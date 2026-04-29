# Arr Dashboard

> **Version 2.16.2** — Security patch: Fastify HIGH bypass + DOMPurify/hono/postcss vulnerabilities patched; GitHub Actions shell-injection vector closed; TRaSH Guides migration notices for upstream CF-group restructures

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

## Features

- **Unified Dashboard** — Queue, calendar, history, and statistics across all Sonarr, Radarr, Prowlarr, Lidarr, and Readarr instances
- **Plex & Tautulli Integration** — Now playing, watch history, on deck, recently added, and detailed analytics with user/device/codec charts
- **Jellyfin & Emby Integration** — Full media server parity with Plex, sourced directly from native APIs (no Tautulli-equivalent required)
- **Seerr** — Manage media requests, users, issues, and notification agents, with optional auto-setup via Plex sign-in
- **Global Search** — Search for content across all indexers via Prowlarr
- **TMDB Discovery** — Trending, popular, and upcoming content with one-click add
- **TRaSH Guides** — Quality profiles, custom formats, naming schemes with auto-sync and profile cloning
- **Notification System** — Discord, Telegram, Email, Pushover, Gotify, Ntfy, Pushbullet, Browser Push
- **Library Cleanup** — Rule-based cleanup with 20+ condition types, approval queue, and audit logging
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

> **Upgrading from 2.4.x?** The volume mount path changed from `/app/data` to `/config`. See [migration instructions](https://github.com/Kha-kis/arr-dashboard/blob/main/RELEASE_NOTES.md).

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
