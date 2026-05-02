import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
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

		// v1 supports movies only — series infoHash is per-episode and the
		// detail modal renders the series, not an episode. Phase 2 work.
		if (itemType !== "movie") {
			return reply.send({
				supported: false,
				reason: "Per-item torrent health is currently movies-only.",
			});
		}

		const cached = await app.prisma.libraryCache.findFirst({
			where: { instanceId: arrInstanceId, arrItemId, itemType: "movie" },
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
		// history for this specific item. One small request that pays off
		// forever — subsequent panel opens hit the cache.
		if (!infoHash) {
			const arrInstance = await app.prisma.serviceInstance.findFirst({
				where: { id: arrInstanceId, userId, service: "RADARR" },
			});
			if (arrInstance) {
				try {
					const response = await app.arrClientFactory.rawRequest(
						{
							id: arrInstance.id,
							baseUrl: arrInstance.baseUrl,
							encryptedApiKey: arrInstance.encryptedApiKey,
							encryptionIv: arrInstance.encryptionIv,
							service: arrInstance.service,
							label: arrInstance.label,
						},
						// No eventType filter — the integer values vary across *arr
						// versions. We grab the latest records and pick the first one
						// that carries a downloadId (grab/import both preserve it).
						`/api/v3/history?movieId=${arrItemId}&pageSize=10&sortKey=date&sortDirection=descending`,
					);
					if (response.ok) {
						const data = (await response.json()) as {
							records?: Array<{ downloadId?: string }>;
						};
						const found = data.records?.find(
							(r) => typeof r.downloadId === "string" && r.downloadId.length >= 32,
						);
						if (found?.downloadId) {
							infoHash = found.downloadId.toLowerCase();
							await app.prisma.libraryCache.update({
								where: { id: cached.id },
								data: { infoHash },
							});
						}
					}
				} catch (error) {
					app.log.warn(
						{ err: error, arrInstanceId, arrItemId },
						"infoHash backfill from *arr history failed",
					);
				}
			}
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
