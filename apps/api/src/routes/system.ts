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
	 * GET /system/settings
	 * Get system-wide settings (URL Base, app name, etc.)
	 */
	app.get("/settings", async (_request, reply) => {
		// Get or create system settings (singleton)
		let settings = await app.prisma.systemSettings.findUnique({
			where: { id: 1 },
		});

		if (!settings) {
			settings = await app.prisma.systemSettings.create({
				data: { id: 1 },
			});
		}

		// Also include current effective BASE_PATH from environment
		// This helps UI show if env var differs from saved setting
		const effectiveBasePath = process.env.BASE_PATH || "";

		return reply.send({
			success: true,
			data: {
				urlBase: settings.urlBase,
				appName: settings.appName,
				effectiveBasePath,
				requiresRestart: settings.urlBase !== effectiveBasePath,
				updatedAt: settings.updatedAt,
			},
		});
	});

	/**
	 * PUT /system/settings
	 * Update system-wide settings
	 * Note: URL Base changes require container restart to take effect
	 */
	app.put<{
		Body: {
			urlBase?: string;
			appName?: string;
		};
	}>("/settings", async (request, reply) => {
		const { urlBase, appName } = request.body;

		// Validate urlBase format if provided
		if (urlBase !== undefined) {
			// Must start with / or be empty
			if (urlBase !== "" && !urlBase.startsWith("/")) {
				return reply.status(400).send({
					success: false,
					error: "URL Base must start with / or be empty",
				});
			}
			// Must not have trailing slash
			if (urlBase.endsWith("/")) {
				return reply.status(400).send({
					success: false,
					error: "URL Base must not have trailing slash",
				});
			}
			// Basic path validation
			if (urlBase && !/^\/[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*$/.test(urlBase)) {
				return reply.status(400).send({
					success: false,
					error: "URL Base contains invalid characters. Use only letters, numbers, hyphens, and underscores.",
				});
			}
		}

		// Update or create settings
		const settings = await app.prisma.systemSettings.upsert({
			where: { id: 1 },
			update: {
				...(urlBase !== undefined && { urlBase }),
				...(appName !== undefined && { appName }),
			},
			create: {
				id: 1,
				urlBase: urlBase || "",
				appName: appName || "Arr Dashboard",
			},
		});

		// Check if restart is needed
		const effectiveBasePath = process.env.BASE_PATH || "";
		const requiresRestart = settings.urlBase !== effectiveBasePath;

		request.log.info(
			{
				userId: request.currentUser?.id,
				urlBase: settings.urlBase,
				effectiveBasePath,
				requiresRestart,
			},
			"System settings updated",
		);

		return reply.send({
			success: true,
			data: {
				urlBase: settings.urlBase,
				appName: settings.appName,
				effectiveBasePath,
				requiresRestart,
				updatedAt: settings.updatedAt,
			},
			message: requiresRestart
				? "Settings saved. Container restart required for URL Base to take effect."
				: "Settings saved successfully.",
		});
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
