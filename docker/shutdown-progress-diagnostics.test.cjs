const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");

const script = path.join(__dirname, "shutdown-progress-diagnostics.cjs");
const sample = (phase, elapsedMs, fields = {}) =>
	JSON.stringify({ category: "shutdown-progress", phase, elapsedMs, ...fields });

function summarize(lines) {
	const result = spawnSync(process.execPath, [script], {
		input: lines.join("\n"),
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	return JSON.parse(result.stdout);
}

test("retains the latest bounded progress for each shutdown phase", () => {
	const result = summarize([
		sample("initialization", 0.4, { admissionClosed: false }),
		sample("fastify", 1, { pendingHandlers: 2 }),
		sample("fastify", 5000, {
			admissionClosed: true,
			pendingHandlers: 0,
			runningSchedulers: 1,
			runningSchedulerKinds: [{ kind: "backup", count: 1 }],
			runtime: {
				phase: "operations",
				activeOperations: 1,
				activeOperationGroups: [
					{ source: "scheduler", stage: "callback", count: 1, oldestMs: 4990 },
				],
			},
		}),
	]);
	assert.deepEqual(result, {
		observations: 3,
		latestByPhase: [
			{ phase: "initialization", elapsedMs: 0, admissionClosed: false },
			{
				phase: "fastify",
				elapsedMs: 5000,
				admissionClosed: true,
				pendingHandlers: 0,
				runningSchedulers: 1,
				runningSchedulerKinds: [{ kind: "backup", count: 1 }],
				runtime: {
					phase: "operations",
					activeOperations: 1,
					activeOperationGroups: [
						{ source: "scheduler", stage: "callback", count: 1, oldestMs: 4990 },
					],
				},
			},
		],
	});
});

test("drops malformed records, unknown labels and unapproved fields", () => {
	const privateValue = "private-instance-identifier";
	const result = summarize([
		"unstructured diagnostic",
		"{",
		"null",
		sample(privateValue, 0),
		sample("runtime", -1),
		sample("failed", 9200, {
			msg: privateValue,
			failedPhase: "fastify",
			pendingHandlers: privateValue,
			runningSchedulerKinds: [
				{ kind: privateValue, count: 2 },
				{ kind: "other", count: 1 },
			],
			runtime: {
				phase: "failed",
				failedPhase: "clients",
				pendingClientCloses: 1,
				activeOperationGroups: [
					{ source: privateValue, stage: "callback", count: 1, oldestMs: 300 },
				],
			},
		}),
	]);
	assert.deepEqual(result, {
		observations: 1,
		latestByPhase: [
			{
				phase: "failed",
				elapsedMs: 9200,
				failedPhase: "fastify",
				runningSchedulerKinds: [{ kind: "other", count: 1 }],
				runtime: {
					phase: "failed",
					failedPhase: "clients",
					pendingClientCloses: 1,
					activeOperationGroups: [],
				},
			},
		],
	});
	assert(!JSON.stringify(result).includes(privateValue));
});

test("reports zero observed records for a missing or oversized progress line", () => {
	assert.deepEqual(summarize([sample("fastify", 5, { msg: "x".repeat(9000) })]), {
		observations: 0,
		latestByPhase: [],
	});
});
