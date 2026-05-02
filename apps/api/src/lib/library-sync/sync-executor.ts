/**
 * Library Sync Executor
 *
 * Handles full and incremental sync of library items from ARR instances
 * to the local cache database.
 */

import type { LibraryItem, LibraryService } from "@arr/shared";
import { LidarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import type { FastifyBaseLogger } from "fastify";
import type { Prisma, PrismaClient, ServiceInstance } from "../../lib/prisma.js";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import { triggerLabelSyncForItem } from "../label-sync/trigger-for-item.js";
import { buildLibraryItem } from "../library/library-item-builder.js";
import { getErrorMessage } from "../utils/error-message.js";

// ============================================================================
// Types
// ============================================================================

export interface NewDownloadItem {
	title: string;
	itemType: string;
}

export interface SyncResult {
	instanceId: string;
	instanceName: string;
	success: boolean;
	itemsProcessed: number;
	itemsAdded: number;
	itemsUpdated: number;
	itemsRemoved: number;
	/** Items that transitioned from hasFile=false to hasFile=true (newly downloaded) */
	newDownloads: NewDownloadItem[];
	durationMs: number;
	error?: string;
}

export interface SyncExecutorDeps {
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	encryptor: Encryptor;
	log: FastifyBaseLogger;
}

/**
 * One tag-list change detected during a sync run. We collect these inside
 * the per-batch transaction (cheap — just a JSON parse + array diff) and
 * process them AFTER all transactions complete, so Label Sync's external
 * HTTP calls don't hold DB connections open.
 */
interface TagDelta {
	arrItemId: number;
	itemType: "movie" | "series" | "artist" | "author";
	tmdbId: number | null;
	addedTagIds: number[];
	removedTagIds: number[];
}

/** Parse the tag id list out of a LibraryCache.data blob. Tolerant of malformed JSON. */
function parseTagsFromCacheData(data: string | null | undefined): number[] {
	if (!data) return [];
	try {
		const parsed = JSON.parse(data) as { tags?: unknown };
		if (!Array.isArray(parsed.tags)) return [];
		return parsed.tags.filter((t): t is number => typeof t === "number");
	} catch {
		return [];
	}
}

/** Diff old vs new tag ids; returns added + removed (set arithmetic). */
function diffTags(oldTags: number[], newTags: number[]): { added: number[]; removed: number[] } {
	const oldSet = new Set(oldTags);
	const newSet = new Set(newTags);
	const added: number[] = [];
	const removed: number[] = [];
	for (const t of newTags) if (!oldSet.has(t)) added.push(t);
	for (const t of oldTags) if (!newSet.has(t)) removed.push(t);
	return { added, removed };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Extracts indexed fields from a LibraryItem for database storage
 */
function extractCacheFields(
	item: LibraryItem,
	cutoffUnmetIds?: Set<number>,
): {
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
	cutoffUnmet: boolean;
	arrAddedAt: Date | null;
	arrUpdatedAt: Date | null;
} {
	const arrItemId = typeof item.id === "string" ? Number.parseInt(item.id, 10) : item.id;
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
		cutoffUnmet: cutoffUnmetIds?.has(arrItemId) ?? false,
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
	const { prisma, arrClientFactory, encryptor, log } = deps;
	const startTime = Date.now();

	const result: SyncResult = {
		instanceId: instance.id,
		instanceName: instance.label,
		success: false,
		itemsProcessed: 0,
		itemsAdded: 0,
		itemsUpdated: 0,
		itemsRemoved: 0,
		newDownloads: [],
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
		} else if (client instanceof LidarrClient) {
			rawItems = await client.artist.getAll();
		} else if (client instanceof ReadarrClient) {
			rawItems = await client.author.getAll();
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

		// Fetch cutoff-unmet item IDs for Sonarr/Radarr (quality upgrade candidates)
		const cutoffUnmetIds = new Set<number>();
		if (client instanceof SonarrClient || client instanceof RadarrClient) {
			try {
				let cutoffPage = 1;
				const cutoffPageSize = 1000;
				let hasMore = true;
				while (hasMore) {
					const cutoffResult = await client.wanted.cutoff({
						page: cutoffPage,
						pageSize: cutoffPageSize,
					});
					const records = cutoffResult.records ?? [];
					for (const record of records) {
						const recordAny = record as Record<string, unknown>;
						// Sonarr cutoff returns episodes with seriesId; Radarr returns movies with id
						const itemId = (recordAny.seriesId ?? recordAny.id) as number | undefined;
						if (itemId) cutoffUnmetIds.add(itemId);
					}
					hasMore = records.length === cutoffPageSize;
					cutoffPage++;
				}
				log.debug(
					{ instanceId: instance.id, cutoffUnmetCount: cutoffUnmetIds.size },
					"Fetched cutoff-unmet item IDs",
				);
			} catch (error) {
				log.warn(
					{ err: error, instanceId: instance.id },
					"Failed to fetch cutoff-unmet data — cutoffUnmet will default to false",
				);
			}
		}

		// Get existing cached items for this instance. We pull `data` so we can
		// diff the previous tag list against the fresh one for Label Sync's
		// event-driven trigger (Phase C — issue #384 follow-up).
		const existingItems = await prisma.libraryCache.findMany({
			where: { instanceId: instance.id },
			select: { id: true, arrItemId: true, itemType: true, hasFile: true, data: true },
		});

		const existingMap = new Map(
			existingItems.map((item) => [
				`${item.arrItemId}-${item.itemType}`,
				{ id: item.id, hasFile: item.hasFile, data: item.data },
			]),
		);

		// Pre-fetch tag id→name map for Label Sync delta detection. Only
		// Sonarr/Radarr support tag-write rules today; Lidarr/Readarr skip.
		// One call per sync amortizes across every item we examine.
		const tagIdToName = new Map<number, string>();
		if (client instanceof SonarrClient || client instanceof RadarrClient) {
			try {
				const tags = (await client.tag.getAll()) as Array<{ id?: number; label?: string }>;
				for (const t of tags) {
					if (typeof t.id === "number" && typeof t.label === "string" && t.label.length > 0) {
						tagIdToName.set(t.id, t.label);
					}
				}
			} catch (err) {
				log.warn(
					{ err, instanceId: instance.id },
					"Tag list fetch failed — Label Sync delta detection will be skipped this run",
				);
			}
		}

		// Tag deltas collected during the transaction; processed afterward
		// so external HTTP calls in Label Sync don't hold DB connections.
		const tagDeltas: TagDelta[] = [];

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

					const existing = existingMap.get(key);
					const fields = extractCacheFields(item, cutoffUnmetIds);

					if (existing) {
						// Update existing item
						await tx.libraryCache.update({
							where: { id: existing.id },
							data: {
								...fields,
								data: JSON.stringify(item),
								updatedAt: new Date(),
							},
						});
						result.itemsUpdated++;

						// Detect newly downloaded: hasFile went from false → true
						if (!existing.hasFile && fields.hasFile) {
							result.newDownloads.push({ title: item.title, itemType: item.type });
						}

						// Phase C: detect tag-list change vs the previously cached
						// data, queue Label Sync triggers for processing after the
						// transaction. Only meaningful for instances where we
						// successfully pulled the tag id→name map.
						if (tagIdToName.size > 0) {
							const oldTags = parseTagsFromCacheData(existing.data);
							const newTags = parseTagsFromCacheData(JSON.stringify(item));
							const { added, removed } = diffTags(oldTags, newTags);
							if (added.length > 0 || removed.length > 0) {
								const itemAny = item as { tmdbId?: unknown };
								const tmdbId =
									typeof itemAny.tmdbId === "number" && itemAny.tmdbId > 0 ? itemAny.tmdbId : null;
								tagDeltas.push({
									arrItemId,
									itemType: item.type,
									tmdbId,
									addedTagIds: added,
									removedTagIds: removed,
								});
							}
						}
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
		const idsToRemove = existingItems
			.filter((item) => !seenKeys.has(`${item.arrItemId}-${item.itemType}`))
			.map((item) => item.id);

		if (idsToRemove.length > 0) {
			await prisma.libraryCache.deleteMany({
				where: {
					id: { in: idsToRemove },
				},
			});
			result.itemsRemoved = idsToRemove.length;
		}

		// Phase C: process collected tag deltas — fire Label Sync triggers for
		// items where tags were added or removed. Done OUTSIDE the per-batch
		// transaction so external HTTP calls don't hold DB connections open.
		// Failures are isolated per item — one bad delta doesn't abort the rest.
		if (
			tagDeltas.length > 0 &&
			tagIdToName.size > 0 &&
			(instance.service === "SONARR" || instance.service === "RADARR")
		) {
			let triggeredCount = 0;
			for (const delta of tagDeltas) {
				if (delta.itemType !== "movie" && delta.itemType !== "series") continue;
				// Build the union of changed tag names — added OR removed both
				// warrant re-evaluating Label Sync rules for that tag.
				const changedNames = new Set<string>();
				for (const id of delta.addedTagIds) {
					const name = tagIdToName.get(id);
					if (name) changedNames.add(name);
				}
				for (const id of delta.removedTagIds) {
					const name = tagIdToName.get(id);
					if (name) changedNames.add(name);
				}
				if (changedNames.size === 0) continue;

				for (const tagName of changedNames) {
					try {
						const triggerResult = await triggerLabelSyncForItem({
							userId: instance.userId,
							sourceService: instance.service,
							sourceInstanceId: instance.id,
							arrItemId: delta.arrItemId,
							itemType: delta.itemType,
							tagName,
							tmdbId: delta.tmdbId ?? undefined,
							prisma,
							arrClientFactory,
							encryptor,
							log,
						});
						if (triggerResult.rulesFired > 0) triggeredCount++;
					} catch (chainErr) {
						log.warn(
							{
								err: chainErr,
								arrItemId: delta.arrItemId,
								tagName,
								instanceId: instance.id,
							},
							"Label Sync trigger threw during library-sync delta processing (non-fatal)",
						);
					}
				}
			}
			if (triggeredCount > 0) {
				log.info(
					{ instanceId: instance.id, triggeredCount },
					"Library sync delta fired Label Sync rule triggers",
				);
			}
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
		const errorMessage = getErrorMessage(error, "Unknown error");

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
