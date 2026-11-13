"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

test("an unacknowledged fixture creation cannot attest cleanup", async () => {
	const file = join(__dirname, "test-startup-health.cjs");
	const image = `sha256:${"1".repeat(64)}`;
	const reports = [];
	let daemonAccepted = false;
	const childProcess = {
		execFileSync(command, args) {
			assert.equal(command, "docker");
			if (args[0] === "image" && args[1] === "inspect") {
				return args.includes("{{.Id}}") ? image : "0";
			}
			if (args[0] === "container" && args[1] === "create") {
				daemonAccepted = true;
				throw Object.assign(new Error("Synthetic lost creation response"), { code: "ETIMEDOUT" });
			}
			throw new Error("Unexpected operation after uncertain fixture creation");
		},
	};
	const processState = { argv: [process.execPath, file, "fixture:startup-health"], exitCode: 0 };
	const context = vm.createContext({
		require: (name) => (name === "node:child_process" ? childProcess : require(name)),
		process: processState,
		console: { log: (value) => reports.push(JSON.parse(value)) },
		setTimeout,
	});
	vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
	await new Promise(setImmediate);
	assert(daemonAccepted);
	assert.equal(processState.exitCode, 1);
	assert.equal(reports.length, 1);
	assert.equal(reports[0].passed, false);
	assert.equal(reports[0].fixtureClosureConfirmed, false);
	assert.match(reports[0].unconfirmedFixture.name, /^arr-test-startup-health-[a-f0-9-]{36}$/);
	assert.match(
		reports[0].unconfirmedFixture.ownerLabel,
		/^arr\.test\.startup-health=[a-f0-9-]{36}$/,
	);
	assert.equal(reports[0].unconfirmedFixture.imageId, image);
});
