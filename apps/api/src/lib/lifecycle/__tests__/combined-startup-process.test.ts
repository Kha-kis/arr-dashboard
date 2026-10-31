import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
	bindCombinedStartupLauncher,
	type CombinedStartupChannel,
	consumeCombinedStartupChannel,
	prepareCombinedStartupChannel,
	readCombinedStartupResult,
	readCombinedStartupStatus,
	removeCombinedStartupChannel,
} from "../combined-startup.js";

const launcher = fileURLToPath(new URL("../../../launcher.ts", import.meta.url)),
	loader = fileURLToPath(new URL("./fixtures/combined-startup-loader.mjs", import.meta.url));
type Actor = {
	child: ChildProcess;
	closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	result: { code: number | null; signal: NodeJS.Signals | null } | null;
	events: Array<{ event: string; pid?: number }>;
	context: CombinedStartupChannel;
	root: string;
};
const actors: Actor[] = [];
function start(mode = "normal"): Actor {
	const root = mkdtempSync(join(tmpdir(), "combined-ipc-test-")),
		context = prepareCombinedStartupChannel(root);
	const child = spawn(process.execPath, [launcher], {
		env: {
			PATH: process.env.PATH,
			NODE_ENV: "production",
			NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import=${loader}`,
			TEST_COMBINED_MODE: mode,
			TEST_CONTROL_DIR: root,
			ARR_COMBINED_STARTUP_DIR: context.directory,
			ARR_COMBINED_STARTUP_NONCE: context.nonce,
			ARR_COMBINED_STARTUP_DEVICE: context.device,
			ARR_COMBINED_STARTUP_INODE: context.inode,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const actor: Actor = {
		child,
		context,
		root,
		events: [],
		result: null,
		closed: Promise.resolve({ code: null, signal: null }),
	};
	let text = "";
	child.stdout!.on("data", (bytes) => {
		text += bytes;
		assert(text.length < 65536);
		const lines = text.split("\n");
		text = lines.pop()!;
		for (const line of lines) if (line.startsWith("{")) actor.events.push(JSON.parse(line));
	});
	child.stderr!.resume();
	actor.closed = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => {
			actor.result = { code, signal };
			resolve(actor.result);
		});
	});
	actors.push(actor);
	return actor;
}
async function until(actor: Actor, condition: () => boolean) {
	const end = performance.now() + 5000;
	while (!condition()) {
		assert.equal(actor.result, null, "actor exited before its expected generic state");
		assert(performance.now() < end, "bounded actor observation expired");
		await new Promise((done) => setTimeout(done, 10));
	}
}
function gone(actor: Actor) {
	for (const row of actor.events.filter((x) => x.event === "child")) {
		assert(typeof row.pid === "number");
		expect(() => process.kill(row.pid!, 0)).toThrow();
	}
}
afterEach(async () => {
	for (const actor of actors.splice(0)) {
		if (actor.result === null) actor.child.kill("SIGTERM");
		const timer = setTimeout(() => actor.child.kill("SIGKILL"), 2000);
		await actor.closed;
		clearTimeout(timer);
		gone(actor);
		if (existsSync(actor.context.directory)) removeCombinedStartupChannel(actor.context);
		for (const name of readdirSync(actor.root)) unlinkSync(join(actor.root, name));
		rmdirSync(actor.root);
	}
});
it("actual Node IPC publishes only after the current API listens and joins both processes on stop", async () => {
	const actor = start();
	await until(
		actor,
		() =>
			readCombinedStartupResult(actor.context) !== null &&
			actor.events.some((x) => x.event === "listening"),
	);
	assert(actor.child.pid);
	bindCombinedStartupLauncher(actor.context, actor.child.pid, process.pid);
	expect(readCombinedStartupStatus(actor.context)?.apiPort).toBe(3011);
	expect(actor.events.filter((x) => x.event === "native")).toHaveLength(1);
	expect(actor.events.filter((x) => x.event === "listening")).toHaveLength(1);
	actor.child.kill("SIGTERM");
	expect(await actor.closed).toEqual({ code: 0, signal: null });
	gone(actor);
});
it.each(["native-failure", "malformed"])(
	"real %s closes without readiness or orphan API children",
	async (mode) => {
		const actor = start(mode);
		const timer = setTimeout(() => actor.child.kill("SIGKILL"), 5000);
		expect(await actor.closed).toEqual({ code: 1, signal: null });
		clearTimeout(timer);
		expect(readCombinedStartupResult(actor.context)).toBeNull();
		expect(actor.events.filter((x) => x.event === "native")).toHaveLength(1);
		gone(actor);
	},
);
it("real code42 replacement revalidates and does not reuse its removed initial channel", async () => {
	const actor = start("restart-after-consumption");
	await until(actor, () => readCombinedStartupResult(actor.context) !== null);
	assert(actor.child.pid);
	bindCombinedStartupLauncher(actor.context, actor.child.pid, process.pid);
	expect(readCombinedStartupStatus(actor.context)?.apiPort).toBe(3011);
	consumeCombinedStartupChannel(actor.context);
	await until(actor, () => actor.events.filter((x) => x.event === "listening").length === 2);
	expect(actor.events.filter((x) => x.event === "native")).toHaveLength(2);
	expect(actor.events.filter((x) => x.event === "child")).toHaveLength(2);
	expect(existsSync(actor.context.directory)).toBe(false);
	actor.child.kill("SIGTERM");
	expect(await actor.closed).toEqual({ code: 0, signal: null });
	gone(actor);
});
it("a real termination while listen is pending publishes nothing and joins the API", async () => {
	const actor = start("wait");
	await until(actor, () => actor.events.some((x) => x.event === "waiting"));
	actor.child.kill("SIGTERM");
	expect(await actor.closed).toEqual({ code: 0, signal: null });
	expect(readCombinedStartupResult(actor.context)).toBeNull();
	gone(actor);
});
it("joins the real API child held in initialization before reporting a failed forced stop", async () => {
	const actor = start("held-native");
	await until(actor, () => actor.events.some((x) => x.event === "waiting-native"));
	actor.child.kill("SIGTERM");
	let expired = false;
	const timer = setTimeout(() => {
		expired = true;
		for (const event of actor.events.filter((x) => x.event === "child")) {
			if (event.pid && event.pid > 1) {
				try {
					process.kill(event.pid, "SIGKILL");
				} catch {}
			}
		}
		actor.child.kill("SIGKILL");
	}, 7500);
	const result = await actor.closed;
	clearTimeout(timer);
	expect(expired).toBe(false);
	expect(result).toEqual({ code: 1, signal: null });
	expect(readCombinedStartupResult(actor.context)).toBeNull();
	gone(actor);
}, 10000);
it("refuses the real first child's retired handoff instead of admitting a replacement before consumption", async () => {
	const actor = start("restart");
	const timer = setTimeout(() => actor.child.kill("SIGTERM"), 3000);
	const result = await actor.closed;
	clearTimeout(timer);
	expect(result).toEqual({ code: 1, signal: null });
	expect(actor.events.filter((x) => x.event === "native")).toHaveLength(1);
	expect(() => readCombinedStartupResult(actor.context)).toThrow();
	gone(actor);
});
it("invalidates real duplicate IPC readiness while the rejected child is still draining", async () => {
	const actor = start("duplicate");
	assert(actor.child.pid);
	bindCombinedStartupLauncher(actor.context, actor.child.pid, process.pid);
	await until(actor, () => actor.events.some((x) => x.event === "duplicate-sent"));
	await until(actor, () => {
		try {
			readCombinedStartupStatus(actor.context);
			return false;
		} catch {
			return true;
		}
	});
	expect(actor.result).toBeNull();
	expect(() => readCombinedStartupStatus(actor.context)).toThrow();
	const timer = setTimeout(() => actor.child.kill("SIGKILL"), 7000);
	expect(await actor.closed).toEqual({ code: 1, signal: null });
	clearTimeout(timer);
	gone(actor);
}, 10000);
