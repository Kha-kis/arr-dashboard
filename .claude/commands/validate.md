Run the full validation suite and report results.

1. Format:
   ```
   pnpm run format
   ```
   Report any files changed by formatting.

2. If `packages/shared` changed, rebuild it before type checking or testing:
   ```
   pnpm --filter @arr/shared build
   ```

3. Run the CI-equivalent root typecheck. Never substitute per-package `tsc`;
   it can resolve stale shared-package output and miss CI failures:
   ```
   pnpm run typecheck
   ```

4. Tests and lint:
   ```
   pnpm run test
   pnpm run lint
   ```

5. Production build:
   ```
   pnpm run build
   ```
   The build is required for release-sensitive, dependency, Docker, routing, or
   substantial frontend changes. For a documentation-only change, explicitly
   mark it not applicable rather than pretending it ran.

Report results as a table: Check | Status | Details

If a check fails, diagnose the root cause. Do not bypass, disable, or quietly
reclassify a failure. Distinguish pre-existing failures from changes introduced
by the current branch with evidence.
