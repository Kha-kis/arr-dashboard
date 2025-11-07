# TRaSH Guides Implementation Roadmap

## Overview
Complete implementation plan for TRaSH Guides quality profile management system with wizard-based customization and template deployment.

---

## Phase 1: Foundation & Critical Gaps (Sprint 5)

**Priority**: Fix existing implementation gaps and remove legacy mode

### 1.1 Remove Legacy Mode
- [ ] Remove legacy import path from API
- [ ] Update API to require wizard selections
- [ ] Remove backward compatibility code
- [ ] Update documentation

### 1.2 Mandatory vs Optional CF Distinction
- [ ] API: Add `source: "profile" | "group"` field to CF responses
- [ ] API: Separate `mandatoryCFs` and `optionalCFs` in response
- [ ] UI: Visual distinction with lock icon for mandatory CFs
- [ ] UI: Warning dialog if user tries to deselect mandatory CF

### 1.3 CF Group `required` and `default` Logic
- [ ] API: Ensure `required` and `defaultChecked` fields in CF enrichment
- [ ] API: Add `defaultEnabled` for groups
- [ ] UI: Implement group-level toggle for `required: true` groups
- [ ] UI: Disable individual CF checkboxes when group has `required: true`
- [ ] UI: Pre-check groups/CFs with `default: "true"` on first load

### 1.4 Zero-Score CF Handling
- [ ] API: Explicitly return `score: 0` when no default exists
- [ ] UI: Display "Score: 0" instead of null/undefined
- [ ] UI: Allow override for zero-score CFs

### 1.5 Score Override UX
- [ ] UI: Add reset button (↺) next to each score override field
- [ ] UI: Show original score vs overridden score clearly
- [ ] UI: Validate score inputs (numbers only)

**Deliverable**: Robust wizard with proper CF handling, no legacy mode

---

## Phase 2: UX Enhancement & Wizard Steps (Sprint 6)

**Priority**: Implement hybrid wizard flow with CF Group selection

### 2.1 Wizard Restructure
- [ ] Step 1: Quality Profile Selection (✅ exists)
- [ ] Step 2a: CF Group Selection (new)
  - [ ] Show applicable groups with counts
  - [ ] Pre-check groups with `default: "true"`
  - [ ] Show score impact preview
  - [ ] Allow skip to Step 3
- [ ] Step 2b: CF Customization (enhance existing)
  - [ ] Grouped view with expand/collapse
  - [ ] Mandatory section at top
  - [ ] Optional sections by group
  - [ ] Search/filter capabilities
- [ ] Step 3: Template Naming & Summary (✅ exists, enhance)
  - [ ] Show summary stats (X mandatory, Y optional CFs)
  - [ ] Preview score impact

### 2.2 Visual Design System
- [ ] Create UI components for CF display
  - [ ] `MandatoryCFCard` with lock icon
  - [ ] `OptionalCFCard` with checkbox
  - [ ] `CFGroupSection` with expand/collapse
  - [ ] `ScoreOverrideInput` with reset button
- [ ] Implement grouping and filtering
- [ ] Add loading states and error handling

### 2.3 Responsive Design
- [ ] Mobile-friendly wizard
- [ ] Tablet optimization
- [ ] Keyboard navigation support

**Deliverable**: Polished wizard UX with clear visual hierarchy

---

## Phase 3: Template Management & Versioning (Sprint 7)

**Priority**: Implement versioning, sync strategy, and template editing

### 3.1 Template Metadata Schema
- [ ] Add `TemplateMetadata` to database schema
  - [ ] `trashGuidesVersion` (commit hash, import timestamp)
  - [ ] `customization` (dirty flag, modified fields)
  - [ ] `syncStrategy` ("auto" | "manual" | "notify")
  - [ ] `changeLog` (optional history)
- [ ] Migration script for existing templates

### 3.2 Template Edit Flow
- [ ] Load existing template into wizard
- [ ] Preserve user selections (groups, scores, conditions)
- [ ] Track modifications vs original TRaSH Guides config
- [ ] Update `hasUserModifications` flag

### 3.3 Sync with TRaSH Guides
- [ ] Background job to check for TRaSH Guides updates
- [ ] Compare template's commit hash with latest
- [ ] For unmodified templates: Auto-update
- [ ] For modified templates: Show notification
  - [ ] Diff view (what changed in TRaSH Guides)
  - [ ] User choice: Keep custom, sync new, merge

### 3.4 Template Storage Optimization
- [ ] Store both CF Group references AND flattened CFs
- [ ] Maintain relationship for group-level operations
- [ ] Enable granular updates

**Deliverable**: Smart template versioning with sync capabilities

---

## Phase 4: Deployment System (Sprint 8)

**Priority**: Deploy templates to *arr instances with preview and conflict handling

### 4.1 Deployment Preview
- [ ] API: Generate preview of changes to *arr instance
  - [ ] New CFs to be added
  - [ ] Existing CFs to be updated
  - [ ] Conflicts (different scores/conditions)
- [ ] UI: Preview screen before deployment
  - [ ] Side-by-side comparison
  - [ ] Highlight conflicts
  - [ ] Allow per-CF conflict resolution

### 4.2 Multi-Instance Support
- [ ] Template variants per instance
  - [ ] Base template + instance-specific overrides
  - [ ] Share common CFs, customize scores per instance
- [ ] Bulk deployment with review

### 4.3 Conflict Resolution
- [ ] Conflict detection algorithm
- [ ] Resolution strategies:
  - [ ] Merge (smart combine)
  - [ ] Replace (overwrite)
  - [ ] Keep existing
  - [ ] Manual per-CF choice
- [ ] Rollback support

### 4.4 Deployment History
- [ ] Track deployments per instance
- [ ] Store pre-deployment state (for rollback)
- [ ] Audit log

**Deliverable**: Robust deployment system with conflict handling

---

## Phase 5: Advanced Features (Sprint 9)

**Priority**: Power user features and management tools

### 5.1 Bulk Score Management Tab
- [ ] New "Score Management" section
- [ ] Table view of all CFs across all quality profiles
- [ ] Filters: Service type, profile, group, CF name
- [ ] Bulk actions:
  - [ ] Edit scores (select multiple → set score)
  - [ ] Copy scores between profiles
  - [ ] Reset to TRaSH Guides defaults
- [ ] Export/import score configurations

### 5.2 Advanced Custom Format Conditions
- [ ] UI to enable/disable individual conditions
- [ ] Advanced mode toggle (hidden by default)
- [ ] Condition editor with validation
- [ ] Preview of regex patterns

### 5.3 Complete Quality Profile Clone
- [ ] Import full quality profile settings:
  - [ ] Quality definitions (cutoff, upgrade behavior)
  - [ ] Custom format scores
  - [ ] Language preferences
- [ ] Template as complete *arr profile

### 5.4 Sharing & Community
- [ ] Export template as JSON
- [ ] Import template from JSON
- [ ] (Future) Community template repository
- [ ] Template validation on import

**Deliverable**: Power user tools and sharing capabilities

---

## Phase 6: Polish & Production (Sprint 10)

**Priority**: Testing, documentation, and production readiness

### 6.1 Comprehensive Testing
- [ ] Unit tests for all services
- [ ] Integration tests for wizard flow
- [ ] E2E tests with Playwright
- [ ] Test edge cases:
  - [ ] Zero-score CFs
  - [ ] Missing data handling
  - [ ] Conflict scenarios
  - [ ] Multi-instance deployments

### 6.2 Documentation
- [ ] User guide for wizard
- [ ] API documentation
- [ ] Admin guide for TRaSH Guides sync
- [ ] Troubleshooting guide

### 6.3 Performance Optimization
- [ ] Cache optimization
- [ ] Lazy loading for large CF lists
- [ ] Pagination for tables
- [ ] Background sync jobs

### 6.4 Error Handling & UX Polish
- [ ] Comprehensive error messages
- [ ] Loading states
- [ ] Empty states
- [ ] Success confirmations
- [ ] Undo capabilities

**Deliverable**: Production-ready feature with full documentation

---

## Technical Specifications

### API Schema Changes

```typescript
// Enhanced API response for quality profile details
interface QualityProfileDetailResponse {
  profile: TrashQualityProfile;

  // Separated mandatory vs optional
  mandatoryCFs: Array<{
    trash_id: string;
    name: string;
    displayName: string;
    description: string;
    score: number | 0;
    specifications: any[];
    source: "profile";  // NEW
    locked: true;       // NEW
  }>;

  cfGroups: Array<{
    trash_id: string;
    name: string;
    description: string;
    defaultEnabled: boolean;     // from group.default
    required: boolean;           // from group.required
    custom_formats: Array<{
      trash_id: string;
      name: string;
      displayName: string;
      description: string;
      score: number | 0;
      required: boolean;         // from CF.required
      defaultChecked: boolean;   // from CF.default
      specifications: any[];
      source: "group";           // NEW
    }>;
  }>;

  stats: {
    mandatoryCount: number;
    optionalGroupCount: number;
    totalOptionalCFs: number;
  };

  metadata: {
    trashGuidesCommit: string;   // NEW
    lastUpdated: string;         // NEW
  };
}
```

### Database Schema Additions

```typescript
// Add to Template model
model TrashTemplate {
  // ... existing fields ...

  // Versioning
  trashGuidesCommitHash  String?
  importedAt             DateTime  @default(now())
  lastSyncedAt           DateTime?

  // Customization tracking
  hasUserModifications   Boolean   @default(false)
  modifiedFields         Json?     // ["scores", "cf_selections"]
  lastModifiedAt         DateTime?

  // Sync strategy
  syncStrategy           String    @default("notify") // "auto" | "manual" | "notify"

  // Change history (optional)
  changeLog              Json?

  // Instance variants
  instanceOverrides      Json?     // Per-instance score/condition overrides
}

// New model for deployment history
model TemplateDeployment {
  id                String    @id @default(cuid())
  templateId        String
  template          TrashTemplate @relation(fields: [templateId], references: [id])

  instanceId        String
  instance          Instance  @relation(fields: [instanceId], references: [id])

  deployedAt        DateTime  @default(now())
  deployedBy        String    // userId

  // Deployment details
  conflictResolution Json?    // How conflicts were resolved
  preDeploymentState Json?    // For rollback

  status            String    // "success" | "partial" | "failed"
  errorLog          Json?
}
```

---

## Success Criteria

### Phase 1 (Sprint 5)
- ✅ Legacy mode completely removed
- ✅ Mandatory CFs clearly distinguished from optional
- ✅ CF Group required/default logic working correctly
- ✅ Zero-score CFs display correctly
- ✅ Score override with reset functionality

### Phase 2 (Sprint 6)
- ✅ Hybrid wizard flow (group selection + customization)
- ✅ Visual hierarchy matches mockups
- ✅ Responsive design works on all devices
- ✅ Search and filtering functional

### Phase 3 (Sprint 7)
- ✅ Template versioning tracks TRaSH Guides commits
- ✅ Edit flow preserves user selections
- ✅ Sync notifications for modified templates
- ✅ Auto-sync for unmodified templates

### Phase 4 (Sprint 8)
- ✅ Deployment preview shows accurate changes
- ✅ Conflict resolution works for all scenarios
- ✅ Multi-instance management functional
- ✅ Rollback capability tested

### Phase 5 (Sprint 9)
- ✅ Bulk score management table functional
- ✅ Advanced conditions editor (opt-in)
- ✅ Template export/import working
- ✅ Complete profile clone capability

### Phase 6 (Sprint 10)
- ✅ Test coverage >80%
- ✅ All documentation complete
- ✅ Performance benchmarks met
- ✅ Production deployment successful

---

## Dependencies & Risks

### Technical Dependencies
- TRaSH Guides GitHub API availability
- Radarr/Sonarr API compatibility
- Database migration success

### Risks & Mitigations
- **Risk**: TRaSH Guides structure changes
  - **Mitigation**: Version tracking + backward compatibility layer

- **Risk**: Large CF lists causing performance issues
  - **Mitigation**: Pagination, lazy loading, virtualized lists

- **Risk**: Conflict resolution complexity
  - **Mitigation**: Clear UX, safe defaults, rollback capability

- **Risk**: User confusion with wizard complexity
  - **Mitigation**: Progressive disclosure, tooltips, documentation

---

## Timeline Estimate

- **Phase 1**: 1 week (5-7 days)
- **Phase 2**: 1.5 weeks (8-10 days)
- **Phase 3**: 1 week (5-7 days)
- **Phase 4**: 1.5 weeks (8-10 days)
- **Phase 5**: 1 week (5-7 days)
- **Phase 6**: 1 week (5-7 days)

**Total**: ~7 weeks (35-42 days) for complete implementation

**Minimum Viable Product (MVP)**: Phases 1-3 (~3.5 weeks)
