import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { FastifyPluginCallback } from "fastify";
import { LOG_DIR, LOG_LEVEL, LOG_MAX_FILES, LOG_MAX_SIZE } from "../lib/logger.js";
import { getAppVersionInfo } from "../lib/utils/version.js";
import { integrationHealth } from "../lib/validation/integration-health.js";
import { schemaFingerprints } from "../lib/validation/schema-fingerprint.js";
import { KNOWN_INTEGRATIONS } from "../lib/validation/index.js";
import { type ValidationMode, getAllValidationModes, setValidationMode } from "../lib/validation/validate-batch.js";
import { validationQuarantine } from "../lib/validation/validation-quarantine.js";

const RESTART_RATE_LIMIT = { max: 2, timeWindow: "5 minutes" };
const LOGS_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };

/**
 * Extract a safe display identifier for the database connection.
 * For PostgreSQL: returns the hostname (credentials are redacted).
 * For SQLite: returns the database filename.
 */
function getDatabaseHost(dbUrl: string, provider: "sqlite" | "postgresql"): string | null {
	if (provider === "postgresql") {
		const match = dbUrl.match(/@([^:/]+)/);
		return match?.[1] || null;
	}
	// SQLite: extract filename from path
	const path = dbUrl.startsWith("file:") ? dbUrl.slice(5) : dbUrl;
	return path.split("/").pop() || "database";
}

const APP_VERSION_INFO = getAppVersionInfo();

const systemRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.log.info({ version: APP_VERSION_INFO.version, commit: APP_VERSION_INFO.commitSha }, "App version detected");
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
		const effectiveTrustProxy = app.config.TRUST_PROXY;
		const effectiveSecureCookies = app.config.COOKIE_SECURE ?? app.config.TRUST_PROXY;

		// Check if settings differ from what's currently running
		const requiresRestart =
			settings.apiPort !== effectiveApiPort ||
			settings.webPort !== effectiveWebPort ||
			settings.listenAddress !== effectiveListenAddress ||
			settings.trustProxy !== effectiveTrustProxy ||
			(settings.secureCookies ?? effectiveTrustProxy) !== effectiveSecureCookies;

		return reply.send({
			success: true,
			data: {
				apiPort: settings.apiPort,
				webPort: settings.webPort,
				listenAddress: settings.listenAddress,
				appName: settings.appName,
				externalUrl: settings.externalUrl,
				trustProxy: settings.trustProxy,
				secureCookies: settings.secureCookies,
				effectiveApiPort,
				effectiveWebPort,
				effectiveListenAddress,
				effectiveTrustProxy,
				effectiveSecureCookies,
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
			externalUrl?: string | null;
			trustProxy?: boolean;
			secureCookies?: boolean | null;
		};
	}>("/settings", async (request, reply) => {
		const { apiPort, webPort, listenAddress, appName, externalUrl, trustProxy, secureCookies } =
			request.body;

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

		// Validate security settings
		if (trustProxy !== undefined && typeof trustProxy !== "boolean") {
			return reply.status(400).send({
				success: false,
				error: "trustProxy must be a boolean",
			});
		}
		if (secureCookies !== undefined && secureCookies !== null && typeof secureCookies !== "boolean") {
			return reply.status(400).send({
				success: false,
				error: "secureCookies must be a boolean or null",
			});
		}

		// Prevent lockout: secure cookies without a reverse proxy means the browser
		// won't send the Secure cookie over plain HTTP, permanently locking out the user.
		// Check both the request body AND existing DB value to catch cases where only
		// trustProxy is being disabled while secureCookies remains true in the database.
		const effectiveTrustProxy = trustProxy ?? (app.config.TRUST_PROXY || false);
		let effectiveSecureCookies = secureCookies;
		if (effectiveSecureCookies === undefined) {
			const currentSettings = await app.prisma.systemSettings.findUnique({
				where: { id: 1 },
				select: { secureCookies: true },
			});
			effectiveSecureCookies = currentSettings?.secureCookies ?? null;
		}
		if (effectiveSecureCookies === true && !effectiveTrustProxy) {
			return reply.status(400).send({
				success: false,
				error: "Cannot enable secure cookies without Trust Proxy. Secure cookies require HTTPS, which is typically provided by a reverse proxy.",
			});
		}

		// Validate external URL if provided (not null - null means clear)
		if (externalUrl !== undefined && externalUrl !== null && externalUrl !== "") {
			try {
				const url = new URL(externalUrl);
				// Must be http or https
				if (!["http:", "https:"].includes(url.protocol)) {
					return reply.status(400).send({
						success: false,
						error: "External URL must use http or https protocol",
					});
				}
			} catch {
				return reply.status(400).send({
					success: false,
					error: "External URL must be a valid URL (e.g., https://arr.example.com)",
				});
			}
		}

		// Normalize external URL (empty string becomes null)
		const normalizedExternalUrl = externalUrl === "" ? null : externalUrl;

		// Update or create settings
		const settings = await app.prisma.systemSettings.upsert({
			where: { id: 1 },
			update: {
				...(apiPort !== undefined && { apiPort }),
				...(webPort !== undefined && { webPort }),
				...(listenAddress !== undefined && { listenAddress }),
				...(appName !== undefined && { appName }),
				...(externalUrl !== undefined && { externalUrl: normalizedExternalUrl }),
				...(trustProxy !== undefined && { trustProxy }),
				...(secureCookies !== undefined && { secureCookies }),
			},
			create: {
				id: 1,
				apiPort: apiPort || 3001,
				webPort: webPort || 3000,
				listenAddress: listenAddress || "0.0.0.0",
				appName: appName || "Arr Dashboard",
				externalUrl: normalizedExternalUrl,
				trustProxy: trustProxy ?? false,
				secureCookies: secureCookies ?? null,
			},
		});

		// Get currently running values
		const currentApiPort = Number(process.env.API_PORT) || 3001;
		const currentWebPort = Number(process.env.PORT) || 3000;
		const currentListenAddress = process.env.HOST || process.env.HOSTNAME || "0.0.0.0";
		const currentTrustProxy = app.config.TRUST_PROXY;
		const currentSecureCookies = app.config.COOKIE_SECURE ?? app.config.TRUST_PROXY;

		// Check if restart is needed (for port, listen address, or security changes)
		const requiresRestart =
			settings.apiPort !== currentApiPort ||
			settings.webPort !== currentWebPort ||
			settings.listenAddress !== currentListenAddress ||
			settings.trustProxy !== currentTrustProxy ||
			(settings.secureCookies ?? currentTrustProxy) !== currentSecureCookies;

		request.log.info(
			{
				userId: request.currentUser!.id,
				apiPort: settings.apiPort,
				webPort: settings.webPort,
				listenAddress: settings.listenAddress,
				externalUrl: settings.externalUrl,
				trustProxy: settings.trustProxy,
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
				externalUrl: settings.externalUrl,
				trustProxy: settings.trustProxy,
				secureCookies: settings.secureCookies,
				effectiveApiPort: currentApiPort,
				effectiveWebPort: currentWebPort,
				effectiveListenAddress: currentListenAddress,
				effectiveTrustProxy: currentTrustProxy,
				effectiveSecureCookies: currentSecureCookies,
				requiresRestart,
				updatedAt: settings.updatedAt,
			},
			message: requiresRestart
				? "Settings saved. Restart required for changes to take effect."
				: "Settings saved successfully.",
		});
	});

	/**
	 * GET /system/info
	 * Get system information (version, database backend, runtime info)
	 * This is read-only information about the running system
	 */
	app.get("/info", async (_request, reply) => {
		const dbUrl = process.env.DATABASE_URL || "";
		const dbType = app.dbProvider === "postgresql" ? "PostgreSQL" : "SQLite";
		const dbHost = getDatabaseHost(dbUrl, app.dbProvider);
		const nodeVersion = process.version;
		const platform = process.platform;
		const uptime = process.uptime();

		return reply.send({
			success: true,
			data: {
				version: APP_VERSION_INFO.version,
				commit: APP_VERSION_INFO.commitSha,
				database: {
					type: dbType,
					host: dbHost,
				},
				runtime: {
					nodeVersion,
					platform,
					uptime: Math.floor(uptime),
				},
				logging: {
					level: LOG_LEVEL,
					directory: LOG_DIR,
					maxFileSize: LOG_MAX_SIZE,
					maxFiles: LOG_MAX_FILES,
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
			{ userId: request.currentUser!.id, username: request.currentUser?.username },
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

	/**
	 * GET /system/logs
	 * List log files with sizes and dates
	 */
	app.get("/logs", { config: { rateLimit: LOGS_RATE_LIMIT } }, async (request, reply) => {
		try {
			const entries = await readdir(LOG_DIR);
			const files: { name: string; size: number; modified: string }[] = [];

			for (const entry of entries) {
				const filePath = join(LOG_DIR, entry);
				const info = await stat(filePath);
				if (info.isFile()) {
					files.push({
						name: entry,
						size: info.size,
						modified: info.mtime.toISOString(),
					});
				}
			}

			// Sort by modified date descending (newest first)
			files.sort((a, b) => b.modified.localeCompare(a.modified));

			return reply.send({
				success: true,
				data: {
					directory: LOG_DIR,
					files,
				},
			});
		} catch (error) {
			request.log.warn({ err: error, logDir: LOG_DIR }, "Failed to list log files");
			return reply.send({
				success: true,
				data: {
					directory: LOG_DIR,
					files: [],
					warning: "Could not read log directory. Check permissions and path configuration.",
				},
			});
		}
	});

	/**
	 * GET /system/logs/download/:filename
	 * Download a specific log file
	 */
	app.get<{ Params: { filename: string } }>(
		"/logs/download/:filename",
		{ config: { rateLimit: LOGS_RATE_LIMIT } },
		async (request, reply) => {
			const { filename } = request.params;

			// Path traversal protection: only allow simple filenames
			if (filename !== basename(filename) || filename.includes("..")) {
				return reply.status(400).send({ error: "Invalid filename" });
			}

			const filePath = resolve(LOG_DIR, filename);

			// Ensure the resolved path is still within the log directory
			if (!filePath.startsWith(resolve(LOG_DIR))) {
				return reply.status(400).send({ error: "Invalid filename" });
			}

			try {
				const info = await stat(filePath);
				if (!info.isFile()) {
					return reply.status(404).send({ error: "File not found" });
				}

				const stream = createReadStream(filePath);
				// Sanitize filename to prevent header injection (strip quotes, newlines, control chars, non-ASCII)
				// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitization of control characters
				const safeFilename = filename.replace(/["\r\n\x00-\x1f\x7f-\xff]/g, "_");
				return reply
					.header("Content-Disposition", `attachment; filename="${safeFilename}"`)
					.header("Content-Type", "application/octet-stream")
					.header("Content-Length", info.size)
					.send(stream);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					return reply.status(404).send({ error: "File not found" });
				}
				request.log.error({ err: error, filename }, "Failed to download log file");
				return reply.status(500).send({ error: "Failed to read log file" });
			}
		},
	);

	/**
	 * GET /system/validation-health
	 * Aggregate validation stats across all integrations (TRaSH, Seerr, Plex, Tautulli).
	 * Includes schema fingerprints for drift detection and per-integration validation modes.
	 */
	app.get("/validation-health", async (_request, reply) => {
		return reply.send({
			success: true,
			data: {
				...integrationHealth.getAll(),
				fingerprints: schemaFingerprints.getAll(),
				validationModes: getAllValidationModes(),
			},
		});
	});

	/**
	 * PUT /system/validation-modes
	 * Update validation mode for a specific integration.
	 */
	app.put<{
		Body: { integration: string; mode: string };
	}>("/validation-modes", async (request, reply) => {
		const { integration, mode } = request.body;

		if (!integration || typeof integration !== "string") {
			return reply.status(400).send({ error: "integration is required and must be a string" });
		}

		if (!KNOWN_INTEGRATIONS.includes(integration as (typeof KNOWN_INTEGRATIONS)[number])) {
			return reply.status(400).send({
				error: `Unknown integration "${integration}". Valid integrations: ${KNOWN_INTEGRATIONS.join(", ")}`,
			});
		}

		const validModes: ValidationMode[] = ["strict", "tolerant", "log-only", "disabled"];
		if (!validModes.includes(mode as ValidationMode)) {
			return reply.status(400).send({
				error: `Invalid mode "${mode}". Must be one of: ${validModes.join(", ")}`,
			});
		}

		setValidationMode(integration, mode as ValidationMode);

		request.log.info({ integration, mode }, "Validation mode updated");

		return reply.send({
			success: true,
			data: getAllValidationModes(),
		});
	});

	/**
	 * DELETE /system/validation-health
	 * Reset all validation health stats. Returns the new (empty) state with resetAt timestamp.
	 */
	app.delete("/validation-health", async (request, reply) => {
		integrationHealth.reset();
		request.log.info("Validation health stats reset");
		return reply.send({
			success: true,
			data: {
				...integrationHealth.getAll(),
				fingerprints: schemaFingerprints.getAll(),
				validationModes: getAllValidationModes(),
			},
		});
	});

	/**
	 * GET /system/validation-quarantine
	 * Returns quarantined (rejected) validation items for inspection.
	 */
	app.get("/validation-quarantine", async (_request, reply) => {
		return reply.send({
			success: true,
			data: {
				items: validationQuarantine.getAll(),
				totalCount: validationQuarantine.count,
			},
		});
	});

	/**
	 * DELETE /system/validation-quarantine
	 * Clear all quarantined items.
	 */
	app.delete("/validation-quarantine", async (request, reply) => {
		validationQuarantine.clear();
		request.log.info("Validation quarantine cleared");
		return reply.send({
			success: true,
			data: {
				items: {},
				totalCount: 0,
			},
		});
	});

	done();
};

export const registerSystemRoutes = systemRoutes;
