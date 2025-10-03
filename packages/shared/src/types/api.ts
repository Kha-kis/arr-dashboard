import type { ArrServiceType } from "./arr.js";

export interface ServiceTagResponse {
  id: string;
  name: string;
}

export interface ServiceInstanceSummary {
  id: string;
  service: ArrServiceType;
  label: string;
  baseUrl: string;
  enabled: boolean;
  isDefault: boolean;
  hasApiKey: boolean;
  defaultQualityProfileId: number | null;
  defaultLanguageProfileId: number | null;
  defaultRootFolderPath: string | null;
  defaultSeasonFolder: boolean | null;
  createdAt: string;
  updatedAt: string;
  tags: ServiceTagResponse[];
}

export interface ServicesResponse {
  services: ServiceInstanceSummary[];
}

export interface ServiceResponse {
  service: ServiceInstanceSummary;
}

export interface TagsResponse {
  tags: ServiceTagResponse[];
}

export interface CreateTagResponse {
  tag: ServiceTagResponse;
}

export interface CurrentUser {
  id: string;
  email: string;
  username: string;
  role: "ADMIN" | "USER";
  mustChangePassword: boolean;
  createdAt: string;
}

export interface CurrentUserResponse {
  user: CurrentUser;
}

export interface ErrorResponse {
  error: string;
  details?: unknown;
}
export type ApiErrorPayload = unknown;
