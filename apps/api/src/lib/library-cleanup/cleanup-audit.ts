import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../prisma.js";
import type { CleanupRunResult } from "./types.js";

const AUDIT_RETENTION_EVENTS = 10_000;
const AUDIT_TIMELINE_EVENT_LIMIT = 1_000;
const AUDIT_RETENTION_GROUP_PAGE = 250;
const AUDIT_RETENTION_DELETE_BATCH = 250;
const AUDIT_PROTECTED_COMPACTION_SCAN_LIMIT = 25;
const AUDIT_TRANSACTION_RETRIES = 6;

const DURABLY_CLOSED_EVENT_TYPES = new Set([
	"approval_rejected",
	"approval_expired",
	"terminal_succeeded",
	"reconciled_without_mutation",
	"safety_blocked",
	"candidate_flagged",
	"media_rescan_triggered",
	"media_rescan_skipped",
	"media_rescan_completed",
]);
const REQUIRED_NONTERMINAL_EVIDENCE_TYPES = [
	"candidate_selected",
	"approval_pending",
	"approval_approved",
	"execution_claimed",
	"mutation_prepared",
	"execution_deferred",
	"execution_incomplete",
	"retry_pending",
	"recovery_transition",
	"media_rescan_pending",
	"media_rescan_failed",
] as const;

type AuditOutcome = "info" | "success" | "blocked" | "failed";
type AuditTrigger = "scheduled" | "manual" | "approval" | "retry" | "recovery";
type AuditActorType = "operator" | "scheduler" | "system";

export interface CleanupAuditApprovalSnapshot {
	id: string;
	configId: string;
	instanceId: string;
	arrItemId: number;
	itemType: string;
	targetScope: "series" | "episode";
	arrEpisodeId: number | null;
	title: string;
	ruleId: string | null;
	ruleName: string | null;
	action: string;
	reason: string;
	status: string;
	lastExecutionError: string | null;
	reviewedAt: Date | null;
	executedAt: Date | null;
	expiresAt: Date | null;
}

interface AuditEventInput {
	configId: string;
	actionId: string;
	correlationId: string;
	eventKey: string;
	eventType: string;
	outcome: AuditOutcome;
	trigger: AuditTrigger;
	actorType: AuditActorType;
	actorId: string | null;
	approvalId: string | null;
	runLogId: string | null;
	instanceId: string;
	arrItemId: number;
	itemType: string;
	targetScope: string;
	arrEpisodeId: number | null;
	title: string;
	ruleId: string | null;
	ruleName: string | null;
	action: string;
	reason: string;
	evidence: string | null;
	details: string | null;
}

interface AuditRow {
	id: number;
	actionId: string;
	eventKey?: string;
	eventType?: string;
}

interface AuditDelegate {
	create(args: { data: AuditEventInput & { sequence: number } }): Promise<AuditRow>;
	findUnique(args: { where: { eventKey: string } }): Promise<AuditRow | null>;
	update(args: { where: { id: number }; data: { sequence: number } }): Promise<AuditRow>;
	count(args: { where: { configId: string; actionId?: string } }): Promise<number>;
	findMany(args: {
		where: {
			configId: string;
			actionId?: string | { in: string[] };
			id?: { in?: number[]; notIn?: number[] };
			eventType?: string;
		};
		orderBy: { id: "asc" | "desc" };
		take?: number;
		skip?: number;
		select: { id: true; actionId?: true; eventType?: true };
	}): Promise<AuditRow[]>;
	groupBy(args: {
		by: ["actionId"];
		where: { configId: string };
		_max: { id: true };
		_count: { _all: true };
		orderBy: { _max: { id: "asc" } };
		skip: number;
		take: number;
	}): Promise<Array<{ actionId: string; _max: { id: number | null }; _count: { _all: number } }>>;
	deleteMany(args: {
		where: {
			configId: string;
			actionId: string | { in: string[] };
			id?: { in?: number[]; notIn?: number[] };
		};
	}): Promise<{ count: number }>;
}

interface AuditTransaction {
	libraryCleanupAuditEvent: AuditDelegate;
	$executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

interface AuditClient {
	libraryCleanupAuditEvent?: Partial<AuditDelegate>;
	$transaction?<T>(
		operation: (transaction: AuditTransaction) => Promise<T>,
		options?: { isolationLevel?: "Serializable" },
	): Promise<T>;
}

function toAuditClient(prisma: PrismaClient): AuditClient {
	return prisma as unknown as AuditClient;
}

export function cleanupAuditEnabled(prisma: PrismaClient): boolean {
	return typeof toAuditClient(prisma).libraryCleanupAuditEvent?.create === "function";
}

export async function runCleanupAuditBestEffort(
	operation: () => Promise<unknown>,
	log: Pick<FastifyBaseLogger, "warn">,
	context: string,
): Promise<boolean> {
	try {
		await operation();
		return true;
	} catch (error) {
		log.warn(
			{ err: error, context },
			"Library cleanup audit write failed; authoritative state is unchanged",
		);
		return false;
	}
}

function stringValue(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableDate(value: unknown): Date | null {
	return value instanceof Date ? value : null;
}

function nullableNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function approvalRecordToAuditSnapshot(
	record: Record<string, unknown> | CleanupAuditApprovalSnapshot,
): CleanupAuditApprovalSnapshot {
	const source = record as unknown as Record<string, unknown>;
	return {
		id: stringValue(source.id),
		configId: stringValue(source.configId),
		instanceId: stringValue(source.instanceId),
		arrItemId: typeof source.arrItemId === "number" ? source.arrItemId : 0,
		itemType: stringValue(source.itemType, "unknown"),
		targetScope: source.targetScope === "episode" ? "episode" : "series",
		arrEpisodeId: nullableNumber(source.arrEpisodeId),
		title: stringValue(source.title, "Unknown item"),
		ruleId: nullableString(source.matchedRuleId ?? source.ruleId),
		ruleName: nullableString(source.matchedRuleName ?? source.ruleName),
		action: stringValue(source.action, "delete"),
		reason: stringValue(source.reason, "Library cleanup action"),
		status: stringValue(source.status, "unknown"),
		lastExecutionError: nullableString(source.lastExecutionError),
		reviewedAt: nullableDate(source.reviewedAt),
		executedAt: nullableDate(source.executedAt),
		expiresAt: nullableDate(source.expiresAt),
	};
}

function actorFor(
	trigger: AuditTrigger,
	actorId?: string | null,
): {
	actorType: AuditActorType;
	actorId: string | null;
} {
	if (actorId) return { actorType: "operator", actorId };
	if (trigger === "scheduled") return { actorType: "scheduler", actorId: null };
	return { actorType: "system", actorId: null };
}

function stringifyAudit(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	return JSON.stringify(value, (_key, candidate) =>
		typeof candidate === "bigint" ? candidate.toString() : candidate,
	);
}

function eventFromApproval(
	approval: CleanupAuditApprovalSnapshot,
	options: {
		correlationId: string;
		eventType: string;
		outcome: AuditOutcome;
		trigger: AuditTrigger;
		actorId?: string | null;
		reason: string;
		evidence?: unknown;
		details?: unknown;
		runLogId?: string | null;
		eventKeySuffix?: string;
	},
): AuditEventInput {
	const actor = actorFor(options.trigger, options.actorId);
	const suffix = options.eventKeySuffix ?? options.eventType;
	return {
		configId: approval.configId,
		actionId: approval.id,
		correlationId: options.correlationId,
		eventKey: `${approval.id}:${options.correlationId}:${suffix}`,
		eventType: options.eventType,
		outcome: options.outcome,
		trigger: options.trigger,
		...actor,
		approvalId: approval.id,
		runLogId: options.runLogId ?? null,
		instanceId: approval.instanceId,
		arrItemId: approval.arrItemId,
		itemType: approval.itemType,
		targetScope: approval.targetScope,
		arrEpisodeId: approval.arrEpisodeId,
		title: approval.title,
		ruleId: approval.ruleId,
		ruleName: approval.ruleName,
		action: approval.action,
		reason: options.reason,
		evidence: stringifyAudit(options.evidence),
		details: stringifyAudit(options.details),
	};
}

function isRetryableTransactionError(error: unknown): boolean {
	const pending: unknown[] = [error];
	const visited = new Set<object>();
	while (pending.length > 0) {
		const candidate = pending.pop();
		if (!candidate || typeof candidate !== "object" || visited.has(candidate)) continue;
		visited.add(candidate);
		const record = candidate as Record<string, unknown>;
		const code = typeof record.code === "string" ? record.code : "";
		const originalCode = typeof record.originalCode === "string" ? record.originalCode : "";
		const message = typeof record.message === "string" ? record.message : "";
		const kind = typeof record.kind === "string" ? record.kind : "";
		if (
			code === "P2034" ||
			code === "SQLITE_BUSY" ||
			code === "40001" ||
			originalCode === "40001" ||
			/serializ|deadlock|database is locked|transactionwriteconflict/i.test(`${kind} ${message}`)
		) {
			return true;
		}
		pending.push(record.cause, record.meta, record.driverAdapterError);
	}
	return false;
}

async function waitForAuditTransactionRetry(attempt: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, attempt * 15));
}

async function trimAuditTimeline(
	transaction: AuditTransaction,
	configId: string,
	actionId: string,
): Promise<number> {
	const requiredIds = new Set<number>();
	for (const eventType of REQUIRED_NONTERMINAL_EVIDENCE_TYPES) {
		const [required] = await transaction.libraryCleanupAuditEvent.findMany({
			where: { configId, actionId, eventType },
			orderBy: { id: "desc" },
			take: 1,
			select: { id: true },
		});
		if (required) requiredIds.add(required.id);
	}
	const recent = await transaction.libraryCleanupAuditEvent.findMany({
		where: { configId, actionId },
		orderBy: { id: "desc" },
		take: Math.max(0, AUDIT_TIMELINE_EVENT_LIMIT - requiredIds.size),
		select: { id: true },
	});
	for (const event of recent) requiredIds.add(event.id);
	let deletedTotal = 0;
	for (;;) {
		const oldest = await transaction.libraryCleanupAuditEvent.findMany({
			where: { configId, actionId },
			orderBy: { id: "asc" },
			take: AUDIT_RETENTION_DELETE_BATCH,
			select: { id: true },
		});
		const deletableIds = oldest.map((event) => event.id).filter((id) => !requiredIds.has(id));
		if (deletableIds.length === 0) break;
		const deleted = await transaction.libraryCleanupAuditEvent.deleteMany({
			where: { configId, actionId, id: { in: deletableIds } },
		});
		deletedTotal += deleted.count;
		if (deleted.count === 0) break;
	}
	return deletedTotal;
}

async function compactAuditTimelineToRequiredEvidence(
	transaction: AuditTransaction,
	configId: string,
	actionId: string,
	maximumDeletes: number,
): Promise<number> {
	if (maximumDeletes <= 0) return 0;

	const requiredIds = new Set<number>();
	for (const eventType of REQUIRED_NONTERMINAL_EVIDENCE_TYPES) {
		const [required] = await transaction.libraryCleanupAuditEvent.findMany({
			where: { configId, actionId, eventType },
			orderBy: { id: "desc" },
			take: 1,
			select: { id: true },
		});
		if (required) requiredIds.add(required.id);
	}
	const [latest] = await transaction.libraryCleanupAuditEvent.findMany({
		where: { configId, actionId },
		orderBy: { id: "desc" },
		take: 1,
		select: { id: true },
	});
	if (latest) requiredIds.add(latest.id);

	let deletedTotal = 0;
	while (deletedTotal < maximumDeletes) {
		const oldest = await transaction.libraryCleanupAuditEvent.findMany({
			where: { configId, actionId },
			orderBy: { id: "asc" },
			take: AUDIT_RETENTION_DELETE_BATCH,
			select: { id: true },
		});
		const deletableIds = oldest
			.map((event) => event.id)
			.filter((id) => !requiredIds.has(id))
			.slice(0, maximumDeletes - deletedTotal);
		if (deletableIds.length === 0) break;
		const deleted = await transaction.libraryCleanupAuditEvent.deleteMany({
			where: { configId, actionId, id: { in: deletableIds } },
		});
		deletedTotal += deleted.count;
		if (deleted.count === 0) break;
	}
	return deletedTotal;
}

async function discardOldestAuditTimelineEvidence(
	transaction: AuditTransaction,
	configId: string,
	actionId: string,
	maximumDeletes: number,
): Promise<number> {
	let deletedTotal = 0;
	while (deletedTotal < maximumDeletes) {
		const oldest = await transaction.libraryCleanupAuditEvent.findMany({
			where: { configId, actionId },
			orderBy: { id: "asc" },
			take: Math.min(AUDIT_RETENTION_DELETE_BATCH, maximumDeletes - deletedTotal),
			select: { id: true },
		});
		if (oldest.length === 0) break;
		const deleted = await transaction.libraryCleanupAuditEvent.deleteMany({
			where: { configId, actionId, id: { in: oldest.map((event) => event.id) } },
		});
		deletedTotal += deleted.count;
		if (deleted.count === 0) break;
	}
	return deletedTotal;
}

async function enforceAuditRetention(
	transaction: AuditTransaction,
	configId: string,
	currentActionId: string,
): Promise<void> {
	const total = await transaction.libraryCleanupAuditEvent.count({ where: { configId } });
	const currentTimelineSize = await transaction.libraryCleanupAuditEvent.count({
		where: { configId, actionId: currentActionId },
	});
	let retainedTotal = total;
	if (currentTimelineSize > AUDIT_TIMELINE_EVENT_LIMIT) {
		retainedTotal -= await trimAuditTimeline(transaction, configId, currentActionId);
	}
	if (retainedTotal <= AUDIT_RETENTION_EVENTS) return;

	const groups: Array<{
		actionId: string;
		_max: { id: number | null };
		_count: { _all: number };
	}> = [];
	for (let skip = 0; ; skip += AUDIT_RETENTION_GROUP_PAGE) {
		const page = await transaction.libraryCleanupAuditEvent.groupBy({
			by: ["actionId"],
			where: { configId },
			_max: { id: true },
			_count: { _all: true },
			orderBy: { _max: { id: "asc" } },
			skip,
			take: AUDIT_RETENTION_GROUP_PAGE,
		});
		groups.push(...page);
		if (page.length < AUDIT_RETENTION_GROUP_PAGE) break;
	}

	const closedTimelines: Array<{ actionId: string; latestId: number; count: number }> = [];
	const nonterminalTimelines: string[] = [];
	const latestEventTypes = new Map<number, string>();
	const latestIds = groups.map((group) => group._max.id).filter((id): id is number => id !== null);
	for (let offset = 0; offset < latestIds.length; offset += AUDIT_RETENTION_DELETE_BATCH) {
		const latestEvents = await transaction.libraryCleanupAuditEvent.findMany({
			where: {
				configId,
				id: { in: latestIds.slice(offset, offset + AUDIT_RETENTION_DELETE_BATCH) },
			},
			orderBy: { id: "asc" },
			select: { id: true, eventType: true },
		});
		for (const event of latestEvents) {
			if (event.eventType) latestEventTypes.set(event.id, event.eventType);
		}
	}
	for (const group of groups) {
		const latestId = group._max.id;
		if (latestId === null) continue;
		let retainedTimelineCount = group._count._all;
		if (group._count._all > AUDIT_TIMELINE_EVENT_LIMIT) {
			const trimmed = await trimAuditTimeline(transaction, configId, group.actionId);
			retainedTotal -= trimmed;
			retainedTimelineCount -= trimmed;
		}

		const latestEventType = latestEventTypes.get(latestId);
		if (latestEventType && DURABLY_CLOSED_EVENT_TYPES.has(latestEventType)) {
			closedTimelines.push({
				actionId: group.actionId,
				latestId,
				count: retainedTimelineCount,
			});
		} else {
			nonterminalTimelines.push(group.actionId);
		}
	}

	const prunableTimelines: string[] = [];
	let projectedTotal = retainedTotal;
	for (const timeline of closedTimelines) {
		if (projectedTotal <= AUDIT_RETENTION_EVENTS) break;
		prunableTimelines.push(timeline.actionId);
		projectedTotal -= timeline.count;
	}
	for (let offset = 0; offset < prunableTimelines.length; offset += AUDIT_RETENTION_DELETE_BATCH) {
		const batch = prunableTimelines.slice(offset, offset + AUDIT_RETENTION_DELETE_BATCH);
		const deleted = await transaction.libraryCleanupAuditEvent.deleteMany({
			where: { configId, actionId: { in: batch } },
		});
		retainedTotal -= deleted.count;
	}
	if (retainedTotal <= AUDIT_RETENTION_EVENTS) return;

	// Preserve required lifecycle evidence when a small number of old timelines
	// can supply enough ordinary history to reach the cap. Bound this scan so a
	// high-cardinality pending queue cannot turn one append into thousands of
	// per-timeline evidence queries; the hard overflow policy below then wins.
	for (const actionId of nonterminalTimelines.slice(0, AUDIT_PROTECTED_COMPACTION_SCAN_LIMIT)) {
		const deleted = await compactAuditTimelineToRequiredEvidence(
			transaction,
			configId,
			actionId,
			retainedTotal - AUDIT_RETENTION_EVENTS,
		);
		retainedTotal -= deleted;
		if (retainedTotal <= AUDIT_RETENTION_EVENTS) return;
	}

	// Audit history is not execution authority. If every remaining event is
	// protected lifecycle evidence, enforce the hard storage cap by discarding
	// the exact excess from the oldest nonterminal timelines. Durable approval
	// and recovery records remain untouched, and no terminal state is invented.
	for (const actionId of nonterminalTimelines) {
		const deleted = await discardOldestAuditTimelineEvidence(
			transaction,
			configId,
			actionId,
			retainedTotal - AUDIT_RETENTION_EVENTS,
		);
		retainedTotal -= deleted;
		if (retainedTotal <= AUDIT_RETENTION_EVENTS) return;
	}
}

async function appendAuditEvent(prisma: PrismaClient, input: AuditEventInput): Promise<void> {
	const client = toAuditClient(prisma);
	const delegate = client.libraryCleanupAuditEvent;
	if (!delegate?.create) return;

	// Lightweight route/unit mocks intentionally expose only create(). Production
	// always uses the transaction path below.
	if (!client.$transaction || !delegate.findUnique || !delegate.update) {
		await delegate.create({ data: { ...input, sequence: 0 } });
		return;
	}

	for (let attempt = 1; attempt <= AUDIT_TRANSACTION_RETRIES; attempt++) {
		try {
			await client.$transaction(
				async (transaction) => {
					// A no-op write is a portable per-config mutex: PostgreSQL takes a row
					// lock and SQLite takes its database writer lock. Every app append and
					// retention pass uses this same boundary, so a concurrent append cannot
					// be swept after the retention snapshot.
					await transaction.$executeRaw`
						UPDATE "library_cleanup_configs"
						SET "id" = "id"
						WHERE "id" = ${input.configId}
					`;
					const existing = await transaction.libraryCleanupAuditEvent.findUnique({
						where: { eventKey: input.eventKey },
					});
					if (existing) return;
					const created = await transaction.libraryCleanupAuditEvent.create({
						data: { ...input, sequence: 0 },
					});
					await transaction.libraryCleanupAuditEvent.update({
						where: { id: created.id },
						data: { sequence: created.id },
					});
					await enforceAuditRetention(transaction, input.configId, input.actionId);
				},
				{ isolationLevel: "Serializable" },
			);
			return;
		} catch (error) {
			const existing = await delegate.findUnique({ where: { eventKey: input.eventKey } });
			if (existing) return;
			if (attempt < AUDIT_TRANSACTION_RETRIES && isRetryableTransactionError(error)) {
				await waitForAuditTransactionRetry(attempt);
				continue;
			}
			throw error;
		}
	}
}

export async function recordApprovalTransition(
	prisma: PrismaClient,
	options: {
		approval: CleanupAuditApprovalSnapshot;
		eventType: "approval_approved" | "approval_rejected";
		actorId: string;
		correlationId: string;
	},
	_log: FastifyBaseLogger,
): Promise<void> {
	await appendAuditEvent(
		prisma,
		eventFromApproval(options.approval, {
			correlationId: options.correlationId,
			eventType: options.eventType,
			outcome: "info",
			trigger: "approval",
			actorId: options.actorId,
			reason:
				options.eventType === "approval_approved"
					? "Operator approved the cleanup action."
					: "Operator rejected the cleanup action.",
			evidence: { status: options.approval.status },
		}),
	);
}

export async function recordApprovalExpired(
	prisma: PrismaClient,
	approval: CleanupAuditApprovalSnapshot,
	_log: FastifyBaseLogger,
): Promise<void> {
	const expiry = approval.expiresAt?.getTime() ?? approval.reviewedAt?.getTime() ?? 0;
	await appendAuditEvent(
		prisma,
		eventFromApproval(approval, {
			correlationId: `expiry:${approval.id}:${expiry}`,
			eventType: "approval_expired",
			outcome: "blocked",
			trigger: "recovery",
			reason: approval.lastExecutionError ?? "Approval expired before execution.",
			evidence: { expiresAt: approval.expiresAt?.toISOString() ?? null },
		}),
	);
}

export async function recordApprovalRecoveryTransition(
	prisma: PrismaClient,
	options: {
		approval: CleanupAuditApprovalSnapshot;
		correlationId: string;
		fromStatus: string;
		toStatus: string;
		reason: string;
		mutationOutcome: "not_started" | "unknown";
		trigger: Exclude<AuditTrigger, "recovery">;
	},
	_log: FastifyBaseLogger,
): Promise<void> {
	await appendAuditEvent(
		prisma,
		eventFromApproval(options.approval, {
			correlationId: options.correlationId,
			eventType: "recovery_transition",
			outcome: options.mutationOutcome === "unknown" ? "failed" : "info",
			trigger: options.trigger,
			reason: options.reason,
			details: {
				fromStatus: options.fromStatus,
				toStatus: options.toStatus,
				mutationOutcome: options.mutationOutcome,
			},
		}),
	);
}

export async function recordApprovalExecutionClaimed(
	prisma: PrismaClient,
	options: {
		approval: CleanupAuditApprovalSnapshot | Record<string, unknown>;
		correlationId: string;
		trigger: "approval" | "retry" | "recovery" | "manual" | "scheduled";
		actorId?: string | null;
		includeCandidate?: boolean;
	},
	_log: FastifyBaseLogger,
): Promise<void> {
	const approval = approvalRecordToAuditSnapshot(options.approval);
	if (options.includeCandidate) {
		await appendAuditEvent(
			prisma,
			eventFromApproval(approval, {
				correlationId: options.correlationId,
				eventType: "candidate_selected",
				outcome: "info",
				trigger: options.trigger,
				actorId: options.actorId,
				reason: approval.reason,
			}),
		);
	}
	await appendAuditEvent(
		prisma,
		eventFromApproval(approval, {
			correlationId: options.correlationId,
			eventType: "execution_claimed",
			outcome: "info",
			trigger: options.trigger,
			actorId: options.actorId,
			reason: "Execution ownership was claimed for this cleanup action.",
			evidence: { status: approval.status },
		}),
	);
}

export async function recordApprovalMutationBoundary(
	prisma: PrismaClient,
	options: {
		approval: CleanupAuditApprovalSnapshot | Record<string, unknown>;
		correlationId: string;
		trigger: "approval" | "retry" | "recovery" | "manual" | "scheduled";
		actorId?: string | null;
		attempt: number;
		step: string;
	},
	_log: FastifyBaseLogger,
): Promise<void> {
	const approval = approvalRecordToAuditSnapshot(options.approval);
	await appendAuditEvent(
		prisma,
		eventFromApproval(approval, {
			correlationId: options.correlationId,
			eventType: "mutation_prepared",
			outcome: "info",
			trigger: options.trigger,
			actorId: options.actorId,
			reason: `Prepared audit evidence before final authority revalidation: ${options.step}.`,
			evidence: { attempt: options.attempt, step: options.step },
			details: {
				attempt: options.attempt,
				step: options.step,
				outcomeAtBoundary: "unknown",
			},
			eventKeySuffix: `mutation_prepared:${options.attempt}:${options.step}`,
		}),
	);
}

export async function recordApprovalMediaRescanEvent(
	prisma: PrismaClient,
	options: {
		approval: CleanupAuditApprovalSnapshot | Record<string, unknown>;
		correlationId: string;
		trigger: "approval" | "retry" | "recovery" | "manual" | "scheduled";
		actorId?: string | null;
		eventType:
			| "media_rescan_pending"
			| "media_rescan_triggered"
			| "media_rescan_skipped"
			| "media_rescan_completed"
			| "media_rescan_failed";
		attempt: number;
		targetCount: number;
		failedCount?: number;
		triggeredCount?: number;
		skippedCount?: number;
	},
	_log: FastifyBaseLogger,
): Promise<void> {
	const approval = approvalRecordToAuditSnapshot(options.approval);
	const failedCount = options.failedCount ?? 0;
	const triggeredCount = options.triggeredCount ?? 0;
	const skippedCount = options.skippedCount ?? 0;
	const outcome: AuditOutcome =
		options.eventType === "media_rescan_triggered" ||
		options.eventType === "media_rescan_skipped" ||
		options.eventType === "media_rescan_completed"
			? "success"
			: options.eventType === "media_rescan_failed"
				? "failed"
				: "info";
	const reason =
		options.eventType === "media_rescan_triggered"
			? "Media-server library scan requests were triggered after the ARR deletion."
			: options.eventType === "media_rescan_completed"
				? "Applicable media-server scans were triggered; targets without a matching Plex library were explicitly skipped."
				: options.eventType === "media_rescan_skipped"
					? "No matching Plex library section existed before deletion, so no media-server scan request was needed."
					: options.eventType === "media_rescan_failed"
						? "The ARR deletion completed, but one or more media-server scan requests remain retryable."
						: "Durable media-server scan work was recorded before the ARR deletion.";
	await appendAuditEvent(
		prisma,
		eventFromApproval(approval, {
			correlationId: options.correlationId,
			eventType: options.eventType,
			outcome,
			trigger: options.trigger,
			actorId: options.actorId,
			reason,
			evidence: {
				attempt: options.attempt,
				targetCount: options.targetCount,
				failedCount,
				triggeredCount,
				skippedCount,
			},
			details: {
				attempt: options.attempt,
				targetCount: options.targetCount,
				failedCount,
				triggeredCount,
				skippedCount,
			},
			eventKeySuffix: `media_rescan:${options.eventType}:${options.attempt}`,
		}),
	);
}

export async function recordApprovalExecutionOutcome(
	prisma: PrismaClient,
	options: {
		approval: CleanupAuditApprovalSnapshot;
		correlationId: string;
		trigger: "approval" | "retry" | "recovery" | "manual" | "scheduled";
		actorId?: string | null;
		auditPrepared: boolean;
		mutationAttempted: boolean;
		durableStateRecordingFailed?: boolean;
		eventKeySuffix?: string;
	},
	_log: FastifyBaseLogger,
): Promise<string> {
	const status = options.approval.status;
	let eventType = "execution_incomplete";
	let outcome: AuditOutcome = "failed";
	let reason =
		options.approval.lastExecutionError ?? "Cleanup execution did not reach a terminal state.";
	if (options.durableStateRecordingFailed) {
		eventType = "execution_incomplete";
		outcome = "failed";
		reason =
			options.approval.lastExecutionError ??
			"The upstream mutation completed, but durable intent status could not be confirmed.";
	} else if (status === "executed") {
		eventType = options.mutationAttempted ? "terminal_succeeded" : "reconciled_without_mutation";
		outcome = "success";
		reason = options.mutationAttempted
			? "The ARR mutation completed and authoritative state was recorded."
			: "The target was already absent and was reconciled without another ARR mutation.";
	} else if (status === "expired") {
		eventType = "safety_blocked";
		outcome = "blocked";
	} else if (status === "pending" || status === "retry_pending") {
		eventType = status === "retry_pending" ? "retry_pending" : "execution_deferred";
		outcome = options.mutationAttempted ? "failed" : "blocked";
	}
	await appendAuditEvent(
		prisma,
		eventFromApproval(options.approval, {
			correlationId: options.correlationId,
			eventType,
			outcome,
			trigger: options.trigger,
			actorId: options.actorId,
			reason,
			evidence: {
				durableStatus: status,
				auditPrepared: options.auditPrepared,
				mutationAttempted: options.mutationAttempted,
				durableStateRecordingFailed: options.durableStateRecordingFailed === true,
			},
			details: {
				status,
				auditPrepared: options.auditPrepared,
				mutationAttempted: options.mutationAttempted,
				durableStateRecordingFailed: options.durableStateRecordingFailed === true,
				lastExecutionError: options.approval.lastExecutionError,
			},
			eventKeySuffix: options.eventKeySuffix ?? "execution_outcome",
		}),
	);
	return eventType;
}

function detailActionId(
	runLogId: string,
	detail: CleanupRunResult["details"][number],
): string | null {
	if (detail.actionId) return detail.actionId;
	// Approval-backed actions must never fall back to a run-scoped synthetic ID.
	// Their durable approval ID is the timeline identity used by every later
	// approval, execution, retry, and recovery event.
	if (detail.action === "queued_for_approval") return null;
	const identity = [
		runLogId,
		detail.instanceId,
		detail.arrItemId,
		detail.targetScope ?? "series",
		detail.arrEpisodeId ?? "",
		detail.ruleId,
	].join(":");
	return `run:${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

export async function recordConfiguredRunAudit(
	prisma: PrismaClient,
	options: {
		configId: string;
		runLogId: string;
		result: Omit<CleanupRunResult, "error"> & { error?: string };
		trigger: "scheduled" | "manual";
		actorId?: string | null;
	},
	_log: FastifyBaseLogger,
): Promise<void> {
	// Repository preview/dry-run semantics prohibit audit persistence as well as
	// upstream mutation. The aggregate run result remains available to the caller.
	if (options.result.isDryRun) return;
	for (const detail of options.result.details) {
		// Queued/retry execution writes its own lifecycle after authoritative
		// approval state changes. Folding it into the configured-run summary
		// would duplicate and potentially contradict that timeline.
		if (detail.auditOutcomeOwnedByExecution) continue;
		const actionId = detailActionId(options.runLogId, detail);
		if (!actionId) continue;
		const correlationId = detail.auditCorrelationId ?? options.runLogId;
		const approval = approvalRecordToAuditSnapshot({
			id: actionId,
			configId: options.configId,
			instanceId: detail.instanceId,
			arrItemId: detail.arrItemId,
			itemType: detail.itemType,
			targetScope: detail.targetScope,
			arrEpisodeId: detail.arrEpisodeId,
			title: detail.title,
			matchedRuleId: detail.ruleId,
			matchedRuleName: detail.rule,
			action: detail.intendedAction ?? detail.action,
			reason: detail.reason,
			status: detail.action,
		});
		await appendAuditEvent(
			prisma,
			eventFromApproval(approval, {
				correlationId,
				eventType: "candidate_selected",
				outcome: "info",
				trigger: options.trigger,
				actorId: options.actorId,
				reason: detail.reason,
				runLogId: options.runLogId,
			}),
		);

		let eventType = "candidate_flagged";
		let outcome: AuditOutcome = "info";
		if (detail.durableStateRecordingFailed === true) {
			eventType = "execution_incomplete";
			outcome = "failed";
		} else if (
			detail.mutationAttempted === true &&
			(detail.action === "skipped" ||
				(detail.intendedAction === "delete" && detail.action === "files_deleted"))
		) {
			eventType = "retry_pending";
			outcome = "failed";
		} else if (
			detail.mutationAttempted !== true &&
			detail.action === "skipped" &&
			detail.reason.startsWith("Reconciled")
		) {
			eventType = "reconciled_without_mutation";
			outcome = "success";
		} else if (detail.action === "skipped") {
			eventType = "safety_blocked";
			outcome = "blocked";
		} else if (detail.action === "queued_for_approval") eventType = "approval_pending";
		else if (["removed", "unmonitored", "files_deleted"].includes(detail.action)) {
			eventType = "terminal_succeeded";
			outcome = "success";
		}
		await appendAuditEvent(
			prisma,
			eventFromApproval(approval, {
				correlationId,
				eventType,
				outcome,
				trigger: options.trigger,
				actorId: options.actorId,
				reason: detail.reason,
				runLogId: options.runLogId,
				evidence: {
					auditPrepared: detail.auditPrepared === true,
					mutationAttempted: detail.mutationAttempted === true,
					durableStateRecordingFailed: detail.durableStateRecordingFailed === true,
				},
				details: {
					detailAction: detail.action,
					intendedAction: detail.intendedAction ?? null,
					auditPrepared: detail.auditPrepared === true,
					mutationAttempted: detail.mutationAttempted === true,
					durableStateRecordingFailed: detail.durableStateRecordingFailed === true,
				},
				eventKeySuffix: "configured_run_outcome",
			}),
		);
	}
}
