/**
 * Destination writer for Plex instances.
 *
 * Resolves match candidates against PlexCache (keyed on tmdbId) to find each
 * Plex item's `ratingKey`, then calls the Plex metadata-tags endpoint to
 * apply the destination label.
 */

import { createPlexClient } from "../../plex/plex-client.js";
import type {
	DestWriteResult,
	DestWriter,
	DestWriterOpts,
	MatchCandidate,
} from "../strategy-types.js";

export const plexDestWriter: DestWriter = {
	prismaService: "PLEX",
	async applyLabels(opts: DestWriterOpts): Promise<DestWriteResult> {
		const { rule, destInstance, candidates, prisma, encryptor, log } = opts;

		if (candidates.length === 0) {
			return { matchesFound: 0, labelsApplied: 0, failures: 0 };
		}

		let plexClient: ReturnType<typeof createPlexClient>;
		try {
			plexClient = createPlexClient(encryptor, destInstance, log);
		} catch (err) {
			log.warn({ err }, "Failed to initialize destination Plex client");
			return { matchesFound: 0, labelsApplied: 0, failures: candidates.length };
		}

		const tmdbIds = unique(candidates.map((c) => c.tmdbId));

		// Plex matching is mediaType-aware so a tmdbId collision between a
		// movie + series doesn't accidentally tag the wrong row.
		const candidatesByTmdb = new Map<number, MatchCandidate>();
		for (const c of candidates) {
			candidatesByTmdb.set(c.tmdbId, c);
		}

		const cacheRows = await prisma.plexCache.findMany({
			where: {
				instanceId: rule.destInstanceId,
				tmdbId: { in: tmdbIds },
			},
			select: { thumb: true, title: true, tmdbId: true, mediaType: true },
		});

		// Filter rows whose mediaType matches the candidate they joined to.
		const matched = cacheRows.filter((row) => {
			const candidate = candidatesByTmdb.get(row.tmdbId);
			return candidate && candidate.mediaType === row.mediaType;
		});

		let labelsApplied = 0;
		let failures = 0;
		for (const row of matched) {
			const ratingKey = extractRatingKey(row.thumb);
			if (!ratingKey) {
				log.warn(
					{ tmdbId: row.tmdbId, title: row.title },
					"Could not extract Plex ratingKey from cached thumb",
				);
				failures++;
				continue;
			}

			try {
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

function extractRatingKey(thumb: string | null): string | undefined {
	if (!thumb) return undefined;
	const match = thumb.match(/\/library\/metadata\/(\d+)/);
	return match?.[1];
}

function unique<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}
