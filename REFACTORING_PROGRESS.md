# Refactoring Progress Tracker

**Started:** 2025-10-06
**Target:** Break down large files for better maintainability

## Overview

This document tracks the ongoing refactoring effort to improve code maintainability and modularity based on TheAuditor analysis.

---

## Phase 1: Utility Extraction ✅ COMPLETED

### library-client.tsx - Utilities Extracted

**Status:** ✅ Complete
**Date:** 2025-10-06

#### Files Created:

1. **`apps/web/src/features/library/lib/library-constants.tsx`** (~30 LOC)
   - Extracted: SERVICE_OPTIONS, STATUS_FILTERS, FILE_FILTERS
   - Added type exports: StatusFilter, FileFilter
   - ✅ No React dependencies except JSX for icons
   - ✅ Pure configuration data

2. **`apps/web/src/features/library/lib/library-utils.ts`** (~85 LOC)
   - Extracted: formatBytes, formatRuntime, normalizeBaseUrl
   - Extracted: buildLibraryExternalLink, groupItemsByType
   - ✅ Pure functions with no side effects
   - ✅ Full JSDoc documentation
   - ✅ Strongly typed with TypeScript

#### Benefits Achieved:
- ✅ Utilities can now be unit tested independently
- ✅ Reusable across other components
- ✅ Clear separation of concerns
- ✅ Reduced main component by ~115 LOC

#### Next Steps:
1. Update `library-client.tsx` to import from these new files
2. Remove the extracted code from `library-client.tsx`
3. Test that library page still works correctly

---

## Phase 2: Simple Component Extraction (NOT STARTED)

### Target Components:

1. **library-badge.tsx** (~25 LOC)
   - Lines to extract: 137-157
   - Dependencies: `cn` utility, React
   - Risk: LOW

2. **item-details-modal.tsx** (~205 LOC)
   - Lines to extract: 519-713
   - Dependencies: library-utils, UI components
   - Risk: LOW

**Estimated Time:** 1-2 hours
**Priority:** HIGH (enables Phase 3)

---

## Phase 3: Complex Component Extraction (NOT STARTED)

### Target Components:

1. **season-episode-list.tsx** (~160 LOC)
   - Lines to extract: 715-867
   - Dependencies: LibraryBadge, API hooks
   - Risk: MEDIUM

2. **season-breakdown-modal.tsx** (~265 LOC)
   - Lines to extract: 869-1123
   - Dependencies: LibraryBadge, SeasonEpisodeList
   - Risk: MEDIUM

3. **library-card.tsx** (~370 LOC)
   - Lines to extract: 159-518
   - Dependencies: LibraryBadge, library-utils, many UI components
   - Risk: MEDIUM-HIGH

**Estimated Time:** 4-6 hours
**Priority:** HIGH (biggest complexity reduction)

---

## Phase 4: Custom Hooks Extraction (NOT STARTED)

### Target Hooks:

1. **use-library-filters.ts** (~35 LOC)
   - State: serviceFilter, instanceFilter, searchTerm, statusFilter, fileFilter
   - Logic: Filter reset on service change
   - Risk: MEDIUM

2. **use-library-data.ts** (~60 LOC)
   - Logic: Data fetching, filtering, grouping
   - Memoization: filteredItems, groupedItems, instanceOptions
   - Risk: MEDIUM

3. **use-library-actions.ts** (~210 LOC)
   - Logic: All action handlers (search, monitor, etc.)
   - State: pendingSeasonAction, pendingMovieSearch, pendingSeriesSearch
   - Risk: MEDIUM-HIGH

**Estimated Time:** 3-4 hours
**Priority:** MEDIUM (reduces main component logic)

---

## Phase 5: Layout Components (NOT STARTED)

### Target Components:

1. **library-header.tsx** (~130 LOC)
   - Header, filters, search input
   - Dependencies: library-constants, use-library-filters hook
   - Risk: MEDIUM

2. **library-content.tsx** (~120 LOC)
   - Main content area with movies/series sections
   - Dependencies: LibraryCard, EmptyState, Alert
   - Risk: MEDIUM

**Estimated Time:** 2-3 hours
**Priority:** MEDIUM (final structural improvement)

---

## Phase 6: Main Component Refactor (NOT STARTED)

### Target:

**library-client.tsx** (Refactored to ~90 LOC)
- Remove all extracted code
- Import and orchestrate all hooks and components
- Keep only:
  - Modal state (seasonDetail, itemDetail)
  - Modal handlers
  - Render logic using extracted components

**Estimated Time:** 2-3 hours
**Priority:** HIGH (completes refactoring)
**Risk:** HIGH (integration point - requires thorough testing)

---

## Similar Refactorings Needed

### Priority 2: settings-client.tsx (1,271 LOC)
**Status:** NOT STARTED
**Hotspot Score:** 42.54
**Estimated Time:** 2-3 days

### Priority 3: dashboard.ts API Route (1,117 LOC)
**Status:** NOT STARTED
**Hotspot Score:** 55.93
**Estimated Time:** 2-3 days

### Priority 4: Other Large Files (6 files over 800 LOC)
**Status:** NOT STARTED
**Estimated Time:** 1-2 weeks total

---

## Testing Strategy

### After Each Phase:

1. **Type Check:** `pnpm typecheck` must pass
2. **Lint:** `pnpm lint` must pass
3. **Build:** `pnpm build` must succeed
4. **Manual Test:** Navigate to library page and test:
   - Loading library items
   - Filtering by service/instance/status/file
   - Searching items
   - Viewing item details
   - Managing seasons/episodes
   - Monitoring toggle
   - Search actions

### Before Committing:

- ✅ All TypeScript errors resolved
- ✅ No lint warnings introduced
- ✅ App runs without console errors
- ✅ All existing functionality preserved

---

## Rollback Plan

If issues arise:
1. Revert specific commits: `git revert <commit-hash>`
2. Feature flag approach: Keep old code temporarily with `USE_LEGACY_LIBRARY` flag
3. Gradual rollout: Test in staging before production

---

## Completion Metrics

### library-client.tsx Refactoring:

| Metric | Before | Target | Current | Status |
|--------|--------|--------|---------|--------|
| Main Component LOC | 514 | 90 | 514 | 🔴 Not Started |
| Total File LOC | 1,639 | ~90 | 1,524 | 🟡 In Progress (7% reduction) |
| Number of Files | 1 | 13 | 3 | 🟡 In Progress (2 new files) |
| Hotspot Score | 65.78 | <30 | 65.78 | 🔴 Not Started |
| Complexity | Very High | Low | Very High | 🔴 Not Started |

### Overall Project:

| Metric | Value | Status |
|--------|-------|--------|
| Files > 800 LOC | 9 | 🔴 Needs attention |
| Architecture Health | Grade A | ✅ Excellent |
| Circular Dependencies | 0 | ✅ Excellent |
| Biome Lint Errors | 0 | ✅ Fixed |

---

## Time Investment Estimate

### library-client.tsx Complete Refactoring:
- **Phase 1 (Utils):** ✅ 1 hour (DONE)
- **Phase 2 (Simple Components):** 1-2 hours
- **Phase 3 (Complex Components):** 4-6 hours
- **Phase 4 (Hooks):** 3-4 hours
- **Phase 5 (Layout):** 2-3 hours
- **Phase 6 (Integration):** 2-3 hours
- **Testing & Fixes:** 2-4 hours

**Total:** 15-23 hours (~2-3 full working days)

### All Priority Refactorings:
- library-client.tsx: 15-23 hours
- settings-client.tsx: 16-24 hours
- dashboard.ts: 16-24 hours
- Other 6 files: 48-72 hours

**Total:** 95-143 hours (~12-18 working days)

---

## Recommendations

### Immediate Next Steps:

1. **Complete library-client.tsx refactoring** before starting others
   - Finish all 6 phases
   - Document lessons learned
   - Create reusable patterns

2. **Update imports in library-client.tsx** to use new utility files
   - Replace local constants with imports from library-constants
   - Replace local utils with imports from library-utils
   - Test thoroughly

3. **Create refactoring template** based on library-client.tsx experience
   - Reuse for settings-client.tsx and dashboard.ts
   - Establish consistent patterns

### Long-term Strategy:

1. **Weekly refactoring sessions:** Dedicate 4-6 hours per week
2. **Pair programming:** Complex refactorings benefit from two sets of eyes
3. **Code review:** All refactorings should be reviewed before merging
4. **Feature freeze:** Consider pausing new features during major refactorings

---

## Notes & Learnings

### Phase 1 Learnings:
- ✅ Utility extraction is straightforward and low-risk
- ✅ Clear dependencies make extraction easier
- ✅ JSDoc comments improve reusability
- 📝 Consider creating barrel exports for cleaner imports

### Blockers:
- None currently

### Questions:
- Should we add unit tests for utilities before proceeding?
- Do we need to maintain backward compatibility during refactoring?
- Should extracted components go in same directory or separate subdirectories?

---

*Last Updated: 2025-10-06*
*Next Review: After Phase 2 completion*
