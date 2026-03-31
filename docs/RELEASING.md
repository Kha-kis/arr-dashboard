# Release Process

Step-by-step checklist for publishing a new version of Arr Dashboard.

## Pre-Release

### 1. Version & Documentation

- [ ] Bump `version` in root `package.json`
  - Sub-packages (`apps/api`, `apps/web`, `packages/shared`) stay at `0.1.0` — they are internal
  - The root version propagates via `version.json` at Docker build time and `getAppVersionInfo()` at runtime
- [ ] Write `CHANGELOG.md` entry following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format
- [ ] Update `README.md` — version tagline at top + version tags table
- [ ] Update `DOCKERHUB.md` — version tagline at top + version tags table
- [ ] Update `CLAUDE.md` — version at bottom
- [ ] Update **Wiki** — version in `Home.md` and `Troubleshooting.md` (`/tmp/arr-wiki` or clone from `arr-dashboard.wiki.git`)
- [ ] Update `CLAUDE.md` if new routes, models, patterns, or conventions were added

### 2. Code Quality

- [ ] `pnpm run lint` passes (Biome + ESLint)
- [ ] `pnpm run typecheck` passes (`tsc --noEmit` across all packages)
- [ ] `pnpm run test` passes (Vitest unit tests)
- [ ] `pnpm run build` passes (production build)
- [ ] No leftover `console.log` in `apps/api/src/` (use structured `app.log` / `request.log`)

### 3. Database

- [ ] **Fresh SQLite install:** Delete `dev.db`, run `pnpm run db:push`, verify API starts
- [ ] **Fresh PostgreSQL install:** Point `DATABASE_URL` at empty database, run `pnpm run db:push`, verify API starts
- [ ] **SQLite upgrade:** Start with previous release database, run new version, verify schema migrates
- [ ] **PostgreSQL upgrade:** Same as above with PostgreSQL
- [ ] New Prisma models (if any) are documented in CHANGELOG

### 4. Docker Build

- [ ] `docker build -t arr-dashboard:test .` completes without error
- [ ] Container starts and both API (3001) and Web (3000) respond
- [ ] `GET /health` returns `{ "status": "ok", "version": "X.Y.Z", "commit": "..." }`
- [ ] Test with `PUID`/`PGID` override
- [ ] Test fresh install (no `/config` volume)
- [ ] Test upgrade from previous version (existing `/config` volume)

### 5. Functional Smoke Test

- [ ] Login (password) works
- [ ] Login (OIDC) works — if configured
- [ ] Login (passkey) works — if configured
- [ ] Add a service instance (Sonarr or Radarr)
- [ ] Dashboard loads
- [ ] Statistics page loads
- [ ] TRaSH Guides cache refresh works
- [ ] Backup create/download works

### 6. E2E Tests

- [ ] CI E2E tests pass (all shards)

## Release

### 7. Tag & Publish

```bash
# Create annotated tag
git tag -a vX.Y.Z -m "vX.Y.Z — <tagline>"

# Push tag (triggers docker-combined.yml workflow)
git push origin vX.Y.Z
```

- [ ] Tag pushed to GitHub
- [ ] `docker-combined.yml` workflow completes successfully
  - Builds linux/amd64 and linux/arm64
  - Pushes to Docker Hub (`khak1s/arr-dashboard:X.Y.Z`, `:X.Y`, `:X`, `:latest`)
  - Pushes to GHCR (`ghcr.io/kha-kis/arr-dashboard:X.Y.Z`, etc.)
  - Trivy security scan passes
- [ ] Verify Docker Hub image is pullable: `docker pull khak1s/arr-dashboard:X.Y.Z`

### 8. GitHub Release

- [ ] Create GitHub Release from the tag
  - Title: `vX.Y.Z — <tagline>`
  - Body: Copy relevant CHANGELOG section
  - Mark as "Latest release"
- [ ] Close resolved GitHub issues with comment referencing the release

### 9. Post-Release

- [ ] Verify `latest` Docker tag points to the new release
- [ ] Monitor issue tracker for immediate regressions (24-48 hours)

## Version Flow

```
root package.json ("X.Y.Z")
    │
    ├── Dockerfile builder stage
    │   └── version.json { version: "X.Y.Z", commitSha: "abc1234" }
    │
    ├── Docker CI (docker-combined.yml)
    │   ├── Git tag "vX.Y.Z" → VERSION build arg → OCI label
    │   └── COMMIT_SHA build arg → version.json + OCI label
    │
    └── Runtime
        ├── getAppVersionInfo() → reads version.json (Docker) or package.json (dev)
        ├── GET /health → { status, version, commit }
        ├── GET /api/system/info → { version, commit, database, runtime }
        └── Startup log → "arr-dashboard vX.Y.Z started (commit: abc1234)"
```

## Hotfix Process

For urgent fixes after a release:

1. Branch from main (after the release merge)
2. Fix, test, PR to main
3. Bump patch version: `X.Y.Z` → `X.Y.Z+1`
4. Follow the same checklist above (abbreviated — skip unchanged sections)
5. Tag as `vX.Y.Z+1`
