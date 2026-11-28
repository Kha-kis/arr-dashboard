# Provider cache native measurements

This is an opt-in diagnostic for repeated Plex cache replacement. It uses the existing isolated temp-file SQLite/Prisma fixture and Plex fake-provider fixture in the heap regression test. The normal `pnpm --filter @arr/api run test:provider-cache-heap` command and its seven regression/fault tests are unchanged. The measuring selector registers only when the runner receives `--measure`.

From the repository root, run:

```sh
node apps/api/scripts/test-provider-cache-heap.mjs --measure
```

The runner creates a fresh temporary SQLite database, pushes the schema, runs five refreshes for each 500-row and 15,000-row fixture, then removes the database directory. It reports elapsed min/mean/max, peak sampled process RSS, post-GC heap mean, provider read calls, settlement calls, reported upserted rows, actual surviving cache row count, cache age after publication, and the actual SQLite journal mode. Keep stdout as the run log. Do not add memory thresholds: this is comparative diagnostic data, not a pass/fail benchmark.

## Paired baseline and candidate

Use the same machine, Node version, power state, and runner for both checkouts. Build each checkout from the same dependency lockfile and apply this instrumentation-only commit to both, so the production implementation is the only difference. For example, set the two refs to the source revision before and after the implementation under study:

```sh
git worktree add /tmp/provider-cache-baseline <baseline-ref>
git worktree add /tmp/provider-cache-candidate <candidate-ref>
# Apply the same instrumentation-only commit to each worktree.
git -C /tmp/provider-cache-baseline cherry-pick <measurement-commit>
git -C /tmp/provider-cache-candidate cherry-pick <measurement-commit>
cd /tmp/provider-cache-baseline
pnpm install --frozen-lockfile
pnpm --filter @arr/shared build
node apps/api/scripts/test-provider-cache-heap.mjs --measure > /tmp/provider-cache-baseline.log 2>&1
cd /tmp/provider-cache-candidate
pnpm install --frozen-lockfile
pnpm --filter @arr/shared build
node apps/api/scripts/test-provider-cache-heap.mjs --measure > /tmp/provider-cache-candidate.log 2>&1
```

Use fresh worktrees/databases and keep both logs. The comparison is meaningful only when both runs report the same SQLite journal mode and fixture sizes. The runner does not switch journal modes. The existing native journal-mode fixture can exercise SQLite WAL and DELETE mode for correctness, but it is not a provider-refresh performance fixture. Do not describe these measurements as WAL, DELETE, or PostgreSQL performance unless the reported mode and a matching provider-refresh fixture actually support that claim.

## Metric boundaries

- `providerReadCalls` counts calls to the fixture's Plex library section and item methods. `sqlStatements`, `sqlReads`, `sqlWrites`, and `sqlOther` count Prisma query events during each refresh; reads are statements starting with SELECT or EXPLAIN, writes start with DML/DDL verbs, and all remaining events are in `sqlOther`. The handler inspects only the leading SQL keyword, never emits or retains SQL text or parameters. Prisma CLI schema setup runs in a separate process and is outside these counts.
- `settlementCalls` counts calls to the fixture's Plex settlement method. Refresh elapsed time includes publication and settlement work performed by the refresh path.
- `reportedWrites` is the refresher's upserted-row total. `conservedRows` is a real post-refresh database count, checking replacement cleanup and final row conservation.
- `cacheAgeMeanMs` is wall-clock age of the stored successful refresh timestamp immediately after each run. It is a freshness observation, not item age or upstream scan age.
- Enabling Prisma query events adds observer overhead to the opt-in refresh timings; compare only runs using this same instrumentation. There is no separate cleanup-service timing and no PostgreSQL provider-refresh native fixture in this path. PostgreSQL and WAL/DELETE native correctness tests remain separate. Do not infer those missing metrics from provider-call or row counts.
- The opt-in measurement run contains only successful cycles and does not time failures. The existing SQLite trigger-injected publication tests in the normal heap command remain the negative control: they verify transaction rollback preserves the prior generation and status.

## Separate native engine controls

These commands validate their own native-engine behaviors; they do not produce provider-refresh performance samples:

```sh
pnpm --filter @arr/api exec vitest run src/lib/__tests__/sqlite-journal-mode.database.test.ts
```

That isolated fixture exercises actual SQLite DELETE and WAL modes and removes its temporary database. The provider measurement runner reports the mode on its own fresh database and currently leaves Prisma's actual default mode in place.

The PostgreSQL helper integration uses a caller-owned loopback database with a name ending in `_test`; its two tests create and delete uniquely named rows and verify real transaction behavior. Set a test-only URL locally, then run:

```sh
export TEST_PG_HELPER_URL=postgresql://127.0.0.1:5432/arr_test
INTEGRATION_TESTS=true pnpm --filter @arr/api exec vitest run src/lib/__tests__/test-prisma-pg.integration.test.ts
```

Use only a disposable local test database. The helper rejects non-loopback hosts and database names without the `_test` suffix. This is a PostgreSQL client/transaction control, not a provider-cache refresh benchmark; no PostgreSQL refresh timing or query counts are available from this harness.
