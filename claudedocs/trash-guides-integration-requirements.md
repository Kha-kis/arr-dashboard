# TRaSH Guides Integration - Requirements Specification

**Project**: Arr Dashboard
**Feature**: TRaSH Guides Synchronization
**Version**: 1.0
**Date**: 2025-01-04
**Status**: Requirements Complete - Ready for Implementation

---

## Executive Summary

### Vision
Implement a "one-click security update" style system for applying TRaSH Guides' expert Radarr/Sonarr configurations directly from the Arr Dashboard. Users can browse, customize, and deploy expert-curated Custom Formats, Quality Profiles, and other configurations with confidence through automatic backups, conflict resolution, and template management.

### Core Value Proposition
- **Instant Expertise**: Apply community-vetted configurations without manual JSON editing
- **Safety First**: Automatic backups and one-click rollback eliminate risk
- **Template System**: Create once, deploy to multiple instances consistently
- **Smart Updates**: Auto-detect TRaSH updates with intelligent diff visualization
- **Full Control**: Selective application with granular customization options

### Success Metrics
- **Adoption**: 60%+ of users sync at least one TRaSH config within first month
- **Confidence**: <5% rollback rate indicates successful conflict resolution UX
- **Efficiency**: Average sync time <30 seconds for manual operations
- **Reliability**: 95%+ sync success rate with proper error handling

---

## Feature Overview

### What is TRaSH Guides?
TRaSH Guides provides expert-maintained configurations for Radarr/Sonarr that optimize media quality, file naming, and download decisions. Their configurations are stored as JSON files in the GitHub repository: https://github.com/TRaSH-Guides/Guides

### Integration Scope

**Data Sources:**
- Repository: `https://github.com/TRaSH-Guides/Guides`
- Metadata: `https://raw.githubusercontent.com/TRaSH-Guides/Guides/master/metadata.json`

**Configuration Types (Radarr & Sonarr):**
1. Custom Formats (`docs/json/{radarr|sonarr}/cf/*.json`)
2. Custom Format Groups (`docs/json/{radarr|sonarr}/cf-groups/*.json`)
3. Quality Size Settings (`docs/json/{radarr|sonarr}/quality-size/*.json`)
4. Naming Schemes (`docs/json/{radarr|sonarr}/naming/*.json`)

---

## Detailed Requirements

### 1. User Experience & Selection Model

**Requirement**: Selective/Custom Configuration Selection

**User Flow:**
1. User navigates to "TRaSH Guides" top-level page
2. System displays categorized TRaSH configurations with search/filter
3. User browses and selects desired configs via interactive checklist:
   ```
   Custom Formats (24 available)
   ├─ [✓] TRaSH-4K-HDR (Score: 100)
   ├─ [ ] TRaSH-Dolby-Vision (Score: 150)
   ├─ [✓] TRaSH-Web-DL-Tier-01 (Score: 75)
   └─ [ ] TRaSH-Anime-Bluray (Score: 90)

   Custom Format Groups (8 available)
   ├─ [✓] 4K Optimized Bundle
   │   └─ Excludes: "HD-1080p Quality Profile", "SD Profile"
   └─ [ ] Anime Collection
   ```
4. User can preview each config's details (conditions, scores, requirements)
5. Selected configs are added to sync queue

**UI Requirements:**
- Category tabs: Custom Formats | CF Groups | Quality Size | Naming
- Search bar with real-time filtering
- Bulk selection: "Select All in Category", "Deselect All"
- Visual indicators: New, Updated, Already Applied
- Count badges: "12 selected / 24 available"

---

### 2. Conflict Management

**Requirement**: User-Controlled Conflict Resolution with Smart Recommendations

**Conflict Detection:**
- Before applying any config, check if matching name/ID exists in target instance
- Compare by: Name (exact match), or Custom Format ID if available

**Resolution Flow:**
1. **Detection**: System identifies conflicts during pre-sync validation
2. **Smart Analysis**:
   - Compare modification dates (user's vs TRaSH's)
   - Analyze changes (score differences, new conditions, removed conditions)
   - Generate recommendation with reasoning
3. **User Prompt** (for each conflict):
   ```
   "HDR Format" Conflict Detected

   Recommendation: Replace with TRaSH version
   Reason: TRaSH version has updated HDR10+ detection

   Your Current:           TRaSH Version:
   Score: 80               Score: 100
   Conditions: 3           Conditions: 5
   Last Modified: 6 mo ago TRaSH Updated: 2 wks ago

   [Use TRaSH (Recommended)] [Keep Mine] [View Full Details] [Skip]
   ```
4. **Bulk Actions**: "Apply recommendation to all conflicts" option

**Resolution Options:**
- **Use TRaSH**: Replace existing with TRaSH version
- **Keep Mine**: Skip this config, keep user's existing version
- **View Full Details**: Show complete side-by-side diff
- **Skip**: Don't apply this config at all

---

### 3. MVP Scope & Phased Implementation

**Phase 1 (MVP): Custom Formats + Custom Format Groups**

**Justification**: These are foundational - Quality Profiles depend on Custom Formats and CF Groups

**Deliverables:**
- Browse and select TRaSH Custom Formats
- Browse and select TRaSH Custom Format Groups
- Handle CF Group "exclude" logic (showing which quality profiles each group doesn't apply to)
- Template creation with CFs and CF Groups
- Sync to Radarr/Sonarr instances
- Automatic backup and rollback
- Conflict resolution UI
- Sync history logging

**Phase 2: Quality Size Settings**

**Deliverables:**
- Browse and apply TRaSH Quality Size configurations
- Add to template system
- Sync quality size settings to instances

**Phase 3: Naming Schemes**

**Deliverables:**
- Browse and apply TRaSH Naming Schemes
- Add to template system
- Sync naming configurations to instances

**Phase 4 (Future): Quality Profiles**

**Note**: Quality Profiles will come after CF Groups are stable, as they depend on Custom Formats being properly configured

---

### 4. Update Behavior

**Requirement**: Hybrid Auto-Detection + Scheduled Sync

**Manual Sync:**
- User clicks "Sync from TRaSH Guides" anytime
- System fetches latest TRaSH data from GitHub
- Shows diff of what changed since last sync
- User reviews and approves changes
- Immediate application

**Auto-Detection:**
- System checks for TRaSH updates every 12 hours (configurable)
- If updates detected, shows notification:
  ```
  🔔 TRaSH Guides Updated
  3 Custom Formats have new versions available
  [Review Changes] [Dismiss]
  ```
- User can review diff and manually apply

**Scheduled Auto-Sync:**
- User sets sync schedule per template or per instance:
  - Daily / Weekly / Monthly
  - "Auto-apply TRaSH updates on schedule" toggle
- If user hasn't manually synced within schedule period, auto-sync triggers
- Always shows diff before applying (stored in sync history for review)
- Notification after scheduled sync: "✓ TRaSH sync completed for Radarr Main (12 configs updated)"

**Configuration Options:**
```
Sync Settings:
├─ Check for updates: Every 12 hours (default)
├─ Auto-sync schedule: Weekly (default), Daily, Monthly, Disabled
├─ Auto-apply updates: [✓] Yes [ ] Notify only
└─ Notification preferences: [✓] Desktop [ ] Email
```

---

### 5. Multi-Instance Support

**Requirement**: Template-Based Deployment System

**Template Concept:**
- A template is a named collection of TRaSH configurations with user customizations
- Templates can be deployed to any compatible Radarr/Sonarr instance
- Templates maintain consistency across multiple instances

**Template Workflow:**

**Creation:**
1. User selects TRaSH configs (Custom Formats, CF Groups)
2. Customizes scores and enables/disables conditions
3. Saves as template: "4K Optimized", "Anime Setup", "Storage Saver"
4. Template stored in database with all customizations

**Deployment:**
1. User selects template: "4K Optimized"
2. Selects target instances:
   ```
   Deploy "4K Optimized" to:
   [✓] Radarr Main (4K)
   [✓] Radarr Secondary (4K)
   [ ] Radarr 1080p (incompatible - missing quality profiles)
   [ ] Sonarr Anime (wrong service type)
   ```
3. System validates compatibility for each instance
4. Shows deployment preview with conflicts per instance
5. User approves
6. Sequential deployment with real-time progress

**Template Management:**
- List all templates with metadata (created, last used, instances using it)
- Edit template (updates don't auto-apply to instances)
- Delete template (with warning if instances are using it)
- Duplicate template (create variant)
- Export/Import templates (JSON format for sharing)

**Template Benefits:**
- Create once, deploy many times
- Maintain consistency across instance fleet
- Easy to update and re-deploy
- Shareable configurations

---

### 6. Rollback & Backup Strategy

**Requirement**: Automatic Backup with One-Click Rollback

**Backup Triggers:**
- **Before every sync**: Automatic snapshot of current instance configs
- Captured data:
  - All Custom Formats (full JSON)
  - All Custom Format Groups (if applicable)
  - Quality Size Settings (Phase 2)
  - Naming Schemes (Phase 3)
  - Metadata: timestamp, instance details, user who initiated

**Backup Storage:**
- Store in database as JSON blobs (compressed)
- Retention policy: Keep last 10 backups per instance (configurable)
- Option to manually create backup: "Snapshot Current Config"

**Rollback Process:**
1. User navigates to Sync History
2. Finds sync operation to rollback
3. Clicks "Rollback to this point"
4. System shows diff: what will be restored vs current state
5. User confirms
6. System:
   - Creates backup of current state (safety net)
   - Restores previous configs via Radarr/Sonarr API
   - Verifies restoration success
   - Logs rollback operation

**Rollback UI:**
```
Sync History - Radarr Main

┌─────────────────────────────────────────────────┐
│ 2025-01-04 14:30 | TRaSH Sync - "4K Optimized" │
│ Applied: 12 Custom Formats, 2 CF Groups         │
│ [View Details] [Rollback to Before This]       │
└─────────────────────────────────────────────────┘
│ 2025-01-03 10:15 | Manual Sync                  │
│ Applied: 5 Custom Formats                       │
│ [View Details] [Rollback to Before This]       │
└─────────────────────────────────────────────────┘
```

**Safety Features:**
- Can't rollback to a backup older than last rollback (prevents loops)
- Rollback creates new backup first (can undo rollback)
- Warning if >24 hours old: "Are you sure? This will lose recent changes"

---

### 7. Sync Status & Progress Tracking

**Requirement**: Real-Time Progress + Persistent History

**Manual Sync - Real-Time Progress:**
```
Syncing "4K Optimized" to Radarr Main

[████████████████░░░░] 75%

✓ Fetching TRaSH Guides data
✓ Validating configurations
✓ Creating backup snapshot
▶ Applying Custom Formats (9/12)
  ├─ ✓ TRaSH-4K-HDR
  ├─ ✓ TRaSH-DV-HDR10
  ├─ ⏳ TRaSH-WEB-Tier-01 (retrying...)
  └─ ⏸ TRaSH-Remux (queued)
⏸ Applying CF Groups (pending)
⏸ Finalizing sync (pending)

[Cancel Sync]
```

**Progress Elements:**
- Overall progress bar with percentage
- Step-by-step status indicators (✓, ▶, ⏳, ✗, ⏸)
- Real-time updates via WebSocket or polling
- Estimated time remaining
- Cancel button (with confirmation and auto-rollback)

**Background Job - Sync History:**
```
Scheduled Sync History

Filter: [All Instances ▾] [Last 30 Days ▾]

┌──────────────────────────────────────────────────┐
│ 2025-01-04 02:00 | Auto-Sync (Scheduled)        │
│ Radarr Main | Template: "4K Optimized"          │
│ Status: ✓ Success (12/12 applied)               │
│ Duration: 28 seconds                             │
│ [View Details] [Rollback]                       │
└──────────────────────────────────────────────────┘
│ 2025-01-03 02:00 | Auto-Sync (Scheduled)        │
│ Radarr Secondary | Template: "4K Optimized"     │
│ Status: ⚠ Partial Success (11/12 applied)       │
│ Failed: TRaSH-HDR-Format (API timeout)           │
│ Duration: 45 seconds                             │
│ [View Details] [Retry Failed] [Rollback]       │
└──────────────────────────────────────────────────┘
```

**History Features:**
- Filterable by: instance, template, status, date range
- Sortable by: timestamp, duration, success rate
- Expandable details: full log, applied configs, errors
- Actions: View, Rollback, Retry (for failed items)
- Export history (CSV, JSON)

---

### 8. Data Validation & Error Handling

**Requirement**: Layered Defense with Pre-Validation, Retry, and Graceful Degradation

**Layer 1: Pre-Validation (Option D)**

**Before applying anything:**
1. **Schema Validation**: Validate TRaSH JSON against expected schema
2. **API Compatibility**: Check if target Radarr/Sonarr version supports features
3. **Dependency Check**: Ensure Custom Formats exist before applying CF Groups
4. **Conflict Detection**: Identify all naming/ID conflicts
5. **Size Check**: Verify payload size within API limits

**Validation Failures:**
- Block sync if critical validation fails
- Show detailed error: "TRaSH-HDR-Format uses 'HDR10+' condition not supported in Radarr v3.x. Upgrade Radarr or exclude this format."
- Allow user to exclude problematic items and continue

**Layer 2: Apply with Retry (Option C)**

**During application:**
1. **Sequential Application**: Apply configs one-by-one to isolate failures
2. **Auto-Retry**: On failure, retry up to 3 times with exponential backoff (1s, 2s, 4s)
3. **Transient Error Detection**: Distinguish between retryable (timeout, 429 rate limit) and permanent (400 bad request) errors
4. **Interactive Prompts** (manual sync only):
   ```
   Failed to apply "TRaSH-HDR-Format" after 3 attempts
   Error: API timeout (Radarr may be unresponsive)

   [Retry Now] [Skip This Format] [Abort Entire Sync]
   ```

**Layer 3: Partial Success for Background Jobs (Option B)**

**Scheduled/background syncs:**
- Allow partial success (some configs applied, some failed)
- Continue trying all configs even if some fail
- Generate detailed report:
  ```
  Scheduled Sync Report - Radarr Main

  ✓ Successfully Applied (11/13):
    - TRaSH-4K-HDR
    - TRaSH-DV-HDR10
    - ... (9 more)

  ✗ Failed (2/13):
    - TRaSH-WEB-Tier-01 (API timeout after 3 retries)
    - TRaSH-Remux-Tier-02 (Invalid regex in condition)

  [View Full Log] [Retry Failed Items] [Rollback All]
  ```
- Notification: "⚠ TRaSH sync partially successful (11/13). View details →"

**Error Categorization:**
- **Retryable**: Timeouts, 429 rate limits, 503 service unavailable
- **User Fixable**: API key invalid, Radarr version too old, missing dependencies
- **Config Issues**: Invalid JSON, unsupported conditions, malformed regex
- **Unknown**: Log for investigation, don't block user

---

### 9. UI Integration & Navigation

**Requirement**: Top-Level "TRaSH Guides" Page

**Navigation Structure:**
```
Arr Dashboard
├─ Dashboard
├─ Calendar
├─ Library
├─ Statistics
├─ Discover
├─ TRaSH Guides  ← NEW
│   ├─ Browse Configs
│   ├─ Templates
│   ├─ Sync History
│   └─ Settings
└─ Settings
```

**TRaSH Guides Page Layout:**

**Main View - Browse Configs:**
```
┌─────────────────────────────────────────────────┐
│ TRaSH Guides Configuration Manager              │
│                                                  │
│ [Radarr ▼] [Custom Formats ▼] [🔍 Search...]   │
│                                                  │
│ ┌─ Custom Formats ─────────────────────────┐   │
│ │ [✓] TRaSH-4K-HDR           Score: 100    │   │
│ │     Last Updated: 2 weeks ago            │   │
│ │     [Preview] [Customize]                │   │
│ │                                           │   │
│ │ [ ] TRaSH-Dolby-Vision     Score: 150    │   │
│ │     Last Updated: 1 week ago  🆕 New     │   │
│ │     [Preview] [Customize]                │   │
│ │                                           │   │
│ │ [✓] TRaSH-WEB-DL-Tier-01   Score: 75     │   │
│ │     Last Updated: 3 days ago ↑ Updated   │   │
│ │     [Preview] [Customize]                │   │
│ └───────────────────────────────────────────┘   │
│                                                  │
│ Selected: 2 configs                              │
│ [Save as Template] [Deploy to Instances]        │
└─────────────────────────────────────────────────┘
```

**Templates View:**
```
┌─────────────────────────────────────────────────┐
│ My Templates                     [+ New Template]│
│                                                  │
│ ┌─ 4K Optimized ───────────────────────────┐   │
│ │ 12 Custom Formats, 2 CF Groups            │   │
│ │ Used by: Radarr Main, Radarr Secondary    │   │
│ │ Last Updated: 2 days ago                  │   │
│ │ [Edit] [Deploy] [Duplicate] [Delete]     │   │
│ └───────────────────────────────────────────┘   │
│                                                  │
│ ┌─ Anime Setup ─────────────────────────────┐   │
│ │ 8 Custom Formats, 1 CF Group              │   │
│ │ Used by: Sonarr Anime                     │   │
│ │ Last Updated: 1 week ago                  │   │
│ │ [Edit] [Deploy] [Duplicate] [Delete]     │   │
│ └───────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

**Sync History View:**
```
┌─────────────────────────────────────────────────┐
│ Sync History                                     │
│ [All Instances ▼] [Last 30 Days ▼] [Export]    │
│                                                  │
│ ┌─ 2025-01-04 14:30 ───────────────────────┐   │
│ │ Manual Sync: "4K Optimized" → Radarr Main │   │
│ │ Status: ✓ Success (12/12)                 │   │
│ │ Duration: 28s                             │   │
│ │ [Details] [Rollback]                      │   │
│ └───────────────────────────────────────────┘   │
│                                                  │
│ ┌─ 2025-01-04 02:00 ───────────────────────┐   │
│ │ Auto-Sync: "4K Optimized" → Radarr Main   │   │
│ │ Status: ⚠ Partial (11/12)                 │   │
│ │ Failed: 1 (API timeout)                   │   │
│ │ Duration: 45s                             │   │
│ │ [Details] [Retry Failed] [Rollback]      │   │
│ └───────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

### 10. Template System with Customization

**Requirement**: Template Creation, Editing, and Deployment with Score + Condition Toggle

**Template Structure:**
```json
{
  "id": "tmpl_abc123",
  "name": "4K Optimized",
  "description": "TRaSH-optimized configs for 4K Radarr instances",
  "serviceType": "RADARR",
  "createdAt": "2025-01-04T10:00:00Z",
  "updatedAt": "2025-01-04T14:30:00Z",
  "configs": {
    "customFormats": [
      {
        "trashId": "trash-4k-hdr",
        "name": "TRaSH-4K-HDR",
        "scoreOverride": 100,
        "conditionsEnabled": {
          "hdr10": true,
          "hdr10Plus": true,
          "dolbyVision": false
        },
        "originalTrashConfig": { /* full TRaSH JSON */ }
      }
    ],
    "customFormatGroups": [
      {
        "trashId": "trash-4k-bundle",
        "name": "4K Optimized Bundle",
        "enabled": true,
        "originalTrashConfig": { /* full TRaSH JSON */ }
      }
    ]
  },
  "instances": [
    "inst_radarr_main",
    "inst_radarr_secondary"
  ]
}
```

**Customization Capabilities:**

**Score Override:**
- User can adjust Custom Format score (0-10000)
- Default: TRaSH recommended score
- UI: Slider or number input with reset button

**Condition Enable/Disable:**
- Each Custom Format has multiple conditions (regex patterns, requirements)
- User can toggle individual conditions on/off
- Disabled conditions are excluded from sync
- UI: Expandable list with checkboxes
  ```
  TRaSH-4K-HDR (Score: 100)
  ├─ [✓] HDR10 detection
  ├─ [✓] HDR10+ detection
  ├─ [ ] Dolby Vision (disabled by user)
  └─ [✓] Resolution: 2160p
  ```

**Limitations (Phase 1):**
- ❌ Cannot modify regex patterns
- ❌ Cannot add new conditions
- ❌ Cannot change condition logic (AND/OR)
- ✅ Can adjust scores
- ✅ Can enable/disable existing conditions
- ✅ Can include/exclude entire Custom Formats

**Template Operations:**

**Create:**
1. Browse TRaSH configs
2. Select desired configs
3. Customize scores and conditions
4. Click "Save as Template"
5. Enter name and description
6. Template saved to database

**Edit:**
1. Select template from list
2. Modify config selections
3. Adjust scores and conditions
4. Save changes
5. Warning: "This won't update instances already using this template. Deploy again to apply changes."

**Deploy:**
1. Select template
2. Choose target instances
3. Review conflicts per instance
4. Approve deployment
5. Real-time progress tracking
6. Success confirmation

**Duplicate:**
- Creates copy with "-Copy" suffix
- Allows creating variants without modifying original

**Delete:**
- Checks if any instances reference this template
- Warning: "2 instances use this template. Are you sure?"
- Soft delete: mark as deleted but keep in database for history

**Export/Import:**
- Export template as JSON file
- Share with community or backup
- Import validates schema and TRaSH IDs

---

### 11. TRaSH Guides Data Fetching & Caching

**Requirement**: Smart Caching with 12-Hour Auto-Refresh

**Caching Strategy:**

**Initial Load:**
1. On first access to TRaSH Guides page, fetch from GitHub
2. Store in database with timestamp
3. Display cached data to user

**Auto-Refresh:**
- Background job runs every 12 hours
- Fetches latest TRaSH data from GitHub
- Compares with cached version
- If changes detected:
  - Update cache
  - Increment version number
  - Trigger notification to active users
- If no changes:
  - Update last-checked timestamp
  - Continue using cache

**Manual Refresh:**
- "🔄 Refresh from TRaSH Guides" button on page
- User-triggered fetch overrides cache
- Shows loading indicator during fetch
- Updates cache with fresh data

**Cache Structure:**
```sql
TrashCache {
  id: "cache_radarr_cf"
  serviceType: "RADARR"
  configType: "CUSTOM_FORMATS"
  data: JSON (compressed)
  version: 42
  fetchedAt: 2025-01-04T14:00:00Z
  lastCheckedAt: 2025-01-04T14:30:00Z
}
```

**GitHub API Integration:**
- Use GitHub API for metadata and file listings
- Use raw.githubusercontent.com for JSON content
- Handle rate limiting (5000 req/hour for authenticated)
- Fallback to cached data if GitHub unavailable

**Data Freshness Indicators:**
```
TRaSH Guides - Custom Formats
Last updated: 2 hours ago
[🔄 Refresh Now]

If auto-refresh detected changes:
[🔔 Updates Available (3 configs updated) - Click to refresh]
```

**Error Handling:**
- If GitHub fetch fails, use cached data
- Show warning: "Using cached data (12 hours old). GitHub unavailable."
- Retry fetch after 1 hour
- Log errors for monitoring

---

### 12. Database Schema Design

**Requirement**: Hybrid Approach - Normalized Metadata + JSON Blobs

**New Tables:**

```prisma
// TRaSH Guides cache storage
model TrashCache {
  id            String      @id @default(cuid())
  serviceType   ServiceType // RADARR, SONARR
  configType    String      // CUSTOM_FORMATS, CF_GROUPS, QUALITY_SIZE, NAMING
  data          String      // JSON blob (compressed with zlib)
  version       Int         @default(1)
  fetchedAt     DateTime    @default(now())
  lastCheckedAt DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  @@unique([serviceType, configType])
  @@index([serviceType, configType])
  @@map("trash_cache")
}

// User-created templates
model TrashTemplate {
  id          String      @id @default(cuid())
  userId      String
  name        String
  description String?
  serviceType ServiceType // RADARR, SONARR
  configData  String      // JSON blob with customizations
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt
  deletedAt   DateTime?   // Soft delete

  syncHistory TrashSyncHistory[]
  schedules   TrashSyncSchedule[]

  @@index([userId])
  @@index([serviceType])
  @@map("trash_templates")
}

// Sync operation history
model TrashSyncHistory {
  id          String    @id @default(cuid())
  instanceId  String
  templateId  String?
  userId      String
  syncType    String    // MANUAL, SCHEDULED
  status      String    // SUCCESS, PARTIAL_SUCCESS, FAILED
  startedAt   DateTime  @default(now())
  completedAt DateTime?
  duration    Int?      // seconds

  // Sync details
  configsApplied   Int @default(0)
  configsFailed    Int @default(0)
  configsSkipped   Int @default(0)

  // JSON blobs
  appliedConfigs String  // JSON array of applied config IDs
  failedConfigs  String? // JSON array with error details
  errorLog       String? // Full error log

  // Rollback reference
  backupId       String?
  rolledBack     Boolean @default(false)
  rolledBackAt   DateTime?

  instance   ServiceInstance   @relation(fields: [instanceId], references: [id], onDelete: Cascade)
  template   TrashTemplate?    @relation(fields: [templateId], references: [id], onDelete: SetNull)
  backup     TrashBackup?      @relation(fields: [backupId], references: [id], onDelete: SetNull)

  @@index([instanceId])
  @@index([templateId])
  @@index([userId])
  @@index([startedAt])
  @@map("trash_sync_history")
}

// Backup snapshots before sync
model TrashBackup {
  id         String      @id @default(cuid())
  instanceId String
  userId     String
  backupData String      // JSON blob (compressed) - full instance config snapshot
  createdAt  DateTime    @default(now())
  expiresAt  DateTime?   // Auto-delete after retention period

  instance    ServiceInstance    @relation(fields: [instanceId], references: [id], onDelete: Cascade)
  syncHistory TrashSyncHistory[]

  @@index([instanceId])
  @@index([createdAt])
  @@map("trash_backups")
}

// Sync schedule configuration
model TrashSyncSchedule {
  id          String      @id @default(cuid())
  instanceId  String?
  templateId  String?
  userId      String
  enabled     Boolean     @default(true)

  // Schedule config
  frequency   String      // DAILY, WEEKLY, MONTHLY
  lastRunAt   DateTime?
  nextRunAt   DateTime?

  // Sync behavior
  autoApply   Boolean     @default(false) // Auto-apply or just notify
  notifyUser  Boolean     @default(true)

  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  instance ServiceInstance? @relation(fields: [instanceId], references: [id], onDelete: Cascade)
  template TrashTemplate?   @relation(fields: [templateId], references: [id], onDelete: Cascade)

  @@index([instanceId])
  @@index([templateId])
  @@index([nextRunAt])
  @@map("trash_sync_schedules")
}

// User preferences for TRaSH Guides
model TrashSettings {
  id                 String   @id @default(cuid())
  userId             String   @unique

  // Update check settings
  checkFrequency     Int      @default(12) // hours
  autoRefreshCache   Boolean  @default(true)

  // Notification preferences
  notifyOnUpdates    Boolean  @default(true)
  notifyOnSyncFail   Boolean  @default(true)

  // Backup settings
  backupRetention    Int      @default(10) // number of backups to keep

  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  @@map("trash_settings")
}
```

**Updates to Existing Tables:**

```prisma
model ServiceInstance {
  // ... existing fields

  trashSyncHistory TrashSyncHistory[]
  trashBackups     TrashBackup[]
  trashSchedules   TrashSyncSchedule[]
}
```

**JSON Blob Structures:**

**TrashTemplate.configData:**
```json
{
  "customFormats": [
    {
      "trashId": "trash-4k-hdr",
      "name": "TRaSH-4K-HDR",
      "scoreOverride": 100,
      "conditionsEnabled": {
        "condition-1": true,
        "condition-2": false
      },
      "originalConfig": { /* full TRaSH JSON */ }
    }
  ],
  "customFormatGroups": [
    {
      "trashId": "trash-4k-bundle",
      "enabled": true,
      "originalConfig": { /* full TRaSH JSON */ }
    }
  ]
}
```

**TrashBackup.backupData:**
```json
{
  "timestamp": "2025-01-04T14:30:00Z",
  "instanceId": "inst_123",
  "instanceName": "Radarr Main",
  "customFormats": [ /* full CF array from Radarr API */ ],
  "customFormatGroups": [ /* if applicable */ ],
  "qualityProfiles": [ /* relevant profiles */ ]
}
```

**Data Compression:**
- Store large JSON blobs with gzip/zlib compression
- Reduces database size by ~70% for config data
- Decompress on read, compress on write
- Transparent to application logic

---

### 13. Diff Visualization

**Requirement**: Interactive Checklist with Expandable Previews

**Diff Display Components:**

**Overview Level:**
```
Changes to Apply (3 updates, 1 new, 0 removals)

Updates (3):
├─ [✓] "TRaSH-4K-HDR" - 2 changes
├─ [✓] "TRaSH-DV-HDR10" - 1 change
└─ [ ] "TRaSH-WEB-DL-Tier-01" - 3 changes

New Configs (1):
└─ [✓] "TRaSH-Anime-Bluray" - New format

[Apply Selected (3)] [Select All] [Deselect All]
```

**Expanded Detail View:**
```
[✓] "TRaSH-4K-HDR" - 2 changes ▼

    Score Change:
    100 → 150 (+50)

    Condition Changes:
    + Added: Dolby Vision detection
      Pattern: /\b(dv|dovi|dolby.?vision)\b/i

    ~ Modified: HDR10+ detection
      - Old: /\bhdr10plus\b/i
      + New: /\b(hdr10\+|hdr10plus)\b/i

    [Keep Current Score] [Keep Current Conditions]
```

**Interactive Controls:**
- **Individual checkboxes**: Apply or skip each change
- **Expand/collapse**: Show/hide details per config
- **Inline actions**:
  - "Keep Current Score" - don't apply score change
  - "Keep Current Conditions" - don't apply condition changes
  - "View Full JSON" - show complete diff
- **Bulk actions**:
  - "Select All Updates"
  - "Deselect All New"
  - "Apply Recommended" (selects all recommended changes)

**Visual Indicators:**
- `+` Green: Added content
- `-` Red: Removed content
- `~` Yellow: Modified content
- `=` Gray: Unchanged content

**Smart Summaries:**
```
Summary for "TRaSH-4K-HDR":
• Score increased by 50 points (recommended for better 4K prioritization)
• Added Dolby Vision support (new HDR variant)
• Improved HDR10+ pattern matching (more accurate detection)

Impact: High quality 4K releases will be prioritized higher
Recommendation: Apply (keeps up with evolving release standards)
```

---

### 14. Customization Capabilities

**Requirement**: Score Override + Condition Toggle

**Score Customization:**

**UI Component:**
```
TRaSH-4K-HDR
├─ Score: [___100___] (TRaSH Default: 100)
│          [  Slider  ]
│          [Reset to TRaSH Default]
└─ Range: 0 - 10000
```

**Features:**
- Numeric input with validation (0-10000)
- Slider for visual adjustment
- Display TRaSH default score
- "Reset to Default" button
- Real-time score preview in template

**Condition Toggle:**

**UI Component:**
```
TRaSH-4K-HDR Conditions

Enabled Conditions (3/4):
├─ [✓] HDR10 Detection
│   └─ Pattern: /\bhdr10\b/i
│       Requirement: Resolution >= 2160p
│
├─ [✓] HDR10+ Detection
│   └─ Pattern: /\b(hdr10\+|hdr10plus)\b/i
│
├─ [ ] Dolby Vision (disabled by you)
│   └─ Pattern: /\b(dv|dovi|dolby.?vision)\b/i
│       ℹ️ Disabled because your releases rarely have DV
│
└─ [✓] Resolution: 2160p
    └─ Minimum: 2160p, Maximum: 4320p

[Expand All] [Collapse All]
```

**Features:**
- Checkbox to enable/disable each condition
- Show regex pattern (read-only)
- Show condition requirements (read-only)
- User can add note for why disabled
- Visual indicator of enabled vs disabled
- Count: "3/4 conditions enabled"

**Restrictions (Phase 1):**
- ✅ Can toggle conditions on/off
- ✅ Can adjust scores
- ❌ Cannot edit regex patterns
- ❌ Cannot modify requirements
- ❌ Cannot add new conditions
- ❌ Cannot change condition logic operators

**Template Preservation:**
- User customizations stored in template
- Original TRaSH config also stored (for reset/comparison)
- Can always "Reset to TRaSH Default" for any config

---

### 15. Conflict Resolution UX

**Requirement**: Smart Recommendations with Context

**Conflict Detection Logic:**

**When Conflict Occurs:**
1. User selects TRaSH config "HDR Format"
2. System checks target instance for existing config with same name or ID
3. If match found, mark as conflict
4. Analyze both versions for recommendation

**Recommendation Algorithm:**
```javascript
function generateRecommendation(userConfig, trashConfig) {
  const factors = {
    recency: compareTimestamps(userConfig.updatedAt, trashConfig.updatedAt),
    changes: analyzeChanges(userConfig, trashConfig),
    community: trashConfig.isPopular && trashConfig.wellMaintained,
  };

  if (factors.recency === 'TRASH_NEWER' && factors.changes.hasImprovements) {
    return {
      action: 'REPLACE',
      confidence: 'HIGH',
      reason: 'TRaSH version has updated detection patterns'
    };
  }

  if (factors.recency === 'USER_NEWER') {
    return {
      action: 'KEEP_USER',
      confidence: 'MEDIUM',
      reason: 'Your version is more recent than TRaSH'
    };
  }

  // ... more logic
}
```

**Conflict Resolution Modal:**

```
┌─────────────────────────────────────────────────┐
│ Conflict Detected: "HDR Format"                 │
├─────────────────────────────────────────────────┤
│                                                  │
│ 🎯 Recommendation: Use TRaSH Version (High)     │
│                                                  │
│ Why?                                             │
│ • TRaSH updated 2 weeks ago with improved        │
│   Dolby Vision detection                         │
│ • Your version last modified 6 months ago        │
│ • TRaSH version includes HDR10+ support          │
│                                                  │
│ ┌─ Your Current ─────────┐ ┌─ TRaSH Version ─┐ │
│ │ Score: 80              │ │ Score: 100       │ │
│ │ Conditions: 3          │ │ Conditions: 5    │ │
│ │ Last Modified:         │ │ Last Updated:    │ │
│ │   6 months ago         │ │   2 weeks ago    │ │
│ │                        │ │                  │ │
│ │ Missing:               │ │ New Features:    │ │
│ │ • DV detection         │ │ • DV detection   │ │
│ │ • HDR10+ support       │ │ • HDR10+ support │ │
│ └────────────────────────┘ └──────────────────┘ │
│                                                  │
│ Impact: Better detection of modern HDR formats  │
│                                                  │
│ [Use TRaSH (Recommended)] [Keep Mine]           │
│ [View Full Diff] [Skip This Config]            │
└─────────────────────────────────────────────────┘
```

**Bulk Conflict Resolution:**

**When Multiple Conflicts:**
```
Multiple Conflicts Detected (5)

├─ [✓] HDR Format → Use TRaSH (Recommended)
├─ [✓] DV-HDR10 → Use TRaSH (Recommended)
├─ [ ] WEB-DL-Tier-01 → Keep Mine (Your version newer)
├─ [✓] Remux-Tier-01 → Use TRaSH (Recommended)
└─ [ ] Custom-Format-5 → Manual Review Required

[Apply All Recommendations] [Review Each]
```

**Features:**
- Show all conflicts in one view
- Visual indicators for recommendations
- Bulk "Apply All Recommendations" button
- Individual review for complex conflicts
- Progress tracking: "3/5 conflicts resolved"

**Recommendation Confidence Levels:**
- **High**: Clear improvement, TRaSH newer, no data loss
- **Medium**: Some trade-offs, user should review
- **Low**: Complex changes, manual review recommended
- **Manual Review**: Cannot determine best action

**Context Information:**
- Timestamps: Last modified/updated dates
- Change count: Number of differences
- Impact summary: What changes mean for matching
- User notes: If user previously customized, show why

---

## Technical Architecture

### System Components

**Frontend (Next.js):**
```
apps/web/src/features/trash-guides/
├── components/
│   ├── trash-browse.tsx          # Browse TRaSH configs
│   ├── trash-template-list.tsx   # Template management
│   ├── trash-sync-progress.tsx   # Real-time sync progress
│   ├── trash-sync-history.tsx    # Historical sync log
│   ├── trash-conflict-modal.tsx  # Conflict resolution UI
│   ├── trash-diff-viewer.tsx     # Diff visualization
│   └── trash-settings.tsx        # User preferences
├── hooks/
│   ├── use-trash-cache.ts        # TRaSH data fetching/caching
│   ├── use-trash-sync.ts         # Sync orchestration
│   ├── use-trash-templates.ts    # Template CRUD
│   └── use-trash-validation.ts   # Pre-sync validation
├── lib/
│   ├── trash-api-client.ts       # API wrapper
│   ├── trash-diff-engine.ts      # Diff computation
│   └── trash-validator.ts        # Config validation
└── types/
    └── trash.types.ts            # TypeScript interfaces
```

**Backend (Fastify):**
```
apps/api/src/
├── routes/
│   └── trash-guides/
│       ├── cache-routes.ts       # Cache management endpoints
│       ├── template-routes.ts    # Template CRUD endpoints
│       ├── sync-routes.ts        # Sync orchestration endpoints
│       ├── history-routes.ts     # Sync history endpoints
│       └── backup-routes.ts      # Backup/rollback endpoints
├── lib/
│   └── trash-guides/
│       ├── github-fetcher.ts     # Fetch from TRaSH repo
│       ├── sync-engine.ts        # Core sync logic
│       ├── backup-manager.ts     # Backup creation/restoration
│       ├── validator.ts          # Pre-sync validation
│       ├── diff-calculator.ts    # Change detection
│       └── radarr-sonarr-api.ts  # Instance API clients
├── jobs/
│   └── trash-sync-scheduler.ts   # Background sync jobs
└── services/
    └── trash-guides-service.ts   # Business logic layer
```

### API Endpoints

**Cache Management:**
- `GET /api/trash-guides/cache/:serviceType/:configType` - Get cached data
- `POST /api/trash-guides/cache/refresh` - Manually refresh cache
- `GET /api/trash-guides/cache/status` - Cache status and version

**Templates:**
- `GET /api/trash-guides/templates` - List all templates
- `POST /api/trash-guides/templates` - Create new template
- `GET /api/trash-guides/templates/:id` - Get template details
- `PATCH /api/trash-guides/templates/:id` - Update template
- `DELETE /api/trash-guides/templates/:id` - Delete template
- `POST /api/trash-guides/templates/:id/duplicate` - Duplicate template
- `POST /api/trash-guides/templates/:id/export` - Export template as JSON
- `POST /api/trash-guides/templates/import` - Import template from JSON

**Sync Operations:**
- `POST /api/trash-guides/sync/validate` - Pre-sync validation
- `POST /api/trash-guides/sync/execute` - Execute sync
- `GET /api/trash-guides/sync/:id/status` - Get sync progress (WebSocket alternative)
- `POST /api/trash-guides/sync/:id/cancel` - Cancel running sync
- `POST /api/trash-guides/sync/:id/rollback` - Rollback sync

**Sync History:**
- `GET /api/trash-guides/history` - List sync history (paginated, filtered)
- `GET /api/trash-guides/history/:id` - Get detailed sync record
- `POST /api/trash-guides/history/:id/retry` - Retry failed items
- `DELETE /api/trash-guides/history/:id` - Delete history record

**Backups:**
- `GET /api/trash-guides/backups` - List backups for instance
- `GET /api/trash-guides/backups/:id` - Get backup details
- `POST /api/trash-guides/backups` - Manually create backup
- `POST /api/trash-guides/backups/:id/restore` - Restore from backup
- `DELETE /api/trash-guides/backups/:id` - Delete backup

**Schedules:**
- `GET /api/trash-guides/schedules` - List all schedules
- `POST /api/trash-guides/schedules` - Create schedule
- `PATCH /api/trash-guides/schedules/:id` - Update schedule
- `DELETE /api/trash-guides/schedules/:id` - Delete schedule

**Settings:**
- `GET /api/trash-guides/settings` - Get user preferences
- `PATCH /api/trash-guides/settings` - Update preferences

### Data Flow

**Manual Sync Flow:**
```
User initiates sync
    ↓
Frontend: Validate selections
    ↓
API: POST /sync/validate
    ↓
Backend: Pre-validation checks
    ↓
Frontend: Show conflicts (if any)
    ↓
User resolves conflicts
    ↓
API: POST /sync/execute
    ↓
Backend: Create backup
    ↓
Backend: Apply configs sequentially
    ↓
Backend: Update sync history
    ↓
Frontend: Show real-time progress
    ↓
Backend: Return final status
    ↓
Frontend: Show completion notification
```

**Scheduled Sync Flow:**
```
Cron job triggers (every 12 hours)
    ↓
Check if TRaSH cache needs refresh
    ↓
If outdated: Fetch from GitHub
    ↓
Compare with cached version
    ↓
If changes detected: Notify users
    ↓
For each scheduled sync:
    ↓
Check if schedule is due
    ↓
Execute sync with schedule settings
    ↓
Log to sync history
    ↓
Send notification to user
```

---

## Implementation Phases

### Phase 1: MVP - Custom Formats + Custom Format Groups

**Estimated Effort**: 3-4 weeks

**Sprint 1: Foundation (Week 1)**
- [ ] Database schema migration
- [ ] TRaSH cache fetching from GitHub
- [ ] Basic API endpoints (cache, templates)
- [ ] Frontend routing and navigation

**Sprint 2: Core Sync (Week 2)**
- [ ] Sync engine for Custom Formats
- [ ] Backup creation before sync
- [ ] Radarr/Sonarr API integration
- [ ] Basic validation logic

**Sprint 3: Template System (Week 3)**
- [ ] Template CRUD operations
- [ ] Customization UI (scores, conditions)
- [ ] Template deployment to instances
- [ ] Conflict detection logic

**Sprint 4: Polish & UX (Week 4)**
- [ ] Conflict resolution modal
- [ ] Diff visualization
- [ ] Real-time sync progress
- [ ] Sync history page
- [ ] Rollback functionality
- [ ] Error handling and retry logic

**Phase 1 Deliverables:**
- ✅ Browse and select TRaSH Custom Formats
- ✅ Browse and select TRaSH Custom Format Groups
- ✅ Create templates with customizations
- ✅ Deploy templates to instances
- ✅ Automatic backup before sync
- ✅ One-click rollback
- ✅ Conflict resolution with smart recommendations
- ✅ Real-time sync progress
- ✅ Sync history with detailed logs

### Phase 2: Quality Size Settings

**Estimated Effort**: 1 week

- [ ] Add Quality Size to TRaSH cache
- [ ] UI for browsing Quality Size configs
- [ ] Sync logic for Quality Size
- [ ] Add to template system
- [ ] Testing and validation

### Phase 3: Naming Schemes

**Estimated Effort**: 1 week

- [ ] Add Naming Schemes to TRaSH cache
- [ ] UI for browsing Naming configs
- [ ] Sync logic for Naming
- [ ] Add to template system
- [ ] Testing and validation

### Phase 4: Quality Profiles (Future)

**Estimated Effort**: 2-3 weeks

**Prerequisites**: Custom Formats and CF Groups must be stable

- [ ] Understand Quality Profile dependencies
- [ ] Handle complex CF score integration
- [ ] Quality Profile sync logic
- [ ] Comprehensive testing

---

## Technical Risks & Mitigations

### Risk 1: TRaSH Guides Schema Changes

**Risk**: TRaSH changes JSON structure, breaking our parser

**Likelihood**: Medium
**Impact**: High

**Mitigation:**
- Version-aware parsing with fallbacks
- Schema validation before caching
- Monitor TRaSH repository for changes (GitHub watch)
- Graceful degradation if parse fails
- Alert system for schema incompatibilities

### Risk 2: Radarr/Sonarr API Compatibility

**Risk**: Different Radarr/Sonarr versions have different API schemas

**Likelihood**: High
**Impact**: High

**Mitigation:**
- Detect instance version via API
- Maintain compatibility matrix (version → supported features)
- Warn users if version doesn't support certain configs
- Graceful degradation for older versions
- Comprehensive API testing across versions

### Risk 3: Partial Sync Failures

**Risk**: Sync fails midway, leaving instance in inconsistent state

**Likelihood**: Medium
**Impact**: High

**Mitigation:**
- Automatic backup before every sync (implemented)
- Transaction-like rollback on critical failures
- Idempotent sync operations (can be retried safely)
- Detailed error logging for debugging
- User notification with clear recovery steps

### Risk 4: GitHub Rate Limiting

**Risk**: Exceed GitHub API rate limits (5000/hour authenticated)

**Likelihood**: Low
**Impact**: Medium

**Mitigation:**
- Smart caching (12-hour refresh cycle)
- Use GitHub API only for metadata
- Use raw.githubusercontent.com for content (no rate limit)
- Implement exponential backoff on 429 errors
- Fallback to cached data if rate limited

### Risk 5: Large Config Data Performance

**Risk**: Syncing hundreds of Custom Formats is slow

**Likelihood**: Medium
**Impact**: Medium

**Mitigation:**
- Compress JSON blobs in database (70% size reduction)
- Pagination for large config lists
- Lazy loading for config details
- Background processing for bulk operations
- Progress indicators for user transparency

### Risk 6: User Confusion with Conflicts

**Risk**: Users don't understand conflict resolution, make wrong choices

**Likelihood**: Medium
**Impact**: Medium

**Mitigation:**
- Smart recommendations with clear reasoning (implemented)
- "Apply All Recommendations" for easy path
- Detailed diff visualization
- Rollback always available (safety net)
- Educational tooltips and help text

### Risk 7: Scheduled Sync Failures

**Risk**: Background syncs fail silently, user doesn't notice

**Likelihood**: Medium
**Impact**: Medium

**Mitigation:**
- Comprehensive sync history logging (implemented)
- Notification on every scheduled sync (success and failure)
- Retry logic for transient failures
- Dashboard widget showing last sync status
- Email notifications for critical failures (optional)

---

## Success Criteria

### User Adoption
- **Target**: 60% of active users sync at least one TRaSH config within 30 days of feature launch
- **Measurement**: Track unique users who execute at least one sync operation

### Sync Success Rate
- **Target**: 95% sync success rate (fully completed without critical errors)
- **Measurement**: `(successful_syncs / total_syncs) * 100`

### User Confidence (Low Rollback Rate)
- **Target**: <5% of syncs are rolled back
- **Measurement**: `(rollbacks / total_syncs) * 100`
- **Interpretation**: Low rollback rate indicates good conflict resolution UX and accurate recommendations

### Performance
- **Target**: Average manual sync completes in <30 seconds
- **Measurement**: Track `completedAt - startedAt` for manual syncs
- **Percentiles**: P50 <20s, P95 <45s, P99 <60s

### Template Adoption
- **Target**: 40% of users who sync create at least one template
- **Measurement**: Track unique users with `templates.count > 0`

### Multi-Instance Usage
- **Target**: 30% of syncs are template deployments to multiple instances
- **Measurement**: Track syncs where `instances.length > 1`

### Error Recovery
- **Target**: 90% of failed sync items succeed on retry
- **Measurement**: Track retry success rate for failed configs

### User Satisfaction
- **Target**: <10 bug reports per 100 active users in first month
- **Measurement**: GitHub issues tagged with `trash-guides` + `bug`

---

## Open Questions & Future Enhancements

### Open Questions (To Resolve Before Implementation)
1. Should templates be shareable between users in the same dashboard instance?
2. How to handle TRaSH deprecating/removing configs that users have applied?
3. Should we support rollback across multiple sync operations (rollback 3 syncs back)?
4. Do we need webhook support for real-time TRaSH updates?

### Future Enhancements (Post-MVP)
1. **Community Template Library**: Public repository of user-created templates
2. **Template Versioning**: Track template versions and migration paths
3. **A/B Testing**: Apply different configs to instances and compare stats
4. **Impact Analysis**: Show before/after metrics (download quality, disk usage)
5. **Conflict Auto-Resolution**: ML-based recommendation engine
6. **Batch Rollback**: Rollback multiple syncs in one operation
7. **Export/Import for Migration**: Export entire TRaSH setup for new dashboard install
8. **TRaSH Guides Comments/Ratings**: Community feedback on specific configs
9. **Custom Format Builder**: UI for creating custom formats from scratch
10. **Webhook Integration**: Real-time updates from TRaSH Guides repository

---

## Appendix

### TRaSH Guides Resources
- **Repository**: https://github.com/TRaSH-Guides/Guides
- **Documentation**: https://trash-guides.info
- **Radarr Configs**: https://github.com/TRaSH-Guides/Guides/tree/master/docs/json/radarr
- **Sonarr Configs**: https://github.com/TRaSH-Guides/Guides/tree/master/docs/json/sonarr
- **Metadata API**: https://raw.githubusercontent.com/TRaSH-Guides/Guides/master/metadata.json

### Radarr/Sonarr API Documentation
- **Radarr API**: https://radarr.video/docs/api/
- **Sonarr API**: https://sonarr.tv/docs/api/

### Related GitHub Issues
- (None yet - this is a new feature)

---

**Document Status**: ✅ Complete - Ready for Implementation Planning
**Next Steps**: Technical design, API spec finalization, Sprint planning
**Questions?**: Contact project owner or create GitHub discussion
