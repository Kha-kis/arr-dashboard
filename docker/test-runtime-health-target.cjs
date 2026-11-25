// Linux combined-image listener metadata, using the actual network namespace.
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const health = process.argv[2] || path.join(__dirname, "runtime-health.cjs");
const port = "38081";

function target(host) {
	return spawnSync(process.execPath, [health, "target", port, host], { encoding: "utf8" });
}

const loopbackIndex = readFileSync("/sys/class/net/lo/ifindex", "utf8").trim();
for (const [host, expected] of [
	["0.0.0.0", "127.0.0.1"],
	["127.0.0.2", "127.0.0.2"],
	["::", "[::1]"],
	["::1", "[::1]"],
	["::ffff:0.0.0.0", "127.0.0.1"],
	["::%lo", "[::1]"],
	[`::%${loopbackIndex}`, "[::1]"],
	["0:0:0:0:0:0:0:1%lo", "[::1]"],
	["::ffff:127.0.0.1%lo", "127.0.0.1"],
]) {
	const result = target(host);
	assert.equal(result.status, 0, `target rejected ${host}: ${result.stderr}`);
	assert.equal(result.stdout, `http://${expected}:${port}`, host);
}

for (const host of ["::%0", "::%4294967295", "::%does-not-exist", "::%%lo", "192.0.2.1"]) {
	const result = target(host);
	assert.equal(result.status, 1, host);
	assert.equal(result.stdout, "", host);
}
process.stdout.write("Runtime health target cases passed\n");
