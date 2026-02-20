/**
 * Service instance formatting utilities
 */

interface ServiceInstanceWithTags {
	id: string;
	service: string;
	label: string;
	baseUrl: string;
	externalUrl: string | null;
	enabled: boolean;
	isDefault: boolean;
	createdAt: Date;
	updatedAt: Date;
	encryptedApiKey: string;
	storageGroupId: string | null;
	tags: Array<{
		tag: {
			id: string;
			name: string;
		};
	}>;
}

export interface FormattedServiceInstance {
	id: string;
	service: string;
	label: string;
	baseUrl: string;
	externalUrl: string | null;
	enabled: boolean;
	isDefault: boolean;
	createdAt: Date;
	updatedAt: Date;
	hasApiKey: boolean;
	storageGroupId: string | null;
	tags: Array<{ id: string; name: string }>;
}

/**
 * Formats a service instance for API response
 */
export function formatServiceInstance(instance: ServiceInstanceWithTags): FormattedServiceInstance {
	return {
		id: instance.id,
		service: instance.service.toLowerCase(),
		label: instance.label,
		baseUrl: instance.baseUrl,
		externalUrl: instance.externalUrl,
		enabled: instance.enabled,
		isDefault: instance.isDefault,
		createdAt: instance.createdAt,
		updatedAt: instance.updatedAt,
		hasApiKey: Boolean(instance.encryptedApiKey),
		storageGroupId: instance.storageGroupId,
		tags: instance.tags.map(({ tag }) => ({ id: tag.id, name: tag.name })),
	};
}
