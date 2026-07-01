import type { FastifyPluginCallback } from "fastify";
import { registerTracearrInstanceRoutes } from "./tracearr/instance-routes.js";
import { registerTracearrSessionRoutes } from "./tracearr/session-routes.js";
import { registerTracearrStreamsRoutes } from "./tracearr/streams-routes.js";

/**
 * Tracearr integration routes — self-hosted media-analytics peer that
 * replaces Tautulli in 3.0 (charter §2.2 / ADR-0007). Foundation phase:
 * typed reads against Tracearr's Public API (`/api/v1/public/*`, Bearer
 * key). Each handler resolves the user's Tracearr ServiceInstance via
 * requireTracearrInstance (filters by userId AND service=TRACEARR), builds a
 * request-scoped client (decrypts the key, no caching), and returns
 * Zod-validated shapes — wire-format normalization happens inside the client.
 *
 * Errors surface through TracearrApiError / TracearrInstanceUnreachableError,
 * both exposing `statusCode` for the centralized handler in server.ts.
 *
 * Registered as `experimental` in the route manifest — a new integration
 * surface that may still move before it graduates (ADR-0005 tier discipline).
 */
const tracearrRoute: FastifyPluginCallback = (app, _opts, done) => {
	registerTracearrInstanceRoutes(app);
	registerTracearrStreamsRoutes(app);
	registerTracearrSessionRoutes(app);
	done();
};

export const registerTracearrRoutes = tracearrRoute;
