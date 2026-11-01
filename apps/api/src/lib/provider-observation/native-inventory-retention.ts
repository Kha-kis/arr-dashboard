import { setTimeout as delay } from "node:timers/promises";
import type { Prisma, PrismaClient } from "../prisma.js";
import { NativeInventoryInputError } from "./native-inventory.js";

const MINIMUM_AGE_MS = 24 * 60 * 60_000;
const CANCELLED = Symbol("native-retention-cancelled");
const candidateSelect = {
	id: true,
	instanceId: true,
	workKey: true,
	state: true,
	connectionGeneration: true,
	identityGeneration: true,
	createdAt: true,
	updatedAt: true,
	instance: {
		select: { userId: true, service: true, connectionGeneration: true, identityGeneration: true },
	},
} as const;
type Candidate = Prisma.ProviderNativeInventoryRunGetPayload<{ select: typeof candidateSelect }>;
type Transaction = Prisma.TransactionClient;
export type NativeInventoryRetentionCursor = { id: string };
export type NativeInventoryRetentionSlice = {
	deletedRows: number;
	deletedRuns: number;
	scannedRuns: number;
	nextCursor: NativeInventoryRetentionCursor | null;
	hasMore: boolean;
};

/** A generic timeout, inherited value or accessor never permits a retry. */
function isBusyAdmission(error: unknown): boolean {
	const ownValue = (value: unknown, key: string): unknown => {
		if (typeof value !== "object" || value === null) return undefined;
		return Object.getOwnPropertyDescriptor(value, key)?.value;
	};
	try {
		return (
			ownValue(error, "code") === "P1008" &&
			ownValue(
				ownValue(ownValue(ownValue(error, "meta"), "driverAdapterError"), "cause"),
				"originalCode",
			) === "SQLITE_BUSY"
		);
	} catch {
		return false;
	}
}

async function retentionTransaction<T>(
	prisma: PrismaClient,
	operation: (tx: Transaction) => Promise<T>,
	admission: { retryAvailable: boolean },
	signal?: AbortSignal,
): Promise<T> {
	for (;;) {
		let callbackEntered = false;
		try {
			return await prisma.$transaction(
				async (tx) => {
					callbackEntered = true;
					return operation(tx);
				},
				{ isolationLevel: "Serializable", timeout: 10_000 },
			);
		} catch (error) {
			if (callbackEntered || !admission.retryAvailable || !isBusyAdmission(error)) throw error;
			// The rejected admission has settled. Never replay an entered body;
			// a fresh transaction below must re-resolve every existing safety fence.
			admission.retryAvailable = false;
			if (signal?.aborted) throw CANCELLED;
			await delay(20);
			if (signal?.aborted) throw CANCELLED;
		}
	}
}

function validate(cutoff: Date, limit: number, maximum: number): void {
	if (
		!(cutoff instanceof Date) ||
		!Number.isFinite(cutoff.getTime()) ||
		cutoff.getTime() > Date.now() - MINIMUM_AGE_MS ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > maximum
	) {
		throw new NativeInventoryInputError("Native inventory retention input is invalid");
	}
}

function eligible(cutoff: Date): Prisma.ProviderNativeInventoryRunWhereInput {
	return {
		state: { in: ["published", "incomplete", "superseded"] },
		activeSlotKey: null,
		claimToken: null,
		leaseUntil: null,
		updatedAt: { lte: cutoff },
		passes: { none: { publishedSnapshots: { some: {} } } },
	};
}

function bound(candidate: Candidate, cutoff: Date): Prisma.ProviderNativeInventoryRunWhereInput {
	return {
		AND: [
			eligible(cutoff),
			{
				id: candidate.id,
				instanceId: candidate.instanceId,
				state: candidate.state,
				workKey: candidate.workKey,
				connectionGeneration: candidate.connectionGeneration,
				identityGeneration: candidate.identityGeneration,
				instance: {
					userId: candidate.instance.userId,
					service: candidate.instance.service,
					connectionGeneration: candidate.instance.connectionGeneration,
					identityGeneration: candidate.instance.identityGeneration,
				},
			},
		],
	};
}

function domains(candidate: Candidate): string[] {
	return candidate.workKey === "paired" ? ["library", "episode"] : [candidate.workKey];
}

async function protectedRun(tx: Transaction, candidate: Candidate, cutoff: Date): Promise<boolean> {
	// SQLite legacy spellings can sort unlike UTC instants. SQL narrows the
	// ledger window; decoded timestamps are the final age authority.
	if (
		!Number.isFinite(candidate.updatedAt.getTime()) ||
		!Number.isFinite(candidate.createdAt.getTime()) ||
		candidate.updatedAt > cutoff
	)
		return true;
	if (
		!candidate.instance.userId.trim() ||
		!["PLEX", "JELLYFIN", "EMBY"].includes(candidate.instance.service) ||
		![
			candidate.connectionGeneration,
			candidate.identityGeneration,
			candidate.instance.connectionGeneration,
			candidate.instance.identityGeneration,
		].every((value) => Number.isSafeInteger(value) && value >= 0)
	)
		return true;
	if (!["library", "episode", "paired"].includes(candidate.workKey)) return true;
	const binding = {
		instanceId: candidate.instanceId,
		connectionGeneration: candidate.connectionGeneration,
		identityGeneration: candidate.identityGeneration,
	};
	for (const domain of domains(candidate)) {
		const latest = await tx.providerNativeInventoryRun.findFirst({
			where: { ...binding, workKey: { in: [domain, "paired"] } },
			orderBy: [{ createdAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
			select: { id: true },
		});
		if (!latest || latest.id === candidate.id) return true;
	}
	if (candidate.workKey === "episode" && candidate.state === "incomplete") {
		const positive = await tx.providerNativeInventoryPass.findFirst({
			where: {
				state: "complete",
				completedAt: { not: null },
				episodeItemCount: { not: null },
				run: {
					...binding,
					workKey: "episode",
					state: { in: ["pending", "running", "ready", "incomplete"] },
				},
			},
			orderBy: [{ completedAt: "desc" }, { id: "desc" }],
			select: { runId: true },
		});
		if (positive?.runId === candidate.id) return true;
	}
	return false;
}

async function keepAttemptMetadata(tx: Transaction, candidate: Candidate): Promise<boolean> {
	if (candidate.state === "published") return false;
	// The reader's newer-unpublished-run check uses this metadata to keep an
	// older published head last-known. Staging can go, but that fact must remain.
	return !!(await tx.providerNativeInventorySnapshot.findFirst({
		where: {
			instanceId: candidate.instanceId,
			domain: { in: domains(candidate) },
			connectionGeneration: candidate.connectionGeneration,
			identityGeneration: candidate.identityGeneration,
			observedAt: { lte: candidate.createdAt },
		},
		select: { id: true },
	}));
}

async function candidates(
	prisma: Pick<PrismaClient, "providerNativeInventoryRun">,
	cutoff: Date,
	limit: number,
	cursor: NativeInventoryRetentionCursor | null,
) {
	return prisma.providerNativeInventoryRun.findMany({
		where: {
			...eligible(cutoff),
			...(cursor ? { id: { gt: cursor.id } } : {}),
		},
		// A stable ID key survives deleted predecessors and never reserializes a
		// legacy SQLite timestamp. Age remains an independent eligibility fence.
		orderBy: [{ id: "asc" }],
		take: limit,
		select: candidateSelect,
	});
}

/** Read-only preview; no lease, timestamp, filesystem or provider mutation. */
export async function previewNativeInventoryRetention(
	prisma: PrismaClient,
	cutoff: Date,
	limit: number,
): Promise<{ candidateCount: number }> {
	validate(cutoff, limit, 100);
	return prisma.$transaction(
		async (tx) => {
			let candidateCount = 0;
			for (const candidate of await candidates(tx, cutoff, limit, null)) {
				if (!(await protectedRun(tx, candidate, cutoff))) candidateCount++;
			}
			return { candidateCount };
		},
		{ isolationLevel: "Serializable", timeout: 10_000 },
	);
}

/** A bounded slice. Only empty parents are deleted, so cascades cannot grow work. */
export async function pruneNativeInventoryRetentionSlice(
	prisma: PrismaClient,
	cutoff: Date,
	options: {
		rowLimit?: number;
		scanLimit?: number;
		cursor?: NativeInventoryRetentionCursor | null;
		signal?: AbortSignal;
	} = {},
): Promise<NativeInventoryRetentionSlice> {
	const rowLimit = options.rowLimit ?? 500,
		scanLimit = options.scanLimit ?? 10;
	validate(cutoff, rowLimit, 500);
	validate(cutoff, scanLimit, 100);
	if (
		options.cursor &&
		(typeof options.cursor.id !== "string" || !options.cursor.id || options.cursor.id.length > 256)
	) {
		throw new NativeInventoryInputError("Native inventory retention cursor is invalid");
	}
	const total: NativeInventoryRetentionSlice = {
		deletedRows: 0,
		deletedRuns: 0,
		scannedRuns: 0,
		nextCursor: options.cursor ?? null,
		hasMore: false,
	};
	if (options.signal?.aborted) return total;
	const selected = await candidates(prisma, cutoff, scanLimit, total.nextCursor);
	// One extra admission for the whole slice, not once per scanned candidate.
	const admission = { retryAvailable: true };
	total.hasMore = selected.length === scanLimit;
	for (const candidate of selected) {
		if (options.signal?.aborted) break;
		const previousCursor = total.nextCursor;
		total.scannedRuns++;
		total.nextCursor = { id: candidate.id };
		const guard = bound(candidate, cutoff);
		try {
			const removed = await retentionTransaction(
				prisma,
				async (tx) => {
					const fresh = await tx.providerNativeInventoryRun.findFirst({
						where: guard,
						select: candidateSelect,
					});
					if (
						!fresh ||
						fresh.createdAt.getTime() !== candidate.createdAt.getTime() ||
						fresh.updatedAt.getTime() !== candidate.updatedAt.getTime() ||
						(await protectedRun(tx, fresh, cutoff))
					)
						return { rows: 0, runs: 0, remaining: false };
					// A true database self-assignment takes the writer fence without
					// ORM @updatedAt behavior or changing legacy timestamp spellings.
					// The serializable read above and every DELETE retain the complete
					// owner/binding/age/reference guard; this statement is not authority.
					const lock = await tx.$executeRaw`
						UPDATE "provider_native_inventory_runs" SET "state" = "state"
						WHERE "id" = ${candidate.id} AND "instanceId" = ${candidate.instanceId}
						AND "workKey" = ${candidate.workKey} AND "state" = ${candidate.state}
						AND "connectionGeneration" = ${candidate.connectionGeneration}
						AND "identityGeneration" = ${candidate.identityGeneration}
						AND "activeSlotKey" IS NULL AND "claimToken" IS NULL AND "leaseUntil" IS NULL
					`;
					if (lock !== 1 || (await protectedRun(tx, fresh, cutoff)))
						return { rows: 0, runs: 0, remaining: false };
					if (options.signal?.aborted) throw CANCELLED;
					let rows = 0,
						runs = 0;
					const room = () => rowLimit - total.deletedRows - rows;
					const pass = await tx.providerNativeInventoryPass.findFirst({
						where: { runId: candidate.id },
						select: { id: true },
					});
					if (pass) {
						const childWhere = { passId: pass.id, pass: { run: guard } };
						const drain = async (
							find: (take: number) => Promise<Array<{ id: string }>>,
							remove: (ids: string[]) => Promise<{ count: number }>,
						) => {
							if (options.signal?.aborted) throw CANCELLED;
							if (room() < 1) return;
							const ids = (await find(room())).map((row) => row.id);
							if (ids.length) rows += (await remove(ids)).count;
						};
						await drain(
							(take) =>
								tx.providerNativeInventoryStageItem.findMany({
									where: childWhere,
									orderBy: [{ domain: "asc" }, { nativeId: "asc" }],
									take,
									select: { id: true },
								}),
							(ids) =>
								tx.providerNativeInventoryStageItem.deleteMany({
									where: { id: { in: ids }, pass: { id: pass.id, run: guard } },
								}),
						);
						await drain(
							(take) =>
								tx.providerNativeInventorySeenItem.findMany({
									where: childWhere,
									orderBy: [{ domain: "asc" }, { scopeKey: "asc" }, { nativeId: "asc" }],
									take,
									select: { id: true },
								}),
							(ids) =>
								tx.providerNativeInventorySeenItem.deleteMany({
									where: { id: { in: ids }, pass: { id: pass.id, run: guard } },
								}),
						);
						await drain(
							(take) =>
								tx.providerNativeInventoryPageReceipt.findMany({
									where: childWhere,
									take,
									select: { id: true },
								}),
							(ids) =>
								tx.providerNativeInventoryPageReceipt.deleteMany({
									where: { ...childWhere, id: { in: ids } },
								}),
						);
						if (room() > 0)
							rows += (
								await tx.providerNativeInventoryPass.deleteMany({
									where: {
										id: pass.id,
										run: guard,
										items: { none: {} },
										seenItems: { none: {} },
										receipts: { none: {} },
										publishedSnapshots: { none: {} },
									},
								})
							).count;
					}
					const metadataRequired = await keepAttemptMetadata(tx, fresh);
					if (room() > 0 && !metadataRequired) {
						runs = (
							await tx.providerNativeInventoryRun.deleteMany({
								where: { ...guard, passes: { none: {} } },
							})
						).count;
						rows += runs;
					}
					if (options.signal?.aborted) throw CANCELLED;
					const remainingPass = await tx.providerNativeInventoryPass.findFirst({
						where: { runId: candidate.id },
						select: { id: true },
					});
					return { rows, runs, remaining: !!remainingPass || (!metadataRequired && runs === 0) };
				},
				admission,
				options.signal,
			);
			total.deletedRows += removed.rows;
			total.deletedRuns += removed.runs;
			if (removed.remaining) {
				total.nextCursor = previousCursor;
				total.hasMore = true;
				return total;
			}
		} catch (error) {
			if (error !== CANCELLED) throw error;
			total.nextCursor = previousCursor;
			total.hasMore = true;
			return total;
		}
		if (total.deletedRows >= rowLimit) {
			total.hasMore = true;
			return total;
		}
	}
	if (!total.hasMore) total.nextCursor = null;
	return total;
}

export async function pruneNativeInventoryRetention(
	prisma: PrismaClient,
	cutoff: Date,
	limit: number,
): Promise<{ deletedRuns: number }> {
	validate(cutoff, limit, 100);
	const result = await pruneNativeInventoryRetentionSlice(prisma, cutoff, { scanLimit: limit });
	return { deletedRuns: result.deletedRuns };
}
