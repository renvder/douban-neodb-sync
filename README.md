![Douban to NeoDB Sync](images/douban-neodb.webp)

<p align="right">
  🌐 <b>EN</b> |
  <a href="./README_tw.md"><b>漢</b></a>
</p>

# Douban to NeoDB Sync

Batch-sync your Douban wishlist / in-progress / completed marks to NeoDB (want to watch / watching / watched, and the read / listen / play equivalents), written as wishlist / progress / complete, keeping the original mark dates (the date you marked something on Douban is the date it shows on NeoDB).

## Install

1. Unzip `douban-neodb-sync-1.0.8.zip` into a folder (keep it — the extension reads from this folder).
2. In Chrome, open `chrome://extensions` and turn on **Developer mode** (top right). Brave works the same way.
3. Click **Load unpacked** and pick the unzipped folder.
4. Click the extension icon and fill in the settings below.

## Settings

- **NeoDB instance**: default `https://neodb.social`. Point it at your own address if you self-host.
- **NeoDB API token**: generate it on the NeoDB site under Settings → Developer options. The token lives only in your browser; the extension never sends it anywhere except your NeoDB instance.
- **What to sync**: check Movies / Books / Music / Games, then the shelves to sync: Wishlist (want to watch / read / listen / play), In progress (watching / reading / listening / playing), Completed (watched / read / listened / played) — written to NeoDB as `wishlist` / `progress` / `complete`. Only Completed is checked by default. Wishlist items usually have no mark date on Douban, so NeoDB stamps them with the sync date.
- **Sync ratings / Sync short reviews**: both on by default. Douban's 5-star ratings are doubled to NeoDB's 10-point scale.
- **Mark visibility**: Public / Followers only / Private.
- **Dry run only**: on by default. Scans without writing anything — check the report (counts, matches, failures) first, then turn it off for the real sync.

## How to use

1. Make sure you're logged in to Douban and NeoDB in this browser.
2. First run: keep **Dry run only** checked, click **Start sync**, and read the report — how many items Douban has, how many matched on NeoDB, how many failed.
3. If it looks right, uncheck **Dry run only** and click **Start sync** again to write for real.
4. You can close the popup while it runs; it keeps going in the background. Click **Pause** to stop any time (restarting runs from the top; re-writing items that are already written is safe).

## Fixing dates synced wrong by another tool

If you previously synced a few items with another tool but the dates came out wrong (e.g. stamped with the sync date), this sync fixes them:

- The extension **never skips** marks that already exist on NeoDB — every matched item is re-written from the Douban data, including the mark date.
- This is guaranteed by NeoDB's own code: in its mark-update logic (`journal/models/mark.py`, `_update_shelf_member`), when a mark already exists with the same shelf type, passing a new `created_time` overwrites the stored mark date, and the log timestamp is updated too. Changing only the date does not post anything new to the fediverse.
- The one exception: a date later than the server's current time is discarded (treated as now). Douban mark dates are all in the past, so this doesn't apply.

Try it on two or three wrongly dated items first: run a real sync, check on NeoDB that their dates changed to the Douban dates, then run the full batch.

## How it works

1. **Reading Douban**: the extension opens a background Douban tab and walks your personal list pages (Movies / Books / Music: `…/people/<your ID>/collect`, `…/wish`, `…/do`; games use your profile page, `…/games?action=collect|wish|do`) the way you would click through them — 15 items per page, ~1.2s apart, to stay under Douban's rate limits. Each page yields the title, Douban link, mark date, stars, and short review. Your user ID is detected automatically from the Douban homepage after you log in — you never type it in. Background requests are not used because Douban answers them with 404; only opening the pages like a normal browse works. The tab is opened by the extension itself and never touches your own tabs; close it when the run is done. Douban actually serves the grid layout, with the date as bare text in `<div class="date">`; parsing follows that.
2. **Matching**: for each item, the extension calls NeoDB `GET /api/catalog/fetch?url=<Douban link>`. Items already in the catalog come back directly; missing ones are created by NeoDB in the background (async — poll after 15s, up to ~2 minutes).
3. **Writing**: for each item, the extension calls NeoDB `POST /api/me/shelf/item/{uuid}` with the shelf you checked (`wishlist` / `progress` / `complete`) and `created_time` set to the Douban mark date (midnight that day, +08:00), plus the rating and short review. Every update sends the full body — NeoDB clears rating / review / tags if an update omits them.

## FAQ

- **Douban asks me to log in or verify**: Douban occasionally shows a verification. Open any Douban page in the browser, complete the verification (or log in again), then continue. The extension never bypasses verification for you.
- **Token invalid**: check that the token was copied in full and hasn't expired, then generate a new one and paste it in.
- **A few items keep failing**: the report lists the failed items and why. Common causes: the item isn't on NeoDB and couldn't be created from its Douban link (e.g. the link doesn't support creation), or requests were rate-limited (429). You can mark those few by hand on the NeoDB site.
- **The sync is slow**: 600 movies is about 40 Douban list pages (~1 minute) plus per-item matching and writing. Items missing from NeoDB take 15–90s each to create — that's the slow part; with many missing items the whole run can take tens of minutes. Close the popup and let it run in the background.
- **Is re-running safe?**: yes. Every run rewrites everything from the Douban data, so no duplicate marks are created.

## Privacy

No server — everything runs locally in your browser. Your Douban login is only used to read your own list pages; your NeoDB token is only sent to your NeoDB instance.

## Changelog

- **v1.0.8**: wishlist and in-progress shelves — all three Douban states now sync to NeoDB as wishlist / progress / complete; fixed book mark dates not parsing (Douban actually serves the grid layout, where the date is bare text in `<div class="date">`, not `<span class="date">`); an empty list no longer errors as a login page.
- **v1.0.7**: NeoDB rate limits (429) are now retried automatically — matching and writing each retry up to 3 times (waiting 5s, 15s, 30s), so a throttled item no longer needs a full re-run to be picked up.
- **v1.0.6**: fixed the "task is not a function" crash — a race in the parallel task queue let a spare worker grab an empty task; taking a task is now atomic. Also fixed the "pending" count shown during the creation phase.
- **v1.0.5**: new URLs — Douban has retired the `/mine/watched`-style shortcut URLs; opening one yourself now gives a 404 that redirects to the homepage. The extension now uses your personal collection pages (`…/people/<your ID>/collect`), with the user ID detected automatically from the Douban homepage after login.
- **v1.0.4**: list pages are now opened by navigating from inside the page (carrying a Douban referer, as close as possible to a person clicking a link); if a 404 still happens, the log records the final URL, page title, and page text to help find the cause.
- **v1.0.3**: switched to "open the page, then read it" — Douban returns 404 even for requests sent from inside a page; only opening the list pages like a normal browse works. The extension now opens its own background tab and walks the list pages one by one. Slower (~2 minutes for ~600 movies) but no more 404s; if this browser isn't logged in to Douban, it says so explicitly.
- **v1.0.2**: fixed connecting to a Douban page opened before the extension was (re)loaded — the helper is now injected into that tab directly, falling back to a fresh tab; the log shows which step it is stuck on.
- **v1.0.1**: Douban requests now go through a page tab, fixing the 404 on direct requests; the `error code: 008` not-logged-in page is detected.
- **v1.0.0**: first release.
