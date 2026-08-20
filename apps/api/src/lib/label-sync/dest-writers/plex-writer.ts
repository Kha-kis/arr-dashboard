/**
 * Destination writer for Plex instances.
 *
 * Resolves match candidates against PlexCache (keyed on tmdbId) to find each
 * Plex item's `ratingKey`, then calls the Plex metadata-tags endpoint to
 * apply the destination label.
 */

import { createPlexClient } from "../../plex/plex-client.js";
import { loadInstanceSelectedMutationEvidence } from "../../plex/plex-evidence-repository.js";
import type { DestWriteResult, DestWriter, DestWriterOpts } from "../strategy-types.js";

export const plexDestWriter: DestWriter = {
	prismaService: "PLEX",
	async applyLabels(opts: DestWriterOpts): Promise<DestWriteResult> {
		const { rule, candidates, prisma, encryptor, log } = opts;

		if (candidates.length === 0) {
			return { matchesFound: 0, labelsApplied: 0, failures: 0 };
		}
		const targets = candidates.map((candidate) => ({
			tmdbId: candidate.tmdbId,
			mediaType: candidate.mediaType,
		}));
		const evidence = await loadInstanceSelectedMutationEvidence(prisma, {
			userId: rule.userId,
			instanceId: rule.destInstanceId,
			selection: { kind: "targets", targets },
		});
		if (
			!evidence.available ||
			evidence.evidence.publicationLevel !== "authoritative" ||
			evidence.evidence.completeness !== "complete" ||
			evidence.evidence.reasonCodes.length > 0
		) {
			log.warn({ instanceId: rule.destInstanceId }, "Plex label destination evidence unavailable");
			return { matchesFound: 0, labelsApplied: 0, failures: candidates.length };
		}

		const targetKeys = new Set(targets.map((target) => `${target.mediaType}:${target.tmdbId}`));
		const matched = evidence.rows.filter((row) => targetKeys.has(`${row.mediaType}:${row.tmdbId}`));

		let labelsApplied = 0;
		let failures = 0;
		const attemptedRatingKeys = new Set<string>();
		for (const row of matched) {
			if (row.mediaType !== "movie" && row.mediaType !== "series") {
				failures++;
				continue;
			}
			const ratingKey = row.ratingKey?.trim();
			if (!ratingKey) {
				log.warn(
					{ tmdbId: row.tmdbId, title: row.title },
					"Plex label target lacks a persisted rating key",
				);
				failures++;
				continue;
			}
			if (attemptedRatingKeys.has(ratingKey)) continue;
			attemptedRatingKeys.add(ratingKey);
			const currentEvidence = await loadInstanceSelectedMutationEvidence(prisma, {
				userId: rule.userId,
				instanceId: rule.destInstanceId,
				selection: {
					kind: "targets",
					targets: [{ tmdbId: row.tmdbId, mediaType: row.mediaType }],
				},
			});
			if (
				!currentEvidence.available ||
				currentEvidence.evidence.publicationLevel !== "authoritative" ||
				currentEvidence.evidence.completeness !== "complete" ||
				currentEvidence.evidence.reasonCodes.length > 0 ||
				!currentEvidence.rows.some(
					(current) =>
						current.tmdbId === row.tmdbId &&
						current.mediaType === row.mediaType &&
						current.ratingKey?.trim() === ratingKey,
				)
			) {
				log.warn(
					{ tmdbId: row.tmdbId, ratingKey },
					"Plex label target evidence changed before mutation",
				);
				failures++;
				continue;
			}
			const currentInstance = await prisma.serviceInstance.findFirst({
				where: {
					id: rule.destInstanceId,
					userId: rule.userId,
					service: "PLEX",
					enabled: true,
				},
			});
			if (
				!currentInstance ||
				currentInstance.connectionGeneration !== currentEvidence.connectionGeneration ||
				currentInstance.identityGeneration !== currentEvidence.identityGeneration
			) {
				log.warn(
					{ tmdbId: row.tmdbId, ratingKey },
					"Plex label destination connection changed before mutation",
				);
				failures++;
				continue;
			}

			try {
				const plexClient = createPlexClient(encryptor, currentInstance, log);
				await plexClient.updateMetadataTags(ratingKey, "label", "add", rule.destTagName);
				labelsApplied++;
			} catch (err) {
				log.warn({ ratingKey, err }, "Failed to apply Plex label");
				failures++;
			}
		}

		return { matchesFound: matched.length, labelsApplied, failures };
	},
};
