# TRaSH Guides Feature - Brainstorming Summary

## Session Overview

**Date**: 2025-11-07
**Objective**: Refine and complete TRaSH Guides quality profile management system
**Current State**: Wizard-based import partially implemented, requires enhancement
**Desired State**: Production-ready template system with deployment capabilities

---

## Key Decisions Made

### 1. User Experience Strategy

**Decision**: Hybrid wizard approach combining quick setup with granular customization

**Rationale**:
- Serves both quick setup users (recommended defaults) and power users (full control)
- Progressive disclosure keeps UI simple by default, powerful when needed
- Balances ease-of-use with flexibility

**Implementation**:
- Step 2a: CF Group Selection (quick setup)
- Step 2b: Individual CF Customization (power users)
- Allow skip from 2a directly to review for fastest path

### 2. Legacy Mode Removal

**Decision**: Remove legacy mode entirely, wizard-only approach

**Rationale**:
- Legacy mode auto-imports everything, doesn't align with user choice philosophy
- Wizard provides better UX and clear understanding of what's being imported
- Reduces code complexity and maintenance burden

**Impact**: Breaking change requiring migration guide for existing users

### 3. Mandatory vs Optional CF Handling

**Decision**: Visual lock icon (🔒) with warning on deselection attempt

**Rationale**:
- Users can see what's mandatory but have emergency override if needed
- Warning dialog educates users about consequences
- More flexible than fully disabled checkboxes

**Implementation**:
- Mandatory section at top of CF list
- Lock icon and amber color coding
- Confirmation dialog if user tries to deselect

### 4. CF Group `required` Logic

**Decision**: Group-level toggle, individual CFs cannot be deselected

**Rationale**:
- Honors TRaSH Guides intent (all-or-nothing groups)
- Clear UX: toggle group = toggle all CFs in group
- Prevents user confusion about partial group selection

**Implementation**:
- Group header with ON/OFF toggle
- Individual CFs shown as bullets (not checkboxes)
- Visual distinction with lock icon

### 5. CF Group `default` Logic

**Decision**: Pre-check on first import, remember user choice on edit

**Rationale**:
- First-time users benefit from TRaSH Guides recommendations
- Editing existing template preserves user intent
- Balance between smart defaults and user control

**Implementation**:
- `isEditMode` flag in wizard state
- Pre-check logic: `if (!isEditMode && group.default === "true")`
- Edit mode: Load from saved template state

### 6. Score Management

**Decisions**:
- Display zero scores as "Score: 0" (explicit)
- Show original score with override field and reset button (↺)
- Bulk score management as separate tab (table view)

**Rationale**:
- Clarity over implicit behavior (0 is a valid score)
- Reset button enables experimentation without losing defaults
- Bulk management for power users managing many profiles

**Implementation**:
- Score display: `{score ?? 0}` (null coalescing to 0)
- Reset button clears override, shows original
- Separate "Score Management" feature in Phase 5

### 7. Template Storage Structure

**Decision**: Store both CF Group references AND flattened CFs

**Rationale**:
- Group references: Maintain relationship for group-level operations
- Flattened CFs: Enable granular updates and fast retrieval
- Flexibility: Support both group and individual CF operations

**Implementation**:
```typescript
interface TemplateConfig {
  customFormats: CustomFormat[];        // Flattened
  customFormatGroups: CFGroupRef[];     // References
}
```

### 8. Template Sync Strategy

**Decision**: Auto-sync unmodified, notify modified templates

**Rationale**:
- Unmodified templates stay current automatically
- User customizations always preserved unless explicitly overridden
- Balance between convenience and safety

**Implementation**:
- Daily background job checks for updates
- `hasUserModifications` flag determines behavior
- Diff view for modified templates

### 9. Versioning Approach

**Decision**: Git-style versioning with dirty flag tracking

**Rationale**:
- Full traceability to TRaSH Guides source (commit hash)
- Smart sync decisions based on modification state
- Audit trail for troubleshooting
- Reasonable storage overhead

**Implementation**:
- Store commit hash, import timestamp, modification flag
- Track modified fields for smart merge
- Optional change log for advanced users
- See: `trash-guides-versioning-best-practices.md`

### 10. Deployment Workflow

**Decision**: Review-then-deploy with preview and conflict handling

**Rationale**:
- Safety: Users see exactly what will change before applying
- Transparency: Conflicts are visible and user-controlled
- Flexibility: Per-CF conflict resolution

**Implementation**:
- Preview API endpoint shows diff vs current instance state
- Conflict resolution UI with multiple strategies
- Per-instance template variants for multi-instance setups

### 11. Advanced Features

**Decisions**:
- Custom format conditions: Advanced mode (opt-in)
- Complete profile clone: Include quality settings, not just CFs
- Sharing: Export/import JSON + future community marketplace

**Rationale**:
- Power features hidden from basic users (progressive disclosure)
- Complete profile clone addresses advanced use cases
- Sharing enables community collaboration

**Implementation Timeline**: Phase 5 (advanced features)

---

## Documents Created

### 1. Implementation Roadmap
**File**: `trash-guides-implementation-roadmap.md`
**Purpose**: Complete 6-phase implementation plan with timeline

**Highlights**:
- Phase 1: Foundation (remove legacy, fix gaps) - 1 week
- Phase 2: UX Enhancement (wizard steps) - 1.5 weeks
- Phase 3: Versioning & Sync - 1 week
- Phase 4: Deployment System - 1.5 weeks
- Phase 5: Advanced Features - 1 week
- Phase 6: Production Polish - 1 week
- **Total**: ~7 weeks (MVP in 3.5 weeks)

### 2. UX Specification
**File**: `trash-guides-wizard-ux-specification.md`
**Purpose**: Detailed UX design for hybrid wizard approach

**Highlights**:
- Step-by-step wireframes
- Component hierarchy
- State management schema
- Responsive design breakpoints
- Accessibility features
- Loading/error states

### 3. Versioning Best Practices
**File**: `trash-guides-versioning-best-practices.md`
**Purpose**: Comprehensive versioning strategy recommendation

**Highlights**:
- Git-style versioning with dirty flag
- Sync decision tree
- Diff view implementation
- Merge strategy
- Rollback capabilities
- API endpoints

### 4. Data Structure Analysis (Existing)
**File**: `trash-guides-data-structure-analysis.md`
**Purpose**: Understanding TRaSH Guides data structures

**Status**: Already reviewed, informs implementation

---

## Technical Specifications

### Enhanced API Response
```typescript
interface QualityProfileDetailResponse {
  profile: TrashQualityProfile;
  mandatoryCFs: CustomFormat[];        // NEW: Separated
  cfGroups: CFGroup[];                 // Enhanced
  stats: {
    mandatoryCount: number;
    optionalGroupCount: number;
    totalOptionalCFs: number;
  };
  metadata: {
    trashGuidesCommit: string;         // NEW: Versioning
    lastUpdated: string;
  };
}
```

### Database Schema Additions
```typescript
model TrashTemplate {
  // ... existing fields ...

  // Versioning
  trashGuidesCommitHash  String?
  importedAt             DateTime  @default(now())
  lastSyncedAt           DateTime?

  // Customization tracking
  hasUserModifications   Boolean   @default(false)
  modifiedFields         Json?
  lastModifiedAt         DateTime?

  // Sync strategy
  syncStrategy           String    @default("notify")

  // Change history
  changeLog              Json?

  // Instance variants
  instanceOverrides      Json?
}

model TemplateDeployment {
  // NEW: Deployment tracking
  id                String    @id @default(cuid())
  templateId        String
  instanceId        String
  deployedAt        DateTime  @default(now())
  conflictResolution Json?
  preDeploymentState Json?
  status            String
}
```

---

## Success Criteria

### Phase 1 (MVP - 3.5 weeks)
- ✅ Legacy mode removed
- ✅ Mandatory/optional CFs clearly distinguished
- ✅ CF Group required/default logic working
- ✅ Zero-score CFs handled correctly
- ✅ Score override with reset
- ✅ Hybrid wizard flow (group selection + customization)
- ✅ Template versioning with commit hash tracking
- ✅ Auto-sync for unmodified templates

### Full Feature (7 weeks)
- ✅ All MVP features
- ✅ Deployment preview and conflict handling
- ✅ Multi-instance management
- ✅ Bulk score management tab
- ✅ Advanced conditions editor
- ✅ Template sharing (export/import)
- ✅ Complete documentation
- ✅ >80% test coverage

---

## Questions Answered

### Original Question Set

1. **Primary Use Case**: Both power users and quick setup (Hybrid approach)
2. **CF Group Selection**: Mock up both approaches (Hybrid wizard recommended)
3. **Mandatory CF Distinction**: Lock icon with warning on deselection
4. **CF Group `required`**: Group toggle, no individual control
5. **CF Group `default`**: Pre-checked on first import, preserved on edit
6. **Profile-Specific Groups**: Transparent filtering (show applicable only)
7. **Zero-Score CFs**: Display as "Score: 0"
8. **Score Override UX**: Original + override with reset button
9. **Bulk Score Management**: Separate tab with table view
10. **Template Storage**: Both group references and flattened CFs
11. **Template Updates**: Auto-sync unmodified, notify modified
12. **Versioning**: Git-style with commit hash (recommended)
13. **Deployment Workflow**: Review-then-deploy with preview
14. **Multi-Instance**: Per-instance template variants
15. **Conflict Handling**: User choice per deployment
16. **CF Conditions**: Advanced mode (opt-in)
17. **Quality Profile Settings**: Complete profile clone
18. **Sharing**: Export/import JSON + future marketplace

---

## Recommended Next Steps

### Immediate Actions

1. **Review Documents**
   - Read implementation roadmap
   - Review UX specification
   - Understand versioning strategy

2. **Prioritize Phases**
   - Confirm Phase 1-3 for MVP (3.5 weeks)
   - OR full 6-phase implementation (7 weeks)
   - Adjust timeline based on team capacity

3. **Technical Decisions**
   - Database migration planning
   - API versioning strategy
   - Testing approach (unit, integration, E2E)

### Implementation Start

**Option A: Sprint-Based** (Recommended)
- Start with Phase 1 (Foundation) - Sprint 5
- Sprint planning session for detailed task breakdown
- Daily standups to track progress
- Demo at end of each sprint

**Option B: Iterative Development**
- Build feature by feature (CF distinction → Groups → Versioning)
- Continuous integration and testing
- User feedback loops after each feature

### Questions for You

Before starting implementation:

1. **Timeline Priority**: MVP (3.5 weeks) or Full Feature (7 weeks)?
2. **Team Capacity**: How many developers? Full-time or part-time?
3. **Testing Requirements**: Unit tests only? Or full E2E with Playwright?
4. **Database Migration**: Can you handle schema changes? Downtime acceptable?
5. **Deployment Strategy**: Phased rollout or all-at-once?
6. **User Communication**: How to announce changes (especially legacy mode removal)?

---

## Risk Mitigation

### Identified Risks

1. **TRaSH Guides Structure Changes**
   - **Risk**: GitHub structure changes break fetcher
   - **Mitigation**: Version-aware fetcher, backward compatibility layer
   - **Monitoring**: Daily sync job alerts on fetch failures

2. **Performance Issues**
   - **Risk**: Large CF lists cause UI slowdowns
   - **Mitigation**: Virtualized lists, pagination, lazy loading
   - **Testing**: Load testing with 100+ CFs

3. **User Confusion**
   - **Risk**: Wizard complexity overwhelms users
   - **Mitigation**: Progressive disclosure, tooltips, documentation
   - **Validation**: User testing sessions

4. **Migration Complexity**
   - **Risk**: Existing templates break with new schema
   - **Mitigation**: Careful migration script, rollback plan
   - **Testing**: Migrate staging environment first

5. **Sync Conflicts**
   - **Risk**: User loses customizations in sync
   - **Mitigation**: Diff view, explicit confirmation, snapshots
   - **Safety**: Always create pre-sync snapshot

---

## Success Metrics

### User Experience
- **Wizard Completion Rate**: >80% of users complete wizard
- **Time to Complete**: <2 min quick setup, <5 min full customization
- **Error Rate**: <5% encounter errors during import
- **Edit Rate**: >30% edit templates after creation

### Technical Performance
- **API Response Time**: <2s for profile list, <3s for details
- **Search Latency**: <100ms for CF search
- **Sync Job Duration**: <5 min for 100 templates
- **Bundle Size**: <150KB (gzipped) for wizard

### Business Impact
- **Adoption**: >50% of users use TRaSH Guides templates
- **Deployment Success**: >90% successful deployments
- **Support Tickets**: <10% increase (despite new feature)
- **User Satisfaction**: >4.5/5 rating

---

## Resources & References

### TRaSH Guides Documentation
- **Contributing Guide**: https://github.com/TRaSH-Guides/Guides/blob/master/CONTRIBUTING.md
- **Quality Profiles**: https://github.com/TRaSH-Guides/Guides/tree/master/docs/json/radarr/quality-profiles
- **CF Groups**: https://github.com/TRaSH-Guides/Guides/tree/master/docs/json/radarr/cf-groups
- **Custom Formats**: https://github.com/TRaSH-Guides/Guides/tree/master/docs/json/radarr/cf

### Internal Documentation
- **Data Structure Analysis**: `claudedocs/trash-guides-data-structure-analysis.md`
- **Implementation Roadmap**: `claudedocs/trash-guides-implementation-roadmap.md`
- **UX Specification**: `claudedocs/trash-guides-wizard-ux-specification.md`
- **Versioning Best Practices**: `claudedocs/trash-guides-versioning-best-practices.md`

### Existing Implementation
- **API Routes**: `apps/api/src/routes/trash-guides/quality-profile-routes.ts`
- **Wizard Component**: `apps/web/src/features/trash-guides/components/quality-profile-wizard.tsx`
- **Type Definitions**: `packages/shared/src/types/trash-guides.ts`

---

## Final Recommendation

**Start with MVP (Phases 1-3)**

**Why**:
- Delivers core value in 3.5 weeks
- Validates architecture before full build
- Enables early user feedback
- Reduces risk of over-engineering

**MVP Scope**:
- Remove legacy mode
- Hybrid wizard (group selection + customization)
- Mandatory/optional CF distinction
- Score override with reset
- Basic versioning with auto-sync
- Template editing

**Post-MVP**:
- User testing and feedback
- Adjust UX based on real usage
- Proceed with Phases 4-6 if validated

**Timeline**:
- **Weeks 1-2**: Phase 1 (Foundation)
- **Weeks 3-4**: Phase 2 (UX Enhancement)
- **Week 5**: Phase 3 (Versioning)
- **Week 6**: Buffer for testing and fixes
- **Week 7**: User testing and documentation

**Team Recommendation**:
- 2 developers (1 frontend, 1 backend) = 4 weeks
- 1 full-stack developer = 5-6 weeks
- With QA support: Add 1 week for comprehensive testing

---

## Conclusion

This brainstorming session has produced:
✅ Clear architectural decisions
✅ Comprehensive implementation plan
✅ Detailed UX specification
✅ Best practice versioning strategy
✅ Risk mitigation approaches
✅ Success criteria and metrics

**You're ready to proceed with implementation!**

Next step: Review all documents, confirm MVP scope, and begin Phase 1 development.

---

**Questions or need clarification on any aspect?** I'm here to help refine any part of this plan! 🚀
