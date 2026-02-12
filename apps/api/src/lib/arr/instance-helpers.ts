import type { Prisma, ServiceInstance } from "../prisma.js";
import type { FastifyInstance } from "fastify";
import { InstanceNotFoundError } from "../errors.js";

type ServiceInstanceFindFirstArgs = Prisma.ServiceInstanceFindFirstArgs;

/**
 * Verify that a service instance exists and is owned by the given user.
 * Throws {@link InstanceNotFoundError} if not found, which the centralized
 * error handler in server.ts maps to a 404 response.
 *
 * When an `include` argument is provided, the return type is automatically
 * narrowed to include the related models (e.g. `{ huntConfig: true }`
 * returns a type with `huntConfig` populated).
 */
export async function requireInstance<
	I extends Prisma.ServiceInstanceInclude | undefined = undefined,
>(
	app: FastifyInstance,
	userId: string,
	instanceId: string,
	include?: I,
): Promise<
	I extends Prisma.ServiceInstanceInclude
		? Prisma.ServiceInstanceGetPayload<{ include: I }>
		: ServiceInstance
> {
	const args: ServiceInstanceFindFirstArgs = {
		where: { id: instanceId, userId },
	};
	if (include) {
		args.include = include;
	}

	const instance = await app.prisma.serviceInstance.findFirst(args);

	if (!instance) {
		throw new InstanceNotFoundError(instanceId);
	}

	// biome-ignore lint/suspicious/noExplicitAny: Prisma's conditional payload type requires cast
	return instance as any;
}

/**
 * Same as {@link requireInstance} but also requires the instance to be enabled.
 * Used by client-creation paths where a disabled instance should be treated as absent.
 */
export async function requireEnabledInstance<
	I extends Prisma.ServiceInstanceInclude | undefined = undefined,
>(
	app: FastifyInstance,
	userId: string,
	instanceId: string,
	include?: I,
): Promise<
	I extends Prisma.ServiceInstanceInclude
		? Prisma.ServiceInstanceGetPayload<{ include: I }>
		: ServiceInstance
> {
	const args: ServiceInstanceFindFirstArgs = {
		where: { id: instanceId, userId, enabled: true },
	};
	if (include) {
		args.include = include;
	}

	const instance = await app.prisma.serviceInstance.findFirst(args);

	if (!instance) {
		throw new InstanceNotFoundError(instanceId);
	}

	// biome-ignore lint/suspicious/noExplicitAny: Prisma's conditional payload type requires cast
	return instance as any;
}
