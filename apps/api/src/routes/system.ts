import type { FastifyPluginCallback } from "fastify";

const RESTART_RATE_LIMIT = { max: 2, timeWindow: "5 minutes" };

const systemRoutes: FastifyPluginCallback = (app, _opts, done) => {
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
	 * POST /system/restart
	 * Manually restart the application
	 *
	 * Security: Requires authentication (single-admin architecture - all authenticated users are admins)
	 * Rate limited to prevent abuse (2 requests per 5 minutes)
	 */
	app.post("/restart", {config: { rateLimit: RESTART_RATE_LIMIT }}, async (request, reply) => {
		request.log.info(
			{ userId: request.currentUser?.id, username: request.currentUser?.username },
			"Manual restart requested",
		);

		// Send response immediately
		await reply.send({
			success: true,
			message: app.lifecycle.getRestartMessage(),
		});

		// Initiate restart
		await app.lifecycle.restart("manual-restart");
	});

	done();
};

export const registerSystemRoutes = systemRoutes;
