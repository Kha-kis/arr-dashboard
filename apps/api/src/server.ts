import Fastify, { type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyCookie from "@fastify/cookie";
import { envSchema, type ApiEnv } from "./config/env.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerServiceRoutes } from "./routes/services.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerDiscoverRoutes } from "./routes/discover.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerManualImportRoutes } from "./routes/manual-import.js";
import { prismaPlugin } from "./plugins/prisma.js";
import { securityPlugin } from "./plugins/security.js";

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
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  });

  app.register(fastifyCookie, {
    secret: env.SESSION_COOKIE_SECRET,
    hook: "onRequest",
  });

  app.register(fastifyRateLimit, {
    max: env.API_RATE_LIMIT_MAX,
    timeWindow: env.API_RATE_LIMIT_WINDOW,
  });

  app.register(prismaPlugin);
  app.register(securityPlugin);

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

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    if (!reply.statusCode || reply.statusCode < 400) {
      reply.status(500);
    }

    reply.send({
      statusCode: reply.statusCode,
      error: error.name ?? "InternalServerError",
      message: env.NODE_ENV === "production" ? "Unexpected error" : error.message,
    });
  });

  app.register(registerHealthRoutes, { prefix: "/health" });
  app.register(registerAuthRoutes, { prefix: "/auth" });
  app.register(registerServiceRoutes, { prefix: "/api" });
  app.register(registerDashboardRoutes, { prefix: "/api" });
  app.register(registerDiscoverRoutes, { prefix: "/api" });
  app.register(registerLibraryRoutes, { prefix: "/api" });
  app.register(registerSearchRoutes, { prefix: "/api" });
  app.register(registerManualImportRoutes, { prefix: "/api" });

  return app;
};
