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

beforeEach(async () => {
	findProvider.mockReset();
	findLinkedAccount.mockReset();

	app = Fastify();
	app.decorate("prisma", {
		oIDCProvider: { findFirst: findProvider },
		oIDCAccount: { findFirst: findLinkedAccount },
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
