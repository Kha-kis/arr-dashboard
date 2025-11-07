# TRaSH Guides Wizard UX Specification

## Overview
Detailed UX specification for the hybrid wizard approach combining quick setup (CF Group selection) with granular customization.

---

## Wizard Flow Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    WIZARD PROGRESS BAR                       │
│  ① Profile Selection  →  ② CF Groups  →  ③ Customize  →  ④ Review │
└─────────────────────────────────────────────────────────────┘
```

---

## Step 1: Quality Profile Selection

**Status**: ✅ Already Implemented

**Enhancements Needed**:
- Add score set badge more prominently
- Show CF Group count preview: "Includes 8 optional CF groups"
- Better description rendering (HTML → proper formatting)

```
┌─ Select Quality Profile ────────────────────────────────────┐
│                                                               │
│ ℹ️  Quality profiles are expert-curated configurations from  │
│    TRaSH Guides that define quality preferences and scoring. │
│                                                               │
│ ┌──────────────────────────────────┐ ┌────────────────────┐ │
│ │ [Anime] Web-1080p                │ │ HD Bluray + WEB    │ │
│ │                                  │ │                    │ │
│ │ Score Set: sqp-1-anime          │ │ Score Set: sqp-1   │ │
│ │                                  │ │                    │ │
│ │ Quality Profile that covers:     │ │ 1080p releases     │ │
│ │ - WEB: 1080p                    │ │ from BluRay and WEB │ │
│ │ - Quality based on release      │ │                    │ │
│ │                                  │ │ ⭐ 12 formats      │ │
│ │ ⭐ 18 formats | 📊 6 qualities   │ │ 📊 8 qualities     │ │
│ │ 📦 8 CF groups available        │ │ 📦 6 CF groups     │ │
│ │                                  │ │                    │ │
│ │ Cutoff: 20 | ✅ Upgrades On     │ │ Cutoff: 15 | ⛔ Off │ │
│ └──────────────────────────────────┘ └────────────────────┘ │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

---

## Step 2a: CF Group Selection (Quick Setup)

**Purpose**: Allow users to quickly enable/disable entire CF groups without diving into individual CFs.

**Behavior**:
- Pre-check groups with `default: "true"`
- Show CF count and score impact preview
- Allow skip to Step 3 (customization)
- OR proceed directly to Step 4 (review) if happy with defaults

```
┌─ Step 2: Select Optional CF Groups ─────────────────────────┐
│                                                               │
│ ℹ️  The quality profile includes mandatory custom formats.   │
│    Select additional optional groups to enhance matching.    │
│                                                               │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ☑ HDR Formats  (recommended)                    [▼ Info]│ │
│ │   15 Custom Formats • Score impact: +1,500 to +4,500    │ │
│ │   Matches: DV, HDR10+, HDR10, HDR, etc.                 │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ☐ Streaming Services                            [▼ Info]│ │
│ │   24 Custom Formats • Score impact: varies              │ │
│ │   Matches: NF, AMZN, ATVP, DSNP, MAX, PMTP, etc.       │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ☑ Unwanted  (recommended) 🔒                    [▼ Info]│ │
│ │   8 Custom Formats • Score impact: -10,000              │ │
│ │   All formats required when group is enabled            │ │
│ │   Matches: LQ, 3D, BR-DISK, x265 (HD), etc.            │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ☐ Audio Channels                                [▼ Info]│ │
│ │   12 Custom Formats • Score impact: +50 to +500         │ │
│ │   Matches: TrueHD ATMOS, DTS X, etc.                    │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ☐ HQ Release Groups                             [▼ Info]│ │
│ │   42 Custom Formats • Score impact: +10 to +1,800       │ │
│ │   Matches: Tier 1, Tier 2, Tier 3 release groups       │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                               │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                               │
│ Summary: 3 groups selected • 35 custom formats              │
│                                                               │
│ [← Back]          [Skip to Review] [Customize Selected →]   │
└───────────────────────────────────────────────────────────────┘
```

**Expandable Info** (when user clicks `[▼ Info]`):

```
┌─ HDR Formats Group Details ─────────────────────────────────┐
│                                                               │
│ Description: Matches various HDR formats to ensure correct   │
│ quality prioritization for HDR content.                      │
│                                                               │
│ Custom Formats Included:                                     │
│ • DV HDR10+ (Score: 4500)                                    │
│ • DV HDR10 (Score: 4000)                                     │
│ • DV (Score: 3500)                                           │
│ • HDR10+ (Score: 3000)                                       │
│ • HDR10 (Score: 2500)                                        │
│ • HDR (Score: 1500)                                          │
│ • HDR (undefined) (Score: 500)                               │
│ • PQ (Score: 500)                                            │
│ • HLG (Score: 500)                                           │
│ ... and 6 more                                               │
│                                                               │
│ [Close]                                                      │
└───────────────────────────────────────────────────────────────┘
```

---

## Step 2b/3: Customize Custom Formats (Granular Control)

**Purpose**: Allow power users to enable/disable individual CFs and override scores.

**Behavior**:
- Show mandatory CFs at top (locked)
- Group optional CFs by their CF Group
- Allow individual selection
- Score override with reset button
- Search and filter capabilities

```
┌─ Step 3: Customize Custom Formats ──────────────────────────┐
│                                                               │
│ [🔍 Search...]  [Filter: All Groups ▼]  [⊟ Collapse All]    │
│                                                               │
│ ━━ MANDATORY CUSTOM FORMATS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ From quality profile - cannot be removed                     │
│                                                               │
│ 🔒 DV HDR10+                                                 │
│    Score: 1100  [Override: ______] ↺                        │
│    Dolby Vision with HDR10+ fallback                         │
│    [ℹ️ View specifications]                                  │
│                                                               │
│ 🔒 BR-DISK                                                   │
│    Score: -10000  [Override: ______] ↺                      │
│    This is a custom format to help Radarr recognize & ignore │
│    BR-DISK (ISO's and Blu-ray folder structure)             │
│    [ℹ️ View specifications]                                  │
│                                                               │
│ ━━ HDR FORMATS GROUP ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ [Select All] [Deselect All] [⊟ Collapse]                    │
│                                                               │
│ ☑ DV HDR10                                                   │
│    Score: 1000  [Override: ______] ↺                        │
│    Dolby Vision with HDR10 fallback                          │
│    [ℹ️ View specifications]                                  │
│                                                               │
│ ☑ HDR10+                                                     │
│    Score: 500  [Override: ______] ↺                         │
│    HDR10+ (High Dynamic Range)                               │
│    [ℹ️ View specifications]                                  │
│                                                               │
│ ☐ HDR                                                        │
│    Score: 250  [Override: ______] ↺                         │
│    Generic HDR tag                                           │
│    [ℹ️ View specifications]                                  │
│                                                               │
│ [+ Show 12 more formats in this group]                       │
│                                                               │
│ ━━ UNWANTED GROUP  🔒 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ All formats required when group is enabled                   │
│ [Group Toggle: ● ON] [⊟ Collapse]                           │
│                                                               │
│ • LQ                  Score: -10000                          │
│   Low quality releases                                       │
│                                                               │
│ • 3D                  Score: -10000                          │
│   Matches 3D releases                                        │
│                                                               │
│ [+ Show 6 more formats in this group]                        │
│                                                               │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                               │
│ Summary: 2 mandatory + 12 optional CFs selected              │
│          5 score overrides applied                           │
│                                                               │
│ [← Back to Groups]                      [Continue to Review →] │
└───────────────────────────────────────────────────────────────┘
```

**Score Override Behavior**:

```
┌─ Score Override Example ────────────────────────────────────┐
│                                                               │
│ DV HDR10                                                     │
│ Score: 1000  [Override: 1500___] ↺                          │
│              ─────────────────                               │
│              │ Original: 1000  │                             │
│              │ Custom: 1500    │                             │
│              └─────────────────┘                             │
│                                                               │
│ [Click ↺ to reset to original score]                        │
└───────────────────────────────────────────────────────────────┘
```

**Advanced: Conditions Toggle** (hidden by default, opt-in):

```
┌─ Advanced: Custom Format Conditions ────────────────────────┐
│                                                               │
│ ☑ DV HDR10                                                   │
│    Score: 1000  [Override: ______] ↺                        │
│    [⚙️ Advanced Settings ▼]                                  │
│                                                               │
│    ┌───────────────────────────────────────────────────────┐│
│    │ Conditions (Regex patterns):                          ││
│    │                                                        ││
│    │ ☑ Dolby Vision HDR10                                  ││
│    │   Pattern: /\bDV\b.*\bHDR10\b/i                       ││
│    │   [View on regex101.com]                              ││
│    │                                                        ││
│    │ ☑ HDR10 Dolby Vision                                  ││
│    │   Pattern: /\bHDR10\b.*\bDV\b/i                       ││
│    │                                                        ││
│    │ ☐ Alternative pattern (disabled)                      ││
│    │   Pattern: /\bDOVIHDR10\b/i                           ││
│    └───────────────────────────────────────────────────────┘│
│                                                               │
│    [Apply] [Reset to Defaults]                              │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

---

## Step 4: Review & Template Naming

**Purpose**: Final review before creating template, with comprehensive summary.

```
┌─ Step 4: Review & Create Template ──────────────────────────┐
│                                                               │
│ Template Details                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Name: [HD Bluray + WEB________________________]         │ │
│ │                                                          │ │
│ │ Description:                                             │ │
│ │ ┌────────────────────────────────────────────────────┐  │ │
│ │ │ Imported from TRaSH Guides: HD Bluray + WEB       │  │ │
│ │ │ Quality Profile that covers:                       │  │ │
│ │ │ - WEBDL: 1080p                                     │  │ │
│ │ │ - Bluray: 720p, 1080p                              │  │ │
│ │ │                                                     │  │ │
│ │ │ Customized with HDR formats and unwanted filters.  │  │ │
│ │ └────────────────────────────────────────────────────┘  │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                               │
│ Configuration Summary                                        │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Quality Profile: HD Bluray + WEB (sqp-1)                │ │
│ │ Service Type: RADARR                                     │ │
│ │                                                          │ │
│ │ Custom Formats:                                          │ │
│ │ • Mandatory: 2 formats (from quality profile)           │ │
│ │ • Optional: 23 formats (from 3 CF groups)               │ │
│ │ • Total: 25 custom formats                              │ │
│ │                                                          │ │
│ │ Score Overrides:                                         │ │
│ │ • 5 scores customized from defaults                     │ │
│ │                                                          │ │
│ │ CF Groups Enabled:                                       │ │
│ │ • HDR Formats (15 formats)                              │ │
│ │ • Unwanted (8 formats) 🔒                               │ │
│ │ • Audio Channels (12 formats)                           │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                               │
│ Detailed Format List                                         │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ [⊞ Expand All]  [🔍 Search formats...]                  │ │
│ │                                                          │ │
│ │ ▼ Mandatory Formats (2)                                 │ │
│ │   • DV HDR10+ (Score: 1100)                             │ │
│ │   • BR-DISK (Score: -10000)                             │ │
│ │                                                          │ │
│ │ ▼ HDR Formats Group (15)                                │ │
│ │   • DV HDR10 (Score: 1500) ⭐ overridden                │ │
│ │   • HDR10+ (Score: 500)                                 │ │
│ │   • HDR10 (Score: 250)                                  │ │
│ │   • ... and 12 more                                     │ │
│ │                                                          │ │
│ │ ▼ Unwanted Group (8) 🔒                                 │ │
│ │   • LQ (Score: -10000)                                  │ │
│ │   • 3D (Score: -10000)                                  │ │
│ │   • ... and 6 more                                      │ │
│ │                                                          │ │
│ │ ▶ Audio Channels Group (12)                             │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                               │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                               │
│ [← Back to Customize]              [Create Template]        │
└───────────────────────────────────────────────────────────────┘
```

**Success State**:

```
┌─ Template Created Successfully ─────────────────────────────┐
│                                                               │
│          ✅  Template "HD Bluray + WEB" Created              │
│                                                               │
│ Your template has been saved and is ready to deploy to       │
│ Radarr instances.                                            │
│                                                               │
│ Next Steps:                                                  │
│ • Deploy to Radarr instances                                 │
│ • Edit template settings                                     │
│ • Create another template                                    │
│                                                               │
│ [View Template] [Deploy Now] [Create Another] [Close]        │
└───────────────────────────────────────────────────────────────┘
```

---

## Responsive Design Breakpoints

### Desktop (1024px+)
- Full 2-column layout for CF cards
- Side-by-side comparison views
- Expanded details visible by default

### Tablet (768px - 1023px)
- Single column for CF cards
- Collapsible sections for details
- Sticky header with progress

### Mobile (< 768px)
- Vertical stack layout
- Touch-friendly tap targets (min 44px)
- Simplified views with essential info
- Bottom sheet for details

---

## Accessibility Features

### Keyboard Navigation
- Tab order: Progress → Search → Filters → CF Cards → Actions
- Enter/Space: Toggle checkboxes and expand sections
- Arrow keys: Navigate between CF cards
- Esc: Close modals and collapse expanded sections

### Screen Reader Support
- ARIA labels for all interactive elements
- Live region announcements for state changes
- Descriptive button labels
- Proper heading hierarchy

### Visual Accessibility
- High contrast mode support
- Minimum 4.5:1 contrast ratio
- Focus indicators (2px outline)
- No color-only information (use icons + text)

---

## Loading & Error States

### Loading State (Initial Load)
```
┌─ Loading Quality Profile... ────────────────────────────────┐
│                                                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ (skeleton)          │ │
│ │ ░░░░░░░░░░░░░░░░░░░░░░░░                               │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░                      │ │
│ │ ░░░░░░░░░░░░░░░░░░░░░░░░                               │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### Error State
```
┌─ Error Loading CF Groups ───────────────────────────────────┐
│                                                               │
│                 ⚠️  Failed to Load CF Groups                 │
│                                                               │
│ Unable to fetch Custom Format Groups from TRaSH Guides.      │
│                                                               │
│ Error: Network timeout (GitHub API unreachable)              │
│                                                               │
│ [Retry] [Skip CF Groups] [Cancel Import]                     │
└───────────────────────────────────────────────────────────────┘
```

### Empty State (No CF Groups)
```
┌─ No CF Groups Available ────────────────────────────────────┐
│                                                               │
│              📦  No Optional CF Groups Found                 │
│                                                               │
│ This quality profile has no applicable CF groups. You can    │
│ proceed with the mandatory custom formats only.              │
│                                                               │
│ [← Back] [Continue with Mandatory CFs →]                     │
└───────────────────────────────────────────────────────────────┘
```

---

## User Interaction Patterns

### 1. Quick Setup Path (Minimal Clicks)
```
Step 1: Select Profile (1 click)
  → Step 2a: Accept defaults (0 clicks, just "Continue")
    → Step 4: Name template (type) + Create (1 click)

Total: 2 clicks + 1 text entry
```

### 2. Customization Path (Power User)
```
Step 1: Select Profile (1 click)
  → Step 2a: Toggle groups (N clicks)
    → Step 2b: "Customize Selected" (1 click)
      → Step 3: Individual CF toggles + score overrides (M clicks)
        → Step 4: Review + Create (1 click)

Total: 3 + N + M clicks + 1 text entry
```

### 3. Edit Existing Template
```
Template List → Edit (1 click)
  → Opens at Step 3 with existing selections pre-filled
    → Make changes (N clicks)
      → Save (1 click)

Total: 2 + N clicks
```

---

## Visual Design System

### Color Semantics
- **Mandatory/Locked**: `text-amber-400` with 🔒 icon
- **Recommended/Default**: `text-blue-400` with ⭐ badge
- **Required Group**: `text-amber-400` with 🔒 and disabled controls
- **Overridden Score**: `text-green-400` with ⭐ indicator
- **Negative Score**: `text-red-400`
- **Positive Score**: `text-green-400`

### Icon System
- 🔒 Locked/Mandatory (cannot deselect)
- ⭐ Recommended/Default/Overridden
- ℹ️ Information/Help
- ▼/▶ Expand/Collapse
- ↺ Reset to default
- ⚙️ Advanced settings
- 🔍 Search
- ✅ Success
- ⚠️ Warning/Error

### Typography
- **Headings**: `text-xl font-semibold`
- **CF Names**: `text-base font-medium`
- **Descriptions**: `text-sm text-fg-muted`
- **Scores**: `text-sm font-mono`
- **Help Text**: `text-xs text-fg-muted italic`

### Spacing
- Section gaps: `gap-6`
- Card gaps: `gap-4`
- Internal padding: `p-4` (cards), `p-6` (sections)
- Input spacing: `gap-2`

---

## Component Hierarchy

```
QualityProfileWizard
├── WizardProgressBar
├── WizardStep1_ProfileSelection
│   └── QualityProfileCard[]
├── WizardStep2a_CFGroupSelection
│   ├── CFGroupCard[]
│   └── CFGroupInfoModal
├── WizardStep2b_CFCustomization
│   ├── SearchFilter
│   ├── MandatoryCFSection
│   │   └── MandatoryCFCard[]
│   ├── OptionalCFGroupSection[]
│   │   ├── CFGroupHeader
│   │   └── OptionalCFCard[]
│   └── AdvancedConditionsEditor (optional)
└── WizardStep4_Review
    ├── TemplateDetailsForm
    ├── ConfigurationSummary
    └── DetailedFormatList
```

---

## State Management

### Wizard State Schema
```typescript
interface WizardState {
  // Step tracking
  currentStep: 1 | 2 | 3 | 4;

  // Step 1
  selectedProfile: QualityProfileSummary | null;

  // Step 2a
  enabledCFGroups: Set<string>;  // trash_ids of enabled groups

  // Step 2b/3
  customFormatSelections: Record<string, {
    selected: boolean;
    scoreOverride?: number;
    conditionsEnabled: Record<string, boolean>;
  }>;

  // Step 4
  templateName: string;
  templateDescription: string;

  // Metadata
  hasUserModifications: boolean;
  isEditMode: boolean;  // editing existing vs creating new
  originalTemplateId?: string;
}
```

### Computed Values
```typescript
// Derived from state
const mandatoryCFs = profile.formatItems;
const optionalCFs = enabledCFGroups.flatMap(group => group.custom_formats);
const totalCFs = mandatoryCFs.length + optionalCFs.length;
const scoreOverrideCount = Object.values(customFormatSelections)
  .filter(s => s.scoreOverride !== undefined).length;
```

---

## API Integration Points

### Step 1: Load Profiles
```typescript
GET /api/trash-guides/quality-profiles/:serviceType
Response: { profiles: QualityProfileSummary[], count: number }
```

### Step 2: Load Profile Details + CF Groups
```typescript
GET /api/trash-guides/quality-profiles/:serviceType/:trashId
Response: {
  profile: TrashQualityProfile,
  mandatoryCFs: CustomFormat[],
  cfGroups: CFGroup[],
  stats: { mandatoryCount, optionalGroupCount, totalOptionalCFs }
}
```

### Step 4: Create Template
```typescript
POST /api/trash-guides/quality-profiles/import
Body: {
  serviceType: "RADARR" | "SONARR",
  trashId: string,
  templateName: string,
  templateDescription: string,
  selectedCFGroups: string[],  // trash_ids
  customFormatSelections: Record<string, {...}>
}
Response: {
  template: TrashTemplate,
  message: string,
  customFormatsIncluded: number,
  customFormatGroupsIncluded: number
}
```

---

## Performance Considerations

### Optimization Strategies
1. **Virtualized Lists**: For CF lists >50 items, use virtual scrolling
2. **Lazy Loading**: Load CF descriptions on demand (expand)
3. **Debounced Search**: 300ms delay for search input
4. **Memoization**: Cache computed values (total counts, filtered lists)
5. **Progressive Enhancement**: Load Step 2 data only when Step 1 completes

### Bundle Size
- Code-split wizard steps (load on demand)
- Lazy load advanced features (conditions editor)
- Optimize icon usage (use shared icon sprite)

---

## Testing Strategy

### Unit Tests
- [ ] Wizard state management
- [ ] CF selection logic
- [ ] Score override validation
- [ ] Mandatory vs optional distinction

### Integration Tests
- [ ] Complete wizard flow (all steps)
- [ ] Edit existing template flow
- [ ] CF Group enabling/disabling
- [ ] Score override and reset

### E2E Tests (Playwright)
- [ ] Quick setup path (minimal clicks)
- [ ] Power user path (full customization)
- [ ] Search and filtering
- [ ] Responsive design (mobile, tablet, desktop)
- [ ] Accessibility (keyboard navigation, screen reader)

### Edge Cases
- [ ] Zero-score CFs
- [ ] Missing CF descriptions
- [ ] Empty CF groups
- [ ] Network errors during load
- [ ] Conflict with existing template name

---

## Success Metrics

### UX Metrics
- **Time to Complete**: <2 min for quick setup, <5 min for full customization
- **Error Rate**: <5% of wizard completions encounter errors
- **Abandonment Rate**: <20% abandon wizard before completion
- **Edit Rate**: >30% of users edit templates after creation

### Technical Metrics
- **Load Time**: <2s for Step 1, <3s for Step 2 (with cache)
- **Search Latency**: <100ms for CF search
- **Bundle Size**: <150KB (gzipped) for wizard code

---

## Future Enhancements

### Phase 2+
- [ ] Template comparison (side-by-side)
- [ ] Template recommendations based on usage
- [ ] CF analytics (most popular, highest impact)
- [ ] Template presets (beginner, intermediate, advanced)
- [ ] Guided tour for first-time users
- [ ] Template versioning with diff view
- [ ] Community template marketplace integration

---

This specification provides a complete UX blueprint for implementing the hybrid wizard approach. Next steps would be to begin Phase 1 implementation, starting with the foundational work of removing legacy mode and implementing proper CF distinction.
