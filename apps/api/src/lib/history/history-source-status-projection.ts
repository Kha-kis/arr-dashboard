import type {
	ProviderObservationAttemptState,
	ProviderObservationReasonCode,
	ProviderObservationStatus,
} from "@arr/shared";
import type { HistoryService } from "../dashboard/history-utils.js";
import { evaluateProviderCoverageReceipt } from "../provider-observation/coverage-receipt.js";
import { projectProviderObservationStatus } from "../provider-observation/status-projection.js";
import { decodeHistoryObservationMetadata } from "./history-observation-metadata.js";
import {
	decodeHistorySourceAttemptProjection,
	type HistorySourceAttemptProjection,
} from "./history-source-attempt.js";

const HISTORY_SERVICES: readonly HistoryService[] = [
	"sonarr",
	"radarr",
	"prowlarr",
	"lidarr",
	"readarr",
];
const PUBLICATION_MAX_AGE_MS = 15 * 60 * 1000;
const STATUS_KEYS = [
	"connectionGeneration",
	"publishedAt",
	"publicationMetadata",
	"lastAttemptAt",
	"lastAttemptResult",
	"lastAttemptReason",
] as const;

export type HistorySourceStatusProjectionInput = {
	service: HistoryService;
	connectionGeneration: number;
	status: null | {
		connectionGeneration: unknown;
		publishedAt: unknown;
		publicationMetadata: unknown;
		lastAttemptAt: unknown;
		lastAttemptResult: unknown;
		lastAttemptReason: unknown;
	};
	now: unknown;
};

export function projectHistorySourceStatus(
	input: HistorySourceStatusProjectionInput,
): ProviderObservationStatus {
	if (!isRecord(input)) return unavailable("unknown-failure");
	if (!isHistoryService(input.service)) return unavailable("identity-unverified");
	if (!isSafeGeneration(input.connectionGeneration)) return unavailable("unknown-failure");
	const now = parseDatabaseDate(input.now);
	if (!now) return unavailable("unknown-failure");

	if (input.status === null)
		return noPublication({ valid: true, state: "idle", attemptedAt: null, reason: null });
	if (!isRecord(input.status) || !hasStatusShape(input.status)) {
		return unavailable("unknown-failure");
	}
	if (input.status.connectionGeneration !== input.connectionGeneration) {
		return unavailable("identity-changed");
	}

	const attempt = decodeHistorySourceAttemptProjection(
		input.status.lastAttemptAt,
		input.status.lastAttemptResult,
		input.status.lastAttemptReason,
	);
	if (!attempt.valid) return unavailable("unknown-failure");
	if (attempt.attemptedAt && attempt.attemptedAt.getTime() > now.getTime()) {
		return unavailable("unknown-failure");
	}

	const publishedAt = input.status.publishedAt;
	const publicationMetadata = input.status.publicationMetadata;
	if (publishedAt === null && publicationMetadata === null) return noPublication(attempt);
	if ((publishedAt === null) !== (publicationMetadata === null)) {
		return invalidPublication("receipt-invalid", attempt);
	}

	const publishedDate =
		publishedAt instanceof Date && Number.isFinite(publishedAt.getTime())
			? new Date(publishedAt.getTime())
			: null;
	if (!publishedDate) return invalidPublication("receipt-invalid", attempt);
	if (publishedDate.getTime() > now.getTime()) {
		return invalidPublication("unknown-failure", attempt);
	}
	const metadataResult = decodeHistoryObservationMetadata(publicationMetadata, now);
	if (!metadataResult.ok) return invalidPublication("receipt-invalid", attempt);
	const metadata = metadataResult.metadata;
	if (
		metadata.service !== input.service ||
		metadata.connectionGeneration !== input.connectionGeneration
	) {
		return invalidPublication("identity-changed", attempt);
	}
	if (metadata.observedAt !== publishedDate.toISOString()) {
		return invalidPublication("receipt-invalid", attempt);
	}

	const evaluation = evaluateProviderCoverageReceipt(metadata.coverageReceipt);
	if (!evaluation.valid) return invalidPublication("receipt-invalid", attempt);
	const projected = projectProviderObservationStatus({
		identity: "current",
		publication: { observedAt: new Date(publishedDate.getTime()), evaluation },
		latestAttempt: toGenericAttempt(attempt),
		now: new Date(now.getTime()),
		maxAgeMs: PUBLICATION_MAX_AGE_MS,
	});
	return addAttemptReason(projected, attempt);
}

function noPublication(attempt: HistorySourceAttemptProjection): ProviderObservationStatus {
	const latestAttempt = attemptState(attempt);
	const reasons: ProviderObservationReasonCode[] = ["no-publication"];
	if (attempt.valid && attempt.state === "running") reasons.push("refresh-running");
	if (attempt.valid && attempt.state === "failed") reasons.push(attempt.reason);
	if (attempt.valid && attempt.state === "successful")
		reasons.splice(0, reasons.length, "unknown-failure");
	return unavailableWithLatest(reasons, latestAttempt);
}

function invalidPublication(
	reason: ProviderObservationReasonCode,
	attempt: HistorySourceAttemptProjection,
): ProviderObservationStatus {
	const reasons: ProviderObservationReasonCode[] = [reason];
	if (attempt.valid && attempt.state === "failed") reasons.push(attempt.reason);
	return unavailableWithLatest(reasons, attemptState(attempt));
}

function addAttemptReason(
	projected: ProviderObservationStatus,
	attempt: HistorySourceAttemptProjection,
): ProviderObservationStatus {
	if (!attempt.valid || attempt.state !== "failed") return projected;
	const reasonCodes = [...projected.reasonCodes];
	if (!reasonCodes.includes(attempt.reason)) {
		const refreshIndex = reasonCodes.indexOf("refresh-failed");
		if (refreshIndex >= 0) reasonCodes.splice(refreshIndex, 0, attempt.reason);
		else reasonCodes.push(attempt.reason);
	}
	if (attempt.attemptedAt.getTime() <= Date.parse(projected.observedAt ?? "")) {
		const refreshIndex = reasonCodes.indexOf("refresh-failed");
		if (refreshIndex >= 0) reasonCodes.splice(refreshIndex, 1);
	}
	return { ...projected, latestAttempt: "failed", reasonCodes: uniqueReasons(reasonCodes) };
}

function unavailable(reason: ProviderObservationReasonCode): ProviderObservationStatus {
	return unavailableWithLatest([reason], "idle");
}

function unavailableWithLatest(
	reasonCodes: readonly ProviderObservationReasonCode[],
	latestAttempt: ProviderObservationAttemptState,
): ProviderObservationStatus {
	return {
		availability: "unavailable",
		evidence: "unknown",
		observedAt: null,
		ageSeconds: null,
		latestAttempt,
		reasonCodes: uniqueReasons(reasonCodes),
	};
}

function toGenericAttempt(
	attempt: HistorySourceAttemptProjection,
): { state: Exclude<ProviderObservationAttemptState, "idle">; attemptedAt: Date } | null {
	if (!attempt.valid || attempt.state === "idle") return null;
	return { state: attempt.state, attemptedAt: new Date(attempt.attemptedAt.getTime()) };
}

function attemptState(attempt: HistorySourceAttemptProjection): ProviderObservationAttemptState {
	return attempt.valid ? attempt.state : "idle";
}

function uniqueReasons(
	reasons: readonly ProviderObservationReasonCode[],
): ProviderObservationReasonCode[] {
	return [...new Set(reasons)];
}

function hasStatusShape(value: Record<string, unknown>): boolean {
	return STATUS_KEYS.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHistoryService(value: unknown): value is HistoryService {
	return typeof value === "string" && HISTORY_SERVICES.includes(value as HistoryService);
}

function isSafeGeneration(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseDatabaseDate(value: unknown): Date | null {
	if (value instanceof Date)
		return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
	if (typeof value !== "string" || value.length === 0) return null;
	const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
	const parsed = new Date(normalized);
	return Number.isFinite(parsed.getTime()) ? parsed : null;
}
