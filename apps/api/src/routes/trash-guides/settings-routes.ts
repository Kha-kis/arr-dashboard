/**
 * TRaSH Guides Settings Routes
 *
 * API routes for managing TRaSH Guides user settings including backup retention policy
 * and custom upstream repository configuration.
 *
 * BACKUP RETENTION POLICY:
 * ------------------------
 * - `backupRetentionDays`: Number of days before a backup automatically expires (default: 30)
 *   - Set to 0 to disable automatic expiration (backups will never auto-delete)
 *   - Backups are created before each deployment operation
 *   - Expired backups are automatically cleaned up by the trash-backup-cleanup scheduler
 *
 * - `backupRetention`: Maximum number of backups to keep per instance (default: 10)
 *   - This is a count-based retention policy
 *   - Enforced by the BackupManager.enforceRetentionLimit() method
 *
 * CLEANUP PROCESS:
 * ----------------
 * The trash-backup-cleanup scheduler runs every hour and performs:
 * 1. Deletes backups where expiresAt < now()
 * 2. Deletes orphaned backups (no referencing SyncHistory or DeploymentHistory) older than 7 days
 *
 * The scheduler is registered as a Fastify plugin and starts automatically when the server starts.
 *
 * CUSTOM REPOSITORY:
 * ------------------
 * Users can configure a custom GitHub fork to replace the official TRaSH-Guides/Guides upstream.
 * The fork must follow the same directory structure.
 * When the repo changes, all caches are automatically invalidated.
 */

import type { TrashConfigType } from "@arr/shared";
import { DEFAULT_TRASH_REPO, TRASH_CONFIG_TYPES } from "@arr/shared";
import type {
	FastifyBaseLogger,
	FastifyInstance,
	FastifyPluginOptions,
	FastifyReply,
	FastifyRequest,
} from "fastify";
import { z } from "zod";
import type { TrashCacheManager } from "../../lib/trash-guides/cache-manager.js";
import { createCacheManager } from "../../lib/trash-guides/cache-manager.js";
import type { TrashGitHubFetcher } from "../../lib/trash-guides/github-fetcher.js";
import { createTrashFetcher } from "../../lib/trash-guides/github-fetcher.js";
import { getRepoConfig } from "../../lib/trash-guides/repo-config.js";

// Regex for valid GitHub owner/repo names
const githubNameRegex = /^[a-zA-Z0-9_.-]+$/;
// Branch names can also contain forward slashes (e.g., feature/custom-formats)
const githubBranchRegex = /^[a-zA-Z0-9_./-]+$/;

// Schema for update request
const updateSettingsSchema = z.object({
	checkFrequency: z.number().min(1).max(168).optional(), // 1 hour to 1 week
	autoRefreshCache: z.boolean().optional(),
	notifyOnUpdates: z.boolean().optional(),
	notifyOnSyncFail: z.boolean().optional(),
	backupRetention: z.number().min(1).max(100).optional(), // 1-100 backups per instance
	backupRetentionDays: z.number().min(0).max(365).optional(), // 0 = never expire, max 1 year
	customRepoOwner: z
		.string()
		.regex(githubNameRegex, "Invalid GitHub owner name")
		.max(100)
		.nullable()
		.optional(),
	customRepoName: z
		.string()
		.regex(githubNameRegex, "Invalid GitHub repository name")
		.max(100)
		.nullable()
		.optional(),
	customRepoBranch: z
		.string()
		.regex(githubBranchRegex, "Invalid branch name")
		.max(100)
		.nullable()
		.optional(),
});

// Schema for test-repo endpoint
const testRepoSchema = z.object({
	owner: z.string().regex(githubNameRegex, "Invalid GitHub owner name").max(100),
	name: z.string().regex(githubNameRegex, "Invalid GitHub repository name").max(100),
	branch: z.string().regex(githubBranchRegex, "Invalid branch name").max(100),
});

// Config types that are quick to fetch. Heavy types (CF_DESCRIPTIONS, CF_INCLUDES) are
// lazy-loaded by the frontend on demand, so we skip them during bulk cache population.
const LIGHTWEIGHT_CONFIG_TYPES = (Object.values(TRASH_CONFIG_TYPES) as TrashConfigType[]).filter(
	(type) => type !== "CF_DESCRIPTIONS" && type !== "CF_INCLUDES",
);

/**
 * Populate the cache from a given fetcher in the background (fire-and-forget).
 * Used after repo changes and resets to pre-warm the cache.
 */
function populateCacheInBackground(
	cacheManager: TrashCacheManager,
	fetcher: TrashGitHubFetcher,
	log: FastifyBaseLogger,
	label: string,
): void {
	void (async () => {
		try {
			for (const serviceType of ["RADARR", "SONARR"] as const) {
				for (const configType of LIGHTWEIGHT_CONFIG_TYPES) {
					try {
						const data = await fetcher.fetchConfigs(serviceType, configType);
						await cacheManager.set(serviceType, configType, data);
						log.info(
							{ serviceType, configType, itemCount: Array.isArray(data) ? data.length : 0 },
							"Auto-populated cache entry",
						);
					} catch (error) {
						log.warn(
							{ err: error, serviceType, configType },
							`Failed to auto-populate cache entry (${label})`,
						);
					}
				}
			}
			log.info(`Cache auto-population complete (${label})`);
		} catch (error) {
			log.error({ err: error }, `Cache auto-population failed unexpectedly (${label})`);
		}
	})();
}

export async function registerSettingsRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
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
	 * GET /api/trash-guides/settings
	 *
	 * Get the current user's TRaSH Guides settings.
	 * Creates default settings if they don't exist.
	 */
	app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth

		// Get or create settings
		let settings = await app.prisma.trashSettings.findUnique({
			where: { userId },
		});

		if (!settings) {
			settings = await app.prisma.trashSettings.create({
				data: { userId },
			});
		}

		return reply.send({
			settings,
			defaultRepo: DEFAULT_TRASH_REPO,
			// Include documentation about the settings
			documentation: {
				backupRetentionDays: {
					description: "Number of days before backups automatically expire",
					default: 30,
					range: "0-365 (0 = never expire)",
				},
				backupRetention: {
					description: "Maximum number of backups to keep per instance",
					default: 10,
					range: "1-100",
				},
				checkFrequency: {
					description: "How often to check for TRaSH Guides updates (hours)",
					default: 12,
					range: "1-168",
				},
			},
		});
	});

	/**
	 * PATCH /api/trash-guides/settings
	 *
	 * Update the current user's TRaSH Guides settings.
	 * When custom repo fields change, automatically invalidates all caches.
	 */
	app.patch("/", async (request: FastifyRequest, reply: FastifyReply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth

		// Validate request body
		const parseResult = updateSettingsSchema.safeParse(request.body);
		if (!parseResult.success) {
			return reply.status(400).send({
				error: "Invalid request body",
				details: parseResult.error.issues,
			});
		}

		const updates = parseResult.data;

		// Check if repo config is changing (need to invalidate cache)
		const repoFieldsChanging =
			updates.customRepoOwner !== undefined ||
			updates.customRepoName !== undefined ||
			updates.customRepoBranch !== undefined;

		let previousRepoConfig: Awaited<ReturnType<typeof app.prisma.trashSettings.findUnique>> | null =
			null;
		if (repoFieldsChanging) {
			previousRepoConfig = await app.prisma.trashSettings.findUnique({
				where: { userId },
			});
		}

		// Upsert settings
		const settings = await app.prisma.trashSettings.upsert({
			where: { userId },
			create: {
				userId,
				...updates,
			},
			update: updates,
		});

		// Invalidate cache if repo config actually changed
		let cacheCleared = false;
		if (repoFieldsChanging && previousRepoConfig) {
			const repoActuallyChanged =
				settings.customRepoOwner !== previousRepoConfig.customRepoOwner ||
				settings.customRepoName !== previousRepoConfig.customRepoName ||
				settings.customRepoBranch !== previousRepoConfig.customRepoBranch;

			if (repoActuallyChanged) {
				const cacheManager = createCacheManager(app.prisma);
				await cacheManager.clearAll();
				cacheCleared = true;
				app.log.info(
					`Cache cleared due to repo config change: ${previousRepoConfig.customRepoOwner ?? "official"}/${previousRepoConfig.customRepoName ?? "Guides"} → ${settings.customRepoOwner ?? "official"}/${settings.customRepoName ?? "Guides"}`,
				);

				const repoConfig = await getRepoConfig(app.prisma, userId);
				const fetcher = createTrashFetcher({ repoConfig, logger: app.log });
				populateCacheInBackground(cacheManager, fetcher, app.log, "repo config change");
			}
		}

		return reply.send({
			settings,
			message: cacheCleared
				? "Settings updated — cache is being populated from the new repository"
				: "Settings updated successfully",
			cacheCleared,
		});
	});

	/**
	 * POST /api/trash-guides/settings/test-repo
	 *
	 * Test if a custom repository is valid and has the expected TRaSH Guides structure.
	 * Checks for the docs/json directory which is required for all data fetching.
	 */
	app.post("/test-repo", async (request: FastifyRequest, reply: FastifyReply) => {
		const parseResult = testRepoSchema.safeParse(request.body);
		if (!parseResult.success) {
			return reply.status(400).send({
				error: "Invalid request body",
				details: parseResult.error.issues,
			});
		}

		const { owner, name, branch } = parseResult.data;

		try {
			const apiUrl = `https://api.github.com/repos/${owner}/${name}/contents/docs/json?ref=${branch}`;
			const headers: Record<string, string> = {
				"User-Agent": "arr-dashboard/2.3.0",
				Accept: "application/vnd.github.v3+json",
			};

			// Use GitHub token if available for higher rate limits
			const githubToken = process.env.GITHUB_TOKEN;
			if (githubToken) {
				headers.Authorization = `Bearer ${githubToken}`;
			}

			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 10000);

			const response = await fetch(apiUrl, {
				signal: controller.signal,
				headers,
			});
			clearTimeout(timeoutId);

			if (response.ok) {
				const contents = (await response.json()) as Array<{ name: string; type: string }>;
				const hasRadarr = contents.some((f) => f.name === "radarr" && f.type === "dir");
				const hasSonarr = contents.some((f) => f.name === "sonarr" && f.type === "dir");

				return reply.send({
					valid: true,
					repo: `${owner}/${name}`,
					branch,
					structure: {
						hasRadarr,
						hasSonarr,
						directoriesFound: contents.filter((f) => f.type === "dir").map((f) => f.name),
					},
				});
			}

			if (response.status === 404) {
				return reply.send({
					valid: false,
					error: `Repository or path not found: ${owner}/${name} (branch: ${branch}). Ensure the repo exists and has a docs/json directory.`,
				});
			}

			if (response.status === 403) {
				// Check if it's actually a rate limit issue
				const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
				const isRateLimited = rateLimitRemaining === "0";

				if (isRateLimited) {
					const resetTime = response.headers.get("x-ratelimit-reset");
					const resetIn = resetTime
						? Math.max(0, Math.ceil((Number(resetTime) * 1000 - Date.now()) / 60000))
						: null;
					return reply.send({
						valid: false,
						error: `GitHub API rate limit exceeded${resetIn ? ` (resets in ~${resetIn} min)` : ""}. Set GITHUB_TOKEN env var for 5,000 requests/hour.`,
					});
				}

				// Not rate limited — likely access denied or private repo
				let detail = "";
				try {
					const body = (await response.json()) as { message?: string };
					if (body.message) detail = `: ${body.message}`;
				} catch {
					// Ignore parse errors
				}
				return reply.send({
					valid: false,
					error: `Access denied for ${owner}/${name}${detail}. Ensure the repository is public or set a GITHUB_TOKEN with repo access.`,
				});
			}

			// Other HTTP errors
			let statusDetail = "";
			try {
				const body = (await response.json()) as { message?: string };
				if (body.message) statusDetail = ` — ${body.message}`;
			} catch {
				// Ignore parse errors
			}
			return reply.send({
				valid: false,
				error: `GitHub API returned HTTP ${response.status}${statusDetail}`,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return reply.send({
				valid: false,
				error: `Failed to connect to GitHub API: ${message}`,
			});
		}
	});

	/**
	 * POST /api/trash-guides/settings/reset-repo
	 *
	 * Reset to official TRaSH-Guides/Guides repository.
	 * Clears all custom repo fields and invalidates caches.
	 */
	app.post("/reset-repo", async (request: FastifyRequest, reply: FastifyReply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth

		// Clear custom repo fields
		const settings = await app.prisma.trashSettings.upsert({
			where: { userId },
			create: { userId },
			update: {
				customRepoOwner: null,
				customRepoName: null,
				customRepoBranch: null,
			},
		});

		// Clear all caches
		const cacheManager = createCacheManager(app.prisma);
		const deletedCount = await cacheManager.clearAll();

		app.log.info(`Reset to official repo. Cleared ${deletedCount} cache entries.`);

		const repoConfig = await getRepoConfig(app.prisma, userId);
		const fetcher = createTrashFetcher({ repoConfig, logger: app.log });
		populateCacheInBackground(cacheManager, fetcher, app.log, "reset to official repo");

		return reply.send({
			settings,
			message: `Reset to official TRaSH-Guides repository — cache is being repopulated.`,
			cacheEntriesCleared: deletedCount,
		});
	});

	/**
	 * GET /api/trash-guides/settings/backup-stats
	 *
	 * Get backup statistics for the current user.
	 * Useful for monitoring backup retention and cleanup effectiveness.
	 */
	app.get("/backup-stats", async (request: FastifyRequest, reply: FastifyReply) => {
		const userId = request.currentUser!.id; // preHandler guarantees auth

		// Run all independent queries in parallel for better performance
		const [settings, totalBackups, expiredBackups, backupsPerInstance, oldestBackup, newestBackup] =
			await Promise.all([
				// Get user's settings
				app.prisma.trashSettings.findUnique({
					where: { userId },
					select: { backupRetention: true, backupRetentionDays: true },
				}),
				// Count backups
				app.prisma.trashBackup.count({
					where: { userId },
				}),
				// Count expired backups
				app.prisma.trashBackup.count({
					where: {
						userId,
						expiresAt: {
							not: null,
							lte: new Date(),
						},
					},
				}),
				// Count backups per instance
				app.prisma.trashBackup.groupBy({
					by: ["instanceId"],
					where: { userId },
					_count: { id: true },
				}),
				// Get oldest backup date
				app.prisma.trashBackup.findFirst({
					where: { userId },
					orderBy: { createdAt: "asc" },
					select: { createdAt: true },
				}),
				// Get newest backup date
				app.prisma.trashBackup.findFirst({
					where: { userId },
					orderBy: { createdAt: "desc" },
					select: { createdAt: true },
				}),
			]);

		return reply.send({
			stats: {
				totalBackups,
				expiredBackups,
				backupsPerInstance: backupsPerInstance.map((b) => ({
					instanceId: b.instanceId,
					count: b._count.id,
				})),
				oldestBackup: oldestBackup?.createdAt ?? null,
				newestBackup: newestBackup?.createdAt ?? null,
			},
			settings: {
				backupRetention: settings?.backupRetention ?? 10,
				backupRetentionDays: settings?.backupRetentionDays ?? 30,
			},
			retentionPolicy: {
				description: "Backups are automatically cleaned up based on two policies",
				timeBased: {
					enabled: (settings?.backupRetentionDays ?? 30) > 0,
					days: settings?.backupRetentionDays ?? 30,
					description: "Backups older than this are automatically deleted",
				},
				countBased: {
					enabled: true,
					maxPerInstance: settings?.backupRetention ?? 10,
					description: "Only the most recent N backups per instance are kept",
				},
				orphanCleanup: {
					enabled: true,
					gracePeriodDays: 7,
					description: "Backups with no referencing history records are deleted after 7 days",
				},
			},
		});
	});
}
