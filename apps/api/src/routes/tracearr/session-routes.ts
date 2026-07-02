import { tracearrTerminateRequestSchema } from "@arr/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createTracearrClient } from "../../lib/tracearr/client-factory.js";
import { requireTracearrInstance } from "../../lib/tracearr/instance-helpers.js";
import { validateRequest } from "../../lib/utils/validate.js";

const TERMINATE_PARAMS = z.object({
	id: z.string().min(1),
	streamId: z.string().min(1),
});

/**
 * Kill-session operator action (Tracearr-3, charter §2.1). Terminates a live
 * playback session on a specific Tracearr instance.
 *
 * The path carries BOTH ids because a session is only meaningful against the
 * Tracearr that owns it: `:id` is the arr-dashboard ServiceInstance (resolved
 * + ownership-checked via requireTracearrInstance — filters userId AND
 * service=TRACEARR), `:streamId` is Tracearr's own stream id. The optional
 * `reason` is forwarded by Tracearr to the terminated user's player.
 *
 * This is a destructive, user-visible action (it interrupts someone's
 * playback), so every attempt is logged with the operator, instance, stream,
 * and outcome. Errors from Tracearr (e.g. the session already ended → 404)
 * surface through TracearrApiError with the mapped status.
 */
export function registerTracearrSessionRoutes(app: FastifyInstance): void {
	app.post<{ Params: { id: string; streamId: string } }>(
		"/tracearr/instances/:id/streams/:streamId/terminate",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id, streamId } = validateRequest(TERMINATE_PARAMS, request.params);
			const { reason } = validateRequest(tracearrTerminateRequestSchema, request.body ?? {});

			const instance = await requireTracearrInstance(app, userId, id);
			const client = createTracearrClient(app, instance);

			try {
				const result = await client.terminateStream(streamId, { reason });
				request.log.info(
					{ userId, instanceId: id, streamId, hasReason: Boolean(reason), outcome: "success" },
					"tracearr session terminated",
				);
				return reply.send(result);
			} catch (error) {
				request.log.warn(
					{ userId, instanceId: id, streamId, err: error, outcome: "failed" },
					"tracearr session terminate failed",
				);
				throw error;
			}
		},
	);
}
