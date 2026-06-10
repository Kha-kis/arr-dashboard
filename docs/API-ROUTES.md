# API Routes Reference

> Reference documentation extracted from CLAUDE.md for detailed deep dives into the API route structure.

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
| `/api/library` | stable | Movies/series listing, episodes, monitor, search |
| `/api/search` | stable | Prowlarr indexer search + grab |
| `/api/manual-import` | stable | Manual import candidates and submission |
| `/api/hunting` | operator | Auto-search configuration and execution |
| `/api/queue-cleaner` | operator | Queue cleanup rules, strikes, dry-run preview |
| `/api/library-cleanup` | internal | Library cleanup rules, approvals, execution |
| `/api/plex` | stable | Now playing, on-deck, history, analytics, forecasts |
| `/api/jellyfin` | stable | Jellyfin activity and library data |
| `/api/label-sync` | operator | Generic any-to-any media-service tag/label sync rules (issue #384). Sub-arc 1 ships Sonarr/Radarr → Plex. |
| `/api/auto-tag` | operator | Criteria-based auto-tagger — applies tags to LibraryCache items matching the rule's criteria DSL (genre, year, codec, watch state, …). Companion to Label Sync. Webhook config (secret read/rotate) lives here under session auth. |
| `/api/auto-tag/webhook` | operator | Inbound Sonarr/Radarr Connect webhook for real-time auto-tagging. **Public route** (no session cookie); authenticates via per-user Bearer token (SHA-256 hash of the user's webhook secret). |
| `/api/pulse` | internal | System Pulse health signals + attention items |
| `/api/qui` | stable | Federated peer integration with autobrr/qui (qBittorrent UI) — torrent state, trackers, cross-seed siblings, and capability-aware torrent mutations; powers the Torrent Health panel and detail drawer. |
| `/api/webhooks/qui` | stable | Inbound qui webhook receiver (Phase 5.1). **Public route** (no session cookie); authenticates via per-user `?secret=…` query param (matches qui's `ApiKeyQuery` scheme). Stores raw events in `QuiEventLog` and publishes to the in-process event bus for SSE fan-out. |
| `/api/seerr` | stable | Request management, discovery, library enrichment |
| `/api/trash-guides` | operator | TRaSH cache, templates, deployment, profiles |

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
| `/dashboard/history` | Download history | 60s |
| `/dashboard/calendar` | Upcoming releases | 60s |
| `/dashboard/statistics` | Aggregate stats | 120s |

## Library (`/api/library`)

| Route | Purpose |
|-------|---------|
| `/library` | Movies/series list |
| `/library/episodes` | Series episodes |
| `/library/monitor` | Toggle monitoring |
| `/library/search` | Search for content |

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
| `/api/library-cleanup` | Library cleanup rules, approvals, execution |
| `/api/manual-import` | Manual import candidates and submission |
| `/api/backup` | Backup create, download, restore, scheduled backups |
| `/api/system` | System settings, info, restart |
| `/api/pulse` | System Pulse health signals and attention items |
| `/api/notifications` | Channels, subscriptions, rules, delivery, aggregation |
| `/api/oidc-providers` | OIDC provider admin configuration |
| `/api/plex` | Now playing, on-deck, watch history, collections, analytics (bandwidth, codec, device, transcode, user), forecasts, episode completion, quality scores |
| `/api/seerr` | Request management, discovery, library enrichment, issues, notifications, user info |

## System Routes (`/api/system`)

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/system/settings` | Get system settings (ports, listen address) |
| PUT | `/system/settings` | Update system settings |
| GET | `/system/info` | Get system info (version, database backend, runtime) |
| POST | `/system/restart` | Trigger application restart |
