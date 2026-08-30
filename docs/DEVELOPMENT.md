# Development Reference

## Quick Start

```bash
pnpm install && pnpm run dev  # API (3001) + Web (3000)
```

Requirements: Node.js 22+ and pnpm 10+.

## Critical Rules

These cause bugs if ignored:

1. **API Proxy**: Frontend calls `/api/*` via Next.js rewrites to backend. NEVER use `localhost:3001` directly from frontend code.
2. **Ownership**: Always include `userId: request.currentUser!.id` in Prisma queries for user-owned resources. Omitting this is a security vulnerability.
3. **Encryption**: All API keys must be encrypted with `app.encryptor.encrypt()` before storage. Store both `value` and `iv`.
4. **Auth Check**: Protected route groups register through `route-manifest.ts` inside the single protected scope, whose preHandler checks `request.currentUser?.id`. Do not add parallel per-route auth gates.
5. **Validation**: Use `validateRequest()` from `lib/utils/validate.ts` for request body parsing. Never use `request.body as Type`.
6. **Incognito Mode**: Any component displaying sensitive data (titles, usernames, URLs, instance names) must use `useIncognitoMode()` hook from `contexts/IncognitoContext.tsx` and anonymize with functions from `lib/incognito.ts`. This includes API response text that embeds instance names (e.g., Pulse titles like `"Label: message"` — split and anonymize both parts). Tests rendering such components need `<IncognitoProvider>` wrapper.
7. **Query Invalidation**: Always invalidate relevant React Query keys after mutations.
8. **Session Invalidation**: After credential changes (password, passkey deletion), call `invalidateAllUserSessions(userId, exceptToken)`.

## Key Paths

```
apps/api/src/routes/       # API route handlers
apps/api/src/lib/          # Shared backend logic (auth/, arr/, utils/, hunting/, queue-cleaner/)
apps/api/prisma/schema.prisma  # Database schema (source of truth)
apps/web/app/              # Next.js pages
apps/web/src/features/     # Feature-specific components, organized by domain
apps/web/src/hooks/api/    # React Query hooks
apps/web/src/lib/api-client/   # API client modules
apps/web/src/lib/theme-gradients.ts  # Color system source of truth
apps/web/src/components/layout/premium-components.tsx  # Reusable UI components
packages/shared/src/types/ # Shared Zod schemas + TypeScript types
```

## Architecture

**Monorepo**: `apps/api` (Fastify 5), `apps/web` (Next.js 16 App Router), `packages/shared` (Zod types). pnpm 10+ with Turbo.

**Stack**: Fastify + Prisma + Zod backend, Next.js + React 19 + TanStack Query frontend, TailwindCSS + shadcn/ui, SQLite default (PostgreSQL supported).

**Design**: Single-admin, self-hosted. Session-based auth (NOT JWT). Three auth methods: Password, OIDC, Passkeys.

**Services**: Sonarr, Radarr, Prowlarr, Lidarr, Readarr, Plex, Tautulli, Jellyfin, Emby, Seerr (Jellyseerr/Overseerr), and qui.

**Fastify Decorations** (available in route handlers):
- `request.currentUser` / `request.sessionToken` — populated by auth preHandler
- `app.prisma` — Prisma client
- `app.encryptor` — AES-256-GCM encryption (`.encrypt()` / `.decrypt()`)
- `app.sessionService` — session create/invalidate/cookie management
- `app.config` — environment config

## Code Style & Conventions

- **Linting**: Biome for API + shared packages, ESLint for web (React-specific rules). Biome for formatting across all packages. Run `pnpm run lint` / `pnpm run format`
- **TypeScript**: Strict mode, `noUncheckedIndexedAccess: true`
- **Imports**: Feature modules use relative imports. Base UI components use `@/` alias
- **Components**: Default to Server Components; add `"use client"` when using hooks/interactivity
- **Theming**: Use `useThemeGradient()` hook for theme colors. Never use the old 2-line pattern (`useColorTheme` + `THEME_GRADIENTS[colorTheme]`). See [`THEMING.md`](THEMING.md) for full reference
- **Colors**: Never hardcode colors. Use `getServiceGradient()` for runtime service lookups, `SEMANTIC_COLORS` for status, `BRAND_COLORS` for external services
- **Z-Index**: Use semantic classes (`z-modal`, `z-toast`, `z-dropdown`), never arbitrary `z-[9999]`
- **Premium Components**: Check `premium-components.tsx` before creating custom UI (has GlassmorphicCard, ServiceBadge, StatusBadge, PremiumTabs, PremiumTable, GradientButton, etc.)
- **Error messages**: Use `getErrorMessage()` from `lib/utils/error-message.ts` instead of `error instanceof Error ? error.message : ...`
- **Logging**: Use `request.log` or `app.log` (pino), never `console.log` in production code
- **Query keys**: All React Query keys must be defined in `lib/query-keys.ts`. Never use inline string arrays. Import from the centralized file.
- **Polling**: Use named constants from `lib/polling-intervals.ts` (POLLING_REALTIME, POLLING_ACTIVE, POLLING_STANDARD, POLLING_STATS, POLLING_BACKGROUND, POLLING_FAST). Never hardcode interval numbers.
- **Refresh pattern**: Use `useRefreshState()` hook from `hooks/useRefreshState.ts` for "refresh with animation" buttons. Never manually manage isRefreshing + setTimeout.
- **No broad refactors**: Do not refactor code unrelated to the current task. Do not "clean up" files you're passing through. Only change what's directly required.
- **Impact summaries**: When completing a task, summarize: what changed, why, files affected, risks, and validation performed.

## Adding Features

**New API Route:**
1. Create `apps/api/src/routes/<domain>.ts`
2. Register in `apps/api/src/routes/route-manifest.ts` and document the group in `docs/API-ROUTES.md`
3. Add Zod types to `packages/shared/src/types/<domain>.ts`
4. Add API client to `apps/web/src/lib/api-client/<domain>.ts`
5. Add React Query hook to `apps/web/src/hooks/api/use<Domain>.ts`

**New Frontend Page:**
1. Create `apps/web/app/<route>/page.tsx`
2. Add components to `apps/web/src/features/<feature>/`
3. Data fetching: API client -> React Query hook -> Component

**Database Changes:**
1. Edit `apps/api/prisma/schema.prisma`
2. Run `pnpm --filter @arr/api run db:push` (syncs schema + regenerates client)
3. No migrations — uses `db push` for multi-provider support (SQLite/PostgreSQL)

## Trust & UX Correctness

When adding features that surface data to users (pages, panels, signals, notifications), verify:

1. **Service-availability gating**: If a signal depends on optional services (Plex, Seerr, Tautulli), guard it — don't show misleading items when the service isn't configured
2. **Signal accuracy**: Every user-facing count or status must be precise, not a proxy. If you can't compute the exact value cheaply, don't show it — overclaiming erodes trust
3. **Duplicate surface check**: Before adding a signal, check where the same data already appears. Justify the overlap (cross-system synthesis is good, pure duplication is not)
4. **Action link verification**: Every action link must point to an existing page that shows the relevant data with any required query params
5. **Perform a trust check** on new user-facing features before marking them ready for review

## Safety-Critical Mutations

Deletion, file removal, unmonitoring, queue cleanup, restore, schema change,
TRaSH deployment, and upstream write paths require stronger evidence than
ordinary reads:

1. **Preview parity**: Dry-run and preview code must be side-effect free and
   select the same targets and actions as real execution.
2. **Fail closed**: Unknown ownership, instance identity, file correlation,
   shared-library state, or upstream state means skip/stop with an actionable
   explanation—not permission to mutate.
3. **Execution-time authority**: Re-fetch and authorize mutable targets at
   execution time. Cached previews and client-supplied identifiers are not
   final authority.
4. **Honest state transitions**: Persist success only after the upstream action
   succeeds. Partial failures remain visible and retryable; cache updates do
   not prove upstream success.
5. **Production-shaped tests**: Cover shared-library/multi-instance cases,
   same-title collisions, dependency failure, dry-run, mutation, retry, and
   concurrency as applicable.
6. **Independent review**: Give deletion-adjacent diffs a separate read-only
   data-safety review before merge, in addition to normal regression and
   browser verification.

## Database

- Schema: `apps/api/prisma/schema.prisma` is the single source of truth
- `pnpm --filter @arr/api run db:push` — sync schema to database (dev, also regenerates client)
- `pnpm --filter @arr/api run db:generate` — regenerate Prisma client only
- `pnpm --filter @arr/api run db:sync` — sync schema only, skip client regen (production)
- SQLite default (`file:/config/prod.db`), PostgreSQL supported via `DATABASE_URL`

## Key Backend Patterns

**ARR Instance Fetcher** — use `createInstanceFetcher(app, instance)` for API calls to Sonarr/Radarr/etc.

**Instance lookup** — use `requireInstance()` from `lib/arr/instance-helpers.ts` (throws `InstanceNotFoundError`).

**Template lookup** — use `requireTemplate()` from `lib/trash-guides/template-helpers.ts`.

**OIDC issuer** — use `resolveCanonicalIssuer()` from `lib/auth/oidc-utils.ts` when working with OIDC discovery URLs.

**Error handling** — centralized in `server.ts` with 4 branches: ArrError, statusCode convention, Prisma, generic fallback. Custom errors in `lib/errors.ts`.

**Pagination** — use `parsePaginationQuery()` from `lib/utils/pagination.ts`.

## Key Frontend Patterns

**Data fetching**: API client module -> `useQuery`/`useMutation` hook -> component. All API requests use `credentials: "include"`. Server state must live in shared domain hooks (`hooks/api/`), never inline in components. Components should only render and handle user interaction — keep data transformation and business logic in hooks or utilities.

**Route protection**: `proxy.ts` performs the frontend redirect preflight, while the API's protected manifest scope is the authoritative auth gate and returns 401 for unauthenticated requests. API proxying is handled by Next.js rewrites in `next.config.mjs`.

**Lazy modals**: Use `React.lazy` + `Suspense` for modals behind `{stateVar && <Modal />}`. Named exports need adapter: `lazy(() => import("./file").then(m => ({ default: m.NamedExport })))`.

**Glassmorphic cards**: Use `<GlassmorphicCard>` component or the pattern `rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm`.

**Staggered animations**: `animationDelay: \`${index * 30}ms\`` with `animate-in fade-in slide-in-from-bottom-2`.

## Testing

```bash
pnpm run format
pnpm --filter @arr/shared build                  # Required after shared changes
pnpm run typecheck                               # CI-equivalent Turbo typecheck
pnpm run test
pnpm run lint
```

- Components using `useIncognitoMode()` require `<IncognitoProvider>` wrapper in tests
- Per-package `tsc` runs can hide stale `@arr/shared` output; only the root Turbo
  typecheck after building shared matches CI

## Pull request review workflow

Follow [`CODE-REVIEW.md`](CODE-REVIEW.md) for the finite review contract.

- Select exactly one risk tier.
- Declare scope, non-goals, and acceptance criteria before broad review.
- Use one broad review, one consolidated correction pass, and a targeted delta
  review within each review epoch.
- Record each finding's severity, classification, reproduction, and
  disposition.
- Require exact-head CI and a maintainer-controlled merge decision.

## Environment & Deployment

**Docker** (single container): Port 3000 exposed, `/config/` volume contains `prod.db` + `secrets.json`. Startup: `docker/start-combined.sh`. Schema sync is fail-closed and never approves destructive changes automatically.

**Runtime topology**: Stable 2.x supports exactly one arr-dashboard API/container per database. Multiple replicas sharing one SQLite or PostgreSQL database are unsupported. Caches, schedulers, locks, and event fan-out are process-local and are not coordinated across API processes. Stable 2.x does not enforce this restriction; runtime enforcement is tracked by [#829](https://github.com/Kha-kis/arr-dashboard/issues/829).

**Key env vars**: `DATABASE_URL`, `API_PORT` (3001), `PORT` (3000), `HOST` (0.0.0.0), `PUID`/`PGID`, `SESSION_TTL_HOURS` (24), `ENCRYPTION_KEY` (auto-generated), `SESSION_COOKIE_SECRET` (auto-generated), `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`.

**CI**: `.github/workflows/ci.yml` — lint, type check, Docker build.

## Patterns & Gotchas

- **API Proxy**: Frontend uses `/api/*` paths via Next.js rewrites in `next.config.mjs`; `proxy.ts` only assists navigation, and API 401 responses remain authoritative
- **Server Components**: Default in Next.js App Router. Add `"use client"` when needed
- **Docker vs Dev**: Different env vars and paths (`/config/` vs `./`)
- **Secrets auto-generated**: `ENCRYPTION_KEY` and `SESSION_COOKIE_SECRET` are auto-generated to `secrets.json` if not provided
- **Error responses**: `{ error: "message" }` with optional `details` for validation. Status codes: 400 (bad input), 401 (auth required), 403 (forbidden), 404 (not found/access denied), 423 (locked)
- **Backup service**: Decomposed into `backup-crypto.ts`, `backup-validation.ts`, `backup-file-utils.ts`, `backup-database.ts`
- **Queue Cleaner**: Has its own `QueueCleanerConfig` model for per-instance auto-cleanup settings

## Release Checklist

When preparing a release, follow [`RELEASING.md`](RELEASING.md). At minimum,
update all of these before tagging:
1. `package.json` — version field
2. `CHANGELOG.md` — new version section
3. `README.md` — version tagline at top + version tags table
4. `DOCKERHUB.md` — version tagline at top + version tags table
5. **Wiki** — update version in `Home.md` and `Troubleshooting.md` (use a fresh temporary clone of `arr-dashboard.wiki.git`)

## Detailed Reference (not loaded by default)

For deep dives, see these files (create as needed):
- [`THEMING.md`](THEMING.md) — full UI theming system (gradients, colors, premium components, z-index, typography, animations)
- [`AUTH.md`](AUTH.md) — detailed auth internals (session flow, OIDC with PKCE, passkeys, encryption, lockout)
- [`API-ROUTES.md`](API-ROUTES.md) — complete API route table with methods, auth requirements, and purposes
