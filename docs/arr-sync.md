# ARR Custom Formats & TRaSH Sync

Automatically sync custom formats and quality profiles from [TRaSH guides](https://trash-guides.info/) to your Sonarr and Radarr instances.

This feature provides a GUI alternative to [Recyclarr](https://recyclarr.dev/)'s CLI, allowing you to manage custom format synchronization through the Arr Dashboard web interface.

## Features

- ✅ **Automatic Sync** - Sync custom formats from TRaSH guides to Sonarr/Radarr
- ✅ **Preset Support** - Filter formats by preset categories (anime, x265, HDR, etc.)
- ✅ **Dry Run Preview** - Review all changes before applying them
- ✅ **Safe Apply** - Automatic backups before making changes
- ✅ **Idempotent** - Re-running sync won't create duplicate changes
- ✅ **Overrides** - Customize scores and specifications per instance
- ✅ **Quality Profiles** - Automatically update quality profile scores
- ✅ **Multi-Instance** - Manage multiple Sonarr/Radarr instances

## Quick Start

### 1. Add Sonarr/Radarr Instance

First, configure your Sonarr or Radarr instance in **Settings → Services**:

1. Navigate to Settings → Services
2. Add your instance with:
   - Service type (Sonarr or Radarr)
   - Label (e.g., "4K Movies")
   - Base URL (e.g., `http://radarr:7878`)
   - API Key
3. Test the connection
4. Save

### 2. Enable ARR Sync

Navigate to **Settings → ARR Sync**:

1. Find your instance in the list
2. Click **Enable** to turn on sync for that instance
3. (Optional) Click **Test** to verify permissions

### 3. Preview Changes

1. Click **Preview Changes** to see what will be synced
2. Review the diff showing:
   - Custom formats to create
   - Custom formats to update
   - Quality profiles to update
   - Any warnings or conflicts

### 4. Apply Sync

1. Review the preview carefully
2. Click **Apply Changes** to sync
3. Wait for completion
4. Verify the changes in your Sonarr/Radarr instance

## Configuration

### TRaSH Reference

The `trashRef` setting determines which version of TRaSH guides to use:

- `stable` (default) - Latest stable release
- `master` - Latest development version
- Specific tag/commit - Pin to a specific version

### Presets

Presets filter custom formats by category. Common presets include:

**Sonarr:**
- `anime` - Anime-specific formats
- `x265` - x265/HEVC codec formats
- `hdr`, `hdr10plus`, `dolby-vision` - HDR formats
- `scene`, `p2p` - Release group quality tiers
- `streaming-services` - Streaming service identifiers

**Radarr:**
- `anime` - Anime movie formats
- `x265` - x265/HEVC codec formats
- `hdr`, `hdr10plus`, `dolby-vision` - HDR formats
- `uhd-bluray-web` - 4K source quality
- `imax`, `imax-enhanced` - IMAX editions

Leave presets empty to sync all available formats.

### Overrides

Override sync behavior per instance using the `overrides` object:

```json
{
  "customFormats": {
    "Format Name": {
      "enabled": false,       // Skip this format entirely
      "scoreOverride": 100,   // Override score
      "addTerms": ["term1"],  // Add custom search terms
      "removeTerms": ["bad"]  // Remove specific terms
    }
  },
  "scores": {
    "Format Name": 50         // Global score override
  },
  "profiles": {
    "Ultra HD": {
      "cutoff": 2160,
      "minFormatScore": 100,
      "cutoffFormatScore": 5000
    }
  }
}
```

## API Usage

The feature exposes REST endpoints under `/api/arr-sync/`:

### Get Settings

```bash
GET /api/arr-sync/settings
```

Returns sync settings for all Sonarr/Radarr instances.

### Update Settings

```bash
PUT /api/arr-sync/settings/:instanceId
Content-Type: application/json

{
  "enabled": true,
  "trashRef": "stable",
  "presets": ["anime", "x265"],
  "overrides": {}
}
```

### Preview Sync

```bash
POST /api/arr-sync/preview
Content-Type: application/json

{
  "instanceIds": ["instance-id"]  // Optional, syncs all if omitted
}
```

Returns a diff plan showing what changes will be made.

### Apply Sync

```bash
POST /api/arr-sync/apply
Content-Type: application/json

{
  "instanceIds": ["instance-id"],  // Optional
  "dryRun": false                   // Set true to test without changes
}
```

Applies the sync changes and returns results.

### Test Connection

```bash
POST /api/arr-sync/test/:instanceId
```

Tests connectivity and permissions for the instance.

## Safety & Backups

### Automatic Backups

Before applying any changes, ARR Sync automatically creates a backup:

- **Location:** `/app/data/arr-sync-snapshots/` (Docker) or `./data/arr-sync-snapshots/` (dev)
- **Format:** JSON containing all custom formats and quality profiles
- **Naming:** `{instanceId}-{timestamp}.json`
- **Retention:** Last 10 backups per instance

### Restore from Backup

To restore from a backup:

1. Locate the backup file in `/app/data/arr-sync-snapshots/`
2. Use the Sonarr/Radarr API or UI to manually restore
3. Or use the backup service's restore functionality

### Safety Features

- **Dry Run:** Preview changes without applying them
- **Idempotency:** Re-running sync won't duplicate changes
- **Delete Protection:** Deletions are disabled by default
- **Rate Limiting:** API calls are rate-limited to prevent overload
- **Retry Logic:** Automatic retries with exponential backoff on failures

## Troubleshooting

### "Connection test failed"

**Causes:**
- Incorrect base URL or API key
- Sonarr/Radarr instance not reachable
- Firewall blocking connection

**Solutions:**
- Verify instance settings in Services tab
- Check Sonarr/Radarr logs for errors
- Test connectivity: `curl http://your-instance/api/v3/system/status?apikey=YOUR_KEY`

### "No changes detected"

**Causes:**
- All custom formats already synced
- No presets selected
- All formats disabled via overrides

**Solutions:**
- Check preset configuration
- Review override settings
- Verify TRaSH guides have content for your presets

### "Failed to apply changes"

**Causes:**
- Permission issues
- Network errors
- Invalid custom format data

**Solutions:**
- Check backup was created before failure
- Review error messages in the result
- Check Sonarr/Radarr logs for API errors
- Try again with dry run enabled

### "Preview shows deletes"

Custom format deletions are **disabled by default** for safety. If you see deletes in the preview:

- These are informational only and won't be applied
- To enable deletions, modify the `allowDeletes` setting (requires code change)
- Manual deletion is recommended for safety

## Architecture

### Server-Side Components

- **`apps/api/src/lib/arr-sync/`** - Core sync logic
  - `clients/` - Typed Sonarr/Radarr API clients
  - `trash/` - TRaSH guide fetchers and parsers
  - `diff/` - Diff engine for computing changes
  - `apply/` - Safe applicator with retries
  - `backup/` - Snapshot creation and management
  - `sync-orchestrator.ts` - Main coordinator

- **`apps/api/src/routes/arr-sync.ts`** - REST API endpoints

### Frontend Components

- **`apps/web/src/lib/api-client/arr-sync.ts`** - Typed API client
- **`apps/web/src/hooks/api/useArrSync.ts`** - React Query hooks
- **`apps/web/src/features/settings/components/arr-sync-tab.tsx`** - UI

### Database

- **`ArrSyncSettings`** - Per-instance sync configuration
- Relations: One-to-one with `ServiceInstance`

## Performance

- **Rate Limiting:** 5 requests per second to prevent overload
- **Retry Logic:** Up to 3 retries with exponential backoff
- **Parallel Execution:** Multiple instances synced in parallel
- **Caching:** TRaSH guides cached per request

## Security

- **API Keys:** Never exposed to browser; all operations server-side
- **Authentication:** All endpoints require valid session
- **Encryption:** API keys encrypted at rest using AES-256-GCM
- **Backups:** Stored server-side, not downloadable via UI

## Comparison with Recyclarr

| Feature | ARR Sync (GUI) | Recyclarr (CLI) |
|---------|---------------|-----------------|
| Interface | Web UI | Command Line |
| Preview | ✅ Yes | ✅ Yes |
| Presets | ✅ Basic | ✅ Advanced |
| Overrides | ✅ JSON | ✅ YAML |
| Scheduling | ❌ Manual | ✅ Cron |
| Multi-Instance | ✅ Yes | ✅ Yes |
| Backups | ✅ Automatic | ❌ Manual |
| Config Validation | ✅ Real-time | ❌ On run |

## Contributing

To add new features:

1. Server logic: `apps/api/src/lib/arr-sync/`
2. API routes: `apps/api/src/routes/arr-sync.ts`
3. Frontend: `apps/web/src/features/settings/components/arr-sync-tab.tsx`
4. Tests: `apps/api/src/lib/arr-sync/**/*.test.ts`

## References

- [TRaSH Guides](https://trash-guides.info/)
- [Recyclarr Documentation](https://recyclarr.dev/wiki/)
- [Sonarr API Docs](https://sonarr.tv/docs/api/)
- [Radarr API Docs](https://radarr.video/docs/api/)

## Support

For issues or questions:

1. Check this documentation
2. Review server logs: `docker logs arr-dashboard`
3. Check Sonarr/Radarr logs
4. Open an issue on GitHub with:
   - Instance type (Sonarr/Radarr) and version
   - Error messages from preview/apply
   - Backup file location (if apply failed)

---

**Last Updated:** 2025-10-15
**Feature Version:** 1.0.0
**Minimum App Version:** 2.3.0
