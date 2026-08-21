## Summary

<!-- What outcome does this PR deliver? Keep this concise. -->

## Related issue

<!--
Use `Related to #N` while acceptance is incomplete.
Use a standalone `Closes #N` only after reproducing and verifying the reporter's actual scenario.
-->

## Scope

<!-- List the behavior, files, or contributor surfaces this PR is authorized to change. -->

## Non-goals

<!-- List adjacent work this PR will not take on. -->

## Acceptance criteria

<!-- Use concrete, verifiable outcomes. -->

- [ ]

## Changes

<!-- Briefly list what changed and why. -->

## Risk classification

<!-- Select exactly one. See docs/CODE-REVIEW.md. A reviewer may escalate risk. -->

- [ ] Trivial
- [ ] Standard
- [ ] Safety-critical

## Validation

<!-- Record commands and live checks actually run. Mark non-applicable checks with a short reason. -->

- [ ] Relevant deterministic validation passed
- [ ] Focused tests passed, when applicable
- [ ] `pnpm run format`
- [ ] `pnpm --filter @arr/shared build`, when shared changed
- [ ] `pnpm run typecheck`
- [ ] `pnpm run test`
- [ ] `pnpm run lint`
- [ ] `pnpm run build`, when required by the change
- [ ] User-visible behavior was live-verified, when applicable
- [ ] New queries use centralized query keys and polling constants, when applicable
- [ ] New sensitive displays preserve incognito behavior, when applicable
- [ ] New Prisma queries for user-owned resources include `userId`, when applicable
- [ ] Optional-service gating is verified for new pages, panels, or signals, when applicable
- [ ] User-facing counts are precise rather than proxies, when applicable
- [ ] Action links reach the correct page with required parameters, when applicable
- [ ] Duplicate surfaces were checked and any overlap is justified, when applicable

## Review plan

- Initial broad-reviewed head: <!-- SHA, or N/A for Trivial -->
- Correction head: <!-- SHA or N/A -->
- Targeted delta range: <!-- reviewed-head..corrected-head, or N/A -->
- Material-scope change declared? <!-- No, or Yes with maintainer decision and reason -->
- Independent regression reviewer: <!-- reviewer/result, or N/A with reason -->
- Independent data-safety reviewer, when required: <!-- reviewer/result, or N/A -->
- GitHub Codex review head: <!-- SHA, pending, or N/A for Trivial -->
- Maintainer decision: <!-- Pending, merge, split, abandon/rebuild, or new review epoch -->

## Finding disposition

<!-- Classify every finding against the actual base and this PR's declared contract. -->

| ID | Severity | Classification | Reproduced evidence | Disposition | Follow-up |
| --- | --- | --- | --- | --- | --- |
| — | — | — | No findings yet | Pending review | — |

## Final merge gate

- [ ] Exact-head CI is green
- [ ] Acceptance criteria passed
- [ ] No unresolved in-scope review threads remain
- [ ] Valid out-of-scope findings are linked or dispositioned
- [ ] Current head is covered by the broad review or a targeted delta review
- [ ] Base is unchanged, or meaningful overlap was reviewed
- [ ] Maintainer approved merge
- [ ] Post-merge verification is planned
