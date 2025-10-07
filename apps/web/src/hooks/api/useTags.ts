"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ServiceTagResponse } from "@arr/shared";
import { fetchTags, createTag, deleteTag } from "../../lib/api-client/tags";

const TAGS_QUERY_KEY = ["service-tags"] as const;

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
