# Release Notes

## Version 2.6.2

### 🐛 Bug Fixes

- **Docker**
  - Fix health check failing due to root path redirect (was checking `/` which returns 307, now uses `/auth/setup-required` which returns 200)

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