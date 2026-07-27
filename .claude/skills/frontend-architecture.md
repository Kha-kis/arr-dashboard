---
name: frontend-architecture
description: Specialized knowledge for frontend hook patterns, query infrastructure, and component architecture in this Next.js + TanStack Query monorepo
type: skill
---

# Frontend Architecture Knowledge

Load this skill when working on React hooks, data fetching, component structure, or state management.

## Query Infrastructure

**Query keys** are centralized in `apps/web/src/lib/query-keys.ts`. Every domain has a key factory:
- Examples include `dashboardKeys`, `libraryKeys`, `plexKeys`, `seerrKeys`,
  `huntingKeys`, `queueCleanerKeys`, `libraryCleanupKeys`, `notificationKeys`,
  `validationKeys`, `authKeys`, and `backupKeys`. Tautulli keys are 2.x-only;
  Tracearr keys are 3.0-only.
- Key factories return `as const` tuples for type safety
- Mutations must invalidate using these factories, never raw string arrays
- Prefix-based invalidation works: invalidating `["seerr"]` clears all seerr queries

**Polling intervals** are in `apps/web/src/lib/polling-intervals.ts`:
- POLLING_FAST (5s), POLLING_REALTIME (15s), POLLING_ACTIVE (30s), POLLING_STANDARD (60s), POLLING_STATS (120s), POLLING_BACKGROUND (5min)
- Some hooks accept `refetchInterval` as a parameter — inspect all call sites
  before changing the hook default

## Hook Organization

Two tiers of hooks:
1. **Domain hooks** (`hooks/api/use*.ts`) — each wraps an API domain's queries and mutations. These are the primary data layer.
2. **Feature hooks** (`features/*/hooks/use*.ts`) — per-feature state management, filter state, derived data. These consume domain hooks.

**Pattern**: API client module → domain hook → feature hook → component. Components should never call `useQuery` or `useMutation` directly.

## State Separation

- **Server state**: TanStack Query only. Never `useState` for data from the API.
- **UI state**: `useState` for local concerns (expanded sections, filter values, modal visibility). These live in feature hooks or components.
- **Filter state**: Each filterable page has a `use-*-state.ts` or `use-*-filters.ts` hook. All use `useState` (no URL params yet). Each setter resets pagination to page 1.

## Common Anti-Patterns to Catch

1. **Inline useQuery in components** — extract to `hooks/api/` or feature hooks
2. **Local KEYS objects** — all keys belong in `query-keys.ts`
3. **Hardcoded refetchInterval numbers** — use `POLLING_*` constants
4. **Manual isRefreshing + setTimeout** — use `useRefreshState()` hook
5. **Data transformation in components** — move to hooks or `useMemo` in the hook layer
6. **Mutations without invalidation** — every mutation that changes server state must invalidate affected queries

## Enrichment Pattern

`useEnrichableItems(items, typeMapping)` extracts tmdb IDs from library items for Seerr/Plex enrichment. The `typeMapping` parameter handles the Seerr ("tv") vs Plex ("series") distinction for the same media type.

## Monitored Count Fields

Sonarr and Lidarr have paired count fields — always use the monitored variant:
- Sonarr: `episodeCount` (monitored) not `totalEpisodeCount` (all)
- Lidarr: `trackCount` (monitored albums) not `totalTrackCount` (all albums)
