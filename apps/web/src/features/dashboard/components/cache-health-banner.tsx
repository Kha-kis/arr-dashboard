"use client";

import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui";
import { useCacheHealth, useCacheRefreshMutation } from "../../../hooks/api/usePlex";

interface CacheHealthBannerProps {
	enabled: boolean;
}

export const CacheHealthBanner = ({ enabled }: CacheHealthBannerProps) => {
	const { data, isError } = useCacheHealth(enabled);
	const refreshMutation = useCacheRefreshMutation();
	const [isRefreshing, setIsRefreshing] = useState(false);

	if (isError || !data?.items?.length) return null;

	const staleItems = data.items.filter((item) => item.isStale);
	const errorItems = data.items.filter((item) => item.lastResult === "error" && !item.isStale);

	if (staleItems.length === 0 && errorItems.length === 0) return null;

	const messages: string[] = [];
	if (staleItems.length > 0) {
		const names = staleItems.map((i) => `${i.instanceName} (${i.cacheType})`).join(", ");
		messages.push(`Stale cache data: ${names}`);
	}
	if (errorItems.length > 0) {
		const names = errorItems.map((i) => `${i.instanceName} (${i.cacheType})`).join(", ");
		messages.push(`Cache refresh errors: ${names}`);
	}

	// Collect unique Plex instance IDs from affected items (only plex cache type is refreshable)
	const refreshableInstanceIds = [
		...new Set(
			[...staleItems, ...errorItems]
				.filter((item) => item.cacheType === "plex")
				.map((item) => item.instanceId),
		),
	];

	const handleRefresh = async () => {
		setIsRefreshing(true);
		try {
			await Promise.allSettled(
				refreshableInstanceIds.map((instanceId) =>
					refreshMutation.mutateAsync({ instanceId }),
				),
			);
		} finally {
			setIsRefreshing(false);
		}
	};

	return (
		<Alert variant="warning" className="animate-in fade-in duration-300">
			<div className="flex items-center gap-2">
				<AlertTriangle className="h-4 w-4 flex-shrink-0" />
				<AlertDescription className="flex-1">
					{messages.join(" — ")}
					<span className="text-xs text-muted-foreground ml-2">
						Data may be outdated. Caches refresh automatically every 6 hours.
					</span>
				</AlertDescription>
				{refreshableInstanceIds.length > 0 && (
					<button
						type="button"
						onClick={handleRefresh}
						disabled={isRefreshing}
						className="flex-shrink-0 rounded-md p-1 hover:bg-muted/50 transition-colors disabled:opacity-50"
						title="Refresh stale caches"
					>
						{isRefreshing ? (
							<Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
						) : (
							<RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
						)}
					</button>
				)}
				{refreshableInstanceIds.length === 0 && (
					<RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
				)}
			</div>
		</Alert>
	);
};
