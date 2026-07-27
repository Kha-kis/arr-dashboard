Prepare release v$ARGUMENTS

This is the mechanical execution step for a stable release from `main`. Run
`/release-patch` first for readiness assessment. For a 3.0 prerelease from
`next`, use the prerelease section of `docs/RELEASING.md` instead.

Follow the release checklist exactly:

1. **Version bump**: Update `package.json` version field
2. **Changelog**: Use `/prepare-changelog` output, add to `CHANGELOG.md`
3. **README**: Update version tagline at top + add entry to version tags table
4. **DOCKERHUB**: Update version tagline at top + add entry to version tags table
5. **CLAUDE.md**: Update version at bottom
6. **Wiki**: Update version in `Home.md` and `Troubleshooting.md` (clone from `arr-dashboard.wiki.git` if not at `/tmp/arr-wiki`)

Then validate (or run `/validate`):
- `pnpm run format`
- `pnpm --filter @arr/shared build` if shared changed
- `pnpm run typecheck`
- `pnpm run test`
- `pnpm run lint`
- `pnpm run build`

Commit as: `chore: v$ARGUMENTS release — changelog and version bump`

Do NOT create the tag or GitHub release — that happens after CI passes.
