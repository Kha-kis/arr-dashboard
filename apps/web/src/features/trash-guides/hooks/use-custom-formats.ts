/**
 * Custom Formats Hooks
 * React hooks for fetching and deploying TRaSH Guides custom formats
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFormatKeys } from "../../../lib/query-keys";
import {
	type CreateUserCFRequest,
	createUserCustomFormat,
	type DeployMultipleCustomFormatsRequest,
	type DeployUserCFsRequest,
	deleteUserCustomFormat,
	deployMultipleCustomFormats,
	deployUserCustomFormats,
	fetchCFDescriptionsList,
	fetchCustomFormatsList,
	fetchUserCustomFormats,
	type ImportUserCFFromInstanceRequest,
	type ImportUserCFFromJsonRequest,
	importUserCFsFromInstance,
	importUserCFsFromJson,
} from "../../../lib/api-client/trash-guides";

/**
 * Hook to fetch all available custom formats from TRaSH Guides
 */
export function useCustomFormats(serviceType?: "RADARR" | "SONARR") {
	return useQuery({
		queryKey: customFormatKeys.list(serviceType),
		queryFn: () => fetchCustomFormatsList(serviceType),
		staleTime: 5 * 60 * 1000, // 5 minutes
	});
}

/**
 * Hook to fetch CF descriptions from TRaSH Guides
 */
export function useCFDescriptions(serviceType?: "RADARR" | "SONARR") {
	return useQuery({
		queryKey: customFormatKeys.descriptions(serviceType),
		queryFn: () => fetchCFDescriptionsList(serviceType),
		staleTime: 60 * 60 * 1000, // 1 hour - descriptions change less frequently
	});
}

/**
 * Hook to deploy multiple custom formats to an instance
 */
export function useDeployMultipleCustomFormats() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (request: DeployMultipleCustomFormatsRequest) =>
			deployMultipleCustomFormats(request),
		onSuccess: () => {
			// Invalidate related queries
			queryClient.invalidateQueries({ queryKey: customFormatKeys.all });
		},
	});
}

// ============================================================================
// User Custom Format Hooks
// ============================================================================

/**
 * Hook to fetch user custom formats
 */
export function useUserCustomFormats(serviceType?: "RADARR" | "SONARR") {
	return useQuery({
		queryKey: customFormatKeys.userByService(serviceType),
		queryFn: () => fetchUserCustomFormats(serviceType),
		staleTime: 60 * 1000, // 1 minute
	});
}

/**
 * Hook to create a user custom format
 */
export function useCreateUserCustomFormat() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (request: CreateUserCFRequest) => createUserCustomFormat(request),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: customFormatKeys.user });
		},
	});
}

/**
 * Hook to delete a user custom format
 */
export function useDeleteUserCustomFormat() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (id: string) => deleteUserCustomFormat(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: customFormatKeys.user });
		},
	});
}

/**
 * Hook to import user CFs from JSON
 */
export function useImportUserCFFromJson() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (request: ImportUserCFFromJsonRequest) => importUserCFsFromJson(request),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: customFormatKeys.user });
		},
	});
}

/**
 * Hook to import user CFs from a connected instance
 */
export function useImportUserCFFromInstance() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (request: ImportUserCFFromInstanceRequest) => importUserCFsFromInstance(request),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: customFormatKeys.user });
		},
	});
}

/**
 * Hook to deploy user custom formats to an instance
 */
export function useDeployUserCustomFormats() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (request: DeployUserCFsRequest) => deployUserCustomFormats(request),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: customFormatKeys.user });
			queryClient.invalidateQueries({ queryKey: customFormatKeys.all });
		},
	});
}
