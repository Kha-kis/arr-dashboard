import { discoverAddRequestSchema, discoverAddResponseSchema } from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import type { FastifyPluginCallback } from "fastify";
import { createInstanceFetcher } from "../../lib/arr/arr-fetcher.js";
import { toNumber, toStringValue } from "../../lib/data/values.js";
import {
	loadRadarrRemote,
	loadSonarrRemote,
	slugify,
} from "../../lib/discover/discover-normalizer.js";

/**
 * Register discover add routes
 * - POST /discover/add - Add a movie or series to an instance
 */
export const registerAddRoutes: FastifyPluginCallback = (app, _opts, done) => {
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
	 * POST /discover/add
	 * Adds a movie or series to the specified Sonarr/Radarr instance
	 */
	app.post("/discover/add", async (request, reply) => {
		const payload = discoverAddRequestSchema.parse(request.body ?? {});
		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				id: payload.instanceId,
				enabled: true,
				userId: request.currentUser?.id,
			},
		});

		if (!instance) {
			reply.status(404);
			return reply.send({ message: "Instance not found" });
		}

		const service = instance.service.toLowerCase() as "sonarr" | "radarr";
		const expected = payload.payload.type === "movie" ? "radarr" : "sonarr";
		if (service !== expected) {
			reply.status(400);
			return reply.send({ message: "Instance service does not match payload" });
		}

		const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

		try {
			if (service === "radarr") {
				if (payload.payload.type !== "movie") {
					reply.status(400);
					return reply.send({
						message: "Instance service does not match payload",
					});
				}

				const moviePayload = payload.payload;
				const remote = await loadRadarrRemote(fetcher, {
					tmdbId: moviePayload.tmdbId,
					imdbId: moviePayload.imdbId,
					queryFallback: moviePayload.title,
				});

				if (!remote) {
					reply.status(404);
					return reply.send({ message: "Unable to locate movie details" });
				}

				const body = {
					...remote,
					id: 0,
					tmdbId: moviePayload.tmdbId ?? remote.tmdbId,
					imdbId: moviePayload.imdbId ?? remote.imdbId,
					title: moviePayload.title ?? remote.title,
					year: moviePayload.year ?? remote.year,
					qualityProfileId: moviePayload.qualityProfileId,
					rootFolderPath: moviePayload.rootFolderPath,
					monitored: moviePayload.monitored ?? true,
					minimumAvailability:
						moviePayload.minimumAvailability ??
						toStringValue(remote?.minimumAvailability) ??
						"announced",
					addOptions: {
						searchForMovie: moviePayload.searchOnAdd ?? true,
					},
					tags: moviePayload.tags ?? [],
				};

				const response = await fetcher("/api/v3/movie", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				const created = await response.json();
				return discoverAddResponseSchema.parse({
					success: true,
					instanceId: instance.id,
					itemId: created?.id ?? created?.movieId,
				});
			}

			if (payload.payload.type !== "series") {
				reply.status(400);
				return reply.send({
					message: "Instance service does not match payload",
				});
			}

			const seriesPayload = payload.payload;
			const remote = await loadSonarrRemote(fetcher, {
				tvdbId: seriesPayload.tvdbId,
				tmdbId: seriesPayload.tmdbId,
				queryFallback: seriesPayload.title,
			});

			if (!remote) {
				reply.status(404);
				return reply.send({ message: "Unable to locate series details" });
			}

			const seasons = Array.isArray(remote?.seasons)
				? remote.seasons.map((season: unknown) => ({
						seasonNumber: toNumber((season as { seasonNumber?: unknown })?.seasonNumber) ?? 0,
						monitored:
							seriesPayload.seasonFolder === false ? false : (seriesPayload.monitored ?? true),
					}))
				: [];

			const languageProfileId =
				seriesPayload.languageProfileId ?? toNumber(remote?.languageProfileId);
			if (languageProfileId === undefined) {
				reply.status(400);
				return reply.send({ message: "languageProfileId is required" });
			}

			const body = {
				...remote,
				title: seriesPayload.title ?? remote.title,
				titleSlug:
					toStringValue(remote?.titleSlug) ??
					slugify(seriesPayload.title ?? remote.title ?? "series"),
				qualityProfileId: seriesPayload.qualityProfileId,
				languageProfileId,
				rootFolderPath: seriesPayload.rootFolderPath,
				seasonFolder: seriesPayload.seasonFolder ?? true,
				monitored: seriesPayload.monitored ?? true,
				seasons,
				addOptions: {
					searchForMissingEpisodes: seriesPayload.searchOnAdd ?? true,
					searchForCutoffUnmetEpisodes: seriesPayload.searchOnAdd ?? true,
				},
				tags: seriesPayload.tags ?? [],
			};

			const response = await fetcher("/api/v3/series", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const created = await response.json();
			return discoverAddResponseSchema.parse({
				success: true,
				instanceId: instance.id,
				itemId: created?.id,
			});
		} catch (error) {
			request.log.error({ err: error, instance: instance.id }, "discover add failed");
			reply.status(502);
			return reply.send({ message: "Failed to add title" });
		}
	});

	done();
};
