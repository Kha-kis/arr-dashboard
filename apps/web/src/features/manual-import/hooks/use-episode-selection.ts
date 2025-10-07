import { useCallback } from "react";
import type { ManualImportCandidateUnion } from "../types";
import { isSonarrCandidate } from "../helpers";
import { useManualImportStore } from "../store";

/**
 * Hook for managing episode selection within a candidate
 */
export const useEpisodeSelection = () => {
	const { updateSelection } = useManualImportStore();

	const toggleEpisode = useCallback(
		(candidate: ManualImportCandidateUnion, episodeId: number) => {
			updateSelection(candidate, (current) => {
				const currentIds = Array.isArray(current.values.episodeIds)
					? current.values.episodeIds
					: [];
				const next = currentIds.includes(episodeId)
					? currentIds.filter((id) => id !== episodeId)
					: [...currentIds, episodeId];
				next.sort((a, b) => a - b);
				return {
					...current,
					values: {
						...current.values,
						episodeIds: next,
					},
				};
			});
		},
		[updateSelection],
	);

	const selectAllEpisodes = useCallback(
		(candidate: ManualImportCandidateUnion) => {
			if (!isSonarrCandidate(candidate) || !candidate.episodes) {
				return;
			}
			const ids = candidate.episodes
				.map((episode) => episode?.id)
				.filter((id): id is number => typeof id === "number");
			if (ids.length === 0) {
				return;
			}
			const unique = Array.from(new Set(ids)).sort((a, b) => a - b);
			updateSelection(candidate, (current) => ({
				...current,
				values: {
					...current.values,
					episodeIds: unique,
				},
			}));
		},
		[updateSelection],
	);

	const clearEpisodes = useCallback(
		(candidate: ManualImportCandidateUnion) => {
			updateSelection(candidate, (current) => ({
				...current,
				values: {
					...current.values,
					episodeIds: [],
				},
			}));
		},
		[updateSelection],
	);

	return {
		toggleEpisode,
		selectAllEpisodes,
		clearEpisodes,
	};
};
