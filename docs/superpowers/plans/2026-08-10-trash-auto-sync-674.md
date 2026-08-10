# TRaSH Auto Sync Issue 674 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduce and correct issue #674 so selecting Auto Sync during a
template deployment is persisted, displayed honestly, and causes one verified
deployment to the exact mapped Radarr or Sonarr endpoint after an upstream TRaSH
change.

**Architecture:** Treat Auto Sync as a linked contract with five observable
boundaries: deployment request, durable mapping authority, UI readback, global
update detection, and exact-endpoint scheduled deployment. Diagnose those
boundaries in order and correct only the first broken contract plus directly
dependent behavior. Keep the separate per-template `TrashSyncSchedule.autoApply`
feature out of the correction unless the reporter's exact reproduction proves
that it is the failed trigger.

**Tech Stack:** TypeScript, Fastify, Prisma, Vitest, React, React Query, Docker
Compose, SQLite, PostgreSQL, Radarr, and Sonarr.

## Frozen acceptance contract

- The stable-user correction targets `main`; `next` is assessed and
  forward-ported separately.
- A successful single or bulk deployment submitted with `syncStrategy: "auto"`
  stores `auto` on every equivalent endpoint mapping that was authorized by the
  deployment.
- Reloading the template statistics shows Auto Sync as the current strategy. A
  disabled Auto Sync menu item may mean "already selected," but the surrounding
  UI must make that state unambiguous.
- The global TRaSH update scheduler, enabled by default and running immediately
  at startup and then on its configured interval, detects a newer repository
  commit and calls `processAutoUpdates(userId)`.
- An eligible auto mapping updates its template and deploys to each distinct
  physical ARR endpoint exactly once. Equivalent service aliases do not create
  duplicate writes.
- `manual` mappings never deploy from the global update scheduler. `notify`
  mappings report available updates without mutating ARR.
- User modifications, new CF-group approval requirements, stale connection
  authority, ambiguous mappings, disabled instances, partial writes, and
  uncertain responses remain fail-closed and visible.
- Production Radarr and Sonarr instances are read-only evidence sources. Every
  scheduled write is exercised against disposable instances.
- Use finding IDs `TRASH-674-NNN`. P0/P1 and in-contract or delta-introduced P2
  findings block; unrelated hardening becomes a follow-up.

---

### Task 1: Capture the exact reported state before changing code

**Files:**

- Read: `apps/api/src/plugins/trash-update-scheduler.ts`
- Read: `apps/api/src/lib/trash-guides/update-scheduler.ts`
- Read: `apps/api/src/lib/trash-guides/template-updater.ts`
- Read: `apps/api/src/routes/trash-guides/deployment-routes.ts`
- Read: `apps/web/src/features/trash-guides/components/deployment-preview-modal.tsx`
- Read: `apps/web/src/features/trash-guides/components/template-stats.tsx`

**Interfaces:**

- Consumes: issue #674 on v2.23.0, Unraid, and SQLite.
- Produces: a sanitized evidence record identifying the first broken boundary.

- [ ] **Step 1: Create the stable task branch**

  ```bash
  git fetch origin main next
  git switch --create codex/fix-674-trash-auto-sync origin/main
  pnpm install --frozen-lockfile
  ```

- [ ] **Step 2: Inspect the reporter-equivalent persisted state read-only**

  Deploy a template with Auto Sync in a disposable v2.23.0 environment, then
  capture these values without secrets or profile names:

  - deployment request `syncStrategy`;
  - mapping `templateId`, `instanceId`, `qualityProfileId`, `syncStrategy`,
    `connectionGeneration`, and whether `connectionStateToken` is present;
  - template `trashGuidesCommitHash`, `hasUserModifications`, and
    `lastSyncedAt`;
  - update-scheduler enabled state, interval, last run, next run, and last
    result; and
  - the template-stats API strategy returned after a full reload.

  Record the boundary as one of:

  1. request lost before execution;
  2. mapping persisted with the wrong strategy;
  3. mapping is correct but UI readback is misleading;
  4. scheduler does not detect or process the update; or
  5. processing begins but exact-endpoint deployment is skipped or fails.

- [ ] **Step 3: Confirm which scheduler contract the reporter used**

  Verify that choosing Auto Sync in deployment creates or updates
  `TemplateQualityProfileMapping.syncStrategy`; it does not implicitly create a
  `TrashSyncSchedule`. Open the schedule dialog only to record whether the
  reporter also created an explicit schedule. Do not combine the two mechanisms
  in the correction merely because both can write to ARR.

- [ ] **Step 4: Record the root reproduction**

  Add `TRASH-674-001` to the pull-request finding ledger with the first failed
  boundary, exact sanitized inputs, expected output, actual output, and the
  narrow production paths that own the failure. Freeze that file set before
  implementation.

### Task 2: Add an end-to-end contract regression before the fix

**Files:**

- Modify: `apps/api/src/lib/trash-guides/__tests__/template-updater-authority.test.ts`
- Modify: `apps/api/src/lib/trash-guides/__tests__/update-scheduler-uncertain.test.ts`
- Modify: `apps/api/src/routes/trash-guides/__tests__/deployment-authority-writer-locks.test.ts`
- Modify: `apps/web/src/hooks/api/__tests__/useDeploymentPreview-authority.test.tsx`
- Modify:
  `apps/web/src/features/trash-guides/components/__tests__/deployment-execution-token.test.tsx`
- Create only if UI readback is the failed boundary:
  `apps/web/src/features/trash-guides/components/__tests__/template-stats-sync-strategy.test.tsx`

**Interfaces:**

- Consumes: the frozen `TRASH-674-001` reproduction.
- Produces: one failing test at the first broken boundary and passing coverage
  for already-correct adjacent boundaries.

- [ ] **Step 1: Assert deployment strategy persistence**

  Extend the deployment authority route suite so a successful request with
  `syncStrategy: "auto"` leaves every equivalent mapping at `auto` while
  retaining the exact user, template, profile, connection generation, and
  connection state token. Assert one authorized upstream deployment and no
  strategy update when deployment fails or is uncertain.

- [ ] **Step 2: Assert frontend request and readback behavior**

  Extend `deployment-execution-token.test.tsx` to select the Auto-sync button,
  execute the deployment, and assert the mutation payload contains both the
  exact preview token and `syncStrategy: "auto"`. Extend the hook suite to
  assert successful execution invalidates all of these query surfaces:

  ```ts
  trashGuidesKeys.deployment.all
  trashGuidesKeys.templates.stats(templateId)
  TEMPLATES_QUERY_KEY
  ```

  If `TRASH-674-001` is UI-only, add a focused component test with
  `<IncognitoProvider>` that renders an `auto` mapping as the selected state and
  explains why its matching menu command is disabled.

- [ ] **Step 3: Assert update detection and scheduler handoff**

  Build an outdated template fixture whose persisted mapping is `auto`, whose
  repository commit changes from `old` to `new`, and whose
  `hasUserModifications` value is false. Assert:

  ```ts
  expect(updateCheck.templatesWithUpdates[0]).toMatchObject({
    autoSyncInstanceCount: 1,
    canAutoSync: true,
  });
  ```

  Then trigger `UpdateScheduler.triggerCheck()` and assert
  `processAutoUpdates(userId)` runs once for the owning user.

- [ ] **Step 4: Assert exact-endpoint deployment**

  Extend `template-updater-authority.test.ts` with one Radarr mapping, one
  Sonarr mapping, and an equivalent alias fixture in separate test cases. For
  each service, assert an eligible update:

  - synchronizes the template from `old` to `new`;
  - invokes the deployment executor once per distinct physical endpoint;
  - passes no client preview token into scheduler automation;
  - resolves authority again from current mappings and connection state; and
  - returns successful only after verified upstream completion.

- [ ] **Step 5: Run the focused tests before implementation**

  ```bash
  pnpm --filter @arr/shared build
  pnpm --filter @arr/api exec vitest run src/lib/trash-guides/__tests__/template-updater-authority.test.ts src/lib/trash-guides/__tests__/update-scheduler-uncertain.test.ts src/routes/trash-guides/__tests__/deployment-authority-writer-locks.test.ts
  pnpm --filter @arr/web exec vitest run src/hooks/api/__tests__/useDeploymentPreview-authority.test.tsx src/features/trash-guides/components/__tests__/deployment-execution-token.test.tsx
  ```

  Expected: exactly the test representing `TRASH-674-001` fails. If all tests
  pass, stop and reproduce the live timing, repository configuration, or UI
  cache state more faithfully; do not invent a production change.

### Task 3: Correct only the reproduced boundary

**Files:**

- Allowed deployment-persistence paths:
  `apps/api/src/lib/trash-guides/deployment-executor.ts`,
  `apps/api/src/routes/trash-guides/deployment-routes.ts`
- Allowed UI paths:
  `apps/web/src/hooks/api/useDeploymentPreview.ts`,
  `apps/web/src/features/trash-guides/components/deployment-preview-modal.tsx`,
  `apps/web/src/features/trash-guides/components/template-stats.tsx`
- Allowed scheduler paths:
  `apps/api/src/plugins/trash-update-scheduler.ts`,
  `apps/api/src/lib/trash-guides/update-scheduler.ts`,
  `apps/api/src/lib/trash-guides/template-updater.ts`

**Interfaces:**

- Consumes: the single failing contract regression.
- Produces: the smallest correction that makes the exact reproduction pass.

- [ ] **Step 1: Select one remediation path from the evidence**

  Apply only the path matching `TRASH-674-001`:

  - **Persistence path:** carry the validated deployment strategy through
    successful finalization and atomically persist it across equivalent
    mappings. Never change mapping authority after failed or uncertain writes.
  - **UI path:** invalidate the exact stats key after deployment and render the
    persisted strategy as a selected status. Keep commands disabled only while
    a mutation is pending or when selecting the already-current value.
  - **Scheduler path:** make startup/interval execution include every owning
    user with an eligible mapped template, compare the configured repository
    commit consistently, and call `processAutoUpdates` once. Preserve the
    concurrent-run guard and maintenance guard.
  - **Automation deployment path:** resolve current equivalent mappings and
    current connection authority immediately before mutation, deduplicate by
    endpoint key, and preserve failed versus uncertain results.

  If evidence shows more than one pre-existing boundary is broken, split the
  additional independent boundary into `TRASH-674-002` and a second focused
  commit in this same issue wave. Do not add unrelated TRaSH redesign work.

- [ ] **Step 2: Make the failing regression pass**

  Run the focused command from Task 2 after each coherent edit. Do not weaken
  the regression or replace exact assertions with call-count-only checks.

- [ ] **Step 3: Commit the red-green correction**

  Stage only the frozen file set and its tests:

  ```bash
  git diff --check
  git diff --stat
  git commit -m "fix(trash): honor automatic deployment strategy"
  ```

### Task 4: Run the Auto Sync behavior matrix

**Files:**

- Modify: `apps/api/src/lib/trash-guides/__tests__/template-updater-authority.test.ts`
- Modify: `apps/api/src/lib/trash-guides/__tests__/update-scheduler-uncertain.test.ts`
- Modify when directly affected:
  `apps/api/src/lib/trash-guides/__tests__/deployment-operation-gate.test.ts`
- Modify when directly affected:
  `apps/api/src/lib/trash-guides/__tests__/maintenance-gate.test.ts`

**Interfaces:**

- Consumes: corrected Auto Sync boundary.
- Produces: regression proof for eligibility, safety, retries, aliases, and
  non-auto strategies.

- [ ] **Step 1: Cover positive and negative strategies**

  Add parameterized assertions for:

  | Mapping state | Template state | Expected scheduler behavior |
  | --- | --- | --- |
  | `auto` | newer commit, unmodified | one exact-endpoint deployment |
  | `manual` | newer commit | no deployment and no automatic mutation |
  | `notify` | newer commit | pending/notification evidence, no deployment |
  | `auto` | same commit | no sync and no deployment |
  | `auto` | user modifications | skip with actionable attention state |
  | `auto` | CF-group approval required | skip with approval state |
  | `auto` | disabled instance | no upstream mutation |

- [ ] **Step 2: Cover identity and concurrency**

  Prove equivalent service aliases produce one physical write, conflicting
  aliases fail closed, stale connection mappings fail closed, and concurrent
  scheduler invocations cannot overlap on the same endpoint.

- [ ] **Step 3: Cover partial, uncertain, and retry behavior**

  Prove that:

  - a verified success advances mapping/history state once;
  - a definite failure remains failed and retryable;
  - an uncertain write is not reported as success and creates the existing
    review notification;
  - restarting after an uncertain operation cannot blindly repeat the write;
    and
  - a second scheduler tick with no new repository commit performs no write.

- [ ] **Step 4: Keep explicit schedules independent**

  Run the `sync-scheduler-uncertain.test.ts` suite. Assert that changing
  deployment Auto Sync does not create, alter, or execute a
  `TrashSyncSchedule`, and that `autoApply: false` remains non-mutating for the
  explicit schedule feature.

- [ ] **Step 5: Run the complete focused matrix**

  ```bash
  pnpm --filter @arr/shared build
  pnpm --filter @arr/api exec vitest run src/lib/trash-guides/__tests__/template-updater-authority.test.ts src/lib/trash-guides/__tests__/update-scheduler-uncertain.test.ts src/lib/trash-guides/__tests__/sync-scheduler-uncertain.test.ts src/lib/trash-guides/__tests__/deployment-operation-gate.test.ts src/lib/trash-guides/__tests__/maintenance-gate.test.ts src/routes/trash-guides/__tests__/deployment-authority-writer-locks.test.ts
  pnpm --filter @arr/web exec vitest run src/hooks/api/__tests__/useDeploymentPreview-authority.test.tsx src/features/trash-guides/components/__tests__/deployment-execution-token.test.tsx
  ```

### Task 5: Verify the real lifecycle against disposable ARR instances

**Files:**

- No production files change.
- Store only sanitized evidence in the pull request.

**Interfaces:**

- Consumes: candidate API/web image, disposable Radarr and Sonarr, controlled
  TRaSH repository/cache fixture, SQLite, and PostgreSQL.
- Produces: observable persistence, UI, scheduler, mutation, restart, and
  idempotency evidence.

- [ ] **Step 1: Run the Radarr lifecycle on SQLite**

  Deploy a cloned quality profile with Auto Sync. Reload the browser and verify
  the strategy status. Advance the controlled TRaSH commit with one benign score
  change, trigger the same global scheduler path used in production, and verify
  the exact mapped Radarr profile changes once. Confirm mapping identity,
  deployment history, scheduler statistics, and notification state.

- [ ] **Step 2: Run the Sonarr lifecycle on PostgreSQL**

  Repeat the same scenario with a disposable Sonarr instance and PostgreSQL.
  Use an episode-capable quality profile, but keep the mutation limited to
  quality-profile configuration rather than media files.

- [ ] **Step 3: Verify restart and repeat behavior**

  Restart the candidate after the successful update. Confirm the startup
  scheduler runs, sees the current commit, and performs no duplicate ARR write.
  Then advance the controlled commit again and confirm one new write.

- [ ] **Step 4: Verify manual, notify, and guarded states live**

  Change the disposable mapping to Manual and then Notify Only. Advance the
  controlled commit for each state and confirm zero ARR writes. Re-enable Auto,
  introduce a user modification or approval-required CF group, and confirm the
  scheduler reports the block without mutation.

- [ ] **Step 5: Compare production configuration read-only**

  Against the user's production Radarr and Sonarr, inspect only service version,
  scheduler status, and sanitized mapping eligibility. Do not trigger a
  deployment or alter repository state.

### Task 6: Apply the bounded review and release gates

**Files:**

- Update API route documentation only if the correction changes a route
  contract. Do not add documentation churn otherwise.

**Interfaces:**

- Consumes: frozen diff, finding ledger, focused tests, and live evidence.
- Produces: one merge-ready TRaSH-only pull request.

- [ ] **Step 1: Run one regression discovery pass**

  Delegate the complete frozen diff to `regression_reviewer`. Record findings
  as `TRASH-674-NNN`, triage all of them before editing, and reject findings
  outside the frozen contract as follow-up candidates.

- [ ] **Step 2: Run one data-safety discovery pass**

  Delegate independently to `data_safety_reviewer` because Auto Sync writes to
  Radarr and Sonarr. Require review of execution-time ownership, endpoint
  deduplication, preview independence, partial results, uncertainty, and retry
  behavior.

- [ ] **Step 3: Address accepted findings in one remediation batch**

  Add red tests for accepted blockers, apply one coherent correction batch, and
  request targeted closure against finding IDs and changed lines. Do not ask
  either critic to rediscover the entire pull request.

- [ ] **Step 4: Run the repository gauntlet**

  ```bash
  pnpm run format
  pnpm run typecheck
  pnpm run test
  pnpm run lint
  pnpm run build
  ```

  Expected: every branch-caused gate passes. Any inherited base failure is
  reproduced on `origin/main` and reported without suppressing it.

- [ ] **Step 5: Open the focused pull request**

  Use `Related to #674` until both the Radarr and Sonarr live lifecycles pass.
  The pull-request body must include the contract, `TRASH-674-NNN` ledger,
  focused and full validation, sanitized live evidence, risks, and the separate
  `next` action.

- [ ] **Step 6: Request one hosted review**

  Triage the complete hosted result before editing. Address accepted findings
  in one batch and close them with targeted review. Request a second full
  hosted review only if the correction materially changes scheduler
  architecture or the upstream mutation boundary. A third full review becomes
  a new scoped wave.

- [ ] **Step 7: Merge and verify `:dev`**

  Squash-merge only after required checks, assigned critics, hosted review, and
  both live lifecycles are green. Wait for the development-image workflow at
  the merge commit and smoke-test that image before using a humanized response
  on #674.

- [ ] **Step 8: Assess `next` separately**

  Reproduce all five boundaries on `next`. If affected, forward-port the
  focused stable commit in a separate branch and pull request; do not merge
  `main` wholesale.
