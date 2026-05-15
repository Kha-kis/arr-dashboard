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
	// qui-only fields — Prisma typings model them as `boolean | null` /
	// `string | null` because SQLite booleans can be null. We coerce to
	// the API-facing types in the formatter below.
	hasLocalFilesystemAccess: boolean | null;
	pathPrefix: string | null;
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
	// qui-only — always present in the response for consistency, but
	// only meaningful when `service === "qui"`. The UI hides these
	// fields for non-qui instances.
	hasLocalFilesystemAccess: boolean;
	pathPrefix: string | null;
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
		// Coerce nullable boolean → boolean. Prisma models the column as
		// `boolean | null` because SQLite has no strict-NOT-NULL on
		// booleans, but our API contract is "false when unset."
		hasLocalFilesystemAccess: instance.hasLocalFilesystemAccess === true,
		pathPrefix: instance.pathPrefix,
		tags: instance.tags.map(({ tag }) => ({ id: tag.id, name: tag.name })),
	};
}
