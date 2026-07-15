"use client";

import type { ApplySetupStartersRequest, SetupStarterPreviewResponse } from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { applySetupStarters, fetchSetupStarters } from "../../lib/api-client/setup";
import { autoTagKeys, labelSyncKeys, notificationKeys, setupKeys } from "../../lib/query-keys";

export const useSetupStarters = () =>
	useQuery<SetupStarterPreviewResponse, Error>({
		queryKey: setupKeys.starters,
		queryFn: fetchSetupStarters,
		refetchOnWindowFocus: false,
		retry: false,
	});

export const useApplySetupStarters = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: ApplySetupStartersRequest) => applySetupStarters(payload),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: setupKeys.starters });
			queryClient.invalidateQueries({ queryKey: notificationKeys.rules });
			queryClient.invalidateQueries({ queryKey: autoTagKeys.all });
			queryClient.invalidateQueries({ queryKey: labelSyncKeys.all });
		},
	});
};
