import type {
	AnalyticsProvider,
	ArrServiceType,
	ServiceInstanceSummary,
	ServiceResponse,
	ServicesResponse,
} from "@arr/shared";
import { apiRequest, UnauthorizedError } from "./base";

export async function fetchServices(): Promise<ServiceInstanceSummary[]> {
	try {
		const data = await apiRequest<ServicesResponse>("/api/services");
		return data.services;
	} catch (error) {
		if (error instanceof UnauthorizedError) {
			return [];
		}
		throw error;
	}
}

export type CreateServicePayload = {
	label: string;
	baseUrl: string;
	externalUrl?: string | null;
	apiKey: string;
	httpAuth?: { username: string; password: string } | null;
	service: ArrServiceType;
	enabled?: boolean;
	isDefault?: boolean;
	tags?: string[];
	storageGroupId?: string | null;
};

export type UpdateServicePayload = Partial<CreateServicePayload> & {
	confirmAnalyticsUnavailableFor?: AnalyticsProvider;
};

export type ServiceIdentityCandidate = {
	service: "PLEX" | "JELLYFIN" | "EMBY" | "TAUTULLI";
	identityKind: string;
	fingerprint: string;
	displayName?: string;
	confirmationDigest: string;
};

export type ServiceIdentityInspection = {
	candidate: ServiceIdentityCandidate;
	connectionGeneration: number;
	identityGeneration: number;
};

export type ServiceIdentityConfirmation = {
	confirmationDigest: string;
	expectedConnectionGeneration: number;
	expectedIdentityGeneration: number;
};

export async function createService(
	payload: CreateServicePayload,
): Promise<ServiceInstanceSummary> {
	const data = await apiRequest<ServiceResponse>("/api/services", {
		method: "POST",
		json: payload,
	});
	return data.service;
}

export async function updateService(
	id: string,
	payload: UpdateServicePayload,
): Promise<ServiceInstanceSummary> {
	const data = await apiRequest<ServiceResponse>(`/api/services/${id}`, {
		method: "PUT",
		json: payload,
	});
	return data.service;
}

export async function removeService(
	id: string,
	confirmAnalyticsUnavailableFor?: AnalyticsProvider,
): Promise<void> {
	const query =
		confirmAnalyticsUnavailableFor === undefined
			? ""
			: `?${new URLSearchParams({ confirmAnalyticsUnavailableFor })}`;
	await apiRequest<void>(`/api/services/${id}${query}`, {
		method: "DELETE",
	});
}

export async function inspectServiceIdentity(
	id: string,
	candidate?: UpdateServicePayload,
): Promise<ServiceIdentityInspection> {
	return await apiRequest<ServiceIdentityInspection>(`/api/services/${id}/identity/inspect`, {
		method: "POST",
		json: candidate ? { candidate } : {},
	});
}

export async function verifyServiceIdentity(
	id: string,
	confirmation: ServiceIdentityConfirmation,
): Promise<ServiceInstanceSummary> {
	const data = await apiRequest<ServiceResponse>(`/api/services/${id}/identity/verify`, {
		method: "POST",
		json: confirmation,
	});
	return data.service;
}

export async function replaceServiceIdentity(
	id: string,
	candidate: UpdateServicePayload,
	confirmation: ServiceIdentityConfirmation,
): Promise<ServiceInstanceSummary> {
	const data = await apiRequest<ServiceResponse>(`/api/services/${id}/identity/replace`, {
		method: "POST",
		json: { candidate, ...confirmation },
	});
	return data.service;
}

export type TestConnectionResponse = {
	success: boolean;
	message?: string;
	version?: string;
	error?: string;
	details?: string;
};

export async function testServiceConnection(
	id: string,
	httpAuth?: { username: string; password: string } | null,
): Promise<TestConnectionResponse> {
	return await apiRequest<TestConnectionResponse>(`/api/services/${id}/test`, {
		method: "POST",
		...(httpAuth === undefined ? {} : { json: { httpAuth } }),
	});
}

export async function testConnectionBeforeAdd(
	baseUrl: string,
	apiKey: string,
	service: ArrServiceType,
	httpAuth?: { username: string; password: string },
): Promise<TestConnectionResponse> {
	return await apiRequest<TestConnectionResponse>("/api/services/test-connection", {
		method: "POST",
		json: { baseUrl, apiKey, service, httpAuth },
	});
}
