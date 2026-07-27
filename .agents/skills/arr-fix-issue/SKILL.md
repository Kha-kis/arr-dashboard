---
name: arr-fix-issue
description: Diagnose and fix an arr-dashboard GitHub issue with exact reproduction, release-line selection, regression coverage, and safe issue-linking. Use when Codex is asked to investigate, fix, or implement a reported issue.
---

# Fix an arr-dashboard issue

1. Read `AGENTS.md`, `CLAUDE.md`, the issue, and all relevant comments.
2. Record the reported version, deployment, database, integrations, expected
   behavior, actual behavior, and evidence.
3. Resolve the release line:
   - stable 2.x user impact targets `main`;
   - 3.0 beta work targets `next`;
   - reproduce both when both may be affected, fixing stable first and
     forward-porting separately.
4. Fetch the intended base and create a focused branch. Preserve unrelated
   worktree changes.
5. Reproduce the reporter's actual scenario. Trace the real data and mutation
   path instead of fixing a plausible symptom.
6. Add a regression test that fails before the fix, then implement the smallest
   coherent correction.
7. For destructive or upstream mutation paths, delegate an independent review
   to the `data_safety_reviewer` project agent before declaring readiness.
8. Use `$arr-validate` for the final checks and live-verify user-visible fixes.
9. Report the root cause, behavior changed, files, risks, validation, and any
   forward-port or patch-release requirement.

Do not commit, push, open a PR, comment, or close an issue unless requested.
Default to `Related to #N`; use standalone `Closes #N` only after exact
reproduction and verification. Sanitize commit messages independently.
