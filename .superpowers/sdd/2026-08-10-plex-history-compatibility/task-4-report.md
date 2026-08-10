# Task 4 report: verify every affected cache consumer

Status: PASS

Commit verified: `2ae42b3c06d0c0a47bf4b34086f650f244dc9e7f`

## Focused reading

The named cache refreshers consume the corrected Plex history interfaces:

- `apps/api/src/lib/plex/plex-cache-refresher.ts` calls `client.getHistory({ maxResults: 100_000, requireComplete: true })`, retains `complete` false on incomplete upstream evidence, and calls `client.verifyHistorySnapshot(history)` before atomic publication. Verification failure prevents the transaction/publication.
- `apps/api/src/lib/plex/plex-episode-cache-refresher.ts` calls `client.getHistory({ maxResults: 100_000, requireComplete: true })`, returns a failed/incomplete result when complete history cannot be proved, and calls `client.verifyHistorySnapshot(history)` before publication. Verification failure prevents the transaction/publication.
- `apps/api/src/lib/library-cleanup/cleanup-executor.ts` requires `loadCompleteCacheGenerations` to see successful, fresh, error-free cache status. `prefetchPlexData` and Plex episode prefetching return no evidence when that proof fails or row counts/generation metadata do not match. Cleanup records Plex as a failed source and passes no Plex map to evaluation, keeping incomplete evidence blocked.

## Exact command group 1: cache refreshers

Command:

```text
pnpm --filter @arr/shared build
pnpm --filter @arr/api exec vitest run src/lib/plex/__tests__/plex-cache-refresher.test.ts src/lib/plex/plex-episode-cache-refresher.test.ts
```

Result: PASS (exit 0)

- Shared build: passed.
- Test files: 2 passed (2).
- Tests: 24 passed (24).
- Failures: 0.
- Skips: none reported.
- Incomplete-history cases: passed. The refresher tests cover the safe history bound and repeated-page failures; both preserve the previous generation and do not open a transaction.
- Verification-failure cases: passed. Both cache refresher suites assert that `verifyHistorySnapshot` is called, the result is incomplete, and no transaction/publication occurs.
- Intended failure-path logs: no failure-path log lines were emitted by Vitest. The tests use mocked/silent logging and assert the returned error state and publication block; this is expected test behavior, not missing verification.

Observed Vitest summary:

```text
Test Files  2 passed (2)
Tests       24 passed (24)
```

## Exact command group 2: Plex-dependent Library Cleanup

Command:

```text
pnpm --filter @arr/shared build
pnpm --filter @arr/api exec vitest run src/lib/library-cleanup/__tests__/prefetch-plex-data.test.ts src/lib/library-cleanup/__tests__/shared-plex-safety.test.ts src/lib/library-cleanup/__tests__/shared-plex-sonarr-safety.test.ts
```

Result: PASS (exit 0)

- Shared build: passed.
- Test files: 3 passed (3).
- Tests: 405 passed (405).
- Failures: 0.
- Skips: none reported.
- Complete evidence remains usable: passed by the complete-generation and cache-map safety coverage.
- Incomplete/mismatched Plex evidence remains blocked: passed. The cleanup code rejects missing, stale, unsuccessful, errored, repointed, or row-count-mismatched generations and leaves the Plex evidence map unavailable/failed for dependent cleanup decisions.
- Intended failure-path logs: no failure-path log lines were emitted by Vitest. The suites assert blocked maps/warnings/results directly; no unexpected log output was present.

Observed Vitest summary:

```text
Test Files  3 passed (3)
Tests       405 passed (405)
```

## Concerns

None found. No source files were edited, staged, committed, or pushed. No live services were contacted. The worktree remained clean after verification.

## Fix Round 1: cover incomplete cache evidence

Status: PASS

### RED evidence

The independent review identified missing regression cases at the pinned commit: ordinary Plex cache refresh had no incomplete-history rejection test, and the cleanup fixture did not enumerate every unavailable-evidence predicate. The existing production behavior already failed closed, so there was no legitimate production failure to fabricate; RED was recorded as the missing test coverage against an otherwise passing implementation.

### GREEN evidence

Added ordinary refresher table-driven coverage for bounded-history and repeated-page completeness rejection. Each case asserts the exact `{ maxResults: 100_000, requireComplete: true }` request, `complete: false`, and no transaction, cache deletion, or status publication.

Added focused cleanup coverage for missing status, stale timestamp, failed completed result, failed latest attempt, completed-generation error, latest-attempt error, connection repoint, normal Plex cache row-count mismatch, and Plex episode-cache row-count mismatch. Unavailable cases assert the relevant evidence map is absent, Plex is in `failedSources`, and ordinary cleanup evaluation returns no match. The complete-generation positive case remains asserted.

### Complete focused command output

#### Command group 1: cache refreshers

Command:

```bash
pnpm --filter @arr/shared build && pnpm --filter @arr/api exec vitest run src/lib/plex/__tests__/plex-cache-refresher.test.ts src/lib/plex/plex-episode-cache-refresher.test.ts
```

Output:

```text

> @arr/shared@0.1.0 build /home/khak1s/arr-dashboard-plex-history-compatibility/packages/shared
> tsup src/index.ts --format esm --format cjs --dts

CLI Building entry: src/index.ts
CLI Using tsconfig: tsconfig.json
CLI tsup v8.5.1
CLI Target: es2022
ESM Build start
CJS Build start
CJS dist/index.cjs 187.77 KB
CJS ⚡️ Build success in 31ms
ESM dist/index.js 140.06 KB
ESM ⚡️ Build success in 31ms
DTS Build start
DTS ⚡️ Build success in 1718ms
DTS dist/index.d.ts  445.75 KB
DTS dist/index.d.cts 445.75 KB

 RUN  v4.1.10 /home/khak1s/arr-dashboard-plex-history-compatibility/apps/api


 Test Files  2 passed (2)
      Tests  26 passed (26)
   Start at  10:22:08
   Duration  220ms (transform 102ms, setup 0ms, import 123ms, tests 148ms, environment 0ms)

Exit code: 0
```

Summary: 2 Vitest files passed, 26 tests passed, 0 skipped (Vitest reported no skipped tests).

#### Command group 2: Plex-dependent Library Cleanup

Command:

```bash
pnpm --filter @arr/shared build && pnpm --filter @arr/api exec vitest run src/lib/library-cleanup/__tests__/prefetch-plex-data.test.ts src/lib/library-cleanup/__tests__/shared-plex-safety.test.ts src/lib/library-cleanup/__tests__/shared-plex-sonarr-safety.test.ts
```

Output:

```text

> @arr/shared@0.1.0 build /home/khak1s/arr-dashboard-plex-history-compatibility/packages/shared
> tsup src/index.ts --format esm --format cjs --dts

CLI Building entry: src/index.ts
CLI Using tsconfig: tsconfig.json
CLI tsup v8.5.1
CLI Target: es2022
ESM Build start
CJS Build start
CJS dist/index.cjs 187.77 KB
CJS ⚡️ Build success in 30ms
ESM dist/index.js 140.06 KB
ESM ⚡️ Build success in 30ms
DTS Build start
DTS ⚡️ Build success in 1728ms
DTS dist/index.d.ts  445.75 KB
DTS dist/index.d.cts 445.75 KB

 RUN  v4.1.10 /home/khak1s/arr-dashboard-plex-history-compatibility/apps/api


 Test Files  3 passed (3)
      Tests  415 passed (415)
   Start at  10:23:15
   Duration  1.10s (transform 1.01s, setup 0ms, import 1.81s, tests 734ms, environment 0ms)

Exit code: 0
```

Summary: 3 Vitest files passed, 415 tests passed, 0 skipped (Vitest reported no skipped tests).

### Files

- `apps/api/src/lib/plex/__tests__/plex-cache-refresher.test.ts`
- `apps/api/src/lib/library-cleanup/__tests__/prefetch-plex-data.test.ts`

### Commit

This batch is committed with the exact subject: `test(plex): cover incomplete cache evidence`.

### Self-review

- Test files only; no production, live-service, documentation, generated, or unrelated files changed.
- The ordinary refresher assertions protect the request boundary and atomic publication guard.
- Cleanup assertions exercise the maps and failed-source state consumed by cleanup evaluation, including both normal and episode row-count checks.
- `git diff --check` passed before commit.

### Concerns

No known concerns. The full package suite and unrelated validation commands were intentionally not run because this fix round was constrained to Task 4's two focused command groups. No live services were contacted.
