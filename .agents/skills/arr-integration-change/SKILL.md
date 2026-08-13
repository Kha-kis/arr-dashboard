---
name: arr-integration-change
description: Use when adding, changing, debugging, or auditing arr-dashboard integrations with Sonarr, Radarr, Prowlarr, Lidarr, Readarr, Plex, Jellyfin, Emby, Seerr, Tautulli, Tracearr, or qui.
---

# Change an arr-dashboard integration

1. Resolve the current target branch and the requested service contract before
   copying an adjacent integration. Tautulli is supported on stable 2.x;
   Tracearr replaces it on 3.0. Keep the change on the intended release line.
2. Read [integration-risks.md](references/integration-risks.md) for contract
   changes, service mutations, or production-shape audits. Record the target
   service, upstream contract, and complete caller/consumer surface.
3. Trace the change end to end: shared schema and Prisma service type,
   credentials and client/factory, normalizer, routes/webhooks, API client,
   query hooks, UI consumers, jobs, and existing tests. Include every caller
   of changed helpers and every consumer of changed response fields.
4. Normalize upstream data at the boundary and preserve repository contracts:
   encrypt credentials with value plus IV; scope user-owned Prisma queries with
   `request.currentUser!.id`; parse bodies with `validateRequest()`; register
   route groups in the manifest and API route docs; support incognito fields;
   use centralized query keys and polling constants.
5. For Radarr/Sonarr updates, fetch the complete resource with `getById()` at
   execution time, spread that fresh resource into the `PUT`, and apply only
   the intended normalized change. Never send a partial update body or mutate
   when ownership, service identity, or shared-library correlation is unclear.
6. Add focused success, malformed-payload, dependency, retry/idempotency,
   partial-success, and production-shaped failure tests for the traced callers.
   Cover optional-service absence and, when applicable, pagination, auth
   collisions, concurrent invocation, and multiple instances sharing a
   library. Use populated fixtures rather than an empty development database.
7. Delegate `data_safety_reviewer` for every service mutation or webhook
   installation, and delegate `regression_reviewer` for substantial,
   data-dependent, or deletion-adjacent changes. Resolve findings before
   declaring the contract ready; disclose missing live evidence explicitly.
8. Rebuild `@arr/shared` when its exports change, run `$arr-validate`, and
   live-verify user-visible behavior when a reachable service is available.
   Do not refactor unrelated integrations.
