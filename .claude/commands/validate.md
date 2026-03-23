Run the full validation suite and report results.

1. TypeScript type check (both packages):
   ```
   pnpm --filter @arr/web exec tsc --noEmit
   pnpm --filter @arr/api exec tsc --noEmit
   ```

2. Lint:
   ```
   pnpm run lint
   ```

3. Tests:
   ```
   pnpm run test
   ```

4. Build:
   ```
   pnpm run build
   ```

Report results as a table: Check | Status | Details

If any check fails, diagnose the root cause and suggest a fix.
