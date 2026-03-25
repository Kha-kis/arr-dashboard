Prepare or refresh a pull request description for the current branch.

If `$ARGUMENTS` is a PR number, refresh that PR's description to match current branch state.

---

## Step 1: Gather context

Run these in parallel:
- `git branch --show-current` — confirm branch name
- `git log --oneline origin/main..HEAD` — all commits since divergence
- `git diff --stat origin/main..HEAD` — file change summary
- `git diff origin/main..HEAD` — full diff for analysis
- `gh pr list --head $(git branch --show-current) --json number,title,body,url --limit 1` — check if PR already exists

Note whether this is a **new PR** or a **refresh** of an existing one.

## Step 2: Classify PR type

Based on branch name, commits, and changed files:

| Signal | Type |
|--------|------|
| `feat/` branch, new functionality | **feature** |
| `fix/` branch, bug repair | **fix** |
| `release/` branch, version bump, changelog | **release** |
| Follow-up commits to a merged PR | **follow-up** |

## Step 3: Draft PR title

- Under 70 characters
- Prefix with conventional type: `feat:`, `fix:`, `refine:`, `chore:`
- Describe the user-facing outcome, not the implementation detail
- Examples: `feat: add "Request As" user selector in Discover`, `fix: require Plex data for requester evaluator`

## Step 4: Draft PR body

Use the `pr-writer` skill conventions. Adapt sections to the PR type — not every PR needs every section.

**Feature PRs** — full treatment:
```
## Summary
[1-3 sentences: what, why, user impact]

## [Domain-specific section name]
[Grouped by theme, not by file. Bold sub-headers for distinct features.
Name this section after the content: "New evaluators", "Request As selector",
"Templates in /cleanup" — not generic "What changed".]

## [Additional sections as needed]
[Behavior / UX impact, Safety, etc. — only if the content warrants a section.
See pr-writer skill for section naming guidance.]

## Files changed
- `path/to/file.ts` — one-line description

## Test plan
- [ ] Verification steps as checkboxes

Closes #NNN (if applicable)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Fix PRs** — lighter:
```
## Summary
[What was broken, what caused it, how it's fixed]

## Files changed
- `path/to/file.ts` — description

## Test plan
- [ ] Steps to verify the fix

Closes #NNN

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Release PRs** — changelog style:
```
## Summary
[Version tagline]

### Fixed
- **Title** — description

### Changed
- **Title** — description

### Added
- **Title** — description

### Dependencies
- package X.Y → X.Z

## Test plan
- [x] TypeScript: 0 errors
- [x] Tests: N passed
- [x] Build: N packages

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Follow-up PRs** — minimal:
```
## Summary
[What follow-up addresses, reference to original PR]

## Changes
- Bullet list

## Test plan
- [ ] Steps

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## Step 5: Detect linked issues

- Scan commit messages for `#NNN` references
- Check branch name for issue numbers (e.g., `feat/222-request-as`)
- If found, include `Closes #NNN` at the bottom of the body

## Step 6: Handle scope drift (refresh mode)

If a PR already exists:
1. Compare the existing PR body against the current branch state
2. Identify new commits since the PR was opened
3. Regenerate the full PR body reflecting all changes (don't append — rewrite)
4. Show the user the updated body for approval
5. If approved, update via: `gh pr edit <number> --title "..." --body "..."`

## Step 7: Readiness checks

Surface these as guidance before offering to create/update. Not hard blockers — just awareness.

- **Working tree clean?** `git status --short` — warn if uncommitted changes exist
- **Branch pushed?** `git log origin/$(git branch --show-current)..HEAD 2>/dev/null` — note if local commits need pushing
- **CI status?** `gh pr checks` or `gh run list --branch $(git branch --show-current) --limit 1` — report if known
- **Trust check needed?** If changed files include new pages (`app/*/page.tsx`), new API routes (`routes/*.ts`), or new feature panels (`features/*/components/*`), suggest running `/trust-check` first

Format as a short checklist:
```
### Readiness
- ✓ Working tree clean
- ✓ Branch pushed to origin
- ⚠ CI status unknown (no runs found)
- ℹ Changed files include new feature components — consider `/trust-check`
```

## Step 8: Present and act

- Show the drafted title and body to the user
- Show the readiness checklist
- Ask: **"Create PR?"** or **"Update PR?"** depending on mode
- If yes and no PR exists: push branch if needed, then create via `gh pr create`
- If yes and PR exists: update via `gh pr edit`
- If no: output the text for manual use

## Rules

- No hype words ("amazing", "powerful", "comprehensive")
- No vague descriptions ("various improvements", "minor fixes")
- Each bullet should be understandable without reading the code
- User-facing changes come before internal/architecture changes
- Test plan is always included, even for small PRs
- Always end with the Claude Code footer
- Omit sections that would be empty — don't include "Notes / risks: None"
