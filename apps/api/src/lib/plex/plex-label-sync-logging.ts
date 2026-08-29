import type { PlexCoverageReasonCode, PlexEvidenceSummary } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { PlexResponseCategory } from "./plex-client.js";

export type PlexMetadataTagMutationFailureReason =
	| "cached_target_unavailable"
	| "cached_target_ambiguous"
	| "cached_target_inconsistent"
	| "provider_authority_unavailable"
	| "live_target_missing"
	| "live_target_ambiguous"
	| "live_target_changed"
	| "live_evidence_unavailable"
	| "provider_identity_changed"
	| "provider_connection_changed"
	| "upstream_write_failed"
	| "publication_superseded"
	| "unknown_failure";

export type PlexLabelSyncTerminalReason =
	| Exclude<PlexMetadataTagMutationFailureReason, "provider_authority_unavailable">
	| "source_authority_unavailable"
	| "source_read_failed"
	| "source_evidence_changed"
	| "source_evidence_ambiguous"
	| "provider_attempt_unavailable"
	| "upstream_write_rejected"
	| "success";

export type PlexLabelSyncTerminalClassificationInput =
	| {
			stage: "source_authority" | "source_read";
			code: PlexCoverageReasonCode | "source_read_failed";
	  }
	| {
			stage: "destination_authority";
			code: PlexMetadataTagMutationFailureReason;
	  }
	| {
			stage: "upstream_write";
			code: PlexResponseCategory;
	  }
	| {
			stage: "success";
			code: "success";
	  };

export class PlexMetadataTagWriteError extends Error {
	readonly code = "upstream_write_failed" as const;

	constructor(readonly responseCategory: PlexResponseCategory = "unavailable") {
		super("Plex metadata tag write failed");
		this.name = "PlexMetadataTagWriteError";
		delete this.stack;
	}
}

export type PlexLabelMutationCaughtErrorClassification =
	| {
			stage: "destination_authority";
			reasonCode: "unknown_failure";
	  }
	| {
			stage: "upstream_write";
			reasonCode: "upstream_write_rejected" | "upstream_write_failed";
			upstreamCategory: PlexResponseCategory;
	  };

function classifyPlexUpstreamWriteReason(
	responseCategory: PlexResponseCategory,
): "upstream_write_rejected" | "upstream_write_failed" {
	switch (responseCategory) {
		case "client_error":
			return "upstream_write_rejected";
		case "server_error":
		case "timeout":
		case "unavailable":
			return "upstream_write_failed";
	}
	return assertNever(responseCategory);
}

export function classifyPlexLabelMutationCaughtError(
	error: unknown,
): PlexLabelMutationCaughtErrorClassification {
	if (!(error instanceof PlexMetadataTagWriteError)) {
		return {
			stage: "destination_authority",
			reasonCode: "unknown_failure",
		};
	}
	return {
		stage: "upstream_write",
		reasonCode: classifyPlexUpstreamWriteReason(error.responseCategory),
		upstreamCategory: error.responseCategory,
	};
}

const PLEX_COVERAGE_REASON_CODES = new Set<PlexCoverageReasonCode>([
	"disabled_instance",
	"missing_status",
	"unpublished_generation",
	"missing_generation_id",
	"missing_metadata",
	"malformed_metadata",
	"unknown_metadata_version",
	"invalid_publication_level",
	"invalid_completeness",
	"invalid_item_count",
	"invalid_sections",
	"duplicate_sections",
	"stale_generation",
	"generation_changed",
	"published_timestamp_changed",
	"row_count_mismatch",
	"connection_generation_mismatch",
	"identity_generation_mismatch",
	"latest_attempt_failed",
	"latest_attempt_in_progress",
	"latest_attempt_partial",
	"latest_attempt_unknown",
	"latest_attempt_missing",
	"latest_attempt_future_dated",
	"published_generation_stale",
	"metadata_invalid",
	"mutation_authority_unavailable",
	"query_failed",
	"parent_generation_unavailable",
	"plex_activity_unavailable",
	"plex_section_state_unavailable",
	"plex_library_scan_in_progress",
	"plex_metadata_refresh_in_progress",
	"plex_library_activity_unknown",
	"plex_library_revision_changed",
	"plex_content_digest_changed",
	"plex_settlement_metadata_missing",
	"target_ledger_binding_missing",
	"target_ledger_invalid",
	"target_ledger_unavailable",
	"target_count_mismatch",
	"target_digest_mismatch",
	"target_section_mismatch",
]);

const PLEX_MUTATION_FAILURE_REASONS = new Set<PlexMetadataTagMutationFailureReason>([
	"cached_target_unavailable",
	"cached_target_ambiguous",
	"cached_target_inconsistent",
	"provider_authority_unavailable",
	"live_target_missing",
	"live_target_ambiguous",
	"live_target_changed",
	"live_evidence_unavailable",
	"provider_identity_changed",
	"provider_connection_changed",
	"upstream_write_failed",
	"publication_superseded",
	"unknown_failure",
]);

function assertNever(value: never): never {
	throw new Error(typeof value === "string" ? "Unclassified Plex reason" : "Unclassified value");
}

function classifySourceCoverageReason(
	reasonCode: PlexCoverageReasonCode,
): PlexLabelSyncTerminalReason {
	switch (reasonCode) {
		case "disabled_instance":
		case "missing_status":
		case "unpublished_generation":
		case "missing_generation_id":
		case "missing_metadata":
		case "malformed_metadata":
		case "unknown_metadata_version":
		case "invalid_publication_level":
		case "invalid_completeness":
		case "invalid_item_count":
		case "invalid_sections":
		case "stale_generation":
		case "row_count_mismatch":
		case "latest_attempt_failed":
		case "latest_attempt_in_progress":
		case "latest_attempt_partial":
		case "latest_attempt_unknown":
		case "latest_attempt_missing":
		case "latest_attempt_future_dated":
		case "published_generation_stale":
		case "metadata_invalid":
		case "parent_generation_unavailable":
		case "plex_settlement_metadata_missing":
			return "source_authority_unavailable";
		case "generation_changed":
		case "published_timestamp_changed":
		case "connection_generation_mismatch":
		case "identity_generation_mismatch":
		case "plex_library_scan_in_progress":
		case "plex_metadata_refresh_in_progress":
		case "plex_library_revision_changed":
		case "plex_content_digest_changed":
			return "source_evidence_changed";
		case "duplicate_sections":
		case "target_ledger_binding_missing":
		case "target_ledger_invalid":
		case "target_ledger_unavailable":
		case "target_count_mismatch":
		case "target_digest_mismatch":
		case "target_section_mismatch":
			return "source_evidence_ambiguous";
		case "mutation_authority_unavailable":
		case "query_failed":
		case "plex_activity_unavailable":
		case "plex_section_state_unavailable":
		case "plex_library_activity_unknown":
			return "source_read_failed";
	}
	return assertNever(reasonCode);
}

function classifyDestinationCoverageReason(
	reasonCode: PlexCoverageReasonCode,
): PlexMetadataTagMutationFailureReason {
	switch (reasonCode) {
		case "connection_generation_mismatch":
			return "provider_connection_changed";
		case "identity_generation_mismatch":
			return "provider_identity_changed";
		case "generation_changed":
		case "published_timestamp_changed":
		case "latest_attempt_failed":
		case "latest_attempt_in_progress":
		case "latest_attempt_partial":
		case "latest_attempt_unknown":
		case "latest_attempt_missing":
		case "latest_attempt_future_dated":
			return "publication_superseded";
		case "plex_content_digest_changed":
			return "live_evidence_unavailable";
		case "disabled_instance":
		case "missing_status":
		case "unpublished_generation":
		case "missing_generation_id":
		case "missing_metadata":
		case "malformed_metadata":
		case "unknown_metadata_version":
		case "invalid_publication_level":
		case "invalid_completeness":
		case "invalid_item_count":
		case "invalid_sections":
		case "duplicate_sections":
		case "stale_generation":
		case "row_count_mismatch":
		case "published_generation_stale":
		case "metadata_invalid":
		case "mutation_authority_unavailable":
		case "query_failed":
		case "parent_generation_unavailable":
		case "plex_activity_unavailable":
		case "plex_section_state_unavailable":
		case "plex_library_scan_in_progress":
		case "plex_metadata_refresh_in_progress":
		case "plex_library_activity_unknown":
		case "plex_library_revision_changed":
		case "plex_settlement_metadata_missing":
		case "target_ledger_binding_missing":
		case "target_ledger_invalid":
		case "target_ledger_unavailable":
		case "target_count_mismatch":
		case "target_digest_mismatch":
		case "target_section_mismatch":
			return "provider_authority_unavailable";
	}
	return assertNever(reasonCode);
}

function classifyMutationReason(
	reasonCode: PlexMetadataTagMutationFailureReason,
): PlexLabelSyncTerminalReason {
	switch (reasonCode) {
		case "cached_target_unavailable":
		case "cached_target_ambiguous":
		case "cached_target_inconsistent":
		case "live_target_missing":
		case "live_target_ambiguous":
		case "live_target_changed":
		case "live_evidence_unavailable":
		case "provider_identity_changed":
		case "provider_connection_changed":
		case "upstream_write_failed":
		case "publication_superseded":
		case "unknown_failure":
			return reasonCode;
		case "provider_authority_unavailable":
			return "provider_attempt_unavailable";
	}
	return assertNever(reasonCode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isCoverageReason(value: unknown): value is PlexCoverageReasonCode {
	return (
		typeof value === "string" && PLEX_COVERAGE_REASON_CODES.has(value as PlexCoverageReasonCode)
	);
}

function isMutationReason(value: unknown): value is PlexMetadataTagMutationFailureReason {
	return (
		typeof value === "string" &&
		PLEX_MUTATION_FAILURE_REASONS.has(value as PlexMetadataTagMutationFailureReason)
	);
}

function isResponseCategory(value: unknown): value is PlexResponseCategory {
	return (
		value === "client_error" ||
		value === "server_error" ||
		value === "timeout" ||
		value === "unavailable"
	);
}

export function classifyPlexLabelSyncTerminalReason(
	input: PlexLabelSyncTerminalClassificationInput,
): PlexLabelSyncTerminalReason {
	switch (input.stage) {
		case "source_authority":
		case "source_read":
			if (input.code === "source_read_failed") return "source_read_failed";
			return classifySourceCoverageReason(input.code);
		case "destination_authority":
			return classifyMutationReason(input.code);
		case "upstream_write":
			return classifyPlexUpstreamWriteReason(input.code);
		case "success":
			return "success";
	}
	return assertNever(input);
}

export function classifyUnknownPlexLabelSyncTerminalReason(
	input: unknown,
): PlexLabelSyncTerminalReason {
	if (!isRecord(input) || typeof input.stage !== "string") return "unknown_failure";
	switch (input.stage) {
		case "source_authority":
		case "source_read":
			if (input.code === "source_read_failed") return "source_read_failed";
			return isCoverageReason(input.code)
				? classifySourceCoverageReason(input.code)
				: "unknown_failure";
		case "destination_authority":
			return isMutationReason(input.code) ? classifyMutationReason(input.code) : "unknown_failure";
		case "upstream_write":
			return isResponseCategory(input.code)
				? input.code === "client_error"
					? "upstream_write_rejected"
					: "upstream_write_failed"
				: "unknown_failure";
		case "success":
			return input.code === "success" ? "success" : "unknown_failure";
		default:
			return "unknown_failure";
	}
}

export function classifyPlexMetadataTagEvidenceFailure(
	evidence: PlexEvidenceSummary,
): PlexMetadataTagMutationFailureReason {
	for (const reasonCode of evidence.reasonCodes) {
		const classified = classifyDestinationCoverageReason(reasonCode);
		if (classified !== "provider_authority_unavailable") return classified;
	}
	return "provider_authority_unavailable";
}

export function createLabelSyncPlexProviderLogSink(): FastifyBaseLogger {
	let sink: FastifyBaseLogger;
	const ignore = (..._args: unknown[]) => undefined;
	sink = {
		child: () => sink,
		info: ignore,
		warn: ignore,
		error: ignore,
		debug: ignore,
		trace: ignore,
		fatal: ignore,
	} as unknown as FastifyBaseLogger;
	return sink;
}

export type PlexLabelSyncTerminalEvent = {
	operation: "source_read" | "destination_write";
	state: "failed" | "success";
	stage:
		| "source_authority"
		| "source_read"
		| "destination_authority"
		| "upstream_write"
		| "success";
	reasonCode: PlexLabelSyncTerminalReason;
	mediaCategory?: "movie" | "series";
	candidateCount?: number;
	upstreamCategory?: PlexResponseCategory;
};

export function logPlexLabelSyncTerminal(
	log: FastifyBaseLogger,
	event: PlexLabelSyncTerminalEvent,
): void {
	const projection: PlexLabelSyncTerminalEvent = {
		operation: event.operation,
		state: event.state,
		stage: event.stage,
		reasonCode: event.reasonCode,
	};
	if (event.mediaCategory === "movie" || event.mediaCategory === "series") {
		projection.mediaCategory = event.mediaCategory;
	}
	if (
		event.candidateCount !== undefined &&
		Number.isSafeInteger(event.candidateCount) &&
		event.candidateCount >= 0
	) {
		projection.candidateCount = event.candidateCount;
	}
	if (event.upstreamCategory && isResponseCategory(event.upstreamCategory)) {
		projection.upstreamCategory = event.upstreamCategory;
	}
	const message =
		event.operation === "source_read"
			? event.state === "success"
				? "Plex label-sync source read succeeded"
				: "Plex label-sync source read failed"
			: event.state === "success"
				? "Plex label-sync destination write succeeded"
				: "Plex label-sync destination write failed";
	if (event.state === "success") log.info(projection, message);
	else log.warn(projection, message);
}
