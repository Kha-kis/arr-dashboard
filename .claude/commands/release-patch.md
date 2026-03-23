Prepare a patch release from the current branch.

1. **Review scope**: Run `git log --oneline origin/main..HEAD` to see all changes. Categorize each commit as:
   - User-facing fix (bug fix, behavior change)
   - Maintenance (dependency update, CI change)
   - Architecture/DX (refactors, hook extraction, code quality)
   - Documentation

2. **Assess readiness**:
   - Are all fixes validated with tests?
   - Are there any incomplete changes that shouldn't ship?
   - Are there open issues that should block this release?
   - Check `gh issue list --state open` for blockers

3. **Run validation**: Execute `/validate` checks (typecheck, lint, test, build)

4. **Draft release notes**: Execute `/prepare-changelog` to generate polished notes

5. **Check version references**: Confirm these are up to date (or flag what needs updating):
   - `package.json` version
   - `README.md` version tagline + tags table
   - `DOCKERHUB.md` version tagline + tags table
   - `CHANGELOG.md` entry
   - `CLAUDE.md` version footer

6. **Report**: Summarize release readiness with:
   - Changes included (categorized)
   - Validation results
   - Any risks or blockers
   - Recommended version number

Do NOT create the tag or GitHub release. That happens after review.
