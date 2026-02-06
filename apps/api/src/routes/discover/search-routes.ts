import {
	type DiscoverSearchResult,
	discoverSearchRequestSchema,
	discoverSearchResponseSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import {
	executeOnInstances,
	isSonarrClient,
	isRadarrClient,
} from "../../lib/arr/client-helpers.js";
import {
	ensureResult,
	fetchLookupResultsWithSdk,
	normalizeLookupResult,
	sortSearchResults,
} from "../../lib/discover/discover-normalizer.js";

/**
 * Register discover search routes
 * - GET /discover/search - Search for movies or series across instances
 */
export const registerSearchRoutes: FastifyPluginCallback = (app, _opts, done) => {
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
	 * GET /discover/search
	 * Searches for movies or series across all enabled Sonarr/Radarr instances
	 */
	app.get("/discover/search", async (request, _reply) => {
		const parsed = discoverSearchRequestSchema.parse(request.query ?? {});
		const type = parsed.type;
		const prismaService = type === "movie" ? "RADARR" : "SONARR";

		const resultMap = new Map<string, DiscoverSearchResult>();

		await executeOnInstances(
			app,
			request.currentUser!.id,
			{ serviceTypes: [prismaService] },
			async (client, instance) => {
				const service = instance.service.toLowerCase() as "sonarr" | "radarr";

				// Validate client type matches expected service
				if (service === "radarr" && !isRadarrClient(client)) return [];
				if (service === "sonarr" && !isSonarrClient(client)) return [];

				// biome-ignore lint/suspicious/noExplicitAny: Type already validated by isSonarrClient/isRadarrClient guards above
				const lookupResults = await fetchLookupResultsWithSdk(client as any, service, parsed.query);
				for (const raw of lookupResults) {
					const normalized = normalizeLookupResult(raw, instance, service);
					ensureResult(resultMap, normalized);
				}

				return [];
			},
		);

		const results = sortSearchResults(Array.from(resultMap.values()), parsed.query);

		return discoverSearchResponseSchema.parse({
			results,
			totalCount: results.length,
		});
	});

	done();
};
