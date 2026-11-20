// Douban list-page fetching + parsing.
//
// Runs in the extension service worker (no DOM), so parsing is done with
// targeted regexes over the raw HTML. Each item on a Douban collection page
// has one title link; the mark date / rating / comment that follow it (up to
// the next title link) belong to that item.

// NOTE (2026-11-20): the /mine/* shortcuts are dead — Douban serves its own
// "你想访问的页面不存在" 404 page for them, even for a logged-in user opening
// them by hand in a normal tab. Every category therefore uses the canonical
// personal page https://<site>.douban.com/people/<uid>/collect.
export const DOUBAN_CATEGORIES = {
  movie: {
    label: "電影",
    listUrl: (uid) => `https://movie.douban.com/people/${uid}/collect?sort=time`,
    host: "movie.douban.com",
  },
  book: {
    label: "書籍",
    listUrl: (uid) => `https://book.douban.com/people/${uid}/collect?sort=time`,
    host: "book.douban.com",
  },
  music: {
    label: "音樂",
    listUrl: (uid) => `https://music.douban.com/people/${uid}/collect?sort=time`,
    host: "music.douban.com",
  },
  game: {
    label: "遊戲",
    listUrl: (uid) => `https://www.douban.com/people/${uid}/games?action=played`,
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
const DATE_RE = /<span[^>]*class="date"[^>]*>(\d{4}-\d{2}-\d{2})<\/span>/g;
const RATING_RE = /(?:allstar|rating)(\d+)(?:-t)?/g;
const COMMENT_RE = /<span[^>]*class="comment"[^>]*>([\s\S]*?)<\/span>/g;

// Parse one list page. Returns { items, looksLikeLogin }.
// items: [{ doubanUrl, doubanId, title, date, stars (1-5|null), comment }]
export function parseDoubanListPage(html) {
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

  const dates = [...html.matchAll(DATE_RE)].map((m) => ({
    date: m[1],
    index: m.index,
  }));
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

  const looksLikeLogin =
    /error code:\s*008|登录豆瓣|请先登录|please login/i.test(html) ||
    (/captcha|验证码/.test(html) && deduped.length === 0);

  return { items: deduped, looksLikeLogin };
}

// Fetch one list page. `fetchFn` is injectable for tests.
export async function fetchDoubanPage(url, fetchFn = fetch) {
  const res = await fetchFn(url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`DOUBAN_HTTP_${res.status}`);
  }
  return await res.text();
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

// Fetch every page of one category. onProgress(page, pageItems) is called
// after each page. Returns the full item list.
export async function fetchDoubanCategory(category, onProgress, fetchFn = fetch) {
  const cfg = DOUBAN_CATEGORIES[category];
  if (!cfg) throw new Error(`UNKNOWN_CATEGORY_${category}`);

  const uid = await getDoubanUid(fetchFn);
  if (!uid) throw new Error("DOUBAN_UID_NOT_FOUND");
  const base = cfg.listUrl(uid);

  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${base}${base.includes("?") ? "&" : "?"}start=${page * PAGE_SIZE}`;
    const html = await fetchDoubanPage(url, fetchFn);
    const { items, looksLikeLogin } = parseDoubanListPage(html);
    if (looksLikeLogin) throw new Error("DOUBAN_LOGIN_REQUIRED");
    if (items.length === 0) break;
    all.push(...items);
    if (onProgress) onProgress(page + 1, items.length, all.length);
    if (items.length < PAGE_SIZE) break; // last page
    await sleep(1200); // be polite to Douban; avoids triggering its limits
  }
  return all;
}
