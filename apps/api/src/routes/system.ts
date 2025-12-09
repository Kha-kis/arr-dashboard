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
	 * Get system-wide settings (URL Base, ports, app name, etc.)
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

		// Get effective values from environment (what's currently running)
		const effectiveBasePath = process.env.BASE_PATH || "";
		const effectiveApiPort = Number(process.env.API_PORT) || 3001;
		const effectiveWebPort = Number(process.env.PORT) || 3000;

		// Check if any settings differ from what's currently running
		const requiresRestart =
			settings.urlBase !== effectiveBasePath ||
			settings.apiPort !== effectiveApiPort ||
			settings.webPort !== effectiveWebPort;

		return reply.send({
			success: true,
			data: {
				urlBase: settings.urlBase,
				apiPort: settings.apiPort,
				webPort: settings.webPort,
				appName: settings.appName,
				effectiveBasePath,
				effectiveApiPort,
				effectiveWebPort,
				requiresRestart,
				updatedAt: settings.updatedAt,
			},
		});
	});

	/**
	 * PUT /system/settings
	 * Update system-wide settings
	 * Note: URL Base and port changes require container restart to take effect
	 */
	app.put<{
		Body: {
			urlBase?: string;
			apiPort?: number;
			webPort?: number;
			appName?: string;
		};
	}>("/settings", async (request, reply) => {
		const { urlBase, apiPort, webPort, appName } = request.body;

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

		// Validate port numbers if provided
		if (apiPort !== undefined) {
			if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
				return reply.status(400).send({
					success: false,
					error: "API Port must be a valid port number (1-65535)",
				});
			}
		}

		if (webPort !== undefined) {
			if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) {
				return reply.status(400).send({
					success: false,
					error: "Web Port must be a valid port number (1-65535)",
				});
			}
		}

		// Check for port conflicts
		const effectiveApiPort = apiPort ?? (Number(process.env.API_PORT) || 3001);
		const effectiveWebPort = webPort ?? (Number(process.env.PORT) || 3000);
		if (effectiveApiPort === effectiveWebPort) {
			return reply.status(400).send({
				success: false,
				error: "API Port and Web Port cannot be the same",
			});
		}

		// Update or create settings
		const settings = await app.prisma.systemSettings.upsert({
			where: { id: 1 },
			update: {
				...(urlBase !== undefined && { urlBase }),
				...(apiPort !== undefined && { apiPort }),
				...(webPort !== undefined && { webPort }),
				...(appName !== undefined && { appName }),
			},
			create: {
				id: 1,
				urlBase: urlBase || "",
				apiPort: apiPort || 3001,
				webPort: webPort || 3000,
				appName: appName || "Arr Dashboard",
			},
		});

		// Get currently running values
		const currentBasePath = process.env.BASE_PATH || "";
		const currentApiPort = Number(process.env.API_PORT) || 3001;
		const currentWebPort = Number(process.env.PORT) || 3000;

		// Check if restart is needed
		const requiresRestart =
			settings.urlBase !== currentBasePath ||
			settings.apiPort !== currentApiPort ||
			settings.webPort !== currentWebPort;

		request.log.info(
			{
				userId: request.currentUser?.id,
				urlBase: settings.urlBase,
				apiPort: settings.apiPort,
				webPort: settings.webPort,
				requiresRestart,
			},
			"System settings updated",
		);

		return reply.send({
			success: true,
			data: {
				urlBase: settings.urlBase,
				apiPort: settings.apiPort,
				webPort: settings.webPort,
				appName: settings.appName,
				effectiveBasePath: currentBasePath,
				effectiveApiPort: currentApiPort,
				effectiveWebPort: currentWebPort,
				requiresRestart,
				updatedAt: settings.updatedAt,
			},
			message: requiresRestart
				? "Settings saved. Container restart required for changes to take effect."
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
