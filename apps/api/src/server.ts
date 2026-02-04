import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { type ApiEnv, envSchema } from "./config/env.js";
import { arrClientPlugin } from "./plugins/arr-client.js";
import backupSchedulerPlugin from "./plugins/backup-scheduler.js";
import queueCleanerSchedulerPlugin from "./plugins/queue-cleaner-scheduler.js";
import librarySyncSchedulerPlugin from "./plugins/library-sync-scheduler.js";
import lifecyclePlugin from "./plugins/lifecycle.js";
import { prismaPlugin } from "./plugins/prisma.js";
import { securityPlugin } from "./plugins/security.js";
import sessionCleanupPlugin from "./plugins/session-cleanup.js";
import trashBackupCleanupPlugin from "./plugins/trash-backup-cleanup.js";
import trashUpdateSchedulerPlugin from "./plugins/trash-update-scheduler.js";
import { registerAuthOidcRoutes } from "./routes/auth-oidc.js";
import { registerAuthPasskeyRoutes } from "./routes/auth-passkey.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBackupRoutes } from "./routes/backup.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerDiscoverRoutes } from "./routes/discover.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerHuntingRoutes } from "./routes/hunting.js";
import { registerQueueCleanerRoutes } from "./routes/queue-cleaner.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerManualImportRoutes } from "./routes/manual-import.js";
import oidcProvidersRoutes from "./routes/oidc-providers.js";
import { registerRecommendationsRoutes } from "./routes/recommendations.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerServiceRoutes } from "./routes/services.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerTMDBRoutes } from "./routes/tmdb.js";
import { registerTrashGuidesRoutes } from "./routes/trash-guides/index.js";

export type ServerOptions = {
	logger?: boolean;
	env?: ApiEnv;
};

export const buildServer = (options: ServerOptions = {}): FastifyInstance => {
	const app = Fastify({
		logger: options.logger ?? true,
	});

	const env = options.env ?? envSchema.parse(process.env);
	app.decorate("config", env);

	app.register(fastifyCors, {
		origin: env.API_CORS_ORIGIN,
		credentials: true,
	});

	app.register(fastifyHelmet, {
		contentSecurityPolicy: false,
		xssFilter: false, // Deprecated header, modern browsers have built-in protections
		hsts: {
			maxAge: 31536000,
			includeSubDomains: true,
			preload: true,
		},
	});

	app.register(fastifyRateLimit, {
		max: env.API_RATE_LIMIT_MAX,
		timeWindow: env.API_RATE_LIMIT_WINDOW,
	});

	// Register Prisma, Security, ARR Client, Lifecycle, and Scheduler plugins
	app.register(prismaPlugin);
	app.register(securityPlugin);
	app.register(arrClientPlugin);
	app.register(lifecyclePlugin);
	app.register(backupSchedulerPlugin);
	app.register(librarySyncSchedulerPlugin);
	app.register(sessionCleanupPlugin);
	app.register(trashBackupCleanupPlugin);
	app.register(trashUpdateSchedulerPlugin);
	app.register(queueCleanerSchedulerPlugin);

	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);

	app.addHook("preHandler", async (request) => {
		request.currentUser = null;
		request.sessionToken = null;
		const resolved = await app.sessionService.validateRequest(request);
		if (resolved) {
			request.currentUser = resolved.session.user;
			request.sessionToken = resolved.token;
		}
	});

	app.setErrorHandler((error: unknown, request, reply) => {
		request.log.error({ err: error }, "request failed");
		if (!reply.statusCode || reply.statusCode < 400) {
			reply.status(500);
		}

		// Fastify 5 types errors as unknown for safety
		const err = error instanceof Error ? error : new Error(String(error));
		reply.send({
			statusCode: reply.statusCode,
			error: err.name ?? "InternalServerError",
			message: env.NODE_ENV === "production" ? "Unexpected error" : err.message,
		});
	});

	app.register(registerHealthRoutes, { prefix: "/health" });
	app.register(registerAuthRoutes, { prefix: "/auth" });
	app.register(registerAuthOidcRoutes, { prefix: "/auth" });
	app.register(registerAuthPasskeyRoutes, { prefix: "/auth" });
	app.register(oidcProvidersRoutes);
	app.register(registerServiceRoutes, { prefix: "/api" });
	app.register(registerDashboardRoutes, { prefix: "/api" });
	app.register(registerDiscoverRoutes, { prefix: "/api" });
	app.register(registerLibraryRoutes, { prefix: "/api" });
	app.register(registerSearchRoutes, { prefix: "/api" });
	app.register(registerManualImportRoutes, { prefix: "/api" });
	app.register(registerRecommendationsRoutes, { prefix: "/api" });
	app.register(registerTMDBRoutes, { prefix: "/api" });
	app.register(registerBackupRoutes, { prefix: "/api/backup" });
	app.register(registerSystemRoutes, { prefix: "/api/system" });
	app.register(registerTrashGuidesRoutes, { prefix: "/api/trash-guides" });
	app.register(registerHuntingRoutes, { prefix: "/api" });
	app.register(registerQueueCleanerRoutes, { prefix: "/api" });

	return app;
};
