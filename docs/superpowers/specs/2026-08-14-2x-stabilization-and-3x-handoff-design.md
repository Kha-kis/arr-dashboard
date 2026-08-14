# 2.x Stabilization and 3.0 Handoff Design

## Goal

Ship one bounded final 2.x stabilization release for confirmed regressions and
data-safety defects, establish explicit behavioral parity on `next`, and then
restrict `main` to critical maintenance while 3.0 moves to release.

## Current baseline

- `main` is the stable 2.x maintenance line. It currently reports version
  `2.23.0` and contains a substantial batch of merged fixes after tag
  `v2.23.0`.
- `next` is the 3.0 line. It has native implementations for several stable
  fixes but must not receive a wholesale merge from `main`.
- The `v2.23.0` tag exists, but its human-facing GitHub Release record is
  missing. Release preparation must reconcile that historical metadata without
  changing the contents of the existing tag.
- Existing cleanup Wave 3A, 3B, and 3C worktrees are preserved. They remain
  paused until the stable release blockers and parity ledger are resolved.

## Release boundary

An issue blocks the stabilization release only when at least one of these is
true:

1. A supported 2.x deployment has a reproduced regression in a core workflow.
2. The defect can authorize deletion, mutate the wrong upstream service, lose
   data, bypass authentication, or publish misleading safety evidence.
3. The application repeatedly becomes unavailable under a supported runtime
   and the report contains enough evidence to identify or reproduce the cause.

The release is not blocked by:

- enhancements or new integrations;
- reports that cannot be reproduced after a bounded evidence pass;
- optional modernization that belongs to 3.0;
- speculative fixes for symptoms without a demonstrated root cause.

Evidence-pending issues remain open with an exact request for the missing
diagnostic information. They are not silently treated as fixed.

## Provisional issue inventory

### Confirmed or high-priority investigation

- `#706`: selected non-default Sonarr destination is ignored during request
  approval.
- `#703`: Jellyfin cleanup fields can appear without operators in composite
  rule authoring.
- `#694`: application becomes unavailable after extended runtime; diagnose
  from the supplied log before deciding whether a code change is justified.
- `#689`: cleanup evidence can be accepted from the wrong upstream behind a
  stable proxy unless it is bound to durable server identity. Plex,
  Jellyfin/Emby, and the configured Plex server reported by Tautulli all expose
  usable identifiers, although the current Tautulli client does not consume
  its identity endpoint. The stable line needs the complete safe lifecycle or
  an explicit fail-closed containment; 3.0 receives the semantically equivalent
  authority rule.

### Verification and disposition

- `#675`: verify the complete fix merged in PR `#693` against a published
  image and the reporter's general-cache scenario.
- `#673`: verify and close the original Plex HTTP 400 report only after release
  evidence supports closure.
- `#674`: time-box reproduction of the exact TRaSH auto-sync scheduler report;
  preserve the issue if required logs are still missing.
- `#427`: reconcile the prior memory/allocator fixes and soak evidence, then
  close only if the current evidence supports resolution.

### Excluded enhancements

`#664`, `#632`, `#627`, `#624`, `#623`, `#622`, and `#487` do not block the
stable release. They remain enhancement work for 3.0 or a later roadmap.

## Delivery model

### One stable issue, one focused PR

Each confirmed stable issue receives a clean worktree and branch from the
current `origin/main`. The implementation follows this order:

1. Freeze the reporter's version, deployment, database, integrations, expected
   result, actual result, and supplied evidence.
2. Reproduce the exact scenario or prove the defect through a faithful fixture.
3. Add a regression test and observe it fail.
4. Implement the smallest coherent correction.
5. Use the layered development loop: RED/GREEN focused tests, affected-path
   integration checks, one required independent review and correction pass,
   then the repository gauntlet once at the PR boundary. Add live verification
   only where it supplies evidence the repository tests cannot.
6. Before merge, audit submitted reviews, inline comments, unresolved review
   threads, and the reviewed commit against the current head. Open and merge
   one focused PR only when every in-scope finding has an explicit disposition
   and every actionable thread is resolved. The configured GitHub Codex result
   and every PR-triggered check must finish before merge, even when GitHub
   already reports the minimum branch-protection checks as mergeable.

Deletion, cleanup, cache publication, identity, and upstream writes always
receive an independent data-safety review. Substantial data-dependent changes
also receive one regression review. Reviewers inspect the coherent diff once;
accepted findings enter one correction batch. A new observation after that
batch becomes follow-up work unless it proves the current change unsafe or
invalid. A comment attached to an older commit still requires an applicability
check; it is not implicitly superseded by a later push.

### Immediate semantic forward-port

After a stable PR merges, its parity decision is recorded before the next
stable issue begins:

- `required`: create a separate branch from current `origin/next`, reproduce
  the scenario on 3.0, and port the behavior using the native 3.0 architecture;
- `already equivalent`: cite the exact 3.0 tests and merged PR that provide the
  same behavior;
- `not applicable`: record the architectural reason and the evidence proving
  the stable path does not exist on 3.0.

No direct `main` to `next` branch merge is allowed. A forward-port PR does not
carry stable-only generated files, migrations, release metadata, or unrelated
maintenance changes.

## Parity ledger

The program maintains one tracked table containing:

- stable issue and PR;
- stable behavior and validation evidence;
- parity classification;
- 3.0 PR or existing equivalent;
- 3.0 focused validation;
- release disposition.

The ledger is the completion authority for the handoff. Commit-count equality
is not a parity signal because both lines use squash merges and divergent
architectures.

## Stable release gate

The release candidate is prepared only after:

- all confirmed blockers are merged on `main`;
- every blocker has a complete parity-ledger disposition;
- evidence-pending reports have either become confirmed blockers or have an
  explicit non-blocking evidence request;
- every release PR has exactly one `release:*` label;
- format, shared build where applicable, root typecheck, tests, lint, and
  production build pass;
- SQLite and PostgreSQL fresh-install and previous-release upgrade checks pass
  without `--accept-data-loss`;
- Docker builds and health metadata pass on the candidate SHA;
- password login and configured OIDC/passkey paths are smoked;
- Sonarr/Radarr write-pattern integration, dashboard, statistics, TRaSH cache,
  backup, and relevant cleanup/cache scenarios are verified;
- the candidate `:dev` image completes a 24-to-48-hour bounded soak with no
  release-blocking regression.

The version is expected to be `v2.24.0` because the accumulated `main` range
contains user-visible cleanup and TRaSH capabilities as well as fixes. The
release audit makes the final semantic-version decision from the actual range.

Tagging, image publication, GitHub Release creation, issue closure, and moving
the `latest` tag occur only from the exact reviewed release commit and are
verified independently after publication.

## Post-release branch policy

After the stabilization release:

- `main` accepts only security fixes, data-loss or deletion-safety fixes, and
  severe regressions affecting the released 2.x line;
- enhancements and ordinary defects target 3.0 unless a current stable user is
  materially affected;
- every accepted stable hotfix retains the immediate parity-ledger rule;
- active development returns to the preserved Wave 3A, 3B, and 3C work on
  current `next`, followed by the 3.0 release-readiness audit.

## Failure handling

- If a report lacks evidence, request the smallest diagnostic artifact that
  would distinguish causes and continue with other confirmed work.
- If a stable fix requires a breaking schema or product migration, prefer a
  fail-closed containment on `main` and implement the complete migration on
  `next`.
- If live validation would mutate production media, storage, or upstream
  state, use disposable fixtures or an explicitly approved bounded test
  target.
- If a release candidate fails its soak, open one regression issue tied to the
  candidate SHA and return only the invalidating change to implementation.
