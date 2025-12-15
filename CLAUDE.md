# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **unified dashboard for managing multiple Sonarr, Radarr, and Prowlarr instances**. Version 2.0 is a complete rewrite with modern architecture and zero-config Docker deployment.

**Key Features:**
- Unified view of queue, calendar, history across all instances
- Global search across all indexers
- Library management for movies and TV shows
- Statistics and health monitoring
- TMDB integration for content discovery
- Tag-based instance organization
- Encrypted API keys with session-based authentication

## Architecture Overview

### Monorepo Structure (pnpm + Turbo)

```
arr-dashboard/
├── apps/
│   ├── api/          # Fastify API server (port 3001)
│   └── web/          # Next.js 14 App Router frontend (port 3000)
└── packages/
    └── shared/       # Shared TypeScript types and Zod schemas
```

**Important:** This is a pnpm workspace monorepo managed by Turbo. Always run commands from the root directory using `pnpm run <script>` or use `pnpm --filter @arr/<package>` for package-specific commands.

### Technology Stack

**Backend (@arr/api):**
- Fastify 4 (high-performance Node.js web framework)
- Prisma ORM with SQLite (default), supports PostgreSQL/MySQL
- Lucia Auth (session-based authentication, NOT JWT)
- Zod for validation
- Custom encryption using Node crypto (AES-256-GCM)

**Frontend (@arr/web):**
- Next.js 14 App Router (NOT Pages Router)
- React 18 with Server Components
- TailwindCSS + shadcn/ui components
- Tanstack Query (React Query) for data fetching
- Zustand for minimal local state (only used in manual-import feature)
- next-themes for dark mode
- Framer Motion for animations

**Shared (@arr/shared):**
- Zod schemas exported as both ESM and CJS
- TypeScript types derived from Zod schemas
- Used by both frontend and backend for type safety

## Critical Architectural Decisions

### 1. API Proxy Pattern (CRITICAL - Recent Fix)

**The web app does NOT make direct API calls to `http://localhost:3001`.**

Instead, it uses Next.js rewrites to proxy all `/api/*` and `/auth/*` requests to the backend. This is handled in `apps/web/next.config.mjs`.

```typescript
// Frontend makes requests to relative paths
fetch("/api/services")  // NOT http://localhost:3001/api/services

// Next.js rewrites proxy to backend
// Development: http://localhost:3001
// Docker: http://api:3001
```

**Why this matters:**
- Eliminates CORS issues
- Next.js handles cookie forwarding automatically via rewrites
- Works seamlessly in Docker without exposing backend port
- Middleware (`apps/web/middleware.ts`) now only handles route protection and session checks
- Recent commits (f7c52f7, c9f24b7, 8b80c82, 917aa92) fixed race conditions and cookie forwarding issues

**Key Files:**
- `apps/web/next.config.mjs` - Rewrites configuration for API proxying
- `apps/web/middleware.ts` - Session-based route protection (skips /api and /auth paths)

**Environment Variables:**
- Frontend: `API_HOST` environment variable (Docker: `http://api:3001`, Dev: `http://localhost:3001`)
- NOT `NEXT_PUBLIC_API_BASE_URL` - that's only for documentation/legacy

### 2. Zero-Config Security (Auto-Generated Secrets)

**The API auto-generates encryption keys and session secrets on first run.**

Implementation in `apps/api/src/lib/auth/secret-manager.ts`:
- Generates `ENCRYPTION_KEY` (32 bytes hex)
- Generates `SESSION_COOKIE_SECRET` (32 bytes hex)
- Persists to `secrets.json` next to database file
- Only generates if not provided via environment variables

**Location:**
- Docker: `/config/secrets.json`
- Dev: `./secrets.json` (next to `dev.db`)

**Key Files:**
- `apps/api/src/plugins/security.ts` - Initializes SecretManager
- `apps/api/src/lib/auth/encryption.ts` - AES-256-GCM encryption
- `apps/api/src/lib/auth/session.ts` - Session management with Lucia

### 3. Session-Based Authentication (NOT JWT)

Uses **signed, HTTP-only cookies** with Lucia Auth:
- Cookie name: `arr_session` (configurable)
- Session tokens are hashed (SHA-256) before storage
- Sessions validated on every request via `preHandler` hook
- `request.currentUser` contains user object if authenticated
- CSRF protection via `sameSite: 'lax'` + CORS restrictions

**Auth Flow:**
1. Login creates session in database
2. Signed cookie sent to client
3. Middleware checks for session cookie presence to handle routing (redirect to /login if missing)
4. API requests are proxied via Next.js rewrites (cookie forwarded automatically)
5. `request.currentUser` populated in Fastify context by preHandler hook

**Important Files:**
- `apps/api/src/routes/auth.ts` - Login/logout routes
- `apps/api/src/server.ts` - Authentication preHandler hook (lines 58-66)
- `apps/web/middleware.ts` - Session cookie check for routing (skips /api and /auth paths)
- `apps/web/next.config.mjs` - API proxy rewrites with automatic cookie forwarding

### 4. Route Authorization Pattern (CRITICAL)

**Every route that accesses user-owned resources MUST verify ownership.**

All route plugins use a `preHandler` hook to enforce authentication:
```typescript
app.addHook("preHandler", async (request, reply) => {
  if (!request.currentUser?.id) {
    return reply.status(401).send({ error: "Authentication required" });
  }
});
```

**Required Pattern for ServiceInstance Access:**
```typescript
// ✅ CORRECT: Always include userId in where clause
const instance = await request.server.prisma.serviceInstance.findFirst({
  where: {
    id: instanceId,
    userId: request.currentUser!.id,  // Use ! assertion - preHandler guarantees auth
  },
});

if (!instance) {
  return reply.status(404).send({ message: "Instance not found or access denied" });
}

// ❌ WRONG: Missing userId check allows access to other users' instances
const instance = await request.server.prisma.serviceInstance.findFirst({
  where: { id: instanceId },  // SECURITY VULNERABILITY!
});
```

**Key Points:**
- Use `request.currentUser!.id` (non-null assertion) since preHandler guarantees authentication
- Always include `userId` in queries for user-owned resources (ServiceInstance, TrashTemplate, etc.)
- Return 404 "not found or access denied" to avoid leaking existence of other users' resources
- This pattern applies to: ServiceInstance, TrashTemplate, TrashSyncHistory, TrashBackup, etc.

### 5. Database Schema (Prisma)

**Key Models:**
- `User` - User accounts (single-admin architecture, no role/email fields)
- `Session` - Active sessions linked to users
- `OIDCAccount` - OIDC provider account links (Authelia/Authentik/Generic)
- `OIDCProvider` - OIDC provider configurations
- `WebAuthnCredential` - Passkey credentials for passwordless auth
- `ServiceInstance` - Sonarr/Radarr/Prowlarr connections (API keys encrypted)
- `ServiceTag` - Tags for organizing instances
- `ServiceInstanceTag` - Many-to-many join table

**Encrypted Fields:**
- All `ServiceInstance.encryptedApiKey` + `encryptionIv` pairs
- All `OIDCProvider.encryptedClientSecret` + `clientSecretIv` pairs
- User TMDB API keys (optional)

**Authentication:**
- Multi-authentication support: Password (optional), OIDC, and/or Passkeys
- User model simplified: no email or role fields (single-admin architecture)
- Service instances are per-user (each instance has a `userId` foreign key for ownership)

**Single-Admin Architecture:**
This application assumes a single administrator. The `User` model intentionally has no `role` or `isAdmin` field - admin privileges are enforced by convention: the first (and typically only) user created via the setup flow is treated as the administrator. This simplifies the codebase for the common home-server use case. If multi-user support with role-based access control is needed in the future, a schema migration would be required to add a `role` field to the `User` model. Scripts like `reset-admin-password.ts` and `seed-admin.ts` operate under this assumption.

**Migrations:**
- Development: `pnpm run db:push` (no migration files)
- Production: `pnpm run db:migrate` (applies migrations)
- Docker: Auto-runs migrations on startup via `start.sh`

**Database URL:**
- Auto-configured in `apps/api/src/config/env.ts` (lines 39-43)
- Docker: `file:/config/prod.db`
- Dev: `file:./dev.db`

### 6. ARR Instance Communication

**All communication with Sonarr/Radarr/Prowlarr happens server-side.**

Pattern:
1. Frontend requests data from API (e.g., `/api/library/movies`)
2. API fetches user's service instances from database
3. API decrypts API keys using `encryptor.decrypt()`
4. API creates authenticated fetchers via `createInstanceFetcher()`
5. API makes parallel requests to all instances
6. API aggregates and returns data to frontend

**Key File:** `apps/api/src/lib/arr/arr-fetcher.ts`

```typescript
const fetcher = createInstanceFetcher(app, instance);
const response = await fetcher('/api/v3/movie');  // Calls Radarr API
```

**Why server-side only:**
- User API keys never exposed to browser
- Centralized authentication
- Easy aggregation across multiple instances
- CORS issues avoided

### 7. Frontend Data Fetching Pattern

**All API calls use Tanstack Query hooks:**

Located in `apps/web/src/hooks/api/`:
- `useAuth.ts` - Login, logout, current user
- `useServicesQuery.ts` - Fetch service instances
- `useDashboard.ts` - Queue, calendar, history
- `useLibrary.ts` - Movies, series, search
- `useSearch.ts` - Global indexer search
- `useDiscover.ts` - TMDB trending/popular content

**API client structure:**
- `apps/web/src/lib/api-client/base.ts` - Base `apiRequest()` function
- `apps/web/src/lib/api-client/*.ts` - Typed API functions per domain

**Pattern:**
```typescript
// Hook wraps Tanstack Query
export function useMovies() {
  return useQuery({
    queryKey: ['movies'],
    queryFn: () => libraryApi.getMovies(),  // Calls /api/library/movies
  });
}
```

### 8. Next.js App Router Conventions

**App directory structure:** `apps/web/app/`
- Each folder = route segment
- `page.tsx` = UI for route
- `layout.tsx` = Shared layout
- Server Components by default, add `"use client"` only when needed

**Key layouts/components:**
- `app/layout.tsx` - Root layout with providers
- `src/components/layout/layout-wrapper.tsx` - Main app shell (sidebar, nav)
- `src/components/auth/auth-gate.tsx` - Client-side auth check

**Route structure:**
```
/login         - Login page (public)
/setup         - First-time setup (public)
/dashboard     - Main dashboard (protected)
/library       - Movies/series management (protected)
/search        - Global search (protected)
/discover      - TMDB content discovery (protected)
/settings      - User settings, service management (protected)
```

## Development Workflows

### Local Development Setup

```bash
# Install dependencies
pnpm install

# Start dev servers (from root) - this will auto-generate Prisma client
pnpm run dev  # Runs both API and web in parallel

# If you need to run database migrations separately
cd apps/api
pnpm run db:generate  # Generate Prisma client after schema changes
pnpm run db:push      # Push schema changes (development)
pnpm run db:migrate   # Run migrations (production)
```

**URLs:**
- Frontend: http://localhost:3000
- API: http://localhost:3001
- API Health: http://localhost:3001/health

### Common Tasks

**Add a new dependency:**
```bash
# For API
pnpm --filter @arr/api add <package>

# For web
pnpm --filter @arr/web add <package>

# For shared
pnpm --filter @arr/shared add <package>
```

**Database changes:**
```bash
cd apps/api

# 1. Edit prisma/schema.prisma
# 2. Create migration
npx prisma migrate dev --name <migration_name>

# OR for quick dev iteration
pnpm run db:push
```

**Add a new API route:**
1. Create route file in `apps/api/src/routes/<domain>.ts`
2. Register in `apps/api/src/server.ts`
3. Add types to `packages/shared/src/types/<domain>.ts`
4. Add API client function in `apps/web/src/lib/api-client/<domain>.ts`
5. Create React Query hook in `apps/web/src/hooks/api/use<Domain>.ts`

**Add a new page:**
1. Create `apps/web/app/<route>/page.tsx`
2. Add client components in `apps/web/src/features/<feature>/`
3. Use hooks from `src/hooks/api/`

### Build and Deployment

**Production build:**
```bash
pnpm run build  # Builds all packages via Turbo

# Run production
cd apps/api
pnpm run start  # Port 3001

cd apps/web
pnpm run start  # Port 3000
```

**Docker:**
- Single container image with both API and Web services
- Uses multi-stage builds for optimization
- Main Dockerfile: `Dockerfile` (root directory)
- Startup script: `docker/start-combined.sh` - Manages both services
- Compose file: `docker-compose.yml`
- Published to Docker Hub: `khak1s/arr-dashboard`
- Unraid template: `unraid/arr-dashboard.xml`

## Docker Deployment

**Single Container (Recommended):**

```bash
# Using pre-built image
docker run -d \
  --name arr-dashboard \
  -p 3000:3000 \
  -v /path/to/config:/config \
  khak1s/arr-dashboard:latest

# Or with docker-compose
docker-compose up -d
```

**Key Files:**
- `Dockerfile` - Combined image build (API + Web)
- `docker/start-combined.sh` - Startup script managing both processes
- `unraid/arr-dashboard.xml` - Unraid Community Applications template
- `UNRAID_DEPLOYMENT.md` - Unraid installation guide

**Environment Variables:**
- `DATABASE_URL`: Database path (default: `file:/config/prod.db`)
- `API_PORT`: API port (default: `3001`)
- `PORT`: Web port (default: `3000`)
- `SESSION_TTL_HOURS`: Session expiration (default: `24`)

**Note:** API and Web use the same `API_HOST` variable differently:
- API server: Set to `0.0.0.0` (bind address)
- Web server: Set to `http://localhost:3001` (proxy URL)
- This is handled automatically in `docker/start-combined.sh`

## Code Style and Tooling

**Formatter/Linter:** Biome (NOT ESLint/Prettier)
- Config: `biome.json`
- Line width: 100 characters
- Recommended rules enabled
- Run: `pnpm run format` or `pnpm run lint`

**TypeScript:**
- Strict mode enabled
- `noUncheckedIndexedAccess: true` (always check array access)
- Path aliases configured in `tsconfig.base.json`:
  - `@arr/shared` - Shared package
  - `@arr/api/*` - API source files
  - `@arr/web/*` - Web source files

**Package Manager:** pnpm 9.12.0 (enforced via `packageManager` field)

## Important Gotchas and Patterns

### 1. Path Aliases Don't Work Everywhere
- Next.js app directory can use `@arr/web/*` for `src/` imports
- Server Components may need relative imports for some paths
- Always test imports when adding new files

### 2. Encryption Pattern
```typescript
// Encrypt (API)
const result = app.encryptor.encrypt(plaintext);
// Store result.value and result.iv in database

// Decrypt (API)
const plaintext = app.encryptor.decrypt({ value, iv });
```

### 3. Service Instance Fetcher Pattern
```typescript
// In route handler
const instances = await app.prisma.serviceInstance.findMany({
  where: { userId: request.currentUser.id, service: 'RADARR' }
});

const results = await Promise.all(
  instances.map(async (instance) => {
    const fetch = createInstanceFetcher(app, instance);
    return fetch('/api/v3/movie');
  })
);
```

### 4. Protected Routes
- Backend: Check `request.currentUser` (populated by preHandler hook)
- Frontend: `AuthGate` component handles client-side redirect
- Middleware handles SSR redirects for protected routes (does NOT proxy API requests)

### 5. React Query Key Conventions
```typescript
// Pattern: [domain, action, ...params]
['services']                    // All services
['services', instanceId]        // Specific service
['movies', { instanceId }]      // Movies for instance
['queue', 'all']               // All queue items
```

### 6. Environment Variables
- API: Defined in `apps/api/src/config/env.ts` with Zod schema
- Web: Only `API_HOST` needed (for Next.js rewrites configuration in next.config.mjs)
- NO `NEXT_PUBLIC_*` variables needed for API communication
- Secrets auto-generated if not provided

### 7. Docker Volume Persistence
- All state persisted to `/config/` in Docker (LinuxServer.io convention)
- Contains: `prod.db`, `secrets.json`
- Mount: `./config:/config` in docker-compose

## Testing

**Test Runner:** Vitest
- Config in each package's `package.json`
- Run: `pnpm run test` from root
- Note: Test coverage is minimal in current codebase

## Recent Bug Fixes to Remember

1. **Login race condition** (f7c52f7): Query cache must be updated immediately after login
2. **Cookie forwarding** (c9f24b7): Next.js rewrites automatically forward cookies (no manual forwarding needed)
3. **API proxy** (8b80c82, 917aa92): Use Next.js rewrites (next.config.mjs) instead of client-side API URLs
4. **Secret generation** (8fbb72f): Register cookie plugin AFTER secret generation
5. **Hex key detection** (af87b0d): Encryption key auto-detects hex/base64/utf8 encoding

## Git Workflow

- Main branch: `main`
- Recent version: 2.0 (complete rewrite, NOT compatible with v1.x)
- Docker images published on releases
- Commit style: Conventional commits (feat:, fix:, chore:, docs:)

## Future Considerations

1. **CSRF tokens** - Currently relying on sameSite cookies + CORS, could add @fastify/csrf-protection
2. **PostgreSQL** - SQLite works for single-instance, but PostgreSQL better for multi-instance deployments
3. **Test coverage** - Minimal tests currently, Vitest configured but underutilized
4. **Rate limiting** - Currently global, could be per-user
5. **Webhook support** - Could add webhook receivers for arr services

## Quick Reference: File Locations

**Backend:**
- Entry: `apps/api/src/index.ts`
- Server setup: `apps/api/src/server.ts`
- Routes: `apps/api/src/routes/*.ts`
- Auth: `apps/api/src/lib/auth/`
- ARR clients: `apps/api/src/lib/arr/`
- Prisma schema: `apps/api/prisma/schema.prisma`

**Frontend:**
- Entry: `apps/web/app/layout.tsx`
- Pages: `apps/web/app/**/page.tsx`
- Components: `apps/web/src/components/`
- Features: `apps/web/src/features/` (page-specific components)
- Hooks: `apps/web/src/hooks/api/`
- API client: `apps/web/src/lib/api-client/`
- Middleware: `apps/web/middleware.ts` (route protection only, skips /api and /auth)
- Config: `apps/web/next.config.mjs` (API proxy rewrites)

**Shared:**
- Types: `packages/shared/src/types/*.ts`
- Export: `packages/shared/src/index.ts`

## Key npm Scripts

```bash
# Root-level (via Turbo)
pnpm run dev      # Start all dev servers (API + Web in parallel)
pnpm run build    # Build all packages
pnpm run lint     # Lint all packages with Biome
pnpm run format   # Format all packages with Biome
pnpm run test     # Run tests with Vitest

# API-specific
cd apps/api
pnpm run dev                    # Start API dev server
pnpm run build                  # Build for production
pnpm run start                  # Start production server
pnpm run db:generate            # Generate Prisma client after schema changes
pnpm run db:migrate             # Run migrations (production)
pnpm run db:push                # Push schema changes (development)
pnpm run reset-admin-password   # Reset admin password utility

# Web-specific
cd apps/web
pnpm run dev      # Start Next.js dev server
pnpm run build    # Build for production
pnpm run start    # Start production server
```

## When Working on This Codebase

1. **Understand the proxy architecture** - API requests are proxied via Next.js rewrites (next.config.mjs), NOT middleware. Middleware only handles route protection.
2. **Never commit secrets** - `.env` files are gitignored
3. **Use relative paths in API** - Avoid absolute imports in Fastify routes
4. **Server Components by default** - Only add `"use client"` when necessary
5. **Encrypt all service API keys** - Use `app.encryptor.encrypt()`
6. **Invalidate queries** - After mutations, invalidate relevant query keys
7. **Check Prisma schema** - Understand relationships before querying
8. **Test in Docker** - Local dev and Docker behave differently (env vars, paths)
9. **Always verify resource ownership** - Include `userId` in all queries for user-owned resources (ServiceInstance, TrashTemplate, etc.)

---

**Last Updated:** 2025-12-04
**Version:** 2.0.0
**Node Version:** 20+
**pnpm Version:** 9.12.0+
