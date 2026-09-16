import Fastify, { type FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_ID, KNOWN_JOBS } from "../../lib/scheduler-registry/job-definitions.js";

const mocks = vi.hoisted(() => ({
	refresh: vi.fn(),
}));

vi.mock("../../lib/tautulli/tautulli-cache-refresher.js", () => ({
	refreshOwnedTautulliCache: mocks.refresh,
}));

import tautulliCacheSchedulerPlugin, {
	refreshScheduledTautulliCacheInstance,
} from "../tautulli-cache-scheduler.js";

const startupDelayMs = 2 * 60_000;
const intervalMs = 5 * 60_000;

type TestInstance = {
	id: string;
	label: string;
	baseUrl: string;
	service: "TAUTULLI";
	enabled: true;
};

function makeInstance(suffix: string): TestInstance {
	return {
		id: `PRIVATE_INSTANCE_ID_${suffix}`,
		label: `PRIVATE_INSTANCE_LABEL_${suffix}`,
		baseUrl: `https://PRIVATE_INSTANCE_URL_${suffix}.invalid`,
		service: "TAUTULLI",
		enabled: true,
	};
}

function positiveResult(overrides: Record<string, unknown> = {}) {
	return {
		kind: "positive-observation",
		complete: true,
		upserted: 3,
		errors: 0,
		errorMessages: [],
		receipt: { attemptToken: "PRIVATE_ATTEMPT_TOKEN" },
		...overrides,
	};
}

describe("refreshScheduledTautulliCacheInstance", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		mocks.refresh.mockResolvedValue(positiveResult());
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("publishes generic outcome telemetry from result.kind without status writes", async () => {
		const app = {
			prisma: { cacheRefreshStatus: { upsert: vi.fn() } },
			encryptor: {},
			log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
		};
		const instance = makeInstance("ONE");

		await refreshScheduledTautulliCacheInstance(app as never, instance as never);

		expect(mocks.refresh).toHaveBeenCalledWith({
			prisma: app.prisma,
			encryptor: app.encryptor,
			instance,
			log: app.log,
		});
		expect(app.prisma.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
		const telemetry = app.log.info.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(Object.keys(telemetry).sort()).toEqual(
			["durationMs", "errors", "outcome", "provider", "superseded", "upserted"].sort(),
		);
		expect(Number.isInteger(telemetry.durationMs)).toBe(true);
		expect(telemetry.durationMs).toBeGreaterThanOrEqual(0);
		expect(app.log.info).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "tautulli",
				outcome: "positive-observation",
				upserted: 3,
				errors: 0,
				superseded: false,
			}),
			expect.any(String),
		);
	});

	it.each([
		["unpublished", { kind: "unpublished", upserted: 0, errors: 1 }],
		["superseded", { kind: "unpublished", upserted: 0, errors: 0, superseded: true }],
	] as const)("classifies a %s result without a second status write", async (outcome, result) => {
		const app = {
			prisma: { cacheRefreshStatus: { upsert: vi.fn() } },
			encryptor: {},
			log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
		};
		const superseded = "superseded" in result ? result.superseded : undefined;
		mocks.refresh.mockResolvedValueOnce({
			kind: result.kind,
			complete: true,
			upserted: result.upserted,
			errors: result.errors,
			errorMessages: ["PRIVATE_RAW_FAILURE"],
			superseded,
			receipt: { attemptToken: "PRIVATE_ATTEMPT_TOKEN" },
		});

		await refreshScheduledTautulliCacheInstance(app as never, makeInstance("TWO") as never);

		expect(app.prisma.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
		expect(app.log.info).toHaveBeenCalledWith(
			expect.objectContaining({ outcome, superseded: outcome === "superseded" }),
			expect.any(String),
		);
	});

	it("logs only a fixed generic reason when the refresher throws", async () => {
		const app = {
			prisma: {},
			encryptor: {},
			log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
		};
		mocks.refresh.mockRejectedValueOnce(
			new Error("PRIVATE_RAW_FAILURE token=PRIVATE_ATTEMPT_TOKEN"),
		);

		await refreshScheduledTautulliCacheInstance(app as never, makeInstance("THREE") as never);

		expect(app.log.error).toHaveBeenCalledWith(
			{ provider: "tautulli", reasonCode: "unknown_failure" },
			expect.any(String),
		);
		expect(JSON.stringify(app.log.error.mock.calls)).not.toContain("PRIVATE_RAW_FAILURE");
		expect(JSON.stringify(app.log.error.mock.calls)).not.toContain("PRIVATE_ATTEMPT_TOKEN");
	});
});

describe("Tautulli observation scheduler lifecycle", () => {
	let app: FastifyInstance;
	let instances: TestInstance[];
	let prisma: {
		serviceInstance: { findMany: ReturnType<typeof vi.fn> };
		cacheRefreshStatus: { findMany: ReturnType<typeof vi.fn> };
	};
	let logSpies: Array<ReturnType<typeof vi.spyOn>>;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		mocks.refresh.mockResolvedValue(positiveResult());
		instances = [makeInstance("A"), makeInstance("B")];
		prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue(instances) },
			cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([]) },
		};
		app = Fastify({ logger: false });
		logSpies = ["debug", "info", "warn", "error"].map((level) =>
			vi.spyOn(app.log, level as "debug").mockImplementation(() => undefined),
		);

		await app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("prisma", prisma as never);
				},
				{
					name: "prisma",
				},
			),
		);
		await app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("encryptor", {} as never);
				},
				{
					name: "security",
				},
			),
		);
		await app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("schedulerRegistry", {
						track: vi.fn(async (_jobId: string, callback: () => Promise<unknown>) => callback()),
					} as never);
				},
				{ name: "scheduler-registry" },
			),
		);
		await app.register(tautulliCacheSchedulerPlugin);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("waits two minutes, then ticks every five minutes and processes enabled instances serially", async () => {
		let inFlight = 0;
		let maximumInFlight = 0;
		mocks.refresh.mockImplementation(async () => {
			inFlight += 1;
			maximumInFlight = Math.max(maximumInFlight, inFlight);
			await Promise.resolve();
			inFlight -= 1;
			return positiveResult();
		});

		expect(mocks.refresh).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(startupDelayMs - 1);
		expect(mocks.refresh).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		expect(mocks.refresh).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ instance: instances[0] }),
		);
		expect(mocks.refresh).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ instance: instances[1] }),
		);
		expect(maximumInFlight).toBe(1);

		await vi.advanceTimersByTimeAsync(intervalMs - 1);
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(mocks.refresh).toHaveBeenCalledTimes(4);
	});

	it("skips a due tick while the prior tick is unresolved", async () => {
		let resolveRefresh!: () => void;
		mocks.refresh.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveRefresh = () => resolve(positiveResult());
				}),
		);

		await vi.advanceTimersByTimeAsync(startupDelayMs);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(intervalMs);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);

		resolveRefresh();
		await vi.runOnlyPendingTimersAsync();
	});

	it("does not query stale status or call notifications", async () => {
		await vi.advanceTimersByTimeAsync(startupDelayMs);

		expect(prisma.cacheRefreshStatus.findMany).not.toHaveBeenCalled();
		expect(app.hasDecorator("notificationService")).toBe(false);
	});

	it("keeps private instance, URL, raw error, and attempt token values out of logs", async () => {
		mocks.refresh.mockResolvedValueOnce({
			kind: "unpublished",
			complete: true,
			upserted: 0,
			errors: 1,
			errorMessages: ["PRIVATE_RAW_FAILURE"],
			superseded: false,
			receipt: { attemptToken: "PRIVATE_ATTEMPT_TOKEN" },
		});

		await vi.advanceTimersByTimeAsync(startupDelayMs);
		const serializedLogs = JSON.stringify(logSpies.flatMap((spy) => spy.mock.calls));
		for (const privateValue of [
			instances[0]?.id,
			instances[0]?.label,
			instances[0]?.baseUrl,
			"PRIVATE_RAW_FAILURE",
			"PRIVATE_ATTEMPT_TOKEN",
		]) {
			expect(serializedLogs).not.toContain(privateValue);
		}
	});

	it("logs query failures with a generic category and no raw exception", async () => {
		const privateError = "PRIVATE_QUERY_ERROR token=PRIVATE_ATTEMPT_TOKEN";
		prisma.serviceInstance.findMany.mockRejectedValueOnce(new Error(privateError));

		await vi.advanceTimersByTimeAsync(startupDelayMs);

		expect(JSON.stringify(logSpies.flatMap((spy) => spy.mock.calls))).not.toContain(privateError);
		expect(
			logSpies.some((spy) =>
				spy.mock.calls.some((args: unknown[]) =>
					JSON.stringify(args).includes("scheduler_tick_failed"),
				),
			),
		).toBe(true);
	});

	it("clears startup and interval timers on close", async () => {
		expect(vi.getTimerCount()).toBe(1);
		await app.close();
		expect(vi.getTimerCount()).toBe(0);

		app = Fastify({ logger: false });
		await app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("prisma", prisma as never);
				},
				{
					name: "prisma",
				},
			),
		);
		await app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("encryptor", {} as never);
				},
				{
					name: "security",
				},
			),
		);
		await app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("schedulerRegistry", {
						track: vi.fn(async (_id: string, callback: () => Promise<unknown>) => callback()),
					} as never);
				},
				{ name: "scheduler-registry" },
			),
		);
		await app.register(tautulliCacheSchedulerPlugin);
		await app.ready();
		await vi.advanceTimersByTimeAsync(startupDelayMs);
		expect(vi.getTimerCount()).toBe(1);
		await app.close();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("Tautulli scheduler registry metadata", () => {
	it("declares a singleton five-minute positive-observation job", () => {
		const definition = KNOWN_JOBS.find(({ id }) => id === JOB_ID.tautulliCache);

		expect(definition).toEqual({
			id: JOB_ID.tautulliCache,
			label: "Tautulli observations",
			description:
				"Collects bounded positive-only recent Tautulli observations every 5 minutes. Per-process overlap is guarded locally; durable attempt CAS resolves cross-process publication.",
			concurrency: "singleton",
			intervalMs,
		});
	});
});
