import type { PlaysByDateResponse, SampledActivityCollection } from "@arr/shared";
import type { ReadSessionSnapshotPagesResult } from "../../../lib/statistics/session-snapshot-pages.js";

export function activityCollectionMeasurement(
	read: ReadSessionSnapshotPagesResult,
): SampledActivityCollection {
	return {
		version: 1,
		configuredSources: read.instanceCount,
		collection: { ...read.collection },
		...(read.collectionByDate ? { collectionByDate: read.collectionByDate } : {}),
	};
}

/** Preserve known observations, but never publish an unsampled/failed day as zero. */
export function projectDailyActivityCollection(
	response: PlaysByDateResponse,
	read: ReadSessionSnapshotPagesResult,
): PlaysByDateResponse {
	return {
		...response,
		measurement: activityCollectionMeasurement(read),
		series: response.series.map((series) => ({
			...series,
			data: series.data.map((value, index) => {
				if (value !== null && value > 0) return value;
				const coverage = read.collectionByDate?.[response.categories[index]!];
				return (response.unidentifiedPlaybackSessions?.[index] ?? 0) === 0 &&
					(response.invalidDetailSnapshots?.[index] ?? 0) === 0 &&
					coverage &&
					coverage.failedSnapshots === 0 &&
					coverage.invalidSnapshots === 0 &&
					coverage.legacySnapshots === 0 &&
					coverage.activeSnapshots + coverage.idleSnapshots > 0
					? 0
					: null;
			}),
		})),
	};
}
