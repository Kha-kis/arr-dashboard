# Release Notes

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