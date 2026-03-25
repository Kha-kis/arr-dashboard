---
name: pr-writer
description: PR description style conventions and patterns for arr-dashboard
type: skill
---

# PR Writing Conventions

## Voice and Tone

- Factual, direct, no filler words
- Describe what changed and why — not how clever the implementation is
- No hype: avoid "amazing", "powerful", "comprehensive", "robust"
- No vagueness: avoid "various improvements", "minor fixes", "cleanup"
- Every bullet should be understandable to someone who hasn't read the code

## Structure Rules

- **Summary always first**: 1-3 sentences covering what, why, and user impact
- **Sections adapt to PR type**: features get full treatment, fixes get 3 sections, follow-ups get minimal
- **Files changed**: explicit path list with one-line descriptions (omit for PRs with <3 files)
- **Test plan always last** (before footer): checkboxes for verification steps
- **Footer**: always `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
- **Omit empty sections**: never include "Notes: None" or "Risks: N/A"

## Section Ordering (feature PRs)

1. Summary
2. Domain-specific sections (named by content, not generic — e.g., "New evaluators", "Signals", "Templates in /cleanup")
3. Behavior / UX impact (if user-facing)
4. Safety (if the feature has failure modes worth documenting)
5. Files changed
6. Notes / risks (only if non-trivial)
7. Test plan
8. Issue references (`Closes #NNN`)
9. Footer

## Writing Patterns

- **Bold sub-headers** within sections to group related items: `**Cross-Service** (requires Plex + Seerr):`
- **Backtick rule type names** and technical identifiers: `` `seerr_requester_watched` ``
- **Tables** for structured comparisons (signal types, version matrix, config options)
- **Checkboxes** in test plans: `- [ ]` for pending, `- [x]` for verified
- **Issue links** as `#NNN`, not full URLs
- **Conventional commit prefix** in title: `feat:`, `fix:`, `refine:`, `chore:`

## Anti-Patterns

- Don't list every file alphabetically — group by theme
- Don't repeat the title in the summary
- Don't describe the implementation approach unless it's architecturally significant
- Don't include deployment notes for zero-migration changes
- Don't pad the test plan with obvious items ("verify the app loads")
- Don't use numbered lists in the body — use bullets. Numbers are for steps only.

## Release PRs

Use Keep a Changelog categories: Fixed, Changed, Added, Dependencies. Each item gets a bold title and one-sentence description. Test plan includes TypeScript error count, test count, and build status.

## Scope Drift Refresh

When updating an existing PR after new commits:
- Rewrite the full body to match current state — don't append a "what's new" section
- The PR body should always read as if written fresh
- If the PR type changed (e.g., started as fix, grew into feature), update the structure accordingly
- Don't preserve stale sections from the old body — regenerate everything from the current diff

## Section Naming

Prefer domain-specific section names over generic ones:

| Instead of | Use |
|-----------|-----|
| "Changes" | "New evaluators", "Templates in /cleanup", "Request As selector" |
| "Details" | "Safety", "Behavior / UX impact", "Identity matching" |
| "Other" | Omit — if it doesn't deserve a heading, fold it into Summary |

The section name should tell a reviewer what they'll learn by reading it.
