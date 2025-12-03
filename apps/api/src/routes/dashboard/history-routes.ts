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
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	/**
	 * GET /dashboard/history
	 * Fetches download history from all enabled Sonarr, Radarr, and Prowlarr instances
	 */
	app.get("/dashboard/history", async (request, reply) => {
		const { page, pageSize, startDate, endDate } = historyQuerySchema.parse(request.query ?? {});

		const instances = await app.prisma.serviceInstance.findMany({
			where: { enabled: true },
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
				// Fetch 2500 records from each service
				const recordLimit = 2500;
				const { items, totalRecords } = await fetchHistoryItems(
					fetcher,
					service,
					1,
					recordLimit,
					startDate,
					endDate,
				);
				const enriched = items.map((item: unknown) => ({
					...item as Record<string, unknown>,
					instanceId: instance.id,
					instanceName: instance.label,
				}));
				const validated = enriched.map((entry: unknown) => historyItemSchema.parse(entry));
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

		// Return all items - frontend will handle pagination after filtering
		return reply.send({
			instances: results,
			aggregated: allItems,
			totalCount: allItems.length,
		});
	});

	done();
};
