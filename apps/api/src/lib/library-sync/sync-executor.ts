/**
 * Library Sync Executor
 *
 * Handles full and incremental sync of library items from ARR instances
 * to the local cache database.
 */

import type { LibraryItem, LibraryService } from "@arr/shared";
import type { Prisma, PrismaClient, ServiceInstance } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { ArrClientFactory } from "../arr/client-factory.js";
import { SonarrClient, RadarrClient } from "arr-sdk";
import { buildLibraryItem } from "../library/library-item-builder.js";

// ============================================================================
// Types
// ============================================================================

export interface SyncResult {
	instanceId: string;
	instanceName: string;
	success: boolean;
	itemsProcessed: number;
	itemsAdded: number;
	itemsUpdated: number;
	itemsRemoved: number;
	durationMs: number;
	error?: string;
}

export interface SyncExecutorDeps {
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	log: FastifyBaseLogger;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Extracts indexed fields from a LibraryItem for database storage
 */
function extractCacheFields(item: LibraryItem): {
	title: string;
	titleSlug: string | null;
	sortTitle: string | null;
	year: number | null;
	monitored: boolean;
	hasFile: boolean;
	status: string | null;
	qualityProfileId: number | null;
	qualityProfileName: string | null;
	sizeOnDisk: bigint;
	arrAddedAt: Date | null;
	arrUpdatedAt: Date | null;
} {
	return {
		title: item.title,
		titleSlug: item.titleSlug ?? null,
		sortTitle: item.sortTitle ?? null,
		year: item.year ?? null,
		monitored: item.monitored ?? true,
		hasFile: item.hasFile ?? false,
		status: item.status ?? null,
		qualityProfileId: item.qualityProfileId ?? null,
		qualityProfileName: item.qualityProfileName ?? null,
		sizeOnDisk: BigInt(item.sizeOnDisk ?? 0),
		arrAddedAt: item.added ? new Date(item.added) : null,
		arrUpdatedAt: item.updated ? new Date(item.updated) : null,
	};
}

/**
 * Builds cache entry data from a LibraryItem
 */
function buildCacheEntry(instanceId: string, item: LibraryItem): Prisma.LibraryCacheCreateInput {
	const arrItemId = typeof item.id === "string" ? Number.parseInt(item.id, 10) : item.id;
	const fields = extractCacheFields(item);

	return {
		instance: { connect: { id: instanceId } },
		arrItemId,
		itemType: item.type,
		...fields,
		data: JSON.stringify(item),
	};
}

// ============================================================================
// Sync Executor
// ============================================================================

/**
 * Performs a full sync of library items from an ARR instance to the cache.
 * This fetches all items and reconciles with the existing cache.
 */
export async function syncInstance(
	deps: SyncExecutorDeps,
	instance: ServiceInstance,
): Promise<SyncResult> {
	const { prisma, arrClientFactory, log } = deps;
	const startTime = Date.now();

	const result: SyncResult = {
		instanceId: instance.id,
		instanceName: instance.label,
		success: false,
		itemsProcessed: 0,
		itemsAdded: 0,
		itemsUpdated: 0,
		itemsRemoved: 0,
		durationMs: 0,
	};

	try {
		// Mark sync as in progress
		await prisma.librarySyncStatus.upsert({
			where: { instanceId: instance.id },
			create: {
				instanceId: instance.id,
				syncInProgress: true,
			},
			update: {
				syncInProgress: true,
				lastError: null,
			},
		});

		// Create ARR client and fetch items
		const client = arrClientFactory.create(instance);
		const service = instance.service.toLowerCase() as LibraryService;
		let rawItems: unknown[] = [];

		if (client instanceof SonarrClient) {
			rawItems = await client.series.getAll();
		} else if (client instanceof RadarrClient) {
			rawItems = await client.movie.getAll();
		} else {
			throw new Error(`Unsupported service type: ${instance.service}`);
		}

		log.debug(
			{ instanceId: instance.id, itemCount: rawItems.length },
			"Fetched items from ARR instance",
		);

		// Build LibraryItems from raw data
		const items = rawItems.map((raw) =>
			buildLibraryItem(instance, service, raw as Record<string, unknown>),
		);

		// Get existing cached items for this instance
		const existingItems = await prisma.libraryCache.findMany({
			where: { instanceId: instance.id },
			select: { id: true, arrItemId: true, itemType: true },
		});

		const existingMap = new Map(
			existingItems.map((item) => [`${item.arrItemId}-${item.itemType}`, item.id]),
		);

		// Track which items we've seen
		const seenKeys = new Set<string>();

		// Process items in batches for efficiency
		const BATCH_SIZE = 100;

		for (let i = 0; i < items.length; i += BATCH_SIZE) {
			const batch = items.slice(i, i + BATCH_SIZE);

			await prisma.$transaction(async (tx) => {
				for (const item of batch) {
					const arrItemId = typeof item.id === "string" ? Number.parseInt(item.id, 10) : item.id;
					const key = `${arrItemId}-${item.type}`;
					seenKeys.add(key);

					const existingId = existingMap.get(key);
					const fields = extractCacheFields(item);

					if (existingId) {
						// Update existing item
						await tx.libraryCache.update({
							where: { id: existingId },
							data: {
								...fields,
								data: JSON.stringify(item),
								updatedAt: new Date(),
							},
						});
						result.itemsUpdated++;
					} else {
						// Create new item
						await tx.libraryCache.create({
							data: buildCacheEntry(instance.id, item),
						});
						result.itemsAdded++;
					}
					result.itemsProcessed++;
				}
			});
		}

		// Remove items that no longer exist in ARR
		const itemsToRemove = existingItems.filter(
			(item) => !seenKeys.has(`${item.arrItemId}-${item.itemType}`),
		);

		if (itemsToRemove.length > 0) {
			await prisma.libraryCache.deleteMany({
				where: {
					id: { in: itemsToRemove.map((item) => item.id) },
				},
			});
			result.itemsRemoved = itemsToRemove.length;
		}

		// Update sync status
		const durationMs = Date.now() - startTime;
		await prisma.librarySyncStatus.update({
			where: { instanceId: instance.id },
			data: {
				lastFullSync: new Date(),
				syncInProgress: false,
				lastSyncDurationMs: durationMs,
				lastError: null,
				itemCount: result.itemsProcessed,
			},
		});

		result.success = true;
		result.durationMs = durationMs;

		log.info(
			{
				instanceId: instance.id,
				instanceName: instance.label,
				itemsProcessed: result.itemsProcessed,
				itemsAdded: result.itemsAdded,
				itemsUpdated: result.itemsUpdated,
				itemsRemoved: result.itemsRemoved,
				durationMs,
			},
			"Library sync completed successfully",
		);
	} catch (error) {
		const durationMs = Date.now() - startTime;
		const errorMessage = error instanceof Error ? error.message : "Unknown error";

		result.durationMs = durationMs;
		result.error = errorMessage;

		// Update sync status with error
		await prisma.librarySyncStatus
			.update({
				where: { instanceId: instance.id },
				data: {
					syncInProgress: false,
					lastError: errorMessage,
				},
			})
			.catch((updateError) => {
				log.error({ err: updateError }, "Failed to update sync status with error");
			});

		log.error(
			{ err: error, instanceId: instance.id, instanceName: instance.label },
			"Library sync failed",
		);
	}

	return result;
}

/**
 * Syncs a single item to the cache (used for optimistic updates)
 */
export async function syncSingleItem(
	deps: Pick<SyncExecutorDeps, "prisma" | "log">,
	instanceId: string,
	item: LibraryItem,
): Promise<void> {
	const { prisma, log } = deps;
	const arrItemId = typeof item.id === "string" ? Number.parseInt(item.id, 10) : item.id;
	const fields = extractCacheFields(item);

	try {
		await prisma.libraryCache.upsert({
			where: {
				instanceId_arrItemId_itemType: {
					instanceId,
					arrItemId,
					itemType: item.type,
				},
			},
			create: buildCacheEntry(instanceId, item),
			update: {
				...fields,
				data: JSON.stringify(item),
				updatedAt: new Date(),
			},
		});

		log.debug({ instanceId, arrItemId, title: item.title }, "Single item synced to cache");
	} catch (error) {
		log.error({ err: error, instanceId, arrItemId }, "Failed to sync single item to cache");
		throw error;
	}
}

/**
 * Removes a single item from the cache
 */
export async function removeCachedItem(
	deps: Pick<SyncExecutorDeps, "prisma" | "log">,
	instanceId: string,
	arrItemId: number,
	itemType: "movie" | "series",
): Promise<void> {
	const { prisma, log } = deps;

	try {
		await prisma.libraryCache.delete({
			where: {
				instanceId_arrItemId_itemType: {
					instanceId,
					arrItemId,
					itemType,
				},
			},
		});

		log.debug({ instanceId, arrItemId, itemType }, "Item removed from cache");
	} catch (error) {
		// Item might not exist, which is fine
		if ((error as { code?: string }).code !== "P2025") {
			log.error({ err: error, instanceId, arrItemId }, "Failed to remove item from cache");
			throw error;
		}
	}
}
