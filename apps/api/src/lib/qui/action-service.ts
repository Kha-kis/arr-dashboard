/** Bulk-action adapter over the shared durable qUI action executor. */

import { type QuiAction, type QuiActionPayload, quiActionPayloadSchemas } from "@arr/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { QuiClient } from "./client-factory.js";
import { type ExecuteQuiActionResult, executeQuiFencedAction } from "./fenced-action-executor.js";

export type { ExecuteQuiActionResult } from "./fenced-action-executor.js";

export interface ExecuteQuiActionArgs {
	app: FastifyInstance;
	client: QuiClient;
	userId: string;
	serviceInstanceId: string;
	qbitInstanceId: number;
	hashes: string[];
	action: QuiAction;
	payload?: QuiActionPayload;
	log?: FastifyBaseLogger;
}

export async function executeQuiAction(
	args: ExecuteQuiActionArgs,
): Promise<ExecuteQuiActionResult> {
	const parsedPayload = quiActionPayloadSchemas[args.action].safeParse(args.payload ?? {});
	if (!parsedPayload.success) {
		return { logRowCount: 0, status: "failed", error: "qUI action payload is invalid" };
	}
	const actionPayload = parsedPayload.data as QuiActionPayload;
	if (
		args.action === "delete" &&
		"deleteFiles" in actionPayload &&
		actionPayload.deleteFiles === true
	) {
		return {
			logRowCount: 0,
			status: "failed",
			error: "qUI file deletion is unavailable until shared-storage ownership is verified",
		};
	}
	const hasExtras = Object.keys(actionPayload).length > 0;
	return executeQuiFencedAction({
		...args,
		auditPayload: hasExtras ? actionPayload : null,
		prepareDispatch: async () => async () => {
			await args.client.bulkAction({
				qbitInstanceId: args.qbitInstanceId,
				hashes: args.hashes,
				action: args.action,
				extras: hasExtras ? (actionPayload as Record<string, unknown>) : undefined,
			});
		},
	});
}
