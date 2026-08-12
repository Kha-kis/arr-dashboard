# Integration contract and production risks

Read this reference before changing an external-service contract, adding an
upstream mutation, or auditing a production-shaped integration path. Trace the
specific caller and consumer before selecting which cases apply.

## Service matrix and optional dependencies

Confirm the target release line and service contract instead of copying a
neighbor. Sonarr, Radarr, Prowlarr, Lidarr, and Readarr have different resource
shapes and mutation requirements. Plex, Jellyfin, Emby, Seerr, Tautulli,
Tracearr, and qui have different authentication and response conventions.
Treat an unconfigured optional service as an expected state: skip dependent
work with an honest result, avoid misleading UI, and test the dependency
failure. Do not turn a missing service into a successful upstream mutation.

## Complete caller and consumer tracing

Search every caller of a changed client, helper, normalizer, route, webhook, or
shared type. Follow the value through schemas, Prisma persistence, factories,
normalizers, jobs, routes, API clients, query hooks, UI, and tests. Check both
list and detail paths, background work, retries, and webhook-triggered paths.
Verify that response-field changes are understood by every consumer and that
credentials remain encrypted as value plus IV. User-owned queries must include
`request.currentUser!.id`; request bodies must use `validateRequest()`.

## Upstream shape and boundary handling

Normalize unstable or versioned responses at the integration boundary. Test
missing fields, extra fields, wrong types, malformed JSON, error envelopes,
pagination, rate limits, timeouts, and unavailable dependencies. Preserve
pagination cursors and do not silently treat a truncated page as complete.
Use bounded retries only for safe, retryable failures; ensure mutations are
idempotent or carry a tested deduplication strategy.

## Radarr and Sonarr full-resource updates

Radarr and Sonarr may reject a partial update body. For every update, re-fetch
the complete current resource with `getById()` immediately before mutation,
spread that response into the `PUT`, and change only the intended field. Test
required fields such as `qualityProfileId`, `rootFolderPath`, and existing
tags, plus already-applied, fetch-failure, update-failure, and later-item
continuation cases. Preserve all upstream fields and avoid stale list data.

## Authentication and authorization boundaries

Do not send unconditional Basic `Authorization`. It can collide with Bearer,
MediaBrowser, or service-specific headers such as qui's API key. Test the
authentication matrix for each service and ensure credentials are not exposed
in URLs, logs, error messages, API responses, or browser state. Resolve and
authorize the service instance at execution time; fail closed when identity or
ownership is uncertain.

## Shared libraries and multiple instances

Treat multiple Sonarr/Radarr/etc. instances pointing to the same media library
as normal production. Test same-title items across instances, distinct items
with the same path, cross-instance IDs, stale cached ownership, and a client
that returns a valid-looking resource from the wrong instance. Correlate by
authorized instance identity and stable library/file identity, not title or a
client-supplied owner. If correlation cannot be proven, skip the mutation and
leave an actionable retryable result.

## Mutation outcomes and review

Record success only after the upstream mutation succeeds. Preserve honest
partial-success state when one item fails, and test retry/idempotency and
concurrent invocation. Dry runs and previews must select the same targets and
actions without side effects. Every service mutation or webhook installation
requires an independent read-only `data_safety_reviewer`; substantial or
data-dependent changes also require `regression_reviewer`. Mocked tests prove
request shape but do not replace live evidence; report unavailable live
verification rather than claiming it.
