# Arr Dashboard

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

### 1. Clone the Repository

```bash
git clone <repository-url>
cd arr-dashboard
```

### 2. Configure Environment

```bash
# Copy the production environment template
cp .env.production.example .env

# Generate secure keys
openssl rand -hex 32  # Use this for ENCRYPTION_KEY
openssl rand -hex 32  # Use this for SESSION_COOKIE_SECRET
```

Edit `.env` and replace the placeholder values with your generated keys:

```env
ENCRYPTION_KEY=<paste-generated-key-1>
SESSION_COOKIE_SECRET=<paste-generated-key-2>
```

That's it! All other settings use sensible defaults.

> **Note:** TMDB API keys are configured per-user in the Settings page, not in environment variables.

### 3. Start the Application

```bash
docker-compose up -d
```

The API container will automatically:
1. Run database migrations to create the schema
2. Start the API server

You can monitor the startup logs:
```bash
docker-compose logs -f api
```

### 4. Initial Setup

1. Open your browser to `http://your-server-ip:3000`
2. Complete the initial admin account setup
3. Add your Sonarr/Radarr/Prowlarr instances in Settings

The application is now running! 🎉

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

#### Option 1: Docker Compose (Recommended)

```bash
docker-compose up -d
```

#### Option 2: Build Individual Images

```bash
# Build API
docker build -f apps/api/Dockerfile -t arr-dashboard-api .

# Build Web
docker build -f apps/web/Dockerfile -t arr-dashboard-web .

# Run containers
docker run -d \
  --name arr-dashboard-api \
  -p 3001:3001 \
  -e DATABASE_URL=file:/app/data/prod.db \
  -e ENCRYPTION_KEY=<your-key> \
  -e SESSION_COOKIE_SECRET=<your-secret> \
  -v arr-api-data:/app/data \
  arr-dashboard-api

docker run -d \
  --name arr-dashboard-web \
  -p 3000:3000 \
  -e NEXT_PUBLIC_API_BASE_URL=http://localhost:3001 \
  arr-dashboard-web
```

## Configuration

### Required Environment Variables

Only 2 variables are required - everything else has sensible defaults:

| Variable | Description | How to Generate |
|----------|-------------|-----------------|
| `ENCRYPTION_KEY` | 32-byte hex key for encrypting API keys | `openssl rand -hex 32` |
| `SESSION_COOKIE_SECRET` | 32-byte hex key for session cookies | `openssl rand -hex 32` |

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

### Docker

```bash
# Pull latest code
git pull

# Rebuild and restart
docker-compose down
docker-compose up -d --build
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

[Your License Here]

## Support

For issues and questions, please open an issue on GitHub.
