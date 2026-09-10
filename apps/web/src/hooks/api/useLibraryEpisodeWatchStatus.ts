import { useJellyfinEpisodeWatchStatus } from "./useJellyfin";
import { useEpisodeWatchStatus } from "./usePlex";

/** Select the native endpoint explicitly; provider failures never switch provenance. */
export function useLibraryEpisodeWatchStatus(
	instanceId: string | null | undefined,
	showTmdbId: number | null | undefined,
	provider: "plex" | "jellyfin",
) {
	const plex = useEpisodeWatchStatus(provider === "plex" ? instanceId : undefined, showTmdbId);
	const jellyfin = useJellyfinEpisodeWatchStatus(
		provider === "jellyfin" ? instanceId : undefined,
		showTmdbId,
	);
	const selected = provider === "jellyfin" ? jellyfin : plex;
	return {
		episodes: selected.data?.episodes,
		error: selected.error,
		plexEvidence: provider === "plex" ? plex.data?.evidence : undefined,
		providerStatus: provider === "jellyfin" ? jellyfin.data?.providerStatus : undefined,
	};
}
