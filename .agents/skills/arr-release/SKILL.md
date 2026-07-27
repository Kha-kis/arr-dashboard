---
name: arr-release
description: Prepare and verify arr-dashboard stable releases and 3.0 prereleases, including readiness, changelog, version surfaces, tagging, registries, GitHub Releases, and issue follow-up. Use for release planning or execution.
---

# Release arr-dashboard

1. Read `docs/RELEASING.md`; it is authoritative. Resolve whether this is:
   - a stable 2.x release from `main`; or
   - a 3.0 alpha/beta/RC from an exact reviewed `next` SHA.
2. Audit scope and blockers with `$arr-review-change` and `$arr-validate`.
   Include `pnpm run build`.
3. Prepare user-facing release notes from the actual commit range. Update every
   version surface required by `docs/RELEASING.md`, including the wiki when
   specified.
4. Before publishing, confirm ancestry, clean state, reviewed SHA, CI, target
   registries, tag type, and stable-versus-prerelease GitHub metadata.
5. Use annotated tags. After publication, verify Docker Hub and GHCR artifacts,
   container `/health` version/commit metadata, and the human-facing GitHub
   Release. A successful image workflow does not create that release.
6. Close only reproduced and resolved issues, with an explanatory release
   comment. Keep unrelated or partially addressed issues open.

Release planning and preparation do not authorize tagging, pushing, publishing,
marking Latest, or closing issues. Perform each external action only when the
user explicitly includes it in scope.
