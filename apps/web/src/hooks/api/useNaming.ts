"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { namingKeys } from "../../lib/query-keys";
import type {
	NamingApplyApiResponse,
	NamingApplyPayload,
	NamingConfigApiResponse,
	NamingConfigCreatePayload,
	NamingConfigDeleteResponse,
	NamingConfigSaveResponse,
	NamingHistoryApiResponse,
	NamingPreviewApiResponse,
	NamingPreviewPayload,
	NamingPresetsApiResponse,
	NamingRollbackApiResponse,
} from "../../lib/api-client/trash-guides/naming";
import {
	applyNaming,
	deleteNamingConfig,
	fetchNamingConfig,
	fetchNamingHistory,
	fetchNamingPresets,
	getNamingPreview,
	rollbackNaming,
	saveNamingConfig,
} from "../../lib/api-client/trash-guides/naming";

// ============================================================================
// Query Keys
// ============================================================================



// ============================================================================
// Query Hooks
// ============================================================================

/**
 * Fetch available TRaSH naming presets for a service type.
 * Presets come from the TRaSH cache and change infrequently.
 */
export const useNamingPresets = (serviceType: "RADARR" | "SONARR", enabled = true) =>
	useQuery<NamingPresetsApiResponse>({
		queryKey: [...namingKeys.presets, serviceType],
		queryFn: () => fetchNamingPresets(serviceType),
		enabled,
		staleTime: 10 * 60 * 1000, // 10 minutes — presets from TRaSH cache
	});

/**
 * Fetch saved naming config for a specific instance.
 */
export const useNamingConfig = (instanceId: string | undefined, enabled = true) =>
	useQuery<NamingConfigApiResponse>({
		queryKey: [...namingKeys.config, instanceId],
		queryFn: () => fetchNamingConfig(instanceId!),
		enabled: enabled && !!instanceId,
		staleTime: 5 * 60 * 1000,
	});

/**
 * Fetch paginated naming deploy history for an instance.
 */
export const useNamingHistory = (
	instanceId: string | undefined,
	options?: { limit?: number; offset?: number },
) =>
	useQuery<NamingHistoryApiResponse>({
		queryKey: [...namingKeys.history, instanceId, options?.offset ?? 0],
		queryFn: () => fetchNamingHistory(instanceId!, options),
		enabled: !!instanceId,
		staleTime: 60_000,
	});

// ============================================================================
// Mutation Hooks
// ============================================================================

/**
 * Preview naming changes against an instance's current config.
 * Returns field-by-field diff of what will change.
 */
export const useNamingPreview = () => {
	return useMutation<NamingPreviewApiResponse, Error, NamingPreviewPayload>({
		mutationFn: (payload) => getNamingPreview(payload),
	});
};

/**
 * Apply selected naming presets to an instance.
 * Invalidates naming config cache on success.
 */
export const useApplyNaming = () => {
	const queryClient = useQueryClient();

	return useMutation<NamingApplyApiResponse, Error, NamingApplyPayload>({
		mutationFn: (payload) => applyNaming(payload),
		onSuccess: (_data, variables) => {
			void queryClient.invalidateQueries({
				queryKey: [...namingKeys.config, variables.instanceId],
			});
			void queryClient.invalidateQueries({
				queryKey: [...namingKeys.history, variables.instanceId],
			});
		},
	});
};

/**
 * Save (create/upsert) naming config for an instance.
 */
export const useSaveNamingConfig = () => {
	const queryClient = useQueryClient();

	return useMutation<NamingConfigSaveResponse, Error, NamingConfigCreatePayload>({
		mutationFn: (payload) => saveNamingConfig(payload),
		onSuccess: (_data, variables) => {
			void queryClient.invalidateQueries({
				queryKey: [...namingKeys.config, variables.instanceId],
			});
		},
	});
};

/**
 * Delete naming config for an instance.
 */
export const useDeleteNamingConfig = () => {
	const queryClient = useQueryClient();

	return useMutation<NamingConfigDeleteResponse, Error, string>({
		mutationFn: (instanceId) => deleteNamingConfig(instanceId),
		onSuccess: (_data, instanceId) => {
			void queryClient.invalidateQueries({
				queryKey: [...namingKeys.config, instanceId],
			});
		},
	});
};

/**
 * Rollback a naming deploy to its pre-deploy state.
 * Invalidates naming config cache on success.
 */
export const useRollbackNaming = () => {
	const queryClient = useQueryClient();

	return useMutation<NamingRollbackApiResponse, Error, { historyId: string; instanceId: string }>({
		mutationFn: ({ historyId }) => rollbackNaming(historyId),
		onSuccess: (_data, variables) => {
			void queryClient.invalidateQueries({
				queryKey: [...namingKeys.config, variables.instanceId],
			});
			void queryClient.invalidateQueries({
				queryKey: [...namingKeys.history, variables.instanceId],
			});
		},
	});
};
