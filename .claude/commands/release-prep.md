Prepare release v$ARGUMENTS

Follow the release checklist exactly:

1. **Version bump**: Update `package.json` version field
2. **Changelog**: Add new section to `CHANGELOG.md` with all changes since last release
3. **README**: Update version tagline at top + add entry to version tags table
4. **DOCKERHUB**: Update version tagline at top + add entry to version tags table
5. **CLAUDE.md**: Update version at bottom

Then validate:
- `pnpm --filter @arr/web exec tsc --noEmit`
- `pnpm --filter @arr/api exec tsc --noEmit`
- `pnpm run test`
- `pnpm run build`

Commit as: `chore: v$ARGUMENTS release — changelog and version bump`

Do NOT create the tag or GitHub release — that happens after CI passes.
