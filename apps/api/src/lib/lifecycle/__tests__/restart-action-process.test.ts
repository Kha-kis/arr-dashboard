import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const launcher = fileURLToPath(new URL("../../../launcher.ts", import.meta.url));
const loader = fileURLToPath(new URL("./fixtures/restart-action-loader.mjs", import.meta.url));
const eventNames = [
	"child",
	"ready",
	"acknowledged",
	"close-entered",
	"close-released",
	"child-exit",
];
type Event = { event: string; pid: number; code?: number };
type Result = { code: number | null; signal: NodeJS.Signals | null };
type Actor = {
	child: ChildProcess;
	closed: Promise<Result>;
	result: Result | null;
	failure: Error | null;
	events: Event[];
	root: string;
};
const actors: Actor[] = [];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function start(): Actor {
	const root = mkdtempSync(join(tmpdir(), "restart-action-process-"));
	chmodSync(root, 0o700);
	const child = spawn(process.execPath, [launcher], {
		detached: process.platform !== "win32",
		env: {
			PATH: dirname(process.execPath),
			NODE_ENV: "production",
			NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import=${loader}`,
			TEST_RESTART_ACTION_DIR: root,
			SHUTDOWN_GRACE: "5",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const actor: Actor = {
		child,
		root,
		events: [],
		failure: null,
		result: null,
		closed: Promise.resolve({ code: null, signal: null }),
	};
	actors.push(actor);
	let pending = "";
	let bytes = 0;
	child.stdout!.on("data", (chunk) => {
		bytes += chunk.length;
		if (bytes > 65536) {
			actor.failure = new Error("Synthetic actor output exceeded its bound");
			return;
		}
		pending += chunk;
		const lines = pending.split("\n");
		pending = lines.pop()!;
		for (const line of lines) {
			if (!line.startsWith("{")) continue; // Fixed real launcher text is not fixture evidence.
			try {
				const row = JSON.parse(line);
				assert(eventNames.includes(row.event));
				assert(Number.isSafeInteger(row.pid) && row.pid > 1);
				assert.deepEqual(
					Object.keys(row).sort(),
					row.event === "child-exit" ? ["code", "event", "pid"] : ["event", "pid"],
				);
				if (row.event === "child-exit") assert(Number.isInteger(row.code));
				actor.events.push(row);
			} catch {
				actor.failure = new Error("Synthetic actor emitted an unexpected event shape");
			}
		}
	});
	child.stderr!.resume();
	child.once("error", () => {
		actor.failure = new Error("Synthetic launcher could not start");
	});
	actor.closed = new Promise((resolve) => {
		child.once("close", (code, signal) => {
			actor.result = { code, signal };
			resolve(actor.result);
		});
	});
	return actor;
}

function rows(actor: Actor, event: string, pid?: number) {
	return actor.events.filter(
		(row) => row.event === event && (pid === undefined || row.pid === pid),
	);
}
function release(actor: Actor, name: string) {
	writeFileSync(join(actor.root, name), "", { mode: 0o600 });
}
function gone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
		return true;
	}
}
async function until(actor: Actor, condition: () => boolean, timeout = 8000) {
	const deadline = performance.now() + timeout;
	while (!condition()) {
		assert.equal(actor.failure, null, "actor protocol failed");
		assert.equal(actor.result, null, "launcher exited before the expected state");
		assert(performance.now() < deadline, "bounded actor observation expired");
		await delay(10);
	}
	assert.equal(actor.failure, null, "actor protocol failed");
}
async function hold(actor: Actor, check: () => void, duration: number) {
	const deadline = performance.now() + duration;
	do {
		assert.equal(actor.failure, null);
		assert.equal(actor.result, null);
		check();
		await delay(10);
	} while (performance.now() < deadline);
	check();
}
async function joined(actor: Actor, timeout: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			actor.closed,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("bounded launcher join expired")), timeout);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

afterEach(async () => {
	for (const actor of actors.splice(0)) {
		release(actor, "release-initial-close");
		release(actor, "release-replacement-close");
		if (actor.result === null) actor.child.kill("SIGTERM");
		let forced = false;
		const timer = setTimeout(() => {
			forced = true;
			if (process.platform !== "win32" && actor.child.pid) {
				try {
					process.kill(-actor.child.pid, "SIGKILL");
				} catch (error) {
					assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
				}
			} else {
				for (const row of rows(actor, "child")) {
					if (!gone(row.pid)) process.kill(row.pid, "SIGKILL");
				}
				actor.child.kill("SIGKILL");
			}
		}, 6000);
		try {
			await joined(actor, 8000);
		} finally {
			clearTimeout(timer);
			for (const name of readdirSync(actor.root)) unlinkSync(join(actor.root, name));
			rmdirSync(actor.root);
		}
		for (const row of rows(actor, "child")) expect(gone(row.pid)).toBe(true);
		assert(actor.child.pid);
		expect(gone(actor.child.pid)).toBe(true);
		expect(forced, "emergency cleanup is never successful restart evidence").toBe(false);
	}
});

it("real restart POST waits for cleanup, exits 42, readies one replacement and joins terminal stop", async () => {
	const actor = start();
	await until(actor, () => rows(actor, "ready").length === 1);
	const initial = rows(actor, "ready")[0]!.pid;
	expect(rows(actor, "child").map((row) => row.pid)).toEqual([initial]);
	release(actor, "request-restart");
	await until(actor, () => rows(actor, "acknowledged", initial).length === 1);
	await until(actor, () => rows(actor, "close-entered", initial).length === 1);
	// Observe beyond the launcher's real 1s replacement delay while cleanup is held.
	await hold(
		actor,
		() => {
			expect(rows(actor, "child")).toHaveLength(1);
			expect(rows(actor, "ready")).toHaveLength(1);
			expect(rows(actor, "child-exit")).toHaveLength(0);
			expect(rows(actor, "close-released")).toHaveLength(0);
			expect(gone(initial)).toBe(false);
		},
		1200,
	);
	release(actor, "release-initial-close");
	await until(actor, () => rows(actor, "ready").length === 2);
	const replacement = rows(actor, "ready")[1]!.pid;
	expect(replacement).not.toBe(initial);
	expect(gone(initial)).toBe(true);
	expect(rows(actor, "child").map((row) => row.pid)).toEqual([initial, replacement]);
	expect(rows(actor, "child-exit")).toEqual([{ event: "child-exit", pid: initial, code: 42 }]);
	const sequence = actor.events.map((row) => row.event);
	expect(sequence).toEqual([
		"child",
		"ready",
		"acknowledged",
		"close-entered",
		"close-released",
		"child-exit",
		"child",
		"ready",
	]);
	// A terminal stop must also join actual replacement cleanup, rather than exit early.
	expect(actor.child.kill("SIGTERM")).toBe(true);
	await until(actor, () => rows(actor, "close-entered", replacement).length === 1);
	await hold(
		actor,
		() => {
			expect(gone(replacement)).toBe(false);
			expect(rows(actor, "child")).toHaveLength(2);
			expect(rows(actor, "child-exit")).toHaveLength(1);
		},
		200,
	);
	release(actor, "release-replacement-close");
	expect(await joined(actor, 5000)).toEqual({ code: 0, signal: null });
	expect(rows(actor, "child")).toHaveLength(2);
	expect(rows(actor, "ready")).toHaveLength(2);
	expect(rows(actor, "acknowledged")).toHaveLength(1);
	expect(rows(actor, "close-released").map((row) => row.pid)).toEqual([initial, replacement]);
	expect(rows(actor, "child-exit")).toEqual([
		{ event: "child-exit", pid: initial, code: 42 },
		{ event: "child-exit", pid: replacement, code: 0 },
	]);
	expect(gone(initial)).toBe(true);
	expect(gone(replacement)).toBe(true);
	assert(actor.child.pid);
	expect(gone(actor.child.pid)).toBe(true);
}, 20000);
