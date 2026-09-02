import type { FastifyInstance, HTTPMethods, RouteHandlerMethod } from "fastify";
import { withCleanupOperationGuard } from "../library-cleanup/cleanup-maintenance-gate.js";

const MUTATING_METHODS = new Set<HTTPMethods>(["DELETE", "PATCH", "POST", "PUT"]);

declare module "fastify" {
	interface FastifyContextConfig {
		/** The handler performs a durable write despite using a read HTTP method. */
		backupMutation?: boolean;
	}
}

/** Serialize every HTTP mutation handler against backup creation and restore. */
export function registerBackupMutationGuard(app: FastifyInstance): void {
	app.addHook("onRoute", (routeOptions) => {
		const methods = Array.isArray(routeOptions.method)
			? routeOptions.method
			: [routeOptions.method];
		const mutatesDurableState =
			routeOptions.config?.backupMutation === true ||
			methods.some((method) => MUTATING_METHODS.has(method));
		if (!mutatesDurableState) return;

		const handler = routeOptions.handler;
		routeOptions.handler = function guardedBackupMutation(request, reply) {
			return withCleanupOperationGuard(async () => handler.call(this, request, reply));
		} as RouteHandlerMethod;
	});
}
