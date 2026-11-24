import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
	it.each(["schema-plan", "date-plan", "foreign-key-check"] as const)(
		"reports entry to %s before the native call completes",
		async (phase) => {
			const { timeSqliteStartupPhase } = await import("../runtime-schema-timing.js");
			const start = {
				category: "sqlite-startup-phase",
				phase,
				outcome: "started",
				elapsedMs: 0,
			};
			expect(
				timeSqliteStartupPhase(phase, () => {
					expect(boundary.events).toEqual([start]);
					return [];
				}),
			).toEqual([]);
			expect(boundary.events).toEqual([
				start,
				{ ...start, outcome: "completed", elapsedMs: expect.any(Number) },
			]);
		},
	);

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
				outcome: "started",
				elapsedMs: 0,
			},
			{
				category: "sqlite-startup-phase",
				phase: "date-plan",
				outcome: "failed",
				elapsedMs: expect.any(Number),
				errorCategory: "unknown",
				code: null,
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
	it("reports an allowlisted filesystem code without exposing error text", async () => {
		const { timeSqliteStartupPhase } = await import("../runtime-schema-timing.js");
		const error = Object.assign(new Error("/private/config/media-name.sqlite"), { code: "EACCES" });
		let caught: unknown;
		try {
			timeSqliteStartupPhase("database-file", () => {
				throw error;
			});
		} catch (failure) {
			caught = failure;
		}
		expect(caught).toBe(error);
		expect(boundary.events.at(-1)).toEqual({
			category: "sqlite-startup-phase",
			phase: "database-file",
			outcome: "failed",
			elapsedMs: expect.any(Number),
			errorCategory: "filesystem",
			code: "EACCES",
		});
		expect(JSON.stringify(boundary.events)).not.toContain("/private/config/media-name.sqlite");
	});
	it("omits unknown and accessor-backed error codes", async () => {
		const { timeSqliteStartupPhase } = await import("../runtime-schema-timing.js");
		const error = Object.assign(new Error("private payload"), { code: "EACCES /secret" });
		try {
			timeSqliteStartupPhase("database-open", () => {
				throw error;
			});
		} catch {}
		expect(boundary.events.at(-1)).toMatchObject({ errorCategory: "unknown", code: null });
		boundary.events.length = 0;
		const hostile = new Error("hidden");
		Object.defineProperty(hostile, "code", { get: () => "EACCES" });
		try {
			timeSqliteStartupPhase("database-open", () => {
				throw hostile;
			});
		} catch {}
		expect(boundary.events.at(-1)).toMatchObject({ errorCategory: "unknown", code: null });
		expect(JSON.stringify(boundary.events)).not.toContain("private payload");
	});
	it("identifies an early missing-parent startup failure before catalog preflight", async () => {
		const { provisionSqliteRestoreRuntimeSchema } = await import(
			"../restore-runtime-sqlite-enrollment.js"
		);
		const parent = join(tmpdir(), "arr-sqlite-missing-" + randomUUID());
		await expect(
			provisionSqliteRestoreRuntimeSchema(
				pathToFileURL(join(parent, "app.db")).href,
				{
					runtimeEpoch: "00000000-0000-4000-8000-000000000001",
				},
				{
					preflight: () => ({}),
					apply: async () => {},
					finish: () => ({ apiPort: null, webPort: null, listenAddress: null }),
				},
			),
		).rejects.toMatchObject({ name: "RuntimeSchemaStartupError", category: "startup-unavailable" });
		expect(boundary.events).toEqual([
			{
				category: "sqlite-startup-phase",
				phase: "database-file",
				outcome: "failed",
				elapsedMs: expect.any(Number),
				errorCategory: "filesystem",
				code: "ENOENT",
			},
		]);
		expect(JSON.stringify(boundary.events)).not.toContain(parent);
	});
	it("classifies a packaged registry load failure before schema provisioning", async () => {
		vi.doMock("../runtime-schema-registry.js", async () => {
			const actual = await vi.importActual<typeof import("../runtime-schema-registry.js")>(
				"../runtime-schema-registry.js",
			);
			return {
				...actual,
				loadRuntimeSchemaRegistry: () => {
					throw new actual.RuntimeSchemaRegistryError();
				},
			};
		});
		try {
			const { synchronizeSqliteRuntimeSchema } = await import("../runtime-schema-sqlite.js");
			await expect(synchronizeSqliteRuntimeSchema("file:/unused.sqlite")).rejects.toMatchObject({
				name: "RuntimeSchemaRegistryError",
			});
			expect(boundary.events).toEqual([
				{
					category: "sqlite-startup-phase",
					phase: "schema-registry",
					outcome: "failed",
					elapsedMs: expect.any(Number),
					errorCategory: "schema",
					code: null,
				},
				{
					category: "sqlite-startup-phase",
					phase: "total",
					outcome: "failed",
					elapsedMs: expect.any(Number),
					errorCategory: "schema",
					code: null,
				},
			]);
		} finally {
			vi.doUnmock("../runtime-schema-registry.js");
		}
	});

	it("preserves selected exact SQLite extended codes and rejects prefix-like values", async () => {
		const { timeSqliteStartupPhase } = await import("../runtime-schema-timing.js");
		for (const [code, expected] of [
			["SQLITE_IOERR_FSTAT", "SQLITE_IOERR_FSTAT"],
			["SQLITE_IOERR_FSTAT_PRIVATE", null],
		] as const) {
			boundary.events.length = 0;
			const error = Object.assign(new Error("private"), { code });
			try {
				timeSqliteStartupPhase("database-open", () => {
					throw error;
				});
			} catch {}
			expect(boundary.events.at(-1)).toMatchObject({
				errorCategory: expected === null ? "unknown" : "database",
				code: expected,
			});
		}
	});
	it("classifies only the exact known storage identity and ownership errors", async () => {
		const { timeSqliteStartupPhase } = await import("../runtime-schema-timing.js");
		const { SqliteRestoreRuntimeEnrollmentError } = await import(
			"../restore-runtime-sqlite-enrollment.js"
		);
		const { SqliteRestoreRuntimeOwnershipError } = await import("../restore-runtime-sqlite.js");
		for (const [error, errorCategory] of [
			[new SqliteRestoreRuntimeEnrollmentError(), "storage-identity"],
			[new SqliteRestoreRuntimeOwnershipError(), "storage-ownership"],
		] as const) {
			boundary.events.length = 0;
			try {
				timeSqliteStartupPhase("storage-resolution", () => {
					throw error;
				});
			} catch {}
			expect(boundary.events.at(-1)).toMatchObject({ errorCategory, code: null });
		}
	});
});
