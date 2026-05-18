import type { QuiAction, QuiActionPayload } from "@arr/shared";
import {
	coerceQuiAction,
	coerceQuiActionStatus,
	normalizeTorrentState,
	quiActionPayloadSchemas,
	quiActionSchema,
	quiBulkActionRequestSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import {
	runEpisodeBackfillSweep,
	runEpisodeFileSync,
} from "../lib/library-sync/episode-file-backfill.js";
import { backfillInfoHashForRow } from "../lib/library-sync/infohash-backfill.js";
import {
	buildFileIdIndex,
	getAllHashesForFileId,
} from "../lib/library-sync/infohash-backfill-by-inode.js";
import { runPathBackfillSweep } from "../lib/library-sync/infohash-backfill-by-path.js";
import { executeQuiAction } from "../lib/qui/action-service.js";
import { createQuiClient } from "../lib/qui/client-factory.js";
import { getDiscoveryAvailability, runDiscoveryBatch } from "../lib/qui/cross-seed-discovery.js";
import { quiEventBus } from "../lib/qui/event-bus.js";
import { listQuiInstances, requireQuiInstance } from "../lib/qui/instance-helpers.js";
import { generateQuiWebhookSecret } from "../lib/qui/webhook-secret.js";
import { createSseHandler } from "../lib/sse/sse-handler.js";
import { getErrorMessage } from "../lib/utils/error-message.js";
import { validateRequest } from "../lib/utils/validate.js";

const HASH_PARAM = z.object({
	hash: z.string().regex(/^[a-fA-F0-9]{40,64}$/, "Invalid info hash"),
});
const INSTANCE_HASH_PARAMS = z.object({
	instanceId: z.string().min(1),
	hash: z.string().regex(/^[a-fA-F0-9]{40,64}$/, "Invalid info hash"),
});
const QUI_INSTANCE_PARAM = z.object({ id: z.string().min(1) });
const TEST_BODY = z.object({
	baseUrl: z.string().url(),
	apiKey: z.string().min(8),
});
const TORRENT_STATE_BODY = z.object({
	arrInstanceId: z.string().min(1),
	arrItemId: z.number().int().positive(),
	itemType: z.enum(["movie", "series", "artist", "author"]),
});

/**
 * Cross-Seed Discovery scan query (Phase 3.1). Cursor is the LibraryCache.id
 * of the last row scanned in the previous batch; null/undefined starts from
 * the beginning. batchSize is clamped server-side to a sane range.
 */
const DISCOVERY_QUERY = z.object({
	cursor: z.string().min(1).optional(),
	batchSize: z.coerce.number().int().positive().optional(),
});

/**
 * Activity feed query (Phase 3.2). Cursor is the activity log row id
 * AFTER which to fetch; null starts from the most recent. limit clamped
 * to keep individual responses bounded.
 */
const ACTIVITY_QUERY = z.object({
	cursor: z.string().min(1).optional(),
	limit: z.coerce.number().int().positive().max(200).optional(),
	eventType: z.string().min(1).optional(),
});

/**
 * Action route params (Phase 4.1). `id` is the qui ServiceInstance, `instanceId`
 * is qui's qBit instance numeric id, `hash` is the torrent info hash, and
 * `action` is one of arr-dashboard's supported qui mutation verbs.
 */
const ACTION_PARAMS = z.object({
	id: z.string().min(1),
	instanceId: z.string().min(1),
	hash: z.string().regex(/^[a-fA-F0-9]{40,64}$/, "Invalid info hash"),
	action: quiActionSchema,
});

/**
 * Bulk-action route params (Phase 4.2). Same as ACTION_PARAMS without `hash` —
 * the body carries `hashes[]` instead.
 */
const BULK_ACTION_PARAMS = z.object({
	id: z.string().min(1),
	instanceId: z.string().min(1),
	action: quiActionSchema,
});

/**
 * Action log feed query (Phase 4.1). Same pagination shape as ACTIVITY_QUERY
 * so the frontend "My Actions" tab can mirror Phase 3.2's interaction model.
 */
const ACTION_LOG_QUERY = z.object({
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

interface PerTrackerInfo {
	hostname: string;
	health: "working" | "updating" | "not_contacted" | "disabled" | "not_working" | "unknown";
	numSeeds: number;
	numLeechs: number;
	numPeers: number;
	tier: number | null;
	/** Raw qBit status msg — used for unregistered/banned detection. NOT sent to client. */
	_msg?: string;
}

interface PeerSources {
	dht: boolean;
	pex: boolean;
	lsd: boolean;
}

interface ClusterCopy {
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

/**
 * Safe hostname extraction from a qBit announce URL.
 *
 * Private-tracker announce URLs include a passkey in the path or query
 * (`tracker.beyond-hd.me:2053/announce/PASSKEY` or
 * `hdbits.org/announce.php?passkey=PASSKEY`). The passkey is equivalent
 * to login credentials — leaking it in an API response or log would
 * compromise the user's tracker account.
 *
 * Returns ONLY the hostname; discards path, query, fragment, userinfo.
 * Empty string on parse failure — better to lose tracker identification
 * than to risk passkey exposure.
 */
function extractHostnameSafe(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

function buildUnreachableCopy(hash: string): ClusterCopy {
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
async function enrichTorrentHashes(args: {
	app: import("fastify").FastifyInstance;
	quiInstance: Awaited<
		ReturnType<import("../lib/prisma.js").PrismaClient["serviceInstance"]["findFirst"]>
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

/**
 * qui integration routes — read-only torrent observability for the
 * media-stack dashboard. Each handler:
 *   - resolves the user's qui ServiceInstance via requireQuiInstance
 *     (filters by userId AND service=QUI; never trust ids alone)
 *   - constructs a request-scoped client (decrypts API key, no caching)
 *   - returns canonical camelCase shapes — wire-format normalization
 *     happens inside the client at the Zod boundary
 *
 * Errors surface through QuiApiError / QuiInstanceUnreachableError, both
 * of which expose `statusCode` for the centralized error handler in
 * server.ts to map onto HTTP responses.
 */
const quiRoute: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/qui/instances", async (request, reply) => {
		const userId = request.currentUser!.id;
		const instances = await listQuiInstances(app, userId);
		return reply.send({
			instances: instances.map((i) => ({
				id: i.id,
				label: i.label,
				baseUrl: i.baseUrl,
				externalUrl: i.externalUrl,
				enabled: i.enabled,
				isDefault: i.isDefault,
			})),
		});
	});

	app.get<{ Params: { id: string } }>("/qui/instances/:id/qbit", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
		const instance = await requireQuiInstance(app, userId, id);
		const client = createQuiClient(app, instance);
		const qbitInstances = await client.listInstances();
		return reply.send({ instances: qbitInstances });
	});

	app.get<{ Params: { id: string; hash: string } }>(
		"/qui/instances/:id/torrents/by-hash/:hash",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const { hash } = validateRequest(HASH_PARAM, { hash: request.params.hash });
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			const torrent = await client.getTorrentByHash(hash);
			return reply.send({ torrent });
		},
	);

	app.get<{ Params: { id: string; instanceId: string; hash: string } }>(
		"/qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
				instanceId: request.params.instanceId,
				hash: request.params.hash,
			});
			const qbitInstanceId = Number.parseInt(instanceId, 10);
			if (!Number.isFinite(qbitInstanceId)) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			const trackers = await client.getTrackers(qbitInstanceId, hash);
			// Filter pseudo-trackers (DHT/PeX/LSD) from the visible list.
			const realTrackers = trackers.filter((t) => !t.url.startsWith("** "));
			return reply.send({ trackers: realTrackers });
		},
	);

	app.get<{ Params: { id: string; instanceId: string; hash: string } }>(
		"/qui/instances/:id/qbit/:instanceId/torrents/:hash/cross-seed",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
				instanceId: request.params.instanceId,
				hash: request.params.hash,
			});
			const qbitInstanceId = Number.parseInt(instanceId, 10);
			if (!Number.isFinite(qbitInstanceId)) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			const matches = await client.getCrossSeedMatches(qbitInstanceId, hash);
			return reply.send({ matches });
		},
	);

	// ────────────────────────────────────────────────────────────────────
	// Detail-drawer reads (Phase 6) — per-torrent properties + files
	// ────────────────────────────────────────────────────────────────────
	//
	// These power the drawer's "Status / Limits / Files" sections. Both
	// are lazy-loaded — the drawer opens with what we already have from
	// the cluster panel and fetches the heavier per-torrent details only
	// when the user expands the relevant section.

	app.get<{ Params: { id: string; instanceId: string; hash: string } }>(
		"/qui/instances/:id/qbit/:instanceId/torrents/:hash/properties",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
				instanceId: request.params.instanceId,
				hash: request.params.hash,
			});
			const qbitInstanceId = Number.parseInt(instanceId, 10);
			if (!Number.isFinite(qbitInstanceId)) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			const properties = await client.getTorrentProperties(qbitInstanceId, hash);
			return reply.send({ properties });
		},
	);

	app.get<{
		Params: { id: string; instanceId: string; hash: string };
		Querystring: { refresh?: string };
	}>("/qui/instances/:id/qbit/:instanceId/torrents/:hash/files", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
		const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
			instanceId: request.params.instanceId,
			hash: request.params.hash,
		});
		const qbitInstanceId = Number.parseInt(instanceId, 10);
		if (!Number.isFinite(qbitInstanceId)) {
			return reply.status(400).send({ error: "qbit instanceId must be numeric" });
		}
		const refresh = request.query?.refresh === "true";
		const instance = await requireQuiInstance(app, userId, id);
		const client = createQuiClient(app, instance);
		const files = await client.getTorrentFiles(qbitInstanceId, hash, { refresh });
		return reply.send({ files });
	});

	// ────────────────────────────────────────────────────────────────────
	// Detail-drawer mutations (Phase 6) — rename + tracker CRUD
	// ────────────────────────────────────────────────────────────────────
	//
	// These bypass the bulk-action transport because qui exposes them as
	// individual endpoints. Still flow through executeQuiAction for audit-
	// log uniformity? — No: those endpoints aren't in the bulk-action enum
	// vocabulary. Audit logging for these mutations lives directly in the
	// route handler via writeNonBulkActionLog (helper added below). The
	// shape stored in the audit log uses the existing QuiActionLog table
	// with synthetic `action` values prefixed `nonBulk.` to stay distinct
	// from the bulk-action enum. (See `nonBulkActionToString` below.)
	//
	// Failure mode: any non-2xx from qui surfaces as 502 with the qui
	// error message, matching the bulk-action route's behavior.

	app.post<{
		Params: { id: string; instanceId: string; hash: string };
		Body: { name?: unknown };
	}>("/qui/instances/:id/qbit/:instanceId/torrents/:hash/rename", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
		const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
			instanceId: request.params.instanceId,
			hash: request.params.hash,
		});
		const body = validateRequest(z.object({ name: z.string().min(1).max(1024) }), request.body);
		const qbitInstanceId = Number.parseInt(instanceId, 10);
		if (!Number.isFinite(qbitInstanceId)) {
			return reply.status(400).send({ error: "qbit instanceId must be numeric" });
		}
		const instance = await requireQuiInstance(app, userId, id);
		const client = createQuiClient(app, instance);
		try {
			await client.renameTorrent(qbitInstanceId, hash, body.name);
			return reply.send({ status: "success" });
		} catch (error) {
			return reply.status(502).send({
				error: "qui mutation failed",
				message: getErrorMessage(error, "qui rename failed"),
			});
		}
	});

	app.post<{
		Params: { id: string; instanceId: string; hash: string };
		Body: { urls?: unknown };
	}>("/qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers/add", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
		const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
			instanceId: request.params.instanceId,
			hash: request.params.hash,
		});
		const body = validateRequest(
			z.object({ urls: z.array(z.string().min(1)).min(1).max(50) }),
			request.body,
		);
		const qbitInstanceId = Number.parseInt(instanceId, 10);
		if (!Number.isFinite(qbitInstanceId)) {
			return reply.status(400).send({ error: "qbit instanceId must be numeric" });
		}
		const instance = await requireQuiInstance(app, userId, id);
		const client = createQuiClient(app, instance);
		try {
			await client.addTrackers(qbitInstanceId, hash, body.urls);
			return reply.send({ status: "success" });
		} catch (error) {
			return reply.status(502).send({
				error: "qui mutation failed",
				message: getErrorMessage(error, "qui addTrackers failed"),
			});
		}
	});

	app.post<{
		Params: { id: string; instanceId: string; hash: string };
		Body: { urls?: unknown };
	}>(
		"/qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers/remove",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
				instanceId: request.params.instanceId,
				hash: request.params.hash,
			});
			const body = validateRequest(
				z.object({ urls: z.array(z.string().min(1)).min(1).max(50) }),
				request.body,
			);
			const qbitInstanceId = Number.parseInt(instanceId, 10);
			if (!Number.isFinite(qbitInstanceId)) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			try {
				await client.removeTrackers(qbitInstanceId, hash, body.urls);
				return reply.send({ status: "success" });
			} catch (error) {
				return reply.status(502).send({
					error: "qui mutation failed",
					message: getErrorMessage(error, "qui removeTrackers failed"),
				});
			}
		},
	);

	app.post<{
		Params: { id: string; instanceId: string; hash: string };
		Body: { oldURL?: unknown; newURL?: unknown };
	}>("/qui/instances/:id/qbit/:instanceId/torrents/:hash/trackers/edit", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
		const { instanceId, hash } = validateRequest(INSTANCE_HASH_PARAMS, {
			instanceId: request.params.instanceId,
			hash: request.params.hash,
		});
		const body = validateRequest(
			z.object({
				oldURL: z.string().min(1),
				newURL: z.string().min(1),
			}),
			request.body,
		);
		const qbitInstanceId = Number.parseInt(instanceId, 10);
		if (!Number.isFinite(qbitInstanceId)) {
			return reply.status(400).send({ error: "qbit instanceId must be numeric" });
		}
		const instance = await requireQuiInstance(app, userId, id);
		const client = createQuiClient(app, instance);
		try {
			await client.editTracker(qbitInstanceId, hash, body.oldURL, body.newURL);
			return reply.send({ status: "success" });
		} catch (error) {
			return reply.status(502).send({
				error: "qui mutation failed",
				message: getErrorMessage(error, "qui editTracker failed"),
			});
		}
	});

	// ────────────────────────────────────────────────────────────────────
	// Picker reads — categories & tags lists per qBit instance
	// ────────────────────────────────────────────────────────────────────
	//
	// These power the drawer's Tags + Category section's selectable
	// pickers (datalists). Power users typically reuse a small set of
	// tags/categories — surfacing them as suggestions prevents the silent
	// "user mistypes 'tv' as 'TV' and creates a phantom category" class
	// of error. Cached at the React Query layer (~5 min) — these change
	// rarely.

	app.get<{ Params: { id: string; instanceId: string } }>(
		"/qui/instances/:id/qbit/:instanceId/categories",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const qbitInstanceId = Number.parseInt(request.params.instanceId, 10);
			if (!Number.isFinite(qbitInstanceId)) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			const categories = await client.listCategories(qbitInstanceId);
			return reply.send({ categories });
		},
	);

	app.get<{ Params: { id: string; instanceId: string } }>(
		"/qui/instances/:id/qbit/:instanceId/tags",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const qbitInstanceId = Number.parseInt(request.params.instanceId, 10);
			if (!Number.isFinite(qbitInstanceId)) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);
			const tags = await client.listTags(qbitInstanceId);
			return reply.send({ tags });
		},
	);

	app.post<{ Params: { id: string } }>("/qui/instances/:id/test", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
		const instance = await requireQuiInstance(app, userId, id);
		const client = createQuiClient(app, instance);
		const result = await client.testConnection();
		return reply.send(result);
	});

	app.post("/qui/test", async (request, reply) => {
		const { baseUrl, apiKey } = validateRequest(TEST_BODY, request.body);
		// Build a synthetic instance object — credentials live in the request
		// body and never touch the DB on this path. The factory still expects
		// an encrypted blob, so we work around it by stubbing the encryptor.
		const stubInstance = {
			id: "test-only",
			userId: request.currentUser!.id,
			service: "QUI",
			label: "test",
			baseUrl,
			externalUrl: null,
			encryptedApiKey: "stub",
			encryptionIv: "stub",
			isDefault: false,
			enabled: true,
			storageGroupId: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		const stubApp = {
			...app,
			encryptor: { ...app.encryptor, decrypt: () => apiKey },
		};
		// biome-ignore lint/suspicious/noExplicitAny: deliberate test-shim factory call
		const client = createQuiClient(stubApp as any, stubInstance as any);
		const result = await client.testConnection();
		return reply.send(result);
	});

	app.post("/qui/library-item/torrent-state", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { arrInstanceId, arrItemId, itemType } = validateRequest(
			TORRENT_STATE_BODY,
			request.body,
		);

		if (itemType !== "movie" && itemType !== "series") {
			return reply.send({
				supported: false,
				reason: "Per-item torrent health supports movies and series only.",
			});
		}

		// SECURITY: scope the cache lookup by userId via the instance relation.
		// Without this, a caller passing a different user's arrInstanceId could
		// read that user's `infoHash` AND trigger a write-through `update`
		// against their row. CLAUDE.md "Critical Rules" #2: ownership scoping.
		const cached = await app.prisma.libraryCache.findFirst({
			where: { instanceId: arrInstanceId, arrItemId, itemType, instance: { userId } },
		});
		if (!cached) {
			return reply.send({
				supported: true,
				infoHash: null,
				torrent: null,
				siblings: [],
				reason: "Item not in library cache yet — try refreshing the library.",
			});
		}

		let infoHash = cached.infoHash;

		// Lazy backfill: when we don't already have the hash, query *arr
		// history for this specific item. The shared util is also used by
		// the periodic backfill scheduler so behavior stays in lockstep.
		if (!infoHash) {
			infoHash = await backfillInfoHashForRow({
				app,
				cacheRowId: cached.id,
				userId,
				arrInstanceId,
				itemType,
				arrItemId,
				log: app.log,
			});
		}

		if (!infoHash) {
			return reply.send({
				supported: true,
				infoHash: null,
				torrent: null,
				siblings: [],
				reason: "No download record found in *arr history for this item.",
			});
		}

		// Pick the user's qui instance — default first, otherwise oldest.
		const quiInstance = await app.prisma.serviceInstance.findFirst({
			where: { userId, service: "QUI", enabled: true },
			orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
		});
		if (!quiInstance) {
			return reply.send({
				supported: true,
				infoHash,
				torrent: null,
				siblings: [],
				reason: "No qui instance configured.",
			});
		}

		const client = createQuiClient(app, quiInstance);
		const torrent = await client.getTorrentByHash(infoHash);
		let siblings: Awaited<ReturnType<typeof client.getCrossSeedMatches>> = [];
		if (torrent?.instanceId) {
			siblings = await client.getCrossSeedMatches(torrent.instanceId, infoHash);
		}

		// Write-through: persist the freshly-fetched state into LibraryCache so
		// the Library filter sees recently-viewed items immediately, instead of
		// waiting for the 10-minute periodic sync. Failures here are non-fatal
		// — the user still gets the live response.
		if (torrent) {
			await app.prisma.libraryCache
				.update({
					where: { id: cached.id },
					data: {
						torrentState: normalizeTorrentState(torrent.state),
						torrentRatio: Number.isFinite(torrent.ratio) ? torrent.ratio : null,
						torrentSyncedAt: new Date(),
					},
				})
				.catch((err) => {
					// Surface the Prisma error code so log analysis can distinguish
					// expected races (P2025 — row deleted between findFirst+update)
					// from operational issues (P1001 — DB unreachable, P2002 —
					// constraint violation indicating schema drift). Use ERROR
					// level for non-P2025 codes so they're visible in standard
					// alerting; P2025 stays at warn since it's benign.
					const code = (err as { code?: string })?.code;
					const isBenignRace = code === "P2025";
					const logFn = isBenignRace ? app.log.warn : app.log.error;
					logFn.call(
						app.log,
						{ err, code, libraryCacheId: cached.id, infoHash },
						"failed to write-through torrent state to LibraryCache",
					);
				});
		}

		return reply.send({
			supported: true,
			infoHash,
			torrent,
			siblings,
			quiInstanceId: quiInstance.id,
			quiInstanceLabel: quiInstance.label,
		});
	});

	// Cross-Seed Discovery (Phase 3.1) — availability probe for empty-state
	// gating on the frontend page. Cheap: zero qui calls.
	app.get("/qui/cross-seed/availability", async (request, reply) => {
		const userId = request.currentUser!.id;
		const availability = await getDiscoveryAvailability(app, userId);
		return reply.send(availability);
	});

	// Cross-Seed Discovery (Phase 3.1) — scan one batch of LibraryCache rows
	// and return any items with cross-seed siblings. Frontend stitches
	// batches via the returned `nextCursor`. See lib/qui/cross-seed-discovery.ts
	// for the scan contract.
	app.get<{
		Querystring: { cursor?: string; batchSize?: string };
	}>("/qui/cross-seed/discover", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { cursor, batchSize } = validateRequest(DISCOVERY_QUERY, request.query);
		const result = await runDiscoveryBatch({
			app,
			userId,
			cursor: cursor ?? null,
			batchSize: batchSize ?? 100,
			log: request.log,
		});
		return reply.send(result);
	});

	// ────────────────────────────────────────────────────────────────────
	// qui home page — summary KPI strip + Needs Attention feed (Phase 6).
	// Single-pane-of-glass surface. One request per panel, both designed
	// to be cheap enough to refresh at the polling-active cadence.
	// ────────────────────────────────────────────────────────────────────

	app.get("/qui/summary", async (request, reply) => {
		const userId = request.currentUser!.id;
		const instances = await listQuiInstances(app, userId);

		// Empty state — user has no qui configured. Return zeros so the
		// frontend can render an empty-state pitch without an extra
		// availability probe.
		if (instances.length === 0) {
			return reply.send({
				totalTorrents: 0,
				byState: { seeding: 0, downloading: 0, paused: 0, stalled: 0, error: 0, other: 0 },
				avgRatio: 0,
				lowRatioCount: 0,
				lastSyncAt: null,
				lastSyncOk: null,
				configuredInstances: 0,
				qbitInstances: [],
			});
		}

		// Aggregate across every qui instance the user has. Multiple-qui
		// users are rare in practice but supported by the schema; merging
		// here keeps the frontend a single source of truth.
		let totalTorrents = 0;
		const byState = { seeding: 0, downloading: 0, paused: 0, stalled: 0, error: 0, other: 0 };
		let totalRatio = 0;
		let lowRatioCount = 0;
		const LOW_RATIO_THRESHOLD = 1.0;
		const qbitInstances: Array<{
			id: number;
			name: string;
			connected: boolean;
			torrentCount: number;
		}> = [];

		const perInstanceTorrentCount = new Map<number, number>();

		for (const instance of instances) {
			let client;
			try {
				client = createQuiClient(app, instance);
			} catch (err) {
				request.log.warn(
					{ err, instanceId: instance.id },
					"qui summary: client construction failed (likely encryption key mismatch); skipping instance",
				);
				continue;
			}

			try {
				const torrents = await client.listAllTorrents();
				totalTorrents += torrents.length;
				for (const t of torrents) {
					const normalized = normalizeTorrentState(t.state);
					// Roll the normalizer's per-direction states into the
					// summary's coarser buckets. `stalled_dl` is "trying to
					// download but no peers"; collapsing it into `stalled`
					// hides that distinction at the KPI level (operators
					// care that a torrent is stuck, not which direction).
					if (normalized === "seeding") byState.seeding++;
					else if (normalized === "downloading") byState.downloading++;
					else if (normalized === "paused") byState.paused++;
					else if (normalized === "stalled_dl") byState.stalled++;
					else if (normalized === "error") byState.error++;
					else byState.other++;
					totalRatio += t.ratio;
					if (t.ratio < LOW_RATIO_THRESHOLD) lowRatioCount++;
					if (t.instanceId !== undefined) {
						perInstanceTorrentCount.set(
							t.instanceId,
							(perInstanceTorrentCount.get(t.instanceId) ?? 0) + 1,
						);
					}
				}
			} catch (err) {
				request.log.warn(
					{ err, instanceId: instance.id },
					"qui summary: listAllTorrents failed; skipping torrents for this instance",
				);
			}

			try {
				const qbits = await client.listInstances();
				for (const q of qbits) {
					qbitInstances.push({
						id: q.id,
						name: q.name,
						connected: q.connected,
						torrentCount: perInstanceTorrentCount.get(q.id) ?? 0,
					});
				}
			} catch (err) {
				request.log.warn(
					{ err, instanceId: instance.id },
					"qui summary: listInstances failed; qbit-instance card will be empty",
				);
			}
		}

		// Pull the most recent `qui_sync_complete` activity row for "last
		// sync" KPI. Falls back to null when the scheduler has never
		// successfully run (e.g., fresh install).
		const lastSync = await app.prisma.quiActivityLog.findFirst({
			where: { userId, eventType: "qui_sync_complete" },
			orderBy: { createdAt: "desc" },
			select: { createdAt: true, details: true },
		});
		let lastSyncOk: boolean | null = null;
		if (lastSync) {
			try {
				const details = JSON.parse(lastSync.details ?? "{}") as { errors?: number };
				lastSyncOk = (details.errors ?? 0) === 0;
			} catch {
				lastSyncOk = null;
			}
		}

		return reply.send({
			totalTorrents,
			byState,
			avgRatio: totalTorrents > 0 ? totalRatio / totalTorrents : 0,
			lowRatioCount,
			lastSyncAt: lastSync?.createdAt.toISOString() ?? null,
			lastSyncOk,
			configuredInstances: instances.length,
			qbitInstances,
		});
	});

	// Manual trigger for the path-correlation backfill pass — same code
	// the scheduler runs every 6h, but on demand. Useful when an operator
	// has just configured qui / re-encrypted credentials and doesn't want
	// to wait a full scheduler cycle to see correlation results.
	//
	// Synchronous-on-success: returns when the sweep completes. A 5000-row
	// cap keeps a single request bounded even on libraries the size of a
	// fully-populated *arr ecosystem (the scheduler uses 500 to stay
	// gentle; the manual button accepts the larger budget because the
	// operator initiated it explicitly).
	// Manual inode-index rebuild — admin convenience endpoint.
	//
	// Triggers a fresh rebuild for one (or all) FS-enabled qui instances
	// owned by the caller. Useful after adding a batch of new torrents
	// or noticing stale correlations — operator can force a refresh
	// without waiting for the 30-min TTL.
	//
	// Body: { instanceId?: string } — when omitted, rebuilds all FS-
	// enabled qui instances for this user.
	//
	// Returns the build result per instance (file counts, duration).
	// Honors in-flight dedup, so two concurrent rebuild requests share
	// one build pass.
	app.post<{ Body?: { instanceId?: string } }>(
		"/qui/inode-index/rebuild",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const targetId = request.body?.instanceId;

			const instances = await app.prisma.serviceInstance.findMany({
				where: {
					userId,
					service: "QUI",
					enabled: true,
					hasLocalFilesystemAccess: true,
					...(targetId ? { id: targetId } : {}),
				},
			});
			if (instances.length === 0) {
				return reply.code(404).send({
					error: targetId
						? "Instance not found, not FS-enabled, or not owned by this user"
						: "No FS-enabled qui instances configured",
				});
			}

			// Invalidate the in-memory cache for these instances so the next
			// `buildFileIdIndex` call rebuilds instead of returning the
			// still-fresh cached copy. Mirrors what the TTL expiry would do
			// naturally, but immediately.
			const { clearFileIdIndexCache } = await import(
				"../lib/library-sync/infohash-backfill-by-inode.js"
			);
			for (const instance of instances) {
				clearFileIdIndexCache(instance.id);
			}

			interface PerInstanceResult {
				instanceId: string;
				label: string;
				durationMs: number;
				filesIndexed?: number;
				error?: string;
			}
			const results: PerInstanceResult[] = await Promise.all(
				instances.map(async (instance) => {
					const start = Date.now();
					try {
						const client = createQuiClient(app, instance);
						const index = await buildFileIdIndex(client, instance, request.log, app.prisma);
						return {
							instanceId: instance.id,
							label: instance.label,
							durationMs: Date.now() - start,
							filesIndexed: index.statted,
						};
					} catch (err) {
						return {
							instanceId: instance.id,
							label: instance.label,
							durationMs: Date.now() - start,
							error: getErrorMessage(err),
						};
					}
				}),
			);

			const succeeded = results.filter((r) => !r.error).length;
			request.log.info(
				{ userId, requested: instances.length, succeeded, results },
				"qui inode-index: manual rebuild complete",
			);
			return reply.send({ instancesProcessed: instances.length, succeeded, results });
		},
	);

	// Inode-probe diagnostic for the local-filesystem-access strategy.
	//
	// Given a path, returns the (st_dev, st_ino, nlink) tuple that
	// arr-dashboard's process can observe — or the errno when the path
	// can't be stat'd. Operators use this BEFORE flipping the
	// `hasLocalFilesystemAccess` toggle on a qui instance to confirm:
	//
	//   1. arr-dashboard can actually see the path (no ENOENT/EACCES).
	//   2. The file is hardlinked (nlink >= 2). If nlink == 1, the file
	//      is isolated from any qui torrent and inode matching can't
	//      correlate it.
	//   3. A library path and a torrent path share `(dev, ino)`. If dev
	//      differs, the two views are on different filesystems and
	//      hardlinks can't cross — inode matching is impossible.
	//
	// Returns a compact JSON shape that's easy to curl from a deployment
	// shell while verifying bind-mount choices. Authenticated per-user
	// like every other route in this file; no path-traversal validation
	// because (a) the operator chose the path, and (b) we only READ the
	// stat — we don't open the file or expose contents.
	app.get<{ Querystring: { path?: string } }>("/qui/debug/inode-probe", async (request, reply) => {
		const path = request.query.path;
		if (!path || typeof path !== "string") {
			return reply.code(400).send({ error: "missing required query param: path" });
		}
		try {
			const { stat } = await import("node:fs/promises");
			const s = await stat(path);
			return reply.send({
				path,
				exists: true,
				dev: Number(s.dev),
				ino: Number(s.ino),
				nlink: Number(s.nlink),
				size: Number(s.size),
				isFile: s.isFile(),
				isDirectory: s.isDirectory(),
			});
		} catch (err) {
			const errno = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
			const message = err instanceof Error ? err.message : String(err);
			return reply.send({
				path,
				exists: false,
				errno,
				message,
			});
		}
	});

	// Cross-seed search for a stuck library item via qui's dir-scan webhook.
	//
	// Flow: caller provides a library_cache row id. We look up the row,
	// extract its on-disk path, and ask qui to scan that specific path for
	// cross-seed matches. qui takes over from there — searches configured
	// indexers via Prowlarr/Jackett, downloads matching .torrent files, and
	// adds them to qBit pointing at the existing library file (skip-hash-
	// check or recheck depending on qui's dir-scan settings). The next
	// inode-backfill sweep picks up the new correlation automatically.
	//
	// Prerequisite: qui must have a configured dir-scan directory whose
	// path is a prefix of the library item's path (e.g., `/data/media/movies`
	// for a movie at `/data/media/movies/Foo (2024)/...`). If not, qui
	// returns 404 "No matching directory found" and we relay that.
	app.post<{
		Body: {
			arrInstanceId: string;
			arrItemId: number;
			itemType: "movie" | "series" | "artist" | "author";
			quiInstanceId?: string;
		};
	}>("/qui/dirscan/trigger", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { arrInstanceId, arrItemId, itemType, quiInstanceId } = request.body ?? {};
		if (!arrInstanceId || typeof arrInstanceId !== "string") {
			return reply.code(400).send({ error: "arrInstanceId is required" });
		}
		if (typeof arrItemId !== "number") {
			return reply.code(400).send({ error: "arrItemId is required" });
		}

		// Ownership check: scope by userId via the instance relation so
		// callers can't probe other users' library rows even by guessing.
		const row = await app.prisma.libraryCache.findFirst({
			where: {
				arrItemId,
				itemType,
				instance: { id: arrInstanceId, userId },
			},
			select: { id: true, title: true, data: true, itemType: true, infoHash: true },
		});
		if (!row) {
			return reply.code(404).send({ error: "Library item not found" });
		}

		// Extract the on-disk path from the cached *arr response.
		// Movies use `data.path + "/" + data.movieFile.relativePath`,
		// series use `data.path` (folder-level — qui's dir-scan then
		// recursively scans inside). For per-episode correlation use
		// the EpisodeFileCache.path directly; this route handles
		// LibraryCache rows only.
		let scanPath: string | null = null;
		try {
			const parsed = JSON.parse(row.data) as Record<string, unknown>;
			const rootPath = typeof parsed.path === "string" ? parsed.path : null;
			if (row.itemType === "movie") {
				const mf = parsed.movieFile as Record<string, unknown> | null | undefined;
				const rel = typeof mf?.relativePath === "string" ? mf.relativePath : null;
				if (rootPath && rel) {
					scanPath = `${rootPath.replace(/\/+$/, "")}/${rel}`;
				}
			} else if (row.itemType === "series") {
				// qui's dir-scan walks recursively from the scan root, so
				// passing the series folder triggers a search across every
				// episode file inside.
				scanPath = rootPath;
			}
		} catch {
			// fall through — scanPath stays null and we'll 422 below
		}
		if (!scanPath) {
			return reply.code(422).send({
				error: "Could not determine on-disk path from library data",
			});
		}

		// Resolve which qui instance to use. If the caller specified one,
		// validate ownership. Otherwise, pick the first enabled qui for
		// this user — matches how the rest of the qui routes behave.
		const quiInstance = quiInstanceId
			? await app.prisma.serviceInstance.findFirst({
					where: { id: quiInstanceId, userId, service: "QUI", enabled: true },
				})
			: await app.prisma.serviceInstance.findFirst({
					where: { userId, service: "QUI", enabled: true },
				});
		if (!quiInstance) {
			return reply.code(404).send({ error: "No qui instance available" });
		}

		try {
			const client = createQuiClient(app, quiInstance);
			const result = await client.triggerDirScan(scanPath);
			request.log.info(
				{
					userId,
					arrInstanceId,
					arrItemId,
					itemType,
					title: row.title,
					scanPath,
					quiInstanceId: quiInstance.id,
					runId: result.runId,
					directoryId: result.directoryId,
				},
				"qui dir-scan triggered for stuck library item",
			);
			return reply.send({ ...result, scanPath });
		} catch (err) {
			// qui's webhook endpoint returns:
			//   404 — no configured dir-scan covers the path
			//   409 — scan already in progress for this directory
			//   400 — malformed payload (shouldn't happen)
			// Surface qui's status code verbatim so the UI can show a
			// useful message ("Configure dir-scan in qui first" vs
			// "Scan already running").
			const status =
				typeof (err as { statusCode?: number }).statusCode === "number"
					? (err as { statusCode: number }).statusCode
					: 502;
			const message = err instanceof Error ? err.message : "qui dir-scan trigger failed";
			request.log.warn(
				{ err, userId, arrInstanceId, arrItemId, scanPath, quiInstanceId: quiInstance.id },
				"qui dir-scan trigger failed",
			);
			return reply.code(status).send({ error: message });
		}
	});

	// Series-level torrent / cross-seed overview.
	//
	// Renders the per-series rich panel in the library detail modal. The
	// shape is **content clusters** — each cluster is one set of episodes
	// covered by 1..N torrent copies (tracker mirrors via qui's hardlink
	// automation). A 4-tracker S02 pack → 1 cluster with 4 copies, not 4
	// duplicated rows with a redundant siblings sub-list.
	//
	// Three trust-correctness fixes happen here:
	//   1. **Stale cache healing** — when an episode's cached infoHash
	//      points at a torrent qui no longer has but a fresh inode lookup
	//      finds replacement hashes, rewrite the cache canonical so it
	//      stops appearing as a phantom row.
	//   2. **Phantom suppression** — cached hashes that aren't in any
	//      live qui index AND have replacement hashes from the inode set
	//      are dropped from the response.
	//   3. **Action items** — surface actionable things (stuck episodes,
	//      unhealthy trackers, dormant content) at the top instead of
	//      making the user infer them from the row list.
	//
	// Scope-bound to one user via the instance.userId relation, same
	// ownership pattern as the rest of qui.ts.
	app.get<{ Params: { arrInstanceId: string; arrItemId: string } }>(
		"/qui/series/:arrInstanceId/:arrItemId/torrents",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { arrInstanceId } = request.params;
			const arrItemId = Number.parseInt(request.params.arrItemId, 10);
			if (!Number.isFinite(arrItemId)) {
				return reply.code(400).send({ error: "arrItemId must be a number" });
			}

			// Ownership: confirm the user owns the (instance, series) before
			// pulling its episode-file cache rows. Without this scoping a
			// caller could enumerate any user's library by guessing pair ids.
			const seriesRow = await app.prisma.libraryCache.findFirst({
				where: {
					instanceId: arrInstanceId,
					arrItemId,
					itemType: "series",
					instance: { userId },
				},
				select: { id: true, title: true },
			});
			if (!seriesRow) {
				return reply.code(404).send({ error: "Series not found" });
			}

			// Pull all episode files for this series in one query. Each row
			// is one EpisodeFile (multi-ep files like `S01E01-E02.mkv` are
			// ONE EpisodeFile covering two Episode entities) — see the
			// EpisodeFileCache schema comment.
			const episodes = await app.prisma.episodeFileCache.findMany({
				where: { instanceId: arrInstanceId, arrSeriesId: arrItemId },
				select: {
					id: true,
					arrEpisodeFileId: true,
					seasonNumber: true,
					relativePath: true,
					path: true,
					size: true,
					qualityName: true,
					releaseGroup: true,
					infoHash: true,
					infoHashSource: true,
				},
				orderBy: [{ seasonNumber: "asc" }, { relativePath: "asc" }],
			});

			const totalEpisodes = episodes.length;
			const viaInodeEpisodes = episodes.filter((e) => e.infoHashSource === "inode").length;

			// Look up a single qui instance for index building. FS-enabled
			// instance preferred (only those have a meaningful inode index).
			const fsInstance = await app.prisma.serviceInstance.findFirst({
				where: { userId, service: "QUI", enabled: true, hasLocalFilesystemAccess: true },
			});

			// Race the inode index build against a 22-second timeout. A cold
			// build over a large qui library (~12k torrents → ~50k stat ops)
			// can exceed Next.js's 30s proxy timeout. Rather than letting
			// the request 504, we return what we have (cached infoHashes
			// only) and let the build continue in the background — the next
			// request after it completes gets full multi-hash coverage.
			//
			// In-flight dedup inside `buildFileIdIndex` ensures the
			// background promise isn't restarted by subsequent requests.
			let inodeIndex: Awaited<ReturnType<typeof buildFileIdIndex>> | null = null;
			if (fsInstance) {
				const indexClient = createQuiClient(app, fsInstance);
				// Pass `app.prisma` so successful builds are persisted to the
				// `InodeIndexCache` table. Next startup hydrates from this row
				// and the panel loads cold-cache-free.
				const buildPromise = buildFileIdIndex(
					indexClient,
					fsInstance,
					request.log,
					app.prisma,
				).catch((err) => {
					request.log.warn(
						{ err, quiInstanceId: fsInstance.id },
						"qui series-torrents: inode index build failed; using cached-hash fallback",
					);
					return null;
				});
				// Clearable timeout — when the build wins the race we don't want
				// a stray 22s timer sitting in Node's wheel. clearTimeout in
				// finally fires whether the build won or lost, so no stale handle.
				let timeoutHandle: NodeJS.Timeout | undefined;
				const timeoutPromise = new Promise<null>((resolve) => {
					timeoutHandle = setTimeout(() => resolve(null), 22000);
				});
				try {
					inodeIndex = await Promise.race([buildPromise, timeoutPromise]);
				} finally {
					if (timeoutHandle) clearTimeout(timeoutHandle);
				}
				if (inodeIndex === null) {
					request.log.info(
						{ quiInstanceId: fsInstance.id, arrSeriesId: arrItemId },
						"qui series-torrents: inode index not ready yet (cold build); returning cached-hash response. Reload after build completes for full multi-hash coverage.",
					);
				}
			}

			// Per-episode hash collection. For each episode we record:
			//   - inodeHashes: hashes the live qui inode index knows about
			//     for this specific file (cross-seeds the user actually has)
			//   - cachedHash: the canonical written by backfill (may be stale)
			//
			// Stale-detection rule: cached hash exists, inode lookup returned
			// at least one hash, but cached hash isn't in that inode set →
			// the cached canonical points at a torrent qui no longer has.
			// We heal those by rewriting cache to inodeHashes[0] AND drop
			// the stale cached hash from the response.
			const perEpisode = await Promise.all(
				episodes.map(async (ep) => {
					const inodeHashes =
						inodeIndex && ep.path ? await getAllHashesForFileId(ep.path, inodeIndex) : [];
					const cachedStale =
						ep.infoHash !== null &&
						inodeHashes.length > 0 &&
						!inodeHashes.some((h) => h.toLowerCase() === ep.infoHash!.toLowerCase());
					return { ep, inodeHashes, cachedStale };
				}),
			);

			// Apply healing: for stale episodes, write the canonical inode
			// hash back so the next page load (and the backfill sweep) see
			// fresh data. Use individual updates rather than chunked updateMany
			// because each row gets a different target hash.
			const healCandidates = perEpisode.filter(
				(p): p is typeof p & { inodeHashes: [string, ...string[]] } =>
					p.cachedStale && p.inodeHashes.length > 0,
			);
			let healedEpisodes = 0;
			if (healCandidates.length > 0) {
				await Promise.all(
					healCandidates.map(({ ep, inodeHashes }) =>
						app.prisma.episodeFileCache.update({
							where: { id: ep.id },
							data: { infoHash: inodeHashes[0], infoHashSource: "inode" },
						}),
					),
				);
				healedEpisodes = healCandidates.length;
				request.log.info(
					{ userId, arrInstanceId, arrSeriesId: arrItemId, healed: healedEpisodes },
					"qui series-torrents: healed stale cached infoHashes",
				);
			}

			// Effective per-episode hash list — for each episode, prefer
			// inode hashes when available (they're live); fall back to cached
			// when no inode data exists (FS-disabled instance). Cached hashes
			// that are stale and have replacements are excluded.
			interface EpisodeContext {
				ep: (typeof episodes)[number];
				/** Hashes that map to this episode in the response. */
				effectiveHashes: string[];
				/** True when at least one hash came from a live inode lookup. */
				inodeVerified: boolean;
			}
			const episodeContexts: EpisodeContext[] = perEpisode.map(
				({ ep, inodeHashes, cachedStale }) => {
					const hashes = new Set<string>();
					for (const h of inodeHashes) hashes.add(h);
					// Cached hash: include only when not stale. If cachedStale is true
					// but we have replacements, the cached hash is dropped — that's
					// what removes the phantom rows.
					if (ep.infoHash && !cachedStale) hashes.add(ep.infoHash);
					return {
						ep,
						effectiveHashes: Array.from(hashes),
						inodeVerified: inodeHashes.length > 0 || ep.infoHashSource === "inode",
					};
				},
			);

			// "Stuck" now = episode with zero effective hashes. A previously-
			// correlated episode whose cache we just healed isn't stuck; an
			// episode whose only cached hash was stale-with-no-replacement
			// IS stuck (we couldn't find anything live).
			const stuckEpisodes = episodeContexts.filter((c) => c.effectiveHashes.length === 0).length;
			const correlatedEpisodes = totalEpisodes - stuckEpisodes;

			// Per-torrent coverage map — invert the per-episode lookup to
			// produce one entry per unique torrent hash, recording exactly
			// which episode files in THIS series the torrent covers.
			//
			// The previous primitive (per-episode hash union → cluster by
			// hash set) double-counted torrents in mixed-coverage scenarios:
			// a season pack hash would appear in N clusters when N episodes
			// had per-episode REPACK siblings. Inverting to per-torrent
			// coverage gives each unique torrent exactly one membership.
			//
			// Built from the same `episodeContexts` data — every hash that
			// covers any episode picks up that episode's id. A torrent NOT
			// hardlinked to any *arr-managed file in this series never
			// appears here at all (correct — it doesn't cover the series).
			interface PerHashCoverage {
				episodeFileIds: Set<number>;
				seasons: Set<number>;
				totalSize: bigint;
				qualityName: string | null;
				releaseGroup: string | null;
				inodeVerified: boolean;
			}
			const hashCoverage = new Map<string, PerHashCoverage>();
			for (const ctx of episodeContexts) {
				if (ctx.effectiveHashes.length === 0) continue; // stuck
				for (const hash of ctx.effectiveHashes) {
					let acc = hashCoverage.get(hash);
					if (!acc) {
						acc = {
							episodeFileIds: new Set(),
							seasons: new Set(),
							totalSize: 0n,
							qualityName: ctx.ep.qualityName,
							releaseGroup: ctx.ep.releaseGroup,
							inodeVerified: ctx.inodeVerified,
						};
						hashCoverage.set(hash, acc);
					}
					acc.episodeFileIds.add(ctx.ep.arrEpisodeFileId);
					acc.seasons.add(ctx.ep.seasonNumber);
					acc.totalSize += ctx.ep.size;
					if (ctx.inodeVerified) acc.inodeVerified = true;
				}
			}

			// Cluster torrents by **identical coverage** — same set of
			// episode files = different tracker copies of the same release.
			// All hashes with the same coverage share the cluster's size /
			// quality / release-group fields (provably consistent because
			// they all hardlink to the same files).
			interface ClusterAccumulator {
				episodeFileIds: number[];
				seasons: Set<number>;
				totalSize: bigint;
				qualityName: string | null;
				releaseGroup: string | null;
				inodeVerified: boolean;
				hashes: Set<string>;
			}
			const clusterMap = new Map<string, ClusterAccumulator>();
			for (const [hash, cov] of hashCoverage) {
				const episodeIds = Array.from(cov.episodeFileIds).sort((a, b) => a - b);
				const signature = episodeIds.join("|");
				let cluster = clusterMap.get(signature);
				if (!cluster) {
					cluster = {
						episodeFileIds: episodeIds,
						seasons: new Set(cov.seasons),
						totalSize: cov.totalSize,
						qualityName: cov.qualityName,
						releaseGroup: cov.releaseGroup,
						inodeVerified: cov.inodeVerified,
						hashes: new Set(),
					};
					clusterMap.set(signature, cluster);
				}
				cluster.hashes.add(hash);
				if (cov.inodeVerified) cluster.inodeVerified = true;
			}

			// Resolve the qui instance once for enrichment. We need one
			// instance per torrent fetch — fsInstance preferred (it has FS
			// access for path matching), else any enabled qui.
			let quiInstance: Awaited<ReturnType<typeof app.prisma.serviceInstance.findFirst>> =
				fsInstance;
			if (!quiInstance && clusterMap.size > 0) {
				quiInstance = await app.prisma.serviceInstance.findFirst({
					where: { userId, service: "QUI", enabled: true },
				});
			}

			// Collect all unique hashes across clusters (one shared fetch
			// per hash; multi-cluster sharing is rare but happens for
			// multi-season packs split into per-season clusters).
			const allHashes = new Set<string>();
			for (const acc of clusterMap.values()) for (const h of acc.hashes) allHashes.add(h);

			// Enrich via the shared module-scope helper. Same code path
			// the /qui/movie/.../torrents route uses — guarantees both
			// routes stay in lockstep on trust signals.
			const enrichedCopies = await enrichTorrentHashes({
				app,
				quiInstance,
				hashes: allHashes,
				log: request.log,
			});

			// Build cluster objects. Sort copies within a cluster: library-role
			// first (Sonarr/Radarr-managed), then by tracker name for stable
			// rendering. Drop quiUnreachable copies from the cluster when at
			// least one reachable copy exists — the cluster already proves
			// coverage; orphan-hash rows are noise.
			interface SeriesTorrentCluster {
				key: string;
				episodeFileIds: number[];
				episodeCount: number;
				seasons: number[];
				/** "S02 · 8 episodes" / "S03E04 · 1 episode" — for the header. */
				coverageLabel: string;
				totalSizeBytes: string;
				qualityName: string | null;
				releaseGroup: string | null;
				inodeVerified: boolean;
				copies: ClusterCopy[];
				/** True when every copy has 0 peers — actionable signal. */
				isDormant: boolean;
				/** Aggregate state for the cluster header. */
				primaryState: string | null;
				/**
				 * Cross-reference: this cluster's episodes are a STRICT subset of
				 * another cluster's coverage (i.e., a pack covers a superset of
				 * episodes). Surfaces redundancy without hiding it — user sees
				 * "S04E07 REPACK ↳ also covered by S04 pack". Null when this
				 * cluster's coverage isn't a subset of any other cluster.
				 *
				 * Inode-correctness: since clusters are built from per-torrent
				 * coverage of *arr files (via inode lookups), a cluster only
				 * appears here if its torrents share an inode with the pack's
				 * files for those episodes. A "separate single-episode release"
				 * with its own inode never lands in any cluster's coverage in
				 * the first place — the cross-ref claim is provably accurate.
				 */
				coveredBy: {
					clusterKey: string;
					coverageLabel: string;
					copyCount: number;
				} | null;
			}

			const formatCoverageLabel = (seasons: number[], episodeIds: number[]): string => {
				if (episodeIds.length === 0) return "—";
				if (seasons.length === 1) {
					if (episodeIds.length === 1) {
						// Pull the single episode's "S0xE0y" from the cached path.
						const ep = episodes.find((e) => e.arrEpisodeFileId === episodeIds[0]);
						const match = ep?.relativePath.match(/S\d{1,2}E\d{1,3}/i);
						if (match) return `${match[0]} · 1 episode`;
						return `S${String(seasons[0]).padStart(2, "0")} · 1 episode`;
					}
					return `S${String(seasons[0]).padStart(2, "0")} · ${episodeIds.length} episodes`;
				}
				const labels = seasons.map((s) => `S${String(s).padStart(2, "0")}`).join(", ");
				return `${labels} · ${episodeIds.length} episodes`;
			};

			const clusters: SeriesTorrentCluster[] = Array.from(clusterMap.entries())
				.map(([signature, acc]) => {
					const seasonsArr = Array.from(acc.seasons).sort((a, b) => a - b);
					const allCopies = Array.from(acc.hashes).map((h) => enrichedCopies.get(h)!);
					const reachable = allCopies.filter((c) => !c.quiUnreachable);
					// Keep reachable when any exist; otherwise keep unreachable (so
					// FS-disabled-instance setups still see something useful).
					const copies = reachable.length > 0 ? reachable : allCopies;
					copies.sort((a, b) => {
						if (a.role !== b.role) return a.role === "library" ? -1 : 1;
						return (a.tracker ?? "").localeCompare(b.tracker ?? "");
					});

					// Dormant: all copies report 0 seeds AND 0 leeches AND ratio<1.
					// Ratio<1 keeps us from flagging well-seeded torrents that just
					// happen to have a momentary 0-peer reading.
					const isDormant =
						copies.length > 0 &&
						copies.every(
							(c) => (c.numSeeds ?? 0) === 0 && (c.numLeechs ?? 0) === 0 && (c.ratio ?? 1) < 1,
						);

					const primaryState = copies.find((c) => c.state !== null)?.state ?? null;

					return {
						key: signature,
						episodeFileIds: acc.episodeFileIds.sort((a, b) => a - b),
						episodeCount: acc.episodeFileIds.length,
						seasons: seasonsArr,
						coverageLabel: formatCoverageLabel(seasonsArr, acc.episodeFileIds),
						totalSizeBytes: acc.totalSize.toString(),
						qualityName: acc.qualityName,
						releaseGroup: acc.releaseGroup,
						inodeVerified: acc.inodeVerified,
						copies,
						isDormant,
						primaryState,
						coveredBy: null, // resolved after sort, see subset pass below
					};
				})
				// Sort: biggest packs first, then by season number ascending.
				.sort((a, b) => {
					if (a.episodeCount !== b.episodeCount) return b.episodeCount - a.episodeCount;
					return (a.seasons[0] ?? 0) - (b.seasons[0] ?? 0);
				});

			// Subset cross-reference pass: for each cluster, find the smallest
			// STRICT-superset cluster (covers all of its episodes plus more).
			// "Smallest" is intentional — if both S04 pack and a complete-series
			// pack cover S04E07-REPACK, we want to surface "covered by S04 pack"
			// (the closest container) rather than "covered by series pack".
			//
			// O(N²) over cluster count. N is typically 1-10 for a series, so
			// this is trivial. If a series had hundreds of clusters we'd switch
			// to coverage-set bitmap intersections.
			//
			// Precompute each cluster's coverage-set ONCE outside the inner
			// loop. Without this we'd allocate a fresh Set per (cluster, other,
			// episode) iteration — bounded but unnecessary GC pressure.
			const clusterEpSets = new Map<string, Set<number>>();
			for (const cluster of clusters) {
				clusterEpSets.set(cluster.key, new Set(cluster.episodeFileIds));
			}
			for (const cluster of clusters) {
				if (cluster.episodeCount === 0) continue;
				let bestSuperset: (typeof clusters)[number] | null = null;
				for (const other of clusters) {
					if (other === cluster) continue;
					if (other.episodeCount <= cluster.episodeCount) continue;
					const otherSet = clusterEpSets.get(other.key)!;
					// Strict superset check: every episode in `cluster` must be in `other`.
					let isSuperset = true;
					for (const id of cluster.episodeFileIds) {
						if (!otherSet.has(id)) {
							isSuperset = false;
							break;
						}
					}
					if (!isSuperset) continue;
					if (!bestSuperset || other.episodeCount < bestSuperset.episodeCount) {
						bestSuperset = other;
					}
				}
				if (bestSuperset) {
					cluster.coveredBy = {
						clusterKey: bestSuperset.key,
						coverageLabel: bestSuperset.coverageLabel,
						copyCount: bestSuperset.copies.length,
					};
				}
			}

			// Action items: surface what the user can do, not just what exists.
			interface SeriesActionItem {
				kind: "stuck_episodes" | "stale_cache_healed" | "dormant_content" | "fs_unavailable";
				severity: "warning" | "info";
				title: string;
				detail: string;
				count?: number;
			}
			const actionItems: SeriesActionItem[] = [];
			if (stuckEpisodes > 0) {
				actionItems.push({
					kind: "stuck_episodes",
					severity: "warning",
					title: `${stuckEpisodes} episode${stuckEpisodes === 1 ? "" : "s"} not seeding`,
					detail: "Files have no live torrent. Use cross-seed search above or re-grab via Sonarr.",
					count: stuckEpisodes,
				});
			}
			if (healedEpisodes > 0) {
				actionItems.push({
					kind: "stale_cache_healed",
					severity: "info",
					title: `${healedEpisodes} stale cache ${healedEpisodes === 1 ? "entry" : "entries"} healed`,
					detail:
						"Old infoHash references were replaced with the current live torrents. Future loads will be accurate.",
					count: healedEpisodes,
				});
			}
			const dormantClusterCount = clusters.filter((c) => c.isDormant).length;
			if (dormantClusterCount > 0) {
				actionItems.push({
					kind: "dormant_content",
					severity: "warning",
					title: `${dormantClusterCount} torrent${dormantClusterCount === 1 ? "" : "s"} with no peers`,
					detail:
						"Ratio is below 1.0 and no seeders/leechers are connected. Consider re-seeding or removing.",
					count: dormantClusterCount,
				});
			}
			if (!fsInstance) {
				actionItems.push({
					kind: "fs_unavailable",
					severity: "info",
					title: "No FS-enabled qui instance",
					detail:
						"Cross-seed coverage relies on cached hashes only. Enable filesystem access on a qui instance for live inode matching.",
				});
			}

			// Season groups — the top-level navigational structure for the UI.
			// One group per season number that has episodes in this series.
			// Each group lists its clusters (by key) so the frontend can
			// render seasons-first without re-deriving from cluster.seasons.
			//
			// Multi-season packs (rare — a torrent spanning S01-S05) appear
			// in each season group they cover, with a `spansMultipleSeasons:
			// true` flag on the cluster itself for the UI to badge it.
			//
			// Stuck episodes (no live torrent) get a compact per-file list
			// inside the season group — so a fully-stuck season can render
			// the "Cross-seed search / Re-grab via Sonarr" CTA strip with
			// the affected episodes inline.
			interface SeasonGroup {
				seasonNumber: number;
				totalEpisodes: number;
				correlatedEpisodes: number;
				stuckEpisodes: number;
				/** Cluster keys belonging to this season, sorted by coverage desc. */
				clusterKeys: string[];
				/** Stuck episode files — for inline "missing release" display. */
				stuckEpisodeFiles: Array<{
					arrEpisodeFileId: number;
					relativePath: string;
				}>;
			}

			const seasonGroupMap = new Map<number, SeasonGroup>();
			// Walk every episode (correlated or stuck) so each season's totals
			// reflect the actual library, not just the correlated subset.
			for (const ep of episodes) {
				let group = seasonGroupMap.get(ep.seasonNumber);
				if (!group) {
					group = {
						seasonNumber: ep.seasonNumber,
						totalEpisodes: 0,
						correlatedEpisodes: 0,
						stuckEpisodes: 0,
						clusterKeys: [],
						stuckEpisodeFiles: [],
					};
					seasonGroupMap.set(ep.seasonNumber, group);
				}
				group.totalEpisodes++;
			}
			// Pull correlation from episodeContexts (post-heal, includes inode hits).
			for (const ctx of episodeContexts) {
				const group = seasonGroupMap.get(ctx.ep.seasonNumber)!;
				if (ctx.effectiveHashes.length > 0) {
					group.correlatedEpisodes++;
				} else {
					group.stuckEpisodes++;
					group.stuckEpisodeFiles.push({
						arrEpisodeFileId: ctx.ep.arrEpisodeFileId,
						relativePath: ctx.ep.relativePath,
					});
				}
			}
			// Wire clusters into their season group(s). A cluster's seasons
			// array can have more than one entry for multi-season packs;
			// each gets a reference. The frontend de-dupes by clusterKey
			// when a cluster is referenced from multiple groups.
			for (const cluster of clusters) {
				for (const seasonNum of cluster.seasons) {
					const group = seasonGroupMap.get(seasonNum);
					if (group) group.clusterKeys.push(cluster.key);
				}
			}
			const seasonGroups: SeasonGroup[] = Array.from(seasonGroupMap.values()).sort(
				(a, b) => a.seasonNumber - b.seasonNumber,
			);

			// Diagnostic: emit cluster summary at info level so operators can
			// confirm clustering behavior without enabling debug logs. Compact
			// shape — one line per cluster with coverage + copy count + first
			// 8 chars of each hash.
			request.log.info(
				{
					userId,
					arrSeriesId: arrItemId,
					totalEpisodes,
					stuckEpisodes,
					clusterCount: clusters.length,
					clusters: clusters.map((c) => ({
						coverage: c.coverageLabel,
						episodes: c.episodeCount,
						copies: c.copies.length,
						hashes: c.copies.map((cp) => cp.infoHash.slice(0, 8)),
					})),
				},
				"qui series-torrents: cluster summary",
			);

			return reply.send({
				seriesTitle: seriesRow.title,
				totalEpisodes,
				correlatedEpisodes,
				viaInodeEpisodes,
				stuckEpisodes,
				healedEpisodes,
				actionItems,
				clusters,
				seasonGroups,
			});
		},
	);

	// Movie-level torrent overview.
	//
	// Same response shape as the series-torrents route, but for a single
	// movie file. There's only ever ONE cluster (the movie file itself,
	// covered by N tracker copies via qui's cross-seed automation), and
	// `seasonGroups` is always empty — the frontend uses that as the
	// signal to render clusters flat instead of season-grouped.
	//
	// Same trust-correctness pipeline as series:
	//   - Inode multi-hash lookup against the *arr-managed file
	//   - Stale cache healing
	//   - Per-tracker enrichment via getTrackers (authoritative)
	//   - DHT/PeX/LSD detection respecting qBit's `health` field
	//   - Action items (stuck, dormant, fs_unavailable, healed)
	app.get<{ Params: { arrInstanceId: string; arrItemId: string } }>(
		"/qui/movie/:arrInstanceId/:arrItemId/torrents",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { arrInstanceId } = request.params;
			const arrItemId = Number.parseInt(request.params.arrItemId, 10);
			if (!Number.isFinite(arrItemId)) {
				return reply.code(400).send({ error: "arrItemId must be a number" });
			}

			// Ownership: confirm the user owns the (instance, movie) pair
			// before pulling its torrent data. The unique constraint
			// `(instanceId, arrItemId, itemType)` guarantees one row max.
			const movieRow = await app.prisma.libraryCache.findFirst({
				where: {
					instanceId: arrInstanceId,
					arrItemId,
					itemType: "movie",
					instance: { userId },
				},
				select: {
					id: true,
					title: true,
					year: true,
					infoHash: true,
					infoHashSource: true,
					sizeOnDisk: true,
					qualityProfileName: true,
					data: true,
				},
			});
			if (!movieRow) {
				return reply.code(404).send({ error: "Movie not found" });
			}

			// Extract the on-disk file path AND the file's quality tier from
			// the data blob. Quality tier ≠ user's quality profile:
			//   - `qualityProfileName` is the user's policy ("Anime Dual Audio")
			//   - `movieFile.quality.quality.name` is the file's actual
			//     classification from Radarr's release parser ("WEBDL-1080p")
			// The panel wants the file's tier — answers "what is this?"
			// instead of "what did I ask for?"
			let libraryPath: string | null = null;
			let releaseGroup: string | null = null;
			let qualityTier: string | null = null;
			try {
				const parsed = JSON.parse(movieRow.data) as Record<string, unknown>;
				const path = typeof parsed.path === "string" ? parsed.path : null;
				const movieFile = parsed.movieFile as Record<string, unknown> | null | undefined;
				const relativePath =
					movieFile && typeof movieFile === "object" && typeof movieFile.relativePath === "string"
						? movieFile.relativePath
						: null;
				if (path && relativePath) {
					libraryPath = `${path.replace(/\/+$/, "")}/${relativePath}`;
				}
				if (movieFile && typeof movieFile === "object") {
					const rg = movieFile.releaseGroup;
					if (typeof rg === "string") releaseGroup = rg;
					// Quality is nested as `movieFile.quality.quality.name`
					// (Radarr's wire shape — outer `quality` is the version
					// wrapper, inner `quality` is the tier).
					const qWrap = movieFile.quality as Record<string, unknown> | null | undefined;
					const qInner = qWrap?.quality as Record<string, unknown> | null | undefined;
					if (qInner && typeof qInner.name === "string") {
						qualityTier = qInner.name;
					}
				}
			} catch (err) {
				request.log.debug(
					{ err, movieId: movieRow.id },
					"qui movie-torrents: data blob parse failed; treating movie as having no file",
				);
			}

			// Locate the FS-enabled qui instance (preferred for inode lookups)
			// or fall back to any enabled qui for cached-only mode.
			const fsInstance = await app.prisma.serviceInstance.findFirst({
				where: { userId, service: "QUI", enabled: true, hasLocalFilesystemAccess: true },
			});

			// Build the inode index — same timeout race the series route uses
			// to avoid blocking on cold cache builds beyond the proxy limit.
			let inodeIndex: Awaited<ReturnType<typeof buildFileIdIndex>> | null = null;
			if (fsInstance) {
				const indexClient = createQuiClient(app, fsInstance);
				const buildPromise = buildFileIdIndex(
					indexClient,
					fsInstance,
					request.log,
					app.prisma,
				).catch((err) => {
					request.log.warn(
						{ err, quiInstanceId: fsInstance.id },
						"qui movie-torrents: inode index build failed; using cached-hash fallback",
					);
					return null;
				});
				let timeoutHandle: NodeJS.Timeout | undefined;
				const timeoutPromise = new Promise<null>((resolve) => {
					timeoutHandle = setTimeout(() => resolve(null), 22000);
				});
				try {
					inodeIndex = await Promise.race([buildPromise, timeoutPromise]);
				} finally {
					if (timeoutHandle) clearTimeout(timeoutHandle);
				}
			}

			// Multi-hash lookup for the movie file. When the inode index
			// found multiple hashes (cross-seeded content), all show up in
			// the cluster. When the cached hash is stale (in DB but not in
			// the live index), heal it to the canonical inode hash.
			let inodeHashes: string[] = [];
			if (inodeIndex && libraryPath) {
				inodeHashes = await getAllHashesForFileId(libraryPath, inodeIndex);
			}

			const cachedHashIsStale =
				movieRow.infoHash !== null &&
				inodeHashes.length > 0 &&
				!inodeHashes.some((h) => h.toLowerCase() === movieRow.infoHash!.toLowerCase());

			let healedEpisodes = 0;
			if (cachedHashIsStale && inodeHashes.length > 0) {
				await app.prisma.libraryCache.update({
					where: { id: movieRow.id },
					data: { infoHash: inodeHashes[0], infoHashSource: "inode" },
				});
				healedEpisodes = 1;
				request.log.info(
					{ userId, arrInstanceId, arrMovieId: arrItemId },
					"qui movie-torrents: healed stale cached infoHash",
				);
			}

			// Effective hashes for the movie file:
			//   - Inode hashes when available (preferred — live)
			//   - Else the cached hash (when not stale)
			//   - Empty when stuck (no torrent at all)
			const effectiveHashes = new Set<string>();
			for (const h of inodeHashes) effectiveHashes.add(h);
			if (movieRow.infoHash && !cachedHashIsStale) effectiveHashes.add(movieRow.infoHash);

			// Resolve quiInstance for enrichment (fsInstance preferred for path-
			// based matching; fall back to any enabled qui).
			let quiInstance: Awaited<ReturnType<typeof app.prisma.serviceInstance.findFirst>> =
				fsInstance;
			if (!quiInstance && effectiveHashes.size > 0) {
				quiInstance = await app.prisma.serviceInstance.findFirst({
					where: { userId, service: "QUI", enabled: true },
				});
			}

			// Enrich via the shared helper. Same trust pipeline as series.
			const enrichedCopies = await enrichTorrentHashes({
				app,
				quiInstance,
				hashes: effectiveHashes,
				log: request.log,
			});

			// Build the single cluster covering this movie file (when correlated).
			// No subset detection needed — movies have exactly zero or one cluster.
			interface MovieCluster {
				key: string;
				episodeFileIds: number[];
				episodeCount: number;
				seasons: number[];
				coverageLabel: string;
				totalSizeBytes: string;
				qualityName: string | null;
				releaseGroup: string | null;
				inodeVerified: boolean;
				copies: ClusterCopy[];
				isDormant: boolean;
				primaryState: string | null;
				coveredBy: null;
			}
			const clusters: MovieCluster[] = [];
			if (effectiveHashes.size > 0) {
				const allCopies = Array.from(effectiveHashes).map((h) => enrichedCopies.get(h)!);
				const reachable = allCopies.filter((c) => !c.quiUnreachable);
				const copies = reachable.length > 0 ? reachable : allCopies;
				copies.sort((a, b) => {
					if (a.role !== b.role) return a.role === "library" ? -1 : 1;
					return (a.tracker ?? "").localeCompare(b.tracker ?? "");
				});
				const isDormant =
					copies.length > 0 &&
					copies.every(
						(c) => (c.numSeeds ?? 0) === 0 && (c.numLeechs ?? 0) === 0 && (c.ratio ?? 1) < 1,
					);
				const primaryState = copies.find((c) => c.state !== null)?.state ?? null;
				const movieTitle = movieRow.year ? `${movieRow.title} (${movieRow.year})` : movieRow.title;
				clusters.push({
					key: Array.from(effectiveHashes).sort().join("|"),
					// Movies have no episode_file_id concept — empty array signals
					// "this cluster has no episode-file granularity." Subset detection
					// (which keys on episodeFileIds) never picks this up, which is
					// correct: a movie cluster has no "parent" pack to defer to.
					episodeFileIds: [],
					episodeCount: 1,
					seasons: [],
					coverageLabel: movieTitle,
					totalSizeBytes: movieRow.sizeOnDisk.toString(),
					qualityName: qualityTier, // tier ("WEBDL-1080p"), not profile name
					releaseGroup,
					inodeVerified: inodeHashes.length > 0 || movieRow.infoHashSource === "inode",
					copies,
					isDormant,
					primaryState,
					coveredBy: null,
				});
			}

			const stuckEpisodes = effectiveHashes.size === 0 ? 1 : 0;
			const correlatedEpisodes = 1 - stuckEpisodes;
			const viaInodeEpisodes = inodeHashes.length > 0 ? 1 : 0;

			// Action items — same vocabulary as the series route so the
			// frontend renders them identically.
			interface SeriesActionItem {
				kind: "stuck_episodes" | "stale_cache_healed" | "dormant_content" | "fs_unavailable";
				severity: "warning" | "info";
				title: string;
				detail: string;
				count?: number;
			}
			const actionItems: SeriesActionItem[] = [];
			if (stuckEpisodes > 0) {
				actionItems.push({
					kind: "stuck_episodes",
					severity: "warning",
					title: "Movie file not seeding",
					detail:
						"This movie has no live torrent. Use cross-seed search above or re-grab via Radarr.",
					count: 1,
				});
			}
			if (healedEpisodes > 0) {
				actionItems.push({
					kind: "stale_cache_healed",
					severity: "info",
					title: "Stale cache entry healed",
					detail:
						"The old infoHash reference was replaced with the current live torrent. Future loads will be accurate.",
					count: 1,
				});
			}
			if (clusters[0]?.isDormant) {
				actionItems.push({
					kind: "dormant_content",
					severity: "warning",
					title: "All copies have no peers",
					detail:
						"Ratio is below 1.0 and no seeders/leechers are connected. Consider re-seeding or removing.",
					count: 1,
				});
			}
			if (!fsInstance) {
				actionItems.push({
					kind: "fs_unavailable",
					severity: "info",
					title: "No FS-enabled qui instance",
					detail:
						"Cross-seed coverage relies on cached hashes only. Enable filesystem access on a qui instance for live inode matching.",
				});
			}

			request.log.info(
				{
					userId,
					arrMovieId: arrItemId,
					stuckEpisodes,
					clusterCount: clusters.length,
					copies: clusters[0]?.copies.length ?? 0,
				},
				"qui movie-torrents: response summary",
			);

			return reply.send({
				seriesTitle: movieRow.title, // shape parity — frontend reuses the same field name
				totalEpisodes: 1,
				correlatedEpisodes,
				viaInodeEpisodes,
				stuckEpisodes,
				healedEpisodes,
				actionItems,
				clusters,
				seasonGroups: [], // movies never have season grouping
			});
		},
	);

	// Tracker-meta registry — single source of truth for "what does this
	// tracker look and read like." Fuses qui's icon map AND display-name
	// customizations into one merged response so the frontend doesn't
	// need our own static brand registry anymore.
	//
	// Two qui endpoints combined per request:
	//   - GET /api/tracker-icons          → Record<host, dataUrl>
	//   - GET /api/tracker-customizations → Array<{displayName, domains[]}>
	//
	// We invert the customizations into Record<host, displayName> (each
	// alias domain gets its own entry) and merge with the icon map.
	// Frontend gets: Record<host, { iconUrl?, name? }> — one entry per
	// host with whatever qui knows about it.
	//
	// Caching: per-user, 1-hour TTL. Soft-fail per sub-fetch (one's
	// failure doesn't block the other's data from reaching the panel).
	const TRACKER_META_TTL_MS = 60 * 60 * 1000;
	interface TrackerMetaEntry {
		iconUrl?: string;
		name?: string;
	}
	const trackerMetaCache = new Map<
		string,
		{ meta: Record<string, TrackerMetaEntry>; builtAt: number }
	>();
	// Route name kept as /tracker-icons for now to avoid renaming the
	// deployed frontend hook. The response shape evolves: the old `icons`
	// field stays for one transition cycle (sets the iconUrl for
	// compatibility) while the new `trackers` field is the canonical
	// merged map.
	app.get("/qui/tracker-icons", async (request, reply) => {
		const userId = request.currentUser!.id;
		const cached = trackerMetaCache.get(userId);
		if (cached && Date.now() - cached.builtAt < TRACKER_META_TTL_MS) {
			return reply.send({ trackers: cached.meta });
		}

		const instance = await app.prisma.serviceInstance.findFirst({
			where: { userId, service: "QUI", enabled: true },
		});
		if (!instance) {
			// No qui — empty map. Panel falls back to auto-derived
			// abbreviations from hostnames.
			return reply.send({ trackers: {} });
		}

		const merged: Record<string, TrackerMetaEntry> = {};
		const client = createQuiClient(app, instance);
		const [iconsResult, customsResult] = await Promise.allSettled([
			client.getTrackerIcons(),
			client.getTrackerCustomizations(),
		]);
		if (iconsResult.status === "fulfilled") {
			for (const [host, iconUrl] of Object.entries(iconsResult.value)) {
				merged[host] ??= {};
				merged[host].iconUrl = iconUrl;
			}
		} else {
			request.log.warn(
				{ err: iconsResult.reason, instanceId: instance.id },
				"qui tracker-icons fetch failed; merged map will lack icons",
			);
		}
		if (customsResult.status === "fulfilled") {
			// Each customization carries N domain aliases. Splay them so
			// every alias hostname maps to the same displayName.
			for (const c of customsResult.value) {
				for (const host of c.domains) {
					merged[host] ??= {};
					merged[host].name = c.displayName;
				}
			}
		} else {
			request.log.warn(
				{ err: customsResult.reason, instanceId: instance.id },
				"qui tracker-customizations fetch failed; merged map will lack names",
			);
		}
		trackerMetaCache.set(userId, { meta: merged, builtAt: Date.now() });
		return reply.send({ trackers: merged });
	});

	// Per-library-item seeding summary — small batch endpoint that feeds
	// the library grid. Frontend sends the IDs of items currently visible
	// (or a whole page), gets back `{trackerCount, topHosts}` per item.
	//
	// Architectural note: uses the SAME pipeline as the cluster endpoint
	// (inode multi-hash lookup + qui tracker meta). Reuses the cached
	// inode index, the cached tracker-meta registry, and the existing
	// `enrichTorrentHashes` helper. No duplicate signal, no separate
	// brand registry, no schema column to maintain.
	//
	// Caching: per (user, item set) for 10 min. The set hash is
	// stable for repeat-loads of the same library page. Aggressive
	// caching is fine because the underlying tracker data already has
	// its own 1h cache, and this just aggregates over a known item set.
	//
	// Cost: the bottleneck is the per-hash `getTrackers` qui call, which
	// we batch (concurrency cap of 32). For a typical 100-item library
	// page sharing ~50-150 unique hashes (cross-seeds collapse), first
	// load is ~1-2s; subsequent loads from cache are instant.
	const LIBRARY_SUMMARY_TTL_MS = 10 * 60 * 1000;
	interface LibrarySeedingSummaryEntry {
		trackerCount: number;
		topHosts: string[];
		hashCount: number;
	}
	const librarySummaryCache = new Map<
		string,
		{ summaries: Record<string, LibrarySeedingSummaryEntry>; builtAt: number }
	>();
	const LIBRARY_SUMMARY_BODY = z.object({
		// Each item carries its own arr instance ID so a single batch can
		// span multiple Sonarr/Radarr instances (the library page
		// renders items from all enabled instances when no filter is
		// applied). The arrInstanceId disambiguates `arrItemId` which
		// is only unique within an instance.
		items: z
			.array(
				z.object({
					arrInstanceId: z.string().min(1),
					itemId: z.number().int().positive(),
					itemType: z.enum(["movie", "series"]),
				}),
			)
			.min(1)
			.max(500),
	});
	app.post("/qui/library-seeding-summary", async (request, reply) => {
		const userId = request.currentUser!.id;
		const body = validateRequest(LIBRARY_SUMMARY_BODY, request.body);
		// Cache key is deterministic on the sorted item set including
		// instance IDs — different arr instances with the same arrItemId
		// don't collide. Two calls for the same page produce the same
		// key → cache hit.
		const sortedKey = body.items
			.map((i) => `${i.arrInstanceId}|${i.itemType}:${i.itemId}`)
			.sort()
			.join(",");
		const cacheKey = `${userId}|${sortedKey}`;
		const cached = librarySummaryCache.get(cacheKey);
		if (cached && Date.now() - cached.builtAt < LIBRARY_SUMMARY_TTL_MS) {
			return reply.send({ summaries: cached.summaries });
		}

		// FS-enabled qui instance is the only thing we strictly need —
		// per-item arr-instance scoping happens inline below via the
		// `instance.userId` join. No qui or no FS access → empty
		// summaries, cards render without the tracker strip.
		const quiInstance = await app.prisma.serviceInstance.findFirst({
			where: { userId, service: "QUI", enabled: true, hasLocalFilesystemAccess: true },
		});
		if (!quiInstance) {
			return reply.send({ summaries: {} });
		}

		// Reuse the cached inode index (built once per qui instance,
		// 30-min TTL, persisted across restarts). If the index isn't
		// warm, bail with empty rather than block the library page.
		const indexClient = createQuiClient(app, quiInstance);
		const inodeIndex = await Promise.race([
			buildFileIdIndex(indexClient, quiInstance, request.log, app.prisma).catch(() => null),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
		]);
		if (!inodeIndex) {
			return reply.send({ summaries: {} });
		}

		// Resolve each item's file paths. Movies → LibraryCache.data.path
		// + movieFile.relativePath. Series → all EpisodeFileCache rows.
		// Both done in parallel.
		interface ItemPaths {
			key: string; // "type:id"
			paths: string[];
		}
		const itemPaths: ItemPaths[] = await Promise.all(
			body.items.map(async ({ arrInstanceId, itemId, itemType }) => {
				// Key includes the *arr instance ID so two instances with
				// overlapping arrItemIds don't collide in the summary map.
				const key = `${arrInstanceId}|${itemType}:${itemId}`;
				if (itemType === "movie") {
					const row = await app.prisma.libraryCache.findFirst({
						where: {
							instanceId: arrInstanceId,
							arrItemId: itemId,
							itemType: "movie",
							instance: { userId },
						},
						select: { data: true },
					});
					if (!row) return { key, paths: [] };
					try {
						const parsed = JSON.parse(row.data) as Record<string, unknown>;
						const path = typeof parsed.path === "string" ? parsed.path : null;
						const movieFile = parsed.movieFile as Record<string, unknown> | null | undefined;
						const relativePath =
							movieFile &&
							typeof movieFile === "object" &&
							typeof movieFile.relativePath === "string"
								? movieFile.relativePath
								: null;
						if (path && relativePath) {
							return { key, paths: [`${path.replace(/\/+$/, "")}/${relativePath}`] };
						}
					} catch {
						/* fall through */
					}
					return { key, paths: [] };
				}
				// series: gather all episode files
				const episodes = await app.prisma.episodeFileCache.findMany({
					where: {
						instanceId: arrInstanceId,
						arrSeriesId: itemId,
						instance: { userId },
					},
					select: { path: true },
				});
				return { key, paths: episodes.map((e) => e.path).filter(Boolean) };
			}),
		);

		// stat() every path → inode → hash set. All in-memory after
		// inode index is warm; just a few hundred syscalls.
		const itemHashes = new Map<string, Set<string>>();
		const allHashes = new Set<string>();
		for (const { key, paths } of itemPaths) {
			const hashes = new Set<string>();
			await Promise.all(
				paths.map(async (p) => {
					const found = await getAllHashesForFileId(p, inodeIndex);
					for (const h of found) hashes.add(h);
				}),
			);
			itemHashes.set(key, hashes);
			for (const h of hashes) allHashes.add(h);
		}

		// Resolve per-hash tracker hostnames. We could call the full
		// `enrichTorrentHashes` here for symmetry, but for the summary
		// view we only need hostnames — skip the full torrent metadata
		// to halve the qui round-trips. Re-use the same hostname-safe
		// extraction logic.
		const hashToHosts = new Map<string, string[]>();
		const hashArr = Array.from(allHashes);
		// Concurrency cap: qui can typically handle ~50 parallel requests
		// but we stay conservative at 32 to leave headroom for the
		// existing cluster endpoint that's running for any open panel.
		const CONCURRENCY = 32;
		for (let i = 0; i < hashArr.length; i += CONCURRENCY) {
			const batch = hashArr.slice(i, i + CONCURRENCY);
			await Promise.all(
				batch.map(async (hash) => {
					try {
						const client = createQuiClient(app, quiInstance);
						const torrent = await client.getTorrentByHash(hash);
						if (!torrent || typeof torrent.instanceId !== "number") {
							hashToHosts.set(hash, []);
							return;
						}
						const trackers = await client.getTrackers(torrent.instanceId, hash);
						const hosts = trackers
							.filter((t) => !t.url.startsWith("** "))
							.map((t) => extractHostnameSafe(t.url))
							.filter((h) => h.length > 0);
						hashToHosts.set(hash, hosts);
					} catch {
						hashToHosts.set(hash, []);
					}
				}),
			);
		}

		// Aggregate per item: union of all hosts across all hashes
		// covering it. trackerCount = distinct hosts. topHosts = up to
		// 4, preserving discovery order (qui's enumeration order for
		// the inode index, which roughly mirrors insertion time).
		const summaries: Record<string, LibrarySeedingSummaryEntry> = {};
		for (const [key, hashes] of itemHashes) {
			const hosts = new Set<string>();
			for (const h of hashes) {
				const hostsForHash = hashToHosts.get(h) ?? [];
				for (const host of hostsForHash) hosts.add(host);
			}
			summaries[key] = {
				trackerCount: hosts.size,
				topHosts: Array.from(hosts).slice(0, 4),
				hashCount: hashes.size,
			};
		}

		librarySummaryCache.set(cacheKey, { summaries, builtAt: Date.now() });
		return reply.send({ summaries });
	});

	app.post("/qui/backfill/run-now", async (request, reply) => {
		const userId = request.currentUser!.id;
		// Three-phase backfill pipeline:
		//   1. Movie sweep — Radarr library_cache rows missing infoHash.
		//      Inode lookup for FS-enabled qui instances + heuristic
		//      ladder for FS-disabled.
		//   2. Episode-file sync — pull /api/v3/episodefile?seriesId=X
		//      per Sonarr series with hasFile=true; upsert into the
		//      EpisodeFileCache table. Necessary because LibraryCache
		//      stores series-level rows without per-episode metadata.
		//   3. Episode sweep — inode lookup on the freshly-synced
		//      episode-file paths. Inode-only (no heuristic ladder for
		//      episodes in v1 — see episode-file-backfill module doc).
		//
		// All three run synchronously and return aggregate stats. The
		// frontend's "Run correlation now" button drives this endpoint.
		request.log.info(
			{ userId },
			"correlation backfill: manual trigger requested (movies + episodes)",
		);
		const movieSweep = await runPathBackfillSweep({
			app,
			log: request.log,
			batchSize: 5000,
		});
		const episodeSync = await runEpisodeFileSync({
			app,
			log: request.log,
			seriesCap: 1000,
		});
		const episodeSweep = await runEpisodeBackfillSweep({
			app,
			log: request.log,
			batchSize: 10000,
		});
		return reply.send({ movieSweep, episodeSync, episodeSweep });
	});

	app.get<{ Querystring: { limit?: string } }>("/qui/attention", async (request, reply) => {
		const userId = request.currentUser!.id;
		// Cap the response to avoid blowing up on libraries with thousands
		// of stalled torrents. Frontend can paginate / "show all" later.
		const limitRaw = Number.parseInt(request.query?.limit ?? "20", 10);
		const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 20));

		const instances = await listQuiInstances(app, userId);
		if (instances.length === 0) {
			return reply.send({ items: [], totalCount: 0 });
		}

		// Collect attention-worthy torrents from every qui instance. The
		// "is this attention-worthy" rule lives here, not in qui — qui
		// reports raw state, we decide which states are operator-actionable.
		// Attention vocabulary uses the normalizer's actual outputs.
		// `stalled_dl` is a download stuck on no peers — almost always
		// the most actionable "something is wrong" state in qBit.
		//
		// IMPORTANT: low-ratio is NOT flagged as attention-worthy. On a
		// large seeding library most torrents have ratio < 1.0× simply
		// because they're newly added or because the user seeds to
		// many trackers; flagging them all drowns the feed. Low-ratio
		// stays visible as a KPI count ("N below 1.00×") instead.
		const attentionStates = new Set(["error", "paused", "stalled_dl"]);

		type AttentionTorrent = {
			hash: string;
			name: string;
			state: ReturnType<typeof normalizeTorrentState>;
			rawState: string;
			ratio: number;
			size: number;
			qbitInstanceId: number | null;
			qbitInstanceName: string | null;
			severity: "critical" | "warning";
			reason: string;
		};
		const collected: AttentionTorrent[] = [];

		for (const instance of instances) {
			let client;
			try {
				client = createQuiClient(app, instance);
			} catch {
				continue;
			}
			let torrents;
			try {
				torrents = await client.listAllTorrents();
			} catch {
				continue;
			}
			for (const t of torrents) {
				const normalized = normalizeTorrentState(t.state);
				if (!attentionStates.has(normalized)) continue;
				// Severity heuristic: error → critical, paused/stalled → warning.
				const severity: "critical" | "warning" = normalized === "error" ? "critical" : "warning";
				const reasons: string[] = [];
				if (normalized === "error") reasons.push("Errored");
				if (normalized === "stalled_dl") reasons.push("Stalled (no peers)");
				if (normalized === "paused") reasons.push("Paused");
				collected.push({
					hash: t.hash.toLowerCase(),
					name: t.name,
					state: normalized,
					rawState: t.state,
					ratio: t.ratio,
					size: t.size,
					qbitInstanceId: t.instanceId ?? null,
					qbitInstanceName: t.instanceName ?? null,
					severity,
					reason: reasons.join(" · ") || normalized,
				});
			}
		}

		// Sort: critical first, then by ratio ascending (worst-ratio bubbles up).
		collected.sort((a, b) => {
			if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
			return a.ratio - b.ratio;
		});
		const totalCount = collected.length;
		const sliced = collected.slice(0, limit);

		// Join with library_cache for *arr context where the infoHash
		// matches. Items qui has that no *arr instance tracks (orphans,
		// manually-added downloads) keep `libraryContext: null` and
		// render as "Unmapped" in the UI.
		const hashes = sliced.map((t) => t.hash);
		const cacheRows =
			hashes.length === 0
				? []
				: await app.prisma.libraryCache.findMany({
						where: {
							infoHash: { in: hashes },
							instance: { userId },
						},
						select: {
							id: true,
							infoHash: true,
							instanceId: true,
							arrItemId: true,
							itemType: true,
							title: true,
							year: true,
							instance: { select: { label: true, service: true } },
						},
					});

		const cacheByHash = new Map<string, (typeof cacheRows)[number]>();
		for (const row of cacheRows) {
			if (row.infoHash) cacheByHash.set(row.infoHash.toLowerCase(), row);
		}

		const arrServiceMap: Record<string, "sonarr" | "radarr" | "lidarr" | "readarr" | null> = {
			SONARR: "sonarr",
			RADARR: "radarr",
			LIDARR: "lidarr",
			READARR: "readarr",
		};

		const items = sliced.map((t) => {
			const ctx = cacheByHash.get(t.hash);
			const arrService = ctx ? arrServiceMap[ctx.instance.service] : null;
			return {
				hash: t.hash,
				name: t.name,
				state: t.state,
				ratio: t.ratio,
				size: t.size,
				qbitInstanceId: t.qbitInstanceId,
				qbitInstanceName: t.qbitInstanceName,
				severity: t.severity,
				reason: t.reason,
				libraryContext:
					ctx && arrService
						? {
								arrInstanceId: ctx.instanceId,
								arrInstanceLabel: ctx.instance.label,
								arrService,
								libraryCacheId: ctx.id,
								arrItemId: ctx.arrItemId,
								itemType: ctx.itemType as "movie" | "series" | "artist" | "author",
								title: ctx.title,
								year: ctx.year,
							}
						: null,
			};
		});

		return reply.send({ items, totalCount });
	});

	// qui Activity feed (Phase 3.2) — paginated chronological view of every
	// qui-related event arr-dashboard has emitted for this user. Eventually
	// joined by mutation events (Phase 4) and webhook events (Phase 5).
	app.get<{
		Querystring: { cursor?: string; limit?: string; eventType?: string };
	}>("/qui/activity", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { cursor, limit, eventType } = validateRequest(ACTIVITY_QUERY, request.query);
		const take = limit ?? 50;

		// Cursor convention: pass the id of the LAST event in the previous
		// page; the next page returns the next N events older than that row.
		// Empty/null cursor = fetch most-recent N.
		let cursorCreatedAt: Date | null = null;
		if (cursor) {
			const anchor = await app.prisma.quiActivityLog.findUnique({
				where: { id: cursor },
				select: { createdAt: true, userId: true },
			});
			// SECURITY: refuse cursor lookups that belong to another user, so
			// the cursor cannot be used to enumerate cross-user event ids.
			if (anchor && anchor.userId === userId) {
				cursorCreatedAt = anchor.createdAt;
			}
		}

		const events = await app.prisma.quiActivityLog.findMany({
			where: {
				userId,
				...(eventType ? { eventType } : {}),
				...(cursorCreatedAt ? { createdAt: { lt: cursorCreatedAt } } : {}),
			},
			orderBy: { createdAt: "desc" },
			take: take + 1, // fetch one extra to detect "has next page"
		});

		const hasMore = events.length > take;
		const trimmed = hasMore ? events.slice(0, take) : events;
		const nextCursor = hasMore ? (trimmed[trimmed.length - 1]?.id ?? null) : null;

		return reply.send({
			events: trimmed.map((e) => {
				const createdAtIso = e.createdAt.toISOString();
				return {
					id: e.id,
					eventType: e.eventType,
					// `severity` is the canonical field; `status` aliased for one
					// release window. See the schema notes on
					// `quiActivityEventSchema` for the rename rationale.
					severity: e.severity,
					status: e.severity,
					createdAt: createdAtIso,
					// `timestamp` is the canonical wire alias — every paginated
					// qui feed exposes it identically so the frontend's cursor
					// logic doesn't need to remember per-feed field names.
					timestamp: createdAtIso,
					details: safeParseJson(e.details),
				};
			}),
			nextCursor,
		});
	});

	// ────────────────────────────────────────────────────────────────────
	// Phase 4.1 — single-torrent action endpoint
	// ────────────────────────────────────────────────────────────────────

	app.post<{
		Params: { id: string; instanceId: string; hash: string; action: string };
		Body: unknown;
	}>(
		"/qui/instances/:id/qbit/:instanceId/torrents/:hash/actions/:action",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id, instanceId, hash, action } = validateRequest(ACTION_PARAMS, request.params);
			const qbitInstanceId = Number.parseInt(instanceId, 10);
			if (!Number.isFinite(qbitInstanceId)) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			// Per-action payload validation: each action declares its own
			// required body shape in `quiActionPayloadSchemas`. The route
			// picks the right schema from URL `:action` and validates the
			// body against it — wrong-field-with-wrong-action becomes a
			// 400 with a precise Zod error path instead of "qui rejected it."
			const payloadSchema = quiActionPayloadSchemas[action as QuiAction];
			const payload = validateRequest(payloadSchema, request.body ?? {}) as QuiActionPayload;

			// Ownership: requireQuiInstance only returns the row when (userId, id)
			// match AND service=QUI. Other users' ids surface as 404, not 403.
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);

			const result = await executeQuiAction({
				app,
				client,
				userId,
				serviceInstanceId: instance.id,
				qbitInstanceId,
				hashes: [hash],
				action,
				payload,
			});

			// Surface failures as 502 (upstream said no) — the audit log row
			// captures the precise reason; the response body just carries
			// enough for the UI to render a toast.
			if (result.status === "failed") {
				return reply.status(502).send({
					error: "qui mutation failed",
					message: result.error ?? "qui mutation failed",
				});
			}

			return reply.send({ status: "success", logRowCount: result.logRowCount });
		},
	);

	// ────────────────────────────────────────────────────────────────────
	// Phase 4.2 — bulk action endpoint (same service, hashes[] in body)
	// ────────────────────────────────────────────────────────────────────

	app.post<{
		Params: { id: string; instanceId: string; action: string };
		Body: unknown;
	}>("/qui/instances/:id/qbit/:instanceId/torrents/bulk-action/:action", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id, instanceId, action } = validateRequest(BULK_ACTION_PARAMS, request.params);
		// First parse the envelope (`hashes[]` cap + format), then validate
		// the action-specific extras against `quiActionPayloadSchemas[action]`.
		// Two passes because the envelope and the per-action payload share
		// the same flat body — the second pass enforces field presence and
		// types for the action's extras (e.g. `category` for setCategory).
		const envelope = validateRequest(quiBulkActionRequestSchema, request.body);
		const qbitInstanceId = Number.parseInt(instanceId, 10);
		if (!Number.isFinite(qbitInstanceId)) {
			return reply.status(400).send({ error: "qbit instanceId must be numeric" });
		}
		const payloadSchema = quiActionPayloadSchemas[action as QuiAction];
		// Strip envelope-level fields (`hashes`) before payload validation —
		// otherwise emptyPayload's `passthrough()` would let `hashes` leak
		// into `extras` and qui would receive duplicated arrays in its POST
		// body. Field-specific payload schemas would reject unknown keys
		// silently here too without the strip.
		const rawBody = (request.body ?? {}) as Record<string, unknown>;
		const { hashes: _omitHashes, ...payloadBody } = rawBody;
		const payload = validateRequest(payloadSchema, payloadBody) as QuiActionPayload;

		const instance = await requireQuiInstance(app, userId, id);
		const client = createQuiClient(app, instance);

		const result = await executeQuiAction({
			app,
			client,
			userId,
			serviceInstanceId: instance.id,
			qbitInstanceId,
			hashes: envelope.hashes,
			action,
			payload,
		});

		if (result.status === "failed") {
			return reply.status(502).send({
				error: "qui mutation failed",
				message: result.error ?? "qui mutation failed",
			});
		}

		return reply.send({ status: "success", logRowCount: result.logRowCount });
	});

	// ────────────────────────────────────────────────────────────────────
	// Phase 4.1 — action log feed for the "My Actions" tab
	// ────────────────────────────────────────────────────────────────────
	//
	// Mirrors the activity feed pagination shape. Joins the ServiceInstance
	// label so the frontend can render "Primary qui" without a second query.
	// Failures: `error` text is included verbatim so the operator can see
	// what qui returned without leaving the timeline.

	app.get<{
		Querystring: { cursor?: string; limit?: string; action?: string; status?: string };
	}>("/qui/actions", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { cursor, limit, action, status } = validateRequest(ACTION_LOG_QUERY, request.query);
		const take = limit ?? 50;

		let cursorRequestedAt: Date | null = null;
		if (cursor) {
			const anchor = await app.prisma.quiActionLog.findUnique({
				where: { id: cursor },
				select: { requestedAt: true, userId: true },
			});
			if (anchor && anchor.userId === userId) {
				cursorRequestedAt = anchor.requestedAt;
			}
		}

		const rows = await app.prisma.quiActionLog.findMany({
			where: {
				userId,
				...(action ? { action } : {}),
				...(status ? { status } : {}),
				...(cursorRequestedAt ? { requestedAt: { lt: cursorRequestedAt } } : {}),
			},
			orderBy: { requestedAt: "desc" },
			take: take + 1,
			include: {
				serviceInstance: { select: { label: true } },
			},
		});

		const hasMore = rows.length > take;
		const trimmed = hasMore ? rows.slice(0, take) : rows;
		const nextCursor = hasMore ? (trimmed[trimmed.length - 1]?.id ?? null) : null;

		// Coerce the DB's String columns back through the shared enum so a
		// stray value (older deploy with a different enum, or a future enum
		// extension reaching an old client) can't type-lie into the response.
		// Unknown values are filtered + counted instead of crashing the
		// page — the client never sees an action/status it can't render.
		const entries = trimmed
			.map((r) => {
				const action = coerceQuiAction(r.action);
				const status = coerceQuiActionStatus(r.status);
				if (action === "unknown" || status === "unknown") {
					request.log.warn(
						{ rowId: r.id, rawAction: r.action, rawStatus: r.status, userId },
						"qui action-log row had unknown enum value — filtering from response",
					);
					return null;
				}
				const requestedAtIso = r.requestedAt.toISOString();
				return {
					id: r.id,
					serviceInstanceId: r.serviceInstanceId,
					serviceInstanceLabel: r.serviceInstance.label,
					qbitInstanceId: r.qbitInstanceId,
					torrentHash: r.torrentHash,
					action,
					status,
					error: r.error,
					payload: r.payload ? safeParseJson(r.payload) : null,
					requestedAt: requestedAtIso,
					/** Canonical timestamp alias — see schema notes. */
					timestamp: requestedAtIso,
					completedAt: r.completedAt ? r.completedAt.toISOString() : null,
				};
			})
			.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

		return reply.send({ entries, nextCursor });
	});

	// ────────────────────────────────────────────────────────────────────
	// Phase 5.1 — webhook config (GET + rotate + register-in-qui)
	// ────────────────────────────────────────────────────────────────────

	/**
	 * Resolve the public-facing URL used by the operator to wire qui's
	 * NotificationTarget back to this dashboard. Mirrors the resolution
	 * order used by `plugins/notification-service.ts` so the same value
	 * an operator sees in notification links is what qui will fire on.
	 *
	 * Preference order:
	 *   1. `SystemSettings.externalUrl` — admin-configured override,
	 *      typically set when the dashboard sits behind a reverse proxy.
	 *   2. `app.config.APP_URL` — validated env var (default localhost:3000).
	 */
	async function resolvePublicBaseUrl(): Promise<string> {
		const settings = await app.prisma.systemSettings.findUnique({ where: { id: 1 } });
		return settings?.externalUrl?.replace(/\/$/, "") ?? app.config.APP_URL;
	}

	app.get("/qui/webhook-config", async (request, reply) => {
		const userId = request.currentUser!.id;
		const user = await app.prisma.user.findUniqueOrThrow({
			where: { id: userId },
			select: { hashedQuiWebhookSecret: true },
		});
		const baseUrl = await resolvePublicBaseUrl();
		return reply.send({
			hasSecret: Boolean(user.hashedQuiWebhookSecret),
			// Public URL the operator pastes into qui's notification target.
			// The query-param placeholder is intentional — the actual secret
			// is only returned at rotation time; the operator copies the URL
			// + secret together on the rotate response.
			webhookUrl: `${baseUrl}/api/webhooks/qui`,
		});
	});

	app.post("/qui/webhook-config/rotate", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { plaintextSecret, hashedSecret } = generateQuiWebhookSecret();
		await app.prisma.user.update({
			where: { id: userId },
			data: { hashedQuiWebhookSecret: hashedSecret },
		});
		const baseUrl = await resolvePublicBaseUrl();
		return reply.send({
			hasSecret: true,
			webhookUrl: `${baseUrl}/api/webhooks/qui`,
			// Plaintext returned only here — never stored, never re-displayed.
			// Operators copy it into qui's notification-target URL once.
			secret: plaintextSecret,
		});
	});

	// `secret` is part of the validated body schema so we never reach for
	// `request.body as Record<string, unknown>` (a previous shape leaked
	// the unvalidated path through a bypass cast — see CLAUDE.md rule 5).
	const REGISTER_BODY = z.object({
		secret: z.string().min(16, "secret must be at least 16 characters"),
		eventTypes: z.array(z.string()).optional(),
	});

	app.post<{ Params: { id: string }; Body: unknown }>(
		"/qui/instances/:id/webhook-config/register",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(QUI_INSTANCE_PARAM, request.params);
			const body = validateRequest(REGISTER_BODY, request.body ?? {});
			const instance = await requireQuiInstance(app, userId, id);
			const client = createQuiClient(app, instance);

			// Operator must rotate the secret first — we don't auto-create
			// a secret as a side effect of registration, because that would
			// silently reset any existing wired-up qui targets that depend
			// on the prior secret.
			const user = await app.prisma.user.findUniqueOrThrow({
				where: { id: userId },
				select: { hashedQuiWebhookSecret: true },
			});
			if (!user.hashedQuiWebhookSecret) {
				return reply.status(409).send({
					error: "No webhook secret configured. Rotate to generate one first.",
				});
			}

			const baseUrl = await resolvePublicBaseUrl();
			// The plaintext is supplied per-request in the validated body; we
			// don't have it on the server. The frontend captures it from the
			// rotate response and forwards it here.
			const targetUrl = `${baseUrl}/api/webhooks/qui?secret=${encodeURIComponent(body.secret)}`;

			try {
				const created = await client.createNotificationTarget({
					name: "arr-dashboard",
					url: targetUrl,
					eventTypes: body.eventTypes,
					enabled: true,
				});
				return reply.send({ ok: true, quiTargetId: created.id });
			} catch (err) {
				request.log.warn(
					{ err, instanceId: instance.id },
					"Failed to register webhook target in qui",
				);
				// If qui's error message echoes the URL we sent (e.g., a
				// "couldn't reach <url>" 500), it would leak the plaintext
				// secret back through the response and into any client-side
				// logging. Strip `secret=...` defensively before relaying.
				const rawMessage = getErrorMessage(err, "qui registration failed");
				const safeMessage = rawMessage.replace(/secret=[^&\s"']+/g, "secret=***");
				return reply.status(502).send({
					error: "qui rejected the notification target registration",
					message: safeMessage,
				});
			}
		},
	);

	// ────────────────────────────────────────────────────────────────────
	// Phase 5.1/5.2 — event log feed + SSE stream
	// ────────────────────────────────────────────────────────────────────

	const EVENTS_QUERY = z.object({
		cursor: z.string().optional(),
		limit: z
			.string()
			.optional()
			.transform((raw) => {
				const parsed = Number.parseInt(raw ?? "50", 10);
				if (!Number.isFinite(parsed)) return 50;
				return Math.max(1, Math.min(200, parsed));
			}),
	});

	app.get<{ Querystring: { cursor?: string; limit?: string } }>(
		"/qui/events",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { cursor, limit } = validateRequest(EVENTS_QUERY, request.query ?? {});

			let cursorReceivedAt: Date | null = null;
			if (cursor) {
				const anchor = await app.prisma.quiEventLog.findUnique({
					where: { id: cursor },
					select: { receivedAt: true, userId: true },
				});
				// Cross-tenant defense: silently drop a cursor pointing at
				// another user's row (return latest instead). Returning 403
				// here would create an enumeration vector — 200-empty does not.
				if (anchor && anchor.userId === userId) {
					cursorReceivedAt = anchor.receivedAt;
				}
			}

			const rows = await app.prisma.quiEventLog.findMany({
				where: {
					userId,
					...(cursorReceivedAt ? { receivedAt: { lt: cursorReceivedAt } } : {}),
				},
				orderBy: { receivedAt: "desc" },
				take: limit + 1,
			});
			const hasMore = rows.length > limit;
			const trimmed = hasMore ? rows.slice(0, limit) : rows;
			const nextCursor = hasMore ? (trimmed[trimmed.length - 1]?.id ?? null) : null;
			return reply.send({
				entries: trimmed.map((r) => {
					const receivedAtIso = r.receivedAt.toISOString();
					return {
						id: r.id,
						serviceInstanceId: r.serviceInstanceId,
						eventType: r.eventType,
						torrentHash: r.torrentHash,
						payload: safeParseJson(r.payload),
						receivedAt: receivedAtIso,
						/** Canonical timestamp alias — see schema notes. */
						timestamp: receivedAtIso,
					};
				}),
				nextCursor,
			});
		},
	);

	app.get("/qui/events/stream", async (request, reply) => {
		// Phase 5.2 — server-sent events stream. Delegates the headers /
		// heartbeat / cleanup pattern to `createSseHandler` so we can't
		// drift from the (already battle-tested) socket-teardown shape.
		// This handler's responsibility is just (a) name the channel
		// "qui-event" so frontend EventSource clients listen on the right
		// event type, and (b) bind subscriptions to the per-user
		// `quiEventBus`. A second push channel (e.g., auto-tag webhook
		// events) reuses the same handler with a different bus + name.
		const userId = request.currentUser!.id;
		return createSseHandler({
			request,
			reply,
			channel: "qui-events",
			eventName: "qui-event",
			primer: ": qui SSE stream open\n\n",
			subscribe: (listener, log) => quiEventBus.subscribe(userId, listener, log),
		});
	});

	done();
};

function safeParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

export const registerQuiRoutes = quiRoute;
