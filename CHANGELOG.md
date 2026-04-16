# Changelog

All notable changes to Arr Dashboard will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.16.1] - 2026-04-16

**Patch release — reverse-proxy link correctness and calendar layout stability.**

Two user-facing bug fixes on top of 2.16.0. No new features, no schema/API breaking changes — both fixes are transparent to existing installs.

### Fixed

- **Calendar narrows on month navigation** — `PageLayout`'s `<main>` was collapsing to its intrinsic content width because `mx-auto` cancels the default `align-items: stretch` when the parent is `flex flex-col`. When a month's content (loading skeleton, dense event chips, sparse weeks) had a different intrinsic width than the previous month, `main` resized and the calendar appeared to grow or shrink between clicks. Pinning `main` to `w-full` keeps it at parent width regardless of content — the grid, filters, and navigation controls now stay anchored across months. Completes the fix for #272 (the earlier #279 addressed only the vertical 6-week grid; this one was the missed horizontal axis).
- **Instance deep links now prefer `externalUrl` everywhere** — Statistics → Overview → Health Issues "View" link, plus the Calendar event card, History row, and Library card "open in Sonarr/Radarr/etc." links were building hrefs from `baseUrl` — the internal container URL that isn't reachable when the instance sits behind a reverse proxy. All four sites now use `instance.externalUrl ?? instance.baseUrl`, matching the pattern introduced for the dashboard Active Queue in #306. To make this bug harder to reintroduce, `HealthIssue` records now carry `instanceExternalUrl` end-to-end from the API down to the render site, so any future consumer inherits correct URL resolution without a frontend service lookup. Closes #354.

## [2.16.0] - 2026-04-15

**From monitoring to guided action.** This release turns the attention surface — System Pulse and the new dashboard Needs Attention panel — from a *report* of what's wrong into a place where operators can *fix* the problem in one click. Pulse / Needs Attention is now the canonical issue surface: pre-existing banners that duplicated its signals have been removed, misleading diagnostic copy has been reworded to defer to Pulse as the single source of truth, and three safe actions — Enable a disabled scheduler, Refresh a stale cache, Retry a failed queue item — land inline on their respective rows.

Scope was deliberately limited to **safe, idempotent, easily-reversible** operations. Destructive actions (remove, blocklist), automation/rules engines, and bulk/batch flows are explicitly deferred to future releases; this release establishes the pattern and trust foundation those later surfaces will build on.

### Added

#### Dashboard & Needs Attention
- **Needs Attention panel** — New curated subset of `/pulse` on the dashboard, showing the top 10 actionable warning/critical items with stable deep-links to the full Pulse feed. The same row renderer is reused on both surfaces so operators see one consistent presentation (#335)
- **Dashboard as the primary Overview item** — The sidebar navigation now treats Dashboard as the default Overview landing page, with a pinned root-route test to prevent regression (#337)
- **Scheduler items route to `/pulse`** — Needs Attention rows that surface disabled/failing schedulers deep-link into the full Pulse feed with hash-scroll + highlight, so operators land directly on the row rather than at the top of an unfiltered list (#336)

#### System Pulse
- **Media-server reachability collector** — New `collectMediaServerReachability` emits critical `plex-unreachable-<id>` / `jellyfin-unreachable-<id>` / `tautulli-unreachable-<id>` rows on a cheap identity ping failure, mirroring the existing `arr-unreachable-*` pattern. Closes the gap where an unreachable media server was only surfacing as a misleading "cache refresh error" banner (#346)

#### Operator Actions (Actionability V1 + V1.1)
- **Pulse action envelope + dispatcher** — New optional `action` field on Pulse items carries a discriminated-union payload (`kind: "scheduler.enable" | "cache.refresh" | "queue.retry"`); new `POST /api/pulse/:id/action` route dispatches to existing service calls. No new backend capability is introduced — every action reuses the plumbing that already powered Settings-page manual triggers (#340)
- **`scheduler.enable`** — Inline "Enable" button on disabled hunting and queue-cleaner scheduler rows. One click re-enables the scheduler; the row drops on the next Pulse poll (#341, #343)
- **`cache.refresh`** — Inline "Refresh now" button on stale Plex and Tautulli cache rows. Fires the refresh in the background and returns immediately so slow library refreshes don't trip the HTTP proxy timeout (#342, #343, #345)
- **`queue.retry`** — Inline "Retry" button on failed or stuck ARR queue items (Sonarr / Radarr / Lidarr / Readarr). Reuses the exact SDK call the dashboard queue page already uses, with tight classification (only ARR-reported failures, never speculative), per-instance fan-out cap of 10 rows plus a no-action rollup row for overflow, and sort deprioritization so a bad download-client day can't drown out scheduler/ARR system warnings (#344)

### Changed

#### Trust & Reliability
- **Source-of-truth write-through after every action** — Actions now explicitly update the state collectors read from (`schedulerRegistry.markEnabled`, `CacheRefreshStatus.lastRefreshedAt` upsert), so the "click action → row drops on next poll" contract holds end-to-end (#343)
- **Rate limit on the action route** — `POST /api/pulse/:id/action` is rate-limited at 10/min to guard against runaway clicks or misbehaving scripts hammering upstream Plex/Tautulli (#343)
- **Fire-and-forget `cache.refresh`** — The dispatcher no longer waits for the (potentially 30–60 second) upstream refresh before returning 200, avoiding false "Internal Server Error" toasts when Next.js's proxy timeout trips before the backend finishes. Ownership checks remain synchronous; errors during the background refresh do NOT bump `lastRefreshedAt`, so a failing refresh correctly keeps surfacing (#345)
- **Incognito-safe error toasts** — `usePulseActionMutation` now routes toast error text through the same anonymization helper that Pulse rows use, stripping hostnames, URLs, and IPs before display. Normal-mode output is byte-identical; generic messages ("Rate limit exceeded", "Internal Server Error", "Bad Request") pass through unchanged (#349)
- **Tightened Pulse action labels** — Scheduler-health rows deep-link to `/pulse` with hash anchors rather than generic `/settings`, so the follow-through lands operators on the specific row (#338, #339)

### Removed

#### UX / Cleanup
- **`CacheHealthBanner` removed** — The pre-Pulse dashboard cache-refresh banner duplicated signals Pulse already covers with better severity and actionable deep links. Removed in favor of the canonical attention surface (#346)
- **`CleanupHealthBanner` removed** — Same pattern as `CacheHealthBanner`: the library-cleanup page banner's three signals (scheduler enabled, last-run error, prefetch source health) are all now covered by Pulse collectors. Removed; the one deliberate sensitivity change — Pulse waits for two consecutive failures vs the banner's one — is the correct attention-surface bias and is documented in the PR (#351)
- **Tautological `/pulse` self-links suppressed** — Scheduler-health rows emit `actionUrl: "/pulse#<id>"` so operators deep-link from the dashboard Needs Attention panel; on the `/pulse` page itself, that link just scrolls to the already-visible row and has been suppressed. `/settings`, `/statistics`, `/dashboard` and other cross-page links render unchanged (#347)
- **Unused `confirmLabel` field dropped from the Pulse action envelope** — Originally added as forward-fitting for a possible destructive-action two-tap confirm UX that didn't ship in V1. Audit confirmed zero production consumers. Removed; a future destructive variant can add a kind-specific confirm field with the right scope (#348)
- **Speculative diagnostic copy reworded** — `season-episode-list.tsx` no longer says "may be unreachable" (the component can't know why a fetch failed); `DomainStatusBadge` tooltips for `degraded` and `offline` states now explicitly frame the badge as a last-check snapshot and defer live health to Pulse. Regression guards pin the framing against future drift (#352)

### Deferred (explicit non-scope)

- **No destructive actions.** `queue.remove`, blocklist, and other one-way operations are not in V1. When they arrive they'll use a two-tap confirm UX; the envelope schema is ready for that extension
- **No automation / rules engine.** Every action is a deliberate operator click; nothing retries or remediates on its own
- **No bulk or batch actions.** One row, one click, one action. The `queue.retry` rollup row (+N more) intentionally carries no action — operators handle overflow by navigating to the queue page
- **Scheduler manual-vs-system distinction is not yet modeled.** Today every `markDisabled` call site is a system/init-failure path, so every disabled-scheduler Pulse row is safely re-enableable. If a future code path introduces an intentional-opt-out manual disable, the `scheduler.enable` gate needs to learn the distinction; the collector comment flags this for the implementer who adds it
- **Queue fan-out is intentionally capped at 10 per instance.** Instances with more failed items emit a no-action rollup row pointing at the queue page rather than flooding Needs Attention. Bulk retry UX is explicitly deferred

## [2.15.0] - 2026-04-14

Operability and trust release — a scheduler jobs surface for operators, a Security Posture diagnostic panel, route surface governance, shared UX primitives for consistent trust signals across panels, and targeted cache-refresh hardening for Plex and Tautulli. No new end-user feature modules; every change is aimed at making the existing app more legible, more trustworthy, and easier to ship.

### Added

#### Reliability & Observability
- **Scheduler jobs surface** — New `SchedulerRegistry` centralizes every background job (session snapshot, Plex/Tautulli/Jellyfin cache refresh, hunt, cleaner, TRaSH sync, backups, notifications, etc.) behind a single `/api/system/jobs` operability surface. Operators can inspect last run, next run, last error, and failure isolation per job (#294, #295)
- **Explicit scheduler init failure-handling policy** — New `runSchedulerInit` helper makes scheduler startup failures a deliberate, testable decision per job rather than silent boot-time drift. Pinned by tests that lock the init-failure operator surface (#319)
- **Session-snapshot tick isolation** — A failure in one snapshot collector no longer short-circuits the remaining collectors in the same tick (#303)
- **Integration test coverage** — Risk-based integration tests cover auth, services, scheduler, queue cleaner, and route auth / service lifecycle gaps — reducing the chance a regression in these critical paths ships unnoticed (#315, #316)

#### Security & Trust
- **Security Posture panel** — New diagnostic surface under System → Security Posture flags configuration that weakens the deployment (missing `SESSION_COOKIE_SECRET`, weak `ENCRYPTION_KEY`, lax cookie flags, etc.). Advisory only; nothing is auto-changed. Distinguishes true misconfiguration from opinionated hardening to avoid false alarms (#317)
- **Route surface governance** — Lightweight manifest-driven tier system (`stable` / `operator` / `internal` / `experimental`) classifies every backend route and is enforced in tests. Documented in ADR-0004 (#320)

#### UX Consistency
- **Shared async state presentation** — New `AsyncStateView` primitive standardizes loading / error / empty states across data panels so operators see the same shapes and wording for the same states everywhere (#321, #326)
- **Domain status badges** — Shared `DomainStatusBadge` + 5-state taxonomy (healthy / degraded / offline / configured / disabled) replaces ad-hoc badge variants across Services and Integrations (#324)
- **Data freshness indicator** — Shared `<DataFreshness>` + `describeFreshness()` wired into Pulse, Queue Cleaner, and Validation Health, driven by a scoped ticker so every polling panel reports age consistently (#325)

#### Contributor Experience
- **Domain operating manuals + ADRs** — New per-domain operating manuals plus ADRs covering security posture and route auth, giving contributors and operators a durable reference beyond code comments (#318)

### Fixed

#### Cache Refresh Hardening
- **Plex stale-cache eviction hits Prisma parameter limit** — Bulk stale-cache evictions are now chunked, eliminating sporadic SQLite `P2029` "too many bind variables" failures on larger libraries (#323, #328)
- **Tautulli stale-cache eviction hits Prisma parameter limit** — Same chunking fix applied to the Tautulli eviction path (#329)

#### Pulse Trust
- **Truthful empty state on refresh error** — Pulse no longer shows a misleadingly-clean "all healthy" view after a failed refresh; collector errors now produce a stable, visible failure state with consistent collector-error IDs (#330)
- **Truthful errors + domain-correct tooltips** — Trust surfaces (Pulse, Validation Health, Rules) now surface real error text instead of generic placeholders, and tooltips describe the domain rather than the underlying transport (#327)

#### Service Integrations
- **Lidarr falsely reported unreachable in System Pulse** — Reachability probe now matches Lidarr's response shape (#300, #307)
- **Seerr notification agent types** — Default to `0` when absent rather than erroring out on the requests page (#309)
- **Tautulli activity fields** — Default to empty values when absent rather than breaking the activity view (#302, #310)
- **Jellyfin/Emby partial-watch enrichment** — Populate `lastWatchedAt` for partially-watched series instead of leaving the field null (#311)
- **Jellyfin cleanup rule copy** — Corrected rule description and backfilled the missing Jellyfin test (#314)
- **Queue instance links use `externalUrl`** — Queue item links now respect the configured external URL per instance (#297, #306)
- **Service type buttons overflow in narrow panels** — Settings service-type selector now wraps cleanly in narrow layouts (#291, #305)

### Changed

#### Architecture
- **Plugin/route registration extracted into domain bundles** — `server.ts` now composes domain bundles rather than inlining every `register()` call, making the startup surface easier to audit and extend (#293)
- **Library watch enrichment extended to Jellyfin/Emby** — Watch state enrichment (now-playing, last-watched, episode completion) parity across Plex / Jellyfin / Emby (#304)

#### Tooling
- **pnpm 10.33.0** — Bumped and guarded `action-setup` major bumps in CI (#312)
- **Dependency updates** — Production-dependencies group (17 updates, #298) and dev-dependencies group (3 updates, #299), plus a follow-up production group bump (#313)

## [2.14.0] - 2026-04-09

Media server expansion and setup experience overhaul — full Jellyfin and Emby support with Plex feature parity, OAuth-assisted setup for Plex and Seerr, notification quiet hours, TRaSH Custom Format conflict detection, and a host of UX refinements.

### Added

#### Media Server Expansion
- **Jellyfin support** — Full media server integration with Plex feature parity: now playing, watch history, on-deck, recently added, user/device/codec/transcode/bandwidth analytics, quality score, bandwidth forecast, episode completion, and watch-aware library cleanup. No separate Tautulli-equivalent required — analytics are sourced directly from Jellyfin's API. 7 cleanup rule evaluators expose watch count, last watched, on-deck, user rating, watched-by, added-at, and episode completion (#274)
- **Emby support** — Emby is supported through a unified Jellyfin/Emby backend (they descend from the same codebase). All Jellyfin capabilities work identically for Emby, and multi-instance aggregates combine data across Jellyfin and Emby instances (#277)

#### OAuth-Assisted Setup
- **Plex OAuth** — New **Connect with Plex** button in the service form triggers a plex.tv PIN flow that discovers your reachable Plex servers with per-connection reachability badges (Local/Remote/Relay, SSL indicator, Recommended label). The best reachable connection auto-fills the URL and token fields. Works in both add and edit modes; manual entry remains available as a fallback (#264)
- **Seerr auto-setup via Plex sign-in** — New **Sign in to Seerr with Plex** button authenticates to your Seerr instance using your Plex token and auto-fetches the Seerr API key from the admin settings endpoint. Requires admin access on the Seerr instance and Plex login enabled; falls back to specific error messages if requirements aren't met (#265)

#### Setup UX
- **Getting Started banner** — When fewer than three services are configured, the Services page shows a guided banner listing recommended services (Plex, Sonarr, Radarr, Seerr, Tautulli, Jellyfin, Emby, Prowlarr) with descriptions and **Auto-setup** badges for services with OAuth helpers. Clicking a recommendation jumps straight into the add-instance form with the service type pre-selected (#266)
- **URL suggestions** — After you add one service, the form offers companion-service URL suggestions derived from existing service hosts (e.g., if Plex is at `192.168.1.100:32400`, the form suggests `:5055` for Seerr, `:8181` for Tautulli, `:8989` for Sonarr, etc.). Incognito-aware — URLs are anonymized in incognito mode (#266)
- **Connection test feedback** — Successful connection tests display the detected service version as a badge; failures show specific error messages with troubleshooting hints (authentication proxy detection, endpoint-not-found, invalid response format) (#266)

#### TRaSH Guides
- **Custom Format conflict detection** — Deployment previews now cross-reference selected custom formats against the upstream TRaSH `conflicts.json` registry and display advisory warnings when mutually exclusive CFs would be deployed together. Warnings are informational only — deployment is not blocked (#286)
- **Quality size preset upstream update warnings** — Previewing a previously-applied quality size preset now compares a SHA-256 hash of the current upstream data against the hash recorded at your last apply. If they differ, a banner surfaces: "This preset has been updated since you last applied it" — letting you stay aligned with upstream changes without surprise (#267)

#### Notifications
- **Quiet hours** — New notification rule action type that defers non-critical notifications during a configurable time window (HH:MM, IANA timezone, overnight ranges supported). Critical events — `SYSTEM_ERROR`, `ACCOUNT_LOCKED`, `LOGIN_FAILED`, `SERVICE_CONNECTION_FAILED`, `BACKUP_FAILED` — always bypass the window. Deferred notifications are flushed in arrival order when the window ends. Fails closed on malformed config (#267)

#### UI & UX
- **Week Starts On setting** — Settings → Appearance now offers a Sunday/Monday toggle for the calendar grid's first column. Stored per-browser in local storage (#281)
- **Collapsible sidebar groups** — Sidebar navigation is reorganized into four collapsible groups (Overview, Media, Maintenance, Configuration). Collapse state persists across sessions and the group containing the active page auto-expands on navigation. Accessible: `aria-expanded` headers, `aria-current="page"`, keyboard-navigable (#270, #283)

### Fixed
- **Rootless container startup** — The container now supports `--user UID:GID` / `user: "UID:GID"` in Compose for rootless deployments. Startup gracefully skips permission setup when the process cannot chown, dropping straight into application start (#282)
- **Mobile responsive settings** — Settings page and service forms now lay out correctly on small screens; previously, the forms overflowed viewport width on mobile (#268)
- **Calendar layout shift** — Navigating between months no longer causes content reflow/layout shift in the grid view (#279)

### Changed
- **PUID/PGID docs** — Updated PUID/PGID usage guidance to clarify when to use the default PUID/PGID convention vs the new rootless `--user` flag. Warns against combining `--user` with PUID/PGID, which produces conflicting instructions (#278)
- **Production dependencies** — 10 dependency updates across the production-dependencies group (#275)
- **Dev dependencies** — 2 dependency updates across the dev-dependencies group (#276)

### Security
- **Input validation hardening** — Tightened input validation at challenge store boundaries, hardened SQL construction paths, and addressed findings from a targeted auth audit (#285)
- **defu & vite vulnerabilities** — Patched transitive vulnerabilities in `defu` and `vite` via `pnpm.overrides` (#284)
- **hono, nodemailer, prisma bumps** — Patched 7 open Dependabot alerts by raising transitive floors (`hono` 4.12.11 → 4.12.12, `@hono/node-server` 1.19.11 → 1.19.13) and bumping direct deps (`nodemailer` 8.0.4 → 8.0.5, `prisma` / `@prisma/client` / adapters 7.6.0 → 7.7.0). `hono` is transitive via `@prisma/dev` dev tooling and not reachable in production (#288)

## [2.13.0] - 2026-03-31

Codebase hardening release — lint infrastructure overhaul, frontend type safety, security audit, dependency modernization, and CI optimization. No new features; focused on reliability, maintainability, and developer experience.

### Changed

#### Codebase Quality
- **Biome config audit** — Updated schema to v2.4.10, added `noConsole` rule, removed stale exclusions. Test files now linted (77 previously invisible). Production code: 76 → 0 Biome warnings (#251)
- **Frontend type safety** — Fixed 140 → 5 `no-explicit-any` ESLint warnings across 24 files. New wizard type system (`WizardCustomFormat`, `WizardCFGroup`, etc.) properly types TRaSH Guides data flowing through the quality profile wizard (#253)
- **Dead code removal** — Removed 21 unused files (~3,300 lines), 6 unused dependencies, 5 empty barrel files, ~60 unused exports. Added Knip to CI for regression prevention (#251, #252)
- **Circular dependencies** — Fixed all 4 real circular dependency cycles (1 API, 3 web) by extracting shared types (#252)

#### Dependencies
- **TypeScript** 5.9.3 → 6.0.2 — Last JS-based compiler before Go rewrite. Migrated tsconfig: removed deprecated `baseUrl`, converted to relative paths (#256)
- **ESLint** 9.39.4 → 10.1.0 — Modern engine with JSX scope analysis (#256)
- **lucide-react** 0.577.0 → 1.7.0 — `aria-hidden` default on icons for better accessibility (#256)
- **jsdom** 27.4.0 → 29.0.1 — Spec-compliant CSSOM for more accurate test environment (#256)

#### CI/CD
- **E2E production builds** — Switched from dev mode to production builds for E2E tests. Eliminates timeout flake: slowest shard 15m19s → 4m35s (-70%), wall clock 15m19s → 6m25s (-58%) (#257)
- **Knip dead code check** — Added to CI pipeline for automated dead code detection (#252)

#### Repository Structure
- **Screenshots reorganized** — Moved 16 PNGs from root to `docs/screenshots/`, refreshed with incognito mode enabled (#258, #262)
- **Stale files removed** — Deleted completed review docs, one-time migration scripts, Unraid template (now on addon store) (#258)
- **Documentation updated** — Rewrote `docker/README.md` with complete env vars table, corrected `docs/AUTH.md`, added missing routes to `docs/API-ROUTES.md` (#258)
- **GitHub best practices** — Added `SECURITY.md`, `CONTRIBUTING.md`, `.gitattributes`, `.editorconfig`, issue template config (#258)

### Fixed
- **Discover incognito mode** — Poster images, titles, and overview text now properly anonymized when incognito mode is enabled (#260)
- **Calendar incognito mode** — Grid event chips now show anonymized titles; network/studio name hidden from detail card (#262)
- **System settings incognito** — Database host, listen address, and log file names now masked in incognito mode (#260)
- **Discover genre scrollbar** — Scrollbar no longer overlaps genre pill content on the `/discover` page (#254)
- **Queue cleaner incognito** — Added missing incognito mode to queue cleaner statistics and preview displays (#250)

### Security
- **Passkey validation** — Replaced `z.any()` with proper WebAuthn Zod schema for passkey registration/login. Malformed payloads now rejected at the validation gate before reaching `@simplewebauthn/server` (#255)
- **OIDC error sanitization** — Reflected `error`/`error_description` from identity providers now truncated and stripped of control characters (#255)
- **OIDC state exhaustion** — In-memory state map capped at 1,000 entries with oldest-entry eviction (#255)
- **CSP hardening** — `connect-src` now dynamic (localhost in dev, `'self'` in production). Removed `unsafe-eval` from production `script-src` (#255)
- **ESLint `no-console`** — Added to web package with `allow: ["warn", "error"]` to catch stray debug logging (#251)

## [2.12.0] - 2026-03-30

Seerr Requests Experience, API stability improvements, and full security sweep.

### Added

#### Seerr Requests Experience
- **Request lifecycle visibility** — Timeline view showing the full journey of each request from creation through approval to availability. Requester popover with user details. Deep-linking to individual requests via query params (#225)
- **Requests UX improvements** — Lifecycle visibility, accessibility enhancements, and queue preview for the Seerr requests page (#229)
- **Dashboard Seerr widget upgrade** — Inline pending request display with one-click approve directly from the dashboard (#236)
- **"Needs Attention" signal** — Seerr dashboard widget now highlights items that need manual action (#237)

#### Library Cleanup
- **Cross-service cleanup rule templates** — Pre-built templates for common cleanup scenarios across Sonarr, Radarr, Plex, and Tautulli (#221)
- **Requester evaluators** — Cleanup rules can now evaluate Seerr requester data. New Discover request options for rule authoring (#223)

### Fixed
- **API heap out-of-memory crash** — Four cache schedulers (Plex, Tautulli, episode, session-snapshot) all fired within 30 seconds of startup. With many service instances, overlapping memory peaks exceeded the 512MB heap limit. Staggered startup delays (30s/2min/5min), paginated session snapshot platform cache, released Plex refresher intermediates earlier, and bumped default heap to 768MB (#239, #242)
- **Plex session schema** — Relaxed schema validation to tolerate type variance across Plex server versions (#228)
- **Pino logging conflict** — Removed shell stdout redirect that conflicted with Pino's worker-thread transport, causing empty log files (#238)
- **Seerr widget hydration error** — Fixed nested `<a>` tags in the dashboard Seerr widget that caused React hydration mismatches
- **Seerr "View" link destination** — Stuck attention items now link to the "All Requests" tab instead of the pending approval tab where they wouldn't appear. Added `?tab=` deep-link support to the requests page
- **Tautulli/Plex validation** — Improved statistics code quality and data validation (#233, #241)

### Changed
- **Logging** — Routed all remaining `console.warn`/`console.error` calls through Pino structured logger (#240)
- **CI** — Fixed Docker Hub login for Dependabot PRs — login step now skips when secrets are unavailable (#246)

### Security
- **nodemailer** 8.0.3 → 8.0.4 — SMTP command injection fix
- **picomatch** 4.0.3 → 4.0.4, 2.3.1 → 2.3.2 — ReDoS and method injection fixes
- **brace-expansion** 5.0.4 → 5.0.5, 1.1.12 → 1.1.13 — memory exhaustion fix
- **yaml** 2.8.2 → 2.8.3 — stack overflow via nested collections fix
- **prisma** 7.5.0 → 7.6.0, **@tanstack/react-query** 5.95.1 → 5.95.2, **turbo** 2.8.20 → 2.9.1, **@biomejs/biome** 2.4.8 → 2.4.10, **vitest** 4.1.0 → 4.1.2

### Tests
- First-wave test coverage for library cleanup, auth, services, and notifications (#224)
- Seerr-backed integration tests for the requests experience (#231)

## [2.11.0] - 2026-03-24

System Pulse — a unified attention feed that synthesizes health signals from every connected service into a single prioritized page.

### Added

#### System Pulse — Unified Health Attention Feed
- **Pulse page** — New `/pulse` page as the first item in sidebar navigation. Aggregates health signals from all connected services into a prioritized feed grouped by severity (critical, warning, info). Severity sections are collapsible with item counts. Empty state shows "All clear" when no issues detected
- **ARR health monitoring** — Surfaces health issues and warnings reported by Sonarr, Radarr, Prowlarr, Lidarr, and Readarr instances. ARR errors map to critical severity, warnings to warning severity
- **Disk space alerts** — Warns when any ARR instance's storage exceeds 80% (warning) or 90% (critical). Deduplicates shared storage groups to avoid double-counting
- **Instance unreachable detection** — Detects when ARR instances fail to respond to health checks and surfaces them as critical signals. Also catches client creation failures (e.g., bad API key)
- **Seerr circuit breaker visibility** — Surfaces Seerr outages (circuit breaker OPEN → critical) and recovery state (HALF_OPEN → warning) on the Pulse page
- **Cache staleness tracking** — Warns when Plex or Tautulli cache data hasn't refreshed in 12+ hours or when the last refresh resulted in an error
- **Validation health signals** — Surfaces integration validation failures (TRaSH, Seerr, Plex, Tautulli) from the validation health registry. Failing integrations are critical, degraded are warning
- **Quality cutoff signal** — Shows an info-level count of library items below their quality profile cutoff, with a direct link to the filtered library view
- **Operation failure alerts** — Surfaces hunt failures, queue cleaner errors, and TRaSH sync failures from the last 24 hours. Capped at 5 items per category to avoid noise
- **Server-side caching** — Pulse response is cached per-user for 60 seconds to avoid excessive ARR API calls on page refresh. Frontend polls every 120 seconds (POLLING_STATS interval)

## [2.10.1] - 2026-03-24

### Fixed

- **Quality filter not applied** — The library "Quality" dropdown (Cutoff unmet / Cutoff met) was not filtering results because the `cutoffUnmet` parameter was missing from the API client's URL serialization. The filter UI, backend validation, and database query all worked correctly — only the HTTP request was missing the parameter

## [2.10.0] - 2026-03-24

Cross-service Library Intelligence, TRaSH scheduled sync, quality upgrade visibility, and foundational reliability improvements.

### Added

#### Library Intelligence — Cross-Service Insights
- **Library Insights section** — New advisory panel on the Library page that surfaces actionable signals by correlating data across Sonarr/Radarr, Plex, and Seerr. Three signals: unwatched disk waste (large files with zero Plex plays), watched items still monitored (wasting indexer searches), and Seerr-requested content never watched
- **Insight quick actions** — Inline "Unmonitor" button on watched-monitored and disk-waste items. Per-item "Dismiss" to hide items from the panel (persisted in localStorage)
- **Priority summary** — Section header shows total count with breakdown by category and a contextual priority cue ("Start with requested items — someone is waiting")
- **Insight notifications** — Two new event types: `LIBRARY_INSIGHT_REQUESTED_UNWATCHED` and `LIBRARY_INSIGHT_WATCHED_MONITORED`. Scheduler runs every 6 hours with 24-hour cooldown. Notifications deep-link to the relevant panel via `?insight=` query param

#### TRaSH Scheduled Sync
- **Sync scheduler** — Background scheduler executes template syncs based on `TrashSyncSchedule` rows. Checks every 60 seconds for due schedules, validates before executing, advances `nextRunAt` even on failure to prevent retry storms
- **Schedule management API** — CRUD endpoints at `/api/trash-guides/schedules` with ownership enforcement and duplicate prevention
- **Schedule modal** — Per-instance schedule creation/editing via the existing `TemplateScheduleModal` (previously built but unconnected). Shows last run time, next run time, and includes a two-step "Remove Schedule" button

#### Quality Upgrade Intelligence
- **Cutoff-unmet tracking** — New `cutoffUnmet` column on `LibraryCache`, populated during library sync from Sonarr/Radarr `/wanted/cutoff` endpoint. Lidarr/Readarr gracefully skipped
- **Quality filter** — New "Quality" dropdown in the library header with options: All quality, Cutoff unmet, Cutoff met
- **Cutoff badge + upgrade button** — Amber "Cutoff Unmet" badge on library cards with an inline "Upgrade" search button that triggers the existing Sonarr/Radarr search command

#### Hunting
- **Lidarr grab detection** — Accurate `itemsGrabbed` counts for Lidarr hunts using album-based history comparison. Previously hardcoded to 0
- **Readarr grab detection** — Same for Readarr using book-based history comparison. Both services fall back to queue-based detection on history API failure

#### Other
- **Template staleness display** — Template cards now show "Synced [date]" and amber "Modified" badge for templates with local changes
- **System hooks** — Extracted 7 inline queries and 3 mutations from `system-tab.tsx` and `validation-health-section.tsx` into shared `useSystem` hooks and `system` API client module
- **Master workflow command** — `.claude/commands/work.md` dispatches to existing commands based on task context

### Fixed

- **Passkey login cache invalidation** — Post-passkey login now correctly invalidates `["current-user"]` instead of `["user"]`, fixing stale auth state after WebAuthn authentication
- **Silent mutation failures in Settings** — Service create/update/delete/toggle, notification rule save/delete/toggle, subscription grid save, and channel config load now show clear error toasts on failure instead of silent no-ops
- **Notification fetch error masquerading as empty state** — Rules tab and subscription grid now show a proper error state with retry guidance instead of misleading "no rules configured" when the API call fails
- **Channel config load error swallowed** — Editing a notification channel that fails to load its config now shows an error message with "Go back" link instead of rendering an empty new-channel form
- **Service delete without confirmation** — Service instance delete, tag delete, and Seerr bulk decline/delete now require two-step inline confirmation (click → "Confirm?" → click within 3 seconds)
- **Dead-end empty states** — Dashboard "no instances" text, hunting overview "go to Configuration tab" text, hunting config "add in Settings" text, and sync history "No Instance Selected" page now have actionable links to the correct destination
- **Incognito mode gaps** — 6 TRaSH-guides components (template-card, template-stats, sync-validation-modal, sync-progress-modal, template-schedule-modal, template-list) now mask instance names when incognito mode is active

### Changed

- **Query key centralization** — Replaced ~40 inline query key string arrays across 15 hook files with centralized imports from `query-keys.ts`. Added 12 new key definitions. Fixed `qualityProfileKeys.overrides` parameter type (`string` → `number`). Fixed 3 files importing `TEMPLATES_QUERY_KEY` from wrong source
- **Request validation hardening** — 15+ API route handlers now use `validateRequest()` with Zod schemas: template-sharing (4 handlers), profile-clone (6 handlers), bulk-score export, user-CF deploy, hunting trigger, passkey login verify (added `sessionId` to schema), and service test-connection
- **Notification event types** — Added "Library Insights" group to the notification subscription grid with two new event types

## [2.9.3] - 2026-03-23

### Fixed

- **Lidarr unmonitored album tracks still counted as missing (#209)** — v2.9.2 filtered by artist-level monitoring but used `totalTrackCount` (all albums) instead of `trackCount` (monitored albums only). Fixed in dashboard statistics, artist normalizer, library card, and album breakdown modal
- **Semgrep unsafe format string in OIDC retry logging (#165)** — Replaced template literal with comma-separated arguments

### Dependencies

- Fastify 5.8.2 → 5.8.4 (CVE-2026-3635 security fix)
- TanStack Query 5.95.0 → 5.95.2, TanStack Query Devtools 5.95.0 → 5.95.2

### Added

- **GitHub issue templates** — Structured bug report and feature request forms with version, deployment method, connected services, and logs fields
- **GitHub PR template** — Checklist covering validation, query keys, polling constants, incognito mode, and ownership checks
- **Claude Code commands** — 9 slash commands for development workflows (fix-issue, release-prep, validate, review-pr, feature-audit, security-pass, stabilize-branch, release-patch, prepare-changelog)
- **Claude Code skills** — 5 domain-specific reasoning skills (frontend architecture, release engineering, integration auditing, auth review, regression hunting)

## [2.9.2] - 2026-03-23

Bug fixes, dependency updates, OIDC compatibility, and frontend architecture improvements.

### Fixed

- **Calendar Sunday events (#207)** — Events were bucketed by UTC date (`airDateUtc`) instead of local air date (`airDate`), causing shows airing Sunday evening in negative UTC timezones to appear on Monday. Now uses the local air date for grid bucketing and UTC for intra-day sort ordering
- **Sonarr/Lidarr statistics (#209)** — Dashboard and statistics showed inflated missing counts and inconsistent downloaded percentages. Sonarr now uses monitored episode count (not total) as the denominator. Lidarr now only counts tracks from monitored artists
- **OIDC Authentik compatibility (#208)** — Authentik includes a trailing slash in its canonical issuer URL, causing `oauth4webapi` strict comparison to fail. New `resolveCanonicalIssuer()` fetches the provider's discovery document to store the exact canonical issuer. Self-healing retry in login flow auto-corrects existing stored issuers without database migration

### Changed

#### Architecture — Frontend Query Infrastructure
- **Centralized query keys** — Consolidated all React Query keys into `query-keys.ts`. Migrated 15 hook files from local KEYS objects and inline string arrays to centralized key factories. Eliminates key drift and enables consistent cache invalidation
- **Polling standardization** — Migrated 28 inline `refetchInterval` values to 6 named constants (`POLLING_REALTIME` 15s through `POLLING_BACKGROUND` 5min). All polling intervals are now auditable from a single file
- **`useRefreshState` hook** — Extracted the 6-copy "isRefreshing + setTimeout" pattern into a shared hook with proper timeout cleanup on unmount, fixing a potential memory leak in 5 of 6 original implementations
- **`useEnrichableItems` hook** — Extracted duplicated library item enrichment logic from Seerr and Plex hooks. Fixes a hidden type mapping inconsistency where Seerr used `"tv"` and Plex used `"series"` for the same concept — both now declare their mapping explicitly

#### Documentation
- **CLAUDE.md rewrite** — Reduced from 1,177 to 158 lines (87% smaller). Extracted detailed reference sections to `docs/THEMING.md`, `docs/AUTH.md`, `docs/API-ROUTES.md`

### Dependencies

- Prisma 7.4.2 → 7.5.0
- Next.js 16.1.7 → 16.2.1
- TanStack Query 5.90.21 → 5.95.0
- Tailwind CSS 4.2.1 → 4.2.2
- Biome 2.4.6 → 2.4.8
- Vitest 4.0.18 → 4.1.0
- better-sqlite3 12.6.2 → 12.8.0
- pnpm/action-setup v4 → v5
- 24 production + 4 dev dependency updates total
- `effect` override to 3.20.0 (Dependabot alert #32)

### Added

- **Authentik OIDC test infrastructure** — Docker Compose setup with PostgreSQL, Redis, and Authentik for end-to-end OIDC flow testing. Validates trailing-slash issuer handling against a real Authentik instance

## [2.9.1] - 2026-03-20

Security patches, comprehensive incognito mode coverage, and TRaSH Guides cloning improvements.

### Security

- **Dependency overrides** - Updated `hono` to 4.12.8 (CVE-2026-29045, CVE-2026-29085, CVE-2026-29086, GHSA-v8w9), `@hono/node-server` to 1.19.11 (CVE-2026-29087), and `flatted` to 3.4.2 (prototype pollution)
- **Input sanitization** - Added type and length validation for TRaSH profile match fields in clone template API
- **Semgrep fix** - Resolved unsafe format string finding in pattern tester

### Fixed

#### Incognito Mode (Hide Sensitive Data)
- **Complete coverage across all features** - Extended incognito mode to 40+ components across every page, tab, modal, filter dropdown, chart, and toast message in the application
- **Dashboard** - Now hides media titles, usernames, server names, device names, and platform info in Plex widgets (Now Playing, Continue Watching, Recently Added, Watch History, Server Info), health messages (download client names), and username greeting
- **Library** - Hides titles, overviews, poster images, instance names, file paths, and Plex usernames in library cards, detail modals, and filter dropdowns
- **Calendar** - Anonymizes event titles, instance names, and overviews in calendar cards and filter dropdowns
- **Statistics** - Hides Plex usernames, media titles, device/player names, and platform names across all charts (user analytics, watch history, device chart, quality scores)
- **Requests (Seerr)** - Anonymizes media titles, user display names, email addresses, avatar images, and overviews across all tabs (requests, users, issues, history, settings dialog)
- **Hunting** - Hides instance names, grabbed item titles, and indexer names in config cards and activity logs
- **Queue Cleaner** - Anonymizes instance names and item titles in config, overview, activity logs, and toast messages
- **Library Cleanup** - Hides media titles in approval queue, log details, and rule evaluation dialog
- **Notifications** - Anonymizes channel names and event titles in notification logs
- **Settings** - Hides instance labels, service URLs, and username on Account tab
- **Topbar** - Anonymizes username display and avatar initial
- **Queue messages** - Added Lidarr music release anonymization patterns for artist/album names, file paths with nested brackets, and download client names in health messages
- New utility functions: `getLinuxUsername`, `getLinuxDevice`, `getLinuxSectionName`, `getLinuxServerName`, `getLinuxEmail`

#### TRaSH Guides
- **Cloned template quality display** - Templates created via "Clone from Instance" now properly show quality configuration in the editor instead of "No Quality Configuration" empty state
- **TRaSH profile linking** - Cloned templates are now linked to their matching TRaSH Guides profile (e.g., SQP-2) for ongoing score updates. User score overrides are preserved via the existing `scoreOverride` system

## [2.9.0] - 2026-03-19

v2.9 is the largest feature release since 2.0 — adding media server awareness, a notification system, library lifecycle management, and TRaSH naming scheme deployment.

### Added

#### Plex Media Server Integration
- **Now Playing Dashboard Widget** - Real-time view of active Plex streams with user avatars, media thumbnails, progress bars, transcode/direct play indicators, and bitrate/bandwidth metrics. Merges sessions from both Plex and Tautulli for enriched data
- **Plex Statistics Tab** - Dedicated statistics view with watch history, top users, most-watched content, and library utilization
- **Watch History Enrichment** - Library items display Plex watch status, play count, and last-watched date when a Plex server is connected
- **Background Cache Refresh** - Scheduled polling of Plex sessions and library data with configurable intervals

#### Tautulli Integration
- **Activity Monitoring** - Real-time stream activity with bandwidth metrics (LAN/WAN breakdown)
- **Watch Statistics** - Historical watch data aggregation surfaced in the Statistics and Library pages
- **Session Merging** - Intelligently merges Plex and Tautulli session data for the richest possible Now Playing view

#### Seerr Integration
- **Request Management** - View, approve, and decline media requests from Seerr directly within the dashboard
- **User Management** - Browse Seerr users with request counts and permissions
- **Issue Tracking** - View and manage reported issues from Seerr
- **Notification Agents** - Configure Seerr notification agents from the dashboard
- **Library Enrichment** - Library items display Seerr request status and requester info
- **Discover Integration** - TMDB discover page enhanced with Seerr availability data

#### Notification System
- **7 Notification Channels** - Discord (webhooks), Telegram (Bot API), Email (SMTP), Pushover, Gotify, Pushbullet, and Browser Push (Web Push API)
- **Event Subscriptions** - Per-channel subscription grid for 12+ event types: system startup, deployment complete, sync complete, hunt complete, queue cleaner actions, backup complete, library cleanup actions, and more
- **Rich Metadata** - All notifications include contextual metadata (instance names, affected items, durations, error details)
- **Notification Logs** - Searchable history of all dispatched notifications with delivery status
- **Test Send** - One-click test delivery per channel for verification during setup

#### Library Cleanup
- **Rule-Based Cleanup Engine** - Define rules to identify library items for removal based on 20+ condition types: age, size, rating, genre, tag, quality profile, watched status (via Plex/Tautulli), request status (via Seerr), monitored state, and more
- **Approval Queue** - Dry-run mode evaluates rules and presents candidates for human review before any deletion
- **Multi-Source Enrichment** - Rules can reference data from Plex (watch status), Tautulli (play count/last watched), and Seerr (request status) for intelligent cleanup decisions
- **Scheduled Execution** - Automated runs with configurable intervals and approval requirements
- **Audit Logging** - Complete history of cleanup actions with item details and rule matches

#### TRaSH Guides Naming Scheme Deployment
- **Naming Preset Selection** - Apply TRaSH-recommended naming schemes for Radarr (movie file/folder) and Sonarr (standard/daily/anime episode, season folder, series folder)
- **Preview & Diff** - See exactly what will change before applying naming schemes
- **Per-Instance Config** - Each instance can have independent naming configurations
- **Auto-Sync** - Optionally keep naming schemes in sync with TRaSH updates

#### TRaSH Guides Enhancements
- **Zod Runtime Validation** - All TRaSH GitHub JSON data is now validated with Zod schemas at fetch time, replacing unsafe `as` type casts. Catches upstream format changes before they cause runtime errors
- **Profile Groups UI** - Quality profiles organized into logical groups (Standard, Anime, French, German, SQP) for easier template building
- **CF Group Scores** - Custom format group scores now visible and configurable in the quality profile wizard

#### Health & Observability
- **Health Check Endpoint** - `GET /health` returns database connectivity status, application version, and commit SHA. Used by Docker `HEALTHCHECK` for container orchestration
- **Startup Banner** - Structured log line on startup: `arr-dashboard v2.9.0 started (commit: abc1234)` with database type, log level, and listen address
- **Version in System Info** - `/api/system/info` now includes commit SHA alongside version

#### Hunting Overhaul (#187)
- **Full Wanted List Pagination** - Hunting now fetches the complete wanted list (up to 10K items at pageSize=500) instead of a single page with a calculated offset, guaranteeing every item is reachable across multiple hunt cycles
- **Upgrade Search All Toggle** - New opt-in "Include all monitored items" toggle re-searches all monitored items with files, catching items Arr doesn't flag after quality profile changes
- **Diagnostic Funnel Messages** - Hunt results now show exactly where items were eliminated: "Fetched 500 → 320 passed filters → all 320 recently searched"

#### UI Consistency Overhaul
- **Backdrop Blur Cleanup** - Removed decorative `backdrop-blur` from ~40 static containers while preserving it on functional overlays (modals, dropdowns)
- **Three-Tier Card System** - Formalized Light (`bg-muted/10`), Elevated (`bg-card/50`), and Floating (`bg-card/30 + blur`) container tiers
- **Light/OLED Mode Fix** - Replaced `bg-card/10` with `bg-muted/10` across 53 files for visibility on white/black backgrounds
- **Form Input Standardization** - Migrated inline input styles to `INPUT_BASE_CLASSES` from `theme-input-styles.ts`

#### Performance Optimizations
- **Batched Plex Cache Upserts** - Transactions of 100 items instead of individual upserts (10-50x faster on RPi/NAS)
- **SessionSnapshot Index** - Added standalone `capturedAt` index for analytics queries
- **Known-Platforms Cache** - 6-hour in-memory cache eliminates 10K-row fetch every 5 minutes
- **Seerr Notification Agents Cache** - 5-minute TTL with invalidation on update
- **Dashboard Polling** - Disabled media polling on inactive tabs (60s vs 15s), queue polling reduced to 30s
- **ColorThemeProvider Memoization** - Prevents 355 subscriber re-renders on provider mount
- **NavContent Module Scope** - Prevents nav tree remounts on sidebar state changes
- **ManualImportModal Lazy Loading** - Deferred chunk load until modal opens
- **Schema Fingerprinting** - Only runs on first item per category (was every validated item)
- **next/image for Plex Posters** - Layout shift prevention with width/height on poster thumbnails

### Changed

- **Comprehensive Security Hardening** - Input sanitization, Helmet security headers (HSTS, X-Content-Type-Options, X-Frame-Options), rate limiting on new endpoints, CUID validation on route parameters, and session logout logging
- **Service Type Taxonomy** - Centralized service type enum prevents crashes when non-ARR services (Plex, Tautulli, Seerr) are passed to ARR-only code paths
- **Silent `.catch()` Cleanup** - Background notification dispatches now log at debug level instead of silently swallowing errors
- **Boolean Parser Extraction** - Shared utility for parsing string booleans from query parameters, replacing ad-hoc `=== "true"` checks

### Fixed

#### Bug Fixes (from v2.8.5, included in this release)

- **Queue Cleaner Misses Radarr importBlocked Items** - Queue Cleaner now detects all `importBlocked` items regardless of cleanup level ([#129](https://github.com/Kha-kis/arr-dashboard/issues/129))
- **Prisma Client Regeneration Fails on PostgreSQL in Docker** - Standalone tsconfig.json for Docker runtime ([#130](https://github.com/Kha-kis/arr-dashboard/issues/130))
- **Sonarr Missing Episode Stats Overcount** - Uses `episodeCount` instead of `totalEpisodeCount` ([#131](https://github.com/Kha-kis/arr-dashboard/issues/131))
- **Queue Remove Dropdown Clipped** - Replaced inline dropdowns with portaled Radix DropdownMenu ([#132](https://github.com/Kha-kis/arr-dashboard/issues/132))
- **LOG_LEVEL Environment Variable Ignored** - Custom logger now wired into Fastify via `loggerInstance` ([#133](https://github.com/Kha-kis/arr-dashboard/issues/133))

#### Release Hardening

- **PostgreSQL Secrets Migration** - Upgrading from v2.8.x with PostgreSQL no longer silently regenerates encryption keys. The startup sequence now checks the legacy secrets path (`/app/api/data/secrets.json`) and auto-migrates to `/config/secrets.json` (#141)
- **Library Cleanup Safety Rails** - Bulk approval capped at 100 IDs per request; "Run Now" button requires confirmation dialog with context-aware messaging (#142)
- **Notification Payload Truncation** - Metadata arrays truncated to 15 items, Discord fields capped at 1024 chars/25 fields/5500 total, Telegram messages capped at 4000 chars. Prevents silent delivery failures (#143)
- **Plex/Tautulli Cache Eviction** - Cache refresh now evicts stale rows for items removed from Plex or Tautulli, preventing unbounded table growth (#144)
- **Integration Observability** - New `/api/plex/cache/:id/status` and `/api/tautulli/cache/:id/status` endpoints plus manual refresh triggers (#145)
- **Notification Delivery Tracking** - Per-channel `lastSentAt`/`lastSendResult` fields track real delivery status alongside existing test status (#146)
- **Cleanup Audit Transparency** - Log table rows expand to show per-item details (matched rule, reason, action, status) (#147)

#### Additional Fixes

- **Plex/Tautulli Schema Hardening** - Zod schemas updated for nullable `title`, `ratingKey`, `guids`, `media_type` fields; `rating_key` uses `z.coerce.string()` for numeric values from Tautulli
- **Cache Refresh Error Messages** - Schedulers now store actual error text (first 3 messages, truncated to 200 chars) instead of generic "N item errors"
- **Lidarr/Readarr Dedup Fix** - Hunting dedup maps skip records with undefined IDs instead of collapsing them to key `0`
- **Seerr Issue Pagination** - Increased page size from 20 to 100 (5x fewer serial API calls)
- **Calendar E2E Tests** - Updated selectors for v2.9 calendar redesign (heading, filters, navigation)
- **Seerr Test Assertions** - Fixed 4 broken tests that checked `mock.calls[0]` instead of `mock.calls[1]` due to CSRF prefetch
- **Skip Future Episodes** - Queue Cleaner can now optionally skip future (unaired) Sonarr episodes
- **Scheduler Test Stability** - Fixed flaky scheduler tests by matching per-config reset implementation

### Security

- **Dependency Updates** - Updated next (16.1.7), undici (7.24.0), flatted (3.4.0) resolving 11 CVEs including HTTP smuggling, CSRF bypasses, WebSocket DoS, and CRLF injection
- **SSRF Prevention** - Plex image proxy rejects paths containing `..` to prevent path traversal past the `/library/metadata/` prefix
- **CSRF Retry Fix** - Seerr client now throws the actual retry error instead of silently discarding it and re-throwing the stale 403
- **Silent Failure Fixes** - Added logging to 6 previously silent catch blocks: `safeRequest`, notification retry handler, cache-manager delete, template-updater corrupt JSON, aggregation buffer flush, Plex cache eviction skip
- **Dependabot Alerts Resolved** - Patched minimatch (ReDoS) and ajv (prototype pollution) via version overrides
- **Fastify Helmet** - Content Security Policy headers on all API responses
- **Notification Channel Encryption** - All channel configurations (webhook URLs, API tokens, SMTP credentials) encrypted at rest with AES-256-GCM

### Testing

- **1073 Unit Tests** - All passing (0 failures), covering notification system, Seerr integration, validation system, cleanup rule evaluators, and Plex route helpers
- **E2E Integration Suite** - 18 specs covering all features, 3 shards for parallel execution
- **CI Pipeline Optimized** - Merged lint+test job, Docker build parallel with E2E, cancel-in-progress on new push
- **TRaSH GitHub Schema Tests** - 583 lines of validation tests ensuring upstream TRaSH JSON format compatibility
- **Naming Deployer Tests** - 497 lines covering naming scheme application logic
- **Database Upgrade Tested** - Verified SQLite and PostgreSQL v2.8→v2.9 upgrade path with data preservation

### Upgrade Notes

> **Database:** v2.9.0 adds new tables for notifications, library cleanup, Plex/Tautulli/Seerr caching, and naming configuration. These are created automatically by `prisma db push` on startup — no manual migration required.
>
> **Plex/Tautulli/Seerr:** These integrations are optional. If you don't configure these services in Settings, no related features will appear in the UI.
>
> **Notifications:** No channels are configured by default. Visit Settings → Notifications to set up your preferred channels.
>
> **PostgreSQL Users Upgrading from v2.8.x:** Your `secrets.json` was previously stored at `/app/api/data/secrets.json`. v2.9 now stores it at `/config/secrets.json`. The migration is **automatic** — existing secrets are copied on first startup. No manual action required, but the log will show: `Migrating secrets from legacy path (v2.8.x upgrade)`.
>
> **Volume:** Ensure your `/config` volume is preserved. This directory contains `prod.db` and `secrets.json`. Standard Docker upgrades preserve this automatically.

---

## [2.8.5] - 2026-03-02

### Fixed

- **Queue Cleaner Misses Radarr importBlocked Items** - Queue Cleaner now detects all `importBlocked` items regardless of cleanup level. Previously items were silently dropped at "safe" level when status messages didn't match known keywords. Also handles `failedPending` state and counts `importBlocked` in queue summary ([#129](https://github.com/Kha-kis/arr-dashboard/issues/129))
- **Prisma Client Regeneration Fails on PostgreSQL in Docker** - Replaced the monorepo `tsconfig.json` (which extends a base file not present in the container) with a standalone version for the Docker runtime image. Fixes Prisma 7 failing to transpile `prisma.config.ts` during provider switch or `db push` ([#130](https://github.com/Kha-kis/arr-dashboard/issues/130))
- **Sonarr Missing Episode Stats Overcount** - Statistics page now uses Sonarr's `episodeCount` (monitored episodes only) instead of `totalEpisodeCount` (all episodes including unaired, unmonitored, and specials) when calculating missing episodes. This caused inflated counts (e.g., 9,000+ shown instead of ~60 actual missing) for users with large libraries containing many unmonitored or future episodes ([#131](https://github.com/Kha-kis/arr-dashboard/issues/131))
- **Queue Remove Dropdown Clipped** - The "Remove" dropdown menu in the Active Queue (and Hunt/Sync Strategy dropdowns elsewhere) was clipped by `overflow-hidden` on card containers. Replaced all three inline-positioned dropdowns with portaled Radix DropdownMenu for proper rendering above all ancestors ([#132](https://github.com/Kha-kis/arr-dashboard/issues/132))
- **LOG_LEVEL Environment Variable Ignored** - The `LOG_LEVEL` env var had no effect because Fastify was creating its own default Pino logger (`logger: true`) instead of using the custom logger that reads `LOG_LEVEL`. Now wires the custom logger into Fastify via `loggerInstance`, supports all standard levels (fatal/error/warn/info/debug/trace), and includes log file rotation, sensitive field redaction, and startup banner showing effective log level ([#133](https://github.com/Kha-kis/arr-dashboard/issues/133))

### Added

- **Sonarr Statistics Unit Tests** - Added comprehensive test suite for the missing episode calculation covering: unmonitored episodes, future unaired episodes, specials/season 0, edge cases (negative counts, missing fields), and multi-instance aggregation
- **Comprehensive Structured Logging** - 35 debug-level log statements across 18 modules (auth, hunting, queue cleaner, backup, deployment, etc.) provide meaningful output when `LOG_LEVEL=debug`

---

## [2.8.4] - 2026-02-23

### Fixed

- **Quality Definition Reset Compatibility** - The "Reset to Factory Defaults" action now tries multiple API strategies (command API → direct endpoint) with proper fallback, instead of relying on a single endpoint that doesn't exist across all Sonarr/Radarr versions. Shows a clear actionable error if the instance doesn't support either method ([#114](https://github.com/Kha-kis/arr-dashboard/issues/114))
- **Reset UI Feedback** - The quality size reset confirmation panel now displays error and success states instead of silently failing

---

## [2.8.3] - 2026-02-23

### Fixed

- **TRaSH Guides PR #2590 Compatibility** - Activated support for TRaSH Guides' upstream format changes: CF groups now use `include` semantics (explicitly listing applicable profiles instead of exclusions), and quality items are ordered human-readable (low→high) requiring reversal before Sonarr/Radarr API submission
- **CF Group Profile Filtering** - Fixed `profile-matcher.ts` using inline `exclude`-only logic instead of the shared `isCFGroupApplicableToProfile()` helper, which caused CF groups to be applied to all profiles regardless of include/exclude restrictions

---

## [2.8.2] - 2026-02-19

### Fixed

- **API Crash on Startup (Docker)** - Fixed `TypeError: Cannot read properties of undefined (reading 'graph')` that prevented the API from starting in v2.8.1 Docker builds. The root cause was a Prisma client version mismatch: `tsup` bundled the 7.3.0-generated config while `@prisma/client` 7.4.0 runtime expected the newer `parameterizationSchema.graph` field. The Dockerfile now runs `prisma generate` before the build step so the bundled config always matches the installed runtime ([#105](https://github.com/Kha-kis/arr-dashboard/issues/105))

---

## [2.8.1] - 2026-02-18

### Added

- **Quality Size Preset Management** - Apply TRaSH Guides quality size presets (movie, anime, series, streaming) to Sonarr/Radarr instances. Includes preview diff, factory reset, sync strategy tracking, and per-instance mapping persistence ([#96](https://github.com/Kha-kis/arr-dashboard/pull/96))
- **Hunting Reset Confirmation** - Reset History button now shows a confirmation dialog to prevent accidental data loss
- **CodeQL & Semgrep Code Scanning** - Automated security analysis on every push and PR via GitHub Actions ([#100](https://github.com/Kha-kis/arr-dashboard/pull/100))

### Changed

- **Major Codebase Refactoring** - Consolidated error handling with `getErrorMessage()` utility (replaces 179 `instanceof Error` patterns), extracted backup-service into focused modules, removed redundant try/catch blocks in favor of global error handler, and decomposed large frontend components ([#93](https://github.com/Kha-kis/arr-dashboard/pull/93), [#96](https://github.com/Kha-kis/arr-dashboard/pull/96))
- **Deployment Executor Plugin** - Extracted long-running deployment logic into a Fastify plugin with proper lifecycle management and structured logging
- **Template Route Consistency** - DELETE instance-override handler now uses shared `parseInstanceOverrides()` utility consistent with GET/PUT handlers
- **Cache Route Type Safety** - Replaced dynamic `service.toLowerCase()` keys and type casts with typed `ServiceType` alias and static lookup maps

### Fixed

- **Runtime Query Validation** - Added Zod validation for `serviceType` query parameter on `/custom-formats/list` and `/cf-descriptions/list` endpoints — Fastify TypeScript generics don't validate at runtime ([#102](https://github.com/Kha-kis/arr-dashboard/pull/102))
- **Quality Size Service Guard** - Non-Sonarr/Radarr instances now return a clear 400 error instead of cryptic 500 when attempting quality size operations
- **Flaky E2E Tests** - Resolved intermittent sidebar navigation test failures with improved wait strategies ([#101](https://github.com/Kha-kis/arr-dashboard/pull/101))

### Security

- **46 Code Scanning Alerts Resolved** - Fixed all CodeQL and Semgrep findings including log injection, prototype pollution, ReDoS, filesystem race conditions, and property injection ([#102](https://github.com/Kha-kis/arr-dashboard/pull/102))
- **ReDoS Prevention** - Rewrote `normalizeProfileName` with string methods (no regex) to eliminate catastrophic backtracking vectors
- **Prototype Pollution Prevention** - CUID format validation (`/^[a-z0-9]+$/`) on instance ID route parameters prevents `__proto__` injection
- **Log Injection Prevention** - `sanitizeForLog()` strips `\r\n` from all interpolated values in structured log messages
- **Atomic Secret Writes** - Secret manager uses temp file + `renameSync` pattern, catches `ENOENT` instead of TOCTOU-vulnerable `existsSync`

### Dependencies

- Bumped 27 production dependencies and 6 remaining outdated packages ([#97](https://github.com/Kha-kis/arr-dashboard/pull/97), [#99](https://github.com/Kha-kis/arr-dashboard/pull/99))
- Bumped GitHub Actions group (7 updates) and dev dependencies group (4 updates)

---

## [2.8.0] - 2026-02-06

### Added

- **Full Lidarr & Readarr Support** - Complete integration for music (Lidarr) and book (Readarr) management. All features now work across Sonarr, Radarr, Lidarr, and Readarr including queue management, library sync, manual import, and queue cleaner ([#87](https://github.com/Kha-kis/arr-dashboard/pull/87))
- **Queue Cleaner Auto-Import** - New experimental feature that attempts to automatically import stuck downloads before removing them. Configurable safe/never patterns, max attempts, cooldown periods, and rate limiting. Live tested with 87% Sonarr and 100% Radarr success rates ([#88](https://github.com/Kha-kis/arr-dashboard/pull/88), [#80](https://github.com/Kha-kis/arr-dashboard/issues/80))
- **Import Pending/Blocked Toggle** - Queue Cleaner now has a dedicated toggle to enable/disable import pending/blocked cleanup separately from other rules

### Fixed

- **TRaSH Guides Quality Format Reversal** - Temporarily disabled quality format reversal feature pending upstream TRaSH PR #2590 merge to prevent incorrect format application

### Security

- **Auto-import rate limiting** - 200ms delay between import attempts and max 10 imports per cleaner run to prevent overwhelming ARR instances
- **Pattern validation** - Custom auto-import patterns validated with size limits (10KB max, 50 patterns max, 200 chars per pattern)

---

## [2.7.4] - 2026-02-05

### Added

- **Configurable Password Policy** - New `PASSWORD_POLICY` environment variable allows choosing between `strict` (default, requires uppercase/lowercase/number/special character) and `relaxed` (8+ characters only, passphrase-friendly) password requirements. Enables secure passphrases like "correct horse battery staple" ([#83](https://github.com/Kha-kis/arr-dashboard/issues/83), [#84](https://github.com/Kha-kis/arr-dashboard/pull/84))

### Changed

- **Password validation** - Frontend validation now matches backend 128-character maximum limit for consistent user experience
- **Type imports** - `PasswordPolicy` type now imported from `@arr/shared` package for single source of truth

---

## [2.7.3] - 2026-02-04

### Added

- **Queue Cleaner** - New automated queue cleanup feature for Sonarr/Radarr with multi-rule detection (stalled, failed, slow, seeding timeout, error patterns, import blocks), strike system, whitelist protection, dry-run mode, rich preview UI, statistics dashboard, and per-instance configuration ([#81](https://github.com/Kha-kis/arr-dashboard/pull/81))
- **Prefer Season Packs** - New hunting toggle for Sonarr that prioritizes season pack releases over individual episode searches. When enabled, always triggers SeasonSearch for any missing content to catch season packs ([#79](https://github.com/Kha-kis/arr-dashboard/issues/79))

### Fixed

- **CI build order** - Build shared package before lint and test jobs to ensure types are available ([#81](https://github.com/Kha-kis/arr-dashboard/pull/81))
- **Environment validation errors** - Replace cryptic Zod stack traces with user-friendly error messages showing which env var failed, its current value, and hints for common issues like SESSION_TTL_HOURS limits ([#78](https://github.com/Kha-kis/arr-dashboard/issues/78))
- **Login page API health check** - Always verify API connectivity when login page loads, ensuring users see the "Connection Error" screen immediately when API is down (including server errors) instead of a stale cached login form ([#78](https://github.com/Kha-kis/arr-dashboard/issues/78))

### Security

- **Fastify** - Update to 5.7.2 to address HTTP request smuggling vulnerability ([GHSA-jx2c-rxcm-jvmq](https://github.com/advisories/GHSA-jx2c-rxcm-jvmq))

---

## [2.7.2] - 2026-02-02

### Added

- **Custom upstream repository** - Configure a custom GitHub fork as TRaSH Guides upstream source, replacing the official TRaSH-Guides/Guides repo. Includes settings UI with Git URL input, test connection, and reset to official ([#77](https://github.com/Kha-kis/arr-dashboard/pull/77))
- **User custom formats** - Full CRUD management for user-defined custom formats with specification builder, import from TRaSH upstream, and deploy to Sonarr/Radarr instances
- **UserCustomFormat database model** - New Prisma model for persisting user-created custom format definitions with specifications

### Fixed

- **DOMPurify v3 CJS import** - Fix silently returning empty HTML for all sanitized content by using `mod.default || mod` with `sanitize()` validation ([#74](https://github.com/Kha-kis/arr-dashboard/issues/74))
- **CF description endpoint** - Switch to dedicated lazy-loading endpoint with multi-strategy slug matching (exact, displayName, base name fallbacks) ([#74](https://github.com/Kha-kis/arr-dashboard/issues/74))
- **Template update banner overflow** - Fix wrapping badge row layout that overflowed on narrow viewports
- **SSR hydration mismatch** - Use deterministic skeleton widths to prevent server/client rendering differences
- **Timer stacking** - Prevent `scheduleCacheRefresh` from stacking on rapid mutations
- **Silent error swallowing** - Add `console.warn` to catch blocks for diagnostic visibility

### Changed

- **Parameterized TRaSH fetcher URLs** - `github-fetcher` and `version-tracker` now accept `TrashRepoConfig` for per-request fetcher creation
- **Tab content rendering** - Refactored from nested ternary to switch statement with ErrorBoundary wrappers
- **UX copy improvements** - Better messaging for cache repopulation timing expectations

### Security

- **Alpine package CVEs** - Patch libcrypto3/libssl3 3.3.5→3.3.6, busybox 1.37.0-r13→r14 via `apk upgrade` in Dockerfile ([#75](https://github.com/Kha-kis/arr-dashboard/pull/75))
- **Dependency overrides** - Force lodash ≥4.17.23 (prototype pollution) and hono ≥4.11.7 (XSS, cache deception, IP spoofing) in Prisma transitive dependency chain ([#75](https://github.com/Kha-kis/arr-dashboard/pull/75))

---

## [2.7.1] - 2026-01-30

### Fixed

- **TRaSH Guides template persistence** - Fix custom quality configurations, quality profiles,
  sync settings, and cloned quality profiles being silently dropped when saving templates.
  The Zod validation schema was missing 4 of 8 TemplateConfig fields, causing them to be
  stripped during parsing ([#69](https://github.com/Kha-kis/arr-dashboard/issues/69))
- **TRaSH CF Group validation** - Add missing `include` field to CF Group quality_profiles
  validation schema for TRaSH Guides PR #2590 include/exclude semantics support

### Security

- **Next.js** - Bump minimum version to 16.1.5 to address HTTP request deserialization DoS
  ([GHSA-h25m-26qc-wcjf](https://github.com/advisories/GHSA-h25m-26qc-wcjf))

---

## [2.7.0] - 2026-01-21

### Major Upgrades

This release includes significant upgrades to the entire technology stack for improved performance, security, and maintainability.

#### Runtime & Build
- **Node.js** 20 → 22 (LTS with improved performance and native fetch)
- **pnpm** 9 → 10 (faster installs with inject-workspace-packages)

#### Backend
- **Prisma** 6 → 7 (driver adapter architecture, improved query performance)
- **Pino** 9 → 10 (logging improvements)
- **Fastify** 4 → 5 (performance optimizations)

#### Frontend
- **Next.js** 15 → 16 (Turbopack by default, improved SSR)
- **Tailwind CSS** 3 → 4 (new architecture, faster builds)
- **Framer Motion** 11 → 12 (improved animations)
- **Zustand** 4 → 5 (smaller bundle, better TypeScript)
- **Zod** 3 → 4 (improved error messages)

#### Development
- **Vitest** 1 → 4 (faster test execution)
- **Biome** 1 → 2 (improved linting rules)
- **TypeScript** 5.7 → 5.9

### Upgrade Notes

> **Important:** If upgrading from a previous version, ensure your `/config` volume is preserved. This directory contains:
> - `prod.db` - Your database with all configurations
> - `secrets.json` - Encryption keys for API credentials
>
> If `secrets.json` is missing after upgrade, your service connections will fail to decrypt. The volume should be automatically preserved in standard Docker setups.

#### Database Changes
- The deprecated `urlBase` column in system settings has been removed. This is handled automatically during startup with no action required.
- New library caching tables (`library_cache`, `library_sync_status`) are created automatically for server-side pagination support.

### Added

#### Dashboard Features
- **Queue sorting** - Sort downloads by title (A-Z, Z-A), size (largest/smallest), progress, or status ([#32](https://github.com/Kha-kis/arr-dashboard/issues/32))

#### CI/CD Improvements
- **Automated testing** in CI pipeline with Vitest
- **Dependency vulnerability auditing** with `pnpm audit`
- **Trivy security scanning** for Docker images on release
- **Dependabot** for automated dependency updates (npm, GitHub Actions, Docker)
- **Turbo build caching** for faster CI runs
- **Version metadata injection** into Docker images (VERSION, COMMIT_SHA, BUILD_DATE)

#### Docker Improvements
- **OCI image labels** with build metadata for registry/scanner compatibility
- **STOPSIGNAL SIGTERM** for graceful container shutdown via tini
- **NODE_OPTIONS** with memory tuning for containerized environments
- **Package manager cleanup** - removed unused yarn/npm/corepack from runtime (~25MB)
- **Pinned Alpine version** (node:22-alpine3.21) for reproducible builds
- **Non-Linux prebuild cleanup** to reduce image size

### Changed

- Docker startup script now uses direct prisma path (`./node_modules/.bin/prisma`) instead of npx
- pnpm workspace configuration uses `inject-workspace-packages=true` for hermetic deployments
- Prisma 7 now requires `prisma.config.ts` for CLI configuration

### Fixed

- **Accessibility**: Removed constant animations from cyberpunk theme
- **Docker**: Fixed pnpm 10 compatibility with proper inject-workspace-packages configuration
- **Docker**: Fixed Prisma 7 CLI compatibility by copying prisma.config.ts to deploy directory

### Security

- Docker images now scanned with Trivy on every release
- Dependencies audited for vulnerabilities in CI
- Automated security updates via Dependabot
- Removed unnecessary package managers from runtime image (reduced attack surface)

### Dependencies

Major dependency updates:
- lucide-react 0.441.0 → 0.562.0
- tailwind-merge 2.6.0 → 3.4.0
- @types/node 22.18.6 → 25.0.9
- dotenv 16.6.1 → 17.2.3
- tsup 8.5.0 → 8.5.1

---

## [2.6.7] - 2026-01-07

### Bug Fixes

- **Unraid Startup Hang** - Resolved container hang during startup on Unraid by removing blanket chown on /app/api ([#29](https://github.com/Kha-kis/arr-dashboard/issues/29))
- **OIDC Configuration** - Fixed URL normalization and added recovery options for Keycloak/Authelia users ([#27](https://github.com/Kha-kis/arr-dashboard/issues/27))
- **Hunting Pagination** - Added page offset rotation to prevent hunting from getting "stuck" on large libraries ([#30](https://github.com/Kha-kis/arr-dashboard/issues/30))
- **Template Editor** - Switched to patch-based approach to prevent custom format data loss
- **Auto-Sync Diff** - Fixed stale cache issues when computing template diffs ([#23](https://github.com/Kha-kis/arr-dashboard/issues/23), [#25](https://github.com/Kha-kis/arr-dashboard/pull/25))

### New Features

- **TRaSH Guides**
  - **Sync Metrics Telemetry** - New observability endpoint (`/api/trash-guides/metrics`) for tracking sync operations, success rates, timing, and error categorization
  - **GitHub Rate Limit Awareness** - Intelligent backoff when approaching GitHub API rate limits
  - **Quality Group Management** - Full quality group editing for power users
  - **Per-Template deleteRemovedCFs** - Configure CF removal behavior per template
  - **CF Origin Tracking** - Recyclarr-style origin tracking and deprecation handling
  - **Instance Quality Overrides** - Per-instance quality configuration customization

### Code Quality

- Fixed TypeScript errors across authenticated routes (userId type safety)
- Fixed React hooks dependency warnings
- Normalized line endings across codebase
- Removed dead code (unused parameters)

---

## [2.6.6] - 2025-12-28

### New Features

- **TRaSH Guides**
  - **Sync Strategy-Specific Score Handling** - Different sync strategies now handle score updates appropriately:
    - **Auto sync**: Automatically applies recommended scores from TRaSH `trash_scores`, but preserves user score overrides and creates notifications about conflicts
    - **Notify sync**: Shows suggested score changes in diff for user review without auto-applying
    - **Manual sync**: Displays score differences in diff, user chooses what to apply
  - Score conflict notifications when auto-sync detects user overrides that differ from TRaSH recommendations
  - New scheduler stats tracking templates with score conflicts

---

## [2.6.5] - 2025-12-20

### Bug Fixes

- **Docker**
  - Fix EACCES permission denied error when using PostgreSQL on Unraid ([#21](https://github.com/Kha-kis/arr-dashboard/issues/21))
  - Resolve Prisma client regeneration failure when switching database providers with non-default PUID/PGID

### New Features

- **Settings > System**
  - Added System Information section displaying application version, database backend, Node.js version, and uptime
  - Version detection via `version.json` created at Docker build time

### Security & Stability

- **Session Management**
  - Middleware now validates session tokens against the API
  - Invalid/stale session cookies are automatically cleared and user redirected to login
  - Prevents issues when database is reset or container recreated with new volume

### Documentation

- Documentation has moved to the [GitHub Wiki](https://github.com/Kha-kis/arr-dashboard/wiki)
- Comprehensive guides for Authentication, TRaSH Guides, Hunting, Backup/Restore, and more

---

## [2.6.4] - 2025-12-18

### Bug Fixes

- **Docker**
  - Fix container crash loop when upgrading from older versions ([#13](https://github.com/Kha-kis/arr-dashboard/issues/13))
  - Add `--accept-data-loss` flag to `db push` to handle removed columns (e.g., `urlBase` from `system_settings`)

---

## [2.6.3] - 2025-12-15

### New Features

- **Backup System**
  - Password protection for backup files with optional encryption
  - TRaSH data inclusion option - choose whether to include templates, cache, and sync history in backups
  - Improved restore warning messages with clearer explanation of the replacement process

- **TRaSH Guides**
  - Standalone custom format deployment - deploy individual CFs without full profile sync
  - Sync rollback support - revert deployments if something goes wrong
  - Better deployment tracking and history

- **History Page**
  - External links on instance names - click to navigate directly to the relevant page in Sonarr/Radarr/Prowlarr
  - Links to series/movie pages when viewing history for specific items

### Security & Stability

- **Security**
  - Replaced unsafe code execution patterns with safer alternatives in Next.js server wrapper

- **Error Handling**
  - Add global error boundaries for better crash recovery
  - Route-level error boundary with user-friendly error UI
  - Root layout error boundary for critical failures

- **Performance**
  - Add database indexes for Session cleanup, TrashTemplate soft deletes, and HuntConfig scheduling
  - Fix memory leak in TMDB carousel (memoized scroll callbacks)
  - Fix excessive API refetching in services query (proper staleTime configuration)

### Infrastructure

- **Database**
  - Removed Prisma migrations in favor of `db push` for better multi-provider support
  - Improved PostgreSQL compatibility and provider switching
  - Simpler database initialization for fresh installs
  - Added performance indexes for frequently queried columns

---

## [2.6.2] - 2025-12-10

### Bug Fixes

- **Docker**
  - Fix health check failing due to root path redirect (was checking `/` which returns 307, now uses `/auth/setup-required` which returns 200)
  - Fix Prisma migration lock error (P3019) when switching from SQLite to PostgreSQL (#12)
  - Fix empty DATABASE_URL causing Prisma validation error on Unraid (#19)

### Improvements

- **Connection Testing**
  - Simplify connection tester to use single `/api/vX/system/status` endpoint consistently across all services
  - Add specific error messages for common HTTP status codes (401, 403, 404, 5xx)
  - Better messaging for reverse proxy authentication issues

---

## [2.6.1] - 2025-12-05

### Bug Fixes

- **Statistics**
  - Fix disk statistics showing incorrect totals when instances share storage (storage group deduplication now works across services)
  - Add `combinedDisk` API field for accurate cross-service disk usage totals

- **TRaSH Guides**
  - Fix "column errors does not exist" error in deployment history (#13)
  - Add missing database columns for deployment history: `errors`, `warnings`, `canRollback`, `rolledBack`, `rolledBackAt`, `rolledBackBy`, `deploymentNotes`, `templateSnapshot`

### Infrastructure

- **Database Migrations**
  - Add `storageGroupId` column to ServiceInstance for storage group tracking
  - Add missing columns to `template_deployment_history` table
  - Add missing `userId` index for deployment history queries

---

## [2.6.0] - 2025-11-15

### Security

- **Session Security Improvements** - Enhanced authentication session handling with improved security measures (#11)

### New Features

- **TRaSH Guides Sync for Cloned Profiles** - Cloned quality profile templates can now sync with TRaSH Guides updates
- **Automated Hunting** - New hunting feature for automatically searching missing content and quality upgrades (#15)
- **PostgreSQL Support** - Full PostgreSQL database support for larger deployments
- **Improved Error Handling** - Helpful error message when API is unreachable instead of generic failures
- **Tabbed Statistics** - New tabbed interface for viewing service statistics
- **Clickable Dashboard Links** - Instance names in Dashboard are now clickable for quick navigation
- **External Links in Discover** - TMDB, IMDB, and TVDB links added to recommendation carousels
- **Calendar Deduplication** - Entries appearing in multiple instances are now deduplicated
- **TMDB Caching** - In-memory caching for TMDB API calls improves Discover page performance

### Bug Fixes

- **TRaSH Guides**
  - Don't auto-exclude Custom Formats with score 0 when cloning profiles
  - Fix cloned profile ID parser for standard UUIDs
  - Remap cutoff ID correctly when deploying cloned quality profiles

- **Docker**
  - Fix PostgreSQL provider detection (was matching generator instead of datasource)
  - Database port settings now take precedence over environment variables
  - Copy public directory to container for static assets

- **Services**
  - Handle 401/403 responses from reverse proxy during Prowlarr ping tests
  - Handle numeric eventType from Prowlarr API in statistics

- **Web/UX**
  - Improve queue links and prevent password manager autofill on forms
  - Prevent Discover carousel items from appearing then disappearing
  - Calendar now respects unmonitored filter for both Sonarr and Radarr
  - Add clipboard fallback for non-HTTPS environments
  - Fix duplicate icon files causing favicon 500 error

- **API**
  - Replace all explicit `any` types with proper TypeScript types

### Infrastructure

- **Fork-Safe CI** - Docker build job now works correctly for external contributors
- **Unraid Support** - Added icon to public directory for Unraid Community Applications template
- **Documentation** - Complete CLAUDE.md rewrite with comprehensive technical documentation

---

## [2.5.0] - 2025-10-01

### ⚠️ Breaking Change: Volume Path Update

**The Docker volume mount path has changed from `/app/data` to `/config`** to follow [LinuxServer.io conventions](https://docs.linuxserver.io/general/running-our-containers/).

#### Migration Steps

1. Stop your container:
   ```bash
   docker stop arr-dashboard
   ```

2. Update your volume mount:
   ```yaml
   # Old (2.4.x)
   volumes:
     - ./data:/app/data

   # New (2.5.0+)
   volumes:
     - ./config:/config
   ```

3. Rename your data directory (optional but recommended):
   ```bash
   mv ./data ./config
   ```

4. Restart:
   ```bash
   docker-compose up -d
   ```

> **Note:** Your data (database, secrets) will be preserved. Only the mount path has changed.

### Why This Change?

- **Industry Standard** - Matches LinuxServer.io, hotio, and other popular container maintainers
- **Consistency** - Works alongside Sonarr, Radarr, Prowlarr which all use `/config`
- **Easier Support** - "Where is my data?" → "Always in `/config`"

### Added

- TRaSH Guides integration for quality profile management
- Automated backup system with retention policies
- OIDC authentication support (Authelia, Authentik)
- Passkey/WebAuthn authentication

### Changed

- Improved dashboard performance with optimized queries
- Enhanced calendar view with better date handling

---

## [2.4.3] - 2025-09-20

### Improvements

- **Favicon/Tab Icon** - Added browser tab icon for better identification
- **README Screenshots** - Added screenshots showcasing all major features

---

## [2.4.2] - 2025-09-15

### New Features

- **PUID/PGID Support** - LinuxServer.io-style user/group ID configuration for proper file permissions in Docker
- **Collapsible Error Messages** - Queue items with many similar errors (e.g., multiple missing episodes) are now collapsed into expandable groups

### Improvements

- **Incognito Mode** - Now properly masks release names and episode information in queue status messages
- **Discover Page** - Shows helpful message when TMDB API key is not configured instead of flooding console with 400 errors

### Bug Fixes

- Fixed incognito mode not masking queue status messages containing release names
- Fixed discover page making infinite API requests when TMDB key is missing
- Added proper 400 error handling for API requests

---

## [2.4.1] - 2025-09-10

### Features

- TRaSH Guides integration with quality profiles and custom formats
- Template system for reusable configurations
- Deployment preview and conflict resolution
- Automatic backups before changes

---

[2.9.0]: https://github.com/Kha-kis/arr-dashboard/compare/v2.8.5...v2.9.0
[2.8.5]: https://github.com/Kha-kis/arr-dashboard/compare/v2.8.4...v2.8.5
[2.8.4]: https://github.com/Kha-kis/arr-dashboard/compare/v2.8.3...v2.8.4
[2.8.3]: https://github.com/Kha-kis/arr-dashboard/compare/v2.8.2...v2.8.3
[2.8.2]: https://github.com/Kha-kis/arr-dashboard/compare/v2.8.1...v2.8.2
[2.8.1]: https://github.com/Kha-kis/arr-dashboard/compare/v2.8.0...v2.8.1
[2.8.0]: https://github.com/Kha-kis/arr-dashboard/compare/v2.7.4...v2.8.0
[2.7.4]: https://github.com/Kha-kis/arr-dashboard/compare/v2.7.3...v2.7.4
[2.7.3]: https://github.com/Kha-kis/arr-dashboard/compare/v2.7.2...v2.7.3
[2.7.2]: https://github.com/Kha-kis/arr-dashboard/compare/v2.7.1...v2.7.2
[2.7.1]: https://github.com/Kha-kis/arr-dashboard/compare/v2.7.0...v2.7.1
[2.7.0]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.7...v2.7.0
[2.6.7]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.6...v2.6.7
[2.6.6]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.5...v2.6.6
[2.6.5]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.4...v2.6.5
[2.6.4]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.3...v2.6.4
[2.6.3]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.2...v2.6.3
[2.6.2]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.1...v2.6.2
[2.6.1]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.0...v2.6.1
[2.6.0]: https://github.com/Kha-kis/arr-dashboard/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/Kha-kis/arr-dashboard/compare/v2.4.3...v2.5.0
[2.4.3]: https://github.com/Kha-kis/arr-dashboard/compare/v2.4.2...v2.4.3
[2.4.2]: https://github.com/Kha-kis/arr-dashboard/compare/v2.4.1...v2.4.2
[2.4.1]: https://github.com/Kha-kis/arr-dashboard/releases/tag/v2.4.1
