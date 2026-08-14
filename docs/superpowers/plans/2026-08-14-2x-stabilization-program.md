# 2.x Stabilization Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a bounded final 2.x stabilization release, prove every stable blocker has an explicit 3.0 parity disposition, and return active development to `next`.

**Architecture:** Treat the program as a sequence of independent issue plans rather than one implementation branch. A tracked ledger is the only cross-issue artifact; each code fix uses a fresh branch from its intended base, one frozen review inventory, and a separate semantic forward-port.

**Tech Stack:** Git/GitHub, pnpm/Turborepo, TypeScript, Fastify, Next.js/React, Vitest, Playwright, Prisma, Docker, SQLite, PostgreSQL.

## Global Constraints

- `main` accepts confirmed 2.x regressions and safety fixes; `next` receives separate semantic forward-ports.
- Never merge `main` wholesale into `next`.
- Every issue fix starts from the current remote base in a clean worktree and includes a reporter-faithful regression test where practical.
- Deletion, cache publication, upstream identity, and upstream mutation changes require an independent `data_safety_reviewer` pass.
- Substantial data-dependent changes require a separate `regression_reviewer` pass.
- Review each coherent issue diff once, freeze accepted findings, and use one correction batch; later observations become follow-up unless they invalidate safety or correctness.
- Use the layered development loop for every issue: focused RED/GREEN tests,
  affected-path integration checks, one coherent independent review and
  correction batch, then one full gauntlet at the PR boundary. Repeat the full
  gate only when the final diff, base, or release candidate changes materially.
- Run GitHub issue replies through the `humanizer` skill and never `@`-mention users.
- Do not close an issue without reproduced-and-verified behavior. Do not publish a release from an unreviewed SHA.
- Preserve the existing cleanup Wave 3A, 3B, and 3C worktrees and all user-owned primary-checkout edits.

---

### Task 1: Establish the stabilization and parity ledger

**Files:**
- Create: `docs/maintenance/2x-stabilization-ledger.md`

**Interfaces:**
- Consumes: GitHub issues `#706`, `#703`, `#694`, `#689`, `#675`, `#674`, `#673`, and `#427`; merged `main` PRs after `v2.23.0`; `docs/RELEASING.md`.
- Produces: one row per issue and post-`v2.23.0` stable PR with stable status, stable evidence, parity classification, `next` evidence, release bucket, and disposition.

- [ ] **Step 1: Create the ledger schema and frozen issue rows**

  Use these exact columns:

  ```markdown
  | Stable issue/PR | Stable status | Stable evidence | 3.0 parity | `next` PR/evidence | Release bucket | Disposition |
  |---|---|---|---|---|---|---|
  ```

  Seed confirmed-investigation rows for `#706`, `#703`, `#694`, and `#689`;
  verification rows for `#675`, `#674`, `#673`, and `#427`; and excluded
  enhancement rows for `#664`, `#632`, `#627`, `#624`, `#623`, `#622`, and
  `#487`.

- [ ] **Step 2: Inventory the stable commit range**

  Run:

  ```bash
  git log --first-parent --oneline v2.23.0..origin/main
  gh pr list --repo Kha-kis/arr-dashboard --state merged \
    --search "base:main merged:>=2026-07-23" --limit 100 \
    --json number,title,mergedAt,labels,url
  ```

  Add one ledger row per merged PR. Record `required`, `already equivalent`, or
  `not applicable`; do not infer parity from matching commit subjects alone.

- [ ] **Step 3: Audit release labels**

  Record PRs missing exactly one `release:*` label. This step is read-only;
  applying labels occurs only after reviewing the proposed classification.

- [ ] **Step 4: Validate and commit the ledger**

  Run:

  ```bash
  git diff --check
  ! rg -n "[T]BD|[T]ODO" docs/maintenance/2x-stabilization-ledger.md
  ```

  Every unresolved row must say what evidence or action resolves it rather than
  contain a placeholder.

  Commit:

  ```bash
  git add docs/maintenance/2x-stabilization-ledger.md
  git commit -m "docs: track final 2.x stabilization parity"
  ```

### Task 2: Fix and forward-port issue #706

**Files:**
- Plan: `docs/superpowers/plans/2026-08-14-issue-706-selected-sonarr-approval.md`
- Stable implementation branch: `codex/fix-706-selected-sonarr-main`
- 3.0 implementation branch: `codex/fix-706-selected-sonarr-next`

**Interfaces:**
- Consumes: `ApproveWithOptionsDialog` and the existing Seerr approval mutation contract.
- Produces: the selected non-default Seerr Sonarr server, profile, and root-folder overrides reach the existing API route on both release lines.

- [ ] **Step 1: Execute the dedicated #706 plan on current `origin/main`**

  Follow `2026-08-14-issue-706-selected-sonarr-approval.md` through RED,
  minimal correction, focused integration checks, one task review and
  correction batch, the root gauntlet, and user-visible component verification
  where it adds evidence.

- [ ] **Step 2: Publish the focused stable PR**

  Use `Related to #706` until the exact two-server scenario is verified. Apply
  one reviewed release bucket. Merge only after required checks and review are
  green.

- [ ] **Step 3: Forward-port from current `origin/next`**

  Reproduce the same failing component test on `next`, make the native minimal
  correction, run the same focused test plus the `next` gauntlet, and open a
  separate PR. Record both PRs and exact test evidence in the ledger.

### Task 3: Fix and forward-port issue #703

**Files:**
- Modify: `apps/web/src/features/rule-criteria/components/condition-params-fields.tsx`
- Test: `apps/web/src/features/library-cleanup/components/__tests__/cleanup-rule-dialog.test.tsx`
- Stable implementation branch: `codex/fix-703-jellyfin-composite-main`
- 3.0 implementation branch: `codex/fix-703-jellyfin-composite-next`

**Interfaces:**
- Consumes: existing Jellyfin cleanup schemas, field metadata, and the single-condition Jellyfin controls.
- Produces: composite conditions for `jellyfin_last_watched`, `jellyfin_watch_count`, `jellyfin_user_rating`, `jellyfin_watched_by`, `jellyfin_added_at`, and `jellyfin_episode_completion` render their valid operators and parameter controls; `jellyfin_on_deck` remains boolean.

- [ ] **Step 1: Write the stable regression test**

  Extend the cleanup dialog test to enter Composite Rule mode, add a condition,
  select `jellyfin_last_watched`, and assert that the `Operator` select exposes
  the operator set required by the shared schema. Add a separate assertion that
  `jellyfin_on_deck` renders its boolean control without an operator select.

- [ ] **Step 2: Run the test and observe RED**

  Run the exact test file with the web Vitest command. Expected result: the
  operator assertion fails because `ConditionParamsFields` currently returns
  `null` for Jellyfin kinds.

- [ ] **Step 3: Add Jellyfin composite rendering**

  Add explicit Jellyfin defaults and cases to `ConditionParamsFields`, reusing
  the established Plex-shaped controls where the shared schemas are aliases.
  Do not alter the API metadata or shared schemas.

- [ ] **Step 4: Validate, review, and publish the stable PR**

  Run the focused web tests followed by format, root typecheck, tests, lint,
  and build. Live-verify the composite dialog with populated Jellyfin field
  metadata. Use one regression review and one correction batch.

- [ ] **Step 5: Forward-port and record parity**

  Repeat the RED test on current `origin/next`, adapt only for the native 3.0
  dialog structure, run the `next` gauntlet, and record both PRs in the ledger.

### Task 4: Resolve the issue #694 evidence gate

**Files:**
- No source edit is authorized by the current evidence.
- Diagnostic artifacts must remain outside the repository or in an ignored, owner-only test directory.

**Interfaces:**
- Consumes: the reporter's attached runtime log, heap-monitor samples, container exit metadata, and cache-refresh implementation.
- Produces: either a reproducible memory defect with a dedicated implementation plan or a precise non-blocking request for missing evidence.

- [ ] **Step 1: Preserve the evidence-led diagnosis**

  Record that the supplied log shows repeated 544-to-578 MB heap increases
  after clustered Plex/Emby/Jellyfin cache refreshes, low external/array-buffer
  usage, and no captured fatal OOM or shutdown. Do not classify allocator
  fragmentation or a specific retained object as root cause.

- [ ] **Step 2: Request the minimum missing evidence**

  Draft and humanize a concise issue response requesting the complete log
  through failure, container exit status and `OOMKilled`, the final heap sample,
  memory limit, effective `NODE_OPTIONS`, `HEAP_AUTO_SNAPSHOT`,
  `MALLOC_ARENA_MAX`, an available heap snapshot, and approximate library/cache
  sizes. Post only after the wording is reviewed against the issue.

- [ ] **Step 3: Run a bounded disposable reproduction in parallel**

  Exercise clustered startup refreshes with large synthetic Plex and
  Jellyfin/Emby inventories, collect heap samples before and after each
  refresher, and prove whether memory returns after references are released.
  Do not use production media libraries or mutate upstream services.

- [ ] **Step 4: Classify the release impact**

  If the disposable fixture reproduces retained heap or the reporter supplies
  crash evidence, create a separate TDD implementation plan and keep `#694` as
  a blocker. Otherwise record it as evidence-pending and non-blocking while
  leaving the issue open.

### Task 5: Resolve issue #689 through a dedicated safety plan

**Files:**
- Plan: `docs/superpowers/plans/2026-08-14-durable-upstream-identity-stable.md`
- Stable and 3.0 files are frozen only after the provider identity audit.

**Interfaces:**
- Consumes: current Plex, Jellyfin, Emby, and Tautulli identity capabilities; service connection lifecycle; cache publication; cleanup snapshot authority.
- Produces: a stable fail-closed identity boundary and a semantically equivalent 3.0 enrollment/replacement lifecycle.

Issue `#689` is a release blocker. Current connection generations and
fingerprints detect configuration changes, but they do not detect a stable
proxy routing every read to the same wrong physical server.

- [ ] **Step 1: Freeze provider identity capabilities**

  Use Plex `MediaContainer.machineIdentifier`, Jellyfin/Emby
  `/System/Info(.Public).Id`, and Tautulli's documented
  `get_server_info.pms_identifier` or `get_servers_info.machine_identifier` as
  server-derived identities. Add the missing typed Tautulli client/schema
  support and verify that its reported identifier matches the intended Plex
  association before Tautulli evidence can authorize cleanup.

- [ ] **Step 2: Choose the stable delivery boundary**

  Persist a non-secret expected identity on the configured service, enroll only
  from a server-side upstream read, require existing instances to re-verify,
  quarantine old cache generations during a deliberate rebind, and expose only
  `verified`, `unverified`, or `mismatch` state. Until enrollment completes,
  provider-independent cleanup may continue but provider-dependent mutation and
  post-delete scans fail closed.

- [ ] **Step 3: Write and approve the dedicated safety plan**

  The plan must cover stable wrong-server proxying, identity changes between
  reads, intentional replacement, existing instances, normal reverse proxies,
  cache publication, cleanup snapshot selection, dry-run, real mutation,
  concurrency, and retry/idempotency. No code is written before this plan and
  its destructive-boundary review are complete.

- [ ] **Step 4: Implement stable first, then forward-port**

  Use TDD, a `data_safety_reviewer`, a separate `regression_reviewer`, the full
  gauntlet, and disposable provider fixtures. Record both release lines in the
  parity ledger.

### Task 6: Verify and disposition #675, #673, #674, and #427

**Files:**
- Modify: `docs/maintenance/2x-stabilization-ledger.md`

**Interfaces:**
- Consumes: merged fixes, published `:dev` SHA, reporter confirmations, logs, and bounded reproductions.
- Produces: evidence-backed close or remain-open decisions without speculative code.

- [ ] **Step 1: Verify Plex cache fixes**

  Confirm that the published `:dev` image contains PR `#693`, run both general
  and episode cache refresh against a compatible Plex fixture, and verify a
  complete current-library generation publishes without the old HTTP 400 or
  false incomplete-coverage warning.

- [ ] **Step 2: Reproduce TRaSH auto-sync once with required evidence**

  Verify persisted auto-sync strategy, scheduler registration, enabled target,
  detected template change, execution, and post-run state. If the exact
  never-runs scenario remains unreproduced and no reporter logs arrive, leave
  `#674` open and non-blocking with the existing evidence request.

- [ ] **Step 3: Reconcile the historical OOM report**

  Compare `#427` against its landed paginator, allocator, and soak fixes. Close
  only if current reporter evidence supports resolution; otherwise preserve it
  as the historical umbrella and link `#694` as the current evidence path.

- [ ] **Step 4: Update the ledger and issue responses**

  Humanize every response, cite the exact merged PR or candidate SHA, and do
  not claim inclusion in a release until the release is published.

### Task 7: Prepare and publish the stabilization release

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `DOCKERHUB.md`
- Modify: `CLAUDE.md`
- Modify: `docs/maintenance/2x-stabilization-ledger.md`
- External: wiki `Home.md` and `Troubleshooting.md`

**Interfaces:**
- Consumes: exact reviewed `main` candidate SHA, completed parity ledger, release labels, and `docs/RELEASING.md`.
- Produces: a verified stable release, registry images, health metadata, GitHub Release, and accurate issue follow-up.

- [ ] **Step 1: Audit the exact release range and version**

  Verify every PR after `v2.23.0` has one release bucket. Confirm whether the
  accumulated user-visible feature range requires `v2.24.0`; do not reuse or
  move an existing tag.

- [ ] **Step 2: Prepare release metadata on a focused branch**

  Update every repository and wiki version surface required by
  `docs/RELEASING.md`. Reconstruct the changelog from the actual commit range,
  not issue titles alone. Record the missing historical `v2.23.0` GitHub
  Release as a separate metadata repair without changing its tag.

- [ ] **Step 3: Run the complete release gauntlet**

  Run format, shared build, root typecheck, tests, lint, production build,
  SQLite/PostgreSQL fresh and upgrade checks, Docker build/start/health checks,
  PUID/PGID, fresh and upgrade volumes, authentication smoke tests,
  Sonarr/Radarr write-pattern integration, dashboard/statistics/TRaSH/backup
  smoke tests, and all CI E2E shards.

- [ ] **Step 4: Complete the bounded candidate soak**

  Publish only the reviewed candidate to `:dev`, verify its commit metadata,
  and monitor it for 24-to-48 hours. Any invalidating regression returns to its
  own focused issue branch rather than reopening every release change.

- [ ] **Step 5: Publish and verify**

  From the exact reviewed SHA, create and push an annotated tag, verify
  linux/amd64 and linux/arm64 images on Docker Hub and GHCR, verify Trivy and
  runtime `/health`, create the Latest GitHub Release, update the wiki, and
  post release-specific closure comments only on reproduced resolved issues.

### Task 8: Enter 2.x maintenance freeze and resume 3.0

**Files:**
- Modify: `docs/maintenance/2x-stabilization-ledger.md`
- Review: existing Wave 3A, 3B, and 3C plan/progress files in their preserved worktrees.

**Interfaces:**
- Consumes: published stable release, complete parity ledger, current `origin/next`, and preserved cleanup worktrees.
- Produces: a closed stabilization program and a current-base 3.0 execution sequence.

- [ ] **Step 1: Confirm every stable blocker has a 3.0 disposition**

  No row may remain `required` without a merged or active focused `next` PR.

- [ ] **Step 2: Record the maintenance freeze**

  Limit future `main` changes to security, data-loss/deletion-safety, and severe
  regressions affecting the released 2.x line.

- [ ] **Step 3: Rebase the Wave 3 delivery sequence semantically**

  Replay Wave 3A onto current `next`, then Wave 3B, then complete Wave 3C. Do
  not merge their stale stacked branches because they predate the analytics
  provider work.

- [ ] **Step 4: Run the 3.0 release-readiness audit**

  Revalidate the charter, current code, open 3.0 issues, CI, Docker preview,
  database upgrades, integration harness, and required soak before proposing a
  3.0 release.
