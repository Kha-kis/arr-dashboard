import {
	coerceQuiAction,
	coerceQuiActionStatus,
	normalizeTorrentState,
	quiActionSchema,
	quiBulkActionRequestSchema,
	quiTorrentActionRequestSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import {
	runEpisodeBackfillSweep,
	runEpisodeFileSync,
} from "../lib/library-sync/episode-file-backfill.js";
import { backfillInfoHashForRow } from "../lib/library-sync/infohash-backfill.js";
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
			const body = validateRequest(quiTorrentActionRequestSchema, request.body ?? {});
			const qbitInstanceId = Number.parseInt(instanceId, 10);
			if (!Number.isFinite(qbitInstanceId)) {
				return reply.status(400).send({ error: "qbit instanceId must be numeric" });
			}
			// Discriminated invariant: `setTags` is the only action that
			// consumes a body. Reject the empty-body case explicitly so qui
			// doesn't have to (and so we don't write a misleading audit row
			// with payload: null for a setTags request). Other actions
			// ignore `tags` when present — that's qui's contract, not ours.
			if (action === "setTags" && (body.tags === undefined || body.tags.length === 0)) {
				return reply.status(400).send({
					error: "setTags requires a non-empty `tags` field in the request body",
				});
			}

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
				tags: body.tags,
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
		const body = validateRequest(quiBulkActionRequestSchema, request.body);
		const qbitInstanceId = Number.parseInt(instanceId, 10);
		if (!Number.isFinite(qbitInstanceId)) {
			return reply.status(400).send({ error: "qbit instanceId must be numeric" });
		}
		// Same setTags invariant as the single-torrent route.
		if (action === "setTags" && (body.tags === undefined || body.tags.length === 0)) {
			return reply.status(400).send({
				error: "setTags requires a non-empty `tags` field in the request body",
			});
		}

		const instance = await requireQuiInstance(app, userId, id);
		const client = createQuiClient(app, instance);

		const result = await executeQuiAction({
			app,
			client,
			userId,
			serviceInstanceId: instance.id,
			qbitInstanceId,
			hashes: body.hashes,
			action,
			tags: body.tags,
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
