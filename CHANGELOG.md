# Changelog

All notable changes to Arr Dashboard will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — qui Integration

This release introduces a deep, federated integration with [autobrr/qui](https://github.com/autobrr/qui)
(qBittorrent UI) that turns arr-dashboard into a unified surface for the *arr
stack **and** the torrent layer underneath it. Add a qui instance from
Settings → Services (port 7476 by default) — the rest of the surfaces light
up automatically.

### Library — torrent observability (Phase 1.4 + 2.1)

- **Per-card Torrent Health badge** on the Library page — at-a-glance pill showing seeding state + ratio for every cached item correlated with a qui torrent.
- **Per-card tracker brand icons** — items show the real tracker logo derived from qui's announce-URL data + icon registry.
- **Server-side Torrent state filter** on the Library page with per-bucket counts (`Seeding (150) | Stalled download (3) | Not correlated with qui (1962) …`). Pagination is honest under the filter — totals reflect the filtered universe.
- **Deep-link support** — `/library?torrentState=<bucket>` preselects the matching torrent-state filter (used by the qui home page Quick Actions and Pulse seeding-health card).
- **Sort by torrent ratio** added to the Library sort dropdown.
- **Pulse Seeding Health domain** with a dedicated status badge in the dashboard footer following the standard 5-state taxonomy (healthy/degraded/offline/configured/disabled).
- **Library Cleanup gate** — cleanup proposals respect active seeding obligations and skip items currently uploading.

### Per-torrent detail drawer (Phase 6)

A 480 px right sheet replaces the old kebab menu on every library item that
has a qui correlation. The drawer is **capability-aware** — it reads qBit's
WebAPI version and visibly disables actions the running qBit doesn't
support, naming the gap in a banner so the operator knows why.

- **Status section** — torrent state, save path, totals, peer counts, tracker brand pill row.
- **Actions** — pause/resume, force start, recheck, reannounce, set/remove super-seed (where supported). State-gated so download-queue actions only appear while progress < 1.
- **Trackers** — per-tracker peers, health aggregation, live speeds, DHT/PeX/LSD status (only reported as enabled when qBit's own health flags agree). Add / edit / remove via hostname (passkey-safe — full announce URLs never leave the API process).
- **Tags + Category** — type-ahead pickers backed by qBit's existing taxonomy.
- **Limits** — per-torrent share-limit, ratio cap, seed-time cap (ratio + seed-time are submitted as one share-limit operation).
- **Behavior** — auto-management, sequential download, first/last piece priority.
- **Files** — full file inventory with **MediaInfo quality verification**: arr-dashboard cross-checks the file's resolution/codec/container against qBit's claimed quality and flags drift.
- **Advanced** — rename torrent, set location (move data on disk). Both inputs mask their prefill in incognito mode.
- **Danger zone** — delete torrent only / delete torrent + data, with a typed confirmation.

The drawer ships with proper Radix tooltips throughout, a SheetDescription
for accessibility, and incognito masking on titles, paths, and instance
labels via the same `useIncognitoMode()` machinery the rest of the app
uses.

### Series + movie torrent panels (Phase 5)

The detail modal on each Sonarr series and Radarr movie now shows the
torrent layer with the same fidelity the drawer does.

- **Season-grouped per-torrent clustering** with cross-references between episodes that share a torrent.
- **Inline action menu** on every cluster copy.
- **Persistent inode index** with startup pre-warm and a manual rebuild button — definitive hardlink correlation when arr-dashboard has filesystem access to both the qBit content tree and the *arr library tree.
- **Movies** get the same clustering and panel shape as series.

### qui home page (`/qui`)

A new top-level Overview entry — the at-a-glance counterpart of `/dashboard`
for the torrent layer.

- **Live throughput KPI** — current download/upload rates with a live tick.
- **Capability banner** that lists qBit feature gaps relevant to the actions arr-dashboard surfaces.
- **Library correlation card** — how many cached items have qui torrents, with a one-click backfill trigger.
- **Needs Attention feed** synthesizing stuck-at-tracker torrents and other operator-actionable signals.
- **Quick Actions** linking into pre-filtered library views.

### qui Activity (`/qui-activity`, Maintenance group)

A drill-down surface with four tabs:

- **Activity feed** — qui's own observation stream (torrent state transitions, etc.).
- **My Actions** — operator-initiated mutation audit log (every drawer/cluster action records here with hash + instance + outcome, including failures).
- **My Events** — raw qui webhook event log.
- **Webhook** — config panel with hashed-secret rotation and a recent-events strip proving the wire is live.

Torrent-state transitions also route into the notification engine, so the
existing notification rules can fire on qui-observed changes.

### Queue Cleaner — last-seed protection

When *arr is the only known seeder of a torrent, queue-cleaner now skips
strikes against it. Per-instance toggle in the queue-cleaner config.

### Schema

- `LibraryCache` gained three columns:
  - `torrentState String?` (normalized: `seeding`/`downloading`/`stalled_dl`/`paused`/`queued`/`checking`/`moving`/`error`/`unknown`)
  - `torrentRatio Float?`
  - `torrentSyncedAt DateTime?`
- New index on `torrentState` (powers the filter dropdown query). One new enum value `ServiceType.QUI`.
- `ServiceInstance` gained two qui-only columns: `hasLocalFilesystemAccess Boolean` (toggles inode-based correlation) and `pathPrefix String?` (`"qui-prefix>local-prefix"` rewrite for mount-mapped setups).
- `QuiActionLog` model for the My Actions audit feed.
- `QuiWebhookConfig` model + `hashedQuiWebhookSecret` for the webhook receiver (plaintext only returned once at rotate time).
- **Migration**: `pnpm --filter @arr/api run db:push` — existing rows start NULL and populate as the backfill scheduler walks them.

### Background jobs

- `qui-torrent-state-sync` (10min interval) — snapshots torrent state from every enabled qui instance into `LibraryCache`. No-op when no qui instance is configured.
- `infohash-backfill` (catch-up at startup → 6h steady-state) — walks `LibraryCache` rows missing `infoHash`, queries each *arr's `/api/v3/history/movie` or `/api/v3/history/series` to populate the hash, then qui sync correlates. Catch-up loop drains existing libraries in ~5 min for typical sizes; hard-capped at 10k rows per startup.
- `infohash-backfill-by-inode` — definitive hardlink correlation when `hasLocalFilesystemAccess` is on. Persistent inode index survives restarts via gzip-serialized snapshot.

### Performance + operability

- **Stale-while-revalidate cache** for qui's full torrent list — first-paint of `/qui` drops from ~3.5s to <100ms once warm; only the first request after a cold process start pays the paginated walk.
- **In-flight dedup** so concurrent `/qui/summary` + `/qui/attention` requests share one paginated fetch instead of running two.
- **Container memory ceiling** (`mem_limit: 3g` in `docker-compose.yml`) as a circuit breaker against a runaway. Two Node processes × `--max-old-space-size=768` leaves comfortable headroom; raise if running a very large library or `HEAP_AUTO_SNAPSHOT`.
- **Cache hygiene** — `DELETE /services/:id` invalidates both the torrent-list cache and the inode index for the deleted instance, so retired qui instances don't linger in memory.

### Architecture

- `routes/qui.ts` split into domain-grouped files: `instance-routes`, `torrent-routes`, `library-routes`, `panel-routes`, `action-routes`, `webhook-routes`.
- Per-action Zod payload schemas + an extended action allowlist in the action service.
- `torrent-detail-drawer` decomposed into per-section files under `features/library/components/torrent-drawer/`.
- New shared types in `packages/shared/src/types/qui.ts` (~960 LOC of Zod schemas including normalized torrent state, transfer info, MediaInfo, monitored torrent).

### Notes for operators

- **Coverage ceiling depends on *arr history retention.** The backfill scheduler can only correlate items whose original grab record is still in *arr's history. Items whose history has been pruned (Sonarr/Radarr default retention is finite) will never match a torrent and will sit in the "Not correlated with qui" bucket forever. To grow coverage, increase Settings → General → History Retention in your *arr instances.
- **Cross-host setups** — definitive hardlink-based correlation requires arr-dashboard process to have read access to both the qBit content tree and the *arr library tree. Enable per-instance via `Has Local Filesystem Access` in the qui service form; pair with `Path Prefix Rewrite` if mount points differ between qBit and arr-dashboard.
- **Capability gaps surface explicitly** — old qBit versions get an amber banner in the drawer naming exactly which actions are disabled (super-seed, share-limit, etc.). Upgrade qBit to unlock them.
- **Privacy mode** — qui's per-instance label, the qBit instance name, torrent titles, file paths, save paths, and drawer rename/move inputs are all anonymized in incognito mode just like other ARR instance labels.

## [2.19.0] - 2026-05-14

### Added

- **Seerr Test Connection now catches permission-misconfigured instances at setup time (closes #465).** Previously `Test Connection` for Seerr probed only `/api/v1/status`, which is tagged `public` in Seerr's openapi spec and skips the `isAuthenticated` middleware. A Seerr instance whose API-key-backed user (user ID 1 by default, per `seerr/server/middleware/auth.ts`) had no usable permissions still passed the connection check — operators then configured the instance, opened Discover, and saw an empty page with no surfaced reason. After this release, Test Connection probes `/api/v1/request/count` after `/status` succeeds and returns a specific actionable error on 403 naming user ID 1 and the Settings → Users path in Seerr. Transient non-403 failures (5xx, 429) and network blips on the second probe fall through to success — `/status` already proved reachability, so the test doesn't fail on a flake. Non-Seerr services skip the second probe. Discovered while diagnosing #454, where a Seerr user with stripped permissions had `Test Connection` succeed while every gated endpoint silently 403'd.
- **Discover surfaces upstream Seerr errors inline (closes #465).** `DiscoverCarousel` and `DiscoverSearchResults` previously rendered "Failed to load <title>" / "Search failed" with no underlying detail, identical to a "no results yet" state. The `SeerrApiError.message` was already on the wire (via the central error handler → `ApiError.message` on the frontend) but neither component displayed it. Now the underlying message renders inline below the generic banner — a Seerr 403 with `"You do not have permission to access this endpoint"` is visible in the carousel itself instead of requiring server-log access. Whitespace-only messages are ignored to avoid empty paragraphs; backward-compatible with any caller not yet updated to forward the `error` object.
- **Schema Drift in Settings → System now explains what it is (closes #455).** The section previously showed `Drift detected` with `+ field` / `~ field` / `- field` badges and no inline explanation, leading users to think it was reporting an error they needed to fix. Added a help tooltip on the header, an always-visible explanation paragraph inside the expanded panel, and a legend explaining the `+ / ~ / -` symbols (shown only when drift is actually present). The underlying detection logic is unchanged — Schema Drift remains a developer-facing diagnostic that surfaces upstream API evolution, not a user action item.
- **TRaSH migration notices for upstream PRs #2719 and #2721 (German/French unwanted-format groups).** Upstream split language-specific unwanted-format CFs into dedicated `[Unwanted] Unwanted Formats German` and `[Unwanted] Unwanted Formats French` groups on April 27–May 8. Each new group is `default: "true"` upstream, so the merger auto-adopts on next sync — users with German/French templates would see a new CF group appear with no explanation. The `migration-notices.ts` registry now has 4 new entries (RADARR + SONARR for each PR) that fire an info-level advisory when the user has the corresponding `[Release Groups] German/French` anchor but lacks the new unwanted group. Notices fall silent once both groups are present.
- **Heap retainer-walk diagnostic script (#427).** `apps/api/scripts/heap-retainer-walk.py` walks a V8 heap snapshot's retainer graph and surfaces accumulator chains by traversing back from the largest live objects. Used during the #427 OOM mitigation arc to identify which call paths were retaining memory across requests; reach for it before guessing on future OOM reports.

### Fixed

- **Continued #427 OOM mitigation across hunting, library-sync, dashboard-statistics, and diagnostics paths.** After v2.18.5's sweep of `findMany` reads, the next batch of memory work targets bulk-fetch paths, scheduler reentrancy, and operator visibility:
  - **Library-sync now stream-parses the bulk JSON response (#448) and pop-drains `rawItems` progressively** instead of holding the full upstream payload + a normalized copy in memory simultaneously. For a 100k-item Sonarr response this halves peak heap during the sync window.
  - **Hunting now stream-fetches the bulk catalog on every per-service hunt (#451)** rather than allocating the full catalog up front, and slims `wanted` records inside the paginator (#456) plus movie/album/book records on the upgrade-all path (#453). The hunting scheduler no longer accumulates large records across pages.
  - **Library-sync startup-delays its first tick and uses adaptive concurrency (#452, #427)** — the first sync after process start no longer races other startup-time work, and the worker pool now shrinks when heap pressure rises rather than running fixed-concurrency under memory pressure.
  - **Dashboard statistics now stream-aggregates the bulk library list (#449)** instead of materializing the full list then aggregating — same peak reduction pattern as the calendar/history fix from 2.18.5.
  - **Diagnostics**: `dump-heap` helper is now reachable on a running container (`docker exec`) so operators can capture snapshots without re-launching with `--inspect`; auto-snapshot triggers at 90% heap usage with `HEAP_AUTO_SNAPSHOT=1`, and the existing `dump-heap` path was verified end-to-end as part of the auto-snapshot fix.
- **Hunting scheduler now suppresses overlapping ticks (closes #457).** Previously a slow hunt cycle could overlap the next scheduler tick, producing duplicate hunt attempts against the same Arr instance and inflating queue load. The scheduler now skips a tick if the previous one is still running, logging the skip at `warn` so the operator can see if hunt latency is exceeding the cycle interval.
- **Seerr discover schema accepts `person` and `collection` items (closes #454, partial).** `seerrDiscoverResultSchema.mediaType` previously rejected anything other than `"movie" | "tv"`. Seerr's `/api/v1/discover/trending` returns all four `mediaType` values, and a single `person` item in the response would throw `UpstreamValidationError` → HTTP 502 → empty discover page. The schema now accepts the full union; non-movie/tv items are filtered at the server boundary so the public `SeerrDiscoverResult` interface stays narrow (`"movie" | "tv"`). Note: #454's reporter was actually hitting a Seerr permissions misconfiguration, not this bug — see the issue thread; the Test Connection / Discover error surfacing items above are the actual fix for that surface.
- **TRaSH Schema Drift no longer oscillates on naming presets (#463).** The `fetchNamingData` path keyed its schema fingerprint under one shared `namingPresets` category for both Radarr and Sonarr — but the two services ship different top-level shapes, so the registry baseline oscillated every refresh and surfaced as constant intermittent-drift in Settings → System. Categories are now service-scoped (`radarrNamingPresets` / `sonarrNamingPresets`); each service keeps its own baseline and only reports drift against its own prior shape.
- **TRaSH legacy NAMING fetcher removed (#462).** Two fetchers (`fetchNaming` and `fetchNamingData`) walked the same upstream `/sonarr/naming/` and `/radarr/naming/` directories but applied incompatible schemas, producing two `Skipping invalid item 0 ... type: Invalid option: expected one of "movie"|"series"` warnings per cache refresh. The legacy fetcher's output (`TrashNamingScheme[]`) had no consumers — all downstream code used `TrashNamingData[]` from the newer `fetchNamingData` path. Removed the legacy fetcher, the `NAMING` config type, the `trashNamingSchemeSchema`, and the `TrashNamingScheme` shared type. Each cache refresh now logs exactly two fewer false-positive validation warnings and quarantines exactly zero false-rejected items.

### Dependencies

- **Next.js, Hono, and fast-uri bumped to patch open security advisories (#446).** Patch-level updates only; no behavior changes.

## [2.18.6] - 2026-05-09

### Fixed

- **Sonarr hunt requests skipping while Radarr worked normally (closes #438).** The queue-threshold pre-flight check counted *every* queue entry against the default threshold of 25 — including items in `completed` (downloaded, waiting for import), `failed`, `warning`, and other stuck states that don't actually consume download-client capacity. Sonarr's queue accumulates these (one entry per episode plus stuck imports), so the threshold was easily exceeded and every hunt skipped. Radarr (one entry per movie, faster import lifecycle) rarely hit this. Live verification on a real Sonarr 4.0.16 instance reproduced the bug exactly: 31 stuck `completed` items, 0 actively downloading — every hunt skipped before fix, hunts proceed after.
  - `checkQueueThresholdWithSdk` now passes `status: ['queued','downloading','paused','delay']` to `client.queue.get` on Sonarr/Radarr/Lidarr so the threshold reflects items genuinely competing for download slots. Readarr's arr-sdk `QueueResource.get` enumerates known fields and silently drops unknown keys, so the filter cannot be applied there — Readarr's behavior is unchanged from pre-fix and the message is labeled "Queue" (vs "Active queue") to keep the wording honest.
  - **Connectivity failures now surface as errors, not silent throttle.** The catch branch previously returned `status: "skipped"` with the same shape as a healthy threshold-skip, so an offline Sonarr or rotated API key would silently stop hunting with no notification (the scheduler's `HUNT_FAILED` dispatch only fired from thrown errors, not returned ones). The function now returns a discriminated outcome (`pass` / `threshold-exceeded` / `check-failed`); the caller maps `check-failed` to `status: "error"`, and the scheduler now dispatches `HUNT_FAILED` for returned errors as well.
  - **Fail-safe on malformed queue responses.** A reverse-proxy returning HTML, a future SDK field rename, or any response missing `totalRecords` previously coalesced to `0` and proceeded as if the queue were empty. Now treated as `check-failed` with an explicit "unexpected response shape" message.
  - **UI**: the skip/error message is shown inline in the collapsed activity row (instead of only after expanding) with a `title` tooltip for full text on hover, so operators see *why* a hunt was skipped at a glance.

## [2.18.5] - 2026-05-08

### Fixed

- **Out-of-memory crash triggered by `/api/dashboard/calendar` (closes #427 follow-up).** A new OOM trace on v2.18.4 showed the calendar request as the trigger, but the trace shape (766 MB live heap after Mark-Compact freed only ~0.4 MB) pointed at retention/peak across multiple paths the prior fixes didn't cover. This release sweeps the remaining unbounded `findMany` reads on tables with large JSON blob columns (`LibraryCache.data`, plex/jellyfin/tautulli cache rows) and reduces transient peaks on the heaviest dashboard request paths:
  - **Library cleanup field-options endpoint** (`GET /api/library-cleanup/field-options`) was loading every `LibraryCache.data` JSON blob for the user with no `take:` cap — for a 50k-item Sonarr-heavy library, ~1 GB transient just to populate codec/resolution dropdowns. Now cursor-paginates at 500 rows. Three formerly-separate full-table scans of `plexCache` (one each for users, libraries, collections+labels) are now a single merged cursor walk that selects the four columns together.
  - **Library sync existing-items load** for Sonarr/Radarr (`syncInstance` in `library-sync/sync-executor.ts`) was loading every cached row with the `data` JSON column for tag-delta detection. For a 100k-item library the unbounded read peaked over the heap cap. Now cursor-paginates at 500 rows; the post-sync deletion-id diff is collected in the same walk.
  - **Plex collection-routes** (`GET /api/plex/:instanceId/{collections,labels}`) ran unbounded `plexCache.findMany` per request. Cursor-paginated at 1000 rows.
  - **Insights digest scheduler** (`requested-unwatched` and `watched-monitored` checks, every 6h) ran unbounded `plexCache.findMany`. Cursor-paginated at 1000 rows.
  - **Calendar + history dashboard handlers** held both raw upstream payloads AND normalized copies in memory simultaneously (Sonarr's `includeSeries: true, includeEpisodeFile: true` payloads are 5–10 KB per row). Refactored to drop each raw item as it's normalized, halving peak heap during the iteration.
  - **Plex/Jellyfin analytics queries** that select `sessionsJson` lowered `take: 50000` → `take: 20000` (queries selecting only scalar columns are unchanged). With session captures every 5 min, 20000 rows = ~70 days of single-instance history — preserves typical-case behavior. Heavy multi-instance + 30-day-window users hit the cap as before but at lower memory.
- **`last-watched` analytics dropped recent watch events when the snapshot cap was hit.** Both `GET /api/jellyfin/analytics/last-watched` and `GET /api/plex/last-watched` ordered `sessionSnapshot.findMany` by `capturedAt asc`, so when the `take` cap was reached the OLDEST rows were kept and the most recent watch events the panel exists to surface were silently dropped. Now uses `desc` to match the `history` endpoint's pattern. Pre-existing bug, surfaced by code review during the issue #427 sweep.

### Added

- **Heap-monitor plugin** logs `process.memoryUsage()` every 5 minutes via pino, including deltas vs. the previous sample. Severity escalates with pressure: `info` at heap > 80%, `warn` at heap > 90% with a copy-paste manual-snapshot command in the warning. A slow leak now shows up as monotonic `heapDeltaMB` growth instead of an opaque OOM.
- **`--heapsnapshot-signal=SIGUSR2`** added to default `NODE_OPTIONS`. Cost = zero (only writes when the signal is received). Operators who notice climbing baseline in heap-monitor logs can capture a snapshot on demand:
  ```
  docker exec <container> sh -c 'kill -USR2 $(pgrep -f "node /app/api/dist/index.js")'
  ```
  Snapshots land on `/config/heap-snapshots/` (persisted volume, owned by `PUID:PGID`).
- **`HEAP_AUTO_SNAPSHOT=1` env var (opt-in)** appends `--heapsnapshot-near-heap-limit=1` so V8 auto-captures a snapshot just before OOM. Off by default — each snapshot is ~3x the heap (~2.3 GB at the 768 MB cap), too much to write to a `/config` volume that may be a small partition. Set in compose / Unraid template alongside other env vars.

### Changed

- **`GET /api/library?limit=0` now returns 400 Bad Request.** Previously this signaled "fetch all" for an internal `useLibraryForFiltering` hook that has been removed. The fetch-all path mass-loaded every `LibraryCache.data` blob and trivially OOM'd the 768 MB heap on any large library — a foot-gun for any future caller (or external API user) who happened to pass `limit=0`. Schema now requires `limit >= 1`. External callers hitting `/api/library?limit=0` directly will need to use a positive limit value.

### Notes

- This patch went through a multi-file fix sweep, an automated heap-retainer audit, an independent code review pass (which caught the `last-watched` ordering bug), and end-to-end Docker smoke testing (heap-monitor logs verified, SIGUSR2 snapshot capture verified end-to-end producing a 157 MB `.heapsnapshot` file in `/config/heap-snapshots/`). Test additions: 4 new tests — cursor-pagination integration test for `field-options`, library-sync deletion-set equivalence under cursor pagination across multiple batches.
- Memory peak reductions (estimated for a 50k-item library, 5 instances, 30-day window): field-options 1 GB → 10 MB; library-sync 250 MB → 10 MB; plex collection-routes 30 MB → 5 MB; calendar/history 2× peak → 1× peak; sessionsJson analytics 500 MB max → 200 MB max.
- If you hit a future OOM, set `HEAP_AUTO_SNAPSHOT=1` and reproduce. Share the resulting `.heapsnapshot` file in your bug report so we can identify the actual retainer instead of guessing.

## [2.18.4] - 2026-05-07

### Added

- **Admin quality-profile override on Seerr request approval (closes #434).** A new "Options" button next to each pending request opens a profile-picker dialog where admins can pick a non-default quality profile, root folder, or server before approval — useful when a specific requester's content should land in a different profile than the server default (e.g. a "trash shows" profile for a user who watches everything). Jellyseerr/Overseerr stamps the override onto the request before handing off to Sonarr/Radarr. The one-click Approve path is unchanged — overrides are opt-in. Audit log records `{ overridden: true, profileId, rootFolder, ... }` for accountability. Live-tested end-to-end against a real Jellyseerr v3.2.0 + Sonarr instance, which surfaced three real-data bugs that mocked unit tests didn't catch: `serverId: 0` is valid (Jellyseerr is 0-indexed), `languageProfiles: null` is valid (was strict `.optional()`), and TV PUT requires `seasons` (Jellyseerr 500s otherwise). Lazy-loaded modal, dropdowns reuse the existing `/request-options` endpoint (#436).

### Fixed

- **Out-of-memory crash during scheduled backup (closes #427 follow-up).** v2.18.3 fixed Readarr/Lidarr library-sync OOM, but a separate report showed scheduled backups still hitting the 768 MB heap cap. Root cause: `exportDatabase` ran 21 `findMany()` calls in parallel and the encryption chain (`JSON.stringify` → buffer → buffer → base64 → stringify) held ~5–6× row data simultaneously. Fixes:
  - **Non-manual backups** (scheduled + auto-update) now skip operational history tables (`huntLog`, `huntSearchHistory`, `trashSyncHistory`, `templateDeploymentHistory`) by default — these grow unbounded over time and are not needed to restore working configuration. Manual UI-triggered backups preserve full history. An info log records when exclusion fires so operators can correlate "empty huntLog after restore" to backup type.
  - When operational history *is* included, each table is capped to the most recent 1000 rows (ordered by timestamp DESC). A `count()` pre-check logs a warn whenever rows are dropped so truncation is never silent.
  - Tables are fetched sequentially instead of in parallel, and the JSON plaintext is built inside a block scope so V8 can reclaim the row data + JSON string before the base64 ciphertext is allocated, halving peak heap during encryption.
  - The size estimator now samples up to three rows per table (first / middle / last) and uses the **max** stringified size — single-row sampling silently underestimated when the first row was sparse (e.g., a `huntLog` with `details: null`). Non-serializable rows (`undefined`) no longer crash the estimator.
  - Envelope JSON is no longer pretty-printed (saves ~33% of envelope-stringify peak).
- **Heap pressure during library cleanup runs.** `prefetchPlexData`, `prefetchJellyfinData`, and `prefetchTautulliData` were loading every cache row for the user with no column projection — for a 50k-item Plex library, ~200 MB of in-memory objects per cleanup run. All three prefetchers now cursor-paginate at 500 rows and project only the columns the watch-map builder actually reads (skipping `ratingKey`, `thumb`, `title`, etc.). Cross-batch Map merging is preserved (same `tmdbId` appearing in batch 1 and batch 2 still aggregates into one entry with summed watchCount and unioned collections/labels).
- **Heap pressure during auto-tag rule execution.** `executeAutoTagRule` was loading the entire `libraryCache` for the instance — including the per-row `data` JSON blob — at once. Under webhook concurrency (Connect events firing in rapid succession), this could stack heap pressure and trip the cap. Now cursor-paginates at 500 rows.

### Notes

- This patch went through code review, silent-failure analysis, test-coverage analysis, and security review before release. Two `take`-cap "defensive" limits proposed during initial implementation (`take: 10000` on queueCleanerStrike and `take: 50000` on plexCache) were *removed* before merge — review found the strike cap could silently break strike-threshold semantics by truncating rows non-deterministically (no `orderBy`), and the plexCache cap targeted a non-issue given the small column projection.
- Test additions: 15 new tests covering the new behaviors — exportDatabase history-exclusion + retention-truncation contract, createBackup type-based defaulting (manual / scheduled / update / explicit override), estimateBackupBytes (sparse-row + multi-sample), auto-tag cursor pagination, and prefetchPlexData cross-batch Map merge.

## [2.18.3] - 2026-05-05

### Fixed

- **Notification "View Details" links broken in all external channels.** Notification payloads sent to Telegram, Discord, Pushover, Gotify, Email, etc. contained relative URLs (`/statistics`, `/library`) that external clients could not resolve. URLs are now resolved to absolute form (preferring `SystemSettings.externalUrl`, falling back to `APP_URL`) before dispatch (#430).
- **Indexer page text hard to read.** Card backgrounds on the indexer page used very low opacity (`bg-card/15-20`) rendering text near-invisible on the light theme. Raised background opacity and fixed hardcoded `text-white` in the pagination component to use theme-aware semantic classes (#428).
- **Excessive memory usage during Readarr/Lidarr library sync.** Sync was loading the full normalized item array into memory for Readarr/Lidarr services that don't need tag-delta diffing. Now skips the `data` column in cache reads and processes items in batches, reducing peak heap usage. JSON blobs are still written on create/update so `/library` responses stay complete (#427).

## [2.18.2] - 2026-05-03

**Auto-Tagger — one-click Connect webhook auto-install (issue #422).** A follow-up to the real-time webhook plumbing that shipped in 2.18.0: instead of hand-pasting the URL and `Authorization: Bearer …` header into every Sonarr/Radarr's Connect settings, you can now select your enabled instances inside the Auto-Tagger settings panel and push the canonical webhook to all of them in a single click.

### Added

- **One-click webhook auto-install for Sonarr/Radarr Connect.** The Auto-Tagger settings panel grew an **Auto-install** sub-section that lists every enabled Sonarr/Radarr instance with its current install state (Installed / Not installed / Probe failed). Selecting one or more instances and clicking "Install / Update on N instances" pushes the `arr-dashboard auto-tagger` notification (URL + Bearer secret + event flags) to each *arr's `/api/v3/notification` endpoint. Idempotent — re-running updates the existing notification by name match. Per-instance failures (auth error, *arr offline) surface individually without blocking the rest of the batch. The install URL is derived from `SystemSettings.externalUrl` when configured, falling back to Fastify's `trustProxy`-aware request fields, so a forged `Host` header cannot redirect Connect traffic to an attacker. Backed by `GET /api/auto-tag/webhook/install/status` and `POST /api/auto-tag/webhook/install`. Closes #422 (#423).

## [2.18.1] - 2026-05-03

**Labels & tagging — bug fix + event-driven triggers (issue #384).** Two follow-ups to the Label Sync / Auto-Tagger features that shipped in 2.18.0: a Radarr/Sonarr validator error that broke tag application is fixed, and Label Sync rules now fire within seconds of a tag change instead of waiting for the hourly schedule.

### Fixed

- **Tag application no longer fails with `'Quality Profile Id' must be greater than '0'`.** The auto-tagger and the Label Sync arr-writer were sending partial PUT bodies (`{ id, tags }`) to Radarr/Sonarr, but stricter validator releases require the full resource. Both writers now fetch the existing item via `getById` and spread it into the update body, matching the canonical pattern in `library-cleanup/cleanup-executor.ts` (#418).

### Added

- **Event-driven Label Sync triggers.** Rules used to wait up to an hour for the scheduled run; now they fire on every relevant change. Three triggers shipped: (1) auto-tagger chain — when the auto-tagger applies a tag matched by a Label Sync rule, the rule fires inline; (2) library-sync delta detection — when an external tag change is observed during the existing library-sync poll, matching rules fire (5–15 min latency); (3) per-item "Sync labels now" button on the library item detail modal for instant manual propagation. End-to-end "Radarr import → Plex label" lands in seconds when the Sonarr/Radarr Connect webhook is configured (Settings → Auto-Tagger → Webhook Config); the scheduler-only fallback is bounded by the auto-tagger schedule. Currently *arr-source rules only — Plex-source rules continue to rely on the scheduler; the 1-hour scheduled run remains as the self-healing safety net (#420).

- **Live-integration test for the *arr tag-write pattern.** Gated on `INTEGRATION_TESTS=1` plus per-service env vars; runs the full `getById → spread → update` round-trip against a real Radarr/Sonarr instance to catch regressions of the validator-rejection class shipped in this release. CI never runs it; documented as an operator pre-release step in `docs/RELEASING.md` §2 (#419).

## [2.18.0] - 2026-05-01

**Auto-Tagger: criteria-based tagging for Sonarr/Radarr — companion to Label Sync.** A new automation feature that applies tags to *arr items when they match a rule's criteria DSL. Same expressiveness as Library Cleanup (50+ rule types: genre, year, codec, watch state, Plex labels/collections, custom format score, audio channels, runtime, file path regex, etc.) plus full composite (AND/OR) rules and real-time tagging via Sonarr/Radarr Connect webhooks. Pair with Label Sync to mirror the tag onto Plex/Jellyfin/Emby labels — Auto-Tagger seeds the source tag, Label Sync propagates it. New `/auto-tag` page in the Maintenance section.

### Added

- **Auto-Tagger feature** at `/auto-tag` — schedule-driven (5min ticks, 60min per-rule cooldown) and on-demand "Run now" against Sonarr/Radarr. Reuses Library Cleanup's evaluator + 50+ rule types, so rule expressiveness is at parity with cleanup from day one (#394).
- **Composite (AND/OR) rule builder UI** — toggle between single criterion and composite mode in the rule dialog, add/remove condition rows independently, each row picks its own rule type with type-specific params via the shared `ConditionParamsFields` (#395).
- **Sonarr/Radarr Connect webhook** at `POST /api/auto-tag/webhook/:instanceId` — fires within seconds of an import event for sub-second tagging vs. the 5-minute scheduled tick. Per-user Bearer-token auth (token's SHA-256 hash stored at rest; plaintext shown once at generation/rotation, never persisted). Webhook config panel on the Auto-Tagger page with copy-secret, rotate-secret, and incognito-mode redaction (#396).
- **Per-rule execution lock** — prevents the scheduler tick and on-demand "Run now" from racing on the same rule's `series.update`/`movie.update` and dropping each other's tag merges. Skipped runs return HTTP 409 with a clear message (#398).
- **List-membership rule type** — `tmdb_list_member` and `trakt_list_member` rule types in the criteria DSL, with backing `TmdbListCache` / `TraktListCache` schema. Rules can be created and edited via the new "Lists" optgroup in the rule dialog (#399).
- **List-membership runtime: TMDb v3 + Trakt PAT integration** — list-membership rules now match items at execution time. TMDb lookups reuse the per-user TMDb v3 read-access token already configured in Settings → Account (the same key Discover uses). Trakt lookups use a new per-user Trakt personal access token field in Settings → Account, paired with the operator-supplied `TRAKT_CLIENT_ID` env var. Both list caches refresh every 4 hours (offset startup delays: TMDb +60s, Trakt +90s) and orphan-collect rows for unreferenced lists at the end of each tick. Membership maps are prefetched into the `EvalContext` and dispatched through `evaluateSingleCondition`, so list-membership conditions compose freely with all other rule types in AND/OR rules (#403).

### Changed

- **Generic rule-criteria types extracted from `library-cleanup` into a neutral shared module** — `RuleType`, `Condition`, `CompositeOperator`, all `*RuleParams` schemas, the validation map, and the data-source-dependency map now live in `packages/shared/src/types/rule-criteria.ts`. Both Auto-Tagger and Library Cleanup consume from there. Legacy export names (`cleanupRuleTypeSchema`, `CleanupRuleType`) preserved as aliases — every existing import resolves unchanged (#393).
- **`ConditionParamsFields` and `MultiSelectField` hoisted out of `library-cleanup/components/`** into a shared `features/rule-criteria/components/` module. Both Library Cleanup and Auto-Tagger import the same UI primitive — no more cross-feature reaching into another feature's `components/` folder (#397).

### Fixed

- **TRaSH Guides cache refresh silently returned empty caches.** GitHub now requires the canonical `refs/heads/{branch}` segment in `raw.githubusercontent.com` paths; the legacy `…/{branch}/…` form returns 404 for many repos. The cache layer was auto-populating each entry with `itemCount: 0` on fetch failure while the UI returned HTTP 200 throughout, so users (on both the official TRaSH-Guides repo and custom forks) saw "successful" refreshes that produced empty Custom Format / Quality Profile / Naming / Quality Size lists. Fixed by switching the URL builder to the canonical form, with the `discoverConfigFiles` regex anchored on `/refs/heads/{branch}/` so the GitHub Contents API path is built deterministically (#407).
- **TRaSH Guides fetch errors lost critical context, making issue #406 hard to triage.** Four error sites in `github-fetcher.ts` were dropping diagnostic information: the per-attempt retry log emitted `"Fetch attempt 1/2 failed:"` with no URL, `fetchMetadata`'s throw omitted the URL and HTTP status, the `discoverConfigFiles` error message named `raw.githubusercontent.com` while the actual fetch was to `api.github.com`, and `fetchCfDescription` used a `log.error(string, error)` form that pino mis-parses (the second positional arg is treated as a `%s` substitution target rather than an error to serialize, so the stack/cause vanished from JSON output). All four sites now emit pino-structured `log.x({ err, url, ... }, message)` entries with the URL named in both the human-readable message and the merge object so log scrapers can filter on it (#408).
- **Older Plex analytics helpers were leaking up to 5 100-character `sessionsJson` slices into pino logs on JSON-parse failure.** PR #382 closed this in the two helpers added during the Option 3 arc; the same pattern lived in five older helpers (`watch-history`, `codec-analytics`, `device-analytics`, `user-analytics`, `quality-score`). `sessionsJson` embeds titles, usernames, and instance metadata — exactly the fields incognito-mode anonymizes — so operators shipping pino logs to a third-party aggregator (Loki, Logtail, etc.) saw partial session payloads in their warn-level events. All five helpers now stop populating `failedPreviews` (the field stays in the return type for caller compatibility but is always `[]`). Each also gains the same `Array.isArray` guard PR #382 added, so a corrupt row that parses to a non-iterable value (`null`, `{}`, a number) is counted as a parse failure instead of throwing `TypeError` on the for-of and silently aborting the rest of the snapshot walk (#383).
- **Library page now honors `?quality=` and `?service=` deep links.** The "View in Library" link from Pulse's "items below quality cutoff" notification (and the dashboard service cards' `/library?service=…` links) navigated to the page but the filter dropdowns stayed on "All". Root cause: `useLibraryFilters` initialized state from `useState(default)` and never read the URL. Now seeds `qualityFilter` from `?quality=cutoff-unmet|cutoff-met` and `serviceFilter` from `?service=sonarr|radarr|lidarr|readarr` on cold mount, and re-syncs on warm client-side navigations so the same deep link works whether the user lands fresh or is already on `/library`. Unknown values fall back to "all" so untrusted URLs can't widen the union; user-driven dropdown changes are preserved across re-renders by tracking the last URL value (closes #404).

### Notes for operators

- The Auto-Tagger writes to the **source-side *arr** (Sonarr/Radarr); pair with a Label Sync rule if you want the tag mirrored to Plex/Jellyfin/Emby labels.
- The webhook is exposed at `/api/auto-tag/webhook/:instanceId` as a **public route** (no session cookie required); auth is the per-user Bearer token. Rotate the secret via the panel if you suspect leakage — old token is invalidated immediately.
- **Trakt list-membership rules require `TRAKT_CLIENT_ID`** to be set in the API process env (issued from `trakt.tv/oauth/applications`). Without it, the Trakt scheduler logs a one-line "skipped — TRAKT_CLIENT_ID not configured" notice and trakt rules will not match. TMDb list-membership has no operator-side env requirement — it uses the user's TMDb v3 read-access token from Settings → Account.

## [2.17.0] - 2026-04-29

**Statistics overhaul: Jellyfin/Emby parity + Tautulli is now optional.** The Statistics page gains a full Jellyfin/Emby tab matching the Plex feature set, and the Plex tab no longer requires Tautulli — all leaderboards and analytics now flow from the dashboard's own SessionSnapshot capture (every 5 minutes during active streams) rather than Tautulli's pre-aggregated home-stats. Tautulli stays around as an *optional enrichment source* that adds richer codec, LAN/WAN bandwidth, and platform metadata when configured; without it, snapshot-driven data still populates the same charts.

### Added

- **Jellyfin/Emby analytics tab** — Statistics page now has a "Jellyfin" tab matching the Plex feature set: 6 leaderboards (top movies/shows/music + most-popular movies/shows/music), transcode/codec/device breakdowns, user analytics, watch history, quality score, bandwidth forecast. Gates on having any enabled Jellyfin or Emby instance. Source-agnostic chart components were extracted from the existing Plex chart implementations, parameterized by `service` for theming and messaging (#374).
- **`aggregateTopMedia` helper** — top-N most-played titles per media type, deduped per user×title within a 10-minute window (matches Tautulli's play-counting semantics). Replaces Tautulli `top_movies / top_tv / top_music` (#375).
- **`aggregatePopularMedia` helper** — top-N titles by distinct watcher count, surfacing broadly-loved titles vs. items one user rewatches obsessively. Replaces Tautulli `popular_*` (#376).
- **`aggregateLastWatched` helper** — most-recently-watched titles deduped by title, sorted by recency. Replaces Tautulli `last_watched` (#377).
- **`aggregateMostConcurrent` helper** — peak concurrent-stream events deduped by 30-minute proximity. Works on snapshot top-level fields (no `sessionsJson` parse). Replaces Tautulli `most_concurrent` (#378).
- **`aggregatePlaysByDate` helper** — per-day play counts segmented by media type with full date-range zero-fill so sparklines render cleanly even for sparse data. Replaces Tautulli `cmd=get_plays_by_date` (#379).
- **Tautulli enrichment indicator** — when a Tautulli instance is configured, the Plex tab's source banner now shows an explicit "Tautulli enrichment active" line explaining that codec/LAN-WAN/platform metadata is enriched on captured sessions (#380).

### Changed

- **Plex tab no longer requires Tautulli.** Tab visibility gates on `hasPlex` (any enabled Plex instance) instead of `hasTautulli`. Plex-only users — previously locked out of the Statistics tab — now see the full analytics surface (#380).
- **Plex tab structure now mirrors Jellyfin tab.** Both render 14 cards (3 Top + 3 Most Popular + 8 SessionSnapshot analytics) sourced from the same shared aggregation helpers. The dynamic Tautulli `homeStatSections` rendering loop and Tautulli summary cards are removed in favor of the unified leaderboard shape (#380).
- **`EnrichedSession` schema extended** with optional `mediaType` and `grandparentTitle` fields so leaderboards can group TV episodes by show name. Backward compatible — pre-extension snapshots are skipped from leaderboards rather than misclassified (#375).

### Behavior matrix

| User has | Plex tab visible | Source banner |
|---|---|---|
| Plex only | ✅ (was ❌) | "Captured from Plex session snapshots…" |
| Plex + Tautulli | ✅ | "…Tautulli enrichment active — codec, LAN/WAN bandwidth, and platform metadata are enriched…" |
| Jellyfin/Emby only | n/a (Jellyfin tab visible) | unchanged |

### Notes

- `useTautulliStats` and `useTautulliPlaysByDate` hooks remain in the codebase. They're no longer consumed by the Plex tab but stay available for the OverviewTab's optional Tautulli card and any future Tautulli-admin surface.
- Leaderboards take a few hours to populate after deploy as new SessionSnapshot rows accrue. Pre-deployment snapshots lack the new `mediaType` field and are skipped from leaderboards (the helpers gracefully degrade rather than misclassify).

## [2.16.2] - 2026-04-28

**Security patch release.** Closes 8 open code-scanning alerts (1 HIGH-severity Fastify body-schema bypass + 4 medium-severity DOMPurify sanitization issues + 1 GitHub Actions shell-injection vector + 2 transitive hono/postcss vulnerabilities) and 6 Dependabot security advisories. Also adds a small TRaSH Guides feature (migration notices for upstream CF-group restructures) and removes a class of spurious diagnostic warnings. No schema or API breaking changes.

### Fixed

- **Fastify body schema validation bypass via leading-space `Content-Type`** — CVE-2026-33806 (HIGH). Fastify 5.3.2–5.8.4 mishandled `Content-Type` headers with leading whitespace, allowing requests to skip body schema validation. Bumped to fastify 5.8.5 via the production-dependencies group (#363).
- **DOMPurify sanitization bypasses (4 CVEs)** — CVE-2026-41238/41239/41240 + GHSA-39q2-94rc-95cp covered `SAFE_FOR_TEMPLATES` bypass in `RETURN_DOM` mode, `FORBID_TAGS` bypass via function-form `ADD_TAGS`, prototype pollution → XSS via `CUSTOM_ELEMENT_HANDLING` fallback, and `ADD_TAGS` short-circuit evaluation. Bumped to dompurify 3.4.1 via the production-dependencies group (#363).
- **Hono JSX HTML injection in SSR (transitive)** — GHSA-458j-xx4x-4375. Pulled in via `prisma@7.8.0` → `@prisma/dev` → hono. The existing pnpm override pinned hono to the vulnerable 4.12.12; updated the override to require ≥4.12.14 (#369).
- **postcss CVE-2026-41305 (transitive)** — Pulled in by `next@16.2.4`, which hardcodes postcss 8.4.31 in its bundled tooling — bumping Next alone wouldn't reach it. Added a `pnpm.overrides` entry pinning all sub-8.5.10 resolutions to 8.5.10 (#369).
- **GitHub Actions shell-injection vector in release workflow** — Semgrep flagged `${{ github.ref_name }}` used directly inside a `run:` block in `docker-combined.yml`. A maliciously crafted tag could inject arbitrary commands into the runner with access to GHCR/Docker Hub credentials. Refactored both the `Extract version metadata` and `Determine scan tag` steps to read git-context values via `env:` blocks instead of inline `${{...}}` interpolation (#368).
- **Spurious schema-drift warnings on per-file TRaSH fetch** — When the GitHub fetcher iterates files individually (one cf-group, one custom format, etc.), it was recording a schema fingerprint per item — and sparse upstream fields (present on some items but not others) showed up as "missing fields" drift warnings on every poll. Added a `skipFingerprint` option for per-item validation calls plus a single `recordSchemaFingerprint` call after each loop, so the union-of-fields semantics work correctly (#365).

### Added

- **TRaSH Guides migration notices** — When an upstream CF-group is restructured (e.g., the recent split of `[Optional] Miscellaneous` → `[Unwanted] Unwanted Formats`), the template diff modal now surfaces an informational notice explaining what changed and what the user should do. Notices fire on both the live diff path and the historical-changelog reconstruction path, and are suppressed once both the kept and introduced groups are present in the user's template — so the notice doesn't nag once the migration is complete. Reusable registry mechanism: future upstream restructures only need a registry entry, no code (#364).
- **`trash_regex` declared in TRaSH custom-format schema** — Long-standing upstream field on ~20 custom formats that was passing through `z.looseObject()` unmodeled. Declaring it as `z.string().optional()` makes the schema match upstream reality and gives consumers proper typing if a future surface needs the regex-documentation URL (#367).

### Changed

- **Removed redundant `console.*` calls in TRaSH Guides web surface** — 22 `console.log/warn/error` calls cleaned up across 13 files (template-list, scheduler-status-dashboard, quality-profile-importer, etc.). Browser-facing code shouldn't ship developer logs by default. Intentional diagnostic calls in `useSync`, `sync-validation-modal`, `pattern-tester`, and `useCFConfiguration` were preserved (#366).
- **Lint hygiene: 9 unused-imports warnings cleared in trash-guides surface** — Pre-existing `catch (err)` parameters that were never referenced in the catch body have been underscore-prefixed (`_err`) per ESLint convention; ESLint config extended with `caughtErrors: "all"` + `caughtErrorsIgnorePattern: "^_"` so future catch-param hygiene is enforced consistently. No runtime change (#371).

### Dependencies

- **Production dependencies (23 packages)** — `knip` 6.4.1→6.7.0, `@prisma/*` 7.7→7.8 (client/cli/adapter-better-sqlite3/adapter-pg), `nodemailer` 8.0.5→8.0.6, `@tanstack/react-query` 5.99→5.100.5, `lucide-react` 1.8→1.11, `next` 16.2.3→16.2.4, `react-hook-form` 7.72→7.74, `postcss` / `tailwindcss` 4.2.2→4.2.4, `isomorphic-dompurify` 3.8→3.10, `@typescript-eslint/*` 8.58.2→8.59, `eslint` 10.2.0→10.2.1, `eslint-plugin-react-hooks` 7.0.1→7.1.1, `jsdom` 29.0→29.1 (#363).
- **Dev dependencies (3 packages)** — `@biomejs/biome` 2.4.11→2.4.13, `typescript`, `vitest` (#362).
- **Trivy scan timeout bumped 5m → 20m** — Default 5-minute timeout consistently failed analyzing `@prisma/config@7.8.0/package.json` after the Prisma 7.8 bump. Applied to both `docker-dev.yml` (post-CI scan) and `docker-combined.yml` (release workflow) so a release tag can't fail at the security gate (#370).

## [2.16.1] - 2026-04-16

**Patch release — reverse-proxy link correctness and calendar layout stability.**

Two user-facing bug fixes on top of 2.16.0. No new features, no schema/API breaking changes — both fixes are transparent to existing installs.

### Fixed

- **Calendar narrows on month navigation** — `PageLayout`'s `<main>` was collapsing to its intrinsic content width because `mx-auto` cancels the default `align-items: stretch` when the parent is `flex flex-col`. When a month's content (loading skeleton, dense event chips, sparse weeks) had a different intrinsic width than the previous month, `main` resized and the calendar appeared to grow or shrink between clicks. Pinning `main` to `w-full` keeps it at parent width regardless of content — the grid, filters, and navigation controls now stay anchored across months. Completes the fix for #272 (the earlier #279 addressed only the vertical 6-week grid; this one was the missed horizontal axis).
- **Instance deep links now prefer `externalUrl` everywhere** — Statistics → Overview → Health Issues "View" link, plus the Calendar event card, History row, and Library card "open in Sonarr/Radarr/etc." links were building hrefs from `baseUrl` — the internal container URL that isn't reachable when the instance sits behind a reverse proxy. All four sites now use `instance.externalUrl ?? instance.baseUrl`, matching the pattern introduced for the dashboard Active Queue in #306. To make this bug harder to reintroduce, `HealthIssue` records now carry `instanceExternalUrl` end-to-end from the API down to the render site, so any future consumer inherits correct URL resolution without a frontend service lookup. Closes #354.

## [2.16.0] - 2026-04-15

**From monitoring to guided action.** This release turns the attention surface — System Pulse and the new dashboard Needs Attention panel — from a *report* of what's wrong into a place where operators can *fix* the problem in one click. Pulse / Needs Attention is now the canonical issue surface: pre-existing banners that duplicated its signals have been removed, misleading diagnostic copy has been reworded to defer to Pulse as the single source of truth, and three safe actions — Enable a disabled scheduler, Refresh a stale cache, Retry a failed queue item — land inline on their respective rows.

Scope was deliberately limited to **safe, idempotent, easily-reversible** operations. Destructive actions (remove, blocklist), automation/rules engines, and bulk/batch flows are explicitly deferred to future releases; this release establishes the pattern and trust foundation those later surfaces will build on.

### Added

#### Dashboard & Needs Attention
- **Needs Attention panel** — New curated subset of `/pulse` on the dashboard, showing the top 10 actionable warning/critical items with stable deep-links to the full Pulse feed. The same row renderer is reused on both surfaces so operators see one consistent presentation (#335)
- **Dashboard as the primary Overview item** — The sidebar navigation now treats Dashboard as the default Overview landing page, with a pinned root-route test to prevent regression (#337)
- **Scheduler items route to `/pulse`** — Needs Attention rows that surface disabled/failing schedulers deep-link into the full Pulse feed with hash-scroll + highlight, so operators land directly on the row rather than at the top of an unfiltered list (#336)

#### System Pulse
- **Media-server reachability collector** — New `collectMediaServerReachability` emits critical `plex-unreachable-<id>` / `jellyfin-unreachable-<id>` / `tautulli-unreachable-<id>` rows on a cheap identity ping failure, mirroring the existing `arr-unreachable-*` pattern. Closes the gap where an unreachable media server was only surfacing as a misleading "cache refresh error" banner (#346)

#### Operator Actions (Actionability V1 + V1.1)
- **Pulse action envelope + dispatcher** — New optional `action` field on Pulse items carries a discriminated-union payload (`kind: "scheduler.enable" | "cache.refresh" | "queue.retry"`); new `POST /api/pulse/:id/action` route dispatches to existing service calls. No new backend capability is introduced — every action reuses the plumbing that already powered Settings-page manual triggers (#340)
- **`scheduler.enable`** — Inline "Enable" button on disabled hunting and queue-cleaner scheduler rows. One click re-enables the scheduler; the row drops on the next Pulse poll (#341, #343)
- **`cache.refresh`** — Inline "Refresh now" button on stale Plex and Tautulli cache rows. Fires the refresh in the background and returns immediately so slow library refreshes don't trip the HTTP proxy timeout (#342, #343, #345)
- **`queue.retry`** — Inline "Retry" button on failed or stuck ARR queue items (Sonarr / Radarr / Lidarr / Readarr). Reuses the exact SDK call the dashboard queue page already uses, with tight classification (only ARR-reported failures, never speculative), per-instance fan-out cap of 10 rows plus a no-action rollup row for overflow, and sort deprioritization so a bad download-client day can't drown out scheduler/ARR system warnings (#344)

### Changed

#### Trust & Reliability
- **Source-of-truth write-through after every action** — Actions now explicitly update the state collectors read from (`schedulerRegistry.markEnabled`, `CacheRefreshStatus.lastRefreshedAt` upsert), so the "click action → row drops on next poll" contract holds end-to-end (#343)
- **Rate limit on the action route** — `POST /api/pulse/:id/action` is rate-limited at 10/min to guard against runaway clicks or misbehaving scripts hammering upstream Plex/Tautulli (#343)
- **Fire-and-forget `cache.refresh`** — The dispatcher no longer waits for the (potentially 30–60 second) upstream refresh before returning 200, avoiding false "Internal Server Error" toasts when Next.js's proxy timeout trips before the backend finishes. Ownership checks remain synchronous; errors during the background refresh do NOT bump `lastRefreshedAt`, so a failing refresh correctly keeps surfacing (#345)
- **Incognito-safe error toasts** — `usePulseActionMutation` now routes toast error text through the same anonymization helper that Pulse rows use, stripping hostnames, URLs, and IPs before display. Normal-mode output is byte-identical; generic messages ("Rate limit exceeded", "Internal Server Error", "Bad Request") pass through unchanged (#349)
- **Tightened Pulse action labels** — Scheduler-health rows deep-link to `/pulse` with hash anchors rather than generic `/settings`, so the follow-through lands operators on the specific row (#338, #339)

### Removed

#### UX / Cleanup
- **`CacheHealthBanner` removed** — The pre-Pulse dashboard cache-refresh banner duplicated signals Pulse already covers with better severity and actionable deep links. Removed in favor of the canonical attention surface (#346)
- **`CleanupHealthBanner` removed** — Same pattern as `CacheHealthBanner`: the library-cleanup page banner's three signals (scheduler enabled, last-run error, prefetch source health) are all now covered by Pulse collectors. Removed; the one deliberate sensitivity change — Pulse waits for two consecutive failures vs the banner's one — is the correct attention-surface bias and is documented in the PR (#351)
- **Tautological `/pulse` self-links suppressed** — Scheduler-health rows emit `actionUrl: "/pulse#<id>"` so operators deep-link from the dashboard Needs Attention panel; on the `/pulse` page itself, that link just scrolls to the already-visible row and has been suppressed. `/settings`, `/statistics`, `/dashboard` and other cross-page links render unchanged (#347)
- **Unused `confirmLabel` field dropped from the Pulse action envelope** — Originally added as forward-fitting for a possible destructive-action two-tap confirm UX that didn't ship in V1. Audit confirmed zero production consumers. Removed; a future destructive variant can add a kind-specific confirm field with the right scope (#348)
- **Speculative diagnostic copy reworded** — `season-episode-list.tsx` no longer says "may be unreachable" (the component can't know why a fetch failed); `DomainStatusBadge` tooltips for `degraded` and `offline` states now explicitly frame the badge as a last-check snapshot and defer live health to Pulse. Regression guards pin the framing against future drift (#352)

### Deferred (explicit non-scope)

- **No destructive actions.** `queue.remove`, blocklist, and other one-way operations are not in V1. When they arrive they'll use a two-tap confirm UX; the envelope schema is ready for that extension
- **No automation / rules engine.** Every action is a deliberate operator click; nothing retries or remediates on its own
- **No bulk or batch actions.** One row, one click, one action. The `queue.retry` rollup row (+N more) intentionally carries no action — operators handle overflow by navigating to the queue page
- **Scheduler manual-vs-system distinction is not yet modeled.** Today every `markDisabled` call site is a system/init-failure path, so every disabled-scheduler Pulse row is safely re-enableable. If a future code path introduces an intentional-opt-out manual disable, the `scheduler.enable` gate needs to learn the distinction; the collector comment flags this for the implementer who adds it
- **Queue fan-out is intentionally capped at 10 per instance.** Instances with more failed items emit a no-action rollup row pointing at the queue page rather than flooding Needs Attention. Bulk retry UX is explicitly deferred

## [2.15.0] - 2026-04-14

Operability and trust release — a scheduler jobs surface for operators, a Security Posture diagnostic panel, route surface governance, shared UX primitives for consistent trust signals across panels, and targeted cache-refresh hardening for Plex and Tautulli. No new end-user feature modules; every change is aimed at making the existing app more legible, more trustworthy, and easier to ship.

### Added

#### Reliability & Observability
- **Scheduler jobs surface** — New `SchedulerRegistry` centralizes every background job (session snapshot, Plex/Tautulli/Jellyfin cache refresh, hunt, cleaner, TRaSH sync, backups, notifications, etc.) behind a single `/api/system/jobs` operability surface. Operators can inspect last run, next run, last error, and failure isolation per job (#294, #295)
- **Explicit scheduler init failure-handling policy** — New `runSchedulerInit` helper makes scheduler startup failures a deliberate, testable decision per job rather than silent boot-time drift. Pinned by tests that lock the init-failure operator surface (#319)
- **Session-snapshot tick isolation** — A failure in one snapshot collector no longer short-circuits the remaining collectors in the same tick (#303)
- **Integration test coverage** — Risk-based integration tests cover auth, services, scheduler, queue cleaner, and route auth / service lifecycle gaps — reducing the chance a regression in these critical paths ships unnoticed (#315, #316)

#### Security & Trust
- **Security Posture panel** — New diagnostic surface under System → Security Posture flags configuration that weakens the deployment (missing `SESSION_COOKIE_SECRET`, weak `ENCRYPTION_KEY`, lax cookie flags, etc.). Advisory only; nothing is auto-changed. Distinguishes true misconfiguration from opinionated hardening to avoid false alarms (#317)
- **Route surface governance** — Lightweight manifest-driven tier system (`stable` / `operator` / `internal` / `experimental`) classifies every backend route and is enforced in tests. Documented in ADR-0004 (#320)

#### UX Consistency
- **Shared async state presentation** — New `AsyncStateView` primitive standardizes loading / error / empty states across data panels so operators see the same shapes and wording for the same states everywhere (#321, #326)
- **Domain status badges** — Shared `DomainStatusBadge` + 5-state taxonomy (healthy / degraded / offline / configured / disabled) replaces ad-hoc badge variants across Services and Integrations (#324)
- **Data freshness indicator** — Shared `<DataFreshness>` + `describeFreshness()` wired into Pulse, Queue Cleaner, and Validation Health, driven by a scoped ticker so every polling panel reports age consistently (#325)

#### Contributor Experience
- **Domain operating manuals + ADRs** — New per-domain operating manuals plus ADRs covering security posture and route auth, giving contributors and operators a durable reference beyond code comments (#318)

### Fixed

#### Cache Refresh Hardening
- **Plex stale-cache eviction hits Prisma parameter limit** — Bulk stale-cache evictions are now chunked, eliminating sporadic SQLite `P2029` "too many bind variables" failures on larger libraries (#323, #328)
- **Tautulli stale-cache eviction hits Prisma parameter limit** — Same chunking fix applied to the Tautulli eviction path (#329)

#### Pulse Trust
- **Truthful empty state on refresh error** — Pulse no longer shows a misleadingly-clean "all healthy" view after a failed refresh; collector errors now produce a stable, visible failure state with consistent collector-error IDs (#330)
- **Truthful errors + domain-correct tooltips** — Trust surfaces (Pulse, Validation Health, Rules) now surface real error text instead of generic placeholders, and tooltips describe the domain rather than the underlying transport (#327)

#### Service Integrations
- **Lidarr falsely reported unreachable in System Pulse** — Reachability probe now matches Lidarr's response shape (#300, #307)
- **Seerr notification agent types** — Default to `0` when absent rather than erroring out on the requests page (#309)
- **Tautulli activity fields** — Default to empty values when absent rather than breaking the activity view (#302, #310)
- **Jellyfin/Emby partial-watch enrichment** — Populate `lastWatchedAt` for partially-watched series instead of leaving the field null (#311)
- **Jellyfin cleanup rule copy** — Corrected rule description and backfilled the missing Jellyfin test (#314)
- **Queue instance links use `externalUrl`** — Queue item links now respect the configured external URL per instance (#297, #306)
- **Service type buttons overflow in narrow panels** — Settings service-type selector now wraps cleanly in narrow layouts (#291, #305)

### Changed

#### Architecture
- **Plugin/route registration extracted into domain bundles** — `server.ts` now composes domain bundles rather than inlining every `register()` call, making the startup surface easier to audit and extend (#293)
- **Library watch enrichment extended to Jellyfin/Emby** — Watch state enrichment (now-playing, last-watched, episode completion) parity across Plex / Jellyfin / Emby (#304)

#### Tooling
- **pnpm 10.33.0** — Bumped and guarded `action-setup` major bumps in CI (#312)
- **Dependency updates** — Production-dependencies group (17 updates, #298) and dev-dependencies group (3 updates, #299), plus a follow-up production group bump (#313)

## [2.14.0] - 2026-04-09

Media server expansion and setup experience overhaul — full Jellyfin and Emby support with Plex feature parity, OAuth-assisted setup for Plex and Seerr, notification quiet hours, TRaSH Custom Format conflict detection, and a host of UX refinements.

### Added

#### Media Server Expansion
- **Jellyfin support** — Full media server integration with Plex feature parity: now playing, watch history, on-deck, recently added, user/device/codec/transcode/bandwidth analytics, quality score, bandwidth forecast, episode completion, and watch-aware library cleanup. No separate Tautulli-equivalent required — analytics are sourced directly from Jellyfin's API. 7 cleanup rule evaluators expose watch count, last watched, on-deck, user rating, watched-by, added-at, and episode completion (#274)
- **Emby support** — Emby is supported through a unified Jellyfin/Emby backend (they descend from the same codebase). All Jellyfin capabilities work identically for Emby, and multi-instance aggregates combine data across Jellyfin and Emby instances (#277)

#### OAuth-Assisted Setup
- **Plex OAuth** — New **Connect with Plex** button in the service form triggers a plex.tv PIN flow that discovers your reachable Plex servers with per-connection reachability badges (Local/Remote/Relay, SSL indicator, Recommended label). The best reachable connection auto-fills the URL and token fields. Works in both add and edit modes; manual entry remains available as a fallback (#264)
- **Seerr auto-setup via Plex sign-in** — New **Sign in to Seerr with Plex** button authenticates to your Seerr instance using your Plex token and auto-fetches the Seerr API key from the admin settings endpoint. Requires admin access on the Seerr instance and Plex login enabled; falls back to specific error messages if requirements aren't met (#265)

#### Setup UX
- **Getting Started banner** — When fewer than three services are configured, the Services page shows a guided banner listing recommended services (Plex, Sonarr, Radarr, Seerr, Tautulli, Jellyfin, Emby, Prowlarr) with descriptions and **Auto-setup** badges for services with OAuth helpers. Clicking a recommendation jumps straight into the add-instance form with the service type pre-selected (#266)
- **URL suggestions** — After you add one service, the form offers companion-service URL suggestions derived from existing service hosts (e.g., if Plex is at `192.168.1.100:32400`, the form suggests `:5055` for Seerr, `:8181` for Tautulli, `:8989` for Sonarr, etc.). Incognito-aware — URLs are anonymized in incognito mode (#266)
- **Connection test feedback** — Successful connection tests display the detected service version as a badge; failures show specific error messages with troubleshooting hints (authentication proxy detection, endpoint-not-found, invalid response format) (#266)

#### TRaSH Guides
- **Custom Format conflict detection** — Deployment previews now cross-reference selected custom formats against the upstream TRaSH `conflicts.json` registry and display advisory warnings when mutually exclusive CFs would be deployed together. Warnings are informational only — deployment is not blocked (#286)
- **Quality size preset upstream update warnings** — Previewing a previously-applied quality size preset now compares a SHA-256 hash of the current upstream data against the hash recorded at your last apply. If they differ, a banner surfaces: "This preset has been updated since you last applied it" — letting you stay aligned with upstream changes without surprise (#267)

#### Notifications
- **Quiet hours** — New notification rule action type that defers non-critical notifications during a configurable time window (HH:MM, IANA timezone, overnight ranges supported). Critical events — `SYSTEM_ERROR`, `ACCOUNT_LOCKED`, `LOGIN_FAILED`, `SERVICE_CONNECTION_FAILED`, `BACKUP_FAILED` — always bypass the window. Deferred notifications are flushed in arrival order when the window ends. Fails closed on malformed config (#267)

#### UI & UX
- **Week Starts On setting** — Settings → Appearance now offers a Sunday/Monday toggle for the calendar grid's first column. Stored per-browser in local storage (#281)
- **Collapsible sidebar groups** — Sidebar navigation is reorganized into four collapsible groups (Overview, Media, Maintenance, Configuration). Collapse state persists across sessions and the group containing the active page auto-expands on navigation. Accessible: `aria-expanded` headers, `aria-current="page"`, keyboard-navigable (#270, #283)

### Fixed
- **Rootless container startup** — The container now supports `--user UID:GID` / `user: "UID:GID"` in Compose for rootless deployments. Startup gracefully skips permission setup when the process cannot chown, dropping straight into application start (#282)
- **Mobile responsive settings** — Settings page and service forms now lay out correctly on small screens; previously, the forms overflowed viewport width on mobile (#268)
- **Calendar layout shift** — Navigating between months no longer causes content reflow/layout shift in the grid view (#279)

### Changed
- **PUID/PGID docs** — Updated PUID/PGID usage guidance to clarify when to use the default PUID/PGID convention vs the new rootless `--user` flag. Warns against combining `--user` with PUID/PGID, which produces conflicting instructions (#278)
- **Production dependencies** — 10 dependency updates across the production-dependencies group (#275)
- **Dev dependencies** — 2 dependency updates across the dev-dependencies group (#276)

### Security
- **Input validation hardening** — Tightened input validation at challenge store boundaries, hardened SQL construction paths, and addressed findings from a targeted auth audit (#285)
- **defu & vite vulnerabilities** — Patched transitive vulnerabilities in `defu` and `vite` via `pnpm.overrides` (#284)
- **hono, nodemailer, prisma bumps** — Patched 7 open Dependabot alerts by raising transitive floors (`hono` 4.12.11 → 4.12.12, `@hono/node-server` 1.19.11 → 1.19.13) and bumping direct deps (`nodemailer` 8.0.4 → 8.0.5, `prisma` / `@prisma/client` / adapters 7.6.0 → 7.7.0). `hono` is transitive via `@prisma/dev` dev tooling and not reachable in production (#288)

## [2.13.0] - 2026-03-31

Codebase hardening release — lint infrastructure overhaul, frontend type safety, security audit, dependency modernization, and CI optimization. No new features; focused on reliability, maintainability, and developer experience.

### Changed

#### Codebase Quality
- **Biome config audit** — Updated schema to v2.4.10, added `noConsole` rule, removed stale exclusions. Test files now linted (77 previously invisible). Production code: 76 → 0 Biome warnings (#251)
- **Frontend type safety** — Fixed 140 → 5 `no-explicit-any` ESLint warnings across 24 files. New wizard type system (`WizardCustomFormat`, `WizardCFGroup`, etc.) properly types TRaSH Guides data flowing through the quality profile wizard (#253)
- **Dead code removal** — Removed 21 unused files (~3,300 lines), 6 unused dependencies, 5 empty barrel files, ~60 unused exports. Added Knip to CI for regression prevention (#251, #252)
- **Circular dependencies** — Fixed all 4 real circular dependency cycles (1 API, 3 web) by extracting shared types (#252)

#### Dependencies
- **TypeScript** 5.9.3 → 6.0.2 — Last JS-based compiler before Go rewrite. Migrated tsconfig: removed deprecated `baseUrl`, converted to relative paths (#256)
- **ESLint** 9.39.4 → 10.1.0 — Modern engine with JSX scope analysis (#256)
- **lucide-react** 0.577.0 → 1.7.0 — `aria-hidden` default on icons for better accessibility (#256)
- **jsdom** 27.4.0 → 29.0.1 — Spec-compliant CSSOM for more accurate test environment (#256)

#### CI/CD
- **E2E production builds** — Switched from dev mode to production builds for E2E tests. Eliminates timeout flake: slowest shard 15m19s → 4m35s (-70%), wall clock 15m19s → 6m25s (-58%) (#257)
- **Knip dead code check** — Added to CI pipeline for automated dead code detection (#252)

#### Repository Structure
- **Screenshots reorganized** — Moved 16 PNGs from root to `docs/screenshots/`, refreshed with incognito mode enabled (#258, #262)
- **Stale files removed** — Deleted completed review docs, one-time migration scripts, Unraid template (now on addon store) (#258)
- **Documentation updated** — Rewrote `docker/README.md` with complete env vars table, corrected `docs/AUTH.md`, added missing routes to `docs/API-ROUTES.md` (#258)
- **GitHub best practices** — Added `SECURITY.md`, `CONTRIBUTING.md`, `.gitattributes`, `.editorconfig`, issue template config (#258)

### Fixed
- **Discover incognito mode** — Poster images, titles, and overview text now properly anonymized when incognito mode is enabled (#260)
- **Calendar incognito mode** — Grid event chips now show anonymized titles; network/studio name hidden from detail card (#262)
- **System settings incognito** — Database host, listen address, and log file names now masked in incognito mode (#260)
- **Discover genre scrollbar** — Scrollbar no longer overlaps genre pill content on the `/discover` page (#254)
- **Queue cleaner incognito** — Added missing incognito mode to queue cleaner statistics and preview displays (#250)

### Security
- **Passkey validation** — Replaced `z.any()` with proper WebAuthn Zod schema for passkey registration/login. Malformed payloads now rejected at the validation gate before reaching `@simplewebauthn/server` (#255)
- **OIDC error sanitization** — Reflected `error`/`error_description` from identity providers now truncated and stripped of control characters (#255)
- **OIDC state exhaustion** — In-memory state map capped at 1,000 entries with oldest-entry eviction (#255)
- **CSP hardening** — `connect-src` now dynamic (localhost in dev, `'self'` in production). Removed `unsafe-eval` from production `script-src` (#255)
- **ESLint `no-console`** — Added to web package with `allow: ["warn", "error"]` to catch stray debug logging (#251)

## [2.12.0] - 2026-03-30

Seerr Requests Experience, API stability improvements, and full security sweep.

### Added

#### Seerr Requests Experience
- **Request lifecycle visibility** — Timeline view showing the full journey of each request from creation through approval to availability. Requester popover with user details. Deep-linking to individual requests via query params (#225)
- **Requests UX improvements** — Lifecycle visibility, accessibility enhancements, and queue preview for the Seerr requests page (#229)
- **Dashboard Seerr widget upgrade** — Inline pending request display with one-click approve directly from the dashboard (#236)
- **"Needs Attention" signal** — Seerr dashboard widget now highlights items that need manual action (#237)

#### Library Cleanup
- **Cross-service cleanup rule templates** — Pre-built templates for common cleanup scenarios across Sonarr, Radarr, Plex, and Tautulli (#221)
- **Requester evaluators** — Cleanup rules can now evaluate Seerr requester data. New Discover request options for rule authoring (#223)

### Fixed
- **API heap out-of-memory crash** — Four cache schedulers (Plex, Tautulli, episode, session-snapshot) all fired within 30 seconds of startup. With many service instances, overlapping memory peaks exceeded the 512MB heap limit. Staggered startup delays (30s/2min/5min), paginated session snapshot platform cache, released Plex refresher intermediates earlier, and bumped default heap to 768MB (#239, #242)
- **Plex session schema** — Relaxed schema validation to tolerate type variance across Plex server versions (#228)
- **Pino logging conflict** — Removed shell stdout redirect that conflicted with Pino's worker-thread transport, causing empty log files (#238)
- **Seerr widget hydration error** — Fixed nested `<a>` tags in the dashboard Seerr widget that caused React hydration mismatches
- **Seerr "View" link destination** — Stuck attention items now link to the "All Requests" tab instead of the pending approval tab where they wouldn't appear. Added `?tab=` deep-link support to the requests page
- **Tautulli/Plex validation** — Improved statistics code quality and data validation (#233, #241)

### Changed
- **Logging** — Routed all remaining `console.warn`/`console.error` calls through Pino structured logger (#240)
- **CI** — Fixed Docker Hub login for Dependabot PRs — login step now skips when secrets are unavailable (#246)

### Security
- **nodemailer** 8.0.3 → 8.0.4 — SMTP command injection fix
- **picomatch** 4.0.3 → 4.0.4, 2.3.1 → 2.3.2 — ReDoS and method injection fixes
- **brace-expansion** 5.0.4 → 5.0.5, 1.1.12 → 1.1.13 — memory exhaustion fix
- **yaml** 2.8.2 → 2.8.3 — stack overflow via nested collections fix
- **prisma** 7.5.0 → 7.6.0, **@tanstack/react-query** 5.95.1 → 5.95.2, **turbo** 2.8.20 → 2.9.1, **@biomejs/biome** 2.4.8 → 2.4.10, **vitest** 4.1.0 → 4.1.2

### Tests
- First-wave test coverage for library cleanup, auth, services, and notifications (#224)
- Seerr-backed integration tests for the requests experience (#231)

## [2.11.0] - 2026-03-24

System Pulse — a unified attention feed that synthesizes health signals from every connected service into a single prioritized page.

### Added

#### System Pulse — Unified Health Attention Feed
- **Pulse page** — New `/pulse` page as the first item in sidebar navigation. Aggregates health signals from all connected services into a prioritized feed grouped by severity (critical, warning, info). Severity sections are collapsible with item counts. Empty state shows "All clear" when no issues detected
- **ARR health monitoring** — Surfaces health issues and warnings reported by Sonarr, Radarr, Prowlarr, Lidarr, and Readarr instances. ARR errors map to critical severity, warnings to warning severity
- **Disk space alerts** — Warns when any ARR instance's storage exceeds 80% (warning) or 90% (critical). Deduplicates shared storage groups to avoid double-counting
- **Instance unreachable detection** — Detects when ARR instances fail to respond to health checks and surfaces them as critical signals. Also catches client creation failures (e.g., bad API key)
- **Seerr circuit breaker visibility** — Surfaces Seerr outages (circuit breaker OPEN → critical) and recovery state (HALF_OPEN → warning) on the Pulse page
- **Cache staleness tracking** — Warns when Plex or Tautulli cache data hasn't refreshed in 12+ hours or when the last refresh resulted in an error
- **Validation health signals** — Surfaces integration validation failures (TRaSH, Seerr, Plex, Tautulli) from the validation health registry. Failing integrations are critical, degraded are warning
- **Quality cutoff signal** — Shows an info-level count of library items below their quality profile cutoff, with a direct link to the filtered library view
- **Operation failure alerts** — Surfaces hunt failures, queue cleaner errors, and TRaSH sync failures from the last 24 hours. Capped at 5 items per category to avoid noise
- **Server-side caching** — Pulse response is cached per-user for 60 seconds to avoid excessive ARR API calls on page refresh. Frontend polls every 120 seconds (POLLING_STATS interval)

## [2.10.1] - 2026-03-24

### Fixed

- **Quality filter not applied** — The library "Quality" dropdown (Cutoff unmet / Cutoff met) was not filtering results because the `cutoffUnmet` parameter was missing from the API client's URL serialization. The filter UI, backend validation, and database query all worked correctly — only the HTTP request was missing the parameter

## [2.10.0] - 2026-03-24

Cross-service Library Intelligence, TRaSH scheduled sync, quality upgrade visibility, and foundational reliability improvements.

### Added

#### Library Intelligence — Cross-Service Insights
- **Library Insights section** — New advisory panel on the Library page that surfaces actionable signals by correlating data across Sonarr/Radarr, Plex, and Seerr. Three signals: unwatched disk waste (large files with zero Plex plays), watched items still monitored (wasting indexer searches), and Seerr-requested content never watched
- **Insight quick actions** — Inline "Unmonitor" button on watched-monitored and disk-waste items. Per-item "Dismiss" to hide items from the panel (persisted in localStorage)
- **Priority summary** — Section header shows total count with breakdown by category and a contextual priority cue ("Start with requested items — someone is waiting")
- **Insight notifications** — Two new event types: `LIBRARY_INSIGHT_REQUESTED_UNWATCHED` and `LIBRARY_INSIGHT_WATCHED_MONITORED`. Scheduler runs every 6 hours with 24-hour cooldown. Notifications deep-link to the relevant panel via `?insight=` query param

#### TRaSH Scheduled Sync
- **Sync scheduler** — Background scheduler executes template syncs based on `TrashSyncSchedule` rows. Checks every 60 seconds for due schedules, validates before executing, advances `nextRunAt` even on failure to prevent retry storms
- **Schedule management API** — CRUD endpoints at `/api/trash-guides/schedules` with ownership enforcement and duplicate prevention
- **Schedule modal** — Per-instance schedule creation/editing via the existing `TemplateScheduleModal` (previously built but unconnected). Shows last run time, next run time, and includes a two-step "Remove Schedule" button

#### Quality Upgrade Intelligence
- **Cutoff-unmet tracking** — New `cutoffUnmet` column on `LibraryCache`, populated during library sync from Sonarr/Radarr `/wanted/cutoff` endpoint. Lidarr/Readarr gracefully skipped
- **Quality filter** — New "Quality" dropdown in the library header with options: All quality, Cutoff unmet, Cutoff met
- **Cutoff badge + upgrade button** — Amber "Cutoff Unmet" badge on library cards with an inline "Upgrade" search button that triggers the existing Sonarr/Radarr search command

#### Hunting
- **Lidarr grab detection** — Accurate `itemsGrabbed` counts for Lidarr hunts using album-based history comparison. Previously hardcoded to 0
- **Readarr grab detection** — Same for Readarr using book-based history comparison. Both services fall back to queue-based detection on history API failure

#### Other
- **Template staleness display** — Template cards now show "Synced [date]" and amber "Modified" badge for templates with local changes
- **System hooks** — Extracted 7 inline queries and 3 mutations from `system-tab.tsx` and `validation-health-section.tsx` into shared `useSystem` hooks and `system` API client module
- **Master workflow command** — `.claude/commands/work.md` dispatches to existing commands based on task context

### Fixed

- **Passkey login cache invalidation** — Post-passkey login now correctly invalidates `["current-user"]` instead of `["user"]`, fixing stale auth state after WebAuthn authentication
- **Silent mutation failures in Settings** — Service create/update/delete/toggle, notification rule save/delete/toggle, subscription grid save, and channel config load now show clear error toasts on failure instead of silent no-ops
- **Notification fetch error masquerading as empty state** — Rules tab and subscription grid now show a proper error state with retry guidance instead of misleading "no rules configured" when the API call fails
- **Channel config load error swallowed** — Editing a notification channel that fails to load its config now shows an error message with "Go back" link instead of rendering an empty new-channel form
- **Service delete without confirmation** — Service instance delete, tag delete, and Seerr bulk decline/delete now require two-step inline confirmation (click → "Confirm?" → click within 3 seconds)
- **Dead-end empty states** — Dashboard "no instances" text, hunting overview "go to Configuration tab" text, hunting config "add in Settings" text, and sync history "No Instance Selected" page now have actionable links to the correct destination
- **Incognito mode gaps** — 6 TRaSH-guides components (template-card, template-stats, sync-validation-modal, sync-progress-modal, template-schedule-modal, template-list) now mask instance names when incognito mode is active

### Changed

- **Query key centralization** — Replaced ~40 inline query key string arrays across 15 hook files with centralized imports from `query-keys.ts`. Added 12 new key definitions. Fixed `qualityProfileKeys.overrides` parameter type (`string` → `number`). Fixed 3 files importing `TEMPLATES_QUERY_KEY` from wrong source
- **Request validation hardening** — 15+ API route handlers now use `validateRequest()` with Zod schemas: template-sharing (4 handlers), profile-clone (6 handlers), bulk-score export, user-CF deploy, hunting trigger, passkey login verify (added `sessionId` to schema), and service test-connection
- **Notification event types** — Added "Library Insights" group to the notification subscription grid with two new event types

## [2.9.3] - 2026-03-23

### Fixed

- **Lidarr unmonitored album tracks still counted as missing (#209)** — v2.9.2 filtered by artist-level monitoring but used `totalTrackCount` (all albums) instead of `trackCount` (monitored albums only). Fixed in dashboard statistics, artist normalizer, library card, and album breakdown modal
- **Semgrep unsafe format string in OIDC retry logging (#165)** — Replaced template literal with comma-separated arguments

### Dependencies

- Fastify 5.8.2 → 5.8.4 (CVE-2026-3635 security fix)
- TanStack Query 5.95.0 → 5.95.2, TanStack Query Devtools 5.95.0 → 5.95.2

### Added

- **GitHub issue templates** — Structured bug report and feature request forms with version, deployment method, connected services, and logs fields
- **GitHub PR template** — Checklist covering validation, query keys, polling constants, incognito mode, and ownership checks
- **Claude Code commands** — 9 slash commands for development workflows (fix-issue, release-prep, validate, review-pr, feature-audit, security-pass, stabilize-branch, release-patch, prepare-changelog)
- **Claude Code skills** — 5 domain-specific reasoning skills (frontend architecture, release engineering, integration auditing, auth review, regression hunting)

## [2.9.2] - 2026-03-23

Bug fixes, dependency updates, OIDC compatibility, and frontend architecture improvements.

### Fixed

- **Calendar Sunday events (#207)** — Events were bucketed by UTC date (`airDateUtc`) instead of local air date (`airDate`), causing shows airing Sunday evening in negative UTC timezones to appear on Monday. Now uses the local air date for grid bucketing and UTC for intra-day sort ordering
- **Sonarr/Lidarr statistics (#209)** — Dashboard and statistics showed inflated missing counts and inconsistent downloaded percentages. Sonarr now uses monitored episode count (not total) as the denominator. Lidarr now only counts tracks from monitored artists
- **OIDC Authentik compatibility (#208)** — Authentik includes a trailing slash in its canonical issuer URL, causing `oauth4webapi` strict comparison to fail. New `resolveCanonicalIssuer()` fetches the provider's discovery document to store the exact canonical issuer. Self-healing retry in login flow auto-corrects existing stored issuers without database migration

### Changed

#### Architecture — Frontend Query Infrastructure
- **Centralized query keys** — Consolidated all React Query keys into `query-keys.ts`. Migrated 15 hook files from local KEYS objects and inline string arrays to centralized key factories. Eliminates key drift and enables consistent cache invalidation
- **Polling standardization** — Migrated 28 inline `refetchInterval` values to 6 named constants (`POLLING_REALTIME` 15s through `POLLING_BACKGROUND` 5min). All polling intervals are now auditable from a single file
- **`useRefreshState` hook** — Extracted the 6-copy "isRefreshing + setTimeout" pattern into a shared hook with proper timeout cleanup on unmount, fixing a potential memory leak in 5 of 6 original implementations
- **`useEnrichableItems` hook** — Extracted duplicated library item enrichment logic from Seerr and Plex hooks. Fixes a hidden type mapping inconsistency where Seerr used `"tv"` and Plex used `"series"` for the same concept — both now declare their mapping explicitly

#### Documentation
- **CLAUDE.md rewrite** — Reduced from 1,177 to 158 lines (87% smaller). Extracted detailed reference sections to `docs/THEMING.md`, `docs/AUTH.md`, `docs/API-ROUTES.md`

### Dependencies

- Prisma 7.4.2 → 7.5.0
- Next.js 16.1.7 → 16.2.1
- TanStack Query 5.90.21 → 5.95.0
- Tailwind CSS 4.2.1 → 4.2.2
- Biome 2.4.6 → 2.4.8
- Vitest 4.0.18 → 4.1.0
- better-sqlite3 12.6.2 → 12.8.0
- pnpm/action-setup v4 → v5
- 24 production + 4 dev dependency updates total
- `effect` override to 3.20.0 (Dependabot alert #32)

### Added

- **Authentik OIDC test infrastructure** — Docker Compose setup with PostgreSQL, Redis, and Authentik for end-to-end OIDC flow testing. Validates trailing-slash issuer handling against a real Authentik instance

## [2.9.1] - 2026-03-20

Security patches, comprehensive incognito mode coverage, and TRaSH Guides cloning improvements.

### Security

- **Dependency overrides** - Updated `hono` to 4.12.8 (CVE-2026-29045, CVE-2026-29085, CVE-2026-29086, GHSA-v8w9), `@hono/node-server` to 1.19.11 (CVE-2026-29087), and `flatted` to 3.4.2 (prototype pollution)
- **Input sanitization** - Added type and length validation for TRaSH profile match fields in clone template API
- **Semgrep fix** - Resolved unsafe format string finding in pattern tester

### Fixed

#### Incognito Mode (Hide Sensitive Data)
- **Complete coverage across all features** - Extended incognito mode to 40+ components across every page, tab, modal, filter dropdown, chart, and toast message in the application
- **Dashboard** - Now hides media titles, usernames, server names, device names, and platform info in Plex widgets (Now Playing, Continue Watching, Recently Added, Watch History, Server Info), health messages (download client names), and username greeting
- **Library** - Hides titles, overviews, poster images, instance names, file paths, and Plex usernames in library cards, detail modals, and filter dropdowns
- **Calendar** - Anonymizes event titles, instance names, and overviews in calendar cards and filter dropdowns
- **Statistics** - Hides Plex usernames, media titles, device/player names, and platform names across all charts (user analytics, watch history, device chart, quality scores)
- **Requests (Seerr)** - Anonymizes media titles, user display names, email addresses, avatar images, and overviews across all tabs (requests, users, issues, history, settings dialog)
- **Hunting** - Hides instance names, grabbed item titles, and indexer names in config cards and activity logs
- **Queue Cleaner** - Anonymizes instance names and item titles in config, overview, activity logs, and toast messages
- **Library Cleanup** - Hides media titles in approval queue, log details, and rule evaluation dialog
- **Notifications** - Anonymizes channel names and event titles in notification logs
- **Settings** - Hides instance labels, service URLs, and username on Account tab
- **Topbar** - Anonymizes username display and avatar initial
- **Queue messages** - Added Lidarr music release anonymization patterns for artist/album names, file paths with nested brackets, and download client names in health messages
- New utility functions: `getLinuxUsername`, `getLinuxDevice`, `getLinuxSectionName`, `getLinuxServerName`, `getLinuxEmail`

#### TRaSH Guides
- **Cloned template quality display** - Templates created via "Clone from Instance" now properly show quality configuration in the editor instead of "No Quality Configuration" empty state
- **TRaSH profile linking** - Cloned templates are now linked to their matching TRaSH Guides profile (e.g., SQP-2) for ongoing score updates. User score overrides are preserved via the existing `scoreOverride` system

## [2.9.0] - 2026-03-19

v2.9 is the largest feature release since 2.0 — adding media server awareness, a notification system, library lifecycle management, and TRaSH naming scheme deployment.

### Added

#### Plex Media Server Integration
- **Now Playing Dashboard Widget** - Real-time view of active Plex streams with user avatars, media thumbnails, progress bars, transcode/direct play indicators, and bitrate/bandwidth metrics. Merges sessions from both Plex and Tautulli for enriched data
- **Plex Statistics Tab** - Dedicated statistics view with watch history, top users, most-watched content, and library utilization
- **Watch History Enrichment** - Library items display Plex watch status, play count, and last-watched date when a Plex server is connected
- **Background Cache Refresh** - Scheduled polling of Plex sessions and library data with configurable intervals

#### Tautulli Integration
- **Activity Monitoring** - Real-time stream activity with bandwidth metrics (LAN/WAN breakdown)
- **Watch Statistics** - Historical watch data aggregation surfaced in the Statistics and Library pages
- **Session Merging** - Intelligently merges Plex and Tautulli session data for the richest possible Now Playing view

#### Seerr Integration
- **Request Management** - View, approve, and decline media requests from Seerr directly within the dashboard
- **User Management** - Browse Seerr users with request counts and permissions
- **Issue Tracking** - View and manage reported issues from Seerr
- **Notification Agents** - Configure Seerr notification agents from the dashboard
- **Library Enrichment** - Library items display Seerr request status and requester info
- **Discover Integration** - TMDB discover page enhanced with Seerr availability data

#### Notification System
- **7 Notification Channels** - Discord (webhooks), Telegram (Bot API), Email (SMTP), Pushover, Gotify, Pushbullet, and Browser Push (Web Push API)
- **Event Subscriptions** - Per-channel subscription grid for 12+ event types: system startup, deployment complete, sync complete, hunt complete, queue cleaner actions, backup complete, library cleanup actions, and more
- **Rich Metadata** - All notifications include contextual metadata (instance names, affected items, durations, error details)
- **Notification Logs** - Searchable history of all dispatched notifications with delivery status
- **Test Send** - One-click test delivery per channel for verification during setup

#### Library Cleanup
- **Rule-Based Cleanup Engine** - Define rules to identify library items for removal based on 20+ condition types: age, size, rating, genre, tag, quality profile, watched status (via Plex/Tautulli), request status (via Seerr), monitored state, and more
- **Approval Queue** - Dry-run mode evaluates rules and presents candidates for human review before any deletion
- **Multi-Source Enrichment** - Rules can reference data from Plex (watch status), Tautulli (play count/last watched), and Seerr (request status) for intelligent cleanup decisions
- **Scheduled Execution** - Automated runs with configurable intervals and approval requirements
- **Audit Logging** - Complete history of cleanup actions with item details and rule matches

#### TRaSH Guides Naming Scheme Deployment
- **Naming Preset Selection** - Apply TRaSH-recommended naming schemes for Radarr (movie file/folder) and Sonarr (standard/daily/anime episode, season folder, series folder)
- **Preview & Diff** - See exactly what will change before applying naming schemes
- **Per-Instance Config** - Each instance can have independent naming configurations
- **Auto-Sync** - Optionally keep naming schemes in sync with TRaSH updates

#### TRaSH Guides Enhancements
- **Zod Runtime Validation** - All TRaSH GitHub JSON data is now validated with Zod schemas at fetch time, replacing unsafe `as` type casts. Catches upstream format changes before they cause runtime errors
- **Profile Groups UI** - Quality profiles organized into logical groups (Standard, Anime, French, German, SQP) for easier template building
- **CF Group Scores** - Custom format group scores now visible and configurable in the quality profile wizard

#### Health & Observability
- **Health Check Endpoint** - `GET /health` returns database connectivity status, application version, and commit SHA. Used by Docker `HEALTHCHECK` for container orchestration
- **Startup Banner** - Structured log line on startup: `arr-dashboard v2.9.0 started (commit: abc1234)` with database type, log level, and listen address
- **Version in System Info** - `/api/system/info` now includes commit SHA alongside version

#### Hunting Overhaul (#187)
- **Full Wanted List Pagination** - Hunting now fetches the complete wanted list (up to 10K items at pageSize=500) instead of a single page with a calculated offset, guaranteeing every item is reachable across multiple hunt cycles
- **Upgrade Search All Toggle** - New opt-in "Include all monitored items" toggle re-searches all monitored items with files, catching items Arr doesn't flag after quality profile changes
- **Diagnostic Funnel Messages** - Hunt results now show exactly where items were eliminated: "Fetched 500 → 320 passed filters → all 320 recently searched"

#### UI Consistency Overhaul
- **Backdrop Blur Cleanup** - Removed decorative `backdrop-blur` from ~40 static containers while preserving it on functional overlays (modals, dropdowns)
- **Three-Tier Card System** - Formalized Light (`bg-muted/10`), Elevated (`bg-card/50`), and Floating (`bg-card/30 + blur`) container tiers
- **Light/OLED Mode Fix** - Replaced `bg-card/10` with `bg-muted/10` across 53 files for visibility on white/black backgrounds
- **Form Input Standardization** - Migrated inline input styles to `INPUT_BASE_CLASSES` from `theme-input-styles.ts`

#### Performance Optimizations
- **Batched Plex Cache Upserts** - Transactions of 100 items instead of individual upserts (10-50x faster on RPi/NAS)
- **SessionSnapshot Index** - Added standalone `capturedAt` index for analytics queries
- **Known-Platforms Cache** - 6-hour in-memory cache eliminates 10K-row fetch every 5 minutes
- **Seerr Notification Agents Cache** - 5-minute TTL with invalidation on update
- **Dashboard Polling** - Disabled media polling on inactive tabs (60s vs 15s), queue polling reduced to 30s
- **ColorThemeProvider Memoization** - Prevents 355 subscriber re-renders on provider mount
- **NavContent Module Scope** - Prevents nav tree remounts on sidebar state changes
- **ManualImportModal Lazy Loading** - Deferred chunk load until modal opens
- **Schema Fingerprinting** - Only runs on first item per category (was every validated item)
- **next/image for Plex Posters** - Layout shift prevention with width/height on poster thumbnails

### Changed

- **Comprehensive Security Hardening** - Input sanitization, Helmet security headers (HSTS, X-Content-Type-Options, X-Frame-Options), rate limiting on new endpoints, CUID validation on route parameters, and session logout logging
- **Service Type Taxonomy** - Centralized service type enum prevents crashes when non-ARR services (Plex, Tautulli, Seerr) are passed to ARR-only code paths
- **Silent `.catch()` Cleanup** - Background notification dispatches now log at debug level instead of silently swallowing errors
- **Boolean Parser Extraction** - Shared utility for parsing string booleans from query parameters, replacing ad-hoc `=== "true"` checks

### Fixed

#### Bug Fixes (from v2.8.5, included in this release)

- **Queue Cleaner Misses Radarr importBlocked Items** - Queue Cleaner now detects all `importBlocked` items regardless of cleanup level ([#129](https://github.com/Kha-kis/arr-dashboard/issues/129))
- **Prisma Client Regeneration Fails on PostgreSQL in Docker** - Standalone tsconfig.json for Docker runtime ([#130](https://github.com/Kha-kis/arr-dashboard/issues/130))
- **Sonarr Missing Episode Stats Overcount** - Uses `episodeCount` instead of `totalEpisodeCount` ([#131](https://github.com/Kha-kis/arr-dashboard/issues/131))
- **Queue Remove Dropdown Clipped** - Replaced inline dropdowns with portaled Radix DropdownMenu ([#132](https://github.com/Kha-kis/arr-dashboard/issues/132))
- **LOG_LEVEL Environment Variable Ignored** - Custom logger now wired into Fastify via `loggerInstance` ([#133](https://github.com/Kha-kis/arr-dashboard/issues/133))

#### Release Hardening

- **PostgreSQL Secrets Migration** - Upgrading from v2.8.x with PostgreSQL no longer silently regenerates encryption keys. The startup sequence now checks the legacy secrets path (`/app/api/data/secrets.json`) and auto-migrates to `/config/secrets.json` (#141)
- **Library Cleanup Safety Rails** - Bulk approval capped at 100 IDs per request; "Run Now" button requires confirmation dialog with context-aware messaging (#142)
- **Notification Payload Truncation** - Metadata arrays truncated to 15 items, Discord fields capped at 1024 chars/25 fields/5500 total, Telegram messages capped at 4000 chars. Prevents silent delivery failures (#143)
- **Plex/Tautulli Cache Eviction** - Cache refresh now evicts stale rows for items removed from Plex or Tautulli, preventing unbounded table growth (#144)
- **Integration Observability** - New `/api/plex/cache/:id/status` and `/api/tautulli/cache/:id/status` endpoints plus manual refresh triggers (#145)
- **Notification Delivery Tracking** - Per-channel `lastSentAt`/`lastSendResult` fields track real delivery status alongside existing test status (#146)
- **Cleanup Audit Transparency** - Log table rows expand to show per-item details (matched rule, reason, action, status) (#147)

#### Additional Fixes

- **Plex/Tautulli Schema Hardening** - Zod schemas updated for nullable `title`, `ratingKey`, `guids`, `media_type` fields; `rating_key` uses `z.coerce.string()` for numeric values from Tautulli
- **Cache Refresh Error Messages** - Schedulers now store actual error text (first 3 messages, truncated to 200 chars) instead of generic "N item errors"
- **Lidarr/Readarr Dedup Fix** - Hunting dedup maps skip records with undefined IDs instead of collapsing them to key `0`
- **Seerr Issue Pagination** - Increased page size from 20 to 100 (5x fewer serial API calls)
- **Calendar E2E Tests** - Updated selectors for v2.9 calendar redesign (heading, filters, navigation)
- **Seerr Test Assertions** - Fixed 4 broken tests that checked `mock.calls[0]` instead of `mock.calls[1]` due to CSRF prefetch
- **Skip Future Episodes** - Queue Cleaner can now optionally skip future (unaired) Sonarr episodes
- **Scheduler Test Stability** - Fixed flaky scheduler tests by matching per-config reset implementation

### Security

- **Dependency Updates** - Updated next (16.1.7), undici (7.24.0), flatted (3.4.0) resolving 11 CVEs including HTTP smuggling, CSRF bypasses, WebSocket DoS, and CRLF injection
- **SSRF Prevention** - Plex image proxy rejects paths containing `..` to prevent path traversal past the `/library/metadata/` prefix
- **CSRF Retry Fix** - Seerr client now throws the actual retry error instead of silently discarding it and re-throwing the stale 403
- **Silent Failure Fixes** - Added logging to 6 previously silent catch blocks: `safeRequest`, notification retry handler, cache-manager delete, template-updater corrupt JSON, aggregation buffer flush, Plex cache eviction skip
- **Dependabot Alerts Resolved** - Patched minimatch (ReDoS) and ajv (prototype pollution) via version overrides
- **Fastify Helmet** - Content Security Policy headers on all API responses
- **Notification Channel Encryption** - All channel configurations (webhook URLs, API tokens, SMTP credentials) encrypted at rest with AES-256-GCM

### Testing

- **1073 Unit Tests** - All passing (0 failures), covering notification system, Seerr integration, validation system, cleanup rule evaluators, and Plex route helpers
- **E2E Integration Suite** - 18 specs covering all features, 3 shards for parallel execution
- **CI Pipeline Optimized** - Merged lint+test job, Docker build parallel with E2E, cancel-in-progress on new push
- **TRaSH GitHub Schema Tests** - 583 lines of validation tests ensuring upstream TRaSH JSON format compatibility
- **Naming Deployer Tests** - 497 lines covering naming scheme application logic
- **Database Upgrade Tested** - Verified SQLite and PostgreSQL v2.8→v2.9 upgrade path with data preservation

### Upgrade Notes

> **Database:** v2.9.0 adds new tables for notifications, library cleanup, Plex/Tautulli/Seerr caching, and naming configuration. These are created automatically by `prisma db push` on startup — no manual migration required.
>
> **Plex/Tautulli/Seerr:** These integrations are optional. If you don't configure these services in Settings, no related features will appear in the UI.
>
> **Notifications:** No channels are configured by default. Visit Settings → Notifications to set up your preferred channels.
>
> **PostgreSQL Users Upgrading from v2.8.x:** Your `secrets.json` was previously stored at `/app/api/data/secrets.json`. v2.9 now stores it at `/config/secrets.json`. The migration is **automatic** — existing secrets are copied on first startup. No manual action required, but the log will show: `Migrating secrets from legacy path (v2.8.x upgrade)`.
>
> **Volume:** Ensure your `/config` volume is preserved. This directory contains `prod.db` and `secrets.json`. Standard Docker upgrades preserve this automatically.

---

## [2.8.5] - 2026-03-02

### Fixed

- **Queue Cleaner Misses Radarr importBlocked Items** - Queue Cleaner now detects all `importBlocked` items regardless of cleanup level. Previously items were silently dropped at "safe" level when status messages didn't match known keywords. Also handles `failedPending` state and counts `importBlocked` in queue summary ([#129](https://github.com/Kha-kis/arr-dashboard/issues/129))
- **Prisma Client Regeneration Fails on PostgreSQL in Docker** - Replaced the monorepo `tsconfig.json` (which extends a base file not present in the container) with a standalone version for the Docker runtime image. Fixes Prisma 7 failing to transpile `prisma.config.ts` during provider switch or `db push` ([#130](https://github.com/Kha-kis/arr-dashboard/issues/130))
- **Sonarr Missing Episode Stats Overcount** - Statistics page now uses Sonarr's `episodeCount` (monitored episodes only) instead of `totalEpisodeCount` (all episodes including unaired, unmonitored, and specials) when calculating missing episodes. This caused inflated counts (e.g., 9,000+ shown instead of ~60 actual missing) for users with large libraries containing many unmonitored or future episodes ([#131](https://github.com/Kha-kis/arr-dashboard/issues/131))
- **Queue Remove Dropdown Clipped** - The "Remove" dropdown menu in the Active Queue (and Hunt/Sync Strategy dropdowns elsewhere) was clipped by `overflow-hidden` on card containers. Replaced all three inline-positioned dropdowns with portaled Radix DropdownMenu for proper rendering above all ancestors ([#132](https://github.com/Kha-kis/arr-dashboard/issues/132))
- **LOG_LEVEL Environment Variable Ignored** - The `LOG_LEVEL` env var had no effect because Fastify was creating its own default Pino logger (`logger: true`) instead of using the custom logger that reads `LOG_LEVEL`. Now wires the custom logger into Fastify via `loggerInstance`, supports all standard levels (fatal/error/warn/info/debug/trace), and includes log file rotation, sensitive field redaction, and startup banner showing effective log level ([#133](https://github.com/Kha-kis/arr-dashboard/issues/133))

### Added

- **Sonarr Statistics Unit Tests** - Added comprehensive test suite for the missing episode calculation covering: unmonitored episodes, future unaired episodes, specials/season 0, edge cases (negative counts, missing fields), and multi-instance aggregation
- **Comprehensive Structured Logging** - 35 debug-level log statements across 18 modules (auth, hunting, queue cleaner, backup, deployment, etc.) provide meaningful output when `LOG_LEVEL=debug`

---

## [2.8.4] - 2026-02-23

### Fixed

- **Quality Definition Reset Compatibility** - The "Reset to Factory Defaults" action now tries multiple API strategies (command API → direct endpoint) with proper fallback, instead of relying on a single endpoint that doesn't exist across all Sonarr/Radarr versions. Shows a clear actionable error if the instance doesn't support either method ([#114](https://github.com/Kha-kis/arr-dashboard/issues/114))
- **Reset UI Feedback** - The quality size reset confirmation panel now displays error and success states instead of silently failing

---

## [2.8.3] - 2026-02-23

### Fixed

- **TRaSH Guides PR #2590 Compatibility** - Activated support for TRaSH Guides' upstream format changes: CF groups now use `include` semantics (explicitly listing applicable profiles instead of exclusions), and quality items are ordered human-readable (low→high) requiring reversal before Sonarr/Radarr API submission
- **CF Group Profile Filtering** - Fixed `profile-matcher.ts` using inline `exclude`-only logic instead of the shared `isCFGroupApplicableToProfile()` helper, which caused CF groups to be applied to all profiles regardless of include/exclude restrictions

---

## [2.8.2] - 2026-02-19

### Fixed

- **API Crash on Startup (Docker)** - Fixed `TypeError: Cannot read properties of undefined (reading 'graph')` that prevented the API from starting in v2.8.1 Docker builds. The root cause was a Prisma client version mismatch: `tsup` bundled the 7.3.0-generated config while `@prisma/client` 7.4.0 runtime expected the newer `parameterizationSchema.graph` field. The Dockerfile now runs `prisma generate` before the build step so the bundled config always matches the installed runtime ([#105](https://github.com/Kha-kis/arr-dashboard/issues/105))

---

## [2.8.1] - 2026-02-18

### Added

- **Quality Size Preset Management** - Apply TRaSH Guides quality size presets (movie, anime, series, streaming) to Sonarr/Radarr instances. Includes preview diff, factory reset, sync strategy tracking, and per-instance mapping persistence ([#96](https://github.com/Kha-kis/arr-dashboard/pull/96))
- **Hunting Reset Confirmation** - Reset History button now shows a confirmation dialog to prevent accidental data loss
- **CodeQL & Semgrep Code Scanning** - Automated security analysis on every push and PR via GitHub Actions ([#100](https://github.com/Kha-kis/arr-dashboard/pull/100))

### Changed

- **Major Codebase Refactoring** - Consolidated error handling with `getErrorMessage()` utility (replaces 179 `instanceof Error` patterns), extracted backup-service into focused modules, removed redundant try/catch blocks in favor of global error handler, and decomposed large frontend components ([#93](https://github.com/Kha-kis/arr-dashboard/pull/93), [#96](https://github.com/Kha-kis/arr-dashboard/pull/96))
- **Deployment Executor Plugin** - Extracted long-running deployment logic into a Fastify plugin with proper lifecycle management and structured logging
- **Template Route Consistency** - DELETE instance-override handler now uses shared `parseInstanceOverrides()` utility consistent with GET/PUT handlers
- **Cache Route Type Safety** - Replaced dynamic `service.toLowerCase()` keys and type casts with typed `ServiceType` alias and static lookup maps

### Fixed

- **Runtime Query Validation** - Added Zod validation for `serviceType` query parameter on `/custom-formats/list` and `/cf-descriptions/list` endpoints — Fastify TypeScript generics don't validate at runtime ([#102](https://github.com/Kha-kis/arr-dashboard/pull/102))
- **Quality Size Service Guard** - Non-Sonarr/Radarr instances now return a clear 400 error instead of cryptic 500 when attempting quality size operations
- **Flaky E2E Tests** - Resolved intermittent sidebar navigation test failures with improved wait strategies ([#101](https://github.com/Kha-kis/arr-dashboard/pull/101))

### Security

- **46 Code Scanning Alerts Resolved** - Fixed all CodeQL and Semgrep findings including log injection, prototype pollution, ReDoS, filesystem race conditions, and property injection ([#102](https://github.com/Kha-kis/arr-dashboard/pull/102))
- **ReDoS Prevention** - Rewrote `normalizeProfileName` with string methods (no regex) to eliminate catastrophic backtracking vectors
- **Prototype Pollution Prevention** - CUID format validation (`/^[a-z0-9]+$/`) on instance ID route parameters prevents `__proto__` injection
- **Log Injection Prevention** - `sanitizeForLog()` strips `\r\n` from all interpolated values in structured log messages
- **Atomic Secret Writes** - Secret manager uses temp file + `renameSync` pattern, catches `ENOENT` instead of TOCTOU-vulnerable `existsSync`

### Dependencies

- Bumped 27 production dependencies and 6 remaining outdated packages ([#97](https://github.com/Kha-kis/arr-dashboard/pull/97), [#99](https://github.com/Kha-kis/arr-dashboard/pull/99))
- Bumped GitHub Actions group (7 updates) and dev dependencies group (4 updates)

---

## [2.8.0] - 2026-02-06

### Added

- **Full Lidarr & Readarr Support** - Complete integration for music (Lidarr) and book (Readarr) management. All features now work across Sonarr, Radarr, Lidarr, and Readarr including queue management, library sync, manual import, and queue cleaner ([#87](https://github.com/Kha-kis/arr-dashboard/pull/87))
- **Queue Cleaner Auto-Import** - New experimental feature that attempts to automatically import stuck downloads before removing them. Configurable safe/never patterns, max attempts, cooldown periods, and rate limiting. Live tested with 87% Sonarr and 100% Radarr success rates ([#88](https://github.com/Kha-kis/arr-dashboard/pull/88), [#80](https://github.com/Kha-kis/arr-dashboard/issues/80))
- **Import Pending/Blocked Toggle** - Queue Cleaner now has a dedicated toggle to enable/disable import pending/blocked cleanup separately from other rules

### Fixed

- **TRaSH Guides Quality Format Reversal** - Temporarily disabled quality format reversal feature pending upstream TRaSH PR #2590 merge to prevent incorrect format application

### Security

- **Auto-import rate limiting** - 200ms delay between import attempts and max 10 imports per cleaner run to prevent overwhelming ARR instances
- **Pattern validation** - Custom auto-import patterns validated with size limits (10KB max, 50 patterns max, 200 chars per pattern)

---

## [2.7.4] - 2026-02-05

### Added

- **Configurable Password Policy** - New `PASSWORD_POLICY` environment variable allows choosing between `strict` (default, requires uppercase/lowercase/number/special character) and `relaxed` (8+ characters only, passphrase-friendly) password requirements. Enables secure passphrases like "correct horse battery staple" ([#83](https://github.com/Kha-kis/arr-dashboard/issues/83), [#84](https://github.com/Kha-kis/arr-dashboard/pull/84))

### Changed

- **Password validation** - Frontend validation now matches backend 128-character maximum limit for consistent user experience
- **Type imports** - `PasswordPolicy` type now imported from `@arr/shared` package for single source of truth

---

## [2.7.3] - 2026-02-04

### Added

- **Queue Cleaner** - New automated queue cleanup feature for Sonarr/Radarr with multi-rule detection (stalled, failed, slow, seeding timeout, error patterns, import blocks), strike system, whitelist protection, dry-run mode, rich preview UI, statistics dashboard, and per-instance configuration ([#81](https://github.com/Kha-kis/arr-dashboard/pull/81))
- **Prefer Season Packs** - New hunting toggle for Sonarr that prioritizes season pack releases over individual episode searches. When enabled, always triggers SeasonSearch for any missing content to catch season packs ([#79](https://github.com/Kha-kis/arr-dashboard/issues/79))

### Fixed

- **CI build order** - Build shared package before lint and test jobs to ensure types are available ([#81](https://github.com/Kha-kis/arr-dashboard/pull/81))
- **Environment validation errors** - Replace cryptic Zod stack traces with user-friendly error messages showing which env var failed, its current value, and hints for common issues like SESSION_TTL_HOURS limits ([#78](https://github.com/Kha-kis/arr-dashboard/issues/78))
- **Login page API health check** - Always verify API connectivity when login page loads, ensuring users see the "Connection Error" screen immediately when API is down (including server errors) instead of a stale cached login form ([#78](https://github.com/Kha-kis/arr-dashboard/issues/78))

### Security

- **Fastify** - Update to 5.7.2 to address HTTP request smuggling vulnerability ([GHSA-jx2c-rxcm-jvmq](https://github.com/advisories/GHSA-jx2c-rxcm-jvmq))

---

## [2.7.2] - 2026-02-02

### Added

- **Custom upstream repository** - Configure a custom GitHub fork as TRaSH Guides upstream source, replacing the official TRaSH-Guides/Guides repo. Includes settings UI with Git URL input, test connection, and reset to official ([#77](https://github.com/Kha-kis/arr-dashboard/pull/77))
- **User custom formats** - Full CRUD management for user-defined custom formats with specification builder, import from TRaSH upstream, and deploy to Sonarr/Radarr instances
- **UserCustomFormat database model** - New Prisma model for persisting user-created custom format definitions with specifications

### Fixed

- **DOMPurify v3 CJS import** - Fix silently returning empty HTML for all sanitized content by using `mod.default || mod` with `sanitize()` validation ([#74](https://github.com/Kha-kis/arr-dashboard/issues/74))
- **CF description endpoint** - Switch to dedicated lazy-loading endpoint with multi-strategy slug matching (exact, displayName, base name fallbacks) ([#74](https://github.com/Kha-kis/arr-dashboard/issues/74))
- **Template update banner overflow** - Fix wrapping badge row layout that overflowed on narrow viewports
- **SSR hydration mismatch** - Use deterministic skeleton widths to prevent server/client rendering differences
- **Timer stacking** - Prevent `scheduleCacheRefresh` from stacking on rapid mutations
- **Silent error swallowing** - Add `console.warn` to catch blocks for diagnostic visibility

### Changed

- **Parameterized TRaSH fetcher URLs** - `github-fetcher` and `version-tracker` now accept `TrashRepoConfig` for per-request fetcher creation
- **Tab content rendering** - Refactored from nested ternary to switch statement with ErrorBoundary wrappers
- **UX copy improvements** - Better messaging for cache repopulation timing expectations

### Security

- **Alpine package CVEs** - Patch libcrypto3/libssl3 3.3.5→3.3.6, busybox 1.37.0-r13→r14 via `apk upgrade` in Dockerfile ([#75](https://github.com/Kha-kis/arr-dashboard/pull/75))
- **Dependency overrides** - Force lodash ≥4.17.23 (prototype pollution) and hono ≥4.11.7 (XSS, cache deception, IP spoofing) in Prisma transitive dependency chain ([#75](https://github.com/Kha-kis/arr-dashboard/pull/75))

---

## [2.7.1] - 2026-01-30

### Fixed

- **TRaSH Guides template persistence** - Fix custom quality configurations, quality profiles,
  sync settings, and cloned quality profiles being silently dropped when saving templates.
  The Zod validation schema was missing 4 of 8 TemplateConfig fields, causing them to be
  stripped during parsing ([#69](https://github.com/Kha-kis/arr-dashboard/issues/69))
- **TRaSH CF Group validation** - Add missing `include` field to CF Group quality_profiles
  validation schema for TRaSH Guides PR #2590 include/exclude semantics support

### Security

- **Next.js** - Bump minimum version to 16.1.5 to address HTTP request deserialization DoS
  ([GHSA-h25m-26qc-wcjf](https://github.com/advisories/GHSA-h25m-26qc-wcjf))

---

## [2.7.0] - 2026-01-21

### Major Upgrades

This release includes significant upgrades to the entire technology stack for improved performance, security, and maintainability.

#### Runtime & Build
- **Node.js** 20 → 22 (LTS with improved performance and native fetch)
- **pnpm** 9 → 10 (faster installs with inject-workspace-packages)

#### Backend
- **Prisma** 6 → 7 (driver adapter architecture, improved query performance)
- **Pino** 9 → 10 (logging improvements)
- **Fastify** 4 → 5 (performance optimizations)

#### Frontend
- **Next.js** 15 → 16 (Turbopack by default, improved SSR)
- **Tailwind CSS** 3 → 4 (new architecture, faster builds)
- **Framer Motion** 11 → 12 (improved animations)
- **Zustand** 4 → 5 (smaller bundle, better TypeScript)
- **Zod** 3 → 4 (improved error messages)

#### Development
- **Vitest** 1 → 4 (faster test execution)
- **Biome** 1 → 2 (improved linting rules)
- **TypeScript** 5.7 → 5.9

### Upgrade Notes

> **Important:** If upgrading from a previous version, ensure your `/config` volume is preserved. This directory contains:
> - `prod.db` - Your database with all configurations
> - `secrets.json` - Encryption keys for API credentials
>
> If `secrets.json` is missing after upgrade, your service connections will fail to decrypt. The volume should be automatically preserved in standard Docker setups.

#### Database Changes
- The deprecated `urlBase` column in system settings has been removed. This is handled automatically during startup with no action required.
- New library caching tables (`library_cache`, `library_sync_status`) are created automatically for server-side pagination support.

### Added

#### Dashboard Features
- **Queue sorting** - Sort downloads by title (A-Z, Z-A), size (largest/smallest), progress, or status ([#32](https://github.com/Kha-kis/arr-dashboard/issues/32))

#### CI/CD Improvements
- **Automated testing** in CI pipeline with Vitest
- **Dependency vulnerability auditing** with `pnpm audit`
- **Trivy security scanning** for Docker images on release
- **Dependabot** for automated dependency updates (npm, GitHub Actions, Docker)
- **Turbo build caching** for faster CI runs
- **Version metadata injection** into Docker images (VERSION, COMMIT_SHA, BUILD_DATE)

#### Docker Improvements
- **OCI image labels** with build metadata for registry/scanner compatibility
- **STOPSIGNAL SIGTERM** for graceful container shutdown via tini
- **NODE_OPTIONS** with memory tuning for containerized environments
- **Package manager cleanup** - removed unused yarn/npm/corepack from runtime (~25MB)
- **Pinned Alpine version** (node:22-alpine3.21) for reproducible builds
- **Non-Linux prebuild cleanup** to reduce image size

### Changed

- Docker startup script now uses direct prisma path (`./node_modules/.bin/prisma`) instead of npx
- pnpm workspace configuration uses `inject-workspace-packages=true` for hermetic deployments
- Prisma 7 now requires `prisma.config.ts` for CLI configuration

### Fixed

- **Accessibility**: Removed constant animations from cyberpunk theme
- **Docker**: Fixed pnpm 10 compatibility with proper inject-workspace-packages configuration
- **Docker**: Fixed Prisma 7 CLI compatibility by copying prisma.config.ts to deploy directory

### Security

- Docker images now scanned with Trivy on every release
- Dependencies audited for vulnerabilities in CI
- Automated security updates via Dependabot
- Removed unnecessary package managers from runtime image (reduced attack surface)

### Dependencies

Major dependency updates:
- lucide-react 0.441.0 → 0.562.0
- tailwind-merge 2.6.0 → 3.4.0
- @types/node 22.18.6 → 25.0.9
- dotenv 16.6.1 → 17.2.3
- tsup 8.5.0 → 8.5.1

---

## [2.6.7] - 2026-01-07

### Bug Fixes

- **Unraid Startup Hang** - Resolved container hang during startup on Unraid by removing blanket chown on /app/api ([#29](https://github.com/Kha-kis/arr-dashboard/issues/29))
- **OIDC Configuration** - Fixed URL normalization and added recovery options for Keycloak/Authelia users ([#27](https://github.com/Kha-kis/arr-dashboard/issues/27))
- **Hunting Pagination** - Added page offset rotation to prevent hunting from getting "stuck" on large libraries ([#30](https://github.com/Kha-kis/arr-dashboard/issues/30))
- **Template Editor** - Switched to patch-based approach to prevent custom format data loss
- **Auto-Sync Diff** - Fixed stale cache issues when computing template diffs ([#23](https://github.com/Kha-kis/arr-dashboard/issues/23), [#25](https://github.com/Kha-kis/arr-dashboard/pull/25))

### New Features

- **TRaSH Guides**
  - **Sync Metrics Telemetry** - New observability endpoint (`/api/trash-guides/metrics`) for tracking sync operations, success rates, timing, and error categorization
  - **GitHub Rate Limit Awareness** - Intelligent backoff when approaching GitHub API rate limits
  - **Quality Group Management** - Full quality group editing for power users
  - **Per-Template deleteRemovedCFs** - Configure CF removal behavior per template
  - **CF Origin Tracking** - Recyclarr-style origin tracking and deprecation handling
  - **Instance Quality Overrides** - Per-instance quality configuration customization

### Code Quality

- Fixed TypeScript errors across authenticated routes (userId type safety)
- Fixed React hooks dependency warnings
- Normalized line endings across codebase
- Removed dead code (unused parameters)

---

## [2.6.6] - 2025-12-28

### New Features

- **TRaSH Guides**
  - **Sync Strategy-Specific Score Handling** - Different sync strategies now handle score updates appropriately:
    - **Auto sync**: Automatically applies recommended scores from TRaSH `trash_scores`, but preserves user score overrides and creates notifications about conflicts
    - **Notify sync**: Shows suggested score changes in diff for user review without auto-applying
    - **Manual sync**: Displays score differences in diff, user chooses what to apply
  - Score conflict notifications when auto-sync detects user overrides that differ from TRaSH recommendations
  - New scheduler stats tracking templates with score conflicts

---

## [2.6.5] - 2025-12-20

### Bug Fixes

- **Docker**
  - Fix EACCES permission denied error when using PostgreSQL on Unraid ([#21](https://github.com/Kha-kis/arr-dashboard/issues/21))
  - Resolve Prisma client regeneration failure when switching database providers with non-default PUID/PGID

### New Features

- **Settings > System**
  - Added System Information section displaying application version, database backend, Node.js version, and uptime
  - Version detection via `version.json` created at Docker build time

### Security & Stability

- **Session Management**
  - Middleware now validates session tokens against the API
  - Invalid/stale session cookies are automatically cleared and user redirected to login
  - Prevents issues when database is reset or container recreated with new volume

### Documentation

- Documentation has moved to the [GitHub Wiki](https://github.com/Kha-kis/arr-dashboard/wiki)
- Comprehensive guides for Authentication, TRaSH Guides, Hunting, Backup/Restore, and more

---

## [2.6.4] - 2025-12-18

### Bug Fixes

- **Docker**
  - Fix container crash loop when upgrading from older versions ([#13](https://github.com/Kha-kis/arr-dashboard/issues/13))
  - Add `--accept-data-loss` flag to `db push` to handle removed columns (e.g., `urlBase` from `system_settings`)

---

## [2.6.3] - 2025-12-15

### New Features

- **Backup System**
  - Password protection for backup files with optional encryption
  - TRaSH data inclusion option - choose whether to include templates, cache, and sync history in backups
  - Improved restore warning messages with clearer explanation of the replacement process

- **TRaSH Guides**
  - Standalone custom format deployment - deploy individual CFs without full profile sync
  - Sync rollback support - revert deployments if something goes wrong
  - Better deployment tracking and history

- **History Page**
  - External links on instance names - click to navigate directly to the relevant page in Sonarr/Radarr/Prowlarr
  - Links to series/movie pages when viewing history for specific items

### Security & Stability

- **Security**
  - Replaced unsafe code execution patterns with safer alternatives in Next.js server wrapper

- **Error Handling**
  - Add global error boundaries for better crash recovery
  - Route-level error boundary with user-friendly error UI
  - Root layout error boundary for critical failures

- **Performance**
  - Add database indexes for Session cleanup, TrashTemplate soft deletes, and HuntConfig scheduling
  - Fix memory leak in TMDB carousel (memoized scroll callbacks)
  - Fix excessive API refetching in services query (proper staleTime configuration)

### Infrastructure

- **Database**
  - Removed Prisma migrations in favor of `db push` for better multi-provider support
  - Improved PostgreSQL compatibility and provider switching
  - Simpler database initialization for fresh installs
  - Added performance indexes for frequently queried columns

---

## [2.6.2] - 2025-12-10

### Bug Fixes

- **Docker**
  - Fix health check failing due to root path redirect (was checking `/` which returns 307, now uses `/auth/setup-required` which returns 200)
  - Fix Prisma migration lock error (P3019) when switching from SQLite to PostgreSQL (#12)
  - Fix empty DATABASE_URL causing Prisma validation error on Unraid (#19)

### Improvements

- **Connection Testing**
  - Simplify connection tester to use single `/api/vX/system/status` endpoint consistently across all services
  - Add specific error messages for common HTTP status codes (401, 403, 404, 5xx)
  - Better messaging for reverse proxy authentication issues

---

## [2.6.1] - 2025-12-05

### Bug Fixes

- **Statistics**
  - Fix disk statistics showing incorrect totals when instances share storage (storage group deduplication now works across services)
  - Add `combinedDisk` API field for accurate cross-service disk usage totals

- **TRaSH Guides**
  - Fix "column errors does not exist" error in deployment history (#13)
  - Add missing database columns for deployment history: `errors`, `warnings`, `canRollback`, `rolledBack`, `rolledBackAt`, `rolledBackBy`, `deploymentNotes`, `templateSnapshot`

### Infrastructure

- **Database Migrations**
  - Add `storageGroupId` column to ServiceInstance for storage group tracking
  - Add missing columns to `template_deployment_history` table
  - Add missing `userId` index for deployment history queries

---

## [2.6.0] - 2025-11-15

### Security

- **Session Security Improvements** - Enhanced authentication session handling with improved security measures (#11)

### New Features

- **TRaSH Guides Sync for Cloned Profiles** - Cloned quality profile templates can now sync with TRaSH Guides updates
- **Automated Hunting** - New hunting feature for automatically searching missing content and quality upgrades (#15)
- **PostgreSQL Support** - Full PostgreSQL database support for larger deployments
- **Improved Error Handling** - Helpful error message when API is unreachable instead of generic failures
- **Tabbed Statistics** - New tabbed interface for viewing service statistics
- **Clickable Dashboard Links** - Instance names in Dashboard are now clickable for quick navigation
- **External Links in Discover** - TMDB, IMDB, and TVDB links added to recommendation carousels
- **Calendar Deduplication** - Entries appearing in multiple instances are now deduplicated
- **TMDB Caching** - In-memory caching for TMDB API calls improves Discover page performance

### Bug Fixes

- **TRaSH Guides**
  - Don't auto-exclude Custom Formats with score 0 when cloning profiles
  - Fix cloned profile ID parser for standard UUIDs
  - Remap cutoff ID correctly when deploying cloned quality profiles

- **Docker**
  - Fix PostgreSQL provider detection (was matching generator instead of datasource)
  - Database port settings now take precedence over environment variables
  - Copy public directory to container for static assets

- **Services**
  - Handle 401/403 responses from reverse proxy during Prowlarr ping tests
  - Handle numeric eventType from Prowlarr API in statistics

- **Web/UX**
  - Improve queue links and prevent password manager autofill on forms
  - Prevent Discover carousel items from appearing then disappearing
  - Calendar now respects unmonitored filter for both Sonarr and Radarr
  - Add clipboard fallback for non-HTTPS environments
  - Fix duplicate icon files causing favicon 500 error

- **API**
  - Replace all explicit `any` types with proper TypeScript types

### Infrastructure

- **Fork-Safe CI** - Docker build job now works correctly for external contributors
- **Unraid Support** - Added icon to public directory for Unraid Community Applications template
- **Documentation** - Complete CLAUDE.md rewrite with comprehensive technical documentation

---

## [2.5.0] - 2025-10-01

### ⚠️ Breaking Change: Volume Path Update

**The Docker volume mount path has changed from `/app/data` to `/config`** to follow [LinuxServer.io conventions](https://docs.linuxserver.io/general/running-our-containers/).

#### Migration Steps

1. Stop your container:
   ```bash
   docker stop arr-dashboard
   ```

2. Update your volume mount:
   ```yaml
   # Old (2.4.x)
   volumes:
     - ./data:/app/data

   # New (2.5.0+)
   volumes:
     - ./config:/config
   ```

3. Rename your data directory (optional but recommended):
   ```bash
   mv ./data ./config
   ```

4. Restart:
   ```bash
   docker-compose up -d
   ```

> **Note:** Your data (database, secrets) will be preserved. Only the mount path has changed.

### Why This Change?

- **Industry Standard** - Matches LinuxServer.io, hotio, and other popular container maintainers
- **Consistency** - Works alongside Sonarr, Radarr, Prowlarr which all use `/config`
- **Easier Support** - "Where is my data?" → "Always in `/config`"

### Added

- TRaSH Guides integration for quality profile management
- Automated backup system with retention policies
- OIDC authentication support (Authelia, Authentik)
- Passkey/WebAuthn authentication

### Changed

- Improved dashboard performance with optimized queries
- Enhanced calendar view with better date handling

---

## [2.4.3] - 2025-09-20

### Improvements

- **Favicon/Tab Icon** - Added browser tab icon for better identification
- **README Screenshots** - Added screenshots showcasing all major features

---

## [2.4.2] - 2025-09-15

### New Features

- **PUID/PGID Support** - LinuxServer.io-style user/group ID configuration for proper file permissions in Docker
- **Collapsible Error Messages** - Queue items with many similar errors (e.g., multiple missing episodes) are now collapsed into expandable groups

### Improvements

- **Incognito Mode** - Now properly masks release names and episode information in queue status messages
- **Discover Page** - Shows helpful message when TMDB API key is not configured instead of flooding console with 400 errors

### Bug Fixes

- Fixed incognito mode not masking queue status messages containing release names
- Fixed discover page making infinite API requests when TMDB key is missing
- Added proper 400 error handling for API requests

---

## [2.4.1] - 2025-09-10

### Features

- TRaSH Guides integration with quality profiles and custom formats
- Template system for reusable configurations
- Deployment preview and conflict resolution
- Automatic backups before changes

---

[2.9.0]: https://github.com/Kha-kis/arr-dashboard/compare/v2.8.5...v2.9.0
[2.8.5]: https://github.com/Kha-kis/arr-dashboard/compare/v2.8.4...v2.8.5
[2.8.4]: https://github.com/Kha-kis/arr-dashboard/compare/v2.8.3...v2.8.4
[2.8.3]: https://github.com/Kha-kis/arr-dashboard/compare/v2.8.2...v2.8.3
[2.8.2]: https://github.com/Kha-kis/arr-dashboard/compare/v2.8.1...v2.8.2
[2.8.1]: https://github.com/Kha-kis/arr-dashboard/compare/v2.8.0...v2.8.1
[2.8.0]: https://github.com/Kha-kis/arr-dashboard/compare/v2.7.4...v2.8.0
[2.7.4]: https://github.com/Kha-kis/arr-dashboard/compare/v2.7.3...v2.7.4
[2.7.3]: https://github.com/Kha-kis/arr-dashboard/compare/v2.7.2...v2.7.3
[2.7.2]: https://github.com/Kha-kis/arr-dashboard/compare/v2.7.1...v2.7.2
[2.7.1]: https://github.com/Kha-kis/arr-dashboard/compare/v2.7.0...v2.7.1
[2.7.0]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.7...v2.7.0
[2.6.7]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.6...v2.6.7
[2.6.6]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.5...v2.6.6
[2.6.5]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.4...v2.6.5
[2.6.4]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.3...v2.6.4
[2.6.3]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.2...v2.6.3
[2.6.2]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.1...v2.6.2
[2.6.1]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.0...v2.6.1
[2.6.0]: https://github.com/Kha-kis/arr-dashboard/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/Kha-kis/arr-dashboard/compare/v2.4.3...v2.5.0
[2.4.3]: https://github.com/Kha-kis/arr-dashboard/compare/v2.4.2...v2.4.3
[2.4.2]: https://github.com/Kha-kis/arr-dashboard/compare/v2.4.1...v2.4.2
[2.4.1]: https://github.com/Kha-kis/arr-dashboard/releases/tag/v2.4.1
