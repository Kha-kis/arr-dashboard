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
