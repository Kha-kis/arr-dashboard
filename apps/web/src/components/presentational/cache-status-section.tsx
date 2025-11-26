import { RefreshCw } from "lucide-react";
import { CacheStatusCard } from "./cache-status-card";

interface CacheStatusEntry {
	serviceType: string;
	configType: string;
	version: number;
	itemCount: number;
	lastFetched: string;
	isStale: boolean;
}

interface CacheStatusSectionProps {
	serviceType: "RADARR" | "SONARR";
	statuses: CacheStatusEntry[];
	configTypeLabels: Record<string, string>;
	refreshing: boolean;
	onRefresh: () => void;
	isRefreshPending: boolean;
}

/**
 * Cache status section component for displaying service-specific cache entries.
 * Pure presentational component that renders cache cards and refresh controls.
 *
 * @param serviceType - Service type (RADARR or SONARR)
 * @param statuses - Array of cache status entries
 * @param configTypeLabels - Mapping of config types to display labels
 * @param refreshing - Whether this service is currently being refreshed
 * @param onRefresh - Handler called when refresh button is clicked
 * @param isRefreshPending - Whether any refresh mutation is pending
 *
 * @example
 * <CacheStatusSection
 *   serviceType="RADARR"
 *   statuses={radarrStatuses}
 *   configTypeLabels={CONFIG_TYPE_LABELS}
 *   refreshing={false}
 *   onRefresh={() => handleRefresh("RADARR")}
 *   isRefreshPending={refreshMutation.isPending}
 * />
 */
export const CacheStatusSection = ({
	serviceType,
	statuses,
	configTypeLabels,
	refreshing,
	onRefresh,
	isRefreshPending,
}: CacheStatusSectionProps) => {
	return (
		<section className="space-y-4">
			<div className="flex items-center justify-between">
				<h2 className="text-2xl font-semibold text-white">{serviceType}</h2>
				<button
					type="button"
					onClick={onRefresh}
					disabled={refreshing || isRefreshPending}
					className="inline-flex items-center gap-2 rounded-lg bg-primary/20 px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/30 disabled:opacity-50"
				>
					<RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
					{refreshing ? "Refreshing..." : "Refresh All"}
				</button>
			</div>

			{statuses.length === 0 ? (
				<div className="rounded-xl border border-white/10 bg-white/5 p-8 text-center">
					<p className="text-white/60">No cache entries for {serviceType}</p>
					<button
						type="button"
						onClick={onRefresh}
						className="mt-4 text-sm text-primary hover:underline"
					>
						Click to initialize cache
					</button>
				</div>
			) : (
				<div className="grid gap-4 md:grid-cols-2">
					{statuses.map((status) => (
						<CacheStatusCard
							key={`${status.serviceType}-${status.configType}`}
							configType={status.configType}
							configTypeLabel={configTypeLabels[status.configType] ?? status.configType}
							version={status.version}
							itemCount={status.itemCount}
							lastFetched={status.lastFetched}
							isStale={status.isStale}
						/>
					))}
				</div>
			)}
		</section>
	);
};
