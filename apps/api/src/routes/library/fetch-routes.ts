import {
	type LibraryAlbum,
	type LibraryBook,
	type LibraryEpisode,
	type LibraryItem,
	type LibraryService,
	type PaginatedLibraryResponse,
	libraryAlbumsRequestSchema,
	libraryAlbumsResponseSchema,
	libraryBooksRequestSchema,
	libraryBooksResponseSchema,
	libraryEpisodesRequestSchema,
	libraryEpisodesResponseSchema,
	paginatedLibraryResponseSchema,
} from "@arr/shared";
import type { Prisma, LibraryItemType as PrismaLibraryItemType } from "../../lib/prisma.js";
import type { FastifyPluginCallback } from "fastify";
import {
	getClientForInstance,
	isLidarrClient,
	isReadarrClient,
	isSonarrClient,
} from "../../lib/arr/client-helpers.js";
import { ArrError, arrErrorToHttpStatus } from "../../lib/arr/client-factory.js";
import { normalizeAlbum } from "../../lib/library/album-normalizer.js";
import { normalizeBook } from "../../lib/library/book-normalizer.js";
import { normalizeEpisode } from "../../lib/library/episode-normalizer.js";
import { libraryQuerySchema } from "../../lib/library/validation-schemas.js";
import { getLibrarySyncScheduler } from "../../lib/library-sync/index.js";

/**
 * Register data fetching routes for library
 * - GET /library - Fetch library items from cache with pagination
 * - GET /library/episodes - Fetch episodes for a series
 */
export const registerFetchRoutes: FastifyPluginCallback = (app, _opts, done) => {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser!.id) {
			return reply.status(401).send({
				error: "Authentication required",
			});
		}
	});

	/**
	 * GET /library
	 * Fetches library items from cache with server-side pagination, search, and filtering
	 */
	app.get("/library", async (request, reply) => {
		const parsed = libraryQuerySchema.parse(request.query ?? {});
		const userId = request.currentUser!.id;

		// Get user's instances to filter cache by
		const userInstances = await app.prisma.serviceInstance.findMany({
			where: {
				userId,
				enabled: true,
				service: { in: ["SONARR", "RADARR", "LIDARR", "READARR"] },
			},
			select: { id: true },
		});

		const userInstanceIds = userInstances.map((i) => i.id);

		if (userInstanceIds.length === 0) {
			// No instances configured
			return paginatedLibraryResponseSchema.parse({
				items: [],
				pagination: {
					page: parsed.page,
					limit: parsed.limit,
					totalItems: 0,
					totalPages: 0,
				},
				appliedFilters: {
					search: parsed.search,
					service: parsed.service,
					instanceId: parsed.instanceId,
					monitored: parsed.monitored,
					hasFile: parsed.hasFile,
					status: parsed.status,
					qualityProfileId: parsed.qualityProfileId,
					yearMin: parsed.yearMin,
					yearMax: parsed.yearMax,
					sortBy: parsed.sortBy,
					sortOrder: parsed.sortOrder,
				},
			});
		}

		// Check if we have any cached items
		const cachedCount = await app.prisma.libraryCache.count({
			where: { instanceId: { in: userInstanceIds } },
		});

		// If no cached items, trigger background sync for all instances
		if (cachedCount === 0) {
			request.log.info("No cached library items found, triggering initial sync");
			const scheduler = getLibrarySyncScheduler();
			for (const instance of userInstances) {
				scheduler.triggerSync(instance.id).catch((err) => {
					request.log.error({ err, instanceId: instance.id }, "Failed to trigger sync");
				});
			}

			// Return empty response - frontend will show loading state
			return paginatedLibraryResponseSchema.parse({
				items: [],
				pagination: {
					page: parsed.page,
					limit: parsed.limit,
					totalItems: 0,
					totalPages: 0,
				},
				appliedFilters: {
					search: parsed.search,
					service: parsed.service,
					instanceId: parsed.instanceId,
					monitored: parsed.monitored,
					hasFile: parsed.hasFile,
					status: parsed.status,
					qualityProfileId: parsed.qualityProfileId,
					yearMin: parsed.yearMin,
					yearMax: parsed.yearMax,
					sortBy: parsed.sortBy,
					sortOrder: parsed.sortOrder,
				},
				syncStatus: {
					isCached: false,
					lastSync: null,
					syncInProgress: true,
					totalCachedItems: 0,
				},
			});
		}

		// Build Prisma where clause
		const where: Prisma.LibraryCacheWhereInput = {
			instanceId: { in: userInstanceIds },
		};

		// Instance filter
		if (parsed.instanceId) {
			// Verify user owns this instance
			if (!userInstanceIds.includes(parsed.instanceId)) {
				return reply.status(403).send({ error: "Instance not found" });
			}
			where.instanceId = parsed.instanceId;
		}

		// Service filter (sonarr = series, radarr = movie, lidarr = artist, readarr = author)
		if (parsed.service) {
			const serviceToItemType: Record<LibraryService, PrismaLibraryItemType> = {
				sonarr: "series",
				radarr: "movie",
				lidarr: "artist",
				readarr: "author",
			};
			where.itemType = serviceToItemType[parsed.service];
		}

		// Search filter (case-insensitive title search)
		// Note: SQLite's LIKE is case-insensitive by default, so we omit mode: "insensitive"
		if (parsed.search) {
			where.title = { contains: parsed.search };
		}

		// Monitored filter
		if (parsed.monitored !== "all") {
			where.monitored = parsed.monitored === "true";
		}

		// Has file filter
		if (parsed.hasFile !== "all") {
			where.hasFile = parsed.hasFile === "true";
		}

		// Status filter
		if (parsed.status) {
			where.status = parsed.status;
		}

		// Quality profile filter
		if (parsed.qualityProfileId) {
			where.qualityProfileId = parsed.qualityProfileId;
		}

		// Year range filter
		if (parsed.yearMin !== undefined || parsed.yearMax !== undefined) {
			where.year = {};
			if (parsed.yearMin !== undefined) {
				where.year.gte = parsed.yearMin;
			}
			if (parsed.yearMax !== undefined) {
				where.year.lte = parsed.yearMax;
			}
		}

		// Get total count for pagination
		const totalItems = await app.prisma.libraryCache.count({ where });

		// Build order by
		const orderBy: Prisma.LibraryCacheOrderByWithRelationInput = {};
		switch (parsed.sortBy) {
			case "title":
				orderBy.title = parsed.sortOrder;
				break;
			case "sortTitle":
				orderBy.sortTitle = parsed.sortOrder;
				break;
			case "year":
				orderBy.year = parsed.sortOrder;
				break;
			case "sizeOnDisk":
				orderBy.sizeOnDisk = parsed.sortOrder;
				break;
			case "added":
				orderBy.arrAddedAt = parsed.sortOrder;
				break;
			default:
				orderBy.sortTitle = "asc";
		}

		// Fetch items (limit=0 means fetch all for internal use like discover filtering)
		const fetchAll = parsed.limit === 0;
		const cachedItems = await app.prisma.libraryCache.findMany({
			where,
			orderBy,
			...(fetchAll ? {} : {
				skip: (parsed.page - 1) * parsed.limit,
				take: parsed.limit,
			}),
		});

		// Parse JSON data back to LibraryItem
		const items: LibraryItem[] = cachedItems.map((item) => {
			try {
				return JSON.parse(item.data) as LibraryItem;
			} catch (parseError) {
				// Log parsing failure for debugging
				request.log.warn(
					{ err: parseError, itemId: item.id, arrItemId: item.arrItemId },
					"Failed to parse cached library item - returning minimal fallback",
				);
				// Fallback if JSON parsing fails
				const itemTypeToService: Record<string, LibraryService> = {
					series: "sonarr",
					movie: "radarr",
					artist: "lidarr",
					author: "readarr",
				};
				return {
					id: item.arrItemId,
					instanceId: item.instanceId,
					instanceName: "",
					service: itemTypeToService[item.itemType] ?? "sonarr",
					type: item.itemType as "movie" | "series" | "artist" | "author",
					title: item.title,
					titleSlug: item.titleSlug ?? undefined,
					sortTitle: item.sortTitle ?? undefined,
					year: item.year ?? undefined,
					monitored: item.monitored,
					hasFile: item.hasFile,
					status: item.status ?? undefined,
					qualityProfileId: item.qualityProfileId ?? undefined,
					qualityProfileName: item.qualityProfileName ?? undefined,
					sizeOnDisk: Number(item.sizeOnDisk),
				} as LibraryItem;
			}
		});

		// Get sync status
		const syncStatuses = await app.prisma.librarySyncStatus.findMany({
			where: { instanceId: { in: userInstanceIds } },
			select: {
				lastFullSync: true,
				syncInProgress: true,
				itemCount: true,
			},
		});

		const mostRecentSync = syncStatuses
			.map((s) => s.lastFullSync)
			.filter((d): d is Date => d !== null)
			.sort((a, b) => b.getTime() - a.getTime())[0];

		const anySyncInProgress = syncStatuses.some((s) => s.syncInProgress);

		const response: PaginatedLibraryResponse = {
			items,
			pagination: {
				page: fetchAll ? 1 : parsed.page,
				limit: fetchAll ? totalItems : parsed.limit,
				totalItems,
				totalPages: fetchAll ? 1 : Math.ceil(totalItems / parsed.limit),
			},
			appliedFilters: {
				search: parsed.search,
				service: parsed.service,
				instanceId: parsed.instanceId,
				monitored: parsed.monitored,
				hasFile: parsed.hasFile,
				status: parsed.status,
				qualityProfileId: parsed.qualityProfileId,
				yearMin: parsed.yearMin,
				yearMax: parsed.yearMax,
				sortBy: parsed.sortBy,
				sortOrder: parsed.sortOrder,
			},
			syncStatus: {
				isCached: true,
				lastSync: mostRecentSync?.toISOString() ?? null,
				syncInProgress: anySyncInProgress,
				totalCachedItems: totalItems,
			},
		};

		return paginatedLibraryResponseSchema.parse(response);
	});

	/**
	 * GET /library/episodes
	 * Fetches episodes for a specific series from a Sonarr instance
	 * Note: Episodes are NOT cached - fetched directly from ARR
	 */
	app.get("/library/episodes", async (request, reply) => {
		const parsed = libraryEpisodesRequestSchema.parse(request.query ?? {});

		const clientResult = await getClientForInstance(app, request, parsed.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				error: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as LibraryService;

		if (service !== "sonarr" || !isSonarrClient(client)) {
			return reply.status(400).send({
				error: "Episodes are only available for Sonarr instances",
			});
		}

		const seriesId = Number(parsed.seriesId);
		if (!Number.isFinite(seriesId)) {
			return reply.status(400).send({
				error: "Invalid series identifier",
			});
		}

		try {
			const rawEpisodes = await client.episode.getAll({
				seriesId,
				seasonNumber: parsed.seasonNumber,
			});

			const episodes: LibraryEpisode[] = rawEpisodes.map((raw) =>
				normalizeEpisode(raw as Record<string, unknown>, seriesId),
			);

			return libraryEpisodesResponseSchema.parse({ episodes });
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, seriesId },
				"failed to fetch episodes",
			);

			if (error instanceof ArrError) {
				return reply.status(arrErrorToHttpStatus(error)).send({
					error: error.message,
				});
			}

			return reply.status(502).send({
				error: "Failed to fetch episodes",
			});
		}
	});

	/**
	 * GET /library/albums
	 * Fetches albums for a specific artist from a Lidarr instance
	 * Note: Albums are NOT cached - fetched directly from ARR
	 */
	app.get("/library/albums", async (request, reply) => {
		const parsed = libraryAlbumsRequestSchema.parse(request.query ?? {});

		const clientResult = await getClientForInstance(app, request, parsed.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				error: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as LibraryService;

		if (service !== "lidarr" || !isLidarrClient(client)) {
			return reply.status(400).send({
				error: "Albums are only available for Lidarr instances",
			});
		}

		const artistId = Number(parsed.artistId);
		if (!Number.isFinite(artistId)) {
			return reply.status(400).send({
				error: "Invalid artist identifier",
			});
		}

		try {
			// Lidarr album endpoint: /api/v1/album?artistId=X
			const rawAlbums = await client.album.getAll({ artistId });

			const albums: LibraryAlbum[] = rawAlbums.map((raw) =>
				normalizeAlbum(raw as Record<string, unknown>, artistId, instance.baseUrl),
			);

			return libraryAlbumsResponseSchema.parse({ albums });
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, artistId },
				"failed to fetch albums",
			);

			if (error instanceof ArrError) {
				return reply.status(arrErrorToHttpStatus(error)).send({
					error: error.message,
				});
			}

			return reply.status(502).send({
				error: "Failed to fetch albums",
			});
		}
	});

	/**
	 * GET /library/books
	 * Fetches books for a specific author from a Readarr instance
	 * Note: Books are NOT cached - fetched directly from ARR
	 */
	app.get("/library/books", async (request, reply) => {
		const parsed = libraryBooksRequestSchema.parse(request.query ?? {});

		const clientResult = await getClientForInstance(app, request, parsed.instanceId);
		if (!clientResult.success) {
			return reply.status(clientResult.statusCode).send({
				error: clientResult.error,
			});
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as LibraryService;

		if (service !== "readarr" || !isReadarrClient(client)) {
			return reply.status(400).send({
				error: "Books are only available for Readarr instances",
			});
		}

		const authorId = Number(parsed.authorId);
		if (!Number.isFinite(authorId)) {
			return reply.status(400).send({
				error: "Invalid author identifier",
			});
		}

		try {
			// Readarr book endpoint: /api/v1/book?authorId=X
			const rawBooks = await client.book.getAll({ authorId });

			const books: LibraryBook[] = rawBooks.map((raw) =>
				normalizeBook(raw as Record<string, unknown>, authorId, instance.baseUrl),
			);

			return libraryBooksResponseSchema.parse({ books });
		} catch (error) {
			request.log.error(
				{ err: error, instance: instance.id, authorId },
				"failed to fetch books",
			);

			if (error instanceof ArrError) {
				return reply.status(arrErrorToHttpStatus(error)).send({
					error: error.message,
				});
			}

			return reply.status(502).send({
				error: "Failed to fetch books",
			});
		}
	});

	done();
};
