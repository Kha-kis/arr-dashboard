import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const { mockSessionService } = vi.hoisted(() => ({
	mockSessionService: {
		createSession: vi.fn().mockResolvedValue({
			token: "mock-session-token",
			expiresAt: new Date("2026-07-30T00:00:00.000Z"),
		}),
		createSessionIfAuthorized: vi.fn().mockResolvedValue({
			token: "mock-session-token",
			expiresAt: new Date("2026-07-30T00:00:00.000Z"),
		}),
		rotateActiveSession: vi.fn().mockResolvedValue({
			token: "mock-session-token",
			expiresAt: new Date("2026-07-30T00:00:00.000Z"),
		}),
		attachCookie: vi.fn(),
		invalidateSession: vi.fn().mockResolvedValue(undefined),
		clearCookie: vi.fn(),
		invalidateAllUserSessions: vi.fn().mockResolvedValue(undefined),
	},
}));

// Mock OIDCProvider class — avoid real discovery/HTTP calls
const { MockOIDCProvider } = vi.hoisted(() => {
	const mockGetAuthorizationUrl = vi
		.fn()
		.mockResolvedValue(
			"https://provider.example.com/authorize?client_id=test&state=mock-state&code_challenge=mock-challenge",
		);
	class MockOIDCProvider {
		config: Record<string, unknown>;
		static mockGetAuthorizationUrl = mockGetAuthorizationUrl;
		constructor(config: Record<string, unknown>) {
			this.config = config;
		}
		getAuthorizationUrl = mockGetAuthorizationUrl;
		exchangeCode = vi.fn().mockResolvedValue({
			access_token: "mock-access-token",
			id_token: "mock-id-token",
		});
		extractIdTokenClaims = vi.fn().mockReturnValue({ sub: "provider-user-1" });
		getUserInfo = vi.fn().mockResolvedValue({
			sub: "provider-user-1",
			preferred_username: "oidc-admin",
		});
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

import Fastify, { type FastifyRequest } from "fastify";
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
		createdAt: new Date("2026-07-29T00:00:00.000Z"),
		updatedAt: new Date("2026-07-29T00:00:00.000Z"),
		...overrides,
	};
}

function createMockPrisma() {
	const userMock = {
		count: vi.fn().mockResolvedValue(0),
		create: vi.fn().mockResolvedValue({
			id: "user-1",
			username: "oidc-admin",
		}),
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
		updateMany: vi.fn().mockResolvedValue({ count: 1 }),
	};

	return {
		user: userMock,
		oIDCProvider: oidcProviderMock,
		oIDCAccount: {
			findUnique: vi.fn().mockResolvedValue(null),
			create: vi.fn(),
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
	MockOIDCProvider.mockGetAuthorizationUrl.mockImplementation(
		(state: string) =>
			`https://provider.example.com/authorize?client_id=test&state=${encodeURIComponent(state)}`,
	);

	mockPrisma = createMockPrisma();
	mockSessionService.rotateActiveSession.mockImplementation(
		async (_token, _userId, _metadata, options) => {
			await options?.onRotate?.(mockPrisma);
			return {
				token: "mock-session-token",
				expiresAt: new Date("2026-07-30T00:00:00.000Z"),
			};
		},
	);
	mockSessionService.createSessionIfAuthorized.mockImplementation(
		async (_userId, _rememberMe, _metadata, authorize) =>
			(await authorize(mockPrisma))
				? {
						token: "mock-session-token",
						expiresAt: new Date("2026-07-30T00:00:00.000Z"),
					}
				: null,
	);

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
	app.addHook("preHandler", async (request: FastifyRequest) => {
		if (request.headers["x-test-current-user"] === "admin-user") {
			request.currentUser = {
				id: "admin-user",
				username: "admin",
				mustChangePassword: false,
				createdAt: new Date(),
				updatedAt: new Date(),
			};
			request.sessionToken = "admin-session-token";
		}
	});

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
	it("continues initial OIDC setup into service onboarding", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());
		const login = await app.inject({ method: "POST", url: "/auth/oidc/login" });
		const authorizationUrl = new URL(JSON.parse(login.payload).authorizationUrl);
		const state = authorizationUrl.searchParams.get("state");

		const res = await app.inject({
			method: "GET",
			url: `/auth/oidc/callback?code=mock-auth-code&state=${encodeURIComponent(state ?? "")}`,
		});

		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toBe("/setup?stage=services");
		expect(mockSessionService.createSession).toHaveBeenCalledWith(
			"user-1",
			true,
			expect.any(Object),
		);
	});

	it("keeps normal OIDC logins on the existing root redirect", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());
		mockPrisma.oIDCAccount.findUnique.mockResolvedValue({
			providerUserId: "provider-user-1",
			user: { id: "existing-user", username: "existing-admin" },
		});
		const login = await app.inject({ method: "POST", url: "/auth/oidc/login" });
		const authorizationUrl = new URL(JSON.parse(login.payload).authorizationUrl);
		const state = authorizationUrl.searchParams.get("state");

		const res = await app.inject({
			method: "GET",
			url: `/auth/oidc/callback?code=mock-auth-code&state=${encodeURIComponent(state ?? "")}`,
		});

		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toBe("/");
	});

	it("links the OIDC identity to the authenticated admin who initiated the flow", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());
		mockPrisma.oIDCAccount.create.mockResolvedValue({
			providerUserId: "provider-user-1",
			user: { id: "admin-user", username: "admin" },
		});

		const login = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
			headers: { "x-test-current-user": "admin-user" },
			payload: { intent: "link" },
		});
		const authorizationUrl = new URL(JSON.parse(login.payload).authorizationUrl);
		const state = authorizationUrl.searchParams.get("state");

		const callback = await app.inject({
			method: "GET",
			url: `/auth/oidc/callback?code=mock-auth-code&state=${encodeURIComponent(state ?? "")}`,
			headers: { "x-test-current-user": "admin-user" },
		});

		expect(callback.statusCode).toBe(302);
		expect(callback.headers.location).toBe("/settings#authentication");
		expect(mockPrisma.oIDCProvider.updateMany).toHaveBeenCalledWith({
			where: {
				id: 1,
				enabled: true,
				clientId: "test-client-id",
				encryptedClientSecret: "encrypted-secret",
				clientSecretIv: "mock-iv",
				issuer: "https://provider.example.com",
				redirectUri: "http://localhost:3000/auth/oidc/callback",
				scopes: "openid,email,profile",
			},
			data: { updatedAt: expect.any(Date) },
		});
		expect(mockPrisma.oIDCAccount.deleteMany).toHaveBeenCalledWith({
			where: { userId: "admin-user" },
		});
		expect(mockPrisma.oIDCAccount.create).toHaveBeenCalledWith({
			data: {
				providerUserId: "provider-user-1",
				userId: "admin-user",
			},
		});
		expect(mockSessionService.rotateActiveSession).toHaveBeenCalledWith(
			"admin-session-token",
			"admin-user",
			expect.any(Object),
			{
				onRotate: expect.any(Function),
				revokeOtherSessions: true,
			},
		);
	});

	it("does not recreate an OIDC link after the provider changes or is deleted", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());
		mockPrisma.oIDCProvider.updateMany.mockResolvedValueOnce({ count: 0 });

		const login = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
			headers: { "x-test-current-user": "admin-user" },
			payload: { intent: "link" },
		});
		const authorizationUrl = new URL(JSON.parse(login.payload).authorizationUrl);
		const state = authorizationUrl.searchParams.get("state");

		const callback = await app.inject({
			method: "GET",
			url: `/auth/oidc/callback?code=mock-auth-code&state=${encodeURIComponent(state ?? "")}`,
			headers: { "x-test-current-user": "admin-user" },
		});

		expect(callback.statusCode).toBe(409);
		expect(JSON.parse(callback.payload).error).toContain("provider changed");
		expect(mockPrisma.oIDCAccount.deleteMany).not.toHaveBeenCalled();
		expect(mockPrisma.oIDCAccount.create).not.toHaveBeenCalled();
		expect(mockSessionService.attachCookie).not.toHaveBeenCalled();
	});

	it("invalidates a pending account link when the initiating session is no longer active", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());

		const login = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
			headers: { "x-test-current-user": "admin-user" },
			payload: { intent: "link" },
		});
		const authorizationUrl = new URL(JSON.parse(login.payload).authorizationUrl);
		const state = authorizationUrl.searchParams.get("state");

		const callback = await app.inject({
			method: "GET",
			url: `/auth/oidc/callback?code=mock-auth-code&state=${encodeURIComponent(state ?? "")}`,
		});

		expect(callback.statusCode).toBe(401);
		expect(JSON.parse(callback.payload).error).toContain("session is no longer active");
		expect(mockPrisma.oIDCAccount.create).not.toHaveBeenCalled();
		expect(mockSessionService.createSession).not.toHaveBeenCalled();
	});

	it("does not link or mint a session when the initiating session is revoked during the OIDC exchange", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());
		mockSessionService.rotateActiveSession.mockResolvedValueOnce(null);

		const login = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
			headers: { "x-test-current-user": "admin-user" },
			payload: { intent: "link" },
		});
		const authorizationUrl = new URL(JSON.parse(login.payload).authorizationUrl);
		const state = authorizationUrl.searchParams.get("state");

		const callback = await app.inject({
			method: "GET",
			url: `/auth/oidc/callback?code=mock-auth-code&state=${encodeURIComponent(state ?? "")}`,
			headers: { "x-test-current-user": "admin-user" },
		});

		expect(callback.statusCode).toBe(401);
		expect(JSON.parse(callback.payload).error).toContain("session is no longer active");
		expect(mockPrisma.oIDCAccount.deleteMany).not.toHaveBeenCalled();
		expect(mockPrisma.oIDCAccount.create).not.toHaveBeenCalled();
		expect(mockSessionService.createSession).not.toHaveBeenCalled();
		expect(mockSessionService.attachCookie).not.toHaveBeenCalled();
	});

	it("tests only an OIDC identity already linked to the authenticated admin", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());

		const login = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
			headers: { "x-test-current-user": "admin-user" },
			payload: { intent: "test" },
		});
		const authorizationUrl = new URL(JSON.parse(login.payload).authorizationUrl);
		const state = authorizationUrl.searchParams.get("state");

		const callback = await app.inject({
			method: "GET",
			url: `/auth/oidc/callback?code=mock-auth-code&state=${encodeURIComponent(state ?? "")}`,
			headers: { "x-test-current-user": "admin-user" },
		});

		expect(callback.statusCode).toBe(401);
		expect(JSON.parse(callback.payload).error).toContain("not linked");
		expect(mockPrisma.oIDCAccount.create).not.toHaveBeenCalled();
		expect(mockSessionService.createSession).not.toHaveBeenCalled();
	});

	it("successfully tests an OIDC identity already linked to the authenticated admin", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());
		mockPrisma.oIDCAccount.findUnique.mockResolvedValue({
			providerUserId: "provider-user-1",
			user: { id: "admin-user", username: "admin" },
		});

		const login = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
			headers: { "x-test-current-user": "admin-user" },
			payload: { intent: "test" },
		});
		const authorizationUrl = new URL(JSON.parse(login.payload).authorizationUrl);
		const state = authorizationUrl.searchParams.get("state");

		const callback = await app.inject({
			method: "GET",
			url: `/auth/oidc/callback?code=mock-auth-code&state=${encodeURIComponent(state ?? "")}`,
			headers: { "x-test-current-user": "admin-user" },
		});

		expect(callback.statusCode).toBe(302);
		expect(callback.headers.location).toBe("/settings#authentication");
		expect(mockPrisma.oIDCAccount.create).not.toHaveBeenCalled();
		expect(mockSessionService.rotateActiveSession).toHaveBeenCalledWith(
			"admin-session-token",
			"admin-user",
			expect.any(Object),
			{ onRotate: expect.any(Function) },
		);
		expect(mockPrisma.oIDCProvider.updateMany).toHaveBeenCalledWith({
			where: {
				id: 1,
				enabled: true,
				clientId: "test-client-id",
				encryptedClientSecret: "encrypted-secret",
				clientSecretIv: "mock-iv",
				issuer: "https://provider.example.com",
				redirectUri: "http://localhost:3000/auth/oidc/callback",
				scopes: "openid,email,profile",
			},
			data: { updatedAt: expect.any(Date) },
		});
		expect(mockSessionService.attachCookie).toHaveBeenCalledWith(
			expect.anything(),
			"mock-session-token",
			true,
			new Date("2026-07-30T00:00:00.000Z"),
		);
	});

	it("does not report a successful account test after the provider changes", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());
		mockPrisma.oIDCAccount.findUnique.mockResolvedValue({
			providerUserId: "provider-user-1",
			user: { id: "admin-user", username: "admin" },
		});
		mockPrisma.oIDCProvider.updateMany.mockResolvedValueOnce({ count: 0 });

		const login = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
			headers: { "x-test-current-user": "admin-user" },
			payload: { intent: "test" },
		});
		const authorizationUrl = new URL(JSON.parse(login.payload).authorizationUrl);
		const state = authorizationUrl.searchParams.get("state");

		const callback = await app.inject({
			method: "GET",
			url: `/auth/oidc/callback?code=mock-auth-code&state=${encodeURIComponent(state ?? "")}`,
			headers: { "x-test-current-user": "admin-user" },
		});

		expect(callback.statusCode).toBe(409);
		expect(JSON.parse(callback.payload).error).toContain("provider changed");
		expect(mockSessionService.attachCookie).not.toHaveBeenCalled();
	});

	it("revalidates an ordinary OIDC login in the session-creation transaction", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());
		mockPrisma.oIDCAccount.findUnique.mockResolvedValue({
			providerUserId: "provider-user-1",
			user: { id: "admin-user", username: "admin" },
		});

		const login = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
		});
		const authorizationUrl = new URL(JSON.parse(login.payload).authorizationUrl);
		const state = authorizationUrl.searchParams.get("state");

		const callback = await app.inject({
			method: "GET",
			url: `/auth/oidc/callback?code=mock-auth-code&state=${encodeURIComponent(state ?? "")}`,
		});

		expect(callback.statusCode).toBe(302);
		expect(mockPrisma.oIDCAccount.updateMany).toHaveBeenCalledWith({
			where: {
				providerUserId: "provider-user-1",
				userId: "admin-user",
			},
			data: { updatedAt: expect.any(Date) },
		});
		expect(mockPrisma.oIDCProvider.updateMany).toHaveBeenCalledWith({
			where: {
				id: 1,
				enabled: true,
				clientId: "test-client-id",
				encryptedClientSecret: "encrypted-secret",
				clientSecretIv: "mock-iv",
				issuer: "https://provider.example.com",
				redirectUri: "http://localhost:3000/auth/oidc/callback",
				scopes: "openid,email,profile",
			},
			data: { updatedAt: expect.any(Date) },
		});
		expect(mockSessionService.createSessionIfAuthorized).toHaveBeenCalledWith(
			"admin-user",
			true,
			expect.any(Object),
			expect.any(Function),
		);
	});

	it("does not mint an ordinary login session after Relink removes the old identity", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());
		mockPrisma.oIDCAccount.findUnique.mockResolvedValue({
			providerUserId: "provider-user-1",
			user: { id: "admin-user", username: "admin" },
		});
		mockPrisma.oIDCAccount.updateMany.mockResolvedValueOnce({ count: 0 });

		const login = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
		});
		const authorizationUrl = new URL(JSON.parse(login.payload).authorizationUrl);
		const state = authorizationUrl.searchParams.get("state");

		const callback = await app.inject({
			method: "GET",
			url: `/auth/oidc/callback?code=mock-auth-code&state=${encodeURIComponent(state ?? "")}`,
		});

		expect(callback.statusCode).toBe(401);
		expect(JSON.parse(callback.payload).error).toContain("no longer linked");
		expect(mockSessionService.createSession).not.toHaveBeenCalled();
		expect(mockSessionService.attachCookie).not.toHaveBeenCalled();
	});

	it("does not mint an ordinary login session after the provider configuration changes", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());
		mockPrisma.oIDCAccount.findUnique.mockResolvedValue({
			providerUserId: "provider-user-1",
			user: { id: "admin-user", username: "admin" },
		});
		mockPrisma.oIDCProvider.updateMany.mockResolvedValueOnce({ count: 0 });

		const login = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
		});
		const authorizationUrl = new URL(JSON.parse(login.payload).authorizationUrl);
		const state = authorizationUrl.searchParams.get("state");

		const callback = await app.inject({
			method: "GET",
			url: `/auth/oidc/callback?code=mock-auth-code&state=${encodeURIComponent(state ?? "")}`,
		});

		expect(callback.statusCode).toBe(401);
		expect(JSON.parse(callback.payload).error).toContain("no longer linked");
		expect(mockPrisma.oIDCAccount.updateMany).not.toHaveBeenCalled();
		expect(mockSessionService.attachCookie).not.toHaveBeenCalled();
	});

	it("allows simultaneous callbacks from the same unchanged provider snapshot", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());
		mockPrisma.oIDCAccount.findUnique.mockResolvedValue({
			providerUserId: "provider-user-1",
			user: { id: "admin-user", username: "admin" },
		});

		const firstLogin = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
		});
		const secondLogin = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
		});
		const firstState = new URL(JSON.parse(firstLogin.payload).authorizationUrl).searchParams.get(
			"state",
		);
		const secondState = new URL(JSON.parse(secondLogin.payload).authorizationUrl).searchParams.get(
			"state",
		);

		const [firstCallback, secondCallback] = await Promise.all([
			app.inject({
				method: "GET",
				url: `/auth/oidc/callback?code=first-code&state=${encodeURIComponent(firstState ?? "")}`,
			}),
			app.inject({
				method: "GET",
				url: `/auth/oidc/callback?code=second-code&state=${encodeURIComponent(secondState ?? "")}`,
			}),
		]);

		expect(firstCallback.statusCode).toBe(302);
		expect(secondCallback.statusCode).toBe(302);
		expect(mockPrisma.oIDCProvider.updateMany).toHaveBeenCalledTimes(2);
		for (const [call] of mockPrisma.oIDCProvider.updateMany.mock.calls) {
			expect(call.where).not.toHaveProperty("updatedAt");
		}
	});

	it("still refuses an unlinked OIDC identity when no authenticated admin initiated the flow", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());
		mockPrisma.user.count.mockResolvedValue(1);

		const login = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
		});
		const authorizationUrl = new URL(JSON.parse(login.payload).authorizationUrl);
		const state = authorizationUrl.searchParams.get("state");

		const callback = await app.inject({
			method: "GET",
			url: `/auth/oidc/callback?code=mock-auth-code&state=${encodeURIComponent(state ?? "")}`,
		});

		expect(callback.statusCode).toBe(401);
		expect(JSON.parse(callback.payload).error).toContain(
			"Cannot sign in with an unlinked OIDC account",
		);
		expect(mockPrisma.oIDCAccount.create).not.toHaveBeenCalled();
	});

	it("refuses to relink an OIDC identity owned by a different account", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue(makeOidcProvider());
		mockPrisma.oIDCAccount.findUnique.mockResolvedValue({
			providerUserId: "provider-user-1",
			user: { id: "different-user", username: "different-admin" },
		});

		const login = await app.inject({
			method: "POST",
			url: "/auth/oidc/login",
			headers: { "x-test-current-user": "admin-user" },
			payload: { intent: "link" },
		});
		const authorizationUrl = new URL(JSON.parse(login.payload).authorizationUrl);
		const state = authorizationUrl.searchParams.get("state");

		const callback = await app.inject({
			method: "GET",
			url: `/auth/oidc/callback?code=mock-auth-code&state=${encodeURIComponent(state ?? "")}`,
			headers: { "x-test-current-user": "admin-user" },
		});

		expect(callback.statusCode).toBe(409);
		expect(JSON.parse(callback.payload).error).toContain("already linked");
		expect(mockPrisma.oIDCAccount.create).not.toHaveBeenCalled();
		expect(mockSessionService.createSession).not.toHaveBeenCalled();
	});

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
