import { calendarItemSchema } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import {
	executeOnInstances,
	isSonarrClient,
	isRadarrClient,
	isLidarrClient,
	isReadarrClient,
} from "../../lib/arr/client-helpers.js";
import {
	formatDateOnly,
	normalizeCalendarItem,
	compareCalendarItems,
	type CalendarService,
} from "../../lib/dashboard/calendar-utils.js";

const calendarQuerySchema = z.object({
	start: z.string().optional(),
	end: z.string().optional(),
	unmonitored: z.coerce.boolean().optional(),
});

/**
 * Calendar-related routes for the dashboard
 */
export const calendarRoutes: FastifyPluginCallback = (app, _opts, done) => {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser!.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	/**
	 * GET /dashboard/calendar
	 * Fetches upcoming releases from all enabled Sonarr, Radarr, Lidarr, and Readarr instances
	 */
	app.get("/dashboard/calendar", async (request, reply) => {
		const { start, end, unmonitored } = calendarQuerySchema.parse(request.query ?? {});
		const now = new Date();
		const defaultStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

		const ensureDate = (value: string | undefined, fallback: Date): Date => {
			if (!value) {
				return new Date(fallback);
			}
			const parsed = new Date(value);
			return Number.isNaN(parsed.getTime()) ? new Date(fallback) : parsed;
		};

		const startDate = ensureDate(start, defaultStart);
		const defaultEnd = new Date(
			Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 0),
		);
		const endDate = ensureDate(end, defaultEnd);
		if (endDate.getTime() < startDate.getTime()) {
			endDate.setTime(startDate.getTime());
		}

		const startIso = formatDateOnly(startDate);
		const endIso = formatDateOnly(endDate);
		const includeUnmonitored = unmonitored === true;

		const response = await executeOnInstances(
			app,
			request.currentUser!.id,
			{ serviceTypes: ["SONARR", "RADARR", "LIDARR", "READARR"] },
			async (client, instance) => {
				const service = instance.service.toLowerCase() as CalendarService;

				let rawItems: unknown[] = [];

				if (isSonarrClient(client)) {
					rawItems = await client.calendar.get({
						start: startIso,
						end: endIso,
						unmonitored: includeUnmonitored,
						includeSeries: true,
						includeEpisodeFile: true,
					});
				} else if (isRadarrClient(client)) {
					rawItems = await client.calendar.get({
						start: startIso,
						end: endIso,
						unmonitored: includeUnmonitored,
					});
				} else if (isLidarrClient(client)) {
					rawItems = await client.calendar.get({
						start: startIso,
						end: endIso,
						unmonitored: includeUnmonitored,
						includeArtist: true,
					});
				} else if (isReadarrClient(client)) {
					rawItems = await client.calendar.get({
						start: startIso,
						end: endIso,
						unmonitored: includeUnmonitored,
						includeAuthor: true,
					});
				}

				// Normalize and enrich items
				const items = rawItems.map((raw) => {
					const normalized = normalizeCalendarItem(raw, service);
					return calendarItemSchema.parse({
						...normalized,
						instanceId: instance.id,
						instanceName: instance.label,
					});
				});

				// Sort by date
				items.sort(compareCalendarItems);

				return items;
			},
		);

		// Transform results to match expected format
		const results = response.instances.map((result) => ({
			instanceId: result.instanceId,
			instanceName: result.instanceName,
			service: result.service as CalendarService,
			data: result.success ? result.data : [],
		}));

		return reply.send({
			instances: results,
			aggregated: response.aggregated,
			totalCount: response.totalCount,
		});
	});

	done();
};
