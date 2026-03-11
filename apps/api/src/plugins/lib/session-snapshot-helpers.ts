/**
 * Session Snapshot Helpers
 *
 * Pure functions for classifying Plex session decisions and computing
 * LAN/WAN bandwidth attribution. Extracted from session-snapshot-scheduler.ts
 * for testability.
 */

/** Minimal session shape needed for classification */
export interface SessionInput {
	bandwidth?: number | null;
	videoDecision?: string | null;
}

/** Result of classifying a batch of sessions */
export interface SessionClassification {
	totalBandwidth: number;
	directPlayCount: number;
	transcodeCount: number;
	directStreamCount: number;
}

/**
 * Classify a list of Plex sessions by their video decision type and
 * sum up total bandwidth.
 */
export function classifySessionDecisions(sessions: SessionInput[]): SessionClassification {
	let totalBandwidth = 0;
	let directPlayCount = 0;
	let transcodeCount = 0;
	let directStreamCount = 0;

	for (const session of sessions) {
		totalBandwidth += session.bandwidth ?? 0;
		const videoDecision = session.videoDecision?.toLowerCase() ?? "direct play";
		if (videoDecision === "transcode") {
			transcodeCount++;
		} else if (
			videoDecision === "copy" ||
			videoDecision === "directstream" ||
			videoDecision === "direct stream"
		) {
			directStreamCount++;
		} else {
			directPlayCount++;
		}
	}

	return { totalBandwidth, directPlayCount, transcodeCount, directStreamCount };
}

/** Result of LAN/WAN bandwidth attribution */
export interface LanWanAttribution {
	lanBandwidth: number;
	wanBandwidth: number;
	attributed: boolean;
}

/**
 * Compute LAN/WAN bandwidth to attribute to a single snapshot.
 *
 * LAN/WAN is attributed to only one Plex instance per capture tick to prevent
 * double-counting when analytics routes aggregate across instances.
 *
 * @param hasCompleteTautulliData - Whether all Tautulli instances responded successfully
 * @param alreadyAttributed - Whether LAN/WAN has already been attributed this tick
 * @param aggLanBandwidth - Aggregate LAN bandwidth from all Tautulli instances
 * @param aggWanBandwidth - Aggregate WAN bandwidth from all Tautulli instances
 */
export function computeLanWanAttribution(
	hasCompleteTautulliData: boolean,
	alreadyAttributed: boolean,
	aggLanBandwidth: number,
	aggWanBandwidth: number,
): LanWanAttribution {
	const shouldAttribute = hasCompleteTautulliData && !alreadyAttributed;
	return {
		lanBandwidth: shouldAttribute ? aggLanBandwidth : 0,
		wanBandwidth: shouldAttribute ? aggWanBandwidth : 0,
		attributed: shouldAttribute,
	};
}
