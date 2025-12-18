# Arr Dashboard

> **Version 2.6.5** - Fix permission errors on Unraid/PostgreSQL, System Information display, improved session handling

A unified dashboard for managing multiple Sonarr, Radarr, and Prowlarr instances. Consolidate your media automation management into a single, secure, and powerful interface.

[![CI](https://github.com/Kha-kis/arr-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/Kha-kis/arr-dashboard/actions/workflows/ci.yml)
[![Dev Build](https://github.com/Kha-kis/arr-dashboard/actions/workflows/docker-dev.yml/badge.svg)](https://github.com/Kha-kis/arr-dashboard/actions/workflows/docker-dev.yml)
[![Docker Pulls](https://img.shields.io/docker/pulls/khak1s/arr-dashboard)](https://hub.docker.com/r/khak1s/arr-dashboard)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Screenshots

<details>
<summary>Click to expand screenshots</summary>

### Dashboard
![Dashboard](https://github.com/user-attachments/assets/fbbbaccc-b9e3-4120-8a02-86894574e27f)

### Library
![Library](https://github.com/user-attachments/assets/6da80d26-5539-4bb4-b531-aa05843eaf0d)

### Calendar
![Calendar](https://github.com/user-attachments/assets/70816679-d696-4adf-ab69-a1233a4465b3)

### Discover
![Discover](https://github.com/user-attachments/assets/09ca830c-6ce3-4891-8de7-e439adb2dbc4)

### Search
![Search](https://github.com/user-attachments/assets/13e3426d-4f61-48fa-995d-71d000d16373)

### Indexers
![Indexers](https://github.com/user-attachments/assets/48be82e1-493f-4b45-abae-ceafe7adcb57)

### History
![History](https://github.com/user-attachments/assets/4db1599c-2933-4680-b384-37ff997709ae)

### Statistics
![Statistics](https://github.com/user-attachments/assets/164dd3b7-8c3b-458e-82eb-82125b89e55e)

### TRaSH Guides
![TRaSH Guides](https://github.com/user-attachments/assets/9ef10da0-7ac6-4d07-8d7a-90b52285abb3)

### Settings
![Settings](https://github.com/user-attachments/assets/11e1dbfd-3e43-4990-8a8a-057a4e6037eb)

</details>

## Features

### Core Features
- **Unified Dashboard** - View queue, calendar, and history across all Sonarr/Radarr instances
- **Global Search** - Search for content across all your indexers simultaneously
- **Library Management** - Manage your movies and TV shows in one place
- **Statistics & Health** - View aggregated statistics and monitor instance health
- **Calendar View** - See upcoming releases across all instances
- **History Tracking** - View download and import history from all services

### Content Discovery
- **TMDB Integration** - Discover trending, popular, and upcoming content
- **One-Click Add** - Add discovered content to any Radarr/Sonarr instance
- **Search Integration** - Search TMDB directly and add results to your library

### TRaSH Guides Integration (New!)
- **Quality Profiles** - Apply TRaSH Guides quality profiles to your instances
- **Custom Formats** - Sync custom formats with recommended scores
- **Templates** - Create reusable configuration templates
- **Auto-Sync** - Keep your configurations up-to-date with TRaSH Guides
- **Deployment Preview** - Preview changes before applying to instances
- **Conflict Resolution** - Smart handling of configuration conflicts
- **Backup & Rollback** - Automatic backups before changes with rollback support

### Security & Authentication
- **Multi-Auth Support** - Password, OIDC (Authelia/Authentik), or Passkeys (WebAuthn)
- **Encrypted Storage** - All API keys encrypted at rest (AES-256-GCM)
- **Session Management** - Secure HTTP-only cookie sessions
- **Rate Limiting** - Built-in protection against abuse
- **Zero-Config Security** - Auto-generated encryption keys
- **Incognito Mode** - Hide sensitive media titles for screenshots/demos (disguises as Linux ISOs)

### Automated Hunting
- **Missing Content Search** - Automatically search for missing movies and episodes
- **Quality Upgrades** - Find better quality versions of existing content
- **Scheduler Control** - Enable/disable and configure search intervals per instance
- **Advanced Filters** - Filter by quality profiles, tags, monitored status, and age
- **Rate Limiting** - Configurable hourly API caps to prevent abuse
- **Activity Logging** - Track all automated search activity with history

### Management
- **Tag Organization** - Organize instances with custom tags
- **Backup & Restore** - Encrypted backups for easy migration and disaster recovery
- **Multi-Instance** - Manage unlimited Sonarr, Radarr, and Prowlarr instances

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
4. Start managing your media!

## Version Tags

| Tag | Description |
|-----|-------------|
| `latest` | Latest stable release |
| `2.6.5` | Fix permission errors on Unraid/PostgreSQL, System Information display |
| `2.6.4` | Hotfix for upgrade crash loop affecting v2.6.3 |
| `2.6.3` | Backup encryption, TRaSH standalone deployment, security fixes |
| `2.6.2` | Fix Docker health check endpoint |
| `2.5.0` | ⚠️ **Breaking:** Volume path changed to `/config` (LinuxServer.io convention) |
| `2.4.3` | Favicon, README screenshots |
| `2.4.x` | TRaSH Guides integration, PUID/PGID support |
| `2.3.x` | Stability improvements and bug fixes |
| `2.2.x` | OIDC and Passkey authentication |

> ⚠️ **Upgrading from 2.4.x?** See [RELEASE_NOTES.md](RELEASE_NOTES.md) for migration instructions. The volume mount path changed from `/app/data` to `/config`.

## Configuration

### Zero Configuration Required

The application auto-generates all necessary security keys on first run. No environment variables needed for basic operation.

### Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PUID` | `911` | User ID for file permissions (LinuxServer.io style) |
| `PGID` | `911` | Group ID for file permissions (LinuxServer.io style) |
| `DATABASE_URL` | `file:/config/prod.db` | Database connection string (SQLite or PostgreSQL) |
| `SESSION_TTL_HOURS` | `24` | Session expiration time in hours |
| `SESSION_COOKIE_NAME` | `arr_session` | Name of the session cookie |
| `API_RATE_LIMIT_MAX` | `200` | Max requests per minute |
| `API_RATE_LIMIT_WINDOW` | `1 minute` | Rate limit time window |
| `API_CORS_ORIGIN` | `localhost:3000,3001` | Allowed CORS origins (comma-separated) |
| `BACKUP_PASSWORD` | - | Password for encrypted backups (optional, auto-generated in dev) |
| `WEBAUTHN_RP_NAME` | `Arr Dashboard` | Passkey display name shown to users |
| `WEBAUTHN_RP_ID` | `localhost` | Passkey relying party ID (your domain, no protocol) |
| `WEBAUTHN_ORIGIN` | `http://localhost:3000` | Passkey origin URL (full URL with protocol) |
| `LOG_LEVEL` | `info` (prod) / `debug` (dev) | Logging level |
| `GITHUB_TOKEN` | - | Optional GitHub token for TRaSH Guides (higher rate limits) |

> **Note:** Set `PUID` and `PGID` to match the owner of your config directory. Run `id -u` and `id -g` on your host to find your user/group IDs. This follows the [LinuxServer.io](https://docs.linuxserver.io/general/understanding-puid-and-pgid) convention for consistent file permissions.

### User Settings (Web Interface)

Configure these in Settings after login:
- **TMDB API Key** - For Discover page trending/popular content
- **Service Instances** - Sonarr, Radarr, Prowlarr connections
- **Tags** - Organize and filter instances
- **TRaSH Guides Templates** - Quality profile configurations
- **Hunting Configuration** - Per-instance automated search settings
- **Backup Settings** - Automated backup schedules and retention

## Platform Support

### Unraid

Community Applications template available. See [Unraid Deployment](https://github.com/Kha-kis/arr-dashboard/wiki/Unraid-Deployment) for detailed instructions.

### Synology/QNAP

Use Docker Compose method with appropriate volume paths.

### Kubernetes

Helm charts coming soon. For now, use standard Kubernetes manifests with the Docker image.

### PostgreSQL Database

By default, Arr Dashboard uses SQLite stored at `/config/prod.db`. For larger deployments or those preferring PostgreSQL:

```bash
docker run -d \
  --name arr-dashboard \
  -p 3000:3000 \
  -v /path/to/config:/config \
  -e DATABASE_URL="postgresql://user:password@hostname:5432/arr_dashboard" \
  khak1s/arr-dashboard:latest
```

**Notes:**
- The database schema is automatically synchronized on startup
- You can switch between SQLite and PostgreSQL at any time
- When switching providers, create a backup first (Settings → Backup)
- PostgreSQL is recommended for multi-user or high-traffic scenarios

**Connection String Examples:**
```bash
# SQLite (default)
DATABASE_URL="file:/config/prod.db"

# PostgreSQL
DATABASE_URL="postgresql://user:password@localhost:5432/arr_dashboard"

# PostgreSQL with SSL
DATABASE_URL="postgresql://user:password@hostname:5432/arr_dashboard?sslmode=require"
```

## Architecture

```
arr-dashboard/
├── apps/
│   ├── api/          # Fastify API server
│   └── web/          # Next.js 14 frontend (App Router)
└── packages/
    └── shared/       # Shared TypeScript types and Zod schemas
```

### Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 14, React 18, TailwindCSS, Tanstack Query |
| Backend | Fastify 4, Prisma ORM |
| Database | SQLite (default), PostgreSQL |
| Auth | Session-based with Argon2id password hashing |
| Encryption | AES-256-GCM for secrets at rest |
| Validation | Zod schemas (shared between frontend/backend) |
| Build | Turbo, pnpm workspaces |

## Development

### Prerequisites

- Node.js 20+
- pnpm 9.12.0+

### Setup

```bash
# Clone the repository
git clone https://github.com/Kha-kis/arr-dashboard.git
cd arr-dashboard

# Install dependencies
pnpm install

# Start development servers
pnpm run dev
```

The API runs at `http://localhost:3001` and the web app at `http://localhost:3000`.

### Building from Source

```bash
# Build all packages
pnpm run build

# Build Docker image
docker build -t arr-dashboard:local .
```

### Database Commands

```bash
cd apps/api

# Sync schema to database (works for SQLite and PostgreSQL)
pnpm run db:push

# Regenerate Prisma client only
pnpm run db:generate
```

## Security

### Best Practices

1. **Use HTTPS** - Set up a reverse proxy (nginx, Caddy, Traefik) with TLS
2. **Keep Private** - Don't expose Sonarr/Radarr/Prowlarr directly to the internet
3. **Regular Backups** - Use the built-in encrypted backup feature
4. **Strong Passwords** - Use unique, strong passwords for all services
5. **Keep Updated** - Pull latest Docker images regularly

### Docker Security Hardening (Optional)

For additional security, you can run the container with these options:

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

| Option | Description |
|--------|-------------|
| `--security-opt=no-new-privileges:true` | Prevents privilege escalation inside container |
| `--cap-drop=ALL` | Drops all Linux capabilities (container runs with minimal permissions) |

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

### Docker

```bash
docker-compose pull
docker-compose up -d
```

### Manual Installation

```bash
git pull
pnpm install
cd apps/api && pnpm run db:push
cd ../.. && pnpm run build
```

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| Port in use | Change port mapping: `-p 8080:3000` |
| Database locked | Ensure only one instance is running |
| Connection refused | Check container logs: `docker logs arr-dashboard` |
| Login issues | Reset password: `pnpm run reset-admin-password` |

### Getting Help

1. Check container logs: `docker logs arr-dashboard`
2. Review [existing issues](https://github.com/Kha-kis/arr-dashboard/issues)
3. Open a new issue with:
   - Version number
   - Deployment method
   - Error messages
   - Steps to reproduce

## Documentation

📚 **[Full Documentation Wiki](https://github.com/Kha-kis/arr-dashboard/wiki)**

| Guide | Description |
|-------|-------------|
| [Quick Start](https://github.com/Kha-kis/arr-dashboard/wiki/Quick-Start) | 5-minute installation guide |
| [Authentication](https://github.com/Kha-kis/arr-dashboard/wiki/Authentication-Guide) | Password, OIDC, and Passkey setup |
| [Environment Variables](https://github.com/Kha-kis/arr-dashboard/wiki/Environment-Variables) | Complete configuration reference |
| [TRaSH Guides](https://github.com/Kha-kis/arr-dashboard/wiki/TRaSH-Guides-Integration) | Quality profiles and custom formats |
| [Hunting](https://github.com/Kha-kis/arr-dashboard/wiki/Hunting-Auto-Search) | Automated content search |
| [Backup & Restore](https://github.com/Kha-kis/arr-dashboard/wiki/Backup-and-Restore) | Encrypted backup system |
| [Unraid Deployment](https://github.com/Kha-kis/arr-dashboard/wiki/Unraid-Deployment) | Unraid-specific instructions |
| [Troubleshooting](https://github.com/Kha-kis/arr-dashboard/wiki/Troubleshooting) | Common issues and solutions |

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

- [Sonarr](https://sonarr.tv/) / [Radarr](https://radarr.video/) / [Prowlarr](https://prowlarr.com/) - The amazing *arr stack
- [TRaSH Guides](https://trash-guides.info/) - Quality profile recommendations
- [TMDB](https://www.themoviedb.org/) - Movie and TV show metadata

---

**Made with love for the self-hosted community**
