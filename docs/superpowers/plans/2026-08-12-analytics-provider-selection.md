# Historical Analytics Provider Selection Plan

> **Required subskill:** Use `superpowers:subagent-driven-development` and `arr-integration-change`. Use `arr-validate` before PR preparation.

**Goal:** Make Tracearr/Tautulli historical analytics selection explicit, deterministic, and operator-controlled while preserving native media-server live and operational data.

**Architecture:** A singleton setting stores the selected provider family. One resolver materializes upgrade defaults and is the only authority used by provider-backed analytics and watch-evidence adapters. Native Plex/Jellyfin/Emby session and operational metrics remain native and clearly separate; responses never merge provider families.

**Tech stack:** Prisma, Fastify, Zod, TypeScript, React, TanStack Query, Vitest.

**Global constraints:** Tracearr recommended/default; Tautulli alternative; no silent mixing or outage failover; removing/disabling a provider does not silently switch selection.

---

## Task 1: Persist and resolve selection

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260812110000_add_analytics_provider/migration.sql`
- Create: `apps/api/src/lib/analytics/provider-resolver.ts`
- Create: `apps/api/src/lib/analytics/provider-resolver.test.ts`

- [ ] Add nullable `analyticsProvider` to `SystemSettings` with application validation to `tracearr | tautulli`.
- [ ] Add the complete failing resolution matrix: fresh/neither, Tracearr-only, Tautulli-only, both, explicit override, selected disabled, selected deleted, and selected unreachable.
- [ ] Implement:

```ts
type AnalyticsProviderResolution = {
  selected: "tracearr" | "tautulli";
  source: "explicit" | "migration-default";
  configured: Record<"tracearr" | "tautulli", boolean>;
  enabled: Record<"tracearr" | "tautulli", boolean>;
  available: boolean;
  degraded: boolean;
  reason?: "not_configured" | "unreachable" | "invalid_response";
};
```

- [ ] Materialize inferred upgrade selection transactionally: Tautulli-only selects Tautulli; both and all other fresh states select Tracearr.
- [ ] Keep the explicit value when its last enabled instance disappears; report degraded state.
- [ ] Run `pnpm --filter @arr/api test -- provider-resolver` and commit: `feat: resolve historical analytics provider`.

## Task 2: Expose the setting API

**Files:**
- Modify: `apps/api/src/routes/system.ts`
- Modify: `apps/api/src/routes/__tests__/system-settings.test.ts`
- Modify: `apps/api/src/routes/route-manifest.ts`
- Modify: `apps/web/src/lib/api-client/system.ts`
- Modify: `apps/web/src/hooks/api/useSystem.ts`
- Modify: `docs/API-ROUTES.md`

- [ ] Add failing tests for read, validated update, ownership/admin authorization, unchanged-provider idempotency, unavailable selected provider, and no auto-switch.
- [ ] Return configured/enabled/availability state without credentials or raw URLs.
- [ ] Require an explicit update request to switch providers and invalidate analytics/rule queries after success.
- [ ] Run focused API/hook tests and commit: `feat: expose analytics provider selection`.

## Task 3: Route provider-backed analytics through one adapter

**Files:**
- Create: `apps/api/src/lib/analytics/historical-analytics-provider.ts`
- Modify: `apps/api/src/routes/tracearr/analytics-routes.ts`
- Modify: `apps/api/src/routes/tautulli/activity-routes.ts`
- Modify: `apps/api/src/routes/tautulli/history-routes.ts`
- Modify: `apps/api/src/routes/tautulli/stats-routes.ts`
- Test: `apps/api/src/routes/__tests__/tracearr-analytics-routes.test.ts`
- Test: `apps/api/src/routes/tautulli/__tests__/aggregation.test.ts`

- [ ] Define a provider-neutral interface for activity, history, statistics, watch enrichment, and rule evidence.
- [ ] Add failing tests that configure data in both families and prove each request returns only the selected family.
- [ ] Add outage tests proving a selected-provider failure returns degraded/unavailable and never reads the alternative.
- [ ] Keep native `SessionSnapshot` media-server operational analytics outside this adapter and label it as native; do not inject it into provider-backed responses.
- [ ] Implement the adapter and update all external historical analytics consumers.
- [ ] Run focused provider route tests and commit: `feat: isolate selected analytics provider data`.

## Task 4: Apply selection to rules and cleanup evidence

**Files:**
- Modify: `apps/api/src/lib/rules/engine.ts`
- Modify: `apps/api/src/lib/library-cleanup/rule-evaluators.ts`
- Modify: `apps/api/src/lib/library-cleanup/cleanup-executor.ts`
- Modify: `apps/api/src/lib/library-cleanup/shared-plex-safety.ts`
- Test: `apps/api/src/lib/rules/__tests__/engine.test.ts`
- Test: `apps/api/src/lib/library-cleanup/phase1-features.test.ts`
- Test: `apps/api/src/lib/library-cleanup/__tests__/mutation-policy-snapshot.test.ts`

- [ ] Add failing tests with contradictory Tracearr/Tautulli evidence proving only the selected family contributes.
- [ ] Test unselected provider healthy, selected provider unavailable, selected cache incomplete, and provider switched between preview and execution.
- [ ] Resolve selection again at execution time; a changed source invalidates cached preview evidence.
- [ ] Return unknown/blocked on selected-provider failure; never fail over or merge.
- [ ] Run focused tests and commit: `fix: bind watch evidence to selected provider`.

## Task 5: Add administrator settings UI

**Files:**
- Create: `apps/web/src/features/settings/components/analytics-provider-section.tsx`
- Create: `apps/web/src/features/settings/components/__tests__/analytics-provider-section.test.tsx`
- Modify: settings page composition under `apps/web/src/features/settings/`
- Modify: setup flow provider copy under `apps/web/src/features/setup/`

- [ ] Add failing tests for recommended/alternative labels, default state, explicit switch, both configured, selected unavailable, no provider, keyboard accessibility, and incognito-safe text.
- [ ] Render Tracearr as `Recommended` and Tautulli as `Alternative`.
- [ ] Explain that switching changes historical analytics and watch evidence, not native live sessions; never claim data migration or failover.
- [ ] Require confirmation when switching away from a configured provider with current data.
- [ ] Run `pnpm --filter @arr/web test -- analytics-provider-section` and commit: `feat: add analytics provider selector`.

## Task 6: Freeze and validate the wave

- [ ] Run resolver, route, rule, cleanup, and UI matrix tests.
- [ ] Run Prisma validation/generation and the full repository gauntlet plus production build.
- [ ] Live-verify Tracearr-only, Tautulli-only, both/default, explicit switch, and selected-provider outage using populated fixtures.
- [ ] Delegate one `regression_reviewer` and one `data_safety_reviewer` over the frozen wave; accept findings once and correct once.
- [ ] Verify search results show no direct provider choice outside the central resolver: `rg -n "analyticsProvider|selected.*tracearr|selected.*tautulli" apps/api/src`.
