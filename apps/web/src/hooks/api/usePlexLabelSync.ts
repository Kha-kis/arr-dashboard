/**
 * Plex Label Sync React Query Hooks
 *
 * CRUD wrappers for the rules-management surface introduced by
 * the Plex Labels feature arc (issue #384).
 */

import type {
	CreatePlexLabelSyncRuleRequest,
	PlexLabelSyncRule,
	UpdatePlexLabelSyncRuleRequest,
} from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createPlexLabelSyncRule,
	deletePlexLabelSyncRule,
	fetchPlexLabelSyncRules,
	runPlexLabelSyncRule,
	updatePlexLabelSyncRule,
} from "../../lib/api-client/plex-label-sync";
import { plexLabelSyncKeys } from "../../lib/query-keys";

export const usePlexLabelSyncRules = () => {
	return useQuery<PlexLabelSyncRule[]>({
		queryKey: plexLabelSyncKeys.rules,
		queryFn: fetchPlexLabelSyncRules,
		staleTime: 30_000,
	});
};

export const useCreatePlexLabelSyncRule = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: CreatePlexLabelSyncRuleRequest) => createPlexLabelSyncRule(payload),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: plexLabelSyncKeys.rules });
		},
	});
};

export const useUpdatePlexLabelSyncRule = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, payload }: { id: string; payload: UpdatePlexLabelSyncRuleRequest }) =>
			updatePlexLabelSyncRule(id, payload),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: plexLabelSyncKeys.rules });
		},
	});
};

export const useDeletePlexLabelSyncRule = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => deletePlexLabelSyncRule(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: plexLabelSyncKeys.rules });
		},
	});
};

export const useRunPlexLabelSyncRule = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => runPlexLabelSyncRule(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: plexLabelSyncKeys.rules });
		},
	});
};
