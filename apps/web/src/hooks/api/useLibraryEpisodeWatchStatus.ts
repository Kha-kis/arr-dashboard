import { useState } from "react";
import { useJellyfinEpisodeWatchStatus } from "./useJellyfin";
import { useEpisodeWatchStatus } from "./usePlex";

/** Select the native endpoint explicitly; provider failures never switch provenance. */
export function useLibraryEpisodeWatchStatus(
	instanceId: string | null | undefined,
	showTmdbId: number | null | undefined,
	provider: "plex" | "jellyfin",
) {
	const [retryFailure, setRetryFailure] = useState<{
		provider: "plex" | "jellyfin";
		instanceId: typeof instanceId;
		showTmdbId: typeof showTmdbId;
		error: Error;
	} | null>(null);
	const plex = useEpisodeWatchStatus(provider === "plex" ? instanceId : undefined, showTmdbId);
	const jellyfin = useJellyfinEpisodeWatchStatus(
		provider === "jellyfin" ? instanceId : undefined,
		showTmdbId,
	);
	const selected = provider === "jellyfin" ? jellyfin : plex;
	const isRetrying = selected.fetchStatus !== "idle";
	const pendingError =
		isRetrying &&
		retryFailure?.provider === provider &&
		retryFailure.instanceId === instanceId &&
		retryFailure.showTmdbId === showTmdbId
			? retryFailure.error
			: null;
	const error = selected.error ?? pendingError;
	const canRetry = !!instanceId && !!showTmdbId && !!error;
	function retry() {
		if (!canRetry || isRetrying || !error) return;
		const failure = { provider, instanceId, showTmdbId, error };
		setRetryFailure(failure);
		void selected.refetch({ cancelRefetch: false }).finally(() => {
			setRetryFailure((current) => (current === failure ? null : current));
		});
	}
	return {
		episodes: selected.data?.episodes,
		error,
		canRetry,
		isRetrying,
		retry,
		plexEvidence: provider === "plex" ? plex.data?.evidence : undefined,
		providerStatus: provider === "jellyfin" ? jellyfin.data?.providerStatus : undefined,
	};
}
