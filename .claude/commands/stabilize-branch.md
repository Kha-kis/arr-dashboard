Assess the current branch for merge/release readiness.

1. **Resolve the base branch**:
   - Check the current branch and any open PR.
   - If a PR exists, use its `baseRefName`.
   - Without a PR, determine whether the task is stable 2.x maintenance
     (`main`) or 3.0 work (`next`) from the branch point and task intent.
   - If both bases are plausible, stop and ask. Never silently default to
     `main`.

2. **Branch overview**:
   - Fetch the resolved base.
   - Run `git log --oneline origin/<base>..HEAD`.
   - Run `git diff --stat origin/<base>...HEAD` and inspect the full diff.
   - Surface pre-existing commits and unrelated working-tree changes.

3. **Regression risk**:
   - Identify files with the most changes — these are highest regression risk
   - Check if changed files have corresponding tests
   - Look for changes to shared utilities, hooks, or types that affect multiple consumers
   - Load the `regression-hunter` skill and apply its current checklist
   - For safety-critical mutations, run the `data-safety-reviewer` agent

4. **Validation**:
   - Run `/validate`
   - Report any failures with root cause

5. **Merge risk**:
   - Compare with the current `origin/<base>` and report divergence/conflicts
   - Are there changes to `package.json`, `pnpm-lock.yaml`, or `schema.prisma` that could conflict?
   - Are there Dependabot PRs that should be merged first or after?

6. **Cleanup check**:
   - Are there debug `console.log` statements?
   - Are there commented-out code blocks?
   - Are there TODO comments introduced in this branch?
   - Are there uncommitted changes that should be staged?
   - Are generated artifacts, credentials, snapshots, or local runtime data in
     the diff?

7. **Trust check** (if applicable):
   - Check if changed files include new pages (`app/*/page.tsx`), new API routes, or new feature panels
   - If yes: run `/trust-check` on the affected files (privacy, ownership, signal accuracy, service gating, action links, overlap)
   - If no: skip — not needed for bug fixes, dependency updates, or refactors

8. **Recommendation**:
   - Safe to merge? Yes/No with reasoning
   - If no: list specific blockers
   - If yes: recommend squash merge and list any forward-port, release, issue,
     or live-monitoring action
