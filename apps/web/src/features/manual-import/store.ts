import { create } from "zustand";
import type {
	ManualImportCandidateUnion,
	ManualImportSelection,
	ManualImportService,
	ManualImportSubmissionFile,
} from "./types";
import { candidateKey } from "./helpers";

type ManualImportUIState = {
	selections: Record<string, ManualImportSelection>;
	toggleSelection: (
		candidate: ManualImportCandidateUnion,
		instanceId: string,
		downloadId: string,
		values: ManualImportSubmissionFile,
	) => void;
	updateSelection: (
		candidate: ManualImportCandidateUnion,
		updater: (selection: ManualImportSelection) => ManualImportSelection,
	) => void;
	removeSelection: (candidate: ManualImportCandidateUnion) => void;
	clear: () => void;
};

export const useManualImportStore = create<ManualImportUIState>((set) => ({
	selections: {},
	toggleSelection: (candidate, instanceId, downloadId, values) =>
		set((state) => {
			const key = candidateKey(candidate);
			if (state.selections[key]) {
				const next = { ...state.selections };
				delete next[key];
				return { selections: next };
			}

			const selection: ManualImportSelection = {
				candidateId: candidate.id,
				service: candidate.service,
				instanceId,
				downloadId,
				values,
			};

			return {
				selections: {
					...state.selections,
					[key]: selection,
				},
			};
		}),
	updateSelection: (candidate, updater) =>
		set((state) => {
			const key = candidateKey(candidate);
			const current = state.selections[key];
			if (!current) {
				return state;
			}
			return {
				selections: {
					...state.selections,
					[key]: updater(current),
				},
			};
		}),
	removeSelection: (candidate) =>
		set((state) => {
			const key = candidateKey(candidate);
			if (!state.selections[key]) {
				return state;
			}
			const next = { ...state.selections };
			delete next[key];
			return { selections: next };
		}),
	clear: () => set({ selections: {} }),
}));

export const getSelectionForCandidate = (
	selections: Record<string, ManualImportSelection>,
	candidate: ManualImportCandidateUnion,
): ManualImportSelection | undefined => selections[candidateKey(candidate)];

export const hasValidSelections = (
	selections: Record<string, ManualImportSelection>,
	service: ManualImportService,
): boolean => {
	const entries = Object.values(selections).filter((selection) => selection.service === service);
	if (entries.length === 0) {
		return false;
	}

	return entries.every((selection) => {
		if (selection.service === "sonarr") {
			const { seriesId, episodeIds } = selection.values;
			return Boolean(seriesId && Array.isArray(episodeIds) && episodeIds.length > 0);
		}

		if (selection.service === "radarr") {
			return typeof selection.values.movieId === "number";
		}

		if (selection.service === "lidarr") {
			return typeof selection.values.artistId === "number" && typeof selection.values.albumId === "number";
		}

		if (selection.service === "readarr") {
			return typeof selection.values.authorId === "number" && typeof selection.values.bookId === "number";
		}

		return false;
	});
};
