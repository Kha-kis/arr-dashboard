import { type NamingSelectedPresets, TRASH_CONFIG_TYPES, type TrashNamingData } from "@arr/shared";
import type { ArrClientFactory } from "../arr/client-factory.js";
import { AppValidationError } from "../errors.js";
import type { PrismaClient } from "../prisma.js";
import { createCacheManager } from "./cache-manager.js";
import { createUpstreamResourceStateToken } from "./deployment-target.js";
import { resolvePayload } from "./naming-deployer.js";

type NamingInstance = Parameters<ArrClientFactory["rawRequest"]>[0];

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
	const serviceType = instance.service.toUpperCase() as "RADARR" | "SONARR";
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
	const currentConfig = (await currentResponse.json()) as Record<string, unknown>;
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
	const currentResponse = await clientFactory.rawRequest(instance, "/api/v3/config/naming");
	if (!currentResponse.ok) {
		throw new Error(`Failed to read current naming configuration: HTTP ${currentResponse.status}`);
	}
	const currentConfig = (await currentResponse.json()) as Record<string, unknown>;
	const currentStateToken = createUpstreamResourceStateToken(currentConfig);
	if (currentStateToken === createUpstreamResourceStateToken(config)) {
		return;
	}
	if (currentStateToken !== expectedCurrentStateToken) {
		throw new Error(
			"Naming configuration changed after this deployment. Restore it manually or create a fresh backup before retrying.",
		);
	}
	const response = await clientFactory.rawRequest(instance, "/api/v3/config/naming", {
		method: "PUT",
		body: config,
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
}
