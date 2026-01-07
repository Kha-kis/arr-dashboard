import { Database, Clock, Trash2, RefreshCw } from "lucide-react";

interface CacheStatusCardProps {
	configTypeLabel: string;
	version: number;
	itemCount: number;
	lastFetched: string;
	isStale: boolean;
	onRefresh?: () => void;
	onDelete?: () => void;
	isRefreshing?: boolean;
	isDeletePending?: boolean;
}

/**
 * Cache status card component for displaying individual cache entry status.
 * Pure presentational component with no business logic.
 *
 * @param configTypeLabel - Human-readable configuration type label
 * @param version - Cache version
 * @param itemCount - Number of items in cache
 * @param lastFetched - ISO timestamp of last fetch
 * @param isStale - Whether cache is stale
 * @param onRefresh - Optional handler for refreshing this cache entry
 * @param onDelete - Optional handler for deleting this cache entry
 * @param isRefreshing - Whether this entry is currently being refreshed
 * @param isDeletePending - Whether a delete operation is in progress
 *
 * @example
 * <CacheStatusCard
 *   configTypeLabel="Custom Formats"
 *   version={1}
 *   itemCount={42}
 *   lastFetched="2025-01-19T12:00:00Z"
 *   isStale={false}
 *   onRefresh={() => handleRefreshEntry("RADARR", "CUSTOM_FORMATS")}
 *   onDelete={() => handleDelete("RADARR", "CUSTOM_FORMATS")}
 * />
 */
export const CacheStatusCard = ({
	configTypeLabel,
	version,
	itemCount,
	lastFetched,
	isStale,
	onRefresh,
	onDelete,
	isRefreshing,
	isDeletePending,
}: CacheStatusCardProps) => {
	return (
		<article
			className={`rounded-xl border p-6 transition ${
				isStale
					? "border-yellow-500/30 bg-yellow-500/5"
					: "border-border bg-bg-subtle hover:border-border"
			}`}
		>
			<div className="flex items-start justify-between">
				<div>
					<h3 className="font-medium text-fg">{configTypeLabel}</h3>
					<p className="mt-1 text-xs text-fg-muted">v{version}</p>
				</div>
				<div className="flex items-center gap-1">
					{isStale && (
						<span className="rounded-full bg-yellow-500/20 px-2 py-1 text-xs font-medium text-yellow-200 mr-1">
							Stale
						</span>
					)}
					{onRefresh && (
						<button
							type="button"
							onClick={onRefresh}
							disabled={isRefreshing || isDeletePending}
							className="rounded-lg p-1.5 text-fg-muted hover:bg-primary/20 hover:text-primary transition disabled:opacity-50 disabled:cursor-not-allowed"
							title="Refresh this cache entry"
						>
							<RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
						</button>
					)}
					{onDelete && (
						<button
							type="button"
							onClick={onDelete}
							disabled={isRefreshing || isDeletePending}
							className="rounded-lg p-1.5 text-fg-muted hover:bg-red-500/20 hover:text-red-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
							title="Delete cache entry"
						>
							<Trash2 className="h-4 w-4" />
						</button>
					)}
				</div>
			</div>

			<div className="mt-4 space-y-2 text-sm">
				<div className="flex items-center gap-2 text-fg-muted">
					<Database className="h-4 w-4" />
					<span>{itemCount} items</span>
				</div>
				<div className="flex items-center gap-2 text-fg-muted">
					<Clock className="h-4 w-4" />
					<span>Last fetched: {new Date(lastFetched).toLocaleString()}</span>
				</div>
			</div>
		</article>
	);
};
