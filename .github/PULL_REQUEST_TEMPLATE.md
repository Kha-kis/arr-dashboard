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
- [ ] Incognito: Any new sensitive data displays use `useIncognitoMode()` (including API text with embedded instance names)
- [ ] Ownership: Any new Prisma queries include `userId` for user-owned resources

### If this PR adds a new page, panel, or signal surface:

- [ ] Service gating: Signals that depend on optional services (Plex/Seerr/Tautulli) are guarded when those services aren't configured
- [ ] Signal accuracy: All user-facing counts are precise — no proxies that overclaim
- [ ] Action links: Every action link navigates to the correct page with required params
- [ ] Overlap: Checked where this data already appears in the app — overlap is justified

## Test plan

<!-- How was this tested? What scenarios were verified? -->
