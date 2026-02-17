import {
	type LibraryService,
	libraryAlbumSearchRequestSchema,
	libraryArtistSearchRequestSchema,
	libraryAuthorSearchRequestSchema,
	libraryBookSearchRequestSchema,
	libraryEpisodeSearchRequestSchema,
	libraryMovieSearchRequestSchema,
	librarySeasonSearchRequestSchema,
	librarySeriesSearchRequestSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import {
	getClientForInstance,
	isLidarrClient,
	isRadarrClient,
	isReadarrClient,
	isSonarrClient,
} from "../../lib/arr/client-helpers.js";

/**
 * Register search operation routes for library
 * - POST /library/season/search - Search for season (Sonarr)
 * - POST /library/series/search - Search for series (Sonarr)
 * - POST /library/movie/search - Search for movie (Radarr)
 * - POST /library/episode/search - Search for episodes (Sonarr)
 * - POST /library/artist/search - Search for artist (Lidarr)
 * - POST /library/album/search - Search for albums (Lidarr)
 * - POST /library/author/search - Search for author (Readarr)
 * - POST /library/book/search - Search for books (Readarr)
 */
export const registerSearchRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * POST /library/season/search
	 * Queues a season search in Sonarr
	 */
	app.post("/library/season/search", async (request, reply) => {
		const payload = librarySeasonSearchRequestSchema.parse(request.body ?? {});

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
				error: "Season search is only supported for Sonarr instances",
			});
		}

		const seriesId = Number(payload.seriesId);
		if (!Number.isFinite(seriesId)) {
			return reply.status(400).send({
				error: "Invalid series identifier",
			});
		}

		const seasonNumber = Number(payload.seasonNumber);
		if (!Number.isFinite(seasonNumber)) {
			return reply.status(400).send({
				error: "Invalid season number",
			});
		}

		await client.command.execute({
			name: "SeasonSearch",
			seriesId,
			seasonNumber,
		});

		return reply.status(202).send({
			message: "Season search queued",
		});
	});

	/**
	 * POST /library/series/search
	 * Queues a series search in Sonarr
	 */
	app.post("/library/series/search", async (request, reply) => {
		const payload = librarySeriesSearchRequestSchema.parse(request.body ?? {});

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
				error: "Series search is only supported for Sonarr instances",
			});
		}

		const seriesId = Number(payload.seriesId);
		if (!Number.isFinite(seriesId)) {
			return reply.status(400).send({
				error: "Invalid series identifier",
			});
		}

		await client.command.execute({
			name: "SeriesSearch",
			seriesId,
		});

		return reply.status(202).send({
			message: "Series search queued",
		});
	});

	/**
	 * POST /library/movie/search
	 * Queues a movie search in Radarr
	 */
	app.post("/library/movie/search", async (request, reply) => {
		const payload = libraryMovieSearchRequestSchema.parse(request.body ?? {});

		const clientResult = await getClientForInstance(app, request, payload.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				error: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as LibraryService;

		if (service !== "radarr" || !isRadarrClient(client)) {
			return reply.status(400).send({
				error: "Movie search is only supported for Radarr instances",
			});
		}

		const movieId = Number(payload.movieId);
		if (!Number.isFinite(movieId)) {
			return reply.status(400).send({
				error: "Invalid movie identifier",
			});
		}

		await client.command.execute({
			name: "MoviesSearch",
			movieIds: [movieId],
		});

		return reply.status(202).send({
			message: "Movie search queued",
		});
	});

	/**
	 * POST /library/episode/search
	 * Queues an episode search in Sonarr
	 */
	app.post("/library/episode/search", async (request, reply) => {
		const payload = libraryEpisodeSearchRequestSchema.parse(request.body ?? {});

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
				error: "Episode search is only supported for Sonarr instances",
			});
		}

		if (!payload.episodeIds || payload.episodeIds.length === 0) {
			return reply.status(400).send({
				error: "No episode IDs provided",
			});
		}

		await client.command.execute({
			name: "EpisodeSearch",
			episodeIds: payload.episodeIds,
		});

		return reply.status(202).send({
			message: "Episode search queued",
		});
	});

	/**
	 * POST /library/artist/search
	 * Queues an artist search in Lidarr
	 */
	app.post("/library/artist/search", async (request, reply) => {
		const payload = libraryArtistSearchRequestSchema.parse(request.body ?? {});

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
				error: "Artist search is only supported for Lidarr instances",
			});
		}

		const artistId = Number(payload.artistId);
		if (!Number.isFinite(artistId)) {
			return reply.status(400).send({
				error: "Invalid artist identifier",
			});
		}

		await client.command.execute({
			name: "ArtistSearch",
			artistId,
		});

		return reply.status(202).send({
			message: "Artist search queued",
		});
	});

	/**
	 * POST /library/album/search
	 * Queues an album search in Lidarr
	 */
	app.post("/library/album/search", async (request, reply) => {
		const payload = libraryAlbumSearchRequestSchema.parse(request.body ?? {});

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
				error: "Album search is only supported for Lidarr instances",
			});
		}

		if (!payload.albumIds || payload.albumIds.length === 0) {
			return reply.status(400).send({
				error: "No album IDs provided",
			});
		}

		await client.command.execute({
			name: "AlbumSearch",
			albumIds: payload.albumIds,
		});

		return reply.status(202).send({
			message: "Album search queued",
		});
	});

	/**
	 * POST /library/author/search
	 * Queues an author search in Readarr
	 */
	app.post("/library/author/search", async (request, reply) => {
		const payload = libraryAuthorSearchRequestSchema.parse(request.body ?? {});

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
				error: "Author search is only supported for Readarr instances",
			});
		}

		const authorId = Number(payload.authorId);
		if (!Number.isFinite(authorId)) {
			return reply.status(400).send({
				error: "Invalid author identifier",
			});
		}

		await client.command.execute({
			name: "AuthorSearch",
			authorId,
		});

		return reply.status(202).send({
			message: "Author search queued",
		});
	});

	/**
	 * POST /library/book/search
	 * Queues a book search in Readarr
	 */
	app.post("/library/book/search", async (request, reply) => {
		const payload = libraryBookSearchRequestSchema.parse(request.body ?? {});

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
				error: "Book search is only supported for Readarr instances",
			});
		}

		if (!payload.bookIds || payload.bookIds.length === 0) {
			return reply.status(400).send({
				error: "No book IDs provided",
			});
		}

		await client.command.execute({
			name: "BookSearch",
			bookIds: payload.bookIds,
		});

		return reply.status(202).send({
			message: "Book search queued",
		});
	});

	done();
};
