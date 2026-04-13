# Domain: Schedulers

Operating manual for background work — periodic jobs that the API runs on
its own timers (backups, hunting, queue cleanup, library sync, TRaSH sync,
Seerr health, media caches, etc.).

For the *why* of the central registry design, see
[ADR-0001](../adr/0001-scheduler-registry.md). This doc covers *where to
plug in* and *what to never break*.

## Purpose

Two distinct things, kept deliberately separate:

1. **Execution** — each scheduler plugin owns its own `setInterval`,
   startup-delay logic, per-instance fan-out, retention rules, and
   concurrency guards. There is *no* shared scheduler framework.
2. **Observability** — a process-local `SchedulerRegistry` catalogs every
   known job and tracks its runtime state (last started/finished/succeeded/
   failed, durations, totals). The `/api/system/jobs` endpoint reads from
   this registry.

This split is intentional. The registry observes; it does not schedule.

## Key files

| Concern | File |
|---|---|
| Registry class (state + invariants) | `apps/api/src/lib/scheduler-registry/scheduler-registry.ts` |
| Static catalog of known job IDs + metadata | `apps/api/src/lib/scheduler-registry/job-definitions.ts` |
| Fastify plugin (decorates `app.schedulerRegistry`) | `apps/api/src/plugins/scheduler-registry.ts` |
| HTTP surface | `apps/api/src/routes/system.ts` (`GET /system/jobs`) |
| Job plugins (one per scheduler) | `apps/api/src/plugins/*-scheduler.ts` (e.g. `hunting-scheduler.ts`, `backup-scheduler.ts`, `queue-cleaner-scheduler.ts`) |
| Job tick implementations | `apps/api/src/lib/<domain>/*-executor.ts` (e.g. `lib/hunting/hunt-executor.ts`) |

## Invariants

1. **Every scheduler is pre-registered in `job-definitions.ts`.** This is
   what makes the catalog complete from day one even before a plugin
   adopts `track()`. If you add a scheduler and do not add it to the
   catalog, it is invisible to operators.
2. **Job IDs are stable strings, exposed via `JOB_ID.*`.** Tests pin to
   them; UI keys off them. Renaming a job ID is a breaking change.
3. **`registry.track()` re-throws the original error.** Existing error
   handling, retries, and notification logic still run. Adoption is purely
   additive.
4. **`registry.track()` is the only legitimate way to update runtime
   stats.** Do not write to registry internals from plugins; read via
   `getStatus()`/`list()`, mutate via `track()` / `markDisabled()` /
   `markEnabled()`.
5. **No cross-process coordination.** This is a single-process app. Any
   "is anything running anywhere?" check is local to this process.
6. **The `/system/jobs` endpoint never triggers a tick.** It is read-only.
   Pinned by `system-jobs.test.ts`.

## Major integration points

- **`app.schedulerRegistry`** — the single Fastify decoration every
  scheduler plugin uses to register itself and wrap its tick.
- **`/api/system/jobs`** — consumed by the System tab in the UI (see
  [`docs/domains/system.md`](system.md)).
- **`KNOWN_JOBS` catalog** — the source of truth for "what schedulers
  exist." Used by tests, UI, and runtime registration alike.

## Common failure modes / operational notes

- **Job appears as `idle` with `totalRuns: 0`** — it is registered in
  `job-definitions.ts` but the plugin has not yet adopted `track()`.
  Honest signal of "unknown," not "confirmed idle." Resolve by wrapping
  the plugin's tick body in `app.schedulerRegistry.track(JOB_ID.x, …)`.
- **Stats lost on restart** — by design (ADR-0001). Operators who need
  trend data across restarts will get it when the `SchedulerRun`
  persistence follow-up lands.
- **Two ticks running concurrently for a `serial` job** — registry throws
  `SerialJobBusyError`. The plugin should propagate it, not swallow it,
  so the rejection shows up in `lastError`.
- **`disabledReason` not surfaced** — when calling `markDisabled(id, reason)`,
  always pass a human-readable reason. The `/system/jobs` payload exposes
  it; the UI displays it; debugging without it is painful.
- **Adding a scheduler that should not auto-start in dev** — gate the
  `setInterval` in the plugin, not in the registry. Registry just
  observes; the registration call should still happen so the job appears
  in the catalog as `disabled`.

## Where to add new code

| Change | Goes in |
|---|---|
| New scheduler | (1) add ID to `JOB_ID` and entry to `KNOWN_JOBS` in `job-definitions.ts`; (2) create `apps/api/src/plugins/<name>-scheduler.ts` registering itself and wrapping the tick in `app.schedulerRegistry.track()`; (3) put the tick body in `apps/api/src/lib/<domain>/<name>-executor.ts` |
| Adopt `track()` on an existing scheduler | wrap the body of the existing tick function — no other changes needed |
| Disable a job at startup | call `app.schedulerRegistry.markDisabled(JOB_ID.x, "reason")` from the plugin instead of registering the timer |
| Add a runtime stat to the API response | extend `JobStatus` in `scheduler-registry.ts` and update `system-jobs.test.ts` (the contract test) |
| Surface a job in a new UI panel | consume `/api/system/jobs`; do not duplicate the registry on the frontend |

## When to update this doc

- A new scheduler is added or removed.
- The registry's public API changes (new method on `SchedulerRegistry`,
  new field on `JobStatus`).
- A new concurrency model is introduced (currently `singleton`,
  `per-instance`, `serial`, `parallel`).
- Persistence is added (will warrant a new ADR + an update here).

Implementation details of individual schedulers (interval, retention
rules, per-instance behavior) belong in code comments at the plugin file,
not here.
