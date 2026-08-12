# Tracearr Primary with Tautulli Alternative

**Status:** Approved product direction; implementation plans complete
**Date:** 2026-08-12
**Target:** `next` / arr-dashboard 3.0
**Related:** Issue #689, ADR-0007, the Next Maintenance Parity Program

## Implementation plans

Execute these bounded plans in order:

1. `../plans/2026-08-12-tautulli-preservation-migration.md`
2. `../plans/2026-08-12-tautulli-runtime-restoration.md`
3. `../plans/2026-08-12-analytics-provider-selection.md`
4. `../plans/2026-08-12-durable-upstream-identity.md`

## Decision

arr-dashboard 3.0 supports both Tracearr and Tautulli as historical analytics
providers.

- Tracearr is the recommended provider and the default for fresh installations.
- Tautulli is a supported alternative, not a deprecated compatibility mode.
- Existing Tautulli users keep their configuration, cache data, and stored rules.
- Users may configure both providers, but arr-dashboard reads historical analytics
  from one selected provider family at a time.
- Data from Tracearr and Tautulli is never silently combined.
- A provider outage never causes silent runtime failover to the other provider.

This supersedes ADR-0007's decision to remove Tautulli from 3.0. ADR-0007 must
remain in the repository as historical context but be marked superseded by a new
ADR implementing this decision.

## Goals

1. Restore Tautulli as a maintainable first-class 3.0 integration.
2. Preserve Tracearr as the recommended and default analytics experience.
3. Make provider selection deterministic and operator-controlled.
4. Preserve existing Tautulli installations and Tautulli-dependent rules.
5. Bind provider evidence to a durable upstream server identity before it can
   influence cache publication or cleanup safety.
6. Deliver the change in bounded, independently reviewable waves.

## Non-goals

- Do not aggregate or deduplicate Tracearr and Tautulli analytics together.
- Do not automatically import Tautulli history into Tracearr.
- Do not silently switch providers during an outage.
- Do not restore stable 2.x files wholesale; adapt only supported behavior to the
  3.0 architecture and validation rules.
- Do not weaken native Plex, Jellyfin, or Emby live-session support.
- Do not let unverified analytics evidence authorize deletion or another upstream
  mutation.

## Provider selection

Add a singleton system setting named `analyticsProvider` with the allowed values
`tracearr` and `tautulli`.

Resolution rules are deterministic:

1. Fresh installations default to `tracearr`.
2. An upgrade containing one or more Tautulli instances and no Tracearr instance
   selects `tautulli`, preserving the user's working behavior.
3. An upgrade containing both provider families selects `tracearr` unless an
   existing explicit setting says otherwise.
4. All enabled instances of the selected provider family may participate in that
   family's existing aggregation behavior.
5. The unselected provider remains configured and healthy but does not contribute
   historical analytics to dashboards, statistics, rules, or cleanup evidence.
6. Disabling or deleting the last enabled instance of the selected provider does
   not silently change the setting. The UI must offer an explicit switch to the
   other configured provider or explicit confirmation that historical analytics
   will remain unavailable.
7. If the selected provider is unavailable, the application reports degraded
   analytics and keeps the selected source. It does not substitute data from the
   other provider.

Settings describes Tracearr as **Recommended** and Tautulli as **Alternative**.
The administrator can change the selected provider without deleting either
configuration.

## Tautulli restoration

Tautulli restoration includes the supported integration surface needed for
feature parity, not merely accepting a `TAUTULLI` enum value:

- encrypted connection configuration and connection testing;
- normalized client and upstream schemas;
- cache refresh, scheduler, status, Pulse, and validation-health behavior;
- historical statistics and watch-enrichment consumers selected through the
  analytics-provider resolver;
- Settings and setup/onboarding UI;
- API route manifest and API documentation;
- incognito masking for identifiable server, user, and title data;
- Tautulli-specific stored rule kinds and evaluation behavior;
- focused malformed-response, pagination, timeout, partial-success, retry, and
  multiple-instance tests.

The restoration must reuse current 3.0 primitives for provider generations,
atomic cache publication, failure-attempt status, unified rules, query keys, and
Pulse. Legacy 2.x runtime code is reference material only.

## Migration behavior

The current blocking Tautulli-removal flow is retired.

- Upgrades must not delete a Tautulli service instance or alter a
  Tautulli-dependent rule merely because 3.0 starts.
- Existing Tautulli-only installations select Tautulli as their analytics
  provider automatically to preserve behavior.
- Existing installations with both providers default to Tracearr and may select
  Tautulli in Settings.
- Previously deleted configurations cannot be reconstructed safely. The
  application must not invent URLs or credentials from stale caches or backups.
- Any old Tautulli-removal report remains historical audit evidence only. It has
  no user or deleted-instance identity, cannot prove user-scoped removal, and
  current upgrades show no recovery or removal notice from it alone.

Stored `tautulli_*` rule kinds become legal and evaluable again when Tautulli is
the selected provider. They remain visible and fail closed when their required
Tautulli evidence is unavailable. They are not automatically rewritten into
Tracearr predicates because the data sources are not semantically identical.

### Replacement for the removal wizard

There is no new blocking wizard. Upgrading must not prevent access to the
dashboard when the application can preserve a valid configuration safely.

- **Tautulli only:** preserve every Tautulli instance and rule, select Tautulli,
  and continue without prompting.
- **Tracearr only:** keep Tracearr selected and continue without prompting.
- **Both configured:** select Tracearr by default and show a one-time,
  non-blocking notice explaining that Tracearr is primary and Tautulli remains
  available. The notice links directly to the analytics-provider selector.
- **Neither configured:** continue normally and show the ordinary unconfigured
  analytics state with Setup links for both providers.
- **Prior beta removal:** do not show a recovery notice from the existing
  installation-wide migration report. The `tautulli-prior-removal` notice kind
  is reserved and dormant until a future durable evidence source identifies the
  affected user and actual deletion.

The notice is dismissible, never deletes data, and is not required for future
application startup. Its dismissal state is durable so it does not reappear on
every restart. The provider selector remains available in Settings after the
notice is dismissed.

## Durable upstream identity

Add a nullable `upstreamIdentity` to each service instance. Store canonical,
namespaced values:

- Plex: `PLEX:<machineIdentifier>`
- Jellyfin: `JELLYFIN:<server Id>`
- Emby: `EMBY:<server Id>`
- Tautulli: a verified associated Plex identity when Tautulli can report it
  reliably

The field is not unique because multiple configured instances may intentionally
reach the same physical server using different credentials or URLs.

### New connections

Creating a Plex, Jellyfin, or Emby connection performs a server-side identity
probe using the submitted credential inputs. A successful probe binds the
identity during creation. Creating Tautulli also probes for its associated Plex
identity; if the verified Tautulli API contract cannot supply one, creation may
proceed only with the explicit analytics-only limitation described below. The API
never trusts a client-supplied identity as authority.

### Existing connections

An existing row with no durable identity is **unbound**. This means the URL and
credentials still exist, but arr-dashboard has not recorded which immutable
upstream server the administrator authorizes that connection to represent.

- Unbound is not the same as disabled or disconnected.
- Settings shows the state and an **Enroll current server** action.
- Enrollment probes the server, displays operator-safe server information, and
  stores the observed identity only after explicit confirmation.
- Ordinary connection testing never enrolls or replaces identity silently.
- Until enrollment, identity-dependent cache publication and cleanup evidence
  fail closed with an actionable status.

### Normal edits and replacement

- A URL, proxy, or credential change that still reaches the enrolled server is a
  normal update.
- A different observed identity returns `409 Conflict` without changing the
  connection, cache, or stored identity.
- The UI presents a distinct **Replace enrolled server** confirmation.
- Confirmed replacement probes the proposed connection and atomically updates the
  connection, identity, connection generation, and cache invalidation state.
- Failed replacement leaves the prior configuration and evidence unchanged.

### Runtime enforcement

Identity is checked before and after gathering a provider cache or read-only
cleanup snapshot. Publication or selection requires:

1. an enrolled expected identity;
2. a matching identity before gathering;
3. the same matching identity after gathering; and
4. a still-current connection generation at transaction time.

This covers a stable reverse proxy pointing at the wrong server, a proxy changing
upstreams during a refresh, ordinary reverse-proxy use, and intentional server
replacement.

For Tautulli, implementation must first verify a reliable API contract for the
associated Plex machine identifier. If no reliable identity is available,
Tautulli remains usable for operator-visible analytics but its evidence cannot
authorize deletion-sensitive cleanup. That limitation must be visible in
Settings, Pulse, and cleanup explanations.

## Error handling and observability

- Provider-selection errors identify the selected family without exposing URLs,
  credentials, server identifiers, usernames, or titles in incognito mode.
- Unbound and mismatched identities produce distinct actionable states.
- A failed refresh records the attempt while retaining the last successful cache
  generation.
- Provider changes invalidate process-local Pulse data after the transaction
  commits.
- Partial or malformed upstream responses never publish a replacement cache
  generation.
- No success is recorded until the upstream read and guarded database publication
  both succeed.

## Delivery waves

1. **Governance and migration reversal**
   - Add a superseding ADR.
   - Update the 3.0 charter, `CLAUDE.md`, route-tier documentation, and the
     maintenance parity plan.
   - Replace the destructive blocking wizard with preservation semantics and the
     bounded non-blocking notices defined above.

2. **Tautulli runtime restoration**
   - Restore the bounded backend, cache, scheduler, routes, schemas, and UI using
     3.0 primitives.
   - Restore Tautulli rule legality and fail-closed evaluation.

3. **Provider selection**
   - Add the system setting, API, Settings control, deterministic resolver, and
     migration defaults.
   - Route historical analytics and rule evidence only through the selected
     provider family.

4. **Durable identity**
   - Add enrollment, mismatch, replacement, cache-publication, and cleanup-evidence
     enforcement for Plex, Jellyfin, Emby, and Tautulli where supported.

Each wave gets one frozen review inventory, one correction batch, focused tests,
the project validation gauntlet, and a local checkpoint before the next wave.

## Acceptance coverage

### Provider choice

- fresh install defaults to Tracearr;
- Tautulli-only upgrade preserves configuration and selects Tautulli;
- both configured defaults to Tracearr;
- administrator can select Tautulli without deleting Tracearr;
- selected-provider outage is visible and does not silently fail over;
- no analytics response combines both provider families;
- disabling/removing the selected provider requires an explicit choice;
- incognito mode masks both providers consistently.

### Tautulli preservation

- no startup or migration path deletes a Tautulli instance without a new explicit
  delete action;
- Tautulli-only and Tracearr-only upgrades require no migration prompt;
- both-provider upgrades show one dismissible notice and never block dashboard
  access;
- notice dismissal survives restart and never changes provider selection;
- Tautulli-dependent rules remain stored and evaluate only from current selected
  evidence;
- beta installations whose prior migration already deleted configuration receive
  recovery guidance rather than fabricated restoration;
- malformed, incomplete, paginated, and failed Tautulli responses preserve the
  last successful generation.

### Identity safety

- stable wrong-server proxy fails before cache publication or cleanup selection;
- identity change between reads fails closed;
- normal reverse proxy with stable identity succeeds;
- existing unbound instance requires explicit enrollment;
- ordinary connection test does not enroll;
- intentional replacement requires confirmation and clears old evidence
  atomically;
- concurrent refresh and replacement cannot publish stale evidence;
- Tautulli without reliable Plex identity cannot authorize cleanup;
- ownership, disabled-instance, retry, idempotency, and partial-failure cases are
  covered.

## Documentation outcome

The final 3.0 documentation states one consistent policy: Tracearr is the
recommended historical analytics provider, Tautulli is a supported alternative,
and the administrator controls which provider family supplies historical
analytics. Neither choice weakens deletion safety.
