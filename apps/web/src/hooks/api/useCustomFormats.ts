/**
 * Custom Formats React Query Hooks
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CustomFormat } from "@arr/shared";
import * as customFormatsApi from "../../lib/api-client/custom-formats";

/**
 * Query key factory for custom formats
 */
export const customFormatsKeys = {
	all: ["custom-formats"] as const,
	lists: () => [...customFormatsKeys.all, "list"] as const,
	list: (instanceId?: string) =>
		[...customFormatsKeys.lists(), { instanceId }] as const,
	details: () => [...customFormatsKeys.all, "detail"] as const,
	detail: (instanceId: string, customFormatId: number) =>
		[...customFormatsKeys.details(), instanceId, customFormatId] as const,
	schema: (instanceId: string) =>
		[...customFormatsKeys.all, "schema", instanceId] as const,
};

/**
 * Hook to get all custom formats (optionally filtered by instance)
 */
export function useCustomFormats(instanceId?: string) {
	return useQuery({
		queryKey: customFormatsKeys.list(instanceId),
		queryFn: () => customFormatsApi.getCustomFormats(instanceId),
		staleTime: 5 * 60 * 1000, // 5 minutes
		gcTime: 10 * 60 * 1000, // 10 minutes
	});
}

/**
 * Hook to get a single custom format
 */
export function useCustomFormat(instanceId: string, customFormatId: number) {
	return useQuery({
		queryKey: customFormatsKeys.detail(instanceId, customFormatId),
		queryFn: () =>
			customFormatsApi.getCustomFormat(instanceId, customFormatId),
		enabled: !!instanceId && !!customFormatId,
		staleTime: 5 * 60 * 1000, // 5 minutes
		gcTime: 10 * 60 * 1000, // 10 minutes
	});
}

/**
 * Hook to create a custom format
 */
export function useCreateCustomFormat() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			instanceId,
			customFormat,
		}: {
			instanceId: string;
			customFormat: Omit<CustomFormat, "id">;
		}) => customFormatsApi.createCustomFormat(instanceId, customFormat),
		onSuccess: () => {
			// Invalidate all custom formats queries
			queryClient.invalidateQueries({ queryKey: customFormatsKeys.lists() });
		},
	});
}

/**
 * Hook to update a custom format
 */
export function useUpdateCustomFormat() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			instanceId,
			customFormatId,
			customFormat,
		}: {
			instanceId: string;
			customFormatId: number;
			customFormat: Partial<Omit<CustomFormat, "id">>;
		}) =>
			customFormatsApi.updateCustomFormat(
				instanceId,
				customFormatId,
				customFormat,
			),
		onSuccess: (_, variables) => {
			// Invalidate the specific custom format and all lists
			queryClient.invalidateQueries({
				queryKey: customFormatsKeys.detail(
					variables.instanceId,
					variables.customFormatId,
				),
			});
			queryClient.invalidateQueries({ queryKey: customFormatsKeys.lists() });
		},
	});
}

/**
 * Hook to delete a custom format
 */
export function useDeleteCustomFormat() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			instanceId,
			customFormatId,
		}: {
			instanceId: string;
			customFormatId: number;
		}) => customFormatsApi.deleteCustomFormat(instanceId, customFormatId),
		onMutate: async ({ instanceId, customFormatId }) => {
			// Cancel outgoing refetches
			await queryClient.cancelQueries({ queryKey: customFormatsKeys.lists() });

			// Snapshot previous value
			const previousFormats = queryClient.getQueryData(customFormatsKeys.lists());

			// Optimistically update to remove the deleted format
			queryClient.setQueriesData({ queryKey: customFormatsKeys.lists() }, (old: any) => {
				if (!old?.instances) return old;

				return {
					...old,
					instances: old.instances.map((instance: any) => {
						if (instance.instanceId !== instanceId) return instance;

						return {
							...instance,
							customFormats: (instance.customFormats || []).filter(
								(cf: any) => cf.id !== customFormatId
							),
						};
					}),
				};
			});

			return { previousFormats };
		},
		onError: (err, variables, context) => {
			// Rollback on error
			if (context?.previousFormats) {
				queryClient.setQueryData(customFormatsKeys.lists(), context.previousFormats);
			}
		},
		onSettled: () => {
			// Refetch to ensure consistency
			queryClient.invalidateQueries({ queryKey: customFormatsKeys.lists() });
		},
	});
}

/**
 * Hook to copy a custom format between instances
 */
export function useCopyCustomFormat() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: customFormatsApi.copyCustomFormat,
		onSuccess: () => {
			// Invalidate all custom formats queries
			queryClient.invalidateQueries({ queryKey: customFormatsKeys.lists() });
		},
	});
}

/**
 * Hook to export a custom format
 * Note: This doesn't use React Query mutation since export is a read operation
 */
export function useExportCustomFormat() {
	return {
		exportCustomFormat: async (instanceId: string, customFormatId: number) => {
			const data = await customFormatsApi.exportCustomFormat(
				instanceId,
				customFormatId,
			);
			// Create a download link
			const blob = new Blob([JSON.stringify(data, null, 2)], {
				type: "application/json",
			});
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${data.name?.replace(/[^a-z0-9]/gi, "_").toLowerCase() || "custom-format"}.json`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		},
	};
}

/**
 * Hook to import a custom format
 */
export function useImportCustomFormat() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: customFormatsApi.importCustomFormat,
		onSuccess: () => {
			// Invalidate all custom formats queries
			queryClient.invalidateQueries({ queryKey: customFormatsKeys.lists() });
		},
	});
}

/**
 * Hook to get custom format schema (field definitions)
 */
export function useCustomFormatSchema(instanceId: string | undefined) {
	return useQuery({
		queryKey: customFormatsKeys.schema(instanceId || ""),
		queryFn: () => customFormatsApi.getCustomFormatSchema(instanceId!),
		enabled: !!instanceId,
		staleTime: 30 * 60 * 1000, // 30 minutes (schema rarely changes)
		gcTime: 60 * 60 * 1000, // 1 hour
	});
}
