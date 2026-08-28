/**
 * Destination writer for Plex instances.
 *
 * Resolves match candidates against PlexCache (keyed on tmdbId) to find each
 * Plex item's `ratingKey`, then calls the Plex metadata-tags endpoint to
 * apply the destination label.
 */

import type { PlexCoverageReasonCode, PlexEvidenceSummary } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import {
	PlexAuthorityService,
	PlexMetadataTagWriteError,
	type PlexMetadataTagMutationFailureReason,
} from "../../plex/plex-authority-service.js";
import type { DestWriteResult, DestWriter, DestWriterOpts } from "../strategy-types.js";

type PlexResponseCategory = "client_error" | "server_error" | "timeout" | "unavailable";

function logPlexLabelMutationFailure(
	log: FastifyBaseLogger,
	reasonCode: PlexMetadataTagMutationFailureReason,
	options: {
		mediaCategory?: "movie" | "series";
		candidateCount?: number;
		responseCategory?: PlexResponseCategory;
	} = {},
) {
	const projection: {
		operation: "plex_label_mutation";
		reasonCode: PlexMetadataTagMutationFailureReason;
		mediaCategory?: "movie" | "series";
		candidateCount?: number;
		responseCategory?: PlexResponseCategory;
	} = { operation: "plex_label_mutation", reasonCode };
	if (options.mediaCategory) projection.mediaCategory = options.mediaCategory;
	if (
		options.candidateCount !== undefined &&
		Number.isSafeInteger(options.candidateCount) &&
		options.candidateCount >= 0
	) {
		projection.candidateCount = options.candidateCount;
	}
	if (options.responseCategory) projection.responseCategory = options.responseCategory;
	log.warn(projection, "Plex label mutation failed");
}

function readSafeResponseCategory(args: unknown[]): PlexResponseCategory | undefined {
	const fields = args[0];
	if (!fields || typeof fields !== "object" || !("responseCategory" in fields)) return undefined;
	const category = fields.responseCategory;
	return category === "client_error" ||
		category === "server_error" ||
		category === "timeout" ||
		category === "unavailable"
		? category
		: undefined;
}

function createPlexLabelMutationProviderLogger(log: FastifyBaseLogger): FastifyBaseLogger {
	let safeLogger: FastifyBaseLogger;
	const reproject = (...args: unknown[]) => {
		logPlexLabelMutationFailure(log, "provider_authority_unavailable", {
			responseCategory: readSafeResponseCategory(args),
		});
	};
	const ignore = () => undefined;
	safeLogger = {
		child: () => safeLogger,
		info: ignore,
		warn: reproject,
		error: reproject,
		debug: ignore,
		trace: ignore,
		fatal: reproject,
	} as unknown as FastifyBaseLogger;
	return safeLogger;
}

function classifyEvidenceFailure(
	evidence: PlexEvidenceSummary,
): PlexMetadataTagMutationFailureReason {
	const codes = new Set<PlexCoverageReasonCode>(evidence.reasonCodes);
	if (codes.has("connection_generation_mismatch")) return "provider_connection_changed";
	if (codes.has("identity_generation_mismatch")) return "provider_identity_changed";
	if (
		codes.has("latest_attempt_failed") ||
		codes.has("latest_attempt_in_progress") ||
		codes.has("latest_attempt_partial") ||
		codes.has("latest_attempt_unknown") ||
		codes.has("latest_attempt_missing") ||
		codes.has("latest_attempt_future_dated") ||
		codes.has("generation_changed") ||
		codes.has("published_timestamp_changed")
	) {
		return "publication_superseded";
	}
	return "provider_authority_unavailable";
}

export const plexDestWriter: DestWriter = {
	prismaService: "PLEX",
	async applyLabels(opts: DestWriterOpts): Promise<DestWriteResult> {
		const { rule, candidates, prisma, encryptor, log } = opts;

		if (candidates.length === 0) {
			return { matchesFound: 0, labelsApplied: 0, failures: 0 };
		}
		const mediaTypesByTmdbId = new Map<number, Set<"movie" | "series">>();
		for (const candidate of candidates) {
			const mediaTypes = mediaTypesByTmdbId.get(candidate.tmdbId) ?? new Set();
			mediaTypes.add(candidate.mediaType);
			mediaTypesByTmdbId.set(candidate.tmdbId, mediaTypes);
		}
		const unambiguousCandidates = candidates.filter(
			(candidate) => mediaTypesByTmdbId.get(candidate.tmdbId)?.size === 1,
		);
		const ambiguousCandidateCount = candidates.length - unambiguousCandidates.length;
		if (ambiguousCandidateCount > 0) {
			logPlexLabelMutationFailure(log, "cached_target_ambiguous", {
				candidateCount: ambiguousCandidateCount,
			});
		}
		if (unambiguousCandidates.length === 0) {
			return { matchesFound: 0, labelsApplied: 0, failures: ambiguousCandidateCount };
		}
		const targets = unambiguousCandidates.map((candidate) => ({
			tmdbId: candidate.tmdbId,
			mediaType: candidate.mediaType,
		}));
		const authority = new PlexAuthorityService({
			prisma,
			encryptor,
			log: createPlexLabelMutationProviderLogger(log),
		});
		const evidence = await authority.readInstanceSelected({
			userId: rule.userId,
			instanceId: rule.destInstanceId,
			selection: { kind: "targets", targets },
			domains: ["membership"],
		});
		if (
			!evidence.available ||
			evidence.evidence.publicationLevel !== "authoritative" ||
			evidence.evidence.completeness !== "complete" ||
			evidence.evidence.reasonCodes.length > 0
		) {
			logPlexLabelMutationFailure(log, classifyEvidenceFailure(evidence.evidence), {
				candidateCount: candidates.length,
			});
			return { matchesFound: 0, labelsApplied: 0, failures: candidates.length };
		}

		const targetKeys = new Set(targets.map((target) => `${target.mediaType}:${target.tmdbId}`));
		const matched = evidence.rows.filter((row) => targetKeys.has(`${row.mediaType}:${row.tmdbId}`));

		let labelsApplied = 0;
		let failures = ambiguousCandidateCount;
		const attemptedRatingKeys = new Set<string>();
		for (const row of matched) {
			if (row.mediaType !== "movie" && row.mediaType !== "series") {
				logPlexLabelMutationFailure(log, "unknown_failure");
				failures++;
				continue;
			}
			const cachedKey = resolveParitySafeCachedRatingKey(row);
			if (!cachedKey.ok) {
				logPlexLabelMutationFailure(log, cachedKey.reasonCode, {
					mediaCategory: row.mediaType,
				});
				failures++;
				continue;
			}
			const ratingKey = cachedKey.ratingKey;
			if (attemptedRatingKeys.has(ratingKey)) continue;
			attemptedRatingKeys.add(ratingKey);
			let mutation: Awaited<ReturnType<PlexAuthorityService["mutateMetadataTag"]>>;
			try {
				mutation = await authority.mutateMetadataTag({
					userId: rule.userId,
					instanceId: rule.destInstanceId,
					target: { tmdbId: row.tmdbId, mediaType: row.mediaType },
					expectedRatingKey: ratingKey,
					type: "label",
					action: "add",
					name: rule.destTagName,
				});
			} catch (error) {
				logPlexLabelMutationFailure(
					log,
					error instanceof PlexMetadataTagWriteError ? "upstream_write_failed" : "unknown_failure",
					{ mediaCategory: row.mediaType },
				);
				failures++;
				continue;
			}
			if (!mutation.ok) {
				logPlexLabelMutationFailure(log, mutation.reasonCode, {
					mediaCategory: row.mediaType,
				});
				failures++;
				continue;
			}
			labelsApplied++;
		}

		return { matchesFound: matched.length, labelsApplied, failures };
	},
};

function resolveParitySafeCachedRatingKey(row: {
	ratingKey: string | null;
	thumb: string | null;
}):
	| { ok: true; ratingKey: string }
	| { ok: false; reasonCode: "cached_target_unavailable" | "cached_target_inconsistent" } {
	const explicitRatingKey = row.ratingKey?.trim();
	if (!explicitRatingKey || !row.thumb) {
		return { ok: false, reasonCode: "cached_target_unavailable" };
	}
	const legacyRatingKey = row.thumb.match(/\/library\/metadata\/(\d+)/)?.[1];
	if (!legacyRatingKey) return { ok: false, reasonCode: "cached_target_unavailable" };
	return legacyRatingKey === explicitRatingKey
		? { ok: true, ratingKey: explicitRatingKey }
		: { ok: false, reasonCode: "cached_target_inconsistent" };
}
