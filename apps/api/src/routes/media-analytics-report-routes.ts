import type { MediaAnalyticsReport } from "@arr/shared";
import type { FastifyPluginAsync } from "fastify";
import { readMediaAnalyticsReport } from "../lib/statistics/media-analytics-report.js";
import { validateRequest } from "../lib/utils/validate.js";
import { analyticsQuery } from "./plex/analytics-schemas.js";

function reportRoutes(provider: MediaAnalyticsReport["provider"]): FastifyPluginAsync {
	return async (app) => {
		app.get("/", async (request, reply) => {
			const { days } = validateRequest(analyticsQuery, request.query);
			const report = await readMediaAnalyticsReport(app.prisma, {
				userId: request.currentUser!.id,
				provider,
				days,
				onParseFailure: (diagnostic) =>
					request.log.warn(
						{ ...diagnostic, provider, route: "analytics-report" },
						"Session snapshot parse failures detected",
					),
			});
			return reply.send(report);
		});
	};
}

export const registerPlexAnalyticsReportRoutes = reportRoutes("plex");
export const registerJellyfinAnalyticsReportRoutes = reportRoutes("jellyfin");
