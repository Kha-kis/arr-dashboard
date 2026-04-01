import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Global fetch mock (captures plex.tv calls AND testConnection calls)
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import Fastify from "fastify";
import { registerOAuthRoutes } from "../oauth-routes.js";
import {
	setupAuthInjection,
	createInjectAuthenticated,
	registerTestErrorHandler,
} from "../../__tests__/test-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CLIENT_ID = "550e8400-e29b-41d4-a716-446655440000";

function jsonResponse(data: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => data,
	} as unknown as Response;
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeAll(async () => {
	app = Fastify();
	setupAuthInjection(app);
	registerTestErrorHandler(app);
	app.register(registerOAuthRoutes, { prefix: "/oauth" });
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

beforeEach(() => vi.resetAllMocks());
afterAll(() => app.close());

// ============================================================================
// POST /oauth/pin — Create PIN
// ============================================================================

describe("POST /oauth/pin", () => {
	it("returns pinId and pinCode on success", async () => {
		mockFetch.mockResolvedValueOnce(jsonResponse({ id: 12345, code: "abc123" }));

		const res = await injectAuthenticated("POST", "/oauth/pin", {
			body: { clientId: VALID_CLIENT_ID },
		});

		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ pinId: 12345, pinCode: "abc123" });
	});

	it("returns 400 when clientId is missing", async () => {
		const res = await injectAuthenticated("POST", "/oauth/pin", {
			body: {},
		});

		expect(res.statusCode).toBe(400);
	});

	it("returns 400 when clientId is not a UUID", async () => {
		const res = await injectAuthenticated("POST", "/oauth/pin", {
			body: { clientId: "not-a-uuid" },
		});

		expect(res.statusCode).toBe(400);
	});

	it("returns 502 when plex.tv returns non-200", async () => {
		mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

		const res = await injectAuthenticated("POST", "/oauth/pin", {
			body: { clientId: VALID_CLIENT_ID },
		});

		expect(res.statusCode).toBe(502);
		expect(res.json().error).toBe("Failed to create Plex PIN");
	});

	it("returns 502 when fetch throws a network error", async () => {
		mockFetch.mockRejectedValueOnce(new Error("DNS resolution failed"));

		const res = await injectAuthenticated("POST", "/oauth/pin", {
			body: { clientId: VALID_CLIENT_ID },
		});

		expect(res.statusCode).toBe(502);
		expect(res.json().error).toBe("Could not reach plex.tv");
	});
});

// ============================================================================
// GET /oauth/pin/:pinId — Poll PIN
// ============================================================================

describe("GET /oauth/pin/:pinId", () => {
	it("returns null tokenRef when not yet approved", async () => {
		mockFetch.mockResolvedValueOnce(jsonResponse({ authToken: null }));

		const res = await injectAuthenticated(
			"GET",
			`/oauth/pin/12345?clientId=${VALID_CLIENT_ID}`,
		);

		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ tokenRef: null });
	});

	it("returns tokenRef when approved", async () => {
		mockFetch.mockResolvedValueOnce(jsonResponse({ authToken: "plex-token-123" }));

		const res = await injectAuthenticated(
			"GET",
			`/oauth/pin/12345?clientId=${VALID_CLIENT_ID}`,
		);

		expect(res.statusCode).toBe(200);
		const body = res.json();
		// Token is stored server-side; response contains a reference, not the raw token
		expect(body.tokenRef).toBeTruthy();
		expect(typeof body.tokenRef).toBe("string");
		expect(body.tokenRef).not.toBe("plex-token-123"); // Must NOT leak the raw token
	});

	it("returns 502 when plex.tv returns an error", async () => {
		mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

		const res = await injectAuthenticated(
			"GET",
			`/oauth/pin/12345?clientId=${VALID_CLIENT_ID}`,
		);

		expect(res.statusCode).toBe(502);
	});

	it("returns 502 on network error", async () => {
		mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

		const res = await injectAuthenticated(
			"GET",
			`/oauth/pin/12345?clientId=${VALID_CLIENT_ID}`,
		);

		expect(res.statusCode).toBe(502);
		expect(res.json().error).toBe("Could not reach plex.tv");
	});
});

// ============================================================================
// POST /oauth/servers — Discover servers
// ============================================================================

describe("POST /oauth/servers", () => {
	/** Helper: poll to get a stored tokenRef, then use it for server discovery */
	async function getTokenRef(): Promise<string> {
		mockFetch.mockResolvedValueOnce(jsonResponse({ authToken: "plex-token-for-test" }));
		const pollRes = await injectAuthenticated(
			"GET",
			`/oauth/pin/99999?clientId=${VALID_CLIENT_ID}`,
		);
		return pollRes.json().tokenRef;
	}

	it("returns servers with reachability status", async () => {
		const tokenRef = await getTokenRef();
		const plexResources = [
			{
				name: "My Server",
				clientIdentifier: "server-id-1",
				provides: "server",
				owned: true,
				platform: "Linux",
				productVersion: "1.32.0",
				connections: [
					{ protocol: "https", address: "192.168.1.10", port: 32400, uri: "https://192.168.1.10:32400", local: true, relay: false },
					{ protocol: "https", address: "203.0.113.10", port: 32400, uri: "https://203.0.113.10:32400", local: false, relay: false },
				],
			},
		];

		// First call: plex.tv resources lookup
		mockFetch.mockResolvedValueOnce(jsonResponse(plexResources));
		// Second + third calls: testConnection for each connection URI
		mockFetch.mockResolvedValueOnce(jsonResponse({}, 200)); // local reachable
		mockFetch.mockResolvedValueOnce(jsonResponse({}, 502)); // relay unreachable (non-ok)

		const res = await injectAuthenticated("POST", "/oauth/servers", {
			body: { tokenRef, clientId: VALID_CLIENT_ID },
		});

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.servers).toHaveLength(1);
		expect(body.servers[0].name).toBe("My Server");
		expect(body.servers[0].clientIdentifier).toBe("server-id-1");
		expect(body.servers[0].connections).toHaveLength(2);
		expect(body.servers[0].connections[0].reachable).toBe(true);
		expect(body.servers[0].connections[1].reachable).toBe(false);
	});

	it("filters out non-server resources", async () => {
		const tokenRef = await getTokenRef();
		const plexResources = [
			{
				name: "My Server",
				clientIdentifier: "server-1",
				provides: "server",
				owned: true,
				connections: [],
			},
			{
				name: "My Player",
				clientIdentifier: "player-1",
				provides: "player",
				owned: true,
				connections: [],
			},
		];

		mockFetch.mockResolvedValueOnce(jsonResponse(plexResources));

		const res = await injectAuthenticated("POST", "/oauth/servers", {
			body: { tokenRef, clientId: VALID_CLIENT_ID },
		});

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.servers).toHaveLength(1);
		expect(body.servers[0].name).toBe("My Server");
	});

	it("returns 400 when plex.tv returns 401 (expired token)", async () => {
		const tokenRef = await getTokenRef();
		mockFetch.mockResolvedValueOnce(jsonResponse({}, 401));

		const res = await injectAuthenticated("POST", "/oauth/servers", {
			body: { tokenRef, clientId: VALID_CLIENT_ID },
		});

		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe("Invalid or expired Plex token");
	});

	it("returns 502 on network error", async () => {
		const tokenRef = await getTokenRef();
		mockFetch.mockRejectedValueOnce(new Error("ETIMEDOUT"));

		const res = await injectAuthenticated("POST", "/oauth/servers", {
			body: { tokenRef, clientId: VALID_CLIENT_ID },
		});

		expect(res.statusCode).toBe(502);
		expect(res.json().error).toBe("Could not reach plex.tv");
	});
});

// ============================================================================
// POST /oauth/token — Retrieve stored token
// ============================================================================

describe("POST /oauth/token", () => {
	async function storeAndGetRef(): Promise<string> {
		mockFetch.mockResolvedValueOnce(jsonResponse({ authToken: "plex-token-for-retrieval" }));
		const pollRes = await injectAuthenticated(
			"GET",
			`/oauth/pin/88888?clientId=${VALID_CLIENT_ID}`,
		);
		return pollRes.json().tokenRef;
	}

	it("returns the stored auth token for a valid tokenRef", async () => {
		const tokenRef = await storeAndGetRef();
		const res = await injectAuthenticated("POST", "/oauth/token", { body: { tokenRef } });

		expect(res.statusCode).toBe(200);
		expect(res.json().authToken).toBe("plex-token-for-retrieval");
	});

	it("allows multiple retrievals (non-consuming)", async () => {
		const tokenRef = await storeAndGetRef();
		const res1 = await injectAuthenticated("POST", "/oauth/token", { body: { tokenRef } });
		const res2 = await injectAuthenticated("POST", "/oauth/token", { body: { tokenRef } });

		expect(res1.statusCode).toBe(200);
		expect(res2.statusCode).toBe(200);
		expect(res1.json().authToken).toBe(res2.json().authToken);
	});

	it("returns 400 for an unknown tokenRef", async () => {
		const res = await injectAuthenticated("POST", "/oauth/token", {
			body: { tokenRef: "nonexistent-ref" },
		});

		expect(res.statusCode).toBe(400);
		expect(res.json().error).toContain("Token expired");
	});
});
