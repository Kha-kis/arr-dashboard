import { createHash } from "node:crypto";
import { ConflictError } from "../errors.js";

export interface DeploymentQualityProfile {
	id?: number;
	name?: string | null;
}

export interface DeploymentProfileMapping {
	templateId?: string;
	qualityProfileId: number;
	qualityProfileName: string;
	connectionGeneration: number;
	connectionStateToken: string | null;
}

interface DeploymentMappingAuthorityInput {
	id?: string;
	instanceId?: string;
	qualityProfileId: number;
	qualityProfileName: string;
	syncStrategy?: string | null;
	managedCustomFormatsCaptured?: boolean | null;
	managedCustomFormats?: string | null;
	updatedAt?: Date | string | null;
}

export interface DeploymentServiceInstance {
	id: string;
	service: string;
	baseUrl: string;
	credentialIdentity: string;
}

export interface DeploymentConnectionBinding {
	instanceId: string;
	connectionGeneration: number;
	connectionStateToken: string | null;
	credentialIdentity?: string;
}

export type DeploymentConnectionPersistenceBinding = Pick<
	DeploymentConnectionBinding,
	"instanceId" | "connectionGeneration" | "connectionStateToken"
>;

export interface AutomationCatchUpTemplateState {
	configData: string;
	instanceOverrides: string | null;
	trashGuidesCommitHash: string | null;
	lastSyncedAt: Date | null;
	hasUserModifications: boolean;
}

export function createAutomationCatchUpTemplateStateToken(
	template: AutomationCatchUpTemplateState,
): string {
	return createUpstreamResourceStateToken({
		configData: template.configData,
		instanceOverrides: template.instanceOverrides,
		trashGuidesCommitHash: template.trashGuidesCommitHash,
		lastSyncedAt: template.lastSyncedAt?.toISOString() ?? null,
		hasUserModifications: template.hasUserModifications,
	});
}

interface DeploymentConnectionMapping {
	connectionGeneration?: number | null;
	connectionStateToken?: string | null;
}

interface DeploymentConnectionInstance {
	id: string;
	service: string;
	baseUrl: string;
	encryptedApiKey: string;
	encryptionIv: string;
	encryptedHttpAuthCredentials?: string | null;
	httpAuthEncryptionIv?: string | null;
	connectionGeneration?: number | null;
}

export interface ResolvedDeploymentTarget<TProfile extends DeploymentQualityProfile> {
	profile: TProfile | undefined;
	profileName: string;
	matchedBy: "mapping_id" | "mapping_name" | "source_id" | "source_name" | "template_name" | "new";
}

function findUniqueProfileByName<TProfile extends DeploymentQualityProfile>(
	profiles: TProfile[],
	name: string,
): TProfile | undefined {
	const matches = profiles.filter((profile) => profile.name === name);
	if (matches.length > 1) {
		throw new ConflictError(
			`Multiple quality profiles named "${name}" exist in the instance. Rename or remove the duplicate before deploying.`,
		);
	}
	return matches[0];
}

/**
 * Resolve the one quality profile a deployment is authorized to mutate.
 *
 * A stored mapping is authoritative. For a first deployment, cloned templates
 * retain the source profile identity even when the template itself was renamed.
 * Every name fallback must be unique so preview and execution fail closed on
 * ambiguous upstream state.
 */
export function resolveDeploymentTarget<TProfile extends DeploymentQualityProfile>(args: {
	profiles: TProfile[];
	mapping?: DeploymentProfileMapping | null;
	sourceProfileId?: number | null;
	isSourceInstance?: boolean;
	sourceProfileName?: string | null;
	templateName?: string | null;
}): ResolvedDeploymentTarget<TProfile> {
	const { profiles, mapping, sourceProfileId, isSourceInstance, sourceProfileName, templateName } =
		args;

	if (mapping) {
		const mappedProfile = profiles.find((profile) => profile.id === mapping.qualityProfileId);
		const isLegacyMapping = isLegacyDeploymentConnectionMapping(mapping);
		if (isLegacyMapping) {
			const namedProfile = findUniqueProfileByName(profiles, mapping.qualityProfileName);
			if (!namedProfile) {
				throw new ConflictError(
					`The legacy quality profile mapping for "${mapping.qualityProfileName}" cannot be verified because that name no longer exists. Unlink the legacy deployment and review a fresh preview.`,
				);
			}
			if (mappedProfile && mappedProfile !== namedProfile) {
				throw new ConflictError(
					`The legacy quality profile mapping identity no longer matches "${mapping.qualityProfileName}". The recorded numeric ID now belongs to "${mappedProfile.name ?? "Unknown"}". Unlink the legacy deployment and review a fresh preview.`,
				);
			}
		} else {
			if (!mappedProfile) {
				throw new ConflictError(
					`The bound quality profile "${mapping.qualityProfileName}" no longer exists at its recorded ID. Review a fresh preview before continuing.`,
				);
			}
			if (mappedProfile.name !== mapping.qualityProfileName) {
				throw new ConflictError(
					`The bound quality profile identity no longer matches "${mapping.qualityProfileName}". The recorded numeric ID now belongs to "${mappedProfile.name ?? "Unknown"}". Review a fresh preview before continuing.`,
				);
			}
		}
		if (mappedProfile) {
			return {
				profile: mappedProfile,
				profileName: mappedProfile.name ?? mapping.qualityProfileName,
				matchedBy: "mapping_id",
			};
		}

		const recoveredProfile = findUniqueProfileByName(profiles, mapping.qualityProfileName);
		if (recoveredProfile) {
			return {
				profile: recoveredProfile,
				profileName: recoveredProfile.name ?? mapping.qualityProfileName,
				matchedBy: "mapping_name",
			};
		}

		throw new ConflictError(
			`The mapped quality profile "${mapping.qualityProfileName}" no longer exists in the instance. Unlink this deployment before selecting a different profile.`,
		);
	}

	if (isSourceInstance && sourceProfileId !== undefined && sourceProfileId !== null) {
		const sourceProfile = profiles.find((profile) => profile.id === sourceProfileId);
		if (!sourceProfile) {
			throw new ConflictError(
				`The cloned source quality profile (ID: ${sourceProfileId}) no longer exists in the source instance. Refresh or recreate the template before deploying.`,
			);
		}
		if (sourceProfileName && sourceProfile.name !== sourceProfileName) {
			throw new ConflictError(
				`The cloned source quality profile identity changed from "${sourceProfileName}" to "${sourceProfile.name ?? "Unknown"}". Refresh or recreate the template before deploying.`,
			);
		}
		return {
			profile: sourceProfile,
			profileName: sourceProfile.name ?? sourceProfileName ?? "TRaSH Guides HD/UHD",
			matchedBy: "source_id",
		};
	}

	const candidates: Array<{
		name: string | null | undefined;
		matchedBy: Exclude<
			ResolvedDeploymentTarget<TProfile>["matchedBy"],
			"mapping_id" | "mapping_name" | "source_id" | "new"
		>;
	}> = [
		{ name: sourceProfileName, matchedBy: "source_name" },
		{ name: templateName, matchedBy: "template_name" },
	];

	const checkedNames = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate.name || checkedNames.has(candidate.name)) continue;
		checkedNames.add(candidate.name);
		const profile = findUniqueProfileByName(profiles, candidate.name);
		if (profile) {
			return {
				profile,
				profileName: profile.name ?? candidate.name,
				matchedBy: candidate.matchedBy,
			};
		}
	}

	return {
		profile: undefined,
		profileName: sourceProfileName || templateName || "TRaSH Guides HD/UHD",
		matchedBy: "new",
	};
}

/** Reject a deployment that would take over a profile managed by another template. */
export function assertDeploymentTargetOwnership(args: {
	target: ResolvedDeploymentTarget<DeploymentQualityProfile>;
	templateId: string;
	existingMappings: DeploymentProfileMapping[];
}): void {
	const targetProfileId = args.target.profile?.id;
	const owner = args.existingMappings
		.filter((mapping) => mapping.templateId !== args.templateId)
		.find(
			(mapping) =>
				(targetProfileId !== undefined && mapping.qualityProfileId === targetProfileId) ||
				mapping.qualityProfileName === args.target.profileName,
		);
	if (owner?.templateId && owner.templateId !== args.templateId) {
		throw new ConflictError(
			`Quality profile "${args.target.profileName}" is already managed by another template. Unlink that deployment before using this profile.`,
		);
	}
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stableValue);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, stableValue(item)]),
		);
	}
	return value;
}

export function normalizeDeploymentBaseUrl(baseUrl: string): string {
	try {
		const url = new URL(baseUrl);
		url.hash = "";
		url.search = "";
		url.pathname = url.pathname.replace(/\/+$/, "") || "/";
		return url.toString();
	} catch {
		return baseUrl.trim().replace(/\/+$/, "");
	}
}

/** Resolve every local service record that can mutate the same physical ARR endpoint. */
export function getEquivalentServiceInstanceIds(
	instances: DeploymentServiceInstance[],
	target: DeploymentServiceInstance,
): string[] {
	const targetService = target.service.toUpperCase();
	const targetBaseUrl = normalizeDeploymentBaseUrl(target.baseUrl);
	return instances
		.filter(
			(instance) =>
				instance.service.toUpperCase() === targetService &&
				normalizeDeploymentBaseUrl(instance.baseUrl) === targetBaseUrl,
		)
		.map((instance) => instance.id);
}

/** Stable in-process lock identity for one user's physical ARR endpoint. */
export function createDeploymentEndpointKey(
	userId: string,
	instance: Pick<DeploymentServiceInstance, "service" | "baseUrl" | "credentialIdentity">,
): string {
	return `${userId}:${instance.service.toUpperCase()}:${normalizeDeploymentBaseUrl(instance.baseUrl)}`;
}

/** Accept pre-URL endpoint keys only when the exact connection token still matches. */
export function isDeploymentBackupEndpointIdentityCurrent(args: {
	userId: string;
	backupEndpointKey: string;
	backupConnectionStateToken: string;
	instance: DeploymentConnectionInstance;
	credentialIdentity: string;
}): boolean {
	if (args.backupConnectionStateToken !== createDeploymentConnectionStateToken(args.instance)) {
		return false;
	}
	const currentKey = createDeploymentEndpointKey(args.userId, {
		service: args.instance.service,
		baseUrl: args.instance.baseUrl,
		credentialIdentity: args.credentialIdentity,
	});
	const credentialBoundUrlKey = `${currentKey}:${args.credentialIdentity}`;
	const legacyKey = `${args.userId}:${args.instance.service.toUpperCase()}:${args.credentialIdentity}`;
	return (
		args.backupEndpointKey === currentKey ||
		args.backupEndpointKey === credentialBoundUrlKey ||
		args.backupEndpointKey === legacyKey
	);
}

/** Bind rollback metadata to both the normalized endpoint and configured credentials. */
export function createDeploymentConnectionStateToken(instance: {
	service: string;
	baseUrl: string;
	encryptedApiKey: string;
	encryptionIv: string;
	encryptedHttpAuthCredentials?: string | null;
	httpAuthEncryptionIv?: string | null;
	connectionGeneration?: number | null;
}): string {
	return createUpstreamResourceStateToken({
		service: instance.service.toUpperCase(),
		baseUrl: normalizeDeploymentBaseUrl(instance.baseUrl),
		credentials: [
			instance.encryptedApiKey,
			instance.encryptionIv,
			instance.encryptedHttpAuthCredentials ?? null,
			instance.httpAuthEncryptionIv ?? null,
		],
		connectionGeneration: instance.connectionGeneration ?? 0,
	});
}

/** Bind cloned-profile creation to the exact reviewed owner, connection, and ARR profile state. */
export function createClonedProfileSourceStateToken(args: {
	userId: string;
	instance: DeploymentConnectionInstance;
	profile: unknown;
	customFormats: unknown[];
}): string {
	const customFormats = args.customFormats
		.map((customFormat) => stableValue(customFormat))
		.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
	return createUpstreamResourceStateToken({
		userId: args.userId,
		instanceId: args.instance.id,
		connectionGeneration: args.instance.connectionGeneration ?? 0,
		connectionStateToken: createDeploymentConnectionStateToken(args.instance),
		profileStateToken: createQualityProfileStateToken(args.profile),
		customFormats,
	});
}

/** Authorize numeric cloned-profile targeting only on the reviewed source ARR connection. */
export function isVerifiedClonedProfileSourceConnection(args: {
	sourceInstanceId?: string | null;
	sourceConnectionStateToken?: string | null;
	equivalentInstanceIds: string[];
	sourceInstance?: DeploymentConnectionInstance | null;
}): boolean {
	if (!args.sourceInstanceId) {
		return false;
	}
	if (!args.sourceConnectionStateToken) {
		throw new ConflictError(
			"This cloned profile predates verified source-connection binding. Recreate the template from the current source profile before deploying it back to that ARR endpoint.",
		);
	}
	if (!args.sourceInstance || args.sourceInstance.id !== args.sourceInstanceId) {
		throw new ConflictError(
			"The cloned profile's recorded source ARR instance is unavailable. Recreate the template from the current source profile before deploying it back to that endpoint.",
		);
	}
	if (
		createDeploymentConnectionStateToken(args.sourceInstance) !== args.sourceConnectionStateToken
	) {
		throw new ConflictError(
			"The cloned profile's source ARR connection changed after the template was created. Recreate the template from the current connection before deploying it back to that source instance.",
		);
	}
	return args.equivalentInstanceIds.includes(args.sourceInstanceId);
}

/** Bind database ownership records to the exact configured ARR connection. */
export function createDeploymentConnectionBinding(
	instance: DeploymentConnectionInstance,
	credentialIdentity?: string,
): DeploymentConnectionBinding {
	return {
		instanceId: instance.id,
		connectionGeneration: instance.connectionGeneration ?? 0,
		connectionStateToken: createDeploymentConnectionStateToken(instance),
		...(credentialIdentity ? { credentialIdentity } : {}),
	};
}

/** Resolve mappings bound to the exact configured ARR connection. */
export function createDeploymentConnectionBindingCandidates(
	instance: DeploymentConnectionInstance,
	credentialIdentity?: string,
): DeploymentConnectionBinding[] {
	return [createDeploymentConnectionBinding(instance, credentialIdentity)];
}

/** Project in-memory connection evidence to fields that exist on persisted ownership rows. */
export function createDeploymentConnectionPersistenceBindings(
	bindings: DeploymentConnectionBinding[],
): DeploymentConnectionPersistenceBinding[] {
	return bindings.map(({ instanceId, connectionGeneration, connectionStateToken }) => ({
		instanceId,
		connectionGeneration,
		connectionStateToken,
	}));
}

/** Locate pre-binding mappings so callers can reject them without trusting them as ownership. */
export function createLegacyDeploymentConnectionBindings(
	instanceIds: string[],
): DeploymentConnectionBinding[] {
	return instanceIds.map((instanceId) => ({
		instanceId,
		connectionGeneration: 0,
		connectionStateToken: null,
	}));
}

/** Never use an unbound 2.x mapping to authorize a mutation after a connection may have changed. */
export function isLegacyDeploymentConnectionMapping(mapping: DeploymentConnectionMapping): boolean {
	return !(
		typeof mapping.connectionGeneration === "number" &&
		Number.isSafeInteger(mapping.connectionGeneration) &&
		mapping.connectionGeneration >= 0 &&
		typeof mapping.connectionStateToken === "string" &&
		mapping.connectionStateToken.trim().length > 0
	);
}

/** True only when a persisted mapping matches one freshly resolved connection binding. */
export function isCurrentDeploymentConnectionMapping(
	mapping: DeploymentConnectionMapping & { instanceId: string },
	bindings: DeploymentConnectionBinding[],
): boolean {
	return bindings.some(
		(binding) =>
			binding.instanceId === mapping.instanceId &&
			binding.connectionGeneration === mapping.connectionGeneration &&
			binding.connectionStateToken === mapping.connectionStateToken,
	);
}

export function assertNoLegacyDeploymentConnectionMappings(
	mappings: DeploymentConnectionMapping[],
): void {
	if (mappings.some(isLegacyDeploymentConnectionMapping)) {
		throw new ConflictError(
			"This deployment mapping predates connection identity verification. Unlink the legacy deployment and review a fresh preview before continuing.",
		);
	}
}

function deploymentMappingAuthorityValue(mapping: DeploymentMappingAuthorityInput) {
	return {
		qualityProfileId: mapping.qualityProfileId,
		qualityProfileName: mapping.qualityProfileName,
		syncStrategy: mapping.syncStrategy ?? null,
		managedCustomFormatsCaptured: mapping.managedCustomFormatsCaptured ?? false,
		managedCustomFormats: mapping.managedCustomFormats ?? null,
	};
}

/** Fail closed when aliases disagree about the resources one template owns. */
export function assertEquivalentDeploymentMappingAuthority(
	mappings: DeploymentMappingAuthorityInput[],
): void {
	const expected = mappings[0];
	if (!expected) return;
	const expectedAuthority = JSON.stringify(stableValue(deploymentMappingAuthorityValue(expected)));
	if (
		mappings.some(
			(mapping) =>
				JSON.stringify(stableValue(deploymentMappingAuthorityValue(mapping))) !== expectedAuthority,
		)
	) {
		throw new ConflictError(
			"Equivalent ARR aliases have conflicting deployment authority. Reconcile the quality profile, sync strategy, and managed Custom Format snapshot before continuing.",
		);
	}
}

/** Canonical mapping state included in preview tokens to detect replacement or revocation. */
export function createDeploymentMappingAuthorityState(
	mappings: DeploymentMappingAuthorityInput[],
): unknown[] {
	return mappings
		.map((mapping) => ({
			id: mapping.id ?? null,
			instanceId: mapping.instanceId ?? null,
			...deploymentMappingAuthorityValue(mapping),
			updatedAt:
				mapping.updatedAt instanceof Date
					? mapping.updatedAt.toISOString()
					: (mapping.updatedAt ?? null),
		}))
		.sort((left, right) =>
			`${left.instanceId ?? ""}:${left.id ?? ""}`.localeCompare(
				`${right.instanceId ?? ""}:${right.id ?? ""}`,
			),
		);
}

/** Create an opaque fingerprint for the exact upstream state shown in preview. */
export function createDeploymentStateToken(args: {
	template: {
		id: string;
		name: string;
		configData: string;
		instanceOverrides?: string | null;
		sourceQualityProfileName?: string | null;
	};
	instanceId: string;
	connection: {
		service: string;
		baseUrl: string;
		credentialIdentity: string;
	};
	target: ResolvedDeploymentTarget<DeploymentQualityProfile>;
	customFormats: unknown[];
	namingConfig?: unknown;
	namingPayload?: unknown;
	mappingAuthority?: unknown;
	savedScoreOverrides?: unknown;
	orphanedFormatScoreChanges?: unknown;
}): string {
	const state = stableValue({
		template: args.template,
		instanceId: args.instanceId,
		connection: {
			...args.connection,
			baseUrl: normalizeDeploymentBaseUrl(args.connection.baseUrl),
		},
		target: {
			matchedBy: args.target.matchedBy,
			profileName: args.target.profileName,
			profile: args.target.profile ?? null,
		},
		customFormats: args.customFormats,
		namingConfig: args.namingConfig ?? null,
		namingPayload: args.namingPayload ?? null,
		mappingAuthority: args.mappingAuthority ?? null,
		savedScoreOverrides: args.savedScoreOverrides ?? null,
		orphanedFormatScoreChanges: args.orphanedFormatScoreChanges ?? null,
	});

	return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

/** Fingerprint one upstream resource using stable object-key ordering. */
export function createUpstreamResourceStateToken(resource: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(stableValue(resource)))
		.digest("hex");
}

/** Fingerprint a full upstream profile for a last-moment concurrency check. */
export function createQualityProfileStateToken(profile: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(stableValue(profile)))
		.digest("hex");
}
