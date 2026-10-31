import type { SampledActivityCollection } from "@arr/shared";

export function ActivityCollectionNotice({
	measurement,
	empty,
}: {
	measurement: SampledActivityCollection | undefined;
	empty: boolean;
}) {
	if (!measurement)
		return (
			<p className="text-xs text-muted-foreground">
				Legacy/unverified collection evidence: this response does not establish native sampling
				coverage.
			</p>
		);
	const { collection } = measurement;
	const emptyState = !empty
		? null
		: measurement.configuredSources === 0
			? "No configured media-server sources. Check Settings to configure a connection."
			: collection.failedSnapshots > 0
				? "Collection failed in this window. Check source Settings and retry collection."
				: collection.invalidSnapshots > 0
					? "Invalid collection evidence. Check source Settings."
					: collection.idleSnapshots > 0
						? "Successful idle observations recorded; no matching activity was observed."
						: collection.activeSnapshots + collection.legacySnapshots > 0
							? "No matching title observations are available in this sampled window."
							: "No observations recorded in this window. Check source Settings and the collection scheduler.";
	return (
		<div className="text-xs text-muted-foreground space-y-1">
			{emptyState && <p role="status">{emptyState}</p>}
			<p>
				Collection: {collection.activeSnapshots} active, {collection.idleSnapshots} idle,{" "}
				{collection.failedSnapshots} failed, {collection.legacySnapshots} legacy/unverified,{" "}
				{collection.invalidSnapshots} invalid observations.
			</p>
			<p>
				Five-minute sampled observations, not complete playback history. Missing collection
				intervals cannot be reconstructed.
			</p>
		</div>
	);
}
