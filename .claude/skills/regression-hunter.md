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

## Silent Breakage Patterns

1. **Query key drift**: A mutation invalidates `["seerr", "requests"]` but the query uses `seerrKeys.requests(id, params)`. The invalidation still works (prefix match) but is fragile. Check that invalidation keys match the centralized key factories.

2. **Polling interval changes**: Changing a `POLLING_*` constant affects every hook that uses it. Grep for the constant before modifying.

3. **Type assertion masking**: `as any` or `as Type` can hide type mismatches that surface as runtime errors. The `prisma.ts` Pool cast is a known example — check after `@types/pg` updates.

4. **useMemo dependency arrays**: Missing `incognitoMode` in a `useMemo` dep array means toggling incognito won't re-render. This has happened before.

5. **Normalizer field access**: Adding a field to a normalizer without checking all callers can produce `undefined` where a value is expected. Always check the `LibraryItem` consumers.

## Test Coverage Gaps to Watch

- No Lidarr or Readarr-specific tests existed before v2.9.2 — new Lidarr stats tests were added but coverage is still thin
- Frontend tests only cover 3 files — approval-queue-tab, useSeerr hook, and queue-utils
- E2E tests run in CI but `authentik-test/` and `pocket-id-test/` are excluded (manual only)
- Dashboard statistics is the most test-covered backend area (12+ test cases)

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
