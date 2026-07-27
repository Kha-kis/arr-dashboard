Generate polished changelog/release notes for the current branch's changes.

1. **Resolve the release base**: stable 2.x uses `origin/main`; 3.0 prereleases
   use `origin/next`. Stop if the intended release line is ambiguous.

2. **Gather changes**: `git log --oneline origin/<base>..HEAD`

3. **Categorize** each change into exactly one group:
   - **Fixed** — bug fixes with issue numbers
   - **Changed** — behavior changes, architecture improvements, refactors
   - **Added** — new features, new test infrastructure, new documentation
   - **Dependencies** — package updates, overrides, CI changes

4. **Write in the repo's changelog style** (see existing entries in `CHANGELOG.md`):
   - Lead each item with a bold short title
   - Follow with a one-sentence description of what changed and why
   - Include issue numbers where applicable (#NNN)
   - Group dependency updates into a compact list

5. **Rules**:
   - No hype words ("amazing", "powerful", "comprehensive")
   - No vague descriptions ("various improvements", "minor fixes")
   - No duplicated information across categories
   - Each item should be understandable without reading the code
   - User-facing fixes come first, architecture changes second

6. **Output**: The formatted changelog section ready to paste into `CHANGELOG.md`, starting with `## [VERSION] - DATE`

Do NOT update CHANGELOG.md directly — output the text for review first.
