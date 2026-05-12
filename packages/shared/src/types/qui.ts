import { z } from "zod";

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
});

export type QuiTorrentProperties = z.infer<typeof quiTorrentPropertiesSchema>;

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
export const quiActivityEventSchema = z.object({
	id: z.string(),
	eventType: z.string(),
	status: z.enum(["ok", "warn", "error"]),
	createdAt: z.string(),
	details: z.unknown(),
});

export type QuiActivityEvent = z.infer<typeof quiActivityEventSchema>;

/** Paginated response for `GET /api/qui/activity`. */
export const quiActivityFeedResponseSchema = z.object({
	events: z.array(quiActivityEventSchema),
	nextCursor: z.string().nullable(),
});

export type QuiActivityFeedResponse = z.infer<typeof quiActivityFeedResponseSchema>;
