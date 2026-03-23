Review pull request $ARGUMENTS

1. Read the PR: `gh pr view $ARGUMENTS`
2. Read the diff: `gh pr diff $ARGUMENTS`
3. Check CI status: `gh pr checks $ARGUMENTS`

Review for:
- **Correctness**: Does the code do what the PR claims?
- **Security**: Any auth bypasses, missing ownership checks, unvalidated input? For deep security review, use `/security-pass` on the affected files.
- **Consistency**: Does it follow CLAUDE.md conventions (query keys, polling constants, incognito mode, server state in hooks, etc.)?
- **Tests**: Are new behaviors tested? Are existing tests updated?
- **Edge cases**: Timezone issues, null handling, empty arrays, concurrent access?

Report findings as: Severity | Location | Issue | Suggestion

Only flag real issues — do not nitpick style when Biome handles formatting.
