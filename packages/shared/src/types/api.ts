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
  externalUrl: string | null;
  enabled: boolean;
  isDefault: boolean;
  hasApiKey: boolean;
  defaultQualityProfileId: number | null;
  defaultLanguageProfileId: number | null;
  defaultRootFolderPath: string | null;
  defaultSeasonFolder: boolean | null;
  storageGroupId: string | null;
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
  username: string;
  mustChangePassword: boolean;
  createdAt: string;
  hasTmdbApiKey?: boolean;
  hasPassword?: boolean;
}

export interface CurrentUserResponse {
  user: CurrentUser;
}

export interface ErrorResponse {
  error: string;
  details?: unknown;
}
export type ApiErrorPayload = unknown;
