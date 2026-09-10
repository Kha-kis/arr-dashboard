import Fastify from "fastify";
import fastifyPlugin from "fastify-plugin";
import { afterEach, describe, expect, it, vi } from "vitest";

const reconcile = vi.hoisted(() => vi.fn());

vi.mock("../../lib/services/provider-cache-status.js", () => ({
	reconcileInterruptedProviderCacheRefreshAttempts: reconcile,
}));

import providerCacheAttemptRecoveryPlugin from "../provider-cache-attempt-recovery.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
	vi.clearAllMocks();
	for (const app of apps.splice(0)) await app.close();
});

async function createApp() {
	const app = Fastify({ logger: false });
	app.register(fastifyPlugin(async () => {}, { name: "prisma" }));
	app.decorate("prisma", {} as never);
	app.register(providerCacheAttemptRecoveryPlugin);
	apps.push(app);
	return app;
}

describe("provider cache attempt recovery plugin", () => {
	it("runs recovery before the ready lifecycle completes", async () => {
		reconcile.mockResolvedValue(2);
		const app = await createApp();

		await app.ready();

		expect(reconcile).toHaveBeenCalledWith(app.prisma);
	});

	it("fails readiness with a sanitized error when recovery fails", async () => {
		const secret = "provider endpoint and credential";
		reconcile.mockRejectedValue(new Error(secret));
		const app = await createApp();
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
	});
});
