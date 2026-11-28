// Combined-image listener metadata in the actual Linux network namespace.
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const {
	dockerIPv6ApiSocket,
	localSocketTarget,
	socketOrigin,
} = require("../apps/web/docker-socket-target.cjs");

const loopbackIndex = readFileSync("/sys/class/net/lo/ifindex", "utf8").trim();
for (const [host, expected] of [
	["0.0.0.0", "127.0.0.1"],
	["127.0.0.2", "127.0.0.2"],
	["::", "::1"],
	["::1", "::1"],
	["::ffff:0.0.0.0", "127.0.0.1"],
	["::%lo", "::1"],
	[`::%${loopbackIndex}`, "::1"],
	["0:0:0:0:0:0:0:1%lo", "::1"],
	["::ffff:127.0.0.1%lo", "127.0.0.1"],
]) {
	assert.equal(localSocketTarget(host), expected, host);
}
for (const host of [
	"::%0",
	"::%4294967295",
	"::%does-not-exist",
	"::%%lo",
	"192.0.2.1",
	"fe80::42%lo",
]) {
	assert.throws(() => localSocketTarget(host), undefined, host);
}
assert.equal(socketOrigin(38081, "fe80::42%eth0"), "http://[fe80::42]:38081");
assert.equal(dockerIPv6ApiSocket("::1", "http://[::1]:38081").port, "38081");
assert.equal(dockerIPv6ApiSocket("::1", "http://[::1]:80").port, "80");
for (const origin of [
	"http://example.invalid:38081",
	"http://[::1]:38081/api",
	"https://[::1]:38081",
	"http://operator@[::1]:38081",
])
	assert.throws(() => dockerIPv6ApiSocket("::1", origin));
process.stdout.write("Runtime health socket cases passed\n");
