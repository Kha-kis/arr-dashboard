import { createHash } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../../config/env.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	type ScopedWriteFixture,
} from "../../lib/__tests__/scoped-write-intent-fixture.js";
import { hashPassword } from "../../lib/auth/password.js";
import { SessionService } from "../../lib/auth/session.js";
import { registerAuthRoutes } from "../auth.js";
import { registerAuthOidcRoutes } from "../auth-oidc.js";

// No provider calls: SQL, password verification, session persistence and cookies
// still use their real production implementations against an owned native DB.
vi.mock("../../lib/arr/connection-warmer.js", () => ({
	warmConnectionsForUser: vi.fn().mockResolvedValue(undefined),
}));

afterEach(closeScopedWriteFixtures);

const password = "Synthetic-auth-only-123!";

async function setup() {
	const f = await createScopedWriteFixture();
	await f.plain.user.update({
		where: { id: "synthetic-user" },
		data: { hashedPassword: await hashPassword(password) },
	});
	const app = Fastify({ logger: false });
	const env = {
		PASSWORD_POLICY: "relaxed",
		SESSION_COOKIE_NAME: "fixture_session",
		SESSION_TTL_HOURS: 24,
		TRUST_PROXY: false,
	} as ApiEnv;
	app.decorate("prisma", f.client.prisma);
	app.decorate("config", env);
	app.decorate("sessionService", new SessionService(f.client.prisma, env, app.log));
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);
	await app.register(fastifyCookie, { secret: "synthetic-cookie-secret-32-characters" });
	await app.register(registerAuthRoutes, { prefix: "/auth" });
	await app.register(registerAuthOidcRoutes, { prefix: "/auth" });
	await app.ready();
	const login = (input = password, username = "synthetic-user") =>
		f.runtime.runOperation(() =>
			app.inject({ method: "POST", url: "/auth/login", payload: { username, password: input } }),
		);
	return { f, app, login };
}

async function holdOrdinaryTransaction(f: ScopedWriteFixture, write = false) {
	const rollback = new Error("synthetic-auth-transaction-rollback");
	let entered!: () => void;
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const completion = f.runtime
		.runOperation(() =>
			f.client.prisma.$transaction(
				async (tx) => {
					if (write) {
						await tx.user.update({
							where: { id: "synthetic-user" },
							data: { username: "uncommitted-user" },
						});
					} else {
						await tx.user.findUniqueOrThrow({ where: { id: "synthetic-user" } });
					}
					entered();
					await held;
					throw rollback;
				},
				{ timeout: 15_000 },
			),
		)
		.then(
			() => null,
			(error: unknown) => error,
		);
	await Promise.race([
		ready,
		completion.then(() => {
			throw new Error("Transaction did not enter");
		}),
	]);
	return async () => {
		release();
		expect(await completion).toBe(rollback);
	};
}

describe("password login native client acquisition", { timeout: 20_000 }, () => {
	it("keeps the OIDC-provider bootstrap available while the ordinary client is held", async () => {
		const { f, app } = await setup();
		await f.plain.oIDCProvider.create({
			data: {
				displayName: "Synthetic provider",
				clientId: "synthetic-client",
				encryptedClientSecret: "synthetic-cipher",
				clientSecretIv: "synthetic-iv",
				issuer: "https://issuer.invalid",
				redirectUri: "https://app.invalid/auth/oidc/callback",
			},
		});
		const release = await holdOrdinaryTransaction(f, true);
		try {
			const response = await f.runtime.runOperation(() =>
				app.inject({ method: "GET", url: "/auth/oidc/providers" }),
			);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				provider: { displayName: "Synthetic provider", enabled: true },
			});
		} finally {
			await release();
			await app.close();
		}
		expect(f.losses).toEqual([]);
	});

	it("persists a real session while an unrelated ordinary read transaction remains held", async () => {
		const { f, app, login } = await setup();
		const release = await holdOrdinaryTransaction(f);
		try {
			const response = await login();
			expect(response.statusCode).toBe(200);
			const cookie = response.cookies.find((entry) => entry.name === "fixture_session");
			expect(cookie).toBeDefined();
			expect(cookie!.httpOnly).toBe(true);
			const unsigned = app.unsignCookie(cookie!.value);
			expect(unsigned.valid).toBe(true);
			const id = createHash("sha256").update(unsigned.value!).digest("hex");
			expect(await f.plain.session.findUnique({ where: { id } })).toMatchObject({
				userId: "synthetic-user",
			});
			expect(response.json().user).toMatchObject({ id: "synthetic-user" });
			expect(response.body).not.toContain("hashedPassword");
		} finally {
			await release();
			await app.close();
		}
		expect(f.losses).toEqual([]);
	});

	it("retains failed-attempt accounting and clears it on a successful retry while the reader is held", async () => {
		const { f, app, login } = await setup();
		const release = await holdOrdinaryTransaction(f);
		try {
			const rejected = await login("Synthetic-wrong-password!");
			expect(rejected.statusCode).toBe(401);
			expect(rejected.cookies).toEqual([]);
			expect(await f.plain.user.findUnique({ where: { id: "synthetic-user" } })).toMatchObject({
				failedLoginAttempts: 1,
			});
			expect((await login()).statusCode).toBe(200);
			expect(await f.plain.user.findUnique({ where: { id: "synthetic-user" } })).toMatchObject({
				failedLoginAttempts: 0,
				lockedUntil: null,
			});
			expect(await f.plain.session.count()).toBe(1);
		} finally {
			await release();
			await app.close();
		}
		expect(f.losses).toEqual([]);
	});

	it("does not authenticate an uncommitted username or lose setup detection behind an ordinary writer", async () => {
		const { f, app, login } = await setup();
		const release = await holdOrdinaryTransaction(f, true);
		try {
			const setupResponse = await f.runtime.runOperation(() =>
				app.inject({ method: "GET", url: "/auth/setup-required" }),
			);
			expect(setupResponse.statusCode).toBe(200);
			expect(setupResponse.json().required).toBe(false);
			const response = await login(password, "uncommitted-user");
			expect(response.statusCode).toBe(401);
			expect(response.cookies).toEqual([]);
			expect(await f.plain.session.count()).toBe(0);
		} finally {
			await release();
			await app.close();
		}
		expect(f.losses).toEqual([]);
	});

	it("never acknowledges a session while a real writer prevents persistence, and recovers after rollback", async () => {
		const { f, app, login } = await setup();
		const release = await holdOrdinaryTransaction(f, true);
		try {
			const response = await login();
			expect(response.statusCode).toBeGreaterThanOrEqual(500);
			expect(response.cookies).toEqual([]);
			expect(await f.plain.session.count()).toBe(0);
		} finally {
			await release();
		}
		try {
			expect((await login()).statusCode).toBe(200);
			expect(await f.plain.session.count()).toBe(1);
		} finally {
			await app.close();
		}
		expect(f.losses).toEqual([]);
	});
});
