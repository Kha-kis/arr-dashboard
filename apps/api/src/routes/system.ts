import type { FastifyPluginCallback } from "fastify";
import { getAppVersion } from "../lib/utils/version.js";

const RESTART_RATE_LIMIT = { max: 2, timeWindow: "5 minutes" };

// Detect database backend from DATABASE_URL
function getDatabaseBackend(): { type: string; host: string | null } {
	const dbUrl = process.env.DATABASE_URL || "";

	if (dbUrl.startsWith("postgresql://") || dbUrl.startsWith("postgres://")) {
		// Extract host from PostgreSQL URL (redact credentials)
		const match = dbUrl.match(/@([^:/]+)/);
		return { type: "PostgreSQL", host: match?.[1] || null };
	}

	if (dbUrl.startsWith("mysql://")) {
		const match = dbUrl.match(/@([^:/]+)/);
		return { type: "MySQL", host: match?.[1] || null };
	}

	if (dbUrl.startsWith("file:")) {
		// Extract filename from SQLite path
		const filename = dbUrl.replace("file:", "").split("/").pop() || "database";
		return { type: "SQLite", host: filename };
	}

	return { type: "SQLite", host: "local" };
}

const APP_VERSION = getAppVersion();
console.log(`[system] App version detected: ${APP_VERSION}`);

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
	 * Get system-wide settings (ports, listen address, app name, etc.)
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
		const effectiveApiPort = Number(process.env.API_PORT) || 3001;
		const effectiveWebPort = Number(process.env.PORT) || 3000;
		const effectiveListenAddress = process.env.HOST || process.env.HOSTNAME || "0.0.0.0";

		// Check if settings differ from what's currently running
		const requiresRestart =
			settings.apiPort !== effectiveApiPort ||
			settings.webPort !== effectiveWebPort ||
			settings.listenAddress !== effectiveListenAddress;

		return reply.send({
			success: true,
			data: {
				apiPort: settings.apiPort,
				webPort: settings.webPort,
				listenAddress: settings.listenAddress,
				appName: settings.appName,
				effectiveApiPort,
				effectiveWebPort,
				effectiveListenAddress,
				requiresRestart,
				updatedAt: settings.updatedAt,
			},
		});
	});

	/**
	 * PUT /system/settings
	 * Update system-wide settings
	 * Note: Port and listen address changes require container restart to take effect
	 */
	app.put<{
		Body: {
			apiPort?: number;
			webPort?: number;
			listenAddress?: string;
			appName?: string;
		};
	}>("/settings", async (request, reply) => {
		const { apiPort, webPort, listenAddress, appName } = request.body;

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

		// Validate listen address if provided
		if (listenAddress !== undefined) {
			// Must be a valid IP address or 0.0.0.0 or localhost
			const validAddresses = ["0.0.0.0", "127.0.0.1", "localhost", "::"];
			const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
			const isValidIp = validAddresses.includes(listenAddress) || ipv4Regex.test(listenAddress);

			if (!isValidIp) {
				return reply.status(400).send({
					success: false,
					error: "Listen address must be a valid IP address (e.g., 0.0.0.0, 127.0.0.1)",
				});
			}
		}

		// Update or create settings
		const settings = await app.prisma.systemSettings.upsert({
			where: { id: 1 },
			update: {
				...(apiPort !== undefined && { apiPort }),
				...(webPort !== undefined && { webPort }),
				...(listenAddress !== undefined && { listenAddress }),
				...(appName !== undefined && { appName }),
			},
			create: {
				id: 1,
				apiPort: apiPort || 3001,
				webPort: webPort || 3000,
				listenAddress: listenAddress || "0.0.0.0",
				appName: appName || "Arr Dashboard",
			},
		});

		// Get currently running values
		const currentApiPort = Number(process.env.API_PORT) || 3001;
		const currentWebPort = Number(process.env.PORT) || 3000;
		const currentListenAddress = process.env.HOST || process.env.HOSTNAME || "0.0.0.0";

		// Check if restart is needed (for port or listen address changes)
		const requiresRestart =
			settings.apiPort !== currentApiPort ||
			settings.webPort !== currentWebPort ||
			settings.listenAddress !== currentListenAddress;

		request.log.info(
			{
				userId: request.currentUser?.id,
				apiPort: settings.apiPort,
				webPort: settings.webPort,
				listenAddress: settings.listenAddress,
				requiresRestart,
			},
			"System settings updated",
		);

		return reply.send({
			success: true,
			data: {
				apiPort: settings.apiPort,
				webPort: settings.webPort,
				listenAddress: settings.listenAddress,
				appName: settings.appName,
				effectiveApiPort: currentApiPort,
				effectiveWebPort: currentWebPort,
				effectiveListenAddress: currentListenAddress,
				requiresRestart,
				updatedAt: settings.updatedAt,
			},
			message: requiresRestart
				? "Settings saved. Container restart required for port changes to take effect."
				: "Settings saved successfully.",
		});
	});

	/**
	 * GET /system/info
	 * Get system information (version, database backend, runtime info)
	 * This is read-only information about the running system
	 */
	app.get("/info", async (_request, reply) => {
		const database = getDatabaseBackend();
		const nodeVersion = process.version;
		const platform = process.platform;
		const uptime = process.uptime();

		return reply.send({
			success: true,
			data: {
				version: APP_VERSION,
				database: {
					type: database.type,
					host: database.host,
				},
				runtime: {
					nodeVersion,
					platform,
					uptime: Math.floor(uptime),
				},
			},
		});
	});

	/**
	 * POST /system/restart
	 * Manually restart the application
	 *
	 * Security: Requires authentication (single-admin architecture - all authenticated users are admins)
	 * Rate limited to prevent abuse (2 requests per 5 minutes)
	 */
	app.post("/restart", { config: { rateLimit: RESTART_RATE_LIMIT } }, async (request, reply) => {
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
