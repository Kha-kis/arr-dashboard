import type { FastifyPluginCallback } from "fastify";
import type {
	ProwlarrIndexer,
	SearchIndexerTestRequest,
	SearchIndexerTestResponse,
	SearchIndexerUpdateRequest,
} from "@arr/shared";
import {
	searchIndexerDetailsResponseSchema,
	searchIndexerTestRequestSchema,
	searchIndexerTestResponseSchema,
	searchIndexerUpdateRequestSchema,
	searchIndexersResponseSchema,
} from "@arr/shared";
import {
	executeOnInstances,
	getClientForInstance,
	isProwlarrClient,
} from "../../lib/arr/client-helpers.js";
import { ArrError, arrErrorToHttpStatus } from "../../lib/arr/client-factory.js";
import {
	buildIndexerDetailsFallback,
	fetchProwlarrIndexersWithSdk,
	fetchProwlarrIndexerDetailsWithSdk,
	updateProwlarrIndexerWithSdk,
	testProwlarrIndexerWithSdk,
} from "../../lib/search/prowlarr-api.js";

/**
 * Registers indexer-related routes for Prowlarr.
 *
 * Routes:
 * - GET /search/indexers - List all indexers across all Prowlarr instances
 * - GET /search/indexers/:instanceId/:indexerId - Get details for a specific indexer
 * - PUT /search/indexers/:instanceId/:indexerId - Update an indexer configuration
 * - POST /search/indexers/test - Test an indexer connection
 */
export const registerIndexerRoutes: FastifyPluginCallback = (app, _opts, done) => {
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
	 * GET /search/indexers
	 * Retrieves all indexers from all enabled Prowlarr instances for the current user.
	 */
	app.get("/search/indexers", async (request, reply) => {
		const response = await executeOnInstances(
			app,
			request.currentUser!.id,
			{ serviceTypes: ["PROWLARR"] },
			async (client, instance) => {
				if (!isProwlarrClient(client)) {
					return [];
				}

				return fetchProwlarrIndexersWithSdk(client, instance);
			},
		);

		// Transform results to match expected format
		const results = response.instances.map((result) => ({
			instanceId: result.instanceId,
			instanceName: result.instanceName,
			data: result.success ? result.data : [],
		}));

		return searchIndexersResponseSchema.parse({
			instances: results,
			aggregated: response.aggregated,
			totalCount: response.totalCount,
		});
	});

	/**
	 * GET /search/indexers/:instanceId/:indexerId
	 * Retrieves detailed information about a specific indexer.
	 */
	app.get("/search/indexers/:instanceId/:indexerId", async (request, reply) => {
		const params = request.params as { instanceId: string; indexerId: string };
		const instanceId = params.instanceId;
		const indexerId = Number(params.indexerId);

		const fallback = buildIndexerDetailsFallback(
			instanceId,
			"",
			undefined,
			Number.isFinite(indexerId) ? indexerId : 0,
		);

		if (!Number.isFinite(indexerId)) {
			reply.status(400);
			return searchIndexerDetailsResponseSchema.parse({ indexer: fallback });
		}

		const clientResult = await getClientForInstance(app, request, instanceId);
		if (!clientResult.success) {
			reply.status(clientResult.statusCode);
			return searchIndexerDetailsResponseSchema.parse({
				indexer: buildIndexerDetailsFallback(instanceId, "", undefined, indexerId),
			});
		}

		const { client, instance } = clientResult;

		if (!isProwlarrClient(client)) {
			reply.status(400);
			return searchIndexerDetailsResponseSchema.parse({
				indexer: buildIndexerDetailsFallback(instanceId, "", undefined, indexerId),
			});
		}

		try {
			const details = await fetchProwlarrIndexerDetailsWithSdk(client, instance, indexerId);
			if (!details) {
				reply.status(502);
				return searchIndexerDetailsResponseSchema.parse({
					indexer: buildIndexerDetailsFallback(
						instance.id,
						instance.label,
						instance.baseUrl,
						indexerId,
					),
				});
			}
			return searchIndexerDetailsResponseSchema.parse({ indexer: details });
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, indexerId },
				"prowlarr indexer details failed",
			);

			if (error instanceof ArrError) {
				reply.status(arrErrorToHttpStatus(error));
			} else {
				reply.status(502);
			}
			return searchIndexerDetailsResponseSchema.parse({
				indexer: buildIndexerDetailsFallback(
					instance.id,
					instance.label,
					instance.baseUrl,
					indexerId,
				),
			});
		}
	});

	/**
	 * PUT /search/indexers/:instanceId/:indexerId
	 * Updates an indexer's configuration in Prowlarr.
	 */
	app.put("/search/indexers/:instanceId/:indexerId", async (request, reply) => {
		const params = request.params as {
			instanceId?: string;
			indexerId?: string;
		};
		const paramInstanceId = params.instanceId ?? "";
		const indexerIdValue = Number(params.indexerId);

		if (!Number.isFinite(indexerIdValue)) {
			reply.status(400);
			return searchIndexerDetailsResponseSchema.parse({
				indexer: buildIndexerDetailsFallback(paramInstanceId, "", undefined, 0),
			});
		}

		const payload: SearchIndexerUpdateRequest = searchIndexerUpdateRequestSchema.parse(
			request.body ?? {},
		);
		const instanceId = payload.instanceId ?? paramInstanceId;

		const clientResult = await getClientForInstance(app, request, instanceId);
		if (!clientResult.success) {
			reply.status(clientResult.statusCode);
			return searchIndexerDetailsResponseSchema.parse({
				indexer: buildIndexerDetailsFallback(instanceId, "", undefined, indexerIdValue),
			});
		}

		const { client, instance } = clientResult;

		if (!isProwlarrClient(client)) {
			reply.status(400);
			return searchIndexerDetailsResponseSchema.parse({
				indexer: buildIndexerDetailsFallback(instanceId, "", undefined, indexerIdValue),
			});
		}

		const originalIndexer = payload.indexer ?? { id: indexerIdValue };
		const bodyIndexer = {
			...originalIndexer,
			id: typeof originalIndexer.id === "number" ? originalIndexer.id : indexerIdValue,
			instanceId: originalIndexer.instanceId ?? instance.id,
			instanceName: originalIndexer.instanceName ?? instance.label,
			instanceUrl: originalIndexer.instanceUrl ?? instance.baseUrl,
		};

		try {
			await updateProwlarrIndexerWithSdk(client, indexerIdValue, bodyIndexer);
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, indexerId: indexerIdValue },
				"prowlarr indexer update failed",
			);

			if (error instanceof ArrError) {
				reply.status(arrErrorToHttpStatus(error));
			} else {
				reply.status(502);
			}
			return searchIndexerDetailsResponseSchema.parse({
				indexer: buildIndexerDetailsFallback(
					instance.id,
					instance.label,
					instance.baseUrl,
					indexerIdValue,
				),
			});
		}

		try {
			const updated = await fetchProwlarrIndexerDetailsWithSdk(client, instance, indexerIdValue);
			if (updated) {
				return searchIndexerDetailsResponseSchema.parse({ indexer: updated });
			}
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, indexerId: indexerIdValue },
				"prowlarr indexer fetch after update failed",
			);
		}

		return searchIndexerDetailsResponseSchema.parse({ indexer: bodyIndexer });
	});

	/**
	 * POST /search/indexers/test
	 * Tests an indexer connection to verify it's working correctly.
	 */
	app.post("/search/indexers/test", async (request, reply) => {
		const payload = searchIndexerTestRequestSchema.parse(request.body ?? {});

		const clientResult = await getClientForInstance(app, request, payload.instanceId);
		if (!clientResult.success) {
			reply.status(clientResult.statusCode);
			return searchIndexerTestResponseSchema.parse({
				success: false,
				message: clientResult.error,
			});
		}

		const { client, instance } = clientResult;

		if (!isProwlarrClient(client)) {
			reply.status(400);
			return searchIndexerTestResponseSchema.parse({
				success: false,
				message: "Instance is not a Prowlarr instance",
			});
		}

		try {
			await testProwlarrIndexerWithSdk(client, payload.indexerId);
			return searchIndexerTestResponseSchema.parse({ success: true });
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, indexerId: payload.indexerId },
				"prowlarr indexer test failed",
			);

			if (error instanceof ArrError) {
				reply.status(arrErrorToHttpStatus(error));
			} else {
				reply.status(502);
			}

			return searchIndexerTestResponseSchema.parse({
				success: false,
				message: error instanceof Error ? error.message : "Failed to test indexer",
			});
		}
	});

	done();
};
