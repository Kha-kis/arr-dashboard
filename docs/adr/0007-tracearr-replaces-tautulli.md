# ADR 0007: Tracearr Replaces Tautulli

- **Status:** Accepted
- **Date:** 2026-06-09
- **Deciders:** Backend maintainers
- **Supersedes:** the phased Tautulli-deprecation plan (memory-tracked, pre-charter)
- **Charter:** [3.0 charter](../3.0-charter.md) §2.2, Bucket A2, §6.1; decision log #2–#6

## Context

Tautulli's role in arr-dashboard has been shrinking for two release
cycles. The "Option 3" arc (PRs #373–#382) made SessionSnapshot the
canonical analytics source and gave Jellyfin/Emby parity with Plex by
moving the aggregation helpers into shared code; Tautulli became an
optional enrichment source. The 3.0 inventory measured what remains:

- **6 sub-route files** (vs Plex's 33, Jellyfin's 14), 1 test file —
  the smallest and least-tested media-server integration.
- One remaining consumer of `useTautulliStats` /
  `useTautulliPlaysByDate` (the Statistics overview tab).

Meanwhile [Tracearr](https://github.com/connorgallopo/Tracearr)
(AGPL-3.0, self-hosted) emerged as the community's Tautulli successor:
one integration covering **Plex + Jellyfin + Emby**, a public REST API
(Swagger at `/api-docs`, API-key auth), Plex SSE for instant session
detection, and — decisively — **built-in Tautulli history import**, so
migrating users keep their watch data. Users asked for it directly
(issue #487), with parallel requests open across the ecosystem
(Maintainerr, Seerr).

Maintaining four analytics paths (Tautulli + native Plex + Jellyfin +
Emby sessions) is the kind of surface-area sprawl the 3.0 charter
exists to remove.

## Decision

### 1. Tautulli is removed outright in 3.0

All of `routes/tautulli/`, `lib/tautulli/`, `useTautulli*` hooks,
schemas, settings UI, and `ServiceType.TAUTULLI` handling are deleted
(charter Bucket A2). No deprecation window, no `deprecated` tier
(see ADR-0005's "why not"). The 2.x line keeps Tautulli working until
its end of life.

### 2. Tracearr becomes the analytics backbone, with full read+write parity

- Backend client (`lib/tracearr/`), routes (`routes/tracearr/`),
  `ServiceType.TRACEARR`, connection tester, settings UI, validation-
  health entry. Enters the route manifest at `experimental`, graduating
  by ADR-0005 criteria.
- **Read**: sessions, history, leaderboards, transcode analytics, trust
  scores — the Statistics rewrite (Bucket C2) re-targets the last
  Tautulli consumers here.
- **Write**: stream termination, bulk actions on Tracearr-side
  users/rules, trust-score actions (decision #6: full parity, not
  read-only).
- Native Plex/Jellyfin/Emby session helpers remain the **live** data
  source; Tracearr is the **historical/analytics** source. The
  `routes/plex/lib/` helpers are renamed to reflect their shared role
  (charter Bucket A3).

### 3. Migration: first-boot blocking wizard, no advance banner

No 2.x warning banner ships (decision #3 — the 2.x line stays quiet).
Instead, if any `ServiceInstance` row with `service = TAUTULLI` exists
at first 3.0 boot, the dashboard presents a **blocking, non-dismissible
wizard** (decision #4) with three paths (decision #5):

1. **Set up Tracearr (recommended)** — walks through connection, points
   at Tracearr's built-in Tautulli import for history carry-over, then
   removes the Tautulli rows.
2. **Continue without historical analytics** — removes the Tautulli
   rows; live sessions keep working; Statistics shows "historical
   analytics unavailable — set up Tracearr in Settings."
3. **Stay on 2.x** — exits cleanly; the operator pins the previous
   Docker tag.

**No silent data loss**: Tautulli rows are deleted only by explicit
choice, and the wizard is the only deleter.

## Why this shape

1. **Removal-with-destination beats deprecation-without-one.** The
   earlier plan deprecated Tautulli with nothing to point users at.
   Tracearr's Tautulli import turns a takeaway into a swap.
2. **The blocking wizard concentrates all migration friction into one
   honest moment.** A dismissible banner gets dismissed; a half-broken
   Tautulli tab generates support issues for a year.
3. **Full write parity from day one** keeps the integration from
   shipping as a second-class read-only viewer that needs a follow-up
   release to be useful for operators (kill-stream is the single most
   requested analytics action).

## Why not …

- **Phased deprecation (demote tier in 3.0, remove in 4.0).** The
  charter draft's option 3. Rejected at ratification: Tautulli usage in
  this codebase is already vestigial, the maintenance window would span
  a 6–12 month cycle for an integration with one remaining consumer,
  and Tracearr's import removes the data-loss argument for going slow.
- **Keeping both integrations.** Three analytics paths becomes four;
  contradicts the charter thesis directly.
- **A 2.x advance-warning banner.** Adds a coordinated 2.x release to
  the critical path for marginal benefit — users who skip versions
  would miss it anyway, which is exactly what the first-boot wizard
  cannot miss.
- **Auto-deleting Tautulli config on upgrade.** Cheapest to build,
  silently destroys user configuration. Violates the trust thesis.

## Consequences

### Positive

- Analytics collapses from four maintained paths to two clearly-roled
  ones (Tracearr historical, native live).
- ~7,000 lines of the least-tested integration leave the codebase.
- The wizard pattern (blocking, explicit paths, no silent loss) becomes
  the template for any future integration removal.

### Negative / trade-offs

- Tracearr is young; its API may churn. Mitigated by the existing
  upstream-validation infrastructure (Zod schemas, quarantine,
  validation-health surface) — drift degrades gracefully and visibly.
- Users who want neither Tracearr nor data loss have no in-place
  option; path 3 (stay on 2.x) is honest but is still an exit, not an
  accommodation. Accepted: single-admin self-hosted users control their
  own upgrade timing.
- AGPL-3.0: arr-dashboard consumes Tracearr's HTTP API only — a normal
  client relationship, no code linkage. No license obligation arises.

## Follow-ups

- Bucket C2 (Statistics rewrite on Tracearr) starts only after the
  Tracearr client + routes land.
- Wizard ships in the same PR as the Tautulli removal — the removal
  must never exist on `next` without its migration path.
- Schedule Tracearr's `experimental` → graduation review at 3.0-rc
  (per ADR-0005).
