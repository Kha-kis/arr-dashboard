import {
	providerNativeInventoryRequestSchema,
	providerNativeInventoryResponseSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { withIsolatedRuntimePrismaReadClient } from "../../lib/backup/restore-runtime-client.js";
import { withRuntimeReadTiming } from "../../lib/backup/restore-runtime-read-timing.js";
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
		let outcome: "available" | "unavailable" | "error" | "cancelled" = "error";
		const cancellation = new AbortController();
		const cancelDisconnectedRead = () => {
			if (!reply.raw.writableFinished)
				cancellation.abort(new Error("Provider inventory read cancelled"));
		};
		reply.raw.on("close", cancelDisconnectedRead);
		if (reply.raw.destroyed) cancelDisconnectedRead();
		try {
			let result: Awaited<ReturnType<typeof readProviderInventoryConnections>>;
			try {
				result = await withRuntimeReadTiming(
					async () => {
						try {
							return await readProviderInventoryConnections(
								app.prisma,
								{
									...query,
									userId: request.currentUser!.id,
									includeAttempt: true,
								},
								request.log,
								(timing) => {
									try {
										// Explicit projection and unbound logger: no inherited user ID,
										// request arguments, rows or errors enter diagnostic records.
										app.log.info(
											{
												category: "provider-inventory-read-subphase",
												domain: query.domain,
												stage: timing.stage,
												outcome: timing.outcome,
												elapsedMs: timing.elapsedMs,
											},
											"Provider inventory read subphase",
										);
									} catch {
										// Diagnostic failure cannot fail an otherwise valid read.
									}
								},
								(operation) =>
									withIsolatedRuntimePrismaReadClient(
										app.prisma,
										(prisma) => {
											admittedAt ??= performance.now();
											return operation(prisma);
										},
										{ signal: cancellation.signal },
									),
							);
						} finally {
							repositoryEndedAt = performance.now();
						}
					},
					(stages) => {
						app.log.info(
							{
								category: "provider-inventory-runtime-timing",
								domain: query.domain,
								spansOverlap: true,
								stages,
							},
							"Provider inventory runtime timing",
						);
					},
				);
			} finally {
				releasedAt = performance.now();
			}
			cancellation.signal.throwIfAborted();
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
		} catch (error) {
			if (cancellation.signal.aborted && error === cancellation.signal.reason) {
				outcome = "cancelled";
				return;
			}
			throw error;
		} finally {
			reply.raw.off("close", cancelDisconnectedRead);
			const endedAt = performance.now();
			try {
				// Admission covers first-phase setup/wait; repository includes later
				// phase waits. Each phase is released before the next. Post-read excludes
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
