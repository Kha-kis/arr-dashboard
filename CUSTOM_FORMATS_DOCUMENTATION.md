# Custom Formats Feature - Complete Technical Documentation

## Overview

The `/custom-formats` feature is a unified management interface for Sonarr and Radarr custom formats across multiple instances. It provides comprehensive CRUD operations, TRaSH Guides integration, automatic synchronization, quality profile management, and scoring matrix configuration.

**Key Capabilities:**
- Manage custom formats across all Sonarr/Radarr instances from a single interface
- Import custom formats from TRaSH Guides (individual formats, CF groups, or quality profiles)
- Export/import custom formats as JSON
- Copy custom formats between instances
- Configure automatic TRaSH sync schedules per instance
- Manage quality profile scoring matrices
- Apply pre-configured TRaSH quality profiles
- Track which formats are managed by TRaSH and exclude specific formats from auto-sync

## Architecture Overview

### Frontend Architecture

**Route:** `/custom-formats` → `apps/web/app/custom-formats/page.tsx`

**Main Component:** `CustomFormatsClient` (`apps/web/src/features/custom-formats/components/custom-formats-client.tsx`)

The feature uses a **tabbed interface** with four main sections:
1. **Formats Tab** - View, create, edit, delete, import/export custom formats
2. **Scoring Tab** - Configure custom format scores in quality profiles
3. **Auto-Sync Tab** - Configure automatic TRaSH synchronization per instance
4. **Quality Profiles Tab** - Browse and apply TRaSH quality profiles

**Component Structure:**
```
CustomFormatsClient (main component)
├── Formats Tab
│   ├── CustomFormatFormModal (lazy loaded) - Create/edit modal
│   ├── ExportModal (lazy loaded) - Export JSON modal
│   ├── ImportModal (lazy loaded) - Import JSON modal
│   ├── TrashBrowserModal (lazy loaded) - Browse TRaSH formats
│   └── TrackedCFGroups - Display tracked CF groups
├── Scoring Tab
│   └── ScoringMatrix - Quality profile scoring matrix
├── Auto-Sync Tab
│   └── InstanceSyncSettings - Per-instance sync configuration
└── Quality Profiles Tab
    ├── QualityProfilesList - Browse TRaSH quality profiles
    └── TrackedQualityProfiles - Display applied quality profiles
```

**State Management:**
- Uses **Tanstack Query (React Query)** for server state management
- All data fetching/mutations use custom hooks in `apps/web/src/hooks/api/`
- Local component state for UI interactions (modals, filters, selections)
- No global state library (Zustand not used in custom formats)

### Backend Architecture

**API Route:** `apps/api/src/routes/custom-formats.ts`

**Key Dependencies:**
- `createInstanceFetcher()` - Authenticated fetcher for Sonarr/Radarr API calls
- Prisma ORM for database operations
- Encryption service for API key decryption

**Pattern:** Server-side proxy
1. Frontend calls dashboard API (`/api/custom-formats/*`)
2. Backend decrypts instance API keys
3. Backend makes authenticated requests to Sonarr/Radarr instances
4. Backend aggregates results from multiple instances
5. Frontend receives unified response

**Why server-side:** User API keys never exposed to browser, centralized authentication, easy aggregation across instances.

## Data Flow

### Basic CRUD Flow

```
User Action → Frontend Component → React Query Hook → API Client Function
→ Backend API Endpoint → Instance Fetcher → Sonarr/Radarr API
→ Response → Backend → Frontend → Query Cache Update → UI Update
```

### TRaSH Import Flow

```
User browses TRaSH formats → Select format → Click Import
→ Frontend calls useImportTrashFormat()
→ Backend fetches TRaSH JSON from GitHub
→ Backend transforms TRaSH format to Radarr/Sonarr format
→ Backend creates format via instance API
→ Backend creates TrashCustomFormatTracking record in database
→ Query cache invalidated → UI refreshes with new format
```

### Auto-Sync Flow

```
Scheduled task triggers (cron-like, managed by backend scheduler)
→ Backend fetches TrashInstanceSyncSettings for instance
→ If enabled, backend syncs all tracked formats:
   - Fetch latest TRaSH JSON from GitHub
   - Compare with lastSyncedHash to detect changes
   - Update changed formats via instance API
   - Skip formats with syncExcluded = true
→ Update lastRunAt, lastRunStatus, statistics in database
→ Calculate and set nextRunAt
```

## Frontend Components

### Location: `apps/web/src/features/custom-formats/components/`

#### 1. `custom-formats-client.tsx` (Main Component)
**Purpose:** Central orchestration component for all custom format management

**Key Features:**
- Four-tab interface (Formats, Scoring, Auto-Sync, Quality Profiles)
- Cards view vs. Table view toggle
- Advanced filtering (search, instance filter, TRaSH-only, excluded-only)
- Sorting by name/instance/specifications
- Bulk operations (select all, bulk delete, bulk export)
- Modal management for create/edit/import/export

**State:**
- `selectedInstance` - Currently selected instance for operations
- `selectedFormat` - Format being edited
- `searchQuery` - Search filter
- `instanceFilter` - Instance filter dropdown
- `showOnlyTrash` - Filter to show only TRaSH-managed formats
- `showOnlyExcluded` - Filter to show only auto-sync excluded formats
- `viewMode` - "cards" or "table" view
- `selectedFormats` - Set of selected format IDs for bulk operations
- `sortColumn`, `sortDirection` - Sorting configuration

**Key Handlers:**
- `handleCreate()` - Open modal for new format
- `handleEdit()` - Open modal for editing existing format
- `handleDelete()` - Delete format with confirmation
- `handleExport()` - Export format as JSON
- `handleImport()` - Import format from JSON
- `handleBrowseTrashClick()` - Open TRaSH browser modal
- `handleSyncTrash()` - Manually sync TRaSH-managed formats for instance
- `handleToggleSyncExclusion()` - Toggle auto-sync on/off for specific format
- `handleUpdateInstanceSync()` - Update auto-sync settings

#### 2. `custom-format-form-modal.tsx` (Lazy Loaded)
**Purpose:** Modal for creating/editing custom formats

**Features:**
- Instance selector (can switch instance while editing)
- Name and "include when renaming" checkbox
- Specifications builder (dynamic list of conditions)
- TRaSH import support (pre-fills form with TRaSH data)
- Validation with error display

**Fields:**
- `name` - Custom format name
- `includeCustomFormatWhenRenaming` - Boolean flag
- `specifications[]` - Array of specification objects:
  - `name` - Specification name
  - `implementation` - Type (ReleaseTitleSpecification, etc.)
  - `negate` - Invert condition
  - `required` - Must match
  - `fields` - Implementation-specific fields (regex, value, etc.)

#### 3. `trash-browser-modal.tsx` (Lazy Loaded)
**Purpose:** Browse and import custom formats from TRaSH Guides

**Features:**
- Service selector (Sonarr/Radarr)
- Instance selector
- Search filter
- Tabs: Individual Formats, CF Groups
- Multi-select for bulk import
- Preview format details before import

**Data Sources:**
- Fetches TRaSH JSON from GitHub repository
- Uses `useTrashFormats()` hook for individual formats
- Uses `useTrashCFGroups()` hook for CF groups

#### 4. `scoring-matrix.tsx`
**Purpose:** Visual matrix for managing custom format scores in quality profiles

**Features:**
- Fetches quality profiles and custom formats for selected instance
- Matrix view: rows = custom formats, columns = quality profiles
- Inline editing of scores (input fields in matrix cells)
- Bulk save changes
- Validation and error handling

**API Calls:**
- `GET /api/v3/qualityprofile` - Fetch quality profiles
- `GET /api/v3/customformat` - Fetch custom formats
- `PUT /api/v3/qualityprofile/{id}` - Update quality profile scores

#### 5. `instance-sync-settings.tsx`
**Purpose:** Configure automatic TRaSH sync per instance

**Settings:**
- `enabled` - Master toggle for auto-sync
- `intervalType` - DISABLED, HOURLY, DAILY, WEEKLY
- `intervalValue` - Number of hours/days/weeks
- `syncFormats` - Sync individual tracked formats
- `syncCFGroups` - Re-import all formats from tracked CF groups
- `syncQualityProfiles` - Update tracked quality profiles

**Display:**
- Last run timestamp and status (SUCCESS/FAILED/PARTIAL)
- Next scheduled run timestamp
- Statistics (formats synced, formats failed, CF groups synced, quality profiles synced)
- Error message if last run failed

#### 6. `quality-profiles-list.tsx`
**Purpose:** Browse and apply TRaSH quality profiles

**Features:**
- Fetches available TRaSH quality profiles for selected service
- Search filter
- Profile details (min score, cutoff score, format count, upgrade allowed)
- "Apply Profile" button (creates/updates quality profile in instance)

**API Flow:**
1. Fetch TRaSH quality profiles from GitHub
2. User clicks "Apply Profile"
3. Backend transforms TRaSH profile to Radarr/Sonarr format
4. Backend creates/updates quality profile via instance API
5. Backend creates TrashQualityProfileTracking record

#### 7. `tracked-cf-groups.tsx`
**Purpose:** Display CF groups that have been imported

**Features:**
- Shows all tracked CF groups per instance
- Displays group name, format count, last sync timestamp
- "Re-sync" button to re-import all formats from group
- "Untrack" button (optionally delete associated formats)

#### 8. `tracked-quality-profiles.tsx`
**Purpose:** Display quality profiles that have been applied from TRaSH

**Features:**
- Shows all tracked quality profiles per instance
- Displays profile name, last applied timestamp
- "Re-apply" button to update profile with latest TRaSH config

#### 9. `export-modal.tsx` (Lazy Loaded)
**Purpose:** Display custom format JSON for export

**Features:**
- Syntax-highlighted JSON display
- Copy to clipboard button
- Download as JSON file button

#### 10. `import-modal.tsx` (Lazy Loaded)
**Purpose:** Import custom format from JSON

**Features:**
- Textarea for JSON input
- Validation (parses JSON, validates schema)
- Preview format name before import
- Import button

#### 11. `specification-fields.tsx`
**Purpose:** Dynamic form fields for custom format specifications

**Features:**
- Renders different field types based on specification implementation
- Supports: text inputs, number inputs, checkboxes, select dropdowns
- Field definitions fetched from schema endpoint

## Backend API Endpoints

### Location: `apps/api/src/routes/custom-formats.ts`

#### 1. `GET /api/custom-formats`
**Purpose:** Fetch all custom formats across instances

**Query Parameters:**
- `instanceId` (optional) - Filter to specific instance

**Response:**
```json
{
  "instances": [
    {
      "instanceId": "string",
      "instanceLabel": "string",
      "instanceService": "SONARR" | "RADARR",
      "customFormats": [...],
      "error": null | "string"
    }
  ]
}
```

**Logic:**
1. Query database for instances (optionally filtered by ID)
2. For each instance, decrypt API key
3. Create authenticated fetcher
4. Call `/api/v3/customformat` on instance
5. Aggregate results
6. Return unified response

#### 2. `GET /api/custom-formats/schema/:instanceId`
**Purpose:** Get custom format schema (field definitions for creating formats)

**Response:** Raw schema from Sonarr/Radarr `/api/v3/customformat/schema`

**Use Case:** Provides field definitions and validation rules for specification implementations

#### 3. `GET /api/custom-formats/:instanceId/:customFormatId`
**Purpose:** Get single custom format

**Response:** Single custom format object

#### 4. `POST /api/custom-formats`
**Purpose:** Create new custom format

**Request Body:**
```json
{
  "instanceId": "string",
  "customFormat": {
    "name": "string",
    "includeCustomFormatWhenRenaming": boolean,
    "specifications": [...]
  }
}
```

**Logic:**
1. Validate request body against CustomFormatSchema
2. Fetch instance from database
3. Create authenticated fetcher
4. POST to `/api/v3/customformat` on instance
5. Return created format with ID

#### 5. `PUT /api/custom-formats/:instanceId/:customFormatId`
**Purpose:** Update existing custom format

**Logic:**
1. Fetch existing format from instance
2. Merge changes with existing data
3. PUT to `/api/v3/customformat/:id` on instance
4. Return updated format

#### 6. `DELETE /api/custom-formats/:instanceId/:customFormatId`
**Purpose:** Delete custom format

**Logic:**
1. DELETE to `/api/v3/customformat/:id` on instance
2. Return 204 No Content

**Note:** Does NOT automatically remove TrashCustomFormatTracking records (they're kept for tracking purposes)

#### 7. `POST /api/custom-formats/copy`
**Purpose:** Copy custom format between instances

**Request Body:**
```json
{
  "sourceInstanceId": "string",
  "targetInstanceId": "string",
  "customFormatId": number
}
```

**Logic:**
1. Fetch format from source instance
2. Transform to clean export format (remove UI metadata, convert fields)
3. POST to target instance
4. Return created format

**Transform:** `transformToExportFormat()` function converts fields from array to object, removes `id` field

#### 8. `GET /api/custom-formats/:instanceId/:customFormatId/export`
**Purpose:** Export custom format as JSON

**Response:** Clean JSON format (ready for re-import)
**Headers:** `Content-Disposition: attachment; filename="format-name.json"`

#### 9. `POST /api/custom-formats/import`
**Purpose:** Import custom format from JSON

**Request Body:**
```json
{
  "instanceId": "string",
  "customFormat": { ... }
}
```

**Logic:**
1. Validate custom format schema
2. POST to instance `/api/v3/customformat`
3. Return created format

## TRaSH Guides Integration

### Location: `apps/api/src/routes/trash-guides.ts`

The TRaSH Guides integration allows importing and automatically syncing custom formats from the community-maintained TRaSH Guides repository.

### Key TRaSH API Endpoints

#### 1. `GET /api/trash-guides/formats/:service`
**Purpose:** List available TRaSH custom formats

**Parameters:**
- `:service` - "SONARR" or "RADARR"
- `ref` (query) - Git reference (default: "master")

**Response:** Array of TRaSH custom format objects from GitHub

**GitHub API Call:**
```
GET https://api.github.com/repos/TRaSH-Guides/Guides/contents/docs/json/{service}/cf
```

#### 2. `POST /api/trash-guides/import`
**Purpose:** Import a TRaSH custom format

**Request Body:**
```json
{
  "instanceId": "string",
  "trashId": "string",
  "service": "SONARR" | "RADARR",
  "ref": "master" (optional)
}
```

**Logic:**
1. Fetch TRaSH JSON from GitHub
2. Check if format already exists (by trashId in tracking table)
3. Transform TRaSH format to Sonarr/Radarr format
4. If exists: update via PUT, else: create via POST
5. Create/update TrashCustomFormatTracking record:
   - `customFormatId` - ID from Sonarr/Radarr
   - `trashId` - TRaSH format identifier
   - `lastSyncedHash` - Hash of format content (for change detection)
   - `gitRef` - Git reference used
   - `importSource` - INDIVIDUAL
6. Return result with action ("created" or "updated")

#### 3. `GET /api/trash-guides/tracked`
**Purpose:** Get all TRaSH-tracked custom formats

**Response:**
```json
{
  "tracked": {
    "instanceId1": [
      {
        "customFormatId": number,
        "customFormatName": "string",
        "trashId": "string",
        "lastSyncedAt": "datetime",
        "syncExcluded": boolean,
        "importSource": "INDIVIDUAL" | "CF_GROUP" | "QUALITY_PROFILE",
        "sourceReference": "string" (optional)
      }
    ]
  }
}
```

**Use Case:** Display TRaSH badges on formats, show sync status

#### 4. `POST /api/trash-guides/sync`
**Purpose:** Manually sync TRaSH-managed formats for an instance

**Request Body:**
```json
{
  "instanceId": "string"
}
```

**Logic:**
1. Query TrashCustomFormatTracking for instance where `syncExcluded = false`
2. For each tracked format:
   - Fetch latest TRaSH JSON from GitHub
   - Calculate hash of new content
   - Compare with `lastSyncedHash`
   - If changed: update format via instance API
   - Update tracking record
3. Return statistics (synced count, failed count)

#### 5. `POST /api/trash-guides/toggle-exclusion`
**Purpose:** Toggle auto-sync on/off for a specific format

**Request Body:**
```json
{
  "instanceId": "string",
  "customFormatId": number,
  "syncExcluded": boolean
}
```

**Logic:**
1. Find TrashCustomFormatTracking record
2. Update `syncExcluded` field
3. Return success

**Use Case:** User wants to manually customize a TRaSH format and prevent auto-sync from overwriting changes

#### 6. `GET /api/trash-guides/cf-groups/:service`
**Purpose:** List available TRaSH custom format groups

**Response:** Array of CF group metadata (group name, format count, description)

**GitHub API Call:**
```
GET https://api.github.com/repos/TRaSH-Guides/Guides/contents/docs/json/{service}/cf-groups
```

#### 7. `POST /api/trash-guides/import-cf-group`
**Purpose:** Import all formats from a CF group

**Request Body:**
```json
{
  "instanceId": "string",
  "groupFileName": "string",
  "service": "SONARR" | "RADARR",
  "ref": "master" (optional)
}
```

**Logic:**
1. Fetch CF group JSON from GitHub
2. Extract array of format definitions
3. For each format in group:
   - Import format (same as individual import)
   - Set `importSource = CF_GROUP`
   - Set `sourceReference = groupFileName`
4. Create TrashCFGroupTracking record:
   - `groupFileName` - Filename of CF group
   - `groupName` - Display name
   - `importedCount` - Number of formats imported
   - `lastSyncedAt` - Timestamp
5. Return result with statistics

#### 8. `GET /api/trash-guides/tracked-cf-groups`
**Purpose:** Get all tracked CF groups

**Response:**
```json
{
  "trackedGroups": {
    "instanceId1": [
      {
        "groupFileName": "string",
        "groupName": "string",
        "importedCount": number,
        "lastSyncedAt": "datetime"
      }
    ]
  }
}
```

#### 9. `POST /api/trash-guides/resync-cf-group`
**Purpose:** Re-import all formats from a tracked CF group

**Request Body:**
```json
{
  "instanceId": "string",
  "groupFileName": "string"
}
```

**Logic:**
1. Fetch latest CF group JSON from GitHub
2. Re-import all formats from group (update existing, create new)
3. Update TrashCFGroupTracking record
4. Return statistics

#### 10. `DELETE /api/trash-guides/untrack-cf-group`
**Purpose:** Stop tracking a CF group

**Request Body:**
```json
{
  "instanceId": "string",
  "groupFileName": "string",
  "deleteFormats": boolean (optional, default: true)
}
```

**Logic:**
1. Query custom formats with `importSource = CF_GROUP` and `sourceReference = groupFileName`
2. If `deleteFormats = true`: delete formats from instance
3. Delete TrashCustomFormatTracking records
4. Delete TrashCFGroupTracking record

#### 11. `GET /api/trash-guides/quality-profiles/:service`
**Purpose:** List available TRaSH quality profiles

**Response:** Array of TRaSH quality profile objects

**GitHub API Call:**
```
GET https://api.github.com/repos/TRaSH-Guides/Guides/contents/docs/json/{service}/quality-profiles
```

#### 12. `POST /api/trash-guides/apply-quality-profile`
**Purpose:** Apply a TRaSH quality profile to an instance

**Request Body:**
```json
{
  "instanceId": "string",
  "profileFileName": "string",
  "service": "SONARR" | "RADARR",
  "ref": "master" (optional)
}
```

**Logic (Complex - Recently Fixed):**
1. Fetch TRaSH quality profile JSON from GitHub
2. **Problem:** TRaSH profiles use quality NAMES (strings), Radarr/Sonarr API expects quality IDs (integers)
3. **Solution:**
   - Fetch Radarr/Sonarr quality schema (`/api/v3/qualityprofile/schema`)
   - Build map of quality names → schema items (which have IDs)
   - Transform TRaSH profile items by matching names with schema items
   - Use schema structure (with IDs) + TRaSH settings (allowed flags)
   - Resolve cutoff name to ID from transformed items
4. Import all custom formats referenced in profile (if not already imported)
5. Check if quality profile with same name exists in instance:
   - If exists: update via PUT
   - If not exists: create via POST
6. Create/update TrashQualityProfileTracking record
7. Return result

**Key Challenge:** Cutoff field transformation from name string to integer ID (see lines 1216-1335 in trash-guides.ts)

#### 13. `GET /api/trash-guides/tracked-quality-profiles`
**Purpose:** Get all tracked quality profiles

**Response:**
```json
{
  "trackedProfiles": {
    "instanceId1": [
      {
        "profileFileName": "string",
        "profileName": "string",
        "qualityProfileId": number (optional),
        "lastAppliedAt": "datetime"
      }
    ]
  }
}
```

#### 14. `POST /api/trash-guides/reapply-quality-profile`
**Purpose:** Re-apply a tracked quality profile

**Request Body:**
```json
{
  "instanceId": "string",
  "profileFileName": "string"
}
```

**Logic:** Same as apply-quality-profile, but updates existing profile

### Auto-Sync System

#### Database Model: `TrashInstanceSyncSettings`

**Fields:**
- `enabled` - Master toggle
- `intervalType` - DISABLED, HOURLY, DAILY, WEEKLY
- `intervalValue` - Number of hours/days/weeks
- `syncFormats` - Boolean (sync individual tracked formats)
- `syncCFGroups` - Boolean (re-import CF groups)
- `syncQualityProfiles` - Boolean (re-apply quality profiles)
- `lastRunAt`, `lastRunStatus`, `lastErrorMessage` - Last run info
- `formatsSynced`, `formatsFailed`, `cfGroupsSynced`, `qualityProfilesSynced` - Statistics
- `nextRunAt` - Calculated next run timestamp

#### API Endpoints

**GET /api/trash-guides/sync-settings** - Get all instance settings
**GET /api/trash-guides/sync-settings/:instanceId** - Get specific instance settings
**PUT /api/trash-guides/sync-settings/:instanceId** - Update settings

#### Scheduler Implementation

**Location:** Backend scheduler service (managed in server startup)

**Logic:**
1. On server start, query all `TrashInstanceSyncSettings` where `enabled = true`
2. For each enabled instance, schedule next run based on `intervalType` and `intervalValue`
3. When scheduled time arrives:
   - If `syncFormats = true`: Sync all tracked formats (excluding syncExcluded)
   - If `syncCFGroups = true`: Re-sync all tracked CF groups
   - If `syncQualityProfiles = true`: Re-apply all tracked quality profiles
4. Update `lastRunAt`, `lastRunStatus`, statistics
5. Calculate and set `nextRunAt`
6. Schedule next run

## Database Models

### Location: `apps/api/prisma/schema.prisma`

#### 1. `TrashCustomFormatTracking`
**Purpose:** Track custom formats imported from TRaSH Guides

**Fields:**
- `id` - Primary key
- `serviceInstanceId` - Foreign key to ServiceInstance
- `customFormatId` - ID from Sonarr/Radarr
- `customFormatName` - Display name
- `trashId` - TRaSH format identifier
- `service` - SONARR or RADARR
- `syncExcluded` - If true, skip during auto-sync
- `lastSyncedAt` - Last sync timestamp
- `lastSyncedHash` - Hash of format content (for change detection)
- `gitRef` - Git reference used (master, specific tag, etc.)
- `importSource` - INDIVIDUAL, CF_GROUP, or QUALITY_PROFILE
- `sourceReference` - Optional: group filename or profile filename

**Unique Constraint:** `[serviceInstanceId, customFormatId]`

**Use Cases:**
- Identify which formats are TRaSH-managed
- Track sync status and changes
- Allow excluding specific formats from auto-sync
- Track how format was imported (individual, group, or profile)

#### 2. `TrashInstanceSyncSettings`
**Purpose:** Auto-sync settings per instance

**Fields:**
- `id` - Primary key
- `serviceInstanceId` - Foreign key to ServiceInstance (unique)
- `enabled` - Master toggle
- `intervalType` - DISABLED, HOURLY, DAILY, WEEKLY
- `intervalValue` - Number (1-24 for hourly, 1-7 for daily, 1+ for weekly)
- `syncFormats`, `syncCFGroups`, `syncQualityProfiles` - What to sync
- `lastRunAt`, `lastRunStatus`, `lastErrorMessage` - Last run info
- `formatsSynced`, `formatsFailed`, `cfGroupsSynced`, `qualityProfilesSynced` - Statistics
- `nextRunAt` - Calculated next run timestamp

**Unique Constraint:** `serviceInstanceId`

#### 3. `TrashCFGroupTracking`
**Purpose:** Track CF groups imported from TRaSH

**Fields:**
- `id` - Primary key
- `serviceInstanceId` - Foreign key to ServiceInstance
- `groupFileName` - Filename of CF group in TRaSH repo
- `groupName` - Display name
- `service` - SONARR or RADARR
- `importedCount` - Number of formats imported from this group
- `lastSyncedAt` - Last sync timestamp
- `gitRef` - Git reference used

**Unique Constraint:** `[serviceInstanceId, groupFileName]`

**Relation:** ServiceInstance has `trashCFGroupTracking` relation

#### 4. `TrashQualityProfileTracking`
**Purpose:** Track quality profiles applied from TRaSH

**Fields:**
- `id` - Primary key
- `serviceInstanceId` - Foreign key to ServiceInstance
- `profileFileName` - Filename of quality profile in TRaSH repo
- `profileName` - Display name
- `qualityProfileId` - ID from Sonarr/Radarr (if created, not updated)
- `service` - SONARR or RADARR
- `lastAppliedAt` - Last applied timestamp
- `gitRef` - Git reference used

**Unique Constraint:** `[serviceInstanceId, profileFileName]`

**Relation:** ServiceInstance has `trashQualityProfileTracking` relation

## React Query Hooks

### Location: `apps/web/src/hooks/api/`

#### Custom Formats Hooks (`useCustomFormats.ts`)

- `useCustomFormats(instanceId?)` - Fetch all custom formats
- `useCustomFormat(instanceId, customFormatId)` - Fetch single format
- `useCreateCustomFormat()` - Create mutation
- `useUpdateCustomFormat()` - Update mutation
- `useDeleteCustomFormat()` - Delete mutation (optimistic update)
- `useCopyCustomFormat()` - Copy between instances mutation
- `useExportCustomFormat()` - Export utility (not a query)
- `useImportCustomFormat()` - Import mutation
- `useCustomFormatSchema(instanceId)` - Fetch schema

**Query Keys:**
```typescript
["custom-formats", "list", { instanceId }]
["custom-formats", "detail", instanceId, customFormatId]
["custom-formats", "schema", instanceId]
```

**Cache Strategy:**
- 5 minute stale time for lists
- 30 minute stale time for schema
- Invalidate lists on all mutations
- Optimistic update on delete

#### TRaSH Guides Hooks (`useTrashGuides.ts`)

- `useTrashFormats(service, ref)` - Fetch available TRaSH formats
- `useImportTrashFormat()` - Import TRaSH format mutation
- `useTrashTracked()` - Fetch tracked formats
- `useSyncTrashFormats()` - Manual sync mutation
- `useAllTrashSyncSettings()` - Fetch all instance sync settings
- `useTrashSyncSettings(instanceId)` - Fetch specific instance settings
- `useUpdateTrashSyncSettings()` - Update settings mutation
- `useToggleSyncExclusion()` - Toggle sync exclusion mutation
- `useTrashCFGroups(service, ref)` - Fetch CF groups
- `useImportCFGroup()` - Import CF group mutation
- `useTrackedCFGroups()` - Fetch tracked CF groups
- `useResyncCFGroup()` - Re-sync CF group mutation
- `useUntrackCFGroup()` - Untrack CF group mutation
- `useTrashQualityProfiles(service, ref)` - Fetch quality profiles
- `useApplyQualityProfile()` - Apply quality profile mutation
- `useTrackedQualityProfiles()` - Fetch tracked quality profiles
- `useReapplyQualityProfile()` - Re-apply quality profile mutation

**Query Keys:**
```typescript
["trash-guides", "formats", service, ref]
["trash-guides", "tracked"]
["trash-guides", "sync-settings"]
["trash-guides", "sync-settings", instanceId]
["trash-guides", "cf-groups", service, ref]
["trash-guides", "tracked-cf-groups"]
["trash-guides", "quality-profiles", service, ref]
["trash-guides", "tracked-quality-profiles"]
```

**Cache Strategy:**
- 5 minute stale time for TRaSH data (changes infrequently)
- 30 second stale time for tracking data (changes frequently)
- 1 minute stale time for sync settings
- Invalidate tracking data on all TRaSH mutations

## API Client Functions

### Location: `apps/web/src/lib/api-client/`

All API client functions use the centralized `apiRequest()` function from `base.ts`, which:
- Handles authentication (session cookies)
- Throws errors on non-2xx responses
- Parses JSON responses
- Uses Next.js middleware proxy (`/api/*` → backend)

**Pattern:**
```typescript
export async function getCustomFormats(instanceId?: string) {
  const params = new URLSearchParams();
  if (instanceId) params.set('instanceId', instanceId);

  return apiRequest<GetCustomFormatsResponse>(
    `/api/custom-formats?${params.toString()}`
  );
}
```

## Key Features Summary

### 1. Manual CRUD Operations
- Create custom formats from scratch
- Edit existing custom formats
- Delete custom formats
- View all formats across all instances in unified interface

### 2. Import/Export
- Export individual format as JSON
- Import format from JSON
- Copy format between instances
- Transform format to clean export format (removes UI metadata)

### 3. TRaSH Guides Integration
- Browse TRaSH custom formats by service (Sonarr/Radarr)
- Import individual formats
- Import entire CF groups (collections of related formats)
- Apply pre-configured quality profiles
- Track which formats are managed by TRaSH

### 4. Auto-Sync
- Configure per-instance automatic sync schedules
- Choose what to sync (formats, CF groups, quality profiles)
- Hourly, daily, or weekly intervals
- View last run status and statistics
- Exclude specific formats from auto-sync (preserve manual changes)

### 5. Scoring Matrix
- Visual matrix: rows = custom formats, columns = quality profiles
- Edit scores inline
- Bulk save changes
- Validation and error handling

### 6. Quality Profiles
- Browse TRaSH quality profiles
- Apply profiles to instances (creates/updates quality profile with correct scoring)
- Track applied profiles
- Re-apply profiles to get latest TRaSH updates

### 7. Advanced Filtering
- Search by name
- Filter by instance
- Show only TRaSH-managed formats
- Show only auto-sync excluded formats
- Sort by name/instance/specification count
- Toggle between cards and table view

### 8. Bulk Operations
- Select multiple formats
- Bulk export
- Bulk delete
- Visual selection UI with checkboxes

### 9. Lazy Loading
- Modal components lazy loaded with React.lazy() and Suspense
- Reduces initial bundle size
- Improves page load performance

## Important Patterns and Considerations

### 1. Instance API Key Security
- API keys NEVER exposed to frontend
- All instance communication happens server-side
- Keys encrypted in database with AES-256-GCM
- Decrypted on-demand for each request

### 2. TRaSH ID Tracking
- TRaSH formats identified by `trash_id` field in JSON
- Used to detect if format already imported
- Allows updates instead of duplicates
- Hash-based change detection (compare JSON hash to detect changes)

### 3. Quality Profile Transformation
- **Critical Issue:** TRaSH profiles use quality NAMES, Radarr API uses quality IDs
- **Solution:** Fetch schema, build name→ID map, transform profile
- See `apps/api/src/routes/trash-guides.ts` lines 1216-1335
- Cutoff resolution: match cutoff name in transformed items to get ID

### 4. Sync Exclusion
- Allows users to manually customize TRaSH formats
- Excluded formats skip auto-sync (preserve user changes)
- Still tracked in database (can re-enable sync later)
- UI shows "Auto-Sync Off" badge for excluded formats

### 5. Import Source Tracking
- Tracks how format was imported: INDIVIDUAL, CF_GROUP, or QUALITY_PROFILE
- Allows grouping related formats
- Enables bulk operations on formats from same source
- Used for cleanup when untracking CF groups/profiles

### 6. Error Handling
- Backend: try-catch blocks with error logging
- Frontend: toast notifications for user feedback
- Optimistic updates on delete (with rollback on error)
- Partial success handling (e.g., 10 formats synced, 2 failed)

### 7. Cache Invalidation
- All mutations invalidate relevant query keys
- Ensures UI stays in sync with backend
- Uses React Query's automatic refetching
- Strategic stale times to balance freshness and performance

### 8. Lazy Component Loading
- Heavy modal components lazy loaded
- Reduces initial bundle size
- Improves Time to Interactive (TTI)
- Suspense fallback for loading state

## File Locations Reference

### Frontend
```
apps/web/
├── app/custom-formats/page.tsx (route)
├── src/features/custom-formats/components/
│   ├── custom-formats-client.tsx (main component)
│   ├── custom-format-form-modal.tsx (create/edit)
│   ├── trash-browser-modal.tsx (TRaSH browser)
│   ├── export-modal.tsx (export UI)
│   ├── import-modal.tsx (import UI)
│   ├── scoring-matrix.tsx (quality profile scoring)
│   ├── instance-sync-settings.tsx (auto-sync config)
│   ├── quality-profiles-list.tsx (TRaSH quality profiles)
│   ├── tracked-cf-groups.tsx (CF groups display)
│   ├── tracked-quality-profiles.tsx (quality profiles display)
│   └── specification-fields.tsx (dynamic form fields)
├── src/hooks/api/
│   ├── useCustomFormats.ts (custom formats hooks)
│   └── useTrashGuides.ts (TRaSH hooks)
└── src/lib/api-client/
    ├── custom-formats.ts (API client functions)
    └── trash-guides.ts (TRaSH API client functions)
```

### Backend
```
apps/api/
├── src/routes/
│   ├── custom-formats.ts (custom formats API)
│   └── trash-guides.ts (TRaSH integration API)
├── src/lib/arr/
│   └── arr-fetcher.ts (instance communication)
└── prisma/
    └── schema.prisma (database models)
```

### Shared
```
packages/shared/
└── src/types/
    ├── custom-formats.ts (TypeScript types)
    └── trash-guides.ts (TRaSH types)
```

## Testing and Development

### Local Development
1. Start dev server: `pnpm run dev` (from root)
2. Navigate to: `http://localhost:3000/custom-formats`
3. Add Sonarr/Radarr instance in Settings first
4. Test CRUD operations, TRaSH import, auto-sync

### Key Testing Scenarios
1. **Create Format** - Test validation, specifications builder
2. **Import from TRaSH** - Test individual, CF group, quality profile
3. **Auto-Sync** - Configure schedule, wait for scheduled run, verify formats updated
4. **Sync Exclusion** - Import TRaSH format, exclude from sync, manually edit, verify not overwritten
5. **Quality Profile** - Apply TRaSH profile, verify cutoff transformed correctly
6. **Bulk Operations** - Select multiple, bulk delete/export
7. **Copy Between Instances** - Test cross-instance copying

### Common Issues
1. **Cutoff conversion error** - TRaSH profile cutoff not resolved to ID (fixed in recent commits)
2. **API key decryption fails** - Check encryption service initialization
3. **TRaSH format not found** - GitHub API rate limiting or network issue
4. **Duplicate formats** - trashId not matched correctly during import
5. **Auto-sync not running** - Check scheduler initialization in server startup

## Performance Considerations

### Frontend
- Lazy loading of modal components (saves ~100KB initial bundle)
- React Query caching reduces redundant API calls
- Optimistic updates provide instant feedback
- Debounced search input (prevents excessive re-renders)

### Backend
- Parallel instance fetching (Promise.all)
- Database connection pooling
- Minimal data transformation (pass-through where possible)
- Rate limiting on TRaSH sync endpoints

### Database
- Indexed foreign keys (serviceInstanceId)
- Unique constraints prevent duplicates
- Efficient queries with specific field selection

## Future Improvements

### Potential Features
1. **Diff view** - Show changes when syncing TRaSH formats
2. **Rollback** - Revert to previous version of format
3. **Format templates** - Save frequently used specification patterns
4. **Batch operations** - Apply same specifications to multiple formats
5. **Smart scoring** - AI-suggested scores based on format patterns
6. **Export/import instance config** - Backup all formats for an instance
7. **Merge conflicts** - Better handling when manual changes conflict with TRaSH updates
8. **Webhook integration** - Notify on auto-sync completion
9. **Performance metrics** - Track how formats affect library quality

### Technical Improvements
1. **WebSocket updates** - Real-time sync status updates
2. **Background jobs** - Move auto-sync to separate worker process
3. **Incremental sync** - Only fetch changed formats from TRaSH
4. **Compression** - Compress large format payloads
5. **Pagination** - Handle instances with 100+ formats more efficiently

---

## Summary

The `/custom-formats` feature is a comprehensive management system for Sonarr/Radarr custom formats with deep TRaSH Guides integration. It provides:

- **Unified Interface** - Manage all instances from one place
- **TRaSH Integration** - Import, sync, and track community formats
- **Automation** - Scheduled auto-sync keeps formats up to date
- **Flexibility** - Manual CRUD, import/export, copy between instances
- **Power Features** - Scoring matrix, quality profiles, bulk operations
- **Safety** - Sync exclusion preserves manual changes

**Architecture Highlights:**
- Server-side proxy pattern (never expose API keys)
- React Query for robust state management
- Lazy loading for performance
- Comprehensive error handling
- Hash-based change detection for smart syncing

**Key Files:**
- Frontend: `custom-formats-client.tsx` (main component)
- Backend: `custom-formats.ts` + `trash-guides.ts` (API routes)
- Database: `TrashCustomFormatTracking`, `TrashInstanceSyncSettings`, etc. (tracking models)
