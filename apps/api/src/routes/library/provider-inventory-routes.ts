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
		const startedAt = performance.now();
		let admittedAt: number | undefined;
		let repositoryEndedAt: number | undefined;
		let releasedAt: number | undefined;
		let outcome: "available" | "unavailable" | "error" = "error";
		try {
			let result: Awaited<ReturnType<typeof readProviderInventoryConnections>>;
			try {
				result = await withIsolatedRuntimePrismaReadClient(app.prisma, async (prisma) => {
					admittedAt = performance.now();
					try {
						return await readProviderInventoryConnections(
							prisma,
							{
								...query,
								userId: request.currentUser!.id,
								includeAttempt: true,
							},
							request.log,
						);
					} finally {
						repositoryEndedAt = performance.now();
					}
				});
			} finally {
				releasedAt = performance.now();
			}
			if (result.status === "unavailable") {
				if (result.reason === "not-owned") {
					outcome = "unavailable";
					return reply.status(404).send({ error: "Instance not found" });
				}
				const response = providerNativeInventoryResponseSchema.parse(result);
				outcome = "unavailable";
				return response;
			}
			const response = providerNativeInventoryResponseSchema.parse({
				...result,
				observedAt: result.observedAt.toISOString(),
				lastAttemptAt: result.lastAttemptAt?.toISOString() ?? null,
			});
			outcome = "available";
			return response;
		} finally {
			const endedAt = performance.now();
			try {
				// Admission includes guarded-client setup/wait; post-read excludes
				// socket delivery. Use the unbound app logger: request.log inherits
				// the authenticated user ID. Never log query arguments, rows or errors.
				app.log.info(
					{
						category: "provider-inventory-read-timing",
						domain: query.domain,
						outcome,
						readAdmissionMs: Math.max(
							0,
							Math.round((admittedAt ?? releasedAt ?? endedAt) - startedAt),
						),
						repositoryMs:
							admittedAt === undefined
								? 0
								: Math.max(0, Math.round((repositoryEndedAt ?? endedAt) - admittedAt)),
						releaseMs:
							repositoryEndedAt === undefined
								? 0
								: Math.max(0, Math.round((releasedAt ?? endedAt) - repositoryEndedAt)),
						postReadMs: Math.max(0, Math.round(endedAt - (releasedAt ?? endedAt))),
						totalMs: Math.max(0, Math.round(endedAt - startedAt)),
					},
					"Provider inventory read timing",
				);
			} catch {
				// Diagnostics cannot change a response or hide its original failure.
			}
		}
	});
	done();
};
