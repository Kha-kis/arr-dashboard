import type { TracearrStatsBundle } from "@arr/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createTracearrClient } from "../../lib/tracearr/client-factory.js";
import { resolveTracearrInstance } from "../../lib/tracearr/instance-helpers.js";
import { validateRequest } from "../../lib/utils/validate.js";

const STATS_QUERY = z.object({
	instanceId: z.string().min(1).optional(),
});

const ACTIVITY_QUERY = z.object({
	instanceId: z.string().min(1).optional(),
	period: z.enum(["week", "month", "year"]).optional(),
	timezone: z.string().min(1).max(64).optional(),
});

/**
 * Tracearr analytics routes for the Statistics "Tracearr" tab (charter C2).
 *
 * These surface Tracearr's deep, cross-server watch analytics — complementary
 * to the SessionSnapshot-backed per-server Plex/Jellyfin tabs (which already
 * work post-Tautulli). Unlike the live-session aggregate, analytics target a
 * SINGLE Tracearr instance (paginated/time-series data doesn't merge across
 * instances): the caller may pass `?instanceId=`, else the user's first
 * enabled Tracearr is used (resolveTracearrInstance, ownership-checked).
 */
export function registerTracearrAnalyticsRoutes(app: FastifyInstance): void {
	app.get("/tracearr/stats", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { instanceId } = validateRequest(STATS_QUERY, request.query);
		const instance = await resolveTracearrInstance(app, userId, instanceId);
		const client = createTracearrClient(app, instance);

		// Both counters come from the same instance; fetch concurrently.
		const [stats, today] = await Promise.all([client.getStats(), client.getStatsToday()]);

		const bundle: TracearrStatsBundle = {
			instanceId: instance.id,
			instanceLabel: instance.label,
			stats,
			today,
		};
		return reply.send(bundle);
	});

	app.get("/tracearr/activity", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { instanceId, period, timezone } = validateRequest(ACTIVITY_QUERY, request.query);
		const instance = await resolveTracearrInstance(app, userId, instanceId);
		const client = createTracearrClient(app, instance);

		const activity = await client.getActivity({ period, timezone });
		return reply.send({ instanceId: instance.id, instanceLabel: instance.label, activity });
	});
}
