# Task 4 — Analytics Provider Experience

## Status

Implemented and committed as:

```text
9ed6e1ab feat: add analytics provider experience
```

The commit contains exactly the 13 Task 4 frontend files. No backend, shared-contract, hook, API-client, or generated-file changes were committed.

## Implemented behavior

- Settings > Services now renders `AnalyticsProviderSection` above configured service cards. It has `id="analytics-provider"`, native accessible radio controls, Tracearr as `Recommended`, and Tautulli as `Alternative`.
- Switching a configured selection opens a confirmation dialog. Its copy says that historical analytics changes while native media-server live sessions do not, and explicitly says that it does not migrate, copy, or automatically fail over historical data.
- A disabled or unconfigured selected provider receives a configuration action. An enabled alternative receives an explicit switch action; no alternative analytics component is mounted implicitly.
- The migration notice names the selected provider and links directly to the provider selector without claiming recovery of a removed configuration or data.
- Setup retains one generic service form. A Tautulli selection is persisted only after connection verification and service creation both succeed. Failed verification neither creates the service nor changes provider selection.
- Statistics replaces the provider-named Tracearr tab with a universal `Analytics` tab. `AnalyticsTab` mounts `TracearrTab` only for selected/configured Tracearr and `TautulliTab` only for selected/configured Tautulli.
- `TautulliTab` uses only the existing typed Tautulli stats, plays-by-date, and history responses. It masks titles, usernames, and source instance labels through the incognito provider/helpers.

## Files

Created:

- `apps/web/src/features/settings/components/analytics-provider-section.tsx`
- `apps/web/src/features/settings/components/__tests__/analytics-provider-section.test.tsx`
- `apps/web/src/features/statistics/components/analytics-tab.tsx`
- `apps/web/src/features/statistics/components/tautulli-tab.tsx`
- `apps/web/src/features/statistics/components/__tests__/analytics-tab.test.tsx`
- `apps/web/src/features/statistics/components/__tests__/tautulli-tab.test.tsx`

Modified:

- `apps/web/src/features/settings/components/services-tab.tsx`
- `apps/web/src/features/migrations/components/tautulli-provider-notice.tsx`
- `apps/web/src/features/migrations/components/__tests__/tautulli-provider-notice.test.tsx`
- `apps/web/src/features/setup/components/service-onboarding.tsx`
- `apps/web/src/features/setup/components/__tests__/service-onboarding.test.tsx`
- `apps/web/src/features/statistics/components/statistics-client.tsx`
- `apps/web/src/features/statistics/components/statistics-tabs.tsx`

## TDD evidence

### RED

Initial required RED command:

```bash
pnpm --filter @arr/web test -- analytics-provider-section analytics-tab tautulli-tab service-onboarding tautulli-provider-notice
```

Relevant recorded output:

```text
❯ src/features/migrations/components/__tests__/tautulli-provider-notice.test.tsx (6 tests | 2 failed)
❯ src/features/settings/components/__tests__/analytics-provider-section.test.tsx (0 test)
❯ src/features/setup/components/__tests__/service-onboarding.test.tsx (7 tests | 1 failed)
❯ src/features/statistics/components/__tests__/tautulli-tab.test.tsx (0 test)
❯ src/features/statistics/components/__tests__/analytics-tab.test.tsx (0 test)

Error: Failed to resolve import "../analytics-provider-section" ... Does the file exist?
Error: Failed to resolve import "../analytics-tab" ... Does the file exist?
Error: Failed to resolve import "../tautulli-tab" ... Does the file exist?

Tautulli provider notice expected selected-aware copy, but rendered:
"Tautulli and Tracearr are both configured"

ServiceOnboarding expected updateAnalyticsProvider({ provider: "tautulli" })
Number of calls: 0

Test Files  5 failed | 68 passed (73)
Tests  3 failed | 696 passed (699)
```

These failures were expected: the three new components did not yet exist, the notice still used non-selected-aware copy, and setup had no post-create Tautulli selection mutation.

Additional RED for the separately required neither-configured state:

```bash
pnpm --filter @arr/web test -- analytics-tab
```

Relevant recorded output:

```text
× guides a new installation to configure its selected provider when neither family exists

Unable to find an element with the text:
No historical analytics provider is configured yet.

Rendered heading: Tracearr is selected but unavailable

Test Files  1 failed | 72 passed (73)
Tests  1 failed | 706 passed (707)
```

The minimal GREEN change added the distinct no-provider heading while preserving the selected-provider configuration action and no-switch state.

### GREEN

Final focused command:

```bash
pnpm --filter @arr/web test -- analytics-provider-section analytics-tab tautulli-tab service-onboarding tautulli-provider-notice tracearr-tab tracearr-panels
```

Recorded output:

```text
RUN  v4.1.10 /home/khak1s/.codex/worktrees/arr-dashboard/next-analytics-provider-selection/apps/web

Test Files  73 passed (73)
Tests  707 passed (707)
Start at  07:24:59
Duration  6.19s
```

The focused coverage includes recommendation/alternative labels, migration default, radio keyboard/dialog flow, unavailable and neither-configured states, no implicit provider mounting, incognito masking, selected-aware notices, and verified setup mutation ordering/failure behavior.

## Validation

### Biome, owned files only

The final format and lint pass targeted only the 13 assigned files:

```bash
pnpm exec biome format --write \
  apps/web/src/features/settings/components/analytics-provider-section.tsx \
  apps/web/src/features/settings/components/__tests__/analytics-provider-section.test.tsx \
  apps/web/src/features/settings/components/services-tab.tsx \
  apps/web/src/features/migrations/components/tautulli-provider-notice.tsx \
  apps/web/src/features/migrations/components/__tests__/tautulli-provider-notice.test.tsx \
  apps/web/src/features/setup/components/service-onboarding.tsx \
  apps/web/src/features/setup/components/__tests__/service-onboarding.test.tsx \
  apps/web/src/features/statistics/components/analytics-tab.tsx \
  apps/web/src/features/statistics/components/tautulli-tab.tsx \
  apps/web/src/features/statistics/components/__tests__/analytics-tab.test.tsx \
  apps/web/src/features/statistics/components/__tests__/tautulli-tab.test.tsx \
  apps/web/src/features/statistics/components/statistics-client.tsx \
  apps/web/src/features/statistics/components/statistics-tabs.tsx
```

```text
Formatted 13 files in 6ms. No fixes applied.
```

```bash
pnpm exec biome lint \
  apps/web/src/features/settings/components/analytics-provider-section.tsx \
  apps/web/src/features/settings/components/__tests__/analytics-provider-section.test.tsx \
  apps/web/src/features/settings/components/services-tab.tsx \
  apps/web/src/features/migrations/components/tautulli-provider-notice.tsx \
  apps/web/src/features/migrations/components/__tests__/tautulli-provider-notice.test.tsx \
  apps/web/src/features/setup/components/service-onboarding.tsx \
  apps/web/src/features/setup/components/__tests__/service-onboarding.test.tsx \
  apps/web/src/features/statistics/components/analytics-tab.tsx \
  apps/web/src/features/statistics/components/tautulli-tab.tsx \
  apps/web/src/features/statistics/components/__tests__/analytics-tab.test.tsx \
  apps/web/src/features/statistics/components/__tests__/tautulli-tab.test.tsx \
  apps/web/src/features/statistics/components/statistics-client.tsx \
  apps/web/src/features/statistics/components/statistics-tabs.tsx
```

```text
Checked 13 files in 8ms. No fixes applied.
```

### Web typecheck

```bash
pnpm --filter @arr/web typecheck
```

```text
> @arr/web@0.1.0 typecheck
> tsc --noEmit
```

Exit status: 0.

### Web production build

```bash
pnpm --filter @arr/web build
```

Recorded output:

```text
> @arr/web@0.1.0 build
> next build --webpack

▲ Next.js 16.2.11 (webpack)

Creating an optimized production build ...
✓ Compiled successfully in 6.0s
Running TypeScript ...
Finished TypeScript in 15.1s ...
Collecting page data using 29 workers ...
Generating static pages using 29 workers (0/26) ...
Generating static pages using 29 workers (6/26)
Generating static pages using 29 workers (12/26)
Generating static pages using 29 workers (19/26)
✓ Generating static pages using 29 workers (26/26) in 475ms
Finalizing page optimization ...
Collecting build traces ...
```

Exit status: 0. The build rewrote `apps/web/next-env.d.ts` to its production `.next/types` reference; it was restored to the tracked development reference before commit and is not in commit `9ed6e1ab`.

## Loopback smoke — NOT verification evidence

Browser plugin availability: absent. A temporary web-only dev server was started:

```bash
pnpm --filter @arr/web dev
```

```text
▲ Next.js 16.2.11 (webpack)
- Local: http://localhost:3000
✓ Ready in 209ms
```

The initial Node Playwright attempt was not usable because the repository did not expose Playwright as an importable runtime:

```text
Error: Cannot find module 'playwright'
```

The available CLI then captured a local screenshot:

```bash
pnpm exec playwright screenshot --device="Desktop Chrome" http://127.0.0.1:3000/setup /tmp/arr-task4-setup.png
```

```text
Navigating to http://127.0.0.1:3000/setup
Capturing screenshot into /tmp/arr-task4-setup.png
```

This was **not verification evidence**. The web-only server had no API fixture/backend, and its log showed proxy timeouts before the route returned:

```text
Request timed out after 3000ms
Retrying 1/3...
Request timed out after 3000ms
Retrying 1/3...
GET /setup 200 in 13.5s
```

The captured page was blank, so no rendered Task 4 behavior, interaction, or console health claim was made from this smoke attempt.

## Cleanup

- The temporary `pnpm --filter @arr/web dev` server was stopped with `SIGINT`.
- The temporary screenshot `/tmp/arr-task4-setup.png` was deleted after inspection.
- No temporary browser script or browser artifact was written into the repository.

## Self-review

- `git diff --check` was clean before staging and after staging.
- The staged commit listed exactly the 13 assigned Task 4 files.
- `apps/web/next-env.d.ts` was restored after each production build and does not appear in the commit.
- The final committed tree was verified as `codex/next-analytics-provider-selection...origin/next [ahead 8]` with commit `9ed6e1ab` at HEAD.
- Review found no backend-contract expansion, no fabricated Tracearr-only capability in Tautulli, no implicit provider fallback, and no unmasked title/username/instance label in the new Tautulli surface.

## Remaining concerns

- Rendered loopback verification is inconclusive because no authenticated/populated backend fixture was available; the focused component tests provide the accessibility, dialog, provider-isolation, setup-ordering, and incognito evidence for this task.
- The Settings switch dialog is intentionally used for configured selections. An unavailable selected family presents an explicit switch action, not an automatic fallback.

## Fix round 1/5 — 2026-08-14

Base commit: `9ed6e1ab feat: add analytics provider experience`.

### Implemented behavior and owned files

Only these six owned Task 4 frontend files changed in this correction:

- `apps/web/src/features/setup/components/service-onboarding.tsx` and its test: the Tracearr and Tautulli setup choices visibly and accessibly include Recommended and Alternative; a successful Tautulli creation followed by provider-selection failure clears the draft and reports honest partial success directing the operator to Settings > Services; provider-selection pending state disables submission.
- `apps/web/src/features/migrations/components/tautulli-provider-notice.tsx` and its test: the both-configured notice names the non-selected provider dynamically.
- `apps/web/src/features/statistics/components/tautulli-tab.tsx` and its test: all three provider collections pass explicit empty-state predicates; typed per-source incomplete metadata is rendered for stats, plays, and history; incomplete history never masquerades as generic empty history; pagination incompleteness is displayed; composite history keys include the user.

No backend or shared contracts changed, and no rollback deletion was added.

### RED — expected failing behavior tests

The new behavioral tests were added before the implementation, then run with:

```bash
pnpm --filter @arr/web test -- service-onboarding tautulli-tab tautulli-provider-notice
```

The RED run reported 8 failures (707 passed / 715 total). The expected failures directly matched the frozen inventory:

- Tracearr/Tautulli choices had only their service names, not Recommended/Alternative labels.
- Tautulli provider-selection failure surfaced the outer `Failed to add service` error and left the form present.
- `updateAnalyticsProvider.isPending` did not disable the Tautulli submit action.
- Empty source arrays did not render the supplied `AsyncStateView` empty states.
- Stats used the generic `Some user statistics are incomplete.` copy rather than the typed failure reason and failed-user count.
- Plays/history did not display source or pagination incompleteness, so incomplete empty history could look like generic empty history.
- React emitted `Encountered two children with the same key` for same item/time, different-user history rows; the old key was `tautulli-1-42-2026-08-10T00:00:00.000Z`.
- When Tautulli was selected, the both-configured notice still said Tautulli was also configured instead of Tracearr.

The first post-implementation test invocation also exposed four existing setup tests that still queried the old exact accessible name `tautulli`. The rendered accessible role list showed the deliberate new name `tautulliAlternative`; the assertions were updated to query `/tautulli.*alternative/i`, preserving role-based behavior coverage.

### GREEN — focused tests

After the implementation and assertion update, the same focused command completed with:

```text
Test Files  73 passed (73)
Tests  715 passed (715)
Start at  07:38:36
Duration  6.14s
```

The complete Task 4 focused suite plus Tracearr regressions was then run:

```bash
pnpm --filter @arr/web test -- analytics-provider-section analytics-tab tautulli-tab service-onboarding tautulli-provider-notice tracearr-tab tracearr-panels
```

```text
Test Files  73 passed (73)
Tests  715 passed (715)
Start at  07:38:55
Duration  5.80s
```

The duplicate-history fixture initially triggered strict `noUncheckedIndexedAccess` type errors on its known non-empty source/item. It was narrowed with non-null assertions in test-only fixture setup, then rerun:

```bash
pnpm --filter @arr/web test -- tautulli-tab
pnpm --filter @arr/web typecheck
```

```text
Test Files  73 passed (73)
Tests  715 passed (715)
Start at  07:39:23
Duration  5.94s

> @arr/web@0.1.0 typecheck
> tsc --noEmit
```

### Final validation

Biome was run only on the six changed owned files:

```bash
pnpm exec biome format --write \
  apps/web/src/features/setup/components/service-onboarding.tsx \
  apps/web/src/features/setup/components/__tests__/service-onboarding.test.tsx \
  apps/web/src/features/migrations/components/tautulli-provider-notice.tsx \
  apps/web/src/features/migrations/components/__tests__/tautulli-provider-notice.test.tsx \
  apps/web/src/features/statistics/components/tautulli-tab.tsx \
  apps/web/src/features/statistics/components/__tests__/tautulli-tab.test.tsx

pnpm exec biome lint \
  apps/web/src/features/setup/components/service-onboarding.tsx \
  apps/web/src/features/setup/components/__tests__/service-onboarding.test.tsx \
  apps/web/src/features/migrations/components/tautulli-provider-notice.tsx \
  apps/web/src/features/migrations/components/__tests__/tautulli-provider-notice.test.tsx \
  apps/web/src/features/statistics/components/tautulli-tab.tsx \
  apps/web/src/features/statistics/components/__tests__/tautulli-tab.test.tsx
```

```text
Formatted 6 files in 4ms. No fixes applied.
Checked 6 files in 6ms. No fixes applied.
```

The initial formatter command mistakenly used the nonexistent singular `features/migration` path. Biome reported `No such file or directory`; no file was changed at that path. The final command above used the repository's actual `features/migrations` path and is the formatting evidence for this round.

Web typecheck:

```bash
pnpm --filter @arr/web typecheck
```

```text
> @arr/web@0.1.0 typecheck
> tsc --noEmit
```

Exit status: 0.

Web production build:

```bash
pnpm --filter @arr/web build
```

```text
> @arr/web@0.1.0 build
> next build --webpack

▲ Next.js 16.2.11 (webpack)

Creating an optimized production build ...
✓ Compiled successfully in 6.2s
Running TypeScript ...
Finished TypeScript in 14.6s ...
Collecting page data using 29 workers ...
Generating static pages using 29 workers (0/26) ...
Generating static pages using 29 workers (6/26)
Generating static pages using 29 workers (12/26)
Generating static pages using 29 workers (19/26)
✓ Generating static pages using 29 workers (26/26) in 460ms
Finalizing page optimization ...
Collecting build traces ...
```

Exit status: 0. The build rewrote `apps/web/next-env.d.ts` to the production `.next/types/routes.d.ts` reference; it was restored with `apply_patch` to the tracked development `.next/dev/types/routes.d.ts` reference and is not part of this correction.

```bash
git diff --check
```

Exit status: 0.

### Loopback and cleanup

No loopback smoke was repeated in this correction. The prior web-only loopback smoke remains explicitly **NOT verification evidence**: its API proxy timed out and rendered blank without an authenticated/populated backend. No temporary server, screenshot, or browser artifact was created by fix round 1/5.

### Self-review and concerns

- Reviewed the bounded diff after the production build and generated-file restoration: six owned Task 4 files plus this persistent report only.
- Confirmed the partial-success path neither reports service creation as failed nor permits immediate form resubmission; it does not attempt deletion/rollback.
- Confirmed source-unreachable, connection-changed, user-list-unavailable, user-stats-partial (with failed user count), plays partial, history partial, incomplete pagination, and duplicate history keys are covered by the focused tests.
- No new concerns beyond the existing lack of authenticated/populated browser evidence. The earlier loopback result remains non-evidence rather than a claim of rendered behavior.
