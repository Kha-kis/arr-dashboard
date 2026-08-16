/** Common owned-instance helpers for Tautulli's query-authenticated API client. */

import type { TautulliHistoryItem, TautulliHistorySnapshot } from "@arr/shared";
import type { FastifyInstance } from "fastify";
import { AppValidationError, InstanceNotFoundError } from "../errors.js";
import type { ServiceInstance } from "../prisma.js";
import { getErrorMessage } from "../utils/error-message.js";
import { createTautulliClient, type TautulliClient } from "./tautulli-client.js";

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

export function createTautulliHistorySnapshot(
	items: TautulliHistoryItem[],
	recordsFiltered: number,
	recordsTotal: number,
	complete: boolean,
	incompleteReason?: TautulliHistorySnapshot["incompleteReason"],
): TautulliHistorySnapshot {
	return {
		items,
		recordsFiltered,
		recordsTotal,
		complete,
		...(incompleteReason ? { incompleteReason } : {}),
	};
}

export async function requireTautulliClient(
	app: FastifyInstance,
	userId: string,
	instanceId: string,
): Promise<{ client: TautulliClient; instance: ServiceInstance }> {
	const instance = await app.prisma.serviceInstance.findFirst({
		where: { id: instanceId, userId, enabled: true },
	});

	if (!instance) throw new InstanceNotFoundError(instanceId);
	if (instance.service !== "TAUTULLI") {
		throw new AppValidationError("Instance is not a Tautulli service");
	}

	return { client: createTautulliClient(app.encryptor, instance, app.log), instance };
}

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
				return {
					instanceId: instance.id,
					instanceName: instance.label,
					success: true,
					data: await operation(createTautulliClient(app.encryptor, instance, app.log), instance),
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
		(result): result is TautulliInstanceResult<T> => result.success,
	);
	const aggregated = successfulResults.flatMap((result) =>
		Array.isArray(result.data) ? result.data : [result.data],
	);

	return {
		instances: results,
		aggregated,
		totalCount: aggregated.length,
		errorCount: results.filter((result) => !result.success).length,
	};
}
