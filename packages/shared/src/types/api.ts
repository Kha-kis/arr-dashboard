import type { ArrServiceType } from "./arr";

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
	storageGroupId: string | null;
	// qui-only — only meaningful when `service === "qui"`. Always present
	// in the API response shape so the frontend doesn't have to special-
	// case missing-field handling per service type. Defaults to `false` /
	// `null` for non-qui instances.
	hasLocalFilesystemAccess: boolean;
	pathPrefix: string | null;
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
