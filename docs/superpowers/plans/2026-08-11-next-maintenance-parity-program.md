# Next Maintenance Parity Program

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `next` to semantic parity with every applicable stable 2.x
maintenance, data-safety, provider-cache, Plex, and TRaSH correction without
merging `main` wholesale or reintroducing behavior intentionally removed from
3.0.

**Architecture:** Treat parity as an ordered program of independently
reviewable pull requests. First install the project Codex controls on `next`,
then port Library Cleanup and provider evidence in dependency order, add the
live validation harness, and finally port the TRaSH deployment safety stack.
Each wave adapts behavior to 3.0's unified rule engine, Composer, and explicit
Tracearr/Tautulli provider choice rather than cherry-picking stable files
blindly.

**Tech Stack:** TypeScript, Fastify 5, Prisma, Next.js 16, React 19, Vitest,
Playwright, Docker Compose, SQLite, PostgreSQL, Sonarr, Radarr, Plex, Jellyfin,
Emby, qUI, GitHub Actions, and Codex project skills.

## Global Constraints

- `main` remains stable 2.x; semantic forward-ports target `next` on dedicated
  branches and pull requests. A newly reproduced cross-line safety defect is
  fixed on `main` first, then forward-ported separately to `next`.
- Never merge `main` into `next`. Port the verified behavior and tests, then
  adapt them to 3.0 architecture.
- Tracearr is the recommended/default historical analytics provider and
  Tautulli is a supported alternative. Preserve existing Tautulli state,
  restore it through the dedicated bounded plan, and never mix provider data
  or silently fail over.
- Keep 2.x version, changelog, README, Docker tag, and release metadata on
  `main`.
- Prisma clients are regenerated from the resulting `next` schema. Generated
  files are never copied from stable commits.
- Every mutation-adjacent wave uses red/green tests, one independent
  `data_safety_reviewer` discovery pass, one `regression_reviewer` pass, one
  correction batch, and targeted closure review.
- Run one whole-PR hosted Codex review on the frozen candidate. A newly found
  concern becomes follow-up work unless it proves the current wave unsafe or
  invalid.
- Automatic TRaSH deployment must not be enabled from an intermediate state
  that has durable recovery but lacks reviewed-preview execution authority.
- Production services are read-only evidence sources. Upstream mutation tests
  use disposable fixtures.
- Every PR runs changed-surface tests plus `pnpm run format`, shared build when
  applicable, root typecheck, root test, root lint, and build when required by
  `AGENTS.md`.

---

## Audited Commit Ledger

The audit compared all 47 commits unique to `main` against `origin/next` at
`60749495`. Patch identity was supporting evidence only; classifications were
confirmed from the live source paths and 3.0 architecture.

### Already equivalent or intentionally adapted

| Stable work | `next` evidence | Disposition |
| --- | --- | --- |
| #582, #583, #597, #598, #547, #603, #605, #607, #611 | #581, #584, #609, #610 and current workflow/schema-sync contracts | No port |
| #600 reverse-proxy Basic Auth | #599 plus Wave 4B | Port the supported Tautulli behavior into the restored 3.0 client |
| #601 new-library notifications | #575 notification correction and current scheduler/executor | No port |
| #604 flat Sonarr ratings | #608 | No port |
| #612 torrent-file allowlist | #613 | No port |
| #629 and #634 shared-media coordination | #633 and #635 | No port |
| #636 null Plex player token | #637 | No port |
| #638 bodyless POST | #639 | No port |
| #640 Pulse cleanup links | #641 | No port |
| #642 approval history | #643 | No port |
| #644 Seerr attention | #645 | No port |
| #646 qUI webhook registration | #647 | No port |
| #651, #648, #653 OIDC/External URL/Authentik | #652, #649, #654 | No port |
| v2.22.0 and v2.23.0 release commits | Stable-line metadata | Never port |

### Required parity work

| Stable work | Required 3.0 outcome | Wave |
| --- | --- | --- |
| #628 | Codex-native `AGENTS.md`, project skills, and independent reviewers | 0 |
| #656, #658 | Radarr retained-variant and Sonarr shared-Plex ownership proof at mutation time | 1 |
| #661 | Episode-scoped Sonarr cleanup, exact episode files, cache evidence, qUI, API, and UI | 2 |
| #668, #671 | Durable policy evidence, selection plan, audit, leases, rescan recovery, IMDb regression | 3 |
| #670 | Provider connection generations, guarded cache publication, actionable Jellyfin failures | 4 |
| #685 | Plex 1.43-compatible history sorting without weakening completeness checks | 5 |
| #688 | Fresh Plex/Jellyfin watch evidence before selection and execution | 5 |
| #693 | Current-library inventory, stale-history filtering, and final mutation-time Plex proof | 5 |
| #669, #691 | Signed browser policy gate and deterministic disposable cleanup harness | 6 |
| #676-#678 | Durable TRaSH state, ownership, backup schema, and exact upstream state capture | 7 |
| #679 | Durable partial/uncertain recovery, restart reconciliation, and honest notifications | 8 |
| #680 | Execution tokens, current authority, writer locks, and preview/execution binding | 9 |
| #681-#682 | Exact cloned-profile target and score/alias recovery | 10 |
| #686 | Execution-time disabled-target and equivalent-alias enforcement | 11 |
| #687 | Complete incognito masking of deployment plans and diagnostics | 12 |

### Additional `next` baseline debt discovered

| Existing `next` debt | Required outcome | Wave |
| --- | --- | --- |
| Four OIDC files introduced by #649/#652 fail the root Biome formatter | Restore a clean formatting baseline in a dedicated mechanical-only PR | -1 |
| Prior beta Tautulli removal governance | Supersede ADR-0007, stop startup deletion, and replace the blocking wizard with non-blocking notices | 4A |
| Stable Tautulli integration surface | Restore typed client, guarded cache, scheduler, routes, setup, Pulse, and rules on 3.0 primitives | 4B |
| Tracearr/Tautulli provider choice | Persist deterministic selection; Tracearr recommended, Tautulli alternative; no mixing or failover | 4C |
| #689 durable upstream server identity is not represented by connection fingerprints alone | Persist and verify provider-returned Plex/Jellyfin/Emby and provable Tautulli-associated Plex identity before cache publication, cleanup evidence use, or mutation; add an explicit reviewed server-replacement path | 4D |
| #674's exact auto-sync-never-runs scenario remains unresolved; #686 proves only disabled-target safety | Make global update-driven auto-sync and per-link schedules observable, restart-safe, and exactly-once under deterministic SQLite/PostgreSQL fixtures | 11A |

### Open bug closure map

| Open issue | Program ownership | Required closure evidence |
| --- | --- | --- |
| #673 and #675 Plex HTTP 400 / degraded general cache | Wave 5 (#685, #693) | Plex 1.43-compatible movie/show and episode refreshes, plus the reported history-only-row case where current-library totals agree but the old generation was still rejected as incomplete |
| #674 TRaSH auto-sync never runs | Waves 7-11, with #686 as partial evidence only | Reproduce or otherwise identify the exact scheduler path, verify a saved enabled target receives one current update, and separately retain disabled/re-enabled mutation safety; #686 alone does not close the reported scenario |
| #689 wrong upstream behind a stable proxy | Wave 4D | Stable wrong-server proxy, between-read identity change, safe existing-instance enrollment, intentional replacement, and normal reverse-proxy coverage |

---

### Task 1: Establish and freeze the `next` baseline

**Files:**

- Verify: repository at `origin/next`
- Create: this program document

**Interfaces:**

- Consumes: `origin/main`, `origin/next`, the 47-commit audit, and open PR/issue
  state.
- Produces: a clean baseline and immutable parity ledger.

- [x] **Step 1: Fetch and identify branch topology**

  Run:

  ```bash
  git fetch origin main next
  git merge-base origin/main origin/next
  git rev-list --left-right --count origin/next...origin/main
  git cherry -v origin/next origin/main
  ```

  Recorded baseline: merge base `18f3e900`; 85 `next`-only commits and 47
  `main`-only commits.

- [x] **Step 2: Audit semantic equivalents**

  Inspect every main-only commit against current `next` source, paired PRs, and
  3.0 ADRs. Record adaptations instead of treating a changed patch ID as
  missing behavior.

- [x] **Step 3: Verify the untouched test baseline**

  Run from a new worktree based on `origin/next`:

  ```bash
  pnpm install --frozen-lockfile
  pnpm run test
  ```

  Expected: all runnable baseline tests pass before any parity change.

- [x] **Step 4: Record pre-existing gauntlet failures**

  `pnpm run format` fails on four unchanged OIDC files at `origin/next`
  (`60749495`). The parity worktree has no source diff for those files, so this
  is tracked as Wave -1 rather than being hidden inside the workflow PR.

### Task 2: Wave -1 - Restore the formatting baseline

**Files:**

- Format: `apps/api/src/routes/__tests__/auth-oidc.test.ts`
- Format: `apps/api/src/routes/__tests__/oidc-providers.test.ts`
- Format: `apps/api/src/routes/oidc-providers.ts`
- Format: `apps/web/src/features/settings/components/oidc-provider-section.tsx`

**Interfaces:**

- Consumes: the exact unchanged files already present on `origin/next`.
- Produces: a mechanical-only prerequisite PR with no behavior change.

- [x] **Step 1: Apply only the repository formatter's exact output**

  Start a dedicated branch from `origin/next` and run Biome with `--write` on
  only the four named files. Reject any unrelated diff.

- [x] **Step 2: Prove the baseline is restored**

  Run the focused OIDC tests and the complete repository gauntlet. Confirm the
  final diff contains formatting changes only.

- [x] **Step 3: Publish the prerequisite**

  Commit, push, and open a focused PR against `next` after explicit publication
  authorization. Merge it before freezing the Wave 0 candidate.

### Task 3: Wave 0 - Codex workflow parity

**Files:**

- Modify: `.gitignore`
- Create: `AGENTS.md`
- Create: `.agents/skills/arr-fix-issue/**`
- Create: `.agents/skills/arr-integration-change/**`
- Create: `.agents/skills/arr-prepare-pr/**`
- Create: `.agents/skills/arr-release/**`
- Create: `.agents/skills/arr-review-change/**`
- Create: `.agents/skills/arr-validate/**`
- Create: `.codex/agents/data-safety-reviewer.toml`
- Create: `.codex/agents/regression-reviewer.toml`
- Create: `docs/ENGINEERING.md`
- Modify: this program document only if audit evidence changes

**Interfaces:**

- Consumes: the approved Codex-native guidance on stable plus 3.0's actual
  architecture in `CLAUDE.md`.
- Produces: branch discipline, validation commands, mutation invariants, and
  discoverable project workflows plus a public engineering entry point for
  every later `next` worktree.

- [x] **Step 1: Port current Codex-native controls**

  Track only the project-owned `.agents/skills/` subtree, then add
  `AGENTS.md`, `.agents/skills/`, `.codex/agents/`, and
  `docs/ENGINEERING.md`. Keep all other `.agents/` artifacts ignored. Do not
  import `.claude/` compatibility files as canonical workflow and do not
  overwrite 3.0's `CLAUDE.md`.

- [x] **Step 2: Make handover loading conditional**

  State that `HANDOVER.md` is optional machine state and is read only when a
  task depends on local services, checkout history, or machine integration.

- [x] **Step 3: Verify workflow paths and privacy**

  Run:

  ```bash
  find .agents .codex/agents -type f -print | sort
  rg -n '/home/|/Users/|token|password|private.*url' AGENTS.md .agents .codex/agents docs/ENGINEERING.md
  git diff --check origin/next...HEAD
  ```

  Expected: all referenced skills/reviewers exist and no private machine path,
  endpoint, credential, or secret enters tracked files.

- [x] **Step 4: Validate and open the focused governance PR**

  Run the project gauntlet. Open one documentation/workflow PR against `next`;
  do not mix runtime forward-port code into it.

### Task 4: Waves 1-6 - Library Cleanup and provider evidence

**Files:**

- Wave-specific plans must list exact paths after rebasing on the preceding
  merged wave; expected domains are `apps/api/src/lib/library-cleanup/`,
  `apps/api/src/lib/plex/`, `apps/api/src/lib/jellyfin/`, provider schedulers and
  routes, Prisma schema, shared cleanup types, cleanup UI, and
  `e2e/library-cleanup/`.

**Interfaces:**

- Consumes: the current unified-rule adapter and Tautulli migration contract.
- Produces: stable-equivalent mutation authority while preserving 3.0 rule
  parity and Tracearr/Tautulli decisions.

- [x] **Step 1: Port retained-variant safety (#656, #658)**

  Start with failing Radarr and Sonarr shared-library collision regressions.
  Implement canonical peer proofs and execution-time revalidation, then run
  focused shared-Plex suites and independent data-safety review.

- [ ] **Step 2: Port episode-scoped cleanup (#661)**

  Write a separate code-level plan covering schema, Plex episode cache,
  Sonarr episode identity, per-episode versus per-series mutation, qUI
  correlation, routes, shared types, and UI. Preserve unified-rule parity.

  Completed on the frozen Wave 2 candidate at `201d1491`; exact episode
  identity, Plex/qUI proof, API/UI authoring, retry behavior, independent
  safety/regression review, and the complete repository gauntlet are green.

- [x] **Step 3: Port policy and recovery foundation (#668, #671)**

  Added durable policy evidence, selection planning, audit events, run leases,
  media-server rescan jobs, retry/idempotency, and IMDb-rating coverage behind
  the unified cleanup adapter. This was completed before the provider-choice
  decision; Tautulli evidence is restored only through Waves 4A-4D.

  Execute this as three bounded, stacked review units: Wave 3A policy evidence,
  recursive rule persistence, IMDb provenance, and deterministic selection;
  Wave 3B append-only audit/activity; Wave 3C durable post-delete media-server
  rescan and independent recovery. See
  `2026-08-12-next-cleanup-policy-recovery-parity.md`.

- [x] **Step 4: Port provider cache correctness (#670)**

  Add connection generations, guarded status/publication writes, Jellyfin
  single-flight refreshes, and actionable Pulse retries for Plex, Jellyfin, and
  Emby. Completed before the provider-choice decision and reused by the
  restoration waves.

- [ ] **Step 4A: Preserve Tautulli and reverse removal governance**

  Supersede ADR-0007, remove the startup mutation and deletion endpoint, retain
  migration reports only as audit evidence, and replace the blocking wizard
  with user-scoped non-blocking notices. Execute
  `2026-08-12-tautulli-preservation-migration.md`.

- [ ] **Step 4B: Restore the Tautulli runtime**

  Restore the typed client, guarded cache publication, scheduling, routes,
  setup, Pulse, and unified-rule evidence on the current 3.0 primitives.
  Tautulli without proven Plex identity remains analytics-only. Execute
  `2026-08-12-tautulli-runtime-restoration.md`.

- [ ] **Step 4C: Add deterministic analytics-provider selection**

  Make Tracearr recommended/default and Tautulli an explicit alternative.
  Preserve Tautulli-only upgrades, default both-configured upgrades to
  Tracearr, and prohibit mixing or silent runtime failover. Native media-server
  sessions remain independent. Execute
  `2026-08-12-analytics-provider-selection.md`.

- [ ] **Step 4D: Bind evidence to durable upstream identity (#689)**

  Extend the provider-generation contract with the immutable identity returned
  by Plex, Jellyfin, or Emby, and with associated Plex identity only where
  Tautulli can prove it unambiguously. Existing instances require explicit safe
  enrollment, and intentional replacement requires a reviewed transition; a
  matching URL, credential fingerprint, or two matching reads is not sufficient
  evidence of server identity. Execute
  `2026-08-12-durable-upstream-identity.md`.

- [ ] **Step 5: Port Plex evidence correctness (#685, #688, #693)**

  Apply compatible single-key history sorting, then fresh Plex/Jellyfin watch
  evidence, then current-library filtering and final target/inventory proof.
  Regression coverage must include stale watched-history rows, pagination
  churn, duplicate editions, same-title collisions, changed ARR state, and
  lower-priority Plex rules.

- [ ] **Step 6: Port validation infrastructure (#669, #691)**

  Add the signed browser-policy gate first, then deterministic Compose
  ownership guards and ARR/Plex/qUI bootstrap. Validate that the harness cannot
  target an unrelated Compose project or live service.

### Task 5: Waves 7-12 - TRaSH deployment safety

**Files:**

- Wave-specific plans must list exact paths after the Cleanup/provider stack is
  merged; expected domains are `apps/api/src/lib/trash-guides/`, TRaSH routes,
  schedulers, Prisma schema, backup/notification integration, shared types,
  frontend hooks/components, and `docs/API-ROUTES.md`.

**Interfaces:**

- Consumes: current 3.0 Composer and TRaSH deployment flows.
- Produces: durable, authority-bound, privacy-safe deployment and recovery
  without weakening Composer registry validation.

- [ ] **Step 1: Port state and ownership foundation (#676-#678)**

  Add nullable/defaulted schema fields, exact endpoint identity, backup version
  parsing, active ownership, legacy rebinding, operation gates, and captured
  custom-format/profile/naming state. Legacy state without proof fails closed.

- [ ] **Step 2: Port durable recovery (#679)**

  Persist partial and uncertain results, startup recovery, retry progress, and
  `TRASH_DEPLOY_UNCERTAIN` metadata while preserving 3.0's
  `AUTOMATION_RULE_MATCHED` registry contract.

- [ ] **Step 3: Port execution authority (#680)**

  Bind preview to execution with 64-character tokens, current connection and
  target identity, writer locks, stale-token rejection, and current-state
  revalidation. Resolve Composer serialization explicitly before enabling
  automatic deployment.

- [ ] **Step 4: Port profile recovery (#681-#682)**

  Preserve exact cloned source targets, negative and instance-only scores,
  equivalent aliases, and same-title profiles without duplicate or wrong-target
  writes.

- [ ] **Step 5: Port disabled auto-sync enforcement (#686)**

  Re-read service enabled state and authority at execution time; skip disabled
  instances, aliases, and unresolved recovery states, then apply pending work
  exactly once after safe re-enable.

- [ ] **Step 5A: Resolve the exact auto-sync scheduler report (#674)**

  Test global update-driven auto-sync and per-link schedules as separate
  products. Persist or surface startup, revision-detection, cache, validation,
  and deployment failures; prove one saved enabled mapping consumes one new
  upstream revision exactly once across restart. If the defect reproduces on
  stable, fix `main` first and forward-port the verified outcome separately.

- [ ] **Step 6: Port deployment-plan privacy (#687)**

  Mask custom-format names, conflicts, naming fields, orphaned formats,
  instance labels, and embedded diagnostics under incognito mode without
  changing execution authority or the underlying plan.

### Task 6: Close parity and clean the working queue

**Files:**

- Update: this ledger as each wave merges
- Review: open PRs #692, #684, #595, and #592

**Interfaces:**

- Consumes: every merged parity PR and current GitHub issue/PR state.
- Produces: zero unclassified main-only maintenance behavior and a deliberate
  disposition for stale drafts and provider-choice work.

- [ ] **Step 1: Re-run the semantic audit**

  Repeat the commit ledger against the final `next`. Every applicable stable
  outcome must point to a merged `next` commit and regression evidence; release
  metadata remains explicitly excluded; restored Tautulli behavior must point
  to the bounded 3.0 implementation and regression evidence.

- [ ] **Step 2: Run the complete 3.0 gauntlet**

  Run formatting, shared build, root typecheck, full tests, lint, production
  build, SQLite/PostgreSQL smoke tests, Docker build, and the disposable cleanup
  and TRaSH mutation scenarios.

- [ ] **Step 3: Resolve stale draft PRs deliberately**

  Rebase and finish only still-valid focused changes. Extract useful behavior
  from superseded plans, then close stale branches without merging obsolete
  implementation. Do not delete local worktrees or branches without separate
  explicit authorization.

- [ ] **Step 4: Declare the clean restart point**

  Record the final `next` commit, merged PR list, open follow-up issues, and
  validation evidence. Resume 3.0 feature work only after no required parity
  item remains unowned.

## Program Exit Gate

- All 47 original `main`-only commits have a recorded disposition.
- All required maintenance outcomes have semantic `next` equivalents, including
  the approved Tracearr-primary/Tautulli-alternative provider model.
- Issue #689 has a reviewed `next` implementation with safe existing-instance
  enrollment, intentional replacement, reverse-proxy mismatch, and
  mutation-boundary coverage.
- Issue #674's reported enabled auto-sync path is represented by deterministic
  SQLite and PostgreSQL scenarios and either fixed or closed with concrete
  evidence; #686 alone is not accepted as closure.
- No known P0/P1 or in-scope P2 data-safety finding remains open.
- The full 3.0 gauntlet, database smoke checks, Docker checks, and disposable
  mutation scenarios pass on the final exact head.
- Open draft PRs have an explicit merge, rebase, extract-and-close, or retain
  decision.
- `next` is ready for new 3.0 work without hidden stable forward-port debt.
