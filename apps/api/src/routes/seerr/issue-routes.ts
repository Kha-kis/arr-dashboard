/**
 * Seerr Issue Routes
 *
 * Endpoints for listing issues, adding comments, and updating issue status.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireSeerrClient } from "../../lib/seerr/seerr-client.js";
import { validateRequest } from "../../lib/utils/validate.js";

const instanceIdParams = z.object({ instanceId: z.string().min(1) });
const issueIdParams = z.object({ instanceId: z.string().min(1), issueId: z.coerce.number().int().positive() });

const listIssuesQuery = z.object({
	take: z.coerce.number().int().min(1).max(100).default(20),
	skip: z.coerce.number().int().min(0).default(0),
	filter: z.enum(["all", "open", "resolved"]).default("all"),
	sort: z.enum(["added", "modified"]).default("added"),
});

const addCommentBody = z.object({
	message: z.string().min(1).max(2000),
});

const updateStatusBody = z.object({
	status: z.enum(["open", "resolved"]),
});

export async function registerIssueRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	// GET /api/seerr/issues/:instanceId — List issues
	app.get("/:instanceId", async (request, reply) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const query = validateRequest(listIssuesQuery, request.query);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		const result = await client.getIssues(query);
		return reply.send(result);
	});

	// POST /api/seerr/issues/:instanceId/:issueId/comment — Add comment
	app.post("/:instanceId/:issueId/comment", async (request, reply) => {
		const { instanceId, issueId } = validateRequest(issueIdParams, request.params);
		const { message } = validateRequest(addCommentBody, request.body);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		const comment = await client.addIssueComment(issueId, message);
		return reply.send(comment);
	});

	// PUT /api/seerr/issues/:instanceId/:issueId — Update issue status
	app.put("/:instanceId/:issueId", async (request, reply) => {
		const { instanceId, issueId } = validateRequest(issueIdParams, request.params);
		const { status } = validateRequest(updateStatusBody, request.body);
		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);
		const issue = await client.updateIssueStatus(issueId, status);
		return reply.send(issue);
	});
}
