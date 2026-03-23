Fix GitHub issue $ARGUMENTS

1. Read the issue with `gh issue view $ARGUMENTS`
2. Understand the root cause — trace the code, don't guess
3. Create a fix on the current branch (never edit main directly)
4. Write or update tests that validate the fix
5. Run `pnpm --filter @arr/web exec tsc --noEmit` and `pnpm --filter @arr/api exec tsc --noEmit`
6. Run `pnpm run test`
7. Commit with message: `fix: Description (#ISSUE_NUMBER)`
8. Comment on the issue with what was fixed and how

If the issue is unclear, ask for clarification before implementing.
