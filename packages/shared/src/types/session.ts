/** Informational coverage for a live session read, never mutation authority. */
export interface SessionAvailability {
	status: "complete" | "partial" | "unavailable" | "not-configured";
	configuredSources: number;
	availableSources: number;
}

/** What a reported rate represents; neither basis certifies network throughput. */
export type SessionBandwidthBasis = "provider-reported" | "encoding-estimate";

/** Measurement coverage of observed rows, independent of provider availability. */
export interface SessionBandwidthCoverage {
	status: "complete" | "partial" | "unavailable";
	observedSessions: number;
	measuredSessions: number;
	knownTotalKbps: number | null;
}

export function getSessionBandwidthKbps(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A known subtotal never fills missing observations with fabricated zeroes. */
export function measureSessionBandwidth(
	sessions: readonly { bandwidth?: number | null }[],
): SessionBandwidthCoverage {
	let measuredSessions = 0;
	let total = 0;
	for (const session of sessions) {
		const bandwidth = getSessionBandwidthKbps(session.bandwidth);
		if (bandwidth !== null) {
			measuredSessions += 1;
			total += bandwidth;
		}
	}
	const knownTotalKbps =
		Number.isFinite(total) && (measuredSessions > 0 || sessions.length === 0) ? total : null;
	return {
		status:
			knownTotalKbps === null
				? "unavailable"
				: measuredSessions === sessions.length
					? "complete"
					: "partial",
		observedSessions: sessions.length,
		measuredSessions,
		knownTotalKbps,
	};
}

/** A provider-reported playback method; missing evidence is not Direct Play. */
export type SessionPlaybackDecision = "direct_play" | "direct_stream" | "transcode" | "unknown";

/** Normalize explicit Plex/Jellyfin methods without inferring absent values. */
export function normalizeSessionPlaybackDecision(value: unknown): SessionPlaybackDecision {
	if (typeof value !== "string") {
		return "unknown";
	}

	switch (value.trim().toLowerCase()) {
		case "direct play":
		case "directplay":
			return "direct_play";
		case "copy":
		case "direct stream":
		case "directstream":
			return "direct_stream";
		case "transcode":
			return "transcode";
		default:
			return "unknown";
	}
}
