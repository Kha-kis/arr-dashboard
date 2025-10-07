"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ServiceInstanceSummary } from "@arr/shared";
import {
	createService,
	updateService,
	removeService,
	type CreateServicePayload,
	type UpdateServicePayload,
} from "../../lib/api-client/services";

const SERVICES_QUERY_KEY = ["services"] as const;

type UpdateVariables = {
	id: string;
	payload: UpdateServicePayload;
};

type CreateVariables = CreateServicePayload;

type DeleteVariables = string;

export const useCreateServiceMutation = () => {
	const queryClient = useQueryClient();

	return useMutation<ServiceInstanceSummary, Error, CreateVariables>({
		mutationFn: createService,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: SERVICES_QUERY_KEY });
		},
	});
};

export const useUpdateServiceMutation = () => {
	const queryClient = useQueryClient();

	return useMutation<ServiceInstanceSummary, Error, UpdateVariables>({
		mutationFn: ({ id, payload }) => updateService(id, payload),
		onSuccess: (updated) => {
			queryClient.setQueryData<ServiceInstanceSummary[]>(SERVICES_QUERY_KEY, (prev) => {
				if (!prev) {
					return prev;
				}
				return prev.map((service) => {
					if (service.id === updated.id) {
						return updated;
					}
					if (updated.isDefault && service.service === updated.service) {
						return { ...service, isDefault: false };
					}
					return service;
				});
			});
		},
	});
};

export const useDeleteServiceMutation = () => {
	const queryClient = useQueryClient();

	return useMutation<void, Error, DeleteVariables>({
		mutationFn: removeService,
		onSuccess: (_, id) => {
			queryClient.setQueryData<ServiceInstanceSummary[]>(SERVICES_QUERY_KEY, (prev) => {
				if (!prev) {
					return prev;
				}
				return prev.filter((service) => service.id !== id);
			});
		},
	});
};
