import type { ProwlarrIndexerHealth } from "@arr/shared";
import {
	prowlarrIndexerHealthSchema,
	searchIndexerDetailsResponseSchema,
	searchIndexersResponseSchema,
	searchIndexerTestRequestSchema,
	searchIndexerTestResponseSchema,
	searchIndexerUpdateOutcomeSchema,
	searchIndexerUpdateRequestSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import {
	executeOnInstances,
	getClientForInstance,
	isProwlarrClient,
} from "../../lib/arr/client-helpers.js";
import {
	buildIndexerDetailsFallback,
	fetchProwlarrIndexerDetailsWithSdk,
	fetchProwlarrIndexersWithSdk,
	IndexerUpdateDispatchError,
	indexerUpdateReadbackMatchesChanges,
	testProwlarrIndexerWithSdk,
	updateProwlarrIndexerWithSdk,
} from "../../lib/search/prowlarr-api.js";
import { withProwlarrIndexerUpdateGuard } from "../../lib/search/prowlarr-indexer-update-guard.js";
import { validateRequest } from "../../lib/utils/validate.js";

const instanceIndexerParams = z.object({
	instanceId: z.string().min(1),
	indexerId: z.coerce.number().int().positive(),
});

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
	/**
	 * GET /search/indexers
	 * Retrieves all indexers from all enabled Prowlarr instances for the current user.
	 */
	app.get("/search/indexers", async (request, _reply) => {
		const response = await executeOnInstances(
			app,
			request.currentUser!.id,
			{ serviceTypes: ["PROWLARR"] },
			async (client, instance) => {
				if (!isProwlarrClient(client)) {
					throw new Error("Configured Prowlarr instance has an incompatible client");
				}

				return fetchProwlarrIndexersWithSdk(client, instance);
			},
		);

		// Transform results to match expected format
		const results = response.instances.map((result) => ({
			instanceId: result.instanceId,
			instanceName: result.instanceName,
			success: result.success,
			data: result.success ? result.data : [],
		}));

		return searchIndexersResponseSchema.parse({
			instances: results,
			aggregated: response.aggregated,
			totalCount: response.totalCount,
			failedInstanceCount: response.errorCount,
		});
	});

	/**
	 * GET /search/indexers/:instanceId/:indexerId
	 * Retrieves detailed information about a specific indexer.
	 */
	app.get("/search/indexers/:instanceId/:indexerId", async (request, reply) => {
		const { instanceId, indexerId } = validateRequest(instanceIndexerParams, request.params);

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

		// Parse pre-fetched health data from query params to skip redundant stats API call
		let prefetchedHealth: ProwlarrIndexerHealth | null = null;
		const query = request.query as Record<string, unknown>;
		if (typeof query.health === "string") {
			try {
				const parsed = prowlarrIndexerHealthSchema.safeParse(JSON.parse(query.health));
				if (parsed.success) {
					prefetchedHealth = parsed.data;
				}
			} catch {
				// Invalid JSON — fall through to full fetch
			}
		}

		const details = await fetchProwlarrIndexerDetailsWithSdk(
			client,
			instance,
			indexerId,
			prefetchedHealth,
		);
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
	});

	/**
	 * PUT /search/indexers/:instanceId/:indexerId
	 * Updates an indexer's configuration in Prowlarr.
	 */
	app.put("/search/indexers/:instanceId/:indexerId", async (request, reply) => {
		const { instanceId, indexerId: indexerIdValue } = validateRequest(
			instanceIndexerParams,
			request.params,
		);

		const payload = validateRequest(searchIndexerUpdateRequestSchema, request.body ?? {});

		return withProwlarrIndexerUpdateGuard(async () => {
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

			try {
				await updateProwlarrIndexerWithSdk(client, indexerIdValue, payload.changes);
			} catch (error) {
				if (!(error instanceof IndexerUpdateDispatchError)) throw error;
				request.log.warn(
					{ category: "indexer-update-outcome-unknown" },
					"Prowlarr indexer update outcome requires provider verification",
				);
				reply.status(202);
				return searchIndexerUpdateOutcomeSchema.parse({ status: "outcome-unknown" });
			}

			const updated = await fetchProwlarrIndexerDetailsWithSdk(client, instance, indexerIdValue);
			if (
				updated &&
				updated.id === indexerIdValue &&
				updated.instanceId === instance.id &&
				indexerUpdateReadbackMatchesChanges(updated, payload.changes)
			) {
				return searchIndexerUpdateOutcomeSchema.parse({ status: "verified", indexer: updated });
			}

			reply.status(202);
			return searchIndexerUpdateOutcomeSchema.parse({ status: "applied-unverified" });
		});
	});

	/**
	 * POST /search/indexers/test
	 * Tests an indexer connection to verify it's working correctly.
	 */
	app.post("/search/indexers/test", async (request, reply) => {
		const payload = validateRequest(searchIndexerTestRequestSchema, request.body ?? {});

		const clientResult = await getClientForInstance(app, request, payload.instanceId);
		if (!clientResult.success) {
			reply.status(clientResult.statusCode);
			return searchIndexerTestResponseSchema.parse({
				success: false,
				message: clientResult.error,
			});
		}

		const { client } = clientResult;

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
		} catch {
			request.log.error({ category: "indexer-test-failed" }, "Prowlarr indexer test failed");
			return searchIndexerTestResponseSchema.parse({
				success: false,
				message: "Indexer test failed. Check Prowlarr before retrying.",
			});
		}
	});

	done();
};
