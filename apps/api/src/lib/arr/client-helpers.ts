/**
 * ARR Client Helper Utilities
 *
 * Common patterns for working with ARR SDK clients across multiple instances.
 * All operations are request-scoped and follow security best practices.
 */

import type { ServiceInstance, ServiceType } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
	type ArrClient,
	type ArrClientFactory,
	ArrError,
	arrErrorToHttpStatus,
} from "./client-factory.js";
import { SonarrClient, RadarrClient, ProwlarrClient } from "arr-sdk";

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
			const service = instance.service.toLowerCase() as Lowercase<ServiceType>;

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
				const errorMessage = error instanceof Error ? error.message : "Unknown error";

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

/**
 * Execute an operation on Sonarr instances only
 */
export async function executeOnSonarrInstances<T>(
	app: FastifyInstance,
	userId: string,
	operation: (client: SonarrClient, instance: ServiceInstance) => Promise<T>,
	options?: Omit<MultiInstanceOptions, "serviceTypes">,
): Promise<MultiInstanceResponse<T>> {
	return executeOnInstances(
		app,
		userId,
		{ ...options, serviceTypes: ["SONARR"] },
		(client, instance) => operation(client as SonarrClient, instance),
	);
}

/**
 * Execute an operation on Radarr instances only
 */
export async function executeOnRadarrInstances<T>(
	app: FastifyInstance,
	userId: string,
	operation: (client: RadarrClient, instance: ServiceInstance) => Promise<T>,
	options?: Omit<MultiInstanceOptions, "serviceTypes">,
): Promise<MultiInstanceResponse<T>> {
	return executeOnInstances(
		app,
		userId,
		{ ...options, serviceTypes: ["RADARR"] },
		(client, instance) => operation(client as RadarrClient, instance),
	);
}

/**
 * Execute an operation on Prowlarr instances only
 */
export async function executeOnProwlarrInstances<T>(
	app: FastifyInstance,
	userId: string,
	operation: (client: ProwlarrClient, instance: ServiceInstance) => Promise<T>,
	options?: Omit<MultiInstanceOptions, "serviceTypes">,
): Promise<MultiInstanceResponse<T>> {
	return executeOnInstances(
		app,
		userId,
		{ ...options, serviceTypes: ["PROWLARR"] },
		(client, instance) => operation(client as ProwlarrClient, instance),
	);
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

	const instance = await app.prisma.serviceInstance.findFirst({
		where: {
			id: instanceId,
			userId: request.currentUser.id,
			enabled: true,
		},
	});

	if (!instance) {
		return {
			success: false,
			error: "Instance not found, disabled, or access denied",
			statusCode: 404,
		};
	}

	const client = app.arrClientFactory.create(instance);

	return {
		success: true,
		client,
		instance,
	};
}

/**
 * Get a typed Sonarr client for a specific instance
 */
export async function getSonarrClientForInstance(
	app: FastifyInstance,
	request: FastifyRequest,
	instanceId: string,
): Promise<
	| { success: true; client: SonarrClient; instance: ServiceInstance }
	| { success: false; error: string; statusCode: number }
> {
	const result = await getClientForInstance(app, request, instanceId);

	if (!result.success) {
		return result;
	}

	if (result.instance.service !== "SONARR") {
		return {
			success: false,
			error: "Instance is not a Sonarr instance",
			statusCode: 400,
		};
	}

	return {
		success: true,
		client: result.client as SonarrClient,
		instance: result.instance,
	};
}

/**
 * Get a typed Radarr client for a specific instance
 */
export async function getRadarrClientForInstance(
	app: FastifyInstance,
	request: FastifyRequest,
	instanceId: string,
): Promise<
	| { success: true; client: RadarrClient; instance: ServiceInstance }
	| { success: false; error: string; statusCode: number }
> {
	const result = await getClientForInstance(app, request, instanceId);

	if (!result.success) {
		return result;
	}

	if (result.instance.service !== "RADARR") {
		return {
			success: false,
			error: "Instance is not a Radarr instance",
			statusCode: 400,
		};
	}

	return {
		success: true,
		client: result.client as RadarrClient,
		instance: result.instance,
	};
}

/**
 * Get a typed Prowlarr client for a specific instance
 */
export async function getProwlarrClientForInstance(
	app: FastifyInstance,
	request: FastifyRequest,
	instanceId: string,
): Promise<
	| { success: true; client: ProwlarrClient; instance: ServiceInstance }
	| { success: false; error: string; statusCode: number }
> {
	const result = await getClientForInstance(app, request, instanceId);

	if (!result.success) {
		return result;
	}

	if (result.instance.service !== "PROWLARR") {
		return {
			success: false,
			error: "Instance is not a Prowlarr instance",
			statusCode: 400,
		};
	}

	return {
		success: true,
		client: result.client as ProwlarrClient,
		instance: result.instance,
	};
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
