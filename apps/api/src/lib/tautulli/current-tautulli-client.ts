import type { FastifyInstance } from "fastify";
import type { ServiceInstance } from "../prisma.js";
import {
	matchesProviderConnectionIdentity,
	providerConnectionIdentity,
} from "../services/provider-connection-guard.js";
import {
	createTautulliClient,
	type TautulliClient,
	type TautulliClientInstanceData,
} from "./tautulli-client.js";

export class TautulliConnectionChangedError extends Error {
	constructor() {
		super("Tautulli connection changed during request");
		this.name = "TautulliConnectionChangedError";
	}
}

export function isTautulliConnectionChanged(error: unknown): boolean {
	return error instanceof TautulliConnectionChangedError;
}

export function createCurrentTautulliClient(
	app: Pick<FastifyInstance, "encryptor" | "prisma" | "log">,
	instance: ServiceInstance,
): { client: TautulliClient; ensureCurrent: () => Promise<void> } {
	const expected = providerConnectionIdentity(instance);
	const ensureCurrent = async (): Promise<void> => {
		const current = await app.prisma.serviceInstance.findFirst({
			where: {
				id: instance.id,
				userId: expected.userId,
				service: "TAUTULLI",
				enabled: true,
			},
		});
		if (!current || !matchesProviderConnectionIdentity(current, expected)) {
			throw new TautulliConnectionChangedError();
		}
	};

	return {
		client: createTautulliClient(
			app.encryptor,
			instance as TautulliClientInstanceData,
			app.log,
			ensureCurrent,
		),
		ensureCurrent,
	};
}
