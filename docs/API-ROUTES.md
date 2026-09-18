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
| `/health` | stable | Liveness/readiness probes for orchestrators |
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
| `/api/manual-import` | stable | Manual import candidates and submission |
| `/api/hunting` | internal | Auto-search configuration and execution |
| `/api/queue-cleaner` | internal | Queue cleanup rules, strikes, dry-run preview |
| `/api/library-cleanup` | internal | Library cleanup rules, approvals, execution, and retention-capped action activity |
| `/api/plex` | stable | Now playing, on-deck, history, analytics, forecasts |
| `/api/jellyfin` | stable | Jellyfin activity and library data |
| `/api/tautulli` | stable | Activity, watch history enrichment, statistics |
| `/api/label-sync` | experimental | Generic any-to-any media-service tag/label sync rules (issue #384). Sub-arc 1 ships Sonarr/Radarr → Plex. |
| `/api/auto-tag` | experimental | Criteria-based auto-tagger — applies tags to ARR items matching criteria, including positive Plex/Jellyfin presence at the last complete scan. `GET /rules/:id/preview` evaluates candidates without writing tags or recording a run; execution rechecks current evidence. Companion to Label Sync. Webhook config (secret read/rotate) lives here under session auth. |
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
this request, not an exhaustive provider-history total.

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

> Federated peer integration with autobrr/qui (qBittorrent UI) — read-only torrent state, trackers, cross-seed siblings.

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| GET | `/qui/instances` | Yes | List QUI instances for current user |
| GET | `/qui/instances/:id/qbit` | Yes | List qBittorrent instances behind a QUI instance |
| GET | `/qui/instances/:id/torrents/by-hash/:hash` | Yes | Get torrent by info hash |
| GET | `/qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers` | Yes | Get trackers for a torrent (filters DHT/PeX/LSD) |
| GET | `/qui/instances/:id/qbit/:instanceId/torrents/:hash/cross-seed` | Yes | Get cross-seed matches for a torrent |
| POST | `/qui/instances/:id/test` | Yes | Test connection to a saved QUI instance |
| POST | `/qui/test` | Yes | Test connection with inline credentials (no storage) |

The Library route (`GET /api/library`) accepts `?torrentState=` for server-side filtering (Phase 2.1). Allowed values: `all` (default), `none` (rows without qui data yet), `seeding`, `downloading`, `stalled_dl`, `paused`, `queued`, `checking`, `moving`, `error`, `unknown`. State is populated by the periodic `qui-torrent-state-sync` scheduler (10 min). The response also includes a `torrentStateCounts` object (per-state counts honoring every other applied filter) so the UI dropdown can show `Seeding (150)` etc.

**Backfill coverage**: the `infohash-backfill` scheduler walks LibraryCache rows missing `infoHash`, queries the relevant *arr's dedicated `/api/v3/history/movie` (Radarr) or `/api/v3/history/series` (Sonarr) endpoint for the original grab record, and persists the hash. **Two-phase cadence**:

- **Catch-up phase** runs at startup whenever the backlog is non-zero — fires batches back-to-back with a 60s gap, capped at 10k rows per startup (~17 min worst-case). Drains an existing library quickly: a 1500-row backlog completes in ~5 minutes.
- **Steady-state phase** takes over after catch-up, running every 6h to capture any new items that have landed since the last sweep.

Per-row sleep is 100ms regardless of phase — that's the politeness budget against *arr. Without this scheduler, only items grabbed since PR #416 (2026-05-04) ever get correlated with qui. The base `/api/v3/history` endpoint is intentionally NOT used: it accepts `movieIds`/`seriesIds` (plural arrays) and silently ignores the singular form, returning unfiltered global history that would assign the same hash to every item.

## Dashboard (`/api/dashboard`)

| Route | Purpose | Refresh |
|-------|---------|---------|
| `/dashboard/queue` | Download queue | 30s |
| `/dashboard/history` | Authenticated durable History v2 read: retained local observations with server-side filters and opaque cursor pagination | Stable |
| `/dashboard/calendar` | Upcoming releases | 60s |
| `/dashboard/statistics` | Aggregate stats | 120s |

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

## Library (`/api/library`)

| Route | Purpose |
|-------|---------|
| `/library` | Movies/series list |
| `/library/episodes` | Series episodes |
| `/library/provider-inventory` | Owned Plex/Jellyfin/Emby native movie, series, or episode inventory |
| `/library/monitor` | Toggle monitoring |
| `/library/search` | Search for content |

`GET /api/library/provider-inventory` reads a published native snapshot without contacting the provider. Supply `instanceId` and `domain=library|episode`; `limit` defaults to 100 and is capped at 200. Continue with both `afterNativeId` and the first page's `generationId` as `expectedGenerationId`. A replaced snapshot returns `status: "unavailable", reason: "snapshot-changed"`; restart at the first page.

Available responses include the native item total, observation time, refresh state, and a bounded page. `complete` describes the latest confirmed inventory of supported movies/series or episodes; `freshness: "last-known"` retains the previous snapshot while current coverage is unconfirmed. Unavailable responses omit counts. Native presence includes unmatched items and does not establish watched state, ARR correspondence, absence, or permission to mutate media.


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

## TRaSH Guides (`/api/trash-guides`)

| Route | Purpose |
|-------|---------|
| `/trash-guides/cache` | GitHub JSON cache |
| `/trash-guides/templates` | User templates CRUD |
| `/trash-guides/sync` | Manual sync |
| `/trash-guides/deployment` | Deploy to instances |
| `/trash-guides/quality-profiles` | Profile management |
| `/trash-guides/custom-formats` | Custom format management |

## Additional Routes

| Prefix | Purpose |
|--------|---------|
| `/api/search` | Prowlarr indexer search + grab |
| `/api/discover` | TMDB/Seerr discovery |
| `/api/hunting` | Auto-search configuration and execution |
| `/api/queue-cleaner` | Queue cleanup rules, strikes, dry-run preview |
| `/api/library-cleanup` | Library cleanup rules, approvals, execution, and retention-capped action activity |
| `/api/manual-import` | Manual import candidates and submission |
| `/api/backup` | Backup create, download, restore, scheduled backups |
| `/api/system` | System settings, info, restart |
| `/api/pulse` | System Pulse health signals and attention items |
| `/api/notifications` | Channels, subscriptions, rules, delivery, aggregation |
| `/api/oidc-providers` | OIDC provider admin configuration |
| `/api/plex` | Now playing, on-deck, watch history, collections, analytics (bandwidth, codec, device, transcode, user), forecasts, episode completion, quality scores |
| `/api/tautulli` | Activity, watch history enrichment, statistics |
| `/api/seerr` | Request management, discovery, library enrichment, issues, notifications, user info |

## System Routes (`/api/system`)

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/system/settings` | Get system settings (ports, listen address) |
| PUT | `/system/settings` | Update system settings |
| GET | `/system/info` | Get system info (version, database backend, runtime) |
| POST | `/system/restart` | Trigger application restart |
