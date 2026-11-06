# API Routes Reference

> Versioned developer reference for the API route structure.

All routes in `apps/api/src/routes/`. Protected routes use preHandler authentication.

## Route Surface Governance

Every top-level route group is registered through a single manifest at
[`apps/api/src/routes/route-manifest.ts`](../apps/api/src/routes/route-manifest.ts).
The manifest assigns each group a **maturity tier** that tells contributors
how careful they need to be when changing it.

| Tier | Audience | Change discipline |
|---|---|---|
| **stable** | Bundled web UI **and** potential external scripts/integrations | Preserve request/response shape within a minor version. Breaking changes need a CHANGELOG entry and (if user-visible) a release-notes call-out. |
| **operator** | Self-hosting operator (single-admin) via the UI or scripted ops | Real-world side effects (restart, restore, configure providers). Treat behavior changes as user-visible; document in CHANGELOG. |
| **internal** | Bundled dashboard only — frontend ships in lockstep | Free to reshape as long as the matching frontend code is updated in the same PR. No external compatibility promise. |
| **experimental** | Opt-in / iterating | May move or be removed. Mark loudly in release notes if surfaced in the UI. |

This is **not** a semantic API versioning scheme. The app remains
single-admin and self-hosted; the tiers exist to set reviewer expectations,
not to gate routing. See
[`docs/adr/0004-route-surface-governance.md`](adr/0004-route-surface-governance.md)
for the full rationale.

### Public route groups

| Path | Maturity | Summary |
|---|---|---|
| `/health` | stable | Database readiness probe for operators |
| `/live` | stable | Process liveness probe for orchestrators |
| `/auth` | stable | Password login, registration, account management |
| `/auth/oidc` | stable | OIDC initiate + callback |
| `/auth/passkey` | stable | WebAuthn registration + assertion |

### Protected route groups

| Path | Maturity | Summary |
|---|---|---|
| `/api/oidc-providers` | operator | OIDC provider configuration (single-admin) |
| `/api/system` | operator | Settings, restart, jobs, posture diagnostics |
| `/api/backup` | operator | Create, download, restore, scheduled backups |
| `/api/notifications` | stable | Channels, subscriptions, rules, delivery aggregation |
| `/api/services` | stable | ARR instance CRUD + connection testing |
| `/api/dashboard` | stable | Queue, history, calendar, statistics aggregates |
| `/api/library` | stable | Movies/series listing, episodes, provider inventory, monitor, search |
| `/api/search` | stable | Prowlarr indexer search + grab |
| `/api/manual-import` | stable | Manual import candidates, tracked submission and cached progress |
| `/api/hunting` | internal | Auto-search configuration and execution |
| `/api/queue-cleaner` | internal | Queue cleanup rules, strikes, dry-run preview |
| `/api/library-cleanup` | internal | Library cleanup rules, approvals, execution, and retention-capped action activity |
| `/api/plex` | stable | Now playing, on-deck, history, analytics, forecasts |
| `/api/jellyfin` | stable | Jellyfin activity and library data |
| `/api/tautulli` | stable | Activity, watch history enrichment, statistics |
| `/api/label-sync` | experimental | Generic any-to-any media-service tag/label sync rules (issue #384). Sub-arc 1 ships Sonarr/Radarr → Plex. |
| `/api/auto-tag` | experimental | Criteria-based auto-tagger — applies tags to ARR items matching criteria, including positive Plex/Jellyfin presence at the last complete scan. `GET /rules/:id/preview` evaluates candidates without writing tags or recording a run; execution rechecks current evidence. Companion to Label Sync. Under session auth, `GET /webhook-config` only reads status (`secret: null`, `configured` reflects the stored hash, `freshlyGenerated: false`) and never generates or writes a credential. Explicit `POST /webhook-config/regenerate` generates or replaces the authenticated user's secret, returns plaintext once with `freshlyGenerated: true`, and persists only its hash. The panel confirms replacement for both Generate and Rotate; it does not promise atomic create-only behavior across tabs. |
| `/api/auto-tag/webhook` | experimental | Inbound Sonarr/Radarr Connect webhook for real-time auto-tagging. **Public route** (no session cookie); authenticates via per-user Bearer token (SHA-256 hash of the user's webhook secret). |
| `/api/pulse` | internal | System Pulse health signals + attention items |
| `/api/qui` | experimental | Federated peer integration with autobrr/qui (qBittorrent UI) — read-only torrent state, trackers, cross-seed siblings; powers the Torrent Health panel. |
| `/api/webhooks/qui` | experimental | Inbound qui Shoutrrr notification receiver (Phase 5.1). **Public route** (no session cookie); authenticates via a per-user `?secret=…` query param forwarded by the generic target. Normalizes qUI's `{title, message}` JSON, stores it in `QuiEventLog`, and publishes to the in-process event bus for SSE fan-out. |
| `/api/seerr` | stable | Request management, discovery, library enrichment |
| `/api/trash-guides` | internal | TRaSH cache, templates, deployment, profiles |

The Tautulli stats route reads per-user statistics through
`get_home_stats(stat_id=top_users)` for the requested time range, using 100-row
pages and a shared 10-second deadline. It requires a short terminal page;
duplicates, invalid rows, page failures or the 100-page cap reject that source
rather than publishing truncated totals. The single-user
`get_user_watch_time_stats` endpoint is not an all-users statistics source.

> When you add a new route group, add a manifest entry **and** a row above.
> A contract test (`apps/api/src/routes/__tests__/route-manifest.test.ts`)
> will fail loudly if either is missing.

## Per-group route detail

## Authentication Routes (`/auth`)

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| GET | `/auth/setup-required` | No | Check if setup needed |
| POST | `/auth/register` | No | Initial user creation |
| POST | `/auth/login` | No | Password login |
| POST | `/auth/logout` | Yes | End session |
| GET | `/auth/me` | Yes | Current user info |
| PATCH | `/auth/account` | Yes | Update username/password/TMDB key |
| DELETE | `/auth/password` | Yes | Remove password (requires OIDC) |
| DELETE | `/auth/account` | Yes | Delete account (no auth methods) |

## OIDC Routes (`/auth/oidc`)

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| GET | `/auth/oidc/providers` | No | Get configured provider |
| POST | `/auth/oidc/setup` | No | Configure during setup |
| POST | `/auth/oidc/login` | No | Initiate OIDC flow |
| GET | `/auth/oidc/callback` | No | Handle provider callback |

## Passkey Routes (`/auth/passkey`)

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| POST | `/passkey/register/options` | Yes | Generate registration challenge |
| POST | `/passkey/register/verify` | Yes | Complete registration |
| POST | `/passkey/login/options` | No | Generate auth challenge |
| POST | `/passkey/login/verify` | No | Complete authentication |
| GET | `/passkey/credentials` | Yes | List user passkeys |
| DELETE | `/passkey/credentials` | Yes | Delete passkey |
| PATCH | `/passkey/credentials` | Yes | Rename passkey |

## Service Management (`/api/services`)

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/services` | List all instances |
| POST | `/services` | Add instance |
| PUT | `/services/:id` | Update instance |
| DELETE | `/services/:id` | Remove instance |
| POST | `/services/test-connection` | Test before saving |
| POST | `/services/:id/test` | Test existing |

Connection deletion returns `409` while an import submission or cleanup-sensitive
operation is active, or while that connection has unresolved Queue Cleaner import
receipts. Failed/unknown commands do not release source protection. Check ARR
command activity and imported files, then run Queue Cleaner to reconcile the
receipt; this never turns a timeout into permission to delete. Positive per-file
completion remains a durable historical fact even after ARR prunes its old logs
or connection credentials change. Completed receipts are removed with the
connection only after complete read-only queue observations across this owner's
ARR connections (including disabled connections) establish that the sources are
no longer queued.
Unavailable, ambiguous, or budget-exhausted evidence blocks deletion. The receipt
count, nonterminal states, and queued source matches are rechecked in the deletion
transaction. Each provider read is subject to the remaining 15-second deadline;
late responses cannot authorize deletion or continue pagination. No command is
cancelled, replayed, or submitted by connection deletion. Coordination assumes
the supported single API process per database; runtime enforcement remains
tracked by #829.

## Tautulli statistics (`/api/tautulli/stats`)

Authenticated read-only `GET /api/tautulli/stats` and
`GET /api/tautulli/stats/plays-by-date` return an `availability` object alongside
their existing data: `status`, `configuredSources`, and `availableSources`.
Counts cover this user's enabled Tautulli sources. The existing identity checks
still gate provider reads and exclude observations rejected after a read.

- `complete`: every source configured at the beginning of this request returned
  an accepted result. A genuinely empty successful result remains distinct from
  failure. This describes source participation, not exact historical coverage.
- `partial`: HTTP 200 retains results from successful sources, but the aggregate
  excludes unavailable sources and must not be presented as a complete total.
- `unavailable`: HTTP 503 with a generic error and availability metadata, when
  configured sources exist but none returned an accepted result. No provider
  errors, instance names, or credentials are included in the error response.
- `not-configured`: HTTP 200 with empty arrays when no enabled source is
  configured. Consumers should hide the optional feature or show unavailable,
  rather than infer zero activity.

This metadata is informational UI evidence, never cleanup or mutation authority.

## Tautulli watch history (`/api/tautulli/history`)

Authenticated read-only `GET /api/tautulli/history` requests return completed history
rows with `include_activity=0`, so active sessions are not treated as completed
plays. The response includes `availability` alongside `history` and
`totalCount`; `totalCount` is the bounded number of observations gathered for
this request, not an exhaustive provider-history total. The route accepts up
to 100 rows per page and a maximum merge window of `start + length <= 500`;
for a nonzero offset, `totalCount` counts the fetched prefix before the page
slice, not all records held by Tautulli.

- `complete`: every enabled Tautulli source configured at the start of the
  request returned an accepted result. An accepted empty result remains
  distinct from an unavailable source.
- `partial`: HTTP 200 retains rows from accepted sources, while unavailable or
  unverified sources are counted in `configuredSources` and excluded from the
  rows. Consumers must not present the result as complete coverage.
- `unavailable`: HTTP 503 with a generic error and availability metadata when
  configured sources exist but none returned an accepted result. Provider
  errors, instance names, and credentials are not included.
- `not-configured`: HTTP 200 with an empty history when this user has no
  enabled Tautulli source.

Availability is informational display evidence only and never grants cleanup
or mutation authority.

## Live session availability (`/api/plex/now-playing`, `/api/jellyfin/now-playing`, `/api/tautulli/activity`)

Each live-session response includes `availability` with `status`,
`configuredSources`, and `availableSources`. Counts describe source reads for
this request, not session totals. `complete` means every configured source
returned successfully, including a healthy empty result; `partial` is HTTP 200
with successful sessions retained while failed sources are excluded;
`unavailable` is HTTP 503 with a generic error when configured sources exist
but none returned an accepted result; and `not-configured` is HTTP 200 with an
empty session set when no source is configured. Enabled but unverified
Tautulli sources remain in the configured count and cannot provide a successful
read. This metadata is informational only and never grants mutation authority.

## QUI Routes (`/api/qui`) — experimental

> Federated peer integration with autobrr/qui (qBittorrent UI): read-only torrent state, trackers, cross-seed siblings, and audited operator actions. A lost bulk-action response holds each target until its outcome is verified; a timed-out request is never automatically retried.

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| GET | `/qui/instances` | Yes | List QUI instances for current user |
| GET | `/qui/actions` | Yes | Paginated, owner-scoped qUI action audit; ambiguous outcomes remain visible |
| POST | `/qui/actions/:id/reconcile` | Yes | Record one explicitly verified operator judgment for an unresolved action and release only its matching retry hold |
| GET | `/qui/instances/:id/qbit` | Yes | List qBittorrent instances behind a QUI instance |
| GET | `/qui/instances/:id/torrents/by-hash/:hash` | Yes | Get torrent by info hash |
| GET | `/qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers` | Yes | Get trackers for a torrent (filters DHT/PeX/LSD) |
| GET | `/qui/instances/:id/qbit/:instanceId/torrents/:hash/cross-seed` | Yes | Get cross-seed matches for a torrent |
| POST | `/qui/library-seeding-summary` | Yes | Read visible Library items' tracker coverage; may build and persist a local inode-index cache, but does not mutate qUI or media |
| POST | `/qui/instances/:id/test` | Yes | Test connection to a saved QUI instance |
| POST | `/qui/test` | Yes | Test connection with inline credentials (no storage) |

The Library page automatically calls `POST /qui/library-seeding-summary` because its bounded batch of visible item coordinates is sent in the body. This is not a strictly GET-only page visit. The response reports `status: available|partial|building|unavailable|not-configured` and a `summaries` map. It combines positive tracker observations across enabled filesystem-capable qUI connections. Only a result with verified complete provider inventories, index walks, and per-hash tracker reads is cached as `available` for ten minutes. Explicitly `partial` lower bounds are cached for at most one minute to bound tracker fanout; missing badges never establish absence. A persisted index bound to the current connection generation can retain positive matches during a guarded background completeness rebuild. Pre-generation snapshots cannot prove their connection and are discarded, requiring one cold rebuild; metadata-free provider inventories remain `partial` until completeness can be proved. `building` and `unavailable` return no confirmed summary and are retried with bounded polling. The inode-index build may continue after the bounded request wait. Service configuration changes invalidate the browser summary cache.

The Library route (`GET /api/library`) accepts `?torrentState=all|none|seeding|downloading|stalled_dl|paused|queued|checking|moving|error|unknown`. Its `quiObservationStatus` is `available|unavailable|not_configured`, with the validated observation START time in `observedAt` only when available. State/ratio, positive filters, ratio ordering and per-state counts require a complete, fresh, unchanged owned publication and matching projection timestamp; `none` means no available cached qUI data, not provider absence. Unavailable views null qUI scalars and omit counts while preserving other Library data and filters. Requested qUI filters fall back to `all` and ratio sorting to `sortTitle`, reported in actual `appliedFilters`; a receipt change during the query causes one bounded unavailable fallback. Available ratio pages rank verified numeric values first and effective-null values last. The existing empty-cache initial Library population trigger remains unchanged; this contract adds no qUI mutation or provider refresh to GET.

**Backfill coverage**: the `infohash-backfill` scheduler walks LibraryCache rows missing `infoHash`, queries the relevant *arr's dedicated `/api/v3/history/movie` (Radarr) or `/api/v3/history/series` (Sonarr) endpoint for the original grab record, and persists the hash. **Two-phase cadence**:

- **Catch-up phase** runs at startup whenever the backlog is non-zero — fires batches back-to-back with a 60s gap, capped at 10k rows per startup (~17 min worst-case). Drains an existing library quickly: a 1500-row backlog completes in ~5 minutes.
- **Steady-state phase** takes over after catch-up, running every 6h to capture any new items that have landed since the last sweep.

Per-row sleep is 100ms regardless of phase — that's the politeness budget against *arr. Without this scheduler, only items grabbed since PR #416 (2026-05-04) ever get correlated with qui. The base `/api/v3/history` endpoint is intentionally NOT used: it accepts `movieIds`/`seriesIds` (plural arrays) and silently ignores the singular form, returning unfiltered global history that would assign the same hash to every item.

## Dashboard (`/api/dashboard`)

| Route | Purpose | Refresh |
|-------|---------|---------|
| `/dashboard/queue` | Download queue | 30s |
| `/dashboard/history` | Authenticated durable History v2 read: retained local observations with server-side filters and opaque cursor pagination | Stable |
| `/dashboard/calendar` | Upcoming releases with per-instance and aggregate availability | 60s |
| `/dashboard/statistics` | Legacy bare ARR aggregate response; response shape preserved for existing clients | 120s |
| `/dashboard/statistics/snapshot` | Source-bound, persisted ARR aggregate envelope (`current`, `partial`, `last-known`, `collecting`, or `unavailable`); provider collection runs off the GET path | 10s while collecting/unavailable, 120s otherwise |

`GET /api/dashboard/calendar` preserves `instances`, `aggregated`, and
`totalCount` (published schedules only). Each instance requires `availability`
(`available`, `partial`, or `unavailable`), nullable `reason`
(`provider-unavailable`, `invalid-response`, or `invalid-items`), and
`rejectedItemCount` (a nonnegative safe integer). A successful valid array with
no rejected rows is available, including a genuine empty array. Rejected rows
produce partial coverage when valid schedules remain, or unavailable coverage
when none remain. Failed reads and invalid top-level responses are unavailable,
with no rejected-row count. Invalid rows are counted independently and cannot
discard valid neighboring schedules. Published schedules require stable
provider identity and a valid Gregorian date.

The required aggregate `availability` is `not-configured` with no instances,
`available` when every instance is available, `unavailable` when every instance
is unavailable, and `partial` for any other mix, including healthy-empty plus
failed sources. Responses contain generic coverage reasons without provider
diagnostics. Clients verify the source and aggregate evidence; missing or
inconsistent evidence is a read failure, never verified emptiness. Calendar
filters derive coverage from selected services and instances before search or
date clipping. Failed refetches retain events as last-known and unverified
current schedules until a successful read.

Search-enabled `POST /api/dashboard/queue/action` deletion validates a positive
safe-integer service-specific search target before removing the queue item.
Missing or unusable targets return 400 without provider writes. After removal,
200 returns `{ removal: "completed", search: "submitted" | "unconfirmed" }`.
`submitted` acknowledges command submission only; `unconfirmed` includes command
failure or timeout and does not establish that the provider did nothing.
Ordinary removal/retry retains 204. Lidarr `albumId` and Readarr `bookId` map to
SDK array targets; broader `artistId`/`authorId` are used only when the narrower
target is absent.

`POST /api/dashboard/queue/action` with `action: manualImport` returns `202`
and the strict generic Manual Import operation status, not an empty success.
Its compatibility identity is stable for an owner/original connection/service/
normalized download source; repeated requests recover that attempt without
provider reads or another command. Queue IDs are re-resolved before new work
and immediately before submission, not used to create replacement attempts.
The route imports only a wholly eligible, unambiguously mapped current source;
rejected or inconsistent candidates require explicit review in Manual Import.
Use the owned cached Manual Import operation GET to observe progress. An
intentional new selection or remainder must use the keyed Manual Import
workflow, not repeat this compatibility action. Aggregate command completion
is not per-file completion. Delete/retry actions retain their existing `204`
contract; bulk manual import remains unsupported by the bulk API route.

### Dashboard History contract

`GET /api/dashboard/history` is protected and reads only the durable local
observation publication. Query keys are `limit` (integer 1–100), `cursor`,
`startDate`, `endDate`, `search`, `service`, `instanceId`, `eventType`, and
`hideProwlarrRss`. The response is strict History v2: retained observations,
positive-only per-source status, and page metadata whose
`matchingObservedCount` is the exact local retained match count, not a provider
total. The cursor is opaque and expires after 30 minutes; clients restart
pagination when it is stale. Invalid queries/cursors return generic 400,
stale cursors return generic 409, and unavailable reads return generic 503.

### Media-server cache refresh contract

Manual cache refresh requests use durable acceptance. Each protected endpoint
returns HTTP `202` with the strict response shape
`{ status: "accepted", cacheType: "plex" | "jellyfin" | "tautulli" }`
after the refresh attempt is durably admitted. The receipt does not mean the
provider refresh has completed and contains no completion counters, timestamps,
markers, or provider error details. Observe completion and the resulting
truthful cache evidence through the corresponding health/status GET endpoints.

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/plex/cache/:instanceId/refresh` | Durably accept a Plex cache refresh request |
| POST | `/jellyfin/cache/:instanceId/refresh` | Durably accept a Jellyfin/Emby cache refresh request |
| POST | `/tautulli/cache/:instanceId/refresh` | Durably accept a Tautulli cache refresh request |

### Plex section catalog and requested scan

`GET /api/plex/sections` is a cache-only read of the enabled, owned Plex section
catalog. Each option includes `sectionId` and `sectionUuid`. The response's
`catalog` reports `availability` (`current`, `last-known`, or `unavailable`) and
`observedAt` independently of canonical mapping/watch `evidence`. Complete
receipt-backed catalog evidence can remain usable when mapping or watch evidence
is partial. Retained values are explicitly last-known. Missing proof or an
unavailable configured instance returns 503 rather than a silently truncated list.

`POST /api/plex/:instanceId/sections/:sectionId/refresh` requires JSON
`{ "sectionUuid": "<selected section UUID>" }`. Before requesting a scan, it
reloads the owned catalog, checks the current Plex identity and exact live
section key/UUID/type, and revalidates the stored connection. Changed or ambiguous
targets return 409; unavailable validation returns 503 without a scan request.
Success is returned only after provider acknowledgement. An unconfirmed write
returns 502 and is not automatically retried; inspect Plex activity before an
explicit retry. Catalog display does not grant watch-state or cleanup authority.

## Library (`/api/library`)

| Route | Purpose |
|-------|---------|
| `/library` | Movies/series list |
| `/library/poster/:instanceId/:itemType/:itemId` | Authenticated cached ARR root-item poster |
| `/library/episodes` | Series episodes |
| `/library/provider-inventory` | Owned Plex/Jellyfin/Emby native movie, series, or episode inventory |
| `/library/monitor` | Toggle monitoring |
| `/library/search` | Search for content |

`GET /api/library` projects existing root-item posters to the authenticated poster
route using the cache row's instance, type and ARR item ID. The TMDb deep-link
lookup uses the same projection. An opaque artwork-source version lets changed
cached artwork retry without exposing its URL. Poster delivery requires
an owned, enabled Radarr/movie, Sonarr/series, Lidarr/artist or Readarr/author cache
match. It reads only that instance's fixed media-cover path, with server-side
credentials, no redirects, a five-second timeout and a four-MiB raster-image limit.
It does not scan the provider, change cached metadata or persist image files.
Successful images use private five-minute HTTP caching; missing images return 404,
invalid upstream responses 502 and transport failures 503, all with generic errors
and no-store caching. Nested album/book artwork is not covered by this route.

`GET /api/library/provider-inventory` reads durable native evidence without contacting the provider. It normally reads a published exact snapshot. For Jellyfin episodes only, when a newer completed scan pass cannot establish exact coverage, it may instead display observed rows from that pass as `evidence: "positive-only"`, `complete: false`, and `freshness: "last-known"`. Those rows establish presence only; missing rows do not establish absence or grant cleanup authority. Supply `instanceId` and `domain=library|episode`; `limit` defaults to 100 and is capped at 200. Continue with both `afterNativeId` and the first page's `generationId` as `expectedGenerationId`, including for positive-only pages. A replaced snapshot or pass returns `status: "unavailable", reason: "snapshot-changed"`; restart at the first page.

For a published library, optional `metadataFilter=missing-tmdb` returns only
native movie/series rows without one unique normalized TMDb ID. It reads the
same generation-pinned inventory, never calls the provider, and does not infer
an ARR match, watch state, or cleanup authority. `itemCount` remains the full
published inventory size; `filteredItemCount` is the filtered subset size.
Continue filtered pages with the returned `nextNativeId` and `generationId`.
The filter is invalid for `domain=episode` and returns `unsupported-provider`
for an owned non-Plex instance. Inventories above the 100,000-item diagnostic
filter limit return `filter-limit-exceeded`; the normal unfiltered inventory
remains available. Neither condition is reported as a changed snapshot.

Available responses include the native item total, observation time, refresh state, and a bounded page. `complete` describes the latest confirmed inventory of supported movies/series or episodes; `freshness: "last-known"` retains the previous snapshot while current coverage is unconfirmed. Unavailable responses omit counts. Native presence includes unmatched items and does not itself establish watched state, ARR correspondence, absence, or permission to mutate media.

Jellyfin/Emby episode rows may include an independent, display-only `watch` object: `state` is `watched`, `unwatched`, or `unknown`; `freshness` is `current`, `last-known`, or `unavailable`; `valueSemantics` is `exact`, `lower-bound`, or `unknown`; and `observedAt` is an ISO timestamp or `null`. A verified positive can be a lower bound when another scope is missing; a negative requires a matching verified episode row for every relevant user/library scope, even if other episodes leave a scope partial. Last-known watch evidence expires after 24 hours. The field does not grant cleanup, unmonitor, or other mutation authority.

For Jellyfin episodes, a separate five-minute, two-pass watched-only refresh can
advance matched positive `watch` badges without waiting for the full scan.
It cannot establish unwatched-by-absence: negative evidence still comes from
the verified full scan. Emby does not use this Jellyfin-specific positive path.


### Watch insight and series progress contracts

`GET /api/library/insights/disk-waste` and
`GET /api/library/insights/requested-unwatched` return supported library facts
with HTTP 200 when media-server watch evidence is incomplete. `data.items`
contains confirmed unwatched candidates; `data.unknownItems` contains candidates
whose watch status is unknown. Each row includes `watchState`. Missing provider
rows or mappings never establish zero plays. `data.watchStatus` distinguishes
`complete`, `partial`, `unavailable`, and `not-configured`; `limited` marks a
bounded candidate/result scan. `totalWastedBytes` is nullable and summarizes only
returned confirmed items when watch conclusions are complete. Requested insights
also expose independent `requestStatus` and retain requests collected before a
later request-page failure. Unknown watch status grants no cleanup authority.

`GET /api/plex/series-progress` and `GET /api/jellyfin/series-progress` expose
`configured` and one progress entry for each valid requested series ID when a
provider is configured. `status: exact` includes numeric `total`, `watched`, and
`percent`. `status: partial` includes a watched lower bound with null total and
percent. `status: unknown` has null counts and percent. `watchedSemantics` is
`exact`, `lower-bound`, or `unknown` respectively. Episode coordinates are
deduplicated across connections. The UI displays each provider separately.

## Backup Restore (`/api/backup`)

Restore is a protected, single-administrator operator action. It replaces the
database's backed-up accounts and settings, revokes both existing and imported
sessions, and requires runtime recovery before normal requests resume. Destination
installation identity, encryption/session secrets and storage identity are
preserved; incoming secrets do not replace them. Incomplete safety evidence is
rejected rather than interpreted as permission to discard held actions.

| Method | Path | Request / purpose |
|--------|------|-------------------|
| POST | `/api/backup/restore` | `{ backupData, password? }`; canonical base64 of the encrypted backup envelope |
| POST | `/api/backup/restore-from-file` | `{ id, password? }`; installation-local backup ID, not a filename or path |
| GET | `/api/backup/restore/status` | Protected latest positive commit evidence after runtime recovery |

Both POST request objects reject additional fields. The optional password is a
nonempty string of at most 1,024 JavaScript code units. If omitted, Restore uses
an existing configured password; it never generates a password or initializes
settings during preparation. Stored IDs are 24 lowercase hexadecimal characters
and are resolved again at execution, with regular-file, no-symlink and file-identity
checks. Each Restore entry point is limited to two requests per five minutes.

Upload permits at most 50 MiB (52,428,800 characters) of canonical ASCII base64,
with a separate 64 KiB JSON/password body allowance. This limit measures the
encoded envelope, not plaintext backup size. Stored Restore supports at most
200 MiB of decoded ciphertext and plaintext; encrypted file intake is bounded at
`4 * ceil(200 MiB / 3) + 65,536` bytes. Authentication occurs before the larger
upload body parser. Invalid input or incomplete preparation is refused before
publication.

### Publication response and compatibility change

The former generic success/backup-metadata response is replaced by a strict
discriminated result. Every terminal result contains a server-minted `restoreId`
(UUID), `outcome`, `success`, `reason`, `restartRequired: true`, and `restart`.
There is no inferred `restoredAt` or backup metadata attached to an uncertain
result. Scripts must validate the result and HTTP status together.

| HTTP | Outcome | Success / reason | Recovery |
|------|---------|------------------|----------|
| 200 | `committed` | `true` / `null`; positive commit and physical writer closure verified | `automatic-requested` or `manual-required` |
| 409 | `not-committed` | `false` / `state-changed`; verified terminal non-commit | `automatic-requested` or `manual-required` |
| 503 | `unavailable` | `false` / `ownership-unavailable`, `closure-unverified`, or `commit-unknown` | Always `manual-required` |

A rejection before publication is not a terminal result and has no `restoreId`.
It returns a bounded error/category, such as 400 `invalid-backup` or 409 for an
active competing operation; failed authentication returns 401. A generic 503 or
`publication-unconfirmed` cannot establish whether a commit occurred. A bare 200,
202, malformed response, timeout or disconnected socket is likewise unconfirmed,
not a successful Restore or proof of rollback. The controller joins the actual
work even when response delivery fails.

### Restart, sign-in and positive status

`automatic-requested` confirms only that restart was requested, not that the new
runtime is ready. Manual or uncertain recovery requires a complete stop of the
old runtime before starting another; a timeout or failed native close never
authorizes a second publisher. After recovery, sign in using the restored account.
The old session and account-sensitive browser cache must not be reused.

Status returns `{ latestCommitted: null }` or a latest positive record containing
`restoreId` and `committedAt`. A matching ID confirms that commit only. An absent
or different marker is unconfirmed, never proof of rollback or a historical
attempt's non-commit. Status requires normal protected admission and a fresh
session; the ID is correlation, not an authentication or mutation capability.

Do not automatically retry either POST on network loss, reload, reconnect or
sign-in. The UI permits correction after a verified prepublication refusal, but
locks ordinary resubmission after a terminal or unconfirmed result until recovery
is independently established and a new action is explicitly confirmed. Backup
creation and download retain their existing contracts outside maintenance.

## TRaSH Guides (`/api/trash-guides`)

| Route | Purpose |
|-------|---------|
| `/trash-guides/cache` | GitHub JSON cache |
| `/trash-guides/templates` | User templates CRUD |
| `/trash-guides/sync` | Manual sync |
| `/trash-guides/deployment` | Deploy to instances |
| `/trash-guides/quality-profiles` | Profile management |
| `/trash-guides/custom-formats` | Custom format management |

## Manual Import

All Manual Import routes use the existing authenticated route scope. Sonarr,
Radarr, Lidarr and Readarr are supported.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/manual-import` | Read candidates from the owned connection |
| POST | `/api/manual-import` | Prepare and submit one durable import attempt; return `202` with generic progress |
| GET | `/api/manual-import/operations?idempotencyKey=…` | Recover cached owned progress after a lost submission response |
| GET | `/api/manual-import/operations/:operationId` | Read cached owned progress without provider requests |
| GET | `/api/manual-import/operations/:operationId/remainder?instanceId=…&service=…&downloadId=…` | Explicit read-only review of fresh remaining candidates from the original owned source |
| GET | `/api/manual-import/legacy?instanceId=…&service=…&downloadId=…` | Discover cached owned legacy progress; never contact providers or adopt on GET |
| GET | `/api/manual-import/source?instanceId=…&service=…&downloadId=…` | Discover cached tracked or legacy progress without a browser attempt key |

Submission accepts an optional `idempotencyKey` (1–128 ASCII letters, digits,
colons, underscores or hyphens, starting with a letter or digit). Keep the same
key, connection, selection and mode when retrying: matching requests observe the
existing attempt, not another command. Reusing a key for different work returns
`409`. New submissions re-fetch and verify current owned enabled targets;
unverified or overlapping work fails closed. At most 1000 files from 32 download
sources can be prepared; split oversized selections (`413`).

New Lidarr submissions require a fresh positive album release and the provider's
exact nonempty track ID set. Readarr requires the provider's exact foreign edition
identifier. These mappings are preserved in candidate reads, commands and durable
encrypted source lookup. Clients may omit this enrichment; supplying a conflicting
release, track set or edition fails before dispatch. Invalid provider mappings
make evidence unavailable rather than publishing a reduced candidate inventory.
Stored older attempts remain observable without resubmission; absent-edition v1
bindings retain their historical value.

For older clients without a key, identical owner/connection/service/selection and
normalized mode derive one stable compatibility attempt. A later intentional
attempt requires an explicit new key and current target verification; keyless
retries cannot bypass historical protection.

The closed progress response contains `operationId`, `state`, `reason`,
`selectedFileCount`, `verifiedFileCount` and `canConsiderNewAttempt`. Command
acceptance or aggregate command completion does not prove imported files.

Remaining-candidate review is an explicit provider-read operation, never ordinary
cached-status polling. Its strict query binds the owned operation, original
enabled connection, service and download source. A consistent positively
terminal command and inactive source claim are required. The review is bounded
to 15 seconds, 10000 transient candidates and 1000 original files, and rechecks
the operation revision, connection and source claim after provider reads.

The closed response contains cached `operation`, original `importMode`
(`move` or `copy`), `sourceFileCount`, `sourceVerifiedFileCount`,
`verifiedEpisodeCount`, `unavailableFileCount` and current normalized
`candidates`. Source counts are conserved: verified files plus unavailable
original targets plus offered candidates equal the original source file count.
Only original source/path/media mappings can be offered. Already proven files
and Sonarr episodes are excluded; partial episode evidence never fabricates a
completed file. Missing, remapped, ambiguous or provisional targets remain
counted as unavailable rather than implying imported success or absence.

Review performs no database write, historical source-payload decryption,
provider POST, reconciliation, legacy adoption or cleanup action. The provider
client uses the existing stored connection credentials normally. Foreign
bindings return `404`; unavailable or changed evidence returns a generic `503`.
Candidates are not mutation permission: final submission must independently
revalidate current targets and all owned source-history protection. An explicit
remaining-file POST includes bounded `remainderOf` and a new explicit
`idempotencyKey`; keyless remaining-file requests are rejected. The predecessor
binds the new intention, so changing it cannot reuse the same key. Preparation
and the final pre-POST fence require current original-target mappings and exclude
positive file/episode evidence across owned source history. A review is never
execution-time authority, and an arbitrary new key cannot bypass protection.

The UI distinguishes cached Check progress from explicit Review remaining files.
Review offers only unproven original targets, shows unavailable targets and
positive episode counts separately, clears old selections, and fixes the
original move/copy mode. Choosing files and submitting are separate interactions;
review never selects or imports automatically. The new attempt key, selection
hash, mode and predecessor are retained before POST, without private paths or
provider payloads. Reload or lost acknowledgement observes that retained attempt
rather than sending another command. Cancelling an unsent review preserves the
old attempt. A proved-not-submitted preparation has no terminal command and does
not itself qualify as a terminal-remainder predecessor. The explicit Review a
new attempt action reads current candidates without selecting or submitting,
then retains a distinct normal attempt key before a deliberate POST. Its cached
status is a UI hint only: preparation and the final fence still prove that all
source history permits the new intention. Cancel, failed reads/storage and reload
preserve observation rather than replay. If the retained unsubmitted attempt was
itself a remainder, review uses its original terminal predecessor and fixed mode,
not the unsubmitted operation, and retains another distinct key before POST.
Discovered source histories must be inspected explicitly; ordering or an
unsubmitted record never bypasses an earlier submitted operation's protection.

Legacy discovery returns a closed `kind`: `none` means no recorded legacy import
for this owned connection/source, not permission to submit or clean up;
`unavailable` carries only `reason: evidence-unavailable`, with no fabricated file
counts; `observed` contains the normal cached `operation` progress. Query fields
are bounded and strictly validated. Same-owner aliases do not borrow receipts.
Positively completed history remains readable after permitted connection removal.
The existing observation job adopts uniquely bound legacy commands using provider
GETs. An exact pending or unknown command supplies factual selected-file counts,
but no verified files, terminal authority, or reconsideration hint. Recognized
terminal outcomes require a valid end time; per-file completion requires separate
positive History evidence. The job alternates legacy discovery
with tracked work, visits at most four connections/one receipt each per tick,
rotates past unavailable receipts and backs off for a minute after a full sweep.
Legacy receipts remain unchanged and independently protect cleanup.

Source discovery uses the same closed projection. An owned active source claim
selects its exact owner/connection/service/source-bound operation. Dangling,
foreign or mismatched claims return unavailable, not absence. Without an active
claim, unique matching recorded progress is readable; multiple attempts return
`history` with at most twenty distinct operation projections and a nullable
`nextCursor`. Continue using the optional `cursor` query parameter, which must
belong to this exact owned connection/service/source. Invalid or missing cursor
records return unavailable, not source absence. Pages use stable opaque-ID
ordering, not chronology or arbitrary latest selection; an active exact claim
takes precedence even during pagination. An empty continuation page means no
more recorded attempts on that page, not that the source has no history.
There is no arbitrary lifetime-attempt cap. With no tracked
work, legacy receipt discovery applies. This route reads only cached state:
no provider calls, decryption, adoption, scheduler trigger or database writes.
Counts describe the selected operation's entire batch, including other downloads
in that batch, not a synthetic per-source total. Historical rows are never
deleted or excluded using an arbitrary age cutoff.

For a source-bound review without a valid retained attempt, the web UI reads
cached source progress before loading candidates. Recorded or unavailable import
evidence enters observation-only mode; checking progress and reopening send no
import command. A valid retained attempt takes precedence over source discovery.
Multiple records are listed individually; inspecting one or changing pages only
reads cached progress. Page/context changes clear the selected presentation,
and unavailable evidence blocks inspection/pagination while labeling retained
last-known counts. Historical inspection creates no attempt key and confers no
new-action or cleanup authority.
Discovered historical completion is displayed without announcing a new
successful import. Folder-only review has no source lookup until a source
is known; execution-time source protections remain mandatory.

The web UI retains only a versioned opaque attempt key, selection hash and mode
in owner/connection/source-scoped session storage. Reloading the same tab can
recover through the cached key lookup without another import command. Storage
failure or corrupt retained state blocks new submission; changing or clearing
browser state is not permission to replay an uncertain import. Closing the tab
does not preserve its local key in another tab or browser; source-bound reviews
can still discover owned cached progress through the source route.
The reconsideration flag is a display hint, not replay or cleanup authority.
Absent and foreign operations return the same `404`; inconsistent cached file
counts return generic unavailable `503`, never invented zero/success. Progress
does not expose paths, source IDs, credentials or raw provider responses.

## Additional Routes

Subscription PUT retains the existing owned-channel filtering policy and returns
`{ success: true, grid, omittedCount }` only after commit. The grid is the owned
GET projection read inside the write transaction; omittedCount counts submitted
entries filtered out, without identifying excluded targets. Unsubmitted and
stored legacy subscription rows remain intact. The web client validates and
projects the grid before publishing it. A legacy `{ success: true }` response
requires one validated GET and leaves the omitted count unknown. Unverified
outcomes retain and lock the draft until an explicit GET reload succeeds; that
reload discards the draft without replaying PUT.

### Notification queue observations

`GET /api/notifications/statistics?days=7|14|30|90` retains its delivery-History
period, totals and breakdowns and adds an independently read, owner-scoped
`queue` observation. Queue counts are not included in delivery success rates.
The queue covers accepted work regardless of the selected History period or
whether a historical recipient channel still exists.

An observed queue carries `state: "observed"`, a UTC `observedAt`, event counts
`ready`, `deferred`, `aggregating`, recipient-delivery counts `ready`,
`retryWaiting`, `submitting`, `uncertain`, and nullable UTC `oldestDueAt`.
Event and recipient counts have different units and must not be summed as one
delivery total. A due time is not a guaranteed completion time; submitting is
not a confirmed delivery. Interrupted unconfirmed attempts are not blindly resent.

Counts and earliest due work are read in one read-only serializable transaction.
A failed read returns only `state: "unavailable"` with `storage-unavailable`;
unsupported stored state returns `state-unavailable`, not zero. Valid delivery
History remains usable independently. The projection never exposes payloads,
recipient identifiers, credentials, worker tokens or raw storage errors through
the queue field. An absent legacy queue is not an observed empty queue.

The web client validates counts and timestamps and retains only public fields.
Malformed queue evidence becomes unavailable without discarding valid History.
The read-only queue panel labels cached counts last-known during a pending or
failed read and replaces them only after an admitted response. “Read queue
status” performs this GET only; it does not send, replay or change settings.

### Notification channel Test outcomes

`POST /api/notifications/channels/:id/test` retains `200` for a passed provider
Test and `400` for a failed Test. Results include `success` and `statusRecorded`;
failures also include a controlled `failureCategory`, `error` and fixed `message`.
Categories are shared by the API and UI; provider exception text is never guidance.
The provider Test outcome and recording its badge are independent. A passed Test
with `statusRecorded: false` must not be resent merely to save the badge.
Status recording is fenced to the owned connection snapshot actually tested.
An edited, deleted or reassigned connection cannot inherit that old result.
The UI says “Test passed,” not “Sent,” because a connectivity Test is not always
a delivered notification. Missing/malformed outcomes remain unverified.

Changing connection configuration clears its persisted Test badge atomically with
the settings update. Metadata-only edits and semantically equivalent validated
configuration retain that proof and encrypted identity; randomized encryption or
JSON key ordering is not a configuration change. Delivery history is retained.
Successful form saves clear prior transient Test feedback without another Test;
failed or canceled edits do not discard evidence for unchanged settings.

### Notification channel conditional editing

`GET /api/notifications/channels/:id/config` returns an opaque `configRevision`
alongside the owned, credential-redacted settings. A conditional edit submits it
as `expectedRevision` to `PUT /api/notifications/channels/:id`. Stale settings
return `409` with `code: "CHANNEL_SETTINGS_CONFLICT"` and apply no part of the
update. Re-read current settings, review/reapply the intended changes and submit
the new revision; do not automatically retry the old draft. The UI retains an
unsaved conflict draft until an explicit reload discards it.

Revisions cover editable settings and encrypted connection configuration, not
delivery diagnostics, Test timestamps or subscriptions. They are concurrency
preconditions, never ownership or delivery authority. Legacy callers may omit
`expectedRevision` for intentionally blind patches; the server still fences its
owned read/update snapshot against intervening settings changes. This does not
protect a legacy caller's stale full draft without a supplied revision.

`GET /api/notifications/channels/:id/edit-state` is an authenticated, read-only
repair check for the currently owned channel. It returns exactly `id`, `name`,
`type`, `enabled`, `configRevision` and `state` (`readable` or `repair-required`).
The state describes decrypt/JSON/schema readability, not delivery success.
Missing or foreign channels return a generic `404`; database lookup failures
and unsupported stored types remain generic errors. No configuration, credentials,
diagnostics, subscriptions or internal error details are returned or written.

After a failed ordinary configuration read, the editor offers an explicit
GET-only repair check. Only `repair-required` permits explicit blank re-entry
of the full configuration. **Save replacement** uses the existing PUT with only
`config` and the freshly read `expectedRevision`; name, type and enabled state
are retained. Omitted optional fields are replaced/cleared rather than retained.
The channel identity, event subscriptions, rules and delivery history remain;
changed connection settings clear old Test proof. Conflicts and unverifiable
save acknowledgments preserve the draft and block replay until an explicit
current read and re-entry. Persistence does not certify delivery, recover lost
secrets or repair an encryption key. Repair checks and opening the editor never
save settings, run a provider Test or send a notification.

Manual re-entry also requires usable configuration field definitions. A
browser-generated channel with an empty field descriptor cannot use manual
re-entry. Browser Push offers a separate selected-channel reconnect flow using
native generated configuration, described below.

### Reversible browser push device lifecycle

The authenticated notification group exposes these JSON POST operations:

| Path | Body | Behavior |
|------|------|----------|
| `/api/notifications/push-subscription/state` | `endpoint` and/or `channelId` | Read-only owned device observation; no enrollment or write lock |
| `/api/notifications/push-subscription/disable` | Same selector; `expectedRevision` required with `channelId` | Disable only this owned device's server delivery, retaining channel settings, subscriptions, rules and history |
| `/api/notifications/push-subscription/enable` | `endpoint`, `keys: { p256dh, auth }`, optional paired `channelId` and `expectedRevision` | Explicitly enable, or rebind a retained device to its new browser subscription |
| `/api/notifications/push-subscription/reconnect` | Required `channelId`, `expectedRevision`, `endpoint`, `keys: { p256dh, auth }`; unknown fields rejected | Explicitly replace the selected owned channel's generated config, including unreadable old config, preserving its enabled state |

Each returns `{ channelId, configRevision, state, subscribedEventCount }`.
Registered devices have nonempty opaque channel IDs, 64-hex settings revisions,
`enabled` or `disabled` state, and a nonnegative supported-event subscription
count. An authoritative unmatched endpoint returns `unregistered`, null handles
and zero count. An explicitly supplied absent/foreign handle returns generic
`404`; conflicting or unreadable device evidence returns generic `409` without
falling back to a different device. Database failures return sanitized `500`
and roll back mutation transactions. Endpoints and keys belong only in request
bodies, never URLs. Revisions are concurrency preconditions, not ownership.

Enable and disable resolve the current owned `BROWSER_PUSH` channel within a
transaction serialized by the same owned User lock as legacy enrollment. A
retained handle cannot overwrite another device already using the new endpoint.
New devices share the ten-device cap and receive no automatic event selection.
Equivalent configuration retains ciphertext, IV and Test proof; endpoint/key
changes clear Test proof while retaining delivery history and send diagnostics.
Legacy `POST /push-subscription` keeps its existing response and disabled-row
deduplication policy.

Reconnect acquires the same owned User lock, resolves the selected owned
`BROWSER_PUSH` channel and fences its current revision and stored row. It never
selects by endpoint or creates another channel. Only this selected replacement
may proceed without decrypting its old config; every other owned Browser Push
config must be readable and unambiguous, with no collision at the replacement
endpoint. The complete replacement is encrypted, persisted and decoded within
the transaction before returning retained enabled/disabled state. Channel name,
identity, event subscriptions, rules, history and send diagnostics are retained;
old Test proof is cleared. Ordinary state, enable and disable checks are unchanged.

The selected repair screen warns that reconnect replaces the former browser
destination and preserves events, history and the enabled setting. Browser
permission has its own direct click; granted consent requires a subsequent
explicit replacement confirmation. Confirmation freshly reads owned edit state,
uses native-generated subscription keys, checks the unchanged native endpoint
before dispatch, and reads back the selected binding and retained state. It
does not overwrite the global browser card's retained handle or unsubscribe on
failure. Incognito, account, unmount and browser changes fence late work. An
unknown write, timeout or invalid acknowledgment requires a read-only current
state check before a new explicit action; there is no automatic mutation replay.
Reconnect neither recovers old secrets nor certifies physical notification delivery.

The browser card observes both browser and server state, retains only an opaque
channel ID in a versioned account-scoped storage key, and disables server delivery
before browser removal. Fresh browser absence confirms removal even when
`unsubscribe()` returns false; a surviving subscription never establishes full
completion. Partial failures require read-first, targeted retry rather than
automatic mutation replay. Active registration is independent of selected
events, provider acceptance, and received delivery.
Browser consent is a separate explicit action: “Allow notifications” invokes
the permission prompt directly from the click and never enrolls the device.
After permission is granted, a subsequent “Enable” action freshly reads device
evidence before subscribing and enabling delivery; already-granted consent is
not requested again. Dismissed consent stays retryable rather than implying
denial. Unknown dispatched enable/disable outcomes trigger independent channel
and subscription cache rereads without replaying the write or claiming completion.
Read-first recovery also reconciles those caches after a verified observation.
After a failed retained-device enable survives reload, initial inconsistent
browser/handle evidence stays unverified. Explicit “Reconnect device” first
reads the retained owned handle and current revision, then explicitly rebinds
that same channel to the browser subscription. The handle-only read establishes
ownership and settings, not endpoint binding. Missing, foreign or unreadable
handles abort reconnect before any mutation.
If consent is needed, the owned retained read first admits the separate permission
action; the later Enable action repeats that owned admission before rebinding.

| Prefix | Purpose |
|--------|---------|
| `/api/search` | Prowlarr indexer search + grab |
| `/api/discover` | TMDB/Seerr discovery |
| `/api/hunting` | Auto-search configuration and execution |
| `/api/queue-cleaner` | Queue cleanup rules, strikes, dry-run preview |
| `/api/library-cleanup` | Library cleanup rules, approvals, execution, and retention-capped action activity |
| `/api/manual-import` | Manual import candidates, tracked submission and cached progress |
| `/api/backup` | Backup create, download, restore, scheduled backups |
| `/api/system` | System settings, info, restart |
| `/api/pulse` | System Pulse health signals and attention items |
| `/api/notifications` | Channels, subscriptions, rules, delivery, aggregation |
| `/api/oidc-providers` | OIDC provider admin configuration |
| `/api/plex` | Now playing, on-deck, watch history, collections, analytics (bandwidth, codec, device, transcode, user), forecasts, episode completion, quality scores |
| `/api/tautulli` | Activity, watch history enrichment, statistics |
| `/api/seerr` | Request management, discovery, library enrichment, issues, notifications, user info |

`GET /api/seerr/notifications/:instanceId` returns verified `agents`, `coverage`
(`complete`, `partial`, or `unavailable`), and `unavailableAgents` containing only
known public agent IDs/names. Only provider 404 means unsupported. Other request
or response-validation failures remain explicit unknown configuration; partial
and unavailable results are not cached. A subsequent read retries current
provider state. Complete empty coverage means no supported known agents.

### Manual Search Grab: provenance, intent and recorded status

`POST /api/search/grab` accepts only `{ instanceId, selector, intentId, retry? }`.
Use an accepted `/api/search/query` row's `grabSelector` as `selector` and generate
a UUID `intentId` for the operator action. `instanceId` is a routing hint: owned,
enabled Prowlarr identity and exact connection evidence are resolved server-side.
Display titles, URLs, result IDs and raw release objects cannot authorize Grab.
Legacy `{ instanceId, result }` requests are refused; update external scripts.

Only a matching provider acknowledgement **persisted in the database** produces
empty204. Prepared/submitting returns202, positive provider rejection422, and an
unconfirmed provider outcome502, with a bounded safe `status` when available.
Admission conflict409 does not prove an earlier action failed. Forged or malformed
input is refused before dispatch. Provider/private diagnostics are never returned.

Keep the same intent after a lost reply: replay observes its recorded contract,
never automatically sends again. Its expired original selector can still prove
that exact observation, but cannot admit a new action. `GET
/api/search/grab/intents/:intentId` returns owner-scoped state, attempt/intent IDs,
timestamps, a generic outcome category and a safe next-action category; no selector
is required. Missing404 or unreadable status remains unavailable—not proof of no
delivery, rejection or safe resubmission. Status reads do not recover or mutate jobs.

For reload recovery after a new search, `POST /api/search/grab/results/status`
accepts `{ results: [{ instanceId, selector }] }` with one to50 entries. This is a
strictly read-only operation: the body keeps opaque selectors out of URLs; there
is no provider call, dispatch, recovery or database mutation. Each response slot
contains its sequential `resultIndex`, `availability` and generic `status`.
`recorded` returns the exact active held attempt, otherwise the latest matching
record. `not-recorded` means only that no dashboard record matched—not that the
provider never received a submission. `unavailable` has null status and cannot
authorize resubmission. Fresh owned result provenance and unchanged connection
proof are required; expired, replaced, missing or foreign evidence is unavailable.
Disabled owned connections can still be observed but cannot admit a new Grab.
Native/read failures return generic unavailability, not an empty-success response.

After uncertainty, a separately confirmed NEW intent requires fresh provenance for
the identical target and `retry: { predecessorId, duplicateRiskConfirmed: true }`.
The predecessor is the recorded attempt ID, not the intent ID. Claim transfer is
atomic; conflicting confirmations cannot each submit. Acknowledgement bookkeeping
failure, restart or elapsed time does not release an unresolved hold. Changing
encryption keys can invalidate old selectors; the selector-free intent read remains
the observation path. Never infer outcome from titles, queue emptiness or timers.

Connection identity replacement and deletion refuse with409 while a Grab claim
is held. The check runs under the same owner-scoped row fence as admission and
dispatch, in the connection-write transaction; an earlier read is not authority.
Presentation/default/tag edits and disabling remain available when the canonical
dispatch binding is unchanged. Disabling does not cancel a submission or release
its hold, and recorded status remains readable. Re-enabling does not resend it.
Identical credential re-entry is permitted only when the existing internal
credential check retains the original encrypted representation; a replacement
fingerprint cannot inherit an unresolved submission's authority. After settled
acknowledgement or positive rejection, a permitted connection deletion preserves
recorded Grab outcome history. A concurrent connection conflict requires reviewing
current state; it never authorizes an automatic provider retry.

Hunting wanted reads require valid, stable provider totals on every page. A
malformed response, inconsistent total, premature empty page, or exhausted
20-page read budget produces an error before searches are submitted. A provider
may return fewer rows than requested; pagination continues until its total is
covered. Inventories beyond this budget are not silently treated as complete;
large-inventory continuation remains unsupported by this bounded reader.

Manual Import candidate reads distinguish a genuinely empty provider list from
unavailable evidence. Invalid response shapes or unrepresentable rows produce
a generic 502 rather than a silently reduced list. Fetch errors and candidate
validation logs do not include provider error text, file paths, or raw payloads.

## System Routes (`/api/system`)

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/system/settings` | Get system settings (ports, listen address) |
| PUT | `/system/settings` | Update system settings |
| GET | `/system/info` | Get system info (version, database backend, runtime) |
| POST | `/system/restart` | Trigger application restart |
