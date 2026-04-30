/**
 * Route Surface Manifest
 *
 * Single source of truth for every top-level route group registered on the
 * Fastify server. Drives both the actual `register()` calls in
 * `bootstrap/{public,protected}-routes.ts` AND the governance section in
 * `docs/API-ROUTES.md`.
 *
 * If you add a new route group, add an entry here. The bootstrap files
 * iterate this list — there is no second place to register a route. A
 * companion test (`__tests__/route-manifest.test.ts`) asserts that every
 * entry is well-formed and that every documented path appears in
 * `docs/API-ROUTES.md`.
 *
 * See `docs/adr/0004-route-surface-governance.md` for the rationale and
 * the meaning of each maturity tier.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyPluginCallback } from "fastify";

import { registerAuthRoutes } from "./auth.js";
import { registerAuthOidcRoutes } from "./auth-oidc.js";
import { registerAuthPasskeyRoutes } from "./auth-passkey.js";
import { registerAutoTagRoutes } from "./auto-tag.js";
import { registerBackupRoutes } from "./backup.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { registerHealthRoutes } from "./health.js";
import { registerHuntingRoutes } from "./hunting.js";
import { registerJellyfinRoutes } from "./jellyfin/index.js";
import { registerLabelSyncRoutes } from "./label-sync.js";
import { registerLibraryRoutes } from "./library.js";
import { registerLibraryCleanupRoutes } from "./library-cleanup.js";
import { registerManualImportRoutes } from "./manual-import.js";
import { registerNotificationRoutes } from "./notifications.js";
import oidcProvidersRoutes from "./oidc-providers.js";
import { registerPlexRoutes } from "./plex/index.js";
import { registerPulseRoutes } from "./pulse.js";
import { registerQueueCleanerRoutes } from "./queue-cleaner.js";
import { registerSearchRoutes } from "./search.js";
import { registerSeerrRoutes } from "./seerr/index.js";
import { registerServiceRoutes } from "./services.js";
import { registerSystemRoutes } from "./system.js";
import { registerTautulliRoutes } from "./tautulli/index.js";
import { registerTrashGuidesRoutes } from "./trash-guides/index.js";

/**
 * Maturity tier of a route group.
 *
 * - `stable`       Web UI and external scripts may depend on this shape.
 *                  Preserve request/response contract within a minor
 *                  version. Breaking changes need a CHANGELOG entry.
 * - `operator`     Operator/admin actions with real-world side effects
 *                  (restart, restore, configure providers). Treat changes
 *                  as user-visible behavior; document in CHANGELOG.
 * - `internal`     Consumed only by the bundled dashboard. Frontend is
 *                  updated in the same PR. Free to reshape.
 * - `experimental` Newer surface, may move or be removed. Mark loudly in
 *                  release notes if exposed in the UI.
 */
export type RouteMaturity = "stable" | "operator" | "internal" | "experimental";

/** Type that matches both Fastify plugin signatures we register. */
type RoutePlugin = FastifyPluginCallback | FastifyPluginAsync | ((app: FastifyInstance) => unknown);

export type RouteGroup = {
	/**
	 * Canonical user-facing path or prefix for this group. Used in docs
	 * and tests. For self-prefixed plugins (e.g. oidc-providers, which
	 * declares `/api/oidc-providers` inside its handlers), this is the
	 * documentation path even though `prefix` is omitted.
	 */
	path: string;
	/** Stability/audience tier. See `RouteMaturity` for definitions. */
	maturity: RouteMaturity;
	/** One-line summary shown in the governance table. */
	summary: string;
	/** The route plugin to register. */
	register: RoutePlugin;
	/**
	 * Fastify `register({ prefix })` option. Omit when the plugin
	 * declares full paths internally (self-prefixed plugins).
	 */
	prefix?: string;
};

/**
 * Public, unauthenticated routes — no session required.
 *
 * These are entry points that establish a session (login, OIDC callback,
 * passkey assertion) plus the health probe. Anything that must work
 * pre-login lives here. See ADR-0003.
 */
export const PUBLIC_ROUTE_GROUPS: readonly RouteGroup[] = [
	{
		path: "/health",
		prefix: "/health",
		register: registerHealthRoutes,
		maturity: "stable",
		summary: "Liveness/readiness probes for orchestrators",
	},
	{
		path: "/auth",
		prefix: "/auth",
		register: registerAuthRoutes,
		maturity: "stable",
		summary: "Password login, registration, account management",
	},
	{
		path: "/auth/oidc",
		prefix: "/auth",
		register: registerAuthOidcRoutes,
		maturity: "stable",
		summary: "OIDC initiate + callback",
	},
	{
		path: "/auth/passkey",
		prefix: "/auth",
		register: registerAuthPasskeyRoutes,
		maturity: "stable",
		summary: "WebAuthn registration + assertion",
	},
];

/**
 * Protected routes — gated by the scoped session preHandler in
 * `bootstrap/protected-routes.ts`. Authentication is uniform; there is
 * no per-route auth check (single-admin model). See ADR-0003.
 */
export const PROTECTED_ROUTE_GROUPS: readonly RouteGroup[] = [
	// --- Auth / identity admin ---
	{
		path: "/api/oidc-providers",
		register: oidcProvidersRoutes,
		maturity: "operator",
		summary: "OIDC provider configuration (single-admin)",
	},

	// --- Operator / system surface ---
	{
		path: "/api/system",
		prefix: "/api/system",
		register: registerSystemRoutes,
		maturity: "operator",
		summary: "Settings, restart, jobs, posture diagnostics",
	},
	{
		path: "/api/backup",
		prefix: "/api/backup",
		register: registerBackupRoutes,
		maturity: "operator",
		summary: "Create, download, restore, scheduled backups",
	},
	{
		path: "/api/notifications",
		prefix: "/api/notifications",
		register: registerNotificationRoutes,
		maturity: "stable",
		summary: "Channels, subscriptions, rules, delivery aggregation",
	},

	// --- ARR services (Sonarr / Radarr / Prowlarr / Lidarr / Readarr) ---
	{
		path: "/api/services",
		prefix: "/api",
		register: registerServiceRoutes,
		maturity: "stable",
		summary: "ARR instance CRUD + connection testing",
	},
	{
		path: "/api/dashboard",
		prefix: "/api",
		register: registerDashboardRoutes,
		maturity: "stable",
		summary: "Queue, history, calendar, statistics aggregates",
	},
	{
		path: "/api/library",
		prefix: "/api",
		register: registerLibraryRoutes,
		maturity: "stable",
		summary: "Movies/series listing, episodes, monitor, search",
	},
	{
		path: "/api/search",
		prefix: "/api",
		register: registerSearchRoutes,
		maturity: "stable",
		summary: "Prowlarr indexer search + grab",
	},
	{
		path: "/api/manual-import",
		prefix: "/api",
		register: registerManualImportRoutes,
		maturity: "stable",
		summary: "Manual import candidates and submission",
	},

	// --- ARR automation (dashboard-driven) ---
	{
		path: "/api/hunting",
		prefix: "/api",
		register: registerHuntingRoutes,
		maturity: "internal",
		summary: "Auto-search configuration and execution",
	},
	{
		path: "/api/queue-cleaner",
		prefix: "/api",
		register: registerQueueCleanerRoutes,
		maturity: "internal",
		summary: "Queue cleanup rules, strikes, dry-run preview",
	},
	{
		path: "/api/library-cleanup",
		prefix: "/api",
		register: registerLibraryCleanupRoutes,
		maturity: "internal",
		summary: "Library cleanup rules, approvals, execution",
	},

	// --- Media servers (Plex / Jellyfin / Tautulli) ---
	{
		path: "/api/plex",
		prefix: "/api/plex",
		register: registerPlexRoutes,
		maturity: "stable",
		summary: "Now playing, on-deck, history, analytics, forecasts",
	},
	{
		path: "/api/jellyfin",
		prefix: "/api/jellyfin",
		register: registerJellyfinRoutes,
		maturity: "stable",
		summary: "Jellyfin activity and library data",
	},
	{
		path: "/api/tautulli",
		prefix: "/api/tautulli",
		register: registerTautulliRoutes,
		maturity: "stable",
		summary: "Activity, watch history enrichment, statistics",
	},
	{
		path: "/api/label-sync",
		prefix: "/api/label-sync",
		register: registerLabelSyncRoutes,
		maturity: "experimental",
		summary:
			"Generic any-to-any media-service tag/label sync rules (issue #384). Sub-arc 1: Sonarr/Radarr → Plex.",
	},
	{
		path: "/api/auto-tag",
		prefix: "/api/auto-tag",
		register: registerAutoTagRoutes,
		maturity: "experimental",
		summary:
			"Criteria-based auto-tagger rules — applies tags to LibraryCache items matching the rule's criteria DSL (genre, year, codec, watch state, …). Companion to Label Sync. Includes inbound webhook endpoint at /webhook/:instanceId for real-time tagging via Sonarr/Radarr Connect (auth via per-user Bearer token).",
	},
	{
		path: "/api/pulse",
		prefix: "/api",
		register: registerPulseRoutes,
		maturity: "internal",
		summary: "System Pulse health signals + attention items",
	},

	// --- External integrations (Seerr / TRaSH Guides) ---
	{
		path: "/api/seerr",
		prefix: "/api/seerr",
		register: registerSeerrRoutes,
		maturity: "stable",
		summary: "Request management, discovery, library enrichment",
	},
	{
		path: "/api/trash-guides",
		prefix: "/api/trash-guides",
		register: registerTrashGuidesRoutes,
		maturity: "internal",
		summary: "TRaSH cache, templates, deployment, profiles",
	},
];

/** All route groups, regardless of auth scope. Used for governance reporting. */
export const ALL_ROUTE_GROUPS: readonly RouteGroup[] = [
	...PUBLIC_ROUTE_GROUPS,
	...PROTECTED_ROUTE_GROUPS,
];
