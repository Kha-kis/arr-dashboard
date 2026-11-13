import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	prepareCombinedStartupChannel,
	readCombinedStartupResult,
	removeCombinedStartupChannel,
	type CombinedStartupChannel,
} from "../combined-startup.js";

type Child = EventEmitter & { kill: (signal: string) => boolean; exitCode: number | null };
const boundary = vi.hoisted(() => ({
	children: [] as Child[],
	kills: [] as string[],
	captures: [] as Array<{
		stdio: unknown;
		phase: string | undefined;
		apiPort: string | undefined;
		webPort: string | undefined;
		host: string | undefined;
	}>,
}));
vi.mock("node:child_process", () => ({
	spawn: (
		_command: string,
		_args: string[],
		options: { stdio: unknown; env: Record<string, string | undefined> },
	) => {
		const child = new EventEmitter() as Child;
		child.exitCode = null;
		child.kill = (signal) => {
			boundary.kills.push(signal);
			return true;
		};
		boundary.children.push(child);
		boundary.captures.push({
			stdio: options.stdio,
			phase: options.env.ARR_COMBINED_STARTUP_PHASE,
			apiPort: options.env.API_PORT,
			webPort: options.env.PORT,
			host: options.env.HOST,
		});
		return child;
	},
}));
let directory: string, context: CombinedStartupChannel;
const signals = new Map<string, () => void>(),
	exits: unknown[] = [];
const current = () => boundary.children.at(-1)!;
function shutdownDiagnostics() {
	return vi.mocked(console.log).mock.calls.flatMap(([line]) => {
		if (typeof line !== "string") return [];
		try {
			const value = JSON.parse(line);
			return value.category === "launcher-shutdown-failure" ? [value] : [];
		} catch {
			return [];
		}
	});
}
const message = () => ({
	kind: "arr-combined-startup",
	version: 1,
	nonce: context.nonce,
	apiPort: 3011,
	webPort: 3010,
	listenAddress: "127.0.0.1",
});
async function boot() {
	await import("../../../launcher.js");
}
beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers();
	boundary.children.length = 0;
	boundary.kills.length = 0;
	boundary.captures.length = 0;
	signals.clear();
	exits.length = 0;
	directory = mkdtempSync(join(tmpdir(), "combined-launcher-test-"));
	context = prepareCombinedStartupChannel(directory);
	for (const [key, value] of Object.entries({
		NODE_ENV: "production",
		SHUTDOWN_GRACE: "6",
		ARR_COMBINED_STARTUP_DIR: context.directory,
		ARR_COMBINED_STARTUP_NONCE: context.nonce,
		ARR_COMBINED_STARTUP_DEVICE: context.device,
		ARR_COMBINED_STARTUP_INODE: context.inode,
	}))
		vi.stubEnv(key, value);
	vi.spyOn(process, "on").mockImplementation((event, callback) => {
		if (event === "SIGTERM" || event === "SIGINT") signals.set(event, callback as () => void);
		return process;
	});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		exits.push(code);
		return undefined as never;
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	if (existsSync(context.directory)) removeCombinedStartupChannel(context);
	rmdirSync(directory);
});

it("opens IPC and publishes only the current child's first validated handoff", async () => {
	await boot();
	expect(readCombinedStartupResult(context)).toBeNull();
	expect(boundary.captures[0]?.stdio).toEqual(["inherit", "inherit", "inherit", "ipc"]);
	expect(boundary.captures[0]?.phase).toBe("initial");
	current().emit("message", message());
	expect(readCombinedStartupResult(context)).toEqual(message());
	expect(boundary.kills).toEqual([]);
	expect(exits).toEqual([]);
});
it("rejects malformed and duplicate messages, then joins the child before failure exit", async () => {
	await boot();
	current().emit("message", { ...message(), privateField: "synthetic" });
	expect(boundary.kills).toEqual(["SIGTERM"]);
	expect(shutdownDiagnostics()).toEqual([
		{ category: "launcher-shutdown-failure", reason: "combined-handoff-rejected" },
	]);
	expect(exits).toEqual([]);
	expect(readCombinedStartupResult(context)).toBeNull();
	current().emit("exit", 0, null);
	expect(exits).toEqual([1]);
});
it("revokes a first result immediately when the same child sends twice, before child join", async () => {
	await boot();
	current().emit("message", message());
	current().emit("message", message());
	expect(() => readCombinedStartupResult(context)).toThrow();
	expect(boundary.kills).toEqual(["SIGTERM"]);
	expect(exits).toEqual([]);
	current().emit("exit", 0, null);
	expect(exits).toEqual([1]);
});
it("keeps captured bindings for a replacement and never republishes the old channel", async () => {
	await boot();
	const old = current();
	old.emit("message", message());
	removeCombinedStartupChannel(context);
	old.emit("exit", 42, null);
	await vi.advanceTimersByTimeAsync(1000);
	expect(boundary.captures[1]).toEqual({
		stdio: ["inherit", "inherit", "inherit", "ipc"],
		phase: "restart",
		apiPort: "3011",
		webPort: "3010",
		host: "127.0.0.1",
	});
	old.emit("message", { ...message(), apiPort: 9999 });
	current().emit("message", message());
	expect(boundary.kills).toEqual([]);
	expect(exits).toEqual([]);
	expect(existsSync(context.directory)).toBe(false);
});
it("refuses a replacement's binding mismatch rather than moving only the API", async () => {
	await boot();
	current().emit("message", message());
	removeCombinedStartupChannel(context);
	current().emit("exit", 42, null);
	await vi.advanceTimersByTimeAsync(1000);
	current().emit("message", { ...message(), apiPort: 9999 });
	expect(boundary.kills).toEqual(["SIGTERM"]);
	expect(exits).toEqual([]);
	current().emit("exit", 0, null);
	expect(exits).toEqual([1]);
});
it("revokes a publishing child that retires before its handoff is consumed", async () => {
	await boot();
	current().emit("message", message());
	current().emit("exit", 42, null);
	expect(() => readCombinedStartupResult(context)).toThrow();
	await vi.advanceTimersByTimeAsync(1000);
	expect(boundary.children).toHaveLength(1);
	expect(exits).toEqual([1]);
});
it("revokes a published result when intentional shutdown starts", async () => {
	await boot();
	current().emit("message", message());
	signals.get("SIGTERM")!();
	expect(() => readCombinedStartupResult(context)).toThrow();
	expect(exits).toEqual([]);
	current().emit("exit", 0, null);
	expect(exits).toEqual([0]);
});
it("escalates a stuck initializing API child and waits for its actual exit", async () => {
	await boot();
	signals.get("SIGTERM")!();
	await vi.advanceTimersByTimeAsync(5000);
	expect(boundary.kills).toEqual(["SIGTERM", "SIGKILL"]);
	expect(exits).toEqual([]);
	current().emit("exit", null, "SIGKILL");
	expect(exits).toEqual([1]);
});
it("does not retry an initial child that exits42 without a validated handoff", async () => {
	await boot();
	current().emit("exit", 42, null);
	await vi.advanceTimersByTimeAsync(2000);
	expect(boundary.children).toHaveLength(1);
	expect(exits).toEqual([1]);
});
it("bounds rejected-child termination without claiming exit before the actual child exit", async () => {
	await boot();
	current().emit("message", { ...message(), version: 2 });
	await vi.advanceTimersByTimeAsync(4999);
	expect(boundary.kills).toEqual(["SIGTERM"]);
	expect(exits).toEqual([]);
	await vi.advanceTimersByTimeAsync(1);
	expect(boundary.kills).toEqual(["SIGTERM", "SIGKILL"]);
	expect(exits).toEqual([]);
	current().emit("exit", null, "SIGKILL");
	expect(exits).toEqual([1]);
});
it("refuses a mismatched channel identity before spawning any API", async () => {
	vi.stubEnv("ARR_COMBINED_STARTUP_INODE", "0");
	await expect(boot()).rejects.toThrow();
	expect(boundary.children).toHaveLength(0);
});
it("does not publish after intentional shutdown and preserves a clean joined exit", async () => {
	await boot();
	signals.get("SIGTERM")!();
	current().emit("message", message());
	expect(readCombinedStartupResult(context)).toBeNull();
	expect(boundary.kills).toEqual(["SIGTERM"]);
	expect(exits).toEqual([]);
	current().emit("exit", 0, null);
	expect(exits).toEqual([0]);
});

it("identifies a post-ready drain held through escalation without exiting before child join", async () => {
	await boot();
	current().emit("message", message());
	expect(readCombinedStartupResult(context)).toEqual(message());
	signals.get("SIGTERM")!();
	await vi.advanceTimersByTimeAsync(4999);
	expect(boundary.kills).toEqual(["SIGTERM"]);
	expect(shutdownDiagnostics()).toEqual([]);
	expect(exits).toEqual([]);
	await vi.advanceTimersByTimeAsync(1);
	expect(boundary.kills).toEqual(["SIGTERM", "SIGKILL"]);
	expect(shutdownDiagnostics()).toEqual([
		{ category: "launcher-shutdown-failure", reason: "forced-child-termination" },
	]);
	expect(exits).toEqual([]);
	current().emit("exit", null, "SIGKILL");
	expect(exits).toEqual([1]);
	expect(boundary.children).toHaveLength(1);
});

it("keeps a post-ready drain clean when the child joins just before its deadline", async () => {
	await boot();
	current().emit("message", message());
	expect(readCombinedStartupResult(context)).toEqual(message());
	signals.get("SIGTERM")!();
	await vi.advanceTimersByTimeAsync(4999);
	current().emit("exit", 0, null);
	await vi.advanceTimersByTimeAsync(2000);
	expect(boundary.kills).toEqual(["SIGTERM"]);
	expect(exits).toEqual([0]);
	expect(shutdownDiagnostics()).toEqual([]);
	expect(boundary.children).toHaveLength(1);
});

it("identifies real handoff revocation failure even when the child joins cleanly", async () => {
	await boot();
	current().emit("message", message());
	expect(readCombinedStartupResult(context)).toEqual(message());
	chmodSync(context.directory, 0o755);
	try {
		signals.get("SIGTERM")!();
		expect(boundary.kills).toEqual(["SIGTERM"]);
		expect(exits).toEqual([]);
		expect(shutdownDiagnostics()).toEqual([
			{ category: "launcher-shutdown-failure", reason: "handoff-revocation-failed" },
		]);
		current().emit("exit", 0, null);
		expect(exits).toEqual([1]);
		expect(
			shutdownDiagnostics().every(
				(value) =>
					value.category === "launcher-shutdown-failure" &&
					value.reason === "handoff-revocation-failed" &&
					Object.keys(value).length === 2,
			),
		).toBe(true);
	} finally {
		chmodSync(context.directory, 0o700);
	}
});

it("still escalates and joins a held post-ready child when the diagnostic sink throws", async () => {
	await boot();
	current().emit("message", message());
	vi.mocked(console.log).mockImplementation(() => {
		throw new Error("Synthetic sink unavailable");
	});
	expect(() => signals.get("SIGTERM")!()).not.toThrow();
	await vi.advanceTimersByTimeAsync(5000);
	expect(boundary.kills).toEqual(["SIGTERM", "SIGKILL"]);
	expect(exits).toEqual([]);
	expect(() => current().emit("exit", null, "SIGKILL")).not.toThrow();
	expect(exits).toEqual([1]);
	expect(boundary.children).toHaveLength(1);
});

it.each(["revocation", "rejection"] as const)(
	"keeps handoff %s termination and failure authoritative when diagnostics throw",
	async (failure) => {
		await boot();
		current().emit("message", message());
		vi.mocked(console.log).mockImplementation(() => {
			throw new Error("Synthetic sink unavailable");
		});
		if (failure === "revocation") chmodSync(context.directory, 0o755);
		try {
			expect(() => {
				if (failure === "revocation") signals.get("SIGTERM")!();
				else current().emit("message", { privateField: "synthetic-private-input" });
			}).not.toThrow();
			expect(boundary.kills).toEqual(["SIGTERM"]);
			expect(exits).toEqual([]);
			expect(() => current().emit("exit", 0, null)).not.toThrow();
			expect(exits).toEqual([1]);
			expect(boundary.children).toHaveLength(1);
		} finally {
			if (failure === "revocation") chmodSync(context.directory, 0o700);
		}
	},
);
