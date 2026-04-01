import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks — vi.hoisted ensures these exist before vi.mock factories
// ---------------------------------------------------------------------------

const { mockPeekToken } = vi.hoisted(() => ({
	mockPeekToken: vi.fn(),
}));

vi.mock("../../../lib/plex/token-store.js", () => ({
	peekToken: (...args: unknown[]) => mockPeekToken(...args),
}));

// Mock global.fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import Fastify from "fastify";
import { registerSeerrOAuthRoutes } from "../oauth-routes.js";
import {
	setupAuthInjection,
	createInjectAuthenticated,
	registerTestErrorHandler,
} from "../../__tests__/test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200, cookies: string[] = []) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			...(cookies.length > 0 ? { "Set-Cookie": cookies.join(", ") } : {}),
		},
	});
}

/** Mock the CSRF preflight GET /status call that happens before auth */
function mockCsrfPreflight() {
	mockFetch.mockResolvedValueOnce(
		jsonResponse({ version: "2.0.0" }, 200, ["_csrf=secret; Path=/", "XSRF-TOKEN=token123; Path=/"]),
	);
}

// ---------------------------------------------------------------------------
// Fastify setup
// ---------------------------------------------------------------------------

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	vi.clearAllMocks();
	mockFetch.mockReset();

	app = Fastify();
	setupAuthInjection(app);
	registerTestErrorHandler(app);
	await app.register(registerSeerrOAuthRoutes, { prefix: "/oauth" });
	await app.ready();

	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => {
	await app.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /oauth/fetch-key", () => {
	const validBody = { seerrUrl: "http://seerr:5055", tokenRef: "test-ref" };

	// ================================================================
	// Success path
	// ================================================================

	it("returns apiKey and version when Plex token valid and Seerr admin", async () => {
		mockPeekToken.mockReturnValue("plex-token-abc");
		mockCsrfPreflight();

		mockFetch
			// Step 1: POST auth/plex → 200 with session cookie
			.mockResolvedValueOnce(
				jsonResponse({ id: 1, permissions: 2 }, 200, ["connect.sid=abc123; Path=/"]),
			)
			// Step 2: GET settings/main → 200 with apiKey
			.mockResolvedValueOnce(jsonResponse({ apiKey: "seerr-key-456" }))
			// Step 3: GET status → 200 with version
			.mockResolvedValueOnce(jsonResponse({ version: "2.0.0" }));

		const res = await injectAuthenticated("POST", "/oauth/fetch-key", { body: validBody });

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body).toEqual({ apiKey: "seerr-key-456", version: "2.0.0" });

		// Verify fetch calls (4 total: CSRF preflight + auth + settings + status)
		expect(mockFetch).toHaveBeenCalledTimes(4);
		expect(mockFetch.mock.calls[0]![0]).toBe("http://seerr:5055/api/v1/status"); // CSRF
		expect(mockFetch.mock.calls[1]![0]).toBe("http://seerr:5055/api/v1/auth/plex");
		expect(mockFetch.mock.calls[2]![0]).toBe("http://seerr:5055/api/v1/settings/main");
		expect(mockFetch.mock.calls[3]![0]).toBe("http://seerr:5055/api/v1/status"); // version
	});

	// ================================================================
	// Token store errors
	// ================================================================

	it("returns 400 when tokenRef not found (peekToken returns null)", async () => {
		mockPeekToken.mockReturnValue(null);

		const res = await injectAuthenticated("POST", "/oauth/fetch-key", { body: validBody });

		expect(res.statusCode).toBe(400);
		const body = res.json();
		expect(body.error).toMatch(/Plex token expired/i);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	// ================================================================
	// Seerr network errors
	// ================================================================

	it("returns 502 when Seerr is unreachable (fetch throws)", async () => {
		mockPeekToken.mockReturnValue("plex-token-abc");
		mockCsrfPreflight();
		// CSRF preflight also fails if Seerr is unreachable — but the code catches it
		// The auth POST fetch will then throw
		mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

		const res = await injectAuthenticated("POST", "/oauth/fetch-key", { body: validBody });

		expect(res.statusCode).toBe(502);
		const body = res.json();
		expect(body.error).toMatch(/Could not reach Seerr/i);
	});

	// ================================================================
	// Seerr auth errors
	// ================================================================

	it("returns 400 when Seerr returns 403 (not admin)", async () => {
		mockPeekToken.mockReturnValue("plex-token-abc");
		mockCsrfPreflight();
		mockFetch.mockResolvedValueOnce(jsonResponse({ error: "Forbidden" }, 403));

		const res = await injectAuthenticated("POST", "/oauth/fetch-key", { body: validBody });

		expect(res.statusCode).toBe(400);
		const body = res.json();
		expect(body.error).toMatch(/does not have admin access/i);
	});

	it("returns 400 when Seerr returns 500 with 'Plex login is disabled'", async () => {
		mockPeekToken.mockReturnValue("plex-token-abc");
		mockCsrfPreflight();
		mockFetch.mockResolvedValueOnce(
			jsonResponse({ error: "Plex login is disabled for this Overseerr instance" }, 500),
		);

		const res = await injectAuthenticated("POST", "/oauth/fetch-key", { body: validBody });

		expect(res.statusCode).toBe(400);
		const body = res.json();
		expect(body.error).toMatch(/Plex sign-in is disabled/i);
	});

	it("returns 502 when Seerr returns generic 500", async () => {
		mockPeekToken.mockReturnValue("plex-token-abc");
		mockCsrfPreflight();
		mockFetch.mockResolvedValueOnce(jsonResponse({ error: "Internal Server Error" }, 500));

		const res = await injectAuthenticated("POST", "/oauth/fetch-key", { body: validBody });

		expect(res.statusCode).toBe(502);
		const body = res.json();
		expect(body.error).toMatch(/Seerr returned an error/i);
	});

	// ================================================================
	// Session cookie errors
	// ================================================================

	it("returns 502 when no session cookie in auth response", async () => {
		mockPeekToken.mockReturnValue("plex-token-abc");
		mockCsrfPreflight();
		// Auth succeeds but no Set-Cookie header
		mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1, permissions: 2 }, 200));

		const res = await injectAuthenticated("POST", "/oauth/fetch-key", { body: validBody });

		expect(res.statusCode).toBe(502);
		const body = res.json();
		expect(body.error).toMatch(/no session was created/i);
	});

	// ================================================================
	// Settings errors
	// ================================================================

	it("returns 400 when settings response is missing apiKey (non-admin fallthrough)", async () => {
		mockPeekToken.mockReturnValue("plex-token-abc");
		mockCsrfPreflight();

		mockFetch
			// Auth succeeds with session cookie
			.mockResolvedValueOnce(
				jsonResponse({ id: 1, permissions: 2 }, 200, ["connect.sid=abc123; Path=/"]),
			)
			// Settings returns object without apiKey (non-admin user)
			.mockResolvedValueOnce(jsonResponse({ applicationTitle: "Seerr" }));

		const res = await injectAuthenticated("POST", "/oauth/fetch-key", { body: validBody });

		expect(res.statusCode).toBe(400);
		const body = res.json();
		expect(body.error).toMatch(/Could not retrieve API key/i);
	});

	// ================================================================
	// Validation errors
	// ================================================================

	it("returns 400 for invalid seerrUrl (not a URL)", async () => {
		mockPeekToken.mockReturnValue("plex-token-abc");
		mockCsrfPreflight();

		const res = await injectAuthenticated("POST", "/oauth/fetch-key", {
			body: { seerrUrl: "not-a-url", tokenRef: "test-ref" },
		});

		expect(res.statusCode).toBe(400);
	});

	// ================================================================
	// Version fallback
	// ================================================================

	it("returns 'unknown' version when status endpoint fails", async () => {
		mockPeekToken.mockReturnValue("plex-token-abc");
		mockFetch.mockReset(); // Clear any leftover mocks completely
		// 4 fetches: CSRF preflight, auth, settings, version (fails)
		mockFetch
			.mockResolvedValueOnce(jsonResponse({ version: "2.0.0" }, 200, ["_csrf=s; Path=/", "XSRF-TOKEN=t; Path=/"]))
			.mockResolvedValueOnce(jsonResponse({ id: 1, permissions: 2 }, 200, ["connect.sid=abc123; Path=/"]))
			.mockResolvedValueOnce(jsonResponse({ apiKey: "seerr-key-789" }))
			.mockRejectedValueOnce(new Error("timeout"));

		const res = await injectAuthenticated("POST", "/oauth/fetch-key", { body: validBody });

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body).toEqual({ apiKey: "seerr-key-789", version: "unknown" });
	});

	it("returns 'unknown' version when status endpoint returns non-OK", async () => {
		mockPeekToken.mockReturnValue("plex-token-abc");
		// 4 fetches: CSRF preflight, auth, settings, version (non-OK)
		mockFetch
			.mockResolvedValueOnce(jsonResponse({ version: "2.0.0" }, 200, ["_csrf=s; Path=/", "XSRF-TOKEN=t; Path=/"]))
			.mockResolvedValueOnce(jsonResponse({ id: 1, permissions: 2 }, 200, ["connect.sid=abc123; Path=/"]))
			.mockResolvedValueOnce(jsonResponse({ apiKey: "seerr-key-789" }))
			.mockResolvedValueOnce(jsonResponse({ error: "Internal error" }, 500));

		const res = await injectAuthenticated("POST", "/oauth/fetch-key", { body: validBody });

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.version).toBe("unknown");
	});

	// ================================================================
	// Trailing slash normalization
	// ================================================================

	it("strips trailing slash from seerrUrl", async () => {
		mockPeekToken.mockReturnValue("plex-token-abc");
		mockCsrfPreflight();

		// 4 fetches: CSRF preflight, auth, settings, version
		mockFetch
			.mockResolvedValueOnce(jsonResponse({ version: "1.0.0" }, 200, ["_csrf=s; Path=/"]))
			.mockResolvedValueOnce(jsonResponse({ id: 1, permissions: 2 }, 200, ["connect.sid=abc123; Path=/"]))
			.mockResolvedValueOnce(jsonResponse({ apiKey: "key-123" }))
			.mockResolvedValueOnce(jsonResponse({ version: "1.0.0" }));

		await injectAuthenticated("POST", "/oauth/fetch-key", {
			body: { seerrUrl: "http://seerr:5055/", tokenRef: "test-ref" },
		});

		// calls[0] is CSRF preflight, calls[1] is auth
		expect(mockFetch.mock.calls[1]![0]).toBe("http://seerr:5055/api/v1/auth/plex");
	});
});
