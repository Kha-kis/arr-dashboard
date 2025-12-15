import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import type { HuntExclusion, InstanceSummary } from "../lib/hunting-types";

interface UseHuntingExclusionsParams {
	mediaType?: string;
	instanceId?: string;
	page?: number;
	pageSize?: number;
}

interface HuntingExclusionsResponse {
	exclusions: HuntExclusion[];
	instances: InstanceSummary[];
	totalCount: number;
}

async function fetchHuntingExclusions(params: UseHuntingExclusionsParams): Promise<HuntingExclusionsResponse> {
	const searchParams = new URLSearchParams();
	if (params.mediaType) searchParams.set("mediaType", params.mediaType);
	if (params.instanceId) searchParams.set("instanceId", params.instanceId);
	if (params.page) searchParams.set("page", params.page.toString());
	if (params.pageSize) searchParams.set("pageSize", params.pageSize.toString());

	const queryString = searchParams.toString();
	return apiRequest<HuntingExclusionsResponse>(`/api/hunting/exclusions${queryString ? `?${queryString}` : ""}`);
}

async function removeExclusion(exclusionId: string): Promise<void> {
	return apiRequest<void>(`/api/hunting/exclusions/${exclusionId}`, {
		method: "DELETE",
	});
}

async function addExclusion(data: {
	instanceId: string;
	mediaType: string;
	mediaId: number;
	title: string;
	reason?: string;
}): Promise<HuntExclusion> {
	return apiRequest<HuntExclusion>("/api/hunting/exclusions", {
		method: "POST",
		body: JSON.stringify(data),
	});
}

export function useHuntingExclusions(params: UseHuntingExclusionsParams = {}) {
	const query = useQuery({
		queryKey: ["hunting", "exclusions", params],
		queryFn: () => fetchHuntingExclusions(params),
	});

	return {
		exclusions: query.data?.exclusions ?? [],
		instances: query.data?.instances ?? [],
		totalCount: query.data?.totalCount ?? 0,
		isLoading: query.isLoading,
		error: query.error,
		refetch: query.refetch,
	};
}

export function useRemoveExclusion() {
	const queryClient = useQueryClient();

	const mutation = useMutation({
		mutationFn: removeExclusion,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["hunting", "exclusions"] });
			void queryClient.invalidateQueries({ queryKey: ["hunting", "status"] });
		},
	});

	return {
		removeExclusion: mutation.mutateAsync,
		isRemoving: mutation.isPending,
		error: mutation.error,
	};
}

export function useAddExclusion() {
	const queryClient = useQueryClient();

	const mutation = useMutation({
		mutationFn: addExclusion,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["hunting", "exclusions"] });
			void queryClient.invalidateQueries({ queryKey: ["hunting", "status"] });
		},
	});

	return {
		addExclusion: mutation.mutateAsync,
		isAdding: mutation.isPending,
		error: mutation.error,
	};
}
