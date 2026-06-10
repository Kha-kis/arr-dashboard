/**
 * Service connection testing utilities
 */

export interface ConnectionTestResult {
	success: boolean;
	message?: string;
	version?: string;
	error?: string;
	details?: string;
}

// Known auth proxy session cookie name patterns
const AUTH_PROXY_COOKIE_PATTERNS = [
	"authelia_session",
	"authentik_session",
	"_oauth2_proxy",
	"_vouch",
	"_forward_auth",
	"organizr_token",
] as const;

/**
 * Detect if a response was intercepted by an authentication proxy.
 * Common in self-hosted setups (Authelia, Authentik, Traefik Forward Auth).
 */
function detectAuthProxy(response: Response, requestUrl: string): string | null {
	const finalUrl = response.url;

	// Request was redirected to a different host (auth proxy redirect)
	if (finalUrl && finalUrl !== requestUrl) {
		const requestHost = new URL(requestUrl).hostname;
		try {
			const responseHost = new URL(finalUrl).hostname;
			if (responseHost !== requestHost) {
				return `Request was redirected to ${responseHost}, which appears to be an authentication proxy.`;
			}
		} catch {
			// Invalid URL in response, skip check
		}
	}

	// Check for auth proxy session cookies
	const setCookie = response.headers.get("set-cookie")?.toLowerCase() ?? "";
	for (const pattern of AUTH_PROXY_COOKIE_PATTERNS) {
		if (setCookie.includes(pattern)) {
			return `Detected authentication proxy in response (${pattern} cookie).`;
		}
	}

	return null;
}

const AUTH_PROXY_ADVICE =
	"Your reverse proxy's authentication is intercepting API requests before they reach the service. " +
	"To fix this, either:\n" +
	"• Use the service's internal/LAN URL (e.g., http://192.168.1.x:PORT or http://container-name:PORT) instead of the public URL\n" +
	"• Configure your auth proxy to bypass authentication for the service's API paths";

/**
 * Tests connection to a service instance using the system/status endpoint.
 * This is the standard approach used by most *arr integration tools.
 */
export async function testServiceConnection(
	baseUrl: string,
	apiKey: string,
	service: string,
): Promise<ConnectionTestResult> {
	try {
		const normalizedBaseUrl = baseUrl.replace(/\/$/, "");


		// Plex uses X-Plex-Token header auth
		if (service === "plex") {
			return await testPlexConnection(normalizedBaseUrl, apiKey);
		}

		// Jellyfin and Emby use the same MediaBrowser auth header and API
		if (service === "jellyfin" || service === "emby") {
			return await testJellyfinConnection(normalizedBaseUrl, apiKey);
		}

		// qui uses X-API-Key header and exposes /api/instances as an
		// authenticated probe; testQuiConnection wraps the same client
		// helper used by route handlers so test + runtime stay in sync.
		if (service === "qui") {
			return await testQuiConnection(normalizedBaseUrl, apiKey);
		}

		// Seerr uses its own status endpoint; Prowlarr/Lidarr/Readarr use v1; Sonarr/Radarr use v3
		const apiPath =
			service === "seerr"
				? "/api/v1/status"
				: ["prowlarr", "lidarr", "readarr"].includes(service)
					? "/api/v1/system/status"
					: "/api/v3/system/status";
		const testUrl = `${normalizedBaseUrl}${apiPath}`;

		const response = await fetch(testUrl, {
			headers: {
				"X-Api-Key": apiKey,
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(5000),
		});

		// Check for auth proxy interception (redirected to login, proxy cookies, etc.)
		const proxyDetected = detectAuthProxy(response, testUrl);
		if (proxyDetected) {
			return {
				success: false,
				error: "Authentication proxy detected",
				details: `${proxyDetected}\n\n${AUTH_PROXY_ADVICE}`,
			};
		}

		if (!response.ok) {
			return handleHttpError(response, normalizedBaseUrl);
		}

		const contentType = response.headers.get("content-type");
		if (!contentType?.includes("application/json")) {
			return {
				success: false,
				error: "Invalid response format",
				details:
					"Received HTML instead of JSON. Check if the base URL is correct and includes any URL base if configured in the service (e.g., http://localhost:7878 for root, or http://localhost/radarr if using a URL base). If this service is behind a reverse proxy with authentication (Authelia, Authentik, etc.), use the internal/LAN URL instead.",
			};
		}

		const data = (await response.json()) as { version?: string };
		const version = data.version ?? "unknown";

		// Seerr-specific second probe: `/api/v1/status` is tagged `public` in Seerr's
		// openapi spec and skips the `isAuthenticated` middleware. That means a Seerr
		// instance whose API-key-backed user (user ID 1 by default; see
		// https://github.com/seerr-team/seerr/blob/main/server/middleware/auth.ts)
		// has no usable permissions still passes the status probe — the connection
		// check then reports "success" while every real feature call (Discover,
		// Requests, Users) returns 403. Probe one permission-gated endpoint here so
		// that under-powered configurations fail at setup time rather than later in
		// the user's flow. See issue #465.
		if (service === "seerr") {
			const permissionProbe = await probeSeerrPermissions(normalizedBaseUrl, apiKey, version);
			if (permissionProbe) return permissionProbe;
		}

		return {
			success: true,
			message: `Successfully connected to ${service.charAt(0).toUpperCase() + service.slice(1)}`,
			version,
		};
	} catch (error: unknown) {
		return handleConnectionError(error);
	}
}

/**
 * Probe a permission-gated Seerr endpoint after `/api/v1/status` has succeeded.
 * Returns a failing `ConnectionTestResult` when the probe shows the API key's
 * backing user can't actually exercise the endpoints arr-dashboard relies on,
 * `null` when the probe passed (the caller continues with its success response).
 *
 * `/api/v1/request/count` is the right probe because (a) it's a tiny response,
 * (b) it requires the same permission class (`Manage Requests` / `Admin`) that
 * Discover, Requests, and Users surfaces all need, and (c) Seerr returns a
 * clean 403 with the documented "You do not have permission…" body when the
 * user lacks permission rather than a noisy empty success. Match the literal
 * status here so the actionable error copy can be specific.
 */
async function probeSeerrPermissions(
	baseUrl: string,
	apiKey: string,
	version: string,
): Promise<ConnectionTestResult | null> {
	const probeUrl = `${baseUrl}/api/v1/request/count`;
	let probeResponse: Response;
	try {
		probeResponse = await fetch(probeUrl, {
			headers: { "X-Api-Key": apiKey, Accept: "application/json" },
			signal: AbortSignal.timeout(5000),
		});
	} catch {
		// The status probe already succeeded, so a network blip on the second
		// hop is more likely a transient than a misconfiguration. Don't fail
		// the connection test on transient probe failures — let the user
		// proceed and surface errors at feature-call time instead.
		return null;
	}

	if (probeResponse.ok) {
		return null;
	}

	if (probeResponse.status === 403) {
		return {
			success: false,
			error: "Connected, but Seerr API key lacks required permissions",
			details:
				"Reached Seerr successfully, but the API-key-backed user account (user ID 1 — the original administrator — by default) cannot access permission-gated endpoints. Open Seerr → Settings → Users, find the first user listed (user ID 1), and either grant Admin or enable Manage Requests + Manage Users + Request Movies/TV. If user ID 1 has been deleted, a Seerr-side recovery is required.",
			version,
		};
	}

	// Any other non-2xx from the probe is interesting but not necessarily
	// fatal (could be a partial outage, rate limit, etc.). Fall through to
	// success — the status probe already proved reachability + key validity.
	return null;
}

/**
 * Handles HTTP error responses with specific messages for common status codes
 */
function handleHttpError(response: Response, baseUrl: string): ConnectionTestResult {
	const status = response.status;
	const contentType = response.headers.get("content-type");

	// Authentication errors - API key issue or reverse proxy auth
	if (status === 401) {
		return {
			success: false,
			error: "Authentication failed (401)",
			details:
				"Invalid API key, or a reverse proxy is blocking the request. Verify the API key is correct. If this service is behind an auth proxy (Authelia, Authentik, etc.), use the service's internal/LAN URL instead of the public URL.",
		};
	}

	if (status === 403) {
		// Check if this looks like a CSRF or auth proxy issue
		const isHtml = contentType?.includes("text/html");
		if (isHtml) {
			return {
				success: false,
				error: "Access blocked by proxy (403)",
				details: AUTH_PROXY_ADVICE,
			};
		}
		return {
			success: false,
			error: "Access forbidden (403)",
			details:
				"The API key may lack permissions, or a reverse proxy is denying access. If this service is behind an auth proxy (Authelia, Authentik, etc.), use the service's internal/LAN URL instead of the public URL.",
		};
	}

	// Server errors
	if (status >= 500) {
		return {
			success: false,
			error: `Server error (${status})`,
			details:
				"The service encountered an internal error. Check the service logs for more details.",
		};
	}

	// Not found - likely wrong URL
	if (status === 404) {
		return {
			success: false,
			error: "Endpoint not found (404)",
			details: `The API endpoint was not found at ${baseUrl}. Check if the base URL is correct and the service is running.`,
		};
	}

	// HTML response usually means wrong URL or proxy issue
	if (contentType?.includes("text/html")) {
		return {
			success: false,
			error: `HTTP ${status}: ${response.statusText}`,
			details:
				"Received HTML instead of JSON. The base URL might be incorrect, or a reverse proxy is returning an error page.",
		};
	}

	// Generic error for other status codes
	return {
		success: false,
		error: `HTTP ${status}: ${response.statusText}`,
		details: "Check your base URL and API key are correct.",
	};
}

/**
 * Tests connection to a qui (autobrr/qui) instance.
 *
 * Two-step probe: hit `/api/instances` with `X-API-Key` to confirm both
 * reachability and authentication in one call. qui returns an array of
 * qBittorrent instances under management — empty array is still a
 * success (qui is reachable and the key is valid; the operator just
 * hasn't added qBit instances yet).
 */
async function testQuiConnection(baseUrl: string, apiKey: string): Promise<ConnectionTestResult> {
	const testUrl = `${baseUrl}/api/instances`;

	let response: Response;
	try {
		response = await fetch(testUrl, {
			headers: {
				"X-API-Key": apiKey,
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(5000),
		});
	} catch (error) {
		return handleConnectionError(error);
	}

	const proxyDetected = detectAuthProxy(response, testUrl);
	if (proxyDetected) {
		return {
			success: false,
			error: "Authentication proxy detected",
			details: `${proxyDetected}\n\n${AUTH_PROXY_ADVICE}`,
		};
	}

	if (!response.ok) {
		return handleHttpError(response, baseUrl);
	}

	const contentType = response.headers.get("content-type");
	if (!contentType?.includes("application/json")) {
		return {
			success: false,
			error: "Invalid response format",
			details:
				"Received non-JSON response from qui. Check the base URL points at a qui instance (default: http://localhost:7476). If qui sits behind a reverse proxy on a subpath, include that subpath in the base URL (e.g. https://example.com/qui).",
		};
	}

	const data = (await response.json()) as Array<{ name?: string; connected?: boolean }>;
	if (!Array.isArray(data)) {
		return {
			success: false,
			error: "Unexpected qui response",
			details: "Expected an array of qBittorrent instances. Check the base URL is correct.",
		};
	}

	const connectedCount = data.filter((i) => i.connected).length;
	const totalCount = data.length;

	let message = "Successfully connected to qui";
	if (totalCount === 0) {
		message = "Connected to qui (no qBittorrent instances configured yet)";
	} else if (connectedCount < totalCount) {
		message = `Connected to qui (${connectedCount}/${totalCount} qBit instances reachable)`;
	} else {
		message = `Connected to qui (${totalCount} qBit instance${totalCount === 1 ? "" : "s"})`;
	}

	return {
		success: true,
		message,
	};
}

/**
 * Tests connection to a Plex Media Server using X-Plex-Token auth.
 */
async function testPlexConnection(baseUrl: string, token: string): Promise<ConnectionTestResult> {
	const testUrl = `${baseUrl}/identity`;

	const response = await fetch(testUrl, {
		headers: {
			Accept: "application/json",
			"X-Plex-Token": token,
		},
		signal: AbortSignal.timeout(5000),
	});

	const proxyDetected = detectAuthProxy(response, testUrl);
	if (proxyDetected) {
		return {
			success: false,
			error: "Authentication proxy detected",
			details: `${proxyDetected}\n\n${AUTH_PROXY_ADVICE}`,
		};
	}

	if (!response.ok) {
		return handleHttpError(response, baseUrl);
	}

	const contentType = response.headers.get("content-type");
	if (!contentType?.includes("application/json")) {
		return {
			success: false,
			error: "Invalid response format",
			details:
				"Received HTML instead of JSON. Check if the base URL is correct (e.g., http://localhost:32400). If behind an auth proxy, use the internal/LAN URL.",
		};
	}

	const json = (await response.json()) as {
		MediaContainer?: { friendlyName?: string; version?: string; machineIdentifier?: string };
	};

	if (!json.MediaContainer?.machineIdentifier) {
		return {
			success: false,
			error: "Invalid Plex response",
			details: "Response did not contain a machine identifier. Check the URL and token.",
		};
	}

	const name = json.MediaContainer.friendlyName;
	const version = json.MediaContainer.version ?? "unknown";
	return {
		success: true,
		message: name ? `Successfully connected to ${name}` : "Successfully connected to Plex",
		version,
	};
}

/**
 * Tests connection to a Jellyfin server using the public info endpoint + API key validation.
 */
async function testJellyfinConnection(
	baseUrl: string,
	apiKey: string,
): Promise<ConnectionTestResult> {
	// First test with public endpoint (no auth needed)
	const publicUrl = `${baseUrl}/System/Info/Public`;

	const response = await fetch(publicUrl, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(5000),
	});

	const proxyDetected = detectAuthProxy(response, publicUrl);
	if (proxyDetected) {
		return {
			success: false,
			error: "Authentication proxy detected",
			details: `${proxyDetected}\n\n${AUTH_PROXY_ADVICE}`,
		};
	}

	if (!response.ok) {
		return handleHttpError(response, baseUrl);
	}

	const contentType = response.headers.get("content-type");
	if (!contentType?.includes("application/json")) {
		return {
			success: false,
			error: "Invalid response format",
			details:
				"Received HTML instead of JSON. Check if the base URL is correct (e.g., http://localhost:8096). If behind an auth proxy, use the internal/LAN URL.",
		};
	}

	const json = (await response.json()) as {
		ServerName?: string;
		Version?: string;
		Id?: string;
	};

	if (!json.Id) {
		return {
			success: false,
			error: "Invalid Jellyfin response",
			details: "Response did not contain a server ID. Check the URL points to a Jellyfin server.",
		};
	}

	// Validate the API key by calling an authenticated endpoint
	const authUrl = `${baseUrl}/System/Info`;
	try {
		const authResponse = await fetch(authUrl, {
			headers: {
				Accept: "application/json",
				Authorization: `MediaBrowser Token="${apiKey}"`,
			},
			signal: AbortSignal.timeout(5000),
		});
		if (authResponse.status === 401) {
			return {
				success: false,
				error: "Authentication failed (401)",
				details: "Invalid API key. Generate one in Jellyfin Dashboard > API Keys.",
			};
		}
	} catch (authErr) {
		return {
			success: false,
			error: "API key validation failed",
			details:
				"Jellyfin server was reached but the API key could not be verified. Check your key in Jellyfin Dashboard > API Keys.",
			version: json.Version,
		};
	}

	const name = json.ServerName ?? "Jellyfin";
	const version = json.Version ?? "unknown";
	return {
		success: true,
		message: `Successfully connected to ${name}`,
		version,
	};
}

/**
 * Handles connection errors and returns appropriate error result
 */
function handleConnectionError(error: unknown): ConnectionTestResult {
	let errorMessage = "Connection failed";
	let details = "Unknown error";

	// Node.js fetch wraps real errors in TypeError with message "fetch failed" —
	// the actual cause (ECONNREFUSED, ENOTFOUND, etc.) is in error.cause
	const raw = error as { cause?: unknown; name?: string; code?: string; message?: string };
	const cause = raw?.cause as { name?: string; code?: string; message?: string } | undefined;
	const err = cause?.code || cause?.name ? cause : raw;

	if (err && typeof err === "object") {
		if (err.name === "TimeoutError" || err.code === "ETIMEDOUT") {
			errorMessage = "Connection timeout";
			details =
				"The service did not respond within 5 seconds. Check if the service is running and the base URL is correct.";
		} else if (err.code === "ECONNREFUSED") {
			errorMessage = "Connection refused";
			details =
				"Could not connect to the service. Verify the base URL and that the service is running.";
		} else if (err.code === "ENOTFOUND") {
			errorMessage = "Host not found";
			details =
				"Could not resolve the hostname. Check that the base URL is correct and the DNS name is reachable from this server.";
		} else if (
			err.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
			err.code === "CERT_HAS_EXPIRED" ||
			err.code === "DEPTH_ZERO_SELF_SIGNED_CERT"
		) {
			errorMessage = "TLS/SSL error";
			details =
				"Certificate verification failed. If using a self-signed certificate, try using HTTP instead of HTTPS, or configure your system to trust the certificate.";
		} else if (err.message && err.message !== "fetch failed") {
			details = err.message;
		} else if (cause?.message) {
			details = cause.message;
		}
	}

	return {
		success: false,
		error: errorMessage,
		details,
	};
}
