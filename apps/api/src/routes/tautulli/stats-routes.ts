/**
 * Tautulli Statistics Routes
 *
 * Watch trends, per-user stats, and leaderboards from Tautulli.
 */

import type {
	TautulliPlaysByDateResponse,
	TautulliStatisticsAvailability,
	TautulliStatsResponse,
} from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import type { TautulliClient } from "../../lib/tautulli/tautulli-client.js";
import {
	executeOnTautulliInstances,
	type TautulliInstanceResult,
} from "../../lib/tautulli/tautulli-helpers.js";
import { validateRequest } from "../../lib/utils/validate.js";

const statsQuery = z.object({
	timeRange: z
		.string()
		.optional()
		.transform((val) => {
			const n = Number(val);
			return Number.isFinite(n) && n > 0 ? n : 30;
		}),
});

async function collectStatistics<T>(
	app: FastifyInstance,
	userId: string,
	operation: (client: TautulliClient) => Promise<T>,
) {
	// Include enabled but unverified sources in coverage, without granting them
	// permission to perform provider reads. The existing helper retains its
	// before/after identity checks and discards authority-rejected observations.
	const configured = await app.prisma.serviceInstance.findMany({
		where: { userId, service: "TAUTULLI", enabled: true },
		select: { id: true },
	});
	const result = await executeOnTautulliInstances(app, userId, operation);
	const successful = new Map(
		result.instances
			.filter((entry): entry is TautulliInstanceResult<T> => entry.success)
			.map((entry) => [entry.instanceId, entry]),
	);
	const instances = configured.flatMap(({ id }) => {
		const entry = successful.get(id);
		return entry ? [entry] : [];
	});
	const availability: TautulliStatisticsAvailability = {
		status:
			configured.length === 0
				? "not-configured"
				: instances.length === 0
					? "unavailable"
					: instances.length === configured.length
						? "complete"
						: "partial",
		configuredSources: configured.length,
		availableSources: instances.length,
	};
	return { instances, availability };
}

export async function registerStatsRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/tautulli/stats?timeRange=30
	 *
	 * Aggregated stats: user watch time + home stats (most watched, top users, etc.)
	 */
	app.get("/", async (request, reply) => {
		const { timeRange } = validateRequest(statsQuery, request.query);
		const userId = request.currentUser!.id;

		const result = await collectStatistics(app, userId, async (client) => {
			const [homeStats, userStats] = await Promise.all([
				client.getHomeStats(timeRange),
				client.getUserStats(timeRange),
			]);
			return { homeStats, userStats };
		});
		if (result.availability.status === "unavailable") {
			return reply
				.status(503)
				.send({ error: "Tautulli statistics are unavailable", availability: result.availability });
		}

		// Merge home stats by statId (same stat from multiple instances → merge rows)
		const homeStatsMap = new Map<
			string,
			{
				statTitle: string;
				rows: Map<
					string,
					{
						title: string;
						friendlyName?: string;
						totalPlays: number;
						totalDuration: number;
						platform?: string;
						thumb?: string;
					}
				>;
			}
		>();
		// Merge user stats by userId (sum plays/duration across instances)
		const userStatsMap = new Map<
			number,
			{ friendlyName: string; totalPlays: number; totalDuration: number }
		>();

		for (const instanceResult of result.instances) {
			if (!instanceResult.success) continue;
			const { homeStats, userStats } = instanceResult.data;

			for (const stat of homeStats) {
				let existing = homeStatsMap.get(stat.stat_id);
				if (!existing) {
					existing = { statTitle: stat.stat_title, rows: new Map() };
					homeStatsMap.set(stat.stat_id, existing);
				}
				for (const r of stat.rows) {
					const rowKey = r.title;
					const prev = existing.rows.get(rowKey);
					if (prev) {
						prev.totalPlays += r.total_plays;
						prev.totalDuration += r.total_duration;
					} else {
						existing.rows.set(rowKey, {
							title: r.title,
							friendlyName: r.friendly_name,
							totalPlays: r.total_plays,
							totalDuration: r.total_duration,
							platform: r.platform,
							thumb: r.thumb,
						});
					}
				}
			}

			for (const stat of userStats) {
				const prev = userStatsMap.get(stat.user_id);
				if (prev) {
					prev.totalPlays += stat.total_plays;
					prev.totalDuration += stat.total_duration;
				} else {
					userStatsMap.set(stat.user_id, {
						friendlyName: stat.friendly_name,
						totalPlays: stat.total_plays,
						totalDuration: stat.total_duration,
					});
				}
			}
		}

		const mergedHomeStats: TautulliStatsResponse["homeStats"] = [...homeStatsMap.entries()].map(
			([statId, { statTitle, rows }]) => ({
				statId,
				statTitle,
				rows: [...rows.values()].sort((a, b) => b.totalPlays - a.totalPlays),
			}),
		);
		const mergedUserStats: TautulliStatsResponse["userStats"] = [...userStatsMap.entries()].map(
			([userId, data]) => ({ userId, ...data }),
		);

		const response: TautulliStatsResponse = {
			homeStats: mergedHomeStats,
			userStats: mergedUserStats,
			timeRange,
			availability: result.availability,
		};

		return reply.send(response);
	});

	/**
	 * GET /api/tautulli/stats/plays-by-date?timeRange=30
	 *
	 * Time-series data for sparkline charts: play counts per day.
	 */
	app.get("/plays-by-date", async (request, reply) => {
		const { timeRange } = validateRequest(statsQuery, request.query);
		const userId = request.currentUser!.id;

		const result = await collectStatistics(app, userId, async (client) => {
			return client.getPlaysByDate(timeRange);
		});
		if (result.availability.status === "unavailable") {
			return reply
				.status(503)
				.send({ error: "Tautulli statistics are unavailable", availability: result.availability });
		}

		// Merge play-by-date data from all instances
		const mergedCategories = new Set<string>();
		const seriesMap = new Map<string, Map<string, number>>();

		for (const instanceResult of result.instances) {
			if (!instanceResult.success) continue;
			const { categories, series } = instanceResult.data;

			for (const cat of categories) mergedCategories.add(cat);

			for (const s of series) {
				if (!seriesMap.has(s.name)) {
					seriesMap.set(s.name, new Map());
				}
				const dataMap = seriesMap.get(s.name)!;
				for (let i = 0; i < categories.length; i++) {
					const cat = categories[i]!;
					const current = dataMap.get(cat) ?? 0;
					dataMap.set(cat, current + (s.data[i] ?? 0));
				}
			}
		}

		const sortedCategories = [...mergedCategories].sort();
		const mergedSeries = [...seriesMap.entries()].map(([name, dataMap]) => ({
			name,
			data: sortedCategories.map((cat) => dataMap.get(cat) ?? 0),
		}));

		const response: TautulliPlaysByDateResponse = {
			categories: sortedCategories,
			series: mergedSeries,
			timeRange,
			availability: result.availability,
		};

		return reply.send(response);
	});
}
