# Next Episode-Scope Cleanup Parity Plan

## Goal

Semantically forward-port the completed stable behavior for #659/#661 onto
`next`, using the Wave 1 shared-Plex safety primitives instead of replaying the
21 historical review commits. A supported Sonarr episode rule must preview,
approve, execute, recover, and explain one exact episode/file without ever
deleting its parent series or sibling files.

Reference end state: `0bc77cd2` in
`/home/khak1s/arr-dashboard-659-episode-scope`.

Target stack:

- `60749495` — `origin/next` audit base
- `4cd0a921` — frozen Wave 1 shared-Plex ownership safety
- `91523868` — isolated four-file format prerequisite
- `codex/next-episode-scope` — this Wave 2 implementation

## Scope boundary

Required parity:

- explicit `series | episode` rule scope, defaulting legacy data to `series`;
- exact Sonarr episode/file identity from preview through durable retry;
- current Plex episode watch proof tied to one Plex connection and physical
  media part;
- complete qUI/hash/inode proof when seeding protection is enabled;
- series-level retention and cleanup precedence over child episode cleanup;
- exact episode `unmonitor`, `delete_files`, and `delete` behavior;
- episode identity in API, explain, preview, approval, logs, and both rule
  authoring surfaces;
- backward compatibility for existing series rules, rows, approvals, and
  non-destructive qUI/backfill consumers.

Explicitly excluded:

- Jellyfin or Emby episode cleanup;
- a generic media-target framework or cleanup-engine redesign;
- broad evaluator, Console, or library-cleanup UI refactors;
- unrelated modernization from the historical branch;
- any live destructive check against production Sonarr, Plex, qUI, or storage.

## Non-negotiable safety invariants

1. An episode target never calls Sonarr `series.delete`.
2. `delete_files` deletes only the approved, freshly revalidated episode-file
   ID; `delete` only unmonitors the approved episode and deletes that exact
   file; `unmonitor` changes only that episode.
3. Multi-episode physical files fail closed.
4. Missing, stale, partial, cross-source, duplicate, or ambiguous Plex/qUI/
   filesystem evidence cannot authorize a mutation.
5. Preview, approval, and execution use the same exact target and action.
6. Every mutation target, rule, service identity, peer topology, file,
   monitored state, watch proof, and qUI policy is re-resolved at execution.
7. Partial and lost-response outcomes remain honest, durable, retryable, and
   idempotent; success is recorded only after verified upstream success.
8. Existing Wave 1 series safety remains intact and series behavior receives
   focused compatibility coverage.

## Task 1 — Contracts, schema, and generated client

Owned files:

- `apps/api/prisma/schema.prisma`
- generated Prisma output produced by `pnpm --filter @arr/api run db:generate`
- `packages/shared/src/types/library-cleanup.ts`
- `packages/shared/src/types/plex.ts` only if the final contract requires it
- `packages/shared/src/types/__tests__/library-cleanup.test.ts`

TDD and behavior:

- Add shared tests first for legacy series default, partial-update omission,
  valid Sonarr episode rules, every unsupported episode shape, and unrestricted
  series behavior.
- Add `targetScope` to rules and approvals; add approval episode coordinates.
- Add `watchCount`, `refreshedAt`, and `sourceFingerprint` to
  `PlexEpisodeCache` (the target schema does not currently contain them).
- Constrain episode rules to Sonarr, non-retention, non-composite
  `plex_watch_count greater_than`, without a Plex library filter.
- Do not let a partial update inject `series` and erase an episode scope.
- Extend preview, approval, log-detail, and explain contracts compatibly.
- Regenerate Prisma; never hand-edit generated output.

Focused validation:

```bash
pnpm --filter @arr/api run db:generate
pnpm --filter @arr/shared build
pnpm --filter @arr/shared test -- src/types/__tests__/library-cleanup.test.ts
pnpm --filter @arr/shared run typecheck
```

## Task 2 — Plex episode evidence

Owned files:

- `apps/api/src/lib/plex/service-instance-fingerprint.ts`
- `apps/api/src/lib/plex/plex-client.ts`
- `apps/api/src/lib/plex/plex-schemas.ts`
- `apps/api/src/lib/plex/plex-episode-cache-refresher.ts`
- `apps/api/src/lib/plex/plex-episode-cache-refresher.test.ts`
- `apps/api/src/lib/plex/__tests__/plex-client-media-parts.test.ts`
- `apps/api/src/plugins/plex-episode-cache-scheduler.ts`
- `apps/api/src/plugins/__tests__/plex-episode-cache-scheduler.test.ts`
- existing cache-health/pulse tests only where the persisted status contract
  directly changes

TDD and behavior:

- Bind evidence to the current Plex connection fingerprint.
- Preserve exact season/episode coordinates and add live exact watch-count
  revalidation by rating key.
- Coalesce duplicate Plex copies without inflating the logical denominator.
- Preserve known positive evidence across bounded history/account/duplicate
  failures without manufacturing fresh proof.
- Record refreshed zero as evidence but not a positive witness.
- Rotate bounded batches for eventual coverage and report partial/degraded
  capacity honestly.
- Keep movie and existing aggregate behavior compatible.

Focused validation:

```bash
pnpm --filter @arr/api exec vitest run \
  src/lib/plex/__tests__/plex-client-media-parts.test.ts \
  src/lib/plex/plex-episode-cache-refresher.test.ts \
  src/plugins/__tests__/plex-episode-cache-scheduler.test.ts
pnpm --filter @arr/api run typecheck
```

## Task 3 — Complete qUI and filesystem proof

Owned files:

- `apps/api/src/lib/qui/client-factory.ts`
- `apps/api/src/lib/qui/torrent-state-sync.ts`
- `apps/api/src/lib/qui/__tests__/client-factory.test.ts`
- `apps/api/src/lib/qui/__tests__/torrent-state-sync.test.ts`
- `apps/api/src/lib/qui/__tests__/action-service.test.ts` only for direct
  compatibility coverage
- `apps/api/src/lib/library-sync/infohash-backfill-by-inode.ts`
- `apps/api/src/lib/library-sync/__tests__/infohash-backfill-by-inode.test.ts`

TDD and behavior:

- Preserve metadata-free ordinary point lookups for compatibility.
- Add strict exact-hash pagination and complete torrent inventory APIs for
  destructive consumers.
- Reject partial metadata, changing totals, duplicate rows, empty continuation
  pages, early exhaustion, and page-cap overflow.
- Keep cached/lenient helpers for display/backfill; add fresh complete helpers
  for mutation authority.
- Require stable qUI inventory, complete filesystem walks, exact target stat
  identity, stable markers, and complete multi-hash resolution.
- Include single-link qUI content in destructive indexes; reject unreadable,
  symlinked, changed, or unsupported evidence.

Focused validation:

```bash
pnpm --filter @arr/api exec vitest run \
  src/lib/qui/__tests__/client-factory.test.ts \
  src/lib/qui/__tests__/torrent-state-sync.test.ts \
  src/lib/library-sync/__tests__/infohash-backfill-by-inode.test.ts
pnpm --filter @arr/api run typecheck
```

## Task 4 — Pure episode domain and candidate evaluation

Owned files:

- `apps/api/src/lib/library-cleanup/episode-scope.ts`
- `apps/api/src/lib/library-cleanup/episode-scope.test.ts`
- `apps/api/src/lib/library-cleanup/types.ts`
- `apps/api/src/lib/library-cleanup/rule-evaluators.ts`
- `apps/api/src/lib/library-cleanup/phase1-features.test.ts`
- `apps/api/src/lib/library-cleanup/qui-filter.ts` only if the target type
  requires it
- `apps/api/src/lib/library-cleanup/cleanup-executor.ts`
- focused candidate/prefetch tests

TDD and behavior:

- Add pure RED tests for exact count threshold, independent sibling keys,
  malformed action rejection, and no cross-Plex aggregation.
- Carry immutable episode, file, consumer, Plex-source, infohash, and qUI
  identity.
- Evaluate series rules first; suppress child candidates when parent retention
  or parent cleanup applies.
- Discover candidates only from supported episode rules and fresh complete
  evidence; unsupported persisted rules are skipped, never broadened.
- Preserve the `next` rule-engine adapter rather than reverting to the older
  evaluator implementation.

Focused validation:

```bash
pnpm --filter @arr/api exec vitest run \
  src/lib/library-cleanup/episode-scope.test.ts \
  src/lib/library-cleanup/phase1-features.test.ts \
  src/lib/library-cleanup/__tests__/prefetch-plex-data.test.ts
pnpm --filter @arr/api run typecheck
```

## Task 5 — Exact episode safety plan and mutation lifecycle

Owned files:

- `apps/api/src/lib/library-cleanup/shared-plex-safety.ts`
- `apps/api/src/lib/library-cleanup/cleanup-executor.ts`
- `apps/api/src/lib/library-cleanup/__tests__/shared-plex-safety.test.ts`
- `apps/api/src/lib/library-cleanup/__tests__/shared-plex-sonarr-safety.test.ts`
- existing approval/concurrency tests only when episode identity changes their
  contract

TDD and behavior:

- Add canonical `verified_sonarr_episode` proof integrated with Wave 1.
- Cover exact file/episode identity, single consumer, retained siblings,
  exact Plex source/rating-key/path/count, peer topology, notification mapping,
  monitored state, current rule precedence, and strict qUI proof.
- Add RED execution tests for exact `unmonitor`, `delete_files`, and `delete`;
  assert `series.delete` and all peer mutations are never called.
- Cover queued, direct, partial, retry, interrupted, already-complete,
  lost-response, service-repoint, rule-edit, policy-change, file-replacement,
  duplicate-copy, and concurrent-claim boundaries.
- Reconcile only the selected episode-file cache row and retain parent/sibling
  records.

Focused validation:

```bash
pnpm --filter @arr/api exec vitest run \
  src/lib/library-cleanup/__tests__/shared-plex-safety.test.ts \
  src/lib/library-cleanup/__tests__/shared-plex-sonarr-safety.test.ts \
  src/routes/__tests__/library-cleanup-approval-cas.test.ts
pnpm --filter @arr/api run typecheck
```

## Task 6 — API serialization, explain, and rule persistence

Owned files:

- `apps/api/src/routes/library-cleanup.ts`
- `apps/api/src/routes/__tests__/library-cleanup-rule-serialization.test.ts`
- `apps/api/src/routes/__tests__/library-cleanup-approval-serialization.test.ts`
- `apps/api/src/routes/__tests__/library-cleanup-explain-episode.test.ts`

TDD and behavior:

- Legacy and unknown stored scopes serialize as `series`; explicit episode
  scope and coordinates round-trip.
- Rule create/update validates the effective complete rule while changing
  `targetScope` only when explicitly supplied.
- Preview, approval, logs, and explain retain structured series/episode
  identity without breaking legacy `title` consumers.
- Explain uses the current `next` rule-engine adapter plus fresh episode
  evidence; wrong service, missing episode, and unavailable evidence fail
  clearly and without mutation.

Focused validation:

```bash
pnpm --filter @arr/api exec vitest run \
  src/routes/__tests__/library-cleanup-rule-serialization.test.ts \
  src/routes/__tests__/library-cleanup-approval-serialization.test.ts \
  src/routes/__tests__/library-cleanup-explain-episode.test.ts
pnpm --filter @arr/api run typecheck
```

## Task 7 — Next-native authoring and display

Owned files:

- full Library Cleanup rule dialog and tests
- Console cleanup rule composer and tests
- Library Cleanup client and tests
- API client/hooks only if the shared types do not flow automatically

TDD and behavior:

- Both authoring surfaces default new rules to series and preserve existing
  episode scope on edits.
- Episode controls visibly enforce the supported Sonarr/Plex watch-count rule.
- Preview, approvals, rules, and log details display series title, episode
  title, and padded `SxxExx`.
- Incognito masks sensitive titles while preserving non-sensitive episode
  coordinates; existing keyboard/ARIA behavior remains intact.
- No broader Console or cleanup redesign.

Focused validation:

```bash
pnpm --filter @arr/web exec vitest run \
  src/features/library-cleanup/components/__tests__/cleanup-rule-dialog.test.tsx \
  src/features/library-cleanup/components/__tests__/library-cleanup-client.test.tsx \
  src/features/console/components/__tests__/cleanup-rule-composer-dialog.test.tsx
pnpm --filter @arr/web run typecheck
```

## Review and completion boundary

- Run narrow tests while iterating and review each task diff before accepting
  its commit.
- Assemble all seven tasks before independent final review.
- Final review inventory is one pass by `data_safety_reviewer` and one pass by
  `regression_reviewer`; one correction batch addresses recorded, in-scope,
  evidence-backed findings. Do not restart whole-branch review after each fix.
- A late finding becomes follow-up unless it proves the current episode change
  unsafe or invalid.
- Live production services remain read-only. Use populated mocks/fixtures for
  destructive behavior and a populated local browser fixture for UI behavior.

Final gauntlet:

```bash
pnpm run format
pnpm --filter @arr/shared build
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build
git diff --check 91523868..HEAD
```

The branch is complete only when the reported whole-series deletion scenario
is represented by regression coverage, exact episode actions cannot reach the
series-delete path, every required safety proof fails closed, both reviewers'
recorded findings are resolved in one bounded correction pass, and the final
gauntlet is green.
