import type { FastifyPluginCallback } from "fastify";
import type { SearchRequest, SearchResult } from "@arr/shared";
import { multiInstanceSearchResponseSchema, searchRequestSchema } from "@arr/shared";
import {
	executeOnInstances,
	isProwlarrClient,
} from "../../lib/arr/client-helpers.js";
import { performProwlarrSearchWithSdk } from "../../lib/search/prowlarr-api.js";

/**
 * Registers search query routes for Prowlarr.
 *
 * Routes:
 * - POST /search/query - Perform a manual search across Prowlarr instances
 */
export const registerQueryRoutes: FastifyPluginCallback = (app, _opts, done) => {
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
	 * POST /search/query
	 * Performs a manual search query across one or more Prowlarr instances.
	 * Supports filtering by indexer IDs and categories per instance.
	 */
	app.post("/search/query", async (request, reply) => {
		const payload = searchRequestSchema.parse(request.body ?? {});

		// Build a map of instance-specific filters
		const filterMap = new Map<string, { indexerIds?: number[]; categories?: number[] }>();
		if (payload.filters && payload.filters.length > 0) {
			for (const filter of payload.filters) {
				filterMap.set(filter.instanceId, {
					indexerIds: filter.indexerIds,
					categories: filter.categories,
				});
			}
		}

		// Determine which instances to query
		const instanceIds = filterMap.size > 0
			? Array.from(filterMap.keys())
			: undefined;

		const response = await executeOnInstances(
			app,
			request.currentUser!.id,
			{
				serviceTypes: ["PROWLARR"],
				instanceIds,
			},
			async (client, instance) => {
				if (!isProwlarrClient(client)) {
					return [];
				}

				// Get filter options for this instance
				const filter = filterMap.get(instance.id);

				return performProwlarrSearchWithSdk(client, instance, {
					query: payload.query,
					type: payload.type,
					limit: payload.limit ?? 100,
					indexerIds: filter?.indexerIds,
					categories: filter?.categories,
				});
			},
		);

		// Transform results to match expected format
		const results = response.instances.map((result) => ({
			instanceId: result.instanceId,
			instanceName: result.instanceName,
			data: result.success ? result.data : [],
		}));

		return multiInstanceSearchResponseSchema.parse({
			instances: results,
			aggregated: response.aggregated,
			totalCount: response.totalCount,
		});
	});

	done();
};
