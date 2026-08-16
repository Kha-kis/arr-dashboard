import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "../prisma.js";

const MAX_APPEND_ATTEMPTS = 32;
const MAX_AUDIT_STRING_LENGTH = 256;
const MAX_AUDIT_METADATA_STRING_LENGTH = 512;
const MAX_AUDIT_METADATA_ENTRIES = 32;
const MAX_AUDIT_TITLE_LENGTH = 512;
const MAX_AUDIT_REASON_LENGTH = 1024;
const MAX_PAGE_SIZE = 100;
const SENSITIVE_AUDIT_FIELD =
	/(?:api[-_]?key|authorization|cookie|credential|encryption|password|secret|token|payload|raw)/i;
const AUDIT_EVENT_TYPES = new Set([
	"claim",
	"mutation_started",
	"succeeded",
	"failed",
	"expired",
	"recovered",
	"proposal_created",
	"approval_reviewed",
]);
const AUDIT_ACTOR_TYPES = new Set(["operator", "scheduler", "system"]);
const AUDIT_TRIGGERS = new Set(["scheduled", "manual", "approval", "retry", "recovery"]);
const AUDIT_OUTCOMES = new Set(["info", "success", "blocked", "failed"]);
const AUDIT_TARGET_KINDS = new Set(["approval", "cleanup_run", "library_item"]);
const AUDIT_TARGET_ITEM_TYPES = new Set(["movie", "series"]);
const AUDIT_TARGET_SCOPES = new Set(["series", "episode"]);
const AUDIT_ACTIONS = new Set(["delete", "unmonitor", "delete_files"]);

type AuditScalar = boolean | null | number | string;
type AuditMetadata = Record<string, AuditScalar>;
type AuditStore = Pick<
	PrismaClient | Prisma.TransactionClient,
	"libraryCleanupAuditEvent" | "libraryCleanupConfig"
>;

type StoredAuditEvent = {
	id: string;
	eventOrder: number;
	eventKey: string;
	actionId: string;
	correlationId: string;
	actionSequence: number;
	actorType: string;
	actorId: string | null;
	eventType: string;
	trigger: string;
	targetKind: string;
	targetId: string | null;
	targetInstanceId: string | null;
	targetItemType: string | null;
	targetArrItemId: number | null;
	targetArrEpisodeId: number | null;
	targetScope: string | null;
	title: string | null;
	ruleId: string | null;
	ruleName: string | null;
	action: string | null;
	reason: string | null;
	outcome: string;
	evidence: string;
	details: string | null;
	createdAt: Date;
};

export type CleanupAuditTarget = {
	arrItemId?: number;
	arrEpisodeId?: number;
	id?: string;
	instanceId?: string;
	itemType?: "movie" | "series";
	kind: string;
	targetScope?: "episode" | "series";
};

export type CleanupAuditEventType =
	| "claim"
	| "mutation_started"
	| "succeeded"
	| "failed"
	| "expired"
	| "recovered"
	| "proposal_created"
	| "approval_reviewed";

export type CleanupAuditTrigger = "scheduled" | "manual" | "approval" | "retry" | "recovery";
export type CleanupAuditActorType = "operator" | "scheduler" | "system";
export type CleanupAuditOutcome = "info" | "success" | "blocked" | "failed";

export type CleanupAuditSummary = {
	action?: "delete" | "unmonitor" | "delete_files";
	reason?: string;
	ruleId?: string;
	ruleName?: string;
	title?: string;
};

export type AppendCleanupAuditEventInput = {
	userId: string;
	configId: string;
	eventKey: string;
	actionId: string;
	correlationId: string;
	actorType: CleanupAuditActorType;
	actorId?: string | null;
	eventType: CleanupAuditEventType;
	trigger: CleanupAuditTrigger;
	target: CleanupAuditTarget;
	summary?: CleanupAuditSummary;
	outcome: CleanupAuditOutcome;
	evidence: AuditMetadata;
	details?: AuditMetadata;
};

export type CleanupTerminalAuditStatus = "executed" | "expired" | "rejected";

export type CleanupTerminalAuditState = {
	terminalAuditCorrelationId: string;
	terminalAuditEventType: CleanupAuditEventType;
	terminalAuditOutcome: CleanupAuditOutcome;
	terminalAuditActorType: CleanupAuditActorType;
	terminalAuditActorId: string | null;
	terminalAuditTrigger: CleanupAuditTrigger;
	terminalAuditReason: string;
	terminalAuditRecordedAt: null;
};

export function createCleanupAuditEventKey(
	input: Pick<AppendCleanupAuditEventInput, "actionId" | "correlationId" | "eventType">,
): string {
	const fingerprint = createHash("sha256")
		.update(JSON.stringify([input.actionId, input.correlationId, input.eventType]))
		.digest("hex");
	return `cleanup:${input.eventType}:${fingerprint}`;
}

export type CleanupAuditEvent = {
	id: string;
	order: number;
	eventKey: string;
	actionId: string;
	correlationId: string;
	actionSequence: number;
	actorType: CleanupAuditActorType;
	actorId: string | null;
	eventType: CleanupAuditEventType;
	trigger: string;
	target: CleanupAuditTarget;
	summary: CleanupAuditSummary;
	outcome: CleanupAuditOutcome;
	evidence: AuditMetadata;
	details: AuditMetadata | null;
	createdAt: Date;
};

export type CleanupAuditPage = {
	events: CleanupAuditEvent[];
	nextCursor: number | null;
};

export type ListCleanupAuditEventsInput = {
	userId: string;
	configId: string;
	limit: number;
	after?: number;
};

export type ListCleanupAuditTimelineInput = ListCleanupAuditEventsInput & {
	correlationId: string;
};

export class CleanupAuditOwnershipError extends Error {
	constructor() {
		super("Library cleanup configuration was not found for the current user");
		this.name = "CleanupAuditOwnershipError";
	}
}

export class CleanupAuditEventConflictError extends Error {
	constructor(eventKey: string) {
		super(`Cleanup audit event key "${eventKey}" was already used with different content`);
		this.name = "CleanupAuditEventConflictError";
	}
}

export class CleanupAuditAppendRetryError extends Error {
	constructor() {
		super("Could not append cleanup audit event after concurrent sequence conflicts");
		this.name = "CleanupAuditAppendRetryError";
	}
}

export class CleanupAuditTerminalStateConflictError extends Error {
	constructor(approvalId: string) {
		super(`Cleanup terminal audit state changed for approval "${approvalId}"`);
		this.name = "CleanupAuditTerminalStateConflictError";
	}
}

function isUniqueConstraintError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function assertAuditString(value: string, field: string): void {
	if (!value || value.length > MAX_AUDIT_STRING_LENGTH) {
		throw new Error(`Invalid cleanup audit ${field}`);
	}
}

function assertAllowedAuditValue(value: string, allowed: Set<string>, field: string): void {
	assertAuditString(value, field);
	if (!allowed.has(value)) throw new Error(`Invalid cleanup audit ${field}`);
}

function canonicalMetadata(value: AuditMetadata, field: string): string {
	const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
	if (entries.length > MAX_AUDIT_METADATA_ENTRIES) {
		throw new Error(`Invalid cleanup audit ${field} metadata entries`);
	}
	for (const [key, entry] of entries) {
		assertAuditString(key, `${field} metadata key`);
		if (SENSITIVE_AUDIT_FIELD.test(key)) {
			throw new Error(`Cleanup audit contains sensitive audit field: ${key}`);
		}
		if (
			entry !== null &&
			typeof entry !== "boolean" &&
			typeof entry !== "number" &&
			typeof entry !== "string"
		) {
			throw new Error(`Invalid cleanup audit ${field} metadata value`);
		}
		if (typeof entry === "string" && entry.length > MAX_AUDIT_METADATA_STRING_LENGTH) {
			throw new Error(`Invalid cleanup audit ${field}`);
		}
		if (typeof entry === "number" && !Number.isFinite(entry)) {
			throw new Error(`Invalid cleanup audit ${field}`);
		}
	}
	return JSON.stringify(Object.fromEntries(entries));
}

function boundedAuditDisplayString(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 1)}…`;
}

function validateSummary(summary: CleanupAuditSummary | undefined): CleanupAuditSummary {
	if (!summary) return {};
	if (summary.ruleId !== undefined) assertAuditString(summary.ruleId, "rule id");
	if (summary.ruleName !== undefined) assertAuditString(summary.ruleName, "rule name");
	if (summary.action !== undefined)
		assertAllowedAuditValue(summary.action, AUDIT_ACTIONS, "action");
	return {
		...(summary.title === undefined
			? {}
			: { title: boundedAuditDisplayString(summary.title, MAX_AUDIT_TITLE_LENGTH) }),
		...(summary.ruleId === undefined ? {} : { ruleId: summary.ruleId }),
		...(summary.ruleName === undefined ? {} : { ruleName: summary.ruleName }),
		...(summary.action === undefined ? {} : { action: summary.action }),
		...(summary.reason === undefined
			? {}
			: { reason: boundedAuditDisplayString(summary.reason, MAX_AUDIT_REASON_LENGTH) }),
	};
}

export function createCleanupTerminalAuditState(
	input: Pick<
		AppendCleanupAuditEventInput,
		"actorId" | "actorType" | "correlationId" | "eventType" | "outcome" | "summary" | "trigger"
	>,
): CleanupTerminalAuditState {
	if (
		input.eventType !== "succeeded" &&
		input.eventType !== "failed" &&
		input.eventType !== "expired" &&
		input.eventType !== "approval_reviewed"
	) {
		throw new Error("Cleanup terminal audit requires a terminal event type");
	}
	const summary = validateSummary(input.summary);
	const reason = summary.reason;
	if (!reason) throw new Error("Cleanup terminal audit requires a public transition reason");
	assertAllowedAuditValue(input.actorType, AUDIT_ACTOR_TYPES, "actor type");
	if (input.actorId !== undefined && input.actorId !== null) {
		assertAuditString(input.actorId, "actor id");
	}
	assertAllowedAuditValue(input.trigger, AUDIT_TRIGGERS, "trigger");
	assertAllowedAuditValue(input.outcome, AUDIT_OUTCOMES, "outcome");
	assertAuditString(input.correlationId, "correlation id");
	return {
		terminalAuditCorrelationId: input.correlationId,
		terminalAuditEventType: input.eventType,
		terminalAuditOutcome: input.outcome,
		terminalAuditActorType: input.actorType,
		terminalAuditActorId: input.actorId ?? null,
		terminalAuditTrigger: input.trigger,
		terminalAuditReason: reason,
		terminalAuditRecordedAt: null,
	};
}

function validateAndSerialize(input: AppendCleanupAuditEventInput) {
	assertAuditString(input.userId, "user id");
	assertAuditString(input.configId, "config id");
	assertAuditString(input.eventKey, "event key");
	assertAuditString(input.actionId, "action id");
	assertAuditString(input.correlationId, "correlation id");
	assertAllowedAuditValue(input.actorType, AUDIT_ACTOR_TYPES, "actor type");
	if (input.actorId !== undefined && input.actorId !== null) {
		assertAuditString(input.actorId, "actor id");
	}
	assertAllowedAuditValue(input.eventType, AUDIT_EVENT_TYPES, "event type");
	assertAllowedAuditValue(input.trigger, AUDIT_TRIGGERS, "trigger");
	assertAllowedAuditValue(input.outcome, AUDIT_OUTCOMES, "outcome");
	assertAllowedAuditValue(input.target.kind, AUDIT_TARGET_KINDS, "target kind");
	if (input.target.id !== undefined) assertAuditString(input.target.id, "target id");
	if (input.target.instanceId !== undefined)
		assertAuditString(input.target.instanceId, "target instance id");
	if (input.target.itemType !== undefined) {
		assertAllowedAuditValue(input.target.itemType, AUDIT_TARGET_ITEM_TYPES, "target item type");
	}
	if (
		input.target.arrItemId !== undefined &&
		(!Number.isSafeInteger(input.target.arrItemId) || input.target.arrItemId < 1)
	) {
		throw new Error("Invalid cleanup audit target ARR item id");
	}
	if (
		input.target.arrEpisodeId !== undefined &&
		(!Number.isSafeInteger(input.target.arrEpisodeId) || input.target.arrEpisodeId < 1)
	) {
		throw new Error("Invalid cleanup audit target ARR episode id");
	}
	if (input.target.targetScope !== undefined) {
		assertAllowedAuditValue(input.target.targetScope, AUDIT_TARGET_SCOPES, "target scope");
	}
	if (input.target.targetScope === "episode" && input.target.arrEpisodeId === undefined) {
		throw new Error("Episode cleanup audit target requires an ARR episode id");
	}
	if (input.target.arrEpisodeId !== undefined && input.target.targetScope !== "episode") {
		throw new Error("ARR episode id requires episode cleanup audit target scope");
	}

	const target = {
		arrItemId: input.target.arrItemId ?? null,
		arrEpisodeId: input.target.arrEpisodeId ?? null,
		id: input.target.id ?? null,
		instanceId: input.target.instanceId ?? null,
		itemType: input.target.itemType ?? null,
		kind: input.target.kind,
		targetScope: input.target.targetScope ?? null,
	};
	const evidence = canonicalMetadata(input.evidence, "evidence");
	const details = input.details === undefined ? null : canonicalMetadata(input.details, "details");
	const summary = validateSummary(input.summary);
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				actionId: input.actionId,
				actorId: input.actorId ?? null,
				actorType: input.actorType,
				correlationId: input.correlationId,
				details,
				evidence,
				eventType: input.eventType,
				outcome: input.outcome,
				summary,
				target,
				trigger: input.trigger,
			}),
		)
		.digest("hex");

	return { details, evidence, fingerprint, summary, target };
}

async function assertOwnedConfig(
	prisma: AuditStore,
	input: Pick<AppendCleanupAuditEventInput, "configId" | "userId">,
): Promise<void> {
	const config = await prisma.libraryCleanupConfig.findFirst({
		where: { id: input.configId, userId: input.userId },
		select: { id: true },
	});
	if (!config) throw new CleanupAuditOwnershipError();
}

function toAuditEvent(event: StoredAuditEvent): CleanupAuditEvent {
	return {
		id: event.id,
		order: event.eventOrder,
		eventKey: event.eventKey,
		actionId: event.actionId,
		correlationId: event.correlationId,
		actionSequence: event.actionSequence,
		actorType: event.actorType as CleanupAuditActorType,
		actorId: event.actorId,
		eventType: event.eventType as CleanupAuditEventType,
		trigger: event.trigger,
		target: {
			kind: event.targetKind,
			...(event.targetId === null ? {} : { id: event.targetId }),
			...(event.targetInstanceId === null ? {} : { instanceId: event.targetInstanceId }),
			...(event.targetItemType === null
				? {}
				: { itemType: event.targetItemType as CleanupAuditTarget["itemType"] }),
			...(event.targetArrItemId === null ? {} : { arrItemId: event.targetArrItemId }),
			...(event.targetArrEpisodeId === null ? {} : { arrEpisodeId: event.targetArrEpisodeId }),
			...(event.targetScope === null
				? {}
				: { targetScope: event.targetScope as CleanupAuditTarget["targetScope"] }),
		},
		summary: {
			...(event.title === null ? {} : { title: event.title }),
			...(event.ruleId === null ? {} : { ruleId: event.ruleId }),
			...(event.ruleName === null ? {} : { ruleName: event.ruleName }),
			...(event.action === null ? {} : { action: event.action as CleanupAuditSummary["action"] }),
			...(event.reason === null ? {} : { reason: event.reason }),
		},
		outcome: event.outcome as CleanupAuditOutcome,
		evidence: JSON.parse(event.evidence) as AuditMetadata,
		details: event.details === null ? null : (JSON.parse(event.details) as AuditMetadata),
		createdAt: event.createdAt,
	};
}

function hasSameFingerprint(event: { fingerprint: string }, fingerprint: string): boolean {
	return event.fingerprint === fingerprint;
}

async function findExistingEvent(
	prisma: AuditStore,
	input: Pick<AppendCleanupAuditEventInput, "configId" | "eventKey" | "userId">,
) {
	return prisma.libraryCleanupAuditEvent.findFirst({
		where: {
			configId: input.configId,
			eventKey: input.eventKey,
			config: { userId: input.userId },
		},
	});
}

export async function appendCleanupAuditEvent(
	prisma: AuditStore,
	input: AppendCleanupAuditEventInput,
): Promise<CleanupAuditEvent> {
	const serialized = validateAndSerialize(input);

	for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
		await assertOwnedConfig(prisma, input);
		const existing = await findExistingEvent(prisma, input);
		if (existing) {
			if (hasSameFingerprint(existing, serialized.fingerprint)) return toAuditEvent(existing);
			throw new CleanupAuditEventConflictError(input.eventKey);
		}

		const lastForAction = await prisma.libraryCleanupAuditEvent.findFirst({
			where: {
				configId: input.configId,
				actionId: input.actionId,
				config: { userId: input.userId },
			},
			orderBy: { actionSequence: "desc" },
			select: { actionSequence: true },
		});

		try {
			const event = await prisma.libraryCleanupAuditEvent.create({
				data: {
					configId: input.configId,
					eventKey: input.eventKey,
					actionId: input.actionId,
					correlationId: input.correlationId,
					actionSequence: (lastForAction?.actionSequence ?? 0) + 1,
					actorType: input.actorType,
					actorId: input.actorId ?? null,
					eventType: input.eventType,
					trigger: input.trigger,
					targetKind: serialized.target.kind,
					targetId: serialized.target.id,
					targetInstanceId: serialized.target.instanceId,
					targetItemType: serialized.target.itemType,
					targetArrItemId: serialized.target.arrItemId,
					targetArrEpisodeId: serialized.target.arrEpisodeId,
					targetScope: serialized.target.targetScope,
					title: serialized.summary.title,
					ruleId: serialized.summary.ruleId,
					ruleName: serialized.summary.ruleName,
					action: serialized.summary.action,
					reason: serialized.summary.reason,
					outcome: input.outcome,
					evidence: serialized.evidence,
					details: serialized.details,
					fingerprint: serialized.fingerprint,
				},
			});
			return toAuditEvent(event);
		} catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			// Concurrent writers can observe the same final action sequence. The
			// compound unique constraint turns that portable SQLite/PostgreSQL race
			// into a retry without ever updating an existing audit row.
			const duplicate = await findExistingEvent(prisma, input);
			if (duplicate) {
				if (hasSameFingerprint(duplicate, serialized.fingerprint)) return toAuditEvent(duplicate);
				throw new CleanupAuditEventConflictError(input.eventKey);
			}
		}
	}

	throw new CleanupAuditAppendRetryError();
}

/**
 * Appends the canonical terminal event and marks its authoritative approval
 * envelope in one transaction. A failed marker check rolls the event back;
 * retrying an already completed envelope remains idempotent.
 */
export async function appendCleanupTerminalAuditEvent(
	prisma: PrismaClient,
	input: AppendCleanupAuditEventInput,
	marker: { approvalId: string; status: CleanupTerminalAuditStatus },
): Promise<CleanupAuditEvent> {
	const terminalState = createCleanupTerminalAuditState(input);
	return prisma.$transaction(async (tx) => {
		const approval = await tx.libraryCleanupApproval.findFirst({
			where: {
				id: marker.approvalId,
				config: { userId: input.userId },
				status: marker.status,
				terminalAuditCorrelationId: terminalState.terminalAuditCorrelationId,
				terminalAuditEventType: terminalState.terminalAuditEventType,
				terminalAuditOutcome: terminalState.terminalAuditOutcome,
				terminalAuditActorType: terminalState.terminalAuditActorType,
				terminalAuditActorId: terminalState.terminalAuditActorId,
				terminalAuditTrigger: terminalState.terminalAuditTrigger,
				terminalAuditReason: terminalState.terminalAuditReason,
			},
			select: { terminalAuditRecordedAt: true },
		});
		if (!approval) throw new CleanupAuditTerminalStateConflictError(marker.approvalId);

		const event = await appendCleanupAuditEvent(tx, input);
		if (approval.terminalAuditRecordedAt !== null) return event;

		const marked = await tx.libraryCleanupApproval.updateMany({
			where: {
				id: marker.approvalId,
				config: { userId: input.userId },
				status: marker.status,
				terminalAuditCorrelationId: terminalState.terminalAuditCorrelationId,
				terminalAuditEventType: terminalState.terminalAuditEventType,
				terminalAuditOutcome: terminalState.terminalAuditOutcome,
				terminalAuditActorType: terminalState.terminalAuditActorType,
				terminalAuditActorId: terminalState.terminalAuditActorId,
				terminalAuditTrigger: terminalState.terminalAuditTrigger,
				terminalAuditReason: terminalState.terminalAuditReason,
				terminalAuditRecordedAt: null,
			},
			data: { terminalAuditRecordedAt: new Date() },
		});
		if (marked.count !== 1) {
			throw new CleanupAuditTerminalStateConflictError(marker.approvalId);
		}
		return event;
	});
}

function pageLimit(limit: number): number {
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
		throw new Error(`Cleanup audit page limit must be between 1 and ${MAX_PAGE_SIZE}`);
	}
	return limit;
}

async function listAuditEvents(
	prisma: AuditStore,
	input: ListCleanupAuditEventsInput,
	correlationId?: string,
): Promise<CleanupAuditPage> {
	await assertOwnedConfig(prisma, input);
	const limit = pageLimit(input.limit);
	if (input.after !== undefined && (!Number.isInteger(input.after) || input.after < 1)) {
		throw new Error("Cleanup audit cursor must be a positive database order");
	}

	const events = await prisma.libraryCleanupAuditEvent.findMany({
		where: {
			configId: input.configId,
			...(correlationId === undefined ? {} : { correlationId }),
			...(input.after === undefined ? {} : { eventOrder: { gt: input.after } }),
			config: { userId: input.userId },
		},
		orderBy: { eventOrder: "asc" },
		take: limit + 1,
	});
	const hasNextPage = events.length > limit;
	const page = events.slice(0, limit).map(toAuditEvent);
	return {
		events: page,
		nextCursor: hasNextPage ? (page.at(-1)?.order ?? null) : null,
	};
}

export async function listCleanupAuditEvents(
	prisma: AuditStore,
	input: ListCleanupAuditEventsInput,
): Promise<CleanupAuditPage> {
	return listAuditEvents(prisma, input);
}

export async function listCleanupAuditTimeline(
	prisma: AuditStore,
	input: ListCleanupAuditTimelineInput,
): Promise<CleanupAuditPage> {
	return listAuditEvents(prisma, input, input.correlationId);
}
