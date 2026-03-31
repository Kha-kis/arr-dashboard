# Docker Deployment

This directory contains files for building and deploying Arr Dashboard as a single container.

## Container Architecture

API and Web run together in one container for simple deployment:
- **Simpler deployment** — One container to manage
- **Easier networking** — No container linking needed
- **Lower overhead** — Shared resources and dependencies

## Files

| File | Purpose |
|------|---------|
| `start-combined.sh` | Container entrypoint — PUID/PGID setup, database detection, Prisma provider switching, service startup |
| `validate-runtime.sh` | CI validation script — checks all required files exist in the built image |
| `read-base-path.cjs` | Reads system settings (ports, listen address) from database at startup |

## Running the Container

### Docker Run

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

```bash
docker-compose up -d
```

## Database Configuration

### SQLite (Default)

No configuration needed. Database stored at `/config/prod.db`:

```bash
docker run -d \
  --name arr-dashboard \
  -p 3000:3000 \
  -v /path/to/config:/config \
  khak1s/arr-dashboard:latest
```

### PostgreSQL

Set `DATABASE_URL` to a PostgreSQL connection string. The container automatically detects the provider and regenerates the Prisma client:

```bash
docker run -d \
  --name arr-dashboard \
  -p 3000:3000 \
  -v /path/to/config:/config \
  -e DATABASE_URL=postgresql://user:password@db-host:5432/arr_dashboard \
  khak1s/arr-dashboard:latest
```

Both `postgresql://` and `postgres://` URL schemes are supported.

## Environment Variables

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PUID` | `911` | User ID for file permissions |
| `PGID` | `911` | Group ID for file permissions |
| `DATABASE_URL` | `file:/config/prod.db` | Database connection (SQLite path or PostgreSQL URL) |
| `PORT` | `3000` | Web server port |
| `API_PORT` | `3001` | API server port (internal) |
| `HOST` | `0.0.0.0` | Listen address |

### Session & Security

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_TTL_HOURS` | `24` | Session expiration (1-720 hours) |
| `SESSION_COOKIE_NAME` | `arr_session` | Session cookie name |
| `SESSION_COOKIE_SECRET` | Auto-generated | Cookie signing secret (saved to `/config/secrets.json`) |
| `ENCRYPTION_KEY` | Auto-generated | AES-256-GCM key for API key encryption (saved to `/config/secrets.json`) |
| `TRUST_PROXY` | `false` | Set `true` when behind a reverse proxy (enables X-Forwarded-* headers) |
| `COOKIE_SECURE` | Auto-detected | Force secure cookies (`true`/`false`/`auto`). Auto detects HTTPS |

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `API_RATE_LIMIT_MAX` | `200` | Max requests per minute |

### WebAuthn / Passkeys

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBAUTHN_RP_NAME` | `Arr Dashboard` | Display name shown during passkey registration |
| `WEBAUTHN_RP_ID` | `localhost` | Your domain (no protocol, e.g., `dashboard.example.com`) |
| `WEBAUTHN_ORIGIN` | `http://localhost:3000` | Full URL with protocol |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `LOG_DIR` | `/config/logs` | Log file directory |
| `LOG_MAX_SIZE` | `10m` | Max log file size before rotation |
| `LOG_MAX_FILES` | `5` | Number of rotated log files to keep |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | — | GitHub token for TRaSH Guides (higher rate limits) |
| `APP_URL` | — | Public URL for OIDC callback (e.g., `https://dashboard.example.com`) |

## Ports

- **3000** — Web UI (required)
- **3001** — API (internal, only expose for direct API access)

## Volumes

- `/config` — Database, secrets, logs, and backups

## Health Check

Built-in health check at `/health` (unauthenticated):

- **Docker HEALTHCHECK**: `http://localhost:3000/health` (runs every 30s)
- **External monitoring**: `http://<host>:3000/health`

Returns: `{ "status": "ok", "version": "X.Y.Z", "commit": "..." }`

## Building

From the repository root:

```bash
docker build -t arr-dashboard:latest .
```

### Multi-Platform

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t khak1s/arr-dashboard:latest \
  --push \
  .
```

## Troubleshooting

```bash
# View logs
docker logs arr-dashboard

# Access shell
docker exec -it arr-dashboard sh

# Check health
curl http://localhost:3000/health
```
