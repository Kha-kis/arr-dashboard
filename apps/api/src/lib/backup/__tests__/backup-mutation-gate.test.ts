import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBackupMutationGuard } from "../backup-mutation-gate.js";
import {
	withCleanupMaintenanceGuard,
	withCleanupOperationGuard,
} from "../../library-cleanup/cleanup-maintenance-gate.js";

describe("backup request mutation gate", () => {
	const apps: Array<ReturnType<typeof Fastify>> = [];

	afterEach(async () => {
		await Promise.all(apps.splice(0).map((app) => app.close()));
	});

	it("covers mutating child-plugin handlers while leaving reads available", async () => {
		const app = Fastify();
		apps.push(app);
		registerBackupMutationGuard(app);

		let releaseMutation!: () => void;
		const mutationStarted = new Promise<void>((resolve) => {
			app.register(async (child) => {
				child.post("/config", async () => {
					resolve();
					await new Promise<void>((release) => {
						releaseMutation = release;
					});
					return { saved: true };
				});
			});
		});
		app.get("/health", async () => ({ ok: true }));
		await app.ready();

		const mutation = app.inject({ method: "POST", url: "/config" });
		await mutationStarted;
		const maintenanceWork = vi.fn();
		await expect(withCleanupMaintenanceGuard(async () => maintenanceWork())).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(maintenanceWork).not.toHaveBeenCalled();
		expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);

		releaseMutation();
		expect((await mutation).statusCode).toBe(200);
	});

	it("upgrades the request's sole shared lease for a maintenance owner", async () => {
		const app = Fastify();
		apps.push(app);
		registerBackupMutationGuard(app);

		let releaseMaintenance!: () => void;
		const maintenanceStarted = new Promise<void>((resolve) => {
			app.post("/restore", async () =>
				withCleanupMaintenanceGuard(async () => {
					resolve();
					await new Promise<void>((release) => {
						releaseMaintenance = release;
					});
					return { restored: true };
				}),
			);
		});
		app.post("/config", async () => ({ saved: true }));
		await app.ready();

		const restore = app.inject({ method: "POST", url: "/restore" });
		await maintenanceStarted;
		const blocked = await app.inject({ method: "POST", url: "/config" });

		expect(blocked.statusCode).toBe(409);
		releaseMaintenance();
		expect((await restore).statusCode).toBe(200);
	});

	it("does not weaken an existing shared operation owner", async () => {
		const app = Fastify();
		apps.push(app);
		registerBackupMutationGuard(app);
		app.post("/shared", async () => withCleanupOperationGuard(async () => ({ saved: true })));
		await app.ready();

		expect((await app.inject({ method: "POST", url: "/shared" })).statusCode).toBe(200);
	});
});
