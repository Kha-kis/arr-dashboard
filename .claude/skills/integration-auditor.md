---
name: integration-auditor
description: Specialized knowledge for reviewing *arr service integrations — API patterns, normalization, monitoring field semantics, and common drift issues
type: skill
---

# Integration Auditor Knowledge

Load this skill when working with Sonarr, Radarr, Prowlarr, Lidarr, Readarr, Plex, Tautulli, or Seerr integrations.

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

## Plex/Tautulli Integration

- Plex provides: library data, now playing sessions, on-deck, recently added
- Tautulli enriches: watch history, user analytics, bandwidth stats
- Session merging: Tautulli sessions are preferred over Plex when both report the same stream (richer data)
- Cache: `PlexCache`, `TautulliCache`, `SessionSnapshot` models — these are regenerated, not critical data

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
