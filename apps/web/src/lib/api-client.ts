import type {
  CurrentUser,
  CurrentUserResponse,
  ServiceInstanceSummary,
  ServiceResponse,
  ServicesResponse,
  ServiceTagResponse,
  TagsResponse,
  CreateTagResponse,
} from "@arr/shared";
import { apiRequest, ApiError, UnauthorizedError } from "./api-client/base";

export { ApiError, UnauthorizedError };

export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  try {
    const data = await apiRequest<CurrentUserResponse>("/auth/me");
    return data.user;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return null;
    }
    throw error;
  }
}

export async function login(payload: { identifier: string; password: string }): Promise<CurrentUser> {
  const data = await apiRequest<CurrentUserResponse>("/auth/login", {
    method: "POST",
    json: payload,
  });
  return data.user;
}

export async function logout(): Promise<void> {
  await apiRequest<void>("/auth/logout", {
    method: "POST",
  });
}

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
  apiKey: string;
  service: "sonarr" | "radarr" | "prowlarr";
  enabled?: boolean;
  isDefault?: boolean;
  tags?: string[];
  defaultQualityProfileId?: number | null;
  defaultLanguageProfileId?: number | null;
  defaultRootFolderPath?: string | null;
  defaultSeasonFolder?: boolean | null;
};

export type UpdateServicePayload = Partial<CreateServicePayload>;

export async function createService(payload: CreateServicePayload): Promise<ServiceInstanceSummary> {
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

export async function fetchTags(): Promise<ServiceTagResponse[]> {
  try {
    const data = await apiRequest<TagsResponse>("/api/tags");
    return data.tags;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return [];
    }
    throw error;
  }
}

export async function createTag(name: string): Promise<ServiceTagResponse> {
  const data = await apiRequest<CreateTagResponse>("/api/tags", {
    method: "POST",
    json: { name },
  });
  return data.tag;
}

export async function deleteTag(id: string): Promise<void> {
  await apiRequest<void>(`/api/tags/${id}`, {
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
  service: "sonarr" | "radarr" | "prowlarr"
): Promise<TestConnectionResponse> {
  return await apiRequest<TestConnectionResponse>("/api/services/test-connection", {
    method: "POST",
    json: { baseUrl, apiKey, service },
  });
}




