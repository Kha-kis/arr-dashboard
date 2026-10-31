import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import * as startup from "../combined-startup.js";

const interleave = vi.hoisted(() => ({
	afterUnlink: undefined as ((path: string) => void) | undefined,
}));
vi.mock("node:fs", async (original) => {
	const actual = await original<typeof import("node:fs")>();
	return {
		...actual,
		unlinkSync(path: Parameters<typeof actual.unlinkSync>[0]) {
			actual.unlinkSync(path);
			interleave.afterUnlink?.(String(path));
		},
	};
});

const roots: string[] = [],
	children: Array<{ child: ChildProcess; closed: Promise<unknown> }> = [];
function context() {
	const root = mkdtempSync(join(tmpdir(), "combined-status-test-"));
	roots.push(root);
	return startup.prepareCombinedStartupChannel(root);
}
function implementation() {
	assert.equal(typeof startup.bindCombinedStartupLauncher, "function");
	assert.equal(typeof startup.readCombinedStartupStatus, "function");
	return startup;
}
async function actor() {
	const child = spawn(
		process.execPath,
		[
			"-e",
			"process.on('SIGTERM',()=>process.exit(0));process.stdout.write('ready');setInterval(()=>{},1000)",
		],
		{ env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] },
	);
	const closed = new Promise((resolve) =>
		child.once("close", (code, signal) => resolve({ code, signal })),
	);
	children.push({ child, closed });
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.stdout!.once("data", () => resolve());
	});
	assert(child.pid);
	return { child, closed, pid: child.pid };
}
const message = (nonce: string) => ({
	kind: "arr-combined-startup",
	version: 1,
	nonce,
	apiPort: 3011,
	webPort: 3010,
	listenAddress: "127.0.0.1",
});
afterEach(async () => {
	interleave.afterUnlink = undefined;
	vi.restoreAllMocks();
	for (const { child, closed } of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
		await closed;
		clearTimeout(timer);
		expect(() => process.kill(child.pid!, 0)).toThrow();
	}
	for (const root of roots.splice(0)) {
		for (const name of readdirSync(root)) {
			const path = join(root, name);
			for (const file of readdirSync(path)) unlinkSync(join(path, file));
			rmdirSync(path);
		}
		rmdirSync(root);
	}
});

it("requires a live birth-bound launcher as well as its current result", async () => {
	const api = implementation(),
		c = context(),
		a = await actor();
	api.bindCombinedStartupLauncher(c, a.pid, process.pid);
	expect(api.readCombinedStartupStatus(c)).toBeNull();
	startup.publishCombinedStartupResult(c, message(c.nonce));
	expect(api.readCombinedStartupStatus(c)).toEqual(message(c.nonce));
	startup.removeCombinedStartupChannel(c);
	expect(existsSync(c.directory)).toBe(false);
});
it("refuses a wrong supervisor or an attempt to replace the initial launcher binding", async () => {
	const api = implementation(),
		c = context(),
		a = await actor();
	expect(() => api.bindCombinedStartupLauncher(c, a.pid, process.pid + 100000)).toThrow();
	expect(existsSync(join(c.directory, "launcher.json"))).toBe(false);
	api.bindCombinedStartupLauncher(c, a.pid, process.pid);
	expect(() => api.bindCombinedStartupLauncher(c, a.pid, process.pid)).toThrow();
});
it("refuses a changed birth identity even if the numeric PID is live", async () => {
	const api = implementation(),
		c = context(),
		a = await actor();
	api.bindCombinedStartupLauncher(c, a.pid, process.pid);
	const binding = JSON.parse(readFileSync(join(c.directory, "launcher.json"), "utf8"));
	binding.startTicks = "0";
	writeFileSync(join(c.directory, "launcher.json"), JSON.stringify(binding));
	expect(() => api.readCombinedStartupStatus(c)).toThrow();
});
it("does not accept a published result after the bound launcher exits", async () => {
	const api = implementation(),
		c = context(),
		a = await actor();
	api.bindCombinedStartupLauncher(c, a.pid, process.pid);
	startup.publishCombinedStartupResult(c, message(c.nonce));
	a.child.kill("SIGTERM");
	await a.closed;
	expect(() => api.readCombinedStartupStatus(c)).toThrow();
});
it("enforces the exact600-second monotonic deadline without a ten-minute test wait", async () => {
	const api = implementation(),
		c = context(),
		a = await actor();
	api.bindCombinedStartupLauncher(c, a.pid, process.pid);
	const request = JSON.parse(readFileSync(join(c.directory, "request.json"), "utf8"));
	const clock = vi.spyOn(process.hrtime, "bigint");
	clock.mockReturnValue(BigInt(request.startedAtNs) + 599_999_999_999n);
	expect(api.readCombinedStartupStatus(c)).toBeNull();
	clock.mockReturnValue(BigInt(request.startedAtNs) + 600_000_000_000n);
	expect(() => api.readCombinedStartupStatus(c)).toThrow();
	clock.mockRestore();
});

const apiRoot = fileURLToPath(new URL("../../../../", import.meta.url)),
	cli = join(apiRoot, "src/combined-startup.ts");
function runCli(args: string[], c?: startup.CombinedStartupChannel) {
	assert(existsSync(cli), "combined startup CLI is not implemented");
	const env = {
		PATH: process.env.PATH,
		HOME: "/tmp/home",
		TMPDIR: "/tmp",
		...(c
			? {
					ARR_COMBINED_STARTUP_DIR: c.directory,
					ARR_COMBINED_STARTUP_NONCE: c.nonce,
					ARR_COMBINED_STARTUP_DEVICE: c.device,
					ARR_COMBINED_STARTUP_INODE: c.inode,
				}
			: {}),
	};
	const r = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
		cwd: apiRoot,
		env,
		encoding: "utf8",
		timeout: 3000,
		maxBuffer: 65536,
	});
	expect(r.error).toBeUndefined();
	expect(r.signal).toBeNull();
	return r;
}
it("CLI returns pending separately from refusal and emits only validated fields", async () => {
	const api = implementation(),
		c = context(),
		a = await actor();
	expect(runCli(["bind", String(a.pid), String(process.pid)], c).status).toBe(0);
	const pending = runCli(["read"], c);
	expect(pending.status).toBe(2);
	expect(pending.stdout).toBe("");
	expect(pending.stderr).toBe("");
	api.publishCombinedStartupResult(c, message(c.nonce));
	const ready = runCli(["read"], c);
	expect(ready.status).toBe(0);
	expect(ready.stdout).toBe("3011\t3010\t127.0.0.1\n");
	expect(ready.stderr).toBe("");
	expect(runCli(["cleanup"], c).status).toBe(0);
	expect(existsSync(c.directory)).toBe(false);
});
it("CLI refuses unknown/extra arguments without returning private input", () => {
	for (const args of [
		["unknown", "synthetic-private"],
		["prepare", "extra"],
	]) {
		const r = runCli(args);
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("Combined startup handoff is unavailable.\n");
	}
});
it("CLI refuses both reading and consuming revoked readiness while its launcher is still live", async () => {
	const c = context(),
		a = await actor();
	startup.bindCombinedStartupLauncher(c, a.pid, process.pid);
	startup.publishCombinedStartupResult(c, message(c.nonce));
	expect(startup.readCombinedStartupStatus(c)).toEqual(message(c.nonce));
	expect(startup.revokeCombinedStartupResult(c)).toBe(false);
	for (const command of ["read", "consume"]) {
		const refused = runCli([command], c);
		expect(refused.status).toBe(1);
		expect(refused.stdout).toBe("");
		expect(refused.stderr).toBe("Combined startup handoff is unavailable.\n");
		expect(existsSync(c.directory)).toBe(true);
	}
	expect(runCli(["cleanup"], c).status).toBe(0);
	expect(existsSync(c.directory)).toBe(false);
});
it("revokes readiness even after consumption removed request metadata but before directory removal", async () => {
	const c = context(),
		a = await actor();
	startup.bindCombinedStartupLauncher(c, a.pid, process.pid);
	startup.publishCombinedStartupResult(c, message(c.nonce));
	let reached = false,
		revoked = false;
	interleave.afterUnlink = (path) => {
		if (path !== join(c.directory, "request.json")) return;
		reached = true;
		try {
			startup.revokeCombinedStartupResult(c);
			revoked = true;
		} catch {
			/* Same failed revocation path as launcher. */
		}
	};
	expect(() => startup.consumeCombinedStartupChannel(c)).toThrow();
	expect(reached).toBe(true);
	expect(revoked).toBe(true);
	expect(existsSync(c.directory)).toBe(true);
	expect(existsSync(join(c.directory, "revoked.json"))).toBe(true);
});
