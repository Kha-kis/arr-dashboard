import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { type ApiEnv, envSchema } from "./config/env.js";
import { isArrError, arrErrorToHttpStatus } from "./lib/arr/client-factory.js";
import { arrClientPlugin } from "./plugins/arr-client.js";
import backupSchedulerPlugin from "./plugins/backup-scheduler.js";
import deploymentExecutorPlugin from "./plugins/deployment-executor.js";
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
import { registerHealthRoutes } from "./routes/health.js";
import { registerHuntingRoutes } from "./routes/hunting.js";
import { registerQueueCleanerRoutes } from "./routes/queue-cleaner.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerManualImportRoutes } from "./routes/manual-import.js";
import oidcProvidersRoutes from "./routes/oidc-providers.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerServiceRoutes } from "./routes/services.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerSeerrRoutes } from "./routes/seerr/index.js";
import { registerTrashGuidesRoutes } from "./routes/trash-guides/index.js";

function isPrismaKnownError(
	error: unknown,
): error is { code: string; meta?: Record<string, unknown>; message: string } {
	return (
		error instanceof Error &&
		"code" in error &&
		typeof (error as Record<string, unknown>).code === "string" &&
		/^P\d{4}$/.test((error as Record<string, unknown>).code as string)
	);
}

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

	// Handle requests with unexpected Content-Type headers (e.g., Next.js proxy
	// injecting application/octet-stream on body-less DELETE requests). Without this,
	// Fastify 5 rejects unknown content types with 415 Unsupported Media Type.
	app.addContentTypeParser(
		"application/octet-stream",
		{ parseAs: "string" },
		(_request, _body, done) => {
			done(null, undefined);
		},
	);

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
	app.register(deploymentExecutorPlugin);
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
		// === ARR SDK errors — check FIRST (ArrError also has statusCode, so must precede duck-typing check) ===
		if (isArrError(error)) {
			const statusCode = arrErrorToHttpStatus(error);
			request.log.warn({ err: error }, "ARR SDK error");
			// Strip internal URLs (e.g. http://192.168.x.x:8989/api/...) from client-facing messages
			const sanitizedMessage = error.message.replace(/https?:\/\/[^\s)]+/g, "<redacted-url>");
			return reply.status(statusCode).send({
				error: error.name,
				message: sanitizedMessage,
			});
		}

		// === Known application errors (statusCode convention) ===
		// ZodValidationError, InstanceNotFoundError, TemplateNotFoundError,
		// ConflictError, AppValidationError, ManualImportError, SchedulerNotInitializedError
		if (error instanceof Error && "statusCode" in error && typeof (error as Record<string, unknown>).statusCode === "number") {
			const statusCode = (error as Record<string, unknown>).statusCode as number;
			if (statusCode >= 500) {
				request.log.error({ err: error }, "application error");
			} else {
				request.log.warn({ err: error }, "application error");
			}
			return reply.status(statusCode).send({
				error: error.name,
				message: error.message,
				...("details" in error ? { details: (error as Record<string, unknown>).details } : {}),
			});
		}

		// === Prisma known errors ===
		if (isPrismaKnownError(error)) {
			const prismaStatusMap: Record<string, number> = {
				P2025: 404, // Record not found
				P2002: 409, // Unique constraint violation
				P2003: 400, // Foreign key constraint failure
			};
			const prismaMessages: Record<string, string> = {
				P2025: "Record not found",
				P2002: "Resource already exists",
				P2003: "Related resource not found",
			};
			const statusCode = prismaStatusMap[error.code];
			if (statusCode) {
				request.log.warn({ err: error, prismaCode: error.code }, "Prisma error");
				return reply.status(statusCode).send({
					error: "DatabaseError",
					message: prismaMessages[error.code] ?? "Database error",
				});
			}
			// Unmapped Prisma code — log with code context, fall through to generic 500
			request.log.error({ err: error, prismaCode: error.code }, "unmapped Prisma error");
		}

		// === Generic fallback ===
		request.log.error({ err: error }, "request failed");
		if (!reply.statusCode || reply.statusCode < 400) {
			reply.status(500);
		}
		const err = error instanceof Error ? error : new Error(String(error));
		reply.send({
			statusCode: reply.statusCode,
			error: err.name ?? "InternalServerError",
			message: err.message,
		});
	});

	// Public routes — no auth required
	app.register(registerHealthRoutes, { prefix: "/health" });
	app.register(registerAuthRoutes, { prefix: "/auth" });
	app.register(registerAuthOidcRoutes, { prefix: "/auth" });
	app.register(registerAuthPasskeyRoutes, { prefix: "/auth" });

	// Protected routes — auth enforced by scope-level hook
	app.register(async (api) => {
		api.addHook("preHandler", async (request, reply) => {
			if (!request.currentUser?.id) {
				return reply.status(401).send({ error: "Authentication required" });
			}
		});

		api.register(oidcProvidersRoutes);
		api.register(registerServiceRoutes, { prefix: "/api" });
		api.register(registerDashboardRoutes, { prefix: "/api" });
		api.register(registerLibraryRoutes, { prefix: "/api" });
		api.register(registerSearchRoutes, { prefix: "/api" });
		api.register(registerManualImportRoutes, { prefix: "/api" });
		api.register(registerBackupRoutes, { prefix: "/api/backup" });
		api.register(registerSystemRoutes, { prefix: "/api/system" });
		api.register(registerTrashGuidesRoutes, { prefix: "/api/trash-guides" });
		api.register(registerSeerrRoutes, { prefix: "/api/seerr" });
		api.register(registerHuntingRoutes, { prefix: "/api" });
		api.register(registerQueueCleanerRoutes, { prefix: "/api" });
	});

	return app;
};
