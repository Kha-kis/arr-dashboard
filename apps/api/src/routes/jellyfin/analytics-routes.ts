/**
 * Jellyfin Analytics Routes
 *
 * Aggregates SessionSnapshot data for Jellyfin instances. Reuses the same
 * pure helper functions as the Plex analytics routes since the snapshot
 * format is identical — instances are differentiated by service: "JELLYFIN".
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { validateRequest } from "../../lib/utils/validate.js";
import { analyticsQuery } from "../plex/analytics-schemas.js";
import { aggregateBandwidthAnalytics } from "../plex/lib/bandwidth-analytics-helpers.js";
import { aggregateCodecAnalytics } from "../plex/lib/codec-analytics-helpers.js";
import { aggregateDeviceAnalytics } from "../plex/lib/device-analytics-helpers.js";
import { computeForecast } from "../plex/lib/forecast-helpers.js";
import { computeQualityScore } from "../plex/lib/quality-score-helpers.js";
import { aggregatePopularMedia, aggregateTopMedia } from "../plex/lib/top-media-helpers.js";
import { aggregateTranscodeAnalytics } from "../plex/lib/transcode-analytics-helpers.js";
import { aggregateUserAnalytics } from "../plex/lib/user-analytics-helpers.js";
import { aggregateUserEpisodeCompletion } from "../plex/lib/user-episode-helpers.js";
import { deduplicateWatchEvents } from "../plex/lib/watch-history-helpers.js";

const watchHistoryQuery = z.object({
	days: z
		.string()
		.optional()
		.transform((val) => {
			const n = val ? Number.parseInt(val, 10) : 7;
			return Number.isFinite(n) && n > 0 ? Math.min(n, 90) : 7;
		}),
	limit: z
		.string()
		.optional()
		.transform((val) => {
			const n = val ? Number.parseInt(val, 10) : 50;
			return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 50;
		}),
});

export async function registerAnalyticsRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/jellyfin/analytics/transcode?days=30
	 *
	 * Transcode / direct play / direct stream breakdown.
	 */
	app.get("/transcode", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true },
		});

		if (instances.length === 0) {
			return reply.send({
				directPlay: 0,
				transcode: 0,
				directStream: 0,
				totalSessions: 0,
				dailyBreakdown: [],
			});
		}

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const snapshots = await app.prisma.sessionSnapshot.findMany({
			where: { instanceId: { in: instances.map((i) => i.id) }, capturedAt: { gte: cutoff } },
			select: {
				capturedAt: true,
				directPlayCount: true,
				transcodeCount: true,
				directStreamCount: true,
			},
			orderBy: { capturedAt: "asc" },
			take: 50000,
		});

		const { parseFailures, totalSnapshots, ...analytics } = aggregateTranscodeAnalytics(snapshots);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, route: "jellyfin/transcode-analytics" },
				"Session snapshot parse failures detected",
			);
		}
		return reply.send(analytics);
	});

	/**
	 * GET /api/jellyfin/analytics/bandwidth?days=30
	 *
	 * Bandwidth usage and concurrent stream trends.
	 */
	app.get("/bandwidth", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true },
		});

		if (instances.length === 0) {
			return reply.send({
				peakConcurrent: 0,
				peakBandwidth: 0,
				avgBandwidth: 0,
				timeSeries: [],
			});
		}

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const snapshots = await app.prisma.sessionSnapshot.findMany({
			where: { instanceId: { in: instances.map((i) => i.id) }, capturedAt: { gte: cutoff } },
			select: {
				capturedAt: true,
				concurrentStreams: true,
				totalBandwidth: true,
				lanBandwidth: true,
				wanBandwidth: true,
			},
			orderBy: { capturedAt: "asc" },
			take: 50000,
		});

		const { parseFailures, totalSnapshots, ...analytics } = aggregateBandwidthAnalytics(snapshots);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, route: "jellyfin/bandwidth-analytics" },
				"Session snapshot parse failures detected",
			);
		}
		return reply.send(analytics);
	});

	/**
	 * GET /api/jellyfin/analytics/users?days=30
	 *
	 * Per-user session analytics and estimated watch time.
	 */
	app.get("/users", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true },
		});

		if (instances.length === 0) {
			return reply.send({ users: [], dailyBreakdown: [] });
		}

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const snapshots = await app.prisma.sessionSnapshot.findMany({
			where: { instanceId: { in: instances.map((i) => i.id) }, capturedAt: { gte: cutoff } },
			select: { capturedAt: true, sessionsJson: true },
			orderBy: { capturedAt: "asc" },
			take: 50000,
		});

		const { parseFailures, totalSnapshots, failedPreviews, ...analytics } =
			aggregateUserAnalytics(snapshots);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, failedPreviews, route: "jellyfin/user-analytics" },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send(analytics);
	});

	/**
	 * GET /api/jellyfin/analytics/history?days=7&limit=50
	 *
	 * Deduplicated recent watch history timeline.
	 */
	app.get("/history", async (request, reply) => {
		const { days, limit } = validateRequest(watchHistoryQuery, request.query);
		const userId = request.currentUser!.id;

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true },
		});

		if (instances.length === 0) {
			return reply.send({ events: [] });
		}

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const snapshots = await app.prisma.sessionSnapshot.findMany({
			where: { instanceId: { in: instances.map((i) => i.id) }, capturedAt: { gte: cutoff } },
			select: { capturedAt: true, sessionsJson: true },
			orderBy: { capturedAt: "desc" },
			take: 10000,
		});

		const { events, parseFailures, totalSnapshots, failedPreviews } = deduplicateWatchEvents(
			snapshots,
			limit,
		);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, failedPreviews, route: "jellyfin/watch-history" },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send({ events });
	});

	/**
	 * GET /api/jellyfin/analytics/codec?days=30
	 *
	 * Video/audio codec and resolution distribution.
	 */
	app.get("/codec", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true },
		});

		if (instances.length === 0) {
			return reply.send({
				videoCodecs: [],
				audioCodecs: [],
				resolutions: [],
				totalSessions: 0,
			});
		}

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const snapshots = await app.prisma.sessionSnapshot.findMany({
			where: { instanceId: { in: instances.map((i) => i.id) }, capturedAt: { gte: cutoff } },
			select: { sessionsJson: true },
			orderBy: { capturedAt: "asc" },
			take: 50000,
		});

		const { parseFailures, totalSnapshots, failedPreviews, ...analytics } =
			aggregateCodecAnalytics(snapshots);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, failedPreviews, route: "jellyfin/codec-analytics" },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send(analytics);
	});

	/**
	 * GET /api/jellyfin/analytics/devices?days=30
	 *
	 * Device and platform distribution.
	 */
	app.get("/devices", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true },
		});

		if (instances.length === 0) {
			return reply.send({ platforms: [], players: [], totalSessions: 0 });
		}

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const snapshots = await app.prisma.sessionSnapshot.findMany({
			where: { instanceId: { in: instances.map((i) => i.id) }, capturedAt: { gte: cutoff } },
			select: { sessionsJson: true },
			orderBy: { capturedAt: "asc" },
			take: 50000,
		});

		const { parseFailures, totalSnapshots, failedPreviews, ...analytics } =
			aggregateDeviceAnalytics(snapshots);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, failedPreviews, route: "jellyfin/device-analytics" },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send(analytics);
	});

	// ── Quality Score ─────────────────────────────────────────────
	app.get("/quality-score", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true },
		});

		if (instances.length === 0) {
			return reply.send({
				overallScore: 0,
				breakdown: { directPlayScore: 0, resolutionScore: 0, transcodeScore: 0 },
				trend: [],
				perUser: [],
			});
		}

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const snapshots = await app.prisma.sessionSnapshot.findMany({
			where: { instanceId: { in: instances.map((i) => i.id) }, capturedAt: { gte: cutoff } },
			select: { capturedAt: true, sessionsJson: true },
			orderBy: { capturedAt: "asc" },
			take: 50000,
		});

		const { parseFailures, totalSnapshots, failedPreviews, ...analytics } =
			computeQualityScore(snapshots);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, failedPreviews, route: "jellyfin/quality-score" },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send(analytics);
	});

	// ── Bandwidth Forecast ────────────────────────────────────────
	app.get("/forecast", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true },
		});

		if (instances.length === 0) {
			return reply.send({
				historicalDaily: [],
				forecast: [],
				peakHours: [],
				trend: "stable",
			});
		}

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const snapshots = await app.prisma.sessionSnapshot.findMany({
			where: { instanceId: { in: instances.map((i) => i.id) }, capturedAt: { gte: cutoff } },
			select: { capturedAt: true, totalBandwidth: true, concurrentStreams: true },
			orderBy: { capturedAt: "asc" },
			take: 50000,
		});

		return reply.send(computeForecast(snapshots));
	});

	// ── User Episode Completion ───────────────────────────────────
	const episodeCompletionQuery = z.object({
		tmdbIds: z.string().transform((val) =>
			val
				.split(",")
				.map((s) => Number.parseInt(s.trim(), 10))
				.filter((n) => Number.isFinite(n) && n > 0),
		),
	});

	app.get("/episode-completion", async (request, reply) => {
		const { tmdbIds } = validateRequest(episodeCompletionQuery, request.query);
		const userId = request.currentUser!.id;

		if (tmdbIds.length === 0 || tmdbIds.length > 200) {
			return reply.send({ shows: [] });
		}

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true },
		});

		if (instances.length === 0) {
			return reply.send({ shows: [] });
		}

		const episodes = await app.prisma.jellyfinEpisodeCache.findMany({
			where: {
				instanceId: { in: instances.map((i) => i.id) },
				showTmdbId: { in: tmdbIds },
			},
			select: { showTmdbId: true, watched: true, watchedByUsers: true },
		});

		const { parseFailures, totalEpisodes, failedPreviews, ...completion } =
			aggregateUserEpisodeCompletion(episodes);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalEpisodes, failedPreviews, route: "jellyfin/episode-completion" },
				"Episode cache JSON parse failures detected",
			);
		}
		return reply.send(completion);
	});

	// ── Top Media Leaderboard ─────────────────────────────────────
	const topMediaQuery = z.object({
		mediaType: z.enum(["movie", "series", "music"]),
		days: z
			.string()
			.optional()
			.transform((val) => {
				const n = val ? Number.parseInt(val, 10) : 30;
				return Number.isFinite(n) && n > 0 ? Math.min(n, 90) : 30;
			}),
		limit: z
			.string()
			.optional()
			.transform((val) => {
				const n = val ? Number.parseInt(val, 10) : 10;
				return Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 10;
			}),
	});

	app.get("/top-media", async (request, reply) => {
		const { mediaType, days, limit } = validateRequest(topMediaQuery, request.query);
		const userId = request.currentUser!.id;

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true },
		});

		if (instances.length === 0) {
			return reply.send({ items: [] });
		}

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const snapshots = await app.prisma.sessionSnapshot.findMany({
			where: { instanceId: { in: instances.map((i) => i.id) }, capturedAt: { gte: cutoff } },
			select: { capturedAt: true, sessionsJson: true },
			orderBy: { capturedAt: "asc" },
			take: 50000,
		});

		const { parseFailures, totalSnapshots, failedPreviews, ...response } = aggregateTopMedia(
			snapshots,
			{ mediaType, limit },
		);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, failedPreviews, route: "jellyfin/top-media", mediaType },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send(response);
	});

	// ── Popular Media Leaderboard (sorted by distinct watcher count) ──
	app.get("/popular-media", async (request, reply) => {
		const { mediaType, days, limit } = validateRequest(topMediaQuery, request.query);
		const userId = request.currentUser!.id;

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true },
		});

		if (instances.length === 0) {
			return reply.send({ items: [] });
		}

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const snapshots = await app.prisma.sessionSnapshot.findMany({
			where: { instanceId: { in: instances.map((i) => i.id) }, capturedAt: { gte: cutoff } },
			select: { capturedAt: true, sessionsJson: true },
			orderBy: { capturedAt: "asc" },
			take: 50000,
		});

		const { parseFailures, totalSnapshots, failedPreviews, ...response } = aggregatePopularMedia(
			snapshots,
			{ mediaType, limit },
		);
		if (parseFailures > 0) {
			request.log.warn(
				{
					parseFailures,
					totalSnapshots,
					failedPreviews,
					route: "jellyfin/popular-media",
					mediaType,
				},
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send(response);
	});
}
