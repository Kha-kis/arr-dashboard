import { calendarItemSchema } from "@arr/shared";
import type { CalendarItem } from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { createInstanceFetcher } from "../../lib/arr/arr-fetcher.js";
import { formatDateOnly } from "../../lib/dashboard/calendar-utils.js";
import { fetchCalendarItems } from "../../lib/dashboard/fetch-utils.js";

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
		if (!request.currentUser?.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	/**
	 * GET /dashboard/calendar
	 * Fetches upcoming releases from all enabled Sonarr and Radarr instances
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

		const instances = await app.prisma.serviceInstance.findMany({
			where: { enabled: true },
		});

		const results: Array<{
			instanceId: string;
			instanceName: string;
			service: "sonarr" | "radarr";
			data: CalendarItem[];
		}> = [];
		const aggregated: CalendarItem[] = [];

		for (const instance of instances) {
			const service = instance.service.toLowerCase();
			if (service !== "sonarr" && service !== "radarr") {
				continue;
			}

			try {
				const fetcher = createInstanceFetcher(app, instance as ServiceInstance);
				const items = await fetchCalendarItems(fetcher, service, {
					start: startIso,
					end: endIso,
					unmonitored,
				});
				const validated = items
					.map((item: unknown) => ({
						...item as Record<string, unknown>,
						instanceId: instance.id,
						instanceName: instance.label,
					}))
					.map((item: unknown) => calendarItemSchema.parse(item));
				results.push({
					instanceId: instance.id,
					instanceName: instance.label,
					service,
					data: validated,
				});
				aggregated.push(...validated);
			} catch (error) {
				request.log.error({ err: error, instance: instance.id }, "calendar fetch failed");
				results.push({
					instanceId: instance.id,
					instanceName: instance.label,
					service,
					data: [],
				});
			}
		}

		return reply.send({
			instances: results,
			aggregated,
			totalCount: aggregated.length,
		});
	});

	done();
};
