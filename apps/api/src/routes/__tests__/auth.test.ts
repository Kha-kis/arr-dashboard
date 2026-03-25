import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks — vi.hoisted for references before vi.mock
// ---------------------------------------------------------------------------

const { mockSessionService } = vi.hoisted(() => ({
	mockSessionService: {
		createSession: vi.fn().mockResolvedValue({ token: "mock-session-token", id: "mock-session-id" }),
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
import { registerAuthRoutes } from "../auth.js";
import { hashPassword, verifyPassword } from "../../lib/auth/password.js";
import { setupAuthInjection, createInjectAuthenticated, createMockEncryptor } from "./test-helpers.js";

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
	};

	return {
		user: userMock,
		oIDCProvider: {
			findFirst: vi.fn().mockResolvedValue(null),
			findUnique: vi.fn().mockResolvedValue(null),
		},
		session: {
			findMany: vi.fn().mockResolvedValue([]),
		},
		// $transaction: execute the callback with the same prisma mock as `tx`
		$transaction: vi.fn().mockImplementation(async (fn: (tx: any) => Promise<any>) => {
			// The tx object exposes the same user methods
			return fn({ user: userMock });
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

	it("returns 403 when OIDC provider is enabled", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue({ id: 1, enabled: true });

		const res = await app.inject({
			method: "POST",
			url: "/auth/register",
			payload: { username: "admin", password: "StrongPass1!" },
		});

		expect(res.statusCode).toBe(403);
		expect(JSON.parse(res.payload).error).toContain("OIDC");
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

	it("returns 403 when OIDC provider is enabled", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue({ id: 1, enabled: true });

		const res = await app.inject({
			method: "POST",
			url: "/auth/login",
			payload: { username: "admin", password: "correctpassword" },
		});

		expect(res.statusCode).toBe(403);
		expect(JSON.parse(res.payload).error).toContain("OIDC");
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
});
