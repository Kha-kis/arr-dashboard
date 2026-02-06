import type { ServiceInstanceSummary, ServiceResponse, ServicesResponse } from "@arr/shared";
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
	service: "sonarr" | "radarr" | "prowlarr" | "lidarr" | "readarr";
	enabled?: boolean;
	isDefault?: boolean;
	tags?: string[];
	defaultQualityProfileId?: number | null;
	defaultLanguageProfileId?: number | null;
	defaultRootFolderPath?: string | null;
	defaultSeasonFolder?: boolean | null;
	storageGroupId?: string | null;
};

export type UpdateServicePayload = Partial<CreateServicePayload>;

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

export async function removeService(id: string): Promise<void> {
	await apiRequest<void>(`/api/services/${id}`, {
		method: "DELETE",
	});
}

export type TestConnectionResponse = {
	success: boolean;
	message?: string;
	version?: string;
	error?: string;
	details?: string;
};

export async function testServiceConnection(id: string): Promise<TestConnectionResponse> {
	return await apiRequest<TestConnectionResponse>(`/api/services/${id}/test`, {
		method: "POST",
	});
}

export async function testConnectionBeforeAdd(
	baseUrl: string,
	apiKey: string,
	service: "sonarr" | "radarr" | "prowlarr" | "lidarr" | "readarr",
): Promise<TestConnectionResponse> {
	return await apiRequest<TestConnectionResponse>("/api/services/test-connection", {
		method: "POST",
		json: { baseUrl, apiKey, service },
	});
}
