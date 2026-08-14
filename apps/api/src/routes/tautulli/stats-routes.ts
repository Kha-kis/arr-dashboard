import type {
	TautulliAnalyticsUserStat,
	TautulliPlaysByDateResponse,
	TautulliStatsResponse,
	TautulliStatsSource,
} from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from "fastify";
import { z } from "zod";
import {
	AnalyticsProviderSelectionMismatchError,
	requireSelectedAnalyticsProvider,
} from "../../lib/analytics/provider-selection.js";
import {
	createCurrentTautulliClient,
	isTautulliConnectionChanged,
} from "../../lib/tautulli/current-tautulli-client.js";
import type { TautulliClient } from "../../lib/tautulli/tautulli-client.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { runWithConcurrency } from "../seerr/lib/enrichment-helpers.js";

const statsQuery = z.object({ timeRange: z.coerce.number().int().min(1).max(365).default(30) });
const TAUTULLI_USER_STATS_CONCURRENCY = 4;
const TAUTULLI_HOME_STATS_LIMIT = 10;

type UserStatsStatus = {
	userStatsComplete: boolean;
	failedUserCount: number;
	incompleteReason?: "user_list_unavailable" | "user_stats_partial";
};

export async function registerStatsRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	app.get("/", async (request, reply) => {
		const { timeRange } = validateRequest(statsQuery, request.query);
		const userId = request.currentUser!.id;
		if (!(await requireTautulliAnalyticsProvider(app, userId, reply))) return;
		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "TAUTULLI", enabled: true },
			orderBy: { label: "asc" },
		});
		const results = await Promise.all(
			instances.map(async (instance) => {
				try {
					const { client, ensureCurrent } = createCurrentTautulliClient(app, instance);
					const homeStats = await client.getHomeStats(timeRange, TAUTULLI_HOME_STATS_LIMIT);
					const userList = await getOptionalUsers(client, instance.id, request.log);
					await ensureCurrent();
					return {
						instance,
						client,
						ensureCurrent,
						reachable: true as const,
						homeStats,
						...userList,
					};
				} catch (error) {
					request.log.warn(
						{ err: error, instanceId: instance.id },
						"Tautulli statistics request failed",
					);
					return {
						instance,
						reachable: false as const,
						incompleteReason: isTautulliConnectionChanged(error)
							? ("connection_changed" as const)
							: ("source_unreachable" as const),
					};
				}
			}),
		);

		const userStatTasks = results.flatMap((item) =>
			item.reachable
				? item.users.map((user) => ({ client: item.client, instance: item.instance, user }))
				: [],
		);
		const userStatsByInstance = new Map<string, TautulliAnalyticsUserStat[]>();
		const userStatsStatusByInstance = new Map<string, UserStatsStatus>();
		for (const item of results) {
			if (!item.reachable) continue;
			userStatsStatusByInstance.set(item.instance.id, {
				userStatsComplete: item.userStatsComplete,
				failedUserCount: 0,
				incompleteReason: item.incompleteReason,
			});
		}

		const userStatResults = await runWithConcurrency(
			userStatTasks.map(
				({ client, instance, user }) =>
					async (): Promise<TautulliAnalyticsUserStat> => {
						const windows = await client.getUserWatchTimeStats(user.user_id, timeRange);
						const stats = windows.find((window) => window.query_days === timeRange);
						if (!stats) {
							throw new Error(
								"Tautulli user watch-time stats did not include the requested time range",
							);
						}
						return {
							userId: user.user_id,
							friendlyName: user.friendly_name?.trim() || user.username,
							totalPlays: stats.total_plays,
							totalDuration: stats.total_time,
							instanceId: instance.id,
							instanceLabel: instance.label,
						};
					},
			),
			TAUTULLI_USER_STATS_CONCURRENCY,
		);
		for (const [index, result] of userStatResults.entries()) {
			const task = userStatTasks[index]!;
			if (result.status === "fulfilled") {
				const rows = userStatsByInstance.get(task.instance.id) ?? [];
				rows.push(result.value);
				userStatsByInstance.set(task.instance.id, rows);
				continue;
			}
			const status = userStatsStatusByInstance.get(task.instance.id)!;
			status.userStatsComplete = false;
			status.failedUserCount += 1;
			status.incompleteReason = "user_stats_partial";
			request.log.warn(
				{ err: result.reason, instanceId: task.instance.id },
				"Tautulli user watch-time request failed",
			);
		}

		const sources: TautulliStatsSource[] = await Promise.all(
			results.map(async (item): Promise<TautulliStatsSource> => {
				if (!item.reachable) {
					return unavailableStatsSource(item.instance, item.incompleteReason);
				}
				try {
					await item.ensureCurrent();
					const status = userStatsStatusByInstance.get(item.instance.id)!;
					return {
						instanceId: item.instance.id,
						instanceLabel: item.instance.label,
						reachable: true,
						homeStats: item.homeStats,
						userStats: (userStatsByInstance.get(item.instance.id) ?? []).sort(
							(left, right) => right.totalDuration - left.totalDuration,
						),
						rankingLimit: TAUTULLI_HOME_STATS_LIMIT,
						...status,
					};
				} catch (error) {
					return unavailableStatsSource(
						item.instance,
						isTautulliConnectionChanged(error) ? "connection_changed" : "source_unreachable",
					);
				}
			}),
		);

		const response: TautulliStatsResponse = {
			provider: "tautulli",
			configured: instances.length > 0,
			sources,
			timeRange,
		};
		return reply.send(response);
	});

	app.get("/plays-by-date", async (request, reply) => {
		const { timeRange } = validateRequest(statsQuery, request.query);
		const userId = request.currentUser!.id;
		if (!(await requireTautulliAnalyticsProvider(app, userId, reply))) return;
		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "TAUTULLI", enabled: true },
			orderBy: { label: "asc" },
		});
		const sources = await Promise.all(
			instances.map(async (instance) => {
				try {
					const { client, ensureCurrent } = createCurrentTautulliClient(app, instance);
					const data = await client.getPlaysByDate(timeRange);
					await ensureCurrent();
					return {
						instanceId: instance.id,
						instanceLabel: instance.label,
						reachable: true as const,
						categories: data.categories,
						series: data.series,
					};
				} catch (error) {
					request.log.warn(
						{ err: error, instanceId: instance.id },
						"Tautulli plays-by-date request failed",
					);
					return {
						instanceId: instance.id,
						instanceLabel: instance.label,
						reachable: false as const,
						incompleteReason: isTautulliConnectionChanged(error)
							? ("connection_changed" as const)
							: ("source_unreachable" as const),
						categories: [],
						series: [],
					};
				}
			}),
		);
		const response: TautulliPlaysByDateResponse = {
			provider: "tautulli",
			configured: instances.length > 0,
			sources,
			timeRange,
		};
		return reply.send(response);
	});
}

async function requireTautulliAnalyticsProvider(
	app: FastifyInstance,
	userId: string,
	reply: FastifyReply,
): Promise<boolean> {
	try {
		await requireSelectedAnalyticsProvider(app.prisma, userId, "tautulli");
		return true;
	} catch (error) {
		if (error instanceof AnalyticsProviderSelectionMismatchError) {
			reply.status(409).send({
				error: "ANALYTICS_PROVIDER_NOT_SELECTED",
				expected: error.expected,
				actual: error.actual,
			});
			return false;
		}
		throw error;
	}
}

function unavailableStatsSource(
	instance: { id: string; label: string },
	incompleteReason: "source_unreachable" | "connection_changed",
): TautulliStatsSource {
	return {
		instanceId: instance.id,
		instanceLabel: instance.label,
		reachable: false,
		incompleteReason,
		homeStats: [],
		userStats: [],
		rankingLimit: TAUTULLI_HOME_STATS_LIMIT,
		userStatsComplete: false,
		failedUserCount: 0,
	};
}

async function getOptionalUsers(
	client: TautulliClient,
	instanceId: string,
	log: FastifyInstance["log"],
): Promise<{
	users: Awaited<ReturnType<TautulliClient["getUsers"]>>;
	userStatsComplete: boolean;
	incompleteReason?: "user_list_unavailable";
}> {
	try {
		return { users: await client.getUsers(), userStatsComplete: true };
	} catch (error) {
		log.warn({ err: error, instanceId }, "Tautulli user identity request failed");
		return {
			users: [],
			userStatsComplete: false,
			incompleteReason: "user_list_unavailable",
		};
	}
}
