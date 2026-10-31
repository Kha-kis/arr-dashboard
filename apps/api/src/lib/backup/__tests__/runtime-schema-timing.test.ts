import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
	events: [] as unknown[],
	createFails: false,
	writeFails: false,
}));
vi.mock("pino", () => ({
	default: Object.assign(
		() => {
			if (boundary.createFails) throw new Error("synthetic log creation failure");
			return {
				info: (event: unknown) => {
					if (boundary.writeFails) throw new Error("synthetic log write failure");
					boundary.events.push(event);
				},
			};
		},
		{ destination: () => ({}) },
	),
}));

beforeEach(() => {
	vi.resetModules();
	boundary.events.length = 0;
	boundary.createFails = false;
	boundary.writeFails = false;
});
afterEach(() => vi.restoreAllMocks());

describe("SQLite startup timing isolation", () => {
	it("returns the original synchronous result and emits only the bounded measurement", async () => {
		const { timeSqliteStartupPhase } = await import("../runtime-schema-timing.js");
		const result = { privateData: "must not enter the event" };
		expect(timeSqliteStartupPhase("catalog-preflight", () => result)).toBe(result);
		expect(boundary.events).toEqual([
			{
				category: "sqlite-startup-phase",
				phase: "catalog-preflight",
				outcome: "completed",
				elapsedMs: expect.any(Number),
			},
		]);
		expect(Number.isFinite((boundary.events[0] as { elapsedMs: number }).elapsedMs)).toBe(true);
	});
	it("rethrows the identical synchronous failure without logging its contents", async () => {
		const { timeSqliteStartupPhase } = await import("../runtime-schema-timing.js");
		const error = new Error("synthetic private SQL failure");
		let caught: unknown;
		try {
			timeSqliteStartupPhase("date-plan", () => {
				throw error;
			});
		} catch (failure) {
			caught = failure;
		}
		expect(caught).toBe(error);
		expect(boundary.events).toEqual([
			{
				category: "sqlite-startup-phase",
				phase: "date-plan",
				outcome: "failed",
				elapsedMs: expect.any(Number),
			},
		]);
	});
	it("waits for the asynchronous operation and preserves its result", async () => {
		const { timeSqliteStartupPhaseAsync } = await import("../runtime-schema-timing.js");
		let release!: (value: object) => void;
		const pending = new Promise<object>((resolve) => {
			release = resolve;
		});
		const operation = timeSqliteStartupPhaseAsync("total", () => pending);
		expect(boundary.events).toEqual([]);
		const result = {};
		release(result);
		expect(await operation).toBe(result);
		expect(boundary.events).toEqual([
			{
				category: "sqlite-startup-phase",
				phase: "total",
				outcome: "completed",
				elapsedMs: expect.any(Number),
			},
		]);
	});
	it("preserves asynchronous failure identity even if writing diagnostics throws", async () => {
		const { timeSqliteStartupPhaseAsync } = await import("../runtime-schema-timing.js");
		boundary.writeFails = true;
		const error = new Error("synthetic closure failure");
		await expect(
			timeSqliteStartupPhaseAsync("total", async () => {
				throw error;
			}),
		).rejects.toBe(error);
	});
	it("does not let logger construction or writing change successful startup work", async () => {
		const { timeSqliteStartupPhase, timeSqliteStartupPhaseAsync } = await import(
			"../runtime-schema-timing.js"
		);
		boundary.createFails = true;
		expect(timeSqliteStartupPhase("commit", () => 7)).toBe(7);
		boundary.createFails = false;
		boundary.writeFails = true;
		expect(await timeSqliteStartupPhaseAsync("schema-apply", async () => 11)).toBe(11);
	});
});
