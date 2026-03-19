# Release Process

Step-by-step checklist for publishing a new version of Arr Dashboard.

## Pre-Release

### 1. Version & Documentation

- [ ] Bump `version` in root `package.json` (e.g., `"2.9.0"`)
  - Sub-packages (`apps/api`, `apps/web`, `packages/shared`) stay at `0.1.0` — they are internal
  - The root version propagates via `version.json` at Docker build time and `getAppVersionInfo()` at runtime
- [ ] Write `CHANGELOG.md` entry following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format
  - Include: Added, Changed, Fixed, Security, Testing, Upgrade Notes, Breaking Changes (if any)
  - Add comparison link at bottom: `[X.Y.Z]: https://github.com/Kha-kis/arr-dashboard/compare/vPREV...vX.Y.Z`
- [ ] Update `CLAUDE.md` if new routes, models, patterns, or conventions were added

### 2. Code Quality

- [ ] `pnpm run lint` passes (Biome)
- [ ] `pnpm run typecheck` passes (`tsc --noEmit` across all packages)
- [ ] `pnpm run test` passes (Vitest unit tests)
- [ ] No leftover `console.log` in `apps/api/src/` (use structured `app.log` / `request.log`)
- [ ] No leftover debug/test scripts in source directories

### 3. Database

- [ ] **Fresh SQLite install:** Delete `dev.db`, run `pnpm run db:push`, verify API starts
- [ ] **Fresh PostgreSQL install:** Point `DATABASE_URL` at empty database, run `pnpm run db:push`, verify API starts
- [ ] **SQLite upgrade:** Start with previous release database, run new version, verify schema migrates
- [ ] **PostgreSQL upgrade:** Same as above with PostgreSQL
- [ ] New Prisma models (if any) are documented in CHANGELOG Upgrade Notes

### 4. Docker Build

- [ ] `docker build -t arr-dashboard:test .` completes without error
- [ ] Container starts and both API (3001) and Web (3000) respond
- [ ] `GET /health` returns `{ "status": "ok", "version": "X.Y.Z", "commit": "..." }`
- [ ] Test with `PUID`/`PGID` override (e.g., `PUID=1000 PGID=1000`)
- [ ] Test fresh install (no `/config` volume)
- [ ] Test upgrade from previous version (existing `/config` volume)

### 5. Functional Smoke Test

- [ ] Login (password) works
- [ ] Login (OIDC) works — if configured
- [ ] Login (passkey) works — if configured
- [ ] Add a service instance (Sonarr or Radarr)
- [ ] Dashboard queue loads
- [ ] Statistics page loads
- [ ] TRaSH Guides cache can be refreshed
- [ ] Backup create/download works

### 6. Environment & Logging

- [ ] `LOG_LEVEL=debug` produces debug output in logs
- [ ] `LOG_LEVEL=warn` suppresses info-level messages
- [ ] Startup banner shows: `arr-dashboard vX.Y.Z started (commit: ...)` with correct version
- [ ] Log files rotate to `LOG_DIR` (default: `/config/logs`)
- [ ] Sensitive fields (passwords, API keys, tokens) are redacted in logs

### 7. E2E Tests

- [ ] `pnpm --filter @arr/web exec playwright test` passes (or CI E2E job passes)

## Release

### 8. Tag & Publish

```bash
# Create annotated tag
git tag -a v2.9.0 -m "v2.9.0 — Plex, Tautulli, Seerr, Notifications, Library Cleanup, Naming Schemes"

# Push tag (triggers docker-combined.yml workflow)
git push origin v2.9.0
```

- [ ] Tag pushed to GitHub
- [ ] `docker-combined.yml` workflow completes successfully
  - Builds linux/amd64 and linux/arm64
  - Pushes to Docker Hub (`khak1s/arr-dashboard:2.9.0`, `:2.9`, `:2`, `:latest`)
  - Pushes to GHCR (`ghcr.io/kha-kis/arr-dashboard:2.9.0`, etc.)
  - Trivy security scan passes
- [ ] Verify Docker Hub image is pullable: `docker pull khak1s/arr-dashboard:2.9.0`

### 9. GitHub Release

- [ ] Create GitHub Release from the tag
  - Title: `v2.9.0 — <tagline>`
  - Body: Copy relevant CHANGELOG section (or link to it)
  - Mark as "Latest release"
- [ ] Close resolved GitHub issues with comment referencing the release

### 10. Post-Release

- [ ] Verify `latest` Docker tag points to the new release
- [ ] Announce in relevant community channels
- [ ] Monitor issue tracker for immediate regressions (24-48 hours)

## Version Flow Diagram

```
root package.json ("2.9.0")
    │
    ├── Dockerfile builder stage
    │   └── version.json { version: "2.9.0", commitSha: "abc1234" }
    │
    ├── Docker CI (docker-combined.yml)
    │   ├── Git tag "v2.9.0" → VERSION build arg → OCI label
    │   └── COMMIT_SHA build arg → version.json + OCI label
    │
    └── Runtime
        ├── getAppVersionInfo() → reads version.json (Docker) or package.json (dev)
        ├── GET /health → { status, version, commit }
        ├── GET /api/system/info → { version, commit, database, runtime, logging }
        └── Startup log → "arr-dashboard v2.9.0 started (commit: abc1234)"
```

## Hotfix Process

For urgent fixes after a release:

1. Branch from the release tag: `git checkout -b fix/issue-NNN v2.9.0`
2. Fix, test, PR to main
3. Bump patch version: `2.9.0` → `2.9.1`
4. Follow the same checklist above (abbreviated — skip unchanged sections)
5. Tag as `v2.9.1`
