import type { PlexCoverageReasonCode, PlexEvidenceSummary } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PlexResponseCategory } from "../plex-client.js";
import {
	classifyPlexLabelMutationCaughtError,
	classifyPlexLabelSyncTerminalReason,
	classifyPlexMetadataTagEvidenceFailure,
	classifyUnknownPlexLabelSyncTerminalReason,
	createLabelSyncPlexProviderLogSink,
	logPlexLabelSyncTerminal,
	PlexMetadataTagWriteError,
	type PlexMetadataTagMutationFailureReason,
} from "../plex-label-sync-logging.js";

const coverageMatrix = [
	["disabled_instance", "source_authority_unavailable", "provider_authority_unavailable"],
	["missing_status", "source_authority_unavailable", "provider_authority_unavailable"],
	["unpublished_generation", "source_authority_unavailable", "provider_authority_unavailable"],
	["missing_generation_id", "source_authority_unavailable", "provider_authority_unavailable"],
	["missing_metadata", "source_authority_unavailable", "provider_authority_unavailable"],
	["malformed_metadata", "source_authority_unavailable", "provider_authority_unavailable"],
	["unknown_metadata_version", "source_authority_unavailable", "provider_authority_unavailable"],
	["invalid_publication_level", "source_authority_unavailable", "provider_authority_unavailable"],
	["invalid_completeness", "source_authority_unavailable", "provider_authority_unavailable"],
	["invalid_item_count", "source_authority_unavailable", "provider_authority_unavailable"],
	["invalid_sections", "source_authority_unavailable", "provider_authority_unavailable"],
	["duplicate_sections", "source_evidence_ambiguous", "provider_authority_unavailable"],
	["stale_generation", "source_authority_unavailable", "provider_authority_unavailable"],
	["generation_changed", "source_evidence_changed", "publication_superseded"],
	["published_timestamp_changed", "source_evidence_changed", "publication_superseded"],
	["row_count_mismatch", "source_authority_unavailable", "provider_authority_unavailable"],
	["connection_generation_mismatch", "source_evidence_changed", "provider_connection_changed"],
	["identity_generation_mismatch", "source_evidence_changed", "provider_identity_changed"],
	["latest_attempt_failed", "source_authority_unavailable", "publication_superseded"],
	["latest_attempt_in_progress", "source_authority_unavailable", "publication_superseded"],
	["latest_attempt_partial", "source_authority_unavailable", "publication_superseded"],
	["latest_attempt_unknown", "source_authority_unavailable", "publication_superseded"],
	["latest_attempt_missing", "source_authority_unavailable", "publication_superseded"],
	["latest_attempt_future_dated", "source_authority_unavailable", "publication_superseded"],
	["published_generation_stale", "source_authority_unavailable", "provider_authority_unavailable"],
	["metadata_invalid", "source_authority_unavailable", "provider_authority_unavailable"],
	["mutation_authority_unavailable", "source_read_failed", "provider_authority_unavailable"],
	["query_failed", "source_read_failed", "provider_authority_unavailable"],
	[
		"parent_generation_unavailable",
		"source_authority_unavailable",
		"provider_authority_unavailable",
	],
	["plex_activity_unavailable", "source_read_failed", "provider_authority_unavailable"],
	["plex_section_state_unavailable", "source_read_failed", "provider_authority_unavailable"],
	["plex_library_scan_in_progress", "source_evidence_changed", "provider_authority_unavailable"],
	[
		"plex_metadata_refresh_in_progress",
		"source_evidence_changed",
		"provider_authority_unavailable",
	],
	["plex_library_activity_unknown", "source_read_failed", "provider_authority_unavailable"],
	["plex_library_revision_changed", "source_evidence_changed", "provider_authority_unavailable"],
	["plex_content_digest_changed", "source_evidence_changed", "live_target_changed"],
	[
		"plex_settlement_metadata_missing",
		"source_authority_unavailable",
		"provider_authority_unavailable",
	],
	["target_ledger_binding_missing", "source_evidence_ambiguous", "provider_authority_unavailable"],
	["target_ledger_invalid", "source_evidence_ambiguous", "provider_authority_unavailable"],
	["target_ledger_unavailable", "source_evidence_ambiguous", "provider_authority_unavailable"],
	["target_count_mismatch", "source_evidence_ambiguous", "provider_authority_unavailable"],
	["target_digest_mismatch", "source_evidence_ambiguous", "provider_authority_unavailable"],
	["target_section_mismatch", "source_evidence_ambiguous", "provider_authority_unavailable"],
] as const satisfies ReadonlyArray<
	readonly [PlexCoverageReasonCode, string, PlexMetadataTagMutationFailureReason]
>;

type MissingCoverageReason = Exclude<PlexCoverageReasonCode, (typeof coverageMatrix)[number][0]>;
const coverageMatrixIsExhaustive: MissingCoverageReason extends never ? true : never = true;

const mutationMatrix = [
	["cached_target_unavailable", "cached_target_unavailable"],
	["cached_target_ambiguous", "cached_target_ambiguous"],
	["cached_target_inconsistent", "cached_target_inconsistent"],
	["provider_authority_unavailable", "provider_attempt_unavailable"],
	["live_target_missing", "live_target_missing"],
	["live_target_ambiguous", "live_target_ambiguous"],
	["live_target_changed", "live_target_changed"],
	["provider_identity_changed", "provider_identity_changed"],
	["provider_connection_changed", "provider_connection_changed"],
	["upstream_write_failed", "upstream_write_failed"],
	["publication_superseded", "publication_superseded"],
	["unknown_failure", "unknown_failure"],
] as const satisfies ReadonlyArray<readonly [PlexMetadataTagMutationFailureReason, string]>;

type MissingMutationReason = Exclude<
	PlexMetadataTagMutationFailureReason,
	(typeof mutationMatrix)[number][0]
>;
const mutationMatrixIsExhaustive: MissingMutationReason extends never ? true : never = true;

const upstreamWriteMatrix = [
	["client_error", "upstream_write_rejected"],
	["server_error", "upstream_write_failed"],
	["timeout", "upstream_write_failed"],
	["unavailable", "upstream_write_failed"],
] as const satisfies ReadonlyArray<readonly [PlexResponseCategory, string]>;

type MissingUpstreamCategory = Exclude<
	PlexResponseCategory,
	(typeof upstreamWriteMatrix)[number][0]
>;
const upstreamWriteMatrixIsExhaustive: MissingUpstreamCategory extends never ? true : never = true;

function evidence(reasonCode: PlexCoverageReasonCode): PlexEvidenceSummary {
	return {
		publicationLevel: "unavailable",
		completeness: "unknown",
		reasonCodes: [reasonCode],
	};
}

function createLogger(): FastifyBaseLogger {
	const logger = {
		child: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
	} as unknown as FastifyBaseLogger;
	(logger.child as unknown as ReturnType<typeof vi.fn>).mockReturnValue(logger);
	return logger;
}

describe("Plex label-sync logging boundary", () => {
	it.each(coverageMatrix)(
		"classifies coverage reason %s exhaustively",
		(reasonCode, sourceReason, destinationReason) => {
			expect(coverageMatrixIsExhaustive).toBe(true);
			expect(classifyPlexLabelSyncTerminalReason({ stage: "source_read", code: reasonCode })).toBe(
				sourceReason,
			);
			expect(classifyPlexMetadataTagEvidenceFailure(evidence(reasonCode))).toBe(destinationReason);
		},
	);

	it.each(mutationMatrix)("classifies mutation reason %s exhaustively", (reasonCode, terminal) => {
		expect(mutationMatrixIsExhaustive).toBe(true);
		expect(
			classifyPlexLabelSyncTerminalReason({
				stage: "destination_authority",
				code: reasonCode,
			}),
		).toBe(terminal);
	});

	it.each(upstreamWriteMatrix)("classifies %s write failures", (category, reasonCode) => {
		expect(upstreamWriteMatrixIsExhaustive).toBe(true);
		expect(classifyPlexLabelSyncTerminalReason({ stage: "upstream_write", code: category })).toBe(
			reasonCode,
		);
	});

	it.each(upstreamWriteMatrix)(
		"classifies a typed %s mutation exception as an attempted write",
		(category, reasonCode) => {
			expect(upstreamWriteMatrixIsExhaustive).toBe(true);
			const classification = classifyPlexLabelMutationCaughtError(
				new PlexMetadataTagWriteError(category),
			);

			expect(classification).toEqual({
				stage: "upstream_write",
				reasonCode,
				upstreamCategory: category,
			});
		},
	);

	it.each([
		["Error", new Error("CANARY_PRE_WRITE_ERROR_787")],
		["string", "CANARY_PRE_WRITE_STRING_787"],
		["object", { privateField: "CANARY_PRE_WRITE_FIELD_787" }],
		["null", null],
		["undefined", undefined],
	] as const)(
		"classifies an untyped pre-write %s without projecting its content",
		(_name, caught) => {
			const classification = classifyPlexLabelMutationCaughtError(caught);

			expect(classification).toEqual({
				stage: "destination_authority",
				reasonCode: "unknown_failure",
			});
			expect(JSON.stringify(classification)).not.toContain("CANARY_PRE_WRITE");
		},
	);

	it("maps unknown runtime input to the closed fallback", () => {
		expect(
			classifyUnknownPlexLabelSyncTerminalReason({
				stage: "private",
				code: new Error("private"),
			}),
		).toBe("unknown_failure");
	});

	it("drops every nested provider log argument without retaining or forwarding it", () => {
		const parent = createLogger();
		const sink = createLabelSyncPlexProviderLogSink();
		const privateError = new Error("CANARY_PROVIDER_ERROR_787");
		const privateFields = { err: privateError, token: "CANARY_PROVIDER_TOKEN_787" };

		sink.warn(privateFields, "CANARY_PROVIDER_MESSAGE_787");
		sink.error(privateFields, "CANARY_PROVIDER_MESSAGE_787");
		sink.fatal(privateFields, "CANARY_PROVIDER_MESSAGE_787");
		sink.child(privateFields).warn(privateFields, "CANARY_PROVIDER_MESSAGE_787");

		for (const method of [
			parent.info,
			parent.warn,
			parent.error,
			parent.debug,
			parent.trace,
			parent.fatal,
		]) {
			expect(method).not.toHaveBeenCalled();
		}
		expect(JSON.stringify(sink)).not.toContain("CANARY_PROVIDER");
	});

	it("constructs an exact fresh terminal projection", () => {
		const log = createLogger();
		logPlexLabelSyncTerminal(log, {
			operation: "destination_write",
			state: "failed",
			stage: "upstream_write",
			reasonCode: "upstream_write_rejected",
			mediaCategory: "movie",
			candidateCount: 1,
			upstreamCategory: "client_error",
		});

		expect(log.warn).toHaveBeenCalledOnce();
		expect(log.warn).toHaveBeenCalledWith(
			{
				operation: "destination_write",
				state: "failed",
				stage: "upstream_write",
				reasonCode: "upstream_write_rejected",
				mediaCategory: "movie",
				candidateCount: 1,
				upstreamCategory: "client_error",
			},
			"Plex label-sync destination write failed",
		);
	});
});
