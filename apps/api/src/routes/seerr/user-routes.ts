/**
 * Seerr User Routes
 *
 * Endpoints for listing Seerr users, viewing quotas, and updating permissions.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireSeerrClient } from "../../lib/seerr/seerr-client.js";
import { validateRequest } from "../../lib/utils/validate.js";

const instanceIdParams = z.object({ instanceId: z.string().min(1) });
const userIdParams = z.object({ instanceId: z.string().min(1), seerrUserId: z.coerce.number().int().positive() });

const listUsersQuery = z.object({
	take: z.coerce.number().int().min(1).max(100).default(20),
	skip: z.coerce.number().int().min(0).default(0),
	sort: z.enum(["created", "updated", "displayname", "requests"]).default("created"),
});

const updateUserBody = z.object({
	permissions: z.number().int().optional(),
	movieQuotaLimit: z.number().int().nullable().optional(),
	movieQuotaDays: z.number().int().nullable().optional(),
	tvQuotaLimit: z.number().int().nullable().optional(),
	tvQuotaDays: z.number().int().nullable().optional(),
});

export async function registerUserRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	// GET /api/seerr/users/:instanceId — List users
	app.get("/:instanceId", async (request, reply) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const query = validateRequest(listUsersQuery, request.query);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		const result = await client.getUsers(query);
		return reply.send(result);
	});

	// GET /api/seerr/users/:instanceId/:seerrUserId/quota — User quota usage
	app.get("/:instanceId/:seerrUserId/quota", async (request, reply) => {
		const { instanceId, seerrUserId } = validateRequest(userIdParams, request.params);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		const quota = await client.getUserQuota(seerrUserId);
		return reply.send(quota);
	});

	// PUT /api/seerr/users/:instanceId/:seerrUserId — Update user
	app.put("/:instanceId/:seerrUserId", async (request, reply) => {
		const { instanceId, seerrUserId } = validateRequest(userIdParams, request.params);
		const body = validateRequest(updateUserBody, request.body);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		const user = await client.updateUser(seerrUserId, body);
		return reply.send(user);
	});
}
