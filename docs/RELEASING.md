# Release Process

Step-by-step checklist for publishing a new version of Arr Dashboard.

## Pre-Release

### 0. Determine Release Scope

Before bumping any version numbers, decide *what* this release contains.

- [ ] List PRs merged since the last tag: `gh pr list --state merged --search "merged:>=$(git log -1 --format=%aI <last-tag>)"`
- [ ] Verify each PR carries exactly one `release:*` label (see [Release Bucketing](#release-bucketing) below)
  - Apply labels manually for any unbucketed PRs (notably Dependabot/Renovate, which don't self-label)
- [ ] Decide which buckets are in scope for this release:
  - Patch release → `release:patch-now` + (optionally) `release:patch-batch`
  - Minor release → all of the above + `release:next-minor`
  - `release:defer` is never in scope without re-labeling first
- [ ] If nothing is `release:patch-now` and the `release:patch-batch` queue is small, prefer to wait

### 1. Version & Documentation

- [ ] Bump `version` in root `package.json`
  - Sub-packages (`apps/api`, `apps/web`, `packages/shared`) stay at `0.1.0` — they are internal
  - The root version propagates via `version.json` at Docker build time and `getAppVersionInfo()` at runtime
- [ ] Write `CHANGELOG.md` entry following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format
- [ ] Update `README.md` — version tagline at top + version tags table
- [ ] Update `DOCKERHUB.md` — version tagline at top + version tags table
- [ ] Update **Wiki** — version in `Home.md` and `Troubleshooting.md` using a fresh temporary clone of `arr-dashboard.wiki.git`
- [ ] Update `docs/DEVELOPMENT.md` or the relevant domain reference if routes, models, patterns, or conventions changed

### 2. Code Quality

- [ ] `pnpm run lint` passes (Biome + ESLint)
- [ ] `pnpm run typecheck` passes (`tsc --noEmit` across all packages)
- [ ] `pnpm run test` passes (Vitest unit tests)
- [ ] `pnpm run build` passes (production build)
- [ ] No leftover `console.log` in `apps/api/src/` (use structured `app.log` / `request.log`)
- [ ] **Live integration test for *arr write paths** (covers the issue #384 regression class — partial PUT bodies rejected by Radarr/Sonarr's strict validators):
      ```
      INTEGRATION_TESTS=1 \
        RADARR_INTEGRATION_URL=... RADARR_INTEGRATION_API_KEY=... RADARR_INTEGRATION_MOVIE_ID=... \
        SONARR_INTEGRATION_URL=... SONARR_INTEGRATION_API_KEY=... SONARR_INTEGRATION_SERIES_ID=... \
        pnpm --filter @arr/api exec vitest run arr-write-pattern.integration
      ```
      The test creates a unique tag, applies it via `getById → spread → update`, verifies it landed without losing fields, then reverts. CI does NOT run this — it's an operator-side gate before each tagged release.

### 3. Database

- [ ] **Fresh SQLite install:** Delete `dev.db`, run `pnpm run db:push`, verify API starts
- [ ] **Fresh PostgreSQL install:** Point `DATABASE_URL` at empty database, run `pnpm run db:push`, verify API starts
- [ ] **SQLite upgrade:** Start with previous release database, run new version, verify schema migrates
- [ ] **PostgreSQL upgrade:** Same as above with PostgreSQL
- [ ] Run both upgrade scenarios **without** Prisma's `--accept-data-loss`; a
      destructive transition requires a release-specific backup/migration plan
      and must not be delegated to container startup
- [ ] New Prisma models (if any) are documented in CHANGELOG

### 4. Docker Build

- [ ] `docker build -t arr-dashboard:test .` completes without error
- [ ] Container starts and both API (3001) and Web (3000) respond
- [ ] `GET /health` returns `{ "status": "ok", "version": "X.Y.Z", "commit": "..." }`
- [ ] Test with `PUID`/`PGID` override
- [ ] For Docker SQLite, test a fresh install with an explicit persistent directory
      mount, then clean shutdown, restart, and container replacement using the same mount.
- [ ] Verify a fresh writable-layer-only SQLite launch refuses before database creation,
      and a legacy writable-layer-only database is conserved on refusal. Verify the
      [storage transition](SQLITE-STORAGE.md) with an encrypted backup from a disposable
      legacy source and a separately enrolled mounted destination.
- [ ] Test upgrade from previous version (existing `/config` volume) and verify the
      deployed mount and database identity are preserved. Run the supported and refused
      topology checks on native AMD64 and ARM64.
      The immutable staging receipt requires those storage cases on both
      architectures in addition to the existing restart, browser, asset and
      scan gates.
- [ ] Call out breaking deployment requirements before selecting a stable
      version. The SQLite directory-mount requirement changes the startup
      contract for previous writable-layer Docker installs. Require explicit
      maintainer version disposition and pre-upgrade preservation guidance
      before including it in a maintenance patch.

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

### 7. Qualify, approve and promote Docker artifacts

#### Stage the actual release images

- [ ] Confirm the final reviewed commit is the current `main`, its CI passed, and root
  `package.json` contains the intended stable version.
- [ ] Dispatch **Qualify Immutable Release Candidate** (`docker-stage.yml`) on
  `main` with the full source SHA and the stable version, such as `2.25.0`.
  This dispatch builds native Linux AMD64 and ARM64 with stable version metadata
  and stages them under nonstable candidate references in Docker Hub and GHCR.
- [ ] Require the workflow to succeed. Each architecture runs packaged asset,
  native runtime, mobile browser and digest-pinned HIGH/CRITICAL image checks.
  Both registry graphs must contain the exact child manifests, configs, layers
  and BuildKit SBOM/provenance for the qualified multiarchitecture index.
- [ ] Retain `release-qualification.json`, its file SHA-256, the stage run ID and
  attempt, the release source commit/tree, and the exact child and index digests.
  A failed, interrupted, expired or mismatched stage cannot qualify a release.
  Use a fresh stage dispatch rather than reusing partial artifacts. Keep one successful stage
  per exact source. A second incompatible success prevents automatic promotion
  until the maintainer reviews the conflict and qualifies the resolved source.

#### Authorize promotion with the release tag

For the first tag-authorized release, a repository administrator must retire the
historical **docker-combined.yml** workflow, ID 196258923. It can build and move
stable aliases when a tag points to an older commit. Disable that workflow ID
before releasing and verify that its API state is `disabled_manually`. The
replacement `docker-stage.yml` must remain active under its own ID. The old path stays registered
as an inert placeholder so you can disable the same historical ID.

Restrict stable tag creation to the release maintainer. In repository **Settings
→ Rules → Rulesets**, create an active tag ruleset for `v[0-9]*.[0-9]*.[0-9]*`,
excluding prerelease and build metadata patterns `*-*` and `*+*`. Enable
**Restrict creations**, **Restrict updates** and **Restrict deletions**. Allow
bypass only for the trusted repository administrator role. Verify that a stable
tag matches the active rule. The workflow independently requires a protected
tag and restricts the tag push and recovery reruns to the canonical owner.

- [ ] Confirm the stage completed and retain its immutable index, receipt SHA-256
  and expected registry aliases. Require an unchanged current main and one
  compatible qualification. The two registry credentials are the existing
  repository Docker Hub credentials and the job-scoped GHCR token. Registry
  accounts can still change tags directly if they have write access. Keep other
  stable writers out of the publication window.
- [ ] Obtain explicit authorization for the qualified source and index. Create
  and push the annotated `vX.Y.Z` tag at the exact qualified main commit.
  This push starts **Promote Qualified Release Docker Image**
  (`docker-promote.yml`). The normal path has no separate dispatch or approval.
- [ ] The workflow finds successful canonical staging evidence issued before the
  tag, verifies its immutable archive and both OCI graphs, and refuses absent,
  expired, conflicting or mismatched evidence. Only its write job uses registry
  credentials. It copies the exact existing index without rebuilding.

#### Verify promotion or reconcile a partial result

The workflow publishes the version tag in both registries first, then the
minor, major and `latest` aliases. Each write is checked and read back. A
different existing version digest is a conflict. Floating aliases must match the
recorded per-registry baseline before the first attempt. A failed build or scan,
incomplete evidence or mismatched identity prevents stable writes.

Registry updates are sequential. If interrupted or failed, the workflow stops on
the first error and reports the alias state it can verify. Inspect every alias
directly in both registries if a write or readback is uncertain. There is no
automatic rollback. Before a maintainer authorizes a recovery rerun, reconcile
the existing Git tag, original qualified index and both registries against the
recorded baseline. Rerun the original tag workflow only as the release
maintainer. It will reconcile aliases at their original digest or already at the
qualified index and refuse any other state. Keep the original tag in place.
Advanced main or expired evidence requires a separately reviewed release
recovery decision.

- [ ] Verify `X.Y.Z`, `X.Y`, `X` and `latest` in both registries resolve to the
  qualified index. Pull both platform digests and verify installed source and
  version. Continue to the GitHub release only after this verification.

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
    ├── Docker CI (docker-stage.yml)
    │   ├── Qualified stable version → VERSION build arg → OCI label
    │   └── COMMIT_SHA build arg → version.json + OCI label
    │
    └── Runtime
        ├── getAppVersionInfo() → reads version.json (Docker) or package.json (dev)
        ├── GET /health → { status, version, commit }
        ├── GET /api/system/info → { version, commit, database, runtime }
        └── Startup log → "arr-dashboard vX.Y.Z started (commit: abc1234)"
```

## Release Bucketing

Merging to `main` does not imply "release now." Every PR should carry exactly
one `release:*` label at merge time so it is clear what the next tag should
contain:

| Label | Meaning |
|---|---|
| `release:patch-now` | Urgent fix / regression — cut a patch release as soon as this merges. |
| `release:patch-batch` | Legitimate patch material, but fine to batch with other `patch-batch` PRs. |
| `release:next-minor` | Feature or non-urgent change — hold until the next minor version. |
| `release:defer` | Merged but intentionally parked (e.g. behind a flag, awaiting a dependency). Revisit before any release. |

These labels are **forward-looking** (set at merge time to drive future scope
decisions). They are independent of the existing `vX.Y.Z` "Released in …"
labels, which are applied *after* a release to record what shipped — keep
both. When preparing a release, see [Step 0: Determine Release Scope](#0-determine-release-scope).

Maintainer-local release tooling may automate the audit-and-classify pass, but
its proposed labels must be reviewed before applying.

## Hotfix Process

For urgent fixes after a release:

1. Branch from main (after the release merge)
2. Fix, test, PR to main
3. Bump patch version: `X.Y.Z` → `X.Y.Z+1`
4. Follow the same checklist above (abbreviated — skip unchanged sections)
5. Qualify, tag, and promote the approved patch using Step 7.
