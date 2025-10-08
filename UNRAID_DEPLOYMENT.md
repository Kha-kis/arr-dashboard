# Unraid Deployment Guide

## Quick Start

The easiest way to deploy Arr Dashboard on Unraid is using the combined Docker image.

### Method 1: Docker Run (Simplest)

1. Go to Unraid Docker tab
2. Click "Add Container"
3. Fill in:
   - **Name:** `arr-dashboard`
   - **Repository:** `khak1s/arr-dashboard:latest`
   - **Network Type:** `Bridge`
   - **WebUI:** `http://[IP]:[PORT:3000]`
   - **Port:** `3000` → `3000` (TCP)
   - **Path:** `/app/data` → `/mnt/user/appdata/arr-dashboard`
4. Click **Apply**

### Method 2: Using Docker Compose Manager Plugin

1. Install "Docker Compose Manager" from Community Applications
2. Create a new compose stack with:

```yaml
version: '3.8'
services:
  arr-dashboard:
    image: khak1s/arr-dashboard:latest
    container_name: arr-dashboard
    ports:
      - "3000:3000"
    volumes:
      - /mnt/user/appdata/arr-dashboard:/app/data
    restart: unless-stopped
```

3. Start the stack

### Method 3: Community Applications Template (Future)

Once submitted to CA, you'll be able to search for "Arr Dashboard" in Community Applications and install with one click.

## Post-Installation Setup

1. Open `http://your-unraid-ip:3000`
2. Create your admin account on first run
3. Go to Settings → Services
4. Add your Sonarr/Radarr/Prowlarr instances:
   - Name: Any friendly name
   - URL: `http://sonarr:8989` (or your instance URL)
   - API Key: From your Sonarr/Radarr/Prowlarr Settings → General
   - Service Type: Select appropriate service

## Optional: TMDB Integration

For the Discover page to work:
1. Get a free TMDB API key from https://www.themoviedb.org/settings/api
2. Add it in Settings → Account → TMDB API Key

## Updating

1. Go to Docker tab in Unraid
2. Click the `arr-dashboard` container
3. Click "Force Update"
4. Click "Apply"

Or via command line:
```bash
docker pull khak1s/arr-dashboard:latest
docker stop arr-dashboard
docker rm arr-dashboard
# Then recreate the container with the same settings
```

## Advanced Configuration

### Custom Port

If port 3000 is already in use:
```
Port: 8080 → 3000
```
Then access via `http://your-unraid-ip:8080`

### Environment Variables (Optional)

Add these in the Unraid Docker template under "Add another Path, Port, Variable, Label or Device":

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_TTL_HOURS` | `24` | How long sessions last before re-login |
| `API_RATE_LIMIT_MAX` | `200` | Max API requests per minute |

### Using PostgreSQL Instead of SQLite

1. Set up PostgreSQL (via Unraid Community Apps)
2. Add environment variable:
   - Key: `DATABASE_URL`
   - Value: `postgresql://user:password@postgres:5432/arr_dashboard`

## Troubleshooting

### Can't Connect to Sonarr/Radarr

Make sure your URLs are correct:
- If on same Unraid server: `http://container-name:port`
- If different server: `http://192.168.x.x:port`

### Database Locked Error

Only one container can access the SQLite database at a time. Ensure you don't have multiple instances running.

### Container Won't Start

Check logs:
```bash
docker logs arr-dashboard
```

Common issues:
- Port 3000 already in use (change the port mapping)
- Volume permission issues (check /mnt/user/appdata/arr-dashboard is writable)

## Backup

To backup your data:
1. Stop the container
2. Copy `/mnt/user/appdata/arr-dashboard/` to your backup location
3. Restart the container

To restore:
1. Stop the container
2. Replace `/mnt/user/appdata/arr-dashboard/` with your backup
3. Restart the container

## Performance Tips

- Use SSD for the appdata share if possible (SQLite performs better on SSD)
- For large libraries (10k+ items), consider using PostgreSQL instead of SQLite
- The combined image uses ~200-300MB RAM under typical load

## Support

- GitHub Issues: https://github.com/Kha-kis/arr-dashboard/issues
- Unraid Forum: (link after CA submission)
