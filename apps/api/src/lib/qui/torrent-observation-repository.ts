import { createHash, randomUUID } from "node:crypto";
import { withIsolatedRuntimePrismaTransaction } from "../backup/restore-runtime-client.js";
import type { Prisma, PrismaClient } from "../prisma.js";
import { withSqliteTransactionWriteIntent } from "../sqlite-transaction-intent.js";

const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const STATES = new Set([
	"seeding",
	"downloading",
	"stalled_dl",
	"queued",
	"checking",
	"moving",
	"unknown",
	"error",
	"paused",
]);
const FRESHNESS_MS = 30 * 60 * 1000;
const BATCH = 150; // Five values per row, below SQLite's 999 bind limit.
type WriteAttempt = <T>(operation: () => Promise<T>) => Promise<T>;
const once: WriteAttempt = (operation) => operation();
type Client = Pick<
	Prisma.TransactionClient,
	"serviceInstance" | "quiObservationPublication" | "quiTorrentObservation"
>;
export interface QuiObservation {
	infoHash: string;
	state: string;
	ratio: number | null;
}

/** Exactly the enabled owned connection inputs consumed by createQuiClient. */
export async function captureQuiObservationTopology(
	prisma: Pick<Client, "serviceInstance">,
	userId: string,
) {
	const sources = await prisma.serviceInstance.findMany({
		where: { userId, service: "QUI", enabled: true },
		orderBy: { id: "asc" },
		select: {
			id: true,
			userId: true,
			service: true,
			enabled: true,
			connectionGeneration: true,
			identityGeneration: true,
			baseUrl: true,
			encryptedApiKey: true,
			encryptionIv: true,
			encryptedHttpAuthCredentials: true,
			httpAuthEncryptionIv: true,
		},
	});
	return {
		digest: createHash("sha256").update(JSON.stringify(sources)).digest("hex"),
		sourceCount: sources.length,
	};
}

function refused(): never {
	throw new Error("qUI observation generation or source changed");
}
function valid(row: QuiObservation): boolean {
	return (
		HASH.test(row.infoHash) &&
		STATES.has(row.state) &&
		(row.ratio === null || Number.isFinite(row.ratio))
	);
}

/** Reserve before runtime guard reads; keep publication off the HTTP connection. */
function withQuiObservationWriteTransaction<T>(
	prisma: PrismaClient,
	operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
	return withSqliteTransactionWriteIntent(() =>
		withIsolatedRuntimePrismaTransaction(prisma, operation),
	);
}

/** The conditional write acquires the database fence, not just the JS guard. */
export async function withQuiObservationGenerationWrite<T>(
	prisma: PrismaClient,
	userId: string,
	generation: string,
	operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
	return withQuiObservationWriteTransaction(prisma, async (tx) => {
		const lock = await tx.quiObservationPublication.updateMany({
			where: { userId, generation, complete: false },
			data: { complete: false },
		});
		if (lock.count !== 1) refused();
		return operation(tx);
	});
}

/** Retry each rolled-back prune batch, never a previously committed head CAS. */
export async function pruneQuiObservationGenerations(
	prisma: PrismaClient,
	userId: string,
	generation: string,
	write: WriteAttempt = once,
) {
	for (;;) {
		const removed = await write(() =>
			withQuiObservationGenerationWrite(prisma, userId, generation, async (tx) => {
				const rows = await tx.quiTorrentObservation.findMany({
					where: { userId, generation: { not: generation } },
					select: { generation: true, infoHash: true },
					take: 150,
				});
				if (rows.length === 0) return 0;
				return (await tx.quiTorrentObservation.deleteMany({ where: { userId, OR: rows } })).count;
			}),
		);
		if (!removed) return;
	}
}

export async function beginQuiObservationPublication(
	prisma: PrismaClient,
	userId: string,
	topologyDigest: string,
	rowCount: number,
	expectedGeneration: string | null,
): Promise<string> {
	if (!Number.isSafeInteger(rowCount) || rowCount < 0) refused();
	const generation = randomUUID();
	await withQuiObservationWriteTransaction(prisma, async (tx) => {
		const topology = await captureQuiObservationTopology(tx, userId);
		if (topology.sourceCount === 0 || topology.digest !== topologyDigest) refused();
		const data = { generation, topologyDigest, rowCount, complete: false, observedAt: null };
		if (expectedGeneration === null) {
			if (await tx.quiObservationPublication.findUnique({ where: { userId } })) refused();
			await tx.quiObservationPublication.create({ data: { userId, ...data } });
		} else if (
			(
				await tx.quiObservationPublication.updateMany({
					where: { userId, generation: expectedGeneration },
					data,
				})
			).count !== 1
		)
			refused();
	});
	// Return ownership immediately after the committed CAS. The caller retains
	// this token through separately retryable pruning and failure invalidation.
	return generation;
}

export async function stageQuiTorrentObservations(
	prisma: PrismaClient,
	userId: string,
	generation: string,
	rows: readonly QuiObservation[],
	write: WriteAttempt = once,
): Promise<void> {
	const hashes = new Set<string>();
	for (const row of rows) {
		if (!valid(row) || hashes.has(row.infoHash))
			throw new Error("Invalid or duplicate qUI torrent observation");
		hashes.add(row.infoHash);
	}
	for (let offset = 0; offset < rows.length; offset += BATCH) {
		// Retry only this rolled-back batch, never already committed earlier batches.
		await write(() =>
			withQuiObservationGenerationWrite(prisma, userId, generation, async (tx) => {
				await tx.quiTorrentObservation.createMany({
					data: rows.slice(offset, offset + BATCH).map((row) => ({ userId, generation, ...row })),
				});
			}),
		);
	}
}

export async function completeQuiObservationPublication(
	prisma: PrismaClient,
	userId: string,
	generation: string,
	topologyDigest: string,
	rowCount: number,
	observedAt: Date,
	finalizeProjections?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
	if (!Number.isFinite(observedAt.getTime()) || observedAt.getTime() > Date.now()) refused();
	await withQuiObservationGenerationWrite(prisma, userId, generation, async (tx) => {
		const topology = await captureQuiObservationTopology(tx, userId),
			head = await tx.quiObservationPublication.findUnique({ where: { userId } });
		if (
			!topology.sourceCount ||
			topology.digest !== topologyDigest ||
			head?.topologyDigest !== topologyDigest ||
			head.rowCount !== rowCount ||
			(await tx.quiTorrentObservation.count({ where: { userId, generation } })) !== rowCount
		)
			refused();
		await finalizeProjections?.(tx);
		await tx.quiObservationPublication.update({
			where: { userId },
			data: { complete: true, observedAt },
		});
	});
}

/** Rotate even invalid markers: an old attempt must never survive an ABA edit. */
export async function invalidateQuiObservationTopology(
	tx: Pick<Client, "quiObservationPublication">,
	userId: string,
): Promise<void> {
	const invalid = { generation: randomUUID(), complete: false, observedAt: null, rowCount: 0 };
	await tx.quiObservationPublication.upsert({
		where: { userId },
		create: { userId, topologyDigest: "", ...invalid },
		update: invalid,
	});
}

/** Returns the new invalid token only if this attempt still owns the head. */
export async function invalidateQuiObservationPublication(
	prisma: PrismaClient,
	userId: string,
	expectedGeneration: string | null,
): Promise<string | null> {
	const generation = randomUUID();
	return withQuiObservationWriteTransaction(prisma, async (tx) => {
		if (expectedGeneration === null) {
			const existing = await tx.quiObservationPublication.findUnique({ where: { userId } });
			if (existing) return null;
			const topology = await captureQuiObservationTopology(tx, userId);
			await tx.quiObservationPublication.create({
				data: {
					userId,
					generation,
					topologyDigest: topology.digest,
					complete: false,
					observedAt: null,
					rowCount: 0,
				},
			});
			return generation;
		}
		return (
			await tx.quiObservationPublication.updateMany({
				where: { userId, generation: expectedGeneration },
				data: { generation, complete: false, observedAt: null, rowCount: 0 },
			})
		).count === 1
			? generation
			: null;
	});
}

export type QuiObservationRead =
	| { status: "not_configured" }
	| { status: "unavailable" }
	| {
			status: "available";
			generation: string;
			observedAt: Date;
			rows: Map<string, { state: string; ratio: number | null }>;
	  };
/** A complete empty generation proves absence; a missing head never does. */
export async function readQuiTorrentObservations(
	prisma: PrismaClient,
	userId: string,
	hashes: readonly string[],
	now = new Date(),
): Promise<QuiObservationRead> {
	const snapshot: {
		head: Awaited<ReturnType<typeof prisma.quiObservationPublication.findUnique>>;
	} = { head: null };
	const result = await prisma.$transaction<QuiObservationRead>(async (tx) => {
		const topology = await captureQuiObservationTopology(tx, userId);
		if (!topology.sourceCount) return { status: "not_configured" };
		const head = await tx.quiObservationPublication.findUnique({ where: { userId } }),
			time = head?.observedAt?.getTime(),
			nowMs = now.getTime();
		if (
			!head?.complete ||
			head.topologyDigest !== topology.digest ||
			time === undefined ||
			!Number.isFinite(time) ||
			!Number.isFinite(nowMs) ||
			time > nowMs ||
			time < nowMs - FRESHNESS_MS ||
			!Number.isSafeInteger(head.rowCount) ||
			head.rowCount < 0
		)
			return { status: "unavailable" };
		const where = { userId, generation: head.generation };
		snapshot.head = head;
		if ((await tx.quiTorrentObservation.count({ where })) !== head.rowCount)
			return { status: "unavailable" };
		const unique = [...new Set(hashes)],
			rows = new Map<string, { state: string; ratio: number | null }>();
		if (unique.some((hash) => !HASH.test(hash))) return { status: "unavailable" };
		for (let offset = 0; offset < unique.length; offset += BATCH) {
			for (const row of await tx.quiTorrentObservation.findMany({
				where: { ...where, infoHash: { in: unique.slice(offset, offset + BATCH) } },
			})) {
				if (!valid(row)) return { status: "unavailable" };
				rows.set(row.infoHash, { state: row.state, ratio: row.ratio });
			}
		}
		const last = await tx.quiObservationPublication.findUnique({ where: { userId } }),
			lastTopology = await captureQuiObservationTopology(tx, userId);
		if (
			!last?.complete ||
			last.generation !== head.generation ||
			last.topologyDigest !== head.topologyDigest ||
			last.rowCount !== head.rowCount ||
			last.observedAt?.getTime() !== time ||
			lastTopology.digest !== topology.digest ||
			(await tx.quiTorrentObservation.count({ where })) !== head.rowCount
		)
			return { status: "unavailable" };
		return { status: "available", generation: head.generation, observedAt: head.observedAt!, rows };
	});
	if (result.status === "not_configured") {
		return (await captureQuiObservationTopology(prisma, userId)).sourceCount === 0
			? result
			: { status: "unavailable" };
	}
	if (result.status !== "available") return result;
	// A repeat inside SQLite's read snapshot cannot see a concurrent commit.
	// Recheck the actual head/source/count after releasing that snapshot as well.
	const head = await prisma.quiObservationPublication.findUnique({ where: { userId } }),
		topology = await captureQuiObservationTopology(prisma, userId);
	if (
		!head?.complete ||
		!snapshot.head ||
		head.generation !== result.generation ||
		head.topologyDigest !== topology.digest ||
		head.topologyDigest !== snapshot.head.topologyDigest ||
		head.rowCount !== snapshot.head.rowCount ||
		head.observedAt?.getTime() !== result.observedAt.getTime() ||
		(await prisma.quiTorrentObservation.count({
			where: { userId, generation: result.generation },
		})) !== head.rowCount
	)
		return { status: "unavailable" };
	return result;
}
