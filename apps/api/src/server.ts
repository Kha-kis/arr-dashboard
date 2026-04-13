import { randomBytes } from "node:crypto";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import {
	registerInfrastructure,
	registerProtectedRoutes,
	registerPublicRoutes,
	registerSchedulers,
} from "./bootstrap/index.js";
import { type ApiEnv, envSchema } from "./config/env.js";
import { arrErrorToHttpStatus, isArrError } from "./lib/arr/client-factory.js";
import { logger } from "./lib/logger.js";

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
	const env = options.env ?? envSchema.parse(process.env);

	const app = Fastify({
		...(options.logger === false
			? { logger: false }
			: { loggerInstance: logger as FastifyBaseLogger }),
		genReqId: () => randomBytes(4).toString("hex"),
		trustProxy: env.TRUST_PROXY,
	});
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

	// Core infrastructure + background schedulers. Infrastructure must run
	// before schedulers because schedulers rely on decorations like `app.prisma`
	// and `app.notificationService`.
	registerInfrastructure(app);
	registerSchedulers(app);

	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);

	app.addHook("preHandler", async (request) => {
		request.currentUser = null;
		request.sessionToken = null;
		const resolved = await app.sessionService.validateRequest(request);
		if (resolved) {
			request.currentUser = resolved.session.user;
			request.sessionToken = resolved.token;
			// Bind userId to this request's logger — all downstream logs include it
			request.log = request.log.child({ userId: resolved.session.user.id });
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
		if (
			error instanceof Error &&
			"statusCode" in error &&
			typeof (error as Record<string, unknown>).statusCode === "number"
		) {
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
		// Never leak internal error details on 5xx responses (they may contain file paths, DB info, etc.)
		const is5xx = reply.statusCode >= 500;
		reply.send({
			statusCode: reply.statusCode,
			error: is5xx ? "InternalServerError" : (err.name ?? "InternalServerError"),
			message: is5xx ? "Internal server error" : err.message,
		});
	});

	registerPublicRoutes(app);
	registerProtectedRoutes(app);

	return app;
};
