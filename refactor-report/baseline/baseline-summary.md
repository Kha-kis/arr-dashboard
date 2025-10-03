# Baseline Summary

## Web App (@arr/web)

### Lint
- **Status**: ✓ Pass (warnings only)
- **Issues**: 7 warnings
  - 2x `@next/next/no-img-element` - Using `<img>` instead of Next.js `<Image />`
  - 5x `react-hooks/exhaustive-deps` - Hook dependencies could change on every render

### Typecheck
- **Status**: ✓ Pass
- **Issues**: None

### Build
- **Status**: ✓ Success
- **Output**: 15 static pages generated
- **Bundle size**: 87.3 kB shared JS

## API App (@arr/api)

### Lint
- **Status**: ✗ Fail (config error)
- **Issue**: biome.json has malformed key `""` instead of `"$schema"`
- **Fix**: Change `""` to `"$schema"` in line 2

### Typecheck
- **Status**: ✗ Fail (4 errors)
- **Location**: `src/routes/dashboard-statistics.ts`
- **Issues**:
  - Lines 519, 594: Element implicitly has 'any' type due to missing index signature
  - Type safety issue with string indexing into empty object type

### Tests
- **Status**: ✗ Fail
- **Issue**: No test files found (vitest exits with code 1)
- **Note**: Test framework configured but no tests written

### Build
- **Status**: Not tested (depends on typecheck passing)

## Critical Issues to Fix Before Refactoring

1. **biome.json schema key** - Preventing linter from running on API
2. **dashboard-statistics.ts type errors** - Must be fixed to ensure type safety
3. **No tests** - Both apps lack test coverage (high refactor risk)

## Baseline Files Created
- `baseline/lint-web.txt` - Web lint output
- `baseline/lint-api.txt` - API lint output (error state)
- `baseline/types-web.txt` - Web typecheck (pass)
- `baseline/types-api.txt` - API typecheck (4 errors)
- `baseline/tests-api.txt` - API test run (no tests found)
- `baseline/build-web.txt` - Web build output (success)
- `baseline/detected-env.json` - Environment detection results
