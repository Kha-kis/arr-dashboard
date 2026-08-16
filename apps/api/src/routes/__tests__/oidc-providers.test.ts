import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import oidcProvidersRoutes from "../oidc-providers.js";

vi.mock("../../lib/auth/password.js", () => ({
	hashPassword: vi.fn().mockResolvedValue("$argon2id$replacement-password"),
	verifyPassword: vi
		.fn()
		.mockImplementation(
			async (password: string, hash: string) =>
				password === "CurrentPassword1!" && hash === "$argon2id$existing-admin-password",
		),
}));

vi.mock("../../lib/auth/oidc-utils.js", () => ({
	resolveCanonicalIssuer: vi.fn().mockResolvedValue({
		issuer: "https://auth.example.com/application/o/arr-dashboard/",
		source: "discovery",
	}),
}));

const provider = {
	id: 1,
	displayName: "Authentik",
	clientId: "arr-dashboard",
	encryptedClientSecret: "encrypted",
	clientSecretIv: "iv",
	issuer: "https://auth.example.com/application/o/arr-dashboard/",
	redirectUri: "https://arr.example.com/auth/oidc/callback",
	scopes: "openid,email,profile",
	enabled: true,
	createdAt: new Date("2026-07-29T00:00:00.000Z"),
	updatedAt: new Date("2026-07-29T00:00:00.000Z"),
};

let app: ReturnType<typeof Fastify>;
const findProvider = vi.fn();
const createProvider = vi.fn();
const findLinkedAccount = vi.fn();
const findUniqueProvider = vi.fn();
const deleteProvider = vi.fn();
const deleteOidcAccounts = vi.fn();
const findOidcOnlyUsers = vi.fn();
const findUniqueUser = vi.fn();
const updateUser = vi.fn();
const updateManyUsers = vi.fn();
const runTransaction = vi.fn();
const deleteSessions = vi.fn();
const clearCookie = vi.fn();
const findSystemSettings = vi.fn();

beforeEach(async () => {
	findProvider.mockReset();
	createProvider.mockReset();
	findLinkedAccount.mockReset();
	findUniqueProvider.mockReset();
	deleteProvider.mockReset();
	deleteOidcAccounts.mockReset();
	findOidcOnlyUsers.mockReset();
	findUniqueUser.mockReset();
	updateUser.mockReset();
	updateManyUsers.mockReset();
	runTransaction.mockReset();
	deleteSessions.mockReset();
	clearCookie.mockReset();
	findSystemSettings.mockReset();
	findSystemSettings.mockResolvedValue(null);

	findUniqueProvider.mockResolvedValue(provider);
	createProvider.mockImplementation(({ data }) => ({ ...provider, ...data }));
	deleteProvider.mockResolvedValue({ count: 1 });
	deleteOidcAccounts.mockResolvedValue({ count: 1 });
	findOidcOnlyUsers.mockResolvedValue([{ id: "admin-user", hashedPassword: null }]);
	findUniqueUser.mockResolvedValue({ hashedPassword: null });
	updateUser.mockResolvedValue({ id: "admin-user" });
	updateManyUsers.mockResolvedValue({ count: 1 });
	deleteSessions.mockResolvedValue({ count: 1 });
	runTransaction.mockImplementation(async (callback) =>
		callback({
			oIDCProvider: { deleteMany: deleteProvider },
			oIDCAccount: { deleteMany: deleteOidcAccounts },
			user: {
				findMany: findOidcOnlyUsers,
				findUnique: findUniqueUser,
				update: updateUser,
				updateMany: updateManyUsers,
			},
			session: { deleteMany: deleteSessions },
		}),
	);

	app = Fastify();
	app.decorate("prisma", {
		systemSettings: { findUnique: findSystemSettings },
		oIDCProvider: {
			findFirst: findProvider,
			findUnique: findUniqueProvider,
			create: createProvider,
		},
		oIDCAccount: { findFirst: findLinkedAccount },
		user: { findMany: findOidcOnlyUsers, findUnique: findUniqueUser },
		session: { deleteMany: deleteSessions },
		$transaction: runTransaction,
	});
	app.decorate("sessionService", { clearCookie });
	app.decorate("config", { APP_URL: "https://arr.example.com", TRUST_PROXY: false });
	app.decorate("encryptor", {
		encrypt: vi.fn().mockReturnValue({ value: "encrypted", iv: "iv" }),
	});
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);
	app.addHook("preHandler", async (request: FastifyRequest) => {
		request.currentUser = {
			id: "admin-user",
			username: "admin",
			mustChangePassword: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		request.sessionToken = "admin-session-token";
	});
	await app.register(oidcProvidersRoutes);
	await app.ready();
});

afterEach(async () => {
	await app?.close();
});

describe("GET /api/oidc-providers", () => {
	it("reports whether the current admin has linked the configured provider", async () => {
		findProvider.mockResolvedValue(provider);
		findLinkedAccount.mockResolvedValue({ id: "oidc-account-1" });

		const response = await app.inject({ method: "GET", url: "/api/oidc-providers" });

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toMatchObject({
			provider: { displayName: "Authentik" },
			linked: true,
		});
		expect(findLinkedAccount).toHaveBeenCalledWith({
			where: { userId: "admin-user" },
			select: { id: true },
		});
	});

	it("returns an unlinked state when no provider is configured", async () => {
		findProvider.mockResolvedValue(null);

		const response = await app.inject({ method: "GET", url: "/api/oidc-providers" });

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toEqual({ provider: null, linked: false });
		expect(findLinkedAccount).not.toHaveBeenCalled();
	});
});

describe("POST /api/oidc-providers", () => {
	it("uses the browser-facing proxy origin when APP_URL is still localhost", async () => {
		Object.assign(app.config, { APP_URL: "http://localhost:3000", TRUST_PROXY: true });

		const response = await app.inject({
			method: "POST",
			url: "/api/oidc-providers",
			remoteAddress: "127.0.0.1",
			headers: {
				host: "localhost:3001",
				"x-arr-dashboard-origin": "https://arr.example.com",
			},
			payload: {
				displayName: "Authentik",
				clientId: "arr-dashboard",
				clientSecret: "secret",
				issuer: "https://auth.example.com",
			},
		});

		expect(response.statusCode).toBe(201);
		expect(JSON.parse(response.payload)).toMatchObject({
			redirectUri: "https://arr.example.com/auth/oidc/callback",
		});
	});

	it("prefers the persisted External URL when generating the admin callback", async () => {
		Object.assign(app.config, { APP_URL: "http://localhost:3000", TRUST_PROXY: true });
		findSystemSettings.mockResolvedValue({
			externalUrl: "https://canonical.example.com/dashboard",
		});

		const response = await app.inject({
			method: "POST",
			url: "/api/oidc-providers",
			remoteAddress: "127.0.0.1",
			headers: {
				"x-arr-dashboard-origin": "https://incidental.example.com",
			},
			payload: {
				displayName: "Authentik",
				clientId: "arr-dashboard",
				clientSecret: "secret",
				issuer: "https://auth.example.com",
			},
		});

		expect(response.statusCode).toBe(201);
		expect(JSON.parse(response.payload)).toMatchObject({
			redirectUri: "https://canonical.example.com/dashboard/auth/oidc/callback",
		});
	});

	it.each([
		"https://admin:secret@arr.example.com/",
		"ftp://arr.example.com/",
		"mailto:admin@example.com",
	])("rejects an unsafe APP_URL when generating the admin callback: %s", async (appUrl) => {
		Object.assign(app.config, { APP_URL: appUrl });

		const response = await app.inject({
			method: "POST",
			url: "/api/oidc-providers",
			payload: {
				displayName: "Authentik",
				clientId: "arr-dashboard",
				clientSecret: "secret",
				issuer: "https://auth.example.com",
			},
		});

		expect(response.statusCode).toBe(400);
		expect(JSON.parse(response.payload).error).toContain("APP_URL");
		expect(findProvider).not.toHaveBeenCalled();
	});
});

describe("DELETE /api/oidc-providers", () => {
	it("deletes the exact provider and its links in one transaction", async () => {
		const response = await app.inject({
			method: "DELETE",
			url: "/api/oidc-providers",
			payload: { replacementPassword: "Safe-Replacement1!" },
		});

		expect(response.statusCode).toBe(204);
		expect(deleteSessions).toHaveBeenNthCalledWith(1, {
			where: {
				id: expect.any(String),
				userId: "admin-user",
				expiresAt: { gt: expect.any(Date) },
			},
		});
		expect(deleteProvider).toHaveBeenCalledWith({
			where: {
				id: provider.id,
				enabled: true,
				clientId: provider.clientId,
				encryptedClientSecret: provider.encryptedClientSecret,
				clientSecretIv: provider.clientSecretIv,
				issuer: provider.issuer,
				redirectUri: provider.redirectUri,
				scopes: provider.scopes,
			},
		});
		expect(deleteOidcAccounts).toHaveBeenCalledWith({});
		expect(findOidcOnlyUsers).toHaveBeenCalledWith({
			where: {
				OR: [{ id: "admin-user" }, { oidcAccounts: { some: {} } }],
			},
			select: { id: true, hashedPassword: true },
		});
		expect(updateManyUsers).toHaveBeenCalledWith({
			where: { id: "admin-user", hashedPassword: null },
			data: {
				hashedPassword: expect.any(String),
				mustChangePassword: false,
				failedLoginAttempts: 0,
				lockedUntil: null,
			},
		});
		expect(deleteSessions).toHaveBeenLastCalledWith({});
		expect(deleteProvider.mock.invocationCallOrder[0]).toBeLessThan(
			deleteOidcAccounts.mock.invocationCallOrder[0]!,
		);
		expect(clearCookie).toHaveBeenCalledWith(expect.anything());
	});

	it("replaces the current admin password while deleting OIDC", async () => {
		findUniqueUser.mockResolvedValueOnce({
			hashedPassword: "$argon2id$existing-admin-password",
		});
		findOidcOnlyUsers.mockResolvedValueOnce([
			{ id: "admin-user", hashedPassword: "$argon2id$existing-admin-password" },
		]);

		const response = await app.inject({
			method: "DELETE",
			url: "/api/oidc-providers",
			payload: {
				currentPassword: "CurrentPassword1!",
				replacementPassword: "Safe-Replacement1!",
			},
		});

		expect(response.statusCode).toBe(204);
		expect(updateManyUsers).toHaveBeenCalledWith({
			where: {
				id: "admin-user",
				hashedPassword: "$argon2id$existing-admin-password",
			},
			data: {
				hashedPassword: expect.any(String),
				mustChangePassword: false,
				failedLoginAttempts: 0,
				lockedUntil: null,
			},
		});
		expect(deleteProvider).toHaveBeenCalled();
		expect(deleteOidcAccounts).toHaveBeenCalled();
		expect(deleteSessions).toHaveBeenLastCalledWith({});
	});

	it("preserves another linked user's existing password", async () => {
		findUniqueUser.mockResolvedValueOnce({
			hashedPassword: "$argon2id$existing-admin-password",
		});
		findOidcOnlyUsers.mockResolvedValueOnce([
			{ id: "admin-user", hashedPassword: "$argon2id$existing-admin-password" },
			{ id: "other-user", hashedPassword: "$argon2id$existing-password" },
		]);

		const response = await app.inject({
			method: "DELETE",
			url: "/api/oidc-providers",
			payload: {
				currentPassword: "CurrentPassword1!",
				replacementPassword: "Safe-Replacement1!",
			},
		});

		expect(response.statusCode).toBe(204);
		expect(updateManyUsers).toHaveBeenCalledTimes(1);
		expect(updateUser).not.toHaveBeenCalled();
	});

	it("requires the current password before replacing an existing admin password", async () => {
		findUniqueUser.mockResolvedValueOnce({
			hashedPassword: "$argon2id$existing-admin-password",
		});

		const response = await app.inject({
			method: "DELETE",
			url: "/api/oidc-providers",
			payload: { replacementPassword: "Safe-Replacement1!" },
		});

		expect(response.statusCode).toBe(400);
		expect(JSON.parse(response.payload).error).toContain("Current password is required");
		expect(runTransaction).not.toHaveBeenCalled();
	});

	it("rejects an incorrect current password before deleting OIDC", async () => {
		findUniqueUser.mockResolvedValueOnce({
			hashedPassword: "$argon2id$existing-admin-password",
		});

		const response = await app.inject({
			method: "DELETE",
			url: "/api/oidc-providers",
			payload: {
				currentPassword: "WrongPassword1!",
				replacementPassword: "Safe-Replacement1!",
			},
		});

		expect(response.statusCode).toBe(401);
		expect(JSON.parse(response.payload).error).toContain("Current password is incorrect");
		expect(runTransaction).not.toHaveBeenCalled();
	});

	it("rolls back deletion when the verified admin credential changes", async () => {
		findUniqueUser.mockResolvedValueOnce({
			hashedPassword: "$argon2id$existing-admin-password",
		});
		updateManyUsers.mockResolvedValueOnce({ count: 0 });

		const response = await app.inject({
			method: "DELETE",
			url: "/api/oidc-providers",
			payload: {
				currentPassword: "CurrentPassword1!",
				replacementPassword: "Safe-Replacement1!",
			},
		});

		expect(response.statusCode).toBe(409);
		expect(JSON.parse(response.payload).error).toContain("password changed");
		expect(deleteOidcAccounts).not.toHaveBeenCalled();
	});

	it("does not remove links when the provider changed before deletion acquired it", async () => {
		deleteProvider.mockResolvedValueOnce({ count: 0 });

		const response = await app.inject({
			method: "DELETE",
			url: "/api/oidc-providers",
			payload: { replacementPassword: "Safe-Replacement1!" },
		});

		expect(response.statusCode).toBe(409);
		expect(JSON.parse(response.payload).error).toContain("provider changed");
		expect(deleteOidcAccounts).not.toHaveBeenCalled();
		expect(deleteSessions).toHaveBeenCalledTimes(1);
		expect(clearCookie).not.toHaveBeenCalled();
	});

	it("does not delete OIDC after the initiating session is revoked", async () => {
		deleteSessions.mockResolvedValueOnce({ count: 0 });

		const response = await app.inject({
			method: "DELETE",
			url: "/api/oidc-providers",
			payload: { replacementPassword: "Safe-Replacement1!" },
		});

		expect(response.statusCode).toBe(401);
		expect(JSON.parse(response.payload).error).toContain("session is no longer active");
		expect(deleteProvider).not.toHaveBeenCalled();
		expect(updateUser).not.toHaveBeenCalled();
		expect(deleteOidcAccounts).not.toHaveBeenCalled();
		expect(clearCookie).not.toHaveBeenCalled();
	});

	it("keeps provider cleanup and session revocation in one transaction", async () => {
		deleteSessions
			.mockResolvedValueOnce({ count: 1 })
			.mockRejectedValueOnce(new Error("database cleanup failed"));

		const response = await app.inject({
			method: "DELETE",
			url: "/api/oidc-providers",
			payload: { replacementPassword: "Safe-Replacement1!" },
		});

		expect(response.statusCode).toBe(500);
		expect(runTransaction).toHaveBeenCalledTimes(1);
		expect(deleteProvider).toHaveBeenCalled();
		expect(updateManyUsers).toHaveBeenCalled();
		expect(deleteOidcAccounts).toHaveBeenCalled();
		expect(deleteSessions).toHaveBeenCalledWith({});
		expect(clearCookie).not.toHaveBeenCalled();
	});
});
