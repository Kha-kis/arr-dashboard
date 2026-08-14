# Historical Analytics Provider Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Use arr-integration-change throughout and arr-validate before PR preparation.

**Goal:** Make Tracearr/Tautulli historical analytics selection explicit, deterministic, and operator-controlled while preserving native media-server live and operational data.

**Architecture:** A nullable singleton setting is materialized once into a selected provider and source. One resolver owns selection and guards provider-specific historical routes; the frontend renders one Analytics surface from that selection. Native Plex/Jellyfin/Emby sessions and Tracearr live-session operations remain outside this historical-provider boundary.

**Tech Stack:** Prisma 7 with `db push`, Fastify 5, Zod, TypeScript, React 19, TanStack Query, Vitest, Playwright, Docker Compose.

## Global Constraints

- Tracearr is `Recommended` and the fresh-install default; Tautulli is a supported `Alternative`.
- Historical analytics never mix provider families and never silently fail over during an outage.
- Existing Tautulli and Tracearr service instances remain configured when the other family is selected.
- Disabling or deleting the last enabled selected-family instance requires explicit confirmation and never changes selection implicitly.
- Cache-health and connection-management endpoints remain provider-specific and available for maintaining an unselected provider.
- Tracearr stream listing/termination and native media-server sessions are live operational data, not historical-provider selection.
- Tautulli rule reactivation and deletion-sensitive cleanup authority remain out of this PR; they require the separately approved durable-upstream-identity wave.
- The repository uses Prisma `db push`; do not add a provider-specific SQL migration.
- Use one frozen finding inventory and one correction pass. New review observations outside corrected lines become follow-up work unless they prove this change unsafe or invalid.

---

### Task 1: Persist and resolve one provider family

**Files:**
- Create: `packages/shared/src/types/analytics-provider.ts`
- Create: `packages/shared/src/types/__tests__/analytics-provider.test.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Regenerate: `apps/api/src/generated/prisma/`
- Create: `apps/api/src/lib/analytics/provider-selection.ts`
- Create: `apps/api/src/lib/analytics/provider-selection.test.ts`

**Interfaces:**
- Produces `AnalyticsProvider = "tracearr" | "tautulli"`.
- Produces `AnalyticsProviderSelection` with `selected`, `source`, `families`, and `status`.
- Produces `resolveAnalyticsProviderSelection(prisma, userId)`, `selectAnalyticsProvider(prisma, userId, provider)`, and `requireSelectedAnalyticsProvider(prisma, userId, provider)`.
- `families.<provider>` exposes only `configuredCount` and `enabledCount`; it never exposes labels, URLs, or credentials.

- [ ] **Step 1: Write shared-contract and resolver tests first**

Cover the exact matrix below, including persistence of the inferred value:

```ts
it.each([
  { stored: null, tracearr: 0, tautulli: 0, selected: "tracearr", source: "migration-default" },
  { stored: null, tracearr: 0, tautulli: 1, selected: "tautulli", source: "migration-default" },
  { stored: null, tracearr: 1, tautulli: 1, selected: "tracearr", source: "migration-default" },
  { stored: "tautulli", tracearr: 1, tautulli: 0, selected: "tautulli", source: "explicit" },
])("resolves $selected without failover", async (scenario) => {
  const resolution = await resolveScenario(scenario);
  expect(resolution.selected).toBe(scenario.selected);
  expect(resolution.source).toBe(scenario.source);
});
```

Also prove an explicit selected family stays selected when disabled, deleted, or unreachable; only its status changes to `disabled` or `unconfigured`.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @arr/shared test -- analytics-provider
pnpm --filter @arr/api test -- provider-selection
```

Expected: fail because the shared contract, schema fields, and resolver do not exist.

- [ ] **Step 3: Implement the minimal contract and resolver**

Add nullable `analyticsProvider` and `analyticsProviderSource` strings to `SystemSettings`. Validate both at the application boundary. In one Prisma transaction, read the singleton and user-scoped provider counts, infer `tautulli` only for a Tautulli-only existing installation, otherwise infer `tracearr`, and materialize both selected value and `migration-default` source. `selectAnalyticsProvider` stores `explicit` without requiring that family to be configured.

`requireSelectedAnalyticsProvider` throws a typed mismatch error carrying only expected/actual provider names. It does not query or call the alternative provider.

- [ ] **Step 4: Generate and verify GREEN**

```bash
pnpm --filter @arr/shared build
pnpm --filter @arr/api db:generate
pnpm --filter @arr/shared test -- analytics-provider
pnpm --filter @arr/api test -- provider-selection
```

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/api/prisma/schema.prisma apps/api/src/generated/prisma apps/api/src/lib/analytics
git commit -m "feat: resolve historical analytics provider"
```

### Task 2: Expose selection and guard selected-provider lifecycle changes

**Files:**
- Modify: `apps/api/src/routes/system.ts`
- Create: `apps/api/src/routes/__tests__/system-analytics-provider.test.ts`
- Modify: `apps/api/src/routes/system-migrations-tautulli.test.ts`
- Modify: `apps/api/src/routes/services.ts`
- Create: `apps/api/src/routes/__tests__/services-analytics-provider.test.ts`
- Modify: `apps/web/src/lib/api-client/system.ts`
- Modify: `apps/web/src/lib/api-client/services.ts`
- Modify: `apps/web/src/hooks/api/useSystem.ts`
- Modify: `apps/web/src/hooks/api/useServiceMutations.ts`
- Modify: `apps/web/src/lib/query-keys.ts`
- Modify: `docs/API-ROUTES.md`

**Interfaces:**
- Produces authenticated `GET /api/system/analytics-provider` returning `AnalyticsProviderSelection`.
- Produces authenticated `PUT /api/system/analytics-provider` accepting exactly `{ provider: AnalyticsProvider }`.
- Extends service update payloads and delete query parameters with `confirmAnalyticsUnavailableFor?: AnalyticsProvider`.
- A blocked last-instance mutation returns HTTP 409 with code `ANALYTICS_PROVIDER_CONFIRMATION_REQUIRED`, the selected family, and whether the other family has an enabled instance. It contains no service label or URL.

- [ ] **Step 1: Write failing route and lifecycle tests**

Prove GET materializes the migration default, PUT rejects unknown values, unchanged PUT is idempotent, and both routes remain user-scoped. For services, test disabling, changing type, and deleting the last enabled selected-family instance:

```ts
expect(blocked.statusCode).toBe(409);
expect(blocked.json()).toMatchObject({
  code: "ANALYTICS_PROVIDER_CONFIRMATION_REQUIRED",
  selected: "tautulli",
  alternativeEnabled: true,
});
expect(deleteService).not.toHaveBeenCalled();
```

Repeat with `confirmAnalyticsUnavailableFor` set to the provider returned by the 409; the mutation succeeds and a following selection read still reports the same selected family as unavailable. Verify a stale provider-bound confirmation receives a fresh 409 and an unselected-family mutation needs no provider confirmation.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @arr/api test -- system-analytics-provider services-analytics-provider system-migrations-tautulli
pnpm --filter @arr/web test -- useSystem useServiceMutations
```

- [ ] **Step 3: Implement routes, mutation guard, and client contracts**

Parse every body/query with `validateRequest()`. Reuse the resolver from Task 1; do not duplicate selection logic in routes. Run the lifecycle guard inside the existing cleanup-topology mutation lease and re-count user-owned enabled provider instances immediately before mutation. Confirmation permits unavailability but never switches the setting.

Invalidate analytics-provider, Tracearr analytics, Tautulli analytics, service, and provider-notice query keys after an explicit switch. Update the both-configured notice to state which provider is selected and link to `/settings/services#analytics-provider`; show it only for an undismissed migration-default both-provider selection. Keep the prior-removal notice dormant.

- [ ] **Step 4: Run GREEN**

```bash
pnpm --filter @arr/api test -- system-analytics-provider services-analytics-provider system-migrations-tautulli
pnpm --filter @arr/web test -- useSystem useServiceMutations
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes apps/web/src/lib apps/web/src/hooks docs/API-ROUTES.md
git commit -m "feat: expose analytics provider selection"
```

### Task 3: Enforce selection at every historical analytics route

**Files:**
- Modify: `apps/api/src/routes/tracearr/analytics-routes.ts`
- Modify: `apps/api/src/routes/tautulli/activity-routes.ts`
- Modify: `apps/api/src/routes/tautulli/history-routes.ts`
- Modify: `apps/api/src/routes/tautulli/stats-routes.ts`
- Modify: `apps/api/src/routes/__tests__/tracearr-analytics-routes.test.ts`
- Modify: `apps/api/src/routes/tautulli/__tests__/aggregation.test.ts`

**Interfaces:**
- Consumes `requireSelectedAnalyticsProvider()` from Task 1.
- Provider-specific historical endpoints return HTTP 409 `ANALYTICS_PROVIDER_NOT_SELECTED` before creating a client for an unselected family.
- Tracearr `/streams` and `/streams/:id/terminate`, Tautulli cache status/refresh, and all connection-management routes remain outside this guard.

- [ ] **Step 1: Write contradictory-provider RED tests**

Configure both provider families with callable client spies. Select Tautulli and request every Tracearr analytics endpoint; select Tracearr and request Tautulli activity, stats, plays-by-date, and history. Assert 409 and zero calls into the unselected client. Add an outage case proving the selected client failure is returned and the alternative client remains untouched.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @arr/api test -- tracearr-analytics-routes aggregation
```

- [ ] **Step 3: Add the guard before client resolution**

Call `requireSelectedAnalyticsProvider()` after authentication and query validation but before provider instance lookup or client creation. Map only the typed mismatch error to 409; preserve existing provider-specific malformed-response and outage behavior.

- [ ] **Step 4: Run GREEN and route-manifest tests**

```bash
pnpm --filter @arr/api test -- tracearr-analytics-routes aggregation route-manifest
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/tracearr apps/api/src/routes/tautulli apps/api/src/routes/__tests__
git commit -m "feat: isolate selected analytics provider data"
```

### Task 4: Add the Settings selector, setup choice, and unified Analytics tab

**Files:**
- Create: `apps/web/src/features/settings/components/analytics-provider-section.tsx`
- Create: `apps/web/src/features/settings/components/__tests__/analytics-provider-section.test.tsx`
- Modify: `apps/web/src/features/settings/components/services-tab.tsx`
- Modify: `apps/web/src/features/migrations/components/tautulli-provider-notice.tsx`
- Modify: `apps/web/src/features/migrations/components/__tests__/tautulli-provider-notice.test.tsx`
- Modify: `apps/web/src/features/setup/components/service-onboarding.tsx`
- Modify: `apps/web/src/features/setup/components/__tests__/service-onboarding.test.tsx`
- Create: `apps/web/src/features/statistics/components/analytics-tab.tsx`
- Create: `apps/web/src/features/statistics/components/tautulli-tab.tsx`
- Create: `apps/web/src/features/statistics/components/__tests__/analytics-tab.test.tsx`
- Create: `apps/web/src/features/statistics/components/__tests__/tautulli-tab.test.tsx`
- Modify: `apps/web/src/features/statistics/components/statistics-client.tsx`
- Modify: `apps/web/src/features/statistics/components/statistics-tabs.tsx`

**Interfaces:**
- `AnalyticsProviderSection` consumes Task 2 hooks and renders `id="analytics-provider"`.
- `AnalyticsTab` consumes the selection: Tracearr renders the existing `TracearrTab`; Tautulli renders `TautulliTab`; unavailable selection renders an actionable empty state and never renders the other provider.
- `TautulliTab` consumes existing typed Tautulli stats, plays-by-date, and history hooks and masks titles, usernames, and instance labels through incognito helpers.
- Setup keeps one generic service form but presents explicit Tracearr `Recommended` and Tautulli `Alternative` choices; choosing Tautulli writes the explicit selection after its verified service creation succeeds.

- [ ] **Step 1: Write UI RED tests**

Cover recommended/alternative labels, migration-default state, explicit switch confirmation, selected unavailable, neither configured, keyboard operation, incognito-safe copy, and no implicit failover. Prove `AnalyticsTab` mounts only one provider component:

```tsx
expect(screen.getByTestId("tautulli-analytics")).toBeInTheDocument();
expect(screen.queryByTestId("tracearr-analytics")).not.toBeInTheDocument();
```

In setup, verify selecting Tautulli, passing connection verification, and creating the service calls the selection mutation only after service creation. A failed connection must neither create the service nor change provider selection.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @arr/web test -- analytics-provider-section analytics-tab tautulli-tab service-onboarding tautulli-provider-notice
```

- [ ] **Step 3: Implement the minimal accessible UI**

Put the selector above service cards on Settings > Services. Switching a configured family uses the existing confirmation-dialog pattern and explains that historical analytics/watch evidence change while native live sessions do not. When the selected family is unavailable, offer `Configure selected provider`, and when an enabled alternative exists also offer an explicit switch. Do not claim migration, data copying, or automatic failover.

Replace the provider-named Statistics tab with one `Analytics` tab. Preserve the existing Tracearr components unchanged behind `AnalyticsTab`; build only the Tautulli panels supported by its current response shapes. Provider-specific capability differences remain visible rather than fabricated.

- [ ] **Step 4: Run GREEN and affected frontend tests**

```bash
pnpm --filter @arr/web test -- analytics-provider-section analytics-tab tautulli-tab service-onboarding tautulli-provider-notice tracearr-tab tracearr-panels
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features apps/web/src/hooks apps/web/src/lib
git commit -m "feat: add analytics provider experience"
```

### Task 5: Prove both providers and selected-provider outage in the reusable harness

**Files:**
- Create: `e2e/media-analytics/specs/provider-selection.spec.ts`
- Modify: `e2e/media-analytics/README.md`
- Modify: `e2e/media-analytics/tests/config.test.mjs`

**Interfaces:**
- The existing retained Plex/Tautulli/Tracearr stack is reused; no new container or port is added.
- The Playwright spec switches through the real Settings control and checks real Statistics data without intercepting provider APIs.
- The documented outage sequence stops only the selected provider, verifies its error/unavailable state and absence of alternative-family content, then restores it in a shell trap.

- [ ] **Step 1: Write the live spec and config contract test**

Assert the spec covers both selected states and contains no `page.route()` interception. The browser flow starts with both configured/default Tracearr, switches to Tautulli and observes a Tautulli source, then switches back and observes Tracearr.

- [ ] **Step 2: Run the focused harness contracts**

```bash
node --test e2e/media-analytics/tests/*.test.mjs
```

- [ ] **Step 3: Rebuild the retained stack and run real provider selection**

```bash
pnpm e2e:media-analytics:down
pnpm e2e:media-analytics:up
pnpm exec playwright test --config=e2e/media-analytics/playwright.config.ts provider-selection.spec.ts
```

- [ ] **Step 4: Verify no outage failover**

Select Tautulli, stop only the harness Tautulli service with the checked-in Compose project/file arguments, and use the signed browser to verify the Analytics tab reports Tautulli unavailable without rendering Tracearr analytics. Restore Tautulli in a trap, wait for its existing health check, and rerun the selection spec. Repeat for Tracearr if the first run exposes provider-specific behavior not covered by route tests.

- [ ] **Step 5: Commit**

```bash
git add e2e/media-analytics
git commit -m "test: verify analytics provider selection"
```

### Task 6: Freeze, review once, validate, and prepare the PR

**Files:**
- Modify only files in the frozen finding inventory.

**Interfaces:**
- `regression_reviewer` reviews the complete base-to-head diff for defaults, no mixing/failover, accessibility, and existing provider behavior.
- `data_safety_reviewer` reviews service lifecycle confirmation, selected-provider guards, transaction timing, user scope, and proof that no cleanup authority was enabled.

- [ ] **Step 1: Freeze one review inventory**

Run focused suites and the real harness first. Dispatch each required reviewer once over the complete coherent diff. Record every accepted, rejected-with-evidence, and follow-up finding before editing.

- [ ] **Step 2: Apply one bounded correction pass**

For each accepted in-scope finding, write or amend the failing test first, observe RED, make the minimal correction, and rerun only affected gates. Re-review only the correction diff against the frozen inventory.

- [ ] **Step 3: Run the repository gauntlet**

```bash
pnpm run format
pnpm --filter @arr/shared build
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build
git diff --check origin/next...HEAD
```

- [ ] **Step 4: Run final scope searches**

```bash
rg -n "analyticsProvider|requireSelectedAnalyticsProvider" apps/api/src
rg -n "page\.route\(" e2e/media-analytics/specs/provider-selection.spec.ts
```

Every historical provider decision must route through the central resolver; the live spec must use real responses.

- [ ] **Step 5: Prepare one focused PR**

Use `arr-review-change`, `arr-validate`, and `arr-prepare-pr`. The PR closes only the provider-selection wave. Durable identity, Tautulli rule reactivation, and deletion-sensitive cleanup evidence remain explicit follow-up work.
