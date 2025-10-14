import type { FastifyPluginCallback } from "fastify";

const RESTART_RATE_LIMIT = { max: 2, timeWindow: "5 minutes" };

const systemRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * POST /system/restart
	 * Manually restart the application
	 *
	 * Security: Requires authentication (admin users only)
	 * Rate limited to prevent abuse
	 */
	app.post("/restart", {config: { rateLimit: RESTART_RATE_LIMIT }}, async (request, reply) => {
		// Authentication check
		if (!request.currentUser) {
			return reply.status(401).send({ error: "Unauthorized" });
		}

		request.log.info(
			{ userId: request.currentUser.id, username: request.currentUser.username },
			"Manual restart requested",
		);

		// Send response immediately
		await reply.send({
			success: true,
			message: app.lifecycle.getRestartMessage(),
		});

		// Initiate restart
		if (app.lifecycle.isRestartRequired()) {
			await app.lifecycle.restart("manual-restart");
		}
	});

	done();
};

export const registerSystemRoutes = systemRoutes;
