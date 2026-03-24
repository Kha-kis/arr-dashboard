Assess the current branch for merge/release readiness.

1. **Branch overview**:
   - `git log --oneline origin/main..HEAD` — list all commits
   - `git diff --stat origin/main..HEAD` — file change summary
   - `git branch --show-current` — confirm branch name

2. **Regression risk**:
   - Identify files with the most changes — these are highest regression risk
   - Check if changed files have corresponding tests
   - Look for changes to shared utilities, hooks, or types that affect multiple consumers

3. **Validation**:
   - Run typecheck, lint, test, build (same as `/validate`)
   - Report any failures with root cause

4. **Merge risk**:
   - `git fetch origin main && git diff origin/main...HEAD --stat` — check for conflicts
   - Are there changes to `package.json`, `pnpm-lock.yaml`, or `schema.prisma` that could conflict?
   - Are there Dependabot PRs that should be merged first or after?

5. **Cleanup check**:
   - Are there debug `console.log` statements?
   - Are there commented-out code blocks?
   - Are there TODO comments introduced in this branch?
   - Are there uncommitted changes that should be staged?

6. **Trust check** (if applicable):
   - Check if changed files include new pages (`app/*/page.tsx`), new API routes, or new feature panels
   - If yes: run `/trust-check` on the affected files (privacy, ownership, signal accuracy, service gating, action links, overlap)
   - If no: skip — not needed for bug fixes, dependency updates, or refactors

7. **Recommendation**:
   - Safe to merge? Yes/No with reasoning
   - If no: list specific blockers
   - If yes: recommended merge strategy (squash vs merge) and any post-merge actions needed
