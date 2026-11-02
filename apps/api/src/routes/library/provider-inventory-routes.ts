import {
	providerNativeInventoryRequestSchema,
	providerNativeInventoryResponseSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { withIsolatedRuntimePrismaReadClient } from "../../lib/backup/restore-runtime-client.js";
import { readProviderInventoryConnections } from "../../lib/provider-observation/inventory-connection-repository.js";
import { validateRequest } from "../../lib/utils/validate.js";

/** Published provider presence only; this route never contacts or changes a provider. */
export const registerProviderInventoryRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/library/provider-inventory", async (request, reply) => {
		const query = validateRequest(providerNativeInventoryRequestSchema, request.query);
		const result = await withIsolatedRuntimePrismaReadClient(app.prisma, (prisma) =>
			readProviderInventoryConnections(
				prisma,
				{
					...query,
					userId: request.currentUser!.id,
					includeAttempt: true,
				},
				request.log,
			),
		);
		if (result.status === "unavailable") {
			if (result.reason === "not-owned")
				return reply.status(404).send({ error: "Instance not found" });
			return providerNativeInventoryResponseSchema.parse(result);
		}
		return providerNativeInventoryResponseSchema.parse({
			...result,
			observedAt: result.observedAt.toISOString(),
			lastAttemptAt: result.lastAttemptAt?.toISOString() ?? null,
		});
	});
	done();
};
