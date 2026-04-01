/**
 * Seerr OAuth Routes
 *
 * Bootstraps Seerr API key retrieval using a Plex auth token.
 * Flow: user signs in with Plex → backend authenticates to Seerr
 * via POST /api/v1/auth/plex → retrieves API key from settings.
 */

import type { SeerrFetchKeyResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { peekToken } from "../../lib/plex/token-store.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";
import { validateRequest } from "../../lib/utils/validate.js";

const SEERR_TIMEOUT = 10_000;
const FETCH_KEY_RATE_LIMIT = { max: 10, timeWindow: "1 minute" };

/** Build an error payload with both `error` and `message` fields for frontend compatibility. */
function errorPayload(error: string, details?: string) {
	return details ? { error, message: error, details } : { error, message: error };
}

/** Safely parse JSON from a Response, returning null on malformed bodies. */
async function safeJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

// ============================================================================
// Request validation
// ============================================================================

const fetchKeySchema = z.object({
	seerrUrl: z.string().url(),
	tokenRef: z.string().min(1),
});

// ============================================================================
// Zod schemas for Seerr upstream responses (internal only)
// ============================================================================

const seerrAuthResponseSchema = z.object({
	id: z.number(),
	permissions: z.number().optional(),
});

const seerrSettingsMainSchema = z.object({
	apiKey: z.string().min(1),
});

const seerrStatusSchema = z.object({
	version: z.string(),
});

// ============================================================================
// Route handler
// ============================================================================

export async function registerSeerrOAuthRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * POST /api/seerr/oauth/fetch-key
	 *
	 * Authenticates to a Seerr instance using a stored Plex token,
	 * then retrieves the API key from Seerr's settings endpoint.
	 *
	 * Requires: the user has completed Plex OAuth and has a valid tokenRef.
	 * Returns: { apiKey, version } for form pre-fill.
	 */
	app.post(
		"/fetch-key",
		{ config: { rateLimit: FETCH_KEY_RATE_LIMIT } },
		async (request, reply) => {
			const { seerrUrl, tokenRef } = validateRequest(fetchKeySchema, request.body);

			// Look up the stored Plex auth token
			const plexToken = peekToken(tokenRef);
			if (!plexToken) {
				return reply
					.status(400)
					.send(errorPayload("Plex token expired. Please sign in with Plex again."));
			}

			const baseUrl = seerrUrl.replace(/\/$/, "");

			// Only allow http/https schemes to prevent SSRF
			try {
				const scheme = new URL(baseUrl).protocol;
				if (scheme !== "http:" && scheme !== "https:") {
					return reply
						.status(400)
						.send(errorPayload("Invalid URL scheme. Use http:// or https://."));
				}
			} catch {
				return reply.status(400).send(errorPayload("Invalid Seerr URL."));
			}

			// Step 1a: Fetch CSRF token from Seerr (required if CSRF protection is enabled)
			let csrfCookie = "";
			let csrfToken = "";
			try {
				const csrfResponse = await fetch(`${baseUrl}/api/v1/status`, {
					headers: { Accept: "application/json" },
					signal: AbortSignal.timeout(SEERR_TIMEOUT),
				});
				const csrfCookies = csrfResponse.headers.getSetCookie?.() ?? [];
				if (csrfCookies.length === 0) {
					const raw = csrfResponse.headers.get("set-cookie") ?? "";
					if (raw) csrfCookies.push(...raw.split(/,(?=\s*\w+=)/));
				}
				// Extract cookie values for the request header
				const cookieParts = csrfCookies.map((c) => c.split(";")[0]).filter(Boolean);
				csrfCookie = cookieParts.join("; ");
				// Extract XSRF-TOKEN value for the X-XSRF-TOKEN header
				const xsrfCookie = cookieParts.find((c) => c?.startsWith("XSRF-TOKEN="));
				if (xsrfCookie) {
					csrfToken = decodeURIComponent(xsrfCookie.split("=").slice(1).join("="));
				}
			} catch (err: unknown) {
				// CSRF fetch failed — proceed without it (works if CSRF is disabled)
				request.log.debug({ err }, "CSRF preflight failed — proceeding without CSRF tokens");
			}

			// Step 1b: Authenticate to Seerr using the Plex token
			let authResponse: Response;
			try {
				const authHeaders: Record<string, string> = {
					"Content-Type": "application/json",
					Accept: "application/json",
				};
				if (csrfCookie) authHeaders.Cookie = csrfCookie;
				if (csrfToken) authHeaders["x-xsrf-token"] = csrfToken;

				authResponse = await fetch(`${baseUrl}/api/v1/auth/plex`, {
					method: "POST",
					headers: authHeaders,
					body: JSON.stringify({ authToken: plexToken }),
					signal: AbortSignal.timeout(SEERR_TIMEOUT),
				});
			} catch (err: unknown) {
				request.log.warn({ err }, "Seerr auth network error");
				return reply
					.status(502)
					.send(errorPayload("Could not reach Seerr", getErrorMessage(err, "Network error")));
			}

			if (authResponse.status === 403) {
				return reply
					.status(400)
					.send(
						errorPayload("Your Plex account does not have admin access to this Seerr instance."),
					);
			}

			if (authResponse.status === 500) {
				const raw = await safeJson(authResponse);
				const body = raw as { error?: string } | null;
				if (body?.error?.toLowerCase().includes("plex login is disabled")) {
					return reply
						.status(400)
						.send(errorPayload("Plex sign-in is disabled on this Seerr instance."));
				}
				return reply
					.status(502)
					.send(errorPayload("Seerr returned an error during authentication."));
			}

			if (!authResponse.ok) {
				request.log.warn({ status: authResponse.status }, "Seerr auth failed");
				return reply
					.status(502)
					.send(
						errorPayload(
							"Failed to authenticate to Seerr",
							`Seerr returned HTTP ${authResponse.status}`,
						),
					);
			}

			// Validate auth response
			const authRaw = await safeJson(authResponse);
			if (authRaw === null) {
				request.log.warn("Seerr auth response was not valid JSON");
				return reply.status(502).send(errorPayload("Unexpected response from Seerr"));
			}
			const authParsed = seerrAuthResponseSchema.safeParse(authRaw);
			if (!authParsed.success) {
				return reply.status(502).send(errorPayload("Unexpected response from Seerr"));
			}

			// Extract session cookie from the auth response
			// Use getSetCookie() when available (Node 18.14+), fallback to header splitting
			let setCookieHeaders = authResponse.headers.getSetCookie?.() ?? [];
			if (setCookieHeaders.length === 0) {
				const raw = authResponse.headers.get("set-cookie") ?? "";
				if (raw) setCookieHeaders = raw.split(/,(?=\s*\w+=)/);
			}
			const sessionCookie = setCookieHeaders
				.map((c) => c.split(";")[0])
				.filter((c) => c?.startsWith("connect.sid="))
				.join("; ");

			if (!sessionCookie) {
				request.log.warn("Seerr auth succeeded but no session cookie returned");
				return reply
					.status(502)
					.send(errorPayload("Seerr authentication succeeded but no session was created."));
			}

			// Step 2: Fetch the API key from settings (requires admin session)
			let settingsResponse: Response;
			try {
				settingsResponse = await fetch(`${baseUrl}/api/v1/settings/main`, {
					headers: {
						Accept: "application/json",
						Cookie: sessionCookie,
					},
					signal: AbortSignal.timeout(SEERR_TIMEOUT),
				});
			} catch (err: unknown) {
				request.log.warn({ err }, "Seerr settings fetch network error");
				return reply
					.status(502)
					.send(errorPayload("Could not reach Seerr", getErrorMessage(err, "Network error")));
			}

			if (settingsResponse.status === 403) {
				return reply
					.status(400)
					.send(
						errorPayload("Your Plex account does not have admin access to this Seerr instance."),
					);
			}

			if (!settingsResponse.ok) {
				request.log.warn({ status: settingsResponse.status }, "Seerr settings fetch failed");
				return reply
					.status(502)
					.send(
						errorPayload(
							"Failed to retrieve Seerr settings",
							`Seerr returned HTTP ${settingsResponse.status}`,
						),
					);
			}

			const settingsRaw = await safeJson(settingsResponse);
			if (settingsRaw === null) {
				request.log.warn("Seerr settings response was not valid JSON");
				return reply.status(502).send(errorPayload("Unexpected response from Seerr"));
			}
			const settingsParsed = seerrSettingsMainSchema.safeParse(settingsRaw);
			if (!settingsParsed.success) {
				// apiKey missing — likely non-admin user (defense-in-depth on Seerr's side)
				return reply
					.status(400)
					.send(
						errorPayload(
							"Could not retrieve API key. Your Plex account may not have admin permissions in Seerr.",
						),
					);
			}

			// Step 3: Get Seerr version for the label
			let version = "unknown";
			try {
				const statusResponse = await fetch(`${baseUrl}/api/v1/status`, {
					headers: { Accept: "application/json", Cookie: sessionCookie },
					signal: AbortSignal.timeout(SEERR_TIMEOUT),
				});
				if (statusResponse.ok) {
					const statusRaw = await safeJson(statusResponse);
					const statusParsed = seerrStatusSchema.safeParse(statusRaw);
					if (statusParsed.success) {
						version = statusParsed.data.version;
					}
				}
			} catch (err: unknown) {
				// Version fetch is best-effort — log but don't fail the whole flow
				request.log.debug({ err }, "Seerr version fetch failed (best-effort)");
			}

			const result: SeerrFetchKeyResponse = {
				apiKey: settingsParsed.data.apiKey,
				version,
			};
			return reply.send(result);
		},
	);
}
