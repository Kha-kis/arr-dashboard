# Tautulli Runtime Restoration Plan

> **Required subskill:** Use `superpowers:subagent-driven-development` and the project `arr-integration-change` skill. Use `arr-validate` before PR preparation.

**Goal:** Restore Tautulli as a maintainable 3.0 historical-analytics integration without copying obsolete stable architecture or weakening cache and cleanup safeguards.

**Architecture:** Port stable client behavior behind 3.0's per-instance services, generation guards, atomic cache publication, failed-attempt tracking, Pulse, and unified rules. This wave restores provider capability but does not choose between Tracearr and Tautulli; selection belongs to the following wave.

**Tech stack:** Fastify, Prisma, Zod, TypeScript, React, TanStack Query, Vitest.

**Global constraints:** Adapt behavior from stable commits, never wholesale-copy deletion-era files; no provider mixing/failover; Tautulli without verified Plex identity is analytics-only and cannot authorize cleanup.

---

## Task 1: Restore typed client and shared contracts

**Files:**
- Create: `apps/api/src/lib/tautulli/tautulli-client.ts`
- Create: `apps/api/src/lib/tautulli/tautulli-schemas.ts`
- Create: `apps/api/src/lib/tautulli/tautulli-helpers.ts`
- Create: `apps/api/src/lib/tautulli/tautulli-client.test.ts`
- Create: `apps/api/src/lib/tautulli/tautulli-schemas.test.ts`
- Modify: `packages/shared/src/types/services.ts`

- [ ] Write failing tests for API-key query auth, optional HTTP Basic auth, pagination, sparse metadata, upstream error normalization, and statistics completeness.
- [ ] Implement Zod schemas and a per-instance client using encrypted service credentials; never log URLs, keys, usernames, or titles.
- [ ] Add bounded pagination and explicit completeness metadata instead of treating partial responses as complete.
- [ ] Run `pnpm --filter @arr/api test -- tautulli-client tautulli-schemas` and commit: `feat: restore tautulli client contracts`.

## Task 2: Add guarded atomic cache publication

**Files:**
- Create: `apps/api/src/lib/tautulli/tautulli-cache-refresher.ts`
- Create: `apps/api/src/lib/tautulli/tautulli-cache-refresher.test.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260812100000_restore_tautulli_cache/migration.sql`

- [ ] Add failing tests for atomic publication, duplicate/group rejection, frozen totals, sparse rows, caps, chunked stale eviction, overlapping runs, disabled/deleted instances, and generation changes.
- [ ] Model cache generations and refresh attempts consistently with the Wave-4 Plex/Jellyfin lifecycle; failed attempts preserve the last successful generation.
- [ ] Gather into an unpublished generation, validate the full snapshot, then publish in one guarded transaction.
- [ ] Do not treat connection fingerprints as verified Plex server identity.
- [ ] Run `pnpm --filter @arr/api test -- tautulli-cache-refresher` and commit: `feat: add guarded tautulli cache refresh`.

## Task 3: Add scheduling, status, and Pulse

**Files:**
- Create: `apps/api/src/plugins/tautulli-cache-scheduler.ts`
- Modify: `apps/api/src/bootstrap/infrastructure.ts`
- Modify: `apps/api/src/lib/pulse/collectors.ts`
- Modify: `apps/api/src/lib/pulse/constants.ts`
- Test: `apps/api/src/plugins/__tests__/tautulli-cache-scheduler.test.ts`
- Test: `apps/api/src/lib/pulse/__tests__/collectors-tautulli.test.ts`

- [ ] Add failing tests for per-instance schedules, overlap prevention, disabled instances, honest failed-attempt state, and stable entity-keyed Pulse signal IDs.
- [ ] Register the scheduler and expose refresh health without replacing successful cache generations on failure.
- [ ] Add collector labels and actionable stale/failure signals.
- [ ] Run focused tests and commit: `feat: schedule and monitor tautulli refreshes`.

## Task 4: Restore API routes and frontend data access

**Files:**
- Create: `apps/api/src/routes/tautulli/index.ts`
- Create: `apps/api/src/routes/tautulli/activity-routes.ts`
- Create: `apps/api/src/routes/tautulli/cache-routes.ts`
- Create: `apps/api/src/routes/tautulli/history-routes.ts`
- Create: `apps/api/src/routes/tautulli/stats-routes.ts`
- Create: `apps/api/src/routes/tautulli/__tests__/aggregation.test.ts`
- Modify: `apps/api/src/routes/route-manifest.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/web/src/lib/api-client/tautulli.ts`
- Create: `apps/web/src/hooks/api/useTautulli.ts`
- Modify: `docs/API-ROUTES.md`

- [ ] Add failing ownership, pagination, cache-status, aggregation, disabled-instance, and incognito-sensitive response tests.
- [ ] Return typed Tautulli-family results only; do not call Tracearr or native session stores from these routes.
- [ ] Add manual refresh using the same guarded refresher as the scheduler.
- [ ] Add route manifest and API documentation entries.
- [ ] Run `pnpm --filter @arr/api test -- tautulli aggregation` and `pnpm --filter @arr/web test -- useTautulli`; commit: `feat: restore tautulli analytics routes`.

## Task 5: Restore setup and connection validation

**Files:**
- Modify: `apps/api/src/lib/services/connection-tester.ts`
- Modify: `apps/api/src/routes/services.ts`
- Modify: `apps/web/src/features/settings/components/service-form.tsx`
- Modify: `apps/web/src/features/settings/components/service-instance-card.tsx`
- Modify: `apps/web/src/features/settings/hooks/use-services-management.ts`
- Test: `apps/api/src/lib/services/connection-tester.test.ts`
- Test: `apps/web/src/features/settings/components/__tests__/service-form.test.tsx`

- [ ] Add failing tests for connection success, HTTP Basic support, invalid API responses, encrypted credential persistence, edit preservation, and safe errors.
- [ ] Re-enable Tautulli in service forms and summaries with supported fields only.
- [ ] Mark identity-unverified Tautulli as `analytics_only`; connection success must not imply cleanup authorization.
- [ ] Run focused API/web tests and commit: `feat: restore tautulli service setup`.

## Task 6: Restore Tautulli-backed unified rules

**Files:**
- Modify: `packages/shared/src/rules/criteria.ts`
- Modify: `apps/api/src/lib/library-cleanup/rule-evaluators.ts`
- Modify: `apps/api/src/lib/library-cleanup/cleanup-executor.ts`
- Modify: `apps/api/src/lib/rules/engine.ts`
- Test: `apps/api/src/lib/rules/__tests__/engine.test.ts`
- Test: `apps/api/src/lib/library-cleanup/phase1-features.test.ts`

- [ ] Add failing tests for the three previously supported Tautulli rule kinds, selected/unselected state, provider outage, stale/incomplete cache, and missing Plex identity.
- [ ] Implement a Tautulli evidence adapter that returns unavailable/unknown rather than rewriting or deleting rules.
- [ ] Fail closed when evidence is unselected, incomplete, stale, or identity-required but unverified.
- [ ] Run focused rule tests and commit: `feat: restore tautulli rule evidence`.

## Task 7: Freeze and validate the wave

- [ ] Run the complete focused Tautulli suite and Prisma validation/generation.
- [ ] Run `pnpm run format`, shared build, root typecheck, tests, lint, and production build.
- [ ] Live-verify setup, connection test, cache status, history, statistics, and non-sensitive errors against an authorized Tautulli fixture.
- [ ] Delegate one `regression_reviewer` and one `data_safety_reviewer` over the frozen wave; inventory findings once and use one correction batch.
- [ ] Verify no Tautulli path can authorize deletion without durable Plex identity.
