/**
 * TRaSH Guides Cache Manager
 *
 * Manages caching of TRaSH Guides configuration data with compression.
 * Handles cache versioning, staleness detection, and automatic cleanup.
 */

import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { TrashCacheStatus, TrashConfigType } from "@arr/shared";
import { z } from "zod";
import type { PrismaClient, TrashCache } from "../../lib/prisma.js";
import { loggers } from "../logger.js";

import { trashQualitySizeSchema } from "./github-schemas.js";

const log = loggers.trashGuides;
const qualitySizeCacheSchema = z.array(trashQualitySizeSchema);

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

/** Decompress a stored gzip payload. */
async function decompressData(compressedData: string): Promise<unknown> {
	const buffer = Buffer.from(compressedData, "base64");
	const decompressed = await gunzipAsync(buffer);
	return JSON.parse(decompressed.toString("utf-8"));
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

export interface TrashCacheProvenance {
	version: 1;
	repository: string;
	commitHash: string;
}

export interface TrashCacheSnapshot<T> {
	data: T;
	commitHash: string | null;
	provenance: TrashCacheProvenance | null;
}

const VERIFIED_PROVENANCE_PREFIX = "verified:v1:";

function encodeVerifiedProvenance(provenance: TrashCacheProvenance): string {
	if (!provenance.repository || !/^[0-9a-f]{40}$/i.test(provenance.commitHash)) {
		throw new Error("Verified TRaSH cache provenance requires a repository and full commit hash");
	}
	return `${VERIFIED_PROVENANCE_PREFIX}${encodeURIComponent(provenance.repository)}:${provenance.commitHash.toLowerCase()}`;
}

function decodeVerifiedProvenance(value: string | null): TrashCacheProvenance | null {
	if (!value?.startsWith(VERIFIED_PROVENANCE_PREFIX)) return null;
	const encoded = value.slice(VERIFIED_PROVENANCE_PREFIX.length);
	const separatorIndex = encoded.lastIndexOf(":");
	if (separatorIndex <= 0) return null;
	let repository: string;
	try {
		repository = decodeURIComponent(encoded.slice(0, separatorIndex));
	} catch {
		return null;
	}
	const commitHash = encoded.slice(separatorIndex + 1);
	if (!repository || !/^[0-9a-f]{40}$/i.test(commitHash)) return null;
	return { version: 1, repository, commitHash: commitHash.toLowerCase() };
}

/** Thrown when a stored cache entry cannot be read. */
export class CacheCorruptionError extends Error {
	readonly statusCode = 503;
	constructor(serviceType: string, configType: string) {
		super(
			`Cache for ${serviceType}/${configType} is unavailable. Refresh the cache to fetch a replacement.`,
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
		schema?: z.ZodType<T>,
	): Promise<T | null> {
		const snapshot = await this.getSnapshot(serviceType, configType, schema);
		return snapshot?.data ?? null;
	}

	/**
	 * Get cached data and its source commit from the same database row.
	 * Reading does not establish that the upstream source is still current.
	 */
	async getSnapshot<T = unknown>(
		serviceType: "RADARR" | "SONARR",
		configType: TrashConfigType,
		schema?: z.ZodType<T>,
	): Promise<TrashCacheSnapshot<T> | null> {
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

		const data = await this.readData(cacheEntry, schema);
		const provenance = decodeVerifiedProvenance(cacheEntry.commitHash);
		return { data, commitHash: provenance?.commitHash ?? null, provenance };
	}

	private async readData<T>(entry: TrashCache, schema?: z.ZodType<T>): Promise<T> {
		try {
			const data = this.options.compressionEnabled
				? await decompressData(entry.data)
				: JSON.parse(entry.data);
			if (!Array.isArray(data)) throw new Error("Expected an array in the TRaSH cache");
			if (schema) return schema.parse(data);
			if (entry.configType === "QUALITY_SIZE") qualitySizeCacheSchema.parse(data);
			return data as T;
		} catch {
			log.warn(
				{ serviceType: entry.serviceType, configType: entry.configType },
				"TRaSH cache entry is unreadable",
			);
			throw new CacheCorruptionError(entry.serviceType, entry.configType);
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
				commitHash: commitHash ?? null,
				fetchedAt: now,
				lastCheckedAt: now,
			},
		});
	}

	/** Store cache data with durable, commit-addressed repository provenance. */
	async setVerified<T = unknown>(
		serviceType: "RADARR" | "SONARR",
		configType: TrashConfigType,
		data: T,
		provenance: TrashCacheProvenance,
	): Promise<void> {
		await this.set(serviceType, configType, data, encodeVerifiedProvenance(provenance));
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

		return this.describeEntry(cacheEntry, serviceType);
	}

	/** Read cache status without changing any stored entry. */
	async getAllStatuses(serviceType: "RADARR" | "SONARR"): Promise<TrashCacheStatus[]> {
		const entries = await this.prisma.trashCache.findMany({ where: { serviceType } });
		const statuses: TrashCacheStatus[] = [];
		for (const entry of entries) statuses.push(await this.describeEntry(entry, serviceType));
		return statuses;
	}

	private async describeEntry(
		entry: TrashCache,
		serviceType: "RADARR" | "SONARR",
	): Promise<TrashCacheStatus> {
		const staleThreshold = new Date();
		staleThreshold.setHours(staleThreshold.getHours() - this.options.staleAfterHours);
		const metadata = {
			serviceType,
			configType: entry.configType as TrashConfigType,
			version: entry.version,
			lastFetched: entry.fetchedAt.toISOString(),
			lastChecked: entry.lastCheckedAt.toISOString(),
			isStale: entry.lastCheckedAt <= staleThreshold,
		};

		try {
			const data = await this.readData<unknown[]>(entry);
			const sourceBreakdown = countSourceBreakdown(data);
			return { ...metadata, itemCount: data.length, ...(sourceBreakdown && { sourceBreakdown }) };
		} catch (error) {
			if (!(error instanceof CacheCorruptionError)) throw error;
			return { ...metadata, unavailable: true, itemCount: null };
		}
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
		} catch (err) {
			// Log unexpected DB errors (P2025 = record not found is expected)
			if ((err as { code?: string }).code !== "P2025") {
				log.warn({ err }, "Cache delete failed");
			}
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
		return (await this.getProvenance(serviceType, configType))?.commitHash ?? null;
	}

	/** Return durable provenance only for a readable cache entry. */
	async getProvenance(
		serviceType: "RADARR" | "SONARR",
		configType: TrashConfigType,
	): Promise<TrashCacheProvenance | null> {
		const cacheEntry = await this.prisma.trashCache.findUnique({
			where: {
				serviceType_configType: {
					serviceType,
					configType,
				},
			},
		});

		if (!cacheEntry) return null;
		const provenance = decodeVerifiedProvenance(cacheEntry.commitHash);
		if (!provenance) return null;
		try {
			await this.readData(cacheEntry);
			return provenance;
		} catch (error) {
			if (!(error instanceof CacheCorruptionError)) throw error;
			return null;
		}
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
