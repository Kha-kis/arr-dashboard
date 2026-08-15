# Task 4 report — Plex cache publication identity

## Implementation

- Sealed Plex library and episode publication behind
  `withGuardedProviderPublication()`. Both refreshers construct their data client
  from the same owned connection snapshot used by the guard's two live identity
  reads and final exact service predicate; callers cannot supply a Plex client.
- Tagged every published Plex library row, episode row, and successful cache
  status with both `connectionGeneration` and `identityGeneration`.
- Preserved bounded 100-row `createMany` chunks inside one atomic publication
  transaction. Deletes, all chunks, and the success status roll back together.
- Restricted episode source selection to library rows matching both current
  generations and derived the source fingerprint from the owned snapshot.
- Migrated startup/recurring schedulers, the authenticated manual route, Plex
  Pulse dispatch, and both cleanup publishing-prefetch calls to the sealed
  context API.
- Split cleanup's `publish:false` use into `collectPlexCacheLiveEvidence()`.
  That API receives no Prisma client and cannot publish; cleanup evidence,
  selection, approval, safety-plan, and mutation behavior were otherwise left
  unchanged.

## RED / GREEN evidence

RED:

```text
pnpm --filter @arr/api exec vitest run \
  src/lib/plex/__tests__/plex-publication-authority.test.ts \
  src/plugins/__tests__/plex-cache-scheduler-authority.test.ts \
  src/routes/plex/__tests__/cache-routes.test.ts
```

The initial authority tests failed against the legacy positional refresher API:
five cases raised `TypeError` because the old implementation treated the sealed
context as a caller-provided Plex client. The new compile/API expectations also
demonstrated that manual, scheduler, and direct refresher paths were not yet
using an owned snapshot.

GREEN coverage proves normal proxy binding, stable wrong-server rejection,
between-read identity switching, final-predicate concurrent update rejection,
identity-generation-only supersession with unchanged connection generation,
sanitized dependency failure, 100-row chunking, dual-generation library,
episode, and success-status writes, and no caller-client production API.
Authenticated manual refresh, Plex Pulse dispatch, startup/recurring schedulers,
and cleanup publishing-prefetch calls are covered separately.

## Validation

| Check | Result |
| --- | --- |
| Focused Plex/scheduler/route/Pulse/cleanup Vitest suite | Passed: 32 files (1 skipped), 256 tests (4 skipped) |
| Real SQLite heap/rollback suite (`TEST_HEAP=true`) | Passed: 4 tests; later-chunk and success-status failures preserved the prior generation |
| Heap evidence | Baseline 54.1 MiB; after Plex 88.3 MiB; first growth 37.1 MiB; repeated growth 18.2 MiB |
| Prisma generate + API typecheck | Passed; generated Prisma output restored afterward |
| SQLite schema sync | Passed using the heap suite's disposable `prisma db push` database |
| PostgreSQL 16 schema sync | Passed against a disposable container using a temporary provider-adjusted schema copy |
| Biome on touched source/test files | Passed: 18 files checked |
| `git diff --check` | Passed |

Generated Prisma client/model changes are validation output in this repository
and are intentionally absent from the commit.

## Caller inventory

- Plex library startup and recurring scheduler
- Plex episode startup and recurring scheduler
- Authenticated `POST /api/plex/cache/:instanceId/refresh`
- Plex Pulse cache dispatch
- Direct library and episode refreshers
- Cleanup library and episode publishing-prefetch calls
- Cleanup live-evidence collection through the non-publishing API

## Commit

`feat(plex): bind caches to server identity` (this commit)

## Concerns

- Failure-attempt status recording remains the existing connection-fenced,
  non-authoritative path. Successful cache status and all cache rows are guarded
  by both generations; failure recording cannot authorize cache cleanup.
- No Jellyfin, Emby, Tautulli, cleanup decision, or cleanup mutation behavior was
  changed.
