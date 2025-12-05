/**
 * Custom Formats Hooks
 * React hooks for fetching and deploying TRaSH Guides custom formats
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
	fetchCustomFormatsList,
	fetchCFDescriptionsList,
	deployCustomFormat,
	deployMultipleCustomFormats,
	type DeployCustomFormatRequest,
	type DeployMultipleCustomFormatsRequest,
} from "../../../lib/api-client/custom-formats";

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
