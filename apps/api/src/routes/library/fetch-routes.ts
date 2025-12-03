import {
	type LibraryEpisode,
	type LibraryItem,
	type LibraryService,
	libraryEpisodesRequestSchema,
	libraryEpisodesResponseSchema,
	multiInstanceLibraryResponseSchema,
} from "@arr/shared";
import type { ServiceInstance, ServiceType } from "@prisma/client";
import type { FastifyPluginCallback } from "fastify";
import { createInstanceFetcher } from "../../lib/arr/arr-fetcher.js";
import { normalizeEpisode } from "../../lib/library/episode-normalizer.js";
import { buildLibraryItem } from "../../lib/library/library-item-builder.js";
import { toNumber } from "../../lib/library/type-converters.js";
import { libraryQuerySchema } from "../../lib/library/validation-schemas.js";

/**
 * Register data fetching routes for library
 * - GET /library - Fetch library items from all instances
 * - GET /library/episodes - Fetch episodes for a series
 */
export const registerFetchRoutes: FastifyPluginCallback = (app, _opts, done) => {
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
	 * GET /library
	 * Fetches library items (movies/series) from enabled instances
	 */
	app.get("/library", async (request, reply) => {
		const parsed = libraryQuerySchema.parse(request.query ?? {});

		const where: {
			enabled: boolean;
			service?: ServiceType | { in: ServiceType[] };
			id?: string;
		} = {
			enabled: true,
		};

		if (parsed.instanceId) {
			where.id = parsed.instanceId;
		}

		if (parsed.service) {
			where.service = parsed.service.toUpperCase() as ServiceType;
		} else {
			where.service = { in: ["SONARR", "RADARR"] } as { in: ServiceType[] };
		}

		const instances = await app.prisma.serviceInstance.findMany({
			where,
			orderBy: { label: "asc" },
		});

		const instanceResults: Array<{
			instanceId: string;
			instanceName: string;
			service: LibraryService;
			data: LibraryItem[];
		}> = [];
		const aggregated: LibraryItem[] = [];

		for (const instance of instances) {
			const service = instance.service.toLowerCase() as LibraryService;
			try {
				const fetcher = createInstanceFetcher(app, instance as ServiceInstance);
				const path = service === "radarr" ? "/api/v3/movie" : "/api/v3/series";
				const response = await fetcher(path);
				const payload = await response.json();
				const items = Array.isArray(payload)
					? payload.map((rawItem: Record<string, unknown>) =>
							buildLibraryItem(instance as ServiceInstance, service, rawItem),
						)
					: [];
				instanceResults.push({
					instanceId: instance.id,
					instanceName: instance.label,
					service,
					data: items,
				});
				aggregated.push(...items);
			} catch (error) {
				request.log.error({ err: error, instance: instance.id }, "library fetch failed");
				instanceResults.push({
					instanceId: instance.id,
					instanceName: instance.label,
					service,
					data: [],
				});
			}
		}

		return multiInstanceLibraryResponseSchema.parse({
			instances: instanceResults,
			aggregated,
			totalCount: aggregated.length,
		});
	});

	/**
	 * GET /library/episodes
	 * Fetches episodes for a specific series from a Sonarr instance
	 */
	app.get("/library/episodes", async (request, reply) => {
		const parsed = libraryEpisodesRequestSchema.parse(request.query ?? {});

		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				id: parsed.instanceId,
				enabled: true,
			},
		});

		if (!instance) {
			reply.status(404);
			return reply.send({ message: "Instance not found" });
		}

		const service = instance.service.toLowerCase() as LibraryService;
		if (service !== "sonarr") {
			reply.status(400);
			return reply.send({
				message: "Episodes are only available for Sonarr instances",
			});
		}

		const seriesId = Number(parsed.seriesId);
		if (!Number.isFinite(seriesId)) {
			reply.status(400);
			return reply.send({ message: "Invalid series identifier" });
		}

		const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

		try {
			const params = new URLSearchParams({ seriesId: seriesId.toString() });
			if (parsed.seasonNumber !== undefined) {
				params.append("seasonNumber", parsed.seasonNumber.toString());
			}

			const response = await fetcher(`/api/v3/episode?${params.toString()}`);
			const payload = await response.json();

			const episodes: LibraryEpisode[] = Array.isArray(payload)
				? payload.map((raw: Record<string, unknown>) => normalizeEpisode(raw, seriesId))
				: [];

			return libraryEpisodesResponseSchema.parse({ episodes });
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, seriesId },
				"failed to fetch episodes",
			);
			reply.status(502);
			return reply.send({ message: "Failed to fetch episodes" });
		}
	});

	done();
};
