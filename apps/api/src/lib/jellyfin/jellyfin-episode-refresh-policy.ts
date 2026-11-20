/** Delay used after a successful non-final Jellyfin episode page advance. */
export const JELLYFIN_EPISODE_SUCCESSFUL_PROGRESS_CONTINUATION_DELAY_MS = 1_000;
/** Recheck the parent library after a refresh that temporarily owns admission. */
export const JELLYFIN_EPISODE_PARENT_REFRESH_CONTINUATION_DELAY_MS = 30_000;

export type JellyfinEpisodePageSize = 1_000 | 2_000;
export const JELLYFIN_EPISODE_NEW_RUN_PAGE_SIZE: JellyfinEpisodePageSize = 2_000;

/** Absence is the immutable page size of runs admitted before the larger-page rollout. */
export function jellyfinEpisodePageSizeFromPayload(
	payload: string | null,
): JellyfinEpisodePageSize | null {
	if (!payload) return null;
	try {
		const value: unknown = JSON.parse(payload);
		if (typeof value !== "object" || value === null) return null;
		const size = (value as { pageSize?: unknown }).pageSize;
		return size === undefined || size === 1_000 ? 1_000 : size === 2_000 ? 2_000 : null;
	} catch {
		return null;
	}
}

export function hasPlausibleJellyfinEpisodePageCount(
	observedRawCount: number,
	completedPages: number,
	pageSize: JellyfinEpisodePageSize,
): boolean {
	return (
		Number.isSafeInteger(observedRawCount) &&
		observedRawCount >= 0 &&
		Number.isSafeInteger(completedPages) &&
		completedPages >= Math.max(1, Math.ceil(observedRawCount / pageSize)) &&
		completedPages <= Math.max(1, observedRawCount)
	);
}

export const JELLYFIN_EPISODE_MAX_SCOPE_ROWS = 100_000;
