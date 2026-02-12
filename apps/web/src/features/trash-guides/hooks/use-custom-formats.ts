/**
 * Custom Formats Hooks
 * React hooks for fetching and deploying TRaSH Guides custom formats
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
	fetchCustomFormatsList,
	fetchCFDescriptionsList,
	fetchCFIncludesList,
	deployCustomFormat,
	deployMultipleCustomFormats,
	fetchUserCustomFormats,
	createUserCustomFormat,
	updateUserCustomFormat,
	deleteUserCustomFormat,
	importUserCFsFromJson,
	importUserCFsFromInstance,
	deployUserCustomFormats,
	type DeployCustomFormatRequest,
	type DeployMultipleCustomFormatsRequest,
	type CreateUserCFRequest,
	type ImportUserCFFromJsonRequest,
	type ImportUserCFFromInstanceRequest,
	type DeployUserCFsRequest,
} from "../../../lib/api-client/trash-guides";

/**
 * Hook to fetch all available custom formats from TRaSH Guides
 */
export function useCustomFormats(serviceType?: "RADARR" | "SONARR") {
	return useQuery({
		queryKey: ["custom-formats", "list", serviceType],
		queryFn: () => fetchCustomFormatsList(serviceType),
		staleTime: 5 * 60 * 1000, // 5 minutes
	});
}

/**
 * Hook to deploy a single custom format to an instance
 */
export function useDeployCustomFormat() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (request: DeployCustomFormatRequest) => deployCustomFormat(request),
		onSuccess: () => {
			// Invalidate related queries
			queryClient.invalidateQueries({ queryKey: ["custom-formats"] });
		},
	});
}

/**
 * Hook to fetch CF descriptions from TRaSH Guides
 */
export function useCFDescriptions(serviceType?: "RADARR" | "SONARR") {
	return useQuery({
		queryKey: ["cf-descriptions", "list", serviceType],
		queryFn: () => fetchCFDescriptionsList(serviceType),
		staleTime: 60 * 60 * 1000, // 1 hour - descriptions change less frequently
	});
}

/**
 * Hook to fetch CF include files from TRaSH Guides.
 * These are MkDocs snippets referenced by CF descriptions using --8<-- syntax.
 */
export function useCFIncludes() {
	return useQuery({
		queryKey: ["cf-includes", "list"],
		queryFn: () => fetchCFIncludesList(),
		staleTime: 60 * 60 * 1000, // 1 hour - includes change less frequently
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
			queryClient.invalidateQueries({ queryKey: ["custom-formats"] });
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
		queryKey: ["user-custom-formats", serviceType],
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
			queryClient.invalidateQueries({ queryKey: ["user-custom-formats"] });
		},
	});
}

/**
 * Hook to update a user custom format
 */
export function useUpdateUserCustomFormat() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, ...request }: { id: string } & Partial<CreateUserCFRequest>) =>
			updateUserCustomFormat(id, request),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["user-custom-formats"] });
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
			queryClient.invalidateQueries({ queryKey: ["user-custom-formats"] });
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
			queryClient.invalidateQueries({ queryKey: ["user-custom-formats"] });
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
			queryClient.invalidateQueries({ queryKey: ["user-custom-formats"] });
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
			queryClient.invalidateQueries({ queryKey: ["user-custom-formats"] });
			queryClient.invalidateQueries({ queryKey: ["custom-formats"] });
		},
	});
}
