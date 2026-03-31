# Arr Dashboard

> **Version 2.13.0** — Codebase hardening, TypeScript 6, security audit, CI optimization

A unified dashboard for managing multiple **Sonarr**, **Radarr**, **Prowlarr**, **Lidarr**, **Readarr**, **Plex**, **Tautulli**, and **Seerr** instances. Consolidate your media automation management into a single, secure, and powerful interface.

[![CI](https://github.com/Kha-kis/arr-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/Kha-kis/arr-dashboard/actions/workflows/ci.yml)
[![Dev Build](https://github.com/Kha-kis/arr-dashboard/actions/workflows/docker-dev.yml/badge.svg)](https://github.com/Kha-kis/arr-dashboard/actions/workflows/docker-dev.yml)
[![Docker Pulls](https://img.shields.io/docker/pulls/khak1s/arr-dashboard)](https://hub.docker.com/r/khak1s/arr-dashboard)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Screenshots

<details>
<summary>Click to expand screenshots</summary>

### Dashboard
![Dashboard](docs/screenshots/screenshot-dashboard.png)

### Library
![Library](docs/screenshots/screenshot-library.png)

### Calendar
![Calendar](docs/screenshots/screenshot-calendar.png)

### Discover
![Discover](docs/screenshots/screenshot-discover.png)

### Search
![Search](docs/screenshots/screenshot-search.png)

### Indexers
![Indexers](docs/screenshots/screenshot-indexers.png)

### History
![History](docs/screenshots/screenshot-history.png)

### Statistics
![Statistics](docs/screenshots/screenshot-statistics.png)

### Requests
![Requests](docs/screenshots/screenshot-requests-all.png)

### Hunting
![Hunting](docs/screenshots/screenshot-hunting.png)

### Queue Cleaner
![Queue Cleaner](docs/screenshots/screenshot-queue-cleaner.png)

### Library Cleanup
![Library Cleanup](docs/screenshots/screenshot-library-cleanup.png)

### TRaSH Guides
![TRaSH Guides](docs/screenshots/screenshot-trash-guides.png)

### Plex Statistics
![Plex Statistics](docs/screenshots/screenshot-statistics-plex.png)

### Settings
![Settings](docs/screenshots/screenshot-settings.png)

</details>

## Features

### Unified Dashboard
- **Multi-Instance Aggregation** — View queue, calendar, history, and statistics across all Sonarr, Radarr, Prowlarr, Lidarr, and Readarr instances from a single view
- **Global Search** — Search for content across all your indexers simultaneously via Prowlarr
- **Library Management** — Browse, filter, and manage your movies, TV shows, music, and books in one place
- **Calendar View** — See upcoming releases across all instances with poster art and external links
- **History Tracking** — Download and import history from all services with timeline and table views

### Plex & Tautulli Integration
- **Now Playing** — Real-time view of active Plex streams with user avatars, progress bars, transcode/direct play indicators, and bandwidth metrics
- **Continue Watching / On Deck** — See what's queued up next across your Plex libraries
- **Recently Added** — Latest additions to your Plex library with poster thumbnails
- **Watch History** — Historical watch data enriched with Tautulli analytics
- **Plex Statistics** — Dedicated stats tab with user analytics, device breakdown, codec distribution, bandwidth forecasting, quality scores, and daily activity charts
- **Library Enrichment** — Watch status, play counts, and last-watched dates shown on library items

### Seerr Integration
- **Request Management** — View, approve, and decline media requests directly from the dashboard
- **User Management** — Browse users with request counts, quotas, and permissions
- **Issue Tracking** — View and manage reported media issues
- **Notification Agents** — Configure Seerr notification agents from the dashboard

### Content Discovery
- **TMDB Integration** — Discover trending, popular, and upcoming content
- **One-Click Add** — Add discovered content to any Radarr/Sonarr instance
- **Seerr Availability** — See request status and availability on the Discover page

### TRaSH Guides Integration
- **Quality Profiles** — Apply TRaSH Guides quality profiles to your instances with guided wizard
- **Custom Formats** — Sync custom formats with recommended scores from TRaSH score sets
- **Profile Cloning** — Clone quality profiles from running instances with automatic TRaSH profile linking for ongoing score updates
- **Templates** — Create reusable configuration templates with instance-specific overrides
- **Naming Schemes** — Deploy TRaSH-recommended naming schemes for Radarr and Sonarr
- **Auto-Sync** — Keep configurations up-to-date with TRaSH Guides changes
- **Deployment Preview** — Preview changes before applying, with backup and rollback support
- **Profile Groups** — Profiles organized by category (Standard, Anime, French, German, SQP)

### Notification System
- **8 Channels** — Discord, Telegram, Email (SMTP), Pushover, Gotify, Ntfy, Pushbullet, and Browser Push (Web Push API)
- **Event Subscriptions** — Per-channel subscription grid for 12+ event types
- **Rich Metadata** — Contextual details in every notification (instance names, affected items, durations)
- **Delivery Logs** — Searchable history of all dispatched notifications with delivery status

### Library Cleanup
- **Rule-Based Engine** — Define cleanup rules using 20+ condition types: age, size, rating, genre, tag, quality, watched status (Plex/Tautulli), request status (Seerr), and more
- **Approval Queue** — Dry-run evaluation presents candidates for human review before deletion
- **Scheduled Execution** — Automated runs with configurable intervals
- **Audit Logging** — Complete history of cleanup actions with item details and rule matches

### Automated Hunting
- **Missing Content Search** — Automatically search for missing movies, episodes, albums, and books
- **Quality Upgrades** — Find better quality versions of existing content
- **Per-Instance Config** — Enable/disable and configure search intervals, batch sizes, and filters per instance
- **Rate Limiting** — Configurable hourly API caps to prevent abuse
- **Activity Logging** — Track all automated search activity with detailed history

### Queue Cleaner
- **Automated Queue Management** — Remove stalled, slow, or problematic downloads based on configurable rules
- **Strike System** — Warn items before removal with configurable strike thresholds
- **Dry Run Mode** — Preview what would be cleaned without making changes
- **Auto-Import** — Automatically import completed downloads that are stuck in queue

### Security & Authentication
- **Multi-Auth Support** — Password, OIDC (Authelia/Authentik/Keycloak), or Passkeys (WebAuthn)
- **Encrypted Storage** — All API keys encrypted at rest (AES-256-GCM)
- **Session Management** — Secure HTTP-only cookie sessions with multi-device support
- **Incognito Mode** — Hide sensitive data (media titles, usernames, server names, URLs) across the entire UI — disguises everything as Linux ISO downloads for safe screenshotting
- **Zero-Config Security** — Auto-generated encryption keys on first run

### Management
- **Backup & Restore** — Automated encrypted backups with configurable retention and scheduling
- **Tag Organization** — Organize instances with custom tags and storage groups
- **Multi-Instance** — Manage unlimited instances across all supported services
- **System Settings** — Configurable ports, listen address, and application restart from the UI

## Quick Start

### Docker (Recommended)

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

Then start:

```bash
docker-compose up -d
```

### First Time Setup

1. Open `http://your-server-ip:3000`
2. Create your admin account on first run
3. Add your Sonarr/Radarr/Prowlarr instances in Settings
4. Optionally connect Plex, Tautulli, and Seerr
5. Start managing your media!

## Supported Services

| Service | Support | Features |
|---------|---------|----------|
| **Sonarr** | Full | Queue, calendar, library, history, statistics, hunting, cleanup |
| **Radarr** | Full | Queue, calendar, library, history, statistics, hunting, cleanup |
| **Prowlarr** | Full | Indexer management, global search |
| **Lidarr** | Full | Queue, calendar, library, history, statistics, hunting |
| **Readarr** | Full | Queue, calendar, library, history, statistics, hunting |
| **Plex** | Full | Now playing, on deck, recently added, watch history, library enrichment |
| **Tautulli** | Full | Activity monitoring, watch statistics, bandwidth analytics |
| **Seerr** | Full | Requests, users, issues, notification agents |

## Version Tags

| Tag | Description |
|-----|-------------|
| `latest` | Latest stable release |
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
| `2.8.4` | Harden quality definition reset with multi-strategy fallback |
| `2.8.3` | TRaSH Guides PR #2590 compatibility (include semantics + quality ordering) |
| `2.8.2` | Hotfix for Docker startup crash in v2.8.1 |
| `2.8.1` | Security hardening, quality size presets & deep refactoring |
| `2.8.0` | Full Lidarr & Readarr support + Queue Cleaner auto-import |
| `2.7.4` | Configurable password policy for passphrase support |
| `2.7.3` | Queue Cleaner, Prefer Season Packs & improved error handling |
| `2.7.2` | Custom upstream repos, user custom formats & bug fixes |
| `2.7.1` | TRaSH template persistence fix + Next.js security patch |
| `2.7.0` | Major stack upgrade (Node 22, Next.js 16, Prisma 7, Tailwind 4) |
| `2.5.0` | **Breaking:** Volume path changed to `/config` (LinuxServer.io convention) |

> **Upgrading from 2.4.x?** See [RELEASE_NOTES.md](RELEASE_NOTES.md) for migration instructions. The volume mount path changed from `/app/data` to `/config`.

## Configuration

### Zero Configuration Required

The application auto-generates all necessary security keys on first run. No environment variables needed for basic operation.

### Config Volume Contents

The `/config` volume contains critical data that must be preserved:

| File | Purpose |
|------|---------|
| `prod.db` | SQLite database with all your settings, users, and configurations |
| `secrets.json` | Auto-generated encryption keys for API credentials |
| `backups/` | Automated database backups (when enabled) |

> **Important:** If `secrets.json` is lost, encrypted API keys cannot be decrypted. You would need to re-enter all service API keys. Always preserve your entire `/config` volume when upgrading or migrating.

### Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PUID` | `911` | User ID for file permissions (LinuxServer.io style) |
| `PGID` | `911` | Group ID for file permissions (LinuxServer.io style) |
| `DATABASE_URL` | `file:/config/prod.db` | Database connection string (SQLite or PostgreSQL) |
| `SESSION_TTL_HOURS` | `24` | Session expiration time in hours |
| `SESSION_COOKIE_NAME` | `arr_session` | Name of the session cookie |
| `PASSWORD_POLICY` | `strict` | `strict` (uppercase, lowercase, number, special char) or `relaxed` (8+ chars, passphrase-friendly) |
| `API_RATE_LIMIT_MAX` | `200` | Max requests per minute |
| `API_CORS_ORIGIN` | `localhost:3000,3001` | Allowed CORS origins (comma-separated) |
| `BACKUP_PASSWORD` | - | Password for encrypted backups (optional) |
| `WEBAUTHN_RP_NAME` | `Arr Dashboard` | Passkey display name |
| `WEBAUTHN_RP_ID` | `localhost` | Passkey relying party ID (your domain, no protocol) |
| `WEBAUTHN_ORIGIN` | `http://localhost:3000` | Passkey origin URL (full URL with protocol) |
| `LOG_LEVEL` | `info` | Logging level (`debug`, `info`, `warn`, `error`) |
| `GITHUB_TOKEN` | - | Optional GitHub token for TRaSH Guides (higher rate limits) |

> **Note:** Set `PUID` and `PGID` to match the owner of your config directory. Run `id -u` and `id -g` on your host to find your user/group IDs. This follows the [LinuxServer.io](https://docs.linuxserver.io/general/understanding-puid-and-pgid) convention.

## Platform Support

### Unraid

Community Applications template available. See the [wiki](https://github.com/Kha-kis/arr-dashboard/wiki/Unraid-Deployment) for detailed instructions.

### Synology/QNAP

Use Docker Compose method with appropriate volume paths.

### PostgreSQL Database

By default, Arr Dashboard uses SQLite stored at `/config/prod.db`. For larger deployments:

```bash
docker run -d \
  --name arr-dashboard \
  -p 3000:3000 \
  -v /path/to/config:/config \
  -e DATABASE_URL="postgresql://user:password@hostname:5432/arr_dashboard" \
  khak1s/arr-dashboard:latest
```

The schema is automatically synchronized on startup. You can switch between SQLite and PostgreSQL at any time — create a backup first (Settings → Backup).

## Architecture

```
arr-dashboard/
├── apps/
│   ├── api/          # Fastify 4 API server (port 3001)
│   └── web/          # Next.js 16 frontend (port 3000)
├── packages/
│   └── shared/       # Shared Zod schemas & TypeScript types
└── docker/
    └── start-combined.sh  # Single-container startup
```

### Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16 (App Router), React 18, TailwindCSS 4, Tanstack Query |
| Backend | Fastify 4, Prisma 7 |
| Database | SQLite (default), PostgreSQL |
| Auth | Session-based with Argon2id password hashing |
| Encryption | AES-256-GCM for secrets at rest |
| Validation | Zod schemas (shared between frontend/backend) |
| Build | Turbo, pnpm 10+ workspaces |
| Runtime | Node.js 22+ |

## Development

### Prerequisites

- Node.js 22+
- pnpm 10+

### Setup

```bash
git clone https://github.com/Kha-kis/arr-dashboard.git
cd arr-dashboard
pnpm install
pnpm run dev
```

The API runs at `http://localhost:3001` and the web app at `http://localhost:3000`.

### Building from Source

```bash
pnpm run build
docker build -t arr-dashboard:local .
```

### Database Commands

```bash
cd apps/api
pnpm run db:push      # Sync schema to database
pnpm run db:generate  # Regenerate Prisma client
```

## Security

### Best Practices

1. **Use HTTPS** — Set up a reverse proxy (nginx, Caddy, Traefik) with TLS
2. **Keep Private** — Don't expose *arr instances directly to the internet
3. **Regular Backups** — Use the built-in encrypted backup feature
4. **Strong Passwords** — Use unique, strong passwords for all services
5. **Keep Updated** — Pull latest Docker images regularly

### Docker Security Hardening (Optional)

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

### Reverse Proxy Example (nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name dashboard.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Updating

```bash
docker-compose pull
docker-compose up -d
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Port in use | Change port mapping: `-p 8080:3000` |
| Database locked | Ensure only one instance is running |
| Connection refused | Check container logs: `docker logs arr-dashboard` |
| Login issues | Reset password: `pnpm run reset-admin-password` |
| Blank page after update | Clear browser cache or hard refresh |

### Getting Help

1. Check container logs: `docker logs arr-dashboard`
2. Review [existing issues](https://github.com/Kha-kis/arr-dashboard/issues)
3. Open a new issue with your version number, deployment method, and error messages

## Documentation

**[Full Documentation Wiki](https://github.com/Kha-kis/arr-dashboard/wiki)**

| Guide | Description |
|-------|-------------|
| [Quick Start](https://github.com/Kha-kis/arr-dashboard/wiki/Quick-Start) | 5-minute installation guide |
| [Dashboard](https://github.com/Kha-kis/arr-dashboard/wiki/Dashboard) | Queue, statistics, Plex widgets, activity |
| [Library & Search](https://github.com/Kha-kis/arr-dashboard/wiki/Library-and-Search) | Browse library, search indexers, manage content |
| [Calendar & History](https://github.com/Kha-kis/arr-dashboard/wiki/Calendar-and-History) | Upcoming releases and download history |
| [Statistics](https://github.com/Kha-kis/arr-dashboard/wiki/Statistics) | Aggregated health and library metrics |
| [Discover](https://github.com/Kha-kis/arr-dashboard/wiki/Discover) | TMDB trending, popular, and upcoming content |
| [Plex & Tautulli](https://github.com/Kha-kis/arr-dashboard/wiki/Plex-and-Tautulli-Integration) | Now playing, analytics, watch history |
| [Seerr](https://github.com/Kha-kis/arr-dashboard/wiki/Seerr-Integration) | Request management and approval |
| [Notifications](https://github.com/Kha-kis/arr-dashboard/wiki/Notification-System) | Discord, Telegram, Email, and 5 more channels |
| [Library Cleanup](https://github.com/Kha-kis/arr-dashboard/wiki/Library-Cleanup) | Rule-based cleanup with approval workflow |
| [Queue Cleaner](https://github.com/Kha-kis/arr-dashboard/wiki/Queue-Cleaner) | Automated queue management |
| [TRaSH Guides](https://github.com/Kha-kis/arr-dashboard/wiki/TRaSH-Guides-Integration) | Quality profiles, custom formats, naming schemes |
| [Naming Schemes](https://github.com/Kha-kis/arr-dashboard/wiki/Naming-Scheme-Deployment) | TRaSH naming convention deployment |
| [Hunting](https://github.com/Kha-kis/arr-dashboard/wiki/Hunting-Auto-Search) | Automated content search |
| [Lidarr & Readarr](https://github.com/Kha-kis/arr-dashboard/wiki/Lidarr-and-Readarr-Support) | Music and book management |
| [Settings](https://github.com/Kha-kis/arr-dashboard/wiki/Settings) | Services, auth, appearance, system config |
| [Authentication](https://github.com/Kha-kis/arr-dashboard/wiki/Authentication-Guide) | Password, OIDC, and Passkey setup |
| [Security Best Practices](https://github.com/Kha-kis/arr-dashboard/wiki/Security-Best-Practices) | Hardening and deployment recommendations |
| [Incognito Mode](https://github.com/Kha-kis/arr-dashboard/wiki/Incognito-Mode) | Hide sensitive data for screenshots |
| [Environment Variables](https://github.com/Kha-kis/arr-dashboard/wiki/Environment-Variables) | Complete configuration reference |
| [Backup & Restore](https://github.com/Kha-kis/arr-dashboard/wiki/Backup-and-Restore) | Encrypted backup system |
| [Unraid Deployment](https://github.com/Kha-kis/arr-dashboard/wiki/Unraid-Deployment) | Unraid-specific instructions |
| [Troubleshooting](https://github.com/Kha-kis/arr-dashboard/wiki/Troubleshooting) | Common issues and solutions |
| [FAQ](https://github.com/Kha-kis/arr-dashboard/wiki/FAQ) | Frequently asked questions |

**For Contributors:** See [CLAUDE.md](CLAUDE.md) for technical architecture and development guide.

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [Sonarr](https://sonarr.tv/) / [Radarr](https://radarr.video/) / [Prowlarr](https://prowlarr.com/) / [Lidarr](https://lidarr.audio/) / [Readarr](https://readarr.com/) — The *arr stack
- [Plex](https://www.plex.tv/) / [Tautulli](https://tautulli.com/) — Media server analytics
- [Seerr](https://github.com/Fallenbagel/jellyseerr) — Media request management
- [TRaSH Guides](https://trash-guides.info/) — Quality profile recommendations
- [TMDB](https://www.themoviedb.org/) — Movie and TV show metadata

---

**Made with love for the self-hosted community**
