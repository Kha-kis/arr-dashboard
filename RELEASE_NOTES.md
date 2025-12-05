# Release Notes

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