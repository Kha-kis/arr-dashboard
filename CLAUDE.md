# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Quick Start

```bash
pnpm install && pnpm run dev  # Starts API (3001) + Web (3000)
```

**Critical Rules:**
1. **API Proxy**: Frontend calls `/api/*` → Next.js rewrites to backend (NOT direct `localhost:3001` calls)
2. **Ownership**: Always include `userId: request.currentUser!.id` in queries for user-owned resources
3. **Encryption**: All API keys encrypted with AES-256-GCM via `app.encryptor.encrypt()`
4. **Auth Check**: Protected routes use preHandler hook checking `request.currentUser?.id`

**Key Paths:**
- API routes: `apps/api/src/routes/`
- Frontend pages: `apps/web/app/`
- Shared types: `packages/shared/src/types/`
- Prisma schema: `apps/api/prisma/schema.prisma`

---

## Project Overview

Unified dashboard for managing multiple **Sonarr**, **Radarr**, and **Prowlarr** instances with:

- Multi-instance aggregation (queue, calendar, history, library)
- Global indexer search via Prowlarr
- TRaSH Guides integration for quality profile management
- Automated hunting for missing content and upgrades
- TMDB discovery and recommendations
- Multi-auth: Password, OIDC (Authelia/Authentik), Passkeys (WebAuthn)
- Encrypted API keys with zero-config secret generation
- Automated backup system

**Architecture**: Single-admin, self-hosted application optimized for home server deployment.

---

## Architecture

### Monorepo Structure

```
arr-dashboard/
├── apps/
│   ├── api/           # Fastify 4 server (port 3001)
│   └── web/           # Next.js 14 App Router (port 3000)
├── packages/
│   └── shared/        # Zod schemas + TypeScript types
└── docker/
    └── start-combined.sh  # Single-container startup
```

**Package Manager**: pnpm 10+ with Turbo for builds.

### Technology Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| **Backend** | Fastify 4, Prisma, Zod | Session-based auth (NOT JWT) |
| **Frontend** | Next.js 14 App Router, React 18 | Server Components default |
| **UI** | TailwindCSS, shadcn/ui | Dark mode via next-themes |
| **Data** | Tanstack Query | 25+ custom hooks |
| **Database** | SQLite (default) | PostgreSQL/MySQL supported |
| **Encryption** | AES-256-GCM | Auto-generated keys |

### Database Models

#### Core Models
| Model | File | Purpose |
|-------|------|---------|
| `User` | schema.prisma:1-15 | Single admin (no roles) |
| `Session` | schema.prisma:17-23 | Hashed tokens with expiry |
| `ServiceInstance` | schema.prisma:25-40 | Sonarr/Radarr/Prowlarr connections |
| `ServiceTag` | schema.prisma:42-48 | Instance organization |

#### Authentication Models
| Model | Purpose |
|-------|---------|
| `OIDCProvider` | Singleton OIDC config (encrypted secret) |
| `OIDCAccount` | User ↔ OIDC provider links |
| `WebAuthnCredential` | Passkey credentials with counter |

#### Feature Models
| Model | Purpose |
|-------|---------|
| `TrashTemplate` | User quality profile templates |
| `TrashSyncHistory` | Sync operation audit log |
| `TrashBackup` | Pre-sync snapshots |
| `TrashCache` | GitHub JSON cache |
| `HuntConfig` | Per-instance hunt settings |
| `HuntLog` | Hunt activity log |
| `BackupSettings` | Singleton backup config |
| `SystemSettings` | Singleton system config |

---

## Authentication System

### Overview

Three mutually-exclusive authentication methods during setup:

| Method | Requires | Disabled When |
|--------|----------|---------------|
| **Password** | Username + password | OIDC enabled |
| **OIDC** | External provider | - |
| **Passkeys** | Password as prerequisite | OIDC enabled |

**Key Files:**
- `apps/api/src/routes/auth.ts` - Password auth
- `apps/api/src/routes/auth-oidc.ts` - OIDC flow
- `apps/api/src/routes/auth-passkey.ts` - WebAuthn
- `apps/api/src/lib/auth/session.ts` - Session management
- `apps/api/src/lib/auth/password.ts` - Argon2id hashing
- `apps/api/src/lib/auth/encryption.ts` - AES-256-GCM
- `apps/api/src/lib/auth/passkey-service.ts` - WebAuthn wrapper

### Session Management

**Flow:**
1. Login → Generate 32-byte token → SHA-256 hash → Store in DB
2. Signed HTTP-only cookie sent to client (`arr_session`)
3. Each request: Extract cookie → Hash → Lookup → Validate expiry
4. `request.currentUser` populated by preHandler hook

**Cookie Configuration:**
```typescript
{
  httpOnly: true,
  sameSite: 'lax',      // CSRF protection
  secure: false,         // Allow HTTP for local networks
  maxAge: rememberMe ? 30 days : SESSION_TTL_HOURS
}
```

**Session Operations** (`apps/api/src/lib/auth/session.ts`):
```typescript
// Create session
const session = await app.sessionService.createSession(userId, rememberMe);
app.sessionService.attachCookie(reply, session.token, rememberMe);

// Invalidate
await app.sessionService.invalidateSession(token);
await app.sessionService.invalidateAllUserSessions(userId, exceptToken?);
```

### Password Authentication

**Hashing** (Argon2id):
- Memory: 19,456 KiB
- Iterations: 2
- Parallelism: 1

**Account Lockout:**
- 5 failed attempts → 15-minute lockout
- 200ms delay on failed login (timing attack mitigation)
- Reset on successful login

**Validation** (`packages/shared/src/types/password.ts`):
```typescript
export const passwordSchema = z.string()
  .min(8).max(128)
  .regex(/[a-z]/, "lowercase required")
  .regex(/[A-Z]/, "uppercase required")
  .regex(/[0-9]/, "number required")
  .regex(/[^a-zA-Z0-9]/, "special char required");
```

### OIDC Authentication

**Library**: oauth4webapi

**Flow:**
1. `POST /auth/oidc/login` → Generate state, nonce, PKCE verifier
2. Redirect to provider authorization URL
3. `GET /auth/oidc/callback` → Validate state, exchange code
4. Verify ID token nonce, get user info
5. Create/link OIDCAccount, create session

**Security:**
- PKCE (Proof Key for Code Exchange)
- State parameter (CSRF protection)
- Nonce validation (replay attack prevention)
- Subject claim consistency check

**Configuration** (`apps/api/src/routes/oidc-providers.ts`):
- Singleton pattern (only one provider)
- Client secret encrypted at rest
- Auto-generated redirect URI

### Passkey Authentication

**Library**: @simplewebauthn/server v13+

**Constraints:**
- Requires password as prerequisite
- Disabled when OIDC enabled
- Cannot delete last passkey without alternative auth

**Registration Flow:**
1. `POST /auth/passkey/register/options` → Generate challenge (5min expiry)
2. Client creates credential via WebAuthn API
3. `POST /auth/passkey/register/verify` → Verify, store credential

**Login Flow:**
1. `POST /auth/passkey/login/options` → Generate challenge + temp sessionId
2. Client authenticates via WebAuthn API
3. `POST /auth/passkey/login/verify` → Verify, validate counter, create session

**Counter Validation:**
```typescript
// Prevents replay attacks
if (credential.counter > 0 && response.counter <= credential.counter) {
  throw new Error("Counter not incremented - possible replay attack");
}
```

### Security Features

**Encryption** (`apps/api/src/lib/auth/encryption.ts`):
```typescript
// Encrypt
const { value, iv } = app.encryptor.encrypt(plaintext);
// Store both value and iv in database

// Decrypt
const plaintext = app.encryptor.decrypt({ value, iv });
```

**Auto-Generated Secrets** (`apps/api/src/lib/auth/secret-manager.ts`):
- `ENCRYPTION_KEY`: 32 bytes hex
- `SESSION_COOKIE_SECRET`: 32 bytes hex
- Persisted to `/config/secrets.json` (Docker) or `./secrets.json` (dev)

**Session Invalidation Pattern:**
```typescript
// After credential changes, invalidate other sessions
if (request.sessionToken) {
  await app.sessionService.invalidateAllUserSessions(
    request.currentUser.id,
    request.sessionToken  // Keep current session
  );
} else {
  // Fallback: invalidate all sessions
  await app.sessionService.invalidateAllUserSessions(request.currentUser.id);
}
```

---

## API Layer

### Route Structure

All routes in `apps/api/src/routes/`. Protected routes use preHandler authentication.

#### Authentication Routes (`/auth`)
| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| GET | `/auth/setup-required` | No | Check if setup needed |
| POST | `/auth/register` | No | Initial user creation |
| POST | `/auth/login` | No | Password login |
| POST | `/auth/logout` | Yes | End session |
| GET | `/auth/me` | Yes | Current user info |
| PATCH | `/auth/account` | Yes | Update username/password/TMDB key |
| DELETE | `/auth/password` | Yes | Remove password (requires OIDC) |
| DELETE | `/auth/account` | Yes | Delete account (no auth methods) |

#### OIDC Routes (`/auth/oidc`)
| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| GET | `/auth/oidc/providers` | No | Get configured provider |
| POST | `/auth/oidc/setup` | No | Configure during setup |
| POST | `/auth/oidc/login` | No | Initiate OIDC flow |
| GET | `/auth/oidc/callback` | No | Handle provider callback |

#### Passkey Routes (`/auth/passkey`)
| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| POST | `/passkey/register/options` | Yes | Generate registration challenge |
| POST | `/passkey/register/verify` | Yes | Complete registration |
| POST | `/passkey/login/options` | No | Generate auth challenge |
| POST | `/passkey/login/verify` | No | Complete authentication |
| GET | `/passkey/credentials` | Yes | List user passkeys |
| DELETE | `/passkey/credentials` | Yes | Delete passkey |
| PATCH | `/passkey/credentials` | Yes | Rename passkey |

#### Service Management (`/api/services`)
| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/services` | List all instances |
| POST | `/services` | Add instance |
| PUT | `/services/:id` | Update instance |
| DELETE | `/services/:id` | Remove instance |
| POST | `/services/test-connection` | Test before saving |
| POST | `/services/:id/test` | Test existing |

#### Dashboard (`/api/dashboard`)
| Route | Purpose | Refresh |
|-------|---------|---------|
| `/dashboard/queue` | Download queue | 30s |
| `/dashboard/history` | Download history | 60s |
| `/dashboard/calendar` | Upcoming releases | 60s |
| `/dashboard/statistics` | Aggregate stats | 120s |

#### Library (`/api/library`)
| Route | Purpose |
|-------|---------|
| `/library` | Movies/series list |
| `/library/episodes` | Series episodes |
| `/library/monitor` | Toggle monitoring |
| `/library/search` | Search for content |

#### TRaSH Guides (`/api/trash-guides`)
| Route | Purpose |
|-------|---------|
| `/trash-guides/cache` | GitHub JSON cache |
| `/trash-guides/templates` | User templates CRUD |
| `/trash-guides/sync` | Manual sync |
| `/trash-guides/deployment` | Deploy to instances |
| `/trash-guides/quality-profiles` | Profile management |
| `/trash-guides/custom-formats` | Custom format management |

#### Additional Routes
| Prefix | Purpose |
|--------|---------|
| `/api/search` | Prowlarr indexer search |
| `/api/discover` | TMDB discovery |
| `/api/hunting` | Auto-search configuration |
| `/api/backup` | Backup management |
| `/api/system` | System settings and info |
| `/api/oidc-providers` | OIDC admin config |

#### System Routes (`/api/system`)
| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/system/settings` | Get system settings (ports, listen address) |
| PUT | `/system/settings` | Update system settings |
| GET | `/system/info` | Get system info (version, database backend, runtime) |
| POST | `/system/restart` | Trigger application restart |

### Key Patterns

#### Resource Ownership (CRITICAL)
```typescript
// ✅ CORRECT: Always include userId
const instance = await app.prisma.serviceInstance.findFirst({
  where: {
    id: instanceId,
    userId: request.currentUser!.id,  // preHandler guarantees auth
  },
});

if (!instance) {
  return reply.status(404).send({ error: "Not found or access denied" });
}

// ❌ WRONG: Security vulnerability!
const instance = await app.prisma.serviceInstance.findFirst({
  where: { id: instanceId },  // Missing userId check
});
```

#### ARR Instance Fetcher
```typescript
// apps/api/src/lib/arr/arr-fetcher.ts
const fetcher = createInstanceFetcher(app, instance);
const response = await fetcher('/api/v3/movie');
const data = await response.json();
```

#### Route Protection
```typescript
// Every protected route plugin
app.addHook("preHandler", async (request, reply) => {
  if (!request.currentUser?.id) {
    return reply.status(401).send({ error: "Authentication required" });
  }
});
```

#### Validation
```typescript
const parsed = schema.safeParse(request.body);
if (!parsed.success) {
  return reply.status(400).send({
    error: "Invalid payload",
    details: parsed.error.flatten()
  });
}
```

---

## Frontend

### Route Structure

All pages in `apps/web/app/`. Protected routes require session cookie.

| Route | Auth | Purpose |
|-------|------|---------|
| `/` | - | Redirect to /dashboard or /login |
| `/login` | Public | Login page (password, OIDC, passkeys) |
| `/setup` | Public | Initial admin setup |
| `/dashboard` | Protected | Queue, statistics overview |
| `/calendar` | Protected | Release calendar |
| `/library` | Protected | Movies/series management |
| `/search` | Protected | Global indexer search |
| `/discover` | Protected | TMDB trending/popular |
| `/indexers` | Protected | Prowlarr indexer management |
| `/history` | Protected | Download history |
| `/statistics` | Protected | Detailed statistics |
| `/hunting` | Protected | Manual import hunting |
| `/settings` | Protected | User/service settings |
| `/trash-guides` | Protected | Quality profile wizard |

### Data Fetching

**Pattern**: API client → React Query hook → Component

**API Client** (`apps/web/src/lib/api-client/`):
```typescript
// base.ts - All requests use credentials: "include"
export async function apiRequest<T>(path: string, options?: RequestInit): Promise<T>

// domain-specific modules
authApi.login(username, password)
servicesApi.fetchServices()
dashboardApi.fetchMultiInstanceQueue()
```

**React Query Hooks** (`apps/web/src/hooks/api/`):
```typescript
// Pattern
export function useMultiInstanceQueue() {
  return useQuery({
    queryKey: ['dashboard', 'queue'],
    queryFn: () => dashboardApi.fetchMultiInstanceQueue(),
    refetchInterval: 30000,
  });
}
```

**Query Key Convention:**
```typescript
['services']                    // All services
['dashboard', 'queue']          // Dashboard queue
['dashboard', 'history', params] // History with filters
['current-user']                // Logged in user
['passkey-credentials']         // User passkeys
```

### API Proxy Configuration

**Next.js Rewrites** (`apps/web/next.config.mjs`):
```javascript
rewrites() {
  return [
    { source: "/api/:path*", destination: `${API_HOST}/api/:path*` },
    { source: "/auth/:path*", destination: `${API_HOST}/auth/:path*` }
  ];
}
```

**Why This Pattern:**
- Eliminates CORS issues
- Cookies forwarded automatically
- Backend port never exposed to browser
- Works in Docker without network complexity

### Middleware

**File**: `apps/web/middleware.ts`

**Purpose**: Route protection with session validation (NOT API proxying)

- Validates session tokens by calling `/auth/me` on the API
- Automatically clears invalid/stale cookies and redirects to `/login`
- Redirects unauthenticated users to `/login`
- Skips `/api/*`, `/auth/*`, static files

**Session Validation**: The middleware calls the API to verify sessions are valid, preventing issues when the database is reset or container recreated with a new volume.

---

## UI Theming System

The application uses a centralized, three-tier color system with CSS variables for instant theme switching.

### Color Hierarchy

| Layer | Purpose | Example Use |
|-------|---------|-------------|
| **Theme Colors** | User's selected accent color (10 themes) | Focus rings, selections, primary buttons |
| **Service Colors** | Fixed colors per service type | Sonarr=cyan, Radarr=orange, Prowlarr=purple |
| **Semantic Colors** | Status indicators | success=green, warning=amber, error=red |

### Key Files

| File | Purpose |
|------|---------|
| `apps/web/src/lib/theme-gradients.ts` | Central source of truth for all color constants and utilities |
| `apps/web/src/hooks/useThemeGradient.ts` | React hook for accessing theme colors in components |
| `apps/web/src/lib/theme-input-styles.ts` | Form input styling utilities |
| `apps/web/src/providers/color-theme-provider.tsx` | React context for theme state |
| `apps/web/app/globals.css` | CSS variable definitions for each theme |

### Usage Patterns

#### Theme Gradients (User's Color Preference)

Use the `useThemeGradient` hook for components that should respect the user's theme choice:

```typescript
// ✅ CORRECT: Use the hook
import { useThemeGradient } from "@/hooks/useThemeGradient";

function MyComponent() {
  const { gradient } = useThemeGradient();

  return (
    <div style={{
      borderColor: gradient.from,
      boxShadow: `0 0 0 2px ${gradient.fromLight}`,
    }}>
      Themed content
    </div>
  );
}

// ❌ WRONG: Don't use the old 2-line pattern
import { useColorTheme } from "@/providers/color-theme-provider";
import { THEME_GRADIENTS } from "@/lib/theme-gradients";
const { colorTheme } = useColorTheme();
const gradient = THEME_GRADIENTS[colorTheme]; // Deprecated pattern
```

#### Service Gradients (Sonarr/Radarr/Prowlarr)

Use `getServiceGradient()` for runtime lookups, `SERVICE_GRADIENTS` for compile-time:

```typescript
import { getServiceGradient, SERVICE_GRADIENTS } from "@/lib/theme-gradients";

// ✅ Runtime lookup (service comes from props/data)
function ServiceCard({ instance }: { instance: ServiceInstance }) {
  const gradient = getServiceGradient(instance.service);
  return <div style={{ background: gradient.from }}>...</div>;
}

// ✅ Compile-time lookup (service is hardcoded)
const sonarrGradient = SERVICE_GRADIENTS.sonarr;
```

#### Semantic Colors (Status Indicators)

Use `SEMANTIC_COLORS` for success/warning/error/info states:

```typescript
import { SEMANTIC_COLORS } from "@/lib/theme-gradients";

// Status badge
<span style={{
  backgroundColor: SEMANTIC_COLORS.success.bg,
  color: SEMANTIC_COLORS.success.text,
  borderColor: SEMANTIC_COLORS.success.border,
}}>
  Connected
</span>
```

#### Brand Colors (External Services)

Use `BRAND_COLORS` for third-party service badges (IMDB, Rotten Tomatoes, etc.):

```typescript
import { BRAND_COLORS, RATING_COLOR } from "@/lib/theme-gradients";

// IMDB badge
<span style={{
  backgroundColor: BRAND_COLORS.imdb.bg,
  borderColor: BRAND_COLORS.imdb.border,
  color: BRAND_COLORS.imdb.text,  // #f5c518
}}>
  8.5
</span>

// Star rating color (amber/gold)
<Star style={{ color: RATING_COLOR }} />  // #fbbf24
```

**Available Brand Colors:**
| Brand | Text Color | Use Case |
|-------|------------|----------|
| `BRAND_COLORS.imdb` | #f5c518 | IMDB ratings |
| `BRAND_COLORS.rottenTomatoes` | #5d8a3a | RT ratings |
| `BRAND_COLORS.tmdb` | #01d277 | TMDB badges |
| `BRAND_COLORS.trakt` | #ed1d24 | Trakt links |

#### Protocol Colors (Indexer Types)

Use `PROTOCOL_COLORS` for torrent/usenet indicators:

```typescript
import { PROTOCOL_COLORS } from "@/lib/theme-gradients";

const protocolColor = indexer.protocol === "torrent"
  ? PROTOCOL_COLORS.torrent  // Orange (#f97316)
  : PROTOCOL_COLORS.usenet;  // Cyan (#06b6d4)
```

### Gradient Type Reference

```typescript
// ThemeGradient - Full gradient with opacity variants
interface ThemeGradient {
  from: string;       // Primary color
  to: string;         // Secondary color
  glow: string;       // Shadow color (rgba)
  fromLight: string;  // 10% opacity - subtle backgrounds
  fromMedium: string; // 20% opacity - hover states
  fromMuted: string;  // 30% opacity - borders
}

// ServiceGradient - Simpler, no opacity variants
interface ServiceGradient {
  from: string;
  to: string;
  glow: string;
}
```

### Helper Functions

| Function | Purpose | Example |
|----------|---------|---------|
| `getServiceGradient(service)` | Safe runtime lookup with fallback | `getServiceGradient("sonarr")` |
| `createGradientStyle(gradient, variant)` | Complete style object | `style={createGradientStyle(gradient, "icon")}` |
| `createAccentLineStyle(gradient)` | Top accent line for cards | Common card pattern |
| `createFocusRingStyle(gradient)` | Input focus styling | Form elements |
| `createGradient(gradient, direction)` | CSS gradient string | `createGradient(gradient, "linear", 135)` |
| `createGlow(glow, intensity)` | Box-shadow string | `createGlow(gradient.glow, "medium")` |

### Style Variants for `createGradientStyle`

```typescript
createGradientStyle(gradient, "icon")   // Icon containers with glow
createGradientStyle(gradient, "button") // Primary buttons
createGradientStyle(gradient, "card")   // Subtle card backgrounds
createGradientStyle(gradient, "badge")  // Colored badges/chips
```

### Import Conventions

The codebase uses **relative imports** consistently for feature modules. Only UI base components use the `@/` alias:

```typescript
// Feature components - use relative paths
import { useThemeGradient } from "../../../hooks/useThemeGradient";

// UI components - use @/ alias
import { useThemeGradient } from "@/hooks/useThemeGradient";
```

### Critical Rules

1. **Never hardcode colors** - Always use theme system constants
2. **Use `useThemeGradient` hook** - Not the old 2-line pattern
3. **Use `getServiceGradient()` for runtime lookups** - When service type is a variable
4. **Use `SERVICE_GRADIENTS.xxx` for compile-time** - When service type is known
5. **CSS variables for instant switching** - Theme colors use `var(--theme-*)` under the hood
6. **Use Premium Components** - Prefer reusable components over custom implementations

### Premium Component Library

Located in `apps/web/src/components/layout/premium-components.tsx`. Always check here before creating custom UI elements.

| Component | Purpose | Use Case |
|-----------|---------|----------|
| `PremiumTabs` | Theme-aware tabbed navigation | Multi-tab views |
| `PremiumTable` | Styled data tables | List displays |
| `PremiumTableHeader` | Table header row | Column labels |
| `PremiumTableRow` | Table body row with hover | Data rows |
| `PremiumEmptyState` | Empty/error state display | No data scenarios |
| `PremiumProgress` | Animated progress bar | Loading states |
| `ServiceBadge` | Service type indicator | Sonarr/Radarr/Prowlarr labels |
| `StatusBadge` | Status indicator | success/warning/error/info states |
| `InstanceCard` | Full instance card | Service instance displays |
| `PremiumSection` | Page section with header | Feature sections |
| `GlassmorphicCard` | Glassmorphic container | Premium card containers |
| `FilterSelect` | Styled filter dropdown | Filter controls |
| `GradientButton` | Theme-gradient button | Primary actions |
| `PremiumSkeleton` | Loading skeleton | Loading placeholders |
| `PremiumPageLoading` | Full page loader | Page transitions |

**Usage:**
```typescript
import {
  PremiumSection,
  GlassmorphicCard,
  ServiceBadge,
  StatusBadge,
} from "@/components/layout/premium-components";
```

### Z-Index Layering System

Custom z-index scale defined in Tailwind preset. Use semantic class names instead of arbitrary values:

| Class | CSS Variable | Value | Use Case |
|-------|--------------|-------|----------|
| `z-dropdown` | `--z-dropdown` | 10 | Dropdown menus |
| `z-sticky` | `--z-sticky` | 20 | Sticky headers |
| `z-fixed` | `--z-fixed` | 30 | Fixed elements |
| `z-modal-backdrop` | `--z-modal-backdrop` | 40 | Modal overlays |
| `z-modal` | `--z-modal` | 50 | Modal dialogs |
| `z-popover` | `--z-popover` | 60 | Popovers |
| `z-toast` | `--z-toast` | 70 | Toast notifications |
| `z-tooltip` | `--z-tooltip` | 80 | Tooltips |

```typescript
// ✅ CORRECT: Use semantic z-index
<div className="z-modal">...</div>

// ❌ WRONG: Arbitrary z-index values
<div className="z-[9999]">...</div>
```

### Animation Patterns

**Staggered Entrance Animation:**
```typescript
// Common pattern for lists
{items.map((item, index) => (
  <Card
    key={item.id}
    className="animate-in fade-in slide-in-from-bottom-2 duration-300"
    style={{
      animationDelay: `${index * 30}ms`,
      animationFillMode: "backwards",
    }}
  />
))}
```

**Duration Utilities:**
| Class | Duration | Use Case |
|-------|----------|----------|
| `duration-fast` | 100ms | Micro-interactions |
| `duration-normal` | 200ms | Standard transitions (default) |
| `duration-slow` | 300ms | Animations |
| `duration-slower` | 500ms | Complex animations |

### Glassmorphic Styling Pattern

Standard pattern for glass-effect cards used throughout:

```typescript
// Glassmorphic card pattern
<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm">
  {/* Content */}
</div>

// Or use the component
import { GlassmorphicCard } from "@/components/layout/premium-components";
<GlassmorphicCard padding="md">Content</GlassmorphicCard>
```

**Key classes:**
- `backdrop-blur-sm` - Subtle blur effect
- `bg-card/30` - 30% opacity card background
- `border-border/50` - 50% opacity border
- `hover:border-border/80` - Interactive hover state

### Typography Utilities

Custom text utilities from Tailwind preset:

| Class | Font | Size | Use Case |
|-------|------|------|----------|
| `text-h1` | Display (Satoshi) | 3xl + bold | Page titles |
| `text-h2` | Display (Satoshi) | 2xl + bold | Section headers |
| `text-h3` | Display (Satoshi) | xl + semibold | Subsection headers |
| `text-h4` | Display (Satoshi) | lg + semibold | Card titles |
| `text-body` | Body (DM Sans) | base | Standard text |
| `text-small` | Body (DM Sans) | sm | Secondary text |
| `text-caption` | Body (DM Sans) | xs | Labels, captions |

---

## Features Guide

### TRaSH Guides Integration

**Purpose**: Apply TRaSH Guides quality profiles to Sonarr/Radarr instances.

**Key Files:**
- Routes: `apps/api/src/routes/trash-guides/` (13 modules)
- Frontend: `apps/web/src/features/trash-guides/`

**Workflow:**
1. Fetch TRaSH JSON from GitHub → Cache in `TrashCache`
2. Create templates from TRaSH recommendations
3. Map templates to quality profiles
4. Deploy to instances (creates backup first)

**Models:**
- `TrashTemplate` - User templates with version history
- `TrashBackup` - Pre-deployment snapshots
- `TrashSyncHistory` - Audit log

### Hunting/Auto-Search

**Purpose**: Automatically search for missing content and upgrades.

**Key Files:**
- Routes: `apps/api/src/routes/hunting/`
- Models: `HuntConfig`, `HuntLog`, `HuntSearchHistory`

**Configuration Per Instance:**
- Enable/disable missing content hunt
- Enable/disable upgrade hunt
- Batch size and interval
- Rate limiting (hourly API cap)
- Filters: monitored-only, tags, quality profiles, age threshold

### Backup System

**Purpose**: Automated database backups with retention.

**Key Files:**
- Routes: `apps/api/src/routes/backup.ts`
- Plugin: `apps/api/src/plugins/backup-scheduler.ts`
- Model: `BackupSettings` (singleton)

**Configuration:**
- Enable/disable automated backups
- Interval: HOURLY, DAILY, WEEKLY
- Retention count (auto-cleanup old backups)

---

## Development

### Setup

```bash
# Install and start
pnpm install
pnpm run dev        # API (3001) + Web (3000) in parallel

# Database
cd apps/api
pnpm run db:push      # Sync schema to database (dev - also regenerates client)
pnpm run db:sync      # Sync schema only, skip client regeneration (production)
pnpm run db:generate  # Regenerate Prisma client only

# Note: Uses 'db push' for multi-provider support (SQLite/PostgreSQL)
# No migrations - schema.prisma is the single source of truth
```

### Adding Features

**New API Route:**
1. Create `apps/api/src/routes/<domain>.ts`
2. Register in `apps/api/src/server.ts`
3. Add types to `packages/shared/src/types/<domain>.ts`
4. Add client to `apps/web/src/lib/api-client/<domain>.ts`
5. Add hook to `apps/web/src/hooks/api/use<Domain>.ts`

**New Frontend Page:**
1. Create `apps/web/app/<route>/page.tsx`
2. Add components to `apps/web/src/features/<feature>/`
3. Use hooks from `src/hooks/api/`

**Database Changes:**
```bash
cd apps/api
# Edit prisma/schema.prisma, then sync:
pnpm run db:push

# This uses 'db push' which:
# - Generates correct SQL for SQLite or PostgreSQL automatically
# - Updates the database schema to match schema.prisma
# - Regenerates the Prisma client
```

### Code Style

**Formatter**: Biome (NOT ESLint/Prettier)
```bash
pnpm run lint    # Check
pnpm run format  # Fix
```

**TypeScript**: Strict mode with `noUncheckedIndexedAccess: true`

---

## Deployment

### Docker (Single Container)

```bash
docker run -d \
  --name arr-dashboard \
  -p 3000:3000 \
  -v /path/to/config:/config \
  -e PUID=1000 \
  -e PGID=1000 \
  khak1s/arr-dashboard:latest
```

**Volume**: `/config/` contains `prod.db`, `secrets.json`

**Startup**: `docker/start-combined.sh` manages API + Web processes

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `file:/config/prod.db` | Database path |
| `API_PORT` | `3001` | API server port |
| `PORT` | `3000` | Web server port |
| `HOST` | `0.0.0.0` | Listen address |
| `PUID` | `911` | Process user ID |
| `PGID` | `911` | Process group ID |
| `SESSION_TTL_HOURS` | `24` | Session expiration |
| `SESSION_COOKIE_NAME` | `arr_session` | Cookie name |
| `ENCRYPTION_KEY` | Auto-generated | 32-byte hex |
| `SESSION_COOKIE_SECRET` | Auto-generated | 32-byte hex |
| `API_CORS_ORIGIN` | - | CORS whitelist |
| `API_RATE_LIMIT_MAX` | - | Rate limit max |
| `WEBAUTHN_RP_ID` | `localhost` | Passkey RP ID |
| `WEBAUTHN_ORIGIN` | `http://localhost:3000` | Passkey origin |

### CI/CD

**Workflow**: `.github/workflows/ci.yml`
- Lint & Type Check (all PRs)
- Docker Build (fork-safe, skips login for external PRs)

---

## Patterns & Gotchas

### Security Patterns

**Always Encrypt API Keys:**
```typescript
const { value, iv } = app.encryptor.encrypt(apiKey);
await prisma.serviceInstance.create({
  data: { encryptedApiKey: value, encryptionIv: iv, ... }
});
```

**Always Verify Ownership:**
```typescript
// Include userId in ALL queries for user-owned resources
where: { id, userId: request.currentUser!.id }
```

**Session Invalidation After Credential Changes:**
```typescript
// Password change, passkey deletion, etc.
await app.sessionService.invalidateAllUserSessions(userId, exceptToken);
```

### Common Gotchas

1. **API Proxy**: Frontend uses `/api/*` paths, NOT `localhost:3001`
2. **Middleware**: Only does route protection, NOT API proxying
3. **Server Components**: Default in Next.js, add `"use client"` when needed
4. **Query Invalidation**: Always invalidate after mutations
5. **Path Aliases**: May need relative imports in some Server Components
6. **Docker vs Dev**: Different env vars and paths

### Error Responses

```typescript
// 400 Bad Request
{ error: "Invalid payload", details: {...} }

// 401 Unauthorized
{ error: "Invalid credentials" }
{ error: "Authentication required" }

// 403 Forbidden
{ error: "Password registration is disabled" }

// 404 Not Found
{ error: "Not found or access denied" }

// 423 Locked
{ error: "Account locked. Try again in X minutes." }
```

---

## Quick Reference

### File Locations

| Purpose | Path |
|---------|------|
| API entry | `apps/api/src/index.ts` |
| API server | `apps/api/src/server.ts` |
| API routes | `apps/api/src/routes/*.ts` |
| Auth library | `apps/api/src/lib/auth/` |
| ARR fetcher | `apps/api/src/lib/arr/arr-fetcher.ts` |
| Prisma schema | `apps/api/prisma/schema.prisma` |
| Frontend pages | `apps/web/app/**/page.tsx` |
| Frontend features | `apps/web/src/features/` |
| API hooks | `apps/web/src/hooks/api/` |
| API client | `apps/web/src/lib/api-client/` |
| **Theme system** | `apps/web/src/lib/theme-gradients.ts` |
| **Theme hook** | `apps/web/src/hooks/useThemeGradient.ts` |
| **Input styles** | `apps/web/src/lib/theme-input-styles.ts` |
| **Premium components** | `apps/web/src/components/layout/premium-components.tsx` |
| **Tailwind preset** | `apps/web/src/styles/tokens/tailwind-preset.ts` |
| Shared types | `packages/shared/src/types/` |
| Docker startup | `docker/start-combined.sh` |

### npm Scripts

```bash
# Root (Turbo)
pnpm run dev      # Start all
pnpm run build    # Build all
pnpm run lint     # Lint all
pnpm run test     # Test all

# API
pnpm --filter @arr/api run db:push    # Sync schema to database
pnpm --filter @arr/api run db:generate # Regenerate Prisma client
pnpm --filter @arr/api run reset-admin-password

# Web
pnpm --filter @arr/web run build
```

### Request Decorations

```typescript
request.currentUser   // User object (if authenticated)
request.sessionToken  // Session token string
app.prisma            // Prisma client
app.encryptor         // AES-256-GCM encryption
app.sessionService    // Session management
app.config            // Environment config
```

---

**Last Updated:** 2026-02-04
**Version:** 2.7.3
**Node:** 22+
**pnpm:** 10+
