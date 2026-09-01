import type { FastifyPluginCallback } from "fastify";

export const HISTORY_UNAVAILABLE_MESSAGE =
	"History is temporarily unavailable while safe, bounded pagination is restored.";

/**
 * History-related routes for the dashboard.
 *
 * History is intentionally unavailable on stable until request-wide provider
 * work and partial-result reporting can be bounded without hiding records.
 */
export const historyRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/dashboard/history", async (_request, reply) => {
		return reply.code(503).send({ error: HISTORY_UNAVAILABLE_MESSAGE });
	});

	done();
};
