---
name: arr-validate
description: Run and report the arr-dashboard verification gauntlet. Use when Codex is asked to validate, test, check, stabilize, or assess readiness of a change, and before preparing a pull request.
---

# Validate arr-dashboard

1. Read `AGENTS.md` and resolve the change scope with `git status` and the diff
   against the actual base branch.
2. Run:

   ```bash
   pnpm run format
   pnpm --filter @arr/shared build   # only when packages/shared changed
   pnpm run typecheck
   pnpm run test
   pnpm run lint
   ```

3. Run `pnpm run build` for release-sensitive, dependency, Docker, routing, or
   substantial frontend changes.
4. Live-verify user-visible behavior in a real browser. Use populated fixtures
   for data-dependent behavior.
5. When a gate fails, determine whether the failure exists on the untouched
   base. Do not bypass it or attribute it to the branch without evidence.
6. Report `Check | Status | Details`, including skipped checks and why they were
   not applicable.

Validation-only requests authorize diagnosis, not unrelated fixes.
