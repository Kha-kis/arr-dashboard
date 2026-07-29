import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import backupSchedulerPlugin from "../backup-scheduler.js";
import schedulerRegistryPlugin from "../scheduler-registry.js";

const stubPrismaPlugin = fp(
	async (app: FastifyInstance) => {
		app.decorate("prisma", {} as never);
	},
	{ name: "prisma" },
);

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
	app = Fastify({ logger: false });
	app.decorate("config", { DATABASE_URL: "file:./dev.db" } as never);
	app.decorate("notificationService", { notify: vi.fn() } as never);
	app.decorate("secretsSynchronized", false);

	await app.register(stubPrismaPlugin);
	await app.register(schedulerRegistryPlugin);
	await app.register(backupSchedulerPlugin);
	await app.ready();
});

afterAll(async () => {
	await app?.close();
});

describe("backup scheduler with unsynchronized environment secrets", () => {
	it("reports the job as disabled instead of idle", () => {
		const status = app.schedulerRegistry.getStatus(JOB_ID.backup);

		expect(status?.state).toBe("disabled");
		expect(status?.disabled).toBe(true);
		expect(status?.disabledReason).toMatch(/environment secrets could not be synchronized/i);
		expect(status?.totalRuns).toBe(0);
		expect(app.hasDecorator("backupScheduler")).toBe(false);
	});
});
