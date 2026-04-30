/**
 * Source reader for Plex instances.
 *
 * Plex labels live on the per-item PlexCache row as a JSON-encoded string
 * array. We pre-filter rows in SQL using `contains: "<quoted label>"`
 * (the JSON-quoted form is a unique enough substring for typical label
 * names), then double-check via JSON parse before yielding the candidate.
 */

import type {
	MatchCandidate,
	SourceReader,
	SourceReaderOpts,
	SourceReadResult,
} from "../strategy-types.js";

export const plexSourceReader: SourceReader = {
	prismaService: "PLEX",
	async readTaggedItems(opts: SourceReaderOpts): Promise<SourceReadResult> {
		const { rule, sourceInstance, prisma, log } = opts;

		// JSON-quoted form: `"Kids"` rather than `Kids` — defends against the
		// label name appearing as a substring of another label or the title.
		// `JSON.stringify` handles the full JSON escape grammar (quotes,
		// backslashes, control chars, unicode), so the resulting substring
		// matches exactly the token Prisma will see in the labels JSON column.
		const quoted = JSON.stringify(rule.sourceTagName);

		let rows: Array<{ tmdbId: number; mediaType: string; title: string; labels: string }>;
		try {
			rows = await prisma.plexCache.findMany({
				where: {
					instanceId: sourceInstance.id,
					labels: { contains: quoted },
				},
				select: { tmdbId: true, mediaType: true, title: true, labels: true },
			});
		} catch (err) {
			log.warn({ err }, "Failed to query PlexCache for source labels");
			return { matches: [], failed: true };
		}

		const matches: MatchCandidate[] = [];
		for (const row of rows) {
			if (!isMediaType(row.mediaType)) continue;
			if (row.tmdbId <= 0) continue;

			let labelArray: unknown;
			try {
				labelArray = JSON.parse(row.labels);
			} catch {
				continue; // malformed labels JSON; skip
			}
			if (!Array.isArray(labelArray)) continue;
			if (!labelArray.includes(rule.sourceTagName)) continue;

			matches.push({
				tmdbId: row.tmdbId,
				title: row.title,
				mediaType: row.mediaType,
			});
		}

		return { matches, failed: false };
	},
};

function isMediaType(value: string): value is "series" | "movie" {
	return value === "series" || value === "movie";
}
