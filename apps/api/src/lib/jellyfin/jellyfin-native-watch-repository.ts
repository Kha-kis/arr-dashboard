import { setTimeout as delay } from "node:timers/promises";
import { type JellyfinNativeWatchRow, Prisma, type PrismaClient } from "../prisma.js";
import { JELLYFIN_EPISODE_PREPARATION_LEASE_MS } from "./jellyfin-episode-generation-repository.js";
import { parseNativeWatchScopeDiagnostics } from "./jellyfin-native-watch-diagnostics.js";
import type { NativeWatchCandidate } from "./jellyfin-native-watch-projection.js";
import { retryJellyfinSnapshotTransaction } from "./jellyfin-snapshot-transaction.js";

function diagnosticJson(value: string | null | undefined): string | null {
	const parsed = parseNativeWatchScopeDiagnostics(value);
	return parsed ? JSON.stringify(parsed) : null;
}

const PUBLICATION_CHUNK_SIZE = 500;
// Bound row-write cost independently of receipt batches and verification pages.
const ROW_WRITE_CHUNK_SIZE = 100;
const CLEANUP_BATCH_SIZE = 5_000;
const LEASE_CHECKPOINT_CHUNKS = 10;
const ADMISSION_RETRY_DELAYS_MS = [10, 20, 40] as const;
const PREPARATION_TRANSACTION_MAX_WAIT_MS = 5_000;

function isBusyAdmission(error: unknown): boolean {
	const ownValue = (value: unknown, key: string): unknown => {
		if (typeof value !== "object" || value === null) return undefined;
		return Object.getOwnPropertyDescriptor(value, key)?.value;
	};
	try {
		// Prisma maps a native busy start to P1008. A generic timeout is not
		// enough: require the exact native cause without invoking accessors.
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

export type NativeWatchPreparationStage =
	| "lease-checkpoint"
	| "authority-check"
	| "own-row-reset"
	| "own-receipt-reset"
	| "row-chunk-write"
	| "receipt-chunk-write"
	| "row-verification"
	| "receipt-verification";

export type NativeWatchPreparationObserver = (event: {
	stage: NativeWatchPreparationStage;
	count?: number;
}) => void;

export type NativeWatchPreparationTransactionKind =
	| "lease-checkpoint"
	| "row-chunk"
	| "receipt-chunk";

type NativeWatchTransactionObserver = (event: {
	kind: NativeWatchPreparationTransactionKind;
	phase: "requested" | "callback-entered" | "succeeded" | "failed";
}) => void;

async function preparationTransaction(
	prisma: PrismaClient,
	kind: NativeWatchPreparationTransactionKind,
	observer: NativeWatchTransactionObserver | undefined,
	operation: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
	const observe = (phase: Parameters<NativeWatchTransactionObserver>[0]["phase"]) => {
		try {
			observer?.({ kind, phase });
		} catch {
			// Diagnostics cannot replace a transaction's result or original error.
		}
	};
	// Share the admission budget across rolled-back snapshot retries as well.
	let admissionRetries = 0;
	await retryJellyfinSnapshotTransaction(async () => {
		for (;;) {
			let callbackEntered = false;
			observe("requested");
			try {
				await prisma.$transaction(
					(tx) => {
						callbackEntered = true;
						observe("callback-entered");
						return operation(tx);
					},
					// Guarded admission precedes callback execution. Give it a bounded
					// start budget without extending the transaction execution timeout.
					{ maxWait: PREPARATION_TRANSACTION_MAX_WAIT_MS },
				);
				observe("succeeded");
				return;
			} catch (error) {
				observe("failed");
				const wait = ADMISSION_RETRY_DELAYS_MS[admissionRetries];
				// Only a refused start can replay the pending batch. Never replay a
				// callback failure or an uncertain commit/acknowledgement.
				if (callbackEntered || wait === undefined || !isBusyAdmission(error)) throw error;
				admissionRetries++;
				await delay(wait);
			}
		}
	});
}

function observePreparation(
	observer: NativeWatchPreparationObserver | undefined,
	stage: NativeWatchPreparationStage,
	count?: number,
): void {
	try {
		observer?.({ stage, ...(count === undefined ? {} : { count }) });
	} catch {
		// Diagnostics are synchronous and cannot change staging authority or results.
	}
}

async function yieldBetweenCleanupBatches(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

export type NativeWatchScopeReceipt = {
	userKeyDigest: string;
	libraryId: string;
	expectedRawCount: number;
	observedRawCount: number;
	exact: boolean;
	contentFingerprint: string;
	diagnosticsJson?: string | null;
};

export type NativeWatchPublicationInput = {
	instanceId: string;
	runId: string;
	cacheGenerationId: string;
	connectionGeneration: number;
	identityGeneration: number;
	observedAt: Date;
	expectedScopeCount: number;
	candidates: readonly NativeWatchCandidate[];
	receipts: readonly NativeWatchScopeReceipt[];
};

type OwnedNativeWatchPreparation = NativeWatchPublicationInput & {
	userId: string;
	preparationToken: string;
};
type PreparedNativeWatchPublication = Omit<
	NativeWatchPublicationInput,
	"candidates" | "receipts"
> & {
	userId: string;
	candidateCount: number;
	receiptCount: number;
};

export class JellyfinNativeWatchLeaseLostError extends Error {
	constructor() {
		super("Native watch preparation lease is unavailable");
		this.name = "JellyfinNativeWatchLeaseLostError";
	}
}

async function renewOwnedPreparationLease(
	tx: Prisma.TransactionClient,
	input: OwnedNativeWatchPreparation,
	observer?: NativeWatchPreparationObserver,
): Promise<void> {
	await acquireNativeWatchStagingWriteIntent(tx, input, observer);
	await assertUnpublishedRunningRun(tx, input, observer);
	observePreparation(observer, "lease-checkpoint");
	const now = new Date();
	const renewed = await tx.jellyfinEpisodePreparation.updateMany({
		where: {
			runId: input.runId,
			instanceId: input.instanceId,
			generationId: input.cacheGenerationId,
			token: input.preparationToken,
			state: "verified",
			leaseExpiresAt: { gt: now },
		},
		data: {
			leaseExpiresAt: new Date(now.getTime() + JELLYFIN_EPISODE_PREPARATION_LEASE_MS),
		},
	});
	if (renewed.count !== 1) throw new JellyfinNativeWatchLeaseLostError();
}

async function checkpointPreparationLease(
	prisma: PrismaClient,
	input: OwnedNativeWatchPreparation,
	observer?: NativeWatchPreparationObserver,
	transactionObserver?: NativeWatchTransactionObserver,
): Promise<void> {
	observePreparation(observer, "lease-checkpoint");
	await preparationTransaction(prisma, "lease-checkpoint", transactionObserver, (tx) =>
		renewOwnedPreparationLease(tx, input, observer),
	);
}

function compareKey(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function compareCandidateKey(left: NativeWatchCandidate, right: NativeWatchCandidate): number {
	return (
		compareKey(left.userKeyDigest, right.userKeyDigest) ||
		compareKey(left.libraryId, right.libraryId) ||
		compareKey(left.jellyfinId, right.jellyfinId)
	);
}

async function assertUnpublishedRunningRun(
	db: Prisma.TransactionClient,
	input: OwnedNativeWatchPreparation,
	observer?: NativeWatchPreparationObserver,
): Promise<void> {
	observePreparation(observer, "authority-check");
	if (!input.userId || !input.instanceId || !input.runId || !input.preparationToken.trim())
		throw new Error("Native watch preparation authority is invalid");
	const leaseNow = new Date();
	// One owner-anchored snapshot; CASE returns closed integer flags on both backends.
	// Enum literals here are physical values (VERIFIED is mapped to "verified").
	const metadata = await db.$queryRaw<
		Array<{ expectedIdentity: unknown; unpublishedRun: unknown; livePreparation: unknown }>
	>(Prisma.sql`
		SELECT instance."expectedIdentity",
			CASE WHEN EXISTS (
				SELECT 1 FROM "provider_observation_runs" AS run
				WHERE run."instanceId" = instance."id" AND run."id" = ${input.runId}
					AND run."provider" = 'jellyfin_episode' AND run."cacheType" = 'jellyfin_episode'
					AND run."state" = 'running' AND run."activeSlotKey" IS NOT NULL
					AND run."connectionGeneration" = ${input.connectionGeneration}
					AND run."identityGeneration" = ${input.identityGeneration}
					AND run."completedUnits" = run."totalUnits"
					AND run."completedWork" = run."totalWork"
			) AND NOT EXISTS (
				SELECT 1 FROM "jellyfin_native_watch_publications" AS publication
				WHERE publication."instanceId" = instance."id"
					AND (publication."activeRunId" = ${input.runId} OR publication."previousRunId" = ${input.runId})
			) THEN 1 ELSE 0 END AS "unpublishedRun",
			CASE WHEN EXISTS (
				SELECT 1 FROM "jellyfin_episode_preparations" AS preparation
				WHERE preparation."instanceId" = instance."id" AND preparation."runId" = ${input.runId}
					AND preparation."generationId" = ${input.cacheGenerationId}
					AND preparation."token" = ${input.preparationToken}
					AND preparation."state" = 'verified' AND preparation."leaseExpiresAt" > ${leaseNow}
			) THEN 1 ELSE 0 END AS "livePreparation"
		FROM "ServiceInstance" AS instance
		WHERE instance."id" = ${input.instanceId} AND instance."userId" = ${input.userId}
			AND instance."enabled" = true AND instance."service" IN ('JELLYFIN', 'EMBY')
			AND instance."identityStatus" = 'verified'
			AND instance."connectionGeneration" = ${input.connectionGeneration}
			AND instance."identityGeneration" = ${input.identityGeneration}
	`);
	const authority = metadata.length === 1 ? metadata[0] : undefined;
	if (
		typeof authority?.expectedIdentity !== "string" ||
		!authority.expectedIdentity.trim() ||
		(authority.unpublishedRun !== 1 && authority.unpublishedRun !== 1n)
	)
		throw new Error("Native watch preparation authority was superseded");
	if (authority.livePreparation !== 1 && authority.livePreparation !== 1n)
		throw new JellyfinNativeWatchLeaseLostError();
}

/** Acquire SQLite write intent before authority reads in each staging transaction. */
async function acquireNativeWatchStagingWriteIntent(
	tx: Prisma.TransactionClient,
	input: OwnedNativeWatchPreparation,
	observer?: NativeWatchPreparationObserver,
): Promise<void> {
	observePreparation(observer, "lease-checkpoint");
	const leaseNow = new Date();
	const matched = await tx.$executeRaw`
		UPDATE "jellyfin_episode_preparations"
		SET "token" = "token"
		WHERE "runId" = ${input.runId}
			AND "instanceId" = ${input.instanceId}
			AND "generationId" = ${input.cacheGenerationId}
			AND "token" = ${input.preparationToken}
			AND "state" = 'verified'
			AND "leaseExpiresAt" > ${leaseNow}
			AND EXISTS (
				SELECT 1 FROM "ServiceInstance"
				WHERE "id" = ${input.instanceId} AND "userId" = ${input.userId}
			)
	`;
	if (matched !== 1) throw new JellyfinNativeWatchLeaseLostError();
}

/** Build an invisible generation in short SQLite writes; retry always resets its own run. */
export async function prepareNativeWatchGeneration(
	prisma: PrismaClient,
	input: OwnedNativeWatchPreparation,
	observer?: NativeWatchPreparationObserver,
	transactionObserver?: NativeWatchTransactionObserver,
	checkCancellation?: () => void | Promise<void>,
): Promise<void> {
	await checkCancellation?.();
	if (
		!Number.isFinite(input.observedAt.getTime()) ||
		!Number.isSafeInteger(input.expectedScopeCount) ||
		input.expectedScopeCount !== input.receipts.length
	)
		throw new Error("Native watch preparation input is invalid");
	const receiptKeys = new Set<string>();
	for (const receipt of input.receipts) {
		const key = `${receipt.userKeyDigest}\0${receipt.libraryId}`;
		if (
			!receipt.userKeyDigest.trim() ||
			!receipt.libraryId.trim() ||
			receiptKeys.has(key) ||
			!Number.isSafeInteger(receipt.expectedRawCount) ||
			receipt.expectedRawCount < 0 ||
			!Number.isSafeInteger(receipt.observedRawCount) ||
			receipt.observedRawCount < 0 ||
			!/^[a-f0-9]{64}$/.test(receipt.contentFingerprint)
		)
			throw new Error("Native watch preparation scope receipt is invalid");
		receiptKeys.add(key);
	}
	if (
		input.candidates.some(
			(candidate) => !receiptKeys.has(`${candidate.userKeyDigest}\0${candidate.libraryId}`),
		)
	)
		throw new Error("Native watch preparation candidate has no scope receipt");
	// Renew in-band with staging. A timer on another SQLite connection can
	// contend with the very write transaction whose progress it protects.
	await checkpointPreparationLease(prisma, input, observer, transactionObserver);
	await assertUnpublishedRunningRun(prisma, input, observer);
	await checkCancellation?.();
	let cleanupBatches = 0;
	for (;;) {
		observePreparation(observer, "own-row-reset");
		await checkCancellation?.();
		const leaseNow = new Date();
		const deleted = await prisma.$executeRaw`
			DELETE FROM "jellyfin_native_watch_rows"
			WHERE "id" IN (
				SELECT row."id"
				FROM "jellyfin_native_watch_rows" AS row
				JOIN "provider_observation_runs" AS run
					ON run."id" = row."runId" AND run."instanceId" = row."instanceId"
				JOIN "ServiceInstance" AS instance ON instance."id" = row."instanceId"
				WHERE row."instanceId" = ${input.instanceId}
					AND row."runId" = ${input.runId}
					AND instance."userId" = ${input.userId}
					AND run."state" = 'running'
					AND run."activeSlotKey" IS NOT NULL
					AND EXISTS (
						SELECT 1 FROM "jellyfin_episode_preparations" AS preparation
						WHERE preparation."runId" = row."runId"
							AND preparation."instanceId" = row."instanceId"
							AND preparation."generationId" = ${input.cacheGenerationId}
							AND preparation."token" = ${input.preparationToken}
							AND preparation."state" = 'verified'
							AND preparation."leaseExpiresAt" > ${leaseNow}
					)
					AND NOT EXISTS (
						SELECT 1 FROM "jellyfin_native_watch_publications" AS pointer
						WHERE pointer."instanceId" = row."instanceId"
							AND (pointer."activeRunId" = row."runId"
								OR pointer."previousRunId" = row."runId")
					)
				LIMIT ${CLEANUP_BATCH_SIZE}
			)
		`;
		await checkCancellation?.();
		if (deleted === 0) break;
		await yieldBetweenCleanupBatches();
		if (++cleanupBatches % LEASE_CHECKPOINT_CHUNKS === 0)
			await checkpointPreparationLease(prisma, input, observer, transactionObserver);
	}
	cleanupBatches = 0;
	for (;;) {
		observePreparation(observer, "own-receipt-reset");
		await checkCancellation?.();
		const leaseNow = new Date();
		const deleted = await prisma.$executeRaw`
			DELETE FROM "jellyfin_native_watch_scope_receipts"
			WHERE "id" IN (
				SELECT receipt."id"
				FROM "jellyfin_native_watch_scope_receipts" AS receipt
				JOIN "provider_observation_runs" AS run
					ON run."id" = receipt."runId" AND run."instanceId" = receipt."instanceId"
				JOIN "ServiceInstance" AS instance ON instance."id" = receipt."instanceId"
				WHERE receipt."instanceId" = ${input.instanceId}
					AND receipt."runId" = ${input.runId}
					AND instance."userId" = ${input.userId}
					AND run."state" = 'running'
					AND run."activeSlotKey" IS NOT NULL
					AND EXISTS (
						SELECT 1 FROM "jellyfin_episode_preparations" AS preparation
						WHERE preparation."runId" = receipt."runId"
							AND preparation."instanceId" = receipt."instanceId"
							AND preparation."generationId" = ${input.cacheGenerationId}
							AND preparation."token" = ${input.preparationToken}
							AND preparation."state" = 'verified'
							AND preparation."leaseExpiresAt" > ${leaseNow}
					)
					AND NOT EXISTS (
						SELECT 1 FROM "jellyfin_native_watch_publications" AS pointer
						WHERE pointer."instanceId" = receipt."instanceId"
							AND (pointer."activeRunId" = receipt."runId"
								OR pointer."previousRunId" = receipt."runId")
					)
				LIMIT ${CLEANUP_BATCH_SIZE}
			)
		`;
		await checkCancellation?.();
		if (deleted === 0) break;
		await yieldBetweenCleanupBatches();
		if (++cleanupBatches % LEASE_CHECKPOINT_CHUNKS === 0)
			await checkpointPreparationLease(prisma, input, observer, transactionObserver);
	}
	await assertUnpublishedRunningRun(prisma, input, observer);
	for (let start = 0; start < input.candidates.length; start += ROW_WRITE_CHUNK_SIZE) {
		const chunk = input.candidates.slice(start, start + ROW_WRITE_CHUNK_SIZE);
		observePreparation(observer, "row-chunk-write", chunk.length);
		await checkCancellation?.();
		await preparationTransaction(prisma, "row-chunk", transactionObserver, async (tx) => {
			if (start % (PUBLICATION_CHUNK_SIZE * LEASE_CHECKPOINT_CHUNKS) === 0)
				await renewOwnedPreparationLease(tx, input, observer);
			else await acquireNativeWatchStagingWriteIntent(tx, input, observer);
			await assertUnpublishedRunningRun(tx, input, observer);
			observePreparation(observer, "row-chunk-write", chunk.length);
			await tx.jellyfinNativeWatchRow.createMany({
				data: chunk.map((candidate) => ({
					instanceId: input.instanceId,
					runId: input.runId,
					...candidate,
					observedAt: input.observedAt,
					connectionGeneration: input.connectionGeneration,
					identityGeneration: input.identityGeneration,
				})),
			});
			await assertUnpublishedRunningRun(tx, input, observer);
			// The transaction's commit is part of this chunk's write phase.
			observePreparation(observer, "row-chunk-write", chunk.length);
		});
		await checkCancellation?.();
	}
	for (let start = 0; start < input.receipts.length; start += PUBLICATION_CHUNK_SIZE) {
		const chunk = input.receipts.slice(start, start + PUBLICATION_CHUNK_SIZE);
		observePreparation(observer, "receipt-chunk-write", chunk.length);
		await checkCancellation?.();
		await preparationTransaction(prisma, "receipt-chunk", transactionObserver, async (tx) => {
			if ((start / PUBLICATION_CHUNK_SIZE) % LEASE_CHECKPOINT_CHUNKS === 0)
				await renewOwnedPreparationLease(tx, input, observer);
			else await acquireNativeWatchStagingWriteIntent(tx, input, observer);
			await assertUnpublishedRunningRun(tx, input, observer);
			observePreparation(observer, "receipt-chunk-write", chunk.length);
			await tx.jellyfinNativeWatchScopeReceipt.createMany({
				data: chunk.map((receipt) => ({
					instanceId: input.instanceId,
					runId: input.runId,
					...receipt,
					diagnosticsJson: diagnosticJson(receipt.diagnosticsJson),
					observedAt: input.observedAt,
					connectionGeneration: input.connectionGeneration,
					identityGeneration: input.identityGeneration,
				})),
			});
			await assertUnpublishedRunningRun(tx, input, observer);
			observePreparation(observer, "receipt-chunk-write", chunk.length);
		});
		await checkCancellation?.();
	}
	await verifyPreparedNativeWatchGeneration(
		prisma,
		input,
		() => checkpointPreparationLease(prisma, input, observer, transactionObserver),
		observer,
		checkCancellation,
	);
}

/** Compare all prepared content, not merely counts, before it can become visible. */
export async function verifyPreparedNativeWatchGeneration(
	prisma: PrismaClient,
	input: OwnedNativeWatchPreparation,
	checkpointLease?: () => Promise<void>,
	observer?: NativeWatchPreparationObserver,
	checkCancellation?: () => void | Promise<void>,
): Promise<void> {
	await checkCancellation?.();
	await assertUnpublishedRunningRun(prisma, input, observer);
	const candidates = [...input.candidates].sort(compareCandidateKey);
	let candidateIndex = 0;
	let candidateCursor: {
		instanceId: string;
		runId: string;
		userKeyDigest: string;
		libraryId: string;
		jellyfinId: string;
	} | null = null;
	let verifiedPages = 0;
	for (;;) {
		if (verifiedPages % LEASE_CHECKPOINT_CHUNKS === 0) await checkpointLease?.();
		observePreparation(observer, "row-verification");
		await checkCancellation?.();
		const seek: Prisma.Sql = candidateCursor
			? Prisma.sql`AND ("userKeyDigest", "libraryId", "jellyfinId") > (${candidateCursor.userKeyDigest}, ${candidateCursor.libraryId}, ${candidateCursor.jellyfinId})`
			: Prisma.empty;
		const rows: JellyfinNativeWatchRow[] = await prisma.$queryRaw<
			JellyfinNativeWatchRow[]
		>(Prisma.sql`
			SELECT * FROM "jellyfin_native_watch_rows"
			WHERE "instanceId" = ${input.instanceId} AND "runId" = ${input.runId} ${seek}
			ORDER BY "userKeyDigest", "libraryId", "jellyfinId"
			LIMIT ${PUBLICATION_CHUNK_SIZE}
		`);
		await checkCancellation?.();
		for (const row of rows) {
			const expected = candidates[candidateIndex++];
			if (
				!expected ||
				row.userKeyDigest !== expected.userKeyDigest ||
				row.libraryId !== expected.libraryId ||
				row.jellyfinId !== expected.jellyfinId ||
				row.seriesId !== expected.seriesId ||
				row.seasonNumber !== expected.seasonNumber ||
				row.episodeNumber !== expected.episodeNumber ||
				row.played !== expected.played ||
				row.playCount !== expected.playCount ||
				row.lastPlayedAt?.getTime() !== expected.lastPlayedAt?.getTime() ||
				row.observedAt.getTime() !== input.observedAt.getTime() ||
				row.connectionGeneration !== input.connectionGeneration ||
				row.identityGeneration !== input.identityGeneration
			)
				throw new Error("Native watch preparation content did not match");
		}
		if (rows.length < PUBLICATION_CHUNK_SIZE) break;
		verifiedPages += 1;
		const last = rows[rows.length - 1]!;
		candidateCursor = {
			instanceId: input.instanceId,
			runId: input.runId,
			userKeyDigest: last.userKeyDigest,
			libraryId: last.libraryId,
			jellyfinId: last.jellyfinId,
		};
	}
	if (candidateIndex !== candidates.length)
		throw new Error("Native watch preparation is incomplete");
	await checkpointLease?.();
	observePreparation(observer, "receipt-verification");
	await checkCancellation?.();
	const receipts = [...input.receipts].sort(
		(left, right) =>
			compareKey(left.userKeyDigest, right.userKeyDigest) ||
			compareKey(left.libraryId, right.libraryId),
	);
	const storedReceipts = await prisma.jellyfinNativeWatchScopeReceipt.findMany({
		where: { instanceId: input.instanceId, runId: input.runId },
		orderBy: [{ userKeyDigest: "asc" }, { libraryId: "asc" }],
	});
	await checkCancellation?.();
	if (storedReceipts.length !== receipts.length)
		throw new Error("Native watch preparation receipts are incomplete");
	for (let index = 0; index < receipts.length; index++) {
		const expected = receipts[index]!;
		const row = storedReceipts[index]!;
		if (
			row.userKeyDigest !== expected.userKeyDigest ||
			row.libraryId !== expected.libraryId ||
			row.expectedRawCount !== expected.expectedRawCount ||
			row.observedRawCount !== expected.observedRawCount ||
			row.exact !== expected.exact ||
			row.contentFingerprint !== expected.contentFingerprint ||
			row.observedAt.getTime() !== input.observedAt.getTime() ||
			row.connectionGeneration !== input.connectionGeneration ||
			row.identityGeneration !== input.identityGeneration
		)
			throw new Error("Native watch preparation receipt did not match");
	}
	await assertUnpublishedRunningRun(prisma, input, observer);
	await checkCancellation?.();
}

/** Final guarded transaction only switches authority to a fully prepared run. */
export async function publishPreparedNativeWatchGeneration(
	tx: Prisma.TransactionClient,
	input: PreparedNativeWatchPublication,
): Promise<void> {
	if (
		!input.userId ||
		!Number.isSafeInteger(input.candidateCount) ||
		input.candidateCount < 0 ||
		!Number.isSafeInteger(input.receiptCount) ||
		input.receiptCount !== input.expectedScopeCount
	)
		throw new Error("Prepared native watch publication input is invalid");
	const instance = await tx.serviceInstance.findFirst({
		where: {
			id: input.instanceId,
			userId: input.userId,
			enabled: true,
			service: { in: ["JELLYFIN", "EMBY"] },
			identityStatus: "VERIFIED",
			connectionGeneration: input.connectionGeneration,
			identityGeneration: input.identityGeneration,
		},
		select: { expectedIdentity: true },
	});
	const run = await tx.providerObservationRun.findFirst({
		where: {
			id: input.runId,
			instanceId: input.instanceId,
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			state: "complete",
			connectionGeneration: input.connectionGeneration,
			identityGeneration: input.identityGeneration,
		},
		select: { id: true },
	});
	const status = await tx.cacheRefreshStatus.findUnique({
		where: {
			instanceId_cacheType: { instanceId: input.instanceId, cacheType: "jellyfin_episode" },
		},
		select: {
			generationId: true,
			lastResult: true,
			connectionGeneration: true,
			identityGeneration: true,
		},
	});
	if (
		!instance?.expectedIdentity?.trim() ||
		!run ||
		status?.generationId !== input.cacheGenerationId ||
		status?.lastResult !== "success" ||
		status?.connectionGeneration !== input.connectionGeneration ||
		status?.identityGeneration !== input.identityGeneration
	)
		throw new Error("Prepared native watch publication authority was superseded");
	const candidateCount = await tx.jellyfinNativeWatchRow.count({
		where: { instanceId: input.instanceId, runId: input.runId },
	});
	const receiptCount = await tx.jellyfinNativeWatchScopeReceipt.count({
		where: { instanceId: input.instanceId, runId: input.runId },
	});
	const matchingCandidateCount = await tx.jellyfinNativeWatchRow.count({
		where: {
			instanceId: input.instanceId,
			runId: input.runId,
			observedAt: input.observedAt,
			connectionGeneration: input.connectionGeneration,
			identityGeneration: input.identityGeneration,
		},
	});
	const matchingReceiptCount = await tx.jellyfinNativeWatchScopeReceipt.count({
		where: {
			instanceId: input.instanceId,
			runId: input.runId,
			observedAt: input.observedAt,
			connectionGeneration: input.connectionGeneration,
			identityGeneration: input.identityGeneration,
		},
	});
	if (
		candidateCount !== input.candidateCount ||
		receiptCount !== input.receiptCount ||
		matchingCandidateCount !== candidateCount ||
		matchingReceiptCount !== receiptCount
	)
		throw new Error("Prepared native watch publication is incomplete");
	const prior = await tx.jellyfinNativeWatchPublication.findUnique({
		where: { instanceId: input.instanceId },
	});
	if (prior?.activeRunId === input.runId) {
		if (
			prior.activeCacheGenerationId === input.cacheGenerationId &&
			prior.activeObservedAt.getTime() === input.observedAt.getTime() &&
			prior.activeExpectedScopeCount === input.expectedScopeCount &&
			prior.connectionGeneration === input.connectionGeneration &&
			prior.identityGeneration === input.identityGeneration
		)
			return;
		throw new Error("Prepared native watch publication metadata did not match");
	}
	if (prior && prior.activeObservedAt > input.observedAt)
		throw new Error("Prepared native watch publication is older than the active generation");
	const keepsPrior =
		prior?.connectionGeneration === input.connectionGeneration &&
		prior.identityGeneration === input.identityGeneration;
	const pointer = {
		activeRunId: input.runId,
		activeCacheGenerationId: input.cacheGenerationId,
		activeObservedAt: input.observedAt,
		activeExpectedScopeCount: input.expectedScopeCount,
		previousRunId: keepsPrior ? prior.activeRunId : null,
		previousObservedAt: keepsPrior ? prior.activeObservedAt : null,
		previousExpectedScopeCount: keepsPrior ? prior.activeExpectedScopeCount : null,
		connectionGeneration: input.connectionGeneration,
		identityGeneration: input.identityGeneration,
	};
	if (prior) {
		const updated = await tx.jellyfinNativeWatchPublication.updateMany({
			where: {
				instanceId: input.instanceId,
				activeRunId: prior.activeRunId,
				activeCacheGenerationId: prior.activeCacheGenerationId,
				connectionGeneration: prior.connectionGeneration,
				identityGeneration: prior.identityGeneration,
			},
			data: pointer,
		});
		if (updated.count !== 1) throw new Error("Prepared native watch pointer was superseded");
	} else {
		await tx.jellyfinNativeWatchPublication.create({
			data: { instanceId: input.instanceId, ...pointer },
		});
	}
}

export async function publishNativeWatchGeneration(
	tx: Prisma.TransactionClient,
	input: NativeWatchPublicationInput,
): Promise<void> {
	if (
		!input.instanceId ||
		!input.runId ||
		!input.cacheGenerationId ||
		!Number.isFinite(input.observedAt.getTime()) ||
		!Number.isSafeInteger(input.expectedScopeCount) ||
		input.expectedScopeCount !== input.receipts.length
	)
		throw new Error("Native watch publication input is invalid");
	const instance = await tx.serviceInstance.findFirst({
		where: {
			id: input.instanceId,
			enabled: true,
			service: { in: ["JELLYFIN", "EMBY"] },
			identityStatus: "VERIFIED",
			connectionGeneration: input.connectionGeneration,
			identityGeneration: input.identityGeneration,
		},
		select: { id: true, expectedIdentity: true },
	});
	const run = await tx.providerObservationRun.findFirst({
		where: {
			id: input.runId,
			instanceId: input.instanceId,
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			state: "complete",
			connectionGeneration: input.connectionGeneration,
			identityGeneration: input.identityGeneration,
		},
		select: { id: true },
	});
	const status = await tx.cacheRefreshStatus.findUnique({
		where: {
			instanceId_cacheType: { instanceId: input.instanceId, cacheType: "jellyfin_episode" },
		},
		select: {
			generationId: true,
			lastResult: true,
			connectionGeneration: true,
			identityGeneration: true,
		},
	});
	if (
		!instance?.expectedIdentity?.trim() ||
		!run ||
		status?.generationId !== input.cacheGenerationId ||
		status?.lastResult !== "success" ||
		status?.connectionGeneration !== input.connectionGeneration ||
		status?.identityGeneration !== input.identityGeneration
	)
		throw new Error("Native watch publication authority was superseded");
	const receiptKeys = new Set<string>();
	for (const receipt of input.receipts) {
		const key = `${receipt.userKeyDigest}\0${receipt.libraryId}`;
		if (
			!receipt.userKeyDigest.trim() ||
			!receipt.libraryId.trim() ||
			receiptKeys.has(key) ||
			!Number.isSafeInteger(receipt.expectedRawCount) ||
			receipt.expectedRawCount < 0 ||
			!Number.isSafeInteger(receipt.observedRawCount) ||
			receipt.observedRawCount < 0 ||
			!/^[a-f0-9]{64}$/.test(receipt.contentFingerprint)
		)
			throw new Error("Native watch scope receipt is invalid");
		receiptKeys.add(key);
	}
	if (
		input.candidates.some(
			(candidate) => !receiptKeys.has(`${candidate.userKeyDigest}\0${candidate.libraryId}`),
		)
	)
		throw new Error("Native watch candidate has no scope receipt");
	const prior = await tx.jellyfinNativeWatchPublication.findUnique({
		where: { instanceId: input.instanceId },
	});
	if (prior?.activeRunId === input.runId) return;
	if (prior && prior.activeObservedAt > input.observedAt)
		throw new Error("Native watch publication is older than the active generation");
	for (let start = 0; start < input.candidates.length; start += PUBLICATION_CHUNK_SIZE) {
		await tx.jellyfinNativeWatchRow.createMany({
			data: input.candidates.slice(start, start + PUBLICATION_CHUNK_SIZE).map((candidate) => ({
				instanceId: input.instanceId,
				runId: input.runId,
				...candidate,
				observedAt: input.observedAt,
				connectionGeneration: input.connectionGeneration,
				identityGeneration: input.identityGeneration,
			})),
		});
	}
	await tx.jellyfinNativeWatchScopeReceipt.createMany({
		data: input.receipts.map((receipt) => ({
			instanceId: input.instanceId,
			runId: input.runId,
			...receipt,
			diagnosticsJson: diagnosticJson(receipt.diagnosticsJson),
			observedAt: input.observedAt,
			connectionGeneration: input.connectionGeneration,
			identityGeneration: input.identityGeneration,
		})),
	});
	const keepsPrior =
		prior?.connectionGeneration === input.connectionGeneration &&
		prior.identityGeneration === input.identityGeneration;
	const pointer = {
		activeRunId: input.runId,
		activeCacheGenerationId: input.cacheGenerationId,
		activeObservedAt: input.observedAt,
		activeExpectedScopeCount: input.expectedScopeCount,
		previousRunId: keepsPrior ? prior.activeRunId : null,
		previousObservedAt: keepsPrior ? prior.activeObservedAt : null,
		previousExpectedScopeCount: keepsPrior ? prior.activeExpectedScopeCount : null,
		connectionGeneration: input.connectionGeneration,
		identityGeneration: input.identityGeneration,
	};
	if (prior) {
		const updated = await tx.jellyfinNativeWatchPublication.updateMany({
			where: {
				instanceId: input.instanceId,
				activeRunId: prior.activeRunId,
				activeCacheGenerationId: prior.activeCacheGenerationId,
				connectionGeneration: prior.connectionGeneration,
				identityGeneration: prior.identityGeneration,
			},
			data: pointer,
		});
		if (updated.count !== 1) throw new Error("Native watch publication pointer was superseded");
	} else {
		await tx.jellyfinNativeWatchPublication.create({
			data: { instanceId: input.instanceId, ...pointer },
		});
	}
	const retainedRunIds = [input.runId, ...(pointer.previousRunId ? [pointer.previousRunId] : [])];
	await tx.jellyfinNativeWatchScopeReceipt.deleteMany({
		where: { instanceId: input.instanceId, runId: { notIn: retainedRunIds } },
	});
}

/**
 * Reclaims large, no-longer-authoritative tables after the generation pointer
 * has committed. Each statement is bounded so SQLite health checks can proceed
 * between batches; an interrupted cleanup can safely resume on the next pass.
 */
export async function cleanupPublishedJellyfinEpisodeArtifacts(
	prisma: PrismaClient,
	instanceId: string,
	runId: string,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	options.signal?.throwIfAborted();
	const terminal = await prisma.providerObservationRun.findFirst({
		where: {
			id: runId,
			instanceId,
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			state: { in: ["complete", "invalidated"] },
		},
		select: { id: true },
	});
	options.signal?.throwIfAborted();
	if (!terminal) return;
	for (;;) {
		options.signal?.throwIfAborted();
		const deleted = await prisma.$executeRaw`
			DELETE FROM "jellyfin_episode_observation_stage"
			WHERE "id" IN (
				SELECT stage."id"
				FROM "jellyfin_episode_observation_stage" AS stage
				JOIN "provider_observation_runs" AS run ON run."id" = stage."runId"
				WHERE stage."runId" = ${runId}
					AND run."instanceId" = ${instanceId}
					AND run."state" IN ('complete', 'invalidated')
				LIMIT ${CLEANUP_BATCH_SIZE}
			)
		`;
		options.signal?.throwIfAborted();
		if (deleted === 0) break;
		await yieldBetweenCleanupBatches();
	}
	for (;;) {
		options.signal?.throwIfAborted();
		const deleted = await prisma.$executeRaw`
			DELETE FROM "jellyfin_episode_observation_exclusions"
			WHERE "id" IN (
				SELECT exclusion."id"
				FROM "jellyfin_episode_observation_exclusions" AS exclusion
				JOIN "provider_observation_runs" AS run ON run."id" = exclusion."runId"
				WHERE exclusion."runId" = ${runId}
					AND run."instanceId" = ${instanceId}
					AND run."state" IN ('complete', 'invalidated')
				LIMIT ${CLEANUP_BATCH_SIZE}
			)
		`;
		options.signal?.throwIfAborted();
		if (deleted === 0) break;
		await yieldBetweenCleanupBatches();
	}
	for (;;) {
		options.signal?.throwIfAborted();
		const deleted = await prisma.$executeRaw`
			DELETE FROM "jellyfin_native_watch_rows"
			WHERE "id" IN (
				SELECT row."id"
				FROM "jellyfin_native_watch_rows" AS row
				JOIN "provider_observation_runs" AS run
					ON run."id" = row."runId" AND run."instanceId" = row."instanceId"
				LEFT JOIN "jellyfin_native_watch_publications" AS pointer
					ON pointer."instanceId" = row."instanceId"
				WHERE row."instanceId" = ${instanceId}
					AND run."provider" = 'jellyfin_episode'
					AND run."cacheType" = 'jellyfin_episode'
					AND run."state" IN ('complete', 'invalidated')
					AND (pointer."instanceId" IS NULL OR (
						row."runId" <> pointer."activeRunId"
						AND (pointer."previousRunId" IS NULL
							OR row."runId" <> pointer."previousRunId")))
				LIMIT ${CLEANUP_BATCH_SIZE}
			)
		`;
		options.signal?.throwIfAborted();
		if (deleted === 0) break;
		await yieldBetweenCleanupBatches();
	}
	for (;;) {
		options.signal?.throwIfAborted();
		const deleted = await prisma.$executeRaw`
			DELETE FROM "jellyfin_native_watch_scope_receipts"
			WHERE "id" IN (
				SELECT receipt."id"
				FROM "jellyfin_native_watch_scope_receipts" AS receipt
				JOIN "provider_observation_runs" AS run
					ON run."id" = receipt."runId" AND run."instanceId" = receipt."instanceId"
				LEFT JOIN "jellyfin_native_watch_publications" AS pointer
					ON pointer."instanceId" = receipt."instanceId"
				WHERE receipt."instanceId" = ${instanceId}
					AND run."provider" = 'jellyfin_episode'
					AND run."cacheType" = 'jellyfin_episode'
					AND run."state" IN ('complete', 'invalidated')
					AND (pointer."instanceId" IS NULL OR (
						receipt."runId" <> pointer."activeRunId"
						AND (pointer."previousRunId" IS NULL
							OR receipt."runId" <> pointer."previousRunId")))
				LIMIT ${CLEANUP_BATCH_SIZE}
			)
		`;
		options.signal?.throwIfAborted();
		if (deleted === 0) break;
		await yieldBetweenCleanupBatches();
	}
}

/**
 * Replays post-commit cleanup after an interrupted process. A completed run is
 * immutable and no longer needs its observation staging; the live pointer is
 * also checked so retired watch generations are pruned even when staging had
 * already been reclaimed before the interruption.
 */
export async function cleanupCompletedJellyfinEpisodeArtifacts(
	prisma: PrismaClient,
	instanceId: string,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	for (;;) {
		options.signal?.throwIfAborted();
		const stageRuns = await prisma.$queryRaw<Array<{ runId: string }>>`
		SELECT DISTINCT stage."runId" AS "runId"
		FROM "jellyfin_episode_observation_stage" AS stage
		JOIN "provider_observation_runs" AS run ON run."id" = stage."runId"
		WHERE run."instanceId" = ${instanceId}
			AND run."cacheType" = 'jellyfin_episode'
			AND run."state" IN ('complete', 'invalidated')
		LIMIT 32
	`;
		options.signal?.throwIfAborted();
		const exclusionRuns = await prisma.$queryRaw<Array<{ runId: string }>>`
		SELECT DISTINCT exclusion."runId" AS "runId"
		FROM "jellyfin_episode_observation_exclusions" AS exclusion
		JOIN "provider_observation_runs" AS run ON run."id" = exclusion."runId"
		WHERE run."instanceId" = ${instanceId}
			AND run."cacheType" = 'jellyfin_episode'
			AND run."state" IN ('complete', 'invalidated')
		LIMIT 32
	`;
		options.signal?.throwIfAborted();
		const retiredRowRuns = await prisma.$queryRaw<Array<{ runId: string }>>`
		SELECT DISTINCT row."runId" AS "runId"
		FROM "jellyfin_native_watch_rows" AS row
		JOIN "provider_observation_runs" AS run
			ON run."id" = row."runId" AND run."instanceId" = row."instanceId"
		LEFT JOIN "jellyfin_native_watch_publications" AS pointer
			ON pointer."instanceId" = row."instanceId"
		WHERE row."instanceId" = ${instanceId}
			AND run."provider" = 'jellyfin_episode'
			AND run."cacheType" = 'jellyfin_episode'
			AND run."state" IN ('complete', 'invalidated')
			AND (pointer."instanceId" IS NULL OR (
				row."runId" <> pointer."activeRunId"
				AND (pointer."previousRunId" IS NULL
					OR row."runId" <> pointer."previousRunId")))
		LIMIT 32
	`;
		options.signal?.throwIfAborted();
		const retiredReceiptRuns = await prisma.$queryRaw<Array<{ runId: string }>>`
		SELECT DISTINCT receipt."runId" AS "runId"
		FROM "jellyfin_native_watch_scope_receipts" AS receipt
		JOIN "provider_observation_runs" AS run
			ON run."id" = receipt."runId" AND run."instanceId" = receipt."instanceId"
		LEFT JOIN "jellyfin_native_watch_publications" AS pointer
			ON pointer."instanceId" = receipt."instanceId"
		WHERE receipt."instanceId" = ${instanceId}
			AND run."provider" = 'jellyfin_episode'
			AND run."cacheType" = 'jellyfin_episode'
			AND run."state" IN ('complete', 'invalidated')
			AND (pointer."instanceId" IS NULL OR (
				receipt."runId" <> pointer."activeRunId"
				AND (pointer."previousRunId" IS NULL
					OR receipt."runId" <> pointer."previousRunId")))
		LIMIT 32
	`;
		options.signal?.throwIfAborted();
		const runIds = new Set([
			...stageRuns.map((row) => row.runId),
			...exclusionRuns.map((row) => row.runId),
			...retiredRowRuns.map((row) => row.runId),
			...retiredReceiptRuns.map((row) => row.runId),
		]);
		if (runIds.size === 0) break;
		for (const runId of runIds)
			await cleanupPublishedJellyfinEpisodeArtifacts(prisma, instanceId, runId, options);
	}
	options.signal?.throwIfAborted();
	const pointer = await prisma.jellyfinNativeWatchPublication.findUnique({
		where: { instanceId },
		select: { activeRunId: true },
	});
	options.signal?.throwIfAborted();
	if (pointer)
		await cleanupPublishedJellyfinEpisodeArtifacts(
			prisma,
			instanceId,
			pointer.activeRunId,
			options,
		);
}
