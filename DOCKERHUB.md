# Arr Dashboard

> **Version 2.24.1** — The **recovery and timezone correctness patch**. Sonarr episode cleanup now resumes safely after partial failures, OIDC callbacks honor configured public origins behind reverse proxies, and Sonarr calendar dates remain correct across viewer timezones and visible-grid boundaries. Workflow action pins and public repository hygiene are also refreshed.

A unified dashboard for managing multiple **Sonarr**, **Radarr**, **Prowlarr**, **Lidarr**, **Readarr**, **Plex**, **Tautulli**, **Jellyfin**, **Emby**, and **Seerr** instances. Consolidate your media automation management into a single, secure, and powerful interface.

## Quick Start

```bash
docker run -d \
  --name arr-dashboard \
  -p 3000:3000 \
  -v /path/to/config:/config \
  -e PUID=1000 \
  -e PGID=1000 \
  --restart unless-stopped \
  khak1s/arr-dashboard:latest
```

### Docker Compose

```yaml
services:
  arr-dashboard:
    image: khak1s/arr-dashboard:latest
    container_name: arr-dashboard
    environment:
      - PUID=1000  # Set to your user ID (run `id -u` on host)
      - PGID=1000  # Set to your group ID (run `id -g` on host)
    volumes:
      - ./config:/config
    ports:
      - 3000:3000
    restart: unless-stopped
```

## Supported Deployment Topology

Stable 2.x supports exactly one arr-dashboard API/container per database. Multiple replicas or containers sharing one SQLite or PostgreSQL database are unsupported. Caches, scheduler timers, event fan-out, and most runtime coordination are process-local and are not coordinated across API processes. A few library-cleanup workflows use database-backed leases, but those leases do not establish general API ownership or make a multi-API topology supported.

Stable 2.x does not enforce this restriction at runtime. Enforcement is tracked by [#829](https://github.com/Kha-kis/arr-dashboard/issues/829).

## Features

- **Unified Dashboard** — Queue, calendar, history, and statistics across all Sonarr, Radarr, Prowlarr, Lidarr, and Readarr instances
- **Plex Integration** — Now playing, watch history, on deck, recently added, and detailed analytics with leaderboards (top + most-popular) and user/device/codec charts. Tautulli is now optional enrichment, not required
- **Jellyfin & Emby Integration** — Full media server parity with Plex, sourced directly from native APIs (no Tautulli-equivalent required)
- **Seerr** — Manage media requests, users, issues, and notification agents, with optional auto-setup via Plex sign-in
- **Global Search** — Search for content across all indexers via Prowlarr
- **TMDB Discovery** — Trending, popular, and upcoming content with one-click add
- **TRaSH Guides** — Quality profiles, custom formats, naming schemes with auto-sync and profile cloning
- **Notification System** — Discord, Telegram, Email, Pushover, Gotify, Ntfy, Pushbullet, Browser Push
- **Library Cleanup** — Rule-based cleanup with 20+ condition types, approval queue, and audit logging
- **Auto-Tagger** — Criteria-based Sonarr/Radarr tagging across 50+ rule types with composite (AND/OR) rules and real-time Sonarr/Radarr Connect webhooks
- **Automated Hunting** — Auto-search for missing content and quality upgrades with per-instance config
- **Queue Cleaner** — Automated queue management with strike system and dry-run mode
- **Multi-Auth** — Password, OIDC (Authelia/Authentik), or Passkeys (WebAuthn)
- **Encrypted Storage** — All API keys encrypted at rest (AES-256-GCM)
- **Incognito Mode** — Hide all sensitive data across the entire UI for safe screenshotting
- **Backup & Restore** — Automated encrypted backups with configurable retention

## Environment Variables

### Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PUID` | `911` | User ID for file permissions |
| `PGID` | `911` | Group ID for file permissions |
| `DATABASE_URL` | `file:/config/prod.db` | Database connection string (SQLite or PostgreSQL) |

### Session & Security

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_TTL_HOURS` | `24` | Session expiration time in hours |
| `SESSION_COOKIE_NAME` | `arr_session` | Name of the session cookie |
| `PASSWORD_POLICY` | `strict` | `strict` or `relaxed` (8+ chars, passphrase-friendly) |
| `API_RATE_LIMIT_MAX` | `200` | Max requests per minute |
| `BACKUP_PASSWORD` | Auto-generated | Password for encrypted backups |
| `LOG_LEVEL` | `info` | Logging level (`debug`, `info`, `warn`, `error`) |
| `GITHUB_TOKEN` | - | Optional GitHub token for TRaSH Guides (higher rate limits) |
| `HEAP_AUTO_SNAPSHOT` | `0` | Set to `1` to capture a V8 heap snapshot just before OOM (lands in `/config/heap-snapshots/`, ~2.3 GB per snapshot). Off by default. Manual snapshots via `kill -USR2 <pid>` always available. |

### WebAuthn/Passkeys (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBAUTHN_RP_NAME` | `Arr Dashboard` | Display name shown to users |
| `WEBAUTHN_RP_ID` | `localhost` | Your domain (no protocol) |
| `WEBAUTHN_ORIGIN` | `http://localhost:3000` | Full URL with protocol |

> **Note:** Two modes are supported for running as a non-root user:
>
> **PUID/PGID (default):** Set these to match the owner of your config directory. The container starts as root, sets up permissions, then drops privileges. Follows the [LinuxServer.io convention](https://docs.linuxserver.io/general/understanding-puid-and-pgid).
>
> **Rootless (`--user`):** Run with `--user UID:GID` or `user: "UID:GID"` in Compose. No root required. Ensure `/config` is writable by the specified user.

## Version Tags

| Tag | Description |
|-----|-------------|
| `latest` | Latest stable release |
| `2.24.1` | **Recovery and timezone correctness** — Makes Sonarr episode cleanup recovery durable, fixes OIDC callback origins behind reverse proxies, and corrects Sonarr calendar bucketing and fetch boundaries in the viewer's timezone (#755, #759, #761, #763). |
| `2.24.0` | **Safer cleanup & resilient automation** — Adds episode-scoped Sonarr cleanup and tighter shared-library deletion checks. TRaSH deployments and auto-sync recover from interrupted runs and refuse stale or unverified data. Also fixes Plex cache refreshes, OIDC linking, qUI webhooks, Seerr routing, PostgreSQL upgrades, vulnerable dependencies, and provider-cache memory (#629, #661, #685, #693, #718, #721, #743, #745, #747–#750). |
| `2.23.0` | **Torrent payload safeguards** — Adds an opt-in Queue Cleaner torrent file-extension allowlist inspected through qui. Mixed torrents containing any unexpected file are removed in full through Sonarr or Radarr when existing safety gates permit cleanup; unavailable manifest metadata fails closed and is retried later (#565, #612). Updates PostCSS to 8.5.20 to resolve GHSA-6g55-p6wh-862q (#611). |
| `2.22.0` | **Authenticated services & hardened maintenance** — Adds optional encrypted HTTP Basic Auth for service instances behind authenticated reverse proxies (#600), restores new-library notifications for between-poll imports (#601, #543), supports Sonarr flat ratings in Library Cleanup (#604), refreshes production/development dependencies and GitHub Actions, restores a zero-diagnostic quality baseline, and pins third-party actions with dependency release-age and provenance policies (#547, #582, #583, #597, #598, #603, #605). |
| `2.21.0` | **Media-only storage & auth resilience** — Storage rollup filters to disks holding configured *arr root folders (container `/` and config volumes no longer inflate the total) with an expandable per-disk breakdown panel explaining every include/exclude decision; shape-agnostic across containerized, bare-metal Linux, and Windows-native *arrs (#504, #505, closes #495). Removes the five global gates that silently disabled password/passkey auth when an OIDC provider was enabled — a wrong redirect URI can no longer lock you out (#501, closes #498). Tolerates Tautulli's sparse `get_metadata` responses for deleted Plex items, ending the Dashboard/Pulse warning flood (#502, closes #497). `hono` override → 4.12.21 closing CVE-2026-47673…47676 (#503). Dependency sweeps (#499, #500). |
| `2.20.0` | **qui integration release** — federates with [autobrr/qui](https://github.com/autobrr/qui) for torrent-layer observability: per-card torrent health, tracker icons, server-side torrent-state filter, 480px detail drawer with capability-aware actions, MediaInfo quality verification, season-grouped torrent panels on series/movies, qui home page, qui Activity tab + webhook receiver, queue-cleaner last-seed protection (#475). Cross-seed reframed as an **integrity lens** keyed on tracker health (#492). Strips raw tracker passkeys from the qui trackers route (#493, closes #491) and the cross-seed display (#492). Storage Available card de-duplicates shared disks (#490, closes #486). Library Cleanup rejection memory (#482, closes #474). Hunting grab detection without `eventType` filter (#479, closes #472). `MALLOC_ARENA_MAX=2` container default + rss/heap ratio (#478). Query-string percent-encoding fix (#476, closes #470). Heap-monitor kill switch (#477, closes #471). CodeQL qui debug-endpoint env-gate (#485). |
| `2.19.0` | Continues the #427 OOM mitigation arc (stream-parse library-sync JSON, stream-fetch hunting catalog, slim wanted/movie/album/book records, adaptive concurrency on library-sync). Adds Seerr permission-aware `Test Connection` + inline Discover error surfacing (closes #465). Adds Schema Drift help tooltip + legend in Settings → System (closes #455). Adds TRaSH migration notices for upstream German/French unwanted-format group splits. Removes the legacy TRaSH NAMING fetcher whose dead-code path produced false-positive validation warnings on every cache refresh. Hunting scheduler reentrancy fix (#457). Dependency security bumps. New diagnostic tooling (heap retainer-walk, dump-heap helper, auto-snapshot at 90%) |
| `2.18.6` | Fixes Sonarr hunts being silently skipped when the queue contains stuck/import-waiting items (#438). Queue threshold now counts only items actively consuming download capacity. Distinguishes connectivity failures from healthy throttles (returned errors fire `HUNT_FAILED` notifications). Fail-safes on malformed queue responses. Inline message + tooltip in activity log |
| `2.18.5` | Comprehensive heap-pressure sweep closing out issue #427 — cursor-paginates remaining unbounded JSON-blob reads, reduces calendar/history transient peaks, caps sessionsJson analytics, rejects `/api/library?limit=0`. Adds heap-monitor plugin + opt-in `HEAP_AUTO_SNAPSHOT=1` for diagnostics. Fixes `last-watched` ordering bug |
| `2.18.4` | Seerr admin profile override on approval (#434) — pick non-default quality profile / root folder / server before approving a request. Plus backup OOM fix and broader memory sweep across cleanup, auto-tag, and history-table reads (#427 follow-up) |
| `2.18.3` | Patch release — notification URL resolution (#430), indexer readability (#428), Readarr/Lidarr sync memory reduction (#427) |
| `2.18.2` | Auto-Tagger: one-click Sonarr/Radarr Connect webhook auto-install (#423) — discover enabled instances and push the canonical webhook in a single click |
| `2.18.1` | Labels & tagging fixes: Radarr/Sonarr partial-PUT validator rejection (#418) + event-driven Label Sync triggers (#420) so rules fire seconds after a tag change |
| `2.18.0` | Auto-Tagger: criteria-based Sonarr/Radarr tagging with composite (AND/OR) rules, Connect webhooks, and TMDb/Trakt list-membership; library deep-link fix; TRaSH cache empty-result fix; Plex log-leak hardening |
| `2.17.0` | Statistics overhaul: Jellyfin/Emby tab + Plex tab decoupled from Tautulli (now optional enrichment); SessionSnapshot-derived leaderboards |
| `2.16.2` | Security patch — Fastify HIGH bypass + DOMPurify/hono/postcss fixes; workflow shell-injection closed; TRaSH migration notices |
| `2.16.1` | Reverse-proxy link resolution in Statistics / Calendar / History / Library; Calendar layout stability |
| `2.16.0` | Needs Attention, inline Pulse actions (Enable / Refresh now / Retry), media-server reachability, duplicate banner cleanup |
| `2.15.0` | Scheduler jobs surface, Security Posture, route governance, shared UX primitives, Plex/Tautulli cache hardening |
| `2.14.0` | Jellyfin & Emby integration, OAuth-assisted setup, notification quiet hours |
| `2.13.0` | Codebase hardening, TypeScript 6, security audit, CI optimization |
| `2.12.0` | Seerr Requests Experience, API stability, security sweep |
| `2.11.0` | System Pulse — unified health attention feed across all services |
| `2.10.1` | Quality filter fix |
| `2.10.0` | Library Intelligence, TRaSH scheduled sync, quality upgrades, grab detection |
| `2.9.3` | Lidarr stats fix (#209 follow-up), Claude Code tooling, GitHub templates |
| `2.9.2` | Bug fixes (#207 #208 #209), architecture improvements, 28 dependency updates |
| `2.9.1` | Security patches, complete incognito mode, TRaSH cloning improvements |
| `2.9.0` | Plex/Tautulli/Seerr integration, notifications, library cleanup, naming deployment |
| `2.8.5` | Bug fixes: queue cleaner, statistics, dropdowns, logging, Docker PostgreSQL |
| `2.8.0` | Full Lidarr & Readarr support + Queue Cleaner auto-import |
| `2.7.0` | Major stack upgrade (Node 22, Next.js 16, Prisma 7, Tailwind 4) |
| `2.5.0` | **Breaking:** Volume path changed to `/config` (LinuxServer.io convention) |

> **Upgrading from 2.4.x?** The volume mount path changed from `/app/data` to `/config`. See the [2.5.0 migration instructions](https://github.com/Kha-kis/arr-dashboard/blob/main/CHANGELOG.md#250---2025-10-01).

## First Time Setup

1. Open `http://your-server-ip:3000`
2. Create your admin account on first run
3. Add your Sonarr/Radarr/Prowlarr instances in Settings
4. Optionally connect Plex, Tautulli, and Seerr
5. Start managing your media!

## Volumes

| Path | Description |
|------|-------------|
| `/config` | Database, secrets, and backups (required) |

## Ports

| Port | Description |
|------|-------------|
| `3000` | Web UI |

## Security Hardening (Optional)

Using PUID/PGID:
```bash
docker run -d \
  --name arr-dashboard \
  --security-opt=no-new-privileges:true \
  --cap-drop=ALL \
  -p 3000:3000 \
  -v /path/to/config:/config \
  -e PUID=1000 \
  -e PGID=1000 \
  khak1s/arr-dashboard:latest
```

Using rootless mode (no root required):
```bash
docker run -d \
  --name arr-dashboard \
  --user 1000:1000 \
  -p 3000:3000 \
  -v /path/to/config:/config \
  khak1s/arr-dashboard:latest
```

## Troubleshooting

```bash
docker logs arr-dashboard
docker restart arr-dashboard
```

## Links

- **GitHub**: https://github.com/Kha-kis/arr-dashboard
- **Documentation**: https://github.com/Kha-kis/arr-dashboard/wiki
- **Issues**: https://github.com/Kha-kis/arr-dashboard/issues

## Support

For issues and feature requests, please use the [GitHub Issues](https://github.com/Kha-kis/arr-dashboard/issues) page.
