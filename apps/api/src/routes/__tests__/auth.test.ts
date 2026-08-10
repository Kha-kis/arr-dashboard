import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks — vi.hoisted for references before vi.mock
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

// Mock argon2 — real argon2id is slow (~200ms per hash)
vi.mock("argon2", () => ({
	hash: vi.fn().mockResolvedValue("$argon2id$mock-hashed-password"),
	verify: vi.fn().mockResolvedValue(true),
}));

// Mock password.ts which wraps argon2
vi.mock("../../lib/auth/password.js", () => ({
	hashPassword: vi.fn().mockResolvedValue("$argon2id$mock-hashed-password"),
	verifyPassword: vi.fn().mockResolvedValue(true),
}));

// Mock connection warmer — no DB/network in tests
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
import { hashPassword, verifyPassword } from "../../lib/auth/password.js";
import { registerAuthRoutes } from "../auth.js";
import {
	createInjectAuthenticated,
	createMockEncryptor,
	setupAuthInjection,
} from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Test data factories
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
		encryptedTmdbApiKey: null,
		tmdbEncryptionIv: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Mock Prisma client
// ---------------------------------------------------------------------------

function createMockPrisma() {
	const userMock = {
		count: vi.fn().mockResolvedValue(0),
		findFirst: vi.fn().mockResolvedValue(null),
		findUnique: vi.fn().mockResolvedValue(null),
		create: vi.fn().mockImplementation(({ data }: any) => ({
			id: "user-1",
			username: data.username,
			hashedPassword: data.hashedPassword,
			mustChangePassword: data.mustChangePassword ?? false,
			createdAt: new Date("2024-01-01T00:00:00Z"),
		})),
		update: vi.fn().mockImplementation(({ data }: any) => ({
			id: "user-1",
			username: data.username ?? "admin",
			hashedPassword: data.hashedPassword ?? "$argon2id$existing-hash",
			mustChangePassword: data.mustChangePassword ?? false,
			createdAt: new Date("2024-01-01T00:00:00Z"),
		})),
		updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		delete: vi.fn().mockResolvedValue(undefined),
	};

	const oidcAccountMock = {
		count: vi.fn().mockResolvedValue(0),
		updateMany: vi.fn().mockResolvedValue({ count: 1 }),
	};
	const oidcProviderMock = {
		findFirst: vi.fn().mockResolvedValue(null),
		findUnique: vi.fn().mockResolvedValue(null),
		updateMany: vi.fn().mockResolvedValue({ count: 1 }),
	};

	return {
		user: userMock,
		libraryCleanupConfig: {
			upsert: vi.fn().mockResolvedValue({ id: "cleanup-config-1" }),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		serviceInstance: {
			findMany: vi.fn().mockResolvedValue([]),
		},
		trashSyncHistory: {
			findMany: vi.fn().mockResolvedValue([]),
		},
		templateDeploymentHistory: {
			findMany: vi.fn().mockResolvedValue([]),
		},
		oIDCAccount: oidcAccountMock,
		webAuthnCredential: {
			count: vi.fn().mockResolvedValue(0),
		},
		oIDCProvider: oidcProviderMock,
		session: {
			findMany: vi.fn().mockResolvedValue([]),
		},
		// $transaction: execute the callback with the same prisma mock as `tx`
		$transaction: vi.fn().mockImplementation(async (fn: (tx: any) => Promise<any>) => {
			return fn({
				user: userMock,
				oIDCAccount: oidcAccountMock,
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
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	vi.clearAllMocks();

	// Reset password mocks to defaults
	vi.mocked(hashPassword).mockResolvedValue("$argon2id$mock-hashed-password");
	vi.mocked(verifyPassword).mockResolvedValue(true);

	mockPrisma = createMockPrisma();

	app = Fastify();

	// Decorations that auth.ts reads
	app.decorate("prisma", mockPrisma);
	app.decorate("sessionService", mockSessionService);
	app.decorate("encryptor", createMockEncryptor());
	app.decorate("config", { PASSWORD_POLICY: "relaxed" });
	app.decorate("notificationService", {
		notify: vi.fn().mockResolvedValue(undefined),
	});

	setupAuthInjection(app, makeUser());

	// Register auth routes
	await app.register(registerAuthRoutes, { prefix: "/auth" });
	await app.ready();

	injectAuthenticated = createInjectAuthenticated(app);
});

afterAll(async () => {
	await app?.close();
});

// ===========================================================================
// GET /auth/setup-required
// ===========================================================================

describe("GET /auth/setup-required", () => {
	it("returns required: true when no users exist", async () => {
		mockPrisma.user.count.mockResolvedValue(0);

		const res = await app.inject({ method: "GET", url: "/auth/setup-required" });

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.required).toBe(true);
		expect(body.passwordPolicy).toBe("relaxed");
	});

	it("returns required: false when users exist", async () => {
		mockPrisma.user.count.mockResolvedValue(1);

		const res = await app.inject({ method: "GET", url: "/auth/setup-required" });

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload).required).toBe(false);
	});
});

// ===========================================================================
// POST /auth/register
// ===========================================================================

describe("POST /auth/register", () => {
	it("creates user and returns 201 with session cookie on initial setup", async () => {
		// $transaction callback will see count = 0 and create the user
		const res = await app.inject({
			method: "POST",
			url: "/auth/register",
			payload: { username: "admin", password: "StrongPass1!" },
		});

		expect(res.statusCode).toBe(201);
		const body = JSON.parse(res.payload);
		expect(body.user.username).toBe("admin");
		expect(body.user.id).toBe("user-1");

		// Session should have been created
		expect(mockSessionService.createSession).toHaveBeenCalledWith(
			"user-1",
			false, // rememberMe defaults to false
			expect.any(Object),
		);
		expect(mockSessionService.attachCookie).toHaveBeenCalled();
	});

	it("returns 403 when a user already exists", async () => {
		// Make the transaction see count > 0
		mockPrisma.$transaction.mockImplementation(async (fn: any) => {
			return fn({
				user: {
					count: vi.fn().mockResolvedValue(1),
					findFirst: vi.fn(),
					create: vi.fn(),
				},
			});
		});

		const res = await app.inject({
			method: "POST",
			url: "/auth/register",
			payload: { username: "hacker", password: "StrongPass1!" },
		});

		expect(res.statusCode).toBe(403);
		expect(JSON.parse(res.payload).error).toContain("Registration is only allowed");

		// No session should have been created
		expect(mockSessionService.createSession).not.toHaveBeenCalled();
	});

	it("allows initial-setup registration even when an OIDC provider is enabled (#498)", async () => {
		// Regression: adding an OIDC provider used to disable password registration
		// globally, which locked admins out if the OIDC config was wrong. Password
		// registration during initial setup must still succeed regardless of OIDC.
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue({ id: 1, enabled: true });

		const res = await app.inject({
			method: "POST",
			url: "/auth/register",
			payload: { username: "admin", password: "StrongPass1!" },
		});

		expect(res.statusCode).toBe(201);
		expect(JSON.parse(res.payload).user.username).toBe("admin");
		expect(mockSessionService.createSession).toHaveBeenCalled();
	});
});

// ===========================================================================
// POST /auth/login
// ===========================================================================

describe("POST /auth/login", () => {
	it("returns 200 and creates session with valid credentials", async () => {
		mockPrisma.user.findFirst.mockResolvedValue(makeUser());
		vi.mocked(verifyPassword).mockResolvedValue(true);

		const res = await app.inject({
			method: "POST",
			url: "/auth/login",
			payload: { username: "admin", password: "correctpassword" },
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.user.username).toBe("admin");
		expect(body.user.id).toBe("user-1");

		expect(mockSessionService.createSession).toHaveBeenCalledWith(
			"user-1",
			false, // rememberMe default
			expect.any(Object),
		);
		expect(mockSessionService.attachCookie).toHaveBeenCalled();
	});

	it("returns 401 with wrong password and does not create session", async () => {
		mockPrisma.user.findFirst.mockResolvedValue(makeUser());
		vi.mocked(verifyPassword).mockResolvedValue(false);

		const res = await app.inject({
			method: "POST",
			url: "/auth/login",
			payload: { username: "admin", password: "wrongpassword1" },
		});

		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.payload).error).toBe("Invalid credentials");
		expect(mockSessionService.createSession).not.toHaveBeenCalled();
	});

	it("returns 401 with nonexistent user — same error as wrong password", async () => {
		mockPrisma.user.findFirst.mockResolvedValue(null);

		const res = await app.inject({
			method: "POST",
			url: "/auth/login",
			payload: { username: "nobody", password: "somepassword1" },
		});

		expect(res.statusCode).toBe(401);
		// CRITICAL: same error message as wrong-password to prevent username enumeration
		expect(JSON.parse(res.payload).error).toBe("Invalid credentials");
		expect(mockSessionService.createSession).not.toHaveBeenCalled();
	});

	it("returns 423 when account is locked", async () => {
		const lockedUser = makeUser({
			lockedUntil: new Date(Date.now() + 10 * 60 * 1000), // 10 min from now
		});
		mockPrisma.user.findFirst.mockResolvedValue(lockedUser);

		const res = await app.inject({
			method: "POST",
			url: "/auth/login",
			payload: { username: "admin", password: "anypassword1" },
		});

		expect(res.statusCode).toBe(423);
		expect(JSON.parse(res.payload).error).toContain("Account locked");

		// Password should NOT have been checked
		expect(verifyPassword).not.toHaveBeenCalled();
		expect(mockSessionService.createSession).not.toHaveBeenCalled();
	});

	it("allows password login even when an OIDC provider is enabled (#498)", async () => {
		// Regression: the global "any enabled OIDC provider → password disabled"
		// gate locked admins out if their OIDC config was wrong. Password login
		// must still work for users with hashedPassword set, regardless of OIDC.
		mockPrisma.user.findFirst.mockResolvedValue(makeUser());
		vi.mocked(verifyPassword).mockResolvedValue(true);
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue({ id: 1, enabled: true });

		const res = await app.inject({
			method: "POST",
			url: "/auth/login",
			payload: { username: "admin", password: "correctpassword" },
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload).user.username).toBe("admin");
		expect(mockSessionService.createSession).toHaveBeenCalled();
	});
});

// ===========================================================================
// GET /auth/me
// ===========================================================================

describe("GET /auth/me", () => {
	it("returns user info with hasTmdbApiKey and hasPassword when authenticated", async () => {
		mockPrisma.user.findUnique.mockResolvedValue({
			encryptedTmdbApiKey: "some-encrypted-key",
			hashedPassword: "$argon2id$hash",
		});

		const res = await injectAuthenticated("GET", "/auth/me");

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.user.id).toBe("user-1");
		expect(body.user.username).toBe("admin");
		expect(body.user.hasTmdbApiKey).toBe(true);
		expect(body.user.hasPassword).toBe(true);
	});

	it("returns 401 when not authenticated", async () => {
		// No preHandler to set currentUser — request.currentUser stays null
		const res = await app.inject({ method: "GET", url: "/auth/me" });

		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.payload).error).toBe("Unauthorized");
	});

	it("returns hasPassword: false when user has no password", async () => {
		mockPrisma.user.findUnique.mockResolvedValue({
			encryptedTmdbApiKey: null,
			hashedPassword: null,
		});

		const res = await injectAuthenticated("GET", "/auth/me");

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.user.hasTmdbApiKey).toBe(false);
		expect(body.user.hasPassword).toBe(false);
	});
});

// ===========================================================================
// PATCH /auth/account — password change
// ===========================================================================

describe("PATCH /auth/account", () => {
	it("changes password and invalidates other sessions", async () => {
		mockPrisma.user.findUnique.mockResolvedValue(makeUser());
		vi.mocked(verifyPassword).mockResolvedValue(true);

		const res = await injectAuthenticated("PATCH", "/auth/account", {
			body: { currentPassword: "oldpassword1", newPassword: "NewPass123!" },
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.user.username).toBe("admin");

		// Password should have been hashed
		expect(hashPassword).toHaveBeenCalledWith("NewPass123!");

		// Other sessions should be invalidated
		expect(mockSessionService.invalidateAllUserSessions).toHaveBeenCalledWith(
			"user-1",
			"mock-session-token",
		);
	});

	it("returns 401 with incorrect current password", async () => {
		mockPrisma.user.findUnique.mockResolvedValue(makeUser());
		vi.mocked(verifyPassword).mockResolvedValue(false);

		const res = await injectAuthenticated("PATCH", "/auth/account", {
			body: { currentPassword: "wrongpassword", newPassword: "NewPass123!" },
		});

		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.payload).error).toBe("Current password is incorrect");

		// Password should NOT have been changed
		expect(hashPassword).not.toHaveBeenCalled();
		// Sessions should NOT have been invalidated
		expect(mockSessionService.invalidateAllUserSessions).not.toHaveBeenCalled();
	});

	it("returns 401 when not authenticated", async () => {
		const res = await app.inject({
			method: "PATCH",
			url: "/auth/account",
			payload: { currentPassword: "old12345", newPassword: "NewPass123!" },
		});

		expect(res.statusCode).toBe(401);
	});

	it("allows password change even when an OIDC provider is enabled (#498)", async () => {
		// Regression: the same global OIDC gate blocked authenticated password
		// changes, so a user who set up OIDC and then noticed their password was
		// out of date had no way to update it. Password change must still work.
		mockPrisma.user.findUnique.mockResolvedValue(makeUser());
		vi.mocked(verifyPassword).mockResolvedValue(true);
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue({ id: 1, enabled: true });

		const res = await injectAuthenticated("PATCH", "/auth/account", {
			body: { currentPassword: "oldpassword1", newPassword: "NewPass123!" },
		});

		expect(res.statusCode).toBe(200);
		expect(hashPassword).toHaveBeenCalledWith("NewPass123!");
	});
});

describe("DELETE /auth/password", () => {
	const oidcProvider = {
		id: 1,
		enabled: true,
		clientId: "arr-dashboard",
		encryptedClientSecret: "encrypted-secret",
		clientSecretIv: "secret-iv",
		issuer: "https://auth.example.com",
		redirectUri: "https://arr.example.com/auth/oidc/callback",
		scopes: "openid,email,profile",
	};

	beforeEach(() => {
		mockPrisma.user.findUnique.mockResolvedValue(makeUser());
		mockPrisma.oIDCAccount.count.mockResolvedValue(1);
		mockPrisma.oIDCProvider.findUnique.mockResolvedValue(oidcProvider);
	});

	it("revalidates the provider, link, and password in one transaction", async () => {
		const res = await injectAuthenticated("DELETE", "/auth/password", {
			body: { currentPassword: "oldpassword1" },
		});

		expect(res.statusCode).toBe(200);
		expect(mockPrisma.oIDCProvider.updateMany).toHaveBeenCalledWith({
			where: {
				...oidcProvider,
				enabled: true,
			},
			data: { updatedAt: expect.any(Date) },
		});
		expect(mockPrisma.oIDCAccount.updateMany).toHaveBeenCalledWith({
			where: { userId: "user-1" },
			data: { updatedAt: expect.any(Date) },
		});
		expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
			where: {
				id: "user-1",
				hashedPassword: "$argon2id$existing-hash",
			},
			data: { hashedPassword: null },
		});
	});

	it("does not remove the replacement password after provider deletion wins the race", async () => {
		mockPrisma.oIDCProvider.updateMany.mockResolvedValueOnce({ count: 0 });

		const res = await injectAuthenticated("DELETE", "/auth/password", {
			body: { currentPassword: "oldpassword1" },
		});

		expect(res.statusCode).toBe(409);
		expect(JSON.parse(res.payload).error).toContain("Authentication settings changed");
		expect(mockPrisma.oIDCAccount.updateMany).not.toHaveBeenCalled();
		expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
		expect(mockSessionService.invalidateAllUserSessions).not.toHaveBeenCalled();
	});
});

describe("DELETE /auth/account", () => {
	it("holds the cleanup topology lease while cascading user data", async () => {
		mockPrisma.user.findUnique.mockResolvedValue(makeUser({ hashedPassword: null }));

		const res = await injectAuthenticated("DELETE", "/auth/account");

		expect(res.statusCode).toBe(200);
		expect(mockPrisma.user.delete).toHaveBeenCalledWith({ where: { id: "user-1" } });
		expect(mockPrisma.libraryCleanupConfig.updateMany).toHaveBeenCalledTimes(2);
	});

	it("returns 409 without deleting the account while cleanup owns the lease", async () => {
		mockPrisma.user.findUnique.mockResolvedValue(makeUser({ hashedPassword: null }));
		mockPrisma.libraryCleanupConfig.updateMany.mockResolvedValueOnce({ count: 0 });

		const res = await injectAuthenticated("DELETE", "/auth/account");

		expect(res.statusCode).toBe(409);
		expect(mockPrisma.user.delete).not.toHaveBeenCalled();
	});

	it("rejects the account cascade when an owned instance has active recovery evidence", async () => {
		mockPrisma.user.findUnique.mockResolvedValue(makeUser({ hashedPassword: null }));
		mockPrisma.serviceInstance.findMany.mockResolvedValueOnce([{ id: "instance-1" }]);
		mockPrisma.trashSyncHistory.findMany.mockResolvedValueOnce([
			{
				id: "sync-1",
				status: "FAILED",
				rolledBack: false,
				rollbackStatus: "PARTIAL",
			},
		]);

		const res = await injectAuthenticated("DELETE", "/auth/account");

		expect(res.statusCode).toBe(409);
		expect(mockPrisma.serviceInstance.findMany).toHaveBeenCalledWith({
			where: { userId: "user-1" },
			select: { id: true },
		});
		expect(mockPrisma.libraryCleanupConfig.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
			mockPrisma.serviceInstance.findMany.mock.invocationCallOrder[0]!,
		);
		expect(mockPrisma.user.delete).not.toHaveBeenCalled();
	});
});
