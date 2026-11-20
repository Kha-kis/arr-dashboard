import { multiInstanceSearchResponseSchema, searchRequestSchema } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { executeOnInstances, isProwlarrClient } from "../../lib/arr/client-helpers.js";
import { createArrServiceFingerprint } from "../../lib/arr/service-fingerprint.js";
import { issueSearchGrabSelector, searchGrabTargetSchema } from "../../lib/search/grab-selector.js";
import { performProwlarrSearchWithSdk } from "../../lib/search/prowlarr-api.js";
import { validateRequest } from "../../lib/utils/validate.js";

/**
 * Registers search query routes for Prowlarr.
 *
 * Routes:
 * - POST /search/query - Perform a manual search across Prowlarr instances
 */
export const registerQueryRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * POST /search/query
	 * Performs a manual search query across one or more Prowlarr instances.
	 * Supports filtering by indexer IDs and categories per instance.
	 */
	app.post("/search/query", async (request, _reply) => {
		const payload = validateRequest(searchRequestSchema, request.body ?? {});

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
		const instanceIds = filterMap.size > 0 ? Array.from(filterMap.keys()) : undefined;

		const response = await executeOnInstances(
			app,
			request.currentUser!.id,
			{
				serviceTypes: ["PROWLARR"],
				instanceIds,
			},
			async (client, instance) => {
				if (!isProwlarrClient(client)) {
					throw new Error("Configured Prowlarr instance has an incompatible client");
				}

				// Get filter options for this instance
				const filter = filterMap.get(instance.id);

				const batch = await performProwlarrSearchWithSdk(client, instance, {
					query: payload.query,
					type: payload.type,
					limit: payload.limit ?? 100,
					indexerIds: filter?.indexerIds,
					categories: filter?.categories,
				});
				const connectionFingerprint = createArrServiceFingerprint(instance);
				return {
					...batch,
					results: batch.results.map((result) => {
						// Only the accepted provider GUID/indexer pair is action evidence;
						// an id or download URL can still be a display-only fallback.
						const target = searchGrabTargetSchema.safeParse({
							userId: request.currentUser!.id,
							serviceInstanceId: instance.id,
							connectionFingerprint,
							guid: result.guid,
							indexerId: result.indexerId,
						});
						return target.success
							? { ...result, grabSelector: issueSearchGrabSelector(app.encryptor, target.data) }
							: result;
					}),
				};
			},
		);

		// Transform results to match expected format
		const results = response.instances.map((result) => ({
			instanceId: result.instanceId,
			instanceName: result.instanceName,
			success: result.success,
			data: result.success ? result.data.results : [],
			...(result.success ? { coverage: result.data.coverage } : {}),
		}));
		const aggregated = results.flatMap((result) => result.data);
		const successfulBatches = response.instances.filter((result) => result.success);
		const coverage =
			successfulBatches.length > 0
				? successfulBatches.reduce(
						(total, result) => ({
							receivedCount: total.receivedCount + result.data.coverage.receivedCount,
							acceptedCount: total.acceptedCount + result.data.coverage.acceptedCount,
							rejectedCount: total.rejectedCount + result.data.coverage.rejectedCount,
							metadataIncompleteCount:
								total.metadataIncompleteCount + result.data.coverage.metadataIncompleteCount,
						}),
						{ receivedCount: 0, acceptedCount: 0, rejectedCount: 0, metadataIncompleteCount: 0 },
					)
				: undefined;
		const returnedInstanceIds = new Set(response.instances.map((result) => result.instanceId));
		const omittedSelectedCount =
			instanceIds?.filter((id) => !returnedInstanceIds.has(id)).length ?? 0;

		return multiInstanceSearchResponseSchema.parse({
			instances: results,
			aggregated,
			totalCount: aggregated.length,
			failedInstanceCount: response.errorCount + omittedSelectedCount,
			coverage,
		});
	});

	done();
};
