# Domain: System

Operating manual for the operator-facing diagnostic surface — settings,
runtime info, logs, scheduler observability, validation health, security
posture, and restart.

This domain is not a feature; it's the *console*. Everything here exists
to answer "what is this app doing right now, and is it healthy?"

## Purpose

Make the running state of the application observable and (where safe)
configurable from the UI without shell access. Read endpoints are the
default; mutating endpoints are narrow, audited, and rate-limited.

## Key files

| Concern | File |
|---|---|
| All `/system/*` HTTP routes | `apps/api/src/routes/system.ts` |
| Pure security-posture evaluator | `apps/api/src/lib/security/security-posture.ts` |
| Scheduler registry | `apps/api/src/lib/scheduler-registry/` (see [`schedulers.md`](schedulers.md)) |
| Validation health + fingerprints + quarantine | `apps/api/src/lib/validation/` |
| Logger + log-rotation config | `apps/api/src/lib/logger.ts` |
| App version | `apps/api/src/lib/utils/version.ts` |
| Lifecycle (restart) decoration | `apps/api/src/plugins/lifecycle.ts` |
| `SystemSettings` table (singleton row) | `apps/api/prisma/schema.prisma` |
| Frontend tab (single consumer) | `apps/web/src/features/settings/components/system-tab.tsx` |
| API client + hooks | `apps/web/src/lib/api-client/system.ts`, `apps/web/src/hooks/api/useSystem.ts` |

## The "stored vs. effective" pattern

`/system/settings` returns *both* the value the operator last saved (e.g.
`trustProxy`) and the value actually being used at runtime (e.g.
`effectiveTrustProxy`, read from `app.config`). When the two diverge,
`requiresRestart: true` tells the UI to show a banner.

This pattern matters because the API process reads most env-derived
config at startup. Saving a new value to the DB does not change the
running process — it changes what the process will pick up next time.
Surfacing both lets operators see *and trust* that distinction.

The Security Posture endpoint follows the same convention: it reports
`effective` runtime values (from `app.config`) alongside its derived
checks. Never report stored values as if they were live.

## Subsystems plugged into `/system`

| Endpoint | Backed by |
|---|---|
| `GET /system/settings`, `PUT /system/settings` | `SystemSettings` row + `app.config` |
| `GET /system/info` | `getAppVersionInfo()`, `app.dbProvider`, `process.*`, logger constants |
| `GET /system/logs`, `GET /system/logs/download/:filename` | `LOG_DIR` filesystem |
| `POST /system/restart` | `app.lifecycle.restart()` |
| `GET /system/jobs` | `app.schedulerRegistry` (see [`schedulers.md`](schedulers.md)) |
| `GET /system/security-posture` | `evaluateSecurityPosture()` (see [ADR-0002](../adr/0002-security-posture-evaluator.md)) |
| `GET/PUT/DELETE /system/validation-health`, `*/validation-quarantine`, `PUT /system/validation-modes` | `lib/validation/integration-health.ts` + `schemaFingerprints` + `validationQuarantine` |

For the full route table, see [`docs/API-ROUTES.md`](../API-ROUTES.md).

## Invariants

1. **All `/system/*` routes are read-only by default**; mutating routes
   are explicitly justified (settings PUT, validation-mode toggles,
   restart, quarantine clear). Adding a new diagnostic should land as a
   GET unless mutation is the whole point.
2. **The `requiresRestart` flag is computed, not stored.** If you add a
   new field to `SystemSettings`, decide whether it needs restart, and
   if so include it in the comparison block in both GET and PUT handlers.
3. **`PUT /system/settings` blocks lockout-inducing combos** before
   writing. The current example: secure cookies on, trust proxy off (the
   browser will refuse to send the cookie over HTTP). Add similar
   guards for any future setting that can lock the operator out.
4. **`GET /system/logs` falls back gracefully** when the log directory
   is unreadable — it returns `success: true` with an empty file list
   and a warning, never 500. Preserve this when extending the route.
5. **`GET /system/validation-quarantine` strips raw payloads** before
   returning. They can contain upstream tokens / PII. Do not "improve"
   the response by re-including them.
6. **Log download paths are sanitized** against traversal — basename
   only, must resolve inside `LOG_DIR`. Do not relax this.
7. **The Security Posture roll-up severity reserves `misconfigured` for
   "do not ship / cannot work" conditions.** Hardening recommendations
   live at `warning`. See [ADR-0002](../adr/0002-security-posture-evaluator.md).

## Major integration points

- **Auth domain** provides `app.encryptor` and `app.sessionService`,
  consumed indirectly by the security-posture evaluator (auth-method
  counts) and by every protected route on this domain.
- **Schedulers domain** provides `app.schedulerRegistry`, surfaced via
  `/system/jobs`.
- **Services domain** emits validation stats consumed by
  `/system/validation-health`.
- **Frontend** has exactly one consumer file (`system-tab.tsx`). Do not
  fan out diagnostics into other tabs without a strong reason —
  centralizing them is the point.

## Common failure modes / operational notes

- **Restart endpoint hammered** — rate-limited to 2 per 5 minutes; clients
  see 429. By design.
- **Log directory missing in dev** — returns empty file list with a
  warning, not an error. Operator can confirm `LOG_DIR` is set correctly.
- **Settings change shows "Restart Required" forever** — usually means
  the env var being compared (e.g., `TRUST_PROXY`) wasn't actually set in
  the environment, so the running process default doesn't match the new
  DB value. Check the actual env.
- **Posture flips between healthy/warning across reloads** — usually
  reflects a real condition flipping (e.g., setup just completed,
  passkey just registered). The endpoint polls on `POLLING_STANDARD`.
- **Long `/system/jobs` polling load** — the response size scales with
  the number of registered jobs (currently O(20)). It is not paginated;
  if catalog grows substantially, paginate before profiling.

## Where to add new code

| Change | Goes in |
|---|---|
| New `/system/X` GET diagnostic | (1) handler in `routes/system.ts`; (2) optional pure evaluator under `lib/<area>/`; (3) types + `fetch*` in `lib/api-client/system.ts`; (4) query-key entry in `apps/web/src/lib/query-keys.ts` under `systemKeys`; (5) `use*` hook in `hooks/api/useSystem.ts`; (6) section component under `features/settings/components/`; (7) render in `system-tab.tsx`; (8) add a row to [`docs/API-ROUTES.md`](../API-ROUTES.md) |
| New mutating `/system/X` route | same as above + a real justification + rate limit + an audit log line via `request.log.info(…)` including `userId` |
| New `SystemSettings` field | add to `prisma/schema.prisma`; run `pnpm --filter @arr/api run db:push`; thread through GET + PUT handlers; if env-driven, also expose an `effective<Field>` twin per the stored-vs-effective pattern; decide and document whether it needs restart |
| New posture check | extend `lib/security/security-posture.ts` (pure) + a unit test; choose severity per ADR-0002; UI updates automatically |
| New validation integration | wire into `integrationHealth` in `lib/validation/`; it surfaces in `/validation-health` automatically |

## When to update this doc

- A new `/system/X` endpoint is added.
- The "stored vs. effective" or "requiresRestart" model changes.
- A new diagnostic subsystem is plugged in (e.g., metrics, tracing).
- An invariant in the list above changes (severity: also write an ADR).

Per-route response shapes belong in [`docs/API-ROUTES.md`](../API-ROUTES.md).
Per-check posture rules belong in code comments inside
`security-posture.ts` (single source of truth).
