# Changelog

All notable changes to Arr Dashboard will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.7.1] - 2026-01-30

### Fixed

- **TRaSH Guides template persistence** - Fix custom quality configurations, quality profiles,
  sync settings, and cloned quality profiles being silently dropped when saving templates.
  The Zod validation schema was missing 4 of 8 TemplateConfig fields, causing them to be
  stripped during parsing ([#69](https://github.com/Kha-kis/arr-dashboard/issues/69))
- **TRaSH CF Group validation** - Add missing `include` field to CF Group quality_profiles
  validation schema for TRaSH Guides PR #2590 include/exclude semantics support

### Security

- **Next.js** - Bump minimum version to 16.1.5 to address HTTP request deserialization DoS
  ([GHSA-h25m-26qc-wcjf](https://github.com/advisories/GHSA-h25m-26qc-wcjf))

---

## [2.7.0] - 2026-01-21

### Major Upgrades

This release includes significant upgrades to the entire technology stack for improved performance, security, and maintainability.

#### Runtime & Build
- **Node.js** 20 → 22 (LTS with improved performance and native fetch)
- **pnpm** 9 → 10 (faster installs with inject-workspace-packages)

#### Backend
- **Prisma** 6 → 7 (driver adapter architecture, improved query performance)
- **Pino** 9 → 10 (logging improvements)
- **Fastify** 4 → 5 (performance optimizations)

#### Frontend
- **Next.js** 15 → 16 (Turbopack by default, improved SSR)
- **Tailwind CSS** 3 → 4 (new architecture, faster builds)
- **Framer Motion** 11 → 12 (improved animations)
- **Zustand** 4 → 5 (smaller bundle, better TypeScript)
- **Zod** 3 → 4 (improved error messages)

#### Development
- **Vitest** 1 → 4 (faster test execution)
- **Biome** 1 → 2 (improved linting rules)
- **TypeScript** 5.7 → 5.9

### Upgrade Notes

> **Important:** If upgrading from a previous version, ensure your `/config` volume is preserved. This directory contains:
> - `prod.db` - Your database with all configurations
> - `secrets.json` - Encryption keys for API credentials
>
> If `secrets.json` is missing after upgrade, your service connections will fail to decrypt. The volume should be automatically preserved in standard Docker setups.

#### Database Changes
- The deprecated `urlBase` column in system settings has been removed. This is handled automatically during startup with no action required.
- New library caching tables (`library_cache`, `library_sync_status`) are created automatically for server-side pagination support.

### Added

#### Dashboard Features
- **Queue sorting** - Sort downloads by title (A-Z, Z-A), size (largest/smallest), progress, or status ([#32](https://github.com/Kha-kis/arr-dashboard/issues/32))

#### CI/CD Improvements
- **Automated testing** in CI pipeline with Vitest
- **Dependency vulnerability auditing** with `pnpm audit`
- **Trivy security scanning** for Docker images on release
- **Dependabot** for automated dependency updates (npm, GitHub Actions, Docker)
- **Turbo build caching** for faster CI runs
- **Version metadata injection** into Docker images (VERSION, COMMIT_SHA, BUILD_DATE)

#### Docker Improvements
- **OCI image labels** with build metadata for registry/scanner compatibility
- **STOPSIGNAL SIGTERM** for graceful container shutdown via tini
- **NODE_OPTIONS** with memory tuning for containerized environments
- **Package manager cleanup** - removed unused yarn/npm/corepack from runtime (~25MB)
- **Pinned Alpine version** (node:22-alpine3.21) for reproducible builds
- **Non-Linux prebuild cleanup** to reduce image size

### Changed

- Docker startup script now uses direct prisma path (`./node_modules/.bin/prisma`) instead of npx
- pnpm workspace configuration uses `inject-workspace-packages=true` for hermetic deployments
- Prisma 7 now requires `prisma.config.ts` for CLI configuration

### Fixed

- **Accessibility**: Removed constant animations from cyberpunk theme
- **Docker**: Fixed pnpm 10 compatibility with proper inject-workspace-packages configuration
- **Docker**: Fixed Prisma 7 CLI compatibility by copying prisma.config.ts to deploy directory

### Security

- Docker images now scanned with Trivy on every release
- Dependencies audited for vulnerabilities in CI
- Automated security updates via Dependabot
- Removed unnecessary package managers from runtime image (reduced attack surface)

### Dependencies

Major dependency updates:
- lucide-react 0.441.0 → 0.562.0
- tailwind-merge 2.6.0 → 3.4.0
- @types/node 22.18.6 → 25.0.9
- dotenv 16.6.1 → 17.2.3
- tsup 8.5.0 → 8.5.1

---

## [2.6.7] - 2026-01-07

### Bug Fixes

- **Unraid Startup Hang** - Resolved container hang during startup on Unraid by removing blanket chown on /app/api ([#29](https://github.com/Kha-kis/arr-dashboard/issues/29))
- **OIDC Configuration** - Fixed URL normalization and added recovery options for Keycloak/Authelia users ([#27](https://github.com/Kha-kis/arr-dashboard/issues/27))
- **Hunting Pagination** - Added page offset rotation to prevent hunting from getting "stuck" on large libraries ([#30](https://github.com/Kha-kis/arr-dashboard/issues/30))
- **Template Editor** - Switched to patch-based approach to prevent custom format data loss
- **Auto-Sync Diff** - Fixed stale cache issues when computing template diffs ([#23](https://github.com/Kha-kis/arr-dashboard/issues/23), [#25](https://github.com/Kha-kis/arr-dashboard/pull/25))

### New Features

- **TRaSH Guides**
  - **Sync Metrics Telemetry** - New observability endpoint (`/api/trash-guides/metrics`) for tracking sync operations, success rates, timing, and error categorization
  - **GitHub Rate Limit Awareness** - Intelligent backoff when approaching GitHub API rate limits
  - **Quality Group Management** - Full quality group editing for power users
  - **Per-Template deleteRemovedCFs** - Configure CF removal behavior per template
  - **CF Origin Tracking** - Recyclarr-style origin tracking and deprecation handling
  - **Instance Quality Overrides** - Per-instance quality configuration customization

### Code Quality

- Fixed TypeScript errors across authenticated routes (userId type safety)
- Fixed React hooks dependency warnings
- Normalized line endings across codebase
- Removed dead code (unused parameters)

---

## [2.6.6] - 2025-12-28

### New Features

- **TRaSH Guides**
  - **Sync Strategy-Specific Score Handling** - Different sync strategies now handle score updates appropriately:
    - **Auto sync**: Automatically applies recommended scores from TRaSH `trash_scores`, but preserves user score overrides and creates notifications about conflicts
    - **Notify sync**: Shows suggested score changes in diff for user review without auto-applying
    - **Manual sync**: Displays score differences in diff, user chooses what to apply
  - Score conflict notifications when auto-sync detects user overrides that differ from TRaSH recommendations
  - New scheduler stats tracking templates with score conflicts

---

## [2.6.5] - 2025-12-20

### Bug Fixes

- **Docker**
  - Fix EACCES permission denied error when using PostgreSQL on Unraid ([#21](https://github.com/Kha-kis/arr-dashboard/issues/21))
  - Resolve Prisma client regeneration failure when switching database providers with non-default PUID/PGID

### New Features

- **Settings > System**
  - Added System Information section displaying application version, database backend, Node.js version, and uptime
  - Version detection via `version.json` created at Docker build time

### Security & Stability

- **Session Management**
  - Middleware now validates session tokens against the API
  - Invalid/stale session cookies are automatically cleared and user redirected to login
  - Prevents issues when database is reset or container recreated with new volume

### Documentation

- Documentation has moved to the [GitHub Wiki](https://github.com/Kha-kis/arr-dashboard/wiki)
- Comprehensive guides for Authentication, TRaSH Guides, Hunting, Backup/Restore, and more

---

## [2.6.4] - 2025-12-18

### Bug Fixes

- **Docker**
  - Fix container crash loop when upgrading from older versions ([#13](https://github.com/Kha-kis/arr-dashboard/issues/13))
  - Add `--accept-data-loss` flag to `db push` to handle removed columns (e.g., `urlBase` from `system_settings`)

---

## [2.6.3] - 2025-12-15

### New Features

- **Backup System**
  - Password protection for backup files with optional encryption
  - TRaSH data inclusion option - choose whether to include templates, cache, and sync history in backups
  - Improved restore warning messages with clearer explanation of the replacement process

- **TRaSH Guides**
  - Standalone custom format deployment - deploy individual CFs without full profile sync
  - Sync rollback support - revert deployments if something goes wrong
  - Better deployment tracking and history

- **History Page**
  - External links on instance names - click to navigate directly to the relevant page in Sonarr/Radarr/Prowlarr
  - Links to series/movie pages when viewing history for specific items

### Security & Stability

- **Security**
  - Replaced unsafe code execution patterns with safer alternatives in Next.js server wrapper

- **Error Handling**
  - Add global error boundaries for better crash recovery
  - Route-level error boundary with user-friendly error UI
  - Root layout error boundary for critical failures

- **Performance**
  - Add database indexes for Session cleanup, TrashTemplate soft deletes, and HuntConfig scheduling
  - Fix memory leak in TMDB carousel (memoized scroll callbacks)
  - Fix excessive API refetching in services query (proper staleTime configuration)

### Infrastructure

- **Database**
  - Removed Prisma migrations in favor of `db push` for better multi-provider support
  - Improved PostgreSQL compatibility and provider switching
  - Simpler database initialization for fresh installs
  - Added performance indexes for frequently queried columns

---

## [2.6.2] - 2025-12-10

### Bug Fixes

- **Docker**
  - Fix health check failing due to root path redirect (was checking `/` which returns 307, now uses `/auth/setup-required` which returns 200)
  - Fix Prisma migration lock error (P3019) when switching from SQLite to PostgreSQL (#12)
  - Fix empty DATABASE_URL causing Prisma validation error on Unraid (#19)

### Improvements

- **Connection Testing**
  - Simplify connection tester to use single `/api/vX/system/status` endpoint consistently across all services
  - Add specific error messages for common HTTP status codes (401, 403, 404, 5xx)
  - Better messaging for reverse proxy authentication issues

---

## [2.6.1] - 2025-12-05

### Bug Fixes

- **Statistics**
  - Fix disk statistics showing incorrect totals when instances share storage (storage group deduplication now works across services)
  - Add `combinedDisk` API field for accurate cross-service disk usage totals

- **TRaSH Guides**
  - Fix "column errors does not exist" error in deployment history (#13)
  - Add missing database columns for deployment history: `errors`, `warnings`, `canRollback`, `rolledBack`, `rolledBackAt`, `rolledBackBy`, `deploymentNotes`, `templateSnapshot`

### Infrastructure

- **Database Migrations**
  - Add `storageGroupId` column to ServiceInstance for storage group tracking
  - Add missing columns to `template_deployment_history` table
  - Add missing `userId` index for deployment history queries

---

## [2.6.0] - 2025-11-15

### Security

- **Session Security Improvements** - Enhanced authentication session handling with improved security measures (#11)

### New Features

- **TRaSH Guides Sync for Cloned Profiles** - Cloned quality profile templates can now sync with TRaSH Guides updates
- **Automated Hunting** - New hunting feature for automatically searching missing content and quality upgrades (#15)
- **PostgreSQL Support** - Full PostgreSQL database support for larger deployments
- **Improved Error Handling** - Helpful error message when API is unreachable instead of generic failures
- **Tabbed Statistics** - New tabbed interface for viewing service statistics
- **Clickable Dashboard Links** - Instance names in Dashboard are now clickable for quick navigation
- **External Links in Discover** - TMDB, IMDB, and TVDB links added to recommendation carousels
- **Calendar Deduplication** - Entries appearing in multiple instances are now deduplicated
- **TMDB Caching** - In-memory caching for TMDB API calls improves Discover page performance

### Bug Fixes

- **TRaSH Guides**
  - Don't auto-exclude Custom Formats with score 0 when cloning profiles
  - Fix cloned profile ID parser for standard UUIDs
  - Remap cutoff ID correctly when deploying cloned quality profiles

- **Docker**
  - Fix PostgreSQL provider detection (was matching generator instead of datasource)
  - Database port settings now take precedence over environment variables
  - Copy public directory to container for static assets

- **Services**
  - Handle 401/403 responses from reverse proxy during Prowlarr ping tests
  - Handle numeric eventType from Prowlarr API in statistics

- **Web/UX**
  - Improve queue links and prevent password manager autofill on forms
  - Prevent Discover carousel items from appearing then disappearing
  - Calendar now respects unmonitored filter for both Sonarr and Radarr
  - Add clipboard fallback for non-HTTPS environments
  - Fix duplicate icon files causing favicon 500 error

- **API**
  - Replace all explicit `any` types with proper TypeScript types

### Infrastructure

- **Fork-Safe CI** - Docker build job now works correctly for external contributors
- **Unraid Support** - Added icon to public directory for Unraid Community Applications template
- **Documentation** - Complete CLAUDE.md rewrite with comprehensive technical documentation

---

## [2.5.0] - 2025-10-01

### ⚠️ Breaking Change: Volume Path Update

**The Docker volume mount path has changed from `/app/data` to `/config`** to follow [LinuxServer.io conventions](https://docs.linuxserver.io/general/running-our-containers/).

#### Migration Steps

1. Stop your container:
   ```bash
   docker stop arr-dashboard
   ```

2. Update your volume mount:
   ```yaml
   # Old (2.4.x)
   volumes:
     - ./data:/app/data

   # New (2.5.0+)
   volumes:
     - ./config:/config
   ```

3. Rename your data directory (optional but recommended):
   ```bash
   mv ./data ./config
   ```

4. Restart:
   ```bash
   docker-compose up -d
   ```

> **Note:** Your data (database, secrets) will be preserved. Only the mount path has changed.

### Why This Change?

- **Industry Standard** - Matches LinuxServer.io, hotio, and other popular container maintainers
- **Consistency** - Works alongside Sonarr, Radarr, Prowlarr which all use `/config`
- **Easier Support** - "Where is my data?" → "Always in `/config`"

### Added

- TRaSH Guides integration for quality profile management
- Automated backup system with retention policies
- OIDC authentication support (Authelia, Authentik)
- Passkey/WebAuthn authentication

### Changed

- Improved dashboard performance with optimized queries
- Enhanced calendar view with better date handling

---

## [2.4.3] - 2025-09-20

### Improvements

- **Favicon/Tab Icon** - Added browser tab icon for better identification
- **README Screenshots** - Added screenshots showcasing all major features

---

## [2.4.2] - 2025-09-15

### New Features

- **PUID/PGID Support** - LinuxServer.io-style user/group ID configuration for proper file permissions in Docker
- **Collapsible Error Messages** - Queue items with many similar errors (e.g., multiple missing episodes) are now collapsed into expandable groups

### Improvements

- **Incognito Mode** - Now properly masks release names and episode information in queue status messages
- **Discover Page** - Shows helpful message when TMDB API key is not configured instead of flooding console with 400 errors

### Bug Fixes

- Fixed incognito mode not masking queue status messages containing release names
- Fixed discover page making infinite API requests when TMDB key is missing
- Added proper 400 error handling for API requests

---

## [2.4.1] - 2025-09-10

### Features

- TRaSH Guides integration with quality profiles and custom formats
- Template system for reusable configurations
- Deployment preview and conflict resolution
- Automatic backups before changes

---

[2.7.1]: https://github.com/Kha-kis/arr-dashboard/compare/v2.7.0...v2.7.1
[2.7.0]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.7...v2.7.0
[2.6.7]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.6...v2.6.7
[2.6.6]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.5...v2.6.6
[2.6.5]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.4...v2.6.5
[2.6.4]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.3...v2.6.4
[2.6.3]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.2...v2.6.3
[2.6.2]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.1...v2.6.2
[2.6.1]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.0...v2.6.1
[2.6.0]: https://github.com/Kha-kis/arr-dashboard/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/Kha-kis/arr-dashboard/compare/v2.4.3...v2.5.0
[2.4.3]: https://github.com/Kha-kis/arr-dashboard/compare/v2.4.2...v2.4.3
[2.4.2]: https://github.com/Kha-kis/arr-dashboard/compare/v2.4.1...v2.4.2
[2.4.1]: https://github.com/Kha-kis/arr-dashboard/releases/tag/v2.4.1
