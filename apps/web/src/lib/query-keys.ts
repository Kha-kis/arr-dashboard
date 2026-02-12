/**
 * Centralized React Query key factory.
 *
 * Every query key in the application should be defined here so that:
 * 1. Invalidation targets are type-safe and never out of sync
 * 2. Duplicate key definitions are eliminated
 * 3. Broad invalidation (e.g. "all library queries") is one import away
 *
 * Convention:
 * - `all`        → readonly tuple for broad invalidation
 * - named static → readonly tuple for a specific query
 * - functions    → return a readonly tuple for parameterised queries
 */

/* -------------------------------------------------------------------------- */
/*  Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

export const dashboardKeys = {
	all: ["dashboard"] as const,
	queue: ["dashboard", "queue"] as const,
	history: (params: Record<string, unknown>) => ["dashboard", "history", params] as const,
	calendar: (params: Record<string, unknown>) => ["dashboard", "calendar", params] as const,
	statistics: ["dashboard", "statistics"] as const,
};

/* -------------------------------------------------------------------------- */
/*  Auth                                                                       */
/* -------------------------------------------------------------------------- */

export const authKeys = {
	currentUser: ["current-user"] as const,
	setupRequired: ["setup-required"] as const,
	passkeyCredentials: ["passkey-credentials"] as const,
};

/* -------------------------------------------------------------------------- */
/*  Services                                                                   */
/* -------------------------------------------------------------------------- */

export const serviceKeys = {
	all: ["services"] as const,
	tags: ["service-tags"] as const,
};

/* -------------------------------------------------------------------------- */
/*  Library                                                                    */
/* -------------------------------------------------------------------------- */

export const libraryKeys = {
	all: ["library"] as const,
	list: (params: Record<string, unknown>) => ["library", params] as const,
	filtering: ["library", "all-for-filtering"] as const,
	syncStatus: ["library", "sync", "status"] as const,
	episodes: (params: Record<string, unknown>) => ["library", "episodes", params] as const,
	albums: (instanceId: string, artistId: number) =>
		["library", "albums", { instanceId, artistId }] as const,
	tracks: (instanceId: string, albumId: number) =>
		["library", "tracks", { instanceId, albumId }] as const,
	books: (instanceId: string, authorId: number) =>
		["library", "books", { instanceId, authorId }] as const,
};

/* -------------------------------------------------------------------------- */
/*  TRaSH Guides                                                               */
/* -------------------------------------------------------------------------- */

export const trashGuidesKeys = {
	all: ["trash-guides"] as const,

	// Templates
	templates: {
		all: ["trash-guides", "templates"] as const,
		list: (params: Record<string, unknown>) => ["trash-guides", "templates", params] as const,
		detail: (templateId: string) => ["trash-guides", "template", templateId] as const,
		stats: (templateId: string) => ["template-stats", templateId] as const,
	},

	// Updates
	updates: {
		all: ["trash-guides", "updates"] as const,
		attention: ["trash-guides", "updates", "attention"] as const,
		latestVersion: ["trash-guides", "updates", "version", "latest"] as const,
		scheduler: ["trash-guides", "updates", "scheduler", "status"] as const,
		diff: (templateId: string, targetCommit: string) =>
			["trash-guides", "updates", "diff", templateId, targetCommit] as const,
	},

	// Instance overrides
	instanceOverrides: (templateId: string, instanceId: string) =>
		["trash-guides", "instance-overrides", templateId, instanceId] as const,

	// Deployment
	deployment: {
		all: ["trash-guides", "deployment"] as const,
		preview: (templateId: string, instanceId: string) =>
			["trash-guides", "deployment", "preview", templateId, instanceId] as const,
	},

	// Settings
	settings: ["trash-settings"] as const,
};

/* -------------------------------------------------------------------------- */
/*  Quality Profiles                                                           */
/* -------------------------------------------------------------------------- */

export const qualityProfileKeys = {
	all: ["quality-profiles"] as const,
	list: (serviceType: string) => ["quality-profiles", serviceType] as const,
	details: (serviceType: string, trashId: string) =>
		["quality-profile-details", serviceType, trashId] as const,
	overrides: (instanceId: string, qualityProfileId: string) =>
		["quality-profile-overrides", instanceId, qualityProfileId] as const,
	cfValidation: (instanceId: string, profileId: string, serviceType: string) =>
		["cf-validation", instanceId, profileId, serviceType] as const,
	profileMatch: (profileName: string, serviceType: string) =>
		["profile-match", profileName, serviceType] as const,
	clone: {
		profiles: (instanceId: string) => ["profile-clone", "profiles", instanceId] as const,
	},
};

/* -------------------------------------------------------------------------- */
/*  TRaSH Cache                                                                */
/* -------------------------------------------------------------------------- */

export const trashCacheKeys = {
	status: (serviceType?: string) => ["trash-cache-status", serviceType] as const,
	entries: (serviceType: string) => ["trash-cache-entries", serviceType] as const,
	cfIncludes: ["cf-includes"] as const,
	gitHubRateLimit: ["github-rate-limit"] as const,
	syncMetrics: ["sync-metrics"] as const,
};

/* -------------------------------------------------------------------------- */
/*  Sync                                                                       */
/* -------------------------------------------------------------------------- */

export const syncKeys = {
	progress: (syncId: string) => ["sync-progress", syncId] as const,
	history: (instanceId: string, params?: Record<string, unknown>) =>
		["sync-history", instanceId, params] as const,
	detail: (syncId: string) => ["sync-detail", syncId] as const,
};

/* -------------------------------------------------------------------------- */
/*  Deployment History                                                         */
/* -------------------------------------------------------------------------- */

export const deploymentHistoryKeys = {
	all: ["deployment-history"] as const,
	allHistory: (options?: Record<string, unknown>) =>
		["deployment-history", "all", options] as const,
	template: (templateId: string, options?: Record<string, unknown>) =>
		["deployment-history", "template", templateId, options] as const,
	instance: (instanceId: string, options?: Record<string, unknown>) =>
		["deployment-history", "instance", instanceId, options] as const,
	detail: (historyId: string) => ["deployment-history", "detail", historyId] as const,
};

/* -------------------------------------------------------------------------- */
/*  Custom Formats                                                             */
/* -------------------------------------------------------------------------- */

export const customFormatKeys = {
	all: ["custom-formats"] as const,
	user: ["user-custom-formats"] as const,
};

/* -------------------------------------------------------------------------- */
/*  Bulk Scores                                                                */
/* -------------------------------------------------------------------------- */

export const bulkScoreKeys = {
	list: (filters: Record<string, unknown>) => ["bulk-scores", filters] as const,
};

/* -------------------------------------------------------------------------- */
/*  TMDB                                                                       */
/* -------------------------------------------------------------------------- */

export const tmdbKeys = {
	all: ["tmdb"] as const,
	genres: (mediaType: string) => ["tmdb", "genres", mediaType] as const,
	similar: (mediaType: string, tmdbId: number, page: number) =>
		["tmdb", "similar", mediaType, tmdbId, page] as const,
	similarInfinite: (mediaType: string, tmdbId: number) =>
		["tmdb", "similar", "infinite", mediaType, tmdbId] as const,
	search: (mediaType: string, query: string, page: number, year?: number) =>
		["tmdb", "search", mediaType, query, page, year] as const,
	searchInfinite: (mediaType: string, query: string, year?: number) =>
		["tmdb", "search", "infinite", mediaType, query, year] as const,
	credits: (mediaType: string, tmdbId: number, aggregate?: boolean) =>
		["tmdb", "credits", mediaType, tmdbId, aggregate] as const,
	videos: (mediaType: string, tmdbId: number) =>
		["tmdb", "videos", mediaType, tmdbId] as const,
	watchProviders: (mediaType: string, tmdbId: number, region?: string) =>
		["tmdb", "watch-providers", mediaType, tmdbId, region] as const,
};

/* -------------------------------------------------------------------------- */
/*  Discover                                                                   */
/* -------------------------------------------------------------------------- */

export const discoverKeys = {
	all: ["discover"] as const,
	search: (query: string, type: string) => ["discover", "search", { query, type }] as const,
	options: (instanceId: string, type: string) =>
		["discover", "options", { instanceId, type }] as const,
	testOptions: (request: Record<string, unknown>) =>
		["discover", "test-options", request] as const,
	recommendations: (type: string, mediaType: string) =>
		["recommendations", type, mediaType] as const,
	recommendationsInfinite: (type: string, mediaType: string) =>
		["recommendations", "infinite", type, mediaType] as const,
};

/* -------------------------------------------------------------------------- */
/*  Search / Indexers                                                          */
/* -------------------------------------------------------------------------- */

export const searchKeys = {
	all: ["search"] as const,
	indexers: ["search", "indexers"] as const,
	indexerDetails: (instanceId: string, indexerId: number) =>
		["search", "indexers", "details", instanceId, indexerId] as const,
};

/* -------------------------------------------------------------------------- */
/*  Feature Singletons                                                         */
/* -------------------------------------------------------------------------- */

export const oidcKeys = {
	provider: ["oidc-provider"] as const,
};

export const queueCleanerKeys = {
	all: ["queue-cleaner"] as const,
};

export const huntingKeys = {
	all: ["hunting"] as const,
};

export const backupKeys = {
	all: ["backups"] as const,
	settings: ["backup-settings"] as const,
	passwordStatus: ["backup-password-status"] as const,
};

export const systemKeys = {
	settings: ["system-settings"] as const,
};

/* -------------------------------------------------------------------------- */
/*  Backward-compatible constants                                              */
/*  These match the old per-file `const X_QUERY_KEY` pattern.                  */
/*  Prefer the namespaced versions above for new code.                         */
/* -------------------------------------------------------------------------- */

export const QUEUE_QUERY_KEY = dashboardKeys.queue;
export const TEMPLATES_QUERY_KEY = trashGuidesKeys.templates.all;
export const SERVICES_QUERY_KEY = serviceKeys.all;
export const TAGS_QUERY_KEY = serviceKeys.tags;
