/**
 * Jellyfin Client Helpers
 *
 * Common patterns for working with Jellyfin clients across multiple instances.
 * Mirrors the plex-helpers.ts pattern.
 */

import type { FastifyInstance } from "fastify";
import type { ServiceInstance } from "../prisma.js";
import { AppValidationError, InstanceNotFoundError } from "../errors.js";
import { getErrorMessage } from "../utils/error-message.js";
import { type JellyfinClient, createJellyfinClient } from "./jellyfin-client.js";

// ============================================================================
// Types
// ============================================================================

export interface JellyfinInstanceResult<T> {
	instanceId: string;
	instanceName: string;
	success: true;
	data: T;
}

export interface JellyfinInstanceError {
	instanceId: string;
	instanceName: string;
	success: false;
	error: string;
}

export type JellyfinInstanceOperationResult<T> = JellyfinInstanceResult<T> | JellyfinInstanceError;

export interface JellyfinMultiInstanceResponse<T> {
	instances: Array<JellyfinInstanceOperationResult<T>>;
	aggregated: T[];
	totalCount: number;
	errorCount: number;
}

// ============================================================================
// Single Instance
// ============================================================================

/**
 * Get a JellyfinClient for a specific instance, verifying ownership.
 */
export async function requireJellyfinClient(
	app: FastifyInstance,
	userId: string,
	instanceId: string,
): Promise<{ client: JellyfinClient; instance: ServiceInstance }> {
	const instance = await app.prisma.serviceInstance.findFirst({
		where: { id: instanceId, userId, enabled: true },
	});

	if (!instance) {
		throw new InstanceNotFoundError(instanceId);
	}

	if (instance.service !== "JELLYFIN" && instance.service !== "EMBY") {
		throw new AppValidationError("Instance is not a Jellyfin or Emby service");
	}

	const client = createJellyfinClient(app.encryptor, instance, app.log);
	return { client, instance };
}

// ============================================================================
// Multi-Instance
// ============================================================================

/**
 * Execute an operation across all enabled Jellyfin instances for a user.
 */
export async function executeOnJellyfinInstances<T>(
	app: FastifyInstance,
	userId: string,
	operation: (client: JellyfinClient, instance: ServiceInstance) => Promise<T>,
): Promise<JellyfinMultiInstanceResponse<T>> {
	const instances = await app.prisma.serviceInstance.findMany({
		where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
		orderBy: { label: "asc" },
	});

	const results = await Promise.all(
		instances.map(async (instance): Promise<JellyfinInstanceOperationResult<T>> => {
			try {
				const client = createJellyfinClient(app.encryptor, instance, app.log);
				const data = await operation(client, instance);

				return {
					instanceId: instance.id,
					instanceName: instance.label,
					success: true,
					data,
				};
			} catch (error) {
				app.log.error(
					{ err: error, instanceId: instance.id, instanceName: instance.label },
					"Jellyfin instance operation failed",
				);

				return {
					instanceId: instance.id,
					instanceName: instance.label,
					success: false,
					error: getErrorMessage(error, "Unknown error"),
				};
			}
		}),
	);

	const successfulResults = results.filter((r): r is JellyfinInstanceResult<T> => r.success);
	const aggregated = successfulResults.flatMap((r) => (Array.isArray(r.data) ? r.data : [r.data]));
	const errorCount = results.filter((r) => !r.success).length;

	return {
		instances: results,
		aggregated,
		totalCount: results.length,
		errorCount,
	};
}
