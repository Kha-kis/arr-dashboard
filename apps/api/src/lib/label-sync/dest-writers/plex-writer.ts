/**
 * Destination writer for Plex instances.
 *
 * Resolves match candidates against PlexCache (keyed on tmdbId) to find each
 * Plex item's `ratingKey`, then calls the Plex metadata-tags endpoint to
 * apply the destination label.
 */

import type { FastifyBaseLogger } from "fastify";
import {
	PlexAuthorityService,
	type PlexMetadataTagMutationFailureReason,
	PlexMetadataTagWriteError,
} from "../../plex/plex-authority-service.js";
import type { PlexResponseCategory } from "../../plex/plex-client.js";
import {
	classifyPlexLabelSyncTerminalReason,
	classifyPlexMetadataTagEvidenceFailure,
	classifyUnknownPlexLabelSyncTerminalReason,
	createLabelSyncPlexProviderLogSink,
	logPlexLabelSyncTerminal,
} from "../../plex/plex-label-sync-logging.js";
import type { DestWriteResult, DestWriter, DestWriterOpts } from "../strategy-types.js";

function logDestinationAuthorityFailure(
	log: FastifyBaseLogger,
	reasonCode: PlexMetadataTagMutationFailureReason,
	options: {
		mediaCategory?: "movie" | "series";
		candidateCount?: number;
	} = {},
): void {
	logPlexLabelSyncTerminal(log, {
		operation: "destination_write",
		state: "failed",
		stage: "destination_authority",
		reasonCode: classifyUnknownPlexLabelSyncTerminalReason({
			stage: "destination_authority",
			code: reasonCode,
		}),
		...(options.mediaCategory ? { mediaCategory: options.mediaCategory } : {}),
		...(options.candidateCount === undefined ? {} : { candidateCount: options.candidateCount }),
	});
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
			logDestinationAuthorityFailure(log, "cached_target_ambiguous", {
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
			log: createLabelSyncPlexProviderLogSink(),
		});
		let evidence: Awaited<ReturnType<PlexAuthorityService["readInstanceSelected"]>>;
		try {
			evidence = await authority.readInstanceSelected({
				userId: rule.userId,
				instanceId: rule.destInstanceId,
				selection: { kind: "targets", targets },
				domains: ["membership"],
			});
		} catch {
			logDestinationAuthorityFailure(log, "provider_authority_unavailable", {
				candidateCount: candidates.length,
			});
			return { matchesFound: 0, labelsApplied: 0, failures: candidates.length };
		}
		if (
			!evidence.available ||
			evidence.evidence.publicationLevel !== "authoritative" ||
			evidence.evidence.completeness !== "complete" ||
			evidence.evidence.reasonCodes.length > 0
		) {
			logDestinationAuthorityFailure(
				log,
				classifyPlexMetadataTagEvidenceFailure(evidence.evidence),
				{
					candidateCount: candidates.length,
				},
			);
			return { matchesFound: 0, labelsApplied: 0, failures: candidates.length };
		}

		const targetKeys = new Set(targets.map((target) => `${target.mediaType}:${target.tmdbId}`));
		const matched = evidence.rows.filter((row) => targetKeys.has(`${row.mediaType}:${row.tmdbId}`));

		let labelsApplied = 0;
		let failures = ambiguousCandidateCount;
		const attemptedRatingKeys = new Set<string>();
		for (const row of matched) {
			if (row.mediaType !== "movie" && row.mediaType !== "series") {
				logDestinationAuthorityFailure(log, "unknown_failure");
				failures++;
				continue;
			}
			const cachedKey = resolveParitySafeCachedRatingKey(row);
			if (!cachedKey.ok) {
				logDestinationAuthorityFailure(log, cachedKey.reasonCode, {
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
				const responseCategory: PlexResponseCategory | undefined =
					error instanceof PlexMetadataTagWriteError ? error.responseCategory : undefined;
				logPlexLabelSyncTerminal(log, {
					operation: "destination_write",
					state: "failed",
					stage: "upstream_write",
					reasonCode: responseCategory
						? classifyPlexLabelSyncTerminalReason({
								stage: "upstream_write",
								code: responseCategory,
							})
						: "unknown_failure",
					mediaCategory: row.mediaType,
					...(responseCategory ? { upstreamCategory: responseCategory } : {}),
				});
				failures++;
				continue;
			}
			if (!mutation.ok) {
				logDestinationAuthorityFailure(log, mutation.reasonCode, {
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
