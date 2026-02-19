/**
 * TRaSH Guides Cache Manager
 *
 * Manages caching of TRaSH Guides configuration data with compression.
 * Handles cache versioning, staleness detection, and automatic cleanup.
 */

import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { TrashCacheStatus, TrashConfigType } from "@arr/shared";
import type { PrismaClient } from "../../lib/prisma.js";
import { safeJsonParse } from "./utils.js";
import { loggers } from "../logger.js";

const log = loggers.trashGuides;

// ============================================================================
// Compression Utilities
// ============================================================================

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Compress JSON data using gzip
 */
async function compressData(data: unknown): Promise<string> {
	const jsonString = JSON.stringify(data);
	const compressed = await gzipAsync(Buffer.from(jsonString, "utf-8"));
	return compressed.toString("base64");
}

/**
 * Decompress gzip data to JSON
 * @throws Error if decompression or parsing fails
 */
async function decompressData<T = unknown>(compressedData: string): Promise<T> {
	const buffer = Buffer.from(compressedData, "base64");
	const decompressed = await gunzipAsync(buffer);
	const jsonString = decompressed.toString("utf-8");
	return JSON.parse(jsonString) as T;
}

// ============================================================================
// Source Breakdown
// ============================================================================

/**
 * Count items by _repoSource tag (set during supplementary mode merge).
 * Returns undefined when no items carry the tag (official-only or fork mode).
 */
function countSourceBreakdown(data: unknown): { official: number; custom: number } | undefined {
	if (!Array.isArray(data)) return undefined;
	let official = 0;
	let custom = 0;
	for (const item of data) {
		if (item && typeof item === "object" && "_repoSource" in item) {
			const source = (item as { _repoSource: string })._repoSource;
			if (source === "official") official++;
			else if (source === "custom") custom++;
		}
	}
	if (official === 0 && custom === 0) return undefined;
	if (official + custom !== data.length) {
		log.warn(
			{ official, custom, total: data.length },
			"Source breakdown count mismatch — some items may lack _repoSource tag",
		);
	}
	return { official, custom };
}

// ============================================================================
// Types
// ============================================================================

interface CacheOptions {
	staleAfterHours?: number; // Hours before cache is considered stale
	compressionEnabled?: boolean;
}

interface CacheStats {
	totalEntries: number;
	staleEntries: number;
	totalSizeBytes: number;
	oldestEntry?: Date;
	newestEntry?: Date;
}

/** Thrown when a cache entry is corrupted and has been automatically cleaned up. */
export class CacheCorruptionError extends Error {
	readonly statusCode = 500;
	constructor(serviceType: string, configType: string) {
		super(
			`Cache for ${serviceType}/${configType} was corrupted and has been cleared. Please refresh to re-fetch from GitHub.`,
		);
		this.name = "CacheCorruptionError";
	}
}

// ============================================================================
// Cache Manager Class
// ============================================================================

export class TrashCacheManager {
	private prisma: PrismaClient;
	private options: Required<CacheOptions>;

	constructor(prisma: PrismaClient, options: CacheOptions = {}) {
		this.prisma = prisma;
		this.options = {
			staleAfterHours: options.staleAfterHours ?? 12,
			compressionEnabled: options.compressionEnabled ?? true,
		};
	}

	/**
	 * Get cached data for a specific service and config type
	 */
	async get<T = unknown>(
		serviceType: "RADARR" | "SONARR",
		configType: TrashConfigType,
	): Promise<T | null> {
		const cacheEntry = await this.prisma.trashCache.findUnique({
			where: {
				serviceType_configType: {
					serviceType,
					configType,
				},
			},
		});

		if (!cacheEntry) {
			return null;
		}

		// Update last checked timestamp
		await this.touchCache(serviceType, configType);

		// Decompress and return data
		try {
			if (this.options.compressionEnabled) {
				return await decompressData<T>(cacheEntry.data);
			}

			const parsed = safeJsonParse<T>(cacheEntry.data, {
				source: "TrashCacheManager",
				identifier: `${serviceType}/${configType}`,
			});
			if (parsed === undefined) {
				// Invalidate corrupted cache entry and signal the error
				await this.delete(serviceType, configType);
				throw new CacheCorruptionError(serviceType, configType);
			}
			return parsed;
		} catch (error) {
			if (error instanceof CacheCorruptionError) throw error;
			// Handle decompression or parsing errors
			log.error({ err: error, serviceType, configType, dataSize: cacheEntry.data.length }, "Failed to retrieve cache");
			// Invalidate corrupted cache entry and signal the error
			await this.delete(serviceType, configType);
			throw new CacheCorruptionError(serviceType, configType);
		}
	}

	/**
	 * Set cached data for a specific service and config type
	 */
	async set<T = unknown>(
		serviceType: "RADARR" | "SONARR",
		configType: TrashConfigType,
		data: T,
		commitHash?: string,
	): Promise<void> {
		// Compress data if enabled
		const dataString = this.options.compressionEnabled
			? await compressData(data)
			: JSON.stringify(data);

		const now = new Date();

		// Get existing entry to check if version should increment
		const existing = await this.prisma.trashCache.findUnique({
			where: {
				serviceType_configType: {
					serviceType,
					configType,
				},
			},
		});

		const newVersion = existing ? existing.version + 1 : 1;

		// Upsert cache entry
		await this.prisma.trashCache.upsert({
			where: {
				serviceType_configType: {
					serviceType,
					configType,
				},
			},
			create: {
				serviceType,
				configType,
				data: dataString,
				version: 1,
				commitHash,
				fetchedAt: now,
				lastCheckedAt: now,
			},
			update: {
				data: dataString,
				version: newVersion,
				commitHash,
				fetchedAt: now,
				lastCheckedAt: now,
			},
		});
	}

	/**
	 * Check if cache exists and is fresh
	 */
	async isFresh(serviceType: "RADARR" | "SONARR", configType: TrashConfigType): Promise<boolean> {
		const cacheEntry = await this.prisma.trashCache.findUnique({
			where: {
				serviceType_configType: {
					serviceType,
					configType,
				},
			},
		});

		if (!cacheEntry) {
			return false;
		}

		const staleThreshold = new Date();
		staleThreshold.setHours(staleThreshold.getHours() - this.options.staleAfterHours);

		return cacheEntry.lastCheckedAt > staleThreshold;
	}

	/**
	 * Get cache status for a specific service and config type
	 */
	async getStatus(
		serviceType: "RADARR" | "SONARR",
		configType: TrashConfigType,
	): Promise<TrashCacheStatus | null> {
		const cacheEntry = await this.prisma.trashCache.findUnique({
			where: {
				serviceType_configType: {
					serviceType,
					configType,
				},
			},
		});

		if (!cacheEntry) {
			return null;
		}

		// Determine if cache is stale
		const staleThreshold = new Date();
		staleThreshold.setHours(staleThreshold.getHours() - this.options.staleAfterHours);
		const isStale = cacheEntry.lastCheckedAt <= staleThreshold;

		// Get item count and source breakdown with error handling
		let itemCount = 0;
		let sourceBreakdown: { official: number; custom: number } | undefined;
		try {
			const data = this.options.compressionEnabled
				? await decompressData<unknown[]>(cacheEntry.data)
				: safeJsonParse<unknown[]>(cacheEntry.data, {
						source: "TrashCacheManager",
						identifier: `${serviceType}/${configType}`,
					});

			// If parsing failed in non-compressed mode, invalidate the entry
			if (!this.options.compressionEnabled && data === undefined) {
				await this.delete(serviceType, configType);
				return null;
			}

			itemCount = Array.isArray(data) ? data.length : 0;
			sourceBreakdown = countSourceBreakdown(data);
		} catch (error) {
			// Handle decompression errors
			log.error({ err: error, serviceType, configType, dataSize: cacheEntry.data.length }, "Failed to get cache status");
			await this.delete(serviceType, configType);
			return null;
		}

		return {
			serviceType,
			configType,
			version: cacheEntry.version,
			lastFetched: cacheEntry.fetchedAt.toISOString(),
			lastChecked: cacheEntry.lastCheckedAt.toISOString(),
			itemCount,
			isStale,
			...(sourceBreakdown && { sourceBreakdown }),
		};
	}

	/**
	 * Get all cache statuses for a service
	 */
	async getAllStatuses(serviceType: "RADARR" | "SONARR"): Promise<TrashCacheStatus[]> {
		const cacheEntries = await this.prisma.trashCache.findMany({
			where: { serviceType },
		});

		const statuses: TrashCacheStatus[] = [];
		const entriesToDelete: string[] = [];

		for (const entry of cacheEntries) {
			const staleThreshold = new Date();
			staleThreshold.setHours(staleThreshold.getHours() - this.options.staleAfterHours);
			const isStale = entry.lastCheckedAt <= staleThreshold;

			let itemCount = 0;
			let sourceBreakdown: { official: number; custom: number } | undefined;
			try {
				const data = this.options.compressionEnabled
					? await decompressData<unknown[]>(entry.data)
					: safeJsonParse<unknown[]>(entry.data, {
							source: "TrashCacheManager",
							identifier: `${serviceType}/${entry.configType}`,
						});

				// If parsing failed in non-compressed mode, mark for deletion
				if (!this.options.compressionEnabled && data === undefined) {
					entriesToDelete.push(entry.configType);
					continue;
				}

				itemCount = Array.isArray(data) ? data.length : 0;
				sourceBreakdown = countSourceBreakdown(data);
			} catch (error) {
				// Handle decompression errors - mark for deletion
				log.error({ err: error, serviceType, configType: entry.configType, dataSize: entry.data.length }, "Failed to get cache status");
				entriesToDelete.push(entry.configType);
				continue;
			}

			statuses.push({
				serviceType,
				configType: entry.configType as TrashConfigType,
				version: entry.version,
				lastFetched: entry.fetchedAt.toISOString(),
				lastChecked: entry.lastCheckedAt.toISOString(),
				itemCount,
				isStale,
				...(sourceBreakdown && { sourceBreakdown }),
			});
		}

		// Clean up corrupted entries
		for (const configType of entriesToDelete) {
			await this.delete(serviceType, configType as TrashConfigType);
		}

		return statuses;
	}

	/**
	 * Update last checked timestamp without modifying data
	 */
	async touchCache(serviceType: "RADARR" | "SONARR", configType: TrashConfigType): Promise<void> {
		await this.prisma.trashCache.updateMany({
			where: {
				serviceType,
				configType,
			},
			data: {
				lastCheckedAt: new Date(),
			},
		});
	}

	/**
	 * Delete cache entry
	 */
	async delete(serviceType: "RADARR" | "SONARR", configType: TrashConfigType): Promise<boolean> {
		try {
			await this.prisma.trashCache.delete({
				where: {
					serviceType_configType: {
						serviceType,
						configType,
					},
				},
			});
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Clear all cache for a service
	 */
	async clearService(serviceType: "RADARR" | "SONARR"): Promise<number> {
		const result = await this.prisma.trashCache.deleteMany({
			where: { serviceType },
		});
		return result.count;
	}

	/**
	 * Clear all cache entries
	 */
	async clearAll(): Promise<number> {
		const result = await this.prisma.trashCache.deleteMany();
		return result.count;
	}

	/**
	 * Get cache statistics
	 */
	async getStats(): Promise<CacheStats> {
		const allEntries = await this.prisma.trashCache.findMany({
			select: {
				data: true,
				fetchedAt: true,
				lastCheckedAt: true,
			},
		});

		const staleThreshold = new Date();
		staleThreshold.setHours(staleThreshold.getHours() - this.options.staleAfterHours);

		let totalSizeBytes = 0;
		let staleCount = 0;
		let oldestEntry: Date | undefined;
		let newestEntry: Date | undefined;

		for (const entry of allEntries) {
			// Calculate size
			totalSizeBytes += Buffer.byteLength(entry.data, "utf-8");

			// Count stale entries
			if (entry.lastCheckedAt <= staleThreshold) {
				staleCount++;
			}

			// Track oldest/newest
			if (!oldestEntry || entry.fetchedAt < oldestEntry) {
				oldestEntry = entry.fetchedAt;
			}
			if (!newestEntry || entry.fetchedAt > newestEntry) {
				newestEntry = entry.fetchedAt;
			}
		}

		return {
			totalEntries: allEntries.length,
			staleEntries: staleCount,
			totalSizeBytes,
			oldestEntry,
			newestEntry,
		};
	}

	/**
	 * Clean up stale cache entries (optional maintenance operation)
	 */
	async cleanupStale(): Promise<number> {
		const staleThreshold = new Date();
		staleThreshold.setHours(staleThreshold.getHours() - this.options.staleAfterHours * 2);

		const result = await this.prisma.trashCache.deleteMany({
			where: {
				lastCheckedAt: {
					lte: staleThreshold,
				},
			},
		});

		return result.count;
	}

	/**
	 * Get the commit hash for cached data
	 */
	async getCommitHash(
		serviceType: "RADARR" | "SONARR",
		configType: TrashConfigType,
	): Promise<string | null> {
		const cacheEntry = await this.prisma.trashCache.findUnique({
			where: {
				serviceType_configType: {
					serviceType,
					configType,
				},
			},
			select: {
				commitHash: true,
			},
		});

		return cacheEntry?.commitHash || null;
	}
}

// ============================================================================
// Exports
// ============================================================================

/**
 * Create a cache manager instance
 */
export function createCacheManager(
	prisma: PrismaClient,
	options: CacheOptions = {},
): TrashCacheManager {
	return new TrashCacheManager(prisma, options);
}
