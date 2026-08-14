---
name: arr-prepare-pr
description: Use when Codex is asked to prepare, open, refresh, review, or assess merge readiness for an arr-dashboard pull request.
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
7. For an existing PR or an authorized merge, run a final GitHub audit after
   the last push:
   - wait for the configured GitHub Codex result—a submitted review or its
     no-findings `+1` reaction—and every PR-triggered check, including
     downstream E2E, Docker, and smoke jobs;
   - inspect submitted reviews, PR comments, inline review comments, and
     unresolved review threads rather than relying on `gh pr view` alone;
   - compare each review's commit with the current head and check whether
     older-commit findings still apply;
   - give every in-scope finding an explicit disposition and resolve actionable
     threads only after the correction is verified.

Use the authenticated `gh` API when available and query PR reactions explicitly;
silence is not a no-findings result. If the configured review signal or review
threads cannot be inspected, report the gap and do not merge.

Do not merge while a configured review or any PR-triggered check is pending,
even when GitHub reports the minimum branch-protection checks as mergeable.
After the single correction batch, request another broad review only when the
correction materially changes the behavior or risk boundary.

Preparing text does not authorize committing, pushing, opening, updating, or
merging a PR. Perform those actions only when the user explicitly requests
them.
