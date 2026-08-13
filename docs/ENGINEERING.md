# Engineering Guide

Repository policy and workflow routing live in [`AGENTS.md`](../AGENTS.md).
This document explains the architecture and established implementation
patterns. Domain-specific details remain authoritative in the linked reference
documents.

## Quick Start

Install dependencies and start the API and web applications:

```bash
pnpm install && pnpm run dev  # API (3001) + Web (3000)
```

Before submitting a change, run the repository verification commands:

```bash
pnpm run format
pnpm --filter @arr/shared build                  # Required after shared changes
pnpm run typecheck                               # CI-equivalent Turbo typecheck
pnpm run test
pnpm run lint
```

## Repository Map

```text
apps/api/src/routes/                         # API route handlers
apps/api/src/lib/                            # Shared backend logic
apps/api/prisma/schema.prisma                # Database schema source of truth
apps/web/app/                                # Next.js pages
apps/web/src/features/                       # Feature-specific components by domain
apps/web/src/hooks/api/                      # React Query hooks
apps/web/src/lib/api-client/                 # API client modules
apps/web/src/lib/theme-gradients.ts          # Color system source of truth
apps/web/src/components/layout/premium-components.tsx  # Reusable UI components
packages/shared/src/types/                   # Shared Zod schemas and TypeScript types
```

## Architecture

The repository is a pnpm 10+ Turbo monorepo containing a Fastify 5 API, a
Next.js 16 App Router web application, and shared Zod types. The frontend uses
React 19, TanStack Query, TailwindCSS, and shadcn/ui. SQLite is the default
database and PostgreSQL is supported.

The application is a single-admin, self-hosted system. Authentication is
session-based rather than JWT-based, with password, OIDC, and passkey methods.
Authentication internals are documented in [`docs/AUTH.md`](AUTH.md).

Frontend requests use `/api/*` paths through Next.js rewrites. The navigation
preflight assists with redirects, while the API protected scope is the
authoritative authentication gate and returns 401 for unauthenticated
requests.

Fastify route handlers can use the auth-populated `request.currentUser` and
`request.sessionToken`, together with `app.prisma`, `app.encryptor`,
`app.sessionService`, and `app.config`.

## Code Style and Conventions

- Biome formats the API and shared packages; ESLint applies web-specific rules.
  Use `pnpm run lint` and `pnpm run format`.
- TypeScript uses strict mode with `noUncheckedIndexedAccess: true`.
- Feature modules use relative imports. Base UI components use the `@/` alias.
- Default to Server Components; add `"use client"` for hooks or
  interactivity.
- Use `useThemeGradient()` for theme colors and the centralized semantic,
  brand, service, and protocol color helpers. Never hardcode colors or use the
  retired two-line theme pattern. See [`docs/THEMING.md`](THEMING.md).
- Use semantic z-index classes such as `z-modal`, `z-toast`, and `z-dropdown`;
  do not use arbitrary values such as `z-[9999]`.
- Check `premium-components.tsx` before creating custom UI. It contains shared
  cards, badges, tabs, tables, and buttons.
- Use `getErrorMessage()` from
  `apps/api/src/lib/utils/error-message.ts` for API error text.
- Use pino through `request.log` or `app.log`; do not use production
  `console.log`.
- Define React Query keys in `lib/query-keys.ts`, and use named constants from
  `lib/polling-intervals.ts` instead of inline interval numbers.
- Use `useRefreshState()` from `hooks/useRefreshState.ts` for refresh buttons.
- Avoid broad refactors and unrelated cleanup.

## Adding Features

For a new API route:

1. Create `apps/api/src/routes/<domain>.ts`.
2. Register it in `apps/api/src/routes/route-manifest.ts` and document the
   group in [`docs/API-ROUTES.md`](API-ROUTES.md).
3. Add Zod types to `packages/shared/src/types/<domain>.ts`.
4. Add an API client to `apps/web/src/lib/api-client/<domain>.ts`.
5. Add a React Query hook to `apps/web/src/hooks/api/use<Domain>.ts`.

For a new frontend page:

1. Create `apps/web/app/<route>/page.tsx`.
2. Add components under `apps/web/src/features/<feature>/`.
3. Keep data flow as API client → React Query hook → component.

When a new route group is introduced, update the route manifest and the API
route reference together. Use the domain documents for route, auth, and UI
specific rules rather than copying those rules here.

## Database

`apps/api/prisma/schema.prisma` is the single source of truth. The project uses
`db push` rather than migrations for multi-provider support:

```bash
pnpm --filter @arr/api run db:push       # sync schema and regenerate client
pnpm --filter @arr/api run db:generate   # regenerate Prisma client only
pnpm --filter @arr/api run db:sync       # sync schema only, skip client regeneration
```

Local development defaults to `file:./dev.db`. The supported single-container
image sets `DATABASE_URL` to `file:/config/prod.db`; the API's production
fallback is `file:/app/data/prod.db` when no deployment value is supplied.
PostgreSQL is supported through `DATABASE_URL`.

## Backend Patterns

- Use `createInstanceFetcher(app, instance)` for calls to configured external
  application instances.
- Use `requireInstance()` from `lib/arr/instance-helpers.ts` for instance
  lookup; it throws `InstanceNotFoundError` when the instance is unavailable.
- Use `requireTemplate()` from `lib/trash-guides/template-helpers.ts` for
  template lookup.
- Use `resolveCanonicalIssuer()` from `lib/auth/oidc-utils.ts` for OIDC
  discovery URLs.
- Use `parsePaginationQuery()` from `lib/utils/pagination.ts` for pagination.
- Error handling is centralized in `server.ts`, with branches for ARR errors,
  status-code conventions, Prisma errors, and a generic fallback. Custom
  errors belong in `lib/errors.ts`.

## Frontend Patterns

Keep the data path as API client module → domain hook → feature hook →
component. Domain hooks in `hooks/api/use*.ts` wrap API queries and mutations;
feature hooks manage feature state, filters, and derived data. Components
render and handle interaction, but should not call `useQuery` or `useMutation`
directly.

Server state belongs in TanStack Query. UI state such as expanded sections,
filters, and modal visibility belongs in `useState` within feature hooks or
components. Filterable pages use a `use-*-state.ts` or `use-*-filters.ts` hook;
setters reset pagination to page 1.

Query keys are centralized in `apps/web/src/lib/query-keys.ts`. Use its domain
key factories for queries and mutation invalidation; factories return `as const`
tuples for type safety, prefix-based invalidation is supported, and local key
objects or raw string arrays are forbidden. Polling constants live in
`apps/web/src/lib/polling-intervals.ts`: `POLLING_FAST` (5s),
`POLLING_REALTIME` (15s), `POLLING_ACTIVE` (30s), `POLLING_STANDARD` (60s),
`POLLING_STATS` (120s), and `POLLING_BACKGROUND` (5min). Inspect call sites
before changing a hook that accepts `refetchInterval`.

Use `useEnrichableItems(items, typeMapping)` when extracting media IDs for
cross-service enrichment; its mapping distinguishes the `tv` and `series`
representations of the same media type.

For monitored counts, use `episodeCount` rather than `totalEpisodeCount` for
Sonarr and `trackCount` rather than `totalTrackCount` for Lidarr.

Use `React.lazy` and `Suspense` for modals rendered behind a state guard. Named
exports need an adapter such as:

```tsx
lazy(() => import("./file").then((m) => ({ default: m.NamedExport })))
```

Use `GlassmorphicCard` or the established glassmorphic card classes. Staggered
animations use `animationDelay: \`${index * 30}ms\`` with
`animate-in fade-in slide-in-from-bottom-2`.

## Testing

Use the repository commands in Quick Start. Building `@arr/shared` before the
root Turbo typecheck is required after shared-package changes; per-package
TypeScript checks can hide stale shared output.

Components that use `useIncognitoMode()` require an `IncognitoProvider` in
tests. Test production-shaped data and relevant failure paths when behavior
depends on external services, persistence, authorization, or counts.

## Environment and Deployment

The single-container deployment exposes port 3000 and uses `/config/` for the
production database and secrets. Startup is handled by
`docker/start-combined.sh`. Production startup uses a database-backed runtime
lease and fail-closed schema synchronization; only one API/container should
operate against a database at a time.

The supported environment settings include `DATABASE_URL`, `API_PORT` (3001),
`PORT` (3000), `HOST` (0.0.0.0), `PUID`, `PGID`, `SESSION_TTL_HOURS` (24),
`ENCRYPTION_KEY`, `SESSION_COOKIE_SECRET`, `WEBAUTHN_RP_ID`, and
`WEBAUTHN_ORIGIN`. Unset encryption and session-cookie settings can be
generated into the deployment secrets file.

Continuous integration is defined in `.github/workflows/ci.yml` and covers
linting, type checking, and the Docker build. Release procedures are
maintained in [`docs/RELEASING.md`](RELEASING.md).

## Patterns and Gotchas

- Frontend API calls use `/api/*` and Next.js rewrites; direct backend host
  URLs do not belong in frontend code.
- Next.js App Router components are server components by default.
- Docker and development use different environment names and filesystem
  paths (`/config/` versus `./`).
- Error responses use `{ error: "message" }`, with optional `details` for
  validation. Common statuses are 400, 401, 403, 404, and 423.
- The backup service is split across `backup-crypto.ts`,
  `backup-validation.ts`, `backup-file-utils.ts`, and `backup-database.ts`.
- Queue Cleaner has its own `QueueCleanerConfig` model for per-instance
  automatic cleanup settings.
- Mutations must invalidate affected query keys after the server state changes.
- Data transformations belong in hooks or utilities, not presentational
  components.

## Domain References

- [Authentication System](AUTH.md) — session, OIDC, passkey, encryption, and
  lockout internals.
- [UI Theming System](THEMING.md) — gradients, colors, components, z-index,
  typography, and animation conventions.
- [API Routes Reference](API-ROUTES.md) — route groups, methods,
  authentication requirements, and purposes.
- [Release Process](RELEASING.md) — release preparation, publication, and
  hotfix procedures.
- Domain-specific service behavior is documented under [`docs/domains/`](domains/).
