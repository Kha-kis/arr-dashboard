---
name: arr-fix-issue
description: Use when investigating, reproducing, fixing, or implementing a reported arr-dashboard GitHub issue, especially when the affected release line or safe issue linkage must be established.
---

# Fix an arr-dashboard issue safely

1. Read `AGENTS.md`, `CLAUDE.md`, the issue URL or number, every reporter
   comment, and all available reproduction evidence. Capture the reported
   version, deployment, database, integrations, expected behavior, actual
   behavior, and what remains unverified.
2. Resolve the real base and branch roles from the current `AGENTS.md` and
   repository state. Preserve unrelated worktree changes; do not infer a base
   from the issue age or a plausible code path.
3. Reproduce the reporter's actual scenario before editing. Trace the complete
   data and mutation path, and stop with an explicit verification gap when the
   reporter environment or exact scenario cannot be established.
4. Add a failing regression test where practical, then implement the smallest
   coherent correction. For destructive or upstream mutation paths, dispatch
   the required independent `data_safety_reviewer` and `regression_reviewer`
   passes before declaring readiness.
5. Use `$arr-validate` for final checks and live-verify user-visible behavior.
   Report the root cause, behavior changed, files, risks, validation evidence,
   residual uncertainty, and any forward-port or release action.
6. Do not commit, push, open a PR, comment, or close an issue unless the user
   authorized it. Default issue linkage to `Related to #N`. Use a standalone
   `Closes #N` only after exact reproduction and verification of the reported
   scenario; never use closure language merely because a test or code path is
   plausible. Sanitize commit messages as an independent auto-close surface.
