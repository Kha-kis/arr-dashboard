/**
 * Library Insights Routes
 *
 * Cross-service intelligence: surfaces actionable signals by correlating
 * library data with Plex watch history.
 *
 * Current signals:
 * - disk_waste: Large files with zero Plex plays, added > N days ago
 * - watched_monitored: Watched items still being monitored
 * - requested_unwatched: Seerr-requested items available but never watched
 */

import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import {
	hasAuthoritativePlexEvidence,
	scanUserPolicyEvidence,
	summarizePlexEvidence,
} from "../../lib/plex/plex-evidence-repository.js";
import { SeerrClient } from "../../lib/seerr/seerr-client.js";
import { safeJsonParse } from "../../lib/utils/json.js";
import { validateRequest } from "../../lib/utils/validate.js";

// ============================================================================
// Types
// ============================================================================

interface DiskWasteItem {
	arrItemId: number;
	instanceId: string;
	instanceName: string;
	service: string;
	title: string;
	year: number | null;
	sizeOnDisk: number;
	addedDaysAgo: number;
	monitored: boolean;
	qualityProfileName: string | null;
}

interface RequestedUnwatchedItem {
	arrItemId: number;
	instanceId: string;
	instanceName: string;
	service: string;
	title: string;
	year: number | null;
	sizeOnDisk: number;
	addedDaysAgo: number;
	requestedBy: string;
	requestedAt: string;
}

interface WatchedMonitoredItem {
	arrItemId: number;
	instanceId: string;
	instanceName: string;
	service: string;
	title: string;
	year: number | null;
	sizeOnDisk: number;
	watchCount: number;
	lastWatchedAt: string | null;
	qualityProfileName: string | null;
}

// ============================================================================
// Validation
// ============================================================================

const insightsQuerySchema = z.object({
	minSizeGb: z.coerce.number().min(0).default(1),
	minAgeDays: z.coerce.number().int().min(0).default(30),
	limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ============================================================================
// Routes
// ============================================================================

export const registerInsightsRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * GET /library/insights/disk-waste
	 * Returns library items consuming disk space with zero Plex plays
	 */
	app.get("/library/insights/disk-waste", async (request, reply) => {
		const userId = request.currentUser!.id;
		const params = validateRequest(insightsQuerySchema, request.query ?? {});
		const minSizeBytes = BigInt(Math.round(params.minSizeGb * 1024 * 1024 * 1024));
		const cutoffDate = new Date(Date.now() - params.minAgeDays * 24 * 60 * 60 * 1000);

		// Get user's instances (library services only)
		const userInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, enabled: true, service: { in: ["SONARR", "RADARR", "LIDARR", "READARR"] } },
			select: { id: true, label: true, service: true },
		});
		const instanceMap = new Map(userInstances.map((i) => [i.id, i]));
		const instanceIds = userInstances.map((i) => i.id);

		if (instanceIds.length === 0) {
			return reply.send({ success: true, data: { items: [], totalWastedBytes: 0 } });
		}

		// Get user's media server instances to load watch data
		const watchCounts = new Map<string, number>();
		const [plexEvidence, jellyfinInstances] = await Promise.all([
			scanUserPolicyEvidence(app.prisma, {
				userId,
				onBatch: ({ rows }) => {
					for (const row of rows) {
						const key = `${row.mediaType}:${row.tmdbId}`;
						watchCounts.set(key, (watchCounts.get(key) ?? 0) + row.watchCount);
					}
				},
			}),
			app.prisma.serviceInstance.findMany({
				where: { userId, service: { in: ["JELLYFIN", "EMBY"] } },
				select: { id: true },
			}),
		]);
		if (plexEvidence.length > 0 && !hasAuthoritativePlexEvidence(plexEvidence)) {
			return reply.status(503).send({
				error: "Plex cache evidence is unavailable",
				evidence: summarizePlexEvidence(plexEvidence),
			});
		}

		// Build watch count map: "movie:tmdbId" | "series:tmdbId" → watchCount
		const hasPlexAuthority = hasAuthoritativePlexEvidence(plexEvidence);
		if (jellyfinInstances.length > 0) {
			const jfRows = await app.prisma.jellyfinCache.findMany({
				where: { instanceId: { in: jellyfinInstances.map((i) => i.id) } },
				select: { tmdbId: true, mediaType: true, watchCount: true },
			});
			for (const row of jfRows) {
				const key = `${row.mediaType}:${row.tmdbId}`;
				watchCounts.set(key, (watchCounts.get(key) ?? 0) + row.watchCount);
			}
		}

		// Fetch candidate library items: has file, large, old enough
		const candidates = await app.prisma.libraryCache.findMany({
			where: {
				instanceId: { in: instanceIds },
				hasFile: true,
				sizeOnDisk: { gte: minSizeBytes },
				arrAddedAt: { lte: cutoffDate },
			},
			orderBy: { sizeOnDisk: "desc" },
			take: params.limit * 3, // Over-fetch to account for Plex-watched filtering
		});

		// Filter to items with zero Plex plays
		const now = Date.now();
		const results: DiskWasteItem[] = [];

		for (const item of candidates) {
			if (results.length >= params.limit) break;

			// Extract tmdbId from the data blob
			const parsed = safeJsonParse(item.data) as Record<string, unknown> | null;
			if (!parsed) continue;

			const remoteIds = parsed.remoteIds as Record<string, unknown> | undefined;
			const tmdbId = remoteIds?.tmdbId;

			// Skip items without tmdbId — we can't verify watch status without it
			if (!tmdbId) continue;

			// Build Plex lookup key — PlexCache stores "movie" | "series"
			const mediaType = item.itemType === "movie" ? "movie" : "series";
			if (
				(!hasPlexAuthority && jellyfinInstances.length === 0) ||
				(plexEvidence.length > 0 && !hasPlexAuthority)
			) {
				continue;
			}
			const watchCount = watchCounts.get(`${mediaType}:${tmdbId}`) ?? 0;

			// Only include items with zero watches
			if (watchCount > 0) continue;

			const inst = instanceMap.get(item.instanceId);
			const addedDaysAgo = item.arrAddedAt
				? Math.floor((now - item.arrAddedAt.getTime()) / (24 * 60 * 60 * 1000))
				: 0;

			results.push({
				arrItemId: item.arrItemId,
				instanceId: item.instanceId,
				instanceName: inst?.label ?? "Unknown",
				service: (inst?.service ?? "UNKNOWN").toLowerCase(),
				title: item.title,
				year: item.year,
				sizeOnDisk: Number(item.sizeOnDisk),
				addedDaysAgo,
				monitored: item.monitored,
				qualityProfileName: item.qualityProfileName,
			});
		}

		const totalWastedBytes = results.reduce((sum, r) => sum + r.sizeOnDisk, 0);

		return reply.send({
			success: true,
			data: {
				items: results,
				totalWastedBytes,
				hasPlexData: hasPlexAuthority,
				hasWatchData: hasPlexAuthority || jellyfinInstances.length > 0,
			},
		});
	});

	/**
	 * GET /library/insights/watched-monitored
	 * Returns library items that have been watched but are still monitored
	 */
	app.get("/library/insights/watched-monitored", async (request, reply) => {
		const userId = request.currentUser!.id;
		const params = validateRequest(
			z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
			request.query ?? {},
		);

		// Get user's library instances
		const userInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, enabled: true, service: { in: ["SONARR", "RADARR", "LIDARR", "READARR"] } },
			select: { id: true, label: true, service: true },
		});
		const instanceMap = new Map(userInstances.map((i) => [i.id, i]));
		const instanceIds = userInstances.map((i) => i.id);

		if (instanceIds.length === 0) {
			return reply.send({
				success: true,
				data: { items: [], hasPlexData: false, hasWatchData: false },
			});
		}

		// Get media server instances — Plex + Jellyfin/Emby
		const watchData = new Map<string, { watchCount: number; lastWatchedAt: Date | null }>();
		const mergeWatchRow = (key: string, watchCount: number, lastWatchedAt: Date | null) => {
			const existing = watchData.get(key);
			if (existing) {
				existing.watchCount += watchCount;
				if (lastWatchedAt && (!existing.lastWatchedAt || lastWatchedAt > existing.lastWatchedAt)) {
					existing.lastWatchedAt = lastWatchedAt;
				}
			} else {
				watchData.set(key, { watchCount, lastWatchedAt });
			}
		};
		const [plexEvidence, jellyfinInstances] = await Promise.all([
			scanUserPolicyEvidence(app.prisma, {
				userId,
				onBatch: ({ rows }) => {
					for (const row of rows) {
						mergeWatchRow(`${row.mediaType}:${row.tmdbId}`, row.watchCount, row.lastWatchedAt);
					}
				},
			}),
			app.prisma.serviceInstance.findMany({
				where: { userId, service: { in: ["JELLYFIN", "EMBY"] } },
				select: { id: true },
			}),
		]);
		if (plexEvidence.length > 0 && !hasAuthoritativePlexEvidence(plexEvidence)) {
			return reply.status(503).send({
				error: "Plex cache evidence is unavailable",
				evidence: summarizePlexEvidence(plexEvidence),
			});
		}

		if (plexEvidence.length === 0 && jellyfinInstances.length === 0) {
			return reply.send({
				success: true,
				data: { items: [], hasPlexData: false, hasWatchData: false },
			});
		}

		if (jellyfinInstances.length > 0) {
			const jfRows = await app.prisma.jellyfinCache.findMany({
				where: { instanceId: { in: jellyfinInstances.map((i) => i.id) } },
				select: { tmdbId: true, mediaType: true, watchCount: true, lastWatchedAt: true },
			});
			for (const row of jfRows) {
				mergeWatchRow(`${row.mediaType}:${row.tmdbId}`, row.watchCount, row.lastWatchedAt);
			}
		}

		// Fetch monitored library items
		const candidates = await app.prisma.libraryCache.findMany({
			where: {
				instanceId: { in: instanceIds },
				monitored: true,
				hasFile: true,
			},
			orderBy: { sizeOnDisk: "desc" },
			take: params.limit * 5, // Over-fetch — most monitored items may not be watched
		});

		// Match with watch data
		const results: WatchedMonitoredItem[] = [];

		for (const item of candidates) {
			if (results.length >= params.limit) break;

			const parsed = safeJsonParse(item.data) as Record<string, unknown> | null;
			if (!parsed) continue;

			const remoteIds = parsed.remoteIds as Record<string, unknown> | undefined;
			const tmdbId = remoteIds?.tmdbId;
			if (!tmdbId) continue;

			const mediaType = item.itemType === "movie" ? "movie" : "series";
			const watchInfo = watchData.get(`${mediaType}:${tmdbId}`);

			// Only include items that have actually been watched
			if (!watchInfo || watchInfo.watchCount === 0) continue;

			// Skip continuing/upcoming series — they should stay monitored for new episodes
			if (item.itemType === "series" && item.status && item.status !== "ended") continue;

			const inst = instanceMap.get(item.instanceId);

			results.push({
				arrItemId: item.arrItemId,
				instanceId: item.instanceId,
				instanceName: inst?.label ?? "Unknown",
				service: (inst?.service ?? "UNKNOWN").toLowerCase(),
				title: item.title,
				year: item.year,
				sizeOnDisk: Number(item.sizeOnDisk),
				watchCount: watchInfo.watchCount,
				lastWatchedAt: watchInfo.lastWatchedAt?.toISOString() ?? null,
				qualityProfileName: item.qualityProfileName,
			});
		}

		// Sort by watch count descending — most-watched monitored items first
		results.sort((a, b) => b.watchCount - a.watchCount);

		return reply.send({
			success: true,
			data: {
				items: results,
				hasPlexData: hasAuthoritativePlexEvidence(plexEvidence),
				hasWatchData: hasAuthoritativePlexEvidence(plexEvidence) || jellyfinInstances.length > 0,
			},
		});
	});

	/**
	 * GET /library/insights/requested-unwatched
	 * Returns items requested via Seerr that are in the library but never watched
	 */
	app.get("/library/insights/requested-unwatched", async (request, reply) => {
		const userId = request.currentUser!.id;
		const params = validateRequest(
			z.object({
				minAgeDays: z.coerce.number().int().min(0).default(7),
				limit: z.coerce.number().int().min(1).max(100).default(25),
			}),
			request.query ?? {},
		);

		// Find Seerr instance
		const seerrInstance = await app.prisma.serviceInstance.findFirst({
			where: { userId, service: "SEERR" },
			select: {
				id: true,
				baseUrl: true,
				encryptedApiKey: true,
				encryptionIv: true,
				encryptedHttpAuthCredentials: true,
				httpAuthEncryptionIv: true,
				service: true,
				label: true,
			},
		});

		if (!seerrInstance) {
			return reply.send({
				success: true,
				data: { items: [], hasSeerrData: false, hasPlexData: false, hasWatchData: false },
			});
		}

		// Get media server watch data — Plex + Jellyfin/Emby
		const watchCounts = new Map<string, number>();
		const [plexEvidence, jellyfinInstances] = await Promise.all([
			scanUserPolicyEvidence(app.prisma, {
				userId,
				onBatch: ({ rows }) => {
					for (const row of rows) {
						const key = `${row.mediaType}:${row.tmdbId}`;
						watchCounts.set(key, (watchCounts.get(key) ?? 0) + row.watchCount);
					}
				},
			}),
			app.prisma.serviceInstance.findMany({
				where: { userId, service: { in: ["JELLYFIN", "EMBY"] } },
				select: { id: true },
			}),
		]);
		if (plexEvidence.length > 0 && !hasAuthoritativePlexEvidence(plexEvidence)) {
			return reply.status(503).send({
				error: "Plex cache evidence is unavailable",
				evidence: summarizePlexEvidence(plexEvidence),
			});
		}

		const hasPlexAuthority = hasAuthoritativePlexEvidence(plexEvidence);
		if (jellyfinInstances.length > 0) {
			const jfRows = await app.prisma.jellyfinCache.findMany({
				where: { instanceId: { in: jellyfinInstances.map((i) => i.id) } },
				select: { tmdbId: true, mediaType: true, watchCount: true },
			});
			for (const row of jfRows) {
				const key = `${row.mediaType}:${row.tmdbId}`;
				watchCounts.set(key, (watchCounts.get(key) ?? 0) + row.watchCount);
			}
		}

		// Fetch Seerr requests — build map of tmdbId → request info
		const seerrRequests: Array<{
			tmdbId: number;
			type: "movie" | "tv";
			requestedBy: string;
			createdAt: string;
		}> = [];

		try {
			const client = new SeerrClient(app.arrClientFactory, seerrInstance, request.log);
			const take = 50;
			let skip = 0;
			const maxPages = 20;

			for (let page = 0; page < maxPages; page++) {
				const result = await client.getRequests({ take, skip, filter: "available" });
				for (const req of result.results) {
					seerrRequests.push({
						tmdbId: req.media.tmdbId,
						type: req.type,
						requestedBy: req.requestedBy.displayName,
						createdAt: req.createdAt,
					});
				}
				if (result.results.length < take) break;
				skip += take;
			}
		} catch (error) {
			request.log.warn(
				{ err: error },
				"Failed to fetch Seerr requests for insights — skipping requested-unwatched signal",
			);
			return reply.send({
				success: true,
				data: {
					items: [],
					hasSeerrData: false,
					hasPlexData: hasAuthoritativePlexEvidence(plexEvidence),
					hasWatchData: hasAuthoritativePlexEvidence(plexEvidence) || jellyfinInstances.length > 0,
				},
			});
		}

		if (seerrRequests.length === 0) {
			return reply.send({
				success: true,
				data: {
					items: [],
					hasSeerrData: true,
					hasPlexData: hasAuthoritativePlexEvidence(plexEvidence),
					hasWatchData: hasAuthoritativePlexEvidence(plexEvidence) || jellyfinInstances.length > 0,
				},
			});
		}

		// Build Seerr lookup: tmdbId → request info (Seerr uses "movie" | "tv")
		const seerrMap = new Map<string, { requestedBy: string; createdAt: string }>();
		for (const req of seerrRequests) {
			const key = `${req.type}:${req.tmdbId}`;
			if (!seerrMap.has(key)) {
				seerrMap.set(key, { requestedBy: req.requestedBy, createdAt: req.createdAt });
			}
		}

		// Get user's library instances
		const userInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, enabled: true, service: { in: ["SONARR", "RADARR"] } },
			select: { id: true, label: true, service: true },
		});
		const instanceMap = new Map(userInstances.map((i) => [i.id, i]));
		const instanceIds = userInstances.map((i) => i.id);

		if (instanceIds.length === 0) {
			return reply.send({
				success: true,
				data: {
					items: [],
					hasSeerrData: true,
					hasPlexData: hasAuthoritativePlexEvidence(plexEvidence),
					hasWatchData: hasAuthoritativePlexEvidence(plexEvidence) || jellyfinInstances.length > 0,
				},
			});
		}

		const cutoffDate = new Date(Date.now() - params.minAgeDays * 24 * 60 * 60 * 1000);

		// Fetch library items with files
		const candidates = await app.prisma.libraryCache.findMany({
			where: {
				instanceId: { in: instanceIds },
				hasFile: true,
				arrAddedAt: { lte: cutoffDate },
			},
			orderBy: { arrAddedAt: "desc" },
			take: params.limit * 5,
		});

		const now = Date.now();
		const results: RequestedUnwatchedItem[] = [];

		for (const item of candidates) {
			if (results.length >= params.limit) break;

			const parsed = safeJsonParse(item.data) as Record<string, unknown> | null;
			if (!parsed) continue;

			const remoteIds = parsed.remoteIds as Record<string, unknown> | undefined;
			const tmdbId = remoteIds?.tmdbId;
			if (!tmdbId) continue;

			// Seerr uses "movie" | "tv" for keys
			const seerrMediaType = item.itemType === "movie" ? "movie" : "tv";
			const seerrInfo = seerrMap.get(`${seerrMediaType}:${tmdbId}`);
			if (!seerrInfo) continue; // Not a Seerr-requested item

			const mediaType = item.itemType === "movie" ? "movie" : "series";
			if (
				(!hasPlexAuthority && jellyfinInstances.length === 0) ||
				(plexEvidence.length > 0 && !hasPlexAuthority)
			) {
				continue;
			}
			const watchCount = watchCounts.get(`${mediaType}:${tmdbId}`) ?? 0;
			if (watchCount > 0) continue; // Has been watched — not a candidate

			const inst = instanceMap.get(item.instanceId);
			const addedDaysAgo = item.arrAddedAt
				? Math.floor((now - item.arrAddedAt.getTime()) / (24 * 60 * 60 * 1000))
				: 0;

			results.push({
				arrItemId: item.arrItemId,
				instanceId: item.instanceId,
				instanceName: inst?.label ?? "Unknown",
				service: (inst?.service ?? "UNKNOWN").toLowerCase(),
				title: item.title,
				year: item.year,
				sizeOnDisk: Number(item.sizeOnDisk),
				addedDaysAgo,
				requestedBy: seerrInfo.requestedBy,
				requestedAt: seerrInfo.createdAt,
			});
		}

		return reply.send({
			success: true,
			data: {
				items: results,
				hasSeerrData: true,
				hasPlexData: hasPlexAuthority,
				hasWatchData: hasPlexAuthority || jellyfinInstances.length > 0,
			},
		});
	});

	done();
};
