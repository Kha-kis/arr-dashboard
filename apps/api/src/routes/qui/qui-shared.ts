import { quiActionSchema } from "@arr/shared";
import { z } from "zod";
import { createQuiClient } from "../../lib/qui/client-factory.js";
import { extractHostnameSafe } from "../../lib/qui/client-helpers.js";

export const HASH_PARAM = z.object({
	hash: z.string().regex(/^[a-fA-F0-9]{40,64}$/, "Invalid info hash"),
});
export const INSTANCE_HASH_PARAMS = z.object({
	instanceId: z.string().min(1),
	hash: z.string().regex(/^[a-fA-F0-9]{40,64}$/, "Invalid info hash"),
});
export const QUI_INSTANCE_PARAM = z.object({ id: z.string().min(1) });
export const TEST_BODY = z.object({
	baseUrl: z.string().url(),
	apiKey: z.string().min(8),
});

/**
 * Cross-Seed Discovery scan query (Phase 3.1). Cursor is the LibraryCache.id
 * of the last row scanned in the previous batch; null/undefined starts from
 * the beginning. batchSize is clamped server-side to a sane range.
 */
export const DISCOVERY_QUERY = z.object({
	cursor: z.string().min(1).optional(),
	batchSize: z.coerce.number().int().positive().optional(),
});

/**
 * Activity feed query (Phase 3.2). Cursor is the activity log row id
 * AFTER which to fetch; null starts from the most recent. limit clamped
 * to keep individual responses bounded.
 */
export const ACTIVITY_QUERY = z.object({
	cursor: z.string().min(1).optional(),
	limit: z.coerce.number().int().positive().max(200).optional(),
	eventType: z.string().min(1).optional(),
});

/**
 * Action route params (Phase 4.1). `id` is the qui ServiceInstance, `instanceId`
 * is qui's qBit instance numeric id, `hash` is the torrent info hash, and
 * `action` is one of arr-dashboard's supported qui mutation verbs.
 */
export const ACTION_PARAMS = z.object({
	id: z.string().min(1),
	instanceId: z.string().min(1),
	hash: z.string().regex(/^[a-fA-F0-9]{40,64}$/, "Invalid info hash"),
	action: quiActionSchema,
});

/**
 * Bulk-action route params (Phase 4.2). Same as ACTION_PARAMS without `hash` —
 * the body carries `hashes[]` instead.
 */
export const BULK_ACTION_PARAMS = z.object({
	id: z.string().min(1),
	instanceId: z.string().min(1),
	action: quiActionSchema,
});

/**
 * Action log feed query (Phase 4.1). Same pagination shape as ACTIVITY_QUERY
 * so the frontend "My Actions" tab can mirror Phase 3.2's interaction model.
 */
export const ACTION_LOG_QUERY = z.object({
	cursor: z.string().min(1).optional(),
	limit: z.coerce.number().int().positive().max(200).optional(),
	action: quiActionSchema.optional(),
	status: z.enum(["pending", "success", "failed"]).optional(),
});

// ─── Shared types + helpers for the cluster-based panel endpoints ─────
//
// The series-torrents and movie-torrents routes both produce the same
// ClusterCopy shape per torrent (per-tracker peers, role classification,
// live speeds, etc). Extracting the shared enrichment into a module-scope
// function avoids duplicating ~140 lines between the two routes — and
// guarantees both stay in lockstep when we evolve the trust signals.

export interface PerTrackerInfo {
	hostname: string;
	health: "working" | "updating" | "not_contacted" | "disabled" | "not_working" | "unknown";
	numSeeds: number;
	numLeechs: number;
	numPeers: number;
	tier: number | null;
	/** Raw qBit status msg — used for unregistered/banned detection. NOT sent to client. */
	_msg?: string;
}

export interface PeerSources {
	dht: boolean;
	pex: boolean;
	lsd: boolean;
}

export interface ClusterCopy {
	infoHash: string;
	name: string | null;
	state: string | null;
	category: string | null;
	role: "library" | "cross-seed";
	tracker: string | null;
	trackerHostnames: string[];
	trackers: Omit<PerTrackerInfo, "_msg">[];
	trackerHealth: "unregistered" | "tracker_down" | null;
	peerSources: PeerSources;
	ratio: number | null;
	savePath: string | null;
	tags: string[];
	addedOn: number | null;
	seedingTime: number | null;
	torrentSizeBytes: string | null;
	numSeeds: number | null;
	numLeechs: number | null;
	progress: number | null;
	dlSpeedBps: number | null;
	upSpeedBps: number | null;
	instanceName: string | null;
	/**
	 * qBit instance ID (numeric) for this torrent — needed to address it
	 * for qui actions like pause/resume/recheck/reannounce. Null when
	 * qui's response didn't include an instance ID (rare edge case in
	 * legacy single-instance setups).
	 */
	qbitInstanceId: number | null;
	/**
	 * qui ServiceInstance ID (cuid) we used to fetch this torrent's data.
	 * Combined with qbitInstanceId, this is the addressing tuple for any
	 * action mutation (`POST /qui/instances/:id/qbit/:instanceId/torrents/:hash/actions/:action`).
	 */
	quiInstanceId: string | null;
	quiUnreachable: boolean;
}

// Canonical home is the lib layer (lib/qui/client-helpers) so the
// client-factory transform can share it without a routes→lib import.
// Re-exported here for the route consumers that already import it.
export { extractHostnameSafe };

export function buildUnreachableCopy(hash: string): ClusterCopy {
	return {
		infoHash: hash,
		name: null,
		state: null,
		category: null,
		role: "library",
		tracker: null,
		trackerHostnames: [],
		trackers: [],
		trackerHealth: null,
		peerSources: { dht: false, pex: false, lsd: false },
		ratio: null,
		savePath: null,
		tags: [],
		addedOn: null,
		seedingTime: null,
		torrentSizeBytes: null,
		numSeeds: null,
		numLeechs: null,
		progress: null,
		dlSpeedBps: null,
		upSpeedBps: null,
		instanceName: null,
		qbitInstanceId: null,
		quiInstanceId: null,
		quiUnreachable: true,
	};
}

/**
 * Enrich a set of torrent hashes into ClusterCopy[] using the
 * authoritative qui sources:
 *   - `getTorrentByHash` for state/category/savePath/speeds/etc.
 *   - `getTrackers` for per-tracker peer counts, health, and the
 *     DHT/PeX/LSD discovery-source flags (respecting qBit's
 *     `health: "disabled"` to avoid false positives on private torrents).
 *
 * Each hash is fetched in parallel — Promise.all over `hashes`. Per-hash
 * failures are caught and emitted as `buildUnreachableCopy` entries so
 * one bad torrent doesn't fail the whole panel.
 *
 * `quiInstance` is optional: when null (no qui instance configured for
 * the user), every hash returns an unreachable copy. The caller surfaces
 * an `fs_unavailable` action item in that case.
 */
export async function enrichTorrentHashes(args: {
	app: import("fastify").FastifyInstance;
	quiInstance: Awaited<
		ReturnType<import("../../lib/prisma.js").PrismaClient["serviceInstance"]["findFirst"]>
	> | null;
	hashes: Iterable<string>;
	log: import("fastify").FastifyBaseLogger;
}): Promise<Map<string, ClusterCopy>> {
	const { app, quiInstance, hashes, log } = args;
	const enrichedCopies = new Map<string, ClusterCopy>();
	const hashArr = Array.from(hashes);
	if (!quiInstance) {
		for (const hash of hashArr) enrichedCopies.set(hash, buildUnreachableCopy(hash));
		return enrichedCopies;
	}
	const UNREGISTERED_RX = /unregistered|not registered|not found|banned|forbidden/i;
	await Promise.all(
		hashArr.map(async (hash) => {
			try {
				const client = createQuiClient(app, quiInstance);
				const torrent = await client.getTorrentByHash(hash);
				if (!torrent) {
					enrichedCopies.set(hash, buildUnreachableCopy(hash));
					return;
				}

				const perTrackerInfo: PerTrackerInfo[] = [];
				let trackerHostnames: string[] = [];
				const peerSources: PeerSources = { dht: false, pex: false, lsd: false };
				if (typeof torrent.instanceId === "number") {
					try {
						const trackers = await client.getTrackers(torrent.instanceId, hash);
						for (const t of trackers) {
							if (t.url.startsWith("** ")) {
								// Pseudo-tracker entries are always present; check health
								// to determine actual participation. `disabled` = inert
								// (private torrent, global setting off, per-torrent off).
								if (t.health === "disabled") continue;
								const lower = t.url.toLowerCase();
								if (lower.includes("dht")) peerSources.dht = true;
								if (lower.includes("pex")) peerSources.pex = true;
								if (lower.includes("lsd")) peerSources.lsd = true;
								continue;
							}
							const hostname = extractHostnameSafe(t.url);
							if (!hostname) continue;
							perTrackerInfo.push({
								hostname,
								health: t.health,
								numSeeds: t.numSeeds,
								numLeechs: t.numLeeches,
								numPeers: t.numPeers,
								tier: typeof t.tier === "number" ? t.tier : null,
								_msg: t.msg,
							});
						}
						trackerHostnames = perTrackerInfo.map((t) => t.hostname);
					} catch (trackerErr) {
						log.debug(
							{ err: trackerErr, hash, instanceId: torrent.instanceId },
							"qui cluster-enrichment: getTrackers failed; tracker fields empty",
						);
					}
				}

				let aggregateHealth: ClusterCopy["trackerHealth"] = null;
				for (const t of perTrackerInfo) {
					if (t.health !== "not_working") continue;
					const looksUnregistered = t._msg ? UNREGISTERED_RX.test(t._msg) : false;
					if (looksUnregistered) {
						aggregateHealth = "unregistered";
						break;
					}
					aggregateHealth = "tracker_down";
				}
				const publicTrackers = perTrackerInfo.map(({ _msg, ...rest }) => {
					void _msg;
					return rest;
				});

				const category = torrent.category || null;
				const linksMatch = (torrent.savePath ?? "").match(/\/links\/([^/]+)/);
				const tracker = linksMatch ? linksMatch[1]! : null;
				const lowerCategory = (category ?? "").toLowerCase();
				const isPathCrossSeed = linksMatch !== null;
				const isCategoryCrossSeed =
					lowerCategory.includes("cross-seed") || lowerCategory.endsWith(".cross");
				const role: ClusterCopy["role"] =
					isPathCrossSeed || isCategoryCrossSeed ? "cross-seed" : "library";
				enrichedCopies.set(hash, {
					infoHash: hash,
					name: torrent.name ?? null,
					state: torrent.state ?? null,
					category,
					role,
					tracker,
					trackerHostnames,
					trackers: publicTrackers,
					trackerHealth: aggregateHealth,
					peerSources,
					ratio: typeof torrent.ratio === "number" ? torrent.ratio : null,
					savePath: torrent.savePath ?? null,
					tags: Array.isArray(torrent.tags) ? torrent.tags : [],
					addedOn: torrent.addedOn && torrent.addedOn > 0 ? torrent.addedOn : null,
					seedingTime:
						typeof torrent.seedingTime === "number" && torrent.seedingTime > 0
							? torrent.seedingTime
							: null,
					torrentSizeBytes: typeof torrent.size === "number" ? torrent.size.toString() : null,
					numSeeds: typeof torrent.numSeeds === "number" ? torrent.numSeeds : null,
					numLeechs: typeof torrent.numLeechs === "number" ? torrent.numLeechs : null,
					progress: typeof torrent.progress === "number" ? torrent.progress : null,
					dlSpeedBps: typeof torrent.dlSpeed === "number" ? torrent.dlSpeed : null,
					upSpeedBps: typeof torrent.upSpeed === "number" ? torrent.upSpeed : null,
					instanceName: torrent.instanceName ?? null,
					qbitInstanceId: typeof torrent.instanceId === "number" ? torrent.instanceId : null,
					quiInstanceId: quiInstance.id,
					quiUnreachable: false,
				});
			} catch (err) {
				log.debug(
					{ err, hash, quiInstanceId: quiInstance.id },
					"qui cluster-enrichment: per-hash failure; using unreachable fallback",
				);
				enrichedCopies.set(hash, buildUnreachableCopy(hash));
			}
		}),
	);
	return enrichedCopies;
}

export function safeParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
