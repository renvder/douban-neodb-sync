// NeoDB API client (API 1.0.0).
// Docs: https://neodb.social/api/docs
// Auth: Bearer token created in the NeoDB developer console. The token never
// leaves the user's browser except in requests to their own NeoDB instance.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const VISIBILITY = { public: 0, followers: 1, private: 2 };

function cleanInstance(instance) {
  return (instance || "https://neodb.social").replace(/\/+$/, "");
}

// Extract the item uuid from a NeoDB item URL, e.g.
// https://neodb.social/movie/4W2ZHSBFHfCbRhdBUlHhBS -> 4W2ZHSBFHfCbRhdBUlHhBS
export function uuidFromItemUrl(url) {
  const m = /\/(?:movie|book|music|album|tv|game|podcast|performance)\/([A-Za-z0-9]+)(?:[/?#]|$)/.exec(url || "");
  return m ? m[1] : null;
}

async function api(instance, token, path, { method = "GET", body = null } = {}) {
  const res = await fetch(`${cleanInstance(instance)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : null,
  });
  return res;
}

// Resolve a Douban subject URL to a NeoDB item.
// Returns { status: 'found', uuid } | { status: 'pending' } |
//         { status: 'unsupported' } | { status: 'error', code }.
// 'pending' means NeoDB accepted the URL and is fetching it in the
// background; call pollFetch() to check again later.
// A 429 (rate limited) is retried a few times with backoff: it is
// transient, and re-running the whole job just for a few throttled
// items would be wasteful.
export async function fetchItem(instance, token, doubanUrl) {
  const delays = [5000, 15000, 30000];
  for (let attempt = 0; ; attempt++) {
    const res = await api(
      instance,
      token,
      `/api/catalog/fetch?url=${encodeURIComponent(doubanUrl)}`
    );
    if (res.status === 429 && attempt < delays.length) {
      await sleep(delays[attempt]);
      continue;
    }
    return classifyFetchResponse(res);
  }
}

async function classifyFetchResponse(res) {
  if (res.status === 200) {
    const data = await res.json().catch(() => null);
    const uuid = data && (data.uuid || uuidFromItemUrl(data.url || data.id || ""));
    return uuid ? { status: "found", uuid } : { status: "error", code: "NO_UUID" };
  }
  // 302: already in the catalog. fetch() followed the redirect; the final
  // URL is the item page (or its API representation).
  if (res.redirected || res.status === 302) {
    const uuid = uuidFromItemUrl(res.url);
    if (uuid) return { status: "found", uuid };
    const data = await res.json().catch(() => null);
    if (data && data.uuid) return { status: "found", uuid: data.uuid };
    return { status: "error", code: "REDIRECT_NO_UUID" };
  }
  if (res.status === 202) return { status: "pending" };
  if (res.status === 422) return { status: "unsupported" };
  if (res.status === 429) return { status: "error", code: "RATE_LIMITED" };
  if (res.status === 401 || res.status === 403)
    return { status: "error", code: "AUTH_FAILED" };
  if (res.status === 404) return { status: "error", code: "NOT_FOUND" };
  return { status: "error", code: `HTTP_${res.status}` };
}

// Poll a pending fetch. Waits up to ~120s total (NeoDB docs: some sites
// need ~90s; treat 120s+ without a result as unavailable).
export async function pollFetch(instance, token, doubanUrl) {
  const started = Date.now();
  while (Date.now() - started < 120000) {
    await sleep(15000);
    const r = await fetchItem(instance, token, doubanUrl);
    if (r.status !== "pending") return r;
  }
  return { status: "error", code: "FETCH_TIMEOUT" };
}

// Mark an item. `createdTime` is the Douban mark date as an ISO-8601 string;
// NeoDB stores it as the mark's date (backdating is supported).
// `shelfType` is one of "wishlist" / "progress" / "complete" (NeoDB
// ShelfType); it defaults to "complete". Always sends the full body:
// omitting rating_grade / comment_text / tags on an update would CLEAR
// those fields on NeoDB.
export async function markItem(instance, token, uuid, mark) {
  const body = {
    shelf_type: mark.shelfType || "complete",
    visibility: mark.visibility ?? VISIBILITY.public,
    comment_text: mark.commentText || "",
    rating_grade: mark.ratingGrade || 0,
    tags: mark.tags || [],
    created_time: mark.createdTime || null,
    post_to_fediverse: false,
  };
  // Marking is idempotent (same body overwrites the same mark), so a 429
  // is safe to retry with backoff instead of failing the item.
  const delays = [5000, 15000, 30000];
  for (let attempt = 0; ; attempt++) {
    const res = await api(instance, token, `/api/me/shelf/item/${uuid}`, {
      method: "POST",
      body,
    });
    if (res.status === 429 && attempt < delays.length) {
      await sleep(delays[attempt]);
      continue;
    }
    if (res.status === 200) return { ok: true };
    if (res.status === 401 || res.status === 403)
      return { ok: false, code: "AUTH_FAILED" };
    if (res.status === 404) return { ok: false, code: "ITEM_NOT_FOUND" };
    if (res.status === 429) return { ok: false, code: "RATE_LIMITED" };
    return { ok: false, code: `HTTP_${res.status}` };
  }
}

// Douban mark date "2024-03-15" -> ISO-8601 midnight in the user's timezone
// (+08:00). NeoDB accepts any ISO-8601 date-time for created_time.
export function doubanDateToCreatedTime(dateStr) {
  if (!dateStr) return null;
  return `${dateStr}T00:00:00+08:00`;
}

// Douban 1-5 stars -> NeoDB 0-10 grade.
export function starsToGrade(stars) {
  if (!stars) return 0;
  return Math.max(0, Math.min(10, stars * 2));
}
