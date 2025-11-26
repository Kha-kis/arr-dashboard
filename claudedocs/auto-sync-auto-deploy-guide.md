# TRaSH Guides Auto-Sync and Auto-Deploy System

**Date**: November 24, 2025
**Status**: Implementation Complete
**Feature**: Automatic template synchronization and deployment workflow

---

## Overview

The TRaSH Guides integration now features a complete end-to-end automation system that:
1. **Monitors** TRaSH Guides repository for updates (every 12 hours)
2. **Syncs** template data from TRaSH Guides to local database
3. **Deploys** updated templates automatically to configured Arr instances

This eliminates the need for manual intervention while respecting user preferences and modifications.

---

## Architecture

### Workflow Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     Background Scheduler                         │
│                   (Runs every 12 hours)                          │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                  1. Check for Updates                            │
│  - Fetch latest TRaSH Guides commit hash                         │
│  - Compare with template commit hashes in database               │
│  - Refresh cached data (quality profiles, custom formats, etc.)  │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              2. Identify Eligible Templates                      │
│  Criteria:                                                       │
│  ✓ syncStrategy = "auto"                                         │
│  ✓ hasUserModifications = false                                  │
│  ✓ Template has available update                                 │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                  3. Sync Template Data                           │
│  For each eligible template:                                     │
│  - Fetch latest template data from TRaSH Guides                  │
│  - Update template in database                                   │
│  - Update commit hash and lastSyncedAt                           │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│            4. Auto-Deploy to Mapped Instances                    │
│  For each successfully synced template:                          │
│  - Query TemplateQualityProfileMapping table                     │
│  - Get all Radarr/Sonarr instances using this template           │
│  - Deploy custom formats to each instance                        │
│  - Log deployment results (success/failure per instance)         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Per-Template Sync Strategy

Each template has a `syncStrategy` field that controls its update behavior:

### Sync Strategy Options

| Strategy | Behavior | Use Case |
|----------|----------|----------|
| **auto** | Automatically sync AND deploy when updates available (if no custom mods) | Templates you want fully automated |
| **notify** | Show notification when updates available, but require manual action | Templates you want to review before deploying |
| **manual** | Never auto-check, all operations must be done manually | Templates with custom workflows |

### Setting Sync Strategy

**Via UI**:
1. Navigate to TRaSH Guides → Templates
2. Click on a template to edit
3. Select sync strategy from radio buttons
4. Save template

**Via API**:
```bash
PATCH /api/trash-guides/templates/:id
{
  "syncStrategy": "auto" | "notify" | "manual"
}
```

---

## Global Configuration Removal

### Previous Behavior (Removed)
- Global `TRASH_AUTO_SYNC_ENABLED` environment variable acted as master switch
- Even if template had `syncStrategy: "auto"`, it wouldn't sync unless global flag was `true`
- UI showed warning about needing both flags enabled

### New Behavior (Current)
- **No global override** - per-template settings are fully respected
- `syncStrategy` on each template is the single source of truth
- Cleaner UI without confusing warning messages
- More intuitive user experience

---

## Auto-Deploy Implementation

### How It Works

1. **Template-to-Instance Mapping**:
   - `TemplateQualityProfileMapping` table links templates to specific quality profiles in instances
   - When a template is synced, system queries this table to find all dependent instances

2. **Deployment Execution**:
   ```typescript
   // For each mapped instance:
   deploymentExecutor.deploySingleInstance(
     templateId,
     instanceId,
     "system" // System user for auto-deployments
   )
   ```

3. **Custom Format Deployment**:
   - Creates/updates custom formats in Radarr/Sonarr
   - Respects instance-specific score overrides
   - Creates backup before deployment
   - Records deployment history

4. **Error Handling**:
   - Deployment failures don't break the sync process
   - Each instance deployment is independent
   - Errors are logged but don't prevent other deployments
   - Sync result includes deployment errors

### Deployment Results

Logged to console:
```
Auto-deploying template <templateId> to 2 instances...
Successfully auto-deployed template <templateId> to instance "Radarr 4K": 5 created, 3 updated
Successfully auto-deployed template <templateId> to instance "Radarr HD": 5 created, 3 updated
```

---

## User Modifications Safety

### Protection Mechanism

Templates with user modifications are **never auto-synced**, even if `syncStrategy = "auto"`.

**What counts as a user modification?**
- Manual score overrides on custom formats
- Custom custom formats added to template
- Changes to template metadata
- `hasUserModifications` flag set to `true`

**Workflow for Modified Templates:**
1. Scheduler detects update available
2. Checks `hasUserModifications` flag
3. If `true`, skips auto-sync
4. Adds template to "needs attention" list
5. Shows notification in UI (if `syncStrategy = "notify"`)

**Manual Sync Options for Modified Templates:**
- **Keep Custom**: Preserve all modifications, don't sync
- **Sync New**: Replace with latest TRaSH, lose modifications
- **Smart Merge**: Add new CFs, update specifications, preserve score overrides

---

## Scheduler Configuration

### Environment Variables

```bash
# Scheduler enable/disable (default: true)
TRASH_UPDATE_SCHEDULER_ENABLED=true

# Check interval in hours (default: 12)
TRASH_UPDATE_CHECK_INTERVAL_HOURS=12

# REMOVED: No longer used
# TRASH_AUTO_SYNC_ENABLED=true
```

### Scheduler Statistics

Available via API: `GET /api/trash-guides/updates/scheduler/status`

```json
{
  "isRunning": true,
  "autoSyncEnabled": false,  // Deprecated, always shows global setting
  "lastCheckAt": "2025-11-24T13:57:40.365Z",
  "nextCheckAt": "2025-11-25T01:30:41.693Z",
  "lastCheckResult": {
    "templatesChecked": 6,
    "templatesOutdated": 2,
    "templatesAutoSynced": 2,      // Templates synced
    "templatesNeedingAttention": 0, // Modified or notify-only
    "cachesRefreshed": 12,          // Cache entries updated
    "cachesFailed": 0,              // Cache update failures
    "errors": []
  }
}
```

**Key Metrics:**
- `templatesAutoSynced`: Number of templates successfully synced AND deployed
- `templatesNeedingAttention`: Templates with updates but requiring manual review
- `cachesRefreshed`: TRaSH Guides data cache entries updated

---

## Manual Override

### Manual Trigger

**Via UI**:
1. Navigate to TRaSH Guides → Update Scheduler tab
2. Click "Trigger Check Now" button
3. System immediately checks for updates and processes auto-syncs

**Via API**:
```bash
POST /api/trash-guides/updates/scheduler/trigger
```

### Manual Sync

For templates not set to auto-sync or requiring manual intervention:

1. Navigate to TRaSH Guides → Templates
2. Template with update shows banner: "Update Available"
3. Click "View Changes" to see diff
4. Review custom format changes
5. Select merge strategy
6. Click "Sync to Latest"

---

## Testing the Workflow

### Test Scenario: Simulate Update

Since all templates are currently up-to-date, use the simulation script:

```bash
# List templates to get ID
cd apps/api && pnpm exec tsx ../../scripts/list-templates.ts

# Simulate outdated template (set old commit hash)
cd apps/api && pnpm exec tsx ../../scripts/simulate-outdated-template.ts <templateId>
```

**Expected workflow:**
1. Template commit hash set to old value
2. Scheduler detects template is outdated
3. If `syncStrategy = "auto"` AND `hasUserModifications = false`:
   - Template syncs automatically
   - Deploys to all mapped instances
4. If `syncStrategy = "notify"` OR `hasUserModifications = true`:
   - Shows update notification
   - Requires manual review

### Verify Deployment

Check deployment history:
```bash
GET /api/trash-guides/deployment/history?templateId=<templateId>
```

Check Radarr/Sonarr instance:
```bash
# Custom formats should be created/updated
GET <radarr_url>/api/v3/customformat
```

---

## Code Changes Summary

### Files Modified

1. **`apps/api/src/lib/trash-guides/update-scheduler.ts`**
   - Removed global `autoSyncEnabled` check (line 209)
   - Now directly calls `processAutoUpdates()` without conditional

2. **`apps/api/src/lib/trash-guides/template-updater.ts`**
   - Added `DeploymentExecutorService` dependency
   - Enhanced `processAutoUpdates()` to call `deployToMappedInstances()`
   - Implemented `deployToMappedInstances()` method
   - Auto-deploys to all instances after successful sync

3. **`apps/api/src/routes/trash-guides/update-routes.ts`**
   - Added `createDeploymentExecutorService` import
   - Instantiates and passes deployment executor to template updater

4. **`apps/api/src/plugins/trash-update-scheduler.ts`**
   - Added `createDeploymentExecutorService` import
   - Instantiates and passes deployment executor to scheduler

5. **`apps/web/src/features/trash-guides/components/sync-strategy-control.tsx`**
   - Removed warning about `TRASH_AUTO_SYNC_ENABLED` (lines 107-120)
   - Cleaner UI with just per-template controls

### Database Schema

No schema changes required. Existing tables support the feature:
- `TrashTemplate`: `syncStrategy`, `hasUserModifications`, `trashGuidesCommitHash`
- `TemplateQualityProfileMapping`: Links templates to instances
- `TemplateDeploymentHistory`: Tracks deployment history

---

## Best Practices

### For End Users

1. **Start Conservative**: Set templates to `"notify"` initially
2. **Observe Behavior**: Watch how updates flow through
3. **Enable Auto When Confident**: Switch to `"auto"` for stable templates
4. **Monitor Scheduler Dashboard**: Check results after each run
5. **Review Deployment History**: Verify deployments succeeded

### For Administrators

1. **Scheduler Interval**: Keep default 12 hours, avoids API rate limits
2. **Monitor Logs**: Watch for deployment errors
3. **Backup Strategy**: Ensure backups work before enabling auto-deploy
4. **Instance Health**: Verify all instances reachable before auto-deploy
5. **Testing**: Use simulation scripts to test workflow

---

## Troubleshooting

### Auto-Sync Not Working

**Check**:
1. Template `syncStrategy` is set to `"auto"` ✓
2. Template `hasUserModifications` is `false` ✓
3. Template has available update ✓
4. Scheduler is running ✓

**Logs to Check**:
```bash
# Scheduler started
"Starting TRaSH Guides update scheduler (interval: 12h, auto-sync: false)"

# Update check running
"Checking for TRaSH Guides updates..."

# Templates synced
"Auto-synced 2 templates (0 failed)"
```

### Auto-Deploy Not Working

**Check**:
1. Template has mapped instances in `TemplateQualityProfileMapping` ✓
2. Instances are reachable ✓
3. Instances have correct API keys ✓
4. Deployment executor initialized ✓

**Logs to Check**:
```bash
# Deployment started
"Auto-deploying template <id> to 2 instances..."

# Deployment success
"Successfully auto-deployed template <id> to instance 'Radarr 4K': 5 created, 3 updated"

# Deployment error
"Failed to auto-deploy template <id> to instance 'Radarr HD': <error>"
```

### Template Keeps Showing as Modified

**Causes**:
- Manual score changes in template
- Custom custom formats added
- Direct modifications via API

**Solutions**:
1. Review modifications in template diff
2. Decide: keep custom, sync new, or smart merge
3. If modifications no longer needed, sync with "replace" strategy
4. `hasUserModifications` flag will reset after full replacement

---

## Future Enhancements

### Potential Improvements

1. **Deployment Queue**:
   - Queue deployments instead of synchronous execution
   - Better handling of multiple simultaneous updates

2. **Rollback Support**:
   - One-click rollback to previous template version
   - Automatic rollback on deployment failure

3. **Selective Deployment**:
   - Choose which instances to deploy to
   - Instance groups for batch deployments

4. **Deployment Scheduling**:
   - Schedule deployments for low-traffic windows
   - Stagger deployments across instances

5. **Notification System**:
   - Email/webhook notifications on auto-sync
   - Alerts on deployment failures

6. **Conflict Resolution**:
   - Better handling of conflicting changes
   - Three-way merge for complex modifications

---

## Related Documentation

- **Testing Guide**: `/claudedocs/trash-guides-testing-guide.md`
- **API Documentation**: `/apps/api/src/routes/trash-guides/`
- **Component Documentation**: `/apps/web/src/features/trash-guides/`
- **Database Schema**: `/apps/api/prisma/schema.prisma`

---

## Support

For issues or questions:
1. Check scheduler logs in console
2. Review deployment history via API
3. Verify template sync strategy settings
4. Test with simulation scripts
5. Report issues with full logs and steps to reproduce
