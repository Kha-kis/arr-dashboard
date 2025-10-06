import { historyItemSchema } from "@arr/shared";
import type { HistoryItem } from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { createInstanceFetcher } from "../../lib/arr/arr-fetcher.js";
import { fetchHistoryItems } from "../../lib/dashboard/fetch-utils.js";

const historyQuerySchema = z.object({
	page: z.coerce.number().min(1).optional().default(1),
	pageSize: z.coerce.number().min(1).max(500).optional().default(100),
	startDate: z.string().optional(),
	endDate: z.string().optional(),
});

/**
 * History-related routes for the dashboard
 */
export const historyRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * GET /dashboard/history
	 * Fetches download history from all enabled Sonarr, Radarr, and Prowlarr instances
	 */
	app.get("/dashboard/history", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);
			return { instances: [], aggregated: [], totalCount: 0 };
		}

		const { startDate, endDate } = historyQuerySchema.parse(request.query ?? {});

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId: request.currentUser.id, enabled: true },
		});

		const results: Array<{
			instanceId: string;
			instanceName: string;
			service: "sonarr" | "radarr" | "prowlarr";
			data: HistoryItem[];
			totalRecords: number;
		}> = [];
		const allItems: HistoryItem[] = [];

		// Fetch all available records from each instance
		for (const instance of instances) {
			const service = instance.service.toLowerCase();
			if (service !== "sonarr" && service !== "radarr" && service !== "prowlarr") {
				continue;
			}

			try {
				const fetcher = createInstanceFetcher(app, instance as ServiceInstance);
				// Fetch all records (no pagination) - let client handle pagination
				const { items, totalRecords } = await fetchHistoryItems(
					fetcher,
					service,
					1,
					10000,
					startDate,
					endDate,
				);
				const enriched = items.map((item) => ({
					...item,
					instanceId: instance.id,
					instanceName: instance.label,
				}));
				const validated = enriched.map((entry) => historyItemSchema.parse(entry));
				results.push({
					instanceId: instance.id,
					instanceName: instance.label,
					service,
					data: validated,
					totalRecords,
				});
				allItems.push(...validated);
			} catch (error) {
				request.log.error({ err: error, instance: instance.id }, "history fetch failed");
				results.push({
					instanceId: instance.id,
					instanceName: instance.label,
					service,
					data: [],
					totalRecords: 0,
				});
			}
		}

		// Sort all items by date descending
		allItems.sort((a, b) => {
			const dateA = a.date ? new Date(a.date).getTime() : 0;
			const dateB = b.date ? new Date(b.date).getTime() : 0;
			return dateB - dateA;
		});

		return reply.send({
			instances: results,
			aggregated: allItems,
			totalCount: allItems.length,
		});
	});

	done();
};
