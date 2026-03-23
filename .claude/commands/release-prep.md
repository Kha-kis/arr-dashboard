Prepare release v$ARGUMENTS

This is the mechanical execution step. Run `/release-patch` first for readiness assessment.

Follow the release checklist exactly:

1. **Version bump**: Update `package.json` version field
2. **Changelog**: Use `/prepare-changelog` output, add to `CHANGELOG.md`
3. **README**: Update version tagline at top + add entry to version tags table
4. **DOCKERHUB**: Update version tagline at top + add entry to version tags table
5. **CLAUDE.md**: Update version at bottom

Then validate (or run `/validate`):
- `pnpm --filter @arr/web exec tsc --noEmit`
- `pnpm --filter @arr/api exec tsc --noEmit`
- `pnpm run test`
- `pnpm run build`

Commit as: `chore: v$ARGUMENTS release — changelog and version bump`

Do NOT create the tag or GitHub release — that happens after CI passes.
