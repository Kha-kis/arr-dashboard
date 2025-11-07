# TRaSH Guides Data Structure Analysis

*Based on: https://github.com/TRaSH-Guides/Guides/blob/master/CONTRIBUTING.md*

## Overview

This document provides a comprehensive analysis of the TRaSH Guides data structure to ensure our implementation correctly handles all aspects of Quality Profiles, Custom Formats, and CF Groups.

---

## 1. Custom Format (CF) Structure

### JSON File Format
```json
{
    "trash_id": "HASHCODE",
    "trash_scores": {
        "default": 50,
        "some_other_profile": 100
    },
    "trash_regex": "https://regex101.com/r/pADWJD/5",
    // ... STARRJSONEXPORT (exported from Radarr/Sonarr)
}
```

### Key Properties

#### `trash_id` (Hashcode)
- **Purpose**: Unique identifier for Custom Format
- **Generation Rules**:
  - **Radarr**: MD5 hash of `CF_name` (e.g., `BR-DISK` → hash of "BR-DISK")
  - **Radarr Anime**: MD5 hash of `Radarr Anime CF_name`
  - **Sonarr**: MD5 hash of `Sonarr CF_name`
  - **Sonarr Anime**: MD5 hash of `Sonarr Anime CF_name`
- **⚠️ Critical**: No hashcode can exist multiple times across the entire system

#### `trash_scores`
- **Purpose**: Define scores for different Quality Profiles
- **Structure**: JSON object with profile keys
  - `"default"`: Base score used when profile doesn't have specific override
  - `"profile_name"`: Profile-specific score override
- **⚠️ Critical Rules**:
  - Custom Formats with Default Score of 0 should NOT have `trash_scores.default`
  - This means if a CF has no default score, the `trash_scores` object might only contain profile-specific scores

#### `trash_regex`
- **Purpose**: Link to regex101.com with test cases
- **Format**: Full URL to regex test page

### File Naming Convention
- **Format**: lowercase, spaces → dashes, `+` → `plus`
- **Examples**:
  - "DV HDR10+" → `dv-hdr10plus.json`
  - "BR-DISK" → `br-disk.json`

### ✅ Current Implementation Status
- ✅ We correctly parse `trash_id`
- ✅ We correctly extract scores from `trash_scores` using `profile.trash_score_set`
- ✅ We fallback to `trash_scores.default` when profile-specific score not found
- ⚠️ **Gap**: We don't handle CFs with no default score (0 score CFs)

---

## 2. Quality Profile Structure

### JSON File Structure
```json
{
    "trash_id": "PROFILE_HASHCODE",
    "name": "Profile Name",
    "trash_description": "Description with HTML",
    "trash_score_set": "sqp-1-2160p",  // KEY FIELD for score lookup!
    "group": 1,
    "upgradeAllowed": true,
    "cutoff": 20,
    "minFormatScore": 0,
    "cutoffFormatScore": 10000,
    "minUpgradeFormatScore": 0,
    "language": "en",  // Radarr only
    "items": [/* quality definitions */],
    "formatItems": {
        "CF_Name_1": "cf_trash_id_1",
        "CF_Name_2": "cf_trash_id_2"
    }
}
```

### Key Properties

#### `trash_id`
- MD5 hash of the profile name
- Used to identify profile uniquely

#### `trash_score_set`
- **⚠️ CRITICAL**: This is the key used to look up profile-specific scores in CF's `trash_scores`
- **Example**: If profile has `"trash_score_set": "sqp-1-2160p"`, then:
  ```json
  // In CF JSON:
  "trash_scores": {
      "default": 1800,
      "sqp-1-2160p": 1100,  // ← This score is used!
      "sqp-2": 2300
  }
  ```

#### `name`
- Display name for the profile
- **Prefixes**:
  - `[Language]` for foreign language profiles: `[German] HD Bluray + WEB`
  - `[Anime]` for anime profiles: `[Anime] Something`

#### `trash_description`
- HTML description (allowed tags: `<b>`, `</b>`, `<br>`, `<a>`)
- Example: `Quality Profile that covers:<br>- WEBDL: 1080p<br>- Bluray: 720p, 1080p`

#### `group`
- Sort order for organizing profiles
- **Ranges**:
  - [1-9]: English/International Public Guides (Non-Anime)
  - [11-19]: German Guides (Incl. Anime)
  - [21-29]: French Guides (Incl. Anime)
  - [81-89]: English/International Public Guides (Anime)
  - [91-99]: Restricted Use

#### `formatItems`
- **Purpose**: Maps CF names to their trash_ids
- **Critical**: These are the **mandatory** Custom Formats for this profile
- **Format**: `{ "CF_Name": "cf_trash_id" }`
- **Note**: These are separate from CF Groups (which are optional)

### ✅ Current Implementation Status
- ✅ We correctly use `trash_score_set` to look up profile-specific scores
- ✅ We parse `formatItems` and resolve to full CF definitions
- ✅ We display profile metadata (name, description)
- ⚠️ **Gap**: We may not handle the distinction between mandatory (formatItems) vs optional (CF Groups) clearly enough

---

## 3. CF Groups Structure

### Purpose
CF Groups provide **optional** configurations where users can selectively enable/disable Custom Formats. This is in contrast to Quality Profiles which define **mandatory** Custom Formats.

### JSON File Structure
```json
{
    "trash_id": "GROUP_HASHCODE",
    "name": "Group Name",
    "trash_description": "Description with HTML",
    "default": "true",  // OPTIONAL: Group enabled by default
    "custom_formats": [
        {
            "name": "CF Name",
            "trash_id": "cf_trash_id",
            "required": false,
            "default": "true"  // OPTIONAL: CF checked by default
        }
    ],
    "quality_profiles": {
        "exclude": {
            "Profile Name 1": "profile_trash_id_1",
            "Profile Name 2": "profile_trash_id_2"
        }
    }
}
```

### Key Properties

#### Group-Level Settings

##### `default` (Optional)
- **Purpose**: Controls if group is enabled by default when user imports profile
- **Values**:
  - `"true"`: Group enabled by default
  - Not present or `"false"`: Group disabled by default
- **Default Behavior**: All groups are disabled by default unless explicitly set

##### `quality_profiles.exclude`
- **Purpose**: Defines which Quality Profiles this CF Group should NOT be available for
- **Format**: `{ "Profile Name": "profile_trash_id" }`
- **Usage**: If a profile is in the exclude list, this CF Group won't be shown as an option

#### Custom Format-Level Settings

##### `required`
- **Values**: `true` | `false`
- **Behavior**:
  - `true`: All CFs in group are enabled when group is enabled (no individual selection)
  - `false`: User can individually select which CFs to enable from the group

##### `default` (Optional)
- **Only applies when**: `required: false`
- **Purpose**: Pre-check the CF in the UI
- **Behavior**: CF is checked by default but user can still uncheck it

### Truth Table for CF Selection

| Group default | CF required | CF default | Result |
|--------------|-------------|------------|--------|
| (not set)    | true        | N/A        | Group disabled; if enabled, all CFs auto-enabled |
| "true"       | true        | N/A        | Group enabled; all CFs auto-enabled |
| (not set)    | false       | (not set)  | Group disabled; if enabled, CFs unchecked |
| "true"       | false       | (not set)  | Group enabled; CFs unchecked |
| (not set)    | false       | "true"     | Group disabled; if enabled, CFs pre-checked |
| "true"       | false       | "true"     | Group enabled; CFs pre-checked |

### ✅ Current Implementation Status
- ✅ We fetch CF Groups from cache
- ✅ We filter CF Groups using `quality_profiles.exclude`
- ✅ We enrich CF Groups with full CF details (descriptions, scores)
- ⚠️ **Gap**: We don't fully implement `required` vs `default` distinction in UI
- ⚠️ **Gap**: We may not clearly show mandatory (from profile) vs optional (from groups) distinction

---

## 4. Score Resolution Logic

### The Complete Picture

When a user selects a Quality Profile, the scores come from multiple sources:

```
Quality Profile Selected
    ↓
1. Get profile.trash_score_set (e.g., "sqp-1-2160p")
    ↓
2. For each Custom Format:
    ↓
    a. Look in CF.trash_scores[profile.trash_score_set]
    b. If found → use that score
    c. If not found → fallback to CF.trash_scores.default
    d. If default also missing → score is undefined/0
    ↓
3. User can optionally override any score in the wizard
```

### Example Score Resolution

Given:
- **Profile**: `trash_score_set: "sqp-1-2160p"`
- **CF "DV HDR10+"**:
  ```json
  {
      "trash_scores": {
          "default": 1800,
          "sqp-1-2160p": 1100,
          "sqp-2": 2300
      }
  }
  ```

**Resolution**:
1. Check `trash_scores["sqp-1-2160p"]` → Found: **1100**
2. Display in UI: "Score (Default: 1100)"
3. User can override to any value they want

### ✅ Current Implementation Status
- ✅ We correctly implement steps 1-2c
- ⚠️ **Gap**: Step 2d - We should handle missing scores gracefully
- ✅ Step 3 - User override is implemented

---

## 5. Import Flow Logic

### What Should Happen When User Imports a Quality Profile

```
User selects Quality Profile → Next
    ↓
Step 1: Show CF Groups
    ├─ Filter: quality_profiles.exclude does NOT contain this profile
    ├─ Display: Groups with default="true" pre-checked
    └─ Allow: User to check/uncheck groups
    ↓
Step 2: Show Custom Formats
    ├─ Section A: Mandatory CFs (from profile.formatItems)
    │   ├─ Always selected
    │   ├─ Show: Score from trash_scores
    │   └─ Allow: User score override
    │
    ├─ Section B: CFs from enabled CF Groups
    │   ├─ If required=true: Auto-selected, show but can't uncheck
    │   ├─ If required=false, default=true: Pre-checked, user can uncheck
    │   ├─ If required=false, no default: Unchecked, user can check
    │   ├─ Show: Score from trash_scores
    │   └─ Allow: User score override
    │
    └─ Show: Descriptions, specifications for all CFs
    ↓
Step 3: Template Naming
    ├─ Pre-filled with profile name
    ├─ Pre-filled description
    └─ User can customize
    ↓
Step 4: Import
    ├─ Create template with:
    │   ├─ All mandatory CFs (from formatItems)
    │   ├─ All selected CFs from CF Groups
    │   ├─ User's score overrides
    │   └─ User's condition selections
    └─ Store: Template for deployment to Radarr/Sonarr instances
```

### ✅ Current Implementation Status
- ✅ We fetch and display Quality Profiles
- ✅ We fetch and filter CF Groups
- ✅ We enrich with descriptions and scores
- ⚠️ **Gap**: We don't clearly separate mandatory vs optional CFs in UI
- ⚠️ **Gap**: We don't implement `required` vs `default` distinction
- ⚠️ **Gap**: Legacy mode imports everything, but wizard mode should be more selective

---

## 6. Implementation Gaps and Recommendations

### Critical Gaps

1. **Zero Score Custom Formats**
   - **Issue**: CFs with score 0 don't have `trash_scores.default`
   - **Current**: We might display `null` or crash
   - **Fix**: Handle missing `trash_scores.default` gracefully

2. **Mandatory vs Optional Distinction**
   - **Issue**: UI doesn't clearly show which CFs are mandatory (from profile) vs optional (from groups)
   - **Current**: All CFs look the same
   - **Fix**: Visual distinction - maybe mandatory CFs in a separate section with lock icon

3. **CF Group `required` Logic**
   - **Issue**: We don't implement the required=true vs required=false distinction
   - **Current**: All CFs in groups are individually selectable
   - **Fix**: If `required=true`, disable individual checkboxes and select all as a unit

4. **CF Group `default` Logic**
   - **Issue**: We don't pre-check groups or CFs based on their default settings
   - **Current**: Everything starts unchecked
   - **Fix**: Apply default settings when loading wizard

### Recommended UX Improvements

1. **Step 1: CF Group Selection**
   ```
   ┌─ Select Optional CF Groups ─────────────┐
   │                                          │
   │ ☑ HDR Formats (enabled by default)      │
   │   → 15 Custom Formats                   │
   │                                          │
   │ ☐ Streaming Services                    │
   │   → 24 Custom Formats                   │
   │                                          │
   │ ☑ Unwanted (enabled by default)         │
   │   → 8 Custom Formats                    │
   └──────────────────────────────────────────┘
   ```

2. **Step 2: CF Configuration**
   ```
   ┌─ Configure Custom Formats ──────────────┐
   │                                          │
   │ MANDATORY (From Quality Profile)        │
   │ ├─ 🔒 DV HDR10+                          │
   │ │   Score: 1100  Override: [____]       │
   │ └─ 🔒 BR-DISK                            │
   │     Score: -10000  Override: [____]     │
   │                                          │
   │ OPTIONAL (From CF Groups)                │
   │ ├─ HDR Formats Group                    │
   │ │   ☑ DV HDR10                           │
   │ │   ☑ HDR10                              │
   │ │   ☐ HDR                                │
   │ └─ Unwanted Group (All Required)        │
   │     • LQ                                 │
   │     • 3D                                 │
   └──────────────────────────────────────────┘
   ```

### Data Validation Checklist

- [ ] Verify `trash_score_set` exists in profile
- [ ] Handle missing `trash_scores.default` in CFs
- [ ] Validate CF `trash_id` references exist
- [ ] Check CF Group `quality_profiles.exclude` logic
- [ ] Ensure mandatory CFs are always included
- [ ] Apply CF Group default settings correctly
- [ ] Implement CF `required` logic correctly
- [ ] Preserve user score overrides through wizard
- [ ] Store template with correct data structure

---

## 7. Next Steps

### Immediate Actions

1. **Review Current Implementation**
   - Audit how we handle missing `trash_scores.default`
   - Verify CF Group filtering logic
   - Check if we distinguish mandatory vs optional CFs

2. **Fix Critical Gaps**
   - Handle zero-score CFs
   - Implement `required` and `default` logic
   - Separate mandatory/optional in UI

3. **Enhance UX**
   - Add visual distinction for mandatory CFs
   - Pre-check groups/CFs based on defaults
   - Show CF counts in group selection

4. **Testing**
   - Test with profiles that have no default scores
   - Test CF Groups with `required=true`
   - Test CF Groups with `default="true"`
   - Test profile exclusion logic

---

## 8. API Response Structure Recommendations

### GET `/api/trash-guides/quality-profiles/:serviceType/:trashId`

**Current Response**:
```json
{
    "profile": { /* profile data */ },
    "cfGroups": [ /* applicable CF groups */ ],
    "directCustomFormats": [ /* mandatory CFs */ ],
    "cfGroupCFCount": 150
}
```

**Recommended Enhancement**:
```json
{
    "profile": {
        "trash_id": "...",
        "name": "...",
        "trash_score_set": "sqp-1-2160p",  // Important for score lookup
        /* other profile fields */
    },
    "mandatoryCFs": [
        // CFs from profile.formatItems
        {
            "trash_id": "...",
            "name": "...",
            "score": 1100,  // Resolved from trash_scores
            "source": "profile",  // NEW: indicates this is mandatory
            /* other CF fields */
        }
    ],
    "cfGroups": [
        {
            "trash_id": "...",
            "name": "...",
            "defaultEnabled": true,  // NEW: from group.default
            "custom_formats": [
                {
                    "trash_id": "...",
                    "name": "...",
                    "score": 50,
                    "required": false,  // Already present
                    "defaultChecked": true,  // NEW: from CF.default
                    /* other CF fields */
                }
            ]
        }
    ],
    "stats": {
        "mandatoryCount": 12,
        "optionalGroupCount": 8,
        "totalOptionalCFs": 150
    }
}
```

---

## Summary

The TRaSH Guides data structure is well-designed with clear separation between:
- **Mandatory configuration** (Quality Profiles + formatItems)
- **Optional configuration** (CF Groups)
- **Score flexibility** (Profile-specific + default + user override)

Our implementation is solid on the core score resolution but has gaps in:
- Handling edge cases (zero scores)
- UI distinction between mandatory/optional
- CF Group default behavior
- CF required/default logic

By addressing these gaps, we can provide a more accurate and user-friendly implementation of the TRaSH Guides import workflow.
