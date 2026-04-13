# ADR 0001: Lightweight in-process SchedulerRegistry

- **Status:** Accepted
- **Date:** 2026-04-13
- **Deciders:** Backend maintainers
- **Supersedes:** —

## Context

The API runs 17 background schedulers (backup, hunting, queue cleaner, media
caches, TRaSH sync, Seerr health, …). Until now, each scheduler owned its own
`setInterval` and its own ad-hoc logging, and there was no unified way for an
operator to answer:

- When did each job last run? Did it succeed?
- How long did the last run take?
- Is any job currently in flight?
- Has a given job failed repeatedly?
- Which jobs are disabled, and why?

Without that visibility, regressions in scheduled work are only caught when a
user reports symptoms. We need a single place to see job state, and a single
helper that the existing schedulers can adopt incrementally.

## Decision

Introduce a process-local `SchedulerRegistry` class that serves as both a
catalog of known jobs and a runtime-state tracker. It does **not** replace
any scheduler's timer or execution logic — it observes.

### Data model

Each job carries:

- **Definition** (static): `id`, `label`, `description`, `concurrency`, optional `intervalMs`.
- **Runtime status**: `state` (`idle` / `running` / `disabled`), `lastStartedAt`,
  `lastFinishedAt`, `lastSuccessAt`, `lastFailureAt`, `lastDurationMs`,
  `lastError`, `consecutiveFailures`, `totalRuns`, `totalFailures`,
  `disabled`, `disabledReason`.

### API surface

```ts
registry.register(definition)
registry.markDisabled(id, reason)
registry.markEnabled(id)
registry.track(id, async () => { /* tick body */ })
registry.getStatus(id)
registry.list()
```

`track()` is the adoption seam: it wraps an existing tick function with
timing + state transitions, re-throws the tick's original error, and updates
stats. Callers preserve their existing error handlers.

### HTTP surface

`GET /api/system/jobs` returns `{ jobs, count, capturedAt }`. The endpoint is
read-only and gated by the existing protected-routes preHandler.

### Concurrency declarations

Each job declares one of `singleton`, `per-instance`, `serial`, `parallel`.
The registry only *enforces* `serial` (throws `SerialJobBusyError` when a run
is already in flight). The other values are advisory and document the lock
model the plugin itself enforces. Plugins are free to ignore the registry's
concurrency value and keep their existing `isRunning` guards.

## Why intentionally lightweight

1. **No persistence.** Runs are not written to the database. Operator value
   comes from the current/recent picture — historical trends can be added
   later (e.g., `SchedulerRun` table with 30-day retention) without breaking
   the public shape. Storing every tick from 17 schedulers would bloat the
   database and buy us little before we know which metrics we actually want.
2. **No global scheduler abstraction.** We did *not* migrate every scheduler
   onto a shared cron / queue framework. Each plugin still owns its own
   timer, because the existing timers already encode nuanced startup-delay,
   retention, per-instance, and notification logic. A framework migration
   would be a multi-week project with real behavior risk; that is not where
   the observability value is today.
3. **Incremental adoption.** Every known job is pre-registered centrally in
   `lib/scheduler-registry/job-definitions.ts`, so the `/api/system/jobs`
   catalog is complete from day one. Execution instrumentation (via
   `registry.track()` or `markDisabled()`) is opt-in per scheduler and can
   land in follow-up PRs.
4. **Process-local.** `arr-dashboard` is a single-process self-hosted app.
   Cross-process job coordination (e.g., distributed locks) is not required
   and would be dead weight.

## Consequences

### Positive

- Operators get a single `/api/system/jobs` view today, for free, for every
  scheduler — even ones whose plugin has not yet adopted `track()`.
- Plugins can adopt instrumentation one file at a time with a ~5-line change.
- The registry has no side effects beyond in-memory bookkeeping, so tests do
  not need a database or Fastify instance.
- Concurrency intent is documented next to the job definition and visible in
  the API response.

### Negative / trade-offs

- Stats are lost on restart. This is acceptable for a dashboard surface;
  users who care about long-term trends will get them when we add
  persistence in a follow-up.
- Jobs that have not adopted `track()` appear as `idle` with `totalRuns: 0`.
  The endpoint is honest about this (no fake data), but operators must know
  that "idle + 0 runs" on an un-adopted job is unknown, not confirmed-idle.
  Resolved by rolling out `track()` adoption across the remaining schedulers
  in subsequent PRs.
- The registry enforces only `serial` concurrency. Plugins retain their own
  `isRunning` guards; there is some duplication until adoption is complete.

## Follow-ups

- Instrument remaining schedulers with `registry.track()`.
- Persist runs to `SchedulerRun` if/when operators ask for trend data.
- Add a UI panel (Settings → Jobs) that renders the `/api/system/jobs`
  response with a "running / healthy / failing" summary.
- Consider exposing a `POST /api/system/jobs/:id/run` trigger once we have a
  clear safety model (right now, ticks are triggered only by timers).
