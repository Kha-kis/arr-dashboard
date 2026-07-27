---
name: regression-hunter
description: Specialized knowledge for identifying regression risks in diffs — silent breakage patterns, missing tests, and edge cases specific to this codebase
type: skill
---

# Regression Hunter Knowledge

Load this skill when reviewing diffs, stabilizing branches, or assessing merge safety.

## High-Risk Change Areas

These areas have caused regressions before — extra scrutiny required:

**Statistics calculations** (`lib/statistics/dashboard-statistics.ts`, 1151 lines):
- Sonarr/Lidarr have paired count fields (monitored vs total). Using the wrong one inflates missing counts (#131, #209).
- Each service's aggregation function must use consistent denominators for missing count and downloaded percentage.
- Changes here affect dashboard stat cards, statistics page, and any derived displays.

**Date/timezone handling** (`use-calendar-data.ts`, normalizers):
- `airDate` (local) vs `airDateUtc` (UTC) — using the wrong one shifts events by a day for users in negative UTC offsets (#207).
- `toISOString()` always returns UTC. If a grid cell represents a local date, keys must use `airDate` not `airDateUtc`.
- `formatDateKey()` and event bucketing must use the same date source.

**Incognito mode** (`lib/incognito.ts`, 40+ consumer components):
- Adding any new component that displays sensitive data requires `useIncognitoMode()`.
- Tests for components with `useIncognitoMode()` require `<IncognitoProvider>` wrapper — missing this causes CI test failures.
- New *arr message patterns may slip through `anonymizeStatusMessage()` regex.

**OIDC issuer normalization** (`lib/auth/oidc-utils.ts`):
- Any change to URL normalization can break Authentik (trailing slash) or Keycloak (no trailing slash).
- The self-healing retry in `discoverAuthServer()` masks stored-issuer mismatches — changing the retry logic can silently break existing setups.

**Safety-critical mutations** (library/queue cleanup, restore, schema sync,
TRaSH deployment, upstream writes):
- Preview and dry-run selection must remain identical to execution selection.
- Re-check ownership and mutable upstream state at execution time.
- Shared Plex/Jellyfin libraries backed by multiple *arr instances are normal,
  not an edge case; title/TMDb matches do not prove file or instance identity.
- Local cache state must not transition to success before the upstream action
  succeeds.
- Partial completion, retries, and concurrent scheduler/manual invocation need
  explicit tests.

**Branch compatibility**:
- `main` is the stable 2.x contract; avoid breaking route, configuration, or
  stored-data behavior in a patch.
- `next` contains 3.0 breaking changes. Confirm whether a fix must be
  forward-ported, and do not assume identical files imply identical behavior.

## Silent Breakage Patterns

1. **Query key drift**: A mutation invalidates `["seerr", "requests"]` but the query uses `seerrKeys.requests(id, params)`. The invalidation still works (prefix match) but is fragile. Check that invalidation keys match the centralized key factories.

2. **Polling interval changes**: Changing a `POLLING_*` constant affects every hook that uses it. Grep for the constant before modifying.

3. **Type assertion masking**: `as any` or `as Type` can hide type mismatches that surface as runtime errors. The `prisma.ts` Pool cast is a known example — check after `@types/pg` updates.

4. **useMemo dependency arrays**: Missing `incognitoMode` in a `useMemo` dep array means toggling incognito won't re-render. This has happened before.

5. **Normalizer field access**: Adding a field to a normalizer without checking all callers can produce `undefined` where a value is expected. Always check the `LibraryItem` consumers.

6. **Bodyless mutation requests**: Next rewrites/proxies and Fastify content-type
parsing can disagree on POST/DELETE requests with no body. Verify the real
browser request and add a route/client regression test rather than assuming
the proxy is neutral.

7. **Status-label drift**: A UI filter can become impossible to observe when
the backend transitions through that status synchronously (for example,
approved → executing → executed). Verify labels and tabs correspond to durable
states users can actually inspect.

## Test Evidence to Require

- A regression fixture for the reported data shape, not only an isolated helper
  test.
- Populated, paginated, multi-instance, and fractional/null values where the
  affected domain can produce them.
- Both failure and success paths at external API boundaries.
- Real browser verification for user-visible behavior; empty-state rendering
  alone is insufficient.
- Manual Authentik/Pocket ID harnesses when their excluded CI paths are
  affected.

## Diff Review Checklist

When reviewing a diff, check for:
1. **New `useQuery`/`useMutation` calls** — should they be in a domain hook, not a component?
2. **New string-literal query keys** — should be in `query-keys.ts`
3. **New `refetchInterval` values** — should use `POLLING_*` constants
4. **Changes to shared hooks** — how many components consume this hook? Ripple risk?
5. **Prisma query changes** — is `userId` in the where clause?
6. **New UI data displays** — incognito mode coverage?
7. **Error handling** — does the catch block log or silently swallow?
8. **New dependencies** — any known CVEs? Check with `pnpm audit`
9. **Mutation state** — can the database/cache claim success before upstream
   success, or can retry double-apply a completed action?
10. **Preview parity** — do preview and execution share selection logic, or can
    they drift?
