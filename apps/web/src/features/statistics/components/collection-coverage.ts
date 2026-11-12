import type { SnapshotCollectionCoverage } from "@arr/shared";

export const MIXED_COLLECTION_EMPTY_NOTICE =
	"Some samples failed. The available samples contain no usable data for this chart.";

export function hasMixedCollectionSamples(collection: SnapshotCollectionCoverage | undefined) {
	return (
		collection !== undefined &&
		collection.failedSnapshots > 0 &&
		(collection.activeSnapshots > 0 || collection.idleSnapshots > 0)
	);
}
