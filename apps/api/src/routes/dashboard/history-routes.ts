import { historyItemSchema } from "@arr/shared";
import type { HistoryItem } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import {
	executeOnInstances,
	isSonarrClient,
	isRadarrClient,
	isProwlarrClient,
	isLidarrClient,
	isReadarrClient,
} from "../../lib/arr/client-helpers.js";
import { normalizeHistoryItem, type HistoryService } from "../../lib/dashboard/history-utils.js";

/**
 * Query schema for history endpoint.
 * Note: Pagination is handled client-side after filtering/sorting aggregated results
 * from multiple instances. Backend fetches up to 2500 records per instance.
 */
const historyQuerySchema = z.object({
	startDate: z.string().optional(),
	endDate: z.string().optional(),
});

/**
 * History-related routes for the dashboard
 */
export const historyRoutes: FastifyPluginCallback = (app, _opts, done) => {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser!.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	/**
	 * GET /dashboard/history
	 * Fetches download history from all enabled Sonarr, Radarr, Prowlarr, Lidarr, and Readarr instances
	 */
	app.get("/dashboard/history", async (request, reply) => {
		const { startDate, endDate } = historyQuerySchema.parse(request.query ?? {});

		const response = await executeOnInstances(
			app,
			request.currentUser!.id,
			{ serviceTypes: ["SONARR", "RADARR", "PROWLARR", "LIDARR", "READARR"] },
			async (client, instance) => {
				const service = instance.service.toLowerCase() as HistoryService;
				const recordLimit = 2500;

				// Fetch history using SDK with pagination params
				let rawRecords: unknown[] = [];
				let totalRecords = 0;

				if (isSonarrClient(client)) {
					const result = await client.history.get({
						page: 1,
						pageSize: recordLimit,
						sortKey: "date",
						sortDirection: "descending",
						...(startDate && { since: startDate }),
						...(endDate && { until: endDate }),
					});
					rawRecords = result.records ?? [];
					totalRecords = result.totalRecords ?? rawRecords.length;
				} else if (isRadarrClient(client)) {
					const result = await client.history.get({
						page: 1,
						pageSize: recordLimit,
						sortKey: "date",
						sortDirection: "descending",
						...(startDate && { since: startDate }),
						...(endDate && { until: endDate }),
					});
					rawRecords = result.records ?? [];
					totalRecords = result.totalRecords ?? rawRecords.length;
				} else if (isProwlarrClient(client)) {
					const result = await client.history.get({
						page: 1,
						pageSize: recordLimit,
						sortKey: "date",
						sortDirection: "descending",
					});
					rawRecords = result.records ?? [];
					totalRecords = result.totalRecords ?? rawRecords.length;
				} else if (isLidarrClient(client)) {
					const result = await client.history.get({
						page: 1,
						pageSize: recordLimit,
						sortKey: "date",
						sortDirection: "descending",
						...(startDate && { since: startDate }),
						...(endDate && { until: endDate }),
					});
					rawRecords = result.records ?? [];
					totalRecords = result.totalRecords ?? rawRecords.length;
				} else if (isReadarrClient(client)) {
					const result = await client.history.get({
						page: 1,
						pageSize: recordLimit,
						sortKey: "date",
						sortDirection: "descending",
						...(startDate && { since: startDate }),
						...(endDate && { until: endDate }),
					});
					rawRecords = result.records ?? [];
					totalRecords = result.totalRecords ?? rawRecords.length;
				}

				// Normalize and enrich items
				const items = rawRecords.map((raw) => {
					const normalized = normalizeHistoryItem(raw, service);
					return historyItemSchema.parse({
						...normalized,
						instanceId: instance.id,
						instanceName: instance.label,
					});
				});

				return {
					items,
					totalRecords,
				};
			},
		);

		// Transform results to match expected format
		const results = response.instances.map((result) => ({
			instanceId: result.instanceId,
			instanceName: result.instanceName,
			service: result.service as HistoryService,
			data: result.success ? result.data.items : [],
			totalRecords: result.success ? result.data.totalRecords : 0,
		}));

		// Collect all items for aggregation
		const allItems: HistoryItem[] = [];
		for (const result of response.instances) {
			if (result.success) {
				allItems.push(...result.data.items);
			}
		}

		// Sort all items by date descending
		allItems.sort((a, b) => {
			const dateA = a.date ? new Date(a.date).getTime() : 0;
			const dateB = b.date ? new Date(b.date).getTime() : 0;
			return dateB - dateA;
		});

		// Return all items - frontend will handle pagination after filtering
		return reply.send({
			instances: results,
			aggregated: allItems,
			totalCount: allItems.length,
		});
	});

	done();
};
