import Fastify from "fastify";
import fastifyPlugin from "fastify-plugin";
import { afterEach, describe, expect, it, vi } from "vitest";

const recover = vi.hoisted(() => vi.fn());
const reconcile = vi.hoisted(() => vi.fn());
vi.mock("../../lib/services/provider-cache-status.js", () => ({
	reconcileInterruptedProviderCacheRefreshAttempts: reconcile,
}));
vi.mock("../../lib/provider-observation/observation-run-repository.js", () => ({
	recoverAbandonedObservationRuns: recover,
}));

import providerCacheAttemptRecoveryPlugin from "../provider-cache-attempt-recovery.js";
import providerObservationRunRecoveryPlugin from "../provider-observation-run-recovery.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
	vi.clearAllMocks();
	for (const app of apps.splice(0)) await app.close();
});

function createApp(events: string[]) {
	const app = Fastify({ logger: false });
	app.register(fastifyPlugin(async () => {}, { name: "prisma" }));
	app.register(fastifyPlugin(async () => {}, { name: "security", dependencies: ["prisma"] }));
	app.decorate("prisma", {} as never);
	app.register(providerCacheAttemptRecoveryPlugin);
	app.register(providerObservationRunRecoveryPlugin);
	reconcile.mockImplementation(async () => {
		events.push("cache-attempt-recovery");
	});
	recover.mockImplementation(async () => {
		events.push("observation-run-recovery");
	});
	apps.push(app);
	return app;
}

describe("provider observation run recovery plugin", () => {
	it("runs recovery during startup", async () => {
		const events: string[] = [];
		const app = createApp(events);
		await app.ready();
		expect(recover).toHaveBeenCalledWith(app.prisma);
		expect(events).toEqual(["cache-attempt-recovery", "observation-run-recovery"]);
	});

	it("rejects readiness and skips unit recovery when outer recovery fails", async () => {
		const secret = "provider endpoint and credential";
		const events: string[] = [];
		const app = createApp(events);
		reconcile.mockRejectedValue(new Error(secret));
		const error = vi.spyOn(app.log, "error");
		const readyError = await app.ready().then(
			() => undefined,
			(readyError) => readyError,
		);
		expect(readyError).toBeInstanceOf(Error);
		expect((readyError as Error).message).toBe("Provider cache attempt recovery failed");
		expect((readyError as Error).message).not.toContain(secret);
		expect(error).toHaveBeenCalledWith(
			{ category: "provider-cache-attempt-recovery-failed" },
			expect.any(String),
		);
		expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
		expect(reconcile).toHaveBeenCalledWith(app.prisma);
		expect(events).toEqual([]);
		expect(recover).not.toHaveBeenCalled();
	});

	it("rejects readiness with a sanitized error when unit recovery fails", async () => {
		const secret = "provider endpoint and credential";
		const events: string[] = [];
		const app = createApp(events);
		recover.mockRejectedValue(new Error(secret));
		const error = vi.spyOn(app.log, "error");
		const readyError = await app.ready().then(
			() => undefined,
			(readyError) => readyError,
		);
		expect(readyError).toBeInstanceOf(Error);
		expect((readyError as Error).message).toBe("Provider observation run recovery failed");
		expect((readyError as Error).message).not.toContain(secret);
		expect(error).toHaveBeenCalledWith(
			{ category: "provider-observation-run-recovery-failed" },
			expect.any(String),
		);
		expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
		expect(reconcile).toHaveBeenCalledWith(app.prisma);
		expect(recover).toHaveBeenCalledWith(app.prisma);
	});
});
