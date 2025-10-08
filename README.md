# Arr Dashboard

> **⚠️ Version 2.0 - Complete Rewrite**
> This is a ground-up rewrite with modern architecture, zero-config Docker deployment, and improved features. Not compatible with v1.x.

A unified dashboard for managing multiple Sonarr, Radarr, and Prowlarr instances.

## Features

- 📊 **Unified Dashboard** - View queue, calendar, and history across all instances
- 🔍 **Global Search** - Search for content across all your indexers
- 📚 **Library Management** - Manage your movies and TV shows in one place
- 📈 **Statistics** - View aggregated statistics and health monitoring
- 🎬 **Discover** - Find new content with TMDB integration
- 🏷️ **Tag Management** - Organize instances with custom tags
- 🔒 **Secure** - Encrypted API keys, session management, and rate limiting

## Quick Start with Docker (Recommended)

### Prerequisites

- Docker and Docker Compose installed
- At least one Sonarr, Radarr, or Prowlarr instance

### Using Pre-built Images

Create a `docker-compose.yml` file:

```yaml
services:
  api:
    image: khak1s/arr-dashboard-api:latest
    container_name: arr-dashboard-api
    volumes:
      - ./data:/app/data
    ports:
      - 3001:3001
    restart: unless-stopped

  web:
    image: khak1s/arr-dashboard-web:latest
    container_name: arr-dashboard-web
    environment:
      - NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
    ports:
      - 3000:3000
    restart: unless-stopped
    depends_on:
      - api
```

Then start the containers:

```bash
docker-compose up -d
```

**Version Tags:**
- `latest` - Latest stable release
- `2.0.0` - Specific version (e.g., `khak1s/arr-dashboard-api:2.0.0`)

### Building from Source (Alternative)

If you prefer to build the images yourself:

```bash
# Clone the repository
git clone https://github.com/yourusername/arr-dashboard.git
cd arr-dashboard

# Build and start
docker-compose -f docker-compose.build.yml up -d
```

See [docker-compose.build.yml](docker-compose.build.yml) for the build configuration.

**Application Setup:**

1. Open `http://your-server-ip:3000`
2. Create your admin account
3. Add your Sonarr/Radarr/Prowlarr instances in Settings

> **Note**: The web UI automatically proxies API requests internally. No additional configuration needed!

**Parameters:**

| Parameter | Function |
|-----------|----------|
| `-p 3000:3000` | Web UI |
| `-p 3001:3001` | API |
| `-v ./data:/app/data` | Database and configuration |

## Manual Installation (Development)

### Prerequisites

- Node.js 20 or higher
- pnpm 9.12.0 or higher

### Installation Steps

```bash
# Install dependencies
pnpm install

# Configure environment
cp apps/api/.env.example apps/api/.env

# Edit apps/api/.env with your configuration
# Generate secure keys for ENCRYPTION_KEY and SESSION_COOKIE_SECRET

# Generate Prisma client
cd apps/api
pnpm run db:generate

# Run database migrations
pnpm run db:migrate

# Return to root
cd ../..

# Start development servers
pnpm run dev
```

The API will be available at `http://localhost:3001` and the web app at `http://localhost:3000`.

## Production Deployment

### Building for Production

```bash
# Build all packages
pnpm run build

# Run database migrations
cd apps/api
pnpm run db:migrate

# Start production servers
cd apps/api
pnpm run start

# In another terminal
cd apps/web
pnpm run start
```

### Docker Deployment Options

#### Option 1: Pre-built Images (Recommended)

Use the pre-built images from Docker Hub:

```bash
docker-compose up -d
```

Images are available at:
- [khak1s/arr-dashboard-api](https://hub.docker.com/r/khak1s/arr-dashboard-api)
- [khak1s/arr-dashboard-web](https://hub.docker.com/r/khak1s/arr-dashboard-web)

#### Option 2: Build from Source

```bash
docker-compose -f docker-compose.build.yml up -d
```

#### Option 3: Manual Docker Commands

```bash
# Using pre-built images
docker run -d \
  --name arr-dashboard-api \
  -p 3001:3001 \
  -v arr-api-data:/app/data \
  khak1s/arr-dashboard-api:latest

docker run -d \
  --name arr-dashboard-web \
  -p 3000:3000 \
  -e NEXT_PUBLIC_API_BASE_URL=http://localhost:3001 \
  khak1s/arr-dashboard-web:latest
```

## Configuration

### Zero Configuration Required! 🎉

The application auto-generates all necessary security keys on first run and persists them to the Docker volume.

### Optional: Advanced Configuration

See `.env.production.example` for advanced customization options.

**When you might need custom configuration:**
- **Migration**: Preserve encryption keys from another installation
- **Compliance**: Corporate security requires specific key management
- **Port Conflicts**: Default ports 3000/3001 are already in use
- **Network Setup**: Custom reverse proxy or network configuration

To customize, create a `.env` file with your overrides. See the example file for details.

### User-Configurable Settings (in Settings Page)

These are set per-user in the web interface, not in environment variables:

| Setting | Where | Description |
|---------|-------|-------------|
| **TMDB API Key** | Settings → Account | For trending/popular content in Discover page |
| **Service Instances** | Settings → Services | Sonarr, Radarr, and Prowlarr connections |
| **Tags** | Settings → Tags | Organize and filter instances |

### Advanced Configuration (Built-in Defaults)

These are managed by the application and don't need to be set:

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `3001` | API server port |
| `API_HOST` | `0.0.0.0` | API bind address |
| `API_CORS_ORIGIN` | `http://localhost:3000` | Allowed CORS origins |
| `SESSION_TTL_HOURS` | `24` | Session expiration |
| `API_RATE_LIMIT_MAX` | `200` | Max requests per minute |
| `APP_URL` | `http://localhost:3000` | Frontend URL |

To override defaults, add them to your `.env` file or docker-compose.yml.

### Database

By default, the application uses SQLite for data storage. The database file is stored in:
- Development: `apps/api/dev.db`
- Docker: `/app/data/prod.db` (persisted in volume)

## Architecture

This is a monorepo using pnpm workspaces and Turbo:

```
arr-dashboard/
├── apps/
│   ├── api/          # Fastify API server
│   └── web/          # Next.js 14 frontend (App Router)
└── packages/
    └── shared/       # Shared TypeScript types and schemas
```

### Technology Stack

- **Frontend**: Next.js 14, React 18, TailwindCSS, Tanstack Query
- **Backend**: Fastify 4, Prisma, Lucia Auth
- **Database**: SQLite (default), supports PostgreSQL/MySQL
- **Validation**: Zod schemas
- **Build**: Turbo, pnpm workspaces

## Database Setup

### Automatic Migrations (Docker)

When using Docker, migrations run automatically on container startup. The startup script:
1. Runs `prisma migrate deploy` to apply pending migrations
2. Starts the API server

### Manual Migrations

```bash
cd apps/api

# Development - Push schema without creating migration
pnpm run db:push

# Production - Apply migrations
pnpm run db:migrate
```

### Creating New Migrations

When you modify the Prisma schema:

```bash
cd apps/api
npx prisma migrate dev --name your_migration_name
```

This will:
1. Generate a new migration file
2. Apply it to your development database
3. Regenerate the Prisma Client

## Resetting Admin Password

If you forget your admin password:

```bash
cd apps/api
pnpm run reset-admin-password
```

Follow the prompts to reset the password.

## Security Considerations

1. **Always generate unique, secure values** for `ENCRYPTION_KEY` and `SESSION_COOKIE_SECRET`
2. **Never commit** `.env` files with real credentials
3. **Use HTTPS** in production with a reverse proxy (nginx, Caddy, Traefik)
4. **Keep your instances private** - Don't expose Sonarr/Radarr/Prowlarr to the internet
5. **Regular backups** of the SQLite database file

## Reverse Proxy Example (nginx)

```nginx
server {
    listen 80;
    server_name dashboard.example.com;

    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name dashboard.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # Frontend
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # API (if accessed directly)
    location /api {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
}
```

## Updating

### Docker (Pre-built Images)

```bash
# Pull latest images
docker-compose pull

# Restart containers
docker-compose up -d
```

### Docker (Build from Source)

```bash
# Pull latest code
git pull

# Rebuild and restart
docker-compose -f docker-compose.build.yml down
docker-compose -f docker-compose.build.yml up -d --build
```

### Manual

```bash
# Pull latest code
git pull

# Install dependencies
pnpm install

# Run migrations
cd apps/api
pnpm run db:migrate

# Rebuild
cd ../..
pnpm run build

# Restart services
```

## Troubleshooting

### Port Already in Use

If ports 3000 or 3001 are already in use, modify the ports in `docker-compose.yml`:

```yaml
ports:
  - "8080:3000"  # Change 8080 to your desired port
```

### Database Locked Error

If you see "database is locked" errors:
1. Ensure only one instance of the API is running
2. Check file permissions on the database file
3. Consider using PostgreSQL for multi-instance deployments

### Connection Issues

If the frontend can't connect to the API:
1. Verify `NEXT_PUBLIC_API_BASE_URL` is accessible from the browser
2. Check CORS settings in the API
3. Ensure both containers are on the same network (Docker)

## Contributing

Contributions are welcome! Please open an issue or pull request.

## License

MIT License - see [LICENSE](LICENSE) for details

## Support

For issues and questions, please open an issue on GitHub.
