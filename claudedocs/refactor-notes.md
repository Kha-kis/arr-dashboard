# Refactor Notes - Incremental Cleanup Sprint

## Session 1: Statistics Feature Extraction

**Date**: 2025-01-19
**Component Decomposed**: `statistics-client.tsx` (657 LOC → 320 LOC)

### Files Created

#### Business Logic Hook
- **`apps/web/src/features/statistics/hooks/useStatisticsData.ts`**
  - Centralizes data aggregation logic for Sonarr/Radarr/Prowlarr
  - Handles fallback aggregation when backend aggregates unavailable
  - Computes health issue collection across all services
  - Returns stable interface: `{ isLoading, error, refetch, sonarrRows, radarrRows, prowlarrRows, sonarrTotals, radarrTotals, prowlarrTotals, allHealthIssues }`

#### Utility Functions
- **`apps/web/src/features/statistics/lib/formatters.ts`**
  - `formatBytes()` - Human-readable file size formatting
  - `formatPercent()` - Percentage formatting with fallback handling

#### Presentational Components
- **`apps/web/src/components/presentational/stats-card.tsx`**
  - Generic metric card (title + value + optional description)
  - Pure UI, no business logic
  - Reusable across dashboard and statistics pages

- **`apps/web/src/components/presentational/quality-breakdown.tsx`**
  - Horizontal progress bars for quality distribution
  - Pure UI, handles rendering of breakdown data
  - Used by both Sonarr and Radarr sections

- **`apps/web/src/components/presentational/instance-table.tsx`**
  - Generic table for service instance statistics
  - Supports custom columns with formatters
  - Incognito mode integration
  - Reusable across all three service types

### Files Modified
- **`apps/web/src/features/statistics/components/statistics-client.tsx`**
  - Reduced from 657 LOC to 320 LOC (51% reduction)
  - Now purely presentational - composes extracted components
  - All business logic delegated to `useStatisticsData` hook
  - Improved readability and testability

### Benefits Achieved
1. **Separation of Concerns**: Business logic isolated from presentation
2. **Testability**: Hook can be unit tested independently
3. **Reusability**: Presentational components can be used in other features
4. **Maintainability**: Changes to aggregation logic don't affect UI
5. **Code Size**: 51% reduction in main component size

### Risks
- **None Identified**: Extraction maintained exact same functionality
- Type safety preserved throughout
- No API signature changes
- No behavior changes

---

## Session 2: Dashboard Feature Extraction

**Date**: 2025-01-19
**Component Decomposed**: `dashboard-client.tsx` (476 LOC → 248 LOC)

### Files Created

#### Business Logic Hooks
- **`apps/web/src/features/dashboard/hooks/useDashboardData.ts`** (103 LOC)
  - Centralizes services and queue data aggregation
  - Groups services by type for summary cards
  - Extracts unique instances and statuses for filter options
  - Returns stable interface: `{ currentUser, services, queueAggregated, totalQueueItems, instanceOptions, statusOptions, isLoading, refetch functions }`

- **`apps/web/src/features/dashboard/hooks/useDashboardFilters.ts`** (113 LOC)
  - Manages queue filtering state (service, instance, status)
  - Handles pagination state
  - Computes filtered and paginated items
  - Returns filter state, filtered data, and control functions

- **`apps/web/src/features/dashboard/hooks/useDashboardQueue.ts`** (111 LOC)
  - Manages queue actions (retry, remove, change category)
  - Handles manual import modal state
  - Auto-dismisses success messages after 6 seconds
  - Returns queue action handlers and modal state

#### Presentational Components
- **`apps/web/src/components/presentational/service-instances-table.tsx`** (72 LOC)
  - Displays configured service instances in table format
  - Shows label, service type, URL, tags, and enabled status
  - Supports incognito mode for URL masking
  - Pure UI component with no business logic

- **`apps/web/src/components/presentational/queue-filters.tsx`** (114 LOC)
  - Filter controls for queue items (service, instance, status)
  - Includes reset button when filters are active
  - Pure UI component with typed props

### Files Modified
- **`apps/web/src/features/dashboard/components/dashboard-client.tsx`**
  - Reduced from 476 LOC to 248 LOC (48% reduction)
  - Now purely presentational - composes extracted hooks and components
  - All data fetching delegated to `useDashboardData` hook
  - All filter logic delegated to `useDashboardFilters` hook
  - All queue actions delegated to `useDashboardQueue` hook
  - Improved readability and testability

- **`apps/web/src/components/presentational/index.ts`**
  - Added exports for `ServiceInstancesTable` and `QueueFilters`

### Benefits Achieved
1. **Separation of Concerns**: Data fetching, filtering, and queue actions isolated from presentation
2. **Testability**: Each hook can be unit tested independently
3. **Reusability**: Presentational components can be used in other features
4. **Maintainability**: Changes to business logic don't affect UI
5. **Code Size**: 48% reduction in main component size

### Risks
- **None Identified**: Extraction maintained exact same functionality
- Type safety preserved throughout
- No API signature changes
- No behavior changes

---

## Session 3: Discover Feature Extraction

**Date**: 2025-01-19
**Component Decomposed**: `discover-client.tsx` (390 LOC → 187 LOC)

### Files Created

#### Business Logic Hooks
- **`apps/web/src/features/discover/hooks/useDiscoverRecommendations.ts`** (157 LOC)
  - Manages 4 parallel TMDB recommendation queries (trending, popular, topRated, upcoming)
  - Auto-pagination logic to maintain MIN_VISIBLE_ITEMS (10) threshold
  - Deduplication and library filtering for each carousel
  - Returns stable interface: `{ trending, popular, topRated, upcoming }` with query + items for each
  - Each carousel includes UseInfiniteQueryResult + filtered RecommendationItem[]

- **`apps/web/src/features/discover/hooks/useDiscoverSearch.ts`** (71 LOC)
  - Manages search state (searchType, searchInput, submittedQuery)
  - Coordinates with useDiscoverSearchQuery API hook
  - Handles form submission logic
  - Returns search state, results, loading/error state, and handlers

- **`apps/web/src/features/discover/hooks/useDiscoverActions.ts`** (120 LOC)
  - Manages item selection for adding to library
  - Handles add mutation with success/error feedback
  - Auto-dismisses feedback messages after 4 seconds
  - Provides separate handlers for RecommendationItem (from carousels) and DiscoverSearchResult (from search)
  - Returns selection state, feedback, mutation status, and action handlers

#### Utility Functions
- **`apps/web/src/features/discover/lib/discover-utils.ts`** (enhanced)
  - Added `convertRecommendationToSearchResult()` - Transforms RecommendationItem to DiscoverSearchResult with fake instance states
  - Existing utilities: `formatRuntime()`, `deduplicateItems()`, `filterExistingItems()`, `getRecentlyAdded()`, `getTopRated()`

### Files Modified
- **`apps/web/src/features/discover/components/discover-client.tsx`**
  - Reduced from 390 LOC to 187 LOC (52% reduction)
  - Now purely orchestration - composes hooks and presentational components
  - All TMDB recommendation logic delegated to `useDiscoverRecommendations` hook
  - All search logic delegated to `useDiscoverSearch` hook
  - All action handlers delegated to `useDiscoverActions` hook
  - Eliminated 4 complex useEffect chains for auto-pagination
  - Eliminated duplicate filtering/deduplication logic
  - Improved readability and maintainability

### Benefits Achieved
1. **Separation of Concerns**: TMDB data fetching, search, and actions isolated from presentation
2. **Testability**: Each hook can be unit tested independently
3. **Reusability**: Hooks can be reused if other features need TMDB data
4. **Maintainability**: Auto-pagination logic centralized in one place
5. **Code Size**: 52% reduction in main component size
6. **Type Safety**: All hooks fully typed with TypeScript
7. **Behavior Preservation**: Identical functionality maintained, TypeScript checks pass

### Risks
- **None Identified**: Extraction maintained exact same functionality
- Type safety preserved throughout (ServiceInstanceSummary types corrected)
- No API signature changes
- No behavior changes
- All existing presentational components (TMDBCarousel, SearchResults, etc.) unchanged

### Key Patterns Used
- **Parallel Queries**: useDiscoverRecommendations manages 4 infinite queries in parallel
- **Auto-Pagination**: useEffect chains for each carousel ensure minimum items after filtering
- **Dual Selection Handlers**: handleSelectItem (RecommendationItem) vs handleSelectResult (DiscoverSearchResult)
- **Auto-Dismiss Feedback**: 4-second timeout for success/error messages

---

## Session 4: Search Feature Extraction

**Date**: 2025-01-19
**Component Decomposed**: `search-client.tsx` (372 LOC → 250 LOC)

### Files Created

#### Business Logic Hooks
- **`apps/web/src/features/search/hooks/use-search-pagination.ts`** (35 LOC)
  - Manages pagination state (page, pageSize)
  - Computes paginated results slice
  - Auto-resets to page 1 when page size changes
  - Returns pagination state and handlers

- **`apps/web/src/features/search/hooks/use-search-actions.ts`** (188 LOC)
  - Manages search mutation with validation
  - Handles grab mutation for downloading releases
  - Clipboard operations for copying magnet/download links
  - Opening release info URLs with safety validation
  - Coordinates with useSearchState for feedback/validation updates
  - Returns search results, mutation state, and action handlers

- **`apps/web/src/features/search/hooks/use-search-indexers.ts`** (44 LOC)
  - Auto-initializes indexer selection when data loads
  - Selects all enabled indexers by default
  - Preserves user selections on re-renders
  - Side-effect only hook (no return value)

### Existing Hooks (Already Present)
- **`apps/web/src/features/search/hooks/use-search-state.ts`** (146 LOC)
  - Comprehensive state management for search, filters, sort, feedback
  - Indexer toggle handlers
  - Filter reset functionality
  - Actions object with all state setters

- **`apps/web/src/features/search/hooks/use-search-data.ts`** (95 LOC)
  - Client-side filtering (protocol, seeders, age, rejected)
  - Multi-level sorting with fallbacks
  - Computes hidden count and filter active state
  - Pure data transformation hook

### Files Modified
- **`apps/web/src/features/search/components/search-client.tsx`**
  - Reduced from 372 LOC to 250 LOC (33% reduction)
  - Now purely orchestration - composes 5 hooks
  - All search mutation logic delegated to `useSearchActions` hook
  - All pagination logic delegated to `useSearchPagination` hook
  - All indexer initialization delegated to `useSearchIndexers` hook
  - Eliminated inline mutation handlers (handleSearch, handleGrab, handleCopyMagnet, handleOpenInfo)
  - Eliminated pagination state management
  - Improved readability and maintainability

### Benefits Achieved
1. **Separation of Concerns**: Search execution, pagination, and indexer logic isolated from presentation
2. **Testability**: Each hook can be unit tested independently
3. **Reusability**: Pagination and actions hooks can be reused in other search contexts
4. **Maintainability**: Mutation logic centralized in useSearchActions
5. **Code Size**: 33% reduction in main component size
6. **Type Safety**: All hooks fully typed with TypeScript
7. **Behavior Preservation**: Identical functionality maintained, TypeScript checks pass

### Risks
- **None Identified**: Extraction maintained exact same functionality
- Type safety preserved throughout (SearchIndexersResponse type corrected)
- No API signature changes
- No behavior changes
- All existing presentational components (SearchForm, IndexerSelector, FilterControls, etc.) unchanged

### Key Patterns Used
- **Validation Before Mutation**: useSearchActions validates query and indexers before executing search
- **Coordinated State Updates**: Action handlers update multiple state pieces through stateActions
- **Auto-Reset Pagination**: Page resets to 1 when page size changes
- **Safe URL Operations**: safeOpenUrl validation for external links
- **Clipboard Error Handling**: Comprehensive error handling for clipboard operations

### Architecture Note
The Search feature already had `useSearchState` and `useSearchData` hooks from a previous refactor. This session completed the extraction by:
1. Moving mutation handlers from component to `useSearchActions`
2. Extracting pagination logic to `useSearchPagination`
3. Isolating indexer initialization to `useSearchIndexers`

This demonstrates incremental refactoring - building on existing good patterns rather than rewriting from scratch.

---

## Session 5: Trash Guides Feature Extraction

**Date**: 2025-01-19
**Component Decomposed**: `trash-guides-client.tsx` (352 LOC → 204 LOC)

### Files Created

#### Business Logic Hooks
- **`apps/web/src/features/trash-guides/hooks/use-trash-guides-state.ts`** (22 LOC)
  - Manages active tab state (5 tabs: cache, templates, scheduler, history, bulk-scores)
  - Returns stable interface: `{ activeTab, setActiveTab }`

- **`apps/web/src/features/trash-guides/hooks/use-trash-guides-data.ts`** (38 LOC)
  - Centralizes cache status and templates data queries
  - Combines loading/error states from multiple queries
  - Returns: `{ cacheStatus, templates, isLoading, error, refetch functions }`

- **`apps/web/src/features/trash-guides/hooks/use-trash-guides-actions.ts`** (42 LOC)
  - Manages cache refresh mutation with service-specific tracking
  - Handles async refresh operations with cleanup
  - Returns: `{ handleRefresh, refreshing, refreshMutation }`

- **`apps/web/src/features/trash-guides/hooks/use-trash-guides-modals.ts`** (104 LOC)
  - Centralizes all modal states (editor, import, quality profile browser)
  - Manages selected template and service type state
  - Provides 8 modal handler functions
  - Returns modal states and all open/close handlers

#### Presentational Components
- **`apps/web/src/components/presentational/trash-guides-tabs.tsx`** (43 LOC)
  - Tab navigation UI for 5 TRaSH Guides tabs
  - Pure presentational component with typed props
  - No business logic, just renders tab buttons

- **`apps/web/src/components/presentational/cache-status-card.tsx`** (64 LOC)
  - Displays individual cache entry status
  - Shows config type, version, item count, last fetched timestamp
  - Visual indicator for stale cache entries
  - Pure UI component with no hooks

- **`apps/web/src/components/presentational/cache-status-section.tsx`** (94 LOC)
  - Service-specific cache status display (RADARR/SONARR)
  - Composes CacheStatusCard components in grid layout
  - Includes refresh controls and empty state handling
  - Pure UI component driven by props

#### Utility Functions
- **`apps/web/src/features/trash-guides/lib/constants.ts`** (11 LOC)
  - CONFIG_TYPE_LABELS mapping for human-readable config type labels
  - Pure data constants for reusability

### Files Modified
- **`apps/web/src/features/trash-guides/components/trash-guides-client.tsx`**
  - Reduced from 352 LOC to 204 LOC (42% reduction)
  - Now purely orchestration - composes 4 hooks and presentational components
  - All tab state delegated to `useTrashGuidesState` hook
  - All data fetching delegated to `useTrashGuidesData` hook
  - All cache refresh logic delegated to `useTrashGuidesActions` hook
  - All modal management delegated to `useTrashGuidesModals` hook
  - Eliminated inline renderServiceSection function
  - Eliminated all useState/handler patterns (9 state variables extracted)
  - Improved readability and maintainability

- **`apps/web/src/components/presentational/index.ts`**
  - Added exports for TrashGuidesTabs, CacheStatusCard, CacheStatusSection

### Benefits Achieved
1. **Separation of Concerns**: Tab state, data fetching, actions, and modals isolated from presentation
2. **Testability**: Each hook can be unit tested independently
3. **Reusability**: Cache status cards and tabs can be used in other contexts
4. **Maintainability**: Tab logic, modal management, and data fetching centralized
5. **Code Size**: 42% reduction in main component size (148 LOC removed)
6. **Type Safety**: All hooks and components fully typed with TypeScript

### Risks
- **None Identified**: Extraction maintained exact same functionality
- Type safety preserved throughout (version: number, configTypeLabel fallback)
- No API signature changes
- No behavior changes
- All existing feature components (TemplateList, BulkScoreManager, etc.) unchanged

### Key Patterns Used
- **Tab State Management**: Single hook for tab navigation state
- **Multi-Query Coordination**: Combined cache + templates queries in useTrashGuidesData
- **Modal State Centralization**: All 3 modals + selection state in one hook
- **Async Mutation Tracking**: Service-specific refresh tracking with cleanup
- **Pure Presentational Components**: Cache cards and tabs as reusable UI components
- **Constants Extraction**: CONFIG_TYPE_LABELS moved to lib for reusability

### Architecture Note
The Trash Guides feature had significant complexity with 5 tabs, 3 modals, and cache management logic. This refactor demonstrates:
1. Effective modal state centralization pattern (1 hook managing 3 modals)
2. Tab-based UI organization with clean orchestration
3. Service-specific action tracking (RADARR vs SONARR refresh)
4. Presentational component composition (section → cards)

This completes the systematic refactoring of major feature client components in the monorepo.

---

## Next Extraction Targets

Based on LOC analysis (updated post-Trash Guides refactor):

1. **`indexers-client.tsx`** (207 LOC)
   - Extract pagination and state management
   - Extract test/update mutation handlers
   - Extract instance aggregation logic

2. **`settings-client.tsx`** (244 LOC) - Already uses hooks
   - Light cleanup if needed
   - Already well-structured

---

## Patterns to Follow

### Hook Extraction Pattern
```typescript
// 1. Create hook in features/<feature>/hooks/
// 2. Move data fetching + transformation logic
// 3. Return stable interface with query state + transformed data
// 4. Keep hooks focused on single responsibility
```

### Presentational Component Pattern
```typescript
// 1. Create in components/presentational/
// 2. Accept only UI-relevant props (no mutation callbacks)
// 3. No hooks except UI-only hooks (useState for local UI state)
// 4. Export with clear prop types
```

### Formatter/Utility Pattern
```typescript
// 1. Create in features/<feature>/lib/
// 2. Pure functions only
// 3. Export individual functions (not default)
// 4. Add JSDoc comments
```
