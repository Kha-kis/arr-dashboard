/**
 * Service instance formatting utilities
 */

import { createHash } from "node:crypto";

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
	encryptedHttpAuthCredentials: string | null;
	httpAuthEncryptionIv: string | null;
	storageGroupId: string | null;
	// qui-only fields — Prisma typings model them as `boolean | null` /
	// `string | null` because SQLite booleans can be null. We coerce to
	// the API-facing types in the formatter below.
	hasLocalFilesystemAccess: boolean | null;
	pathPrefix: string | null;
	expectedIdentity?: string | null;
	identityKind?:
		| "PLEX_MACHINE_IDENTIFIER"
		| "JELLYFIN_SERVER_ID"
		| "EMBY_SERVER_ID"
		| "TAUTULLI_PMS_IDENTIFIER"
		| null;
	identityStatus?: "UNVERIFIED" | "VERIFIED" | "MISMATCH";
	identityVerifiedAt?: Date | null;
	identityLastCheckedAt?: Date | null;
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
	hasHttpAuth: boolean;
	storageGroupId: string | null;
	// qui-only — always present in the response for consistency, but
	// only meaningful when `service === "qui"`. The UI hides these
	// fields for non-qui instances.
	hasLocalFilesystemAccess: boolean;
	pathPrefix: string | null;
	identity: {
		status: "unverified" | "verified" | "mismatch";
		kind: string | null;
		fingerprint: string | null;
		verifiedAt: Date | null;
		lastCheckedAt: Date | null;
	};
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
		hasHttpAuth: Boolean(instance.encryptedHttpAuthCredentials && instance.httpAuthEncryptionIv),
		storageGroupId: instance.storageGroupId,
		// Coerce nullable boolean → boolean. Prisma models the column as
		// `boolean | null` because SQLite has no strict-NOT-NULL on
		// booleans, but our API contract is "false when unset."
		hasLocalFilesystemAccess: instance.hasLocalFilesystemAccess === true,
		pathPrefix: instance.pathPrefix,
		identity: formatIdentity(instance),
		tags: instance.tags.map(({ tag }) => ({ id: tag.id, name: tag.name })),
	};
}

function formatIdentity(instance: ServiceInstanceWithTags): FormattedServiceInstance["identity"] {
	const kind = instance.identityKind?.toLowerCase().replaceAll("_", "-") ?? null;
	const fingerprint =
		instance.expectedIdentity && kind
			? createHash("sha256")
					.update(`display:${instance.service}:${kind}:${instance.expectedIdentity.trim()}`)
					.digest("hex")
					.slice(0, 12)
			: null;
	return {
		status: (instance.identityStatus?.toLowerCase() ??
			"unverified") as FormattedServiceInstance["identity"]["status"],
		kind,
		fingerprint,
		verifiedAt: instance.identityVerifiedAt ?? null,
		lastCheckedAt: instance.identityLastCheckedAt ?? null,
	};
}
