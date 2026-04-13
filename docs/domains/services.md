# Domain: Services

Operating manual for external integrations: Sonarr, Radarr, Prowlarr,
Lidarr, Readarr, Plex, Tautulli, Jellyfin/Emby, Seerr (Jellyseerr /
Overseerr).

## Purpose

Talk to user-configured external services on behalf of the user, without
ever leaking credentials or letting one user touch another user's
instance. All service-specific quirks — auth header shape, error mapping,
field-name drift across versions — are absorbed here so route handlers
and the UI deal in normalized, typed shapes.

## Service shape categories

| Shape | Services | Client style |
|---|---|---|
| ARR | Sonarr, Radarr, Prowlarr, Lidarr, Readarr | shared `ArrClientFactory` over `arr-sdk` |
| Media server | Plex, Jellyfin, Emby, Tautulli | per-service hand-written client (different auth headers) |
| Request | Seerr (Jellyseerr / Overseerr) | hand-written client over `ArrClientFactory.rawRequest()` with retry + circuit breaker |

All three categories share the same Prisma model (`ServiceInstance`) and
the same lookup helper (`requireInstance`). The split is in *how to talk
to them*, not in *how we own them*.

## Key files

| Concern | File |
|---|---|
| CRUD + connection test for any service | `apps/api/src/routes/services.ts` |
| Ownership-checked instance lookup | `apps/api/src/lib/arr/instance-helpers.ts` (`requireInstance`, `requireEnabledInstance`) |
| ARR client factory + error types | `apps/api/src/lib/arr/client-factory.ts` |
| Plex / Tautulli / Jellyfin clients | `apps/api/src/lib/plex/plex-client.ts`, `apps/api/src/lib/tautulli/tautulli-client.ts`, `apps/api/src/lib/jellyfin/*` |
| Seerr client (resilient) | `apps/api/src/lib/seerr/seerr-client.ts` |
| Encrypted update helper | `apps/api/src/lib/services/update-builder.ts` |
| Library/search normalizers | `apps/api/src/lib/library/*-normalizer.ts`, `apps/api/src/lib/search/normalizers.ts` |
| Centralized error mapping | `apps/api/src/server.ts` (error handler) + `apps/api/src/lib/errors.ts` |
| Schema (single discriminated row) | `apps/api/prisma/schema.prisma` (`ServiceInstance`, `ServiceType` enum) |

## Invariants

These are the rules every contributor must hold. Most are not type-checkable.

1. **Every instance lookup goes through `requireInstance(app, userId, id)`.**
   Never query `serviceInstance.findFirst({ where: { id } })` directly —
   that elides the `userId` filter and creates a cross-tenant read.
2. **Credentials are encrypted on write through `app.encryptor.encrypt()`,
   stored as `{ encryptedApiKey, encryptionIv }`, and decrypted only at
   the moment of use.** No plaintext on the wire to the DB, no caching
   of decrypted material across requests.
3. **`buildUpdateData()` is the only legitimate place that re-encrypts on
   update.** Routes pass through it; they do not call `encryptor` directly
   for service updates.
4. **Errors map through the centralized error handler in `server.ts`.**
   Throw `ArrError` subclasses (or rely on `arr-sdk` to throw them); do
   not hand-roll `reply.status(...).send(...)` with bespoke error shapes.
5. **No URL leakage in error messages.** `server.ts` redacts URLs from
   `ArrError.message` so internal IPs / ports are not echoed to clients
   or logs. If you add a new client, sanitize before logging.
6. **Frontend never calls service endpoints directly.** All traffic flows
   `apps/web/src/lib/api-client/*` → `/api/*` (Next.js rewrite) → Fastify
   route → service client. Never `fetch("http://sonarr:8989", …)` from
   the browser.

## Major integration points

- **`requireInstance()`** — used by every domain that resolves a service
  by id (hunting, queue cleaner, library, search, statistics, pulse).
- **`app.encryptor`** — provided by the auth domain
  ([`docs/domains/auth.md`](auth.md)).
- **Validation health** — every external integration emits validation
  stats consumed by `/system/validation-health` (see
  [`docs/domains/system.md`](system.md)).
- **Centralized error handler** — `ArrError` / `SeerrApiError` /
  `InstanceNotFoundError` all collapse into clean HTTP responses there.

## Common failure modes / operational notes

- **`InstanceNotFoundError` (404)** — either the id doesn't exist or the
  caller doesn't own it. The route should not branch on which; both
  surface as 404 to avoid id-existence oracles.
- **Connection test failures** — most user-facing; surfaced via the
  `POST /services/:id/test` route. Use the existing client factory so
  errors map through the same paths as production calls.
- **Field-name drift across upstream versions** — Sonarr v3 vs. v4,
  Prowlarr API revisions, Plex schema additions. Absorb in a normalizer
  with defensive type converters (`toNumber`, `toString`, `toBoolean`),
  not in the route or the UI.
- **Token leakage in logs** — Tautulli's `apikey=…` query param is the
  most common offender. Sanitize before any `app.log` call. Same rule
  for Plex's `X-Plex-Token`.
- **Seerr/Jellyseerr 5xx storms** — handled by retry + circuit breaker
  in `seerr-client.ts`. Do not add ad-hoc retries on top of that in
  routes.
- **Concurrent writes to the same instance** — Prisma will serialize at
  the row level, but two near-simultaneous `PUT /services/:id` calls can
  re-encrypt with different IVs. The last write wins; clients must not
  assume read-after-write coherence within milliseconds.

## Where to add new code

A new ARR-style service (rare, since the SDK covers them):
1. Add the enum value to `ServiceType` in `schema.prisma`; run `db push`.
2. Add a constructor in `ArrClientFactory` if `arr-sdk` ships one.
3. Reuse `routes/services.ts` — no new route file.

A new media or request service (more common):
1. `prisma/schema.prisma` — extend `ServiceType`.
2. `apps/api/src/lib/<service>/<service>-client.ts` — factory
   `create<Service>Client(encryptor, instance, log)` with the right
   auth model. Sanitize tokens before logging.
3. Routes:
   - if it slots into the generic CRUD shape → reuse `routes/services.ts`
     and only add a connection-test branch.
   - if it has feature endpoints (discover, stats, request, …) → new
     `apps/api/src/routes/<service>/` with one file per feature.
4. Normalizers in `apps/api/src/lib/<service>/<service>-normalizer.ts`
   when the upstream shape doesn't match the existing typed contract.
5. `packages/shared/src/types/<service>.ts` — Zod schema + TS type.
6. Frontend: `apps/web/src/lib/api-client/<service>.ts` and
   `apps/web/src/hooks/api/use<Service>.ts` (mirror the existing pairs).

## When to update this doc

- A new service or service category is added.
- An invariant in the list above changes.
- A new shared abstraction lands (e.g., a generic media-server client).
- The credential-encryption shape changes (would also warrant an ADR).

Per-service quirks (auth header shape, version-specific field names)
belong in code comments at the relevant client file, not here.
