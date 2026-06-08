import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const { mockSessionService } = vi.hoisted(() => ({
	mockSessionService: {
		createSession: vi
			.fn()
			.mockResolvedValue({ token: "mock-session-token", id: "mock-session-id" }),
		attachCookie: vi.fn(),
		invalidateSession: vi.fn().mockResolvedValue(undefined),
		clearCookie: vi.fn(),
		invalidateAllUserSessions: vi.fn().mockResolvedValue(undefined),
		revokeSessionById: vi.fn().mockResolvedValue(true),
	},
}));

const { mockPasskeyService } = vi.hoisted(() => ({
	mockPasskeyService: {
		generateRegistrationOptions: vi.fn().mockResolvedValue({
			challenge: "mock-challenge-base64url",
			rp: { name: "Arr Dashboard", id: "localhost" },
			user: { id: "dXNlci0x", name: "admin", displayName: "admin" },
			pubKeyCredParams: [],
			timeout: 60000,
			attestation: "none",
		}),
		verifyRegistration: vi.fn().mockResolvedValue(undefined),
		generateAuthenticationOptions: vi.fn().mockResolvedValue({
			challenge: "mock-auth-challenge-base64url",
			timeout: 60000,
			rpId: "localhost",
			allowCredentials: [],
			userVerification: "required",
		}),
		verifyAuthentication: vi.fn().mockResolvedValue({
			verified: true,
			userId: "user-1",
			credentialId: "cred-1",
		}),
		listUserCredentials: vi.fn().mockResolvedValue([]),
		deleteCredential: vi.fn().mockResolvedValue(true),
		renameCredential: vi.fn().mockResolvedValue(true),
	},
}));

// Mock the passkey service factory
vi.mock("../../lib/auth/passkey-service.js", () => ({
	createPasskeyService: vi.fn().mockReturnValue(mockPasskeyService),
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
import { registerAuthPasskeyRoutes } from "../auth-passkey.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeUser(overrides: Record<string, unknown> = {}) {
	return {
		id: "user-1",
		username: "admin",
		hashedPassword: "$argon2id$existing-hash",
		mustChangePassword: false,
		createdAt: new Date("2024-01-01T00:00:00Z"),
		failedLoginAttempts: 0,
		lockedUntil: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Mock Prisma client
// ---------------------------------------------------------------------------

function createMockPrisma() {
	return {
		user: {
			findUnique: vi.fn().mockResolvedValue(makeUser()),
		},
		oIDCProvider: {
			findFirst: vi.fn().mockResolvedValue(null), // No OIDC by default
		},
		oIDCAccount: {
			count: vi.fn().mockResolvedValue(0),
		},
		webAuthnCredential: {
			count: vi.fn().mockResolvedValue(2), // >1 by default — not last passkey
		},
	};
}

// ---------------------------------------------------------------------------
// Fastify app setup
// ---------------------------------------------------------------------------

let app: ReturnType<typeof Fastify>;
let mockPrisma: ReturnType<typeof createMockPrisma>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	vi.clearAllMocks();

	mockPrisma = createMockPrisma();

	app = Fastify();

	// Decorations
	app.decorate("prisma", mockPrisma);
	app.decorate("sessionService", mockSessionService);
	app.decorate("config", {
		PASSWORD_POLICY: "relaxed",
		APP_URL: "http://localhost:3000",
	});

	setupAuthInjection(app, makeUser());

	// Register passkey routes
	await app.register(registerAuthPasskeyRoutes, { prefix: "/auth" });
	await app.ready();

	injectAuthenticated = createInjectAuthenticated(app);
});

afterAll(async () => {
	await app?.close();
});

// ===========================================================================
// POST /auth/passkey/register/options
// ===========================================================================

describe("POST /auth/passkey/register/options", () => {
	it("returns registration options when authenticated with password", async () => {
		const res = await injectAuthenticated("POST", "/auth/passkey/register/options", {
			body: {},
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.challenge).toBe("mock-challenge-base64url");
		expect(body.rp.id).toBe("localhost");

		// Service should have been called with user details
		expect(mockPasskeyService.generateRegistrationOptions).toHaveBeenCalledWith(
			"user-1",
			"admin",
			undefined,
		);
	});

	it("returns 401 when not authenticated", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/auth/passkey/register/options",
			payload: {},
		});

		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.payload).error).toBe("Unauthorized");

		// Service should NOT have been called
		expect(mockPasskeyService.generateRegistrationOptions).not.toHaveBeenCalled();
	});

	it("allows passkey registration even when an OIDC provider is enabled (#498)", async () => {
		// Regression: the global "any enabled OIDC provider → other auth disabled"
		// gate also blocked passkey registration, so a user setting up MFA with
		// passkeys after configuring OIDC was rejected. Passkey registration must
		// still work for users with a password set, regardless of OIDC.
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue({ id: 1, enabled: true });

		const res = await injectAuthenticated("POST", "/auth/passkey/register/options", {
			body: {},
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload).challenge).toBe("mock-challenge-base64url");
	});

	it("returns 403 when user has no password set", async () => {
		mockPrisma.user.findUnique.mockResolvedValue(makeUser({ hashedPassword: null }));

		const res = await injectAuthenticated("POST", "/auth/passkey/register/options", {
			body: {},
		});

		expect(res.statusCode).toBe(403);
		expect(JSON.parse(res.payload).error).toContain("password");
	});
});

// ===========================================================================
// POST /auth/passkey/login/verify
// ===========================================================================

describe("POST /auth/passkey/login/verify", () => {
	it("issues passkey login options even when an OIDC provider is enabled (#498)", async () => {
		// Regression: the same OIDC gate blocked /passkey/login/options, locking
		// passkey users out if OIDC was misconfigured. Login options must still
		// be issued regardless of OIDC presence.
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue({ id: 1, enabled: true });

		const res = await app.inject({
			method: "POST",
			url: "/auth/passkey/login/options",
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload).sessionId).toBeDefined();
	});

	it("returns 200 with user and session on valid credential", async () => {
		// First: get login options to populate the challenge store
		const optionsRes = await app.inject({
			method: "POST",
			url: "/auth/passkey/login/options",
		});
		expect(optionsRes.statusCode).toBe(200);
		const { sessionId } = JSON.parse(optionsRes.payload);

		// Mock user lookup for the login verify
		mockPrisma.user.findUnique.mockResolvedValue(makeUser());

		// Now verify with the session ID from options
		const res = await app.inject({
			method: "POST",
			url: "/auth/passkey/login/verify",
			payload: {
				response: {
					id: "cred-1",
					rawId: "cred-1",
					type: "public-key",
					response: { clientDataJSON: "test", authenticatorData: "test", signature: "test" },
				},
				sessionId,
			},
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.user.id).toBe("user-1");
		expect(body.user.username).toBe("admin");

		// Session should have been created with rememberMe: true (passkey sessions are long-lived)
		expect(mockSessionService.createSession).toHaveBeenCalledWith(
			"user-1",
			true,
			expect.any(Object),
		);
		expect(mockSessionService.attachCookie).toHaveBeenCalled();
	});

	it("returns 400 when session ID is invalid (expired or never existed)", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/auth/passkey/login/verify",
			payload: {
				response: {
					id: "cred-1",
					rawId: "cred-1",
					type: "public-key",
					response: { clientDataJSON: "test", authenticatorData: "test", signature: "test" },
				},
				sessionId: "nonexistent-session-id",
			},
		});

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toContain("Challenge not found");
		expect(mockSessionService.createSession).not.toHaveBeenCalled();
	});

	it("returns 401 when verification fails", async () => {
		// Get options to populate challenge store
		const optionsRes = await app.inject({
			method: "POST",
			url: "/auth/passkey/login/options",
		});
		const { sessionId } = JSON.parse(optionsRes.payload);

		// Make verification throw
		mockPasskeyService.verifyAuthentication.mockRejectedValueOnce(
			new Error("Signature verification failed"),
		);

		const res = await app.inject({
			method: "POST",
			url: "/auth/passkey/login/verify",
			payload: {
				response: {
					id: "cred-1",
					rawId: "cred-1",
					type: "public-key",
					response: { clientDataJSON: "test", authenticatorData: "test", signature: "test" },
				},
				sessionId,
			},
		});

		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.payload).error).toBe("Authentication failed");
		expect(mockSessionService.createSession).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// DELETE /auth/passkey/credentials
// ===========================================================================

describe("DELETE /auth/passkey/credentials", () => {
	it("returns 400 when deleting last passkey with no password or OIDC", async () => {
		// User has no password and no OIDC
		mockPrisma.user.findUnique.mockResolvedValue(makeUser({ hashedPassword: null }));
		mockPrisma.oIDCAccount.count.mockResolvedValue(0);
		mockPrisma.webAuthnCredential.count.mockResolvedValue(1); // Last passkey

		const res = await injectAuthenticated("DELETE", "/auth/passkey/credentials", {
			body: { credentialId: "cred-1" },
		});

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toContain("Cannot delete last passkey");

		// Credential should NOT have been deleted
		expect(mockPasskeyService.deleteCredential).not.toHaveBeenCalled();
		// Sessions should NOT have been invalidated
		expect(mockSessionService.invalidateAllUserSessions).not.toHaveBeenCalled();
	});

	it("allows deleting last passkey when user has a password", async () => {
		mockPrisma.user.findUnique.mockResolvedValue(makeUser({ hashedPassword: "$argon2id$hash" }));
		mockPrisma.webAuthnCredential.count.mockResolvedValue(1); // Last passkey

		const res = await injectAuthenticated("DELETE", "/auth/passkey/credentials", {
			body: { credentialId: "cred-1" },
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload).success).toBe(true);

		// Credential should have been deleted
		expect(mockPasskeyService.deleteCredential).toHaveBeenCalledWith("user-1", "cred-1");
	});

	it("invalidates other sessions after successful deletion", async () => {
		// Multiple passkeys — no safety check needed
		mockPrisma.webAuthnCredential.count.mockResolvedValue(2);

		const res = await injectAuthenticated("DELETE", "/auth/passkey/credentials", {
			body: { credentialId: "cred-1" },
		});

		expect(res.statusCode).toBe(200);

		// Other sessions should be invalidated, preserving current session
		expect(mockSessionService.invalidateAllUserSessions).toHaveBeenCalledWith(
			"user-1",
			"mock-session-token",
		);
	});

	it("returns 401 when not authenticated", async () => {
		const res = await app.inject({
			method: "DELETE",
			url: "/auth/passkey/credentials",
			payload: { credentialId: "cred-1" },
		});

		expect(res.statusCode).toBe(401);
		expect(mockPasskeyService.deleteCredential).not.toHaveBeenCalled();
	});

	it("returns 404 when credential not found", async () => {
		mockPrisma.webAuthnCredential.count.mockResolvedValue(2);
		mockPasskeyService.deleteCredential.mockResolvedValueOnce(false);

		const res = await injectAuthenticated("DELETE", "/auth/passkey/credentials", {
			body: { credentialId: "nonexistent" },
		});

		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.payload).error).toContain("Credential not found");
		// Sessions should NOT be invalidated when deletion fails
		expect(mockSessionService.invalidateAllUserSessions).not.toHaveBeenCalled();
	});
});
