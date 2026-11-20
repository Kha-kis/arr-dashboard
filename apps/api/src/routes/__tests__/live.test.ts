import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHealthRoutes, registerLiveRoutes } from "../health.js";

describe("health probe separation", () => {
	const apps: Array<ReturnType<typeof Fastify>> = [];
	afterEach(async () => {
		await Promise.all(apps.splice(0).map((app) => app.close()));
	});

	it("keeps process liveness available while database readiness fails", async () => {
		const app = Fastify();
		apps.push(app);
		const databaseQuery = vi.fn().mockRejectedValue(new Error("synthetic database stall"));
		app.decorate("prisma", { $queryRaw: databaseQuery } as unknown as typeof app.prisma);
		app.register(registerHealthRoutes, { prefix: "/health" });
		app.register(registerLiveRoutes, { prefix: "/live" });
		await app.ready();

		expect((await app.inject({ method: "GET", url: "/live" })).statusCode).toBe(200);
		expect((await app.inject({ method: "HEAD", url: "/live" })).statusCode).toBe(200);
		expect(databaseQuery).not.toHaveBeenCalled();
		expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(503);
		expect(databaseQuery).toHaveBeenCalledTimes(1);
	});
});
