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

### 3. Migration: first-boot confirmation dialog, no advance banner

*(Amended 2026-06-09 — originally specified as a three-path wizard; see
the amendment note below.)*

No 2.x warning banner ships (decision #3 — the 2.x line stays quiet).
Instead, if any `ServiceInstance` row with `service = TAUTULLI` exists
at first 3.0 boot, the dashboard presents a **blocking confirmation
dialog** (decision #4) — one screen, two actions:

1. **Remove Tautulli & continue** — deletes the Tautulli rows; live
   sessions keep working; Statistics shows "historical analytics
   unavailable — set up Tracearr in Settings" (decision #5's
   no-analytics path).
2. **Set up Tracearr →** — navigates to Settings → Services with the
   add-Tracearr form ready, and notes Tracearr's built-in Tautulli
   history import. Returning with a Tracearr instance configured (or
   choosing Remove afterwards) resolves the dialog.

The dialog blocks the dashboard until resolved — it is one click, so no
"remind me later" state is needed — and copy mentions that staying on
2.x is a Docker-tag decision documented in the release notes.

**No silent data loss**: Tautulli rows are deleted only by explicit
choice, and the dialog is the only deleter.

**Amendment note (2026-06-09):** the original three-path *wizard* — with
an embedded Tracearr connection walkthrough and a "stay on 2.x" exit —
was downscoped after review. The embedded walkthrough would have
duplicated Settings → Services' add-service flow (a second setup UI to
maintain forever) and created a hard dependency: the Tautulli removal
(Bucket A2) could not ship before the Tracearr integration existed.
As a navigation link, that dependency becomes soft — A2 ships
independently and the link target improves when Tracearr lands. The
"stay on 2.x" path needed no UI at all: not upgrading is a decision
made before boot, owned by release notes. The migration invariants —
consent before deletion, can't-miss presentation, a pointer to the
successor — are fully preserved in the dialog.

**Implementation note (2026-06-10, shipped with the A2 removal PR):**
the dialog shipped with a **single** action — "Remove Tautulli &
continue" — not two. The "Set up Tracearr →" button would have been a
dead CTA: Tracearr has no service-form entry until charter C2 lands, so
the link had nowhere truthful to point. The successor pointer is
informational copy instead ("your watch history remains inside Tautulli
itself; Tracearr imports it from there"), which upgrades to a deep link
when Tracearr lands. Endpoints: `GET/POST /api/system/migrations/tautulli`
(operator tier, under `/api/system`); the GET includes the rules-pass
report for the disclosure block. All migration invariants hold — the
POST is the only deleter of Tautulli rows.

## Why this shape

1. **Removal-with-destination beats deprecation-without-one.** The
   earlier plan deprecated Tautulli with nothing to point users at.
   Tracearr's Tautulli import turns a takeaway into a swap.
2. **The blocking dialog concentrates all migration friction into one
   honest moment.** A dismissible banner gets dismissed; a half-broken
   Tautulli tab generates support issues for a year.
3. **Reuse the real setup flow.** The dialog links to Settings →
   Services rather than embedding a parallel setup path — one
   add-service UI, maintained once, and the migration code stays a
   dialog + a delete.
4. **Full write parity from day one** keeps the integration from
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
  would miss it anyway, which is exactly what the first-boot dialog
  cannot miss.
- **Auto-deleting Tautulli config on upgrade.** Cheapest to build,
  silently destroys user configuration. Violates the trust thesis.

## Consequences

### Positive

- Analytics collapses from four maintained paths to two clearly-roled
  ones (Tracearr historical, native live).
- ~7,000 lines of the least-tested integration leave the codebase.
- The dialog pattern (blocking, explicit consent, no silent loss) becomes
  the template for any future integration removal.

### Negative / trade-offs

- Tracearr is young; its API may churn. Mitigated by the existing
  upstream-validation infrastructure (Zod schemas, quarantine,
  validation-health surface) — drift degrades gracefully and visibly.
- Users who want neither Tracearr nor data loss have no in-place
  option; staying on 2.x is honest but is still an exit, not an
  accommodation. Accepted: single-admin self-hosted users control their
  own upgrade timing.
- AGPL-3.0: arr-dashboard consumes Tracearr's HTTP API only — a normal
  client relationship, no code linkage. No license obligation arises.

**Amendment note 2 (2026-06-09) — A2 is sequenced AFTER A4:** the
removal inventory found that Tautulli is a *data source*, not just an
integration: Library Cleanup's rule grammar has three Tautulli-typed
condition kinds (`tautulli_last_watched`, `tautulli_watch_count`,
`tautulli_watched_by`) stored in user rules (and reachable from
Auto-Tagger, which reuses the same evaluators), and the `TautulliCache`
table feeds the cleanup executor plus the Plex AND Jellyfin
watch-enrichment routes. Removing Tautulli therefore orphans stored
user rules — a stored-rule migration, which is exactly what ADR-0006's
5-point contract exists for. ~~A2 lands after A4's unified engine +
migration framework~~ **Superseded by ADR-0006 amendment 2
(2026-06-09): eager format migration was eliminated from A4 entirely
(parse-time versioning), so the Tautulli pass is self-contained over
the existing stored-document format and A2 is again independent — and
sequenced FIRST. The pass still runs under the full 5-point contract
(it is the one semantic migration in 3.0), and its rule-count report
feeds this dialog's disclosure.** The first-boot dialog additionally discloses how many of
the user's stored rules referenced Tautulli watch data. Watch-enrichment
re-pointing (Plex/Jellyfin enrichment reads of TautulliCache → Tracearr
or SessionSnapshot equivalents) is scoped into A2 alongside the
Statistics overview-tab migration.

## Follow-ups

- Bucket C2 (Statistics rewrite on Tracearr) starts only after the
  Tracearr client + routes land.
- Dialog ships in the same PR as the Tautulli removal — the removal
  must never exist on `next` without its migration path.
- The `ServiceType.TAUTULLI` Prisma enum value is RETAINED (with a
  deprecation comment) until 4.0 — removing it would make pre-dialog
  rows undeserializable and crash boot before the dialog could render.
  The dialog is the only deleter of rows; the enum value goes when no
  supported upgrade path can still carry such rows.
- Schedule Tracearr's `experimental` → graduation review at 3.0-rc
  (per ADR-0005).
