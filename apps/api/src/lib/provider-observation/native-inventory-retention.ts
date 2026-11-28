import { setTimeout as delay } from "node:timers/promises";
import type { Prisma, PrismaClient } from "../prisma.js";
import { NativeInventoryInputError } from "./native-inventory.js";
import {
	type NativeInventoryRetentionOperation,
	rememberNativeInventoryRetentionBoundary,
} from "./native-inventory-retention-diagnostics.js";

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
	nextAttemptAt: true,
	lastFailureCategory: true,
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
	admission: { retryAvailable: boolean; retryObserved: boolean },
	boundary: { operation: NativeInventoryRetentionOperation },
	signal?: AbortSignal,
): Promise<T> {
	for (;;) {
		let callbackEntered = false;
		try {
			return await prisma.$transaction(
				async (tx) => {
					callbackEntered = true;
					const result = await operation(tx);
					boundary.operation = "transaction-finish";
					return result;
				},
				{ isolationLevel: "Serializable", timeout: 10_000 },
			);
		} catch (error) {
			if (callbackEntered || !admission.retryAvailable || !isBusyAdmission(error)) {
				rememberNativeInventoryRetentionBoundary(
					error,
					callbackEntered ? boundary.operation : "transaction-start",
					callbackEntered,
					admission.retryObserved,
				);
				throw error;
			}
			// The rejected admission has settled. Never replay an entered body;
			// a fresh transaction below must re-resolve every existing safety fence.
			admission.retryAvailable = false;
			admission.retryObserved = true;
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

const settledFailureCategories = [
	"coverage-incomplete",
	"provider-unavailable",
	"deadline-exceeded",
	"database-retryable",
	"budget-exhausted",
];
const collectiblePass = { state: "collecting" } as const;
const settledPass = { state: { in: ["collecting", "complete"] } };

function eligible(cutoff: Date): Prisma.ProviderNativeInventoryRunWhereInput {
	return {
		activeSlotKey: null,
		claimToken: null,
		leaseUntil: null,
		passes: { none: { publishedSnapshots: { some: {} } } },
		OR: [
			{ state: { in: ["published", "incomplete", "superseded"] }, updatedAt: { lte: cutoff } },
			{ state: "superseded", passes: { some: settledPass } },
			{
				state: "incomplete",
				lastFailureCategory: { in: settledFailureCategories },
				OR: [
					{ workKey: { in: ["library", "paired"] }, passes: { some: settledPass } },
					{ workKey: "episode", passes: { some: collectiblePass } },
				],
			},
		],
	};
}

/** Terminal runs have lost their exact work slot and cannot be claimed again. */
function abandonedPass(candidate: Candidate): Prisma.ProviderNativeInventoryPassWhereInput | null {
	if (candidate.state === "superseded") return settledPass;
	if (
		candidate.state !== "incomplete" ||
		!candidate.lastFailureCategory ||
		!settledFailureCategories.includes(candidate.lastFailureCategory)
	)
		return null;
	// A complete episode pass can still supply positive-only Jellyfin display evidence.
	return candidate.workKey === "episode" ? collectiblePass : settledPass;
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

function validRetentionBinding(candidate: Candidate): boolean {
	return (
		Number.isFinite(candidate.updatedAt.getTime()) &&
		Number.isFinite(candidate.createdAt.getTime()) &&
		candidate.instance.userId.trim().length > 0 &&
		["PLEX", "JELLYFIN", "EMBY"].includes(candidate.instance.service) &&
		["library", "episode", "paired"].includes(candidate.workKey) &&
		[
			candidate.connectionGeneration,
			candidate.identityGeneration,
			candidate.instance.connectionGeneration,
			candidate.instance.identityGeneration,
		].every((value) => Number.isSafeInteger(value) && value >= 0)
	);
}

async function protectedRun(tx: Transaction, candidate: Candidate, cutoff: Date): Promise<boolean> {
	// SQLite legacy spellings can sort unlike UTC instants. SQL narrows the
	// ledger window; decoded timestamps are the final age authority.
	if (candidate.updatedAt > cutoff) return true;

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

async function keepAttemptMetadata(
	db: Pick<PrismaClient, "providerNativeInventorySnapshot" | "providerNativeInventoryRun">,
	candidate: Candidate,
	options?: { requireNoPasses: boolean },
): Promise<boolean> {
	if (candidate.state === "published") return false;
	if (candidate.state === "incomplete" && candidate.nextAttemptAt) {
		const latestTerminal = await db.providerNativeInventoryRun.findFirst({
			where: {
				instanceId: candidate.instanceId,
				workKey: candidate.workKey,
				connectionGeneration: candidate.connectionGeneration,
				identityGeneration: candidate.identityGeneration,
				state: { in: ["published", "incomplete", "superseded"] },
			},
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			select: { id: true },
		});
		if (
			latestTerminal?.id === candidate.id &&
			(!options?.requireNoPasses ||
				(await db.providerNativeInventoryRun.findFirst({
					where: { id: candidate.id, passes: { none: {} } },
					select: { id: true },
				})))
		)
			return true;
	}
	// The reader's newer-unpublished-run check uses this metadata to keep an
	// older published head last-known. Staging can go, but that fact must remain.
	return !!(await db.providerNativeInventorySnapshot.findFirst({
		where: {
			instanceId: candidate.instanceId,
			domain: { in: domains(candidate) },
			connectionGeneration: candidate.connectionGeneration,
			identityGeneration: candidate.identityGeneration,
			observedAt: { lte: candidate.createdAt },
			...(options?.requireNoPasses && {
				instance: { nativeInventoryRuns: { some: { id: candidate.id, passes: { none: {} } } } },
			}),
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
				if (!validRetentionBinding(candidate)) continue;
				const abandoned = abandonedPass(candidate);
				if (
					!(await protectedRun(tx, candidate, cutoff)) ||
					(abandoned &&
						(await tx.providerNativeInventoryPass.findFirst({
							where: { runId: candidate.id, ...abandoned },
							select: { id: true },
						})))
				)
					candidateCount++;
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
		skipProtectedWriteAdmission?: boolean;
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
	const selected = await candidates(prisma, cutoff, scanLimit, total.nextCursor).catch(
		(error: unknown) => {
			rememberNativeInventoryRetentionBoundary(error, "candidate-enumeration", false);
			throw error;
		},
	);
	// One extra admission for the whole slice, not once per scanned candidate.
	const admission = { retryAvailable: true, retryObserved: false };
	total.hasMore = selected.length === scanLimit;
	for (const candidate of selected) {
		if (options.signal?.aborted) break;
		const previousCursor = total.nextCursor;
		total.scannedRuns++;
		total.nextCursor = { id: candidate.id };
		const guard = bound(candidate, cutoff);
		const boundary: { operation: NativeInventoryRetentionOperation } = {
			operation: "transaction-start",
		};
		try {
			// A read-side skip can only defer work until a later sweep. Every
			// candidate with possible deletions still goes through the writer fences.
			const skipWriter = await keepAttemptMetadata(prisma, candidate, { requireNoPasses: true })
				.then((metadataOnly) => {
					if (
						metadataOnly ||
						!options.skipProtectedWriteAdmission ||
						candidate.state !== "incomplete" ||
						!validRetentionBinding(candidate) ||
						abandonedPass(candidate) !== null
					) {
						return metadataOnly;
					}
					// The probe may only defer. A failed probe falls back to the
					// ordinary writer admission and its mandatory rechecks.
					return protectedRun(prisma, candidate, cutoff).catch(() => false);
				})
				.catch((error: unknown) => {
					rememberNativeInventoryRetentionBoundary(error, "candidate-enumeration", false);
					throw error;
				});
			if (options.signal?.aborted) throw CANCELLED;
			if (skipWriter) continue;
			const removed = await retentionTransaction(
				prisma,
				async (tx) => {
					boundary.operation = "run-recheck";
					const fresh = await tx.providerNativeInventoryRun.findFirst({
						where: guard,
						select: candidateSelect,
					});
					boundary.operation = "protected-check";
					if (
						!fresh ||
						fresh.createdAt.getTime() !== candidate.createdAt.getTime() ||
						fresh.updatedAt.getTime() !== candidate.updatedAt.getTime() ||
						!validRetentionBinding(fresh)
					)
						return { rows: 0, runs: 0, remaining: false };
					const abandoned = abandonedPass(fresh);
					const protectedBeforeWrite = await protectedRun(tx, fresh, cutoff);
					if (
						protectedBeforeWrite &&
						(!abandoned ||
							!(await tx.providerNativeInventoryPass.findFirst({
								where: { runId: fresh.id, ...abandoned },
								select: { id: true },
							})))
					)
						return { rows: 0, runs: 0, remaining: false };
					// A true database self-assignment takes the writer fence without
					// ORM @updatedAt behavior or changing legacy timestamp spellings.
					// The serializable read above and every DELETE retain the complete
					// owner/binding/age/reference guard; this statement is not authority.
					boundary.operation = "writer-fence";
					const lock = await tx.$executeRaw`
						UPDATE "provider_native_inventory_runs" SET "state" = "state"
						WHERE "id" = ${candidate.id} AND "instanceId" = ${candidate.instanceId}
						AND "workKey" = ${candidate.workKey} AND "state" = ${candidate.state}
						AND "connectionGeneration" = ${candidate.connectionGeneration}
						AND "identityGeneration" = ${candidate.identityGeneration}
						AND "activeSlotKey" IS NULL AND "claimToken" IS NULL AND "leaseUntil" IS NULL
						`;
					boundary.operation = "protected-check";
					if (lock !== 1) return { rows: 0, runs: 0, remaining: false };
					const retainRun = await protectedRun(tx, fresh, cutoff);
					if (retainRun && !abandoned) return { rows: 0, runs: 0, remaining: false };
					const passWhere = { runId: candidate.id, ...(retainRun ? abandoned : {}) };
					if (options.signal?.aborted) throw CANCELLED;
					let rows = 0,
						runs = 0;
					const room = () => rowLimit - total.deletedRows - rows;
					boundary.operation = "pass-read";
					const pass = await tx.providerNativeInventoryPass.findFirst({
						where: passWhere,
						orderBy: { ordinal: "asc" },
						select: { id: true },
					});
					if (pass) {
						const passGuard = { id: pass.id, ...(retainRun ? abandoned : {}), run: guard };
						const childWhere = { passId: pass.id, pass: passGuard };
						const drain = async (
							selectOperation: NativeInventoryRetentionOperation,
							deleteOperation: NativeInventoryRetentionOperation,
							find: (take: number) => Promise<Array<{ id: string }>>,
							remove: (ids: string[]) => Promise<{ count: number }>,
						) => {
							if (options.signal?.aborted) throw CANCELLED;
							if (room() < 1) return;
							boundary.operation = selectOperation;
							const ids = (await find(room())).map((row) => row.id);
							if (ids.length) {
								boundary.operation = deleteOperation;
								rows += (await remove(ids)).count;
							}
						};
						await drain(
							"stage-select",
							"stage-delete",
							(take) =>
								tx.providerNativeInventoryStageItem.findMany({
									where: childWhere,
									orderBy: [{ domain: "asc" }, { nativeId: "asc" }],
									take,
									select: { id: true },
								}),
							(ids) =>
								tx.providerNativeInventoryStageItem.deleteMany({
									where: { id: { in: ids }, pass: passGuard },
								}),
						);
						await drain(
							"seen-select",
							"seen-delete",
							(take) =>
								tx.providerNativeInventorySeenItem.findMany({
									where: childWhere,
									orderBy: [{ domain: "asc" }, { scopeKey: "asc" }, { nativeId: "asc" }],
									take,
									select: { id: true },
								}),
							(ids) =>
								tx.providerNativeInventorySeenItem.deleteMany({
									where: { id: { in: ids }, pass: passGuard },
								}),
						);
						await drain(
							"receipt-select",
							"receipt-delete",
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
						if (room() > 0) {
							boundary.operation = "pass-delete";
							rows += (
								await tx.providerNativeInventoryPass.deleteMany({
									where: {
										id: pass.id,
										...(retainRun ? abandoned : {}),
										run: guard,
										items: { none: {} },
										seenItems: { none: {} },
										receipts: { none: {} },
										publishedSnapshots: { none: {} },
									},
								})
							).count;
						}
					}
					boundary.operation = "attempt-metadata";
					const metadataRequired = retainRun || (await keepAttemptMetadata(tx, fresh));
					if (room() > 0 && !metadataRequired) {
						boundary.operation = "run-delete";
						runs = (
							await tx.providerNativeInventoryRun.deleteMany({
								where: { ...guard, passes: { none: {} } },
							})
						).count;
						rows += runs;
					}
					if (options.signal?.aborted) throw CANCELLED;
					boundary.operation = "remaining-pass-read";
					const remainingPass = await tx.providerNativeInventoryPass.findFirst({
						where: passWhere,
						select: { id: true },
					});
					return { rows, runs, remaining: !!remainingPass || (!metadataRequired && runs === 0) };
				},
				admission,
				boundary,
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
