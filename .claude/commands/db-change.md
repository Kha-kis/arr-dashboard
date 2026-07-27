Apply a database schema change end-to-end: $ARGUMENTS

---

## Step 1: Plan the change

1. Read the current schema: `apps/api/prisma/schema.prisma`
2. Identify which models are affected (new model, new field, modified field, removed field)
3. Check for downstream consumers — use LSP `findReferences` on the affected Prisma model type and `incomingCalls` on key query functions to trace the full consumer chain across the monorepo:
   - Shared types in `packages/shared/src/types/` that expose this model
   - API routes in `apps/api/src/routes/` that query this model
   - API client modules in `apps/web/src/lib/api-client/` that call those routes
   - React Query hooks in `apps/web/src/hooks/api/` that wrap those clients
   - Components that consume those hooks
4. State the plan: what changes where, in what order. If scope is ambiguous, state the inferred scope and proceed conservatively.

Only pause for confirmation if the change is destructive (dropping columns/models), backward-incompatible (renaming fields consumed by live clients), or requires manual data transformation on existing rows.

---

## Step 2: Update Prisma schema

1. Edit `apps/api/prisma/schema.prisma`
2. Follow existing conventions:
   - User-owned models: add `userId String` + `user User @relation(...)` + `@@index([userId])`
   - Encrypted fields: paired `encryptedX String` + `encryptionIv String`
   - Use `@default(cuid())` for string IDs
   - Use `@default(now())` for `createdAt`, `@updatedAt` for `updatedAt`
3. Run `pnpm --filter @arr/api run db:push` to sync schema and regenerate the Prisma client
4. Verify the push succeeded (check output for errors)

---

## Step 3: Update shared types

1. Edit or create the relevant file in `packages/shared/src/types/`
2. Add/update Zod schemas that match the new schema shape
3. Derive TypeScript types via `z.infer<typeof schema>`
4. Define response types that omit sensitive fields (encrypted keys → `hasApiKey: boolean`)
5. Export from the barrel `packages/shared/src/types/index.ts` if new file
6. Rebuild shared and run the CI-equivalent typecheck:
   - `pnpm --filter @arr/shared build`
   - `pnpm run typecheck`

---

## Step 4: Update API routes

1. Edit affected route files in `apps/api/src/routes/`
2. For new CRUD operations:
   - Use `validateRequest(schema, request.body)` for input validation
   - Include `userId: request.currentUser!.id` in all Prisma queries
   - Encrypt sensitive fields with `app.encryptor.encrypt()`
   - Log mutations with `request.log.info()`
   - Return proper status codes (201 for create, 200 for update, 204 for delete)
3. For modified fields:
   - Update any Prisma `select` or `include` clauses
   - Update response formatting functions
4. Register new route groups in `apps/api/src/routes/route-manifest.ts` and add
   the contract row to `docs/API-ROUTES.md`
5. Run `pnpm run typecheck` to verify the complete workspace

---

## Step 5: Update frontend consumers

1. **API client** (`apps/web/src/lib/api-client/`):
   - Update or add fetch functions matching the new route signatures
   - Use `/api/*` paths (never `localhost:3001`)
   - Type returns against the shared response types

2. **React Query hooks** (`apps/web/src/hooks/api/`):
   - Update or add `useQuery`/`useMutation` hooks
   - Use query keys from `apps/web/src/lib/query-keys.ts` (add new keys if needed)
   - Invalidate correct query keys in mutation `onSuccess`

3. **Components** (if directly affected):
   - Only update components that render the changed fields
   - If new fields display sensitive data: apply `useIncognitoMode()` + anonymizer

4. Run `pnpm run typecheck` to verify frontend and shared consumers together

---

## Step 6: Add or update tests

1. Identify the narrowest high-value test layer for this change:
   - Schema/model changes: test via route handlers that exercise the affected queries
   - Shared type changes: test via existing consumers or add type-level assertions
   - Route changes: add or update tests in `apps/api/src/**/__tests__/`
   - Frontend hook changes: update hook tests in `apps/web/src/hooks/`
2. Prioritize these test cases:
   - Happy path (valid input → expected output)
   - Validation failure (invalid input → 400)
   - Ownership enforcement (wrong userId → 404)
   - New fields are included in responses
3. Run focused tests, then `/validate`

---

## Step 7: Report

Summarize:
- **Schema changes**: models/fields added, modified, or removed
- **Files changed**: list each file with a one-line description
- **Migration notes**: any manual steps needed (e.g., existing data backfill)
- **Manual review needed**: list anything that couldn't be fully automated (component UI changes, complex query updates, data migration scripts)
- **Validation**: results of tsc (both packages) and test run

---

## Rules

- Never run a destructive `db:push` against production data. Inspect the
  proposed transition first; destructive or transform-requiring changes need a
  release-specific backup/migration plan.
- Regenerate the Prisma client after schema changes before TypeScript checks
- Never create migration files — this project uses `db push` for SQLite/PostgreSQL dual support
- Use the root Turbo typecheck; per-package `tsc` can hide shared-output drift
- If removing a field, search for all usages first (grep across the repo)
- If adding an encrypted field, always add both `encryptedX` and `encryptionIv` columns
- Do not modify unrelated models or routes as part of this change
- Run the `data-safety-reviewer` agent for destructive schema changes, restore
  behavior, or data transformations
