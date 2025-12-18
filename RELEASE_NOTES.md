# Release Notes

## Version 2.6.6

### ✨ New Features

- **TRaSH Guides**
  - **Sync Strategy-Specific Score Handling** - Different sync strategies now handle score updates appropriately:
    - **Auto sync**: Automatically applies recommended scores from TRaSH `trash_scores`, but preserves user score overrides and creates notifications about conflicts
    - **Notify sync**: Shows suggested score changes in diff for user review without auto-applying
    - **Manual sync**: Displays score differences in diff, user chooses what to apply
  - Score conflict notifications when auto-sync detects user overrides that differ from TRaSH recommendations
  - New scheduler stats tracking templates with score conflicts

### 📦 Upgrade Notes

This is a non-breaking release. Simply pull the latest image:

```bash
docker-compose pull
docker-compose up -d
```

---

## Version 2.6.5

### 🐛 Bug Fixes

- **Docker**
  - Fix EACCES permission denied error when using PostgreSQL on Unraid ([#21](https://github.com/Kha-kis/arr-dashboard/issues/21))
  - Resolve Prisma client regeneration failure when switching database providers with non-default PUID/PGID

### ✨ New Features

- **Settings > System**
  - Added System Information section displaying application version, database backend, Node.js version, and uptime
  - Version detection via `version.json` created at Docker build time

### 🔒 Security & Stability

- **Session Management**
  - Middleware now validates session tokens against the API
  - Invalid/stale session cookies are automatically cleared and user redirected to login
  - Prevents issues when database is reset or container recreated with new volume

### 📚 Documentation

- Documentation has moved to the [GitHub Wiki](https://github.com/Kha-kis/arr-dashboard/wiki)
- Comprehensive guides for Authentication, TRaSH Guides, Hunting, Backup/Restore, and more

### 📦 Upgrade Notes

This is a non-breaking release. Simply pull the latest image:

```bash
docker-compose pull
docker-compose up -d
```

**Note:** You may be logged out after upgrading due to improved session validation. Simply log in again.

---

## Version 2.6.4

### 🐛 Bug Fixes

- **Docker**
  - Fix container crash loop when upgrading from older versions ([#13](https://github.com/Kha-kis/arr-dashboard/issues/13))
  - Add `--accept-data-loss` flag to `db push` to handle removed columns (e.g., `urlBase` from `system_settings`)

### 📦 Upgrade Notes

This is a hotfix release. Simply pull the latest image:

```bash
docker-compose pull
docker-compose up -d
```

If you were stuck on v2.6.3 with a crash loop, this release fixes the issue.

---

## Version 2.6.3

### ✨ New Features

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

### 🔒 Security & Stability

- **Security**
  - Replace `eval()` with `vm.runInNewContext()` in Next.js server wrapper for safer config parsing

- **Error Handling**
  - Add global error boundaries for better crash recovery
  - Route-level error boundary with user-friendly error UI
  - Root layout error boundary for critical failures

- **Performance**
  - Add database indexes for Session cleanup, TrashTemplate soft deletes, and HuntConfig scheduling
  - Fix memory leak in TMDB carousel (memoized scroll callbacks)
  - Fix excessive API refetching in services query (proper staleTime configuration)

### 🏗️ Infrastructure

- **Database**
  - Removed Prisma migrations in favor of `db push` for better multi-provider support
  - Improved PostgreSQL compatibility and provider switching
  - Simpler database initialization for fresh installs
  - Added performance indexes for frequently queried columns

### 📦 Upgrade Notes

This is a non-breaking release. Simply pull the latest image:

```bash
docker-compose pull
docker-compose up -d
```

---

## Version 2.6.2

### 🐛 Bug Fixes

- **Docker**
  - Fix health check failing due to root path redirect (was checking `/` which returns 307, now uses `/auth/setup-required` which returns 200)
  - Fix Prisma migration lock error (P3019) when switching from SQLite to PostgreSQL (#12)
  - Fix empty DATABASE_URL causing Prisma validation error on Unraid (#19)

### 🔧 Improvements

- **Connection Testing**
  - Simplify connection tester to use single `/api/vX/system/status` endpoint consistently across all services
  - Add specific error messages for common HTTP status codes (401, 403, 404, 5xx)
  - Better messaging for reverse proxy authentication issues

### 📦 Upgrade Notes

This is a non-breaking release. Simply pull the latest image:

```bash
docker-compose pull
docker-compose up -d
```

---

## Version 2.6.1

### 🐛 Bug Fixes

- **Statistics**
  - Fix disk statistics showing incorrect totals when instances share storage (storage group deduplication now works across services)
  - Add `combinedDisk` API field for accurate cross-service disk usage totals

- **TRaSH Guides**
  - Fix "column errors does not exist" error in deployment history (#13)
  - Add missing database columns for deployment history: `errors`, `warnings`, `canRollback`, `rolledBack`, `rolledBackAt`, `rolledBackBy`, `deploymentNotes`, `templateSnapshot`

### 🏗️ Infrastructure

- **Database Migrations**
  - Add `storageGroupId` column to ServiceInstance for storage group tracking
  - Add missing columns to `template_deployment_history` table
  - Add missing `userId` index for deployment history queries

### 📦 Upgrade Notes

This is a non-breaking release. Simply pull the latest image:

```bash
docker-compose pull
docker-compose up -d
```

Database migrations will run automatically on startup. If you encounter any issues with migrations, you can resolve them manually:

```bash
# If migrations fail due to existing columns (e.g., from db:push)
docker exec arr-dashboard npx prisma migrate resolve --applied 20251216000000_add_storage_group_id
docker exec arr-dashboard npx prisma migrate resolve --applied 20251216100000_add_deployment_history_columns
```

---

## Version 2.6.0

### 🔒 Security

- **Session Security Improvements** - Enhanced authentication session handling with improved security measures (#11)

### ✨ New Features

- **TRaSH Guides Sync for Cloned Profiles** - Cloned quality profile templates can now sync with TRaSH Guides updates
- **Automated Hunting** - New hunting feature for automatically searching missing content and quality upgrades (#15)
- **PostgreSQL Support** - Full PostgreSQL database support for larger deployments
- **Improved Error Handling** - Helpful error message when API is unreachable instead of generic failures
- **Tabbed Statistics** - New tabbed interface for viewing service statistics
- **Clickable Dashboard Links** - Instance names in Dashboard are now clickable for quick navigation
- **External Links in Discover** - TMDB, IMDB, and TVDB links added to recommendation carousels
- **Calendar Deduplication** - Entries appearing in multiple instances are now deduplicated
- **TMDB Caching** - In-memory caching for TMDB API calls improves Discover page performance

### 🐛 Bug Fixes

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

### 🏗️ Infrastructure

- **Fork-Safe CI** - Docker build job now works correctly for external contributors
- **Unraid Support** - Added icon to public directory for Unraid Community Applications template
- **Documentation** - Complete CLAUDE.md rewrite with comprehensive technical documentation

### 📦 Upgrade Notes

This is a non-breaking release. Simply pull the latest image:

```bash
docker-compose pull
docker-compose up -d
```

If upgrading from 2.4.x or earlier, see the [2.5.0 migration guide](#version-250) for volume path changes.

---

## Version 2.5.0

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

---

## Version 2.4.3

### Improvements
- **Favicon/Tab Icon** - Added browser tab icon for better identification
- **README Screenshots** - Added screenshots showcasing all major features

---

## Version 2.4.2

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

## Version 2.4.1

### Features
- TRaSH Guides integration with quality profiles and custom formats
- Template system for reusable configurations
- Deployment preview and conflict resolution
- Automatic backups before changes