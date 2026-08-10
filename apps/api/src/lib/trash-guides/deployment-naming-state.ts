import { type NamingSelectedPresets, TRASH_CONFIG_TYPES, type TrashNamingData } from "@arr/shared";
import { z } from "zod";
import type { ArrClientFactory } from "../arr/client-factory.js";
import { AppValidationError } from "../errors.js";
import type { PrismaClient } from "../prisma.js";
import { createCacheManager } from "./cache-manager.js";
import { createUpstreamResourceStateToken } from "./deployment-target.js";
import { arrNamingConfigSchema } from "./github-schemas.js";
import { resolvePayload } from "./naming-deployer.js";

type NamingInstance = Parameters<ArrClientFactory["rawRequest"]>[0];
const positiveConfigId = z.number().int().positive().safe();
const radarrNamingSnapshotSchema = arrNamingConfigSchema.extend({
	id: positiveConfigId,
	renameMovies: z.boolean(),
	replaceIllegalCharacters: z.boolean(),
	colonReplacementFormat: z.enum(["delete", "dash", "spaceDash", "spaceDashSpace", "smart"]),
	standardMovieFormat: z.string().nullable(),
	movieFolderFormat: z.string().nullable(),
});
const sonarrNamingSnapshotSchema = arrNamingConfigSchema.extend({
	id: positiveConfigId,
	renameEpisodes: z.boolean(),
	replaceIllegalCharacters: z.boolean(),
	colonReplacementFormat: z.number().int().nonnegative().safe(),
	customColonReplacementFormat: z.string().nullable(),
	multiEpisodeStyle: z.number().int().nonnegative().safe(),
	standardEpisodeFormat: z.string().nullable(),
	dailyEpisodeFormat: z.string().nullable(),
	animeEpisodeFormat: z.string().nullable(),
	seriesFolderFormat: z.string().nullable(),
	seasonFolderFormat: z.string().nullable(),
	specialsFolderFormat: z.string().nullable(),
});

function getNamingServiceType(instance: NamingInstance): "RADARR" | "SONARR" {
	const serviceType = instance.service.toUpperCase();
	if (serviceType !== "RADARR" && serviceType !== "SONARR") {
		throw new AppValidationError(`Naming deployment is unsupported for ${instance.service}`);
	}
	return serviceType;
}

function getNamingSnapshotSchema(serviceType: "RADARR" | "SONARR") {
	return serviceType === "RADARR" ? radarrNamingSnapshotSchema : sonarrNamingSnapshotSchema;
}

function parseNamingResponse(
	value: unknown,
	serviceType: "RADARR" | "SONARR",
): Record<string, unknown> {
	const parsed = getNamingSnapshotSchema(serviceType).safeParse(value);
	if (!parsed.success) {
		throw new AppValidationError(
			`The instance returned an invalid ${serviceType} naming configuration.`,
		);
	}
	return parsed.data as Record<string, unknown>;
}

export interface PreparedNamingDeployment {
	currentConfig: Record<string, unknown>;
	mergedConfig: Record<string, unknown>;
	changedFields: string[];
}

/** Resolve the exact naming mutation against a fresh upstream snapshot. */
export async function prepareNamingDeployment(
	prisma: PrismaClient,
	clientFactory: ArrClientFactory,
	instance: NamingInstance,
	selection: NamingSelectedPresets,
): Promise<PreparedNamingDeployment> {
	const serviceType = getNamingServiceType(instance);
	if (selection.serviceType !== serviceType) {
		throw new AppValidationError(`Naming selection service type mismatch: expected ${serviceType}`);
	}

	const namingData = await createCacheManager(prisma).get<TrashNamingData[]>(
		serviceType,
		TRASH_CONFIG_TYPES.NAMING_PRESETS,
	);
	if (!namingData?.length) {
		throw new AppValidationError(
			"Naming data is not cached. Refresh TRaSH Guides data before deploying this template.",
		);
	}

	const currentResponse = await clientFactory.rawRequest(instance, "/api/v3/config/naming");
	if (!currentResponse.ok) {
		throw new AppValidationError(
			`The current naming configuration could not be read (HTTP ${currentResponse.status}).`,
		);
	}
	const currentConfig = parseNamingResponse(await currentResponse.json(), serviceType);
	const patch = resolvePayload(namingData[0]!, selection);
	const changedFields = Object.keys(patch).filter(
		(field) => !Object.is(currentConfig[field], patch[field]),
	);

	return {
		currentConfig,
		mergedConfig: { ...currentConfig, ...patch },
		changedFields,
	};
}

/** Restore a naming snapshot captured with a deployment backup. */
export async function restoreNamingDeployment(
	clientFactory: ArrClientFactory,
	instance: NamingInstance,
	config: Record<string, unknown>,
	expectedCurrentStateToken: string,
): Promise<void> {
	const serviceType = getNamingServiceType(instance);
	const snapshotResult = getNamingSnapshotSchema(serviceType).safeParse(config);
	if (!snapshotResult.success) {
		throw new Error(`Naming snapshot is incomplete or does not match ${serviceType}.`);
	}
	const snapshot = snapshotResult.data as Record<string, unknown>;
	const currentResponse = await clientFactory.rawRequest(instance, "/api/v3/config/naming");
	if (!currentResponse.ok) {
		throw new Error(`Failed to read current naming configuration: HTTP ${currentResponse.status}`);
	}
	const currentConfig = parseNamingResponse(await currentResponse.json(), serviceType);
	const currentStateToken = createUpstreamResourceStateToken(currentConfig);
	if (currentStateToken === createUpstreamResourceStateToken(snapshot)) {
		return;
	}
	if (currentStateToken !== expectedCurrentStateToken) {
		throw new Error(
			"Naming configuration changed after this deployment. Restore it manually or create a fresh backup before retrying.",
		);
	}
	throw new Error(
		"Naming configuration cannot be restored safely because the upstream API has no conditional update. Its current state still matches this deployment; restore the recorded pre-deployment configuration manually.",
	);
}
