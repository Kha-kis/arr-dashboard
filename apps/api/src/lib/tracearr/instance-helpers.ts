import type { FastifyInstance } from "fastify";
import { InstanceNotFoundError } from "../errors.js";
import type { ServiceInstance } from "../prisma.js";

/**
 * Look up a Tracearr ServiceInstance by id, scoped to the requesting user.
 * Throws InstanceNotFoundError on miss (mapped to 404 by the centralised
 * handler in server.ts). The `service: "TRACEARR"` filter makes this safe
 * to call with a user-supplied id — it can never return a non-Tracearr row,
 * even if an ownership check is forgotten elsewhere. Mirrors
 * `requireQuiInstance` in `lib/qui/instance-helpers.ts`.
 */
export async function requireTracearrInstance(
	app: FastifyInstance,
	userId: string,
	instanceId: string,
): Promise<ServiceInstance> {
	const instance = await app.prisma.serviceInstance.findFirst({
		where: { id: instanceId, userId, service: "TRACEARR" },
	});

	if (!instance) {
		throw new InstanceNotFoundError(instanceId);
	}

	return instance;
}

/** List all enabled Tracearr instances for a user, oldest first. */
export async function listTracearrInstances(
	app: FastifyInstance,
	userId: string,
): Promise<ServiceInstance[]> {
	return app.prisma.serviceInstance.findMany({
		where: { userId, service: "TRACEARR", enabled: true },
		orderBy: { createdAt: "asc" },
	});
}

/**
 * Resolve the single Tracearr instance a statistics query should target.
 * Unlike the live-session aggregate (which fans out across instances),
 * paginated analytics (history / activity / stats) don't merge cleanly, so
 * these surfaces run against ONE hub instance: the caller-specified
 * `instanceId` when given (ownership-checked), otherwise the user's first
 * enabled Tracearr. Throws InstanceNotFoundError (→ 404) when none exists —
 * the frontend gates the tab on configuration, so that's a defensive path.
 */
export async function resolveTracearrInstance(
	app: FastifyInstance,
	userId: string,
	instanceId?: string,
): Promise<ServiceInstance> {
	if (instanceId) {
		return requireTracearrInstance(app, userId, instanceId);
	}
	const [first] = await listTracearrInstances(app, userId);
	if (!first) {
		throw new InstanceNotFoundError("tracearr");
	}
	return first;
}
