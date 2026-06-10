"use client";

import type { ServiceTagResponse } from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TAGS_QUERY_KEY } from "../../lib/query-keys";
import { createTag, deleteTag, fetchTags } from "../../lib/api-client/tags";


export const useTagsQuery = () =>
	useQuery<ServiceTagResponse[]>({
		queryKey: TAGS_QUERY_KEY,
		queryFn: fetchTags,
		staleTime: 5 * 60 * 1000,
	});

export const useCreateTagMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: createTag,
		onSuccess: (tag) => {
			queryClient.setQueryData<ServiceTagResponse[]>(TAGS_QUERY_KEY, (prev) => {
				if (!prev) {
					return [tag];
				}
				return [...prev, tag];
			});
		},
	});
};

export const useDeleteTagMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: deleteTag,
		onSuccess: (_, id) => {
			queryClient.setQueryData<ServiceTagResponse[]>(TAGS_QUERY_KEY, (prev) => {
				if (!prev) {
					return prev;
				}
				return prev.filter((tag) => tag.id !== id);
			});
		},
	});
};
