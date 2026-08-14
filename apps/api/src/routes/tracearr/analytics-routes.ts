import type {
	TracearrHistoryBundle,
	TracearrStatsBundle,
	TracearrUsersBundle,
	TracearrViolationsBundle,
} from "@arr/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
	AnalyticsProviderSelectionMismatchError,
	requireSelectedAnalyticsProvider,
} from "../../lib/analytics/provider-selection.js";
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

const page = z.coerce.number().int().min(1).optional();
const pageSize = z.coerce.number().int().min(1).max(100).optional();

const HISTORY_QUERY = z.object({
	instanceId: z.string().min(1).optional(),
	page,
	pageSize,
	mediaType: z.enum(["movie", "episode", "track", "live", "photo", "unknown"]).optional(),
});

const USERS_QUERY = z.object({
	instanceId: z.string().min(1).optional(),
	page,
	pageSize,
});

const VIOLATIONS_QUERY = z.object({
	instanceId: z.string().min(1).optional(),
	page,
	pageSize,
	severity: z.enum(["low", "warning", "high"]).optional(),
	// Query strings are text — z.coerce.boolean() would turn "false" into true
	// (Boolean("false") === true), so parse the literal instead.
	acknowledged: z
		.enum(["true", "false"])
		.transform((v) => v === "true")
		.optional(),
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
		if (!(await requireTracearrAnalyticsProvider(app, userId, reply))) return;
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
		if (!(await requireTracearrAnalyticsProvider(app, userId, reply))) return;
		const instance = await resolveTracearrInstance(app, userId, instanceId);
		const client = createTracearrClient(app, instance);

		const activity = await client.getActivity({ period, timezone });
		return reply.send({ instanceId: instance.id, instanceLabel: instance.label, activity });
	});

	app.get("/tracearr/history", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { instanceId, page, pageSize, mediaType } = validateRequest(HISTORY_QUERY, request.query);
		if (!(await requireTracearrAnalyticsProvider(app, userId, reply))) return;
		const instance = await resolveTracearrInstance(app, userId, instanceId);
		const client = createTracearrClient(app, instance);

		const history = await client.getHistory({ page, pageSize, mediaType });
		const bundle: TracearrHistoryBundle = {
			instanceId: instance.id,
			instanceLabel: instance.label,
			history,
		};
		return reply.send(bundle);
	});

	app.get("/tracearr/users", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { instanceId, page, pageSize } = validateRequest(USERS_QUERY, request.query);
		if (!(await requireTracearrAnalyticsProvider(app, userId, reply))) return;
		const instance = await resolveTracearrInstance(app, userId, instanceId);
		const client = createTracearrClient(app, instance);

		const users = await client.getUsers({ page, pageSize });
		const bundle: TracearrUsersBundle = {
			instanceId: instance.id,
			instanceLabel: instance.label,
			users,
		};
		return reply.send(bundle);
	});

	app.get("/tracearr/violations", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { instanceId, page, pageSize, severity, acknowledged } = validateRequest(
			VIOLATIONS_QUERY,
			request.query,
		);
		if (!(await requireTracearrAnalyticsProvider(app, userId, reply))) return;
		const instance = await resolveTracearrInstance(app, userId, instanceId);
		const client = createTracearrClient(app, instance);

		const violations = await client.getViolations({ page, pageSize, severity, acknowledged });
		const bundle: TracearrViolationsBundle = {
			instanceId: instance.id,
			instanceLabel: instance.label,
			violations,
		};
		return reply.send(bundle);
	});
}

async function requireTracearrAnalyticsProvider(
	app: FastifyInstance,
	userId: string,
	reply: FastifyReply,
): Promise<boolean> {
	try {
		await requireSelectedAnalyticsProvider(app.prisma, userId, "tracearr");
		return true;
	} catch (error) {
		if (error instanceof AnalyticsProviderSelectionMismatchError) {
			reply.status(409).send({
				error: "ANALYTICS_PROVIDER_NOT_SELECTED",
				expected: error.expected,
				actual: error.actual,
			});
			return false;
		}
		throw error;
	}
}
