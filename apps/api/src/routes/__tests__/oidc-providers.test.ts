import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import oidcProvidersRoutes from "../oidc-providers.js";

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
const findLinkedAccount = vi.fn();
const findUniqueProvider = vi.fn();
const deleteProvider = vi.fn();
const deleteOidcAccounts = vi.fn();
const findOidcOnlyUsers = vi.fn();
const updateUser = vi.fn();
const runTransaction = vi.fn();
const deleteSessions = vi.fn();
const clearCookie = vi.fn();

beforeEach(async () => {
	findProvider.mockReset();
	findLinkedAccount.mockReset();
	findUniqueProvider.mockReset();
	deleteProvider.mockReset();
	deleteOidcAccounts.mockReset();
	findOidcOnlyUsers.mockReset();
	updateUser.mockReset();
	runTransaction.mockReset();
	deleteSessions.mockReset();
	clearCookie.mockReset();

	findUniqueProvider.mockResolvedValue(provider);
	deleteProvider.mockResolvedValue({ count: 1 });
	deleteOidcAccounts.mockResolvedValue({ count: 1 });
	findOidcOnlyUsers.mockResolvedValue([{ id: "admin-user" }]);
	updateUser.mockResolvedValue({ id: "admin-user" });
	deleteSessions.mockResolvedValue({ count: 1 });
	runTransaction.mockImplementation(async (callback) =>
		callback({
			oIDCProvider: { deleteMany: deleteProvider },
			oIDCAccount: { deleteMany: deleteOidcAccounts },
			user: { findMany: findOidcOnlyUsers, update: updateUser },
			session: { deleteMany: deleteSessions },
		}),
	);

	app = Fastify();
	app.decorate("prisma", {
		oIDCProvider: {
			findFirst: findProvider,
			findUnique: findUniqueProvider,
		},
		oIDCAccount: { findFirst: findLinkedAccount },
		user: { findMany: findOidcOnlyUsers },
		session: { deleteMany: deleteSessions },
		$transaction: runTransaction,
	});
	app.decorate("sessionService", { clearCookie });
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

describe("DELETE /api/oidc-providers", () => {
	it("deletes the exact provider and its links in one transaction", async () => {
		const response = await app.inject({
			method: "DELETE",
			url: "/api/oidc-providers",
			payload: { replacementPassword: "Safe-Replacement1!" },
		});

		expect(response.statusCode).toBe(204);
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
			where: { oidcAccounts: { some: {} } },
			select: { id: true },
		});
		expect(updateUser).toHaveBeenCalledWith({
			where: { id: "admin-user" },
			data: {
				hashedPassword: expect.any(String),
				mustChangePassword: false,
			},
		});
		expect(deleteSessions).toHaveBeenCalledWith({});
		expect(deleteProvider.mock.invocationCallOrder[0]).toBeLessThan(
			deleteOidcAccounts.mock.invocationCallOrder[0]!,
		);
		expect(clearCookie).toHaveBeenCalledWith(expect.anything());
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
		expect(deleteSessions).not.toHaveBeenCalled();
		expect(clearCookie).not.toHaveBeenCalled();
	});

	it("keeps provider cleanup and session revocation in one transaction", async () => {
		deleteSessions.mockRejectedValueOnce(new Error("database cleanup failed"));

		const response = await app.inject({
			method: "DELETE",
			url: "/api/oidc-providers",
			payload: { replacementPassword: "Safe-Replacement1!" },
		});

		expect(response.statusCode).toBe(500);
		expect(runTransaction).toHaveBeenCalledTimes(1);
		expect(deleteProvider).toHaveBeenCalled();
		expect(updateUser).toHaveBeenCalled();
		expect(deleteOidcAccounts).toHaveBeenCalled();
		expect(deleteSessions).toHaveBeenCalledWith({});
		expect(clearCookie).not.toHaveBeenCalled();
	});
});
