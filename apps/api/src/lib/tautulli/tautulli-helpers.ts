/**
 * Tautulli Client Helpers
 *
 * Common patterns for working with Tautulli clients across multiple instances.
 * Mirrors the executeOnInstances pattern from arr/client-helpers.ts.
 */

import type { FastifyInstance } from "fastify";
import { AppValidationError, InstanceNotFoundError } from "../errors.js";
import type { ServiceInstance } from "../prisma.js";
import {
	createProviderPublicationAuthority,
	sameProviderPublicationAuthority,
} from "../services/provider-identity-guard.js";
import { getErrorMessage } from "../utils/error-message.js";
import { createTautulliClient, type TautulliClient } from "./tautulli-client.js";

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

export type TautulliInstanceOperationResult<T> = TautulliInstanceResult<T> | TautulliInstanceError;

export interface TautulliMultiInstanceResponse<T> {
	instances: Array<TautulliInstanceOperationResult<T>>;
	aggregated: T[];
	totalCount: number;
	errorCount: number;
}

function hasVerifiedTautulliIdentity(
	instance: Pick<ServiceInstance, "enabled" | "identityStatus" | "expectedIdentity">,
): boolean {
	return (
		instance.enabled &&
		instance.identityStatus === "VERIFIED" &&
		typeof instance.expectedIdentity === "string" &&
		instance.expectedIdentity.trim() !== ""
	);
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
		where: {
			id: instanceId,
			userId,
			enabled: true,
			identityStatus: "VERIFIED",
			expectedIdentity: { not: "" },
		},
	});

	if (!instance) {
		throw new InstanceNotFoundError(instanceId);
	}
	if (!hasVerifiedTautulliIdentity(instance)) {
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
	const candidateInstances = await app.prisma.serviceInstance.findMany({
		where: {
			userId,
			service: "TAUTULLI",
			enabled: true,
			identityStatus: "VERIFIED",
			expectedIdentity: { not: "" },
		},
		select: { id: true },
		orderBy: { label: "asc" },
	});

	const results = await Promise.all(
		candidateInstances.map(
			async (candidate): Promise<TautulliInstanceOperationResult<T> | null> => {
				const instance = await app.prisma.serviceInstance.findFirst({
					where: {
						id: candidate.id,
						userId,
						service: "TAUTULLI",
						enabled: true,
						identityStatus: "VERIFIED",
						expectedIdentity: { not: "" },
					},
				});
				if (!instance || !hasVerifiedTautulliIdentity(instance)) return null;

				const authority = createProviderPublicationAuthority(instance);
				try {
					const client = createTautulliClient(app.encryptor, instance, app.log);
					const data = await operation(client, instance);
					const current = await app.prisma.serviceInstance.findFirst({
						where: {
							id: candidate.id,
							userId,
							service: "TAUTULLI",
							enabled: true,
							identityStatus: "VERIFIED",
							expectedIdentity: { not: "" },
						},
					});
					if (
						!current ||
						!hasVerifiedTautulliIdentity(current) ||
						!sameProviderPublicationAuthority(
							authority,
							createProviderPublicationAuthority(current),
						)
					) {
						return null;
					}

					return {
						instanceId: current.id,
						instanceName: current.label,
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
			},
		),
	);
	const completedResults = results.filter(
		(result): result is TautulliInstanceOperationResult<T> => result !== null,
	);

	const successfulResults = completedResults.filter(
		(r): r is TautulliInstanceResult<T> => r.success,
	);
	const aggregated = successfulResults.flatMap((r) => (Array.isArray(r.data) ? r.data : [r.data]));
	const errorCount = completedResults.filter((r) => !r.success).length;

	return {
		instances: completedResults,
		aggregated,
		totalCount: aggregated.length,
		errorCount,
	};
}
