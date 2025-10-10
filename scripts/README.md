# Development Scripts

## Build Dev Docker Image

These scripts allow you to build and push development Docker images without affecting the `latest` tag.

### Prerequisites

1. **Docker Buildx** must be enabled:
   ```bash
   docker buildx create --use
   ```

2. **Authentication** - Log in to Docker registries:
   ```bash
   # Docker Hub
   docker login

   # GitHub Container Registry (optional)
   echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin
   ```

### Usage

**On Linux/Mac:**
```bash
chmod +x scripts/build-dev-docker.sh
./scripts/build-dev-docker.sh
```

**On Windows (PowerShell):**
```powershell
.\scripts\build-dev-docker.ps1
```

**On Windows (Git Bash/WSL):**
```bash
bash scripts/build-dev-docker.sh
```

### What This Does

1. Builds a multi-platform Docker image (amd64 + arm64)
2. Tags it with both:
   - `dev` (rolling dev tag)
   - `dev-YYYYMMDD-HHMMSS` (timestamped tag)
3. Pushes to both Docker Hub and GHCR
4. Does **NOT** affect the `latest` tag

### Testing the Dev Image

Use the provided `docker-compose.dev.yml`:

```bash
# Pull and run the dev image
docker-compose -f docker-compose.dev.yml up -d

# View logs
docker-compose -f docker-compose.dev.yml logs -f

# Stop and remove
docker-compose -f docker-compose.dev.yml down
```

The dev image uses a separate data directory (`./data-dev`) so it won't interfere with your production setup.

### Automatic Dev Builds (GitHub Actions)

The `.github/workflows/docker-dev.yml` workflow automatically builds and pushes dev images on every push to `main`. You can also trigger it manually from the GitHub Actions tab.

Each automated build is tagged with:
- `dev` - Always points to the latest dev build
- `dev-YYYYMMDD-HHMMSS-GITHASH` - Specific timestamped build with commit hash

### Troubleshooting

**"buildx not found":**
```bash
docker buildx create --name mybuilder --use
docker buildx inspect --bootstrap
```

**Permission denied on Linux:**
```bash
sudo usermod -aG docker $USER
# Log out and back in
```

**Rate limit on Docker Hub:**
- Use GHCR instead: `ghcr.io/khak1s/arr-dashboard:dev`
- Or wait an hour for rate limit to reset
