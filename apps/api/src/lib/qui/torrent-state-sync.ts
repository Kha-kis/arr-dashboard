import { type NormalizedTorrentState, normalizeTorrentState, type QuiTorrent } from "@arr/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { isRetryableSqlitePublicationStartRefusal } from "../backup/restore-runtime-client.js";
import { Prisma, type Prisma as PrismaTypes } from "../prisma.js";
import { logQuiActivity, type QuiSyncCompleteDetails } from "./activity-log.js";
import { createQuiClient } from "./client-factory.js";
import { listQuiInstances } from "./instance-helpers.js";
import { withQuiObservationTopologyGuard } from "./observation-topology-guard.js";
import {
	beginQuiObservationPublication,
	captureQuiObservationTopology,
	completeQuiObservationPublication,
	invalidateQuiObservationPublication,
	stageQuiTorrentObservations,
	pruneQuiObservationGenerations,
	withQuiObservationGenerationWrite,
} from "./torrent-observation-repository.js";
import {
	buildNotificationPayloads,
	classifyTransition,
	type ProblemTransition,
} from "./torrent-state-notifier.js";

const UPDATE_CHUNK_SIZE = 500;
// Three bound values are emitted for each staged observation (hash, state, and
// ratio in the VALUES relation), plus the user id. Keep the batch below
// SQLite's 999-variable limit while retaining one set-based statement per table.
const OBSERVATION_WRITE_CHUNK_SIZE = 300;
const SQLITE_WRITE_RETRY_DELAYS_MS = [100, 250, 500] as const;
const CLEAR_OBSERVATION_DATA = {
	torrentState: null,
	torrentRatio: null,
	torrentSyncedAt: null,
} as const;

/**
 * Conservative deterministic ordering for one durable state per infoHash.
 *
 * Any state that execution treats as active, transitional, or unknown outranks
 * paused/error. The exact order among protected states is only for stable
 * persistence and notifications; every one of them remains non-reassuring.
 */
const AGGREGATE_STATE_PRIORITY: Record<NormalizedTorrentState, number> = {
	seeding: 90,
	downloading: 80,
	stalled_dl: 70,
	queued: 60,
	checking: 50,
	moving: 40,
	unknown: 30,
	error: 20,
	paused: 10,
};

interface CompleteQuiInventory {
	instanceId: string;
	instanceLabel: string;
	torrents: QuiTorrent[];
}

interface AggregatedTorrentObservation {
	state: NormalizedTorrentState;
	/** Independent Queue Cleaner policy; deliberately NOT the display winner. */
	queueState: NormalizedTorrentState;
	ratio: number | null;
	instanceLabel: string;
}

type ObservationWriteClient = Pick<PrismaTypes.TransactionClient, "$executeRaw">;

function isSqliteBusyWriteError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	try {
		const candidate = error as {
			code?: unknown;
			meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; kind?: unknown } } };
		};
		const cause = candidate.meta?.driverAdapterError?.cause;
		return (
			(candidate.code === "P1008" || candidate.code === "P2010") &&
			cause?.originalCode === "SQLITE_BUSY" &&
			cause.kind === "SocketTimeout"
		);
	} catch {
		return false;
	}
}

/** Retry only a local, absolute write; never replay provider reads or notifications. */
async function withSqliteWriteRetry<T>(
	dbProvider: FastifyInstance["dbProvider"],
	operation: () => Promise<T>,
): Promise<T> {
	for (let retry = 0; ; retry++) {
		try {
			return await operation();
		} catch (error) {
			const delay = SQLITE_WRITE_RETRY_DELAYS_MS[retry];
			if (
				dbProvider !== "sqlite" ||
				delay === undefined ||
				(!isSqliteBusyWriteError(error) && !isRetryableSqlitePublicationStartRefusal(error))
			) {
				throw error;
			}
			// Yield before reacquiring native runtime fences and the database lock.
			await new Promise<void>((resolve) => setTimeout(resolve, delay));
		}
	}
}

async function yieldToEventLoop(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function stageQuiObservationChunk(
	prisma: ObservationWriteClient,
	tableName: "library_cache" | "episode_file_cache",
	userId: string,
	observations: ReadonlyArray<[string, AggregatedTorrentObservation]>,
): Promise<number> {
	if (observations.length === 0) return 0;

	const stagedRows = Prisma.join(
		observations.map(
			([hash, observation]) =>
				Prisma.sql`(${hash}, ${observation.state}, CAST(${observation.ratio} AS DOUBLE PRECISION))`,
		),
		", ",
	);

	return await prisma.$executeRaw(Prisma.sql`
		WITH staged("hash", "state", "ratio") AS (VALUES ${stagedRows})
		UPDATE ${Prisma.raw(`"${tableName}"`)} AS cache
		SET "torrentState" = (
				SELECT staged."state" FROM staged WHERE staged."hash" = LOWER(cache."infoHash")
			),
			"torrentRatio" = (
				SELECT staged."ratio" FROM staged WHERE staged."hash" = LOWER(cache."infoHash")
			),
			"torrentSyncedAt" = NULL
		WHERE cache."instanceId" IN (
			SELECT "id" FROM "ServiceInstance" WHERE "userId" = ${userId}
		)
		AND LOWER(cache."infoHash") IN (SELECT staged."hash" FROM staged)
	`);
}

async function stageQuiObservations(
	prisma: FastifyInstance["prisma"],
	userId: string,
	generation: string,
	aggregate: ReadonlyMap<string, AggregatedTorrentObservation>,
	dbProvider: "sqlite" | "postgresql",
): Promise<number> {
	const observations = [...aggregate.entries()];
	let rowsUpdated = 0;
	let hasPreviousChunk = false;
	for (const tableName of ["library_cache", "episode_file_cache"] as const) {
		for (let offset = 0; offset < observations.length; offset += OBSERVATION_WRITE_CHUNK_SIZE) {
			if (hasPreviousChunk && dbProvider === "sqlite") {
				await yieldToEventLoop();
			}
			rowsUpdated += await withSqliteWriteRetry(dbProvider, () =>
				withQuiObservationGenerationWrite(prisma, userId, generation, (tx) =>
					stageQuiObservationChunk(
						tx,
						tableName,
						userId,
						observations.slice(offset, offset + OBSERVATION_WRITE_CHUNK_SIZE),
					),
				),
			);
			hasPreviousChunk = true;
		}
	}
	return rowsUpdated;
}

function aggregateCompleteInventories(
	inventories: CompleteQuiInventory[],
): Map<string, AggregatedTorrentObservation> {
	const observations = new Map<
		string,
		Array<{
			state: NormalizedTorrentState;
			ratio: number | null;
			instanceLabel: string;
			sourceKey: string;
		}>
	>();

	for (const inventory of inventories) {
		for (const torrent of inventory.torrents) {
			const hash = torrent.hash.toLowerCase();
			if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)) {
				throw new Error("qUI inventory contained an invalid infoHash");
			}
			const state = normalizeTorrentState(torrent.state);
			const current = observations.get(hash) ?? [];
			current.push({
				state,
				ratio: Number.isFinite(torrent.ratio) ? torrent.ratio : null,
				instanceLabel: inventory.instanceLabel,
				sourceKey: `${inventory.instanceId}\0${torrent.instanceId ?? 0}\0${state}`,
			});
			observations.set(hash, current);
		}
	}

	const aggregate = new Map<string, AggregatedTorrentObservation>();
	for (const [hash, candidates] of [...observations.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		candidates.sort(
			(left, right) =>
				AGGREGATE_STATE_PRIORITY[right.state] - AGGREGATE_STATE_PRIORITY[left.state] ||
				left.sourceKey.localeCompare(right.sourceKey),
		);
		const selected = candidates[0]!;
		aggregate.set(hash, {
			state: selected.state,
			// Display/Library-cleanup ranking stays unchanged. Queue Cleaner must
			// retain every source veto before the per-copy information is lost.
			queueState: candidates.some((row) => row.state === "unknown")
				? "unknown"
				: candidates.some((row) => row.state === "error")
					? "error"
					: candidates.some((row) => row.state === "paused")
						? "paused"
						: selected.state,
			// Cross-seeds and duplicate qUI views can have different ratios. A
			// single scalar would imply false precision, so only retain it when
			// exactly one torrent contributed to this hash.
			ratio: candidates.length === 1 ? selected.ratio : null,
			instanceLabel: selected.instanceLabel,
		});
	}
	return aggregate;
}

async function clearUserQuiObservations(
	app: FastifyInstance,
	userId: string,
	expectedGeneration: string | null,
): Promise<number> {
	const generation = await withSqliteWriteRetry(app.dbProvider, () =>
		invalidateQuiObservationPublication(app.prisma, userId, expectedGeneration),
	);
	if (!generation) return 0; // A newer attempt owns both authority and projections.
	return await withSqliteWriteRetry(app.dbProvider, () =>
		withQuiObservationGenerationWrite(app.prisma, userId, generation, async (tx) => {
			const where = { instance: { userId } };
			const libraryRows = await tx.libraryCache.updateMany({
				where,
				data: CLEAR_OBSERVATION_DATA,
			});
			const episodeRows = await tx.episodeFileCache.updateMany({
				where,
				data: CLEAR_OBSERVATION_DATA,
			});
			return libraryRows.count + episodeRows.count;
		}),
	);
}

async function clearUserQuiFreshness(
	app: FastifyInstance,
	userId: string,
	generation: string,
): Promise<void> {
	await withSqliteWriteRetry(app.dbProvider, () =>
		withQuiObservationGenerationWrite(app.prisma, userId, generation, async (tx) => {
			const where = { instance: { userId } };
			await tx.libraryCache.updateMany({
				where,
				data: { torrentSyncedAt: null },
			});
			await tx.episodeFileCache.updateMany({
				where,
				data: { torrentSyncedAt: null },
			});
		}),
	);
}

async function publishUserQuiFreshness(
	app: FastifyInstance,
	userId: string,
	generation: string,
	topologyDigest: string,
	rowCount: number,
	observedAt: Date,
): Promise<void> {
	await withSqliteWriteRetry(app.dbProvider, () =>
		completeQuiObservationPublication(
			app.prisma,
			userId,
			generation,
			topologyDigest,
			rowCount,
			observedAt,
			async (tx) => {
				const where = { instance: { userId }, infoHash: { not: null } };
				await tx.libraryCache.updateMany({
					where,
					data: { torrentSyncedAt: observedAt },
				});
				await tx.episodeFileCache.updateMany({
					where,
					data: { torrentSyncedAt: observedAt },
				});
			},
		),
	);
}

async function persistCompleteAbsence(
	prisma: FastifyInstance["prisma"],
	userId: string,
	generation: string,
	seenHashes: ReadonlySet<string>,
	dbProvider: "sqlite" | "postgresql",
): Promise<number> {
	const [libraryCandidates, episodeCandidates] = await Promise.all([
		prisma.libraryCache.findMany({
			where: { instance: { userId }, infoHash: { not: null } },
			select: { id: true, infoHash: true },
		}),
		prisma.episodeFileCache.findMany({
			where: { instance: { userId }, infoHash: { not: null } },
			select: { id: true, infoHash: true },
		}),
	]);
	const libraryIds = libraryCandidates
		.filter((row) => row.infoHash && !seenHashes.has(row.infoHash.toLowerCase()))
		.map((row) => row.id);
	const episodeIds = episodeCandidates
		.filter((row) => row.infoHash && !seenHashes.has(row.infoHash.toLowerCase()))
		.map((row) => row.id);

	let rowsCleared = 0;
	let hasPreviousChunk = false;
	for (let offset = 0; offset < libraryIds.length; offset += UPDATE_CHUNK_SIZE) {
		if (hasPreviousChunk && dbProvider === "sqlite") {
			await yieldToEventLoop();
		}
		const updated = await withSqliteWriteRetry(dbProvider, () =>
			withQuiObservationGenerationWrite(prisma, userId, generation, (tx) =>
				tx.libraryCache.updateMany({
					where: {
						id: { in: libraryIds.slice(offset, offset + UPDATE_CHUNK_SIZE) },
						instance: { userId },
					},
					data: {
						torrentState: null,
						torrentRatio: null,
						torrentSyncedAt: null,
					},
				}),
			),
		);
		rowsCleared += updated.count;
		hasPreviousChunk = true;
	}
	for (let offset = 0; offset < episodeIds.length; offset += UPDATE_CHUNK_SIZE) {
		if (hasPreviousChunk && dbProvider === "sqlite") {
			await yieldToEventLoop();
		}
		const updated = await withSqliteWriteRetry(dbProvider, () =>
			withQuiObservationGenerationWrite(prisma, userId, generation, (tx) =>
				tx.episodeFileCache.updateMany({
					where: {
						id: { in: episodeIds.slice(offset, offset + UPDATE_CHUNK_SIZE) },
						instance: { userId },
					},
					data: {
						torrentState: null,
						torrentRatio: null,
						torrentSyncedAt: null,
					},
				}),
			),
		);
		rowsCleared += updated.count;
		hasPreviousChunk = true;
	}
	return rowsCleared;
}

/**
 * Periodic complete snapshot of qUI torrent state into LibraryCache.
 *
 * No qUI-derived observation is published until every enabled qUI instance
 * returned a complete inventory. A partial or failed topology is invalidated
 * user-wide under the same writer/topology guard, so preview can never present
 * a fresh reassuring value from only part of the configured qUI topology.
 */
export interface TorrentStateSyncResult {
	usersScanned: number;
	instancesScanned: number;
	torrentsSeen: number;
	rowsUpdated: number;
	/**
	 * Rows published as a fresh complete absence or invalidated because the
	 * configured qUI topology could not be observed completely.
	 */
	rowsCleared: number;
	errors: number;
	durationMs: number;
}

export async function runQuiTorrentStateSync(
	app: FastifyInstance,
	log: FastifyBaseLogger = app.log,
): Promise<TorrentStateSyncResult> {
	const startedAt = Date.now();
	const result: TorrentStateSyncResult = {
		usersScanned: 0,
		instancesScanned: 0,
		torrentsSeen: 0,
		rowsUpdated: 0,
		rowsCleared: 0,
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
		result.usersScanned++;
		await withQuiObservationTopologyGuard(userId, async () => {
			const userStartedAt = Date.now();
			// Capture before any provider read; a slow scan cannot renew its age.
			const observedAt = new Date();
			const topology = await captureQuiObservationTopology(app.prisma, userId);
			let publicationGeneration =
				(await app.prisma.quiObservationPublication.findUnique({ where: { userId } }))
					?.generation ?? null;
			let userInstancesScanned = 0;
			let userTorrentsSeen = 0;
			let userRowsUpdated = 0;
			let userRowsCleared = 0;
			let userErrors = 0;
			const instances = [...(await listQuiInstances(app, userId))].sort((left, right) =>
				left.id.localeCompare(right.id),
			);
			const inventories: CompleteQuiInventory[] = [];

			// Phase 1: fetch every participating inventory before any durable qUI
			// observation write. Continue after individual failures so the activity
			// record accurately reflects every configured instance attempted.
			for (const instance of instances) {
				result.instancesScanned++;
				userInstancesScanned++;
				try {
					const client = createQuiClient(app, instance);
					const inventory =
						typeof client.listTorrentInventory === "function"
							? await client.listTorrentInventory()
							: {
									torrents: await client.listAllTorrents({ requireComplete: true }),
									complete: true,
								};
					result.torrentsSeen += inventory.torrents.length;
					userTorrentsSeen += inventory.torrents.length;
					if (inventory.complete !== true) {
						throw new Error("qUI inventory was incomplete");
					}
					inventories.push({
						instanceId: instance.id,
						instanceLabel: instance.label,
						torrents: inventory.torrents,
					});
				} catch (error) {
					userErrors++;
					result.errors++;
					log.warn(
						{ err: error, userId, instanceId: instance.id, instanceLabel: instance.label },
						"qUI torrent-state sync failed to prove a complete instance inventory",
					);
				}
			}

			if (instances.length === 0 || inventories.length !== instances.length) {
				try {
					const cleared = await clearUserQuiObservations(app, userId, publicationGeneration);
					result.rowsCleared += cleared;
					userRowsCleared += cleared;
				} catch (error) {
					userErrors++;
					result.errors++;
					log.error(
						{ err: error, userId },
						"qUI torrent-state sync could not invalidate observations after an incomplete topology scan",
					);
				}
			} else {
				let aggregate = new Map<string, AggregatedTorrentObservation>();
				const priorStates = new Map<string, { state: string | null; title: string }>();
				try {
					const priorRows = await app.prisma.libraryCache.findMany({
						where: { instance: { userId }, infoHash: { not: null } },
						select: { infoHash: true, torrentState: true, title: true },
					});
					for (const row of priorRows) {
						if (row.infoHash) {
							priorStates.set(row.infoHash.toLowerCase(), {
								state: row.torrentState,
								title: row.title,
							});
						}
					}
				} catch (error) {
					log.warn(
						{ err: error, userId },
						"qUI torrent-state sync: prior-state snapshot failed; notifications skipped this run",
					);
				}

				const transitions: ProblemTransition[] = [];
				let publishedRowsUpdated = 0;
				let publishedRowsCleared = 0;
				try {
					aggregate = aggregateCompleteInventories(inventories);
					publicationGeneration = await withSqliteWriteRetry(app.dbProvider, () =>
						beginQuiObservationPublication(
							app.prisma,
							userId,
							topology.digest,
							aggregate.size,
							publicationGeneration,
						),
					);
					// Every bounded write checks the same generation fence; independent
					// authority remains unavailable until all rows and projections are
					// ready. Publish the complete marker last in a short transaction.
					await pruneQuiObservationGenerations(
						app.prisma,
						userId,
						publicationGeneration,
						(operation) => withSqliteWriteRetry(app.dbProvider, operation),
					);
					await clearUserQuiFreshness(app, userId, publicationGeneration);
					await stageQuiTorrentObservations(
						app.prisma,
						userId,
						publicationGeneration,
						[...aggregate].map(([infoHash, row]) => ({
							infoHash,
							state: row.queueState,
							ratio: row.ratio,
						})),
						async (operation) => {
							// Completed batches must let pending reads run before the next
							// transaction reacquires its independently checked generation fence.
							if (app.dbProvider === "sqlite") await yieldToEventLoop();
							return withSqliteWriteRetry(app.dbProvider, operation);
						},
					);
					// Stage each cache table with bounded CASE updates. This avoids one
					// synchronous better-sqlite3 statement per hash while keeping the
					// state and ratio paired with their normalized hash.
					publishedRowsUpdated = await stageQuiObservations(
						app.prisma,
						userId,
						publicationGeneration,
						aggregate,
						app.dbProvider,
					);
					publishedRowsCleared = await persistCompleteAbsence(
						app.prisma,
						userId,
						publicationGeneration,
						new Set(aggregate.keys()),
						app.dbProvider,
					);
					await publishUserQuiFreshness(
						app,
						userId,
						publicationGeneration,
						topology.digest,
						aggregate.size,
						observedAt,
					);
					for (const [hash, observation] of aggregate) {
						const prior = priorStates.get(hash);
						if (prior) {
							const kind = classifyTransition(prior.state, observation.state);
							if (kind) {
								transitions.push({
									kind,
									infoHash: hash,
									title: prior.title,
									instanceLabel: observation.instanceLabel,
									oldState: prior.state,
									newState: observation.state,
								});
							}
						}
					}
					result.rowsUpdated += publishedRowsUpdated;
					userRowsUpdated += publishedRowsUpdated;
					result.rowsCleared += publishedRowsCleared;
					userRowsCleared += publishedRowsCleared;
				} catch (error) {
					userErrors++;
					result.errors++;
					log.error(
						{ err: error, userId },
						"qUI torrent-state sync publish failed; invalidating partial observations",
					);
					try {
						const cleared = await clearUserQuiObservations(app, userId, publicationGeneration);
						result.rowsCleared += cleared;
						userRowsCleared += cleared;
					} catch (clearError) {
						userErrors++;
						result.errors++;
						log.error(
							{ err: clearError, userId },
							"qUI torrent-state sync could not invalidate a partial publish",
						);
					}
				}

				if (userErrors === 0 && transitions.length > 0 && app.notificationService) {
					const payloads = buildNotificationPayloads(transitions);
					await Promise.all(
						payloads.map((payload) =>
							app.notificationService.notify(payload, { userId }).catch((error) => {
								log.warn(
									{ err: error, userId, eventType: payload.eventType },
									"qUI torrent-state notification dispatch failed",
								);
							}),
						),
					);
					log.info(
						{ userId, transitions: transitions.length, payloads: payloads.length },
						"qUI torrent-state sync emitted torrent-state notifications",
					);
				}
			}

			const userDetails: QuiSyncCompleteDetails = {
				instancesScanned: userInstancesScanned,
				torrentsSeen: userTorrentsSeen,
				rowsUpdated: userRowsUpdated,
				rowsCleared: userRowsCleared,
				errors: userErrors,
				durationMs: Date.now() - userStartedAt,
			};
			await logQuiActivity({
				app,
				userId,
				eventType: "qui_sync_complete",
				details: userDetails,
				status: userErrors > 0 ? "error" : "ok",
				log,
			});
		});
	}

	result.durationMs = Date.now() - startedAt;
	log.info(
		{
			usersScanned: result.usersScanned,
			instancesScanned: result.instancesScanned,
			torrentsSeen: result.torrentsSeen,
			rowsUpdated: result.rowsUpdated,
			rowsCleared: result.rowsCleared,
			errors: result.errors,
			durationMs: result.durationMs,
		},
		"qUI torrent-state sync completed",
	);
	return result;
}
