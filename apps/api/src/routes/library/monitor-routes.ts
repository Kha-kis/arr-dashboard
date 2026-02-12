import {
	type LibraryService,
	libraryAlbumMonitorRequestSchema,
	libraryBookMonitorRequestSchema,
	libraryEpisodeMonitorRequestSchema,
	libraryToggleMonitorRequestSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import {
	getClientForInstance,
	isLidarrClient,
	isRadarrClient,
	isReadarrClient,
	isSonarrClient,
} from "../../lib/arr/client-helpers.js";
import { toNumber } from "../../lib/library/type-converters.js";

/**
 * Optimistically update the library cache after a monitoring change
 * Updates both the indexed `monitored` field and the JSON `data` blob
 */
async function updateCacheMonitoredStatus(
	prisma: import("../../lib/prisma.js").PrismaClientInstance,
	instanceId: string,
	arrItemId: number,
	itemType: "movie" | "series" | "artist" | "author",
	monitored: boolean,
): Promise<void> {
	try {
		const cached = await prisma.libraryCache.findUnique({
			where: {
				instanceId_arrItemId_itemType: {
					instanceId,
					arrItemId,
					itemType,
				},
			},
		});

		if (cached) {
			// Parse existing data, update monitored, re-serialize
			const data = JSON.parse(cached.data);
			data.monitored = monitored;

			await prisma.libraryCache.update({
				where: { id: cached.id },
				data: {
					monitored,
					data: JSON.stringify(data),
					updatedAt: new Date(),
				},
			});
		}
	} catch {
		// Cache update is best-effort - don't fail the request if it fails
		// The next sync will correct any inconsistencies
	}
}

/**
 * Register monitoring control routes for library
 * - POST /library/monitor - Toggle monitoring for movies/series/seasons/artists/authors
 * - POST /library/episode/monitor - Toggle monitoring for episodes (Sonarr)
 * - POST /library/album/monitor - Toggle monitoring for albums (Lidarr)
 * - POST /library/book/monitor - Toggle monitoring for books (Readarr)
 */
export const registerMonitorRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * POST /library/monitor
	 * Toggles monitoring status for movies, series, or specific seasons
	 */
	app.post("/library/monitor", async (request, reply) => {
		const payload = libraryToggleMonitorRequestSchema.parse(request.body ?? {});

		const clientResult = await getClientForInstance(app, request, payload.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				error: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as LibraryService;

		if (service !== payload.service) {
			return reply.status(400).send({
				error: "Instance service mismatch",
			});
		}

		const itemId = Number(payload.itemId);
		if (!Number.isFinite(itemId)) {
			return reply.status(400).send({
				error: "Invalid item identifier",
			});
		}

		if (service === "radarr" && isRadarrClient(client)) {
			// Fetch current movie, update monitored, then save
			const movie = await client.movie.getById(itemId);
			const updatedMovie = {
				...movie,
				id: itemId,
				monitored: payload.monitored,
			};
			await client.movie.update(itemId, updatedMovie);

			// Optimistically update cache
			await updateCacheMonitoredStatus(
				app.prisma,
				payload.instanceId,
				itemId,
				"movie",
				payload.monitored,
			);

			return reply.status(204).send();
		}

		if (service === "sonarr" && isSonarrClient(client)) {
			// Fetch current series
			const series = await client.series.getById(itemId);

			// Update series monitored status
			const updatedSeries = {
				...series,
				id: itemId,
				monitored: payload.monitored,
			};

			// Update season monitoring if seasons exist
			if (Array.isArray(series.seasons)) {
				const seasonNumbers = payload.seasonNumbers
					?.map((number) => Number(number))
					.filter((value) => Number.isFinite(value));

				updatedSeries.seasons = series.seasons.map((season: Record<string, unknown>) => {
					const seasonObj = season;
					const seasonNumber = toNumber(seasonObj?.seasonNumber) ?? 0;
					const hasSelections = Array.isArray(seasonNumbers) && seasonNumbers.length > 0;

					let nextMonitored = !!seasonObj?.monitored;

					if (hasSelections) {
						if (seasonNumbers?.includes(seasonNumber)) {
							nextMonitored = payload.monitored;
						}
					} else {
						// Don't monitor specials (season 0) by default
						nextMonitored = seasonNumber === 0 ? false : payload.monitored;
					}

					return {
						...seasonObj,
						monitored: nextMonitored,
					};
				});
			}

			await client.series.update(
				itemId,
				updatedSeries as Parameters<typeof client.series.update>[1],
			);

			// Optimistically update cache
			await updateCacheMonitoredStatus(
				app.prisma,
				payload.instanceId,
				itemId,
				"series",
				payload.monitored,
			);

			return reply.status(204).send();
		}

		if (service === "lidarr" && isLidarrClient(client)) {
			// Fetch current artist, update monitored, then save
			const artist = await client.artist.getById(itemId);
			const updatedArtist = {
				...artist,
				id: itemId,
				monitored: payload.monitored,
			};
			await client.artist.update(itemId, updatedArtist);

			// Optimistically update cache
			await updateCacheMonitoredStatus(
				app.prisma,
				payload.instanceId,
				itemId,
				"artist",
				payload.monitored,
			);

			return reply.status(204).send();
		}

		if (service === "readarr" && isReadarrClient(client)) {
			// Fetch current author, update monitored, then save
			const author = await client.author.getById(itemId);
			const updatedAuthor = {
				...author,
				id: itemId,
				monitored: payload.monitored,
			};
			await client.author.update(itemId, updatedAuthor);

			// Optimistically update cache
			await updateCacheMonitoredStatus(
				app.prisma,
				payload.instanceId,
				itemId,
				"author",
				payload.monitored,
			);

			return reply.status(204).send();
		}

		return reply.status(400).send({
			error: "Unsupported service type",
		});
	});

	/**
	 * POST /library/episode/monitor
	 * Toggles monitoring status for specific episodes
	 */
	app.post("/library/episode/monitor", async (request, reply) => {
		const payload = libraryEpisodeMonitorRequestSchema.parse(request.body ?? {});

		const clientResult = await getClientForInstance(app, request, payload.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				error: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as LibraryService;

		if (service !== "sonarr" || !isSonarrClient(client)) {
			return reply.status(400).send({
				error: "Episode monitoring is only supported for Sonarr instances",
			});
		}

		const seriesId = Number(payload.seriesId);
		if (!Number.isFinite(seriesId)) {
			return reply.status(400).send({
				error: "Invalid series identifier",
			});
		}

		if (!payload.episodeIds || payload.episodeIds.length === 0) {
			return reply.status(400).send({
				error: "No episode IDs provided",
			});
		}

		// Use SDK's episode.setMonitored method for bulk monitoring updates
		await client.episode.setMonitored(payload.episodeIds, payload.monitored);

		return reply.status(204).send();
	});

	/**
	 * POST /library/album/monitor
	 * Toggles monitoring status for specific albums in Lidarr
	 */
	app.post("/library/album/monitor", async (request, reply) => {
		const payload = libraryAlbumMonitorRequestSchema.parse(request.body ?? {});

		const clientResult = await getClientForInstance(app, request, payload.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				error: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as LibraryService;

		if (service !== "lidarr" || !isLidarrClient(client)) {
			return reply.status(400).send({
				error: "Album monitoring is only supported for Lidarr instances",
			});
		}

		const artistId = Number(payload.artistId);
		if (!Number.isFinite(artistId)) {
			return reply.status(400).send({
				error: "Invalid artist identifier",
			});
		}

		if (!payload.albumIds || payload.albumIds.length === 0) {
			return reply.status(400).send({
				error: "No album IDs provided",
			});
		}

		// Lidarr uses PUT /api/v1/album/monitor for bulk monitoring updates
		await client.album.monitor({
			albumIds: payload.albumIds,
			monitored: payload.monitored,
		});

		return reply.status(204).send();
	});

	/**
	 * POST /library/book/monitor
	 * Toggles monitoring status for specific books in Readarr
	 */
	app.post("/library/book/monitor", async (request, reply) => {
		const payload = libraryBookMonitorRequestSchema.parse(request.body ?? {});

		const clientResult = await getClientForInstance(app, request, payload.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				error: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as LibraryService;

		if (service !== "readarr" || !isReadarrClient(client)) {
			return reply.status(400).send({
				error: "Book monitoring is only supported for Readarr instances",
			});
		}

		const authorId = Number(payload.authorId);
		if (!Number.isFinite(authorId)) {
			return reply.status(400).send({
				error: "Invalid author identifier",
			});
		}

		if (!payload.bookIds || payload.bookIds.length === 0) {
			return reply.status(400).send({
				error: "No book IDs provided",
			});
		}

		// Readarr uses PUT /api/v1/book/monitor for bulk monitoring updates
		await client.book.monitor({
			bookIds: payload.bookIds,
			monitored: payload.monitored,
		});

		return reply.status(204).send();
	});

	done();
};
