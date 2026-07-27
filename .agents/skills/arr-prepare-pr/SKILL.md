---
name: arr-prepare-pr
description: Assess arr-dashboard pull-request readiness and draft an accurate title and body from the real branch diff. Use when Codex is asked to prepare, open, refresh, or review a PR.
---

# Prepare an arr-dashboard pull request

1. Resolve the actual base from an existing PR or branch intent. Stable 2.x
   maintenance targets `main`; 3.0 work targets `next`.
2. Inspect commits, the triple-dot diff, working-tree changes, linked issues,
   and CI state. Surface unrelated or uncommitted work.
3. Use `$arr-review-change`, then `$arr-validate`. A validation failure remains
   visible even if it predates the branch.
4. Draft:
   - a conventional title under 70 characters describing the outcome;
   - a concise summary and domain-specific change sections;
   - an honest test plan using checks actually performed;
   - files changed when it helps reviewers;
   - risks, compatibility, and forward-port notes when applicable.
5. Default issue references to `Related to #N`. Upgrade to a standalone
   `Closes #N` line only after reproducing the exact reporter scenario before
   the fix and verifying it afterward. Check commit messages for auto-close
   language separately.
6. Never `@`-mention people. Refer to `Kha-kis` in backticks or prose.

Preparing text does not authorize committing, pushing, opening, updating, or
merging a PR. Perform those actions only when the user explicitly requests
them.
