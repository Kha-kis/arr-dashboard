# 2.x Stabilization and 3.0 Parity Ledger

This ledger is the completion authority for the final bounded 2.x
stabilization cycle. `main` and `next` have divergent architecture and squash
history, so matching commit counts or subjects do not prove behavioral parity.

## Release boundary

- **Blocker:** reproduced stable regression, deletion/data-safety defect,
  authentication bypass, wrong-upstream mutation, or diagnosed supported-runtime
  outage.
- **Evidence gate:** the report remains open, but no speculative code is
  authorized until the listed evidence distinguishes the cause.
- **Excluded:** enhancement or new integration that belongs to 3.0 or a later
  roadmap.

## Post-v2.23.0 stable PR parity

The rows below classify the complete first-parent `main` range after
`v2.23.0`. A row is complete only when its cited `next` implementation or
non-applicability evidence has been inspected.

| Stable issue/PR | Stable status | Stable evidence | 3.0 parity | `next` PR/evidence | Release bucket | Disposition |
|---|---|---|---|---|---|---|
| [#628](https://github.com/Kha-kis/arr-dashboard/pull/628) | Merged | Codex-native project workflows | Already equivalent | PR #696 / `38bce1a3` carries `AGENTS.md`, project skills, reviewers, and engineering docs | `release:defer` | No code port required |
| [#629](https://github.com/Kha-kis/arr-dashboard/pull/629) | Merged | Shared-media ownership and deletion protection | Already equivalent | PR #633 plus current shared Plex safety suites | `release:patch-now` | Verified equivalent |
| [#634](https://github.com/Kha-kis/arr-dashboard/pull/634) | Merged | Cleanup coordination, maintenance gate, leases, and recovery | Already equivalent | PR #635 plus maintenance-gate, run-lease, and scheduler-recovery tests | `release:patch-now` | Verified equivalent |
| [#636](https://github.com/Kha-kis/arr-dashboard/pull/636) | Merged | Accept null Plex player access tokens | Already equivalent | Exact forward-port PR #637 | `release:patch-batch` | Verified equivalent |
| [#638](https://github.com/Kha-kis/arr-dashboard/pull/638) | Merged | Normalize bodyless POST requests | Already equivalent | Exact forward-port PR #639 | `release:patch-batch` | Verified equivalent |
| [#640](https://github.com/Kha-kis/arr-dashboard/pull/640) | Merged | Correct Pulse cleanup links | Already equivalent | Exact forward-port PR #641 | `release:patch-batch` | Verified equivalent |
| [#642](https://github.com/Kha-kis/arr-dashboard/pull/642) | Merged | Show executed approvals in Approved | Already equivalent | Exact forward-port PR #643 | `release:patch-batch` | Verified equivalent |
| [#644](https://github.com/Kha-kis/arr-dashboard/pull/644) | Merged | Limit Seerr attention to failed requests | Already equivalent | Exact forward-port PR #645 | `release:patch-batch` | Verified equivalent |
| [#646](https://github.com/Kha-kis/arr-dashboard/pull/646) | Merged | Repair qUI webhook registration | Already equivalent | Exact forward-port PR #647 | `release:patch-now` | Verified equivalent |
| [#648](https://github.com/Kha-kis/arr-dashboard/pull/648) | Merged | Align security posture with External URL | Already equivalent | Exact forward-port PR #649 | `release:patch-now` | Verified equivalent |
| [#651](https://github.com/Kha-kis/arr-dashboard/pull/651) | Merged | Secure OIDC administrator linking | Already equivalent | Exact forward-port PR #652 | `release:patch-now` | Verified equivalent |
| [#653](https://github.com/Kha-kis/arr-dashboard/pull/653) | Merged | Authentik linked-account lifecycle coverage | Already equivalent | Exact forward-port PR #654 | `release:defer` | Verified equivalent |
| [#656](https://github.com/Kha-kis/arr-dashboard/pull/656) | Merged | Retained Radarr variant and peer ownership revalidation | Already equivalent | PR #697 and `shared-plex-safety.test.ts` | `release:patch-now` | Verified equivalent |
| [#658](https://github.com/Kha-kis/arr-dashboard/pull/658) | Merged | Shared Sonarr/Plex ownership and exact episode proof | Already equivalent | PR #697 and `shared-plex-sonarr-safety.test.ts` | `release:patch-now` | Verified equivalent |
| [#661](https://github.com/Kha-kis/arr-dashboard/pull/661) | Merged | Episode-scoped Sonarr cleanup | Already equivalent | PR #698 provides native episode scope, qUI proof, API, UI, and safety tests | `release:next-minor` | Verified equivalent |
| [#668](https://github.com/Kha-kis/arr-dashboard/pull/668) | Merged | Durable cleanup policy, selection, audit, rescan, leases, and recovery | Required | PRs #697-#699 cover only part; Wave 3A-3C contains the remaining policy/audit/rescan work but must be replayed onto current `next` | `release:patch-now` | Land preserved Wave 3A, 3B, and 3C after stable stabilization |
| [#669](https://github.com/Kha-kis/arr-dashboard/pull/669) | Merged | Signed cleanup browser-policy gate | Required | No merged `next` equivalent for the signed browser-policy and provenance scripts | `release:defer` | Port the harness gate independently of application behavior |
| [#670](https://github.com/Kha-kis/arr-dashboard/pull/670) | Merged | Actionable Jellyfin cache failures and guarded publication | Already equivalent | PR #700 provider generations, single-flight, scheduler, Pulse, and cache tests | `release:patch-now` | Verified equivalent |
| [#671](https://github.com/Kha-kis/arr-dashboard/pull/671) | Merged | Radarr IMDb sync-to-cleanup regression | Required | Generic IMDb evaluators exist, but the exact sync-to-cleanup regression is absent | `release:defer` | Add the exact Radarr cache write followed by `imdb_rating` evaluation test |
| [#676](https://github.com/Kha-kis/arr-dashboard/pull/676) | Merged | TRaSH deployment state foundation | Required | No deployment-state schema, backup/recovery, or maintenance-gate parity on `next` | `release:next-minor` | Port first in the ordered TRaSH parity stack |
| [#677](https://github.com/Kha-kis/arr-dashboard/pull/677) | Merged | TRaSH deployment ownership and operation safety | Required | No active ownership, operation gate, target identity, or legacy rebinding parity | `release:next-minor` | Port after #676 behavior |
| [#678](https://github.com/Kha-kis/arr-dashboard/pull/678) | Merged | Exact TRaSH deployment-state capture | Required | No current `next` captured-state contract or round-trip tests | `release:next-minor` | Port after safety primitives |
| [#679](https://github.com/Kha-kis/arr-dashboard/pull/679) | Merged | Durable partial/uncertain TRaSH recovery | Required | No restart reconciliation, retry progress, or honest notification parity | `release:next-minor` | Port after state capture |
| [#680](https://github.com/Kha-kis/arr-dashboard/pull/680) | Merged | Bind TRaSH execution to reviewed authority | Required | No execution token, current-target revalidation, or writer-lock parity | `release:next-minor` | Port after recovery foundation |
| [#681](https://github.com/Kha-kis/arr-dashboard/pull/681) | Merged | Preserve exact cloned profile target | Required | No source/target recovery and same-title collision parity | `release:next-minor` | Port after reviewed execution authority |
| [#682](https://github.com/Kha-kis/arr-dashboard/pull/682) | Merged | Recover profile scores and aliases across instances | Required | No negative/instance-only score, alias, or same-title target parity | `release:next-minor` | Port after exact clone target identity |
| [#685](https://github.com/Kha-kis/arr-dashboard/pull/685) | Merged | Plex 1.43-compatible history refresh | Already equivalent | PR #700 uses one-key sorting and preserves complete-pagination tests | `release:patch-batch` | Verified equivalent |
| [#686](https://github.com/Kha-kis/arr-dashboard/pull/686) | Merged | Skip disabled TRaSH auto-sync targets | Required | No execution-time enabled-state/alias reread and re-enable parity | `release:patch-now` | Port after the TRaSH authority stack |
| [#687](https://github.com/Kha-kis/arr-dashboard/pull/687) | Merged | Incognito privacy for TRaSH plans and diagnostics | Required | No deployment-plan privacy parity for names, conflicts, instances, and diagnostics | `release:patch-batch` | Port with the native `next` TRaSH UI |
| [#688](https://github.com/Kha-kis/arr-dashboard/pull/688) | Merged | Refresh current watch evidence before selection | Already equivalent | PR #699 requires external evidence refresh before authority reads | `release:patch-now` | Verified equivalent |
| [#691](https://github.com/Kha-kis/arr-dashboard/pull/691) | Merged | Deterministic cleanup E2E/Compose harness | Required | No merged `next` parity for Compose ownership, bootstrap, isolation, and live scripts | `release:defer` | Port as a focused harness change |
| [#693](https://github.com/Kha-kis/arr-dashboard/pull/693) | Merged | Ignore stale Plex history outside current library | Already equivalent | PR #700 current-library map and incomplete-history generation-retention tests | `release:patch-now` | Verified equivalent |
| [#709](https://github.com/Kha-kis/arr-dashboard/pull/709) | Merged | Restore the stable formatter baseline for existing OIDC files | Not applicable | Formatter-only stable-line cleanup with no runtime behavior to forward-port | No release bucket | No code port or release note required |
| [#710](https://github.com/Kha-kis/arr-dashboard/pull/710) | Merged | Honor the selected Sonarr approval server and its defaults | Already equivalent | PR #712 contains the native `next` routing correction and regression coverage | `release:patch-now` | Verified equivalent |
| [#711](https://github.com/Kha-kis/arr-dashboard/pull/711) | Merged | Mask approval routing labels and distinguish colliding aliases | Already equivalent | PR #712 contains the same privacy and alias-collision behavior | `release:patch-now` | Verified equivalent |

Parity summary: **21 already equivalent, 13 required, 1 not applicable**.
None of these stable PRs currently carries a forward-looking `release:*` label;
the proposed buckets above must be reviewed before labels are applied.

## Reported issues

| Stable issue/PR | Stable status | Stable evidence | 3.0 parity | `next` PR/evidence | Release bucket | Disposition |
|---|---|---|---|---|---|---|
| [#706](https://github.com/Kha-kis/arr-dashboard/issues/706) / [PR #710](https://github.com/Kha-kis/arr-dashboard/pull/710) / [PR #711](https://github.com/Kha-kis/arr-dashboard/pull/711) | Fixed on `main` | RED/GREEN rendered coverage proves Sonarr B sends explicit server/profile/root overrides while an unchanged default approval remains override-free; PR #711 masks routing labels in incognito mode and keeps colliding aliases distinguishable; local and GitHub gates passed | Equivalent | [PR #712](https://github.com/Kha-kis/arr-dashboard/pull/712) merged the native `next` forward-port with the same routing, privacy, and alias-collision regressions; all checks passed and Codex returned a no-findings reaction | `release:patch-now` | Retain the stable fix in the final 2.x release candidate; no further #706 code work remains |
| [#703](https://github.com/Kha-kis/arr-dashboard/issues/703) | Confirmed blocker; queued after #706 | Shared schemas and single-rule controls define Jellyfin operators, but the composite `ConditionParamsFields` has no Jellyfin cases and returns `null` | Required | The same shared composite renderer is used on current `next` | `release:patch-now` | Add component regression coverage and explicit Jellyfin composite rendering on both lines |
| [#694](https://github.com/Kha-kis/arr-dashboard/issues/694) | Evidence gate | Attached log shows repeatable 544-to-578 MB heap jumps after clustered media cache refreshes, but no fatal OOM, shutdown, or container exit is captured | Required only if a stable defect is reproduced | Current 3.0 provider refresh scheduling must be tested with the same bounded large-inventory fixture if the defect is confirmed | Unassigned until diagnosis | Request crash-time evidence and run a disposable reproduction; do not block release indefinitely without a diagnosed defect |
| [#689](https://github.com/Kha-kis/arr-dashboard/issues/689) | Confirmed data-safety blocker | A stable proxy can route all consistent reads to the same wrong physical server; URL, credentials, and cache generation remain unchanged, allowing wrong-server evidence to authorize cleanup | Required | Current connection fingerprints/generations do not bind Plex, Jellyfin, Emby, or Tautulli data to durable upstream identity; Tautulli's official API exposes the configured Plex identifier but the current client does not consume it | `release:patch-now` | Add durable server-derived binding and fail closed while unverified or mismatched; add typed Tautulli identity support and require its verified Plex association |
| [#675](https://github.com/Kha-kis/arr-dashboard/issues/675) / [PR #693](https://github.com/Kha-kis/arr-dashboard/pull/693) | Fix merged; published-image verification required | PR #693 contains current-library filtering, incomplete-history fail-closed checks, cache revalidation, exact target binding, policy revalidation, and ARR recheck | Focused parity audit required | Current `next` has provider cache guards in PR #700, but equivalence to every PR #693 behavior must be demonstrated separately | `release:patch-now` | Verify both Plex cache generations on the published candidate and complete the parity row before closure |
| [#673](https://github.com/Kha-kis/arr-dashboard/issues/673) / [PR #685](https://github.com/Kha-kis/arr-dashboard/pull/685) | Original HTTP 400 fixed; release verification required | Compound Plex history sort was replaced with a compatible complete-pagination request | Focused parity audit required | Verify the current `next` Plex client does not send the rejected compound sort | `release:patch-now` | Close only after candidate verification and release-specific follow-up |
| [#674](https://github.com/Kha-kis/arr-dashboard/issues/674) / [PR #686](https://github.com/Kha-kis/arr-dashboard/pull/686) | Exact never-runs scenario not reproduced; related disabled-target defect fixed | Stable tests and live Sonarr/PostgreSQL verification prove disabled targets are skipped and pending updates apply after re-enable | Focused parity audit required | Verify native 3.0 TRaSH scheduler behavior and disabled-target handling | `release:patch-batch` | Time-box one scheduler reproduction; leave open and non-blocking if required reporter logs remain unavailable |
| [#427](https://github.com/Kha-kis/arr-dashboard/issues/427) | Historical evidence reconciliation | Prior paginator, heap-retention, and allocator fixes received large-library soak evidence; no current reporter confirmation closes the umbrella conclusively | Already equivalent must be revalidated | 3.0 carries later memory/supply-chain/runtime changes but needs release-candidate soak evidence | No new release bucket unless code changes | Reconcile prior fixes and current soak evidence; otherwise retain as the historical umbrella linked to #694 |

## Excluded enhancements

| Stable issue/PR | Stable status | Stable evidence | 3.0 parity | `next` PR/evidence | Release bucket | Disposition |
|---|---|---|---|---|---|---|
| [#664](https://github.com/Kha-kis/arr-dashboard/issues/664) | Excluded enhancement | Connected-service version display is not a stable regression | Roadmap candidate | No release-blocking parity requirement | `release:defer` | Revisit on `next` after stabilization |
| [#632](https://github.com/Kha-kis/arr-dashboard/issues/632) | Excluded enhancement | NZBHydra2 is a new integration | Roadmap candidate | No release-blocking parity requirement | `release:defer` | Keep open for integration roadmap |
| [#627](https://github.com/Kha-kis/arr-dashboard/issues/627) | Excluded enhancement | NZBGet/SABnzbd workflow is not defined as a stable regression | Roadmap candidate | No release-blocking parity requirement | `release:defer` | Keep open pending a concrete workflow definition |
| [#624](https://github.com/Kha-kis/arr-dashboard/issues/624) | Excluded enhancement | Hunt selection ordering is requested new behavior | Roadmap candidate | No release-blocking parity requirement | `release:defer` | Revisit after 3.0 stabilization |
| [#623](https://github.com/Kha-kis/arr-dashboard/issues/623) | Excluded enhancement | Relaxed-password support changes security policy | Roadmap candidate | No release-blocking parity requirement | `release:defer` | Keep outside final 2.x stabilization |
| [#622](https://github.com/Kha-kis/arr-dashboard/issues/622) | Excluded enhancement | Additional Arr and related applications are new integrations | Roadmap candidate | No release-blocking parity requirement | `release:defer` | Split concrete integrations into focused future issues |
| [#487](https://github.com/Kha-kis/arr-dashboard/issues/487) | Excluded from stable; 3.0 feature audit | Tracearr integration and explicit historical-provider selection are implemented on `next` | Native 3.0 | PRs #555-#559 and #701-#708 provide the current implementation; Tracearr 2.0 additions require separate scope | `release:defer` | Audit issue acceptance against current Tracearr API before closure |
