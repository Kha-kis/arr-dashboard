import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const { mockSessionService } = vi.hoisted(() => ({
	mockSessionService: {
		createSession: vi.fn().mockResolvedValue({ token: "mock-session-token", id: "mock-session-id" }),
		attachCookie: vi.fn(),
		invalidateSession: vi.fn().mockResolvedValue(undefined),
		clearCookie: vi.fn(),
		invalidateAllUserSessions: vi.fn().mockResolvedValue(undefined),
	},
}));

// Mock OIDCProvider class — avoid real discovery/HTTP calls
const { MockOIDCProvider } = vi.hoisted(() => {
	const mockGetAuthorizationUrl = vi.fn().mockResolvedValue(
		"https://provider.example.com/authorize?client_id=test&state=mock-state&code_challenge=mock-challenge",
	);
	class MockOIDCProvider {
		config: Record<string, unknown>;
		static mockGetAuthorizationUrl = mockGetAuthorizationUrl;
		constructor(config: Record<string, unknown>) {
			this.config = config;
		}
		getAuthorizationUrl = mockGetAuthorizationUrl;
	}
	return { MockOIDCProvider };
});

vi.mock("../../lib/auth/oidc-provider.js", () => ({
	OIDCProvider: MockOIDCProvider,
}));

// Mock resolveCanonicalIssuer — avoid real discovery fetch
vi.mock("../../lib/auth/oidc-utils.js", () => ({
	resolveCanonicalIssuer: vi.fn().mockResolvedValue({
		issuer: "https://provider.example.com",
		source: "discovery",
	}),
}));

// Mock oauth4webapi PKCE functions
vi.mock("oauth4webapi", () => ({
	generateRandomCodeVerifier: vi.fn().mockReturnValue("mock-code-verifier"),
	calculatePKCECodeChallenge: vi.fn().mockResolvedValue("mock-code-challenge"),
}));

// Mock connection warmer
vi.mock("../../lib/arr/connection-warmer.js", () => ({
	warmConnectionsForUser: vi.fn().mockResolvedValue(undefined),
}));

// Mock session metadata
vi.mock("../../lib/auth/session-metadata.js", () => ({
	getSessionMetadata: vi.fn().mockReturnValue({ ip: "127.0.0.1", userAgent: "vitest" }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import Fastify from "fastify";
import { registerAuthOidcRoutes } from "../auth-oidc.js";
import { resolveCanonicalIssuer } from "../../lib/auth/oidc-utils.js";

// ---------------------------------------------------------------------------
// Mock Prisma client
// ---------------------------------------------------------------------------

function makeOidcProvider(overrides: Record<string, unknown> = {}) {
	return {
		id: 1,
		displayName: "Test Provider",
		clientId: "test-client-id",
		encryptedClientSecret: "encrypted-secret",
		clientSecretIv: "mock-iv",
		issuer: "https://provider.example.com",
		redirectUri: "http://localhost:3000/auth/oidc/callback",
		scopes: "openid,email,profile",
		enabled: true,
		...overrides,
	};
}

function createMockPrisma() {
	const userMock = {
		count: vi.fn().mockResolvedValue(0),
	};

	const oidcProviderMock = {
		findFirst: vi.fn().mockResolvedValue(null),
		findUnique: vi.fn().mockResolvedValue(null),
		create: vi.fn().mockImplementation(({ data }: any) => ({
			id: 1,
			displayName: data.displayName,
			...data,
		})),
		update: vi.fn().mockImplementation(({ data }: any) => ({
			id: 1,
			...data,
		})),
	};

	return {
		user: userMock,
		oIDCProvider: oidcProviderMock,
		oIDCAccount: {
			findFirst: vi.fn().mockResolvedValue(null),
		},
		$transaction: vi.fn().mockImplementation(async (fn: any) => {
			return fn({
				user: userMock,
				oIDCProvider: oidcProviderMock,
			});
		}),
	};
}

// ---------------------------------------------------------------------------
// Fastify app setup
// ---------------------------------------------------------------------------

let app: ReturnType<typeof Fastify>;
let mockPrisma: ReturnType<typeof createMockPrisma>;

beforeEach(async () => {
	vi.clearAllMocks();

	// Reset the OIDCProvider mock
	MockOIDCProvider.mockGetAuthorizationUrl.mockResolvedValue(
		"https://provider.example.com/authorize?client_id=test&state=mock-state",
	);

	mockPrisma = createMockPrisma();

	app = Fastify();

	// Decorations
	app.decorate("prisma", mockPrisma);
	app.decorate("sessionService", mockSessionService);
	app.decorate("encryptor", {
		encrypt: vi.fn().mockReturnValue({ value: "encrypted-secret", iv: "mock-iv" }),
		decrypt: vi.fn().mockReturnValue("decrypted-client-secret"),
	});
	app.decorate("config", {
		PASSWORD_POLICY: "relaxed",
		APP_URL: "http://localhost:3000",
	});

	// Request decorations
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);

	// Register OIDC routes
	await app.register(registerAuthOidcRoutes, { prefix: "/auth" });
	await app.ready();
});

afterAll(async () => {
	await app?.close();
});

// ===========================================================================
// POST /auth/oidc/setup
// ===========================================================================

describe("POST /auth/oidc/setup", () => {
	it("stores encrypted provider config during initial setup", async () => {
		// No users exist (default mock: count = 0)
		const res = await app.inject({
			method: "POST",
			url: "/auth/oidc/setup",
			payload: {
				displayName: "My OIDC Provider",
				clientId: "my-client-id",
				clientSecret: "my-client-secret",
				issuer: "https://provider.example.com",
			},
		});

		expect(res.statusCode).toBe(201);
		const body = JSON.parse(res.payload);
		expect(body.success).toBe(true);
		expect(body.provider.displayName).toBe("My OIDC Provider");

		// Issuer should have been resolved via discovery
		expect(resolveCanonicalIssuer).toHaveBeenCalledWith("https://provider.example.com");

		// The provider should have been created in the transaction
		expect(mockPrisma.$transaction).toHaveBeenCalled();
	});

	it("returns 403 when users already exist", async () => {
		// Make the transaction see existing users
		mockPrisma.$transaction.mockImplementation(async (fn: any) => {
			return fn({
				user: { count: vi.fn().mockResolvedValue(1) },
				oIDCProvider: mockPrisma.oIDCProvider,
			});
		});

		const res = await app.inject({
			method: "POST",
			url: "/auth/oidc/setup",
			payload: {
				displayName: "My OIDC Provider",
				clientId: "my-client-id",
				clientSecret: "my-client-secret",
				issuer: "https://provider.example.com",
			},
		});

		expect(res.statusCode).toBe(403);
		expect(JSON.parse(res.payload).error).toContain("initial setup");
	});

	it("returns 400 when issuer URL is invalid", async () => {
		vi.mocked(resolveCanonicalIssuer).mockRejectedValueOnce(
			new Error("ECONNREFUSED: could not connect"),
		);

		const res = await app.inject({
			method: "POST",
			url: "/auth/oidc/setup",
			payload: {
				displayName: "My OIDC Provider",
				clientId: "my-client-id",
				clientSecret: "my-client-secret",
				issuer: "https://invalid-provider.example.com",
			},
		});

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toBe("Invalid issuer URL");
	});
});

// ===========================================================================
// POST /auth/oidc/login
// ===========================================================================

describe("POST /auth/oidc/login", () => {
	it("returns authorization URL when provider is configured", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());

		const res = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.authorizationUrl).toBeDefined();
		expect(body.authorizationUrl).toContain("provider.example.com");

		// OIDCProvider should have been constructed with decrypted secret
		expect(MockOIDCProvider.mockGetAuthorizationUrl).toHaveBeenCalled();
	});

	it("returns 400 when no OIDC provider is configured", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(null);

		const res = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
		});

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toContain("not configured");
	});

	it("returns 500 when authorization URL generation fails", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());
		MockOIDCProvider.mockGetAuthorizationUrl.mockRejectedValueOnce(
			new Error("Discovery endpoint unreachable"),
		);

		const res = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
		});

		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.payload).error).toContain("Failed to initiate OIDC login");
		expect(JSON.parse(res.payload).hint).toBeDefined();
	});
});

// ===========================================================================
// GET /auth/oidc/callback — state validation
// ===========================================================================

describe("GET /auth/oidc/callback", () => {
	it("returns 400 with invalid state (CSRF protection)", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/auth/oidc/callback?code=mock-auth-code&state=invalid-state-value",
		});

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toContain("Invalid or expired state");

		// No session should have been created
		expect(mockSessionService.createSession).not.toHaveBeenCalled();
	});

	it("returns 400 when code is missing from callback", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/auth/oidc/callback?state=some-state",
		});

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toContain("Invalid callback parameters");
	});

	it("returns 400 when provider returns an error", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/auth/oidc/callback?error=access_denied&error_description=User+denied+access",
		});

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toContain("access_denied");
		expect(JSON.parse(res.payload).details).toContain("User denied access");
	});
});
