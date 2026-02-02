"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
	TrashSettingsResponse,
	UpdateTrashSettingsPayload,
	UpdateTrashSettingsResponse,
	TestRepoPayload,
	TestRepoResponse,
	ResetRepoResponse,
} from "../../lib/api-client/trash-guides";
import {
	fetchTrashSettings,
	updateTrashSettings,
	testCustomRepo,
	resetToOfficialRepo,
} from "../../lib/api-client/trash-guides";

/**
 * Hook to fetch current user's TRaSH Guides settings
 */
export const useTrashSettings = () =>
	useQuery<TrashSettingsResponse>({
		queryKey: ["trash-settings"],
		queryFn: fetchTrashSettings,
		staleTime: 5 * 60 * 1000, // 5 minutes
	});

/**
 * Hook to update TRaSH Guides settings.
 * When repo config changes, the backend automatically clears all caches.
 */
export const useUpdateTrashSettings = () => {
	const queryClient = useQueryClient();

	return useMutation<UpdateTrashSettingsResponse, Error, UpdateTrashSettingsPayload>({
		mutationFn: updateTrashSettings,
		onSuccess: (data) => {
			void queryClient.invalidateQueries({ queryKey: ["trash-settings"] });
			// If cache was cleared (repo changed), invalidate cache-related queries
			if (data.cacheCleared) {
				void queryClient.invalidateQueries({ queryKey: ["trash-cache-status"] });
				void queryClient.invalidateQueries({ queryKey: ["trash-cache-entries"] });
			}
		},
	});
};

/**
 * Hook to test a custom repository configuration.
 * Validates the repo exists and has the expected TRaSH Guides structure.
 */
export const useTestCustomRepo = () =>
	useMutation<TestRepoResponse, Error, TestRepoPayload>({
		mutationFn: testCustomRepo,
	});

/**
 * Hook to reset to the official TRaSH-Guides/Guides repository.
 * Clears custom repo fields and invalidates all caches.
 */
export const useResetToOfficialRepo = () => {
	const queryClient = useQueryClient();

	return useMutation<ResetRepoResponse, Error, void>({
		mutationFn: resetToOfficialRepo,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["trash-settings"] });
			void queryClient.invalidateQueries({ queryKey: ["trash-cache-status"] });
			void queryClient.invalidateQueries({ queryKey: ["trash-cache-entries"] });
		},
	});
};
