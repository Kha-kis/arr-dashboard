import { ArrSyncClient } from "../../src/features/arr-sync/components/arr-sync-client";

/**
 * ARR Sync Page
 * Standalone page for Custom Formats & TRaSH guides synchronization
 */
export default function ArrSyncPage() {
	return (
		<div className="container mx-auto p-6 max-w-7xl">
			<div className="mb-8">
				<h1 className="text-3xl font-bold gradient-text">ARR Custom Formats & TRaSH Sync</h1>
				<p className="mt-2 text-fg-muted">
					Automatically sync custom formats and quality profiles from TRaSH guides to your Sonarr and Radarr instances
				</p>
			</div>

			<ArrSyncClient />
		</div>
	);
}
