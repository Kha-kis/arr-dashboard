import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { SessionService } from "../../lib/auth/session.js";
import { registerBackupRoutes as backupRoutes } from "../backup.js";

describe.each(["restore", "restore-from-file"])("actual %s pre-publication rate limit", (route) => {
	it("keeps the two-request limit and emits only bounded refusal evidence before preparation", async () => {
		const app = Fastify({ logger: false });
		let preparations = 0;
		let parentErrors = 0;
		app.decorate("restoreRuntime", {
			runStarting: async () => {
				throw new Error("Unexpected startup");
			},
			bindDestination: async () => {
				throw new Error("Unexpected destination binding");
			},
			activate: async () => {
				throw new Error("Unexpected activation");
			},
			closeAdmission: () => {
				throw new Error("Unexpected admission close");
			},
			drain: async () => {
				throw new Error("Unexpected runtime drain");
			},
			close: async () => {
				throw new Error("Unexpected runtime close");
			},
			runIndependentOperation: async <T>(operation: () => T | Promise<T>) => operation(),
			runOperation: async () => {
				preparations++;
				throw new Error("Unexpected preparation");
			},
		});
		const now = new Date();
		// Authentication is a controlled dependency in this pre-body limiter
		// test; native authentication/publication remains a separate image gate.
		const sessionService = vi.mockObject(SessionService.prototype);
		sessionService.validateRequest.mockResolvedValue({
			session: {
				id: "synthetic-session",
				userId: "synthetic-account",
				createdAt: now,
				expiresAt: new Date(now.getTime() + 60_000),
				lastAccessedAt: now,
				userAgent: null,
				ipAddress: null,
				user: {
					id: "synthetic-account",
					username: "synthetic",
					createdAt: now,
					updatedAt: now,
					mustChangePassword: false,
				},
			},
			token: "synthetic-fixture-token",
		});
		app.decorate("sessionService", sessionService);
		// A parent that discards extra error fields proves the route must produce
		// its own contract; merely attaching fields to a plugin error is insufficient.
		app.setErrorHandler((error, _request, reply) => {
			parentErrors++;
			const status =
				error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
					? error.statusCode
					: 500;
			return reply.code(status).send({ error: "Generic parent response" });
		});
		await app.register(rateLimit, { global: false });
		await app.register(backupRoutes, { prefix: "/api/backup" });
		app.get(
			"/unrelated-rate-limit",
			{ config: { rateLimit: { max: 1, timeWindow: "5 minutes" } } },
			async () => ({ ok: true }),
		);
		await app.ready();
		try {
			const submit = () => app.inject({ method: "POST", url: `/api/backup/${route}`, payload: {} });
			expect((await submit()).statusCode).toBe(400);
			expect((await submit()).statusCode).toBe(400);
			const limited = await submit();
			expect(limited.statusCode).toBe(429);
			const evidence = limited.json();
			expect(Object.keys(evidence).sort()).toEqual(["category", "error", "retryAfterSeconds"]);
			expect(evidence.category).toBe("restore-rate-limited");
			expect(evidence.error).toBe("Restore request rejected");
			expect(Number.isInteger(evidence.retryAfterSeconds)).toBe(true);
			expect(evidence.retryAfterSeconds).toBeGreaterThan(0);
			expect(evidence.retryAfterSeconds).toBeLessThanOrEqual(300);
			expect(preparations).toBe(0);
			expect(parentErrors).toBe(0);
			expect((await app.inject({ url: "/unrelated-rate-limit" })).statusCode).toBe(200);
			const unrelated = await app.inject({ url: "/unrelated-rate-limit" });
			expect(unrelated.statusCode).toBe(429);
			expect(unrelated.json()).toEqual({ error: "Generic parent response" });
			expect(parentErrors).toBe(1);
		} finally {
			await app.close();
		}
	});
});
