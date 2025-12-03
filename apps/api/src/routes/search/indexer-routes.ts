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
import { createInstanceFetcher } from "../../lib/arr/arr-fetcher.js";
import {
	buildIndexerDetailsFallback,
	fetchProwlarrIndexerDetails,
	fetchProwlarrIndexers,
	testProwlarrIndexer,
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

		const instances = await app.prisma.serviceInstance.findMany({
			where: { enabled: true, service: "PROWLARR" },
		});

		if (instances.length === 0) {
			return searchIndexersResponseSchema.parse({
				instances: [],

				aggregated: [],

				totalCount: 0,
			});
		}

		const results: Array<{
			instanceId: string;
			instanceName: string;
			data: ProwlarrIndexer[];
		}> = [];

		const aggregated: ProwlarrIndexer[] = [];

		for (const instance of instances) {
			const fetcherInstance = createInstanceFetcher(app, instance);

			try {
				const indexers = await fetchProwlarrIndexers(fetcherInstance, instance);

				results.push({
					instanceId: instance.id,

					instanceName: instance.label,

					data: indexers,
				});

				aggregated.push(...indexers);
			} catch (error) {
				request.log.error({ err: error, instance: instance.id }, "prowlarr indexers fetch failed");

				results.push({
					instanceId: instance.id,

					instanceName: instance.label,

					data: [],
				});
			}
		}

		return searchIndexersResponseSchema.parse({
			instances: results,

			aggregated,

			totalCount: aggregated.length,
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

		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				enabled: true,
				service: "PROWLARR",
				id: instanceId,
			},
		});

		if (!instance) {
			reply.status(404);
			return searchIndexerDetailsResponseSchema.parse({
				indexer: buildIndexerDetailsFallback(instanceId, "", undefined, indexerId),
			});
		}

		const fetcherInstance = createInstanceFetcher(app, instance);

		try {
			const details = await fetchProwlarrIndexerDetails(fetcherInstance, instance, indexerId);
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

		const instance = await app.prisma.serviceInstance.findFirst({
			where: { enabled: true, service: "PROWLARR", id: instanceId },
		});

		if (!instance) {
			reply.status(404);
			return searchIndexerDetailsResponseSchema.parse({
				indexer: buildIndexerDetailsFallback(instanceId, "", undefined, indexerIdValue),
			});
		}

		const fetcherInstance = createInstanceFetcher(app, instance);
		const originalIndexer = payload.indexer ?? { id: indexerIdValue };
		const bodyIndexer = {
			...originalIndexer,
			id: typeof originalIndexer.id === "number" ? originalIndexer.id : indexerIdValue,
			instanceId: originalIndexer.instanceId ?? instance.id,
			instanceName: originalIndexer.instanceName ?? instance.label,
			instanceUrl: originalIndexer.instanceUrl ?? instance.baseUrl,
		};

		try {
			await fetcherInstance(`/api/v1/indexer/${indexerIdValue}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(bodyIndexer),
			});
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, indexerId: indexerIdValue },
				"prowlarr indexer update failed",
			);
			reply.status(502);
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
			const updated = await fetchProwlarrIndexerDetails(fetcherInstance, instance, indexerIdValue);
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

		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				enabled: true,
				service: "PROWLARR",
				id: payload.instanceId,
			},
		});

		if (!instance) {
			reply.status(404);

			return searchIndexerTestResponseSchema.parse({
				success: false,
				message: "Indexer instance not found",
			});
		}

		const fetcherInstance = createInstanceFetcher(app, instance);

		try {
			await testProwlarrIndexer(fetcherInstance, payload.indexerId);

			return searchIndexerTestResponseSchema.parse({ success: true });
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, indexerId: payload.indexerId },
				"prowlarr indexer test failed",
			);

			reply.status(502);

			return searchIndexerTestResponseSchema.parse({
				success: false,

				message: error instanceof Error ? error.message : "Failed to test indexer",
			});
		}
	});

	done();
};
