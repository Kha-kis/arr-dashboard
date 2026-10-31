/**
 * Jellyfin Analytics Routes
 *
 * Aggregates SessionSnapshot data for Jellyfin instances. Reuses the same
 * pure helper functions as the Plex analytics routes since the snapshot
 * format is identical — instances are differentiated by service: "JELLYFIN".
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import {
	isArithmeticAuthoritativeProviderObservationStatus,
	type JellyfinDisplayInstance,
	readOwnedJellyfinEpisodeDisplaySources,
} from "../../lib/jellyfin/jellyfin-display-evidence.js";
import {
	readSessionSnapshotMetricsPages,
	readSessionSnapshotPages,
} from "../../lib/statistics/session-snapshot-pages.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { analyticsQuery } from "../plex/analytics-schemas.js";
import {
	activityCollectionMeasurement,
	projectDailyActivityCollection,
} from "../plex/lib/activity-collection-helpers.js";
import { createBandwidthAnalyticsAccumulator } from "../plex/lib/bandwidth-analytics-helpers.js";
import { createCodecAnalyticsAccumulator } from "../plex/lib/codec-analytics-helpers.js";
import { createDeviceAnalyticsAccumulator } from "../plex/lib/device-analytics-helpers.js";
import { createForecastAccumulator } from "../plex/lib/forecast-helpers.js";
import { createMostConcurrentAccumulator } from "../plex/lib/most-concurrent-helpers.js";
import { createPlaysByDateAccumulator } from "../plex/lib/plays-by-date-helpers.js";
import { createQualityScoreAccumulator } from "../plex/lib/quality-score-helpers.js";
import { createTopMediaAccumulator } from "../plex/lib/top-media-helpers.js";
import { createTranscodeAnalyticsAccumulator } from "../plex/lib/transcode-analytics-helpers.js";
import { createUserAnalyticsAccumulator } from "../plex/lib/user-analytics-helpers.js";
import { aggregateUserEpisodeCompletion } from "../plex/lib/user-episode-helpers.js";
import { createWatchHistoryAccumulator } from "../plex/lib/watch-history-helpers.js";

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
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createTranscodeAnalyticsAccumulator();
		const read = await readSessionSnapshotPages(app.prisma, {
			userId,
			services: ["JELLYFIN", "EMBY"],
			cutoff,
			includeCollectionByDate: true,
			onPage: (page) => accumulator.addSnapshots(page),
		});

		const { parseFailures, totalSnapshots, ...analytics } = accumulator.getResult(
			read.collection,
			read.collectionByDate,
		);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, route: "jellyfin/transcode-analytics" },
				"Session snapshot parse failures detected",
			);
		}
		return reply.send({
			...analytics,
			measurement: { ...analytics.measurement, configuredSources: read.instanceCount },
		});
	});

	/**
	 * GET /api/jellyfin/analytics/bandwidth?days=30
	 *
	 * Bandwidth usage and concurrent stream trends.
	 */
	app.get("/bandwidth", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createBandwidthAnalyticsAccumulator();
		const read = await readSessionSnapshotMetricsPages(app.prisma, {
			userId,
			services: ["JELLYFIN", "EMBY"],
			cutoff,
			includeCollectionByDate: true,
			onPage: (page) => accumulator.addSnapshots(page),
		});

		const { parseFailures, totalSnapshots, ...analytics } = accumulator.getResult(
			read.collection,
			read.collectionByDate,
		);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, route: "jellyfin/bandwidth-analytics" },
				"Session snapshot parse failures detected",
			);
		}
		return reply.send({
			...analytics,
			measurement: { ...analytics.measurement, configuredSources: read.instanceCount },
		});
	});

	/**
	 * GET /api/jellyfin/analytics/users?days=30
	 *
	 * Per-user session analytics and estimated watch time.
	 */
	app.get("/users", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createUserAnalyticsAccumulator();
		const read = await readSessionSnapshotPages(app.prisma, {
			userId,
			services: ["JELLYFIN", "EMBY"],
			cutoff,
			includeCollectionByDate: true,
			onPage: (page) => accumulator.addSnapshots(page),
		});

		const { parseFailures, totalSnapshots, ...analytics } = accumulator.getResult(
			read.collection,
			read.collectionByDate,
		);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, route: "jellyfin/user-analytics" },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send({
			...analytics,
			measurement: { ...analytics.measurement, configuredSources: read.instanceCount },
		});
	});

	/**
	 * GET /api/jellyfin/analytics/history?days=7&limit=50
	 *
	 * Deduplicated recent watch history timeline.
	 */
	app.get("/history", async (request, reply) => {
		const { days, limit } = validateRequest(watchHistoryQuery, request.query);
		const userId = request.currentUser!.id;

		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createWatchHistoryAccumulator(limit);
		const read = await readSessionSnapshotPages(
			app.prisma,
			{
				userId,
				services: ["JELLYFIN", "EMBY"],
				cutoff,
				onPage: (page) => accumulator.addBatch(page),
			},
			"reverse-chronological",
		);

		const { events, parseFailures, totalSnapshots, failedPreviews } = accumulator.getResult();
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, failedPreviews, route: "jellyfin/watch-history" },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send({ events, measurement: activityCollectionMeasurement(read) });
	});

	/**
	 * GET /api/jellyfin/analytics/codec?days=30
	 *
	 * Video/audio codec and resolution distribution.
	 */
	app.get("/codec", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createCodecAnalyticsAccumulator();
		const read = await readSessionSnapshotPages(app.prisma, {
			userId,
			services: ["JELLYFIN", "EMBY"],
			cutoff,
			onPage: (page) => accumulator.addSnapshots(page),
		});
		const {
			parseFailures,
			totalSnapshots,
			failedPreviews: _unusedPreviews,
			...analytics
		} = accumulator.getResult(read.collection);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, route: "jellyfin/codec-analytics" },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send({
			...analytics,
			measurement: { ...analytics.measurement, configuredSources: read.instanceCount },
		});
	});

	/**
	 * GET /api/jellyfin/analytics/devices?days=30
	 *
	 * Device and platform distribution.
	 */
	app.get("/devices", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createDeviceAnalyticsAccumulator();
		const read = await readSessionSnapshotPages(app.prisma, {
			userId,
			services: ["JELLYFIN", "EMBY"],
			cutoff,
			onPage: (page) => accumulator.addSnapshots(page),
		});
		const {
			parseFailures,
			totalSnapshots,
			failedPreviews: _unusedPreviews,
			...analytics
		} = accumulator.getResult(read.collection);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, route: "jellyfin/device-analytics" },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send({
			...analytics,
			measurement: {
				...analytics.measurement,
				configuredSources: read.instanceCount,
				platformAxis: "client",
			},
		});
	});

	// ── Quality Score ─────────────────────────────────────────────
	app.get("/quality-score", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createQualityScoreAccumulator();
		const read = await readSessionSnapshotPages(app.prisma, {
			userId,
			services: ["JELLYFIN", "EMBY"],
			cutoff,
			includeCollectionByDate: true,
			onPage: (page) => accumulator.addBatch(page),
		});

		const { parseFailures, totalSnapshots, ...analytics } = accumulator.getResult(
			read.collection,
			read.collectionByDate,
		);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, route: "jellyfin/quality-score" },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send({
			...analytics,
			measurement: { ...analytics.measurement, configuredSources: read.instanceCount },
		});
	});

	// ── Bandwidth Forecast ────────────────────────────────────────
	app.get("/forecast", async (request, reply) => {
		const { days } = validateRequest(analyticsQuery, request.query);
		const userId = request.currentUser!.id;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createForecastAccumulator();
		const read = await readSessionSnapshotMetricsPages(app.prisma, {
			userId,
			services: ["JELLYFIN", "EMBY"],
			cutoff,
			includeCollectionByDate: true,
			onPage: (page) => accumulator.addSnapshots(page),
		});

		const result = accumulator.getResult(7, read.collection, read.collectionByDate);
		return reply.send({
			...result,
			measurement: { ...result.measurement, configuredSources: read.instanceCount },
		});
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
			select: { id: true, label: true, service: true },
		});

		if (instances.length === 0) {
			return reply.send({ shows: [] });
		}

		const displayInstances: JellyfinDisplayInstance[] = instances.flatMap((instance) =>
			instance.service === "JELLYFIN" || instance.service === "EMBY"
				? [{ id: instance.id, label: instance.label, service: instance.service }]
				: [],
		);
		const displayEvidence = await readOwnedJellyfinEpisodeDisplaySources({
			prisma: app.prisma,
			userId,
			instances: displayInstances,
			showTmdbIds: tmdbIds,
		});
		if (!isArithmeticAuthoritativeProviderObservationStatus(displayEvidence.providerStatus)) {
			return reply.send({ shows: [], providerStatus: displayEvidence.providerStatus });
		}

		const episodes = displayEvidence.sources
			.flatMap((source) => source.rows)
			.filter((episode) => tmdbIds.includes(episode.showTmdbId))
			.sort(
				(left, right) =>
					left.showTmdbId - right.showTmdbId ||
					left.instanceId.localeCompare(right.instanceId) ||
					left.seasonNumber - right.seasonNumber ||
					left.episodeNumber - right.episodeNumber ||
					left.id.localeCompare(right.id),
			);

		const completionResult = aggregateUserEpisodeCompletion(episodes);
		if (completionResult.parseFailures > 0) {
			request.log.warn(
				{
					parseFailures: completionResult.parseFailures,
					totalEpisodes: completionResult.totalEpisodes,
					route: "jellyfin/episode-completion",
				},
				"Episode cache JSON parse failures detected",
			);
		}
		const shows = completionResult.shows
			.map((show) => ({
				...show,
				users: [...show.users].sort(
					(left, right) =>
						right.percent - left.percent || left.username.localeCompare(right.username),
				),
			}))
			.sort((left, right) => left.tmdbId - right.tmdbId);
		return reply.send({ shows, providerStatus: displayEvidence.providerStatus });
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
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createTopMediaAccumulator(mediaType);
		const read = await readSessionSnapshotPages(
			app.prisma,
			{
				userId,
				services: ["JELLYFIN", "EMBY"],
				cutoff,
				onPage: (page) => accumulator.addBatch(page),
			},
			"reverse-chronological",
		);

		const { parseFailures, totalSnapshots, failedPreviews, ...response } = accumulator.getResult(
			"top",
			limit,
		);
		if (parseFailures > 0) {
			request.log.warn(
				{ parseFailures, totalSnapshots, failedPreviews, route: "jellyfin/top-media", mediaType },
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send({ ...response, measurement: activityCollectionMeasurement(read) });
	});

	// ── Popular Media Leaderboard (sorted by distinct watcher count) ──
	app.get("/popular-media", async (request, reply) => {
		const { mediaType, days, limit } = validateRequest(topMediaQuery, request.query);
		const userId = request.currentUser!.id;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createTopMediaAccumulator(mediaType);
		const read = await readSessionSnapshotPages(
			app.prisma,
			{
				userId,
				services: ["JELLYFIN", "EMBY"],
				cutoff,
				onPage: (page) => accumulator.addBatch(page),
			},
			"reverse-chronological",
		);

		const { parseFailures, totalSnapshots, failedPreviews, ...response } = accumulator.getResult(
			"popular",
			limit,
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
		return reply.send({ ...response, measurement: activityCollectionMeasurement(read) });
	});

	// ── Last Watched Feed (titles deduped, sorted by most-recent watch) ──
	app.get("/last-watched", async (request, reply) => {
		const { mediaType, days, limit } = validateRequest(topMediaQuery, request.query);
		const userId = request.currentUser!.id;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createTopMediaAccumulator(mediaType);
		const read = await readSessionSnapshotPages(
			app.prisma,
			{
				userId,
				services: ["JELLYFIN", "EMBY"],
				cutoff,
				onPage: (page) => accumulator.addBatch(page),
			},
			"reverse-chronological",
		);

		const { parseFailures, totalSnapshots, failedPreviews, ...response } = accumulator.getResult(
			"last-watched",
			limit,
		);
		if (parseFailures > 0) {
			request.log.warn(
				{
					parseFailures,
					totalSnapshots,
					failedPreviews,
					route: "jellyfin/last-watched",
					mediaType,
				},
				"Session snapshot JSON parse failures detected",
			);
		}
		return reply.send({ ...response, measurement: activityCollectionMeasurement(read) });
	});

	// ── Most Concurrent Peaks (snapshot-level, no sessionsJson parse) ──
	const mostConcurrentQuery = z.object({
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
				const n = val ? Number.parseInt(val, 10) : 5;
				return Number.isFinite(n) && n > 0 ? Math.min(n, 25) : 5;
			}),
	});

	app.get("/most-concurrent", async (request, reply) => {
		const { days, limit } = validateRequest(mostConcurrentQuery, request.query);
		const userId = request.currentUser!.id;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createMostConcurrentAccumulator({ limit });
		const read = await readSessionSnapshotMetricsPages(
			app.prisma,
			{
				userId,
				services: ["JELLYFIN", "EMBY"],
				cutoff,
				onPage: (page) => accumulator.addSnapshots(page),
			},
			"most-concurrent",
		);

		const result = accumulator.getResult(read.collection);
		return reply.send({
			...result,
			measurement: { ...result.measurement, configuredSources: read.instanceCount },
		});
	});

	// ── Plays By Date (per-day plays, segmented by mediaType) ──────
	const playsByDateQuery = z.object({
		days: z
			.string()
			.optional()
			.transform((val) => {
				const n = val ? Number.parseInt(val, 10) : 30;
				return Number.isFinite(n) && n > 0 ? Math.min(n, 90) : 30;
			}),
	});

	app.get("/plays-by-date", async (request, reply) => {
		const { days } = validateRequest(playsByDateQuery, request.query);
		const userId = request.currentUser!.id;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		const accumulator = createPlaysByDateAccumulator({ days });
		const read = await readSessionSnapshotPages(app.prisma, {
			userId,
			services: ["JELLYFIN", "EMBY"],
			cutoff,
			onPage: (page) => accumulator.addBatch(page),
			includeCollectionByDate: true,
		});
		return reply.send(projectDailyActivityCollection(accumulator.getResult(), read));
	});
}
