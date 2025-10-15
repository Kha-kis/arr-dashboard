# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **unified dashboard for managing multiple Sonarr, Radarr, and Prowlarr instances**. Version 2.3+ is a complete rewrite with modern architecture and zero-config Docker deployment.

**Key Features:**
- Unified view of queue, calendar, history across all instances
- Global search across all indexers
- Library management for movies and TV shows
- Statistics and health monitoring
- TMDB integration for content discovery
- Tag-based instance organization
- Encrypted API keys with session-based authentication
- **Multi-authentication support** (password, OIDC, passkeys)
- **Encrypted backup/restore** with scheduled automated backups

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
- SimpleWebAuthn (passkey authentication)
- Arctic + oauth4webapi (OIDC authentication)
- Zod for validation
- Custom encryption using Node crypto (AES-256-GCM)
- Built-in launcher for process lifecycle management

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

Instead, it uses Next.js middleware to proxy all `/api/*` and `/auth/*` requests to the backend. This is handled in `apps/web/middleware.ts`.

```typescript
// Frontend makes requests to relative paths
fetch("/api/services")  // NOT http://localhost:3001/api/services

// Middleware rewrites to backend
// Development: http://localhost:3001
// Docker: http://api:3001
```

**Why this matters:**
- Eliminates CORS issues
- Handles cookie forwarding automatically
- Works seamlessly in Docker without exposing backend port
- Recent commits (f7c52f7, c9f24b7, 8b80c82, 917aa92) fixed race conditions and cookie forwarding issues

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
- Docker: `/app/data/secrets.json`
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
3. Middleware validates cookie on each request
4. `request.currentUser` populated in Fastify context

**Important Files:**
- `apps/api/src/routes/auth.ts` - Login/logout routes
- `apps/api/src/server.ts` - Authentication preHandler hook (lines 58-66)
- `apps/web/middleware.ts` - Session cookie check for routing

### 4. Database Schema (Prisma)

**Key Models:**
- `User` - User accounts (single-admin architecture, no role/email fields)
- `Session` - Active sessions linked to users
- `OIDCAccount` - OIDC provider account links (Authelia/Authentik/Generic)
- `OIDCProvider` - OIDC provider configurations (can be managed via UI or env vars)
- `WebAuthnCredential` - Passkey credentials for passwordless auth
- `ServiceInstance` - Sonarr/Radarr/Prowlarr connections (API keys encrypted)
- `ServiceTag` - Tags for organizing instances
- `ServiceInstanceTag` - Many-to-many join table
- `BackupSettings` - Scheduled backup configuration (singleton table)

**Encrypted Fields:**
- All `ServiceInstance.encryptedApiKey` + `encryptionIv` pairs
- All `OIDCProvider.encryptedClientSecret` + `clientSecretIv` pairs
- User TMDB API keys (optional)

**Authentication:**
- Multi-authentication support: Password (optional), OIDC, and/or Passkeys
- User model simplified: no email or role fields (single-admin architecture)
- Service instances are global, not per-user (removed userId foreign key)

**Migrations:**
- Development: `pnpm run db:push` (no migration files)
- Production: `pnpm run db:migrate` (applies migrations)
- Docker: Auto-runs migrations on startup via `start.sh`

**Database URL:**
- Auto-configured in `apps/api/src/config/env.ts` (lines 39-43)
- Docker: `file:/app/data/prod.db`
- Dev: `file:./dev.db`

### 5. ARR Instance Communication

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

### 6. Frontend Data Fetching Pattern

**All API calls use Tanstack Query hooks:**

Located in `apps/web/src/hooks/api/`:
- `useAuth.ts` - Login, logout, current user
- `useServicesQuery.ts` - Fetch service instances
- `useDashboard.ts` - Queue, calendar, history
- `useLibrary.ts` - Movies, series, search
- `useSearch.ts` - Global indexer search
- `useDiscover.ts` - TMDB trending/popular content
- `useBackup.ts` - Backup creation, restoration, scheduled backups

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

### 7. Backup & Restore System

**Complete encrypted backup/restore functionality with scheduled automation.**

**Architecture:**
- `apps/api/src/lib/backup/backup-service.ts` - Core backup/restore logic
- `apps/api/src/lib/backup/backup-scheduler.ts` - Scheduled backup automation
- `apps/api/src/lib/lifecycle/lifecycle-service.ts` - Process lifecycle management
- `apps/api/src/launcher.ts` - Production launcher with auto-restart support

**Key Features:**
- **Manual backups** - Create encrypted backup on-demand via UI or API
- **Scheduled backups** - Automated backups (hourly, daily, weekly)
- **AES-256-GCM encryption** - Password-based encryption with PBKDF2 key derivation
- **Complete backup** - Includes all database data + encryption secrets
- **Auto-restart** - Application automatically restarts after restore (production)
- **Backup rotation** - Configurable retention (keep last N scheduled backups)

**What's Included in Backups:**
- All database tables (users, sessions, service instances, OIDC providers, passkeys, etc.)
- Encryption keys (from `secrets.json`)
- Session cookie secret
- App version metadata

**API Routes:**
- `POST /api/backup/create` - Create encrypted backup (rate limited: 3/5min)
- `POST /api/backup/restore` - Restore from encrypted backup (rate limited: 2/5min)
- `POST /api/system/restart` - Manual application restart (rate limited: 2/5min)
- `GET /api/backup/settings` - Get scheduled backup configuration
- `PUT /api/backup/settings` - Update scheduled backup configuration
- `GET /api/backup/scheduled` - List scheduled backups with metadata
- `DELETE /api/backup/scheduled/:filename` - Delete scheduled backup

**Encryption Format:**
```
Backup File (.enc)
├── Salt (32 bytes)
├── IV (16 bytes)
├── Auth Tag (16 bytes)
└── Encrypted Payload (base64)
    └── JSON { version, appVersion, timestamp, data, secrets }
```

**Scheduled Backups:**
- Stored in `/app/data/backups/` (Docker) or `./backups/` (dev)
- Configured via `BackupSettings` model (singleton table)
- Intervals: DISABLED, HOURLY (1-24h), DAILY (1-7 days), WEEKLY
- Auto-rotation based on `retentionCount` setting
- Background scheduler runs on API startup

**Important Files:**
- `apps/api/src/routes/backup.ts` - All backup/restore endpoints
- `apps/api/src/routes/system.ts` - System restart endpoint
- `apps/web/src/features/settings/components/backup-tab.tsx` - UI for backup management
- `BACKUP_RESTORE.md` - Complete user documentation

**Lifecycle Management:**
- Production uses `launcher.ts` to manage API process
- `lifecycleService.scheduleRestart()` triggers graceful shutdown
- Launcher monitors process and restarts automatically
- Development mode shows manual restart message

### 8. Multi-Authentication System

**Users can authenticate via password, OIDC, or passkeys (or any combination).**

**Authentication Methods:**

1. **Password Authentication** (default, always enabled)
   - Traditional username/password login
   - Password hashing with strong requirements
   - Account lockout after 5 failed attempts (15 min)
   - Optional: Users can remove password if OIDC/passkey configured

2. **OIDC/OAuth2 Authentication**
   - Supported providers: Authelia, Authentik, Generic OIDC
   - Configuration via environment variables OR database (UI management)
   - PKCE for authorization code flow
   - Nonce validation to prevent ID token replay
   - State parameter for CSRF protection
   - Account linking during initial setup or while logged in

3. **Passkey Authentication (WebAuthn)**
   - Passwordless authentication using biometrics or security keys
   - Supports platform authenticators (Touch ID, Face ID, Windows Hello)
   - Supports roaming authenticators (YubiKey, etc.)
   - Multiple passkeys per account
   - Backup-eligible and cross-device sync support

**Key Files:**
- `apps/api/src/routes/auth.ts` - All authentication routes
- `apps/api/src/routes/oidc/*.ts` - OIDC provider management and callbacks
- `apps/api/src/routes/passkey.ts` - WebAuthn passkey endpoints
- `apps/api/src/lib/auth/oidc/` - OIDC client implementations
- `apps/api/src/lib/auth/passkey/` - WebAuthn challenge/verification logic
- `AUTHENTICATION.md` - Complete setup guide for all auth methods

**OIDC Environment Variables:**
```bash
# Authelia
OIDC_AUTHELIA_CLIENT_ID, OIDC_AUTHELIA_CLIENT_SECRET, OIDC_AUTHELIA_ISSUER, OIDC_AUTHELIA_REDIRECT_URI

# Authentik
OIDC_AUTHENTIK_CLIENT_ID, OIDC_AUTHENTIK_CLIENT_SECRET, OIDC_AUTHENTIK_ISSUER, OIDC_AUTHENTIK_REDIRECT_URI

# Generic OIDC
OIDC_GENERIC_CLIENT_ID, OIDC_GENERIC_CLIENT_SECRET, OIDC_GENERIC_ISSUER, OIDC_GENERIC_REDIRECT_URI
```

**WebAuthn Environment Variables:**
```bash
WEBAUTHN_RP_NAME="Arr Dashboard"           # Relying party name
WEBAUTHN_RP_ID="arr.example.com"           # Domain (no protocol/port)
WEBAUTHN_ORIGIN="https://arr.example.com"  # Full origin URL
```

**Security Features:**
- OIDC providers can be configured via UI (stored encrypted in database)
- All OIDC client secrets are encrypted (AES-256-GCM)
- Passkey challenges stored in-memory with 5-minute expiration
- OIDC state/nonce stored in-memory with 15-minute expiration
- Account lockout protection
- Session-based authentication with HTTP-only cookies

### 9. UI Component System & Theming

**Reusable UI components that maintain consistent theming across the entire application.**

**Architecture:**
- `apps/web/src/components/ui/` - All reusable UI primitives
- `apps/web/src/styles/tokens/tailwind-preset.ts` - Design token system
- `apps/web/src/lib/utils.ts` - Utility functions (`cn()` for class merging)

**Component Library (shadcn/ui-inspired):**

All UI components are exported from a centralized index:
```typescript
import { Button, Card, Input, Badge, Dialog, Alert } from '@/components/ui';
```

**Available Components:**
- **Primitives**: Button, Card, Input, Badge, Select, Dialog
- **Feedback**: Toast, Alert, EmptyState
- **Loading**: Skeleton (with variants: SkeletonText, SkeletonCard, SkeletonAvatar)
- **Navigation**: Pagination

**Design Token System:**

The app uses a semantic color system based on CSS custom properties mapped to Tailwind utilities:

**Semantic Colors:**
```typescript
// Background colors
bg          // Main background
bg-subtle   // Subtle background (cards, panels)
bg-muted    // More muted backgrounds
bg-overlay  // Overlays and modals

// Foreground/text colors
fg          // Primary text color
fg-muted    // Muted text
fg-subtle   // Subtle text

// Brand colors
primary          // Primary brand color (sky blue)
primary-hover    // Hover state
accent           // Accent color
accent-secondary // Secondary accent

// Semantic feedback colors
success  // Success states (green)
warning  // Warning states (yellow)
danger   // Danger/error states (red)
info     // Info states (blue)

// Borders
border       // Default border color
border-hover // Border hover state
border-focus // Border focus state
```

**Component Variants:**

Components support multiple variants via props:

```typescript
// Button variants
<Button variant="primary">Primary</Button>
<Button variant="secondary">Secondary</Button>
<Button variant="ghost">Ghost</Button>
<Button variant="danger">Danger</Button>
<Button variant="gradient">Gradient</Button>

// Button sizes
<Button size="sm">Small</Button>
<Button size="md">Medium</Button>
<Button size="lg">Large</Button>

// Alert variants
<Alert variant="success">Success message</Alert>
<Alert variant="warning">Warning message</Alert>
<Alert variant="danger">Error message</Alert>
<Alert variant="info">Info message</Alert>
```

**Styling Patterns:**

1. **Use semantic tokens instead of hardcoded colors:**
   ```typescript
   // Good
   className="bg-bg-subtle text-fg border border-border"

   // Avoid
   className="bg-slate-900 text-white border-white/10"
   ```

2. **Use the cn() utility for conditional classes:**
   ```typescript
   import { cn } from '@/lib/utils';

   <div className={cn(
     "base-classes",
     isActive && "active-classes",
     isDisabled && "disabled-classes",
     className  // Allow override from props
   )} />
   ```

3. **Extend components with composition:**
   ```typescript
   // Don't modify core components directly
   // Instead, compose them with additional styling

   const MyCustomCard = ({ children, ...props }) => (
     <Card className="border-accent/20 bg-accent/5" {...props}>
       {children}
     </Card>
   );
   ```

4. **Use variant styles for reusable patterns:**
   ```typescript
   // Define variant maps for consistency
   const statusStyles = {
     active: "bg-success/10 text-success border-success/30",
     pending: "bg-warning/10 text-warning border-warning/30",
     error: "bg-danger/10 text-danger border-danger/30",
   };

   <div className={statusStyles[status]} />
   ```

**Dark Theme:**
The app uses a dark theme by default with:
- Deep slate/navy backgrounds
- Sky blue accents (primary color)
- Subtle white/opacity for borders and secondary elements
- Backdrop blur effects for glass-morphism
- Smooth transitions and hover states

**Component Styling Conventions:**
- Border radius: `rounded-xl` (12px) or `rounded-2xl` (16px) for cards
- Transitions: `transition-all duration-200` for smooth interactions
- Focus rings: `focus:ring-2 focus:ring-primary/50 focus:ring-offset-2`
- Hover states: Scale transforms (`hover:scale-[1.02]`) and shadow enhancements
- Backdrop blur: `backdrop-blur-xl` for glass-morphism effects

**Key Files:**
- `apps/web/src/components/ui/index.ts` - Centralized component exports
- `apps/web/src/components/ui/button.tsx` - Button component with variants
- `apps/web/src/components/ui/card.tsx` - Card component family
- `apps/web/tailwind.config.ts` - Tailwind configuration
- `apps/web/src/styles/tokens/tailwind-preset.ts` - Design token definitions

**Important:**
- Always import from `@/components/ui` (centralized exports)
- Never hardcode colors - use semantic tokens
- Use `cn()` utility for conditional class names
- Maintain consistency with existing component variants
- Test dark theme appearance for all new components

### 10. Next.js App Router Conventions

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
  -v /path/to/data:/app/data \
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
- `DATABASE_URL`: Database path (default: `file:/app/data/prod.db`)
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
- Middleware handles SSR redirects for protected routes

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
- Web: Only `API_HOST` needed (for middleware proxy)
- NO `NEXT_PUBLIC_*` variables needed for API communication
- Secrets auto-generated if not provided
- OIDC/WebAuthn optional environment variables (see sections 7-8 above)
- All sensitive env vars (client secrets, encryption keys) are optional and have secure defaults

### 7. Docker Volume Persistence
- All state persisted to `/app/data/` in Docker
- Contains: `prod.db`, `secrets.json`, `backups/` directory
- Mount: `./data:/app/data` in docker-compose
- Scheduled backups saved to `/app/data/backups/` automatically

### 8. UI Component Patterns

**Always use the centralized UI component library:**
```typescript
// Good - centralized import
import { Button, Card, Alert, Badge } from '@/components/ui';

// Avoid - direct file imports
import { Button } from '@/components/ui/button';
```

**Use semantic tokens for theming:**
```typescript
// Good - semantic tokens (theme-aware)
<div className="bg-bg-subtle text-fg border border-border">

// Avoid - hardcoded colors (breaks theme consistency)
<div className="bg-slate-900 text-white border-white/10">
```

**Use cn() utility for conditional classes:**
```typescript
import { cn } from '@/lib/utils';

// Good - proper class merging
<Button
  className={cn(
    "base-styles",
    isActive && "active-styles",
    className  // Allow prop override
  )}
/>

// Avoid - string concatenation
<Button className={`base-styles ${isActive ? 'active-styles' : ''} ${className}`} />
```

**Extend via composition, not modification:**
```typescript
// Good - compose existing components
export const DangerCard = ({ children, ...props }) => (
  <Card className="border-danger/20 bg-danger/5" {...props}>
    {children}
  </Card>
);

// Avoid - modifying core component files
// (Don't edit apps/web/src/components/ui/card.tsx directly)
```

### 9. Backup/Restore Patterns

**Creating backups:**
```typescript
// In route handler
const backupService = new BackupService(app.prisma, app.encryptor, app.secretManager);
const { encryptedBackup, metadata } = await backupService.createBackup(password);
// Returns base64-encoded encrypted backup
```

**Restoring backups:**
```typescript
const backupService = new BackupService(app.prisma, app.encryptor, app.secretManager);
await backupService.restoreBackup({ encryptedBackup, password });
// Overwrites database and secrets.json

// Then trigger restart (production only)
if (process.env.NODE_ENV === 'production') {
  app.lifecycleService.scheduleRestart();
}
```

**Scheduled backups:**
- Managed by `BackupScheduler` class
- Runs on interval based on `BackupSettings` model
- Auto-rotates old backups based on `retentionCount`
- Backups stored with metadata in filename: `scheduled-backup-2025-10-15T12-00-00-000Z.enc`

**Important:**
- Backups include encryption keys from `secrets.json`
- Restore completely overwrites database (no merge)
- Sessions are invalidated after restore (users must re-login)
- Application auto-restarts after restore in production (via launcher)

## Testing

**Test Runner:** Vitest
- Config in each package's `package.json`
- Run: `pnpm run test` from root
- Note: Test coverage is minimal in current codebase

## Recent Bug Fixes to Remember

1. **Login race condition** (f7c52f7): Query cache must be updated immediately after login
2. **Cookie forwarding** (c9f24b7): Middleware must explicitly forward cookie headers
3. **API proxy** (8b80c82, 917aa92): Use middleware proxy instead of client-side API URLs
4. **Secret generation** (8fbb72f): Register cookie plugin AFTER secret generation
5. **Hex key detection** (af87b0d): Encryption key auto-detects hex/base64/utf8 encoding
6. **OIDC race conditions** (02ef613): Prevent authentication bypass in OIDC flow
7. **Passkey deletion** (9576cac): Require alternative auth before deleting last passkey
8. **Registration lockout** (d868563): Require password during initial setup to prevent permanent lockout
9. **Passkey authenticator types** (6bd87c8): Allow roaming authenticators (YubiKey support)

## Git Workflow

- Main branch: `main`
- Current version: 2.3+ (complete rewrite, NOT compatible with v1.x)
- Docker images published on releases to `khak1s/arr-dashboard`
- Commit style: Conventional commits (feat:, fix:, chore:, docs:, security:)

## Future Considerations

1. **CSRF tokens** - Currently relying on sameSite cookies + CORS, could add @fastify/csrf-protection
2. **PostgreSQL** - SQLite works for single-instance, but PostgreSQL better for multi-instance deployments
3. **Test coverage** - Minimal tests currently, Vitest configured but underutilized
4. **Rate limiting** - Currently global, could be per-user
5. **Webhook support** - Could add webhook receivers for arr services

## Quick Reference: File Locations

**Backend:**
- Entry: `apps/api/src/index.ts`
- Launcher: `apps/api/src/launcher.ts` (production process manager)
- Server setup: `apps/api/src/server.ts`
- Routes: `apps/api/src/routes/*.ts`
  - `auth.ts` - Login/logout, password management
  - `oidc/*.ts` - OIDC provider management and callbacks
  - `passkey.ts` - WebAuthn passkey authentication
  - `backup.ts` - Backup creation, restoration, scheduled backups
  - `system.ts` - System operations (restart)
  - `services.ts`, `library.ts`, `dashboard.ts`, etc.
- Auth: `apps/api/src/lib/auth/`
  - `session.ts`, `encryption.ts`, `secret-manager.ts`
  - `oidc/` - OIDC client implementations
  - `passkey/` - WebAuthn challenge/verification
- Backup: `apps/api/src/lib/backup/`
  - `backup-service.ts` - Core backup/restore logic
  - `backup-scheduler.ts` - Scheduled backup automation
- Lifecycle: `apps/api/src/lib/lifecycle/lifecycle-service.ts`
- ARR clients: `apps/api/src/lib/arr/`
- Prisma schema: `apps/api/prisma/schema.prisma`

**Frontend:**
- Entry: `apps/web/app/layout.tsx`
- Pages: `apps/web/app/**/page.tsx`
- Components: `apps/web/src/components/`
- Features: `apps/web/src/features/` (page-specific components)
- Hooks: `apps/web/src/hooks/api/`
- API client: `apps/web/src/lib/api-client/`
- Middleware: `apps/web/middleware.ts`

**Shared:**
- Types: `packages/shared/src/types/*.ts`
  - `backup.ts` - Backup/restore types
  - `auth.ts`, `oidc.ts`, `passkey.ts` - Authentication types
  - `service.ts`, `library.ts`, etc.
- Export: `packages/shared/src/index.ts`

**Documentation:**
- `CLAUDE.md` - This file (architectural overview)
- `README.md` - User-facing documentation
- `AUTHENTICATION.md` - Multi-auth setup guide (OIDC, passkeys)
- `BACKUP_RESTORE.md` - Backup/restore user guide
- `UNRAID_DEPLOYMENT.md` - Unraid-specific deployment instructions

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
pnpm run dev                    # Start API dev server (standard)
pnpm run dev:launcher           # Start API with launcher (auto-restart support)
pnpm run build                  # Build for production
pnpm run start                  # Start production server (uses launcher)
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

1. **Always check middleware first** - API proxy behavior is non-obvious
2. **Never commit secrets** - `.env` files are gitignored
3. **Use relative paths in API** - Avoid absolute imports in Fastify routes
4. **Server Components by default** - Only add `"use client"` when necessary
5. **Use UI component system** - Import from `@/components/ui`, use semantic tokens, never hardcode colors
6. **Encrypt all sensitive data** - Use `app.encryptor.encrypt()` for API keys, OIDC secrets, etc.
7. **Invalidate queries** - After mutations, invalidate relevant query keys
8. **Check Prisma schema** - Understand relationships before querying
9. **Test in Docker** - Local dev and Docker behave differently (env vars, paths)
10. **Multi-auth aware** - Users may have password, OIDC, passkeys, or any combination
11. **Rate limiting** - All sensitive endpoints (backup, restore, restart, auth) are rate-limited
12. **Security first** - Review AUTHENTICATION.md and recent security fixes before changing auth code
13. **Backup testing** - Test backup/restore in development before making database schema changes
14. **Maintain theme consistency** - Use `cn()` utility for conditional classes, follow component variant patterns

---

**Last Updated:** 2025-10-15
**Version:** 2.3.0
**Node Version:** 20+
**pnpm Version:** 9.12.0+

## Major Changes Since v2.0

**v2.3.0 (October 2025):**
- Added backup/restore system with AES-256-GCM encryption
- Implemented scheduled automated backups (hourly/daily/weekly)
- Added process lifecycle management with auto-restart
- Introduced launcher for production deployments

**v2.2.0 (October 2025):**
- Multi-authentication support (password + OIDC + passkeys)
- OIDC providers: Authelia, Authentik, Generic
- WebAuthn passkey authentication with YubiKey support
- Multiple security fixes (PKCE, nonce validation, race conditions)
- UI-based OIDC provider management with encrypted secrets
- Account linking workflow for multiple auth methods
