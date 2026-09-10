import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClientInstance } from "../prisma.js";
import {
	type HistoryCollectionLeaseClaim,
	withHistoryCollectionLeaseAuthority,
} from "./history-collection-lease.js";
import { HISTORY_SERVICE_TYPES, isHistoryServiceType } from "./history-source-contract.js";
import {
	deriveHistorySourceFailureSuccessor,
	type HistorySourcePhase,
	type HistorySourceSchedule,
	historySourceScheduleToDatabase,
	parseHistorySourceRunningSchedule,
	parseHistorySourceTerminalSchedule,
} from "./history-source-schedule.js";

export const HISTORY_SOURCE_ATTEMPT_FAILURE_REASONS = [
	"provider-unavailable",
	"provider-limit",
	"rows-inconsistent",
	"receipt-invalid",
	"unknown-failure",
] as const;
export const HISTORY_PUBLICATION_REVISION_MAX = 2_147_483_647;
export function isValidHistoryPublicationRevision(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= HISTORY_PUBLICATION_REVISION_MAX
	);
}
export type HistorySourceAttemptFailureReason =
	(typeof HISTORY_SOURCE_ATTEMPT_FAILURE_REASONS)[number];
export const HISTORY_SOURCE_ATTEMPT_TERMINAL_REASONS = [
	...HISTORY_SOURCE_ATTEMPT_FAILURE_REASONS,
	"collection-deferred",
] as const;
export type HistorySourceAttemptTerminalReason =
	(typeof HISTORY_SOURCE_ATTEMPT_TERMINAL_REASONS)[number];
export type HistorySourceAttemptMarker =
	| `in_progress:v1:${string}:${string}`
	| `in_progress:v2:prepared:${string}:${string}`
	| `in_progress:v2:started:${string}:${string}`;
export type HistorySourceAttemptFields = {
	userId: string;
	instanceId: string;
	connectionGeneration: number;
	attemptedAt: Date;
	phase: HistorySourcePhase;
	collectionPage: number;
	backfillPage: number;
};
export type HistorySourceAttempt = HistorySourceAttemptFields & {
	resultMarker: HistorySourceAttemptMarker;
};
export type HistorySourceProviderPreparedAttempt = HistorySourceAttemptFields & {
	resultMarker: HistorySourcePreparedAttemptMarker;
};
export type HistorySourceProviderStartedAttempt = HistorySourceAttemptFields & {
	resultMarker: HistorySourceStartedAttemptMarker;
};
export type HistorySourcePreparedAttemptMarker = `in_progress:v2:prepared:${string}:${string}`;
export type HistorySourceStartedAttemptMarker = `in_progress:v2:started:${string}:${string}`;
export type HistorySourceAttemptProjection =
	| { valid: true; state: "idle"; attemptedAt: null; reason: null }
	| { valid: true; state: "running"; attemptedAt: Date; reason: null }
	| { valid: true; state: "successful"; attemptedAt: Date; reason: null }
	| {
			valid: true;
			state: "failed";
			attemptedAt: Date;
			reason: HistorySourceAttemptTerminalReason;
	  }
	| { valid: false };
export type HistorySourceAttemptOptions = { dialect?: "sqlite" | "postgresql" };

type SourceAttemptPrisma = Pick<
	PrismaClientInstance,
	"$executeRawUnsafe" | "$queryRawUnsafe" | "$transaction"
>;
type SourceAttemptTransaction = Prisma.TransactionClient;
type LeaseClaim = Pick<HistoryCollectionLeaseClaim, "userId" | "claimToken">;
type BeginInput = { userId: string; instanceId: string; leaseClaim: LeaseClaim };
type PublicFailureInput = HistorySourceAttempt & {
	leaseClaim: LeaseClaim;
	reason: HistorySourceAttemptFailureReason;
};
type CurrentTimestampRow = { now: unknown };
type SourceStatusRow = {
	instanceId: unknown;
	connectionGeneration: unknown;
	lastAttemptAt: unknown;
	lastAttemptResult: unknown;
	lastAttemptReason: unknown;
	collectHeadNext: unknown;
	nextBackfillPage: unknown;
	activeCollectionPage: unknown;
	publishedAt: unknown;
	publicationMetadata: unknown;
	retainedObservationCount: unknown;
	retentionEpoch: unknown;
	publicationRevision: unknown;
};
type DetailedAttemptDecode =
	| {
			valid: true;
			state: "idle";
			attemptedAt: null;
			lastAttemptResult: null;
			lastAttemptReason: null;
			running: null;
	  }
	| {
			valid: true;
			state: "successful";
			attemptedAt: Date;
			lastAttemptResult: "success";
			lastAttemptReason: null;
			running: null;
	  }
	| {
			valid: true;
			state: "failed";
			attemptedAt: Date;
			lastAttemptResult: "error";
			lastAttemptReason: HistorySourceAttemptTerminalReason;
			running: null;
	  }
	| {
			valid: true;
			state: "running";
			attemptedAt: Date;
			lastAttemptResult: HistorySourceAttemptMarker;
			lastAttemptReason: null;
			running: { fingerprint: string; stage: "legacy" | "prepared" | "started" };
	  }
	| { valid: false };

const CURRENT_TIMESTAMP_SQL = {
	sqlite: "SELECT CURRENT_TIMESTAMP AS now",
	postgresql: "SELECT CURRENT_TIMESTAMP AS now",
} as const;
const MARKER_PATTERN =
	/^in_progress:(v1|v2:(prepared|started)):([0-9a-f]{64}):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const ID_MAX_BYTES = 256;
const TOKEN_MAX_BYTES = 128;
class SourceAttemptInvariantError extends Error {
	constructor() {
		super("History source attempt invariant failed");
		this.name = "SourceAttemptInvariantError";
	}
}

export async function beginHistorySourceAttempt(
	prisma: SourceAttemptPrisma,
	input: BeginInput,
	options: HistorySourceAttemptOptions = {},
): Promise<HistorySourceProviderPreparedAttempt | null> {
	if (!isValidBeginInput(input)) return null;
	const dialect = resolveDialect(options.dialect);
	const fingerprint = fingerprintLease(input.leaseClaim.claimToken);
	const result =
		await withHistoryCollectionLeaseAuthority<HistorySourceProviderPreparedAttempt | null>(
			prisma,
			input.leaseClaim,
			async (tx) => {
				const instance = await tx.serviceInstance.findFirst({
					where: {
						id: input.instanceId,
						userId: input.userId,
						enabled: true,
						service: { in: [...HISTORY_SERVICE_TYPES] },
					},
					select: { id: true, service: true, connectionGeneration: true },
				});
				if (
					!instance ||
					!isHistoryServiceType(instance.service) ||
					!isSafeGeneration(instance.connectionGeneration)
				)
					return null;
				const existing = (await tx.historySourceStatus.findUnique({
					where: { instanceId: input.instanceId },
				})) as unknown as SourceStatusRow | null;
				const attemptedAt = await readDatabaseTimestamp(tx, dialect);
				if (!attemptedAt) return null;
				const parsed = parseStatus(existing, input.instanceId, instance.connectionGeneration);
				if (
					!parsed.valid ||
					!parsed.schedule ||
					!parsed.databaseSchedule ||
					parsed.running?.fingerprint === fingerprintLease(input.leaseClaim.claimToken)
				)
					return null;
				const publicationRevision = existing?.publicationRevision ?? 0;
				if (!isValidHistoryPublicationRevision(publicationRevision)) return null;
				if (parsed.lastAttemptAt && parsed.lastAttemptAt.getTime() > attemptedAt.getTime())
					return null;
				const successor =
					parsed.running && parsed.running.stage === "prepared"
						? parsed.running.schedule
						: parsed.running
							? deriveHistorySourceFailureSuccessor(parsed.running.schedule)
							: parsed.schedule;
				const marker = makePreparedMarker(fingerprint);
				const databaseSchedule = historySourceScheduleToDatabase(
					successor,
					successor.collectionPage,
				);
				if (!databaseSchedule) return null;
				if (existing === null) {
					await tx.historySourceStatus.create({
						data: {
							instanceId: input.instanceId,
							connectionGeneration: instance.connectionGeneration,
							lastAttemptAt: attemptedAt,
							lastAttemptResult: marker,
							lastAttemptReason: null,
							collectHeadNext: databaseSchedule.collectHeadNext,
							nextBackfillPage: databaseSchedule.nextBackfillPage,
							activeCollectionPage: databaseSchedule.activeCollectionPage,
						},
					});
				} else {
					const changed = await tx.historySourceStatus.updateMany({
						where: {
							instanceId: input.instanceId,
							connectionGeneration: instance.connectionGeneration,
							lastAttemptAt: parsed.lastAttemptAt,
							lastAttemptResult: parsed.lastAttemptResult,
							lastAttemptReason: parsed.lastAttemptReason,
							collectHeadNext: parsed.databaseSchedule.collectHeadNext,
							nextBackfillPage: parsed.databaseSchedule.nextBackfillPage,
							activeCollectionPage: parsed.databaseSchedule.activeCollectionPage,
							publicationRevision,
							instance: {
								id: input.instanceId,
								userId: input.userId,
								enabled: true,
								service: { in: [...HISTORY_SERVICE_TYPES] },
								connectionGeneration: instance.connectionGeneration,
							},
						},
						data: {
							lastAttemptAt: attemptedAt,
							lastAttemptResult: marker,
							lastAttemptReason: null,
							collectHeadNext: databaseSchedule.collectHeadNext,
							nextBackfillPage: databaseSchedule.nextBackfillPage,
							activeCollectionPage: databaseSchedule.activeCollectionPage,
						},
					});
					if (changed.count !== 1) return null;
				}
				const committed = (await tx.historySourceStatus.findUnique({
					where: { instanceId: input.instanceId },
				})) as unknown as SourceStatusRow | null;
				const storedAttemptAt = committed && parseDatabaseDate(committed.lastAttemptAt);
				if (
					!committed ||
					committed.connectionGeneration !== instance.connectionGeneration ||
					!storedAttemptAt ||
					committed.lastAttemptResult !== marker ||
					committed.lastAttemptReason !== null ||
					committed.collectHeadNext !== databaseSchedule.collectHeadNext ||
					committed.nextBackfillPage !== databaseSchedule.nextBackfillPage ||
					committed.activeCollectionPage !== databaseSchedule.activeCollectionPage ||
					committed.publicationRevision !== publicationRevision
				)
					return null;
				return {
					userId: input.userId,
					instanceId: input.instanceId,
					connectionGeneration: instance.connectionGeneration,
					attemptedAt: storedAttemptAt,
					resultMarker: marker,
					phase: successor.phase,
					collectionPage: successor.collectionPage,
					backfillPage: successor.backfillPage,
				};
			},
			options,
		);
	return result.matched ? result.value : null;
}

export function decodeHistorySourceAttemptProjection(
	lastAttemptAt: unknown,
	lastAttemptResult: unknown,
	lastAttemptReason: unknown,
): HistorySourceAttemptProjection {
	const decoded = decodeAttemptFields(lastAttemptAt, lastAttemptResult, lastAttemptReason);
	if (!decoded.valid) return { valid: false };
	if (decoded.state === "idle") {
		return { valid: true, state: "idle", attemptedAt: null, reason: null };
	}
	if (decoded.state === "successful") {
		return {
			valid: true,
			state: "successful",
			attemptedAt: new Date(decoded.attemptedAt.getTime()),
			reason: null,
		};
	}
	if (decoded.state === "failed") {
		return {
			valid: true,
			state: "failed",
			attemptedAt: new Date(decoded.attemptedAt.getTime()),
			reason: decoded.lastAttemptReason,
		};
	}
	return {
		valid: true,
		state: "running",
		attemptedAt: new Date(decoded.attemptedAt.getTime()),
		reason: null,
	};
}

export async function finishHistorySourceAttemptFailure(
	prisma: SourceAttemptPrisma,
	input: PublicFailureInput,
	options: HistorySourceAttemptOptions = {},
): Promise<"recorded" | "superseded" | "failed"> {
	if (!isValidFailureInput(input)) return "failed";
	try {
		const result = await withHistoryCollectionLeaseAuthority<"recorded" | "superseded" | "failed">(
			prisma,
			input.leaseClaim,
			async (tx) => await finishHistorySourceAttemptFailureInTransaction(tx, input, options),
			options,
		);
		return result.matched ? result.value : "superseded";
	} catch {
		return "failed";
	}
}

export async function markHistorySourceAttemptProviderStarted(
	prisma: SourceAttemptPrisma,
	input: HistorySourceProviderPreparedAttempt & { leaseClaim: LeaseClaim },
	options: HistorySourceAttemptOptions = {},
): Promise<
	| { kind: "started"; attempt: HistorySourceProviderStartedAttempt }
	| { kind: "superseded" | "failed" }
> {
	if (!isValidPreparedInput(input)) return { kind: "failed" };
	try {
		const result = await withHistoryCollectionLeaseAuthority(
			prisma,
			input.leaseClaim,
			async (tx) => {
				const now = await readDatabaseTimestamp(tx, resolveDialect(options.dialect));
				if (!now || input.attemptedAt.getTime() > now.getTime()) return { kind: "failed" as const };
				const schedule = historySourceScheduleToDatabase(input, input.collectionPage);
				if (!schedule) return { kind: "failed" as const };
				const before = (await tx.historySourceStatus.findUnique({
					where: { instanceId: input.instanceId },
				})) as unknown as SourceStatusRow | null;
				if (!before) return { kind: "superseded" as const };
				if (!isValidHistoryPublicationRevision(before.publicationRevision))
					return { kind: "failed" as const };
				const startedMarker = toStartedMarker(input.resultMarker);
				const changed = await tx.historySourceStatus.updateMany({
					where: exactAttemptWhere(input, schedule, before.publicationRevision),
					data: { lastAttemptResult: startedMarker },
				});
				if (changed.count !== 1) return { kind: "superseded" as const };
				const committed = (await tx.historySourceStatus.findUnique({
					where: { instanceId: input.instanceId },
				})) as unknown as SourceStatusRow | null;
				const committedAt = committed && parseDatabaseDate(committed.lastAttemptAt);
				if (
					!committed ||
					!committedAt ||
					committedAt.getTime() !== input.attemptedAt.getTime() ||
					committed.lastAttemptResult !== startedMarker ||
					committed.lastAttemptReason !== null ||
					committed.collectHeadNext !== schedule.collectHeadNext ||
					committed.nextBackfillPage !== schedule.nextBackfillPage ||
					committed.activeCollectionPage !== schedule.activeCollectionPage ||
					!samePersistedDate(committed.publishedAt, before.publishedAt) ||
					committed.publicationMetadata !== before.publicationMetadata ||
					committed.retainedObservationCount !== before.retainedObservationCount ||
					committed.retentionEpoch !== before.retentionEpoch ||
					committed.publicationRevision !== before.publicationRevision
				)
					throw new SourceAttemptInvariantError();
				const { leaseClaim: _leaseClaim, ...attemptFields } = input;
				return {
					kind: "started" as const,
					attempt: { ...attemptFields, attemptedAt: committedAt, resultMarker: startedMarker },
				};
			},
			options,
		);
		return result.matched ? result.value : { kind: "superseded" };
	} catch {
		return { kind: "failed" };
	}
}

export async function deferHistorySourceAttemptBeforeProvider(
	prisma: SourceAttemptPrisma,
	input: HistorySourceProviderPreparedAttempt & { leaseClaim: LeaseClaim },
	options: HistorySourceAttemptOptions = {},
): Promise<"recorded" | "superseded" | "failed"> {
	if (!isValidPreparedInput(input)) return "failed";
	try {
		const result = await withHistoryCollectionLeaseAuthority(
			prisma,
			input.leaseClaim,
			async (tx) => {
				const now = await readDatabaseTimestamp(tx, resolveDialect(options.dialect));
				if (!now || input.attemptedAt.getTime() > now.getTime()) return "failed" as const;
				const running = historySourceScheduleToDatabase(input, input.collectionPage);
				const terminal = historySourceScheduleToDatabase(input, null);
				if (!running || !terminal) return "failed" as const;
				const before = (await tx.historySourceStatus.findUnique({
					where: { instanceId: input.instanceId },
				})) as unknown as SourceStatusRow | null;
				if (!before) return "superseded" as const;
				if (!isValidHistoryPublicationRevision(before.publicationRevision))
					return "failed" as const;
				const changed = await tx.historySourceStatus.updateMany({
					where: exactAttemptWhere(input, running, before.publicationRevision),
					data: {
						lastAttemptResult: "error",
						lastAttemptReason: "collection-deferred",
						collectHeadNext: terminal.collectHeadNext,
						nextBackfillPage: terminal.nextBackfillPage,
						activeCollectionPage: null,
					},
				});
				if (changed.count !== 1) return "superseded";
				const committed = (await tx.historySourceStatus.findUnique({
					where: { instanceId: input.instanceId },
				})) as unknown as SourceStatusRow | null;
				const committedAt = committed && parseDatabaseDate(committed.lastAttemptAt);
				if (
					!committed ||
					!committedAt ||
					committedAt.getTime() !== input.attemptedAt.getTime() ||
					committed.lastAttemptResult !== "error" ||
					committed.lastAttemptReason !== "collection-deferred" ||
					committed.collectHeadNext !== terminal.collectHeadNext ||
					committed.nextBackfillPage !== terminal.nextBackfillPage ||
					committed.activeCollectionPage !== null ||
					!samePersistedDate(committed.publishedAt, before.publishedAt) ||
					committed.publicationMetadata !== before.publicationMetadata ||
					committed.retainedObservationCount !== before.retainedObservationCount ||
					committed.retentionEpoch !== before.retentionEpoch ||
					committed.publicationRevision !== before.publicationRevision
				)
					throw new SourceAttemptInvariantError();
				return "recorded";
			},
			options,
		);
		return result.matched ? result.value : "superseded";
	} catch {
		return "failed";
	}
}

async function finishHistorySourceAttemptFailureInTransaction(
	tx: SourceAttemptTransaction,
	input: PublicFailureInput,
	options: HistorySourceAttemptOptions = {},
): Promise<"recorded" | "superseded" | "failed"> {
	if (!isValidFailureInput(input)) return "failed";
	const now = await readDatabaseTimestamp(tx, resolveDialect(options.dialect));
	if (!now || input.attemptedAt.getTime() > now.getTime()) return "failed";
	const originalSchedule = {
		phase: input.phase,
		collectionPage: input.collectionPage,
		backfillPage: input.backfillPage,
	} satisfies HistorySourceSchedule;
	const originalDatabaseSchedule = historySourceScheduleToDatabase(
		originalSchedule,
		input.collectionPage,
	);
	const successor = deriveHistorySourceFailureSuccessor(originalSchedule);
	const successorDatabaseSchedule = historySourceScheduleToDatabase(successor, null);
	if (!originalDatabaseSchedule || !successorDatabaseSchedule) return "failed";
	const before = await tx.historySourceStatus.findFirst({
		where: {
			instanceId: input.instanceId,
			connectionGeneration: input.connectionGeneration,
			instance: {
				id: input.instanceId,
				userId: input.userId,
				enabled: true,
				service: { in: [...HISTORY_SERVICE_TYPES] },
				connectionGeneration: input.connectionGeneration,
			},
		},
		select: { publicationRevision: true },
	});
	if (!before) return "superseded";
	if (!isValidHistoryPublicationRevision(before.publicationRevision)) return "failed";
	const changed = await tx.historySourceStatus.updateMany({
		where: {
			instanceId: input.instanceId,
			connectionGeneration: input.connectionGeneration,
			lastAttemptAt: input.attemptedAt,
			lastAttemptResult: input.resultMarker,
			lastAttemptReason: null,
			collectHeadNext: originalDatabaseSchedule.collectHeadNext,
			nextBackfillPage: originalDatabaseSchedule.nextBackfillPage,
			activeCollectionPage: originalDatabaseSchedule.activeCollectionPage,
			publicationRevision: before.publicationRevision,
			instance: {
				id: input.instanceId,
				userId: input.userId,
				enabled: true,
				service: { in: [...HISTORY_SERVICE_TYPES] },
				connectionGeneration: input.connectionGeneration,
			},
		},
		data: {
			lastAttemptResult: "error",
			lastAttemptReason: input.reason,
			collectHeadNext: successorDatabaseSchedule.collectHeadNext,
			nextBackfillPage: successorDatabaseSchedule.nextBackfillPage,
			activeCollectionPage: null,
		},
	});
	return changed.count === 1 ? "recorded" : "superseded";
}

async function readDatabaseTimestamp(
	tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe"> | SourceAttemptPrisma,
	dialect: "sqlite" | "postgresql",
): Promise<Date | null> {
	const rows = await tx.$queryRawUnsafe<CurrentTimestampRow[]>(CURRENT_TIMESTAMP_SQL[dialect]);
	return parseDatabaseDate(rows[0]?.now);
}

function parseStatus(
	status: SourceStatusRow | null,
	instanceId: string,
	connectionGeneration: number,
): {
	valid: boolean;
	schedule: HistorySourceSchedule | null;
	databaseSchedule: ReturnType<typeof historySourceScheduleToDatabase>;
	lastAttemptAt: Date | null;
	lastAttemptResult: string | null;
	lastAttemptReason: string | null;
	running: {
		fingerprint: string;
		stage: "legacy" | "prepared" | "started";
		schedule: HistorySourceSchedule;
	} | null;
} {
	if (!status)
		return {
			valid: true,
			schedule: { phase: "head", collectionPage: 1, backfillPage: 2 },
			databaseSchedule: { collectHeadNext: true, nextBackfillPage: 2, activeCollectionPage: null },
			lastAttemptAt: null,
			lastAttemptResult: null,
			lastAttemptReason: null,
			running: null,
		};
	if (
		status.instanceId !== instanceId ||
		status.connectionGeneration !== connectionGeneration ||
		!isValidHistoryPublicationRevision(status.publicationRevision)
	)
		return {
			valid: false,
			schedule: null,
			databaseSchedule: null,
			lastAttemptAt: null,
			lastAttemptResult: null,
			lastAttemptReason: null,
			running: null,
		};
	const decoded = decodeAttemptFields(
		status.lastAttemptAt,
		status.lastAttemptResult,
		status.lastAttemptReason,
	);
	if (decoded.valid) {
		const storedDatabaseSchedule = {
			collectHeadNext: status.collectHeadNext,
			nextBackfillPage: status.nextBackfillPage,
			activeCollectionPage: status.activeCollectionPage,
		};
		const parsedSchedule =
			decoded.state === "running"
				? parseHistorySourceRunningSchedule(storedDatabaseSchedule)
				: parseHistorySourceTerminalSchedule(storedDatabaseSchedule);
		if (!parsedSchedule.valid)
			return {
				valid: false,
				schedule: null,
				databaseSchedule: null,
				lastAttemptAt: null,
				lastAttemptResult: null,
				lastAttemptReason: null,
				running: null,
			};
		return {
			valid: true,
			schedule: parsedSchedule.schedule,
			databaseSchedule: historySourceScheduleToDatabase(
				parsedSchedule.schedule,
				decoded.state === "running" ? parsedSchedule.schedule.collectionPage : null,
			),
			lastAttemptAt: decoded.attemptedAt,
			lastAttemptResult: decoded.lastAttemptResult,
			lastAttemptReason: decoded.lastAttemptReason,
			running: decoded.running ? { ...decoded.running, schedule: parsedSchedule.schedule } : null,
		};
	}
	return {
		valid: false,
		schedule: null,
		databaseSchedule: null,
		lastAttemptAt: null,
		lastAttemptResult: null,
		lastAttemptReason: null,
		running: null,
	};
}

function decodeAttemptFields(
	lastAttemptAt: unknown,
	lastAttemptResult: unknown,
	lastAttemptReason: unknown,
): DetailedAttemptDecode {
	if (lastAttemptAt === null && lastAttemptResult === null && lastAttemptReason === null) {
		return {
			valid: true,
			state: "idle",
			attemptedAt: null,
			lastAttemptResult: null,
			lastAttemptReason: null,
			running: null,
		};
	}
	const attemptedAt = parseDatabaseDate(lastAttemptAt);
	if (!attemptedAt || typeof lastAttemptResult !== "string") return { valid: false };
	if (lastAttemptResult === "success" && lastAttemptReason === null) {
		return {
			valid: true,
			state: "successful",
			attemptedAt,
			lastAttemptResult,
			lastAttemptReason: null,
			running: null,
		};
	}
	if (lastAttemptResult === "error" && isTerminalReason(lastAttemptReason)) {
		return {
			valid: true,
			state: "failed",
			attemptedAt,
			lastAttemptResult,
			lastAttemptReason,
			running: null,
		};
	}
	const marker = parseMarker(lastAttemptResult);
	if (marker && lastAttemptReason === null) {
		return {
			valid: true,
			state: "running",
			attemptedAt,
			lastAttemptResult: lastAttemptResult as HistorySourceAttemptMarker,
			lastAttemptReason: null,
			running: marker,
		};
	}
	return { valid: false };
}

function isValidBeginInput(input: BeginInput): boolean {
	return (
		isSafeIdentifier(input.userId) &&
		isSafeIdentifier(input.instanceId) &&
		isValidLeaseClaim(input.leaseClaim) &&
		input.userId === input.leaseClaim.userId
	);
}
function isValidFailureInput(input: PublicFailureInput): boolean {
	if (!isValidFinishShape(input) || !isFailureReason(input.reason)) return false;
	return (
		parseMarker(input.resultMarker)?.stage !== "prepared" || input.reason === "unknown-failure"
	);
}
function isValidPreparedInput(
	input: unknown,
): input is HistorySourceProviderPreparedAttempt & { leaseClaim: LeaseClaim } {
	if (!isRecord(input)) return false;
	return (
		isValidFinishShape(input as HistorySourceAttempt & { leaseClaim: LeaseClaim }) &&
		parseMarker((input as { resultMarker: unknown }).resultMarker as string)?.stage === "prepared"
	);
}
function isValidFinishShape(input: HistorySourceAttempt & { leaseClaim: LeaseClaim }): boolean {
	return (
		isSafeIdentifier(input.userId) &&
		isSafeIdentifier(input.instanceId) &&
		isSafeGeneration(input.connectionGeneration) &&
		isValidLeaseClaim(input.leaseClaim) &&
		input.userId === input.leaseClaim.userId &&
		input.attemptedAt instanceof Date &&
		Number.isFinite(input.attemptedAt.getTime()) &&
		isValidMarkerForClaim(input.resultMarker, input.leaseClaim.claimToken) &&
		historySourceScheduleToDatabase(
			{
				phase: input.phase,
				collectionPage: input.collectionPage,
				backfillPage: input.backfillPage,
			},
			input.collectionPage,
		) !== null
	);
}
function isValidLeaseClaim(claim: unknown): claim is LeaseClaim {
	if (!isRecord(claim)) return false;
	return isSafeIdentifier(claim.userId) && isSafeToken(claim.claimToken);
}
function isSafeIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!containsControl(value) &&
		Buffer.byteLength(value, "utf8") <= ID_MAX_BYTES
	);
}
function isSafeToken(value: unknown): value is string {
	return isSafeIdentifier(value) && Buffer.byteLength(value, "utf8") <= TOKEN_MAX_BYTES;
}
function isSafeGeneration(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isValidMarkerForClaim(
	value: unknown,
	claimToken: string,
): value is HistorySourceAttemptMarker {
	return (
		typeof value === "string" && parseMarker(value)?.fingerprint === fingerprintLease(claimToken)
	);
}
export function parseHistorySourceAttemptMarker(
	value: unknown,
): { fingerprint: string; stage: "legacy" | "prepared" | "started"; uuid: string } | null {
	if (typeof value !== "string") return null;
	const match = MARKER_PATTERN.exec(value);
	if (!match?.[1] || !match[3] || !match[4]) return null;
	return {
		fingerprint: match[3],
		stage: match[1] === "v1" ? "legacy" : (match[2] as "prepared" | "started"),
		uuid: match[4],
	};
}
function parseMarker(value: string) {
	return parseHistorySourceAttemptMarker(value);
}
function isFailureReason(value: unknown): value is HistorySourceAttemptFailureReason {
	return (
		typeof value === "string" &&
		(HISTORY_SOURCE_ATTEMPT_FAILURE_REASONS as readonly string[]).includes(value)
	);
}
function isTerminalReason(value: unknown): value is HistorySourceAttemptTerminalReason {
	return (
		typeof value === "string" &&
		(HISTORY_SOURCE_ATTEMPT_TERMINAL_REASONS as readonly string[]).includes(value)
	);
}
export function isStartedHistorySourceAttempt(
	attempt: HistorySourceAttempt,
): attempt is HistorySourceProviderStartedAttempt {
	return parseMarker(attempt.resultMarker)?.stage === "started";
}
export function isStartedHistorySourceAttemptForClaim(
	attempt: HistorySourceAttempt,
	claimToken: string,
): attempt is HistorySourceProviderStartedAttempt {
	return (
		isStartedHistorySourceAttempt(attempt) &&
		isValidMarkerForClaim(attempt.resultMarker, claimToken)
	);
}
export function isPreparedHistorySourceAttempt(
	attempt: HistorySourceAttempt,
): attempt is HistorySourceProviderPreparedAttempt {
	return parseMarker(attempt.resultMarker)?.stage === "prepared";
}
function fingerprintLease(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}
function makePreparedMarker(fingerprint: string): HistorySourcePreparedAttemptMarker {
	return `in_progress:v2:prepared:${fingerprint}:${randomUUID()}`;
}
function toStartedMarker(
	marker: HistorySourcePreparedAttemptMarker,
): HistorySourceStartedAttemptMarker {
	return marker.replace(":prepared:", ":started:") as HistorySourceStartedAttemptMarker;
}
function exactAttemptWhere(
	input: HistorySourceAttempt & { leaseClaim: LeaseClaim },
	schedule: NonNullable<ReturnType<typeof historySourceScheduleToDatabase>>,
	publicationRevision: number,
) {
	return {
		instanceId: input.instanceId,
		connectionGeneration: input.connectionGeneration,
		lastAttemptAt: input.attemptedAt,
		lastAttemptResult: input.resultMarker,
		lastAttemptReason: null,
		collectHeadNext: schedule.collectHeadNext,
		nextBackfillPage: schedule.nextBackfillPage,
		activeCollectionPage: schedule.activeCollectionPage,
		publicationRevision,
		instance: {
			id: input.instanceId,
			userId: input.userId,
			enabled: true,
			service: { in: [...HISTORY_SERVICE_TYPES] },
			connectionGeneration: input.connectionGeneration,
		},
	};
}
function parseDatabaseDate(value: unknown): Date | null {
	if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
	if (typeof value !== "string" || value.length === 0) return null;
	const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
	const date = new Date(normalized);
	return Number.isFinite(date.getTime()) ? date : null;
}
function samePersistedDate(left: unknown, right: unknown): boolean {
	if (left === null || right === null) return left === right;
	const leftDate = parseDatabaseDate(left);
	const rightDate = parseDatabaseDate(right);
	return leftDate !== null && rightDate !== null && leftDate.getTime() === rightDate.getTime();
}
function containsControl(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function resolveDialect(dialect?: "sqlite" | "postgresql"): "sqlite" | "postgresql" {
	return (
		dialect ??
		(/^postgres(?:ql)?:\/\//i.test(process.env.DATABASE_URL ?? "") ? "postgresql" : "sqlite")
	);
}
