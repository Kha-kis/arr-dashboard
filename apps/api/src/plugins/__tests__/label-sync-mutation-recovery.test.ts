import Fastify from "fastify";
import fastifyPlugin from "fastify-plugin";
import { afterEach, describe, expect, it, vi } from "vitest";

const recover = vi.hoisted(() => vi.fn());
const schedulerTrack = vi.hoisted(() =>
	vi.fn(async (_id: string, work: () => Promise<unknown>) => work()),
);

vi.mock("../../lib/label-sync/jellyfin-mutation-repository.js", () => ({
	recoverLabelSyncMutationAttempts: recover,
}));

import labelSyncMutationRecoveryPlugin from "../label-sync-mutation-recovery.js";
import labelSyncSchedulerPlugin from "../label-sync-scheduler.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
	vi.clearAllMocks();
	for (const app of apps.splice(0)) await app.close();
});

function createApp() {
	const app = Fastify({ logger: false });
	app.register(fastifyPlugin(async () => {}, { name: "prisma" }));
	app.decorate("prisma", { labelSyncRule: { findMany: async () => [] } } as never);
	app.register(fastifyPlugin(async () => {}, { name: "arr-client" }));
	app.decorate("arrClientFactory", {} as never);
	app.decorate("encryptor", {} as never);
	app.register(fastifyPlugin(async () => {}, { name: "scheduler-registry" }));
	app.decorate("schedulerRegistry", {
		track: schedulerTrack,
		register: () => undefined,
		markDisabled: () => undefined,
	} as never);
	app.register(labelSyncMutationRecoveryPlugin);
	apps.push(app);
	return app;
}

describe("label-sync mutation recovery plugin", () => {
	it("keeps admission closed until full recovery resolves", async () => {
		let release!: () => void;
		recover.mockReturnValue(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		const app = createApp();
		const ready = app.ready();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(app.labelSyncMutationAdmission.isOpen()).toBe(false);
		release();
		await ready;
		expect(app.labelSyncMutationAdmission.isOpen()).toBe(true);
	});

	it("contains recovery failure and leaves admission closed", async () => {
		const secret = "private provider endpoint and token";
		recover.mockRejectedValue(new Error(secret));
		const app = createApp();
		const error = vi.spyOn(app.log, "error");
		await app.ready();
		expect(app.labelSyncMutationAdmission.isOpen()).toBe(false);
		expect(error).toHaveBeenCalledWith(
			{ category: "label-sync-mutation-recovery-failed" },
			expect.any(String),
		);
		expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
	});

	it("runs immediate scheduler startup only after recovery", async () => {
		let release!: () => void;
		recover.mockReturnValue(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		const app = createApp();
		app.register(labelSyncSchedulerPlugin);
		const ready = app.ready();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(schedulerTrack).not.toHaveBeenCalled();
		release();
		await ready;
		expect(schedulerTrack).toHaveBeenCalledOnce();
	});
});
