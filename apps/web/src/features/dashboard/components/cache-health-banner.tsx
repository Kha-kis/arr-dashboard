"use client";

import { AlertTriangle, Loader2, RefreshCw, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui";
import { getLinuxInstanceName, useIncognitoMode } from "../../../lib/incognito";
import {
	useJellyfinCacheHealth,
	useJellyfinCacheRefreshMutation,
} from "../../../hooks/api/useJellyfin";
import { useCacheHealth, useCacheRefreshMutation } from "../../../hooks/api/usePlex";

interface CacheHealthBannerProps {
	enabled: boolean;
}

export const CacheHealthBanner = ({ enabled }: CacheHealthBannerProps) => {
	const [incognitoMode] = useIncognitoMode();
	const plexHealth = useCacheHealth(enabled);
	const jellyfinHealth = useJellyfinCacheHealth(enabled);
	const plexRefresh = useCacheRefreshMutation();
	const jellyfinRefresh = useJellyfinCacheRefreshMutation();
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [refreshError, setRefreshError] = useState(false);

	const allItems = useMemo(() => {
		const plex = plexHealth.data?.items ?? [];
		const jellyfin = jellyfinHealth.data?.items ?? [];
		return [...plex, ...jellyfin];
	}, [plexHealth.data, jellyfinHealth.data]);

	const isError = plexHealth.isError && jellyfinHealth.isError;

	if (dismissed || isError || allItems.length === 0) return null;

	const staleItems = allItems.filter((item) => item.isStale);
	const errorItems = allItems.filter((item) => item.lastResult === "error" && !item.isStale);

	if (staleItems.length === 0 && errorItems.length === 0) return null;

	const displayName = (name: string) => incognitoMode ? getLinuxInstanceName(name) : name;

	const messages: string[] = [];
	if (staleItems.length > 0) {
		const names = staleItems.map((i) => `${displayName(i.instanceName)} (${i.cacheType})`).join(", ");
		messages.push(`Stale cache data: ${names}`);
	}
	if (errorItems.length > 0) {
		const names = errorItems.map((i) => `${displayName(i.instanceName)} (${i.cacheType})`).join(", ");
		messages.push(`Cache refresh errors: ${names}`);
	}

	// Collect affected instances by cache type for targeted refresh
	const affected = [...staleItems, ...errorItems];
	const plexInstanceIds = [...new Set(affected.filter((i) => i.cacheType === "plex" || i.cacheType === "plex_episode").map((i) => i.instanceId))];
	const jellyfinInstanceIds = [...new Set(affected.filter((i) => i.cacheType === "jellyfin" || i.cacheType === "jellyfin_episode").map((i) => i.instanceId))];
	const hasRefreshable = plexInstanceIds.length > 0 || jellyfinInstanceIds.length > 0;

	const handleRefresh = async () => {
		setIsRefreshing(true);
		setRefreshError(false);
		try {
			const results = await Promise.allSettled([
				...plexInstanceIds.map((id) => plexRefresh.mutateAsync({ instanceId: id })),
				...jellyfinInstanceIds.map((id) => jellyfinRefresh.mutateAsync({ instanceId: id })),
			]);
			const failures = results.filter((r) => r.status === "rejected");
			if (failures.length > 0) setRefreshError(true);
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
						{refreshError
							? "Some cache refreshes failed. Please try again."
							: "Data may be outdated. Caches refresh automatically every 6 hours."}
					</span>
				</AlertDescription>
				{hasRefreshable && (
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
				{!hasRefreshable && (
					<RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
				)}
				<button
					type="button"
					onClick={() => setDismissed(true)}
					className="flex-shrink-0 rounded-md p-1 hover:bg-muted/50 transition-colors"
					title="Dismiss"
				>
					<X className="h-3.5 w-3.5 text-muted-foreground" />
				</button>
			</div>
		</Alert>
	);
};
