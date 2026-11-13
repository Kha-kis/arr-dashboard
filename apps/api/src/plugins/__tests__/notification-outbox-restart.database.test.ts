import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { synchronizeRuntimeSchema } from "../../lib/backup/runtime-schema-startup.js";

const require = createRequire(import.meta.url);
const actorPath = fileURLToPath(
	new URL("./fixtures/notification-outbox-restart-actor.ts", import.meta.url),
);
type Snapshot = {
	sends: number;
	titles: string[];
	digestCounts: (number | null)[];
	deliveries: { state: string; ordinal: number; dueAt: string; hasToken: boolean }[];
	events: { stage: string; dueAt: string }[];
	logs: string[];
	channels: number;
	subscriptions: number;
	encryptedConfigRoundTrip: boolean;
	blockedNetworkCalls: number;
};
type ActorMessage = { state: string; snapshot?: Snapshot; category?: string };
type Terminal = { code: number | null; signal: NodeJS.Signals | null };
const owned = new Set<{ child: ChildProcess; joined: Promise<Terminal> }>();
function launch(directory: string, phase: string, mode: string, now: Date) {
	const child = spawn(
		process.execPath,
		[
			"--import",
			require.resolve("tsx"),
			actorPath,
			phase,
			mode,
			join(directory, "owned.db"),
			now.toISOString(),
		],
		{
			cwd: process.cwd(),
			env: {
				PATH: process.env.PATH,
				NODE_ENV: "test",
				DOTENV_CONFIG_PATH: "/dev/null",
				CI: "true",
				TZ: "UTC",
				LOG_DIR: join(directory, "logs"),
				LOG_LEVEL: "error",
			},
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		},
	);
	let stderr = "";
	child.stderr!.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	let terminal: Terminal | undefined;
	let spawnError = false;
	const messages: ActorMessage[] = [];
	const listeners = new Set<() => void>();
	child.on("message", (value: ActorMessage) => {
		messages.push(value);
		for (const wake of listeners) wake();
	});
	child.once("error", () => {
		spawnError = true;
		for (const wake of listeners) wake();
	});
	const joined = new Promise<Terminal>((resolve) =>
		child.once("close", (code, signal) => {
			terminal = { code, signal };
			owned.delete(entry);
			for (const wake of listeners) wake();
			resolve(terminal);
		}),
	);
	const entry = { child, joined };
	owned.add(entry);
	function wait(state: string): Promise<Snapshot> {
		return new Promise((resolve, reject) => {
			const finish = () => {
				clearTimeout(timer);
				listeners.delete(check);
			};
			const check = () => {
				const failure = messages.find((item) => item.state === "ACTOR_ERROR");
				const match = messages.find((item) => item.state === state);
				if (failure || spawnError) {
					finish();
					reject(new Error(`Synthetic actor failed: ${failure?.category ?? "spawn"}\n${stderr}`));
				} else if (match?.snapshot) {
					finish();
					resolve(match.snapshot);
				} else if (terminal) {
					finish();
					reject(new Error(`Synthetic actor closed before ${state}\n${stderr}`));
				}
			};
			const timer = setTimeout(() => {
				finish();
				reject(new Error(`Synthetic actor observation expired: ${state}\n${stderr}`));
			}, 30_000);
			listeners.add(check);
			check();
		});
	}
	function kill() {
		assert.ok(owned.has(entry) && child.exitCode === null && child.signalCode === null);
		assert.ok(child.spawnargs.includes(actorPath));
		assert.equal(child.kill("SIGKILL"), true);
	}
	async function send(value: object) {
		await new Promise<void>((resolve, reject) =>
			child.send(value, (error) => (error ? reject(error) : resolve())),
		);
	}
	return {
		child,
		joined,
		wait,
		send,
		kill,
		evidence: () => ({ pid: child.pid, terminal, messages, stderr }),
	};
}

describe("actual notification process restart on the same owned native SQLite database", () => {
	afterEach(async () => {
		for (const entry of owned)
			if (entry.child.exitCode === null && entry.child.signalCode === null)
				entry.child.kill("SIGKILL");
		await Promise.all([...owned].map((entry) => entry.joined));
		expect(owned.size).toBe(0);
	});
	const matrix = [
		["immediate", "graceful"],
		["aggregation", "graceful"],
		["retry", "graceful"],
		["quiet-hours", "graceful"],
		["aggregation", "abrupt"],
		["retry", "abrupt"],
		["quiet-hours", "abrupt"],
		["before-marker", "abrupt"],
		["in-flight", "abrupt"],
		["ack-write-fault", "abrupt"],
	] as const;
	it.each(matrix)(
		"%s accepted work survives %s termination without false delivery or blind replay",
		async (mode, termination) => {
			const directory = await mkdtemp(join(tmpdir(), "arr-outbox-process-"));
			await chmod(directory, 0o700);
			const database = join(directory, "owned.db");
			new Database(database).close();
			await chmod(database, 0o600);
			await synchronizeRuntimeSchema(`file:${database}`);
			const identity = await stat(database);
			const now = new Date();
			const original = launch(directory, "admit", mode, now);
			const accepted = await original.wait("ACCEPTED");
			expect(accepted.blockedNetworkCalls).toBe(0);
			expect(accepted.channels).toBe(1);
			expect(accepted.subscriptions).toBe(1);
			expect(accepted.encryptedConfigRoundTrip).toBe(true);
			if (mode === "aggregation") {
				expect(accepted.sends).toBe(0);
				expect(accepted.events.map((item) => item.stage)).toEqual(["aggregating", "aggregating"]);
			} else if (mode === "quiet-hours") {
				expect(accepted.sends).toBe(0);
				expect(accepted.events[0]?.stage).toBe("deferred");
			} else if (mode === "retry") {
				expect(accepted.sends).toBe(1);
				expect(accepted.deliveries[0]).toMatchObject({
					state: "retry-waiting",
					ordinal: 1,
					hasToken: false,
				});
			} else if (mode === "in-flight" || mode === "ack-write-fault") {
				expect(accepted.sends).toBe(1);
				expect(accepted.logs).toEqual([]);
				expect(accepted.deliveries[0]).toMatchObject({
					state: "submitting",
					ordinal: 0,
					hasToken: true,
				});
			} else if (mode === "before-marker") {
				expect(accepted.sends).toBe(0);
				expect(accepted.deliveries[0]).toMatchObject({ state: "ready", hasToken: false });
			} else expect(accepted.logs).toEqual(["sent"]);
			if (termination === "abrupt") original.kill();
			else {
				await original.send({ action: "graceful" });
				await original.wait("DRAINED");
			}
			expect(await original.joined).toEqual(
				termination === "abrupt" ? { code: null, signal: "SIGKILL" } : { code: 0, signal: null },
			);
			const timed = mode === "aggregation" || mode === "quiet-hours" || mode === "retry";
			const due = new Date(
				mode === "retry" ? accepted.deliveries[0]!.dueAt : accepted.events[0]!.dueAt,
			);
			if (timed) expect(due.getTime()).toBeGreaterThan(now.getTime());
			const replacement = launch(
				directory,
				"restart",
				mode,
				timed ? new Date(due.getTime() - 1) : now,
			);
			const restarted = await replacement.wait("RESTARTED");
			if (mode !== "before-marker") expect(restarted.sends).toBe(0);
			if (timed) {
				expect(restarted.deliveries.map((item) => item.dueAt)).toEqual(
					accepted.deliveries.map((item) => item.dueAt),
				);
				if (mode === "retry") expect(restarted.deliveries[0]?.ordinal).toBe(1);
			}
			await replacement.send({ action: "advance", now: (timed ? due : now).toISOString() });
			const recovered = await replacement.wait("RECOVERED");
			if (mode === "in-flight" || mode === "ack-write-fault") {
				expect(recovered.sends).toBe(0);
				expect(recovered.logs).toEqual([]);
				expect(recovered.deliveries[0]).toMatchObject({ state: "uncertain", ordinal: 0 });
			} else if (mode === "immediate") {
				expect(recovered.sends).toBe(0);
				expect(recovered.logs).toEqual(["sent"]);
			} else {
				expect(recovered.sends).toBe(1);
				expect(recovered.deliveries.filter((item) => item.state === "sent")).toHaveLength(1);
				if (mode === "aggregation") {
					expect(recovered.digestCounts).toEqual([2]);
					expect(recovered.events.filter((item) => item.stage === "grouped")).toHaveLength(2);
				} else expect(recovered.titles).toEqual(["Synthetic accepted event"]);
				if (mode === "retry") expect(recovered.deliveries[0]?.ordinal).toBe(1);
			}
			const control = await replacement.wait("CONTROL");
			expect(control.sends).toBe(recovered.sends + 1);
			expect(control.titles.at(-1)).toBe("Synthetic independent control");
			expect(control.logs.filter((status) => status === "sent")).toHaveLength(
				recovered.logs.filter((status) => status === "sent").length + 1,
			);
			expect(control.encryptedConfigRoundTrip).toBe(true);
			expect(control.subscriptions).toBe(1);
			expect(control.blockedNetworkCalls).toBe(0);
			expect(await replacement.joined).toEqual({ code: 0, signal: null });
			const after = await stat(database);
			expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: identity.dev, ino: identity.ino });
			await writeFile(
				join(directory, "process-receipt.json"),
				JSON.stringify(
					{
						mode,
						termination,
						samePhysicalDatabase: true,
						original: original.evidence(),
						replacement: replacement.evidence(),
						allChildrenJoined: true,
						externalNetworkCalls: control.blockedNetworkCalls,
					},
					null,
					2,
				),
				{ mode: 0o600, flag: "wx" },
			);
			process.stdout.write(
				`${JSON.stringify({ notificationRestartEvidence: directory, case: `${mode}-${termination}` })}\n`,
			);
		},
		60_000,
	);
});
