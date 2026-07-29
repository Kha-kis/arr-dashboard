/**
 * System External URL and security-posture HTTP integration tests.
 *
 * The route combines runtime environment values with database-backed system
 * settings. Keep External URL persistence, live notification updates, and
 * posture diagnostics aligned with the same public origin.
 */

import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSystemRoutes } from "../system.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let mockPrisma: {
	systemSettings: {
		findUnique: ReturnType<typeof vi.fn>;
		upsert: ReturnType<typeof vi.fn>;
	};
	oIDCProvider: { findFirst: ReturnType<typeof vi.fn> };
	oIDCAccount: { findFirst: ReturnType<typeof vi.fn> };
	webAuthnCredential: { count: ReturnType<typeof vi.fn> };
	user: { count: ReturnType<typeof vi.fn> };
};
let mockNotificationService: { setBaseUrl: ReturnType<typeof vi.fn> };

beforeEach(async () => {
	mockPrisma = {
		systemSettings: {
			findUnique: vi.fn().mockResolvedValue({
				externalUrl: "https://arr.example.com",
			}),
			upsert: vi.fn().mockImplementation(({ update, create }) =>
				Promise.resolve({
					apiPort: 3001,
					webPort: 3000,
					listenAddress: process.env.HOST || process.env.HOSTNAME || "0.0.0.0",
					appName: "Arr Dashboard",
					externalUrl: null,
					trustProxy: true,
					secureCookies: true,
					updatedAt: new Date(),
					...create,
					...update,
				}),
			),
		},
		oIDCProvider: { findFirst: vi.fn().mockResolvedValue(null) },
		oIDCAccount: { findFirst: vi.fn().mockResolvedValue(null) },
		webAuthnCredential: { count: vi.fn().mockResolvedValue(1) },
		user: { count: vi.fn().mockResolvedValue(1) },
	};
	mockNotificationService = { setBaseUrl: vi.fn() };

	app = Fastify();
	app.decorate("prisma", mockPrisma as never);
	app.decorate("config", {
		NODE_ENV: "production",
		TRUST_PROXY: true,
		COOKIE_SECURE: true,
		SESSION_TTL_HOURS: 24,
		SESSION_COOKIE_NAME: "arr_session",
		PASSWORD_POLICY: "strict",
		APP_URL: "http://localhost:3000",
	} as never);
	app.decorate("dbProvider", "sqlite" as never);
	app.decorate("notificationService", mockNotificationService as never);
	app.decorate("lifecycle", {
		getRestartMessage: () => "ok",
		restart: vi.fn(),
	} as never);

	setupAuthInjection(app);
	await app.register(registerSystemRoutes, { prefix: "/system" });
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterAll(async () => {
	await app?.close();
});

describe("PUT /system/settings", () => {
	it("trims External URL, removes trailing slashes, and updates the live base URL", async () => {
		const res = await injectAuthenticated("PUT", "/system/settings", {
			body: { externalUrl: "  https://arr.example.com///  " },
		});

		expect(res.statusCode, res.payload).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.data.externalUrl).toBe("https://arr.example.com");
		expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.objectContaining({ externalUrl: "https://arr.example.com" }),
				create: expect.objectContaining({ externalUrl: "https://arr.example.com" }),
			}),
		);
		expect(mockNotificationService.setBaseUrl).toHaveBeenCalledWith("https://arr.example.com");
	});

	it.each([
		["https://arr.example.com\\proxy", "https://arr.example.com/proxy"],
		["https://arr.example.com/\tproxy", "https://arr.example.com/proxy"],
	])("persists the parser-canonical External URL: %s", async (externalUrl, expected) => {
		const res = await injectAuthenticated("PUT", "/system/settings", {
			body: { externalUrl },
		});

		expect(res.statusCode, res.payload).toBe(200);
		expect(JSON.parse(res.payload).data.externalUrl).toBe(expected);
		expect(mockPrisma.systemSettings.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.objectContaining({ externalUrl: expected }),
				create: expect.objectContaining({ externalUrl: expected }),
			}),
		);
		expect(mockNotificationService.setBaseUrl).toHaveBeenCalledWith(expected);
	});

	it("clears a whitespace-only External URL and restores the APP_URL fallback", async () => {
		const res = await injectAuthenticated("PUT", "/system/settings", {
			body: { externalUrl: "   " },
		});

		expect(res.statusCode, res.payload).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.data.externalUrl).toBeNull();
		expect(mockNotificationService.setBaseUrl).toHaveBeenCalledWith("http://localhost:3000");
	});

	it("rejects a non-string External URL without persisting it", async () => {
		const res = await injectAuthenticated("PUT", "/system/settings", {
			body: { externalUrl: 123 },
		});

		expect(res.statusCode, res.payload).toBe(400);
		expect(mockPrisma.systemSettings.upsert).not.toHaveBeenCalled();
		expect(mockNotificationService.setBaseUrl).not.toHaveBeenCalled();
	});

	it.each([
		"https://arr.example.com?source=proxy",
		"https://arr.example.com#settings",
		"https://arr.example.com?",
		"https://arr.example.com#",
	])("rejects an External URL with a query or fragment: %s", async (externalUrl) => {
		const res = await injectAuthenticated("PUT", "/system/settings", {
			body: { externalUrl },
		});

		expect(res.statusCode, res.payload).toBe(400);
		expect(JSON.parse(res.payload)).toMatchObject({
			error: "External URL must not include a query string or fragment",
		});
		expect(mockPrisma.systemSettings.upsert).not.toHaveBeenCalled();
		expect(mockNotificationService.setBaseUrl).not.toHaveBeenCalled();
	});

	it.each(["https://admin@arr.example.com", "https://admin:secret@arr.example.com"])(
		"rejects an External URL containing credentials: %s",
		async (externalUrl) => {
			const res = await injectAuthenticated("PUT", "/system/settings", {
				body: { externalUrl },
			});

			expect(res.statusCode, res.payload).toBe(400);
			expect(JSON.parse(res.payload)).toMatchObject({
				error: "External URL must not include credentials",
			});
			expect(mockPrisma.systemSettings.upsert).not.toHaveBeenCalled();
			expect(mockNotificationService.setBaseUrl).not.toHaveBeenCalled();
		},
	);
});

describe("GET /system/security-posture", () => {
	it("uses the configured HTTPS External URL instead of the APP_URL fallback", async () => {
		const res = await injectAuthenticated("GET", "/system/security-posture");

		expect(res.statusCode, res.payload).toBe(200);
		const body = JSON.parse(res.payload);
		const appUrlCheck = body.data.checks.find((check: { id: string }) => check.id === "app-url");

		expect(appUrlCheck).toMatchObject({
			severity: "healthy",
			detail: "External URL uses HTTPS.",
		});
		expect(body.data.effective.appUrl).toBe("https://arr.example.com");
	});

	it.each([
		" https://arr.example.com ",
		"https://admin:secret@arr.example.com",
		"https://arr.example.com\\proxy",
		"https://arr.example.com/\tproxy",
		"https://arr.example.com/base path",
		"https://arr.example.com?source=proxy",
	])(
		"warns when a legacy persisted External URL is not a valid public base: %s",
		async (externalUrl) => {
			mockPrisma.systemSettings.findUnique.mockResolvedValue({ externalUrl });

			const res = await injectAuthenticated("GET", "/system/security-posture");

			expect(res.statusCode, res.payload).toBe(200);
			const body = JSON.parse(res.payload);
			const appUrlCheck = body.data.checks.find((check: { id: string }) => check.id === "app-url");

			expect(appUrlCheck).toMatchObject({
				severity: "warning",
				detail: "External URL is not a valid public URL.",
				remediation: expect.stringContaining("without embedded credentials"),
			});
			expect(body.data.effective.appUrl).toBe(externalUrl);
		},
	);

	it("checks the enabled provider's stored redirect URI instead of APP_URL", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue({
			redirectUri: "https://arr.example.com/auth/oidc/callback",
		});

		const res = await injectAuthenticated("GET", "/system/security-posture");

		expect(res.statusCode, res.payload).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.data.checks).not.toContainEqual(expect.objectContaining({ id: "oidc-app-url" }));
		expect(mockPrisma.oIDCProvider.findFirst).toHaveBeenCalledWith({
			where: { enabled: true },
			select: { redirectUri: true },
		});
	});

	it("does not report OIDC as active until the current admin is linked", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue({
			redirectUri: "https://arr.example.com/auth/oidc/callback",
		});
		mockPrisma.webAuthnCredential.count.mockResolvedValue(1);

		const res = await injectAuthenticated("GET", "/system/security-posture");

		expect(res.statusCode, res.payload).toBe(200);
		const body = JSON.parse(res.payload);
		const authentication = body.data.checks.find(
			(check: { id: string }) => check.id === "authentication",
		);
		const oidcAccountLink = body.data.checks.find(
			(check: { id: string }) => check.id === "oidc-account-link",
		);
		expect(body.data.auth.oidcEnabled).toBe(false);
		expect(body.data.auth.oidcProviderEnabled).toBe(true);
		expect(authentication).toMatchObject({
			severity: "healthy",
		});
		expect(oidcAccountLink).toMatchObject({ severity: "warning" });
		expect(body.data.overall).toBe("warning");
		expect(mockPrisma.oIDCAccount.findFirst).toHaveBeenCalledWith({
			where: { userId: "user-1" },
			select: { id: true },
		});
	});

	it("reports OIDC as active when the enabled provider is linked to the current admin", async () => {
		mockPrisma.oIDCProvider.findFirst.mockResolvedValue({
			redirectUri: "https://arr.example.com/auth/oidc/callback",
		});
		mockPrisma.oIDCAccount.findFirst.mockResolvedValue({ id: "oidc-account-1" });

		const res = await injectAuthenticated("GET", "/system/security-posture");

		expect(res.statusCode, res.payload).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.data.auth.oidcEnabled).toBe(true);
		expect(body.data.auth.oidcProviderEnabled).toBe(true);
		expect(body.data.checks).toContainEqual(
			expect.objectContaining({
				id: "authentication",
				detail: expect.stringContaining("OIDC"),
			}),
		);
	});
});
