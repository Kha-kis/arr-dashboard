# ADR 0009: Tracearr Primary with Tautulli Alternative

- **Status:** Accepted
- **Date:** 2026-08-12
- **Deciders:** Backend maintainers
- **Supersedes:** [ADR-0007](0007-tracearr-replaces-tautulli.md)

## Decision

arr-dashboard 3.0 supports both Tracearr and Tautulli as historical analytics
providers.

- Tracearr is the recommended provider and the default for fresh installations.
- Tautulli is a supported alternative, not a deprecated compatibility mode.
- Existing Tautulli users keep their configuration, cache data, and stored rules.
- Administrators may configure both providers, but historical analytics come
  from one selected provider family at a time.
- Data from Tracearr and Tautulli is never silently combined.
- A provider outage never causes silent runtime failover to the other provider.

## Deterministic provider selection

The system setting `analyticsProvider` has the allowed values `tracearr` and
`tautulli`.

1. Fresh installations default to `tracearr`.
2. An upgrade with one or more Tautulli instances and no Tracearr instance
   selects `tautulli`.
3. An upgrade with both provider families selects `tracearr` unless an existing
   explicit setting says otherwise.
4. All enabled instances of the selected provider family may participate in
   that family's existing aggregation behavior.
5. The unselected provider remains configured and healthy but contributes no
   historical analytics to dashboards, statistics, rules, or cleanup evidence.
6. Disabling or deleting the last enabled instance of the selected family does
   not silently change the setting; the UI offers an explicit switch or an
   explicit confirmation that historical analytics will remain unavailable.
7. If the selected provider is unavailable, the application reports degraded
   analytics and keeps the selected source.

Settings describes Tracearr as **Recommended** and Tautulli as **Alternative**.

## Migration and removal governance

There is no blocking Tautulli-removal wizard. Upgrades do not delete a
Tautulli instance or alter a Tautulli-dependent rule merely because 3.0 starts.

- **Tautulli only:** preserve every Tautulli instance and rule, select Tautulli,
  and continue without prompting.
- **Tracearr only:** keep Tracearr selected and continue without prompting.
- **Both configured:** select Tracearr by default and show a one-time,
  non-blocking notice that Tracearr is primary and Tautulli remains available;
  link to the provider selector.
- **Neither configured:** continue normally and show the ordinary unconfigured
  analytics state with setup links for both providers.
- **Prior beta removal:** the existing installation-wide migration report is
  historical audit evidence only. It contains no user identity or deleted
  instance identity, so it cannot prove user-scoped removal and current
  upgrades show no recovery or removal notice from that report alone.

The `tautulli-prior-removal` notice kind remains reserved and dormant until a
future durable evidence source identifies both the affected user and the actual
deletion. Notices are dismissible, durable, and never delete data. Old removal
reports are not authority to delete a newly added Tautulli instance or to
attribute recovery to a user. Previously deleted configurations cannot be
reconstructed safely.

Stored `tautulli_*` rule kinds are legal and evaluable again when Tautulli is the
selected provider. They fail closed when required Tautulli evidence is
unavailable and are not rewritten into Tracearr predicates.

## Identity-gated cleanup evidence

Provider evidence cannot authorize deletion-sensitive cleanup unless the
upstream identity is durably enrolled and verified. Publication or selection of
such evidence requires:

1. an enrolled expected identity;
2. a matching identity before gathering;
3. the same matching identity after gathering; and
4. a still-current connection generation at transaction time.

For Tautulli, the identity is a verified associated Plex identity when the API
can report it reliably. If it cannot, Tautulli remains usable for operator-
visible analytics but its evidence cannot authorize deletion-sensitive cleanup.
Unbound and mismatched identities fail closed with actionable status.

## Consequences

Tracearr remains the primary 3.0 analytics experience while existing Tautulli
installations are preserved. Provider choice is explicit and deterministic,
and cleanup cannot act on analytics evidence whose upstream identity is not
proven. Runtime restoration, provider selection, and durable identity are
implemented in bounded follow-up plans.
