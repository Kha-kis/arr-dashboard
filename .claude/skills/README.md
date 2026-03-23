# Skills

Skills are loaded on-demand (not every session) for domain-specific workflows.
Use skills for detailed knowledge that would bloat CLAUDE.md if always loaded.

## When to create a skill vs a command

- **Command** (`/command-name`): A repeatable workflow with steps to execute.
  Examples: fix-issue, release-prep, validate, review-pr.

- **Skill**: Domain expertise loaded when Claude needs specialized context.
  Examples: TRaSH Guides deployment logic, OIDC provider configuration,
  library cleanup rule evaluation, notification channel setup.

## Structure

Each skill file should:
1. Be named descriptively: `trash-guides.md`, `oidc-config.md`
2. Start with a one-line description of when to load it
3. Contain only information Claude cannot derive from reading the code
4. Stay under 200 lines — if longer, it belongs in `@docs/` instead

## Current skills

None yet. Skills will be added as specific domain workflows are identified
that benefit from pre-loaded context rather than code inspection.
