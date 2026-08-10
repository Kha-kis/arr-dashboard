import type { FastifyInstance, FastifyRequest } from "fastify";
import { acquireCleanupOperationGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Keep backup restore mutually exclusive with every mutating TRaSH HTTP request. */
export function registerTrashGuidesMaintenanceHooks(app: FastifyInstance): void {
	const releases = new WeakMap<FastifyRequest, () => void>();
	const release = (request: FastifyRequest) => {
		releases.get(request)?.();
		releases.delete(request);
	};

	app.addHook("onRequest", async (request) => {
		if (!MUTATING_METHODS.has(request.method)) return;
		releases.set(request, acquireCleanupOperationGuard());
	});
	app.addHook("onResponse", async (request) => release(request));
	app.addHook("onError", async (request) => release(request));
	app.addHook("onTimeout", async (request) => release(request));
	app.addHook("onRequestAbort", async (request) => release(request));
}
