Add or modify an external service integration: $ARGUMENTS

---

## Step 1: Study the analogous integration

Before writing any code, read an existing integration that is structurally closest to the target service:

- **Arr services** (Sonarr, Radarr, Lidarr, Readarr): read `apps/api/src/routes/services.ts` and one normalizer in `apps/api/src/lib/library/`
- **Media server** (Plex): read `apps/web/src/lib/api-client/plex.ts`, `apps/web/src/hooks/api/usePlex.ts`
- **Enrichment service** (Seerr, Tautulli): read `apps/web/src/lib/api-client/seerr.ts` or `tautulli.ts`

Note the patterns used: how the service is registered, how its API key is stored, how raw data is normalized, and how the frontend consumes it.

---

## Step 2: Service registration and schema

1. **Prisma enum**: If this is a new service type, add it to `ServiceType` in `apps/api/prisma/schema.prisma`
2. **Shared constants**: Add the lowercase name to the appropriate array in `packages/shared/src/types/arr.ts`:
   - `ARR_SERVICES` for *arr services with library content
   - `INTEGRATION_SERVICES` for enrichment/media services
   - Update `ARR_SERVICES_UPPER` if the new service is an *arr type
3. **Prisma push**: Run `pnpm --filter @arr/api run db:push` to sync schema and regenerate client
4. **Type-check both packages** after shared type changes:
   - `pnpm --filter @arr/api exec tsc --noEmit`
   - `pnpm --filter @arr/web exec tsc --noEmit`

If the service uses an API key, confirm that the existing `ServiceInstance` model's `encryptedApiKey`/`encryptionIv` fields are sufficient. If additional credentials are needed, add paired `encryptedX String` + `encryptionIv String` columns.

---

## Step 3: Backend adapter

1. **SDK or HTTP client**: Prefer `arr-sdk` for *arr services. For non-*arr services, use a typed HTTP client or add a new adapter in `apps/api/src/lib/`.
2. **Instance lookup**: Use `requireInstance(app, userId, instanceId)` from `lib/arr/instance-helpers.ts`. Never query `ServiceInstance` without `userId` in the where clause.
3. **Decrypting credentials**: Use `app.encryptor.decrypt(instance.encryptedApiKey, instance.encryptionIv)` to get the plaintext key for outbound API calls.
4. **Error handling**: Let errors propagate to the centralized handler in `server.ts`. Add custom error types to `lib/errors.ts` only if the service has specific failure modes that need distinct HTTP status codes.
5. **Circuit breaker**: For external services that may be unreachable (not on the local network), consider a circuit breaker pattern. Seerr's client is the existing example.

---

## Step 4: Normalizer (if the service provides library data)

If the service returns content items that need to appear in the unified library:

1. Create `apps/api/src/lib/library/<type>-normalizer.ts` following the existing pattern
2. Accept `Record<string, unknown>` for raw API data — never trust field existence
3. Use the defensive extraction helpers from `./type-converters.ts`: `toNumber()`, `toStringValue()`, `toBoolean()`, `normalizeGenres()`, `normalizeTags()`
4. Return a complete `LibraryItem` with all required fields populated or safely defaulted
5. **Monitored count fields**: If the service has monitored vs total counts (like Sonarr's `episodeCount` vs `totalEpisodeCount`), always use the monitored variant — this has caused bugs (#131, #209)
6. **Date fields**: Distinguish local dates (for display bucketing) from UTC dates (for sorting). Prefer the local variant for calendar/grid views (#207).

---

## Step 5: API routes

1. Create or update route files in `apps/api/src/routes/`
2. Follow these conventions for every handler:
   - `validateRequest(schema, request.body)` for input validation — never `request.body as Type`
   - `userId: request.currentUser!.id` in all Prisma queries (inside the protected routes block)
   - `app.encryptor.encrypt()` for any new secrets before storage
   - `request.log.info()` for mutation logging
   - Proper status codes: 201 create, 200 update, 204 delete
3. Register new route files in `apps/api/src/server.ts`
4. **Response shaping for privacy**: Keep identifiable data (instance names, URLs, usernames) in separate response fields, not embedded in free-text strings. The frontend needs to be able to anonymize each part independently for incognito mode.
5. Run `pnpm --filter @arr/api exec tsc --noEmit`

---

## Step 6: Shared types and contracts

1. Add or update Zod schemas in `packages/shared/src/types/` for any new request/response shapes
2. Zod schema is source of truth — derive TypeScript types via `z.infer<typeof schema>`
3. Response types must omit sensitive fields: encrypted keys become `hasApiKey: boolean`
4. Export from `packages/shared/src/types/index.ts` if a new file
5. Type-check both packages — shared type changes affect both `@arr/api` and `@arr/web`

---

## Step 7: Frontend consumers

1. **API client** (`apps/web/src/lib/api-client/<service>.ts`):
   - Use `/api/*` paths (never `localhost:3001`)
   - Type returns against the shared response types
   - Handle `UnauthorizedError` gracefully where appropriate

2. **Query keys** (`apps/web/src/lib/query-keys.ts`):
   - Add a key factory for the new service domain
   - Follow the existing namespace pattern: `{ all, list, detail, ... }`

3. **React Query hooks** (`apps/web/src/hooks/api/use<Service>.ts`):
   - Use the centralized query keys, never inline string arrays
   - Use `POLLING_*` constants from `lib/polling-intervals.ts` for `refetchInterval`
   - Invalidate correct query keys in mutation `onSuccess`

4. Run `pnpm --filter @arr/web exec tsc --noEmit`

---

## Step 8: Incognito and privacy check

1. Any backend response field containing instance names, titles, URLs, or usernames must be structured for frontend anonymization
2. If the new service introduces message formats that embed identifiable data (like health messages or status strings), check whether `anonymizeHealthMessage()` or `anonymizeStatusMessage()` in `apps/web/src/lib/incognito.ts` need new regex patterns
3. Frontend components displaying this data must use `useIncognitoMode()` and the appropriate anonymizer

---

## Step 9: Tests

1. Identify the narrowest high-value test layer:
   - Normalizer: unit test with representative raw API payloads and edge cases (null fields, missing counts)
   - Routes: happy path, validation failure (400), ownership enforcement (wrong userId → 404)
   - Hooks: if the hook has non-trivial logic (filtering, merging, derived state)
2. If the service has monitored/total count fields, add explicit test cases for the correct field selection
3. Run `pnpm run test`

---

## Step 10: Validate and report

1. Run the full check:
   - `pnpm --filter @arr/api exec tsc --noEmit`
   - `pnpm --filter @arr/web exec tsc --noEmit`
   - `pnpm run test`
   - `pnpm run lint`

2. Summarize:
   - **Integration scope**: what service, what capabilities (library data, enrichment, sessions, etc.)
   - **Files changed**: list each with a one-line description
   - **Regression risks**: fields that have caused bugs before (monitored counts, date variants, ID mapping)
   - **Incognito impact**: any new anonymization patterns needed
   - **Manual review needed**: UI components, service-availability gating, or configuration flow that needs human verification

---

## Rules

- Read the closest existing integration before writing anything — do not invent new patterns
- Every Prisma query for user-owned data must include `userId` in the where clause
- Every request body must go through `validateRequest()` — no `as Type` casts
- Every API key must be encrypted before storage — store both `value` and `iv`
- Every user-facing response with identifiable data must be structured for anonymization — no embedded names in free-text fields
- Shared type changes require type-checking both `@arr/api` and `@arr/web`
- Do not modify unrelated integrations or routes as part of this change
