# TRaSH Guides Update System - Testing Guide

**Date**: November 24, 2025
**Status**: Ready for Manual Testing

## Current System Status

✅ **API Server**: Running on port 3002
✅ **Web App**: Running on port 3000
✅ **Scheduler**: Active (12-hour interval)
✅ **Templates**: 6 total, all up-to-date
✅ **Latest TRaSH Commit**: `d11ab60e` (Nov 23, 2025)

---

## API Endpoints Verified

### 1. ✅ Scheduler Status
**Endpoint**: `GET /api/trash-guides/updates/scheduler/status`
**Status**: Working

```bash
curl http://localhost:3002/api/trash-guides/updates/scheduler/status
```

**Expected Response**:
```json
{
  "success": true,
  "data": {
    "isRunning": true,
    "nextCheckAt": "2025-11-25T01:30:41.693Z",
    "lastCheckAt": "2025-11-24T13:57:40.365Z",
    "lastCheckResult": {
      "templatesChecked": 6,
      "templatesOutdated": 0,
      "templatesAutoSynced": 0,
      "templatesNeedingAttention": 0,
      "cachesRefreshed": 12,
      "cachesFailed": 0,
      "errors": []
    }
  }
}
```

### 2. ✅ Check for Updates
**Endpoint**: `GET /api/trash-guides/updates`
**Status**: Working

```bash
curl http://localhost:3002/api/trash-guides/updates
```

**Expected Response**:
```json
{
  "success": true,
  "data": {
    "templatesWithUpdates": [],
    "latestCommit": {
      "commitHash": "d11ab60eb94ade1b5bf5921225ed248a014b5d2e",
      "commitDate": "2025-11-23T00:30:27Z",
      "commitMessage": "chore(contributors): Update CONTRIBUTORS.md"
    },
    "summary": {
      "total": 6,
      "outdated": 0,
      "upToDate": 6
    }
  }
}
```

### 3. ✅ Latest Version
**Endpoint**: `GET /api/trash-guides/updates/version/latest`
**Status**: Working

```bash
curl http://localhost:3002/api/trash-guides/updates/version/latest
```

---

## Manual Testing Checklist

### Priority 1: Update Notification Workflow

#### Test 1.1: Scheduler Status Dashboard
**Location**: http://localhost:3000/trash-guides → "Update Scheduler" tab

**Steps**:
1. Navigate to TRaSH Guides page
2. Click on "Update Scheduler" tab
3. Verify the dashboard displays:
   - ✅ Running status with pulsing indicator
   - ✅ Last check timestamp (relative time)
   - ✅ Next check countdown
   - ✅ Templates checked count (should be 6)
   - ✅ Outdated templates count (should be 0)
   - ✅ Auto-sync statistics
   - ✅ Templates needing attention count
   - ✅ Cache refresh statistics
4. Wait 60 seconds and verify auto-refresh occurs

**Expected Result**: Dashboard displays correctly with real-time data

#### Test 1.2: Manual Update Check
**Location**: http://localhost:3000/trash-guides → "Update Scheduler" tab

**Steps**:
1. Click "Trigger Check Now" button
2. Observe loading state
3. Wait for completion
4. Verify statistics update

**Expected Result**: Manual check completes successfully and updates statistics

#### Test 1.3: Template Update Banner (Simulated)
**Location**: http://localhost:3000/trash-guides → "Templates" tab

**Current State**: All templates are up-to-date, so no banners should display

**To Test with Real Updates**:
1. **Option A**: Wait for TRaSH Guides to publish new updates
2. **Option B**: Manually modify a template's `trashMetadata.commitHash` in the database to an older commit

**Steps** (if updates available):
1. Navigate to Templates tab
2. Locate template with update banner
3. Verify banner displays:
   - ✅ "Update Available" text
   - ✅ Current vs latest commit info
   - ✅ Sync strategy badge (auto/manual/notify)
   - ✅ "Modified" badge if user changes exist
   - ✅ "Can auto-sync" badge if eligible
   - ✅ "Details" toggle button
   - ✅ "View Changes" button
4. Click "Details" to expand commit information
5. Verify commit details display correctly

**Expected Result**: Update banner displays with correct information

---

### Priority 2: Template Diff Modal

#### Test 2.1: View Changes Modal
**Prerequisites**: Template with available update

**Steps**:
1. Click "View Changes" button on update banner
2. Verify modal opens with:
   - ✅ Template name
   - ✅ Version comparison (current → latest)
   - ✅ Custom format changes section
   - ✅ Score changes visualization
   - ✅ Specification changes details
3. Review added custom formats (green indicators)
4. Review removed custom formats (red indicators)
5. Review modified custom formats (yellow indicators)
6. Check score changes display

**Expected Result**: Modal displays comprehensive diff information

#### Test 2.2: Sync Actions from Modal
**Prerequisites**: Template with available update

**Steps**:
1. Open diff modal
2. Click "Sync to Latest" button
3. Verify:
   - ✅ Loading state during sync
   - ✅ Success message on completion
   - ✅ Modal closes automatically
   - ✅ Update banner disappears
   - ✅ Template is updated in list
4. Test "Keep Current" button:
   - ✅ Dismisses notification
   - ✅ Closes modal
   - ✅ Banner disappears

**Expected Result**: Sync actions work correctly and update template state

---

### Priority 3: Auto-Sync Functionality

#### Test 3.1: Auto-Sync Eligible Template
**Prerequisites**:
- Template with `syncStrategy: "auto"`
- Template has NO user modifications
- Update available for template

**Steps**:
1. Enable auto-sync in environment:
   ```
   TRASH_AUTO_SYNC_ENABLED=true
   ```
2. Restart API server
3. Trigger manual update check OR wait for scheduler
4. Verify:
   - ✅ Template automatically syncs
   - ✅ Scheduler stats show auto-synced count > 0
   - ✅ Template version updated
   - ✅ No manual intervention required

**Expected Result**: Template auto-syncs without user action

#### Test 3.2: Auto-Sync Blocked (User Modifications)
**Prerequisites**:
- Template with `syncStrategy: "auto"`
- Template HAS user modifications
- Update available for template

**Steps**:
1. Verify template marked as modified
2. Trigger update check
3. Verify:
   - ✅ Template does NOT auto-sync
   - ✅ Update banner shows "Modified" badge
   - ✅ Banner indicates manual review required
   - ✅ Template appears in "needs attention" count

**Expected Result**: Modified template requires manual review

---

### Priority 4: Sync Strategy Behaviors

#### Test 4.1: Manual Sync Strategy
**Prerequisites**: Template with `syncStrategy: "manual"`

**Steps**:
1. Wait for or trigger update check
2. Verify:
   - ✅ No update banner displays
   - ✅ Template not counted in "needs attention"
   - ✅ User must manually check for updates
3. Navigate to template details
4. Manually check version vs latest

**Expected Result**: Manual templates show no automatic notifications

#### Test 4.2: Notify Sync Strategy
**Prerequisites**: Template with `syncStrategy: "notify"`

**Steps**:
1. Trigger update check when update available
2. Verify:
   - ✅ Update banner displays
   - ✅ Template counted in "needs attention"
   - ✅ "View Changes" button available
   - ✅ No automatic syncing occurs
3. Review and manually sync or dismiss

**Expected Result**: Notification shown but no auto-sync

---

## Edge Cases & Error Scenarios

### Test 5.1: Network Errors
**Steps**:
1. Disconnect internet
2. Trigger update check
3. Verify:
   - ✅ Error message displays
   - ✅ Scheduler continues running
   - ✅ Error logged in statistics
   - ✅ Previous data still available

**Expected Result**: Graceful error handling

### Test 5.2: Scheduler Restart
**Steps**:
1. Restart API server
2. Verify:
   - ✅ Scheduler initializes correctly
   - ✅ Immediate update check runs
   - ✅ Statistics reset appropriately
   - ✅ Next check scheduled correctly

**Expected Result**: Scheduler recovers cleanly

### Test 5.3: Concurrent Updates
**Steps**:
1. Trigger multiple update checks rapidly
2. Verify:
   - ✅ Requests queued correctly
   - ✅ No race conditions
   - ✅ Data consistency maintained
   - ✅ All checks complete successfully

**Expected Result**: System handles concurrent requests

---

## Database State Testing

### Test 6.1: Template Metadata
**Query**: Check template metadata in database

```sql
SELECT
  id,
  name,
  syncStrategy,
  isModified,
  trashMetadata
FROM TrashTemplate;
```

**Verify**:
- ✅ `trashMetadata.commitHash` matches template version
- ✅ `trashMetadata.sourceUrl` is valid
- ✅ `syncStrategy` is one of: auto, manual, notify
- ✅ `isModified` flag accurate

### Test 6.2: Update Notifications
**Query**: Check notifications table

```sql
SELECT
  id,
  type,
  status,
  data
FROM Notification
WHERE type = 'TRASH_UPDATE_AVAILABLE';
```

**Verify**:
- ✅ Notifications created for outdated templates
- ✅ Notification data includes commit info
- ✅ Status updates correctly (pending → read → dismissed)

---

## Performance Testing

### Test 7.1: Update Check Performance
**Steps**:
1. Note start time
2. Trigger update check with 6 templates
3. Note completion time
4. Verify:
   - ✅ Check completes in < 10 seconds
   - ✅ API remains responsive during check
   - ✅ UI doesn't freeze or lag

**Expected Result**: Fast, responsive update checks

### Test 7.2: Cache Performance
**Steps**:
1. First API call (cold cache)
2. Second API call (warm cache)
3. Compare response times
4. Verify:
   - ✅ Cached responses significantly faster
   - ✅ Cache hit rate > 80%
   - ✅ Cache refresh statistics accurate

**Expected Result**: Effective caching strategy

---

## UI/UX Testing

### Test 8.1: Responsive Design
**Steps**:
1. Test on desktop (1920x1080)
2. Test on tablet (768px)
3. Test on mobile (375px)
4. Verify:
   - ✅ Scheduler dashboard responsive
   - ✅ Update banners responsive
   - ✅ Diff modal responsive
   - ✅ All buttons accessible

**Expected Result**: Works on all screen sizes

### Test 8.2: Loading States
**Steps**:
1. Trigger slow operation (manual check)
2. Verify:
   - ✅ Loading spinner displays
   - ✅ Buttons disabled during loading
   - ✅ Clear loading indication
   - ✅ Smooth transition to complete state

**Expected Result**: Clear loading feedback

### Test 8.3: Error Messages
**Steps**:
1. Force error scenario (disconnect network)
2. Verify:
   - ✅ Clear error message
   - ✅ Actionable guidance
   - ✅ Error dismissible
   - ✅ System remains functional

**Expected Result**: User-friendly error handling

---

## Integration Testing

### Test 9.1: End-to-End Update Flow
**Complete workflow test**:

1. **Initial State**: All templates up-to-date
2. **Update Available**: New TRaSH commit published
3. **Scheduler Runs**: Automatic check detects update
4. **Notification**: Update banner appears
5. **User Review**: Click "View Changes"
6. **Diff Modal**: Review changes
7. **Sync Decision**: Click "Sync to Latest"
8. **Template Update**: Template synced successfully
9. **Verification**: Banner disappears, template updated

**Expected Result**: Complete flow works seamlessly

### Test 9.2: Multiple Template Updates
**Steps**:
1. Have multiple templates with updates
2. Trigger update check
3. Verify:
   - ✅ All outdated templates detected
   - ✅ Banners display for each
   - ✅ Statistics accurate
   - ✅ Can review/sync individually
   - ✅ Bulk auto-sync works (if enabled)

**Expected Result**: Handles multiple updates correctly

---

## Testing Summary

### ✅ Completed Tests
- [x] API endpoints functional
- [x] Scheduler running
- [x] Update check working
- [x] Version tracking working

### ⏳ Pending Manual Tests
- [ ] Scheduler status dashboard UI
- [ ] Template update banners
- [ ] Template diff modal
- [ ] Sync actions
- [ ] Auto-sync functionality
- [ ] Error handling
- [ ] Performance validation
- [ ] Responsive design
- [ ] End-to-end workflow

### 🎯 Test Execution Strategy

**Phase 1**: Test with current state (all up-to-date)
- Verify UI components render correctly
- Test dashboard functionality
- Validate API responses

**Phase 2**: Simulate update scenario
- Option A: Modify database to create "outdated" template
- Option B: Wait for real TRaSH update
- Test complete update workflow

**Phase 3**: Error and edge cases
- Network failures
- Concurrent operations
- Scheduler restarts

**Phase 4**: Performance and polish
- Response times
- Cache effectiveness
- UI/UX refinements

---

## Testing Scripts

### List Templates
View all TRaSH Guides templates with their version info:

```bash
cd apps/api && pnpm exec tsx ../../scripts/list-templates.ts
```

**Output**: Displays all 43 templates with:
- ID (for use in simulation script)
- Service type (RADARR/SONARR)
- Sync strategy (auto/manual/notify)
- Modification status
- Current commit hash
- Last sync date

### Simulate Outdated Template
Artificially set a template to an old commit to test update workflow:

```bash
# List templates first to get ID
cd apps/api && pnpm exec tsx ../../scripts/list-templates.ts

# Simulate outdated template
cd apps/api && pnpm exec tsx ../../scripts/simulate-outdated-template.ts <templateId>
```

**Example**:
```bash
# Use a template ID from the list
cd apps/api && pnpm exec tsx ../../scripts/simulate-outdated-template.ts cmi640enu0000ogknbujvrhhf
```

**What it does**:
1. Sets template's commit hash to an old version (`abc123def456`)
2. Makes the template appear outdated
3. Allows testing of update banners and diff modals

**Next steps after running**:
1. Go to http://localhost:3000/trash-guides → "Update Scheduler" tab
2. Click "Trigger Check Now"
3. Wait for check to complete
4. Go to "Templates" tab to see update banner

**Important**: All current templates have `NULL` commit hashes, so they won't show as outdated until synced at least once or manually set.

## Next Steps

1. **Manual UI Testing**: Navigate to http://localhost:3000/trash-guides
2. **Test Scheduler Dashboard**: Verify real-time updates
3. **Simulate Outdated Template**: Use the script above to create a test scenario
4. **Test Update Banner**: Verify banner displays correctly
5. **Test Diff Modal**: Review changes display
6. **Test Sync Actions**: Try "Sync to Latest" and "Keep Current"
7. **Document Findings**: Note any issues or improvements

---

## Notes

- All templates currently up-to-date (0 outdated / 6 total)
- Latest TRaSH commit: `d11ab60e` (Nov 23, 2025)
- Auto-sync currently disabled (safe default)
- Scheduler runs every 12 hours
- Next scheduled check: ~12 hours from last run
