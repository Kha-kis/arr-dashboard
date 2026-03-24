/**
 * Library Insights Digest
 *
 * Periodically checks for "requested but unwatched" items and sends
 * a notification summary if any are found. Runs every 6 hours with
 * a 24-hour cooldown between notifications to prevent spam.
 */

import type { FastifyBaseLogger } from "fastify";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { PrismaClient } from "../prisma.js";
import { SeerrClient } from "../seerr/seerr-client.js";
import { safeJsonParse } from "../utils/json.js";
import type { NotificationPayload } from "./types.js";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours between notifications
const MIN_AGE_DAYS = 7; // Only consider items available for 7+ days

const MIN_WATCH_COUNT = 1; // Minimum plays to qualify for watched-monitored signal

export class InsightsDigestScheduler {
	private intervalId: NodeJS.Timeout | null = null;
	private lastNotifiedRequestedUnwatched: number = 0;
	private lastNotifiedWatchedMonitored: number = 0;

	constructor(
		private prisma: PrismaClient,
		private logger: FastifyBaseLogger,
		private arrClientFactory: ArrClientFactory,
		private notifyFn?: (payload: NotificationPayload) => Promise<void>,
	) {}

	start() {
		if (this.intervalId) {
			this.logger.warn("Insights digest scheduler already running");
			return;
		}

		this.logger.info("Starting insights digest scheduler");

		// First check after 5 minutes (let other services warm up)
		setTimeout(() => {
			this.check().catch((err) => {
				this.logger.error({ err }, "Failed initial insights digest check");
			});
		}, 5 * 60 * 1000);

		this.intervalId = setInterval(() => {
			this.check().catch((err) => {
				this.logger.error({ err }, "Failed insights digest check");
			});
		}, CHECK_INTERVAL_MS);
	}

	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
			this.logger.info("Insights digest scheduler stopped");
		}
	}

	private async check() {
		if (!this.notifyFn) return;

		// Single-admin app — get the first user
		const user = await this.prisma.user.findFirst({ select: { id: true } });
		if (!user) return;

		// Signal 1: Requested but unwatched
		await this.checkRequestedUnwatched(user.id);

		// Signal 2: Watched but still monitored
		await this.checkWatchedMonitored(user.id);
	}

	private async checkRequestedUnwatched(userId: string) {
		if (Date.now() - this.lastNotifiedRequestedUnwatched < COOLDOWN_MS) return;

		const items = await this.findRequestedUnwatched(userId);
		if (items.length === 0) return;

		const topItems = items.slice(0, 5);
		const itemList = topItems.map((i) => `• ${i.title} (requested by ${i.requestedBy})`).join("\n");
		const moreText = items.length > 5 ? `\n+${items.length - 5} more` : "";

		this.notifyFn!({
			eventType: "LIBRARY_INSIGHT_REQUESTED_UNWATCHED",
			title: `${items.length} requested item${items.length !== 1 ? "s" : ""} never watched`,
			body: `The following Seerr requests are available but have not been watched after ${MIN_AGE_DAYS}+ days:\n${itemList}${moreText}`,
			url: "/library?insight=requested-unwatched",
			metadata: { count: items.length, signal: "requested_unwatched" },
		}).catch((err) => {
			this.logger.debug({ err }, "Requested-unwatched notification dispatch failed");
		});

		this.lastNotifiedRequestedUnwatched = Date.now();
		this.logger.info({ count: items.length }, "Sent requested-unwatched insights digest");
	}

	private async checkWatchedMonitored(userId: string) {
		if (Date.now() - this.lastNotifiedWatchedMonitored < COOLDOWN_MS) return;

		const items = await this.findWatchedMonitored(userId);
		if (items.length === 0) return;

		const topItems = items.slice(0, 5);
		const itemList = topItems.map((i) => `• ${i.title} (${i.watchCount} play${i.watchCount !== 1 ? "s" : ""})`).join("\n");
		const moreText = items.length > 5 ? `\n+${items.length - 5} more` : "";

		this.notifyFn!({
			eventType: "LIBRARY_INSIGHT_WATCHED_MONITORED",
			title: `${items.length} watched item${items.length !== 1 ? "s" : ""} still monitored`,
			body: `These items have been watched but are still monitored, using indexer searches for upgrades:\n${itemList}${moreText}`,
			url: "/library?insight=watched-monitored",
			metadata: { count: items.length, signal: "watched_monitored" },
		}).catch((err) => {
			this.logger.debug({ err }, "Watched-monitored notification dispatch failed");
		});

		this.lastNotifiedWatchedMonitored = Date.now();
		this.logger.info({ count: items.length }, "Sent watched-monitored insights digest");
	}

	private async findRequestedUnwatched(
		userId: string,
	): Promise<Array<{ title: string; requestedBy: string }>> {
		// Find Seerr instance
		const seerrInstance = await this.prisma.serviceInstance.findFirst({
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
		if (!seerrInstance) return [];

		// Get Plex watch data
		const plexInstances = await this.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX" },
			select: { id: true },
		});
		if (plexInstances.length === 0) return [];

		const plexWatchCounts = new Map<string, number>();
		const plexRows = await this.prisma.plexCache.findMany({
			where: { instanceId: { in: plexInstances.map((i) => i.id) } },
			select: { tmdbId: true, mediaType: true, watchCount: true },
		});
		for (const row of plexRows) {
			const key = `${row.mediaType}:${row.tmdbId}`;
			plexWatchCounts.set(key, (plexWatchCounts.get(key) ?? 0) + row.watchCount);
		}

		// Fetch available Seerr requests
		let seerrRequests: Array<{
			tmdbId: number;
			type: "movie" | "tv";
			requestedBy: string;
			title: string;
		}> = [];

		try {
			const client = new SeerrClient(this.arrClientFactory, seerrInstance, this.logger);
			const take = 50;
			let skip = 0;

			for (let page = 0; page < 10; page++) {
				const result = await client.getRequests({ take, skip, filter: "available" });
				for (const req of result.results) {
					seerrRequests.push({
						tmdbId: req.media.tmdbId,
						type: req.type,
						requestedBy: req.requestedBy.displayName,
						title: req.media.title ?? req.media.originalTitle ?? `TMDB ${req.media.tmdbId}`,
					});
				}
				if (result.results.length < take) break;
				skip += take;
			}
		} catch (error) {
			this.logger.warn({ err: error }, "Failed to fetch Seerr requests for insights digest");
			return [];
		}

		if (seerrRequests.length === 0) return [];

		// Get library items (Sonarr/Radarr)
		const userInstances = await this.prisma.serviceInstance.findMany({
			where: { userId, enabled: true, service: { in: ["SONARR", "RADARR"] } },
			select: { id: true },
		});

		const cutoffDate = new Date(Date.now() - MIN_AGE_DAYS * 24 * 60 * 60 * 1000);
		const libraryItems = await this.prisma.libraryCache.findMany({
			where: {
				instanceId: { in: userInstances.map((i) => i.id) },
				hasFile: true,
				arrAddedAt: { lte: cutoffDate },
			},
			select: { data: true, itemType: true },
			take: 500,
		});

		// Build tmdbId set from library
		const libraryTmdbIds = new Map<string, boolean>();
		for (const item of libraryItems) {
			const parsed = safeJsonParse(item.data) as Record<string, unknown> | null;
			if (!parsed) continue;
			const remoteIds = parsed.remoteIds as Record<string, unknown> | undefined;
			const tmdbId = remoteIds?.tmdbId;
			if (!tmdbId) continue;
			// Seerr uses "movie" | "tv"
			const seerrKey = `${item.itemType === "movie" ? "movie" : "tv"}:${tmdbId}`;
			libraryTmdbIds.set(seerrKey, true);
		}

		// Cross-reference: requested + in library + not watched
		const results: Array<{ title: string; requestedBy: string }> = [];

		for (const req of seerrRequests) {
			const seerrKey = `${req.type}:${req.tmdbId}`;
			if (!libraryTmdbIds.has(seerrKey)) continue; // Not in library

			// Plex uses "movie" | "series"
			const plexKey = `${req.type === "movie" ? "movie" : "series"}:${req.tmdbId}`;
			const watchCount = plexWatchCounts.get(plexKey) ?? 0;
			if (watchCount > 0) continue; // Already watched

			results.push({ title: req.title, requestedBy: req.requestedBy });
		}

		return results;
	}

	private async findWatchedMonitored(
		userId: string,
	): Promise<Array<{ title: string; watchCount: number }>> {
		// Get Plex watch data
		const plexInstances = await this.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX" },
			select: { id: true },
		});
		if (plexInstances.length === 0) return [];

		const plexWatchData = new Map<string, { watchCount: number }>();
		const plexRows = await this.prisma.plexCache.findMany({
			where: { instanceId: { in: plexInstances.map((i) => i.id) } },
			select: { tmdbId: true, mediaType: true, watchCount: true },
		});
		for (const row of plexRows) {
			const key = `${row.mediaType}:${row.tmdbId}`;
			const existing = plexWatchData.get(key);
			if (existing) {
				existing.watchCount += row.watchCount;
			} else {
				plexWatchData.set(key, { watchCount: row.watchCount });
			}
		}

		// Get monitored library items
		const userInstances = await this.prisma.serviceInstance.findMany({
			where: { userId, enabled: true, service: { in: ["SONARR", "RADARR"] } },
			select: { id: true },
		});
		if (userInstances.length === 0) return [];

		const candidates = await this.prisma.libraryCache.findMany({
			where: {
				instanceId: { in: userInstances.map((i) => i.id) },
				monitored: true,
				hasFile: true,
			},
			select: { data: true, itemType: true, title: true },
			take: 500,
		});

		const results: Array<{ title: string; watchCount: number }> = [];

		for (const item of candidates) {
			const parsed = safeJsonParse(item.data) as Record<string, unknown> | null;
			if (!parsed) continue;

			const remoteIds = parsed.remoteIds as Record<string, unknown> | undefined;
			const tmdbId = remoteIds?.tmdbId;
			if (!tmdbId) continue;

			// PlexCache stores "movie" | "series"
			const mediaType = item.itemType === "movie" ? "movie" : "series";
			const plexInfo = plexWatchData.get(`${mediaType}:${tmdbId}`);

			if (!plexInfo || plexInfo.watchCount < MIN_WATCH_COUNT) continue;

			results.push({ title: item.title, watchCount: plexInfo.watchCount });
		}

		// Sort by watch count descending
		results.sort((a, b) => b.watchCount - a.watchCount);

		return results;
	}
}
