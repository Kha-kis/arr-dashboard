/**
 * GET /system/security-posture HTTP integration tests.
 *
 * The route combines runtime environment values with database-backed system
 * settings. Keep the reverse-proxy External URL path covered here so the
 * security diagnostic reports the same public origin configured in Settings.
 */

import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSystemRoutes } from "../system.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let mockPrisma: {
	systemSettings: { findUnique: ReturnType<typeof vi.fn> };
	oIDCProvider: { findFirst: ReturnType<typeof vi.fn> };
	webAuthnCredential: { count: ReturnType<typeof vi.fn> };
	user: { count: ReturnType<typeof vi.fn> };
};

beforeEach(async () => {
	mockPrisma = {
		systemSettings: {
			findUnique: vi.fn().mockResolvedValue({
				externalUrl: "https://arr.example.com",
			}),
		},
		oIDCProvider: { findFirst: vi.fn().mockResolvedValue(null) },
		webAuthnCredential: { count: vi.fn().mockResolvedValue(1) },
		user: { count: vi.fn().mockResolvedValue(1) },
	};

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
});
