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

import type {
	DiskWasteItem,
	DiskWasteInsightsResponse,
	RequestedUnwatchedItem,
	RequestedUnwatchedInsightsResponse,
	WatchInsightAvailability,
} from "@arr/shared";
import type { FastifyBaseLogger, FastifyInstance, FastifyPluginCallback } from "fastify";
import { z } from "zod";
import {
	readOwnedJellyfinLibraryDisplaySources,
	type JellyfinDisplayInstance,
} from "../../lib/jellyfin/jellyfin-display-evidence.js";
import {
	type JellyfinInsightWatchEvidence,
	readOwnedJellyfinInsightWatchEvidence,
} from "../../lib/library-insights/watch-evidence.js";
import {
	PlexAuthorityService,
	summarizePlexEvidence,
} from "../../lib/plex/plex-authority-service.js";
import {
	createWatchInsightDisplay,
	insightTarget,
	type InsightTarget,
	type InsightWatchSource,
} from "../../lib/library-insights/watch-insight-display.js";
import { authorizeProviderEvidenceUse } from "../../lib/provider-observation/evidence-capabilities.js";
import { projectWatchDisplayEvidence } from "../../lib/provider-observation/watch-display-evidence.js";
import { SeerrClient } from "../../lib/seerr/seerr-client.js";
import { safeJsonParse } from "../../lib/utils/json.js";
import { validateRequest } from "../../lib/utils/validate.js";

// ============================================================================
// Types
// ============================================================================

interface WatchedMonitoredItem {
	arrItemId: number;
	instanceId: string;
	instanceName: string;
	service: string;
	title: string;
	year: number | null;
	sizeOnDisk: number;
	watchCount: number;
	watchCountSemantics: "exact" | "lower-bound";
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

type WatchData = Map<
	string,
	{ watchCount: number; lastWatchedAt: Date | null; watchCountSemantics: "exact" | "lower-bound" }
>;

function mergeWatchRow(
	watchData: WatchData,
	mediaType: string,
	tmdbId: number,
	watchCount: number,
	lastWatchedAt: Date | null,
	watchCountSemantics: "exact" | "lower-bound" = "exact",
) {
	const key = `${mediaType}:${tmdbId}`;
	const existing = watchData.get(key);
	if (existing) {
		// Providers and shared-library instances may observe the same plays.
		// Their maximum is a proven lower bound; summing could double-count.
		existing.watchCount = Math.max(existing.watchCount, watchCount);
		existing.watchCountSemantics = "lower-bound";
		existing.lastWatchedAt = null;
	} else {
		watchData.set(key, { watchCount, lastWatchedAt, watchCountSemantics });
	}
}

function mergeInsightRows(watchData: WatchData, rows: JellyfinInsightWatchEvidence["rows"]) {
	for (const row of rows) {
		mergeWatchRow(
			watchData,
			row.mediaType,
			row.tmdbId,
			row.watchCount,
			row.lastWatchedAt,
			row.watchCountSemantics,
		);
	}
}

function providerStatusResponse(evidence: JellyfinInsightWatchEvidence) {
	return evidence.providerStatus ? { providerStatus: evidence.providerStatus } : {};
}

async function readWatchDisplay(
	app: FastifyInstance,
	userId: string,
	log: FastifyBaseLogger,
	targets: InsightTarget[],
) {
	const uniqueTargets = [
		...new Map(targets.map((target) => [`${target.mediaType}:${target.tmdbId}`, target])).values(),
	];
	const [plex, instances] = await Promise.all([
		new PlexAuthorityService({
			prisma: app.prisma,
			encryptor: app.encryptor,
			log,
		}).readUserSelectedDisplay({
			userId,
			selection: { kind: "targets", targets: uniqueTargets },
			domains: ["membership", "watch"],
		}),
		app.prisma.serviceInstance.findMany({
			where: { userId, enabled: true, service: { in: ["JELLYFIN", "EMBY"] } },
			select: { id: true, label: true, service: true },
		}),
	]);
	const jellyfin = await readOwnedJellyfinLibraryDisplaySources({
		prisma: app.prisma,
		userId,
		instances: instances as JellyfinDisplayInstance[],
	});
	const sources: InsightWatchSource[] = plex.map((source) => ({
		provider: "plex",
		status: source.providerStatus,
		rows: source.available ? source.rows : [],
	}));
	for (const instance of instances) {
		const statuses =
			jellyfin.providerStatus?.sources.filter(
				(source) => source.instanceId === instance.id && source.cacheType === "jellyfin",
			) ?? [];
		const entries = jellyfin.sources.filter((source) => source.instanceId === instance.id);
		sources.push({
			provider: "jellyfin",
			status: statuses.length === 1 ? statuses[0]!.status : undefined,
			rows: entries.length === 1 ? entries[0]!.rows : [],
		});
	}
	return {
		...createWatchInsightDisplay(sources),
		evidence: plex.length > 0 ? summarizePlexEvidence(plex) : undefined,
		providerStatus: jellyfin.providerStatus,
	};
}

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

		const bound = params.limit * 3;
		const candidates =
			instanceIds.length === 0
				? []
				: await app.prisma.libraryCache.findMany({
						where: {
							instanceId: { in: instanceIds },
							instance: { userId },
							hasFile: true,
							sizeOnDisk: { gte: minSizeBytes },
							arrAddedAt: { lte: cutoffDate },
						},
						orderBy: [{ sizeOnDisk: "desc" }, { id: "asc" }],
						take: bound + 1,
					});
		const selected = candidates.slice(0, bound);
		const watch = await readWatchDisplay(
			app,
			userId,
			request.log,
			selected.flatMap((item) => {
				const target = insightTarget(item);
				return target ? [target] : [];
			}),
		);
		const items: DiskWasteItem[] = [];
		const unknownItems: DiskWasteItem[] = [];
		let limited = candidates.length > bound;
		let hasUnknown = false;
		for (const item of selected) {
			const watchState = watch.classify(insightTarget(item));
			if (watchState === "watched") continue;
			if (watchState === "unknown") hasUnknown = true;
			const destination = watchState === "unknown" ? unknownItems : items;
			if (destination.length >= params.limit) {
				limited = true;
				continue;
			}
			const inst = instanceMap.get(item.instanceId);
			if (!inst) continue;
			destination.push({
				arrItemId: item.arrItemId,
				instanceId: item.instanceId,
				instanceName: inst.label,
				service: inst.service.toLowerCase(),
				title: item.title,
				year: item.year,
				sizeOnDisk: Number(item.sizeOnDisk),
				addedDaysAgo: item.arrAddedAt
					? Math.floor((Date.now() - item.arrAddedAt.getTime()) / 86400000)
					: 0,
				monitored: item.monitored,
				qualityProfileName: item.qualityProfileName,
				watchState,
			});
		}
		const watchStatus = watch.status(hasUnknown);
		const response: DiskWasteInsightsResponse = {
			success: true,
			data: {
				items,
				unknownItems,
				totalWastedBytes:
					watchStatus === "complete" ? items.reduce((sum, item) => sum + item.sizeOnDisk, 0) : null,
				hasPlexData: watch.hasPlexData,
				hasWatchData: watch.hasWatchData,
				watchStatus,
				limited,
			},
			evidence: watch.evidence,
			providerStatus: watch.providerStatus,
		};
		return reply.send(response);
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

		// Bound provider reads to the owned, monitored candidates shown by this panel.
		const candidates = await app.prisma.libraryCache.findMany({
			where: {
				instanceId: { in: instanceIds },
				instance: { userId },
				monitored: true,
				hasFile: true,
			},
			orderBy: { sizeOnDisk: "desc" },
			take: params.limit * 5,
		});
		const targets = new Map<string, { tmdbId: number; mediaType: "movie" | "series" }>();
		for (const candidate of candidates) {
			const parsed = safeJsonParse(candidate.data) as { remoteIds?: { tmdbId?: unknown } } | null;
			const tmdbId = parsed?.remoteIds?.tmdbId;
			if (typeof tmdbId !== "number" || !Number.isSafeInteger(tmdbId) || tmdbId <= 0) continue;
			const mediaType = candidate.itemType === "movie" ? "movie" : "series";
			targets.set(`${mediaType}:${tmdbId}`, { tmdbId, mediaType });
		}
		const [plexEvidence, jellyfinInstances] = await Promise.all([
			new PlexAuthorityService({
				prisma: app.prisma,
				encryptor: app.encryptor,
				log: request.log,
			}).readUserSelectedDisplay({
				userId,
				selection: { kind: "targets", targets: [...targets.values()] },
				domains: ["membership", "watch"],
			}),
			app.prisma.serviceInstance.findMany({
				where: { userId, enabled: true, service: { in: ["JELLYFIN", "EMBY"] } },
				select: { id: true, label: true, service: true },
			}),
		]);
		const watchData: WatchData = new Map();
		let hasPlexData = false;
		for (const source of plexEvidence) {
			if (!source.available) continue;
			for (const row of source.rows) {
				const display = projectWatchDisplayEvidence({ status: source.providerStatus, row });
				if (display.watchCount === null || !source.providerStatus) continue;
				const decision = authorizeProviderEvidenceUse(source.providerStatus, {
					domain: "watch-count",
					use: "positive-predicate",
					field: "watch-count",
					operator: "greater_than",
					threshold: 0,
					observedValue: display.watchCount,
					targetObserved: true,
				});
				if (!decision.authorized || display.watchCountSemantics === "unknown") continue;
				hasPlexData = true;
				mergeWatchRow(
					watchData,
					row.mediaType,
					row.tmdbId,
					display.watchCount,
					display.lastWatchedAt ? new Date(display.lastWatchedAt) : null,
					display.watchCountSemantics,
				);
			}
		}
		const jellyfinWatchEvidence = await readOwnedJellyfinInsightWatchEvidence({
			prisma: app.prisma,
			userId,
			instances: jellyfinInstances as JellyfinDisplayInstance[],
		});
		mergeInsightRows(watchData, jellyfinWatchEvidence.rows);

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
				watchCountSemantics: watchInfo.watchCountSemantics,
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
				hasPlexData,
				hasWatchData: hasPlexData || jellyfinWatchEvidence.hasPositiveEvidence,
			},
			...(plexEvidence.length > 0 ? { evidence: summarizePlexEvidence(plexEvidence) } : {}),
			...providerStatusResponse(jellyfinWatchEvidence),
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
			where: { userId, enabled: true, service: "SEERR" },
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

		// Request coverage and watch coverage are independent; keep known requests even if either source is partial.
		const seerrMap = new Map<string, { requestedBy: string; createdAt: string }>();
		let requestStatus: WatchInsightAvailability = seerrInstance ? "partial" : "not-configured";
		let requestPages = 0;
		if (seerrInstance) {
			try {
				const client = new SeerrClient(app.arrClientFactory, seerrInstance, request.log);
				const take = 50;
				for (let page = 0; page < 20; page++) {
					const result = await client.getRequests({ take, skip: page * take, filter: "available" });
					requestPages++;
					for (const req of result.results) {
						const key = `${req.type}:${req.media.tmdbId}`;
						if (!seerrMap.has(key))
							seerrMap.set(key, {
								requestedBy: req.requestedBy.displayName,
								createdAt: req.createdAt,
							});
					}
					if (result.results.length < take) {
						requestStatus = "complete";
						break;
					}
				}
			} catch {
				request.log.warn("Seerr request evidence is incomplete for requested-unwatched insights");
				requestStatus = requestPages > 0 ? "partial" : "unavailable";
			}
		}
		const userInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, enabled: true, service: { in: ["SONARR", "RADARR"] } },
			select: { id: true, label: true, service: true },
		});
		const instanceMap = new Map(userInstances.map((instance) => [instance.id, instance]));
		const bound = params.limit * 5;
		const candidates =
			userInstances.length === 0 || seerrMap.size === 0
				? []
				: await app.prisma.libraryCache.findMany({
						where: {
							instanceId: { in: userInstances.map((instance) => instance.id) },
							instance: { userId },
							hasFile: true,
							arrAddedAt: { lte: new Date(Date.now() - params.minAgeDays * 86400000) },
						},
						orderBy: [{ arrAddedAt: "desc" }, { id: "asc" }],
						take: bound + 1,
					});
		const selected = candidates.slice(0, bound);
		const watch = await readWatchDisplay(
			app,
			userId,
			request.log,
			selected.flatMap((item) => {
				const target = insightTarget(item);
				return target ? [target] : [];
			}),
		);
		const items: RequestedUnwatchedItem[] = [];
		const unknownItems: RequestedUnwatchedItem[] = [];
		let limited = candidates.length > bound || requestStatus === "partial";
		let hasUnknown = false;
		for (const item of selected) {
			const target = insightTarget(item);
			if (!target) {
				limited = true;
				continue;
			} // No safe way to correlate this ARR file to a Seerr request.
			const seerrInfo = seerrMap.get(
				`${target.mediaType === "movie" ? "movie" : "tv"}:${target.tmdbId}`,
			);
			if (!seerrInfo) continue;
			const watchState = watch.classify(target);
			if (watchState === "watched") continue;
			if (watchState === "unknown") hasUnknown = true;
			const destination = watchState === "unknown" ? unknownItems : items;
			if (destination.length >= params.limit) {
				limited = true;
				continue;
			}
			const inst = instanceMap.get(item.instanceId);
			if (!inst) continue;
			destination.push({
				arrItemId: item.arrItemId,
				instanceId: item.instanceId,
				instanceName: inst.label,
				service: inst.service.toLowerCase(),
				title: item.title,
				year: item.year,
				sizeOnDisk: Number(item.sizeOnDisk),
				addedDaysAgo: item.arrAddedAt
					? Math.floor((Date.now() - item.arrAddedAt.getTime()) / 86400000)
					: 0,
				requestedBy: seerrInfo.requestedBy,
				requestedAt: seerrInfo.createdAt,
				watchState,
			});
		}
		const response: RequestedUnwatchedInsightsResponse = {
			success: true,
			data: {
				items,
				unknownItems,
				hasSeerrData: requestPages > 0,
				hasPlexData: watch.hasPlexData,
				hasWatchData: watch.hasWatchData,
				watchStatus: watch.status(hasUnknown),
				requestStatus,
				limited,
			},
			evidence: watch.evidence,
			providerStatus: watch.providerStatus,
		};
		return reply.send(response);
	});

	done();
};
