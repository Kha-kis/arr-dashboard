# Refactoring Recommendations for Maintainability & Modularity

Generated: 2025-10-06
Source: TheAuditor graph analysis, structure analysis, and insights

## Executive Summary

**Overall Architecture Health: Grade A (100/100)**

Good news! Your codebase has:
- ✅ **Zero circular dependencies**
- ✅ **Low coupling** (5.3% graph density)
- ✅ **Good module organization**

However, there are opportunities to improve maintainability by breaking down large files and reducing hotspots.

## Key Metrics

| Metric | Value | Assessment |
|--------|-------|------------|
| Total Files | 96 | Reasonable |
| Total LOC | 23,308 | Medium-sized |
| Circular Dependencies | 0 | ✅ Excellent |
| Graph Density | 5.3% | ✅ Low coupling |
| Fragility Score | 45.32/100 | ⚠️ Moderate |
| Health Grade | A | ✅ Excellent |

## Priority 1: Split Large Component Files (High Impact)

These files are **complexity hotspots** - large, highly connected, and difficult to maintain:

### 1. `library-client.tsx` - **HIGHEST PRIORITY**
- **Size**: 1,639 LOC (13,886 tokens = 7.8% of codebase)
- **Hotspot Score**: 65.78 (highest in project)
- **Issue**: Handles too many responsibilities

**Recommended Refactoring:**
```
library-client.tsx (1,639 LOC)
├── library-header.tsx          (~200 LOC) - Filters, search, tabs
├── library-item-card.tsx       (~300 LOC) - Display logic for items
├── library-grid.tsx            (~200 LOC) - Grid layout & virtualization
├── season-episode-panel.tsx    (~400 LOC) - Episode management UI
├── library-actions.tsx         (~200 LOC) - Action buttons/dialogs
└── library-container.tsx       (~300 LOC) - Main orchestration
```

**Benefits:**
- Easier testing (test components in isolation)
- Better code reuse
- Improved performance (fewer re-renders)
- Easier onboarding for new developers

### 2. `settings-client.tsx`
- **Size**: 1,271 LOC (11,198 tokens = 6.2% of codebase)
- **Hotspot Score**: 42.54
- **Issue**: Single massive form component

**Recommended Refactoring:**
```
settings-client.tsx (1,271 LOC)
├── service-settings-card.tsx   (~300 LOC) - Per-service configuration
├── global-settings-card.tsx    (~200 LOC) - Global preferences
├── user-settings-card.tsx      (~200 LOC) - User profile/password
├── api-key-management.tsx      (~150 LOC) - TMDB API key handling
├── settings-validation.ts      (~150 LOC) - Form validation logic
└── settings-container.tsx      (~250 LOC) - Main orchestration
```

### 3. `dashboard.ts` (API Route)
- **Size**: 1,117 LOC (8,167 tokens = 4.6% of codebase)
- **Hotspot Score**: 55.93 (2nd highest)
- **Issue**: Handles queue, history, and calendar in one file

**Recommended Refactoring:**
```
routes/
├── dashboard/
│   ├── index.ts                 (~100 LOC) - Route registration
│   ├── queue-handler.ts         (~400 LOC) - Queue operations
│   ├── history-handler.ts       (~300 LOC) - History operations
│   ├── calendar-handler.ts      (~300 LOC) - Calendar operations
│   └── shared/
│       ├── normalizers.ts       (~200 LOC) - Data transformation
│       └── validators.ts        (~100 LOC) - Request validation
```

**Benefits:**
- Easier to find code (separation of concerns)
- Better testability
- Reduced merge conflicts
- Clear module boundaries

## Priority 2: Extract Shared Logic (Medium Impact)

### High-Dependency Files (Refactoring Opportunity)

#### `apps/web/src/lib/utils.ts`
- **In-degree**: 22 (used by 22 other files)
- **Issue**: Likely a "junk drawer" of miscellaneous utilities

**Recommended Refactoring:**
```
lib/
├── utils/
│   ├── date-utils.ts        - Date formatting/parsing
│   ├── string-utils.ts      - String manipulation
│   ├── array-utils.ts       - Array helpers
│   ├── number-utils.ts      - Number formatting
│   └── validation-utils.ts  - Input validation
```

#### `apps/web/src/components/ui/button.tsx`
- **In-degree**: 13 (used by 13 components)
- **Status**: ✅ This is actually good! Shared components should be reused

## Priority 3: Reduce File Size (Medium Impact)

Files over 800 LOC should be evaluated for splitting:

| File | LOC | Recommended Action |
|------|-----|-------------------|
| `search.ts` (API) | 1,132 | Split into search handlers by type (series/movie/release) |
| `queue-table.tsx` | 908 | Extract row component and action buttons |
| `discover-client.tsx` | 881 | Split into recommendation cards and browse grid |
| `library.ts` (API) | 872 | Split into series/movie/episode handlers |
| `search-client.tsx` | 867 | Extract search form and results table |
| `indexers-client.tsx` | 812 | Extract indexer card and stats components |

### Example: Refactor `search.ts` (API Route)

**Current**: 1,132 LOC in one file

**Proposed Structure**:
```
routes/search/
├── index.ts                    (~100 LOC) - Route registration
├── series-search.ts            (~300 LOC) - Sonarr series search
├── movie-search.ts             (~300 LOC) - Radarr movie search
├── release-search.ts           (~300 LOC) - Prowlarr release search
└── shared/
    ├── search-normalizers.ts   (~100 LOC) - Response normalization
    └── search-validators.ts    (~50 LOC)  - Query validation
```

## Priority 4: Improve Modularity (Low Impact, High Long-term Value)

### Create Feature Modules

Currently, the API routes are flat. Consider organizing by feature:

**Current Structure:**
```
routes/
├── auth.ts
├── dashboard.ts
├── dashboard-statistics.ts
├── discover.ts
├── health.ts
├── library.ts
├── manual-import.ts
├── manual-import-utils.ts
├── recommendations.ts
├── search.ts
└── services.ts
```

**Proposed Structure:**
```
routes/
├── auth/
│   └── index.ts
├── dashboard/
│   ├── index.ts
│   ├── queue.ts
│   ├── history.ts
│   ├── calendar.ts
│   └── statistics.ts
├── library/
│   ├── index.ts
│   ├── series.ts
│   ├── movies.ts
│   └── episodes.ts
├── search/
│   ├── index.ts
│   ├── series.ts
│   ├── movies.ts
│   └── releases.ts
├── manual-import/
│   ├── index.ts
│   └── utils.ts
└── services/
    └── index.ts
```

## Priority 5: Address Technical Debt

### TypeScript Compilation Errors

From earlier typecheck, there are ~100+ TypeScript errors from our `unknown` type conversions. These need type guards:

**Pattern to Fix:**
```typescript
// ❌ Current (causes TS errors)
const value = (data as unknown).someProperty;

// ✅ Better (with type guard)
function hasProperty<T extends string>(
  obj: unknown,
  prop: T
): obj is Record<T, unknown> {
  return typeof obj === 'object' && obj !== null && prop in obj;
}

const value = hasProperty(data, 'someProperty')
  ? data.someProperty
  : undefined;
```

**Recommended Approach:**
1. Create type guard utility functions in `lib/type-guards.ts`
2. Gradually add type guards to fix TS errors
3. Focus on critical paths first (auth, payment processing, etc.)

## Fragility Analysis

**Fragility Score: 45.32/100** (moderate)

Files with highest fragility (changes ripple through codebase):

1. `library-client.tsx` - 65.78
2. `dashboard.ts` - 55.93
3. `calendar-client.tsx` - 49.28
4. `queue-table.tsx` - 47.61
5. `discover-client.tsx` - 46.90

**Reducing Fragility:**
- Extract interfaces/types to shared location
- Use dependency injection for services
- Add more unit tests to catch breaking changes
- Consider adding integration tests for critical paths

## Recommended Refactoring Order

### Phase 1: Quick Wins (1-2 days)
1. ✅ **Already Done**: Fix lint errors (100% reduction achieved)
2. Split `utils.ts` into focused utility modules
3. Extract validation logic to separate files

### Phase 2: Major Refactors (1 week)
1. Break down `library-client.tsx` (highest priority)
2. Break down `settings-client.tsx`
3. Split `dashboard.ts` API route

### Phase 3: Structural Improvements (2 weeks)
1. Reorganize API routes into feature modules
2. Split remaining large files (search, library API routes)
3. Create shared component library for common patterns

### Phase 4: Technical Debt (Ongoing)
1. Add type guards to fix TypeScript errors
2. Improve test coverage
3. Add integration tests for critical flows
4. Update deprecated dependencies (lucia/oslo - see SECURITY_RECOMMENDATIONS.md)

## Testing Strategy

For each refactoring:

1. **Before refactoring**:
   - Ensure existing functionality works
   - Take note of test coverage
   - Document current behavior

2. **During refactoring**:
   - Use feature flags if possible
   - Refactor one module at a time
   - Keep git commits small and focused

3. **After refactoring**:
   - Verify all tests pass
   - Manual testing of affected features
   - Performance benchmarking (especially for large components)

## Success Metrics

Track these metrics after refactoring:

- **Code Size**: Target < 500 LOC per file
- **Coupling**: Maintain < 10% graph density
- **Test Coverage**: Aim for 80%+ on new modules
- **Build Time**: Should not increase significantly
- **Bundle Size**: Monitor impact on frontend bundle

## Tools for Refactoring

1. **TheAuditor** - Track impact of changes:
   ```bash
   aud impact --file <refactored-file> --expansion-mode direct
   ```

2. **Git** - Make small, atomic commits:
   ```bash
   git commit -m "refactor(library): extract season-episode-panel component"
   ```

3. **Tests** - Run after each change:
   ```bash
   pnpm test
   pnpm typecheck
   pnpm lint
   ```

## Questions Before Starting?

1. **Which modules are most actively developed?** Focus refactoring there first
2. **Are there upcoming features?** Refactor to support them
3. **What causes the most bugs?** Prioritize refactoring those areas
4. **What's hardest to test?** Those files likely need breaking down

## Summary

Your codebase is in **good shape** overall (Grade A), but has **a few large files** that would benefit from splitting. The recommended approach is:

1. **Start small**: Split utils.ts and extract validation
2. **Tackle hotspots**: Focus on library-client, settings-client, dashboard
3. **Improve structure**: Organize routes into feature modules
4. **Fix tech debt**: Add type guards for TypeScript errors

This will make the codebase more maintainable, testable, and easier for new developers to understand.

---

*Generated by TheAuditor Analysis*
*For questions or to discuss refactoring strategy, review this document with the team*
