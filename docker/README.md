# Docker Deployment

This directory contains files for building and deploying Arr Dashboard as a single container.

**Note:** The project uses a combined image approach - API and Web run together in one container for simplicity.

## Why Single Container?

- **Simpler deployment** - One container to manage
- **Unraid compatible** - Works great with Community Applications
- **Easier networking** - No container linking needed
- **Lower overhead** - Shared resources and dependencies

## Building the Image

From the repository root:

```bash
docker build -t arr-dashboard:latest .
```

Or use docker-compose:

```bash
docker-compose up -d --build
```

## Running the Container

### Using Docker Run

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

### Using Docker Compose

```bash
docker-compose up -d
```

## Database Configuration

### SQLite (Default)

SQLite is the default database — no additional configuration needed. The database file is stored in the `/config` volume:

```bash
docker run -d \
  --name arr-dashboard \
  -p 3000:3000 \
  -v /path/to/config:/config \
  khak1s/arr-dashboard:latest
```

### PostgreSQL

To use PostgreSQL, set the `DATABASE_URL` environment variable to a PostgreSQL connection string. The application automatically detects the database type from the URL — no other configuration is needed:

```bash
docker run -d \
  --name arr-dashboard \
  -p 3000:3000 \
  -v /path/to/config:/config \
  -e DATABASE_URL=postgresql://user:password@db-host:5432/arr_dashboard \
  khak1s/arr-dashboard:latest
```

Both `postgresql://` and `postgres://` URL schemes are supported. On first startup with a new PostgreSQL database, the schema is created automatically.

## Environment Variables

### Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PUID` | `911` | User ID for file permissions |
| `PGID` | `911` | Group ID for file permissions |
| `DATABASE_URL` | `file:/config/prod.db` | Database connection string (SQLite or PostgreSQL) |
| `API_PORT` | `3001` | API server port (internal) |
| `PORT` | `3000` | Web server port |

### Session & Security

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_TTL_HOURS` | `24` | Session expiration time in hours |
| `SESSION_COOKIE_NAME` | `arr_session` | Name of the session cookie |
| `API_RATE_LIMIT_MAX` | `200` | Max requests per minute |
| `BACKUP_PASSWORD` | Auto-generated | Password for encrypted backups |

### WebAuthn/Passkeys (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBAUTHN_RP_NAME` | `Arr Dashboard` | Display name shown to users |
| `WEBAUTHN_RP_ID` | `localhost` | Your domain (no protocol) |
| `WEBAUTHN_ORIGIN` | `http://localhost:3000` | Full URL with protocol |

### Advanced

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Logging level (debug, info, warn, error) |
| `GITHUB_TOKEN` | - | Optional GitHub token for TRaSH Guides (higher rate limits) |

## Ports

- **3000** - Web UI (required)
- **3001** - API (optional, only needed for direct API access)

## Volumes

- `/config` - Database and configuration files (LinuxServer.io convention)

## Health Check

The container includes a health check at `/health` that validates both the Next.js frontend and Fastify API are running. This endpoint is publicly accessible (no authentication required) and can be used with external monitoring tools like Uptime Kuma.

- **Docker HEALTHCHECK**: `http://localhost:3000/health` (built-in, runs every 30s)
- **Uptime Kuma / external**: `http://<host>:3000/health`

## Process Management

The combined container uses a lightweight shell script to manage both processes:
- **tini** - Proper signal handling and zombie reaping
- **Background processes** - API and Web run as separate processes
- **Graceful shutdown** - SIGTERM/SIGINT properly propagate to both services

## Troubleshooting

### Check Logs

```bash
docker logs arr-dashboard
```

### Check Process Status

```bash
docker exec arr-dashboard ps aux
```

### Restart Container

```bash
docker restart arr-dashboard
```

### Access Shell

```bash
docker exec -it arr-dashboard sh
```

## Unraid Deployment

Arr Dashboard is available in Unraid Community Applications. Search for "Arr Dashboard" in the Apps tab.

For manual installation or detailed instructions, see [UNRAID_DEPLOYMENT.md](../UNRAID_DEPLOYMENT.md).

## Building for Multiple Platforms

To build for both amd64 and arm64:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t khak1s/arr-dashboard:latest \
  --push \
  .
```

## Size Optimization

The combined image is optimized for size:
- Multi-stage build to exclude build dependencies
- Alpine Linux base (small footprint)
- Production-only dependencies in final stage
- Shared dependencies between API and Web

Expected image size: ~400-500MB
