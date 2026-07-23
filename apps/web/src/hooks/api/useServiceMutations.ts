"use client";

import type { ServiceInstanceSummary } from "@arr/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { libraryCleanupKeys, serviceKeys } from "../../lib/query-keys";
import {
	type CreateServicePayload,
	createService,
	removeService,
	type UpdateServicePayload,
	updateService,
} from "../../lib/api-client/services";

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
			queryClient.invalidateQueries({ queryKey: serviceKeys.all });
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.fieldOptions });
		},
	});
};

export const useUpdateServiceMutation = () => {
	const queryClient = useQueryClient();

	return useMutation<ServiceInstanceSummary, Error, UpdateVariables>({
		mutationFn: ({ id, payload }) => updateService(id, payload),
		onSuccess: (updated) => {
			queryClient.setQueryData<ServiceInstanceSummary[]>(serviceKeys.all, (prev) => {
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
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.fieldOptions });
		},
	});
};

export const useDeleteServiceMutation = () => {
	const queryClient = useQueryClient();

	return useMutation<void, Error, DeleteVariables>({
		mutationFn: removeService,
		onSuccess: (_, id) => {
			queryClient.setQueryData<ServiceInstanceSummary[]>(serviceKeys.all, (prev) => {
				if (!prev) {
					return prev;
				}
				return prev.filter((service) => service.id !== id);
			});
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.fieldOptions });
		},
	});
};

// Service Connection Testing
import {
	type TestConnectionResponse,
	testConnectionBeforeAdd,
	testServiceConnection,
} from "../../lib/api-client/services";

export const useTestServiceConnection = () => {
	return useMutation<
		TestConnectionResponse,
		Error,
		string | { id: string; httpAuth: { username: string; password: string } | null }
	>({
		mutationFn: (input) =>
			typeof input === "string"
				? testServiceConnection(input)
				: testServiceConnection(input.id, input.httpAuth),
	});
};

export const useTestConnectionBeforeAdd = () => {
	return useMutation<
		TestConnectionResponse,
		Error,
		{
			baseUrl: string;
			apiKey: string;
			service:
				| "sonarr"
				| "radarr"
				| "prowlarr"
				| "lidarr"
				| "readarr"
				| "seerr"
				| "plex"
				| "jellyfin"
				| "emby"
				| "qui"
				| "tracearr";
			httpAuth?: { username: string; password: string };
		}
	>({
		mutationFn: ({ baseUrl, apiKey, service, httpAuth }) =>
			testConnectionBeforeAdd(baseUrl, apiKey, service, httpAuth),
	});
};
