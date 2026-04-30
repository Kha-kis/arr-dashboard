/**
 * Auto-Tagger Inbound Webhook Routes (PUBLIC — no session auth).
 *
 * Sonarr/Radarr Connect cannot send a session cookie, so the webhook
 * endpoint is mounted in `PUBLIC_ROUTE_GROUPS` and authenticates via a
 * Bearer token (the user's hashed webhook secret). The session-protected
 * endpoints for managing the secret (`GET/POST /webhook-config`) live in
 * the regular auto-tag routes file.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { processWebhook, resolveUserFromBearer } from "../lib/auto-tag/webhook-handler.js";
import { validateRequest } from "../lib/utils/validate.js";

const ruleParams = z.object({ instanceId: z.string().min(1) });

export async function registerAutoTagWebhookRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	app.post("/:instanceId", async (request, reply) => {
		const { instanceId } = validateRequest(ruleParams, request.params);

		const authHeader = (request.headers.authorization as string | undefined) ?? undefined;
		const user = await resolveUserFromBearer(app.prisma, authHeader);
		if (!user) {
			return reply.status(401).send({ error: "Invalid or missing webhook secret" });
		}

		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId: user.id, enabled: true },
		});
		if (!instance) {
			return reply.status(404).send({ error: "Instance not found or disabled" });
		}

		const result = await processWebhook({
			deps: {
				prisma: app.prisma,
				arrClientFactory: app.arrClientFactory,
				encryptor: app.encryptor,
				log: request.log,
			},
			user,
			instance,
			payload: request.body,
		});

		const code = result.status === "error" ? 400 : result.status === "ignored" ? 202 : 200;
		return reply.status(code).send(result);
	});
}
