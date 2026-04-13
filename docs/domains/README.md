# Domain operating manuals

Short, durable docs answering **where does this change belong**, **what
invariants must hold**, and **what fails in the wild** for each major
backend domain.

These are intentionally not exhaustive references. They link out to
deep dives (`docs/AUTH.md`, `docs/API-ROUTES.md`) and ADRs
(`docs/adr/`) for the *what* and *why*. The job here is the *where*.

| Domain | Read this when … |
|---|---|
| [Auth](auth.md) | touching login, sessions, encryption, OIDC, passkeys, or anything that decides who a request belongs to |
| [Schedulers](schedulers.md) | adding or modifying a background job, or wiring something into `/system/jobs` |
| [Services](services.md) | adding or modifying a Sonarr / Radarr / Plex / Tautulli / Jellyfin / Seerr integration |
| [System](system.md) | adding a `/system/*` endpoint or a section to the System tab in Settings |

For when to update these docs vs. when to write an ADR, see the
"Architecture-Affecting Changes" section in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).
