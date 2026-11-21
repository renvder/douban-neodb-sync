// Service worker: runs the sync job in the background so closing the popup
// does not stop it. All progress lives in chrome.storage.local, so the popup
// can reopen at any time and pick up where it left off.

import { DOUBAN_CATEGORIES, DOUBAN_SHELVES, fetchDoubanCategory } from "./douban.js";
import {
  VISIBILITY,
  fetchItem,
  pollFetch,
  markItem,
  doubanDateToCreatedTime,
  starsToGrade,
} from "./neodb.js";

const STATE_KEY = "dns_state";
const CONFIG_KEY = "dns_config";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Douban transport ----
// Douban answers HTTP 404 to fetches (fetch/XHR), even when the request is
// sent from inside a real Douban page. A normal page navigation to the same
// URL works fine, so this transport drives a dedicated background tab:
// navigate it to each list page and read the rendered page out of the DOM.
// That is exactly what happens when the user clicks the link themselves.
// The tab is created by the extension itself and stays in the background;
// the user's own tabs are never navigated.
// No "tabs" permission is needed: host_permissions cover tabs on *.douban.com.

const doubanTabs = {}; // host -> tabId

async function waitTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return true;
    } catch {
      return false; // tab closed
    }
    await sleep(500);
  }
  return false;
}

async function ensureDoubanTab(host) {
  let tabId = doubanTabs[host];
  if (tabId) {
    try {
      await chrome.tabs.get(tabId);
      return tabId; // still there
    } catch {
      delete doubanTabs[host];
    }
  }
  await log("正在打開豆瓣後台標籤頁…");
  const tab = await chrome.tabs.create({ url: `https://${host}/`, active: false });
  doubanTabs[host] = tab.id;
  await waitTabComplete(tab.id, 20000);
  return tab.id;
}

async function scrapeTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      html: document.documentElement.outerHTML,
      title: document.title,
      text: document.body ? document.body.innerText.slice(0, 300) : "",
    }),
  });
  return results && results[0]
    ? results[0].result || { html: "", title: "", text: "" }
    : { html: "", title: "", text: "" };
}

// Navigate from inside the page (location.href) so the request carries the
// current Douban page as Referer — as close as possible to a human clicking
// a link. Falls back to a programmatic navigation if the page cannot run
// scripts (blank tab, error page, ...).
async function navigateTab(tabId, url) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (u) => {
        location.href = u;
      },
      args: [url],
    });
  } catch (e) {
    await chrome.tabs.update(tabId, { url });
  }
  await waitTabComplete(tabId, 20000);
}

// fetch()-shaped adapter used by douban.js: returns { ok, status, url, text() }.
async function doubanFetch(url) {
  const host = new URL(url).host;
  let tabId = await ensureDoubanTab(host);
  try {
    const current = await chrome.tabs.get(tabId);
    if (current.url !== url) {
      await navigateTab(tabId, url);
    }
  } catch (e) {
    // Tab went away mid-flight; recreate it once and navigate.
    delete doubanTabs[host];
    tabId = await ensureDoubanTab(host);
    await navigateTab(tabId, url);
  }
  const { html, title, text } = await scrapeTab(tabId);
  if (!html) throw new Error("DOUBAN_EMPTY_PAGE");
  const finalUrl = (await chrome.tabs.get(tabId).catch(() => null))?.url || url;
  // Douban's 404 page has no usable list; report it as a 404 response.
  if (/页面不存在|error code:\s*404/i.test(html)) {
    await log(
      `豆瓣返回 404：最後地址 ${finalUrl}，標題「${title}」，內容：${text.replace(/\s+/g, " ").slice(0, 200)}`
    );
    return {
      ok: false,
      status: 404,
      url: finalUrl,
      title,
      pageText: text,
      text: async () => html,
    };
  }
  return {
    ok: true,
    status: 200,
    url: finalUrl,
    title,
    pageText: text,
    text: async () => html,
  };
}

const defaultState = () => ({
  status: "idle", // idle | scanning | matching | marking | paused | done | error
  phase: "",
  categories: [],
  total: 0,
  matched: 0,
  marked: 0,
  failed: 0,
  pending: 0,
  current: "",
  log: [],
  report: null,
  error: null,
  startedAt: null,
  finishedAt: null,
});

async function getState() {
  const o = await chrome.storage.local.get(STATE_KEY);
  return o[STATE_KEY] || defaultState();
}

async function setState(patch) {
  const s = await getState();
  const next = { ...s, ...patch };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

async function log(msg) {
  const s = await getState();
  const line = `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${msg}`;
  const logLines = [...(s.log || []), line].slice(-200);
  await setState({ log: logLines });
}

function isPausedOrStopped() {
  return getState().then((s) => s.status === "paused" || s.status === "idle");
}

// Run `tasks` (array of async fns) with limited concurrency and a small gap
// between starts. Stops early if the job is paused/reset.
// The bounds check and the take (i++) MUST stay in one synchronous block:
// an await between them lets two workers pass the check for the same last
// slot, and the extra worker takes tasks[length] (undefined) and crashes
// with "task is not a function".
async function runPool(tasks, concurrency, gapMs, onEach) {
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      if (await isPausedOrStopped()) return;
      if (i >= tasks.length) return;
      const task = tasks[i++];
      await task();
      if (onEach) await onEach();
      if (gapMs) await sleep(gapMs);
    }
  });
  await Promise.all(workers);
}

async function runJob(config) {
  await setState({
    ...defaultState(),
    status: "scanning",
    phase: "正在讀取豆瓣列表…",
    categories: config.categories,
    startedAt: new Date().toISOString(),
  });
  await log("開始同步，目標：" + config.instance);

  try {
    // ---- Phase 1: fetch all Douban items ----
    // One pass per (category, shelf): wish/do/collect map 1:1 onto NeoDB
    // wishlist/progress/complete. Old saved configs have no `shelves`,
    // so they default to collect-only (the previous behaviour).
    const allItems = [];
    const shelves =
      config.shelves && config.shelves.length ? config.shelves : ["collect"];
    for (const cat of config.categories) {
      for (const shelf of shelves) {
        if (await isPausedOrStopped()) return;
        const label = DOUBAN_CATEGORIES[cat].label;
        const shelfLabel = DOUBAN_SHELVES[shelf].label;
        await setState({ current: `${label}${shelfLabel}：正在讀取第 1 頁…` });
        await log(`讀取豆瓣${label}${shelfLabel}列表…`);
        const items = await fetchDoubanCategory(
          cat,
          shelf,
          (page, pageCount, total) =>
            setState({
              current: `${label}${shelfLabel}：已讀 ${page} 頁，共 ${total} 條…`,
            }),
          doubanFetch
        );
        items.forEach((it) => {
          it.category = cat;
          it.shelf = shelf;
          it.shelfType = DOUBAN_SHELVES[shelf].shelfType;
        });
        await log(`豆瓣${label}${shelfLabel}：共 ${items.length} 條`);
        allItems.push(...items);
      }
    }
    await setState({ total: allItems.length });
    await log(`豆瓣共 ${allItems.length} 條，開始在 NeoDB 匹配…`);

    // ---- Phase 2: resolve each item to a NeoDB uuid ----
    await setState({ status: "matching", phase: "正在 NeoDB 匹配條目…" });
    const resolved = new Map(); // doubanId -> uuid
    const pending = [];
    const matchFailed = [];
    let matchedCount = 0;

    await runPool(
      allItems.map((item) => async () => {
        const r = await fetchItem(config.instance, config.token, item.doubanUrl);
        if (r.status === "found") {
          resolved.set(item.doubanUrl, r.uuid);
          matchedCount++;
        } else if (r.status === "pending") {
          pending.push(item);
        } else if (r.status === "unsupported") {
          matchFailed.push({ item, reason: "NeoDB 不支持該鏈接" });
        } else {
          matchFailed.push({ item, reason: r.code || "匹配失敗" });
          if (r.code === "AUTH_FAILED") throw new Error("AUTH_FAILED");
        }
        await setState({
          matched: matchedCount,
          pending: pending.length,
          current: `已匹配 ${matchedCount} / ${allItems.length}（待新建 ${pending.length}，失敗 ${matchFailed.length}）`,
        });
      }),
      3,
      400
    );
    if (await isPausedOrStopped()) return;

    // Poll pending creations (NeoDB fetches missing items asynchronously).
    if (pending.length > 0) {
      await log(`有 ${pending.length} 條 NeoDB 裏沒有，等待新建（每條最多約 2 分鐘）…`);
      let pollDone = 0;
      await runPool(
        pending.map((item) => async () => {
          const r = await pollFetch(config.instance, config.token, item.doubanUrl);
          if (r.status === "found") {
            resolved.set(item.doubanUrl, r.uuid);
            matchedCount++;
          } else {
            matchFailed.push({ item, reason: r.code || "新建超時" });
          }
          pollDone++;
          await setState({
            matched: matchedCount,
            pending: pending.length - pollDone,
            current: `新建中：已確認 ${matchedCount} / ${allItems.length}`,
          });
        }),
        3,
        0
      );
      if (await isPausedOrStopped()) return;
    }

    const toMark = allItems.filter((it) => resolved.has(it.doubanUrl));
    await log(`匹配完成：${toMark.length} 條可同步，${matchFailed.length} 條失敗`);
    await setState({ matched: toMark.length, failed: matchFailed.length });

    // ---- Phase 3: mark (or dry-run report) ----
    if (config.dryRun) {
      const report = {
        total: allItems.length,
        matched: toMark.length,
        failed: matchFailed,
        sample: toMark.slice(0, 5).map((it) => ({
          title: it.title,
          date: it.date,
          stars: it.stars,
          comment: it.comment,
          categoryLabel: DOUBAN_CATEGORIES[it.category].label,
          shelfLabel: DOUBAN_SHELVES[it.shelf].label,
        })),
      };
      await setState({
        status: "done",
        phase: "試掃描完成（未寫入任何數據）",
        report,
        finishedAt: new Date().toISOString(),
      });
      await log("試掃描完成，未寫入任何數據。正式同步時會重寫每一條標記，已同步過、日期寫錯的條目也會按豆瓣日期修正。");
      return;
    }

    await setState({ status: "marking", phase: "正在寫入 NeoDB 標記…" });
    let markedCount = 0;
    const markFailed = [...matchFailed];
    await runPool(
      toMark.map((item) => async () => {
        const r = await markItem(
          config.instance,
          config.token,
          resolved.get(item.doubanUrl),
          {
            visibility: VISIBILITY[config.visibility] ?? VISIBILITY.public,
            ratingGrade: config.includeRating ? starsToGrade(item.stars) : 0,
            commentText: config.includeComments ? item.comment : "",
            shelfType: item.shelfType,
            createdTime: doubanDateToCreatedTime(item.date),
          }
        );
        if (r.ok) {
          markedCount++;
        } else {
          markFailed.push({ item, reason: r.code || "寫入失敗" });
          if (r.code === "AUTH_FAILED") throw new Error("AUTH_FAILED");
        }
        await setState({
          marked: markedCount,
          failed: markFailed.length,
          current: `已寫入 ${markedCount} / ${toMark.length}`,
        });
      }),
      2,
      500
    );
    if (await isPausedOrStopped()) return;

    const report = { total: allItems.length, matched: toMark.length, failed: markFailed };
    await setState({
      status: "done",
      phase: "同步完成",
      report,
      finishedAt: new Date().toISOString(),
    });
    await log(`同步完成：成功 ${markedCount} 條，失敗 ${markFailed.length} 條。已同步過的條目已按豆瓣日期重新寫入，之前寫錯的日期已修正。`);
  } catch (err) {
    const code = err && err.message ? err.message : String(err);
    const friendly = {
      AUTH_FAILED: "NeoDB Token 無效或已過期，請檢查 Token 後重試。",
      DOUBAN_LOGIN_REQUIRED:
        "豆瓣要求登錄或驗證：請在瀏覽器裏打開豆瓣任意頁面完成驗證（或重新登錄），再點繼續。",
      DOUBAN_UID_NOT_FOUND: "沒能識別你的豆瓣用戶 ID：請確認已在瀏覽器裏登錄豆瓣，再點繼續（也可以直接把你的豆瓣主頁地址發給我）。",
      DOUBAN_EMPTY_PAGE:
        "豆瓣頁面沒有讀到內容：請確認網絡正常、豆瓣能正常打開，再點繼續。",
    }[code] || `出錯了：${code}`;
    await setState({ status: "error", phase: "出錯", error: friendly });
    await log(friendly);
    // Diagnostics: what did the background tab actually see? The title
    // tells a login/verification page ("登录豆瓣") apart from a real list
    // page (e.g. "…想读的书") or an empty list.
    if (err && err.pageTitle) {
      await log(`豆瓣頁面標題：「${err.pageTitle}」`);
    }
    if (err && err.pageText) {
      await log(`頁面內容開頭：${err.pageText.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === "getConfig") {
      const o = await chrome.storage.local.get(CONFIG_KEY);
      sendResponse({ config: o[CONFIG_KEY] || null });
    } else if (msg.type === "saveConfig") {
      await chrome.storage.local.set({ [CONFIG_KEY]: msg.config });
      sendResponse({ ok: true });
    } else if (msg.type === "getState") {
      sendResponse({ state: await getState() });
    } else if (msg.type === "start") {
      const s = await getState();
      if (s.status === "scanning" || s.status === "matching" || s.status === "marking") {
        sendResponse({ ok: false, error: "任務進行中" });
        return;
      }
      await chrome.storage.local.set({ [CONFIG_KEY]: msg.config });
      runJob(msg.config); // intentionally not awaited; runs in background
      sendResponse({ ok: true });
    } else if (msg.type === "pause") {
      await setState({ status: "paused", phase: "已暫停" });
      await log("已暫停。點“繼續”可從斷點接著跑。");
      sendResponse({ ok: true });
    } else if (msg.type === "reset") {
      await chrome.storage.local.set({ [STATE_KEY]: defaultState() });
      sendResponse({ ok: true });
    }
  })();
  return true; // keep the channel open for the async response
});
