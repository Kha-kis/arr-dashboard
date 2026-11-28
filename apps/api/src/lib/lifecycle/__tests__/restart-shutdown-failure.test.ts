import { spawnSync } from "node:child_process";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import lifecyclePlugin from "../../../plugins/lifecycle.js";

const childProcess = vi.hoisted(() => ({ spawn: vi.fn(), unref: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	// Capture only allowlisted restart fields. A failed assertion must never
	// serialize the inherited environment (which can contain credentials).
	spawn: (
		command: string,
		args: string[],
		options: { detached: boolean; stdio: string[]; env: { PROCESS_RESTARTED?: string } },
	) =>
		childProcess.spawn({
			command,
			args,
			detached: options.detached,
			stdio: options.stdio,
			restartMarker: options.env.PROCESS_RESTARTED,
		}),
}));

const modes = [
	{
		name: "production self-spawn",
		environment: "production",
		launcher: "false",
		exit: 0,
		spawns: 1,
	},
	{ name: "production launcher", environment: "production", launcher: "true", exit: 42, spawns: 0 },
	{
		name: "development launcher",
		environment: "development",
		launcher: "true",
		exit: 42,
		spawns: 0,
	},
	{
		name: "development without launcher",
		environment: "development",
		launcher: "false",
		exit: null,
		spawns: 0,
	},
];

let app: FastifyInstance | undefined;
let exitCodes: Array<string | number | null | undefined> = [];
let releaseGates: Array<() => void> = [];

beforeEach(() => {
	vi.useFakeTimers();
	exitCodes = [];
	releaseGates = [];
	childProcess.unref.mockReset();
	childProcess.spawn.mockReset().mockReturnValue({ pid: 12345, unref: childProcess.unref });
	// Termination and spawning are the only external boundaries mocked. Fastify,
	// the registered lifecycle plugin, and the full restart flow remain real.
	vi.spyOn(process, "exit").mockImplementation((code) => {
		exitCodes.push(code);
		return undefined as never;
	});
});

afterEach(async () => {
	for (const release of releaseGates) release();
	await vi.advanceTimersByTimeAsync(0);
	await app?.close().catch(() => undefined);
	app = undefined;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

async function boot(environment: string, launcher: string, closeHook: () => Promise<void>) {
	vi.stubEnv("NODE_ENV", environment);
	vi.stubEnv("LAUNCHER_MANAGED", launcher);
	app = Fastify({ logger: false });
	await app.register(lifecyclePlugin);
	app.addHook("onClose", closeHook);
	await app.ready();
	return app;
}

describe.each(modes)("restart shutdown failure: $name", (mode) => {
	it.each([new Error("Synthetic close failure"), "synthetic non-Error rejection"])(
		"fails closed on a close rejection instead of signaling or spawning a replacement (%s)",
		async (failure) => {
			let closeInvocations = 0;
			const server = await boot(mode.environment, mode.launcher, async () => {
				closeInvocations++;
				throw failure;
			});
			await server.lifecycle.restart("synthetic-test");
			await vi.advanceTimersByTimeAsync(1500);
			expect(closeInvocations).toBe(1);
			expect(childProcess.spawn).not.toHaveBeenCalled();
			expect(exitCodes).toEqual([1]);
		},
	);

	it("preserves the successful mode only after its close hook settles", async () => {
		let release!: () => void;
		let cleanupCompleted = false;
		const cleanup = new Promise<void>((resolve) => {
			release = resolve;
		});
		releaseGates.push(release);
		const server = await boot(mode.environment, mode.launcher, async () => {
			await cleanup;
			cleanupCompleted = true;
		});
		await server.lifecycle.restart("synthetic-test");
		await vi.advanceTimersByTimeAsync(1500);
		expect(cleanupCompleted).toBe(false);
		expect(childProcess.spawn).not.toHaveBeenCalled();
		expect(exitCodes).toEqual([]);
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(cleanupCompleted).toBe(true);
		expect(childProcess.spawn).toHaveBeenCalledTimes(mode.spawns);
		expect(exitCodes).toEqual(mode.exit === null ? [] : [mode.exit]);
		if (mode.spawns > 0) {
			expect(childProcess.spawn).toHaveBeenCalledWith({
				command: process.argv[0],
				args: process.argv.slice(1),
				detached: true,
				stdio: ["ignore", "ignore", "ignore"],
				restartMarker: "true",
			});
			expect(childProcess.unref).toHaveBeenCalledTimes(1);
		}
	});
});

it("acknowledges only a newly scheduled restart, not a duplicate or terminally superseded request", async () => {
	let closes = 0;
	const server = await boot("production", "true", async () => {
		closes++;
	});
	await expect(server.lifecycle.restart("first-request")).resolves.toBe(true);
	await expect(server.lifecycle.restart("duplicate-request")).resolves.toBe(false);
	await server.lifecycle.shutdown();
	await expect(server.lifecycle.restart("terminally-superseded")).resolves.toBe(false);
	await vi.advanceTimersByTimeAsync(1500);
	expect(closes).toBe(1);
	expect(exitCodes).toEqual([]);
	expect(childProcess.spawn).not.toHaveBeenCalled();
});

it("ignores a duplicate restart request while failed cleanup is still pending", async () => {
	let reject!: (failure: Error) => void;
	let closeInvocations = 0;
	const cleanup = new Promise<void>((_resolve, rej) => {
		reject = rej;
	});
	releaseGates.push(() => reject(new Error("Synthetic cleanup failure")));
	const server = await boot("production", "true", async () => {
		closeInvocations++;
		await cleanup;
	});
	await server.lifecycle.restart("first-request");
	await server.lifecycle.restart("duplicate-request");
	await vi.advanceTimersByTimeAsync(1500);
	expect(closeInvocations).toBe(1);
	expect(exitCodes).toEqual([]);
	reject(new Error("Synthetic cleanup failure"));
	await vi.advanceTimersByTimeAsync(0);
	await server.lifecycle.restart("late-duplicate-request");
	await vi.advanceTimersByTimeAsync(1500);
	expect(closeInvocations).toBe(1);
	expect(childProcess.spawn).not.toHaveBeenCalled();
	expect(exitCodes).toEqual([1]);
});

it.each(["production", "development"])(
	"really exits unsuccessfully after a rejected close in launcher-managed %s",
	(environment) => {
		const source = new URL("../lifecycle-service.ts", import.meta.url).href;
		const fastify = import.meta.resolve("fastify");
		// Minimal child environment: no inherited credentials or application config.
		// This is a synthetic Fastify instance, not the application entrypoint.
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				import.meta.resolve("tsx/esm"),
				"--input-type=module",
				"--eval",
				`
					import childProcess from "node:child_process";
					import { syncBuiltinESMExports } from "node:module";
					childProcess.spawn = () => {
						process.stdout.write("unexpected-spawn");
						throw new Error("Fixture forbids replacement spawning");
					};
					syncBuiltinESMExports();
					const { default: Fastify } = await import(${JSON.stringify(fastify)});
					const { LifecycleService } = await import(${JSON.stringify(source)});
					const server = Fastify({ logger: false });
					server.addHook("onClose", async () => {
						throw new Error("Synthetic close failure");
					});
					await server.ready();
					await new LifecycleService(server).restart("synthetic-child-test");
				`,
			],
			{
				env: { NODE_ENV: environment, LAUNCHER_MANAGED: "true" },
				encoding: "utf8",
				timeout: 8000,
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect(result.status).toBe(1);
	},
	10_000,
);
