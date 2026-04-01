/**
 * Plex OAuth Routes
 *
 * PIN-based OAuth flow for Plex setup assistance.
 * Proxies plex.tv API calls to avoid CORS and test server reachability
 * from the backend's network perspective (important for Docker deployments).
 *
 * Flow: create PIN → user approves in popup → poll for token → discover servers
 */

import type {
	PlexDiscoverServersResponse,
	PlexOAuthPinResponse,
	PlexOAuthTokenResponse,
	PlexServerConnection,
} from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { peekToken, startCleanupInterval, storeToken } from "../../lib/plex/token-store.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";
import { validateRequest } from "../../lib/utils/validate.js";

const PLEX_TV_BASE = "https://plex.tv";
const PLEX_PRODUCT_NAME = "Arr Control Center";
const PLEX_TV_TIMEOUT = 10_000;
const SERVER_TEST_TIMEOUT = 5_000;

// Per-route rate limits (global default is 200/min)
const PIN_CREATE_RATE_LIMIT = { max: 10, timeWindow: "1 minute" };
const PIN_POLL_RATE_LIMIT = { max: 150, timeWindow: "1 minute" };
const SERVER_DISCOVER_RATE_LIMIT = { max: 10, timeWindow: "1 minute" };

/** Standard X-Plex-* headers required by the plex.tv API. */
function plexTvHeaders(clientId: string): Record<string, string> {
	return {
		Accept: "application/json",
		"X-Plex-Product": PLEX_PRODUCT_NAME,
		"X-Plex-Version": "1.0",
		"X-Plex-Client-Identifier": clientId,
	};
}

// ============================================================================
// Local Zod schemas for plex.tv upstream responses (not shared — internal only)
// ============================================================================

const plexTvPinResponseSchema = z.object({
	id: z.number(),
	code: z.string(),
});

const plexTvPinCheckSchema = z.object({
	authToken: z.string().nullable(),
});

const plexTvResourceConnectionSchema = z.object({
	protocol: z.string(),
	address: z.string(),
	port: z.number(),
	uri: z.string(),
	local: z.boolean(),
	relay: z.boolean(),
});

const plexTvResourceSchema = z.object({
	name: z.string(),
	clientIdentifier: z.string(),
	provides: z.string(),
	owned: z.boolean().optional(),
	connections: z.array(plexTvResourceConnectionSchema).optional(),
	accessToken: z.string().optional(),
	productVersion: z.string().optional(),
	platform: z.string().optional(),
});

const plexTvResourcesResponseSchema = z.array(plexTvResourceSchema);

/** Safely parse JSON from a Response, returning null on malformed bodies. */
async function safeJson(response: Response): Promise<unknown | null> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

/** Build an error payload with both `error` and `message` fields for frontend compatibility. */
function errorPayload(error: string, details?: string) {
	return details ? { error, message: error, details } : { error, message: error };
}

// ============================================================================
// Request validation schemas
// ============================================================================

const createPinSchema = z.object({
	clientId: z.string().uuid(),
});

const pollPinParamsSchema = z.object({
	pinId: z.coerce.number().int().positive(),
});

const pollPinQuerySchema = z.object({
	clientId: z.string().uuid(),
});

const discoverServersSchema = z.object({
	tokenRef: z.string().min(1),
	clientId: z.string().uuid(),
});

const retrieveTokenSchema = z.object({
	tokenRef: z.string().min(1),
});

// ============================================================================
// Route handlers
// ============================================================================

export async function registerOAuthRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	// Start token cleanup and register graceful shutdown
	const cleanupTimer = startCleanupInterval();
	app.addHook("onClose", () => clearInterval(cleanupTimer));

	/**
	 * POST /api/plex/oauth/pin
	 *
	 * Creates a PIN on plex.tv for the OAuth popup flow.
	 * Returns { pinId, pinCode } for the frontend to open the auth popup.
	 */
	app.post("/pin", { config: { rateLimit: PIN_CREATE_RATE_LIMIT } }, async (request, reply) => {
		const { clientId } = validateRequest(createPinSchema, request.body);

		let response: Response;
		try {
			response = await fetch(`${PLEX_TV_BASE}/api/v2/pins?strong=true`, {
				method: "POST",
				headers: plexTvHeaders(clientId),
				signal: AbortSignal.timeout(PLEX_TV_TIMEOUT),
			});
		} catch (err: unknown) {
			request.log.warn({ err }, "plex.tv PIN creation network error");
			return reply
				.status(502)
				.send(errorPayload("Could not reach plex.tv", getErrorMessage(err, "Network error")));
		}

		if (!response.ok) {
			request.log.warn({ status: response.status }, "plex.tv PIN creation failed");
			return reply
				.status(502)
				.send(
					errorPayload("Failed to create Plex PIN", `plex.tv returned HTTP ${response.status}`),
				);
		}

		const raw = await safeJson(response);
		if (raw === null) {
			request.log.warn("plex.tv PIN response was not valid JSON");
			return reply.status(502).send(errorPayload("Unexpected response from plex.tv"));
		}
		const parsed = plexTvPinResponseSchema.safeParse(raw);
		if (!parsed.success) {
			request.log.warn("plex.tv PIN response did not match expected schema");
			return reply.status(502).send(errorPayload("Unexpected response from plex.tv"));
		}

		const result: PlexOAuthPinResponse = {
			pinId: parsed.data.id,
			pinCode: parsed.data.code,
		};
		return reply.send(result);
	});

	/**
	 * GET /api/plex/oauth/pin/:pinId
	 *
	 * Polls plex.tv for PIN approval status.
	 * Returns { tokenRef: null } if not yet approved, { tokenRef: "..." } when approved.
	 * The actual Plex token is stored server-side — only an opaque reference is returned.
	 */
	app.get("/pin/:pinId", { config: { rateLimit: PIN_POLL_RATE_LIMIT } }, async (request, reply) => {
		const { pinId } = validateRequest(pollPinParamsSchema, request.params);
		const { clientId } = validateRequest(pollPinQuerySchema, request.query);

		let response: Response;
		try {
			response = await fetch(`${PLEX_TV_BASE}/api/v2/pins/${pinId}`, {
				headers: plexTvHeaders(clientId),
				signal: AbortSignal.timeout(PLEX_TV_TIMEOUT),
			});
		} catch (err: unknown) {
			request.log.warn({ err }, "plex.tv PIN poll network error");
			return reply
				.status(502)
				.send(errorPayload("Could not reach plex.tv", getErrorMessage(err, "Network error")));
		}

		if (!response.ok) {
			request.log.warn({ status: response.status }, "plex.tv PIN poll failed");
			return reply
				.status(502)
				.send(
					errorPayload(
						"Failed to check Plex PIN status",
						`plex.tv returned HTTP ${response.status}`,
					),
				);
		}

		const raw = await safeJson(response);
		if (raw === null) {
			request.log.warn("plex.tv PIN poll response was not valid JSON");
			return reply.status(502).send(errorPayload("Unexpected response from plex.tv"));
		}
		const parsed = plexTvPinCheckSchema.safeParse(raw);
		if (!parsed.success) {
			request.log.warn(
				{ zodError: parsed.error.issues },
				"plex.tv PIN poll response did not match expected schema",
			);
			return reply.status(502).send(errorPayload("Unexpected response from plex.tv"));
		}

		// Store token server-side to keep it off the browser during discovery
		const authToken = parsed.data.authToken;
		const tokenRef = authToken ? storeToken(authToken) : null;
		const result: PlexOAuthTokenResponse = { tokenRef };
		return reply.send(result);
	});

	/**
	 * POST /api/plex/oauth/servers
	 *
	 * Discovers Plex servers accessible with the given auth token.
	 * Tests each connection from the backend network and returns reachability status.
	 */
	app.post(
		"/servers",
		{ config: { rateLimit: SERVER_DISCOVER_RATE_LIMIT } },
		async (request, reply) => {
			const { tokenRef, clientId } = validateRequest(discoverServersSchema, request.body);

			const authToken = peekToken(tokenRef);
			if (!authToken) {
				return reply
					.status(400)
					.send(errorPayload("Token expired or not found. Please sign in again."));
			}

			let response: Response;
			try {
				response = await fetch(
					`${PLEX_TV_BASE}/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1`,
					{
						headers: {
							...plexTvHeaders(clientId),
							"X-Plex-Token": authToken,
						},
						signal: AbortSignal.timeout(PLEX_TV_TIMEOUT),
					},
				);
			} catch (err: unknown) {
				request.log.warn({ err }, "plex.tv server discovery network error");
				return reply
					.status(502)
					.send(errorPayload("Could not reach plex.tv", getErrorMessage(err, "Network error")));
			}

			if (response.status === 401) {
				return reply.status(400).send(errorPayload("Invalid or expired Plex token"));
			}

			if (!response.ok) {
				request.log.warn({ status: response.status }, "plex.tv resources lookup failed");
				return reply
					.status(502)
					.send(
						errorPayload(
							"Failed to discover Plex servers",
							`plex.tv returned HTTP ${response.status}`,
						),
					);
			}

			const raw = await safeJson(response);
			if (raw === null) {
				request.log.warn("plex.tv resources response was not valid JSON");
				return reply.status(502).send(errorPayload("Unexpected response from plex.tv"));
			}
			const parsed = plexTvResourcesResponseSchema.safeParse(raw);
			if (!parsed.success) {
				request.log.warn("plex.tv resources response did not match expected schema");
				return reply.status(502).send(errorPayload("Unexpected response from plex.tv"));
			}

			// Filter to owned servers only — shared servers lack admin API access
			const serverResources = parsed.data.filter(
				(r) => r.provides.includes("server") && r.owned !== false,
			);

			// Expand connections: when an HTTPS plex.direct URI differs from the raw
			// address, synthesize an HTTP connection with the raw IP (same as Seerr).
			// This gives users both the secure plex.direct option and a plain HTTP local option.
			const servers = await Promise.all(
				serverResources.map(async (server) => {
					// Exclude relay connections — they're Plex's cloud proxy, not useful for API access
					const rawConns = (server.connections ?? []).filter((c) => !c.relay);
					const expanded: typeof rawConns = [];

					for (const conn of rawConns) {
						try {
							const uriHost = new URL(conn.uri).hostname;
							if (uriHost !== conn.address && uriHost.includes(".plex.direct")) {
								// Add HTTP variant with raw IP address
								expanded.push({
									...conn,
									protocol: "http",
									uri: `http://${conn.address}:${conn.port}`,
								});
								// Keep HTTPS variant with plex.direct hostname
								expanded.push(conn);
							} else {
								expanded.push(conn);
							}
						} catch {
							expanded.push(conn);
						}
					}

					// Deduplicate by URI
					const seen = new Set<string>();
					const unique = expanded.filter((c) => {
						if (seen.has(c.uri)) return false;
						seen.add(c.uri);
						return true;
					});

					// Test each connection in parallel
					const connections: PlexServerConnection[] = await Promise.all(
						unique.map(async (conn) => {
							const reachable = await testConnection(conn.uri, authToken);
							return {
								uri: conn.uri,
								local: conn.local,
								relay: conn.relay,
								reachable,
							};
						}),
					);

					return {
						name: server.name,
						clientIdentifier: server.clientIdentifier,
						platform: server.platform,
						version: server.productVersion,
						connections,
					};
				}),
			);

			const result: PlexDiscoverServersResponse = { servers };
			return reply.send(result);
		},
	);

	/**
	 * POST /api/plex/oauth/token
	 *
	 * Retrieves the stored Plex auth token for service form pre-fill.
	 * Token remains valid until TTL expiry so the user can switch between connections.
	 */
	app.post(
		"/token",
		{ config: { rateLimit: SERVER_DISCOVER_RATE_LIMIT } },
		async (request, reply) => {
			const { tokenRef } = validateRequest(retrieveTokenSchema, request.body);

			const authToken = peekToken(tokenRef);
			if (!authToken) {
				return reply
					.status(400)
					.send(errorPayload("Token expired or not found. Please sign in again."));
			}

			return reply.send({ authToken });
		},
	);
}

/**
 * Test if a Plex server connection is reachable from this backend.
 * Calls GET / (server root) with the auth token and a short timeout.
 */
async function testConnection(uri: string, token: string): Promise<boolean> {
	try {
		// Only allow http/https schemes to prevent SSRF via non-HTTP protocols
		const scheme = new URL(uri).protocol;
		if (scheme !== "http:" && scheme !== "https:") return false;

		const response = await fetch(`${uri}/identity`, {
			headers: {
				Accept: "application/json",
				"X-Plex-Token": token,
			},
			signal: AbortSignal.timeout(SERVER_TEST_TIMEOUT),
		});
		return response.ok;
	} catch {
		return false;
	}
}
