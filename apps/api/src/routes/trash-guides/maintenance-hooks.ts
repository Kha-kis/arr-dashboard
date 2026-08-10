import type { FastifyInstance, RouteHandlerMethod } from "fastify";
import { acquireCleanupOperationGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Keep backup restore mutually exclusive with every mutating TRaSH HTTP request. */
export function registerTrashGuidesMaintenanceHooks(app: FastifyInstance): void {
	app.addHook("onRoute", (routeOptions) => {
		const methods = Array.isArray(routeOptions.method)
			? routeOptions.method
			: [routeOptions.method];
		if (!methods.some((method) => MUTATING_METHODS.has(method))) return;

		const handler = routeOptions.handler;
		const guardedHandler: RouteHandlerMethod = async function (request, reply) {
			const release = acquireCleanupOperationGuard();
			try {
				return await handler.call(this, request, reply);
			} finally {
				// A timeout or socket abort does not cancel the handler's upstream
				// work. Ownership is released only when the handler promise settles.
				release();
			}
		};
		routeOptions.handler = guardedHandler;
	});
}
