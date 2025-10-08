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

Or use the docker-compose file:

```bash
docker-compose -f docker-compose.combined.yml up -d --build
```

## Running the Container

### Using Docker Run

```bash
docker run -d \
  --name arr-dashboard \
  -p 3000:3000 \
  -v /path/to/data:/app/data \
  --restart unless-stopped \
  khak1s/arr-dashboard:latest
```

### Using Docker Compose

```bash
docker-compose up -d
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `file:/app/data/prod.db` | Database connection string |
| `API_PORT` | `3001` | API server port |
| `PORT` | `3000` | Web server port |
| `SESSION_TTL_HOURS` | `24` | Session expiration time |
| `API_RATE_LIMIT_MAX` | `200` | Max requests per minute |

## Ports

- **3000** - Web UI (required)
- **3001** - API (optional, only needed for direct API access)

## Volumes

- `/app/data` - Database and configuration files

## Health Check

The container includes a health check that monitors the web UI on port 3000.

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

See `/unraid/arr-dashboard.xml` for the Unraid Community Applications template.

To install manually in Unraid:
1. Go to Docker tab
2. Click "Add Container"
3. Fill in:
   - Name: `arr-dashboard`
   - Repository: `khak1s/arr-dashboard:latest`
   - Port: `3000` → `3000` (TCP)
   - Path: `/app/data` → `/mnt/user/appdata/arr-dashboard`
4. Click Apply

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
