# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

This is a **unified dashboard for managing multiple Sonarr, Radarr, and Prowlarr instances**. Version 2.3+ is a complete rewrite with modern architecture, zero-config Docker deployment, and encrypted backup/restore capabilities.

**Core Features:**
- Unified view of queue, calendar, history across all instances
- Global search across all indexers  
- Library management for movies and TV shows
- TMDB integration for content discovery
- Multi-authentication support (password, OIDC, passkeys)
- Encrypted API keys with session-based authentication
- Automated encrypted backups with scheduled rotation

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

**Critical:** This is a pnpm workspace monorepo managed by Turbo. Always run commands from the root directory using `pnpm run <script>`.

### Technology Stack

**Backend (@arr/api):**
- Fastify 4 with TypeScript
- Prisma ORM with SQLite (supports PostgreSQL/MySQL)
- Lucia Auth for session-based authentication (NOT JWT)
- Custom AES-256-GCM encryption for sensitive data
- SimpleWebAuthn for passkey authentication
- Arctic + oauth4webapi for OIDC authentication

**Frontend (@arr/web):**
- Next.js 14 App Router (NOT Pages Router)
- React 18 with Server Components
- TailwindCSS + shadcn/ui component system
- Tanstack Query for data fetching
- Zustand for minimal client state

**Shared (@arr/shared):**
- Zod schemas exported as both ESM and CJS
- Shared TypeScript types between frontend and backend

## Development Commands

### Getting Started

```bash
# Install dependencies
pnpm install

# Start development servers (API + Web in parallel)
pnpm run dev

# URLs
# Frontend: http://localhost:3000
# API: http://localhost:3001
```

### Common Development Tasks

```bash
# Build all packages
pnpm run build

# Lint and format (uses Biome, NOT ESLint/Prettier)
pnpm run lint
pnpm run format
pnpm run typecheck

# Run tests
pnpm run test

# Package-specific commands
pnpm --filter @arr/api <command>
pnpm --filter @arr/web <command>
pnpm --filter @arr/shared <command>
```

### Database Operations

```bash
cd apps/api

# Generate Prisma client after schema changes
pnpm run db:generate

# Development: Push schema changes without migration files
pnpm run db:push

# Production: Run migrations
pnpm run db:migrate

# Reset admin password utility
pnpm run reset-admin-password
```

### Testing Individual Components

```bash
# Test a specific service instance
# Use the UI at /settings to add your instances

# Test backup/restore
# Navigate to Settings → Backup tab in the UI

# Test different authentication methods
# Configure OIDC providers in Settings → Authentication
```

## Critical Architectural Patterns

### 1. API Proxy Pattern (CRITICAL)

**The web app does NOT make direct API calls to `http://localhost:3001`.**

All API communication uses Next.js middleware to proxy `/api/*` and `/auth/*` requests:

```typescript
// Frontend makes requests to relative paths
fetch("/api/services")  // NOT http://localhost:3001/api/services

// Middleware in apps/web/middleware.ts rewrites to backend
// Development: http://localhost:3001
// Docker: http://api:3001
```

**Environment Variables:**
- `API_HOST` for middleware proxy target
- NO `NEXT_PUBLIC_*` variables needed for API communication

### 2. Session-Based Authentication (NOT JWT)

Uses **signed, HTTP-only cookies** with Lucia Auth:
- Cookie name: `arr_session`
- Sessions stored in database, tokens hashed (SHA-256)
- `request.currentUser` populated in Fastify context
- Multi-authentication: password + OIDC + passkeys (any combination)

**Key Files:**
- `apps/api/src/routes/auth.ts` - Authentication routes
- `apps/api/src/lib/auth/session.ts` - Session management
- `apps/web/middleware.ts` - Session validation for routing

### 3. Zero-Config Security

**Auto-generates encryption keys and session secrets on first run:**
- `ENCRYPTION_KEY` (32 bytes hex)
- `SESSION_COOKIE_SECRET` (32 bytes hex) 
- Persisted to `secrets.json` next to database file
- Only generates if not provided via environment

**Implementation:**
- `apps/api/src/lib/auth/secret-manager.ts` - Secret generation
- `apps/api/src/lib/auth/encryption.ts` - AES-256-GCM encryption

### 4. Server-Side ARR Communication

**All Sonarr/Radarr/Prowlarr communication happens server-side:**

1. Frontend requests data from API (e.g., `/api/library/movies`)
2. API fetches user's service instances from database
3. API decrypts API keys using `encryptor.decrypt()`
4. API makes authenticated requests to ARR instances
5. API aggregates and returns data to frontend

**Key Pattern:**
```typescript
const instances = await app.prisma.serviceInstance.findMany({
  where: { service: 'RADARR' }
});

const results = await Promise.all(
  instances.map(async (instance) => {
    const fetch = createInstanceFetcher(app, instance);
    return fetch('/api/v3/movie');
  })
);
```

### 5. Encrypted Backup/Restore System

**Complete encrypted backup/restore with scheduled automation:**

- **Manual backups** via UI or API (`POST /api/backup/create`)
- **Scheduled backups** (hourly/daily/weekly) with auto-rotation
- **AES-256-GCM encryption** with password-based key derivation
- **Complete state** includes database + encryption secrets
- **Auto-restart** after restore in production

**Key Files:**
- `apps/api/src/lib/backup/backup-service.ts` - Core backup logic
- `apps/api/src/lib/backup/backup-scheduler.ts` - Scheduled automation
- `apps/api/src/launcher.ts` - Production process manager with auto-restart

### 6. UI Component System

**Centralized component library with semantic theming:**

```typescript
// Always import from centralized barrel
import { Button, Card, Alert, Badge } from '@/components/ui';

// Use semantic tokens (NOT hardcoded colors)
<div className="bg-bg-subtle text-fg border border-border">

// Use cn() utility for conditional classes
import { cn } from '@/lib/utils';
<Button className={cn("base-styles", isActive && "active-styles")} />
```

**Available Components:**
- Primitives: Button, Card, Input, Badge, Select, Dialog
- Feedback: Toast, Alert, EmptyState  
- Loading: Skeleton variants
- Navigation: Pagination

**Theme System:**
- Dark theme by default with sky blue accents
- Semantic color tokens (bg, fg, primary, danger, etc.)
- Variant-based styling with consistent patterns

## Database Schema (Prisma)

**Key Models:**
- `User` - Single-admin architecture, supports multiple auth methods
- `Session` - Active sessions linked to users
- `OIDCAccount`, `OIDCProvider` - OIDC authentication
- `WebAuthnCredential` - Passkey authentication
- `ServiceInstance` - Sonarr/Radarr/Prowlarr connections (encrypted API keys)
- `ServiceTag`, `ServiceInstanceTag` - Instance organization
- `BackupSettings` - Scheduled backup configuration

**Encrypted Fields:**
- All `ServiceInstance.encryptedApiKey` + `encryptionIv` pairs
- All `OIDCProvider.encryptedClientSecret` + `clientSecretIv` pairs
- User TMDB API keys (optional)

**Database URL auto-configured:**
- Docker: `file:/app/data/prod.db`
- Development: `file:./dev.db`

## Production Deployment

### Docker (Recommended)

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

**Volume Persistence:**
- All state in `/app/data/` (contains `prod.db`, `secrets.json`, `backups/`)
- Automatic database migrations on startup

### Manual Production

```bash
# Build all packages
pnpm run build

# Run database migrations
cd apps/api
pnpm run db:migrate

# Start production servers
pnpm run start  # API on port 3001

cd ../web
pnpm run start  # Web on port 3000
```

## Authentication Configuration

### OIDC Providers (Optional)

Configure via environment variables or UI:

```bash
# Authelia
OIDC_AUTHELIA_CLIENT_ID=your-client-id
OIDC_AUTHELIA_CLIENT_SECRET=your-secret
OIDC_AUTHELIA_ISSUER=https://auth.example.com
OIDC_AUTHELIA_REDIRECT_URI=https://dashboard.example.com/auth/oidc/authelia/callback

# Authentik  
OIDC_AUTHENTIK_CLIENT_ID=your-client-id
OIDC_AUTHENTIK_CLIENT_SECRET=your-secret
OIDC_AUTHENTIK_ISSUER=https://auth.example.com/application/o/your-app/
OIDC_AUTHENTIK_REDIRECT_URI=https://dashboard.example.com/auth/oidc/authentik/callback

# Generic OIDC
OIDC_GENERIC_CLIENT_ID=your-client-id
OIDC_GENERIC_CLIENT_SECRET=your-secret
OIDC_GENERIC_ISSUER=https://auth.example.com
OIDC_GENERIC_REDIRECT_URI=https://dashboard.example.com/auth/oidc/generic/callback
```

### WebAuthn/Passkeys (Optional)

```bash
WEBAUTHN_RP_NAME="Arr Dashboard"
WEBAUTHN_RP_ID="arr.example.com"           # Domain only, no protocol/port
WEBAUTHN_ORIGIN="https://arr.example.com"  # Full origin URL
```

## File Structure Reference

**Backend Key Files:**
- `apps/api/src/index.ts` - Main entry point
- `apps/api/src/launcher.ts` - Production process manager
- `apps/api/src/server.ts` - Fastify server setup
- `apps/api/src/routes/` - API route handlers
- `apps/api/src/lib/auth/` - Authentication logic
- `apps/api/src/lib/backup/` - Backup/restore system
- `apps/api/prisma/schema.prisma` - Database schema

**Frontend Key Files:**
- `apps/web/app/` - Next.js App Router pages
- `apps/web/src/components/` - Reusable components
- `apps/web/src/features/` - Page-specific components
- `apps/web/src/hooks/api/` - Tanstack Query hooks
- `apps/web/src/lib/api-client/` - Typed API client functions
- `apps/web/middleware.ts` - API proxy middleware

**Shared:**
- `packages/shared/src/types/` - Shared TypeScript types
- `packages/shared/src/index.ts` - Barrel exports

## Development Best Practices

### Adding New Features

1. **API Route:** Create in `apps/api/src/routes/<domain>.ts`
2. **Types:** Add to `packages/shared/src/types/<domain>.ts`
3. **API Client:** Add function to `apps/web/src/lib/api-client/<domain>.ts`
4. **React Hook:** Create hook in `apps/web/src/hooks/api/use<Domain>.ts`
5. **UI Components:** Use existing UI components from `@/components/ui`
6. **Register Route:** Add to `apps/api/src/server.ts`

### Security Considerations

- **Never expose API keys** to frontend - use server-side fetching
- **Encrypt sensitive data** using `app.encryptor.encrypt()`
- **Rate limit sensitive endpoints** (backup, restore, auth)
- **Use session-based auth** not JWT tokens
- **Validate OIDC nonces** to prevent token replay

### Code Style

- **Formatter:** Biome (100 char line width)
- **Import from barrels:** `import { Button } from '@/components/ui'`
- **Semantic tokens:** Use `bg-bg-subtle` not `bg-slate-900`
- **Class merging:** Use `cn()` utility for conditional classes
- **Server Components:** Default in Next.js, add `"use client"` only when needed

### Testing Approach

- **Test Runner:** Vitest configured in each package
- **Minimal coverage** currently - focus on critical paths
- **Manual testing** via Docker deployment recommended
- **Backup/restore testing** essential before schema changes

## Important Gotchas

1. **API Proxy:** Frontend uses middleware proxy, not direct API calls
2. **Encryption Keys:** Auto-generated, stored in `secrets.json`
3. **Sessions:** Lucia auth with database storage, not in-memory
4. **Monorepo:** Always run commands from root with pnpm
5. **Docker Paths:** `/app/data/` contains all persistent state
6. **Multi-auth:** Users can have password, OIDC, passkeys simultaneously
7. **Rate Limits:** Backup/restore/restart endpoints have strict rate limits
8. **Process Restart:** Production uses launcher for auto-restart after restore

## Support Documentation

- `README.md` - User installation guide
- `AUTHENTICATION.md` - Multi-auth setup (OIDC, passkeys)
- `BACKUP_RESTORE.md` - Backup/restore user guide
- `UNRAID_DEPLOYMENT.md` - Unraid-specific instructions
- `CLAUDE.md` - Detailed architectural documentation

## Version Information

- **Current:** v2.3.0+ (complete rewrite, NOT compatible with v1.x)
- **Node.js:** 20+
- **pnpm:** 9.12.0+
- **Docker:** khak1s/arr-dashboard:latest