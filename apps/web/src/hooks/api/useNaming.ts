"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	NamingApplyApiResponse,
	NamingApplyPayload,
	NamingConfigApiResponse,
	NamingConfigCreatePayload,
	NamingConfigDeleteResponse,
	NamingConfigSaveResponse,
	NamingPreviewApiResponse,
	NamingPreviewPayload,
	NamingPresetsApiResponse,
} from "../../lib/api-client/trash-guides/naming";
import {
	applyNaming,
	deleteNamingConfig,
	fetchNamingConfig,
	fetchNamingPresets,
	getNamingPreview,
	saveNamingConfig,
} from "../../lib/api-client/trash-guides/naming";

// ============================================================================
// Query Keys
// ============================================================================

export const NAMING_PRESETS_KEY = ["naming-presets"] as const;
export const NAMING_CONFIG_KEY = ["naming-config"] as const;

// ============================================================================
// Query Hooks
// ============================================================================

/**
 * Fetch available TRaSH naming presets for a service type.
 * Presets come from the TRaSH cache and change infrequently.
 */
export const useNamingPresets = (serviceType: "RADARR" | "SONARR", enabled = true) =>
	useQuery<NamingPresetsApiResponse>({
		queryKey: [...NAMING_PRESETS_KEY, serviceType],
		queryFn: () => fetchNamingPresets(serviceType),
		enabled,
		staleTime: 10 * 60 * 1000, // 10 minutes — presets from TRaSH cache
	});

/**
 * Fetch saved naming config for a specific instance.
 */
export const useNamingConfig = (instanceId: string | undefined, enabled = true) =>
	useQuery<NamingConfigApiResponse>({
		queryKey: [...NAMING_CONFIG_KEY, instanceId],
		queryFn: () => fetchNamingConfig(instanceId!),
		enabled: enabled && !!instanceId,
		staleTime: 5 * 60 * 1000,
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
				queryKey: [...NAMING_CONFIG_KEY, variables.instanceId],
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
				queryKey: [...NAMING_CONFIG_KEY, variables.instanceId],
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
				queryKey: [...NAMING_CONFIG_KEY, instanceId],
			});
		},
	});
};
