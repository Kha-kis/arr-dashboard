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
		return coerceTagIds(parsed.tags);
	} catch {
		return [];
	}
}

/**
 * The shared `LibraryItem.tags` schema is `z.array(z.string())` (each tag id
 * stored as a string), but the *arr-sdk's raw movie/series resource returns
 * `tags: number[]`. The library item builder may pass either through
 * depending on the path. Normalize both to a number list for diffing.
 */
function coerceTagIds(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	const out: number[] = [];
	for (const v of value) {
		if (typeof v === "number" && Number.isFinite(v)) out.push(v);
		else if (typeof v === "string" && v.length > 0) {
			const n = Number.parseInt(v, 10);
			if (Number.isFinite(n)) out.push(n);
		}
	}
	return out;
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

/** Returns true for service types that need tag-delta detection + a stored data blob. */
function isTagDeltaService(service: string): boolean {
	return service === "SONARR" || service === "RADARR";
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
 * Builds cache entry create data from a LibraryItem.
 * Always includes the full normalized JSON in `data` for /library response serving.
 */
function buildCacheCreate(
	instanceId: string,
	item: LibraryItem,
): Omit<Prisma.LibraryCacheCreateInput, "data"> & { data: string } {
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

/**
 * Logs process memory usage at debug level for monitoring heap during sync phases.
 */
function logMemoryPhase(log: FastifyBaseLogger, instanceId: string, phase: string): void {
	if (!log.level || log.level === "silent") return;
	const mem = process.memoryUsage();
	log.debug(
		{
			instanceId,
			phase,
			heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
			heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
			rssMB: Math.round(mem.rss / 1024 / 1024),
		},
		"Library sync memory usage",
	);
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
	const tagDeltaService = isTagDeltaService(instance.service);

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

		const client = arrClientFactory.create(instance);
		const service = instance.service.toLowerCase() as LibraryService;

		// Sample heap BEFORE the full-library fetch so heap-monitor data can
		// distinguish the parse-spike contribution (issue #427) from the
		// batch-loop retention window.
		logMemoryPhase(log, instance.id, "before-fetch");

		let rawItems: unknown[];

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
		logMemoryPhase(log, instance.id, "after-fetch");

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

		// Only pull the `data` column for Sonarr/Radarr (tag-delta detection).
		// Readarr/Lidarr skip it to avoid loading every cached JSON blob.
		//
		// Cursor-paginate at SYNC_QUERY_BATCH_SIZE rows. The previous shape
		// loaded every row at once; for a 100k Sonarr/Radarr library with
		// the data JSON column included that easily exceeds the 768 MB
		// container heap (issue #427). Used both for the existing-item map
		// AND the deletion-id list at end of sync, so we collect the minimal
		// fields for both passes here.
		const SYNC_QUERY_BATCH_SIZE = 500;
		const existingMap = new Map<string, { id: string; hasFile: boolean; data: string | null }>();
		// Mirrors `existingItems` from the prior shape — the post-sync
		// deletion pass at the bottom of this function reads
		// (id, arrItemId, itemType) to compute the stale-row diff.
		const existingForDeletion: Array<{ id: string; arrItemId: number; itemType: string }> = [];
		{
			let cursor: string | undefined;
			while (true) {
				const batch = await prisma.libraryCache.findMany({
					where: { instanceId: instance.id },
					select: {
						id: true,
						arrItemId: true,
						itemType: true,
						hasFile: true,
						...(tagDeltaService ? { data: true } : {}),
					},
					take: SYNC_QUERY_BATCH_SIZE,
					...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
					orderBy: { id: "asc" },
				});
				if (batch.length === 0) break;
				for (const item of batch) {
					existingMap.set(`${item.arrItemId}-${item.itemType}`, {
						id: item.id,
						hasFile: item.hasFile,
						data: "data" in item ? ((item as { data: string | null }).data ?? null) : null,
					});
					existingForDeletion.push({
						id: item.id,
						arrItemId: item.arrItemId,
						itemType: item.itemType,
					});
				}
				cursor = batch[batch.length - 1]!.id;
				if (batch.length < SYNC_QUERY_BATCH_SIZE) break;
			}
		}

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

		const tagDeltas: TagDelta[] = [];
		const seenKeys = new Set<string>();
		const BATCH_SIZE = 100;

		// Process items in batches directly from rawItems — avoids building
		// a full parallel normalized array in memory.
		//
		// Pop-based drain (issue #427): the previous `for (i ... slice)` shape
		// kept `rawItems` fully alive until the loop completed because every
		// slice held an implicit reference back to the source array's
		// elements. For a 1.5M-track Lidarr library (~50k artist objects,
		// 200-500 MB parsed) the retention window spanned the entire batch
		// transaction chain. Pop-draining shrinks the array as we go, so each
		// processed batch is eligible for GC during the next transaction's
		// await. Reverse processing order is safe: every item still gets
		// exactly one create/update and sync is order-independent.
		while (rawItems.length > 0) {
			const rawBatch: Array<Record<string, unknown>> = [];
			const batchSize = Math.min(BATCH_SIZE, rawItems.length);
			for (let j = 0; j < batchSize; j++) {
				rawBatch.push(rawItems.pop() as Record<string, unknown>);
			}

			await prisma.$transaction(async (tx) => {
				for (const raw of rawBatch) {
					const item = buildLibraryItem(instance, service, raw);
					const arrItemId = typeof item.id === "string" ? Number.parseInt(item.id, 10) : item.id;
					const key = `${arrItemId}-${item.type}`;
					seenKeys.add(key);

					const existing = existingMap.get(key);
					const fields = extractCacheFields(item, cutoffUnmetIds);

					if (existing) {
						const updateData: Prisma.LibraryCacheUpdateInput = {
							...fields,
							data: JSON.stringify(item),
							updatedAt: new Date(),
						};

						await tx.libraryCache.update({
							where: { id: existing.id },
							data: updateData,
						});
						result.itemsUpdated++;

						if (!existing.hasFile && fields.hasFile) {
							result.newDownloads.push({ title: item.title, itemType: item.type });
						}

						if (tagIdToName.size > 0) {
							const oldTags = parseTagsFromCacheData(existing.data);
							const newTags = coerceTagIds((item.tags as unknown) ?? []);
							const { added, removed } = diffTags(oldTags, newTags);
							if (added.length > 0 || removed.length > 0) {
								const itemAny = item as {
									tmdbId?: unknown;
									remoteIds?: { tmdbId?: unknown } | null;
								};
								const tmdbCandidates: unknown[] = [itemAny.remoteIds?.tmdbId, itemAny.tmdbId];
								let tmdbId: number | null = null;
								for (const v of tmdbCandidates) {
									if (typeof v === "number" && v > 0) {
										tmdbId = v;
										break;
									}
								}
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
						await tx.libraryCache.create({
							data: buildCacheCreate(instance.id, item),
						});
						result.itemsAdded++;
					}
					result.itemsProcessed++;
				}
			});
		}

		// Defensive: pop-drain already empties rawItems, but reassign to a
		// fresh array so any retained closure reference (current or future)
		// can release the original buffer immediately.
		rawItems = [];

		logMemoryPhase(log, instance.id, "after-batch-writes");

		const idsToRemove = existingForDeletion
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

		if (
			tagDeltas.length > 0 &&
			tagIdToName.size > 0 &&
			(instance.service === "SONARR" || instance.service === "RADARR")
		) {
			let triggeredCount = 0;
			for (const delta of tagDeltas) {
				if (delta.itemType !== "movie" && delta.itemType !== "series") continue;
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
