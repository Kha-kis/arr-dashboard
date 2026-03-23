# API Routes Reference

> Reference documentation extracted from CLAUDE.md for detailed deep dives into the API route structure.

All routes in `apps/api/src/routes/`. Protected routes use preHandler authentication.

## Authentication Routes (`/auth`)

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

## OIDC Routes (`/auth/oidc`)

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| GET | `/auth/oidc/providers` | No | Get configured provider |
| POST | `/auth/oidc/setup` | No | Configure during setup |
| POST | `/auth/oidc/login` | No | Initiate OIDC flow |
| GET | `/auth/oidc/callback` | No | Handle provider callback |

## Passkey Routes (`/auth/passkey`)

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| POST | `/passkey/register/options` | Yes | Generate registration challenge |
| POST | `/passkey/register/verify` | Yes | Complete registration |
| POST | `/passkey/login/options` | No | Generate auth challenge |
| POST | `/passkey/login/verify` | No | Complete authentication |
| GET | `/passkey/credentials` | Yes | List user passkeys |
| DELETE | `/passkey/credentials` | Yes | Delete passkey |
| PATCH | `/passkey/credentials` | Yes | Rename passkey |

## Service Management (`/api/services`)

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/services` | List all instances |
| POST | `/services` | Add instance |
| PUT | `/services/:id` | Update instance |
| DELETE | `/services/:id` | Remove instance |
| POST | `/services/test-connection` | Test before saving |
| POST | `/services/:id/test` | Test existing |

## Dashboard (`/api/dashboard`)

| Route | Purpose | Refresh |
|-------|---------|---------|
| `/dashboard/queue` | Download queue | 30s |
| `/dashboard/history` | Download history | 60s |
| `/dashboard/calendar` | Upcoming releases | 60s |
| `/dashboard/statistics` | Aggregate stats | 120s |

## Library (`/api/library`)

| Route | Purpose |
|-------|---------|
| `/library` | Movies/series list |
| `/library/episodes` | Series episodes |
| `/library/monitor` | Toggle monitoring |
| `/library/search` | Search for content |

## TRaSH Guides (`/api/trash-guides`)

| Route | Purpose |
|-------|---------|
| `/trash-guides/cache` | GitHub JSON cache |
| `/trash-guides/templates` | User templates CRUD |
| `/trash-guides/sync` | Manual sync |
| `/trash-guides/deployment` | Deploy to instances |
| `/trash-guides/quality-profiles` | Profile management |
| `/trash-guides/custom-formats` | Custom format management |

## Additional Routes

| Prefix | Purpose |
|--------|---------|
| `/api/search` | Prowlarr indexer search |
| `/api/discover` | TMDB discovery |
| `/api/hunting` | Auto-search configuration |
| `/api/backup` | Backup management |
| `/api/system` | System settings and info |
| `/api/oidc-providers` | OIDC admin config |
| `/api/library-cleanup` | Cleanup rules, approvals, execution |
| `/api/notifications` | Channels, subscriptions, delivery |
| `/api/plex` | Now playing, on-deck, watch history, analytics |
| `/api/tautulli` | Activity, watch history enrichment |
| `/api/seerr` | Jellyseerr/Overseerr request management |
| `/api/validation` | Runtime validation health and drift |

## System Routes (`/api/system`)

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/system/settings` | Get system settings (ports, listen address) |
| PUT | `/system/settings` | Update system settings |
| GET | `/system/info` | Get system info (version, database backend, runtime) |
| POST | `/system/restart` | Trigger application restart |
