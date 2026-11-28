import { buildPlexSessionSnapshot } from "../../../plugins/lib/session-snapshot-measurements.js";

/** Synthetic captured coordinates for tests of native tick chaining/ranking. */
export function activitySnapshot(capturedAt: string, sessions: Array<Record<string, unknown>>) {
	return {
		instanceId: "synthetic-source",
		capturedAt: new Date(capturedAt),
		...buildPlexSessionSnapshot(
			sessions.map((row) => ({
				sessionKey: `session-${row.user}-${row.title}`,
				ratingKey: `item-${row.title}`,
				title: row.title,
				grandparentTitle: row.grandparentTitle,
				type:
					row.mediaType === "series"
						? "episode"
						: row.mediaType === "music"
							? "track"
							: row.mediaType === "other"
								? "photo"
								: "movie",
				user: { id: row.user, title: row.user },
				player: { title: "Synthetic player", platform: row.platform },
				videoDecision: row.videoDecision,
				state: "playing",
			})) as never,
			{ connectionGeneration: 0, identityGeneration: 0 },
		),
	};
}
