import { Database, Clock } from "lucide-react";

interface CacheStatusCardProps {
	configType: string;
	configTypeLabel: string;
	version: number;
	itemCount: number;
	lastFetched: string;
	isStale: boolean;
}

/**
 * Cache status card component for displaying individual cache entry status.
 * Pure presentational component with no business logic.
 *
 * @param configType - Configuration type identifier
 * @param configTypeLabel - Human-readable configuration type label
 * @param version - Cache version
 * @param itemCount - Number of items in cache
 * @param lastFetched - ISO timestamp of last fetch
 * @param isStale - Whether cache is stale
 *
 * @example
 * <CacheStatusCard
 *   configType="CUSTOM_FORMATS"
 *   configTypeLabel="Custom Formats"
 *   version="1.2.3"
 *   itemCount={42}
 *   lastFetched="2025-01-19T12:00:00Z"
 *   isStale={false}
 * />
 */
export const CacheStatusCard = ({
	configTypeLabel,
	version,
	itemCount,
	lastFetched,
	isStale,
}: CacheStatusCardProps) => {
	return (
		<article
			className={`rounded-xl border p-6 transition ${
				isStale
					? "border-yellow-500/30 bg-yellow-500/5"
					: "border-white/10 bg-white/5 hover:border-white/20"
			}`}
		>
			<div className="flex items-start justify-between">
				<div>
					<h3 className="font-medium text-white">{configTypeLabel}</h3>
					<p className="mt-1 text-xs text-white/60">v{version}</p>
				</div>
				{isStale && (
					<span className="rounded-full bg-yellow-500/20 px-2 py-1 text-xs font-medium text-yellow-200">
						Stale
					</span>
				)}
			</div>

			<div className="mt-4 space-y-2 text-sm">
				<div className="flex items-center gap-2 text-white/70">
					<Database className="h-4 w-4" />
					<span>{itemCount} items</span>
				</div>
				<div className="flex items-center gap-2 text-white/70">
					<Clock className="h-4 w-4" />
					<span>Last fetched: {new Date(lastFetched).toLocaleString()}</span>
				</div>
			</div>
		</article>
	);
};
