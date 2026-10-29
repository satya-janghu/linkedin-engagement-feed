# Architecture

LinkedIn Engagement Feed has four parts that run on one machine and talk only over loopback.

| Part | Location | Responsibility |
| --- | --- | --- |
| Electron main process | `electron/main.ts` | App lifecycle, single-instance lock, window, IPC, startup and clean shutdown of the API server and database |
| Loopback API | `electron/api.ts` | HTTP API on `127.0.0.1` (first free port in 38421–38425), origin checks, body limits, schema validation |
| Database | `electron/database.ts` | SQLite via sql.js (WASM): feeds, people, memberships, queue items, counters, app state, atomic saves and backups |
| Refresh sessions | `electron/refreshSessions.ts` | Resumable, paced walk of each tracked person's posts and comments pages |
| Chrome control | `electron/chrome.ts`, `electron/chromeControl.ts` | Finds Chrome, launches a dedicated profile with the helper loaded, reuses it over the DevTools port (38431–38435) |
| React renderer | `src/main.tsx`, `src/api.ts` | Feed, queue, people, storage and counter UI; typed API client with timeouts and safe retries |
| Chrome helper (MV3) | `chrome-extension/` | Adds `Feeds` controls beside names on LinkedIn and captures visible activity from tracked people |

## Data model

Six SQLite tables: `feeds`, `people`, `feed_people`, `items`, `item_feeds`, `app_state`.

- **Membership-gated capture.** Activity is accepted only for people already tracked in the selected feed. Removing a person from a feed also removes that person's queued-item links from that feed.
- **Global status.** Duplicate posts and comments merge across feeds, so `Done` and `Skip` apply everywhere.
- **Per-person comment dedupe.** Identical comments on the same post from different people stay separate.
- **Reversible counters.** Marking an item `Done` increments the engagement counter (capped at 9999); reopening it reverses the increment.

Limits enforced in `electron/database.ts`:

| Limit | Value |
| --- | --- |
| People per feed | 200 |
| Feed lookback | 1–365 days (default 15) |
| Captured items per request | 120 |
| Feeds per capture request | 20 |
| People per bulk-import request | 500 |
| Queue page size | 150 by default, 500 max |

## Storage safety

- Every save writes to `engagement.sqlite.tmp` and is atomically renamed into place, with short retries for transient file locks.
- Each save also rotates a three-generation backup chain: `engagement.sqlite.bak`, `.bak.1`, `.bak.2`.
- On startup the app recovers a pending temp save, runs `PRAGMA integrity_check`, and falls back through the backup generations if the primary file is damaged. Corrupt files are quarantined as `engagement.sqlite.corrupt-<timestamp>` rather than deleted.
- The storage panel shows database and backup sizes, and `Export JSON` writes a portable snapshot of feeds, people, memberships, counters and queue items.

## Idempotent writes

Every mutating API call carries a `requestId`. A replayed request returns the original result instead of applying twice. Replay state is capped at 500 entries per key prefix.

The renderer's client (`src/api.ts`) retries only GETs and writes marked safe: 3 attempts with 300 ms and 900 ms backoff, honoring `Retry-After` up to 5 s. Timeouts are 12 s by default, 20 s for writes and 60 s for long operations.

## Refresh sessions

A refresh walks each tracked person's posts and comments pages in one visible tab of the dedicated Chrome profile, sequentially.

- **Pacing.** The base delay between pages is 2.8 s, rising to 3.2 s at 80+ targets and 3.6 s at 160+.
- **Retries.** A failing page is retried up to 2 times, after 6 s and 18 s. A page that keeps failing is counted as a page issue and the run moves on.
- **Instability backoff.** 6 / 10 / 16 / 24 s.
- **Rate-limit cooldowns.** 45 s / 90 s / 3 min, triggered by page text such as "too many requests", "unusual traffic" or "temporarily restricted".
- **Login handling.** The run waits while LinkedIn shows a sign-in or checkpoint page. Unavailable profiles are skipped quickly.
- **Lookback-aware scrolling.** The helper receives the feed's lookback cutoff and stops scrolling once older activity is visible.
- **Resumable.** Session state is persisted in `app_state`, with heartbeats saved every 60 s, so a run reconnects after an app restart. A session with no progress for 45 minutes expires with a clear message. Starting a refresh twice for the same feed reuses the active run.

## Loopback API hardening

- Binds to `127.0.0.1` only.
- Origin allowlist: the app, the helper extension and localhost. LinkedIn origins may reach only `/health` unless they send the `X-LinkedIn-Engagement-Feed: 1` identity header.
- Request bodies are capped at 1 MiB with a 12 s read timeout, and inputs are validated against strict schemas.
- The extension's background worker proxies only to the five allowlisted loopback bases, with methods GET, POST, PATCH and DELETE and timeouts clamped to 250 ms–60 s. If the worker is unavailable, the helper falls back to direct requests with the identity header and shows an on-page status banner while the app is unreachable.

## Chrome workspace control

- Chrome is discovered on macOS, Windows (Program Files, Program Files (x86), LocalAppData) and Linux (`google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`).
- The app launches a dedicated profile with the helper extension loaded, and reuses an existing controlled Chrome (matched by DevTools browser ID) instead of spawning duplicates. At most 20 URLs are opened at once.
- Over DevTools it verifies the helper is live: a marker no older than 20 s and a matching helper version (`1.0.32`, kept in sync across the manifest, `content.js` and the app, and enforced by a test).
- Recent branded Chrome builds can ignore `--load-extension`. When that happens the app gives recovery steps: load `chrome-extension/` once via `chrome://extensions`, and Chrome remembers it for that profile.

## Electron security

`contextIsolation` is on and `nodeIntegration` is off. The preload bridge exposes four IPC methods: get the API base URL, launch Chrome, open a path, and save a JSON export.

## Local data

By default, data lives in Electron's user data directory; set `LINKEDIN_FEED_USER_DATA_DIR` to override it.

- SQLite file: `engagement.sqlite` (plus its backups)
- Dedicated Chrome profile: `chrome-profile`

## Tests

`npm test` builds the app and runs 527 `node:test` tests:

| File | Tests | Focus |
| --- | --- | --- |
| `tests/database.test.mjs` | 301 | Real sql.js databases and the real loopback HTTP API |
| `tests/chrome-extension.test.mjs` | 86 | Helper overlay, capture and background-worker contracts |
| `tests/frontend-ui.test.mjs` | 83 | Renderer UI contracts |
| `tests/frontend-api.test.mjs` | 28 | API client timeouts, retries and idempotency |
| `tests/chrome-control.test.mjs` | 24 | Chrome discovery, launch and DevTools control |
| `tests/electron-main.test.mjs` | 5 | Main-process wiring |
