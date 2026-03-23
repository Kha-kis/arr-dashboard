# Skills

Skills provide domain-specific reasoning context loaded on demand.
They complement CLAUDE.md (general rules) and commands (workflow steps).

## When to use skills

Skills are loaded when Claude needs specialized knowledge that would bloat CLAUDE.md if always present. They improve reasoning quality within command workflows.

| Skill | Load when... |
|-------|-------------|
| `frontend-architecture` | Working on hooks, query infrastructure, component patterns, state management |
| `release-engineer` | Preparing releases, writing changelogs, assessing release scope |
| `integration-auditor` | Working with *arr service APIs, normalizers, Plex/Tautulli/Seerr data |
| `auth-reviewer` | Reviewing auth changes, OIDC flows, session management, encryption |
| `regression-hunter` | Reviewing diffs, stabilizing branches, assessing merge safety |

## How skills relate to commands

Commands define **what to do** (steps). Skills define **how to think** (context).

Example: `/review-pr 215` executes the review workflow. Loading `regression-hunter` first makes the review more thorough by providing knowledge of this repo's specific breakage patterns.

## Structure

Each skill file has frontmatter (`name`, `description`, `type`) and focused content under 150 lines. Skills contain only information Claude cannot reliably derive from reading the code — learned patterns, historical bugs, and architectural decisions.
