---
name: integration-auditor
description: Specialized knowledge for reviewing *arr and adjacent service integrations — API patterns, normalization, version-line differences, monitoring semantics, and common drift issues
type: skill
---

# Integration Auditor Knowledge

Load this skill when working with Sonarr, Radarr, Prowlarr, Lidarr,
Readarr, Plex, Jellyfin, Emby, Tautulli, Seerr, qui, or Tracearr integrations.

## Resolve the release line first

- On stable 2.x (`main`), Tautulli remains a supported integration. Tracearr is
  not part of the stable contract.
- On 3.0 (`next`), Tautulli is removed from the product surface; its enum value
  remains only for migration compatibility. Tracearr is its analytics
  replacement, and qui is a stable integration.
- Never forward-port integration code mechanically. Re-evaluate service
  availability, route maturity, stored rows, migrations, and UI consumers on
  the target branch.

## Service Architecture

Each service integration follows this pattern:
- **API client**: `apps/web/src/lib/api-client/<service>.ts` — frontend fetch wrappers
- **Domain hooks**: `apps/web/src/hooks/api/use<Service>.ts` — TanStack Query hooks
- **Backend routes**: `apps/api/src/routes/<service>.ts` — Fastify handlers
- **SDK calls**: Backend uses `arr-sdk` for typed *arr API access
- **Normalizers**: `apps/api/src/lib/library/*-normalizer.ts` — transform raw API data to `LibraryItem`

## Normalizer Field Mapping (Critical)

Each *arr service has different API shapes. The normalizers map them to a unified `LibraryItem` type. Key traps:

**Monitored count fields** (the #209 bug family):
- Sonarr: `statistics.episodeCount` (monitored) vs `statistics.totalEpisodeCount` (all) — ALWAYS use `episodeCount`
- Lidarr: `statistics.trackCount` (monitored albums) vs `statistics.totalTrackCount` (all) — ALWAYS use `trackCount`
- Radarr: No sub-level monitoring — movies are either monitored or not
- Readarr: Same as Radarr — books are monitored/not

**Date fields** (the #207 bug family):
- Sonarr: `airDate` (local YYYY-MM-DD) vs `airDateUtc` (UTC ISO datetime) — prefer `airDate` for display bucketing, `airDateUtc` for precise sorting
- Radarr: `releaseDate` (used for both) or `airDate`/`airDateUtc` (normalized by backend)
- Lidarr: `releaseDate` on albums

**ID fields**:
- Sonarr/Radarr: `tmdbId`, `imdbId`, `tvdbId` in various locations
- Lidarr: `foreignArtistId` (MusicBrainz)
- Plex: `ratingKey` for items, `machineId` for servers

## Media analytics integrations

- Plex provides: library data, now playing sessions, on-deck, recently added
- Jellyfin and Emby provide parallel library and playback data through their
  branch-specific clients and caches.
- In 2.x, Tautulli enriches watch history, user analytics, and bandwidth
  statistics.
- In 3.0, Tracearr provides the replacement analytics surface and live-session
  actions; do not reintroduce Tautulli consumers.
- Cache rows are regenerated, but actions derived from cache data are not
  automatically safe. Re-establish the owned upstream target before mutation.

## Seerr Integration

- Formerly Jellyseerr/Overseerr — now just "Seerr" in all code and docs
- Provides: request management, user management, issues, notification agents
- Circuit breaker: Seerr client has built-in circuit breaker for connection failures
- Discovery enrichment: Library items can be enriched with Seerr request status

## Common Integration Drift Issues

1. **SDK type changes**: When `arr-sdk` is updated, field names or types may change. Check normalizers after SDK bumps.
2. **API version mismatches**: Sonarr v3 vs v4 use different API paths. The SDK handles this but normalizers may assume specific field availability.
3. **Missing monitored filtering**: New aggregate calculations must filter by monitored status — this has caused bugs multiple times (#131, #209).
4. **Inconsistent error handling**: Some API client modules swallow errors (e.g., `services.ts` returns `[]` on 401), others propagate. Prefer propagation.
5. **Health message anonymization**: The `anonymizeHealthMessage()` and `anonymizeStatusMessage()` functions in `incognito.ts` need regex patterns updated when new services add new message formats (Lidarr music release patterns were missed initially).
6. **Proxy/auth drift**: Test service URLs behind reverse proxies and optional
   Basic Auth. A successful connection test must exercise the same
   authentication and URL resolution path used by real operations.
7. **Webhook URL formats**: Distinguish a browser HTTP URL from an integration
   service URL such as Shoutrrr. Preserve secrets while transforming schemes
   and forwarding query parameters.
8. **Shared-library identity**: Plex/Jellyfin media identity can aggregate files
   managed by different *arr instances. A media-server match does not authorize
   deletion from every backing instance.
9. **Upstream status semantics**: Do not label normal pending/unreleased content
   as failed or stuck solely from request age. Require a state transition or
   evidence that intervention can help.
