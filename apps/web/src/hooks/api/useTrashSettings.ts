"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
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
 * Schedule delayed cache query invalidations to pick up background population.
 * After a repo change or reset, the backend populates cache asynchronously (~30-60s).
 * We re-invalidate at intervals so the cache tab auto-updates without manual refresh.
 */
const CACHE_REFRESH_DELAYS_MS = [15_000, 45_000, 75_000];
let pendingTimers: ReturnType<typeof setTimeout>[] = [];

function scheduleCacheRefresh(queryClient: QueryClient): void {
	// Clear any previously scheduled timers to prevent stacking
	for (const timer of pendingTimers) clearTimeout(timer);
	pendingTimers = [];

	for (const delay of CACHE_REFRESH_DELAYS_MS) {
		pendingTimers.push(
			setTimeout(() => {
				void queryClient.invalidateQueries({ queryKey: ["trash-cache-status"] });
				void queryClient.invalidateQueries({ queryKey: ["trash-cache-entries"] });
			}, delay),
		);
	}
}

/**
 * Hook to fetch current user's TRaSH Guides settings
 */
export function useTrashSettings() {
	return useQuery<TrashSettingsResponse>({
		queryKey: ["trash-settings"],
		queryFn: fetchTrashSettings,
		staleTime: 5 * 60 * 1000, // 5 minutes
	});
}

/**
 * Hook to update TRaSH Guides settings.
 * When repo config changes, the backend automatically clears all caches.
 */
export function useUpdateTrashSettings() {
	const queryClient = useQueryClient();

	return useMutation<UpdateTrashSettingsResponse, Error, UpdateTrashSettingsPayload>({
		mutationFn: updateTrashSettings,
		onSuccess: (data) => {
			void queryClient.invalidateQueries({ queryKey: ["trash-settings"] });
			if (data.cacheCleared) {
				void queryClient.invalidateQueries({ queryKey: ["trash-cache-status"] });
				void queryClient.invalidateQueries({ queryKey: ["trash-cache-entries"] });
				scheduleCacheRefresh(queryClient);
			}
		},
	});
}

/**
 * Hook to test a custom repository configuration.
 * Validates the repo exists and has the expected TRaSH Guides structure.
 */
export function useTestCustomRepo() {
	return useMutation<TestRepoResponse, Error, TestRepoPayload>({
		mutationFn: testCustomRepo,
	});
}

/**
 * Hook to reset to the official TRaSH-Guides/Guides repository.
 * Clears custom repo fields and invalidates all caches.
 */
export function useResetToOfficialRepo() {
	const queryClient = useQueryClient();

	return useMutation<ResetRepoResponse, Error, void>({
		mutationFn: resetToOfficialRepo,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["trash-settings"] });
			void queryClient.invalidateQueries({ queryKey: ["trash-cache-status"] });
			void queryClient.invalidateQueries({ queryKey: ["trash-cache-entries"] });
			scheduleCacheRefresh(queryClient);
		},
	});
}
