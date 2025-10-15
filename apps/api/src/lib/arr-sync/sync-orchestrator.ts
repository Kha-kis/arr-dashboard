/**
 * Sync Orchestrator - Main service that coordinates the sync process
 */

import type { FastifyInstance } from "fastify";
import type { ServiceInstance } from "@prisma/client";
import { ArrClient } from "./clients/arr-client.js";
import {
	fetchTrashGuides,
	filterByPresets,
} from "./trash/trash-fetcher.js";
import { computeSyncPlan } from "./diff/diff-engine.js";
import { applySyncPlan, verifySyncResult } from "./apply/apply-service.js";
import type {
	SyncPlan,
	ApplyResult,
	RemoteState,
	SyncContext,
} from "./types.js";
import type { ArrSyncOverrides } from "@arr/shared";

export interface SyncOptions {
	instanceId: string;
	enabled?: boolean;
	trashRef?: string;
	presets?: string[];
	overrides?: ArrSyncOverrides;
}

/**
 * Preview sync changes without applying them
 */
export async function previewSync(
	app: FastifyInstance,
	instanceId: string,
): Promise<SyncPlan> {
	// Get instance and settings
	const instance = await app.prisma.serviceInstance.findUnique({
		where: { id: instanceId },
		include: { arrSyncSettings: true },
	});

	if (!instance) {
		throw new Error(`Instance ${instanceId} not found`);
	}

	if (instance.service !== "SONARR" && instance.service !== "RADARR") {
		throw new Error(
			`Instance ${instanceId} is ${instance.service}, only SONARR and RADARR are supported`,
		);
	}

	// Check if sync is enabled
	const settings = instance.arrSyncSettings;
	if (!settings || !settings.enabled) {
		return {
			instanceId,
			instanceLabel: instance.label,
			customFormats: { creates: [], updates: [], deletes: [] },
			qualityProfiles: { creates: [], updates: [] },
			warnings: ["Sync is not enabled for this instance"],
			errors: [],
		};
	}

	// Decrypt API key and create client
	const apiKey = app.encryptor.decrypt({
		value: instance.encryptedApiKey,
		iv: instance.encryptionIv,
	});

	const client = new ArrClient(app, { ...instance, apiKey } as any);

	// Fetch remote state
	const remoteState: RemoteState = {
		customFormats: await client.getCustomFormats(),
		qualityProfiles: await client.getQualityProfiles(),
		systemStatus: await client.getSystemStatus(),
	};

	// Fetch TRaSH guides
	const trashGuides = await fetchTrashGuides({
		ref: settings.trashRef,
		service: instance.service,
	});

	// Parse presets
	const presets = settings.presets ? JSON.parse(settings.presets) : [];

	// Filter by presets
	const desiredCustomFormats = filterByPresets(
		trashGuides.customFormats,
		presets,
	);

	// Parse overrides
	const overrides = settings.overridesJson
		? JSON.parse(settings.overridesJson)
		: {};

	// Compute diff
	const plan = computeSyncPlan({
		instanceId,
		instanceLabel: instance.label,
		remoteState,
		desiredCustomFormats,
		overrides,
		allowDeletes: false, // For safety, don't allow deletes by default
	});

	return plan;
}

/**
 * Apply sync changes
 */
export async function applySync(
	app: FastifyInstance,
	instanceId: string,
	options: { dryRun?: boolean } = {},
): Promise<ApplyResult> {
	// Get plan first
	const plan = await previewSync(app, instanceId);

	// Get instance again for the client
	const instance = await app.prisma.serviceInstance.findUnique({
		where: { id: instanceId },
	});

	if (!instance) {
		throw new Error(`Instance ${instanceId} not found`);
	}

	// Decrypt API key
	const apiKey = app.encryptor.decrypt({
		value: instance.encryptedApiKey,
		iv: instance.encryptionIv,
	});

	const client = new ArrClient(app, { ...instance, apiKey } as any);

	// Apply the plan
	const result = await applySyncPlan(client, plan, {
		dryRun: options.dryRun,
	});

	// Verify if not dry run
	if (!options.dryRun && result.success) {
		const verification = await verifySyncResult(client, plan);
		if (!verification.verified) {
			result.warnings.push(...verification.issues);
		}
	}

	// Update lastSyncAt if successful
	if (result.success && !options.dryRun) {
		await app.prisma.arrSyncSettings.update({
			where: { serviceInstanceId: instanceId },
			data: { lastSyncAt: new Date() },
		});
	}

	return result;
}

/**
 * Test connection to an instance
 */
export async function testConnection(
	app: FastifyInstance,
	instanceId: string,
): Promise<{
	success: boolean;
	message: string;
	version?: string;
	canManageCustomFormats: boolean;
	canManageQualityProfiles: boolean;
}> {
	const instance = await app.prisma.serviceInstance.findUnique({
		where: { id: instanceId },
	});

	if (!instance) {
		return {
			success: false,
			message: "Instance not found",
			canManageCustomFormats: false,
			canManageQualityProfiles: false,
		};
	}

	if (instance.service !== "SONARR" && instance.service !== "RADARR") {
		return {
			success: false,
			message: `${instance.service} is not supported for ARR sync`,
			canManageCustomFormats: false,
			canManageQualityProfiles: false,
		};
	}

	try {
		const apiKey = app.encryptor.decrypt({
			value: instance.encryptedApiKey,
			iv: instance.encryptionIv,
		});

		const client = new ArrClient(app, { ...instance, apiKey } as any);

		const status = await client.getSystemStatus();
		const canConnect = await client.testConnection();

		if (!canConnect) {
			return {
				success: false,
				message: "Failed to connect to instance",
				canManageCustomFormats: false,
				canManageQualityProfiles: false,
			};
		}

		// Test permissions
		let canManageCustomFormats = false;
		let canManageQualityProfiles = false;

		try {
			await client.getCustomFormats();
			canManageCustomFormats = true;
		} catch (error) {
			// Permission denied or not available
		}

		try {
			await client.getQualityProfiles();
			canManageQualityProfiles = true;
		} catch (error) {
			// Permission denied or not available
		}

		return {
			success: true,
			message: "Connection successful",
			version: status.version,
			canManageCustomFormats,
			canManageQualityProfiles,
		};
	} catch (error) {
		return {
			success: false,
			message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
			canManageCustomFormats: false,
			canManageQualityProfiles: false,
		};
	}
}
