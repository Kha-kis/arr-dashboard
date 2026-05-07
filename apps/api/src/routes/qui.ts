import { normalizeTorrentState } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { backfillInfoHashForRow } from "../lib/library-sync/infohash-backfill.js";
import { createQuiClient } from "../lib/qui/client-factory.js";
import { listQuiInstances, requireQuiInstance } from "../lib/qui/instance-helpers.js";
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

	done();
};

export const registerQuiRoutes = quiRoute;
