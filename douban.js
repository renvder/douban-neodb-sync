// Douban list-page fetching + parsing.
//
// Runs in the extension service worker (no DOM), so parsing is done with
// targeted regexes over the raw HTML. Each item on a Douban collection page
// has one title link; the mark date / rating / comment that follow it (up to
// the next title link) belong to that item.

// NOTE (2026-11-20): the /mine/* shortcuts are dead — Douban serves its own
// "你想访问的页面不存在" 404 page for them, even for a logged-in user opening
// them by hand in a normal tab. Every category therefore uses the canonical
// personal page https://<site>.douban.com/people/<uid>/<shelf>.
// Douban has three shelves per category; NeoDB has three shelf types.
// They map 1:1 (verified in neodb-social/neodb, ShelfType enum), so the
// popup offers all three — a user may have wish/do items even if the
// author does not. "dropped" exists on NeoDB but has no Douban shelf.
export const DOUBAN_SHELVES = {
  wish: { label: "想看", shelfType: "wishlist" },
  do: { label: "在看", shelfType: "progress" },
  collect: { label: "看過", shelfType: "complete" },
};

export const DOUBAN_CATEGORIES = {
  movie: {
    label: "電影",
    listUrl: (uid, shelf = "collect") =>
      `https://movie.douban.com/people/${uid}/${shelf}?sort=time&mode=list`,
    host: "movie.douban.com",
  },
  book: {
    label: "書籍",
    listUrl: (uid, shelf = "collect") =>
      `https://book.douban.com/people/${uid}/${shelf}?sort=time&mode=list`,
    host: "book.douban.com",
  },
  music: {
    label: "音樂",
    listUrl: (uid, shelf = "collect") =>
      `https://music.douban.com/people/${uid}/${shelf}?sort=time&mode=list`,
    host: "music.douban.com",
  },
  game: {
    label: "遊戲",
    listUrl: (uid, shelf = "collect") =>
      `https://www.douban.com/people/${uid}/games?action=${shelf}`,
    host: "www.douban.com",
  },
};

const PAGE_SIZE = 15; // Douban list pages show 15 items per page
const MAX_PAGES = 200; // safety cap: 3000 items per category

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripTags(s) {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// Title links on a Douban list page. Each item has two links to the same
// subject: the poster link (contains an <img>) and the title link (contains
// <em>Title</em>). Only the title link is used.
const TITLE_LINK_RE =
  /<a\s[^>]*href="(https:\/\/(?:movie|book|music)\.douban\.com\/subject\/(\d+)\/|https:\/\/www\.douban\.com\/game\/(\d+)\/)"[^>]*>([\s\S]*?)<\/a>/g;
// Date element: <span class="date"> in list view, <div class="date"> in the
// grid view Douban actually serves (even for ?mode=list — verified on a real
// book page 2026-11-21). In grid view the date is bare text inside the
// <div>, after the rating span: <div class="date"><span class="rating5-t">
// </span>&nbsp;&nbsp; 2023-02-10 </div>. The backreference \1 forces the
// close tag to match the open tag, so the nested </span> cannot end the
// match early. class="date" (quote right before "date") excludes the hidden
// <div class="grid-date">, which holds the intro (author/publisher), not a
// mark date. The date is extracted from the element's inner HTML, since
// the <div> case has markup before the date.
const DATE_EL_RE = /<(span|div)[^>]*class="date(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/\1>/g;
const RATING_RE = /(?:allstar|rating)(\d+)(?:-t)?/g;
// Comment is a <span> in list view and a <p> in grid view.
const COMMENT_RE = /<(?:span|p)[^>]*class="comment"[^>]*>([\s\S]*?)<\/(?:span|p)>/g;

// Parse one list page. Returns { items, looksLikeLogin }.
// items: [{ doubanUrl, doubanId, title, date, stars (1-5|null), comment }]
// `pageTitle` is document.title from the tab transport ("" when unknown).
export function parseDoubanListPage(html, pageTitle = "") {
  const links = [...html.matchAll(TITLE_LINK_RE)]
    .filter((m) => {
      const inner = m[4] || "";
      // Poster link contains <img>; title link contains <em> or plain text.
      if (inner.includes("<img")) return false;
      const text = stripTags(inner);
      return text.length > 0;
    })
    .map((m) => ({
      doubanUrl: m[1],
      doubanId: m[2] || m[3],
      title: stripTags(m[4]),
      index: m.index,
    }));

  const dates = [...html.matchAll(DATE_EL_RE)]
    .map((m) => {
      const d = /(\d{4}-\d{2}-\d{2})/.exec(m[2]);
      return d ? { date: d[1], index: m.index } : null;
    })
    .filter(Boolean);
  const ratings = [...html.matchAll(RATING_RE)].map((m) => {
    const n = parseInt(m[1], 10);
    return { stars: n > 5 ? Math.round(n / 10) : n, index: m.index };
  });
  const comments = [...html.matchAll(COMMENT_RE)].map((m) => ({
    comment: stripTags(m[1]).replace(/^短评[:：]\s*/, ""),
    index: m.index,
  }));

  const firstAfter = (arr, from, until) =>
    arr.find((x) => x.index > from && (until === undefined || x.index < until));

  const items = links.map((link, i) => {
    const until = i + 1 < links.length ? links[i + 1].index : undefined;
    const date = firstAfter(dates, link.index, until);
    const rating = firstAfter(ratings, link.index, until);
    const comment = firstAfter(comments, link.index, until);
    return {
      doubanUrl: link.doubanUrl,
      doubanId: link.doubanId,
      title: link.title,
      date: date ? date.date : null,
      stars: rating ? rating.stars : null,
      comment: comment ? comment.comment : "",
    };
  });

  // Dedupe by subject id (a page can list the same subject twice).
  const seen = new Set();
  const deduped = items.filter((it) => {
    if (seen.has(it.doubanId)) return false;
    seen.add(it.doubanId);
    return true;
  });

  // Login detection. The page title is the primary signal when the tab
  // transport provides it: a real list page is titled e.g. "我想读的书(0)",
  // a login page "登录豆瓣". The raw HTML of a logged-in list page can
  // contain stray "登录豆瓣" / "验证码" strings (e.g. a hidden login dialog
  // present on every page), so NEITHER HTML check may fire on a page whose
  // title says it is a list — that is what killed Frost's (empty) wish
  // page 2026-11-21 twice: title "我想读的书(0)", 0 items, logged in as
  // Bing, yet the check fired. A real login/captcha page has a title
  // that is not a list title, so it still errors. When no title is
  // available (plain fetch / tests), the HTML checks apply as before.
  const LIST_TITLE_RE =
    /想读|在读|读过|想看|在看|看过|想听|在听|听过|想玩|在玩|玩过/;
  const looksLikeLogin =
    deduped.length === 0 &&
    (/登录|login/i.test(pageTitle) ||
      (!LIST_TITLE_RE.test(pageTitle) &&
        (/captcha|验证码/.test(html) ||
          /error code:\s*008|登录豆瓣|请先登录|please login/i.test(html))));

  return { items: deduped, looksLikeLogin };
}

// Fetch one list page. `fetchFn` is injectable for tests.
// Returns { html, title, pageText, url }. title/pageText come from the tab
// transport (document.title + leading body text); plain fetch() adapters
// leave them empty. They are only used as diagnostics when a page looks
// like a login/verification page.
export async function fetchDoubanPage(url, fetchFn = fetch) {
  const res = await fetchFn(url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`DOUBAN_HTTP_${res.status}`);
  }
  return {
    html: await res.text(),
    title: res.title || "",
    pageText: res.pageText || "",
    url: res.url || url,
  };
}

// Detect the logged-in Douban user id. Primary source: the logged-in
// homepage — the first /people/ link in the document is the user's own
// profile link in the top navigation. Fallback: the /mine/ redirect
// (https://www.douban.com/mine/ -> https://www.douban.com/people/<uid>/).
let cachedUid = null;

export async function getDoubanUid(fetchFn = fetch) {
  if (cachedUid) return cachedUid;
  try {
    const res = await fetchFn("https://www.douban.com/", {
      credentials: "include",
    });
    const html = await res.text();
    const m = /douban\.com\/people\/([^"/]+)\//.exec(html);
    if (m) {
      cachedUid = m[1];
      return cachedUid;
    }
  } catch {
    // fall through to the redirect check
  }
  try {
    const res = await fetchFn("https://www.douban.com/mine/", {
      credentials: "include",
    });
    const m = /\/people\/([^/]+)\//.exec(res.url || "");
    if (m) {
      cachedUid = m[1];
      return cachedUid;
    }
  } catch {
    // no uid found
  }
  return null;
}

// Fetch every page of one category + shelf. onProgress(page, pageItems)
// is called after each page. Returns the full item list.
export async function fetchDoubanCategory(
  category,
  shelf = "collect",
  onProgress,
  fetchFn = fetch
) {
  const cfg = DOUBAN_CATEGORIES[category];
  if (!cfg) throw new Error(`UNKNOWN_CATEGORY_${category}`);
  if (!DOUBAN_SHELVES[shelf]) throw new Error(`UNKNOWN_SHELF_${shelf}`);

  const uid = await getDoubanUid(fetchFn);
  if (!uid) throw new Error("DOUBAN_UID_NOT_FOUND");
  const base = cfg.listUrl(uid, shelf);

  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${base}${base.includes("?") ? "&" : "?"}start=${page * PAGE_SIZE}`;
    const { html, title, pageText } = await fetchDoubanPage(url, fetchFn);
    const { items, looksLikeLogin } = parseDoubanListPage(html, title);
    if (looksLikeLogin) {
      const err = new Error("DOUBAN_LOGIN_REQUIRED");
      err.pageTitle = title;
      err.pageText = pageText;
      throw err;
    }
    if (items.length === 0) break;
    all.push(...items);
    if (onProgress) onProgress(page + 1, items.length, all.length);
    if (items.length < PAGE_SIZE) break; // last page
    await sleep(1200); // be polite to Douban; avoids triggering its limits
  }
  return all;
}
