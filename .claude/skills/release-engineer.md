---
name: release-engineer
description: Specialized knowledge for preparing releases — version management, changelog quality, scope discipline, and the files that must be updated together
type: skill
---

# Release Engineering Knowledge

Load this skill when preparing releases, writing changelogs, or assessing release readiness.

## Version File Inventory

These files must ALL be updated together on every release. Missing any one causes visible inconsistency:
1. `package.json` — `"version"` field
2. `CHANGELOG.md` — new section at top
3. `README.md` — version tagline (line 3) + version tags table (~line 203)
4. `DOCKERHUB.md` — version tagline (line 3) + version tags table (~line 90)
5. `CLAUDE.md` — version footer (last line)
6. **Wiki** — version in `Home.md` and `Troubleshooting.md` (separate git repo: `arr-dashboard.wiki.git`)

## Changelog Style

This repo uses Keep a Changelog format with these categories:
- **Fixed** — bug fixes, always with issue number (#NNN)
- **Changed** — behavior changes, architecture improvements, refactors
- **Added** — new features, test infrastructure, documentation
- **Dependencies** — compact list of package updates

Rules:
- Bold title per item, then one-sentence description
- User-facing fixes come first
- No hype words, no vague descriptions
- Each item understandable without reading code
- Architecture changes separated from user-visible changes

## Release Types

- **Patch** (x.y.Z): Bug fixes, dependency updates, internal improvements. No new features. Most releases are patches.
- **Minor** (x.Y.0): New features, new integrations, significant UI additions. These get detailed changelogs.
- **The v2.9.0 release** was the largest — added Plex, Tautulli, Seerr, Notifications, Library Cleanup, Naming Deployment, Runtime Validation, and Health Monitoring.

## Scope Discipline

The biggest release risk is scope creep. A patch release should contain:
- The specific fixes/changes on the branch
- Dependency updates if included
- Documentation updates for the changes

It should NOT contain:
- Speculative refactors "while we're here"
- Unrelated cleanup
- New features disguised as fixes

## CI Pipeline

Follow `docs/RELEASING.md`; it is the authoritative checklist. In particular:

1. Merge the reviewed release commit to the correct branch and confirm CI.
2. Create an annotated tag:
   `git tag -a vX.Y.Z -m "vX.Y.Z — <tagline>"`.
3. Push the tag and wait for the release Docker workflow.
4. Verify both registries and `/health` version/commit metadata.
5. Create the GitHub Release from the exact tag and explicitly mark the newest
   stable release as Latest (or mark a 3.0 tag as a prerelease).
6. Confirm `gh release list` shows the tag; a successful Docker workflow does
   not create the human-facing GitHub Release automatically.
7. Close only reproduced/resolved issues, each with an explanatory release
   comment. Close related dependency PRs if their changes are included.

## Common Mistakes

- Forgetting to update DOCKERHUB.md (not visible in the repo, only on Docker Hub)
- Writing changelog entries that describe implementation ("changed X to Y") instead of impact ("fixes incorrect missing count for Lidarr")
- Not closing Dependabot PRs after their changes are included via overrides
- Creating the tag before CI passes on the merge commit
- Publishing images but forgetting the GitHub Release, leaving an older version
  marked Latest
- Treating prerelease and stable ancestry/tagging rules as interchangeable
