# Stable Maintenance Issue Gauntlet Program

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the verified TRaSH Guides and Plex cache reports on stable 2.x
without combining independent defects, repeatedly reopening full reviews, or
expanding a pull request beyond its frozen acceptance contract.

**Architecture:** Treat issue closure, Plex history compatibility, TRaSH Auto
Sync, and Library Cleanup recovery as four independent waves. Each code wave
gets one focused branch and pull request, a stable finding ledger, one discovery
pass per required critic, one closure pass, and one hosted review on the frozen
candidate.

**Tech Stack:** GitHub issues and Actions, TypeScript, Fastify, Prisma,
Vitest, Next.js, React Query, Docker Compose, Radarr, Sonarr, and Plex.

## Global Constraints

- Stable-user fixes target `main`. Reproduce on `next` after the stable fix and
  forward-port with a separate pull request when affected.
- Do not add Plex cache behavior to a TRaSH Guides pull request or TRaSH Guides
  behavior to a Plex pull request.
- Production services are read-only evidence sources. Upstream mutations run
  only against disposable Radarr, Sonarr, Plex, and database fixtures.
- P0 and P1 findings always block. P2 findings block only when they violate the
  frozen acceptance contract or were introduced by the current delta.
- Each wave receives one full hosted review and one remediation batch. A second
  full review is allowed only after a material architecture or mutation-boundary
  change. A third full review starts a new scoped wave instead of expanding the
  current pull request.
- Do not request a fresh whole-pull-request review after every correction.
  Closure reviewers inspect accepted finding IDs, their remediation delta, and
  directly affected paths.
- Use the humanizer skill for reporter-facing issue and pull-request comments.
- Use standalone `Closes #N` only after reproducing the reported scenario and
  verifying the correction against the same scenario.

---

## Scope ledger

| Wave | Reports | Frozen outcome | Pull-request boundary |
| --- | --- | --- | --- |
| A: completed-report closure | #665 and #666 | Reporters receive exact merged and `:dev` evidence; completed issues close without code changes | No code pull request |
| B: Plex history compatibility | #673 and #675 | Both cache refreshers and Library Cleanup can consume complete Plex history on the reported server while incomplete or unstable pagination still fails closed | One Plex-only `main` pull request |
| C: TRaSH Auto Sync | #674 | A deployed `auto` mapping persists, is represented honestly in the UI, detects an upstream change, and updates the exact mapped ARR profile once | One TRaSH-only `main` pull request |
| D: residual deployment-plan UI | PR #672 | The remaining deployment-plan display and incognito masking are separated from the superseded integration branch and verified without importing its replaced safety stack | One focused TRaSH UI pull request |
| E: Library Cleanup recovery | Existing RECOVERY and AUDIT gates | Real restart and fault-injection evidence verifies durable, idempotent recovery | Separate harness or focused runtime pull requests |

Issues #665 and #666 cannot add new implementation scope unless a reporter
provides a scenario that still fails on the merged `:dev` image. Such a report
receives a new finding ID and a new focused wave.

## Bounded gauntlet lifecycle

Every code wave follows these gates:

1. **Contract freeze:** Record the exact reported version, deployment,
   database, integration version, expected behavior, observed failure, and
   accepted regression scenarios.
2. **Reproduction:** Add or run a check that fails at the real boundary before
   changing production behavior.
3. **Discovery:** The implementer, regression reviewer, and data-safety reviewer
   when applicable each inspect the frozen surface once. Record findings as
   `PLEX-675-NNN`, `TRASH-674-NNN`, or `RECOVERY-NNN`.
4. **Remediation:** Address accepted findings in one coherent batch with focused
   red-green tests.
5. **Closure:** Review only unresolved finding IDs, changed lines, and directly
   affected callers. Unrelated hardening becomes a follow-up issue with
   maintainer rationale.
6. **Integration:** Run the repository gauntlet and the wave's live scenario.
7. **Hosted review:** Request one whole-pull-request review on the frozen
   candidate. Triage every result before editing, then use one remediation batch
   and targeted closure review.
8. **Release evidence:** Merge only with green required checks. Confirm the
   `:dev` image before telling reporters the correction is available.

## Task 1: Close reports already fixed by the merged stack

**Files:**

- No repository files change.
- Evidence: pull requests #681 and #682, merge commits `517605ae` and
  `d21eed0e`, and successful `main` development-image workflow `31395082514`.

**Interfaces:**

- Consumes: merged live and automated verification for renamed clone targeting
  and retained instance scores.
- Produces: closed issues #665 and #666 with accurate release guidance.

- [ ] **Step 1: Reconfirm remote evidence**

  Run:

  ```bash
  gh pr view 681 --repo Kha-kis/arr-dashboard --json state,mergedAt,mergeCommit,statusCheckRollup
  gh pr view 682 --repo Kha-kis/arr-dashboard --json state,mergedAt,mergeCommit,statusCheckRollup
  gh run view 31395082514 --repo Kha-kis/arr-dashboard --json status,conclusion,headSha,url
  ```

  Expected: both pull requests are merged and the development-image workflow
  succeeded at `d21eed0e` or a descendant.

- [ ] **Step 2: Respond to and close #665**

  Run the final response through the humanizer skill. The response must state
  that #681 preserves the exact cloned source profile even when the template is
  renamed, that the isolated Radarr verification created no duplicate profile,
  and that the correction is available on `:dev` and will be in the next stable
  release. Close the issue as completed.

- [ ] **Step 3: Respond to and close #666**

  Run the final response through the humanizer skill. The response must state
  that #682 preserves exact instance-only scores including negative values such
  as `-10000`, and that the correction is available on `:dev` and will be in the
  next stable release. Close the issue as completed.

- [ ] **Step 4: Retire the superseded integration pull request**

  Confirm #672 contains no commits absent from merged replacement pull requests
  #676 through #682. Add a concise replacement-stack comment and close #672
  without merging it only if no effective implementation remains. If unique
  behavior remains, keep #672 open, identify the exact residual paths, and
  route them to Wave D instead of importing them into Waves B or C.

## Task 2: Execute the Plex compatibility wave

**Files:**

- Plan: `docs/superpowers/plans/2026-08-10-plex-history-compatibility.md`

**Interfaces:**

- Consumes: exact HTTP 400 evidence from #673 and #675.
- Produces: one verified Plex-only stable pull request and reporter follow-up.

- [ ] **Step 1: Complete every task in the Plex plan**

  Do not begin #674 while the Plex implementation branch has unresolved
  accepted findings or red required checks.

- [ ] **Step 2: Merge and verify the development image**

  After merge, wait for the `Build and Push Dev Docker Image` workflow at the
  merge commit. Do not claim `:dev` availability from pull-request CI alone.

- [ ] **Step 3: Respond to both Plex reports**

  Explain that both reports shared the same history-sort compatibility defect,
  include the verified Plex server version and cache paths, and identify the
  release channel. Close both only after the live cache and Library Cleanup
  prefetch checks pass.

## Task 3: Execute the TRaSH Auto Sync wave

**Files:**

- Plan: `docs/superpowers/plans/2026-08-10-trash-auto-sync-674.md`

**Interfaces:**

- Consumes: #674's persisted-strategy, UI, and scheduler reproduction.
- Produces: one verified TRaSH-only stable pull request and reporter follow-up.

- [ ] **Step 1: Complete every task in the Auto Sync plan**

  Do not import Plex compatibility or Library Cleanup recovery work into this
  branch.

- [ ] **Step 2: Merge and verify the development image**

  Confirm the merged image against disposable Radarr and Sonarr before telling
  the reporter to retry.

- [ ] **Step 3: Respond to #674**

  Describe the exact reproduced failure and corrected behavior. Do not describe
  a selected-but-disabled UI control as a scheduler fix unless the live
  scheduled mutation also passed.

## Task 4: Extract the residual deployment-plan UI from #672

**Files:**

- Source evidence: PR #672 commits `983c790` and `118c32c`
- Expected paths:
  `apps/web/src/features/trash-guides/components/sync-validation-panels.tsx`
  and
  `apps/web/src/features/trash-guides/components/sync-validation-modal.tsx`

**Interfaces:**

- Consumes: the deployment-plan display and incognito masking that remain only
  on #672.
- Produces: one focused `main` pull request without the safety and recovery
  implementation already replaced by #676 through #682.

- [ ] **Step 1: Freeze the residual diff**

  Compare #672 at the two identified commits with current `main`. Record only
  behavior that is still absent. Do not cherry-pick or merge the integration
  branch wholesale.

- [ ] **Step 2: Write and approve a focused implementation plan**

  Cover deployment-plan rendering, incognito behavior, user-visible browser
  verification, focused component tests, and the bounded review budget. Keep
  this wave behind the user-reported Plex and Auto Sync bugs.

- [ ] **Step 3: Implement, verify, and retire #672**

  Merge the focused replacement only after its own gauntlet. Then update and
  close #672 unmerged with exact replacement evidence.

## Task 5: Resume Library Cleanup recovery

**Files:**

- Existing specification: `docs/library-cleanup-gauntlet.md`
- Future plan: a separately approved recovery and fault-injection plan.

**Interfaces:**

- Consumes: working Plex cache evidence from Wave B.
- Produces: live SQLite and PostgreSQL restart evidence without reopening Waves
  B or C.

- [ ] **Step 1: Refresh the Library Cleanup issue audit**

  Search all open issues and comments after Waves B and C merge. Add only
  reports that directly affect Library Cleanup behavior.

- [ ] **Step 2: Freeze the recovery matrix**

  Cover lost Radarr deletion responses, interrupted Sonarr episode and series
  operations, terminal-audit recovery, and independently retryable media scans
  on SQLite and PostgreSQL.

- [ ] **Step 3: Execute recovery as a new bounded wave**

  Production code changes require a reproduced live failure. Passing scenarios
  remain harness-and-evidence work.

## Program exit gate

The maintenance program is complete when:

- #665 and #666 are closed with accurate merged and `:dev` evidence;
- #673 and #675 pass the same cache-refresh and Library Cleanup scenarios that
  previously returned HTTP 400;
- #674 passes persistence, UI, scheduler, exact-target mutation, restart, and
  manual/notify non-regression scenarios;
- #672 has no unique implementation left and is closed unmerged after its
  deployment-plan display and incognito masking land through a focused pull
  request;
- every accepted finding ID is closed with evidence;
- no P0, P1, or in-contract/current-delta P2 remains open;
- each code wave has green focused tests, repository gauntlet, build, live
  verification, independent assigned critics, hosted review, and merge CI; and
- follow-up candidates are recorded outside the closed wave instead of silently
  expanding its pull request.
