/**
 * Tautulli Client Helpers
 *
 * Common patterns for working with Tautulli clients across multiple instances.
 * Mirrors the executeOnInstances pattern from arr/client-helpers.ts.
 */

import type { FastifyInstance } from "fastify";
import type { ServiceInstance } from "../prisma.js";
import { InstanceNotFoundError } from "../errors.js";
import { AppValidationError } from "../errors.js";
import { getErrorMessage } from "../utils/error-message.js";
import { type TautulliClient, createTautulliClient } from "./tautulli-client.js";

// ============================================================================
// Types
// ============================================================================

export interface TautulliInstanceResult<T> {
	instanceId: string;
	instanceName: string;
	success: true;
	data: T;
}

export interface TautulliInstanceError {
	instanceId: string;
	instanceName: string;
	success: false;
	error: string;
}

export type TautulliInstanceOperationResult<T> =
	| TautulliInstanceResult<T>
	| TautulliInstanceError;

export interface TautulliMultiInstanceResponse<T> {
	instances: Array<TautulliInstanceOperationResult<T>>;
	aggregated: T[];
	totalCount: number;
	errorCount: number;
}

// ============================================================================
// Single Instance
// ============================================================================

/**
 * Get a TautulliClient for a specific instance, verifying ownership.
 * Throws InstanceNotFoundError if not found or not a TAUTULLI instance.
 */
export async function requireTautulliClient(
	app: FastifyInstance,
	userId: string,
	instanceId: string,
): Promise<{ client: TautulliClient; instance: ServiceInstance }> {
	const instance = await app.prisma.serviceInstance.findFirst({
		where: { id: instanceId, userId, enabled: true },
	});

	if (!instance) {
		throw new InstanceNotFoundError(instanceId);
	}

	if (instance.service !== "TAUTULLI") {
		throw new AppValidationError("Instance is not a Tautulli service");
	}

	const client = createTautulliClient(app.encryptor, instance, app.log);
	return { client, instance };
}

// ============================================================================
// Multi-Instance
// ============================================================================

/**
 * Execute an operation across all enabled Tautulli instances for a user.
 * Returns aggregated results with per-instance success/error tracking.
 */
export async function executeOnTautulliInstances<T>(
	app: FastifyInstance,
	userId: string,
	operation: (client: TautulliClient, instance: ServiceInstance) => Promise<T>,
): Promise<TautulliMultiInstanceResponse<T>> {
	const instances = await app.prisma.serviceInstance.findMany({
		where: { userId, service: "TAUTULLI", enabled: true },
		orderBy: { label: "asc" },
	});

	const results = await Promise.all(
		instances.map(async (instance): Promise<TautulliInstanceOperationResult<T>> => {
			try {
				const client = createTautulliClient(app.encryptor, instance, app.log);
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
					"Tautulli instance operation failed",
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

	const successfulResults = results.filter(
		(r): r is TautulliInstanceResult<T> => r.success,
	);
	const aggregated = successfulResults.flatMap((r) =>
		Array.isArray(r.data) ? r.data : [r.data],
	);
	const errorCount = results.filter((r) => !r.success).length;

	return {
		instances: results,
		aggregated,
		totalCount: aggregated.length,
		errorCount,
	};
}
