# Development Scripts

## Docker Dev Builds

Build and push development Docker images without affecting the `latest` tag.

### Prerequisites

1. **Docker Buildx** enabled: `docker buildx create --use`
2. **Authentication**: `docker login` (Docker Hub) and/or `echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin` (GHCR)

### Usage

```bash
# Linux/Mac
./scripts/build-dev-docker.sh

# Windows (PowerShell)
.\scripts\build-dev-docker.ps1
```

Tags created:
- `dev` — Rolling latest dev build
- `dev-YYYYMMDD-HHMMSS` — Timestamped snapshot

Test with: `docker-compose -f docker-compose.dev.yml up -d`

> **Note:** GitHub Actions also builds dev images automatically on every push to `main` via `.github/workflows/docker-dev.yml`.

## Database Diagnostic Scripts

Run from the repo root with `npx tsx`:

| Script | Purpose | Usage |
|--------|---------|-------|
| `check-templates.ts` | List all templates with config summary | `npx tsx scripts/check-templates.ts` |
| `list-templates.ts` | List templates with version and sync info | `npx tsx scripts/list-templates.ts` |

## Testing Helpers

| Script | Purpose | Usage |
|--------|---------|-------|
| `simulate-notify-flow.ts` | Simulate the notify sync strategy for a template | `npx tsx scripts/simulate-notify-flow.ts` |
| `simulate-outdated-template.ts` | Make a template appear outdated for testing updates | `npx tsx scripts/simulate-outdated-template.ts [templateId]` |

> These scripts require the Prisma client to be generated (`cd apps/api && pnpm exec prisma generate`) and a database to be available.
