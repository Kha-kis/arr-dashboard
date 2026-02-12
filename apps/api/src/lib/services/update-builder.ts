import type { ServiceType } from "../../lib/prisma.js";

/**
 * Service instance update data builder
 */

export interface UpdatePayload {
	label?: string;
	baseUrl?: string;
	externalUrl?: string | null;
	enabled?: boolean;
	isDefault?: boolean;
	service?: string;
	apiKey?: string;
	defaultQualityProfileId?: number | null;
	defaultLanguageProfileId?: number | null;
	defaultRootFolderPath?: string | null;
	defaultSeasonFolder?: boolean | null;
	storageGroupId?: string | null;
}

export interface EncryptedData {
	value: string;
	iv: string;
}

export interface UpdateData {
	label?: string;
	baseUrl?: string;
	externalUrl?: string | null;
	enabled?: boolean;
	isDefault?: boolean;
	service?: ServiceType;
	encryptedApiKey?: string;
	encryptionIv?: string;
	defaultQualityProfileId?: number | null;
	defaultLanguageProfileId?: number | null;
	defaultRootFolderPath?: string | null;
	defaultSeasonFolder?: boolean | null;
	storageGroupId?: string | null;
}

/**
 * Builds update data object from payload
 */
export function buildUpdateData(
	payload: UpdatePayload,
	encryptor?: { encrypt: (value: string) => EncryptedData },
): UpdateData {
	const updateData: UpdateData = {};

	if (payload.label) {
		updateData.label = payload.label;
	}
	if (payload.baseUrl) {
		updateData.baseUrl = payload.baseUrl;
	}
	if (typeof payload.enabled === "boolean") {
		updateData.enabled = payload.enabled;
	}
	if (typeof payload.isDefault === "boolean") {
		updateData.isDefault = payload.isDefault;
	}
	if (payload.service) {
		updateData.service = payload.service.toUpperCase() as ServiceType;
	}
	if (payload.apiKey && encryptor) {
		const encrypted = encryptor.encrypt(payload.apiKey);
		updateData.encryptedApiKey = encrypted.value;
		updateData.encryptionIv = encrypted.iv;
	}

	// Handle nullable fields explicitly
	if (Object.hasOwn(payload, "externalUrl")) {
		updateData.externalUrl = payload.externalUrl ?? null;
	}
	if (Object.hasOwn(payload, "defaultQualityProfileId")) {
		updateData.defaultQualityProfileId = payload.defaultQualityProfileId ?? null;
	}
	if (Object.hasOwn(payload, "defaultLanguageProfileId")) {
		updateData.defaultLanguageProfileId = payload.defaultLanguageProfileId ?? null;
	}
	if (Object.hasOwn(payload, "defaultRootFolderPath")) {
		updateData.defaultRootFolderPath = payload.defaultRootFolderPath ?? null;
	}
	if (Object.hasOwn(payload, "defaultSeasonFolder")) {
		updateData.defaultSeasonFolder = payload.defaultSeasonFolder ?? null;
	}
	if (Object.hasOwn(payload, "storageGroupId")) {
		updateData.storageGroupId = payload.storageGroupId ?? null;
	}

	return updateData;
}
