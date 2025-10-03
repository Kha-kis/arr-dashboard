# Repository Map

## Overview
- **Total Source Files**: 71 (TypeScript/TSX)
- **Monorepo Structure**: Turborepo with 2 apps
- **Features**: 13 feature modules
- **Largest File**: 1348 lines (apps/api/src/routes/search.ts)

## Entry Points

### Web App (apps/web)
- **App Router Pages** (13 routes):
  - `/` - apps/web/app/page.tsx (root redirect)
  - `/dashboard` - apps/web/app/dashboard/page.tsx
  - `/settings` - apps/web/app/settings/page.tsx
  - `/history` - apps/web/app/history/page.tsx
  - `/calendar` - apps/web/app/calendar/page.tsx
  - `/statistics` - apps/web/app/statistics/page.tsx
  - `/search` - apps/web/app/search/page.tsx
  - `/indexers` - apps/web/app/indexers/page.tsx
  - `/login` - apps/web/app/login/page.tsx
  - `/discover` - apps/web/app/discover/page.tsx
  - `/library` - apps/web/app/library/page.tsx
  - `/setup` - apps/web/app/setup/page.tsx
  - `/_not-found` - auto-generated

### API App (apps/api)
- **Entry**: apps/api/src/index.ts
- **Server**: apps/api/src/server.ts
- **Routes** (10 endpoints):
  - `/health` - apps/api/src/routes/health.ts
  - `/auth` - apps/api/src/routes/auth.ts
  - `/services` - apps/api/src/routes/services.ts
  - `/dashboard` - apps/api/src/routes/dashboard.ts
  - `/dashboard/statistics` - apps/api/src/routes/dashboard-statistics.ts
  - `/discover` - apps/api/src/routes/discover.ts
  - `/search` - apps/api/src/routes/search.ts
  - `/library` - apps/api/src/routes/library.ts
  - `/manual-import` - apps/api/src/routes/manual-import.ts

## Feature Modules (apps/web/src/features)

1. **auth** - Authentication & login
   - components/login-form.tsx

2. **calendar** - Calendar view for releases
   - components/calendar-client.tsx (550 lines)
   - components/calendar-grid.tsx

3. **dashboard** - Main dashboard with queue
   - components/dashboard-client.tsx (429 lines)
   - components/queue-table.tsx (860 lines) ⚠️
   - components/queue-progress.tsx
   - components/queue-issue-badge.tsx
   - components/queue-action-buttons.tsx

4. **discover** - Discover new content
   - components/discover-client.tsx
   - components/add-to-library-dialog.tsx (433 lines)

5. **history** - Download history
   - components/history-client.tsx (505 lines)
   - components/history-table.tsx

6. **indexers** - Indexer management
   - components/indexers-client.tsx (674 lines)

7. **library** - Library management
   - components/library-client.tsx (967 lines) ⚠️

8. **manual-import** - Manual import workflow
   - components/manual-import-modal.tsx (573 lines)
   - store.ts (Zustand store)
   - types.ts
   - helpers.ts

9. **search** - Search functionality
   - components/search-client.tsx (726 lines)
   - components/search-results-table.tsx

10. **settings** - Settings & configuration
    - components/settings-client.tsx (953 lines) ⚠️

11. **setup** - Initial setup wizard
    - components/setup-client.tsx

12. **statistics** - Statistics dashboard
    - components/statistics-client.tsx (490 lines)

⚠️ = Files over 700 lines (complexity hotspot)

## Shared Infrastructure

### API Clients (apps/web/src/lib/api-client)
- **base.ts** - Base API request wrapper, UnauthorizedError
- **auth.ts** - Login, logout, user management
- **services.ts** - Service instance CRUD
- **tags.ts** - Tag management
- **dashboard.ts** - Queue, history, calendar, statistics
- **discover.ts** - Discover endpoints
- **search.ts** - Search endpoints
- **library.ts** - Library management

### Hooks (apps/web/src/hooks/api)
- **useAuth.ts** - Auth hooks (login, logout, currentUser, setup)
- **useServicesQuery.ts** - Services query
- **useServiceMutations.ts** - Services mutations
- **useTags.ts** - Tags CRUD
- **useDashboard.ts** - Dashboard data (queue, history, calendar, stats)
- **useQueueActions.ts** - Queue actions (348 lines)
- **useDiscover.ts** - Discover hooks
- **useSearch.ts** - Search hooks
- **useLibrary.ts** - Library hooks
- **useManualImport.ts** - Manual import hooks

### Components

#### Layout (apps/web/src/components/layout)
- **layout-wrapper.tsx** - Main layout shell
- **sidebar.tsx** - Navigation sidebar
- **topbar.tsx** - Top navigation bar

#### Auth (apps/web/src/components/auth)
- **auth-gate.tsx** - Auth guard component

#### UI Primitives (apps/web/src/components/ui)
- **button.tsx** - Button component
- **card.tsx** - Card components
- **input.tsx** - Input component

### Utilities
- **apps/web/src/lib/utils.ts** - Shared utilities (cn, etc.)
- **apps/web/src/providers/root-providers.tsx** - React Query + Theme providers

## API Infrastructure (apps/api/src)

### Config
- **config/env.ts** - Environment configuration

### Plugins (Fastify)
- **plugins/security.ts** - Security middleware
- **plugins/prisma.ts** - Prisma plugin

### Utilities
- **utils/encryption.ts** - Encryption utilities
- **utils/password.ts** - Password hashing
- **utils/session.ts** - Session management
- **utils/arr-fetcher.ts** - Arr service HTTP client
- **utils/values.ts** - Value normalization helpers

### Route Utilities
- **routes/manual-import-utils.ts** - Manual import helpers (432 lines)

## High Fan-In Modules (Heavily Imported)

1. **apps/web/src/lib/utils.ts** - Imported by all UI components
2. **apps/web/src/lib/api-client/base.ts** - Imported by all API clients
3. **apps/web/src/components/ui/button.tsx** - Used across all features
4. **apps/web/src/components/ui/card.tsx** - Used across all features
5. **apps/web/src/components/ui/input.tsx** - Used across all features
6. **@arr/shared** package - Imported by 30+ files for types

## High Fan-Out Modules (Import Many)

1. **apps/web/src/features/settings/components/settings-client.tsx** - 15+ imports
2. **apps/web/src/features/library/components/library-client.tsx** - 12+ imports
3. **apps/web/src/features/dashboard/components/queue-table.tsx** - 10+ imports

## Dependency Patterns

### Web → API Flow
```
Page Component (app/*.tsx)
  ↓
Feature Client (features/*/components/*-client.tsx)
  ↓
Hooks (hooks/api/use*.ts)
  ↓
API Clients (lib/api-client/*.ts)
  ↓
Base API Request (lib/api-client/base.ts)
  ↓
API Server
```

### State Management
- **React Query** - Server state (all data fetching)
- **Zustand** - Local state (manual-import feature only)
- **No global app state** - Features are isolated

## Module Boundaries

### Current Structure ✓
- Features are isolated in separate folders
- API clients are modular by domain
- Hooks follow single-responsibility pattern
- UI components are shared primitives

### Missing Boundaries ⚠️
- No index.ts barrel exports for features (deep imports everywhere)
- Utils are catch-all modules (need domain grouping)
- Some features mix concerns (e.g., settings manages services + tags + user)
