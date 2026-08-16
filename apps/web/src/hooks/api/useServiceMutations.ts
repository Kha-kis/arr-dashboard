"use client";

import type { AnalyticsProvider, ArrServiceType, ServiceInstanceSummary } from "@arr/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	type CreateServicePayload,
	createService,
	removeService,
	replaceServiceIdentity,
	type ServiceIdentityConfirmation,
	type ServiceIdentityReplacementConfirmation,
	type UpdateServicePayload,
	updateService,
	verifyServiceIdentity,
} from "../../lib/api-client/services";
import {
	jellyfinKeys,
	libraryCleanupKeys,
	plexKeys,
	serviceKeys,
	systemKeys,
	tautulliKeys,
	tracearrKeys,
	trashCacheKeys,
} from "../../lib/query-keys";

const SERVICES_QUERY_KEY = serviceKeys.all;
type UpdateVariables = {
	id: string;
	payload: UpdateServicePayload;
};

type CreateVariables = CreateServicePayload;

type DeleteVariables = string | { id: string; confirmAnalyticsUnavailableFor?: AnalyticsProvider };
type IdentityVariables = ServiceIdentityConfirmation & { id: string };
type ReplaceIdentityVariables = ServiceIdentityReplacementConfirmation & {
	id: string;
	payload: UpdateServicePayload;
};

function invalidateServiceDependencies(queryClient: ReturnType<typeof useQueryClient>) {
	queryClient.invalidateQueries({ queryKey: SERVICES_QUERY_KEY });
	queryClient.invalidateQueries({ queryKey: trashCacheKeys.cacheHealth });
	queryClient.invalidateQueries({ queryKey: plexKeys.cacheHealth() });
	queryClient.invalidateQueries({ queryKey: jellyfinKeys.cacheHealth() });
	queryClient.invalidateQueries({ queryKey: plexKeys.all });
	queryClient.invalidateQueries({ queryKey: jellyfinKeys.all });
	queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.status });
	queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.approvalsAll });
}

function applyServiceSummary(
	queryClient: ReturnType<typeof useQueryClient>,
	updated: ServiceInstanceSummary,
) {
	invalidateServiceDependencies(queryClient);
	queryClient.setQueryData<ServiceInstanceSummary[]>(SERVICES_QUERY_KEY, (previous) =>
		previous?.map((service) => (service.id === updated.id ? updated : service)),
	);
}

export const useCreateServiceMutation = () => {
	const queryClient = useQueryClient();

	return useMutation<ServiceInstanceSummary, Error, CreateVariables>({
		mutationFn: createService,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: serviceKeys.all });
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.fieldOptions });
			queryClient.invalidateQueries({ queryKey: systemKeys.analyticsProvider });
			queryClient.invalidateQueries({ queryKey: tracearrKeys.all });
			queryClient.invalidateQueries({ queryKey: tautulliKeys.all });
			queryClient.invalidateQueries({ queryKey: systemKeys.tautulliProviderNotices });
		},
	});
};

export const useUpdateServiceMutation = () => {
	const queryClient = useQueryClient();

	return useMutation<ServiceInstanceSummary, Error, UpdateVariables>({
		mutationFn: ({ id, payload }) => updateService(id, payload),
		onSuccess: (updated) => {
			invalidateServiceDependencies(queryClient);
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
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.fieldOptions });
			queryClient.invalidateQueries({ queryKey: systemKeys.analyticsProvider });
			queryClient.invalidateQueries({ queryKey: tracearrKeys.all });
			queryClient.invalidateQueries({ queryKey: tautulliKeys.all });
			queryClient.invalidateQueries({ queryKey: systemKeys.tautulliProviderNotices });
		},
	});
};

export const useDeleteServiceMutation = () => {
	const queryClient = useQueryClient();

	return useMutation<void, Error, DeleteVariables>({
		mutationFn: (input) =>
			typeof input === "string"
				? removeService(input)
				: removeService(input.id, input.confirmAnalyticsUnavailableFor),
		onSuccess: (_, input) => {
			const id = typeof input === "string" ? input : input.id;
			invalidateServiceDependencies(queryClient);
			queryClient.setQueryData<ServiceInstanceSummary[]>(SERVICES_QUERY_KEY, (prev) => {
				if (!prev) {
					return prev;
				}
				return prev.filter((service) => service.id !== id);
			});
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.fieldOptions });
			queryClient.invalidateQueries({ queryKey: systemKeys.analyticsProvider });
			queryClient.invalidateQueries({ queryKey: tracearrKeys.all });
			queryClient.invalidateQueries({ queryKey: tautulliKeys.all });
			queryClient.invalidateQueries({ queryKey: systemKeys.tautulliProviderNotices });
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
		onSuccess: (updated) => {
			applyServiceSummary(queryClient, updated);
			queryClient.invalidateQueries({ queryKey: libraryCleanupKeys.fieldOptions });
			queryClient.invalidateQueries({ queryKey: systemKeys.analyticsProvider });
			queryClient.invalidateQueries({ queryKey: tracearrKeys.all });
			queryClient.invalidateQueries({ queryKey: tautulliKeys.all });
			queryClient.invalidateQueries({ queryKey: systemKeys.tautulliProviderNotices });
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
			service: ArrServiceType;
			httpAuth?: { username: string; password: string };
		}
	>({
		mutationFn: ({ baseUrl, apiKey, service, httpAuth }) =>
			testConnectionBeforeAdd(baseUrl, apiKey, service, httpAuth),
	});
};
