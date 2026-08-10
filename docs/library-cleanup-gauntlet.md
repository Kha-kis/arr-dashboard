# Library Cleanup Completion Gauntlet

## Goal

Make Library Cleanup a complete, trustworthy 2.x feature for rule authoring,
preview, approval, execution, recovery, and audit. The operational quality bar
is qUI Automations: clear rule semantics, useful impact previews, explicit
destructive actions, deterministic ordering, fail-closed ownership checks,
idempotent execution, and actionable activity records.

This is an umbrella program delivered through focused changes. A single clean
pull-request review is not completion; the whole feature must satisfy the exit
gates below.

## Scope ledger

| ID | Report or finding | Required proof | Status |
| --- | --- | --- | --- |
| LC-616 | [#616](https://github.com/Kha-kis/arr-dashboard/issues/616): deleting one Radarr quality variant must retain the other variant and its Plex identity | Reproduce the reporter's two-Radarr/shared-Plex topology with different ARR-visible paths in a disposable live test; cover both 4K-to-1080p and 1080p-to-4K retention without the v2.23.0 cross-instance safety block | Automated mutation-boundary coverage and the disposable two-Radarr/shared-Plex topology are green in both quality directions. Only the selected ARR record/file changes; the retained peer, shared Plex identity, and every qUI source torrent remain. Action-triggering Plex connections remain mandatory mutation witnesses; non-triggering connections can supply exact fallback path evidence without gaining delete authority |
| LC-618 | [#618](https://github.com/Kha-kis/arr-dashboard/issues/618): rules need nested AND/OR groups and NOT | Round-trip a versioned recursive rule tree through API, database, editor, preview, explain, approval, and execution; prove backward compatibility for existing composite rules | Green: shared schema, evaluator, API, editor, preview/explain, current-policy authority, provider freshness, and legacy compatibility gates pass. The disposable live policy run round-trips and dry-runs `(A AND B) OR (A AND NOT C)` against both Radarr fixtures, and signed Chromium sessions on the SQLite and PostgreSQL candidates author, persist, and reopen the same recursive tree without flattening it |
| LC-619 | [#619](https://github.com/Kha-kis/arr-dashboard/issues/619): monitored items need a direct condition | Prove monitored and unmonitored matches in standalone, nested, retention, preview, explain, and execution paths | Green: standalone/nested/NOT evaluation, explain, auto-tag, queued/direct authority, missing-evidence failure, preview, and timeout reconciliation pass. The disposable live run selects one monitored UHD item, performs and verifies a real Radarr unmonitor, restores it, and resyncs; signed Chromium sessions on both database candidates author, persist, and reopen the direct Monitored/Unmonitor rule |
| LC-657 | [#657](https://github.com/Kha-kis/arr-dashboard/issues/657): verify shared Plex ownership across Sonarr instances | Prove every selected episode file and every retained Plex part has an exact live owner; cover series-level and episode-level actions | Automated ownership/state-transition coverage is green. The disposable two-Sonarr/shared-Plex topology passes both series and episode deletion in both quality directions. Plex identity, the peer file/record, and qUI source torrents remain |
| LC-660 | [#660](https://github.com/Kha-kis/arr-dashboard/issues/660): IMDb rating does not match current library data | Reproduce against current Radarr and Sonarr payload shapes; distinguish a real zero, a missing rating, and an unavailable source | Independently clean in the integrated foundation: Radarr TMDb/IMDb and Sonarr rating provenance, zero/missing/malformed handling, nested Radarr-only scope, current mutation authority, editor/API round trips, and auto-tag races pass. Post-upgrade live sync and browser gates remain open |
| LC-667 | [#667](https://github.com/Kha-kis/arr-dashboard/issues/667): optionally refresh media-server libraries after cleanup deletes files | Prove the opt-in setting round-trips, persists scan intent before deletion, triggers only after durable deletion success, coalesces duplicate Plex/Jellyfin/Emby work, survives restart, and retries scan failure without repeating ARR deletion | Implementation, focused/full automated gates, SQLite/PostgreSQL schema startup, production-compatible Plex/Jellyfin/Emby HTTP contracts, and disposable automatic-Plex-scan mutations are green. The option is off by default and valid only for destructive non-retention rules. Per-action jobs capture physical server identity and Plex section scope before deletion; terminal audit precedes scan outcome; retries use database-clock exponential backoff; a fenced physical-operation lease prevents cross-worker duplicate refreshes; ambiguous post-dispatch persistence remains in-flight without false failure; and restart recovery always reissues an idempotent refresh instead of trusting process clocks. SQLite Sonarr/Radarr and PostgreSQL Radarr live mutations passed automatic Plex refresh. Both independent reviewers are clean |
| LC-659 | [#659](https://github.com/Kha-kis/arr-dashboard/issues/659): an episode match must never widen into whole-series deletion | Keep the reporter scenario and the inverse watched/unwatched cases as permanent mutation-boundary regressions | Green: permanent mutation-boundary regressions plus disposable watched-episode deletion in both quality directions retain both Sonarr series records, the peer episode file, Plex identity, and qUI sources |
| LC-617 | [#617](https://github.com/Kha-kis/arr-dashboard/issues/617): approved work must remain visible with an honest terminal or retry state | Keep approval-tab, execution-error, retry, expired, and executed lifecycle coverage | Regression gate |
| LC-661-A | Late review on PR #661: a nonmatching provider-backed series rule can allow an episode proposal that execution can never authorize | Preview and execution must evaluate the same policy with equally fresh evidence, or discovery must suppress the proposal with an actionable reason | Discovery and mutation share recursive live-Sonarr-only Kleene evaluation: applicable series cleanup or retention rules must be exactly false; `FALSE AND UNKNOWN` permits the episode path while `FALSE OR UNKNOWN`, `TRUE OR UNKNOWN`, provider-only UNKNOWN, and `NOT UNKNOWN` fail closed; full automated gates green |
| LC-POLICY-ALL | Queued and direct movie/series mutations currently revalidate exact ARR/file identity but not the current cleanup-rule and retention policy; recursive provider-backed NOT makes stale intent especially dangerous | Immediately before every mutation, revalidate the exact current winning rule/action, priority, retention state, and recursive expression using fresh authoritative evidence; missing or changed evidence fails closed | The frozen provider/policy foundation is independently clean: every destructive step revalidates exact current policy, expected ARR transitions, atomic Plex and typed list generations, provider completeness/freshness, post-lease budgets, and user scope. Integration, PostgreSQL runtime, and live mutation gates remain open |
| LC-661-B | Late review on PR #661: a renamed EpisodeFile after unmonitor can leave the file present and the episode unmonitored | Inject the identity change after unmonitor; prove a durable retry or compensating remonitor action survives restart and never authorizes the changed file blindly | Integrated automated recovery and restart-state gates are green. Candidate SQLite and PostgreSQL startup/migration smoke tests pass; a disposable live Sonarr mutation/restart remains open |
| LC-QUI-ALL | Fresh physical-file qUI protection currently covers episode cleanup but not every movie and series file-deleting action | Apply the same complete, fresh, fail-closed inventory proof to every destructive scope when qUI protection is enabled | Independently clean in the integrated foundation. Movie, series, and episode file mutations require complete fresh evidence from every enabled qUI, including all inode-sharing hashes and qBittorrent identities. One per-user guard spans final proof through physical ARR mutation, and topology or hash changes invalidate durable and process-local observations before the guard is released. The regression critic's Queue Cleaner finding was fixed so invalidated/stale correlated evidence fails closed while no-qUI behavior is unchanged. Disposable live qUI/qBittorrent topology and browser gates remain open |
| LC-PREVIEW | Preview does not yet model the exact next run because execution also applies approval history, retry policy, deduplication, and removal budgets | Preview the deterministic next-run selection, expose capped/deferred counts honestly, and invalidate it when policy or topology changes | Independently clean in the integrated foundation: preview, dry run, approval, retry, and direct paths share deterministic rule/file ownership, fixed no-backfill selection, retry-first budgets, honest outage/nullability, exact totals, and a 200-row display cap. qUI/recovery integration and live browser gates remain open |
| LC-EVIDENCE | Missing cached qUI state can be described as highest-trust safe-to-delete evidence even though no live or physical proof occurred | Label cached/unknown evidence accurately and reserve a safe result for completed live authorization | Independently clean in the integrated foundation. All enabled qUI inventories are fetched before conservative aggregation; incomplete or failed scans invalidate both caches, freshness is published only after complete staging, and fresh complete absence has explicit sync provenance. Preview labels the result as informational cached evidence with its observation time and never calls it safe to delete. Queue Cleaner also treats invalidated/stale correlated evidence as unavailable and fails closed. Browser verification remains open |
| LC-AUDIT | Queue creation and direct runs are logged separately from later approval/retry execution state | Provide one per-action operator history across preview, approval, mutation, compensation, retry, and terminal state | Integrated automated gates are green: append-only timelines, exact per-SDK mutation boundaries, truthful partial/retry outcomes, scheduler expiry/recovery, zero-write dry runs, bounded retention, correlation, user scope, pagination, incognito UI, and SQLite concurrency all pass. A live PostgreSQL serialization conflict exposed nested driver code `40001`; the retry detector now handles it and the concurrent 10,001-row retention test passes on PostgreSQL. Candidate SQLite/PostgreSQL image startup and migrations pass. Signed browser and live restart scenarios remain open |

Before every major wave and the final merge gate, search all open repository
issues by title, body, label, and comments. Any newly reported Library Cleanup
behavior joins this ledger before the gauntlet may finish.

Open-issue and comment audit refreshed 2026-08-05 after PR #668 merged: the repository's
complete open Library Cleanup set is #618 and #619, both represented and verified above.
Closed reports remain mandatory regression gates because their failure modes are part of
the same destructive workflow.

General download-client expansion, such as NZBGet support, is not automatically
part of this 2.x completion program unless a Library Cleanup safety or execution
scenario depends on it.

## Non-negotiable behavioral contract

1. **Preview parity** — preview, approval, and execution select the same logical
   targets and actions. Preview is side-effect free.
2. **Live authority** — every mutation re-fetches and authorizes the exact
   current ARR entity, media file, configured service set, and safety evidence.
3. **Fail closed** — missing, stale, ambiguous, incomplete, or conflicting
   evidence produces a skipped or retryable result with a specific reason.
4. **No scope widening** — movie, series, season, episode, file, Plex part, and
   torrent ownership scopes remain explicit through every state transition.
5. **Deterministic policy** — nested logic, retention, rule priority, and
   action precedence have one documented meaning shared by preview and
   execution.
6. **Honest partial failure** — upstream success is recorded only after it
   happens. Partial work remains visible, retryable, and safe across restart.
   When possible, reversible mutations are compensated.
7. **Idempotency** — retries and concurrent invocations do not repeat completed
   mutations, widen their scope, or report false success.
8. **Operator evidence** — preview and activity records show the matched rule,
   target scope, exact action, ownership/safety result, and failure or skip
   reason without requiring debug-log archaeology.
9. **Compatibility** — existing flat and composite rules continue to work after
   schema changes; unsupported service capabilities are gated rather than
   guessed.

## Acceptance scenario matrix

| Scenario | Expected result | Required evidence | Status |
| --- | --- | --- | --- |
| RULE-001 `(A AND B) OR (A AND C)` | Only the mathematically matching items are proposed and executed | Shared schema/evaluator tests, API round-trip, editor E2E | Green with the stronger live/browser fixture `(A AND B) OR (A AND NOT C)`: exact recursive persistence, preview/dry-run evaluation, and edit hydration pass without flattening |
| RULE-002 `A AND NOT B` | Negation is explicit and identical in preview/explain/execution | Property and truth-table tests, editor E2E | Green: Kleene evaluator and provider-unknown truth tables, preview/explain/current-policy authority, live dry-run, and signed editor authoring/rehydration pass |
| RULE-003 monitored/unmonitored | Each state can be selected directly without retention-rule workarounds | API/evaluator/UI tests | Green: standalone, nested, NOT, preview, explain, current authority, signed editor authoring, and a real disposable Monitored-to-Unmonitor Radarr mutation with verified restoration pass |
| ENRICH-001 IMDb below/above/unrated/unavailable | Current ARR payloads evaluate correctly; unavailable data does not masquerade as no match | Captured contract fixtures and evaluator tests | Automated gate green; live Radarr 6 source-keyed and Sonarr 4 flat-rating shapes verified; post-upgrade sync open |
| POLICY-001 provider series rule plus episode rule | Discovery never creates an approval that unchanged execution must reject | Failure-injection regression | Planned |
| PREVIEW-001 deterministic selection and run budget | Preview identifies the same ordered fresh targets as the next run and honestly reports selected, deferred, and capped counts | Shared planner contract tests and populated browser E2E | Integrated planner/API/UI independently clean, including tied-priority ordering, physical EpisodeFile ownership, 250-match/100-budget parity, exact totals, and independent count/display completeness; signed browser gate open |
| PREVIEW-002 approval memory and deduplication | Pending and remembered rejected targets are excluded before the approval run limit without hiding why | Approval-mode parity tests | Automated approval parity green; fresh second-pass review open |
| PREVIEW-003 durable retry fairness and in-flight ownership | Direct-mode preview shows selected retries, one-run fairness deferrals, already executing work, and the remaining fresh budget without claiming a mutation outcome it cannot know | Retry-state and restart contract tests | Retry outage, pending/in-flight collision, restart ordering, and duplicate-target ownership gates green; historical duplicate rows are visible as deferred and cannot consume multiple budget slots or starve unrelated work |
| PREVIEW-004 safety evidence unavailable or blocked | The selected target remains visibly blocked/deferred and does not silently pull a later target into the same run | Failure-injection API/UI tests | Automated no-backfill and honest-count gates green; fresh second-pass review open |
| RADARR-001 delete 4K, retain 1080p through different ARR-visible paths | Only the verified target file/record changes; retained Plex metadata remains; no cross-instance-path safety block | Contract test and disposable live topology | Green: selected 2160p record/file removed; 1080p peer, shared Plex identity, and all qUI sources retained |
| RADARR-002 delete 1080p, retain 4K through different ARR-visible paths | Symmetric result to RADARR-001 | Contract test and disposable live topology | Green: symmetric automated and disposable live evidence |
| SONARR-001 series-level cleanup with shared variants | Each target episode file is independently authorized; retained files and peer instances are untouched | Contract test and disposable live topology | Green in both quality directions on the latest disposable candidate; Plex scan and retained identity verified |
| SONARR-002 watched episode cleanup | Only the matched episode file changes; series and other episodes remain | Permanent #659 regression and live topology | Green in both quality directions on the disposable two-Sonarr/shared-Plex topology |
| RECOVERY-001 file identity changes after unmonitor | Changed file is not deleted; monitoring is restored or a durable recovery remains visible | Restartable failure-injection test | Automated gate green; live gate open |
| RECOVERY-002 upstream/network failure after each mutation boundary | Retry resumes from honest state without repeating completed work | Parameterized state-machine tests | Planned |
| PLEX-001 duplicate sections, parts, capped/unavailable history | Watch and ownership evidence remains conservative without losing valid retained copies | Contract and cache-refresh tests | Planned |
| QUI-001 complete, incomplete, cross-seeded, hardlinked, symlinked, and unavailable inventory | Destructive authorization succeeds only for fully proven safe inventory | Filesystem and qUI contract tests | Automated complete/incomplete/failure, cross-seed, stable-inode, path/hash/topology drift, unknown-state, and multi-qUI gates are independently clean; disposable filesystem and live qUI/qBittorrent gate open |
| QUI-002 movie, series, and episode deletion scopes | Every scope uses the same fresh physical-file proof when qUI protection is enabled | Cross-scope contract tests and disposable live topology | Automated movie/series/episode, direct/queued, `delete`/`delete_files`, newly-enabled protection, record-only, unmonitor, and topology-lock gates are independently clean; disposable live topology open |
| EVIDENCE-001 cached, live, unavailable, and unknown qUI evidence | The UI names the actual evidence source and never turns absence into a safety claim | API/UI contract tests and browser E2E | API/UI contracts are independently clean for enabled-qUI gating, 30-minute freshness, provenance timestamps, complete absence, episode-file cache reads, ambiguous state, non-authoritative wording, and Queue Cleaner fail-closed handling after incomplete multi-qUI sync; signed browser E2E open |
| APPROVAL-001 pending through executed/expired/retry states | Queue and activity views always expose the current honest state | API and browser tests | Planned |
| AUDIT-001 preview, approval, mutation, compensation, retry, and terminal outcomes | One action timeline contains every state transition, evidence level, actor/trigger, and actionable failure reason without double-counting an action across run and approval records | API persistence tests, restart tests, and browser E2E | Integrated API/database/UI gates are clean, including 5,001 pending timelines capped at exactly 10,000 events, truthful failed-boundary outcomes, SQLite locking, PostgreSQL serializable-conflict retry, user-scoped pagination, incognito masking, and candidate migrations in both database modes. Signed browser and disposable live restart gates remain open |
| RESCAN-001 opt-in media-server refresh after destructive cleanup | ARR deletion reaches durable success before any scan request; duplicate work is coalesced; scan failure remains independently retryable and never repeats deletion | Schema/API/UI tests, executor failure injection, SQLite/PostgreSQL restart tests, and disposable Plex/Jellyfin/Emby endpoints | Schema/API/UI, queued/direct audit ordering, physical-identity coalescing, Plex planned-section/no-op handling, database-clock lease/retry handling, skewed-worker restart recovery, ambiguous terminal persistence, CAS races, durable-job retention, HTTP endpoint, full suite, Docker build, and disposable live Radarr/Sonarr automatic-scan gates are green. The PostgreSQL-backed live Radarr mutation exercised the provider-specific raw lease/eligibility/request-time path successfully. Both independent reviewers are clean |
| SCALE-001 populated large library | Evaluation stays within measured memory/time budgets and produces complete/capped counts honestly | Benchmark fixture on SQLite and PostgreSQL | Planned |

The lead agent may split or add scenarios as implementation evidence reveals
new independent behaviors. Existing scenarios cannot be removed merely to make
the matrix pass.

## Builder and critic loop

The gauntlet has a bounded discovery phase followed by a finding-ledger closure
phase. A correction does not restart an unrestricted review of the whole
feature.

### Contract freeze

Before a major implementation wave, freeze its acceptance scenarios, mutation
boundaries, threat model, required evidence, and explicit out-of-scope work.
New information may amend the contract, but the amendment and maintainer
rationale must be recorded before it can expand the blocking scope.

### Discovery phase

For each independently testable gap:

1. Reproduce it against the real code or a production-shaped fixture.
2. Add a test that fails for the reported behavior.
3. Have a builder implement the smallest coherent correction.
4. Run focused validation.
5. Give the actual diff, tests, and running artifact to independent critics for
   one complete pass over their assigned surface:
   - rule semantics and preview parity;
   - destructive data safety;
   - retry/idempotency and regression;
   - operator UX and observability, when affected.
6. Record every actionable finding in one ledger with a stable identifier,
   severity, violated acceptance requirement, owner, status, and closure
   evidence.
7. Triage the complete discovery set before starting a remediation batch.
8. Run a whole-feature integration pass after each major wave so individually
   correct parts do not form an inconsistent system.

Discovery closes after every required critic has completed its assigned pass.
It is not reopened merely because a later reviewer identifies unrelated
hardening or a pre-existing condition outside the frozen contract.

### Closure phase

1. Address accepted findings in coherent batches rather than requesting a new
   review after every small correction.
2. Closure critics review the unresolved finding identifiers, the lines changed
   to resolve them, and directly affected mutation paths. They do not begin a
   fresh whole-feature audit.
3. A new finding may block closure only when it demonstrates a P0 or P1 issue,
   or a P2 issue that violates the frozen acceptance contract or was introduced
   by the remediation delta.
4. Pre-existing, unrelated, or future-hardening findings are recorded as
   follow-up candidates with maintainer rationale. They do not reopen the
   current gauntlet.
5. Additional targeted closure is required when evidence for an accepted
   finding is incomplete or a remediation materially changes an architecture or
   mutation boundary. The review remains scoped to that change.

Severity controls the merge decision:

- P0 and P1 findings always block.
- P2 findings block when they are in the frozen contract or introduced by the
  current delta. Other P2 findings require a recorded follow-up decision.
- P3 suggestions and non-actionable hardening ideas enter the backlog and do
  not block closure.

### Hosted review budget

Request one full hosted pull-request review on the frozen candidate. Triage all
of its findings before editing, address accepted findings in one remediation
batch, and use targeted closure review plus CI to verify that batch. Request a
second full hosted review only when the remediation materially changes the
architecture or a safety-critical mutation boundary; otherwise another
whole-PR review would restart discovery without changing the quality bar. A
third full hosted review is not part of the current loop. If the exceptional
second review exposes a contract-invalidating architectural problem, close the
current wave as not mergeable and open a newly scoped gauntlet wave rather than
expanding the pull request again.

The normal review budget is one discovery pass per critic domain, one closure
pass per domain, one full hosted review, and one hosted-review remediation
batch. This budget limits repeated re-auditing; it never permits merging with a
known unresolved blocker.

The implementer does not grade its own mutation boundary. Hosted pull-request
review remains an additional critic, not a replacement for the independent
data-safety and regression reviews.

## Live verification policy

- Use production services read-only for compatibility and preview evidence.
- Use isolated libraries, disposable files, and test records for destructive
  verification.
- Exercise supported Sonarr, Radarr, media-server, and qUI/qBittorrent
  topologies plus SQLite and PostgreSQL.
- Capture exact versions, paths, mappings, actions, and before/after state in
  the evidence ledger.
- Never infer destructive permission from an empty development database.

## Disposable live harness

The integrated candidate is verified in a project-scoped Docker Compose stack
that cannot share containers, volumes, media, configuration, or databases with
production. The cleanup profile adds two Radarr instances, two Sonarr
instances, Plex, two qBittorrent instances behind two qUI instances,
PostgreSQL, deterministic media/torrent fixtures, and a request fault proxy.

The live matrix must:

- reproduce #616 on the published v2.23.0 image with different ARR-visible
  paths, then prove both 4K-to-HD and HD-to-4K deletion directions on the
  integrated candidate without changing the retained Plex identity;
- prove series-, file-, and episode-scoped Sonarr ownership while peer files,
  peer records, unrelated episodes, and retained Plex parts remain untouched;
- exercise complete, absent, incomplete, unavailable, cross-seeded, active,
  paused, error, hardlinked, and concurrently changing qUI evidence;
- inject failures between upstream mutation steps and verify durable,
  idempotent recovery across container restart on SQLite and PostgreSQL; and
- drive nested rule authoring, preview, approval, partial failure, retry, audit
  pagination, and evidence labels through a signed Playwright session.

A fresh disposable Plex server requires a short-lived claim token. The token
must come from an ignored temporary environment file and must never appear in
logs or captured evidence. Production compatibility checks remain strictly
read-only.

The isolated stack under `e2e/library-cleanup` passed independent safety review
on 2026-08-03. Its base and debug Compose models, 24 negative safety cases,
Docker build-context exclusions, project-scoped physical resources, and guarded
teardown remain green. Bootstrap now proves a newly requested dashboard sync
generation completed, always asks ARR to rescan restored hardlinks, and leaves
unchanged service credentials untouched so published evidence keeps its exact
connection fingerprint. The same harness can target SQLite or PostgreSQL.
Radarr, Sonarr series, and Sonarr episode mutations, automatic Plex refresh,
retained Plex identity, and retained qUI sources are live-verified. Injected
restart failures and signed browser flows remain live gates.

## Exit gates

The umbrella gauntlet is complete only when all of the following are true:

- Every scope-ledger item is implemented or deliberately resolved with recorded
  maintainer rationale and evidence.
- Every acceptance scenario is green in its required automated and live layers.
- A fresh repository search finds no untracked open Library Cleanup issue.
- Every accepted finding identifier has closure evidence; no P0 or P1 finding
  remains open, and no P2 finding that is in scope or introduced by the current
  delta remains open.
- Independent closure critics confirm the accepted findings and directly
  affected mutation paths. Out-of-scope discoveries have recorded maintainer
  rationale and follow-up disposition rather than silently expanding the
  feature.
- Formatting, shared build when applicable, root typecheck, full tests, lint,
  production build, database smoke tests, Docker builds, and browser
  verification pass.
- Hosted review has completed within the review budget, every actionable thread
  is resolved with evidence, and any material-boundary exception has passed its
  targeted additional review.
- The final pull request is marked ready, then all newly triggered reviews and
  CI are allowed to finish before a merge decision.
- Documentation describes the behavior that was actually verified.
