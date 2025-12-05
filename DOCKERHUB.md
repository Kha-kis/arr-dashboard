# Arr Dashboard

> **Version 2.5.0** - Now with LinuxServer.io-style `/config` volume

A unified dashboard for managing multiple Sonarr, Radarr, and Prowlarr instances. Consolidate your media automation management into a single, secure, and powerful interface.

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

- **Unified Dashboard** - View queue, calendar, and history across all Sonarr/Radarr instances
- **Global Search** - Search for content across all your indexers simultaneously
- **Library Management** - Manage your movies and TV shows in one place
- **TMDB Integration** - Discover trending, popular, and upcoming content
- **TRaSH Guides Integration** - Apply quality profiles and custom formats with auto-sync
- **Multi-Auth Support** - Password, OIDC (Authelia/Authentik), or Passkeys (WebAuthn)
- **Encrypted Storage** - All API keys encrypted at rest (AES-256-GCM)
- **Incognito Mode** - Hide sensitive media titles for screenshots/demos
- **Backup & Restore** - Encrypted backups for easy migration

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PUID` | `911` | User ID for file permissions |
| `PGID` | `911` | Group ID for file permissions |
| `DATABASE_URL` | `file:/config/prod.db` | Database connection string |
| `SESSION_TTL_HOURS` | `24` | Session expiration time |
| `API_RATE_LIMIT_MAX` | `200` | Max requests per minute |

> **Note:** Set `PUID` and `PGID` to match the owner of your config directory. Run `id -u` and `id -g` on your host to find your user/group IDs. This follows the [LinuxServer.io](https://docs.linuxserver.io/general/understanding-puid-and-pgid) convention.

## Version Tags

| Tag | Description |
|-----|-------------|
| `latest` | Latest stable release |
| `2.5.0` | **Breaking:** Volume path changed to `/config` (LinuxServer.io convention) |
| `2.4.x` | TRaSH Guides integration, PUID/PGID support (uses `/app/data`) |

> ⚠️ **Upgrading from 2.4.x?** The volume mount path changed from `/app/data` to `/config`. See [migration instructions](https://github.com/Kha-kis/arr-dashboard/blob/main/RELEASE_NOTES.md).

## First Time Setup

1. Open `http://your-server-ip:3000`
2. Create your admin account on first run
3. Add your Sonarr/Radarr/Prowlarr instances in Settings
4. (Optional) Add TMDB API key for Discover page
5. Start managing your media!

## Volumes

| Path | Description |
|------|-------------|
| `/config` | Database and secrets storage (required) |

## Ports

| Port | Description |
|------|-------------|
| `3000` | Web UI |

## Security Hardening (Optional)

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

## Links

- **GitHub**: https://github.com/Kha-kis/arr-dashboard
- **Documentation**: https://github.com/Kha-kis/arr-dashboard#readme
- **Issues**: https://github.com/Kha-kis/arr-dashboard/issues

## Support

For issues and feature requests, please use the [GitHub Issues](https://github.com/Kha-kis/arr-dashboard/issues) page.
