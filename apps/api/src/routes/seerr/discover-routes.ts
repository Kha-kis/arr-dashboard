/**
 * Seerr Discovery Routes
 *
 * Endpoints for browsing, searching, and requesting media via Seerr's TMDB-enriched API.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireSeerrClient } from "../../lib/seerr/seerr-client.js";
import { validateRequest } from "../../lib/utils/validate.js";

const instanceIdParams = z.object({ instanceId: z.string().min(1) });

const genreParams = z.object({
	instanceId: z.string().min(1),
	genreId: z.coerce.number().int().positive(),
});

const tmdbIdParams = z.object({
	instanceId: z.string().min(1),
	tmdbId: z.coerce.number().int().positive(),
});

const languageSchema = z.string().regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/).optional();

const paginationQuery = z.object({
	page: z.coerce.number().int().min(1).default(1),
	language: languageSchema,
});

const searchQuery = z.object({
	query: z.string().trim().min(1).max(200),
	page: z.coerce.number().int().min(1).default(1),
	language: languageSchema,
});

const createRequestBody = z.object({
	mediaId: z.number().int().positive(),
	mediaType: z.enum(["movie", "tv"]),
	seasons: z.array(z.number().int().min(0)).optional(),
	is4k: z.boolean().optional(),
	serverId: z.number().int().positive().optional(),
	profileId: z.number().int().positive().optional(),
	rootFolder: z.string().optional(),
	languageProfileId: z.number().int().positive().optional(),
	tags: z.array(z.number().int()).optional(),
});

export async function registerDiscoverRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	// --- Browse endpoints ---

	app.get("/:instanceId/movies", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const query = validateRequest(paginationQuery, request.query);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.discoverMovies(query);
	});

	app.get("/:instanceId/tv", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const query = validateRequest(paginationQuery, request.query);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.discoverTv(query);
	});

	app.get("/:instanceId/trending", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const query = validateRequest(paginationQuery, request.query);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.discoverTrending(query);
	});

	app.get("/:instanceId/movies/upcoming", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const query = validateRequest(paginationQuery, request.query);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.discoverMoviesUpcoming(query);
	});

	app.get("/:instanceId/tv/upcoming", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const query = validateRequest(paginationQuery, request.query);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.discoverTvUpcoming(query);
	});

	app.get("/:instanceId/movies/genre/:genreId", async (request) => {
		const { instanceId, genreId } = validateRequest(genreParams, request.params);
		const query = validateRequest(paginationQuery, request.query);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.discoverMoviesByGenre(genreId, query);
	});

	app.get("/:instanceId/tv/genre/:genreId", async (request) => {
		const { instanceId, genreId } = validateRequest(genreParams, request.params);
		const query = validateRequest(paginationQuery, request.query);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.discoverTvByGenre(genreId, query);
	});

	// --- Search ---

	app.get("/:instanceId/search", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const query = validateRequest(searchQuery, request.query);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.search(query);
	});

	// --- Details ---

	app.get("/:instanceId/movie/:tmdbId", async (request) => {
		const { instanceId, tmdbId } = validateRequest(tmdbIdParams, request.params);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.getMovieDetailsFull(tmdbId);
	});

	app.get("/:instanceId/tv/:tmdbId", async (request) => {
		const { instanceId, tmdbId } = validateRequest(tmdbIdParams, request.params);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.getTvDetailsFull(tmdbId);
	});

	// --- Genres ---

	app.get("/:instanceId/genres/movie", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.getMovieGenres();
	});

	app.get("/:instanceId/genres/tv", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.getTvGenres();
	});

	// --- Request Options ---

	app.get("/:instanceId/request-options", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const { mediaType } = validateRequest(
			z.object({ mediaType: z.enum(["movie", "tv"]) }),
			request.query,
		);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.getRequestOptions(mediaType);
	});

	// --- Request ---

	app.post("/:instanceId/request", async (request) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const body = validateRequest(createRequestBody, request.body);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		return client.createRequest(body);
	});
}
