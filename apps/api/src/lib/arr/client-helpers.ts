/**
 * ARR Client Helper Utilities
 *
 * Common patterns for working with ARR SDK clients across multiple instances.
 * All operations are request-scoped and follow security best practices.
 */

import { LidarrClient, ProwlarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServiceInstance, ServiceType } from "../../lib/prisma.js";
import { InstanceNotFoundError } from "../errors.js";
import { getErrorMessage } from "../utils/error-message.js";
import { type ArrClient, ArrError, arrErrorToHttpStatus } from "./client-factory.js";
import { requireEnabledInstance } from "./instance-helpers.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Result of an operation on a single instance
 */
export interface InstanceResult<T> {
	instanceId: string;
	instanceName: string;
	service: Lowercase<ServiceType>;
	success: true;
	data: T;
}

/**
 * Error result from an instance operation
 */
export interface InstanceError {
	instanceId: string;
	instanceName: string;
	service: Lowercase<ServiceType>;
	success: false;
	error: string;
	/** HTTP status code for the error (always provided, defaults to 500 for unknown errors) */
	statusCode: number;
}

/**
 * Combined result type
 */
export type InstanceOperationResult<T> = InstanceResult<T> | InstanceError;

/**
 * Aggregated results from multiple instances
 */
export interface MultiInstanceResponse<T> {
	instances: Array<InstanceOperationResult<T>>;
	aggregated: T[];
	totalCount: number;
	errorCount: number;
}

/**
 * Options for multi-instance operations
 */
export interface MultiInstanceOptions {
	/** Only include enabled instances (default: true) */
	enabledOnly?: boolean;
	/** Filter by service type */
	serviceTypes?: ServiceType[];
	/** Filter by specific instance IDs */
	instanceIds?: string[];
	/** Continue on error (default: true) */
	continueOnError?: boolean;
}

// ============================================================================
// Service Type Utilities
// ============================================================================

/**
 * Convert a database ServiceType (e.g. "SONARR") to its lowercase API form.
 *
 * Centralizes the `toLowerCase() as ...` cast so route files don't repeat
 * the inline type assertion.
 */
export function toServiceLabel(service: string): Lowercase<ServiceType> {
	return service.toLowerCase() as Lowercase<ServiceType>;
}

// ============================================================================
// Multi-Instance Operations
// ============================================================================

/**
 * Execute an operation across multiple instances in parallel.
 *
 * @example
 * ```typescript
 * const results = await executeOnInstances(
 *   app,
 *   request.currentUser!.id,
 *   { serviceTypes: ['SONARR', 'RADARR'] },
 *   async (client, instance) => {
 *     if (client instanceof SonarrClient) {
 *       return client.queue.getAll();
 *     } else if (client instanceof RadarrClient) {
 *       return client.queue.getAll();
 *     }
 *     return [];
 *   }
 * );
 * ```
 */
export async function executeOnInstances<T>(
	app: FastifyInstance,
	userId: string,
	options: MultiInstanceOptions,
	operation: (client: ArrClient, instance: ServiceInstance) => Promise<T>,
): Promise<MultiInstanceResponse<T>> {
	const { enabledOnly = true, serviceTypes, instanceIds, continueOnError = true } = options;

	// Build query
	const where: {
		userId: string;
		enabled?: boolean;
		service?: { in: ServiceType[] };
		id?: { in: string[] };
	} = { userId };

	if (enabledOnly) {
		where.enabled = true;
	}

	if (serviceTypes?.length) {
		where.service = { in: serviceTypes };
	}

	if (instanceIds?.length) {
		where.id = { in: instanceIds };
	}

	// Fetch instances
	const instances = await app.prisma.serviceInstance.findMany({
		where,
		orderBy: { label: "asc" },
	});

	// Execute operations in parallel
	const results = await Promise.all(
		instances.map(async (instance): Promise<InstanceOperationResult<T>> => {
			const service = toServiceLabel(instance.service);

			try {
				const client = app.arrClientFactory.create(instance);
				const data = await operation(client, instance);

				return {
					instanceId: instance.id,
					instanceName: instance.label,
					service,
					success: true,
					data,
				};
			} catch (error) {
				if (!continueOnError) {
					throw error;
				}

				const statusCode = error instanceof ArrError ? arrErrorToHttpStatus(error) : 500;
				const errorMessage = getErrorMessage(error, "Unknown error");

				// Log error for server-side debugging
				app.log.error(
					{
						err: error,
						instanceId: instance.id,
						instanceName: instance.label,
						service,
						statusCode,
					},
					"Instance operation failed",
				);

				return {
					instanceId: instance.id,
					instanceName: instance.label,
					service,
					success: false,
					error: errorMessage,
					statusCode,
				};
			}
		}),
	);

	// Aggregate successful results
	const successfulResults = results.filter((r): r is InstanceResult<T> => r.success);
	const aggregated = successfulResults.flatMap((r) => (Array.isArray(r.data) ? r.data : [r.data]));
	const errorCount = results.filter((r) => !r.success).length;

	return {
		instances: results,
		aggregated,
		totalCount: aggregated.length,
		errorCount,
	};
}

// ============================================================================
// Single Instance Operations
// ============================================================================

/**
 * Get a client for a specific instance, verifying ownership.
 *
 * @example
 * ```typescript
 * const result = await getClientForInstance(app, request, instanceId);
 * if (!result.success) {
 *   return reply.status(result.statusCode).send({ error: result.error });
 * }
 * const { client, instance } = result;
 * ```
 */
export async function getClientForInstance(
	app: FastifyInstance,
	request: FastifyRequest,
	instanceId: string,
): Promise<
	| { success: true; client: ArrClient; instance: ServiceInstance }
	| { success: false; error: string; statusCode: number }
> {
	if (!request.currentUser?.id) {
		return {
			success: false,
			error: "Authentication required",
			statusCode: 401,
		};
	}

	try {
		const instance = await requireEnabledInstance(app, request.currentUser.id, instanceId);
		const client = app.arrClientFactory.create(instance);
		return { success: true, client, instance };
	} catch (error) {
		if (error instanceof InstanceNotFoundError) {
			return {
				success: false,
				error: "Instance not found, disabled, or access denied",
				statusCode: 404,
			};
		}
		throw error;
	}
}

// ============================================================================
// Type Guards for Clients
// ============================================================================

/**
 * Type guard to check if a client is a SonarrClient
 */
export function isSonarrClient(client: ArrClient): client is SonarrClient {
	return client instanceof SonarrClient;
}

/**
 * Type guard to check if a client is a RadarrClient
 */
export function isRadarrClient(client: ArrClient): client is RadarrClient {
	return client instanceof RadarrClient;
}

/**
 * Type guard to check if a client is a ProwlarrClient
 */
export function isProwlarrClient(client: ArrClient): client is ProwlarrClient {
	return client instanceof ProwlarrClient;
}

/**
 * Type guard to check if a client is a LidarrClient
 */
export function isLidarrClient(client: ArrClient): client is LidarrClient {
	return client instanceof LidarrClient;
}

/**
 * Type guard to check if a client is a ReadarrClient
 */
export function isReadarrClient(client: ArrClient): client is ReadarrClient {
	return client instanceof ReadarrClient;
}
