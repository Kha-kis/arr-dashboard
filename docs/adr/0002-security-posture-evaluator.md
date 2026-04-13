# ADR 0002: Security Posture Evaluator + Diagnostics Surface

- **Status:** Accepted
- **Date:** 2026-04-13
- **Deciders:** Backend + frontend maintainers
- **Supersedes:** —
- **Related:** [ADR-0001](0001-scheduler-registry.md) (same observer-not-actor shape)

## Context

The app exposes several security-relevant settings (trust proxy, secure
cookies, OIDC, passkeys, password policy, session TTL). Some are stored
in the DB, some come from the environment, and the *effective* value at
runtime depends on both. Operators had no way to ask, from inside the
product, "is my setup safe?" — the only signal was reading code or env.

Worse, certain combinations are actively dangerous (e.g., `COOKIE_SECURE=true`
with `TRUST_PROXY=false` over plain HTTP locks users out), and the
existing `PUT /system/settings` validator only catches the *DB-write*
path. The env-var path bypassed it entirely.

We needed a visibility surface that:

- aggregates effective config + observable auth state (OIDC enabled,
  passkey count, password user count),
- flags genuinely broken combinations,
- offers opinionated hardening recommendations *without* drowning the
  broken-combination signal,
- can be unit-tested without spinning up Fastify or Prisma.

## Decision

Introduce a **pure evaluator** (`lib/security/security-posture.ts`) and
a **thin aggregator route** (`GET /system/security-posture`).

### Pure evaluator

`evaluateSecurityPosture(input) → SecurityPostureResult`

- Input is a plain object: env snapshot + OIDC enabled + passkey count
  + password user count + total user count.
- Output: per-check severity-tagged list, a worst-case overall severity,
  the `effective` runtime values verbatim, and an `auth` summary.
- Three severities: `healthy`, `warning`, `misconfigured`.
- No I/O. No Fastify. No Prisma. The route handler is responsible for
  gathering the inputs.

### Severity discipline

The roll-up is the load-bearing UI signal — admins read the top badge to
decide whether to act. We deliberately separate two kinds of finding:

| Severity | Meaning | Examples |
|---|---|---|
| `misconfigured` | Cannot work / will lock users out / actively harms | Secure cookies + no trust proxy; users exist but no auth methods active |
| `warning` | Works fine; an observable hardening opportunity exists | Password-only auth; relaxed password policy in production; >14-day session TTL in production; non-https `APP_URL` in production |
| `healthy` | No issue detected | — |

Hardening warnings must never be promoted to `misconfigured`. Doing so
collapses the "do not ship" signal into "could be slightly better,"
which trains operators to ignore the banner.

### Route

`GET /system/security-posture` queries the four counts in parallel,
calls the pure evaluator, and returns its result with a `capturedAt`
timestamp. No mutation, no caching, no rate limit (it polls on
`POLLING_STANDARD`).

### Frontend

A single section component (`SecurityPostureSection`) renders inside
the existing `SystemTab`, between System Information and Validation
Health. No new tab, no new route. Reuses `StatusBadge` /
`PremiumSection` / `PremiumSkeleton` — no new design primitives.

## Why a pure evaluator

1. **Testable without harness.** Every check is a unit test against a
   plain input object. The PR landed with 21 unit tests covering every
   severity branch plus malformed-URL edge cases.
2. **Single source of truth for severity.** The route, the UI, future
   notification triggers, and any CLI tool all read from the same
   evaluator. No drift.
3. **Composability.** A future "send me a Slack alert when posture goes
   misconfigured" job can call the evaluator with the same inputs and
   compare against a stored baseline — no new evaluation logic needed.

## Why not …

- **A `SecuritySettings` model in Prisma.** Most posture inputs are
  derived from `app.config` (env) or counted from existing tables. A
  dedicated table would only encode opinions about thresholds, which
  belong in code where they're reviewed alongside changes.
- **Inline `if`s in the route handler.** Tested through HTTP, less
  reusable, and the severity rules drift from any future consumer.
- **A new "Security" tab in Settings.** Would split diagnostic surfaces
  across two tabs (System and Security) and dilute discoverability. The
  System tab is already where operators look for "is this app okay?"

## Consequences

### Positive

- Operators get a single banner ("Action required" / "Recommended
  improvements" / "All checks passing") that they can trust.
- Adding a check is a one-file change to `security-posture.ts` plus a
  test; the UI updates automatically.
- The dangerous `COOKIE_SECURE=true` + `TRUST_PROXY=false` env-var path
  is now visible — previously only the DB-write path was guarded.

### Negative / trade-offs

- The check rules are opinionated (especially the >14-day TTL warning
  and the "consider passkeys" nudge). We accept that opinion explicitly
  by tagging them as `warning`-severity, distinct from real
  misconfiguration.
- Counts are read on every poll. At the current cardinality (a handful
  of users / passkeys) this is negligible; if it grows, batch into a
  short-TTL in-memory cache before profiling.
- Severity discipline is enforced by convention, not types. A future
  contributor adding a hardening check at `misconfigured` severity
  would degrade the roll-up signal. The check list in this ADR plus
  the unit tests are the reviewer's cue.

## Follow-ups

- Action links from each check into the relevant settings sub-section
  (requires sub-route refactor in Settings).
- Optional notification trigger when overall severity transitions to
  `misconfigured` (uses the same evaluator).
- Encryption-key age tracking, once `secret-manager.ts` records a
  generated-at timestamp.
