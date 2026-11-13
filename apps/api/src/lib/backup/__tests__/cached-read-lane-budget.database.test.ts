import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../../../config/env.js";
import { registerProviderInventoryRoutes } from "../../../routes/library/provider-inventory-routes.js";
import { registerSessionValidationHook } from "../../../server.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { SessionService } from "../../auth/session.js";
import type { PrismaClientInstance } from "../../prisma.js";
import {
	withIsolatedRuntimePrismaReadClient,
	withIsolatedRuntimePrismaReadTransaction,
} from "../restore-runtime-client.js";

afterEach(closeScopedWriteFixtures);

describe("bounded cached-read lane acquisition", { timeout: 20_000 }, () => {
	it("authenticates and serves inventory through a normal display burst without increasing four-lane capacity", async () => {
		const f = await createScopedWriteFixture();
		const token = "synthetic-only-lane-budget-session";
		await f.plain.session.create({
			data: {
				id: createHash("sha256").update(token).digest("hex"),
				userId: "synthetic-user",
				expiresAt: new Date(Date.now() + 3_600_000),
			},
		});
		const app = Fastify({ logger: false });
		const sessionService = new SessionService(
			f.client.prisma,
			{ SESSION_COOKIE_NAME: "fixture_session" } as ApiEnv,
			app.log,
		);
		app.decorate("prisma", f.client.prisma);
		app.decorate("restoreRuntime", f.runtime);
		app.decorate("sessionService", sessionService);
		app.decorateRequest("currentUser", null);
		app.decorateRequest("sessionToken", null);
		await app.register(fastifyCookie, {
			secret: "synthetic-only-signing-secret-32bytes",
			hook: "onRequest",
		});
		registerSessionValidationHook(app);
		app.addHook("preHandler", async (request, reply) => {
			if (!request.currentUser) return reply.status(401).send({ error: "Unauthenticated" });
		});
		app.addHook("preClose", async () => sessionService.closeValidationAdmission());
		app.addHook("onClose", async () => sessionService.drainValidations());
		await app.register(registerProviderInventoryRoutes);
		await app.ready();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let allEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			allEntered = resolve;
		});
		let active = 0;
		const holders = Array.from({ length: 4 }, () =>
			f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(f.client.prisma, async (reader) => {
					await reader.serviceInstance.findFirst({
						where: { id: "synthetic-plex", userId: "synthetic-user" },
					});
					if (++active === 4) allEntered();
					try {
						await held;
					} finally {
						active--;
					}
				}),
			),
		);
		let inventory: Promise<{ statusCode: number; json(): unknown }> | undefined;
		let ordinary: Promise<unknown> | undefined;
		try {
			await entered;
			const ordinaryCallback = vi.fn((reader: PrismaClientInstance) =>
				reader.serviceInstance.count({ where: { userId: "synthetic-user" } }),
			);
			ordinary = f.runtime
				.runOperation(() => withIsolatedRuntimePrismaReadClient(f.client.prisma, ordinaryCallback))
				.then(
					(value) => value,
					(error: unknown) => error,
				);
			let inventorySettled = false;
			inventory = f.runtime.runOperation(() =>
				app.inject({
					method: "GET",
					url: "/library/provider-inventory?instanceId=synthetic-plex&domain=library",
					headers: { cookie: `fixture_session=${encodeURIComponent(app.signCookie(token))}` },
				}),
			);
			void inventory.then(() => {
				inventorySettled = true;
			});
			// Exercise the actual two-second policy deadline, not a readiness sleep.
			await delay(2_100);
			expect(ordinaryCallback).not.toHaveBeenCalled();
			expect(active).toBe(4);
			expect(inventorySettled).toBe(false);
			release();
			await Promise.all(holders);
			expect(await ordinary).toBe(2);
			const response = await inventory;
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({ status: "unavailable", reason: "no-publication" });
			expect(ordinaryCallback).toHaveBeenCalledTimes(1);
			expect(f.losses).toEqual([]);
		} finally {
			release();
			await Promise.allSettled(holders);
			await ordinary;
			await inventory;
			await app.close();
		}
	});

	it("removes an expired explicitly bounded waiter without running its callback later", async () => {
		const f = await createScopedWriteFixture();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let allEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			allEntered = resolve;
		});
		let active = 0;
		const holders = Array.from({ length: 4 }, () =>
			f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(f.client.prisma, async () => {
					if (++active === 4) allEntered();
					await held;
				}),
			),
		);
		const callback = vi.fn();
		try {
			await entered;
			const startedAt = performance.now();
			await expect(
				f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaReadTransaction(f.client.prisma, callback, { maxWait: 20 }),
				),
			).rejects.toMatchObject({ statusCode: 503 });
			expect(performance.now() - startedAt).toBeLessThan(1_000);
			release();
			await Promise.all(holders);
			await f.runtime.runOperation(() =>
				withIsolatedRuntimePrismaReadClient(f.client.prisma, (reader) =>
					reader.serviceInstance.count({ where: { userId: "synthetic-user" } }),
				),
			);
			expect(callback).not.toHaveBeenCalled();
			expect(f.losses).toEqual([]);
		} finally {
			release();
			await Promise.allSettled(holders);
		}
	});
});
