# Deduplication Map

## Overview

The codebase is already well-structured with minimal duplication. Recent refactoring (visible in git status) shows active consolidation:
- ✓ Centralized API client split into modular clients (api-client.ts → api-client/*)
- ✓ User hooks consolidated (useCurrentUser, useAccountSettings → useAuth)

## Identified Duplication Patterns

### 1. ✓ **API Client Pattern** (ALREADY DEDUPLICATED)

**Status**: Recently refactored ✓

**Before** (old pattern):
```
apps/web/src/lib/api-client.ts (god module)
```

**After** (current pattern):
```
apps/web/src/lib/api-client/
  ├── base.ts          (shared apiRequest wrapper)
  ├── auth.ts
  ├── services.ts
  ├── tags.ts
  ├── dashboard.ts
  ├── discover.ts
  ├── search.ts
  └── library.ts
```

**Consolidation**: All API clients now use shared `apiRequest()` from base.ts
- **Usage**: 40+ calls across 8 API client modules
- **Pattern**: Consistent error handling via UnauthorizedError

### 2. ✓ **React Query Hooks Pattern** (ALREADY STANDARDIZED)

**Status**: Well-organized ✓

**Pattern**:
- All hooks in `hooks/api/use*.ts`
- Consistent naming: `use[Domain][Action]` (e.g., useServicesQuery, useCreateTagMutation)
- **Total**: 58 useQuery/useMutation calls across 10 hook files
- All consume modular API clients

### 3. **Feature Client Components** (STANDARDIZED NAMING)

**Pattern**: All features follow `*-client.tsx` naming
```
apps/web/src/features/
  ├── calendar/components/calendar-client.tsx
  ├── dashboard/components/dashboard-client.tsx
  ├── discover/components/discover-client.tsx
  ├── history/components/history-client.tsx
  ├── indexers/components/indexers-client.tsx
  ├── library/components/library-client.tsx
  ├── search/components/search-client.tsx
  ├── settings/components/settings-client.tsx
  ├── setup/components/setup-client.tsx
  └── statistics/components/statistics-client.tsx
```

**Shared Patterns** (✓ No duplication, just consistency):
- All use React Query hooks for data fetching
- All use shared UI components (Button, Card, Input)
- All use cn() utility for className merging (31 usages)
- All handle loading/error states similarly

### 4. **UI Component Utilities**

**Current**: `apps/web/src/lib/utils.ts`
```typescript
export function cn(...classes) {
  return classes.filter(Boolean).join(" ");
}
```

**Usage**: 31 components
**Status**: Optimal ✓ (single source of truth)

### 5. **API Route Handlers** (SERVER SIDE)

**Pattern Analysis**:
- ✓ Consistent Fastify route structure
- ✓ Shared utilities in `apps/api/src/utils/`
  - arr-fetcher.ts (Arr service HTTP client)
  - encryption.ts
  - password.ts
  - session.ts
  - values.ts (normalization helpers)

**Note**: `routes/manual-import-utils.ts` (432 lines) contains helpers specific to manual import - correctly scoped, not duplicated elsewhere.

## Consolidation Opportunities (Minor)

### 1. **API Utils Organization** (Low Priority)

**Current Structure**:
```
apps/api/src/utils/
  ├── encryption.ts
  ├── password.ts
  ├── session.ts
  ├── arr-fetcher.ts
  └── values.ts
```

**Recommended Grouping** (optional):
```
apps/api/src/lib/
  ├── auth/
  │   ├── encryption.ts
  │   ├── password.ts
  │   └── session.ts
  ├── arr/
  │   └── arr-fetcher.ts
  └── data/
      └── values.ts
```

**Impact**: Low (organizational only, no functional change)

### 2. **Feature State Management** (ALREADY LEAN)

**Current**:
- Only 1 feature uses Zustand (manual-import/store.ts)
- All other features use React Query for state
- No duplication - each feature has isolated state

**Status**: Optimal ✓

## Top Consolidation Wins (Already Achieved)

1. ✓ **API Client Modularization** - Split god module into 8 domain-specific modules
2. ✓ **Auth Hooks Consolidation** - Merged useCurrentUser + useAccountSettings → useAuth
3. ✓ **Shared UI Utilities** - Single cn() utility used 31 times
4. ✓ **Consistent Hook Patterns** - All 10 API hooks follow same structure

## Deduplication Score: 9/10

The codebase shows evidence of recent, high-quality refactoring:
- Minimal duplication
- Clear separation of concerns
- Consistent patterns across layers
- No copy-paste code detected

## Recommendations

1. **No urgent deduplication needed** - codebase is clean
2. **Optional**: Group API utils by domain (auth/, arr/, data/) for clarity
3. **Maintain patterns**: Continue using established conventions when adding features
