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
		diff: (templateId: string, targetCommit?: string) =>
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

	// Schedules
	schedules: {
		all: ["trash-guides", "schedules"] as const,
		byLink: (templateId: string, instanceId: string) =>
			["trash-guides", "schedules", "by-link", templateId, instanceId] as const,
	},

	// Settings
	settings: ["trash-settings"] as const,

	// Supplementary report
	supplementaryReport: (serviceType: string) => ["supplementary-report", serviceType] as const,

	// Quality Size
	qualitySize: {
		all: ["trash-guides", "quality-size"] as const,
		presets: (serviceType: string) =>
			["trash-guides", "quality-size", "presets", serviceType] as const,
		mapping: (instanceId: string) =>
			["trash-guides", "quality-size", "mapping", instanceId] as const,
		preview: (instanceId: string, presetTrashId: string) =>
			["trash-guides", "quality-size", "preview", instanceId, presetTrashId] as const,
	},
};

/* -------------------------------------------------------------------------- */
/*  Quality Profiles                                                           */
/* -------------------------------------------------------------------------- */

export const qualityProfileKeys = {
	all: ["quality-profiles"] as const,
	list: (serviceType: string) => ["quality-profiles", serviceType] as const,
	details: (serviceType: string, trashId: string) =>
		["quality-profile-details", serviceType, trashId] as const,
	overrides: (instanceId: string, qualityProfileId: number) =>
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
	allStatus: ["trash-cache-status"] as const,
	status: (serviceType?: string) => ["trash-cache-status", serviceType] as const,
	allEntries: ["trash-cache-entries"] as const,
	entries: (serviceType: string) => ["trash-cache-entries", serviceType] as const,
	cfIncludes: ["cf-includes"] as const,
	cfIncludesList: ["cf-includes", "list"] as const,
	gitHubRateLimit: ["github-rate-limit"] as const,
	syncMetrics: ["sync-metrics"] as const,
	cacheHealth: ["cache-health"] as const,
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
	list: (serviceType?: string) => ["custom-formats", "list", serviceType] as const,
	descriptions: (serviceType?: string) => ["cf-descriptions", "list", serviceType] as const,
	user: ["user-custom-formats"] as const,
	userByService: (serviceType?: string) => ["user-custom-formats", serviceType] as const,
};

/* -------------------------------------------------------------------------- */
/*  Bulk Scores                                                                */
/* -------------------------------------------------------------------------- */

export const bulkScoreKeys = {
	all: ["bulk-scores"] as const,
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
	videos: (mediaType: string, tmdbId: number) => ["tmdb", "videos", mediaType, tmdbId] as const,
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
	testOptions: (request: Record<string, unknown>) => ["discover", "test-options", request] as const,
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
/*  Notifications                                                              */
/* -------------------------------------------------------------------------- */

export const notificationKeys = {
	all: ["notifications"] as const,
	channels: ["notification-channels"] as const,
	channelTypes: ["notification-channel-types"] as const,
	subscriptions: ["notification-subscriptions"] as const,
	logs: (page: number, filters?: Record<string, string>) =>
		["notification-logs", page, filters] as const,
	rules: ["notification-rules"] as const,
	statistics: (days: number) => ["notification-statistics", days] as const,
	aggregation: ["notification-aggregation"] as const,
};

/* -------------------------------------------------------------------------- */
/*  Plex                                                                       */
/* -------------------------------------------------------------------------- */

export const plexKeys = {
	all: ["plex"] as const,
	watchEnrichment: (key: string) => ["plex", "watch-enrichment", key] as const,
	sections: () => ["plex", "sections"] as const,
	nowPlaying: () => ["plex", "now-playing"] as const,
	episodes: (instanceId: string, showTmdbId: number) =>
		["plex", "episodes", instanceId, showTmdbId] as const,
	tags: (instanceId: string) => ["plex", "tags", instanceId] as const,
	recentlyAdded: (limit: number) => ["plex", "recently-added", limit] as const,
	identity: () => ["plex", "identity"] as const,
	onDeck: () => ["plex", "on-deck"] as const,
	accounts: () => ["plex", "accounts"] as const,
	cacheHealth: () => ["plex", "cache-health"] as const,
	seriesProgress: (key: string) => ["plex", "series-progress", key] as const,
	transcodeAnalytics: (days: number) => ["plex", "transcode-analytics", days] as const,
	bandwidthAnalytics: (days: number) => ["plex", "bandwidth-analytics", days] as const,
	userAnalytics: (days: number) => ["plex", "user-analytics", days] as const,
	watchHistory: (days: number, limit: number) => ["plex", "watch-history", days, limit] as const,
	codecAnalytics: (days: number) => ["plex", "codec-analytics", days] as const,
	deviceAnalytics: (days: number) => ["plex", "device-analytics", days] as const,
	collectionStats: () => ["plex", "collection-stats"] as const,
	userEpisodeCompletion: (key: string) => ["plex", "user-episode-completion", key] as const,
	qualityScore: (days: number) => ["plex", "quality-score", days] as const,
	bandwidthForecast: (days: number) => ["plex", "bandwidth-forecast", days] as const,
	topMedia: (mediaType: string, days: number, limit: number) =>
		["plex", "top-media", mediaType, days, limit] as const,
	popularMedia: (mediaType: string, days: number, limit: number) =>
		["plex", "popular-media", mediaType, days, limit] as const,
	lastWatched: (mediaType: string, days: number, limit: number) =>
		["plex", "last-watched", mediaType, days, limit] as const,
	mostConcurrent: (days: number, limit: number) =>
		["plex", "most-concurrent", days, limit] as const,
	playsByDate: (days: number) => ["plex", "plays-by-date", days] as const,
};

/* -------------------------------------------------------------------------- */
/*  Jellyfin                                                                   */
/* -------------------------------------------------------------------------- */

export const jellyfinKeys = {
	all: ["jellyfin"] as const,
	identity: () => ["jellyfin", "identity"] as const,
	sections: () => ["jellyfin", "sections"] as const,
	watchEnrichment: (key: string) => ["jellyfin", "watch-enrichment", key] as const,
	onDeck: () => ["jellyfin", "on-deck"] as const,
	recentlyAdded: (limit: number) => ["jellyfin", "recently-added", limit] as const,
	episodes: (instanceId: string, showTmdbId: number) =>
		["jellyfin", "episodes", instanceId, showTmdbId] as const,
	accounts: () => ["jellyfin", "accounts"] as const,
	cacheHealth: () => ["jellyfin", "cache-health"] as const,
	nowPlaying: () => ["jellyfin", "now-playing"] as const,
	transcodeAnalytics: (days: number) => ["jellyfin", "analytics", "transcode", days] as const,
	bandwidthAnalytics: (days: number) => ["jellyfin", "analytics", "bandwidth", days] as const,
	userAnalytics: (days: number) => ["jellyfin", "analytics", "users", days] as const,
	watchHistory: (days: number, limit: number) =>
		["jellyfin", "analytics", "history", days, limit] as const,
	codecAnalytics: (days: number) => ["jellyfin", "analytics", "codec", days] as const,
	deviceAnalytics: (days: number) => ["jellyfin", "analytics", "devices", days] as const,
	qualityScore: (days: number) => ["jellyfin", "analytics", "quality-score", days] as const,
	bandwidthForecast: (days: number) => ["jellyfin", "analytics", "forecast", days] as const,
	seriesProgress: (key: string) => ["jellyfin", "series-progress", key] as const,
	userEpisodeCompletion: (key: string) =>
		["jellyfin", "analytics", "episode-completion", key] as const,
	topMedia: (mediaType: string, days: number, limit: number) =>
		["jellyfin", "analytics", "top-media", mediaType, days, limit] as const,
	popularMedia: (mediaType: string, days: number, limit: number) =>
		["jellyfin", "analytics", "popular-media", mediaType, days, limit] as const,
	lastWatched: (mediaType: string, days: number, limit: number) =>
		["jellyfin", "analytics", "last-watched", mediaType, days, limit] as const,
	mostConcurrent: (days: number, limit: number) =>
		["jellyfin", "analytics", "most-concurrent", days, limit] as const,
	playsByDate: (days: number) => ["jellyfin", "analytics", "plays-by-date", days] as const,
};

/* -------------------------------------------------------------------------- */
/*  Tautulli                                                                   */
/* -------------------------------------------------------------------------- */

export const tautulliKeys = {
	all: ["tautulli"] as const,
	activity: () => ["tautulli", "activity"] as const,
	stats: (timeRange: number) => ["tautulli", "stats", timeRange] as const,
	playsByDate: (timeRange: number) => ["tautulli", "plays-by-date", timeRange] as const,
	history: (length: number, start: number) => ["tautulli", "history", length, start] as const,
};

/* -------------------------------------------------------------------------- */
/*  Seerr                                                                      */
/* -------------------------------------------------------------------------- */

export const seerrKeys = {
	all: ["seerr"] as const,
	requests: (instanceId: string, params?: object) =>
		["seerr", "requests", instanceId, params] as const,
	request: (instanceId: string, requestId: number) =>
		["seerr", "request", instanceId, requestId] as const,
	requestCount: (instanceId: string) => ["seerr", "request-count", instanceId] as const,
	attention: (instanceId: string) => ["seerr", "attention", instanceId] as const,
	users: (instanceId: string, params?: object) => ["seerr", "users", instanceId, params] as const,
	userQuota: (instanceId: string, userId: number) =>
		["seerr", "user-quota", instanceId, userId] as const,
	issues: (instanceId: string, params?: object) => ["seerr", "issues", instanceId, params] as const,
	notifications: (instanceId: string) => ["seerr", "notifications", instanceId] as const,
	status: (instanceId: string) => ["seerr", "status", instanceId] as const,
	health: (instanceId: string) => ["seerr", "health", instanceId] as const,
	audit: (instanceId: string) => ["seerr", "audit", instanceId] as const,
	libraryEnrichment: (instanceId: string, tmdbIdKey: string) =>
		["seerr", "library-enrichment", instanceId, tmdbIdKey] as const,
	discover: {
		all: ["seerr", "discover"] as const,
		movies: (instanceId: string) => ["seerr", "discover", "movies", instanceId] as const,
		tv: (instanceId: string) => ["seerr", "discover", "tv", instanceId] as const,
		trending: (instanceId: string) => ["seerr", "discover", "trending", instanceId] as const,
		moviesUpcoming: (instanceId: string) =>
			["seerr", "discover", "movies-upcoming", instanceId] as const,
		tvUpcoming: (instanceId: string) => ["seerr", "discover", "tv-upcoming", instanceId] as const,
		search: (instanceId: string, query: string) =>
			["seerr", "discover", "search", instanceId, query] as const,
		movieDetails: (instanceId: string, tmdbId: number) =>
			["seerr", "discover", "movie", instanceId, tmdbId] as const,
		tvDetails: (instanceId: string, tmdbId: number) =>
			["seerr", "discover", "tv-details", instanceId, tmdbId] as const,
		genres: (instanceId: string, mediaType: "movie" | "tv") =>
			["seerr", "discover", "genres", instanceId, mediaType] as const,
		requestOptions: (instanceId: string, mediaType: "movie" | "tv") =>
			["seerr", "discover", "request-options", instanceId, mediaType] as const,
		byGenre: (instanceId: string, mediaType: "movie" | "tv", genreId: number) =>
			["seerr", "discover", "genre", instanceId, mediaType, genreId] as const,
	},
};

/* -------------------------------------------------------------------------- */
/*  Hunting                                                                    */
/* -------------------------------------------------------------------------- */

export const huntingKeys = {
	all: ["hunting"] as const,
	status: ["hunting", "status"] as const,
	configs: ["hunting", "configs"] as const,
	logs: (params?: Record<string, unknown>) => ["hunting", "logs", params] as const,
	filterOptions: (instanceId: string) => ["hunting", "filter-options", instanceId] as const,
};

/* -------------------------------------------------------------------------- */
/*  Queue Cleaner                                                              */
/* -------------------------------------------------------------------------- */

export const queueCleanerKeys = {
	all: ["queue-cleaner"] as const,
	status: ["queue-cleaner", "status"] as const,
	configs: ["queue-cleaner", "configs"] as const,
	logs: (params?: Record<string, unknown>) => ["queue-cleaner", "logs", params] as const,
	statistics: ["queue-cleaner", "statistics"] as const,
};

/* -------------------------------------------------------------------------- */
/*  Library Cleanup                                                            */
/* -------------------------------------------------------------------------- */

export const libraryCleanupKeys = {
	all: ["library-cleanup"] as const,
	fieldOptions: ["library-cleanup-field-options"] as const,
	config: ["library-cleanup-config"] as const,
	status: ["library-cleanup-status"] as const,
	statistics: (days: number) => ["library-cleanup-statistics", days] as const,
	approvalQueue: (page: number, status?: string) =>
		["library-cleanup-approvals", page, status] as const,
	logs: (page: number, filters?: Record<string, string>) =>
		["library-cleanup-logs", page, filters] as const,
};

/* -------------------------------------------------------------------------- */
/*  Validation                                                                 */
/* -------------------------------------------------------------------------- */

export const validationKeys = {
	health: ["validation-health"] as const,
	quarantine: ["validation-quarantine"] as const,
};

/* -------------------------------------------------------------------------- */
/*  Feature Singletons                                                         */
/* -------------------------------------------------------------------------- */

export const oidcKeys = {
	provider: ["oidc-provider"] as const,
};

export const backupKeys = {
	all: ["backups"] as const,
	settings: ["backup-settings"] as const,
	passwordStatus: ["backup-password-status"] as const,
};

export const systemKeys = {
	settings: ["system-settings"] as const,
	info: ["system-info"] as const,
	logs: ["system-logs"] as const,
	securityPosture: ["system-security-posture"] as const,
};

/* -------------------------------------------------------------------------- */
/*  Pulse                                                                      */
/* -------------------------------------------------------------------------- */

export const pulseKeys = {
	all: ["pulse"] as const,
	attention: () => ["pulse", "attentionOnly"] as const,
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
