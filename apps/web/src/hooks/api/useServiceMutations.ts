"use client";

import type { ServiceInstanceSummary } from "@arr/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	type CreateServicePayload,
	createService,
	removeService,
	type UpdateServicePayload,
	updateService,
	replaceServiceIdentity,
	verifyServiceIdentity,
	type ServiceIdentityConfirmation,
} from "../../lib/api-client/services";
import {
	jellyfinKeys,
	libraryCleanupKeys,
	plexKeys,
	serviceKeys,
	trashCacheKeys,
} from "../../lib/query-keys";

const SERVICES_QUERY_KEY = serviceKeys.all;
const FIELD_OPTIONS_KEY = libraryCleanupKeys.fieldOptions;

type UpdateVariables = {
	id: string;
	payload: UpdateServicePayload;
};

type CreateVariables = CreateServicePayload;

type DeleteVariables = string;
type IdentityVariables = ServiceIdentityConfirmation & { id: string };
type ReplaceIdentityVariables = IdentityVariables & { payload: UpdateServicePayload };

function applyServiceSummary(
	queryClient: ReturnType<typeof useQueryClient>,
	updated: ServiceInstanceSummary,
) {
	queryClient.invalidateQueries({ queryKey: SERVICES_QUERY_KEY });
	queryClient.invalidateQueries({ queryKey: trashCacheKeys.cacheHealth });
	queryClient.invalidateQueries({ queryKey: plexKeys.cacheHealth() });
	queryClient.invalidateQueries({ queryKey: jellyfinKeys.cacheHealth() });
	queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.status });
	queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.approvals });
	queryClient.setQueryData<ServiceInstanceSummary[]>(SERVICES_QUERY_KEY, (previous) =>
		previous?.map((service) => (service.id === updated.id ? updated : service)),
	);
}

export const useCreateServiceMutation = () => {
	const queryClient = useQueryClient();

	return useMutation<ServiceInstanceSummary, Error, CreateVariables>({
		mutationFn: createService,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: SERVICES_QUERY_KEY });
			queryClient.invalidateQueries({ queryKey: FIELD_OPTIONS_KEY });
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
			queryClient.invalidateQueries({ queryKey: FIELD_OPTIONS_KEY });
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
			queryClient.invalidateQueries({ queryKey: FIELD_OPTIONS_KEY });
		},
	});
};

export const useVerifyServiceIdentityMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<ServiceInstanceSummary, Error, IdentityVariables>({
		mutationFn: ({ id, ...confirmation }) => verifyServiceIdentity(id, confirmation),
		onSuccess: (updated) => applyServiceSummary(queryClient, updated),
	});
};

export const useReplaceServiceIdentityMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<ServiceInstanceSummary, Error, ReplaceIdentityVariables>({
		mutationFn: ({ id, payload, ...confirmation }) =>
			replaceServiceIdentity(id, payload, confirmation),
		onSuccess: (updated) => applyServiceSummary(queryClient, updated),
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
				| "tautulli"
				| "plex"
				| "jellyfin"
				| "emby"
				| "qui";
			httpAuth?: { username: string; password: string };
		}
	>({
		mutationFn: ({ baseUrl, apiKey, service, httpAuth }) =>
			testConnectionBeforeAdd(baseUrl, apiKey, service, httpAuth),
	});
};
