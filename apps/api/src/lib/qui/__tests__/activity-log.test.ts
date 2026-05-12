import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { logQuiActivity } from "../activity-log.js";

const silentLog: FastifyBaseLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	fatal: vi.fn(),
	trace: vi.fn(),
	child: vi.fn(() => silentLog),
	level: "info",
	silent: vi.fn(),
} as unknown as FastifyBaseLogger;

function makeApp() {
	const create = vi.fn().mockResolvedValue({});
	const findFirst = vi.fn().mockResolvedValue(null);
	const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
	return {
		log: silentLog,
		prisma: {
			quiActivityLog: { create, findFirst, deleteMany },
		},
		__create: create,
		__findFirst: findFirst,
		__deleteMany: deleteMany,
		// biome-ignore lint/suspicious/noExplicitAny: test-shim
	} as any;
}

describe("logQuiActivity", () => {
	it("inserts the event with stringified details and default status 'ok'", async () => {
		const app = makeApp();
		await logQuiActivity({
			app,
			userId: "user-1",
			eventType: "qui_sync_complete",
			details: { rowsUpdated: 5 },
		});

		const createArgs = app.__create.mock.calls[0]?.[0];
		expect(createArgs.data.userId).toBe("user-1");
		expect(createArgs.data.eventType).toBe("qui_sync_complete");
		expect(createArgs.data.status).toBe("ok");
		expect(JSON.parse(createArgs.data.details)).toEqual({ rowsUpdated: 5 });
	});

	it("honors a passed-in status (warn/error)", async () => {
		const app = makeApp();
		await logQuiActivity({
			app,
			userId: "user-1",
			eventType: "qui_sync_complete",
			details: {},
			status: "error",
		});
		expect(app.__create.mock.calls[0]?.[0].data.status).toBe("error");
	});

	it("never throws when the prisma insert fails — observability is non-fatal", async () => {
		const app = makeApp();
		app.__create.mockRejectedValueOnce(new Error("DB down"));
		await expect(
			logQuiActivity({
				app,
				userId: "user-1",
				eventType: "qui_sync_complete",
				details: {},
			}),
		).resolves.toBeUndefined();
	});

	it("trims the oldest rows when the user has more than the retention cap for this eventType", async () => {
		const app = makeApp();
		// findFirst returns a row at the cap boundary — its createdAt is the
		// delete cutoff. anything <= this gets pruned.
		const cutoff = new Date("2026-05-01T00:00:00.000Z");
		app.__findFirst.mockResolvedValue({ createdAt: cutoff });

		await logQuiActivity({
			app,
			userId: "user-1",
			eventType: "qui_sync_complete",
			details: {},
		});

		const deleteArgs = app.__deleteMany.mock.calls[0]?.[0];
		expect(deleteArgs.where.userId).toBe("user-1");
		expect(deleteArgs.where.eventType).toBe("qui_sync_complete");
		expect(deleteArgs.where.createdAt).toEqual({ lte: cutoff });
	});

	it("skips deleteMany when no trim cutoff exists (user is under the cap)", async () => {
		const app = makeApp();
		app.__findFirst.mockResolvedValue(null);

		await logQuiActivity({
			app,
			userId: "user-1",
			eventType: "qui_sync_complete",
			details: {},
		});
		expect(app.__deleteMany).not.toHaveBeenCalled();
	});
});
