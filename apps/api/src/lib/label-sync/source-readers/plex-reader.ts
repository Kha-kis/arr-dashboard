/**
 * Source reader for Plex instances.
 *
 * Plex labels live on the per-item PlexCache row as a JSON-encoded string
 * array. Rows come from the central evidence repository so unavailable or
 * non-authoritative generations cannot be interpreted as an empty label set.
 */

import type {
	MatchCandidate,
	SourceReader,
	SourceReaderOpts,
	SourceReadResult,
} from "../strategy-types.js";
import { PlexAuthorityService } from "../../plex/plex-authority-service.js";
import {
	classifyPlexLabelSyncTerminalReason,
	createLabelSyncPlexProviderLogSink,
	logPlexLabelSyncTerminal,
} from "../../plex/plex-label-sync-logging.js";

export const plexSourceReader: SourceReader = {
	prismaService: "PLEX",
	async readTaggedItems(opts: SourceReaderOpts): Promise<SourceReadResult> {
		const { rule, sourceInstance, prisma, log } = opts;
		const providerLog = createLabelSyncPlexProviderLogSink();

		let rows: Array<{ tmdbId: number; mediaType: string; title: string; labels: string }>;
		try {
			const evidence = await new PlexAuthorityService({
				prisma,
				encryptor: opts.encryptor,
				log: providerLog,
			}).readInstanceSelected({
				userId: rule.userId,
				instanceId: sourceInstance.id,
				selection: { kind: "label-membership", label: rule.sourceTagName },
				// The selection itself proves membership in the configured source
				// label. Unrelated labels on the same selected item are outside this
				// read's authority domain and must not revoke otherwise stable evidence.
				domains: ["membership", "display"],
			});
			if (
				!evidence.available ||
				evidence.evidence.publicationLevel !== "authoritative" ||
				evidence.evidence.completeness !== "complete" ||
				evidence.evidence.reasonCodes.length > 0
			) {
				const reasonCode = evidence.evidence.reasonCodes[0];
				logPlexLabelSyncTerminal(log, {
					operation: "source_read",
					state: "failed",
					stage: "source_authority",
					reasonCode: reasonCode
						? classifyPlexLabelSyncTerminalReason({
								stage: "source_authority",
								code: reasonCode,
							})
						: "unknown_failure",
				});
				return { matches: [], failed: true };
			}
			rows = evidence.rows;
		} catch {
			logPlexLabelSyncTerminal(log, {
				operation: "source_read",
				state: "failed",
				stage: "source_read",
				reasonCode: classifyPlexLabelSyncTerminalReason({
					stage: "source_read",
					code: "source_read_failed",
				}),
			});
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
