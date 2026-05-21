import { z } from "zod";

/**
 * Inline copy of the LibraryItemType enum from library.ts. We intentionally
 * DON'T `import { libraryItemTypeSchema } from "./library.js"` because
 * library.ts imports `normalizedTorrentStateSchema` from THIS file —
 * cross-importing would create a circular ESM dependency that tsx-watch
 * trips on at startup (`Cannot access 'libraryItemTypeSchema' before
 * initialization`). The enum is tiny + stable; duplicating it costs less
 * than untangling the circular.
 */
const libraryItemTypeSchemaInternal = z.enum(["movie", "series", "artist", "author"]);

// ── qui (autobrr/qui) Shared Types ──────────────────────────────────
// Wire contract between arr-dashboard's API and frontend for the qui
// integration. Backend translates raw qui responses into these shapes;
// the frontend should never see qui's API surface directly.

/**
 * qBittorrent torrent state strings (from qui's Torrent.state field).
 * `.catch("unknown")` tolerates qBit additions without breaking validation —
 * the UI degrades to a generic state pill rather than a hard parse failure.
 */
export const quiTorrentStateSchema = z
	.enum([
		"downloading",
		"uploading",
		"stalledUP",
		"stalledDL",
		"pausedUP",
		"pausedDL",
		"queuedUP",
		"queuedDL",
		"checkingUP",
		"checkingDL",
		"metaDL",
		"moving",
		"forcedUP",
		"forcedDL",
		"error",
		"missingFiles",
		"unknown",
	])
	.catch("unknown");

export type QuiTorrentState = z.infer<typeof quiTorrentStateSchema>;

/**
 * Normalized torrent state vocabulary surfaced to operators (Phase 2.1).
 * Persisted to `LibraryCache.torrentState` and used by the library filter.
 * Decoupled from qBit's raw vocabulary so the schema doesn't have to evolve
 * when qBit adds states, and so UX collapses (`stalledUP` → `seeding`) live
 * in one place.
 */
export const normalizedTorrentStateSchema = z.enum([
	"seeding",
	"downloading",
	"stalled_dl",
	"paused",
	"queued",
	"checking",
	"moving",
	"error",
	"unknown",
]);

export type NormalizedTorrentState = z.infer<typeof normalizedTorrentStateSchema>;

/**
 * Map raw qBit torrent state to the normalized vocabulary.
 *
 * Why `stalledUP` → `seeding`: qBit's `stalledUP` means "complete + in seed
 * pool, no peer actively pulling right now" — the resting state of any
 * well-seeded torrent. Calling it "stalled" misleads media-stack operators
 * into thinking something's broken. `stalledDL`, however, IS a real problem
 * (download stuck) so it stays distinct as `stalled_dl`.
 */
export const normalizeTorrentState = (raw: string | null | undefined): NormalizedTorrentState => {
	switch (raw) {
		case "uploading":
		case "forcedUP":
		case "stalledUP":
			return "seeding";
		case "downloading":
		case "forcedDL":
		case "metaDL":
			return "downloading";
		case "stalledDL":
			return "stalled_dl";
		case "pausedUP":
		case "pausedDL":
			return "paused";
		case "queuedUP":
		case "queuedDL":
			return "queued";
		case "checkingUP":
		case "checkingDL":
			return "checking";
		case "moving":
			return "moving";
		case "error":
		case "missingFiles":
			return "error";
		default:
			return "unknown";
	}
};

/**
 * Friendly tracker health, derived in the backend mapper from qBit's int status (0–4).
 * 0 = disabled, 1 = not contacted, 2 = working, 3 = updating, 4 = not working.
 */
export const quiTrackerHealthSchema = z.enum([
	"disabled",
	"not_contacted",
	"working",
	"updating",
	"not_working",
	"unknown",
]);

export type QuiTrackerHealth = z.infer<typeof quiTrackerHealthSchema>;

/** Cross-seed match type — confidence varies by source. */
export const quiCrossSeedMatchTypeSchema = z.enum(["content_path", "name", "release"]);

export type QuiCrossSeedMatchType = z.infer<typeof quiCrossSeedMatchTypeSchema>;

/**
 * A torrent record as surfaced to the frontend.
 * `instanceId` / `instanceName` are populated when the torrent is fetched via the
 * cross-instance endpoint; absent on per-instance lookups.
 */
export const quiTorrentSchema = z.object({
	hash: z.string(),
	name: z.string(),
	state: quiTorrentStateSchema,
	ratio: z.number(),
	progress: z.number().min(0).max(1),
	numSeeds: z.number().int(),
	numLeechs: z.number().int(),
	tags: z.array(z.string()).default([]),
	category: z.string().default(""),
	savePath: z.string(),
	addedOn: z.number().int(),
	completedOn: z.number().int().nullable(),
	seedingTime: z.number().int().default(0),
	eta: z.number().int(),
	dlSpeed: z.number().int(),
	upSpeed: z.number().int(),
	priority: z.number().int(),
	size: z.number().int(),
	instanceId: z.number().int().optional(),
	instanceName: z.string().optional(),
});

export type QuiTorrent = z.infer<typeof quiTorrentSchema>;

/** Extended properties for a single torrent (lazy-loaded — not in list payloads). */
export const quiTorrentPropertiesSchema = z.object({
	additionDate: z.number().int(),
	completionDate: z.number().int(),
	comment: z.string().default(""),
	totalSize: z.number().int(),
	totalDownloaded: z.number().int(),
	totalUploaded: z.number().int(),
	shareRatio: z.number(),
	uploadSpeed: z.number().int(),
	downloadSpeed: z.number().int(),
	uploadLimit: z.number().int(),
	downloadLimit: z.number().int(),
	seedsActual: z.number().int(),
	peersActual: z.number().int(),
	eta: z.number().int(),
	// Share-limit fields. Sentinel values mirror qBit's wire format:
	//   `-1` = no limit, `-2` = use the global default. Treat both as
	//   "unset" in UI but persist as-is so the operator can distinguish.
	ratioLimit: z.number().default(-2),
	seedingTimeLimit: z.number().int().default(-2),
	inactiveSeedingTimeLimit: z.number().int().default(-2),
	savePath: z.string().default(""),
});

export type QuiTorrentProperties = z.infer<typeof quiTorrentPropertiesSchema>;

/**
 * One file inside a torrent. Maps to qBit's per-file inventory; surfaced
 * by qui at `GET /api/instances/:id/torrents/:hash/files`. The `priority`
 * field uses qBit's int codes (0 = do not download, 1 = normal, 6 = high,
 * 7 = maximum). `progress` is 0-1.
 */
export const quiTorrentFileSchema = z.object({
	index: z.number().int(),
	name: z.string(),
	size: z.number().int(),
	progress: z.number().min(0).max(1),
	priority: z.number().int(),
	isSeeding: z.boolean().optional(),
});

export type QuiTorrentFile = z.infer<typeof quiTorrentFileSchema>;

/**
 * MediaInfo report for one file inside a torrent, from qui's
 * `GET /api/instances/:id/torrents/:hash/files/:index/mediainfo`. qui runs
 * MediaInfo against the file on disk, so this only works when qui has local
 * filesystem access to the torrent's data.
 *
 * `streams` is MediaInfo's native shape: each stream has a `kind`
 * ("General" / "Video" / "Audio" / "Text" / …) and a free-form list of
 * `{ name, value }` fields ("Width" → "1 920 pixels", "Format" → "AVC", …).
 * It is deliberately untyped beyond name/value strings — MediaInfo's field
 * set varies by container/codec, and arr-dashboard only reads a few keys.
 */
export const quiMediaInfoStreamSchema = z.object({
	kind: z.string(),
	fields: z.array(z.object({ name: z.string(), value: z.string() })),
});

export const quiMediaInfoSchema = z.object({
	fileIndex: z.number().int(),
	relativePath: z.string(),
	streams: z.array(quiMediaInfoStreamSchema),
});

export type QuiMediaInfo = z.infer<typeof quiMediaInfoSchema>;

/**
 * One torrent in qui's reannounce monitoring scope, from
 * `GET /api/instances/:id/reannounce/candidates`. qui watches torrents
 * that have a tracker problem or are still waiting for their first tracker
 * contact, and retries their announces. arr-dashboard reads
 * `hasTrackerProblem` as a precise "stuck at the tracker" signal — a root
 * cause a generic "stalled" torrent state can't express. `.passthrough()`
 * keeps the schema lenient toward fields we don't consume.
 */
export const quiMonitoredTorrentSchema = z
	.object({
		hash: z.string(),
		torrentName: z.string().default(""),
		hasTrackerProblem: z.boolean().default(false),
		waitingForInitial: z.boolean().default(false),
		timeActiveSeconds: z.number().int().default(0),
	})
	.passthrough();

export type QuiMonitoredTorrent = z.infer<typeof quiMonitoredTorrentSchema>;

/**
 * Per-instance feature-support flags. qui derives these from the connected
 * qBittorrent's WebAPI version — older qBit builds lack tracker editing,
 * share-limit actions, etc. Surfaced at `GET /api/instances/:id/capabilities`.
 * The UI gates action affordances on these so it never offers a control the
 * backend qBit can't honor.
 *
 * Every flag defaults to `false`: a missing flag is treated as "unsupported",
 * the conservative choice — better to hide a usable action than to surface
 * one that errors on click. `.passthrough()` keeps the schema lenient toward
 * flags qui adds in future versions.
 */
export const quiCapabilitiesSchema = z
	.object({
		supportsTorrentCreation: z.boolean().default(false),
		supportsTorrentExport: z.boolean().default(false),
		supportsSetTags: z.boolean().default(false),
		supportsTrackerHealth: z.boolean().default(false),
		supportsTrackerEditing: z.boolean().default(false),
		supportsRenameTorrent: z.boolean().default(false),
		supportsRenameFile: z.boolean().default(false),
		supportsRenameFolder: z.boolean().default(false),
		supportsFilePriority: z.boolean().default(false),
		supportsSubcategories: z.boolean().default(false),
		subcategoriesAlwaysEnabled: z.boolean().default(false),
		supportsTorrentTmpPath: z.boolean().default(false),
		supportsPathAutocomplete: z.boolean().default(false),
		supportsFreeSpacePathSource: z.boolean().default(false),
		supportsSetRSSFeedURL: z.boolean().default(false),
		supportsShareLimitsAction: z.boolean().default(false),
		supportsShareLimitsMode: z.boolean().default(false),
		webAPIVersion: z.string().optional(),
	})
	.passthrough();

export type QuiCapabilities = z.infer<typeof quiCapabilitiesSchema>;

/**
 * Live transfer stats for one qBittorrent instance — qBit's `transfer/info`.
 * Speeds are bytes/sec; data totals are session bytes. Surfaced (aggregated
 * across instances) on the qui home KPI strip.
 */
export const quiTransferInfoSchema = z.object({
	dlSpeed: z.number().int(),
	upSpeed: z.number().int(),
	dlData: z.number().int(),
	upData: z.number().int(),
	dhtNodes: z.number().int(),
	connectionStatus: z.string(),
});

export type QuiTransferInfo = z.infer<typeof quiTransferInfoSchema>;

/**
 * Tracker entry for a torrent. `status` is the raw qBit int (kept for diagnostics);
 * `health` is the friendly mapping the UI renders. `tier` is optional because
 * qui omits it for pseudo-trackers like DHT/PeX/LSD.
 */
export const quiTrackerSchema = z.object({
	url: z.string(),
	status: z.number().int(),
	health: quiTrackerHealthSchema,
	msg: z.string().default(""),
	numSeeds: z.number().int().default(0),
	numLeeches: z.number().int().default(0),
	numPeers: z.number().int().default(0),
	tier: z.number().int().optional(),
});

export type QuiTracker = z.infer<typeof quiTrackerSchema>;

/**
 * A torrent that qui has identified as a cross-seed sibling of another torrent.
 * `trackerHealth` is only present when the tracker reports a problem; `matchType`
 * communicates how confidently qui matched it.
 */
export const quiCrossSeedMatchSchema = z.object({
	hash: z.string(),
	name: z.string(),
	instanceId: z.number().int(),
	instanceName: z.string(),
	state: z.string(),
	progress: z.number().min(0).max(1),
	size: z.number().int(),
	category: z.string().default(""),
	savePath: z.string(),
	contentPath: z.string(),
	tracker: z.string(),
	trackerHealth: z.enum(["unregistered", "tracker_down"]).optional(),
	matchType: quiCrossSeedMatchTypeSchema,
	tags: z.string().default(""),
});

export type QuiCrossSeedMatch = z.infer<typeof quiCrossSeedMatchSchema>;

/**
 * A qBittorrent instance as known to qui. `hasLocalFilesystemAccess` gates
 * features like hardlink detection — surface to the UI when relevant.
 */
export const quiInstanceSchema = z.object({
	id: z.number().int(),
	name: z.string(),
	host: z.string().url(),
	connected: z.boolean(),
	hasLocalFilesystemAccess: z.boolean(),
	useHardlinks: z.boolean(),
	useReflinks: z.boolean(),
	hardlinkBaseDir: z.string().nullable(),
	isActive: z.boolean(),
});

export type QuiInstance = z.infer<typeof quiInstanceSchema>;

/** Connection-test result returned by the backend's qui health endpoint. */
export const quiConnectionTestResultSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true) }),
	z.object({ ok: z.literal(false), reason: z.string() }),
]);

export type QuiConnectionTestResult = z.infer<typeof quiConnectionTestResultSchema>;

// ── Phase 3.1 — Cross-Seed Discovery ────────────────────────────────
// Shapes for the Cross-Seed Discovery page. The backend walks the user's
// LibraryCache rows with infoHash, joins against qui's torrent list once
// per batch, then resolves cross-seed siblings per item. Each response
// represents a single scan batch; the frontend stitches batches via the
// returned `nextCursor`.

/** One library item that has at least one cross-seed sibling in qui. */
export const crossSeedDiscoveryItemSchema = z.object({
	/** LibraryCache row id (frontend uses this as React key + nextCursor anchor) */
	libraryCacheId: z.string(),
	/** *arr instance owning the library item */
	arrInstanceId: z.string(),
	arrInstanceLabel: z.string(),
	arrService: z.enum(["sonarr", "radarr", "lidarr", "readarr"]),
	/** Library item display fields — kept minimal to keep the payload small */
	itemType: z.enum(["movie", "series", "artist", "author"]),
	arrItemId: z.number().int(),
	title: z.string(),
	year: z.number().int().nullable(),
	/** Primary torrent (the one *arr grabbed) — null when qui no longer knows it */
	primary: z
		.object({
			hash: z.string(),
			qbitInstanceId: z.number().int(),
			qbitInstanceName: z.string(),
			state: quiTorrentStateSchema,
			ratio: z.number(),
			tracker: z.string().nullable(),
		})
		.nullable(),
	/** Cross-seed siblings — sorted by qui in match-confidence order */
	siblings: z.array(quiCrossSeedMatchSchema),
});

export type CrossSeedDiscoveryItem = z.infer<typeof crossSeedDiscoveryItemSchema>;

/**
 * Single batch of the cross-seed discovery scan. Scan honesty: we report
 * how many rows we scanned this batch and how many had siblings, so the
 * frontend can show "scanned 200 items, 12 with siblings" — operators can
 * judge coverage without hidden surprises.
 */
export const crossSeedDiscoveryResponseSchema = z.object({
	/** Items found in THIS batch (empty array is valid; not all batches find siblings) */
	items: z.array(crossSeedDiscoveryItemSchema),
	/** LibraryCache.id of the last scanned row — pass back as cursor for the next batch */
	nextCursor: z.string().nullable(),
	/** Number of LibraryCache rows scanned in this batch (≤ scanBatchSize) */
	scannedThisBatch: z.number().int(),
	/** Number of items in this batch that had ≥1 sibling */
	foundThisBatch: z.number().int(),
	/** Total scanned across this scan session — frontend accumulates */
	totalScanned: z.number().int(),
	/** Total found across this scan session — frontend accumulates */
	totalFound: z.number().int(),
	/** True when no more rows remain to scan */
	exhausted: z.boolean(),
	/** Display name of the qui instance the scan used */
	quiInstanceLabel: z.string(),
	/**
	 * Number of LibraryCache rows we tried to scan in this batch but
	 * couldn't because qui returned an error for the sibling lookup.
	 * Surfacing this lets the frontend render "scanned 200, 12 with
	 * siblings, 3 unreachable" — without it, operators can't tell a
	 * "no siblings found" from a "we tried and qui errored" answer.
	 * Optional for one release window to keep older API clients valid.
	 */
	siblingFetchErrors: z.number().int().optional(),
});

export type CrossSeedDiscoveryResponse = z.infer<typeof crossSeedDiscoveryResponseSchema>;

/**
 * Service-availability response for the discovery page. When `available`
 * is false, the page renders an empty state with `reason` instead of
 * attempting a scan.
 */
export const crossSeedDiscoveryAvailabilitySchema = z.discriminatedUnion("available", [
	z.object({
		available: z.literal(true),
		quiInstanceId: z.string(),
		quiInstanceLabel: z.string(),
		/** Total LibraryCache rows with a backfilled infoHash (the scan universe) */
		scanCandidates: z.number().int(),
	}),
	z.object({
		available: z.literal(false),
		reason: z.enum(["no_qui_instance", "no_correlated_items"]),
	}),
]);

export type CrossSeedDiscoveryAvailability = z.infer<typeof crossSeedDiscoveryAvailabilitySchema>;

// ── Phase 3.2 — qui Activity Log ────────────────────────────────────
// Discrete events from arr-dashboard's qui-related operations, emitted
// by scheduler ticks and gate firings. The frontend renders them as a
// chronological feed on the /qui-activity page.

/** Detail payload for `qui_sync_complete` events. */
export const quiSyncCompleteDetailsSchema = z.object({
	instancesScanned: z.number().int(),
	torrentsSeen: z.number().int(),
	rowsUpdated: z.number().int(),
	rowsCleared: z.number().int(),
	errors: z.number().int(),
	durationMs: z.number().int(),
});

export type QuiSyncCompleteDetails = z.infer<typeof quiSyncCompleteDetailsSchema>;

/** Detail payload for `qui_backfill_complete` events. */
export const quiBackfillCompleteDetailsSchema = z.object({
	itemsScanned: z.number().int(),
	itemsUpdated: z.number().int(),
	itemsWithoutHash: z.number().int(),
	durationMs: z.number().int(),
});

export type QuiBackfillCompleteDetails = z.infer<typeof quiBackfillCompleteDetailsSchema>;

/**
 * One activity log row as surfaced to the frontend. `details` is the
 * pre-parsed JSON payload — server side stores it as a string column,
 * the API layer parses before returning. `eventType` is open string so
 * new emitters can land without a shared-schema bump; the frontend
 * gracefully degrades to a generic row for unknown types.
 */
/**
 * Activity-event severity. Distinct vocabulary from `quiActionStatusSchema`
 * (which describes the lifecycle of an operator-initiated mutation —
 * pending/success/failed). Mixing the two names confuses readers and made
 * the qui-activity surface ambiguous about which kind of "status" it
 * displayed in each tab. The wire field is now `severity` everywhere; the
 * DB column stays `status` via Prisma `@map` so existing rows survive.
 *
 * The reply on the wire ALSO exposes the original `status` field for one
 * release window so any external consumers cutting over have time. Drop
 * the alias in v3.0+ — tracked in qui-integration-arc.md.
 */
export const quiActivityEventSchema = z.object({
	id: z.string(),
	eventType: z.string(),
	severity: z.enum(["ok", "warn", "error"]),
	/** @deprecated Use `severity`. Aliased for one release window. */
	status: z.enum(["ok", "warn", "error"]).optional(),
	createdAt: z.string(),
	/** Canonical timestamp field — same value as `createdAt`. Aliased so
	 * frontend cursor logic doesn't have to remember per-feed field names. */
	timestamp: z.string().optional(),
	details: z.unknown(),
});

export type QuiActivityEvent = z.infer<typeof quiActivityEventSchema>;

/** Paginated response for `GET /api/qui/activity`. */
export const quiActivityFeedResponseSchema = z.object({
	events: z.array(quiActivityEventSchema),
	nextCursor: z.string().nullable(),
});

export type QuiActivityFeedResponse = z.infer<typeof quiActivityFeedResponseSchema>;

// ── Phase 4 — Action audit log (arr-dashboard-initiated mutations) ─────
// Distinct from QuiActivityEvent above: that surface records *observed*
// qui automation events (sync ticks, gate firings). The schemas below
// represent *intentional* mutations the operator triggered through
// arr-dashboard — pause, resume, recheck, reannounce, tag changes — so
// the operator has a tamper-evident record of every change arr-dashboard
// made against their qui instances.

/**
 * Action vocabulary mirroring qui's bulk-action `action` enum. Despite the
 * name `bulk-action`, qui uses this endpoint as the single transport for
 * most per-torrent mutations (the `hashes[]` array can be length-1).
 *
 * Each action's payload requirements are declared separately via
 * `quiActionPayloadSchemas` below — the route layer looks up the right
 * schema by action and validates the body. This keeps "wrong field with
 * wrong action" a compile-time rather than runtime concern.
 */
export const quiActionSchema = z.enum([
	"pause",
	"resume",
	"recheck",
	"reannounce",
	"setTags",
	"setCategory",
	"toggleAutoTMM",
	"forceStart",
	"topPriority",
	"bottomPriority",
	"increasePriority",
	"decreasePriority",
	"toggleSequentialDownload",
	"setUploadLimit",
	"setDownloadLimit",
	"setShareLimit",
	"setLocation",
	"delete",
]);

export type QuiAction = z.infer<typeof quiActionSchema>;

/**
 * Subset of actions that are destructive — mutate state in a way that
 * either deletes data, moves data on disk, or is otherwise expensive to
 * undo. The UI uses this to gate confirm prompts; the route layer can
 * use it to require an explicit "I know what I'm doing" header in
 * future. Today it's documentation + a single source of truth for the
 * frontend.
 */
export const QUI_DESTRUCTIVE_ACTIONS: ReadonlySet<QuiAction> = new Set<QuiAction>([
	"delete",
	"setLocation",
]);

/** Lifecycle states for a logged action. */
export const quiActionStatusSchema = z.enum(["pending", "success", "failed"]);

export type QuiActionStatus = z.infer<typeof quiActionStatusSchema>;

/**
 * Wire format for a qBit info hash — SHA-1 (40 hex) or SHA-256 (64 hex).
 * Used both in URL params (single-action) AND as a per-element guard for
 * bulk-action `hashes[]`. Centralizing prevents the asymmetry that earlier
 * versions had: single-action validated the hash regex, bulk-action only
 * required `min(1)`, so bulk could pass garbage strings through to qui +
 * the audit log.
 */
export const quiInfoHashSchema = z
	.string()
	.regex(/^[a-fA-F0-9]{40,64}$/, "expected 40-64 hex characters (qBit info hash)");

/**
 * Per-call cap on `hashes[]` for bulk actions. 500 is the documented
 * scaling boundary for the audit-log `$transaction([create, …])` pattern
 * — beyond this, one bulk request can stall other DB writes by holding
 * the write lock too long. The constant is exported so both the route
 * boundary (Zod) AND the frontend selection toolbar can refuse the
 * over-quota case with matching copy.
 */
export const QUI_BULK_HASH_CAP = 500;

/**
 * Upper bound on the per-action `tags` string. qui itself accepts an
 * unbounded `tags` parameter, but our audit log stores the JSON-encoded
 * payload as a varchar column and we shouldn't let a single setTags call
 * persist megabytes of operator-supplied data. 2 KiB is comfortably
 * above any reasonable tag list while bounding worst-case row size.
 */
export const QUI_TAGS_MAX_LENGTH = 2_000;

/**
 * Per-action payload schemas. The route layer looks up the right schema
 * by URL `:action` param and validates the request body against it. Each
 * schema describes ONLY the action-specific extras — `hashes` (bulk) and
 * the target hash (single) live on URL params and a separate bulk envelope.
 *
 * Empty `z.object({})` is intentional for the "no-extras" actions: it
 * accepts `{}` and rejects unknown fields when callers paired with
 * `.strict()`, but here we stay permissive (`.passthrough()`) so a future
 * extension doesn't reject already-deployed older clients.
 */
const emptyPayload = z.object({}).passthrough();

export const quiActionPayloadSchemas = {
	pause: emptyPayload,
	resume: emptyPayload,
	recheck: emptyPayload,
	reannounce: emptyPayload,
	forceStart: emptyPayload,
	// Download-queue actions — no extras; qui's bulk-action takes just
	// `{ action, hashes }`. The drawer surfaces them only for incomplete
	// torrents (queue priority is moot once a torrent is seeding).
	topPriority: emptyPayload,
	bottomPriority: emptyPayload,
	increasePriority: emptyPayload,
	decreasePriority: emptyPayload,
	toggleSequentialDownload: emptyPayload,
	setTags: z.object({
		// Comma-joined tag list (qui's wire format — qui accepts a single
		// comma-separated string, not a JSON array). Required and non-empty.
		tags: z.string().min(1).max(QUI_TAGS_MAX_LENGTH),
	}),
	setCategory: z.object({
		// qBit category names accept any string qBit accepts. Empty string
		// is valid — it clears the category. No length cap here matches
		// qui's behavior; downstream audit log writes a JSON blob.
		category: z.string().max(200),
	}),
	toggleAutoTMM: z.object({
		enable: z.boolean(),
	}),
	setUploadLimit: z.object({
		// KB/s. 0 = no limit per qBit convention. Negative values rejected.
		uploadLimit: z.number().int().nonnegative(),
	}),
	setDownloadLimit: z.object({
		downloadLimit: z.number().int().nonnegative(),
	}),
	setShareLimit: z.object({
		// qBit sentinels: -1 = no limit, -2 = use global. Operator may set
		// only one at a time, but qui's wire format expects both fields
		// present, so require both here and let the UI fill `-2` for "leave
		// alone."
		ratioLimit: z.number(),
		seedingTimeLimit: z.number().int(),
		inactiveSeedingTimeLimit: z.number().int().optional(),
	}),
	setLocation: z.object({
		// Absolute path. qui validates the path internally (must be within
		// configured safe directories). We don't pre-validate beyond
		// non-empty + reasonable length.
		location: z.string().min(1).max(4096),
	}),
	delete: z.object({
		// Explicit because the cost difference between true and false is
		// catastrophic. Default is omitted — caller MUST decide.
		deleteFiles: z.boolean(),
	}),
} as const satisfies Record<QuiAction, z.ZodTypeAny>;

/**
 * Discriminated union of all action payloads. Used as the audit-log
 * `payload` column type; the column itself stores `JSON.stringify(payload)`.
 */
export type QuiActionPayload = {
	[K in QuiAction]: z.infer<(typeof quiActionPayloadSchemas)[K]>;
}[QuiAction];

/**
 * Bulk-action request envelope. Combines the `hashes[]` selection with
 * the action-specific payload validated above. The route handler uses
 * `quiActionPayloadSchemas[action]` to validate the entire body keyed
 * on the URL `:action` param.
 *
 * Kept as a permissive object on the wire so we can spread the payload
 * fields alongside `hashes` without nesting (matches qui's flat body
 * shape and the existing Phase 4 wire format that frontends already use).
 */
export const quiBulkActionRequestSchema = z
	.object({
		hashes: z.array(quiInfoHashSchema).min(1).max(QUI_BULK_HASH_CAP),
	})
	.passthrough();

export type QuiBulkActionRequest = z.infer<typeof quiBulkActionRequestSchema>;

// Legacy aliases kept for the frontend types package while the per-action
// schema migration lands. Resolves to the union of every per-action
// payload — callers can narrow once they know the action.
export const quiTorrentActionRequestSchema = z.unknown();
export type QuiTorrentActionRequest = QuiActionPayload | Record<string, never>;

/**
 * Defensive coercion helpers — apply when reading an `action`/`status`
 * back out of the DB. The columns are stored as plain strings (SQLite
 * has no enum support), so a stray value from an older deploy or a
 * future enum extension reaching an old client would otherwise type-lie
 * its way into the response. Falls back to "unknown" with a typed
 * sentinel so the UI can render a degraded row instead of crashing.
 */
export type QuiActionMaybeUnknown = QuiAction | "unknown";
export type QuiActionStatusMaybeUnknown = QuiActionStatus | "unknown";

const QUI_ACTION_VALUES = new Set<QuiAction>([
	"pause",
	"resume",
	"recheck",
	"reannounce",
	"setTags",
	"setCategory",
	"toggleAutoTMM",
	"forceStart",
	"topPriority",
	"bottomPriority",
	"increasePriority",
	"decreasePriority",
	"toggleSequentialDownload",
	"setUploadLimit",
	"setDownloadLimit",
	"setShareLimit",
	"setLocation",
	"delete",
]);
const QUI_ACTION_STATUS_VALUES = new Set<QuiActionStatus>(["pending", "success", "failed"]);

export function coerceQuiAction(raw: string): QuiActionMaybeUnknown {
	return QUI_ACTION_VALUES.has(raw as QuiAction) ? (raw as QuiAction) : "unknown";
}

export function coerceQuiActionStatus(raw: string): QuiActionStatusMaybeUnknown {
	return QUI_ACTION_STATUS_VALUES.has(raw as QuiActionStatus)
		? (raw as QuiActionStatus)
		: "unknown";
}

/**
 * One row of the per-user action log surfaced to the frontend "My Actions"
 * tab. Server side stores `payload` and `error` as nullable string columns;
 * the API layer parses `payload` JSON before returning if present.
 */
export const quiActionLogEntrySchema = z.object({
	id: z.string(),
	serviceInstanceId: z.string(),
	serviceInstanceLabel: z.string(),
	qbitInstanceId: z.number().int(),
	torrentHash: z.string(),
	action: quiActionSchema,
	status: quiActionStatusSchema,
	error: z.string().nullable(),
	payload: z.unknown().nullable(),
	requestedAt: z.string(),
	/** Canonical timestamp — alias for `requestedAt` so cursor consumers
	 * don't need to remember per-feed field names. See note on
	 * `quiActivityEventSchema.timestamp`. */
	timestamp: z.string().optional(),
	completedAt: z.string().nullable(),
});

export type QuiActionLogEntry = z.infer<typeof quiActionLogEntrySchema>;

/** Paginated response for `GET /api/qui/actions`. */
export const quiActionLogResponseSchema = z.object({
	entries: z.array(quiActionLogEntrySchema),
	nextCursor: z.string().nullable(),
});

export type QuiActionLogResponse = z.infer<typeof quiActionLogResponseSchema>;

// ── Phase 5 — Webhook receiver + event push ────────────────────────────
//
// qui can POST notifications to arr-dashboard. The body shape is opaque to
// us — qui has its own NotificationEvent envelope per its openapi, which
// we accept as a passthrough `unknown` and store verbatim in QuiEventLog
// for replay/debug. The narrower fields we extract (eventType, torrent
// hash when present) drive the SSE invalidation in Phase 5.2.

/**
 * Outer shape of a qui webhook POST body. qui's envelope contains an
 * event type and a payload; we don't lock the payload shape because new
 * event types land in qui without arr-dashboard schema bumps.
 */
export const quiWebhookEnvelopeSchema = z.object({
	type: z.string(),
	timestamp: z.string().optional(),
	payload: z.unknown().optional(),
});

export type QuiWebhookEnvelope = z.infer<typeof quiWebhookEnvelopeSchema>;

/**
 * Per-user webhook config surfaced to the Settings UI. `secret` is only
 * returned at generation/rotation time (write-only thereafter); the
 * `hasSecret` boolean tells the UI whether to show "rotate" vs "generate".
 */
export const quiWebhookConfigSchema = z.object({
	hasSecret: z.boolean(),
	/** Public URL operators should paste into qui's NotificationTarget. */
	webhookUrl: z.string(),
	/** Plaintext secret — returned ONLY on generate/rotate. */
	secret: z.string().optional(),
});

export type QuiWebhookConfig = z.infer<typeof quiWebhookConfigSchema>;

/** Event-log row for `GET /api/qui/events`. */
export const quiEventLogEntrySchema = z.object({
	id: z.string(),
	serviceInstanceId: z.string().nullable(),
	eventType: z.string(),
	torrentHash: z.string().nullable(),
	payload: z.unknown(),
	receivedAt: z.string(),
	/** Canonical timestamp — alias for `receivedAt`. See note on
	 * `quiActivityEventSchema.timestamp`. */
	timestamp: z.string().optional(),
});

export type QuiEventLogEntry = z.infer<typeof quiEventLogEntrySchema>;

/** Paginated event-log response. */
export const quiEventLogResponseSchema = z.object({
	entries: z.array(quiEventLogEntrySchema),
	nextCursor: z.string().nullable(),
});

export type QuiEventLogResponse = z.infer<typeof quiEventLogResponseSchema>;

// ── qui home page — Summary + Attention (single-pane-of-glass surfaces) ─

/**
 * Per-state torrent count rollup. Mirrors the operator-facing
 * vocabulary in `normalizeTorrentState`, NOT qBit's raw state strings
 * (so the frontend doesn't have to map e.g. `stalledUP` → `seeding`).
 */
export const quiSummaryByStateSchema = z.object({
	seeding: z.number().int(),
	downloading: z.number().int(),
	paused: z.number().int(),
	stalled: z.number().int(),
	error: z.number().int(),
	other: z.number().int(),
});

/**
 * Per-qBit-instance health snapshot. `connected` is the qBit ↔ qui
 * connection status that qui itself reports. `torrentCount` is the
 * count of torrents qui has for this qBit instance.
 */
export const quiSummaryQbitInstanceSchema = z.object({
	id: z.number().int(),
	name: z.string(),
	connected: z.boolean(),
	torrentCount: z.number().int(),
});

/**
 * Response shape for `GET /api/qui/summary` — drives the KPI strip
 * on the qui home page. One call, one cheap pass; refreshed on the
 * same cadence as the torrent-state-sync scheduler (10 min).
 */
export const quiSummaryResponseSchema = z.object({
	totalTorrents: z.number().int(),
	byState: quiSummaryByStateSchema,
	/** Mean ratio across all torrents (0 when there are no torrents). */
	avgRatio: z.number(),
	/** Count of torrents below the low-ratio threshold (default 1.0). */
	lowRatioCount: z.number().int(),
	/** Live aggregate download speed (bytes/sec) summed across every
	 * connected qBittorrent instance. 0 when none reachable. */
	dlSpeed: z.number().int(),
	/** Live aggregate upload speed (bytes/sec), same aggregation. */
	upSpeed: z.number().int(),
	/** ISO timestamp of the most recent successful sync, or null if
	 * never run / never succeeded. */
	lastSyncAt: z.string().nullable(),
	/** Was the most recent sync successful (errors === 0)? Null if no
	 * sync has run yet. */
	lastSyncOk: z.boolean().nullable(),
	/** Number of qui ServiceInstance rows enabled for this user. */
	configuredInstances: z.number().int(),
	/** Per-qBit-instance health. Empty when no qui instance reachable. */
	qbitInstances: z.array(quiSummaryQbitInstanceSchema),
});

export type QuiSummaryResponse = z.infer<typeof quiSummaryResponseSchema>;

/**
 * One row in the Needs Attention feed — a problematic torrent + (when
 * we have an infoHash match) its *arr library context. The frontend
 * uses this to render "your movie X has a stalled torrent" with a
 * one-click jump to the library item.
 */
export const quiAttentionItemSchema = z.object({
	hash: z.string(),
	name: z.string(),
	state: quiTorrentStateSchema,
	ratio: z.number(),
	size: z.number().int(),
	qbitInstanceId: z.number().int().nullable(),
	qbitInstanceName: z.string().nullable(),
	/** Severity ranks the row for sorting. */
	severity: z.enum(["critical", "warning"]),
	/** Short human-readable reason this torrent needs attention. */
	reason: z.string(),
	/** *arr context when we can correlate the hash to a library_cache
	 * row. Null when qui has the torrent but no *arr instance tracks it
	 * (orphans, manually-added downloads). */
	libraryContext: z
		.object({
			arrInstanceId: z.string(),
			arrInstanceLabel: z.string(),
			arrService: z.enum(["sonarr", "radarr", "lidarr", "readarr"]),
			libraryCacheId: z.string(),
			arrItemId: z.number().int(),
			itemType: libraryItemTypeSchemaInternal,
			title: z.string(),
			year: z.number().int().nullable(),
		})
		.nullable(),
});

export type QuiAttentionItem = z.infer<typeof quiAttentionItemSchema>;

/** Response shape for `GET /api/qui/attention`. */
export const quiAttentionResponseSchema = z.object({
	items: z.array(quiAttentionItemSchema),
	/** Total count across all severities — may exceed `items.length`
	 * when the route caps the response. */
	totalCount: z.number().int(),
});

export type QuiAttentionResponse = z.infer<typeof quiAttentionResponseSchema>;
