---
name: arr-integration-change
description: Add, modify, or audit arr-dashboard integrations with Sonarr, Radarr, Prowlarr, Lidarr, Readarr, Plex, Jellyfin, Emby, Seerr, Tautulli, Tracearr, or qui. Use for service clients, schemas, normalization, routes, webhooks, and integration UI.
---

# Change an arr-dashboard integration

1. Resolve the target branch before copying patterns. Tautulli is supported on
   stable 2.x; Tracearr replaces it on 3.0. Do not blindly port either contract.
2. Read the closest integration end to end: shared schema, Prisma service type,
   encrypted credentials, backend client/factory, normalizer, route, API
   client, query hook, UI, and tests.
3. Preserve these contracts:
   - encrypt credentials and store value plus IV;
   - scope user-owned resources with `request.currentUser!.id`;
   - parse bodies with `validateRequest()`;
   - normalize unstable upstream payloads at the boundary;
   - use route-manifest registration and `docs/API-ROUTES.md`;
   - structure identifiable response fields so incognito mode can mask them;
   - use centralized query keys and polling constants.
4. Treat absent optional services, timeouts, malformed payloads, pagination,
   rate limits, retries, partial upstream success, and multiple instances
   sharing a media library as normal cases.
5. For service mutations or webhook installation, delegate a review to
   `data_safety_reviewer`.
6. Add focused contract and failure-path tests. Rebuild `@arr/shared` when its
   exports change, then use `$arr-validate`.

Do not refactor unrelated integrations.
