# TRaSH Guides Update Checker Design

## Overview
Automated system to check for TRaSH Guides updates and notify users when their templates can be synced with new configurations.

## Architecture

### 1. GitHub Version Tracking

**Current Implementation:**
- `github-fetcher.ts` fetches from: `https://raw.githubusercontent.com/TRaSH-Guides/Guides/master/`
- No commit hash or version tracking currently

**Enhancement Needed:**
- Use GitHub API to get latest commit hash for the master branch
- Store this in `TrashCache` for each config type
- Compare template's `trashGuidesCommitHash` with latest

**GitHub API Endpoints:**
```typescript
// Get latest commit on master branch
GET https://api.github.com/repos/TRaSH-Guides/Guides/commits/master

// Response includes:
{
  sha: "abc123...",  // Full commit hash
  commit: {
    author: { date: "2025-11-07T..." },
    message: "..."
  }
}
```

### 2. Database Schema (Already Exists)

**TrashTemplate** (apps/api/prisma/schema.prisma:183-223):
```prisma
model TrashTemplate {
  // Version tracking
  trashGuidesCommitHash  String?   // ✅ Already exists
  trashGuidesVersion     String?   // ✅ Already exists
  importedAt             DateTime  @default(now())
  lastSyncedAt           DateTime? // ✅ Already exists

  // Customization tracking
  hasUserModifications   Boolean   @default(false) // ✅ Already exists
  modifiedFields         String?   // JSON array
  lastModifiedAt         DateTime?
  lastModifiedBy         String?

  // Sync strategy
  syncStrategy           String    @default("notify") // ✅ Already exists
  // Options: "auto" | "manual" | "notify"
}
```

**TrashCache** (needs enhancement):
```prisma
model TrashCache {
  id               String      @id @default(cuid())
  serviceType      ServiceType
  configType       String      // QUALITY_PROFILE, CUSTOM_FORMATS, etc.
  data             String      // JSON blob
  commitHash       String?     // ADD: Latest commit hash from GitHub
  fetchedAt        DateTime    @default(now())
  expiresAt        DateTime

  @@index([serviceType, configType])
  @@index([commitHash])  // ADD: Index for version queries
}
```

### 3. Background Job System ✅

**Implemented Solution: Simple Interval (Option A)**

**Implementation Details:**
- Location: `apps/api/src/lib/trash-guides/update-scheduler.ts`
- Plugin: `apps/api/src/plugins/trash-update-scheduler.ts`
- Uses Node.js `setInterval()` in main process
- Default interval: 12 hours (configurable)
- Runs immediately on startup, then periodically
- Graceful shutdown via Fastify `onClose` hook

**Configuration (Environment Variables):**
```env
# Enable/disable scheduler (default: true)
TRASH_UPDATE_SCHEDULER_ENABLED=true

# Check interval in hours (default: 12)
TRASH_UPDATE_CHECK_INTERVAL_HOURS=12

# Enable auto-sync for unmodified templates (default: false)
TRASH_AUTO_SYNC_ENABLED=false
```

**Key Features:**
- ✅ Automatic update checks on configurable interval
- ✅ Auto-sync capability for unmodified templates (opt-in)
- ✅ Notification system via template changeLog
- ✅ Statistics tracking (last check, next check, results)
- ✅ Manual trigger endpoint for on-demand checks
- ✅ Safe defaults (auto-sync disabled to protect user modifications)

**API Endpoints:**
- `GET /api/trash-guides/updates/scheduler/status` - View scheduler statistics
- `POST /api/trash-guides/updates/scheduler/trigger` - Manually trigger check

**Future Enhancement Options:**
- **Option B: node-cron** - Standard cron syntax for complex schedules
- **Option C: Bull/BullMQ** - Persistent queue with Redis for distributed systems

### 4. Update Check Flow

```typescript
// Pseudocode for background job
async function checkForTRaSHGuidesUpdates() {
  // 1. Get latest commit hash from GitHub API
  const latestCommit = await fetchLatestCommitHash();

  // 2. Get all unique template commit hashes
  const templates = await db.trashTemplate.findMany({
    select: {
      id: true,
      trashGuidesCommitHash: true,
      syncStrategy: true,
      hasUserModifications: true
    },
    where: { deletedAt: null }
  });

  // 3. Group templates by commit hash
  const outdatedTemplates = templates.filter(
    t => t.trashGuidesCommitHash && t.trashGuidesCommitHash !== latestCommit.sha
  );

  // 4. For each outdated template, determine action
  for (const template of outdatedTemplates) {
    if (template.syncStrategy === "auto" && !template.hasUserModifications) {
      // Auto-update unmodified templates
      await autoSyncTemplate(template.id, latestCommit.sha);
    } else if (template.syncStrategy === "notify" || template.hasUserModifications) {
      // Create notification for user
      await createUpdateNotification(template.id, latestCommit.sha);
    }
    // syncStrategy === "manual": Do nothing, user handles it
  }

  // 5. Update cache commit hashes
  await updateCacheCommitHashes(latestCommit.sha);
}
```

### 5. API Endpoints ✅

**Update Check Endpoints:**

**GET /api/trash-guides/updates** ✅
```typescript
// Returns list of templates with available updates
{
  success: true,
  data: {
    templatesWithUpdates: [{
      id: "template123",
      name: "Radarr HD Profile",
      currentCommit: "abc123",
      latestCommit: "def456",
      hasUserModifications: true,
      syncStrategy: "notify",
      canAutoSync: false
    }],
    latestCommit: {
      commitHash: "def456",
      commitDate: "2025-11-07T...",
      message: "Update custom formats"
    },
    summary: {
      total: 10,
      outdated: 3,
      upToDate: 7
    }
  }
}
```

**GET /api/trash-guides/updates/attention** ✅
```typescript
// Get templates requiring manual review
{
  success: true,
  data: {
    templates: [{
      templateId: "template123",
      templateName: "Radarr HD",
      currentCommit: "abc123",
      latestCommit: "def456",
      hasUserModifications: true
    }],
    count: 1
  }
}
```

**POST /api/trash-guides/updates/:id/sync** ✅
```typescript
// Request
{
  targetCommitHash: "def456",  // Optional, defaults to latest
  strategy: "replace" | "merge" | "keep_custom"  // Optional
}

// Response
{
  success: true,
  data: {
    templateId: "template123",
    previousCommit: "abc123",
    newCommit: "def456",
    message: "Template synced successfully"
  }
}
```

**POST /api/trash-guides/updates/process-auto** ✅
```typescript
// Process all auto-sync eligible templates
{
  success: true,
  data: {
    summary: {
      processed: 5,
      successful: 4,
      failed: 1
    },
    results: [{
      templateId: "template123",
      success: true,
      previousCommit: "abc123",
      newCommit: "def456"
    }]
  }
}
```

**GET /api/trash-guides/updates/:id/diff** 🔄
```typescript
// Compare template's commit with latest (placeholder implementation)
{
  success: true,
  data: {
    hasChanges: true,
    templateCommit: "abc123",
    latestCommit: "def456",
    message: "Diff generation not yet implemented"
    // Future: detailed changes object
  }
}
```

**GET /api/trash-guides/updates/version/latest** ✅
```typescript
// Get latest TRaSH Guides commit info
{
  success: true,
  data: {
    commitHash: "def456",
    commitDate: "2025-11-07T...",
    author: "TRaSH-Guides",
    message: "Update custom formats"
  }
}
```

**Scheduler Control Endpoints:**

**GET /api/trash-guides/updates/scheduler/status** ✅
```typescript
// Get background scheduler status and statistics
{
  success: true,
  data: {
    isRunning: true,
    lastCheckAt: "2025-11-07T12:00:00Z",
    nextCheckAt: "2025-11-08T00:00:00Z",
    lastCheckResult: {
      templatesChecked: 10,
      templatesOutdated: 3,
      templatesAutoSynced: 1,
      templatesNeedingAttention: 2,
      errors: []
    }
  }
}
```

**POST /api/trash-guides/updates/scheduler/trigger** ✅
```typescript
// Manually trigger an update check (doesn't wait for interval)
{
  success: true,
  message: "Update check triggered successfully"
}
```

### 6. Notification System ✅

**Implemented Solution: changeLog JSON Storage**

The notification system stores update notifications in the `TrashTemplate.changeLog` JSON field:

```typescript
// Notification entry structure
{
  type: "update_available",
  timestamp: "2025-11-07T12:00:00Z",
  currentCommit: "abc123",
  latestCommit: "def456",
  reason: "has_user_modifications" | "notify_strategy",
  dismissed: false
}
```

**Implementation:**
- Location: `apps/api/src/lib/trash-guides/update-scheduler.ts:263-317`
- Function: `createUpdateNotifications()`
- Prevents duplicate notifications for same commit
- Deduplication: Checks if notification already exists before creating

**Future Enhancement:**
```prisma
model TrashUpdateNotification {
  id             String   @id @default(cuid())
  templateId     String
  userId         String
  currentCommit  String
  latestCommit   String
  createdAt      DateTime @default(now())
  dismissedAt    DateTime?
  appliedAt      DateTime?

  template TrashTemplate @relation(fields: [templateId], references: [id])

  @@index([userId, dismissedAt])
}
```

### 7. UI Components

**Update Banner:**
```tsx
// Show in template list
{template.hasAvailableUpdate && (
  <div className="bg-blue-500/10 border-blue-500/30 p-3 rounded">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium">Update Available</p>
        <p className="text-xs text-fg-muted">
          TRaSH Guides has new changes for this template
        </p>
      </div>
      <div className="flex gap-2">
        <button onClick={() => viewDiff(template.id)}>
          View Changes
        </button>
        <button onClick={() => syncTemplate(template.id)}>
          Update Now
        </button>
      </div>
    </div>
  </div>
)}
```

**Update Modal:**
- Side-by-side diff view
- Show what will change (added/removed/modified CFs)
- Conflict resolution UI for modified templates
- Sync strategy options

### 8. Implementation Phases

**Phase 1: GitHub API Integration** ✅ COMPLETE
- ✅ Create service to fetch latest commit hash (`version-tracker.ts`)
- ✅ Add commit hash to TrashCache schema
- ✅ Update cache fetcher to store commit hash (`cache-manager.ts`)

**Phase 2: Template Update Logic** ✅ COMPLETE
- ✅ Create template updater service (`template-updater.ts`)
- ✅ Implement update detection (compare commits)
- ✅ Auto-sync for unmodified templates
- ✅ Templates needing attention logic

**Phase 3: Background Scheduler & API** ✅ COMPLETE
- ✅ Implement interval-based scheduler (`update-scheduler.ts`)
- ✅ Fastify plugin integration (`trash-update-scheduler.ts`)
- ✅ Server registration and lifecycle management
- ✅ Configuration via environment variables
- ✅ Notification system via changeLog
- ✅ API endpoints for updates (`update-routes.ts`)
- ✅ Scheduler control endpoints (status, trigger)
- ✅ Statistics tracking

**Phase 4: Diff Generation** 🔄 PENDING
- ⏳ Fetch both versions from GitHub
- ⏳ Generate diff between commits
- ⏳ Detailed change comparison (added/removed/modified)
- 🔄 Placeholder endpoint exists (`GET /updates/:id/diff`)

**Phase 5: UI Integration** 🔄 PENDING
- ⏳ Add update indicators to template list
- ⏳ Create update notification components
- ⏳ Implement sync confirmation flow
- ⏳ Create diff viewer component
- ⏳ Scheduler status display

## Configuration ✅

**Environment Variables:**
```env
# Enable/disable scheduler (default: true)
TRASH_UPDATE_SCHEDULER_ENABLED=true

# Check interval in hours (default: 12)
TRASH_UPDATE_CHECK_INTERVAL_HOURS=12

# Enable auto-sync for unmodified templates (default: false for safety)
TRASH_AUTO_SYNC_ENABLED=false

# Optional: GitHub token for higher rate limits (5000/hour vs 60/hour)
GITHUB_TOKEN=ghp_xxxxxxxxxxxxx
```

**Configuration Details:**
- Scheduler enabled by default for automatic update checking
- 12-hour interval provides good balance of freshness vs API usage
- Auto-sync disabled by default to protect user modifications
- Only templates with `syncStrategy: "auto"` AND `hasUserModifications: false` are auto-synced

**User Settings (Future):**
```typescript
// Per-user preferences
interface TrashSettings {
  enableUpdateChecks: boolean;
  updateCheckFrequency: "hourly" | "daily" | "weekly";
  defaultSyncStrategy: "auto" | "manual" | "notify";
  notifyOnUpdates: boolean;
}
```

## Testing Strategy

**Unit Tests:**
- GitHub API client
- Diff generation logic
- Sync strategy decision logic

**Integration Tests:**
- Background job execution
- Template sync flow
- Notification creation

**Manual Testing:**
- Simulate GitHub updates
- Test all sync strategies
- Verify notification delivery

## Security Considerations

1. **Rate Limiting:**
   - Respect GitHub API rate limits (60/hour unauthenticated, 5000/hour with token)
   - Implement exponential backoff on failures

2. **Data Validation:**
   - Verify commit hashes before syncing
   - Validate fetched data structure

3. **User Control:**
   - Always allow manual override
   - Never force auto-sync on modified templates
   - Provide rollback capability

## Monitoring & Observability

**Logs:**
- Update check executions
- Auto-sync operations
- Failed syncs with reasons

**Metrics:**
- Templates checked per run
- Auto-synced count
- Notification count
- Sync failures

## Future Enhancements

1. **Webhook Support:**
   - GitHub webhook for instant notifications
   - Reduce polling frequency

2. **Change Summarization:**
   - Natural language summary of changes
   - Impact analysis (e.g., "This update adds 5 new HDR formats")

3. **Scheduled Syncs:**
   - User-defined sync windows
   - Batch updates across multiple templates

4. **Rollback Support:**
   - Store previous versions
   - One-click rollback to previous commit

5. **Smart Merging:**
   - Intelligent conflict resolution
   - Preserve user customizations while applying updates
