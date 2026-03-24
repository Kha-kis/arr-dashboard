Smart workflow dispatcher. Analyze the task, pick the right workflow, execute it.

Task: $ARGUMENTS

---

## Step 1: Classify the task

Inspect the task description, current branch, and git state to determine the workflow type:

| Signal | Workflow |
|--------|----------|
| `#NNN` or mentions a GitHub issue | **issue** |
| `PR`, `pull request`, or `#NNN` with PR context | **pr** |
| References a feature, module, or file path to improve | **feature** |
| `release`, `patch`, `ship`, version number like `2.x.x` | **release** |
| Branch has unreleased commits + task is about readiness | **stabilize** |
| None of the above | **ambiguous** — infer from git context below |

For ambiguous tasks, check:
- `git log --oneline origin/main..HEAD` — if there are unreleased commits, lean toward **stabilize**
- `git branch --show-current` — if branch name contains `fix/`, `feat/`, `release/`, use that hint
- `gh issue list --assignee @me --state open --limit 3` — if the task loosely matches an open issue, treat as **issue**

State your classification and reasoning in one line, then proceed.

---

## Step 2: Execute the workflow

### Issue workflow
1. Run `/fix-issue {issue_number}`
2. Run `/validate`
3. If on a feature branch with multiple commits, run `/stabilize-branch`

### PR workflow
1. Run `/review-pr {pr_number}`
2. If the PR touches auth, encryption, or routes: run `/security-pass` on affected files
3. If the PR is large (>10 files changed): run `/feature-audit` on the primary module
4. If the PR adds new pages, API routes, or feature panels: run `/trust-check` on affected files
5. Run `/validate` if CI status is not all green

### Feature workflow
1. Run `/feature-audit {target}` — get the action plan first
2. Present the top 3 findings to the user
3. Ask: "Which item should I implement?" (unless the task already specifies)
4. Implement the chosen item
5. Run `/validate`
6. **Trust gate**: Check if changed files include new pages (`app/*/page.tsx`), new API routes (`routes/*.ts`), new feature panels (`features/*/components/*`), or notification event types. If yes, run `/trust-check` on the affected files before declaring the work done.

### Release workflow
1. Run `/release-patch` — assess readiness
2. If ready: run `/prepare-changelog`
3. Present changelog for review
4. If approved: run `/release-prep {version}`

### Stabilize workflow
1. Run `/stabilize-branch`
2. If blockers found: fix them, then re-run `/validate`
3. Report merge readiness

---

## Step 3: Wrap up

After the workflow completes:
- Summarize what was done, what changed, and any remaining actions
- If there is a natural next step (e.g., "ready to merge" or "PR needs one more fix"), state it clearly
- Do NOT loop into additional workflows unless the user asks

---

## Rules
- Execute, don't just analyze. Prefer action over planning when the path is clear.
- Stop and ask only when the task is genuinely ambiguous or a decision has real trade-offs.
- Never reimplement command logic — delegate to the existing `/command` workflows.
- If a command fails or produces unexpected results, diagnose and report instead of retrying blindly.
- Load relevant skills when needed (e.g., `regression-hunter` for stabilize, `release-engineer` for releases, `auth-reviewer` for security-sensitive PRs).
