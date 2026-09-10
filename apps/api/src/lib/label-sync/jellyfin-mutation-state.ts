/**
 * Strict, provider-neutral vocabulary for the durable Jellyfin/Emby label
 * mutation ledger. Keep this module free of provider objects and error text:
 * backup validation and later orchestration share these bounded values.
 */

export const LABEL_SYNC_MUTATION_STATUSES = [
	"claimed",
	"sending",
	"unknown",
	"verified",
	"noop",
	"failed",
	"blocked",
] as const;

export type LabelSyncMutationStatus = (typeof LABEL_SYNC_MUTATION_STATUSES)[number];

export const LABEL_SYNC_MUTATION_UNRESOLVED_STATUSES = ["claimed", "sending", "unknown"] as const;
export const LABEL_SYNC_MUTATION_TERMINAL_STATUSES = [
	"verified",
	"noop",
	"failed",
	"blocked",
] as const;

export const LABEL_SYNC_MUTATION_REASON_CODES = [
	"startup_before_send",
	"provider_unavailable",
	"identity_unavailable",
	"identity_changed",
	"rule_changed",
	"destination_changed",
	"generation_changed",
	"target_missing",
	"target_ambiguous",
	"target_changed",
	"library_ancestry_changed",
	"already_applied",
	"applied",
	"confirmed_absent",
	"uncertain_send",
	"reconciliation_unavailable",
	"attempt_limit",
	"internal_failure",
] as const;

export type LabelSyncMutationReasonCode = (typeof LABEL_SYNC_MUTATION_REASON_CODES)[number];
export const LABEL_SYNC_MUTATION_PROVIDERS = ["jellyfin", "emby"] as const;
export type LabelSyncMutationProvider = (typeof LABEL_SYNC_MUTATION_PROVIDERS)[number];
export const LABEL_SYNC_MUTATION_MEDIA_TYPES = ["movie", "series"] as const;
export type LabelSyncMutationMediaType = (typeof LABEL_SYNC_MUTATION_MEDIA_TYPES)[number];

// This is deliberately finite. It protects restore from hostile/corrupt
// counters while leaving ample room for normal retries and reconciliation.
export const MAX_LABEL_SYNC_MUTATION_ATTEMPTS = 1_000_000;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_FINGERPRINT_LENGTH = 256;
const MAX_TAG_LENGTH = 256;
const MAX_PORTABLE_INT = 2_147_483_647;

export type LabelSyncMutationAttemptRecord = {
	id: string;
	userId: string;
	ruleId: string;
	destinationInstanceId: string;
	provider: LabelSyncMutationProvider;
	mediaType: LabelSyncMutationMediaType;
	tmdbId: number;
	connectionGeneration: number;
	identityGeneration: number;
	targetItemId: string;
	libraryId: string;
	intentFingerprint: string;
	ruleFingerprint: string;
	destinationTag: string;
	activeOperationKey: string | null;
	claimToken: string | null;
	sendAttemptCount: number;
	reconcileAttemptCount: number;
	requestStartedAt: Date | null;
	lastObservedAt: Date | null;
	completedAt: Date | null;
	status: LabelSyncMutationStatus;
	reasonCode: LabelSyncMutationReasonCode | null;
	createdAt: Date;
	updatedAt: Date;
};

const TERMINAL_BLOCKED_REASONS = new Set([
	"identity_changed",
	"rule_changed",
	"destination_changed",
	"generation_changed",
	"target_missing",
	"target_ambiguous",
	"target_changed",
	"library_ancestry_changed",
]);

/** Validate the evidence required for every persisted terminal outcome. */
export function validateLabelSyncMutationTerminalEvidence(
	attempt: Pick<
		LabelSyncMutationAttemptRecord,
		| "status"
		| "reasonCode"
		| "sendAttemptCount"
		| "reconcileAttemptCount"
		| "requestStartedAt"
		| "lastObservedAt"
	>,
): void {
	if (
		!Number.isSafeInteger(attempt.sendAttemptCount) ||
		attempt.sendAttemptCount < 0 ||
		!Number.isSafeInteger(attempt.reconcileAttemptCount) ||
		attempt.reconcileAttemptCount < 0 ||
		attempt.reconcileAttemptCount > MAX_LABEL_SYNC_MUTATION_ATTEMPTS
	)
		invalid();

	if (attempt.status === "verified") {
		if (
			attempt.reasonCode !== "applied" ||
			attempt.sendAttemptCount !== 1 ||
			attempt.requestStartedAt === null ||
			attempt.lastObservedAt === null
		)
			invalid();
		return;
	}
	if (attempt.status === "noop") {
		if (
			attempt.reasonCode !== "already_applied" ||
			attempt.sendAttemptCount !== 0 ||
			attempt.requestStartedAt !== null ||
			attempt.reconcileAttemptCount !== 0 ||
			attempt.lastObservedAt === null
		)
			invalid();
		return;
	}
	if (attempt.status === "failed") {
		const preSendFailure =
			attempt.reasonCode === "startup_before_send" ||
			attempt.reasonCode === "provider_unavailable" ||
			attempt.reasonCode === "identity_unavailable" ||
			attempt.reasonCode === "internal_failure";
		if (preSendFailure) {
			if (
				attempt.sendAttemptCount !== 0 ||
				attempt.requestStartedAt !== null ||
				attempt.reconcileAttemptCount !== 0 ||
				attempt.lastObservedAt !== null
			)
				invalid();
			return;
		}
		if (
			attempt.reasonCode !== "confirmed_absent" ||
			attempt.sendAttemptCount !== 1 ||
			attempt.requestStartedAt === null ||
			attempt.lastObservedAt === null
		)
			invalid();
		return;
	}
	if (
		attempt.status === "blocked" &&
		typeof attempt.reasonCode === "string" &&
		TERMINAL_BLOCKED_REASONS.has(attempt.reasonCode)
	) {
		if (
			attempt.sendAttemptCount !== 0 ||
			attempt.requestStartedAt !== null ||
			attempt.reconcileAttemptCount !== 0
		)
			invalid();
		return;
	}
	invalid();
}

/**
 * Validate the operational state machine after structural values have been
 * parsed. This is shared by backup validation and durable recovery/repository
 * callers so an impossible persisted row cannot be admitted.
 */
export function validateLabelSyncMutationAttemptLifecycle(
	attempt: Pick<
		LabelSyncMutationAttemptRecord,
		| "status"
		| "claimToken"
		| "sendAttemptCount"
		| "reconcileAttemptCount"
		| "requestStartedAt"
		| "lastObservedAt"
		| "reasonCode"
	>,
): void {
	if (attempt.status === "claimed") {
		if (
			attempt.requestStartedAt !== null ||
			attempt.lastObservedAt !== null ||
			attempt.sendAttemptCount !== 0 ||
			attempt.reconcileAttemptCount !== 0 ||
			attempt.claimToken === null ||
			attempt.reasonCode !== null
		)
			invalid();
		return;
	}

	if (attempt.status === "sending") {
		if (
			attempt.requestStartedAt === null ||
			attempt.lastObservedAt !== null ||
			attempt.sendAttemptCount !== 1 ||
			attempt.reconcileAttemptCount !== 0 ||
			attempt.claimToken === null ||
			attempt.reasonCode !== null
		)
			invalid();
		return;
	}

	if (attempt.status === "unknown") {
		if (
			attempt.requestStartedAt === null ||
			attempt.sendAttemptCount !== 1 ||
			(attempt.reasonCode !== "uncertain_send" &&
				attempt.reasonCode !== "reconciliation_unavailable" &&
				attempt.reasonCode !== "attempt_limit") ||
			((attempt.reasonCode === "reconciliation_unavailable" ||
				attempt.reasonCode === "attempt_limit") &&
				attempt.reconcileAttemptCount < 1)
		)
			invalid();
		if (attempt.claimToken !== null && attempt.reconcileAttemptCount < 1) {
			invalid();
		}
		return;
	}

	validateLabelSyncMutationTerminalEvidence(attempt);
}

function invalid(): never {
	// Never include a value from a backup in an error; values can contain
	// provider titles, IDs, tokens, or raw upstream text.
	throw new Error("Invalid label sync mutation attempt");
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
	return value as Record<string, unknown>;
}

function boundedString(value: unknown, maxLength: number): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
		return invalid();
	}
	return value;
}

function nullableBoundedString(value: unknown, maxLength: number): string | null {
	if (value === null) return null;
	return boundedString(value, maxLength);
}

function safeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
		return invalid();
	}
	return value;
}

function positiveSafeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
	const integer = safeInteger(value, max);
	if (integer < 1) return invalid();
	return integer;
}

function date(value: unknown, nullable: boolean): Date | null {
	if (value === null && nullable) return null;
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return invalid();
		return new Date(value.getTime());
	}
	if (typeof value !== "string" || value.length === 0) {
		return invalid();
	}
	const match =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/.exec(
			value,
		);
	if (!match) return invalid();
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const daysInMonth =
		month === 2
			? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
				? 29
				: 28
			: [4, 6, 9, 11].includes(month)
				? 30
				: 31;
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		return invalid();
	}
	const timezone = match[7];
	if (!timezone) return invalid();
	if (timezone !== "Z") {
		const offset = timezone.slice(1).replace(":", "");
		if (Number(offset.slice(0, 2)) > 23 || Number(offset.slice(2)) > 59) return invalid();
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return invalid();
	return parsed;
}

export function parseLabelSyncMutationStatus(value: unknown): LabelSyncMutationStatus {
	if (
		typeof value === "string" &&
		(LABEL_SYNC_MUTATION_STATUSES as readonly string[]).includes(value)
	) {
		return value as LabelSyncMutationStatus;
	}
	return invalid();
}

export function parseLabelSyncMutationReasonCode(value: unknown): LabelSyncMutationReasonCode {
	if (
		typeof value === "string" &&
		(LABEL_SYNC_MUTATION_REASON_CODES as readonly string[]).includes(value)
	) {
		return value as LabelSyncMutationReasonCode;
	}
	return invalid();
}

export function parseLabelSyncMutationAttempt(value: unknown): LabelSyncMutationAttemptRecord {
	const input = record(value);
	const allowedFields = new Set([
		"id",
		"userId",
		"ruleId",
		"destinationInstanceId",
		"provider",
		"mediaType",
		"tmdbId",
		"connectionGeneration",
		"identityGeneration",
		"targetItemId",
		"libraryId",
		"intentFingerprint",
		"ruleFingerprint",
		"destinationTag",
		"activeOperationKey",
		"claimToken",
		"sendAttemptCount",
		"reconcileAttemptCount",
		"requestStartedAt",
		"lastObservedAt",
		"completedAt",
		"status",
		"reasonCode",
		"createdAt",
		"updatedAt",
	]);
	if (Object.keys(input).some((field) => !allowedFields.has(field))) return invalid();
	const status = parseLabelSyncMutationStatus(input.status);
	const activeOperationKey = nullableBoundedString(input.activeOperationKey, MAX_IDENTIFIER_LENGTH);
	const claimToken = nullableBoundedString(input.claimToken, MAX_IDENTIFIER_LENGTH);
	const completedAt = date(input.completedAt, true);

	if (
		LABEL_SYNC_MUTATION_UNRESOLVED_STATUSES.includes(
			status as (typeof LABEL_SYNC_MUTATION_UNRESOLVED_STATUSES)[number],
		)
	) {
		if (activeOperationKey === null) return invalid();
		if ((status === "claimed" || status === "sending") && claimToken === null) return invalid();
		if (completedAt !== null) return invalid();
	} else {
		if (activeOperationKey !== null || claimToken !== null || completedAt === null)
			return invalid();
	}

	const reasonCode =
		input.reasonCode === null ? null : parseLabelSyncMutationReasonCode(input.reasonCode);
	const provider = input.provider;
	const mediaType = input.mediaType;
	if (
		typeof provider !== "string" ||
		!(LABEL_SYNC_MUTATION_PROVIDERS as readonly string[]).includes(provider) ||
		typeof mediaType !== "string" ||
		!(LABEL_SYNC_MUTATION_MEDIA_TYPES as readonly string[]).includes(mediaType)
	) {
		return invalid();
	}

	const parsed: LabelSyncMutationAttemptRecord = {
		id: boundedString(input.id, MAX_IDENTIFIER_LENGTH),
		userId: boundedString(input.userId, MAX_IDENTIFIER_LENGTH),
		ruleId: boundedString(input.ruleId, MAX_IDENTIFIER_LENGTH),
		destinationInstanceId: boundedString(input.destinationInstanceId, MAX_IDENTIFIER_LENGTH),
		provider: provider as LabelSyncMutationProvider,
		mediaType: mediaType as LabelSyncMutationMediaType,
		tmdbId: positiveSafeInteger(input.tmdbId, MAX_PORTABLE_INT),
		connectionGeneration: safeInteger(input.connectionGeneration, MAX_PORTABLE_INT),
		identityGeneration: safeInteger(input.identityGeneration, MAX_PORTABLE_INT),
		targetItemId: boundedString(input.targetItemId, MAX_IDENTIFIER_LENGTH),
		libraryId: boundedString(input.libraryId, MAX_IDENTIFIER_LENGTH),
		intentFingerprint: boundedString(input.intentFingerprint, MAX_FINGERPRINT_LENGTH),
		ruleFingerprint: boundedString(input.ruleFingerprint, MAX_FINGERPRINT_LENGTH),
		destinationTag: boundedString(input.destinationTag, MAX_TAG_LENGTH),
		activeOperationKey,
		claimToken,
		sendAttemptCount: safeInteger(input.sendAttemptCount, MAX_LABEL_SYNC_MUTATION_ATTEMPTS),
		reconcileAttemptCount: safeInteger(
			input.reconcileAttemptCount,
			MAX_LABEL_SYNC_MUTATION_ATTEMPTS,
		),
		requestStartedAt: date(input.requestStartedAt, true),
		lastObservedAt: date(input.lastObservedAt, true),
		completedAt,
		status,
		reasonCode,
		createdAt: date(input.createdAt, false) as Date,
		updatedAt: date(input.updatedAt, false) as Date,
	};
	validateLabelSyncMutationAttemptLifecycle(parsed);
	return parsed;
}

export function isLabelSyncMutationUnresolved(status: LabelSyncMutationStatus): boolean {
	return (LABEL_SYNC_MUTATION_UNRESOLVED_STATUSES as readonly string[]).includes(status);
}
