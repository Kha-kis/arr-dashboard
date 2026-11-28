import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";
import { Writable } from "node:stream";
import Fastify from "fastify";
import fastifyPlugin from "fastify-plugin";
import { RestoreRuntimeAdmissionError } from "../../../lib/backup/restore-runtime-admission.js";
import { JOB_ID } from "../../../lib/scheduler-registry/job-definitions.js";
import { SchedulerRegistry } from "../../../lib/scheduler-registry/scheduler-registry.js";
import nativeInventorySchedulerPlugin from "../../native-inventory-scheduler.js";

const mode = process.argv[2];
assert.ok(mode);
assert.ok(["startup", "interval", "ordinary-failure", "close-join"].includes(mode));
const messages: string[] = [];
const stream = new Writable({
	write(chunk, _encoding, callback) {
		messages.push(String(chunk));
		callback();
	},
});
let attempts = 0;
const releases: Array<() => void> = [];
const registry = new SchedulerRegistry(undefined, async () => {
	attempts += 1;
	if (mode === "close-join") {
		await new Promise<void>((resolve) => {
			releases.push(resolve);
		});
	}
	if (mode === "ordinary-failure") throw new Error("private synthetic scheduler detail");
	// This represents refusal before the job body is admitted, not a mocked success.
	throw new RestoreRuntimeAdmissionError();
});
registry.register({
	id: JOB_ID.nativeInventory,
	label: "Synthetic job",
	description: "Timer rejection boundary",
	concurrency: "singleton",
});
registry.register({
	id: JOB_ID.nativeInventoryRetention,
	label: "Synthetic retention job",
	description: "Independent timer rejection boundary",
	concurrency: "serial",
});

const app = Fastify({ logger: { stream } });
app.register(fastifyPlugin(async () => {}, { name: "prisma" }));
app.register(fastifyPlugin(async () => {}, { name: "security" }));
app.register(
	fastifyPlugin(
		async (instance) => {
			instance.decorate("schedulerRegistry", registry);
		},
		{ name: "scheduler-registry" },
	),
);
app.register(nativeInventorySchedulerPlugin);

let startup: (() => void) | undefined;
let interval: (() => void) | undefined;
let retentionInterval: (() => void) | undefined;
let timeoutCleared = false;
let intervalCleared = false;
let retentionIntervalCleared = false;
const timeoutHandle = { synthetic: "startup" } as unknown as ReturnType<typeof setTimeout>;
const intervalHandle = { synthetic: "interval" } as unknown as ReturnType<typeof setInterval>;
const retentionIntervalHandle = { synthetic: "retention" } as unknown as ReturnType<
	typeof setInterval
>;
const original = {
	setTimeout: globalThis.setTimeout,
	setInterval: globalThis.setInterval,
	clearTimeout: globalThis.clearTimeout,
	clearInterval: globalThis.clearInterval,
};
globalThis.setTimeout = ((callback: () => void, delay: number, ...args: unknown[]) => {
	if (delay !== 30_000) return original.setTimeout(callback, delay, ...args);
	startup = callback;
	return timeoutHandle;
}) as typeof setTimeout;
globalThis.setInterval = ((callback: () => void, delay: number, ...args: unknown[]) => {
	if (delay === 5_000) {
		retentionInterval = callback;
		return retentionIntervalHandle;
	}
	if (delay !== 30_000) return original.setInterval(callback, delay, ...args);
	interval = callback;
	return intervalHandle;
}) as typeof setInterval;
globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
	if (handle === timeoutHandle) timeoutCleared = true;
	else original.clearTimeout(handle);
}) as typeof clearTimeout;
globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
	if (handle === intervalHandle) intervalCleared = true;
	else if (handle === retentionIntervalHandle) retentionIntervalCleared = true;
	else original.clearInterval(handle);
}) as typeof clearInterval;

async function settle(): Promise<void> {
	await immediate();
	await immediate();
	await immediate();
}
try {
	await app.ready();
	assert.ok(startup);
	startup();
	assert.ok(interval);
	assert.ok(retentionInterval);
	await settle();
	let closeJoined = false;
	if (mode === "close-join") {
		assert.equal(registry.getStatus(JOB_ID.nativeInventory)?.state, "running");
		const close = app.close().then(() => {
			closeJoined = true;
		});
		await settle();
		assert.equal(closeJoined, false, "Shutdown must join accepted scheduler work");
		assert.equal(releases.length, 2);
		for (const release of releases) release();
		await close;
	} else {
		if (mode === "interval") {
			interval();
			retentionInterval();
			await settle();
		}
		await app.close();
		closeJoined = true;
	}
	assert.equal(timeoutCleared, true);
	assert.equal(intervalCleared, true);
	assert.equal(retentionIntervalCleared, true);
	const before = attempts;
	startup();
	interval();
	retentionInterval();
	await settle();
	assert.equal(attempts, before, "Closed callbacks must not admit new work");
	const status = registry.getStatus(JOB_ID.nativeInventory);
	assert.equal(status?.state, "idle");
	assert.equal(status?.totalFailures, mode === "interval" ? 2 : 1);
	assert.equal(status?.lastSuccessAt, null);
	assert.equal(status?.lastStartedAt, null);
	const retentionStatus = registry.getStatus(JOB_ID.nativeInventoryRetention);
	assert.equal(retentionStatus?.state, "idle");
	assert.equal(retentionStatus?.totalFailures, mode === "interval" ? 2 : 1);
	assert.equal(retentionStatus?.lastSuccessAt, null);
	assert.equal(retentionStatus?.lastStartedAt, null);
	const logs = messages.join("");
	assert.equal(logs.includes("private synthetic scheduler detail"), false);
	const categories = messages
		.flatMap((line) => {
			try {
				return [JSON.parse(line).category];
			} catch {
				return [];
			}
		})
		.filter(
			(category) =>
				category === "native-inventory-scheduler-tick-failed" ||
				category === "native-inventory-retention-tick-failed",
		);
	assert.equal(categories.length, attempts);
	process.stdout.write(
		`${JSON.stringify({
			mode,
			survived: true,
			attempts,
			recordedFailures: status.totalFailures + retentionStatus.totalFailures,
			closeJoined,
			timersCancelled: true,
			privateErrorOmitted: true,
		})}\n`,
	);
} finally {
	Object.assign(globalThis, original);
	await app.close();
}
