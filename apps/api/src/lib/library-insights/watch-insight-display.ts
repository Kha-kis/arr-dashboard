import type { ProviderObservationStatus, WatchInsightAvailability } from "@arr/shared";
import { authorizeProviderEvidenceUse } from "../provider-observation/evidence-capabilities.js";
import {
	projectWatchDisplayEvidence,
	type WatchDisplayRow,
} from "../provider-observation/watch-display-evidence.js";
import { safeJsonParse } from "../utils/json.js";

export interface InsightTarget {
	tmdbId: number;
	mediaType: "movie" | "series";
}
export type InsightWatchState = "watched" | "unwatched" | "unknown";
export interface InsightWatchSource {
	provider: "plex" | "jellyfin";
	status: ProviderObservationStatus | undefined;
	rows: readonly (WatchDisplayRow & { tmdbId: number; mediaType: string })[];
}

export function insightTarget(candidate: { data: string; itemType: string }): InsightTarget | null {
	if (candidate.itemType !== "movie" && candidate.itemType !== "series") return null;
	const parsed = safeJsonParse(candidate.data) as { remoteIds?: { tmdbId?: unknown } } | null;
	const tmdbId = parsed?.remoteIds?.tmdbId;
	return typeof tmdbId === "number" && Number.isSafeInteger(tmdbId) && tmdbId > 0
		? { tmdbId, mediaType: candidate.itemType }
		: null;
}

/** Display conclusions only. Never use this projection as mutation authority. */
export function createWatchInsightDisplay(sources: readonly InsightWatchSource[]) {
	const projected = sources.map((source) => {
		const status = source.status;
		const domain = status?.domains?.find((entry) => entry.domain === "watch-count");
		const admitted = Boolean(
			status &&
				authorizeProviderEvidenceUse(status, {
					domain: "watch-count",
					use: "display",
					field: "watch-count",
					targetObserved: true,
				}).authorized,
		);
		const complete =
			admitted &&
			status?.availability === "current" &&
			status.evidence === "complete" &&
			domain?.availability === "current" &&
			domain.evidence === "complete" &&
			domain.valueSemantics === "exact";
		const targets = new Map<string, InsightWatchState[]>();
		for (const row of source.rows) {
			if (
				!Number.isSafeInteger(row.tmdbId) ||
				row.tmdbId <= 0 ||
				!["movie", "series"].includes(row.mediaType)
			)
				continue;
			const key = `${row.mediaType}:${row.tmdbId}`;
			const display = projectWatchDisplayEvidence({ status, row });
			const state: InsightWatchState =
				display.watchCount !== null && display.watchCount > 0
					? "watched"
					: complete && display.watchCount === 0 && display.watchCountSemantics === "exact"
						? "unwatched"
						: "unknown";
			targets.set(key, [...(targets.get(key) ?? []), state]);
		}
		return { provider: source.provider, admitted, complete, targets };
	});
	const baseStatus: WatchInsightAvailability =
		sources.length === 0
			? "not-configured"
			: projected.every((source) => source.complete)
				? "complete"
				: projected.some((source) => source.admitted)
					? "partial"
					: "unavailable";
	return {
		hasPlexData: projected.some((source) => source.provider === "plex" && source.admitted),
		hasWatchData: projected.some((source) => source.admitted),
		status(hasUnknown: boolean): WatchInsightAvailability {
			return baseStatus === "complete" && hasUnknown ? "partial" : baseStatus;
		},
		classify(target: InsightTarget | null): InsightWatchState {
			if (!target || sources.length === 0) return "unknown";
			const key = `${target.mediaType}:${target.tmdbId}`;
			const states = projected.map((source) => source.targets.get(key) ?? []);
			if (states.some((entries) => entries.includes("watched"))) return "watched";
			return states.every(
				(entries) => entries.length > 0 && entries.every((state) => state === "unwatched"),
			)
				? "unwatched"
				: "unknown";
		},
	};
}
