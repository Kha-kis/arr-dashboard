# Phase 5: Advanced Features - Implementation Plan

**Date**: November 19, 2025
**Status**: Planning Phase
**Priority**: Power user features and management tools

---

## Overview

Phase 5 focuses on advanced features for power users who need fine-grained control over custom format scores, conditions, and template management. This phase adds professional-grade tools for managing complex configurations across multiple instances.

---

## 5.1 Bulk Score Management Tab

### Current State
- ✅ `bulk-score-manager.tsx` component exists
- ✅ Component integrated in tab navigation
- 🔄 Needs enhancement with actual functionality

### What We'll Build

#### 5.1.1 Score Management Table
**Purpose**: Centralized view of all custom format scores across all templates

**Features**:
- **Comprehensive Table View**:
  - Columns: CF Name | Template | Service Type | Current Score | TRaSH Default | Status
  - Sortable by any column
  - Filterable by service type, template, CF group, CF name
  - Search functionality
  - Pagination (50/100/200 per page)

- **Bulk Selection**:
  - Select individual CFs
  - Select all CFs in a template
  - Select all CFs in a group
  - Select all visible (filtered) CFs
  - Selection counter (e.g., "15 selected")

- **Bulk Actions**:
  1. **Edit Scores**: Apply same score to all selected CFs
  2. **Copy Scores**: Copy scores from one template to another
  3. **Reset to TRaSH Defaults**: Restore TRaSH Guides recommended scores
  4. **Apply Multiplier**: Multiply all selected scores by factor (e.g., 1.5x)
  5. **Set Range**: Set min/max bounds for selected scores

#### 5.1.2 Export/Import Score Configurations
**Purpose**: Save and share score presets

**Export Format** (JSON):
```json
{
  "version": "1.0",
  "name": "My Custom Scores",
  "description": "Optimized for 4K HDR content",
  "serviceType": "RADARR",
  "created": "2025-11-19T...",
  "scores": [
    {
      "cfTrashId": "cf-123",
      "cfName": "DV HDR10Plus",
      "score": 150,
      "notes": "Prioritize Dolby Vision"
    }
  ]
}
```

**Import Features**:
- Validate JSON structure
- Preview changes before applying
- Merge strategies: Replace all, Update existing, Add new only
- Conflict resolution UI

#### 5.1.3 Score Analytics
**Purpose**: Insights into score distributions

**Metrics**:
- Average score per CF group
- Most/least valued formats
- Score distribution histogram
- Templates with most customizations

**Implementation**:
```
Files to Create/Modify:
- apps/web/src/features/trash-guides/components/bulk-score-manager.tsx (enhance)
- apps/api/src/routes/trash-guides/bulk-score-routes.ts (already exists)
- apps/api/src/lib/trash-guides/bulk-score-manager.ts (already exists)
```

---

## 5.2 Advanced Custom Format Conditions

### Current State
- ✅ Custom formats display specifications
- ❌ No UI to modify conditions
- ❌ No condition editor

### What We'll Build

#### 5.2.1 Condition Viewer/Editor
**Purpose**: Enable/disable and edit individual CF conditions

**UI Design**:
```
┌─────────────────────────────────────────────────┐
│ Custom Format: DV HDR10Plus                     │
├─────────────────────────────────────────────────┤
│ ⚙️ Advanced Mode [Toggle]                       │
│                                                  │
│ Specifications (3):                             │
│                                                  │
│ ☑ Resolution: Must be 2160p                     │
│   Pattern: /2160p|4320p/i                       │
│   [Edit] [Test Pattern]                         │
│                                                  │
│ ☑ HDR Format: Dolby Vision                      │
│   Pattern: /\bDV\b|dolby.?vision/i              │
│   [Edit] [Test Pattern]                         │
│                                                  │
│ ☐ Release Group: Trusted encoders (disabled)    │
│   Pattern: /FraMeSToR|CtrlHD/i                  │
│   [Edit] [Test Pattern]                         │
└─────────────────────────────────────────────────┘
```

**Features**:
- Enable/disable individual conditions (checkboxes)
- Regex pattern editor with syntax highlighting
- Pattern tester: Enter sample text, see if it matches
- Validation: Warn about invalid regex
- Preview: Show how disabling affects matching

#### 5.2.2 Condition Templates
**Purpose**: Common condition patterns

**Pre-built Templates**:
- Resolution filters (720p, 1080p, 2160p, 4320p)
- Audio codec filters (DTS-HD, TrueHD, FLAC, etc.)
- HDR format filters (HDR10, HDR10+, Dolby Vision, HLG)
- Release group filters (Scene, P2P, Internal)
- Source filters (BluRay, WEB-DL, HDTV, etc.)

#### 5.2.3 Condition Builder
**Purpose**: Build complex conditions without regex knowledge

**Visual Builder**:
```
Field: [Release Name ▾]
Operator: [Contains ▾]
Value: [DV          ]
Case Sensitive: ☐

[+ Add Condition] [Preview]
```

**Operators**:
- Contains / Not Contains
- Starts With / Ends With
- Matches Pattern (regex)
- Equals / Not Equals
- Is Empty / Is Not Empty

**Implementation**:
```
Files to Create:
- apps/web/src/features/trash-guides/components/condition-editor.tsx (NEW)
- apps/web/src/features/trash-guides/components/condition-builder.tsx (NEW)
- apps/web/src/features/trash-guides/components/pattern-tester.tsx (NEW)
- apps/api/src/routes/trash-guides/condition-routes.ts (NEW)
```

---

## 5.3 Complete Quality Profile Clone

### Current State
- ✅ Templates contain custom format selections and scores
- ❌ Missing: Quality definitions, language prefs, upgrade behavior

### What We'll Build

#### 5.3.1 Extended Template Schema
**Purpose**: Store complete *arr quality profile settings

**New Fields**:
```typescript
interface TrashTemplate {
  // Existing fields...

  // NEW: Quality Profile Settings
  qualityProfileSettings?: {
    cutoff: number;                    // Quality cutoff ID
    minFormatScore: number;            // Minimum format score
    cutoffFormatScore: number;         // Cutoff format score
    upgradeAllowed: boolean;           // Allow upgrades

    // Quality definitions with ordering
    qualities: Array<{
      quality: {
        id: number;
        name: string;
        source: string;
        resolution: number;
      };
      allowed: boolean;
    }>;

    // Language preferences
    language?: {
      allowed: string[];               // ["English", "Japanese"]
      preferred: string[];             // Ordered preference
    };

    // Release profile (if applicable)
    releaseProfile?: {
      preferred: Array<{
        key: string;
        value: number;
      }>;
      ignored: string[];
      required: string[];
    };
  };
}
```

#### 5.3.2 Quality Profile Importer
**Purpose**: Import complete settings from existing *arr profile

**Workflow**:
```
1. User selects instance + quality profile
2. Fetch complete profile data from *arr API
3. Preview what will be imported:
   - Quality definitions
   - Custom format scores
   - Language settings
   - Upgrade behavior
4. User confirms import
5. Create template with all settings
```

**UI**:
```
┌─────────────────────────────────────────────────┐
│ Import Quality Profile                          │
├─────────────────────────────────────────────────┤
│ Instance: [Radarr - Main ▾]                     │
│ Quality Profile: [4K Remux + WEB 2160p ▾]      │
│                                                  │
│ [Preview Import]                                │
│                                                  │
│ Import Preview:                                 │
│ ✓ 12 Quality definitions                        │
│ ✓ 45 Custom formats with scores                 │
│ ✓ Language: English (preferred)                 │
│ ✓ Upgrade allowed: Yes                          │
│ ✓ Cutoff: Remux-2160p                          │
│                                                  │
│ Template Name: [4K Remux + WEB 2160p           ]│
│                                                  │
│ [Cancel] [Import & Create Template]             │
└─────────────────────────────────────────────────┘
```

#### 5.3.3 Complete Profile Deployment
**Purpose**: Deploy template as complete quality profile

**Features**:
- Create new quality profile in *arr instance
- Update existing profile (merge or replace)
- Deploy to multiple instances with variations
- Preserve instance-specific customizations

**Implementation**:
```
Files to Create/Modify:
- apps/api/src/lib/trash-guides/profile-cloner.ts (NEW)
- apps/web/src/features/trash-guides/components/profile-importer.tsx (NEW)
- apps/api/src/routes/trash-guides/profile-routes.ts (NEW - extended)
- packages/shared/src/types/trash-guides.ts (modify schema)
```

---

## 5.4 Sharing & Community

### Current State
- ✅ Export template as JSON exists (`templates/:id/export`)
- ✅ Import template from JSON exists (`templates/import`)
- 🔄 Needs enhancement with validation and community features

### What We'll Build

#### 5.4.1 Enhanced Template Export
**Purpose**: Export templates with metadata for sharing

**Export Format**:
```json
{
  "version": "2.0",
  "exportedAt": "2025-11-19T...",
  "exportedBy": "username",

  "template": {
    "name": "4K Optimized for Anime",
    "description": "Optimized for 4K anime releases...",
    "serviceType": "RADARR",
    "qualityProfile": {...},

    "metadata": {
      "author": "username",
      "tags": ["4K", "anime", "remux"],
      "trashGuidesVersion": "commit-hash",
      "compatibleWith": ["radarr-v4", "radarr-v5"],
      "usageCount": 0,
      "lastUpdated": "2025-11-19T..."
    },

    "customFormats": [...],
    "scores": {...},
    "qualitySettings": {...}
  }
}
```

**Export Options**:
- Include/exclude quality settings
- Include/exclude custom conditions
- Anonymize (remove author info)
- Add usage notes/readme

#### 5.4.2 Template Validation on Import
**Purpose**: Validate templates before import

**Validation Checks**:
1. **Schema Validation**: JSON structure matches template schema
2. **Version Compatibility**: Compatible with current app version
3. **Custom Format Validation**: All CFs exist in TRaSH Guides cache
4. **Score Range Validation**: Scores within acceptable range (-10000 to 10000)
5. **Service Type Match**: Template matches selected service type
6. **Conflict Detection**: Name conflicts with existing templates

**Import Preview**:
```
┌─────────────────────────────────────────────────┐
│ Import Template                                  │
├─────────────────────────────────────────────────┤
│ Template: "4K Optimized for Anime"              │
│ Author: username                                 │
│ Service Type: Radarr                             │
│ Version: 2.0                                     │
│                                                  │
│ Validation Results:                              │
│ ✓ Schema valid                                   │
│ ✓ Version compatible (2.0)                       │
│ ✓ All custom formats found (42/42)              │
│ ⚠ Name conflicts with existing template         │
│                                                  │
│ New Template Name: [4K Anime (imported)        ]│
│                                                  │
│ Preview:                                         │
│ • 42 Custom Formats                              │
│ • Quality Profile: 4K Remux + WEB               │
│ • Tags: 4K, anime, remux                         │
│                                                  │
│ [Cancel] [Import Template]                       │
└─────────────────────────────────────────────────┘
```

#### 5.4.3 Template Sharing Hub (Future)
**Purpose**: Community template repository

**Features** (Phase 6+):
- Browse community templates
- Rate and review templates
- Download popular templates
- Submit templates for approval
- Version control for templates
- Discussion/comments

**Implementation**:
```
Files to Modify:
- apps/api/src/routes/trash-guides/template-routes.ts (enhance export/import)
- apps/web/src/features/trash-guides/components/template-import-dialog.tsx (enhance validation)
- apps/api/src/lib/trash-guides/template-validator.ts (NEW)
```

---

## Implementation Priority

### High Priority (Phase 5 Core)
1. **Bulk Score Management Enhancements** (5.1)
   - Score table with filters
   - Bulk edit/reset functionality
   - Export/import scores
   - **Effort**: 6-8 hours
   - **Value**: High - frequently requested feature

2. **Advanced Condition Editor** (5.2)
   - Enable/disable conditions
   - Basic condition editor
   - Pattern tester
   - **Effort**: 8-10 hours
   - **Value**: Medium-High - power user feature

3. **Enhanced Template Export/Import** (5.4.1, 5.4.2)
   - Validation on import
   - Export with metadata
   - Conflict detection
   - **Effort**: 4-6 hours
   - **Value**: High - essential for sharing

### Medium Priority (Phase 5 Extended)
4. **Complete Quality Profile Clone** (5.3)
   - Extended template schema
   - Profile importer
   - Complete deployment
   - **Effort**: 10-12 hours
   - **Value**: Medium - nice-to-have for advanced users

5. **Condition Builder** (5.2.2, 5.2.3)
   - Visual condition builder
   - Condition templates
   - **Effort**: 6-8 hours
   - **Value**: Medium - helpful for non-technical users

### Low Priority (Future Phases)
6. **Template Sharing Hub** (5.4.3)
   - Community repository
   - Rating/reviews
   - **Effort**: 20+ hours
   - **Value**: Low - can be separate future project

---

## Technical Architecture

### Database Schema Changes

```sql
-- Add quality profile settings to templates (Prisma)
model TrashTemplate {
  // ... existing fields ...

  // NEW: Complete quality profile settings
  qualitySettings Json? // Store complete quality profile JSON

  // NEW: Metadata for sharing
  exportMetadata Json?  // Author, tags, compatibility info
  usageCount     Int     @default(0)
  isPublic       Boolean @default(false)
  tags           String[] // For filtering/search
}

-- Track score configurations
model ScoreConfiguration {
  id          String   @id @default(cuid())
  name        String
  description String?
  serviceType String   // RADARR | SONARR
  scores      Json     // Array of {cfTrashId, score}
  userId      String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  isPublic    Boolean  @default(false)
}
```

### API Endpoints to Create

```typescript
// Bulk Score Management
POST   /api/trash-guides/bulk-scores/export
POST   /api/trash-guides/bulk-scores/import
POST   /api/trash-guides/bulk-scores/apply
POST   /api/trash-guides/bulk-scores/reset-defaults

// Condition Management
GET    /api/trash-guides/conditions/:cfId
PUT    /api/trash-guides/conditions/:cfId
POST   /api/trash-guides/conditions/:cfId/validate
POST   /api/trash-guides/conditions/:cfId/test

// Quality Profile Cloning
GET    /api/trash-guides/profiles/:instanceId/:profileId/export
POST   /api/trash-guides/profiles/import
POST   /api/trash-guides/profiles/:instanceId/deploy-complete

// Template Sharing
POST   /api/trash-guides/templates/:id/validate
GET    /api/trash-guides/templates/public (future)
POST   /api/trash-guides/templates/:id/publish (future)
```

### Frontend Components to Create

```
apps/web/src/features/trash-guides/components/
├── bulk-score-manager.tsx (enhance existing)
├── score-export-dialog.tsx (NEW)
├── score-import-dialog.tsx (NEW)
├── condition-editor.tsx (NEW)
├── condition-builder.tsx (NEW)
├── pattern-tester.tsx (NEW)
├── profile-importer.tsx (NEW)
├── template-validator.tsx (NEW)
└── template-metadata-editor.tsx (NEW)
```

---

## Success Criteria

### Phase 5 Complete When:
- [ ] Bulk score table shows all CFs with filtering
- [ ] Bulk edit applies scores to multiple CFs simultaneously
- [ ] Score export/import works with validation
- [ ] Condition editor allows enable/disable per specification
- [ ] Pattern tester validates regex patterns
- [ ] Template export includes metadata
- [ ] Template import validates before creating
- [ ] Quality profile import creates template with all settings
- [ ] Complete profile deployment works end-to-end

---

## Timeline Estimate

**Optimistic**: 3-4 weeks (25-30 hours)
**Realistic**: 4-5 weeks (35-40 hours)
**Pessimistic**: 6-7 weeks (45-50 hours)

**Minimum Viable Phase 5** (MVP):
- Bulk score management (5.1)
- Basic condition editor (5.2.1)
- Enhanced export/import with validation (5.4.1, 5.4.2)
**Timeline**: 2-3 weeks (18-24 hours)

---

## Next Steps

1. **User Feedback**: Which features are most valuable?
2. **Prioritize**: Start with high-value, low-effort features
3. **Prototype**: Build bulk score manager first (most requested)
4. **Iterate**: Add condition editor and export enhancements
5. **Polish**: Quality profile clone as final feature

---

## Questions for Clarification

1. **Bulk Score Management**: What operations are most important?
   - Edit multiple scores at once?
   - Copy scores between templates?
   - Reset to TRaSH defaults?

2. **Condition Editor**: How much control do users need?
   - Just enable/disable?
   - Full regex editing?
   - Visual builder for non-technical users?

3. **Quality Profile Clone**: Is this essential for Phase 5?
   - Could be pushed to Phase 6?
   - Or implement basic version now, enhance later?

4. **Template Sharing**: Community repository now or later?
   - Start with simple export/import?
   - Add community features in future phase?
