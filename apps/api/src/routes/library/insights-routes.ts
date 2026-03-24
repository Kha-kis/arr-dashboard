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

		// Get user's Plex instances to load watch data
		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX" },
			select: { id: true },
		});

		// Build Plex watch count map: "movie:tmdbId" | "series:tmdbId" → watchCount
		const plexWatchCounts = new Map<string, number>();
		if (plexInstances.length > 0) {
			const plexRows = await app.prisma.plexCache.findMany({
				where: { instanceId: { in: plexInstances.map((i) => i.id) } },
				select: { tmdbId: true, mediaType: true, watchCount: true },
			});
			for (const row of plexRows) {
				const key = `${row.mediaType}:${row.tmdbId}`;
				const existing = plexWatchCounts.get(key) ?? 0;
				plexWatchCounts.set(key, existing + row.watchCount);
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
			const watchCount = plexWatchCounts.get(`${mediaType}:${tmdbId}`) ?? 0;

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
				hasPlexData: plexInstances.length > 0,
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
			return reply.send({ success: true, data: { items: [], hasPlexData: false } });
		}

		// Get Plex watch data — build map of mediaType:tmdbId → { watchCount, lastWatchedAt }
		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX" },
			select: { id: true },
		});

		if (plexInstances.length === 0) {
			return reply.send({ success: true, data: { items: [], hasPlexData: false } });
		}

		const plexWatchData = new Map<string, { watchCount: number; lastWatchedAt: Date | null }>();
		const plexRows = await app.prisma.plexCache.findMany({
			where: { instanceId: { in: plexInstances.map((i) => i.id) } },
			select: { tmdbId: true, mediaType: true, watchCount: true, lastWatchedAt: true },
		});
		for (const row of plexRows) {
			const key = `${row.mediaType}:${row.tmdbId}`;
			const existing = plexWatchData.get(key);
			if (existing) {
				existing.watchCount += row.watchCount;
				if (row.lastWatchedAt && (!existing.lastWatchedAt || row.lastWatchedAt > existing.lastWatchedAt)) {
					existing.lastWatchedAt = row.lastWatchedAt;
				}
			} else {
				plexWatchData.set(key, { watchCount: row.watchCount, lastWatchedAt: row.lastWatchedAt });
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

		// Match with Plex watch data
		const results: WatchedMonitoredItem[] = [];

		for (const item of candidates) {
			if (results.length >= params.limit) break;

			const parsed = safeJsonParse(item.data) as Record<string, unknown> | null;
			if (!parsed) continue;

			const remoteIds = parsed.remoteIds as Record<string, unknown> | undefined;
			const tmdbId = remoteIds?.tmdbId;
			if (!tmdbId) continue;

			// PlexCache stores "movie" | "series"
			const mediaType = item.itemType === "movie" ? "movie" : "series";
			const plexInfo = plexWatchData.get(`${mediaType}:${tmdbId}`);

			// Only include items that have actually been watched
			if (!plexInfo || plexInfo.watchCount === 0) continue;

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
				watchCount: plexInfo.watchCount,
				lastWatchedAt: plexInfo.lastWatchedAt?.toISOString() ?? null,
				qualityProfileName: item.qualityProfileName,
			});
		}

		// Sort by watch count descending — most-watched monitored items first
		results.sort((a, b) => b.watchCount - a.watchCount);

		return reply.send({
			success: true,
			data: { items: results, hasPlexData: true },
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
				service: true,
				label: true,
			},
		});

		if (!seerrInstance) {
			return reply.send({ success: true, data: { items: [], hasSeerrData: false, hasPlexData: false } });
		}

		// Get Plex watch data
		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX" },
			select: { id: true },
		});

		const plexWatchCounts = new Map<string, number>();
		if (plexInstances.length > 0) {
			const plexRows = await app.prisma.plexCache.findMany({
				where: { instanceId: { in: plexInstances.map((i) => i.id) } },
				select: { tmdbId: true, mediaType: true, watchCount: true },
			});
			for (const row of plexRows) {
				// PlexCache stores "movie" | "series"
				const key = `${row.mediaType}:${row.tmdbId}`;
				plexWatchCounts.set(key, (plexWatchCounts.get(key) ?? 0) + row.watchCount);
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
				data: { items: [], hasSeerrData: false, hasPlexData: plexInstances.length > 0 },
			});
		}

		if (seerrRequests.length === 0) {
			return reply.send({
				success: true,
				data: { items: [], hasSeerrData: true, hasPlexData: plexInstances.length > 0 },
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
				data: { items: [], hasSeerrData: true, hasPlexData: plexInstances.length > 0 },
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

			// Plex uses "movie" | "series" for keys
			const plexMediaType = item.itemType === "movie" ? "movie" : "series";
			const watchCount = plexWatchCounts.get(`${plexMediaType}:${tmdbId}`) ?? 0;
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
				hasPlexData: plexInstances.length > 0,
			},
		});
	});

	done();
};
