/**
 * Per-episode infoHash correlation for Sonarr — the TV analog of the
 * movie path-backfill in `infohash-backfill-by-path.ts`.
 *
 * Background: arr-dashboard's `library_cache` stores SERIES-level rows
 * for Sonarr (one row per show, not per episode). The series JSON does
 * NOT carry per-episode-file metadata — Sonarr requires a separate
 * `GET /api/v3/episodefile?seriesId=X` call to enumerate the files on
 * disk. So before we can do inode-based correlation at the episode
 * granularity, we need a cache of episode-file paths keyed by their
 * Sonarr EpisodeFile id.
 *
 * That cache is `EpisodeFileCache` (one row per EpisodeFile, NOT per
 * Episode — a multi-ep file like `S01E01-E02.mkv` is ONE EpisodeFile
 * covering two Episode entities). The unit of correlation is the file
 * on disk, not the episode number, because the file is what gets
 * stat()'d and looked up in the inode index.
 *
 * Two responsibilities live in this module:
 *
 *   1. `runEpisodeFileSync` — for each Sonarr instance, for each series
 *      with at least one file, pull the per-series episode-file list
 *      from Sonarr's API and upsert into `EpisodeFileCache`. Delete
 *      stale rows whose EpisodeFile ids no longer appear in Sonarr.
 *      This is the cache-population pass.
 *
 *   2. `runEpisodeBackfillSweep` — iterate `EpisodeFileCache` rows with
 *      `infoHash IS NULL`, stat each row's path, look up its
 *      `(dev, ino)` in the per-instance inode index built from qui's
 *      torrent list. On a hit, write `infoHash` + `infoHashSource =
 *      "inode"` back to the cache row. Mirrors the movie sweep exactly
 *      — the inode index already contains every file in every torrent
 *      (per-file walking shipped earlier), so episode files in season
 *      packs and multi-file torrents resolve naturally.
 *
 * Why qui parity holds here too: this module uses the same
 * `buildFileIdIndex` and `matchLibraryByFileId` helpers as movies. The
 * inode-strategy semantics (strict mode when `hasLocalFilesystemAccess
 * === true`, no heuristic fallback, FileID = `(st_dev, st_ino)`) carry
 * over without modification. The only thing that's different is the
 * unit of work — episode files instead of movie files.
 *
 * Out of scope (deliberately, for v1):
 *
 *   - Heuristic fallback for episodes when FS access is off. The
 *     movie heuristics rely on title+year tokenization, which doesn't
 *     translate cleanly to episodes (episode files are
 *     `Show.S01E01.mkv`, not `Title (Year).mkv`). FS-disabled qui
 *     instances will see episodes stuck — that's acceptable because
 *     anyone running arr-dashboard server-side will enable the toggle.
 *   - Lidarr per-track correlation. Same pattern, separate session.
 */

import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { ServiceInstance } from "../prisma.js";
import { createQuiClient } from "../qui/client-factory.js";
import { withQuiObservationTopologyGuard } from "../qui/observation-topology-guard.js";
import {
	assertQuiTopologyGenerationCurrent,
	captureQuiTopologyGeneration,
} from "../qui/topology-generation.js";
import { getErrorMessage } from "../utils/error-message.js";
import {
	cachedSonarrSeriesFileEvidence,
	createEpisodeFileInventoryReceipt,
	currentSonarrSeriesFileEvidence,
	episodeFileIdentitiesFromSonarr,
	hasCompleteEpisodeFileInventory,
} from "./episode-file-coverage.js";
import { buildFileIdIndex, matchLibraryByFileId } from "./infohash-backfill-by-inode.js";
import { CURRENT_INODE_SOURCE } from "./inode-correlation-upgrade.js";

const BACKFILL_MISS_RETRY_MS = 30 * 60_000;

export interface EpisodeFileSyncResult {
	usersScanned: number;
	seriesScanned: number;
	filesUpserted: number;
	filesDeleted: number;
	errors: number;
	durationMs: number;
}

export interface EpisodeFileSyncArgs {
	app: FastifyInstance;
	log?: FastifyBaseLogger;
	/** Cap on series fetched per sweep. Each series = one Sonarr API call. */
	seriesCap: number;
}

/**
 * Pull episode-file metadata from Sonarr and upsert into EpisodeFileCache.
 *
 * One Sonarr API call per series with `hasFile = true`. For a typical
 * library this is ~500 series × ~10-30 episodes each. The cap protects
 * against runaway sweeps; subsequent ticks resume where this one left
 * off (oldest cache rows first).
 *
 * Deletes EpisodeFileCache rows whose Sonarr EpisodeFile id no longer
 * appears in the latest pull — that's the cleanup path for episodes
 * that *arr deleted (upgrade-replaces-old-file, hand-removed, etc.).
 */
export async function runEpisodeFileSync({
	app,
	log,
	seriesCap,
}: EpisodeFileSyncArgs): Promise<EpisodeFileSyncResult> {
	const startedAt = Date.now();
	const result: EpisodeFileSyncResult = {
		usersScanned: 0,
		seriesScanned: 0,
		filesUpserted: 0,
		filesDeleted: 0,
		errors: 0,
		durationMs: 0,
	};

	const sonarrInstances = await app.prisma.serviceInstance.findMany({
		where: { service: "SONARR", enabled: true },
	});

	const seenUserIds = new Set(sonarrInstances.map((instance) => instance.userId));
	const availableClients: Array<{
		sonarrInstance: (typeof sonarrInstances)[number];
		client: ReturnType<typeof app.arrClientFactory.create>;
	}> = [];
	for (const sonarrInstance of sonarrInstances) {
		try {
			availableClients.push({
				sonarrInstance,
				client: app.arrClientFactory.create(sonarrInstance),
			});
		} catch (err) {
			result.errors++;
			await app.prisma.libraryCache.updateMany({
				where: { instanceId: sonarrInstance.id, itemType: "series" },
				data: { episodeFileInventoryReceipt: null },
			});
			log?.warn(
				{ err: getErrorMessage(err), sonarrInstanceId: sonarrInstance.id },
				"episode-file-sync: failed to build Sonarr client; skipping instance",
			);
		}
	}

	// Reserve a fair bounded share for each healthy Sonarr connection, then
	// use any unused slots for the globally oldest attempts. With cap < the
	// connection count, the global oldest-attempt query rotates across them.
	const select = {
		id: true,
		instanceId: true,
		arrItemId: true,
		title: true,
		data: true,
		cachedAt: true,
	} as const;
	const orderBy = [
		{ episodeFileInventoryAttemptedAt: "asc" as const },
		{ cachedAt: "asc" as const },
		{ id: "asc" as const },
	];
	const quota = availableClients.length > 0 ? Math.floor(seriesCap / availableClients.length) : 0;
	const selectedSeries = (
		quota > 0
			? await Promise.all(
					availableClients.map(({ sonarrInstance }) =>
						app.prisma.libraryCache.findMany({
							where: { instanceId: sonarrInstance.id, itemType: "series", hasFile: true },
							select,
							orderBy,
							take: quota,
						}),
					),
				)
			: []
	).flat();
	const remaining = Math.max(0, seriesCap - selectedSeries.length);
	if (remaining > 0 && availableClients.length > 0) {
		const selectedIds = selectedSeries.map((series) => series.id);
		selectedSeries.push(
			...(await app.prisma.libraryCache.findMany({
				where: {
					instanceId: { in: availableClients.map(({ sonarrInstance }) => sonarrInstance.id) },
					itemType: "series",
					hasFile: true,
					...(selectedIds.length > 0 ? { id: { notIn: selectedIds } } : {}),
				},
				select,
				orderBy,
				take: remaining,
			})),
		);
	}

	for (const { sonarrInstance, client } of availableClients) {
		const seriesRows = selectedSeries.filter((series) => series.instanceId === sonarrInstance.id);

		for (const series of seriesRows) {
			result.seriesScanned++;
			const attemptToken = randomUUID();
			// Revoke the previous complete-list receipt before touching any file
			// rows. A crash, malformed provider row, or partial write then leaves
			// only positive lower-bound evidence, never a false exact list.
			try {
				const invalidated = await app.prisma.libraryCache.updateMany({
					where: {
						id: series.id,
						instanceId: sonarrInstance.id,
						itemType: "series",
						cachedAt: series.cachedAt,
					},
					data: {
						episodeFileInventoryReceipt: null,
						episodeFileInventoryAttemptedAt: new Date(),
						episodeFileInventoryAttemptToken: attemptToken,
					},
				});
				if (invalidated.count !== 1) {
					result.errors++;
					continue;
				}
			} catch (err) {
				result.errors++;
				log?.warn(
					{ err: getErrorMessage(err), sonarrInstanceId: sonarrInstance.id },
					"episode-file-sync: failed to invalidate series coverage receipt",
				);
				continue;
			}

			// Mirror the SDK's optional-everything + nullable-name shape so
			// the assignment from `episodeFile.getAll(...)` type-checks
			// directly. We narrow the fields we actually persist at the
			// `if (typeof ... === ...)` guard below.
			let episodeFiles: Array<{
				id?: number;
				seriesId?: number;
				seasonNumber?: number;
				relativePath?: string | null;
				path?: string | null;
				size?: number;
				quality?: { quality?: { name?: string | null } } | null;
				releaseGroup?: string | null;
			}>;
			let stableReceipt: string;
			try {
				// arr-sdk's property is `client.episodeFile` (camelCase, single F).
				// We narrow from the union ArrClient to SonarrClient via the
				// `service === "SONARR"` filter on the outer findMany, but
				// TypeScript's discriminated-union narrowing doesn't carry
				// through `app.arrClientFactory.create(...)` (the factory
				// returns `ArrClient` regardless of service). Asserting
				// `SonarrClient` is the precise, type-checked cast — much
				// safer than the `any` we had before, which silently masked
				// the property-name typo `episodefile` vs `episodeFile`.
				const sonarrClient = client as import("arr-sdk").SonarrClient;
				const firstSeries = await sonarrClient.series.getById(series.arrItemId);
				const firstFiles =
					(await sonarrClient.episodeFile.getAll({ seriesId: series.arrItemId })) ?? [];
				const secondSeries = await sonarrClient.series.getById(series.arrItemId);
				const secondFiles =
					(await sonarrClient.episodeFile.getAll({ seriesId: series.arrItemId })) ?? [];
				const cachedEvidence = cachedSonarrSeriesFileEvidence(series.data);
				const firstEvidence = currentSonarrSeriesFileEvidence(firstSeries, series.arrItemId);
				const secondEvidence = currentSonarrSeriesFileEvidence(secondSeries, series.arrItemId);
				const firstIdentities = episodeFileIdentitiesFromSonarr(firstFiles, series.arrItemId);
				const secondIdentities = episodeFileIdentitiesFromSonarr(secondFiles, series.arrItemId);
				const firstReceipt =
					firstIdentities && firstEvidence
						? createEpisodeFileInventoryReceipt(series.cachedAt, firstIdentities, firstEvidence)
						: null;
				const secondReceipt =
					secondIdentities && secondEvidence
						? createEpisodeFileInventoryReceipt(series.cachedAt, secondIdentities, secondEvidence)
						: null;
				if (
					!cachedEvidence ||
					!firstEvidence ||
					!secondEvidence ||
					firstEvidence.episodeWithFileCount !== cachedEvidence.episodeWithFileCount ||
					secondEvidence.episodeWithFileCount !== cachedEvidence.episodeWithFileCount ||
					firstEvidence.sizeOnDisk !== cachedEvidence.sizeOnDisk ||
					secondEvidence.sizeOnDisk !== cachedEvidence.sizeOnDisk ||
					!firstReceipt ||
					firstReceipt !== secondReceipt ||
					!secondIdentities
				) {
					result.errors++;
					log?.warn(
						{
							cachedEpisodeCount: cachedEvidence?.episodeWithFileCount,
							firstEpisodeCount: firstEvidence?.episodeWithFileCount,
							secondEpisodeCount: secondEvidence?.episodeWithFileCount,
							firstFileCount: firstFiles.length,
							secondFileCount: secondFiles.length,
							cachedSizeMatchesLive:
								!!cachedEvidence &&
								!!firstEvidence &&
								!!secondEvidence &&
								cachedEvidence.sizeOnDisk === firstEvidence.sizeOnDisk &&
								cachedEvidence.sizeOnDisk === secondEvidence.sizeOnDisk,
							fileSizeMatchesLive: !!firstReceipt && !!secondReceipt,
						},
						"episode-file-sync: live series and file-list evidence did not settle",
					);
					continue;
				}
				episodeFiles = secondFiles;
				stableReceipt = secondReceipt;
			} catch (err) {
				result.errors++;
				log?.warn(
					{
						err: getErrorMessage(err),
						sonarrInstanceId: sonarrInstance.id,
						seriesId: series.arrItemId,
						title: series.title,
					},
					"episode-file-sync: failed to fetch episode files for series; skipping",
				);
				continue;
			}
			// The provider shape was checked by episodeFileIdentitiesFromSonarr.
			// Claim this exact attempt before writing any rows; all writes and
			// receipt publication must commit or roll back together.
			try {
				const counts = await app.prisma.$transaction(
					async (tx) => {
						const claimed = await tx.libraryCache.updateMany({
							where: {
								id: series.id,
								instanceId: sonarrInstance.id,
								itemType: "series",
								cachedAt: series.cachedAt,
								episodeFileInventoryReceipt: null,
								episodeFileInventoryAttemptToken: attemptToken,
							},
							data: {
								episodeFileInventoryReceipt: stableReceipt,
								episodeFileInventoryAttemptToken: null,
							},
						});
						if (claimed.count !== 1) throw new Error("series attempt was superseded");
						const existingRows = await tx.episodeFileCache.findMany({
							where: { instanceId: sonarrInstance.id, arrSeriesId: series.arrItemId },
							select: { arrEpisodeFileId: true, path: true, size: true },
						});
						const existingById = new Map(existingRows.map((row) => [row.arrEpisodeFileId, row]));
						const seenFileIds: number[] = [];
						for (const ef of episodeFiles) {
							if (
								typeof ef.id !== "number" ||
								typeof ef.seasonNumber !== "number" ||
								typeof ef.size !== "number" ||
								!ef.path ||
								!ef.relativePath
							) {
								throw new Error("validated provider file lost required fields");
							}
							seenFileIds.push(ef.id);
							const previous = existingById.get(ef.id);
							const fileChanged =
								previous !== undefined &&
								(previous.path !== ef.path || previous.size !== BigInt(ef.size));
							await tx.episodeFileCache.upsert({
								where: {
									instanceId_arrEpisodeFileId: {
										instanceId: sonarrInstance.id,
										arrEpisodeFileId: ef.id,
									},
								},
								update: {
									arrSeriesId: series.arrItemId,
									seasonNumber: ef.seasonNumber,
									relativePath: ef.relativePath,
									path: ef.path,
									size: BigInt(ef.size),
									qualityName: ef.quality?.quality?.name ?? null,
									releaseGroup: ef.releaseGroup ?? null,
									...(fileChanged
										? {
												infoHash: null,
												infoHashSource: null,
												inodeBackfillRetryAfter: null,
												torrentState: null,
												torrentRatio: null,
												torrentSyncedAt: null,
											}
										: {}),
								},
								create: {
									instanceId: sonarrInstance.id,
									arrEpisodeFileId: ef.id,
									arrSeriesId: series.arrItemId,
									seasonNumber: ef.seasonNumber,
									relativePath: ef.relativePath,
									path: ef.path,
									size: BigInt(ef.size),
									qualityName: ef.quality?.quality?.name ?? null,
									releaseGroup: ef.releaseGroup ?? null,
								},
							});
						}

						// Reap rows whose EpisodeFile id no longer appears in Sonarr's
						// latest response. This catches the upgrade-replaces-old-file
						// case (Sonarr swaps file id 123 for file id 456 on a quality
						// upgrade; row 123 must go) and manual deletions.
						//
						// Two correctness traps the naive `notIn` approach hits:
						//   1. SQLite (via Prisma) has a parameter-count limit on
						//      `IN/NOT IN` clauses. A series with thousands of
						//      episodes (long-running soaps, kids' content) overflows
						//      it. We saw this crash live on the first production run.
						//   2. A single failed delete was bringing down the whole
						//      sync — error propagated out, no try/catch, sync aborted
						//      partway with no resumption signal.
						//
						// Re-read deletion targets after a source-snapshot CAS, then delete
						// and publish the receipt in one transaction. If another worker has
						// refreshed this series or any row write fails, neither the delete
						// nor the exactness claim commits.
						const seenSet = new Set(seenFileIds);
						const currentRows = await tx.episodeFileCache.findMany({
							where: { instanceId: sonarrInstance.id, arrSeriesId: series.arrItemId },
							select: { arrEpisodeFileId: true, path: true, size: true },
						});
						const staleIds = currentRows
							.map((row) => row.arrEpisodeFileId)
							.filter((id) => !seenSet.has(id));
						let deleted = 0;
						// Chunk to stay below even older SQLite parameter caps.
						const CHUNK = 500;
						for (let i = 0; i < staleIds.length; i += CHUNK) {
							const batch = staleIds.slice(i, i + CHUNK);
							const result = await tx.episodeFileCache.deleteMany({
								where: {
									instanceId: sonarrInstance.id,
									arrSeriesId: series.arrItemId,
									arrEpisodeFileId: { in: batch },
								},
							});
							if (result.count !== batch.length)
								throw new Error("series stale-row delete was incomplete");
							deleted += result.count;
						}
						const retainedRows = await tx.episodeFileCache.findMany({
							where: { instanceId: sonarrInstance.id, arrSeriesId: series.arrItemId },
							select: { arrEpisodeFileId: true, path: true, size: true },
						});
						if (!hasCompleteEpisodeFileInventory(stableReceipt, series.cachedAt, retainedRows)) {
							throw new Error("series file rows do not match verified provider receipt");
						}
						return { upserted: episodeFiles.length, deleted };
					},
					{ timeout: 30_000 },
				);
				result.filesUpserted += counts.upserted;
				result.filesDeleted += counts.deleted;
			} catch (err) {
				result.errors++;
				log?.warn(
					{ err: getErrorMessage(err), sonarrInstanceId: sonarrInstance.id },
					"episode-file-sync: series receipt transaction failed",
				);
			}
		}
	}

	result.usersScanned = seenUserIds.size;
	result.durationMs = Date.now() - startedAt;
	log?.info(
		{
			usersScanned: result.usersScanned,
			seriesScanned: result.seriesScanned,
			filesUpserted: result.filesUpserted,
			filesDeleted: result.filesDeleted,
			errors: result.errors,
			durationMs: result.durationMs,
		},
		"episode-file sync completed",
	);
	return result;
}

export interface EpisodeBackfillSweepResult {
	usersScanned: number;
	rowsScanned: number;
	rowsHashed: number;
	rowsMissed: number;
	errors: number;
	durationMs: number;
}

export interface EpisodeBackfillSweepArgs {
	app: FastifyInstance;
	log?: FastifyBaseLogger;
	batchSize: number;
	/** Periodic recovery considers only previously deferred rows, not new backlog. */
	dueOnly?: boolean;
}

/**
 * Run one episode-file inode-correlation sweep.
 *
 * Mirrors `runPathBackfillSweep` for movies, but:
 *   - Iterates `EpisodeFileCache` rows with `infoHash IS NULL` instead
 *     of `LibraryCache` movie rows.
 *   - Inode-only (no heuristic fallback). Episode files don't have the
 *     same title-year metadata structure that powers the movie
 *     heuristics; running them on episodes would produce too many false
 *     positives. FS-disabled qui instances therefore can't correlate
 *     episodes — that's a documented v1 constraint.
 *   - Per-user, partitions qui instances by `hasLocalFilesystemAccess`,
 *     skips FS-disabled instances entirely for this sweep.
 */
export async function runEpisodeBackfillSweep({
	app,
	log,
	batchSize,
	dueOnly = false,
}: EpisodeBackfillSweepArgs): Promise<EpisodeBackfillSweepResult> {
	const startedAt = Date.now();
	const result: EpisodeBackfillSweepResult = {
		usersScanned: 0,
		rowsScanned: 0,
		rowsHashed: 0,
		rowsMissed: 0,
		errors: 0,
		durationMs: 0,
	};

	const usersWithQui = await app.prisma.serviceInstance.findMany({
		where: { service: "QUI", enabled: true },
		select: { userId: true },
		distinct: ["userId"],
	});
	if (usersWithQui.length === 0) {
		result.durationMs = Date.now() - startedAt;
		return result;
	}

	for (const { userId } of usersWithQui) {
		if (result.rowsScanned >= batchSize) break;
		result.usersScanned++;

		// Only FS-enabled qui instances participate. FS-disabled
		// instances would need a heuristic ladder we haven't built for
		// episodes — see module-level doc.
		const quiInstances = await app.prisma.serviceInstance.findMany({
			where: { service: "QUI", userId, enabled: true },
		});
		const topologyGeneration = captureQuiTopologyGeneration(quiInstances);
		const fsEnabledInstances = quiInstances.filter((instance) => instance.hasLocalFilesystemAccess);
		if (fsEnabledInstances.length === 0) continue;

		const inodeIndices: Array<{
			instanceId: string;
			index: Awaited<ReturnType<typeof buildFileIdIndex>>;
		}> = [];
		for (const qi of fsEnabledInstances) {
			try {
				const client = createQuiClient(app, qi);
				const index = await buildFileIdIndex(client, qi, log, app.prisma);
				inodeIndices.push({ instanceId: qi.id, index });
			} catch (err) {
				result.errors++;
				log?.warn(
					{ err: getErrorMessage(err), userId, quiInstanceId: qi.id },
					"episode-backfill: failed to build inode index; skipping",
				);
			}
		}
		if (inodeIndices.length === 0) continue;

		const remaining = batchSize - result.rowsScanned;
		const now = new Date();
		const rows = await app.prisma.episodeFileCache.findMany({
			where: {
				infoHash: null,
				instance: { userId, service: "SONARR" },
				...(dueOnly
					? { inodeBackfillRetryAfter: { lte: now } }
					: { OR: [{ inodeBackfillRetryAfter: null }, { inodeBackfillRetryAfter: { lte: now } }] }),
			},
			orderBy: [{ inodeBackfillRetryAfter: "asc" }, { cachedAt: "asc" }],
			take: remaining,
			select: { id: true, path: true, size: true, arrSeriesId: true, relativePath: true },
		});

		for (const row of rows) {
			result.rowsScanned++;
			let match: Awaited<ReturnType<typeof matchLibraryByFileId>> = null;
			for (const { index } of inodeIndices) {
				const hit = await matchLibraryByFileId(row.path, index);
				if (hit) {
					match = hit;
					break;
				}
			}
			if (!match) {
				result.rowsMissed++;
				try {
					await withQuiObservationTopologyGuard(userId, async () => {
						await assertQuiTopologyGenerationCurrent(app.prisma, userId, topologyGeneration);
						await app.prisma.episodeFileCache.updateMany({
							where: {
								id: row.id,
								path: row.path,
								size: row.size,
								infoHash: null,
								instance: { userId, service: "SONARR" },
							},
							data: { inodeBackfillRetryAfter: new Date(Date.now() + BACKFILL_MISS_RETRY_MS) },
						});
					});
				} catch (err) {
					result.errors++;
					log?.warn(
						{ err: getErrorMessage(err), userId, cacheRowId: row.id },
						"episode-backfill: failed to defer unmatched row",
					);
				}
				continue;
			}
			try {
				const persisted = await withQuiObservationTopologyGuard(userId, async () => {
					await assertQuiTopologyGenerationCurrent(app.prisma, userId, topologyGeneration);
					return app.prisma.episodeFileCache.updateMany({
						where: {
							id: row.id,
							path: row.path,
							size: row.size,
							infoHash: null,
							instance: { userId, service: "SONARR" },
						},
						data: {
							infoHash: match.hash,
							infoHashSource: CURRENT_INODE_SOURCE,
							inodeBackfillRetryAfter: null,
							torrentState: null,
							torrentRatio: null,
							torrentSyncedAt: null,
						},
					});
				});
				if (persisted.count === 1) result.rowsHashed++;
				else result.rowsMissed++;
			} catch (err) {
				result.errors++;
				log?.warn(
					{ err: getErrorMessage(err), cacheRowId: row.id },
					"episode-backfill: persist failed",
				);
			}
		}
	}

	result.durationMs = Date.now() - startedAt;
	log?.info(
		{
			usersScanned: result.usersScanned,
			rowsScanned: result.rowsScanned,
			rowsHashed: result.rowsHashed,
			rowsMissed: result.rowsMissed,
			errors: result.errors,
			durationMs: result.durationMs,
		},
		"episode-file inode-backfill sweep completed",
	);
	return result;
}

// Re-export for the ArrClientFactory type to be reachable from any
// caller importing this module (the sync function takes
// `app.arrClientFactory` which is decorated by the plugin).
export type { ArrClientFactory, ServiceInstance };
