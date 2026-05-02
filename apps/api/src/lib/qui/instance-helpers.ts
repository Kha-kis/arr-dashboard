import type { FastifyInstance } from "fastify";
import { InstanceNotFoundError } from "../errors.js";
import type { ServiceInstance } from "../prisma.js";

/**
 * Look up a qui ServiceInstance by id, scoped to the requesting user.
 * Throws InstanceNotFoundError on miss; the centralised error handler
 * in server.ts maps that to 404 (same shape as the *arr counterpart in
 * `lib/arr/instance-helpers.ts`).
 *
 * The `service: "QUI"` filter is what makes this function safe to call
 * with a user-supplied id — even if a caller forgets the ownership
 * check elsewhere, this query can never return a non-qui instance.
 */
export async function requireQuiInstance(
	app: FastifyInstance,
	userId: string,
	instanceId: string,
): Promise<ServiceInstance> {
	const instance = await app.prisma.serviceInstance.findFirst({
		where: { id: instanceId, userId, service: "QUI" },
	});

	if (!instance) {
		throw new InstanceNotFoundError(instanceId);
	}

	return instance;
}

/** List all qui instances for a user, ordered by creation. */
export async function listQuiInstances(
	app: FastifyInstance,
	userId: string,
): Promise<ServiceInstance[]> {
	return app.prisma.serviceInstance.findMany({
		where: { userId, service: "QUI", enabled: true },
		orderBy: { createdAt: "asc" },
	});
}
