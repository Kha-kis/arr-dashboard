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
 * `health` is the friendly mapping the UI renders.
 */
export const quiTrackerSchema = z.object({
	url: z.string(),
	status: z.number().int(),
	health: quiTrackerHealthSchema,
	msg: z.string().default(""),
	numSeeds: z.number().int().default(0),
	numLeeches: z.number().int().default(0),
	numPeers: z.number().int().default(0),
	tier: z.number().int(),
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
