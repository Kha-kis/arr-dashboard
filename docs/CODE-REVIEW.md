# Code review contract

## Purpose and roles

This contract makes pull request review thorough, finite, and controlled by a
human maintainer. It applies severity consistently without allowing every new
suggestion to expand a pull request.

The PR author declares the change contract: scope, non-goals, acceptance
criteria, and one risk tier. Reviewers test the implementation against that
contract and the actual base branch. Every finding must be reproduced,
classified, and dispositioned before it authorizes a code change.

Codex is an additional reviewer. It does not set final scope, replace required
human judgment, or decide whether to merge. A maintainer owns risk escalation,
material-scope declarations, review-epoch changes, finding disposition, and the
final stop or merge decision.

Reviewer satisfaction means every finding is reproduced, classified, and
dispositioned. It does not mean no future model invocation can think of another
improvement.

## Risk tiers

The PR author selects exactly one of these three tiers. A reviewer may require
escalation to a higher tier. Risk may be escalated, never silently downgraded.

### Trivial

Examples include documentation-only changes, generated formatting-only changes,
comment corrections, and narrowly mechanical metadata.

Required:

- declare scope and non-goals;
- run relevant deterministic validation;
- obtain maintainer review;
- add no mandatory agent subreview unless review discovers higher risk.

### Standard

Examples include ordinary bug fixes, normal UI or API behavior, bounded
refactors, and test-harness changes.

Required:

- declare acceptance criteria;
- run focused tests;
- perform one initial broad review;
- make one consolidated correction pass when needed;
- perform one targeted delta review;
- obtain exact-head CI;
- obtain the maintainer stop decision.

### Safety-critical

This tier includes deletion, file removal, unmonitoring, queue cleanup, restore,
schema or data migration, TRaSH deployment, provider identity or ownership,
upstream writes, and evidence that may authorize an upstream mutation.

In addition to Standard requirements, it requires:

- an independent read-only data-safety review;
- an independent read-only regression review;
- preview and execution parity;
- execution-time target authorization;
- multi-instance and ambiguous-identity coverage;
- real mutation, expected-failure, retry, idempotency, partial-completion, and
  concurrency tests as applicable;
- explicit human maintainer approval.

## Review epoch lifecycle

A review epoch covers one declared PR contract and one coherent implementation.
It has a finite default lifecycle.

### Phase 1: implementation

1. Reproduce the issue or establish the current behavior.
2. State scope, non-goals, acceptance criteria, and risk tier.
3. Produce one coherent implementation diff.
4. Run focused validation.
5. Run local regression and data-safety review when the risk tier requires it.

### Phase 2: initial broad review

Review the complete coherent diff exactly once. Record the exact reviewed head
SHA and every finding in the PR's finding-disposition table.

Allow the normal automatic GitHub Codex review when a PR becomes ready. Do not
comment `@codex review` after every correction.

### Phase 3: consolidated correction

Reproduce each proposed finding. Correct all accepted in-scope findings in one
coherent pass. Do not automatically implement valid out-of-scope findings;
open or link focused follow-up issues where appropriate.

### Phase 4: targeted delta review

Review only:

```text
<previous-reviewed-head>..<corrected-head>
```

Ask only:

- Did the correction resolve the recorded finding?
- Did the correction introduce a regression?
- Did the correction expand scope or authorization?
- Did the correction violate a non-goal?

Do not restart unconstrained exploration of the whole PR.

### Phase 5: optional micro-correction

If the targeted delta review finds a new, reproduced, in-scope blocker, one
bounded micro-correction and one review of only that micro-delta are allowed.
After that, the maintainer must choose whether to merge, split the PR,
abandon/rebuild it, or explicitly start a new review epoch.

### Phase 6: maintainer stop gate

The maintainer checks the stopping conditions in this guide and records the
decision. A new commit alone does not start a review epoch. A new AI suggestion
alone does not expand PR scope.

## Finding classification

Assign every finding a stable ID, an independent severity, and exactly one of
these classifications.

### `introduced-regression`

The PR introduced the defect. Fix it before merge.

### `worsened-preexisting`

The problem exists on the base, but the PR materially expands its impact,
authorization, exposure, or likelihood. Fix it before merge.

### `contract-violation`

The finding violates the PR's declared scope, acceptance criteria, non-goals,
or repository safety invariants. Fix it before merge.

### `preexisting-follow-up`

The issue exists on the base and the PR preserves or reduces the risk. Create
or link a focused follow-up issue; do not expand the current PR.

### `planned-later-phase`

The capability is explicitly assigned to a later approved PR or phase. Link
the plan or issue; do not implement it in the current PR.

### `unreproduced`

The hypothesis cannot be reproduced or supported by the current diff and code.
Do not change code; record the evidence checked.

### `unrelated`

The finding belongs to another subsystem or task. Use a separate issue or PR.

## Severity versus scope

Record severity independently as P0, P1, P2, P3, or informational. Severity
describes impact if the finding is real. Classification describes its
relationship to the current PR.

A P1 badge does not itself make a finding in scope for the current PR. Compare
the behavior with both:

- the PR's declared contract; and
- the actual base branch behavior.

High severity can justify stopping a merge, escalating the risk tier, or
creating an urgent follow-up. It does not erase the need to establish scope.

## Reproduction requirement

No finding authorizes a code change until it is reproduced or supported by
direct evidence. Record:

- the finding ID and reviewer;
- exact base and head SHAs checked;
- the failing scenario, command, test, trace, or code path;
- whether the same behavior exists on the base;
- the severity and classification;
- the accepted disposition and follow-up link, if any.

For an unreproduced hypothesis, record the evidence checked and stop. Do not
change code merely to satisfy a badge, a reviewer identity, or a plausible
idea.

## Correction and delta-review rules

Correct accepted `introduced-regression`, `worsened-preexisting`, and
`contract-violation` findings together in one consolidated pass. Preserve the
PR's declared boundaries while correcting them.

The first correction receives one targeted delta review, not another broad
review. If that delta contains a new reproduced in-scope blocker, permit one
micro-correction and one micro-delta review. Further iteration requires a
maintainer decision to merge, split, abandon/rebuild, or start a new epoch.

Record the initial broad-reviewed head, correction head, targeted range, and
optional micro-delta in the PR body. Valid `preexisting-follow-up`,
`planned-later-phase`, and `unrelated` findings receive links or explicit
dispositions instead of opportunistic implementation.

## Material-scope-change rules

Only a maintainer can declare a material scope change and start a new broad
review epoch. Record the reason and the new epoch in the PR review plan.

A new epoch is required when any of these materially changes the reviewed
contract or risk boundary:

- a new subsystem enters the diff;
- a database schema or external contract is added;
- a new upstream mutation path is added;
- acceptance criteria, the safety model, or a public contract changes;
- behavior moves from read-only to mutation;
- the base advances with meaningful overlap;
- architectural responsibilities are split, merged, or substantially
  redesigned by a correction.

These do not automatically start a new epoch:

- a deterministic test-fixture correction;
- a narrow query optimization;
- a direct correction to a recorded finding;
- formatting;
- moving code behind an already approved boundary;
- another commit with unchanged scope.

File count and diff size are warning signals. They are not a percentage-based
definition of material scope.

## Exact-head and base rules

Record full SHAs for the actual base, initial broad-reviewed head, correction
head, GitHub Codex review head, and current PR head. Before the stop gate:

1. fetch the base branch;
2. compare the current merge base with the recorded base;
3. inspect meaningful overlapping base changes;
4. confirm the current head is the broad-reviewed head or that every later
   correction is covered by a recorded targeted delta;
5. require CI results for the exact current head.

A status from an older head is not exact-head evidence. A base advance without
meaningful overlap does not automatically invalidate an epoch; record the
comparison. Meaningful overlap requires maintainer review and may require a new
epoch.

## GitHub review-thread handling

Before merge, inspect every review surface:

- submitted reviews and their commit SHAs;
- PR conversation comments and reactions used as review signals;
- inline review comments;
- unresolved review threads;
- all checks triggered by the current PR head.

For each finding on an older commit, verify whether it still applies to the
current head. Fix, reject with evidence, or explicitly defer every in-scope
finding. Resolve actionable threads only after the correction is verified.
Do not treat an older comment as obsolete merely because a new commit exists.

Wait for the configured GitHub Codex result and every PR-triggered check. A
minimum required check turning green is not enough while another configured
review or check remains pending.

## CI and live-validation expectations

Run focused tests while iterating and the repository verification gauntlet at
the PR boundary. Run release, build, disposable integration, populated-fixture,
or live browser checks when the changed behavior requires them. Trivial PRs
need only relevant deterministic validation; safety-critical changes need the
stronger evidence listed in their tier.

The `PR Review Contract` workflow validates the live PR body from trusted base
code on PR open, edit, reopen, synchronization, and ready-for-review events. It
uses `pull_request_target`, checks out only the repository default branch, has
read-only contents and pull-request permissions, receives no secrets, and
treats the PR body only as data. It never checks out or executes PR-head code.
PR-body edits therefore rerun this lightweight check without rerunning the full
application gauntlet.

The workflow that introduces this check cannot run from the base until it is
merged. Do not weaken the trusted-base design to self-test the introducing PR.
Normal CI runs the checker's Node test suite on that PR instead.

## Final maintainer stop gate

The maintainer may approve merge only when all applicable conditions hold:

- exact-head CI is green;
- acceptance criteria pass;
- no introduced regression remains;
- no declared contract violation remains;
- no unresolved in-scope review thread remains;
- every valid out-of-scope finding has a recorded disposition;
- the reviewed head equals the current head, or the final delta was reviewed;
- the base has not materially changed, or the overlap received the required
  decision;
- all required risk-tier reviews and validation are complete;
- the maintainer approves merge.

A real reproduced in-scope blocker can always stop merge. The finite correction
budget limits repeated unconstrained review; it does not convert a blocker into
permission to merge.

## Post-merge verification

After this contract's workflow is merged:

1. Open or update a later verification PR and confirm `PR Review Contract`
   runs from the trusted base branch.
2. Edit that PR body and confirm only the lightweight contract workflow is
   retriggered by the edit.
3. Add `PR Review Contract` as a required status check on `main` while
   preserving `Lint, Type Check & Test` and all unrelated protection settings.
4. Enable required conversation resolution if it is not already enabled.
5. Do not require an approving review that the sole maintainer cannot provide
   to their own PR.

For an application change, execute its recorded post-merge validation against
the merged SHA and release/deployment surface as applicable. If post-merge
verification fails, open a focused regression issue or corrective PR; do not
rewrite the completed review ledger.

## Examples

### Query regression

A PR introduces a query regression that materializes an entire dataset.

- Classification: `introduced-regression`
- Disposition: fix before merge.

### Pre-existing target-identity gap

A reviewer identifies a pre-existing upstream target-identity gap while the PR
adds safety checks and does not expand authorization.

- Classification: `preexisting-follow-up`
- Disposition: link a focused issue; do not expand the current PR.

### Deterministic fixture correction

A correction changes only a deterministic test fixture.

- Disposition: perform a targeted delta review; do not start a new broad
  review epoch.

### Schema added during correction

A correction adds a new schema table.

- Disposition: this is a material scope change. The maintainer declares a new
  review epoch or splits the PR.
