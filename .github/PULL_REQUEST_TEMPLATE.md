## Summary

<!-- What does this PR do? Link related issues with "Fixes #NNN" -->

## Changes

<!-- Brief list of what changed and why -->

## Checklist

- [ ] TypeScript: `tsc --noEmit` passes on both web and api
- [ ] Tests: All tests pass (`pnpm run test`)
- [ ] Lint: No errors (`pnpm run lint`)
- [ ] Build: `pnpm run build` succeeds
- [ ] Query keys: Any new queries use centralized keys from `query-keys.ts`
- [ ] Polling: Any new `refetchInterval` uses `POLLING_*` constants
- [ ] Incognito: Any new sensitive data displays use `useIncognitoMode()`
- [ ] Ownership: Any new Prisma queries include `userId` for user-owned resources

## Test plan

<!-- How was this tested? What scenarios were verified? -->
