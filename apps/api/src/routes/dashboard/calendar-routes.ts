import {
	getCalendarAvailability,
	LIBRARY_SERVICES_UPPER,
	type MultiInstanceCalendarResponse,
	scheduledCalendarItemSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import {
	executeOnInstances,
	isLidarrClient,
	isRadarrClient,
	isReadarrClient,
	isSonarrClient,
} from "../../lib/arr/client-helpers.js";
import {
	type CalendarService,
	compareCalendarItems,
	formatDateOnly,
	normalizeCalendarItem,
} from "../../lib/dashboard/calendar-utils.js";
import { validateRequest } from "../../lib/utils/validate.js";

const calendarQuerySchema = z.object({
	start: z.string().optional(),
	end: z.string().optional(),
	unmonitored: z
		.preprocess((val) => val === true || val === "true" || val === "1", z.boolean())
		.optional(),
});

/**
 * Calendar-related routes for the dashboard
 */
export const calendarRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * GET /dashboard/calendar
	 * Fetches upcoming releases from all enabled Sonarr, Radarr, Lidarr, and Readarr instances
	 */
	app.get("/dashboard/calendar", async (request, reply) => {
		const { start, end, unmonitored } = validateRequest(calendarQuerySchema, request.query ?? {});
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

		// Request-local metadata keeps the shared helper's array aggregation contract intact.
		const coverage = new Map<
			string,
			Pick<
				MultiInstanceCalendarResponse["instances"][number],
				"availability" | "reason" | "rejectedItemCount"
			>
		>();
		const response = await executeOnInstances(
			app,
			request.currentUser!.id,
			{ serviceTypes: [...LIBRARY_SERVICES_UPPER] },
			async (client, instance) => {
				const service = instance.service.toLowerCase() as CalendarService;

				let rawResponse: unknown;

				try {
					if (isSonarrClient(client)) {
						rawResponse = await client.calendar.get({
							start: startIso,
							end: endIso,
							unmonitored: includeUnmonitored,
							includeSeries: true,
							includeEpisodeFile: true,
						});
					} else if (isRadarrClient(client)) {
						rawResponse = await client.calendar.get({
							start: startIso,
							end: endIso,
							unmonitored: includeUnmonitored,
						});
					} else if (isLidarrClient(client)) {
						rawResponse = await client.calendar.get({
							start: startIso,
							end: endIso,
							unmonitored: includeUnmonitored,
							includeArtist: true,
						});
					} else if (isReadarrClient(client)) {
						rawResponse = await client.calendar.get({
							start: startIso,
							end: endIso,
							unmonitored: includeUnmonitored,
							includeAuthor: true,
						});
					}
				} catch {
					coverage.set(instance.id, {
						availability: "unavailable",
						reason: "provider-unavailable",
						rejectedItemCount: 0,
					});
					return [];
				}
				if (!Array.isArray(rawResponse)) {
					coverage.set(instance.id, {
						availability: "unavailable",
						reason: "invalid-response",
						rejectedItemCount: 0,
					});
					return [];
				}
				let rawItems: unknown[] = rawResponse;
				rawResponse = undefined;

				// Reduce peak heap (issue #427 follow-up). Sonarr's calendar
				// payload with includeSeries+includeEpisodeFile inlines full
				// series metadata + episode files per item — easily 5–10 KB
				// per row. Drop each raw entry as soon as it's normalized so
				// only one copy of the data is alive at a time, instead of
				// raw + normalized for the duration of the closure.
				const items: ReturnType<typeof normalizeCalendarItem>[] = [];
				let rejectedItemCount = 0;
				for (let i = 0; i < rawItems.length; i++) {
					try {
						const parsed = scheduledCalendarItemSchema.safeParse({
							...normalizeCalendarItem(rawItems[i], service),
							instanceId: instance.id,
							instanceName: instance.label,
						});
						if (parsed.success) items.push(parsed.data);
						else rejectedItemCount++;
					} catch {
						rejectedItemCount++;
					} finally {
						rawItems[i] = null;
					}
				}
				rawItems = [];
				coverage.set(instance.id, {
					availability:
						rejectedItemCount === 0 ? "available" : items.length > 0 ? "partial" : "unavailable",
					reason: rejectedItemCount > 0 ? "invalid-items" : null,
					rejectedItemCount,
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
			...(coverage.get(result.instanceId) ?? {
				availability: "unavailable" as const,
				reason: "provider-unavailable" as const,
				rejectedItemCount: 0,
			}),
		}));

		return reply.send({
			instances: results,
			aggregated: response.aggregated,
			totalCount: response.totalCount,
			availability: getCalendarAvailability(results),
		});
	});

	done();
};
