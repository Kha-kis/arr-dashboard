# Durable Upstream Identity Plan

> **Required subskill:** Use `superpowers:subagent-driven-development`, `arr-integration-change`, and `arr-validate`. Deletion-adjacent work requires `data_safety_reviewer` and `regression_reviewer` passes.

**Goal:** Bind media-server data and mutation authority to a durable upstream server identity so reverse-proxy retargeting, credential changes, or stale previews cannot publish or mutate against the wrong server.

**Architecture:** Service rows store a namespaced immutable identity. Explicit enrollment/replacement controls identity changes. Provider probes run before and after gathering, and guarded publication/mutation transactions compare identity plus connection generation. Existing rows remain unbound until enrolled; Tautulli remains analytics-only unless it can unambiguously prove its associated Plex identity.

**Tech stack:** Prisma, Fastify, Plex/Jellyfin/Emby/Tautulli APIs, Zod, React, Vitest.

**Global constraints:** Fail closed; no silent enrollment/replacement; never expose raw IDs; identity is not unique because multiple service rows may target one server; preserve last successful generations on failed probes.

---

## Task 1: Add identity schema and normalization

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260812120000_add_upstream_identity/migration.sql`
- Create: `apps/api/src/lib/services/provider-identity.ts`
- Create: `apps/api/src/lib/services/provider-identity.test.ts`
- Modify: `packages/shared/src/types/services.ts`

- [ ] Add nullable `ServiceInstance.upstreamIdentity` and safe `identityState: enrolled | unbound | mismatch | analytics_only` response state.
- [ ] Add failing normalization tests for `PLEX:<machineIdentifier>`, `JELLYFIN:<Id>`, and `EMBY:<Id>`; reject blank, wrong namespace, control characters, and ambiguous values.
- [ ] Implement a discriminated `ProviderIdentityProbe` returning `verified` or `unavailable` with `unbound | unsupported | ambiguous | unreachable`.
- [ ] Keep raw identity backend-only and out of ordinary logs/API responses.
- [ ] Run focused tests and commit: `feat: add durable provider identity contract`.

## Task 2: Implement provider identity probes

**Files:**
- Modify: `apps/api/src/lib/plex/plex-client.ts`
- Modify: `apps/api/src/lib/jellyfin/jellyfin-client.ts`
- Modify: `apps/api/src/lib/services/connection-tester.ts`
- Modify: `apps/api/src/lib/tautulli/tautulli-client.ts`
- Add/modify matching client and connection tests

- [ ] Add failing Plex `/identity` tests and Jellyfin/Emby `System/Info` tests for normalized ID, missing ID, wrong shape, timeout, and safe error handling.
- [ ] Add bounded Tautulli compatibility tests for `get_server_info`/`get_servers_info`: exactly one Plex machine identifier verifies; zero, multiple, or unsupported responses are analytics-only.
- [ ] Ensure an ordinary connection test reports probe state but never persists enrollment.
- [ ] Implement probes and run focused client tests.
- [ ] Commit: `feat: probe upstream service identities`.

## Task 3: Add explicit enrollment and replacement lifecycle

**Files:**
- Modify: `apps/api/src/routes/services.ts`
- Modify: `apps/api/src/routes/__tests__/service-lifecycle.test.ts`
- Modify: `apps/api/src/routes/route-manifest.ts`
- Modify: `docs/API-ROUTES.md`

- [ ] Add failing tests for new service binding, existing unbound row, preview without mutation, confirmed enrollment, ordinary edit same identity, ordinary edit different identity, confirmed replacement, failed replacement, ownership, disabled rows, and concurrent update.
- [ ] Add `POST /services/:id/identity/enroll` with an operator-safe probe preview and explicit confirmation.
- [ ] Add `POST /services/:id/identity/replace`; probe first, then atomically update credentials/URL and identity, increment generation, and clear provider cache/status/evidence.
- [ ] Return `409` from ordinary updates when the live identity differs; preserve old configuration and evidence.
- [ ] Bind new Plex/Jellyfin/Emby services during creation; leave existing null rows unbound until explicit enrollment.
- [ ] Run `pnpm --filter @arr/api test -- service-lifecycle` and commit: `feat: require explicit server identity enrollment`.

## Task 4: Guard cache collection and publication

**Files:**
- Modify: `apps/api/src/lib/services/provider-connection-guard.ts`
- Modify: `apps/api/src/lib/plex/plex-cache-refresher.ts`
- Modify: `apps/api/src/lib/plex/plex-episode-cache-refresher.ts`
- Modify: `apps/api/src/lib/jellyfin/jellyfin-cache-refresher.ts`
- Modify: `apps/api/src/lib/jellyfin/jellyfin-episode-cache-refresher.ts`
- Modify: Tautulli refresher and manual/scheduled/Pulse refresh callers
- Add/modify corresponding refresher tests

- [ ] Add failing tests for unbound rows, wrong-server reverse proxy, identity changes between pre/post probes, stable success, refresh-versus-replacement races, and failed-attempt preservation.
- [ ] Require expected identity before gather, live match before and after gather, and identity plus generation match in the publication transaction.
- [ ] Apply the same guarded refresher to manual, scheduled, and Pulse-triggered runs.
- [ ] Never publish a gathered generation when any identity check is unavailable or mismatched.
- [ ] Run focused refresh tests and commit: `fix: bind cache publication to server identity`.

## Task 5: Bind cleanup and rescan evidence

**Files:**
- Modify: `apps/api/src/lib/library-cleanup/shared-plex-safety.ts`
- Modify: `apps/api/src/lib/library-cleanup/cleanup-executor.ts`
- Modify: `apps/api/src/lib/library-cleanup/media-server-rescan.ts`
- Modify: `apps/api/src/routes/library-cleanup.ts`
- Modify: `apps/api/prisma/schema.prisma` where cleanup evidence persists identity
- Modify: cleanup and rescan execution tests

- [ ] Add failing tests for missing/mismatched identity at preview, execution, post-gather, rescan, retry, partial failure, and concurrent replacement.
- [ ] Carry upstream identity in cleanup evidence in addition to the connection fingerprint.
- [ ] Resolve and compare identity again immediately before each upstream mutation and rescan.
- [ ] Return blocked/unknown on missing or mismatched identity; never produce a candidate, deletion, unmonitor, or rescan target from that evidence.
- [ ] Record success only after upstream success and retain an honest retryable state on partial failure.
- [ ] Run focused cleanup/rescan tests and commit: `fix: authorize cleanup with durable server identity`.

## Task 6: Expose safe status and controls

**Files:**
- Modify: `apps/api/src/lib/pulse/collectors.ts`
- Modify: `apps/api/src/lib/pulse/constants.ts`
- Modify: `apps/web/src/lib/api-client/services.ts`
- Modify: `apps/web/src/features/settings/components/service-instance-card.tsx`
- Modify: `apps/web/src/features/settings/components/service-form.tsx`
- Modify: `apps/web/src/features/settings/hooks/use-services-management.ts`
- Add/modify Pulse and settings component tests

- [ ] Add distinct `unbound`, `identity_mismatch`, `identity_unavailable`, and `analytics_only` signals with stable entity-keyed IDs.
- [ ] Add explicit `Enroll current server` and `Replace enrolled server` controls with safe server name/version confirmation.
- [ ] Add Tautulli `Analytics only — Plex server identity unavailable` state.
- [ ] Test incognito mode and prove raw identifiers, URLs, and credentials are never rendered.
- [ ] Run focused Pulse/web tests and commit: `feat: surface service identity state`.

## Task 7: Freeze and validate the wave

- [ ] Run the full identity, lifecycle, cache, cleanup, rescan, Pulse, and settings suites.
- [ ] Run Prisma validation/generation, format, shared build, root typecheck, full tests, lint, and production build.
- [ ] Live-verify stable reverse-proxy success, retargeted proxy blocking, enrollment, replacement, and analytics-only Tautulli using authorized fixtures.
- [ ] Delegate one `data_safety_reviewer` and one `regression_reviewer` over the frozen diff. Inventory findings once, use one correction batch, and rerun only affected focused checks plus the final gauntlet.
- [ ] Confirm no identity-dependent path remains fingerprint-only with `rg -n "connectionFingerprint|connectionGeneration" apps/api/src/lib apps/api/src/routes`.
