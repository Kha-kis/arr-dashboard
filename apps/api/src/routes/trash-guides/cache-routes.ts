/**
 * TRaSH Guides Cache API Routes
 *
 * Endpoints for fetching, refreshing, and managing TRaSH Guides cache.
 */

import { TRASH_CONFIG_TYPES } from "@arr/shared";
import type { TrashConfigType } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from "fastify";
import { z } from "zod";
import { createCacheManager } from "../../lib/trash-guides/cache-manager.js";
import { createTrashFetcher, getRateLimitState } from "../../lib/trash-guides/github-fetcher.js";
import { getRepoConfig } from "../../lib/trash-guides/repo-config.js";

// ============================================================================
// Request Schemas
// ============================================================================

const getCacheParamsSchema = z.object({
	serviceType: z.enum(["RADARR", "SONARR"]),
	configType: z.enum([
		"CUSTOM_FORMATS",
		"CF_GROUPS",
		"QUALITY_SIZE",
		"NAMING",
		"QUALITY_PROFILES",
		"CF_DESCRIPTIONS",
		"CF_INCLUDES",
	]),
});

const refreshCacheBodySchema = z.object({
	serviceType: z.enum(["RADARR", "SONARR"]),
	configType: z
		.enum([
			"CUSTOM_FORMATS",
			"CF_GROUPS",
			"QUALITY_SIZE",
			"NAMING",
			"QUALITY_PROFILES",
			"CF_DESCRIPTIONS",
			"CF_INCLUDES",
		])
		.optional(),
	force: z.boolean().optional().default(false),
});

const getStatusParamsSchema = z.object({
	serviceType: z.enum(["RADARR", "SONARR"]).optional(),
});

const getEntriesQuerySchema = z.object({
	serviceType: z.enum(["RADARR", "SONARR"]),
});

// ============================================================================
// Route Handlers
// ============================================================================

export async function registerTrashCacheRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	const cacheManager = createCacheManager(app.prisma);

	/** Create a fetcher configured for the current user's repo settings */
	async function getFetcher(userId: string) {
		const repoConfig = await getRepoConfig(app.prisma, userId);
		return createTrashFetcher({ repoConfig, logger: app.log });
	}

	/**
	 * GET /api/trash-guides/cache/:serviceType/:configType
	 * Get cached TRaSH Guides data for a specific config type
	 */
	app.get<{
		Params: z.infer<typeof getCacheParamsSchema>;
	}>("/:serviceType/:configType", async (request, reply) => {
		const { serviceType, configType } = getCacheParamsSchema.parse(request.params);

		try {
			// Check if cache exists and is fresh
			const isFresh = await cacheManager.isFresh(serviceType, configType);

			if (!isFresh) {
				// Cache is stale or doesn't exist, fetch fresh data
				app.log.info({ serviceType, configType }, "Cache miss or stale, fetching fresh data");

				const fetcher = await getFetcher(request.currentUser!.id);
				const data = await fetcher.fetchConfigs(serviceType, configType);
				await cacheManager.set(serviceType, configType, data);

				return reply.send({
					data,
					cached: false,
					status: await cacheManager.getStatus(serviceType, configType),
				});
			}

			// Get cached data
			const data = await cacheManager.get(serviceType, configType);

			if (!data) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: `No cache found for ${serviceType} ${configType}`,
				});
			}

			return reply.send({
				data,
				cached: true,
				status: await cacheManager.getStatus(serviceType, configType),
			});
		} catch (error) {
			app.log.error({ err: error, serviceType, configType }, "Failed to get cache");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to fetch TRaSH Guides data",
			});
		}
	});

	/**
	 * POST /api/trash-guides/cache/refresh
	 * Manually refresh cache from GitHub
	 */
	app.post<{
		Body: z.infer<typeof refreshCacheBodySchema>;
	}>("/refresh", async (request, reply) => {
		const { serviceType, configType, force } = refreshCacheBodySchema.parse(request.body);

		try {
			const results: Record<string, unknown> = {};

			// If specific config type provided, refresh only that
			if (configType) {
				// Check if refresh is needed
				if (!force) {
					const isFresh = await cacheManager.isFresh(serviceType, configType);
					if (isFresh) {
						return reply.send({
							message: "Cache is already fresh",
							refreshed: false,
							status: await cacheManager.getStatus(serviceType, configType),
						});
					}
				}

				app.log.info({ serviceType, configType, force }, "Refreshing cache");

				const fetcher = await getFetcher(request.currentUser!.id);
				const data = await fetcher.fetchConfigs(serviceType, configType);
				await cacheManager.set(serviceType, configType, data);

				results[configType] = {
					success: true,
					itemCount: Array.isArray(data) ? data.length : 0,
				};

				return reply.send({
					message: "Cache refreshed successfully",
					refreshed: true,
					results,
					status: await cacheManager.getStatus(serviceType, configType),
				});
			}

			// Refresh all config types for the service
			app.log.info({ serviceType, force }, "Refreshing all caches");

			// Skip heavy types during full refresh - they make 100+ requests and can crash the server.
			// These are lazy-loaded by the frontend when needed.
			const SKIP_DURING_FULL_REFRESH = ["CF_DESCRIPTIONS", "CF_INCLUDES"];
			const configTypes = (Object.values(TRASH_CONFIG_TYPES) as TrashConfigType[]).filter(
				(type) => !SKIP_DURING_FULL_REFRESH.includes(type),
			);

			const fetcher = await getFetcher(request.currentUser!.id);

			for (const type of configTypes) {
				try {
					// Check if refresh is needed
					if (!force) {
						const isFresh = await cacheManager.isFresh(serviceType, type);
						if (isFresh) {
							results[type] = {
								success: true,
								skipped: true,
								reason: "Cache is fresh",
							};
							continue;
						}
					}

					const data = await fetcher.fetchConfigs(serviceType, type);
					await cacheManager.set(serviceType, type, data);

					results[type] = {
						success: true,
						itemCount: Array.isArray(data) ? data.length : 0,
					};
				} catch (error) {
					app.log.error({ err: error, configType: type }, "Failed to refresh config type");
					results[type] = {
						success: false,
						error: error instanceof Error ? error.message : "Unknown error",
					};
				}
			}

			// Mark skipped types
			for (const type of SKIP_DURING_FULL_REFRESH) {
				results[type] = {
					success: true,
					skipped: true,
					reason: "Lazy-loaded on demand",
				};
			}

			return reply.send({
				message: "Cache refresh completed",
				refreshed: true,
				results,
			});
		} catch (error) {
			app.log.error({ err: error, serviceType, configType }, "Failed to refresh cache");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to refresh cache",
			});
		}
	});

	/**
	 * GET /api/trash-guides/cache/status
	 * Get cache status for all or specific service
	 */
	app.get<{
		Querystring: z.infer<typeof getStatusParamsSchema>;
	}>("/status", async (request, reply) => {
		const { serviceType } = getStatusParamsSchema.parse(request.query);

		try {
			if (serviceType) {
				// Get status for specific service
				const statuses = await cacheManager.getAllStatuses(serviceType);

				return reply.send({
					serviceType,
					statuses,
				});
			}

			// Get status for all services
			const radarrStatuses = await cacheManager.getAllStatuses("RADARR");
			const sonarrStatuses = await cacheManager.getAllStatuses("SONARR");

			return reply.send({
				radarr: radarrStatuses,
				sonarr: sonarrStatuses,
				stats: await cacheManager.getStats(),
			});
		} catch (error) {
			app.log.error({ err: error }, "Failed to get cache status");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to get cache status",
			});
		}
	});

	/**
	 * GET /api/trash-guides/cache/entries
	 * Get cache entries with data for a specific service type
	 */
	app.get<{
		Querystring: z.infer<typeof getEntriesQuerySchema>;
	}>("/entries", async (request, reply) => {
		const { serviceType } = getEntriesQuerySchema.parse(request.query);

		try {
			const configTypes = Object.values(TRASH_CONFIG_TYPES) as TrashConfigType[];
			const entries = [];

			for (const configType of configTypes) {
				const data = await cacheManager.get(serviceType, configType);
				if (data) {
					const status = await cacheManager.getStatus(serviceType, configType);
					if (status) {
						entries.push({
							id: `${serviceType}-${configType}`,
							serviceType,
							configType,
							data,
							version: status.version,
							fetchedAt: status.lastFetched,
							lastCheckedAt: status.lastChecked,
							updatedAt: status.lastFetched,
						});
					}
				}
			}

			return reply.send(entries);
		} catch (error) {
			app.log.error({ err: error, serviceType }, "Failed to get cache entries");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to get cache entries",
			});
		}
	});

	/**
	 * DELETE /api/trash-guides/cache/:serviceType/:configType
	 * Delete specific cache entry
	 */
	app.delete<{
		Params: z.infer<typeof getCacheParamsSchema>;
	}>("/:serviceType/:configType", async (request, reply) => {
		const { serviceType, configType } = getCacheParamsSchema.parse(request.params);

		try {
			const deleted = await cacheManager.delete(serviceType, configType);

			if (!deleted) {
				return reply.status(404).send({
					statusCode: 404,
					error: "NotFound",
					message: `No cache found for ${serviceType} ${configType}`,
				});
			}

			return reply.send({
				message: "Cache deleted successfully",
				serviceType,
				configType,
			});
		} catch (error) {
			app.log.error({ err: error, serviceType, configType }, "Failed to delete cache");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to delete cache",
			});
		}
	});

	/**
	 * GET /api/trash-guides/cache/custom-formats/list
	 * Get all available custom formats from cache for browsing
	 */
	app.get<{
		Querystring: { serviceType?: "RADARR" | "SONARR" };
	}>("/custom-formats/list", async (request, reply) => {
		const { serviceType } = request.query;

		try {
			const results: Record<string, unknown> = {};

			// Fetch custom formats for requested service types
			const serviceTypes = serviceType ? [serviceType] : ["RADARR", "SONARR"];

			for (const service of serviceTypes) {
				// Check cache freshness
				const isFresh = await cacheManager.isFresh(
					service as "RADARR" | "SONARR",
					"CUSTOM_FORMATS",
				);

				if (!isFresh) {
					// Fetch fresh data if cache is stale
					const fetcher = await getFetcher(request.currentUser!.id);
					const data = await fetcher.fetchConfigs(service as "RADARR" | "SONARR", "CUSTOM_FORMATS");
					await cacheManager.set(service as "RADARR" | "SONARR", "CUSTOM_FORMATS", data);
					results[service.toLowerCase()] = data;
				} else {
					// Get from cache
					const data = await cacheManager.get(service as "RADARR" | "SONARR", "CUSTOM_FORMATS");
					results[service.toLowerCase()] = data || [];
				}
			}

			return reply.send(results);
		} catch (error) {
			app.log.error({ err: error, serviceType }, "Failed to fetch custom formats list");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to fetch custom formats",
			});
		}
	});

	/**
	 * GET /api/trash-guides/cache/cf-descriptions/list
	 * Get all CF descriptions from cache
	 */
	app.get<{
		Querystring: { serviceType?: "RADARR" | "SONARR" };
	}>("/cf-descriptions/list", async (request, reply) => {
		const { serviceType } = request.query;

		try {
			const results: Record<string, unknown> = {};
			const serviceTypes = serviceType ? [serviceType] : ["RADARR", "SONARR"];

			for (const service of serviceTypes) {
				const isFresh = await cacheManager.isFresh(
					service as "RADARR" | "SONARR",
					"CF_DESCRIPTIONS",
				);

				if (!isFresh) {
					const fetcher = await getFetcher(request.currentUser!.id);
					const data = await fetcher.fetchConfigs(
						service as "RADARR" | "SONARR",
						"CF_DESCRIPTIONS",
					);
					await cacheManager.set(service as "RADARR" | "SONARR", "CF_DESCRIPTIONS", data);
					results[service.toLowerCase()] = data;
				} else {
					const data = await cacheManager.get(service as "RADARR" | "SONARR", "CF_DESCRIPTIONS");
					results[service.toLowerCase()] = data || [];
				}
			}

			return reply.send(results);
		} catch (error) {
			app.log.error({ err: error, serviceType }, "Failed to fetch CF descriptions");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to fetch CF descriptions",
			});
		}
	});

	/**
	 * GET /api/trash-guides/cache/rate-limit
	 * Get current GitHub API rate limit status
	 */
	app.get("/rate-limit", async (_request, reply) => {
		const state = getRateLimitState();

		if (!state) {
			return reply.send({
				status: "unknown",
				message: "No GitHub API requests made yet",
			});
		}

		const now = Date.now();
		const resetTime = state.resetAt.getTime();
		const secondsUntilReset = Math.max(0, Math.ceil((resetTime - now) / 1000));

		// Determine status based on remaining requests
		let status: "ok" | "warning" | "critical";
		if (state.remaining < 2) {
			status = "critical";
		} else if (state.remaining < 10) {
			status = "warning";
		} else {
			status = "ok";
		}

		return reply.send({
			status,
			limit: state.limit,
			remaining: state.remaining,
			resetAt: state.resetAt.toISOString(),
			secondsUntilReset,
			lastUpdated: state.lastUpdated.toISOString(),
			isAuthenticated: state.isAuthenticated,
			message:
				status === "critical"
					? `Rate limit nearly exhausted. Resets in ${secondsUntilReset}s`
					: status === "warning"
						? `Rate limit running low (${state.remaining} remaining)`
						: `Rate limit healthy (${state.remaining}/${state.limit} remaining)`,
		});
	});

	/**
	 * GET /api/trash-guides/cache/cf-includes/list
	 * Get all CF include files from cache.
	 * These are MkDocs snippets shared across CF descriptions.
	 * Stored under RADARR serviceType as a convention (includes are shared).
	 */
	app.get("/cf-includes/list", async (request, reply) => {
		try {
			// CF includes are stored under RADARR as they're shared across services
			const isFresh = await cacheManager.isFresh("RADARR", "CF_INCLUDES");

			if (!isFresh) {
				const fetcher = await getFetcher(request.currentUser!.id);
				const data = await fetcher.fetchConfigs("RADARR", "CF_INCLUDES");
				await cacheManager.set("RADARR", "CF_INCLUDES", data);
				return reply.send({ data });
			}

			const data = await cacheManager.get("RADARR", "CF_INCLUDES");
			return reply.send({ data: data || [] });
		} catch (error) {
			app.log.error({ err: error }, "Failed to fetch CF includes");
			return reply.status(500).send({
				statusCode: 500,
				error: "InternalServerError",
				message: error instanceof Error ? error.message : "Failed to fetch CF includes",
			});
		}
	});
}
