import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createTracearrClient } from "../../lib/tracearr/client-factory.js";
import {
	listTracearrInstances,
	requireTracearrInstance,
} from "../../lib/tracearr/instance-helpers.js";
import { validateRequest } from "../../lib/utils/validate.js";

const TRACEARR_INSTANCE_PARAM = z.object({ id: z.string().min(1) });

/**
 * Tracearr instance routes — the foundation surface (charter §2.2 /
 * ADR-0007). Instance CRUD + connection testing runs through the generic
 * `/api/services` routes (Tracearr is a ServiceInstance like any other), so
 * this group owns only Tracearr-specific typed reads. In this phase that's:
 *   - listing the user's Tracearr instances
 *   - a typed `/health` probe that exercises the full client stack end to
 *     end (decrypt key → Bearer request → Zod boundary), proving the
 *     integration works through a registered route.
 *
 * The data surfaces (live streams, watch history, kill-session) land in
 * Tracearr-2 / Tracearr-3 / C2 as sibling files under this same group.
 */
export function registerTracearrInstanceRoutes(app: FastifyInstance): void {
	app.get("/tracearr/instances", async (request, reply) => {
		const userId = request.currentUser!.id;
		const instances = await listTracearrInstances(app, userId);
		return reply.send({
			instances: instances.map((i) => ({
				id: i.id,
				label: i.label,
				baseUrl: i.baseUrl,
				externalUrl: i.externalUrl,
				enabled: i.enabled,
				isDefault: i.isDefault,
			})),
		});
	});

	app.get<{ Params: { id: string } }>("/tracearr/instances/:id/health", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(TRACEARR_INSTANCE_PARAM, request.params);
		const instance = await requireTracearrInstance(app, userId, id);
		const client = createTracearrClient(app, instance);
		const health = await client.getHealth();
		return reply.send({ health });
	});
}
