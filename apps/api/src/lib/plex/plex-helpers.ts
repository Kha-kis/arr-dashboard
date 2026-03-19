/**
 * Plex Client Helpers
 *
 * Common patterns for working with Plex clients across multiple instances.
 * Mirrors the executeOnInstances pattern from arr/client-helpers.ts.
 */

import type { FastifyInstance } from "fastify";
import type { ServiceInstance } from "../prisma.js";
import { InstanceNotFoundError } from "../errors.js";
import { AppValidationError } from "../errors.js";
import { getErrorMessage } from "../utils/error-message.js";
import { type PlexClient, createPlexClient } from "./plex-client.js";

// ============================================================================
// Types
// ============================================================================

export interface PlexInstanceResult<T> {
	instanceId: string;
	instanceName: string;
	success: true;
	data: T;
}

export interface PlexInstanceError {
	instanceId: string;
	instanceName: string;
	success: false;
	error: string;
}

export type PlexInstanceOperationResult<T> = PlexInstanceResult<T> | PlexInstanceError;

export interface PlexMultiInstanceResponse<T> {
	instances: Array<PlexInstanceOperationResult<T>>;
	aggregated: T[];
	totalCount: number;
	errorCount: number;
}

// ============================================================================
// Single Instance
// ============================================================================

/**
 * Get a PlexClient for a specific instance, verifying ownership.
 * Throws InstanceNotFoundError if not found or not a PLEX instance.
 */
export async function requirePlexClient(
	app: FastifyInstance,
	userId: string,
	instanceId: string,
): Promise<{ client: PlexClient; instance: ServiceInstance }> {
	const instance = await app.prisma.serviceInstance.findFirst({
		where: { id: instanceId, userId, enabled: true },
	});

	if (!instance) {
		throw new InstanceNotFoundError(instanceId);
	}

	if (instance.service !== "PLEX") {
		throw new AppValidationError("Instance is not a Plex service");
	}

	const client = createPlexClient(app.encryptor, instance, app.log);
	return { client, instance };
}

// ============================================================================
// Multi-Instance
// ============================================================================

/**
 * Execute an operation across all enabled Plex instances for a user.
 * Returns aggregated results with per-instance success/error tracking.
 */
export async function executeOnPlexInstances<T>(
	app: FastifyInstance,
	userId: string,
	operation: (client: PlexClient, instance: ServiceInstance) => Promise<T>,
): Promise<PlexMultiInstanceResponse<T>> {
	const instances = await app.prisma.serviceInstance.findMany({
		where: { userId, service: "PLEX", enabled: true },
		orderBy: { label: "asc" },
	});

	const results = await Promise.all(
		instances.map(async (instance): Promise<PlexInstanceOperationResult<T>> => {
			try {
				const client = createPlexClient(app.encryptor, instance, app.log);
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
					"Plex instance operation failed",
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

	const successfulResults = results.filter((r): r is PlexInstanceResult<T> => r.success);
	const aggregated = successfulResults.flatMap((r) => (Array.isArray(r.data) ? r.data : [r.data]));
	const errorCount = results.filter((r) => !r.success).length;

	return {
		instances: results,
		aggregated,
		totalCount: aggregated.length,
		errorCount,
	};
}
