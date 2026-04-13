/**
 * End-to-end integration test for the scheduler init failure-handling
 * contract documented in `docs/domains/schedulers.md`.
 *
 * Boots the REAL `backup-scheduler` plugin (not the helper in isolation)
 * and forces an init failure by stubbing `app.config` with a Proxy that
 * throws on property access. This proves the full chain works:
 *
 *   plugin onReady → runSchedulerInit → markDisabled → /system/jobs surface
 *
 * If a future refactor unwraps a plugin's init or bypasses
 * `runSchedulerInit`, this test fails — preventing silent regression of
 * the operator-visible contract. The `system-jobs.test.ts` integration
 * test pins the same surface but exercises the helper directly; this
 * test pins it through a real plugin's onReady chain.
 */

import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import backupSchedulerPlugin from "../backup-scheduler.js";
import schedulerRegistryPlugin from "../scheduler-registry.js";

/**
 * Minimal stub for the real `prisma` plugin. backup-scheduler declares
 * `dependencies: ["prisma", "scheduler-registry"]`; Fastify's dependency
 * check requires a registered plugin with that exact name, not just a
 * decoration. We don't need a real Prisma client because the forced init
 * failure happens before backup-scheduler ever touches it.
 */
const stubPrismaPlugin = fp(
	async (app: FastifyInstance) => {
		app.decorate("prisma", {} as never);
	},
	{ name: "prisma" },
);

let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
	app = Fastify({ logger: false });

	// notificationService is read by the plugin but not declared as a
	// fastify-plugin dependency, so a plain decoration is enough.
	app.decorate("notificationService", { notify: vi.fn() } as never);

	// Force init failure: install a config object whose DATABASE_URL getter
	// throws. The plugin reads `app.config.DATABASE_URL` first thing inside
	// the onReady body; this synthetic-but-realistic failure mode mirrors
	// what would happen if config resolution started returning a poisoned
	// shape. A Proxy here is too eager — Fastify's `decorate` validates the
	// value and triggers the trap before onReady runs — so we use a
	// property-specific getter, which is only evaluated when the property
	// is actually read.
	const failingConfig: Record<string, unknown> = {};
	Object.defineProperty(failingConfig, "DATABASE_URL", {
		enumerable: true,
		get() {
			throw new Error("simulated config failure");
		},
	});
	app.decorate("config", failingConfig as never);

	await app.register(stubPrismaPlugin);
	await app.register(schedulerRegistryPlugin);
	await app.register(backupSchedulerPlugin);
	// `ready()` triggers all onReady hooks. If runSchedulerInit re-threw,
	// this would reject; that it resolves is itself part of the contract.
	await app.ready();
});

afterAll(async () => {
	await app?.close();
});

describe("scheduler init failure surfaces through the plugin chain", () => {
	it("backup-scheduler init failure is recorded as state=disabled with a human-readable reason", async () => {
		const status = app.schedulerRegistry.getStatus(JOB_ID.backup);

		expect(status).not.toBeNull();
		expect(status?.state).toBe("disabled");
		expect(status?.disabled).toBe(true);
		expect(status?.disabledReason).toBe("Init failed: simulated config failure");
		// totalRuns stays at 0 — the failure happened before any tick ran.
		expect(status?.totalRuns).toBe(0);
		expect(status?.lastError).toBeNull();
	});

	it("server.ready() resolves despite the scheduler init failure", () => {
		// Implicit assertion: beforeEach awaited app.ready() without throwing.
		// This is what enables sibling onReady hooks to keep running in the
		// real server. The runSchedulerInit unit test pins the helper-level
		// no-rethrow invariant; this test pins it at the live-plugin level.
		expect(app.hasDecorator("schedulerRegistry")).toBe(true);
	});
});
