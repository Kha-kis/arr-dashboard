import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
	CleanupMaintenanceConflictError,
	withCleanupMaintenanceGuard,
} from "../../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { registerTrashGuidesMaintenanceHooks } from "../maintenance-hooks.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe.sequential("TRaSH Guides maintenance hooks", () => {
	it("blocks restore for the full lifetime of a mutating request", async () => {
		const app = Fastify({ logger: false });
		registerTrashGuidesMaintenanceHooks(app);
		const started = deferred();
		const finish = deferred();
		await app.register(async (child) => {
			child.post("/mutate", async () => {
				started.resolve();
				await finish.promise;
				return { ok: true };
			});
		});
		await app.ready();

		const request = app.inject({ method: "POST", url: "/mutate" });
		await started.promise;
		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toBeInstanceOf(
			CleanupMaintenanceConflictError,
		);

		finish.resolve();
		expect((await request).statusCode).toBe(200);
		await expect(withCleanupMaintenanceGuard(async () => "restored")).resolves.toBe("restored");
		await app.close();
	});

	it("rejects mutating requests during restore without blocking reads", async () => {
		const app = Fastify({ logger: false });
		registerTrashGuidesMaintenanceHooks(app);
		app.get("/read", async () => ({ ok: true }));
		app.post("/mutate", async () => ({ ok: true }));
		await app.ready();

		const finish = deferred();
		const restore = withCleanupMaintenanceGuard(() => finish.promise);
		expect((await app.inject({ method: "POST", url: "/mutate" })).statusCode).toBe(409);
		expect((await app.inject({ method: "GET", url: "/read" })).statusCode).toBe(200);

		finish.resolve();
		await restore;
		await app.close();
	});

	it("does not release mutation ownership merely because the request aborts", async () => {
		const app = Fastify({ logger: false });
		registerTrashGuidesMaintenanceHooks(app);
		const started = deferred();
		const finish = deferred();
		const aborted = deferred();
		app.addHook("onRequestAbort", async (_request) => {
			aborted.resolve();
		});
		app.post("/mutate", async () => {
			started.resolve();
			await finish.promise;
			return { ok: true };
		});
		await app.listen({ host: "127.0.0.1", port: 0 });

		const address = app.server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP address");
		const controller = new AbortController();
		const request = fetch(`http://127.0.0.1:${address.port}/mutate`, {
			method: "POST",
			signal: controller.signal,
		}).catch(() => undefined);
		await started.promise;
		controller.abort();
		await request;
		await aborted.promise;

		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toBeInstanceOf(
			CleanupMaintenanceConflictError,
		);

		finish.resolve();
		await new Promise((resolve) => setTimeout(resolve, 10));
		await expect(withCleanupMaintenanceGuard(async () => "restored")).resolves.toBe("restored");
		await app.close();
	});
});
