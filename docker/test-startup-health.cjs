#!/usr/bin/env node
"use strict";

// Runs only a disposable, network-isolated liveness fixture; never opens a DB.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const image = process.argv[2];
assert(
	process.argv.length === 3 && image && !image.startsWith("-"),
	"Usage: node docker/test-startup-health.cjs IMAGE",
);
const owner = randomUUID();
const name = `arr-test-startup-health-${owner}`;
const docker = (args) =>
	execFileSync("docker", args, {
		encoding: "utf8",
		timeout: 15000,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
const expectedImage = docker(["image", "inspect", "--format", "{{.Id}}", image]);
assert.match(expectedImage, /^sha256:[a-f0-9]{64}$/);
assert.equal(docker(["image", "inspect", "--format", "{{len .Config.Volumes}}", image]), "0");
const template =
	'{"id":{{json .Id}},"image":{{json .Image}},"owner":{{json (index .Config.Labels "arr.test.startup-health")}},"network":{{json .HostConfig.NetworkMode}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}},"running":{{json .State.Running}},"pid":{{json .State.Pid}},"health":{{if index .State "Health"}}{{json (index (index .State "Health") "Status")}}{{else}}null{{end}},"restarts":{{json .RestartCount}},"oom":{{json .State.OOMKilled}}}';
let id;
let createIssued = false;
let passed = false;
let closed = false;
const transitions = [];

function inspectOwned() {
	const state = JSON.parse(docker(["container", "inspect", "--format", template, id]));
	assert.equal(state.id, id);
	assert.equal(state.image, expectedImage);
	assert.equal(state.owner, owner);
	assert.equal(state.network, "none");
	assert.equal(state.readonly, true);
	// Docker records --tmpfs in HostConfig before start, and Mounts after it.
	assert(state.mounts.every((mount) => mount.Type === "tmpfs" && mount.Destination === "/tmp"));
	assert.deepEqual(state.tmpfs, { "/tmp": "rw,nosuid,nodev,noexec,size=4m,mode=1777" });
	assert.equal(state.restarts, 0);
	assert.equal(state.oom, false);
	return state;
}

async function main() {
	const started = Date.now();
	try {
		// Deliberately exceeds the former 30s image grace. Use the image's real
		// health command and grace; shorten only its probe intervals/retry count.
		const fixture = `
const http = require('node:http');
const health = require('/app/runtime-health.cjs');
const began = Date.now();
const server = http.createServer((request, response) => {
  response.statusCode = Date.now() - began < 40000 ? 200 : 503;
  response.end();
});
setTimeout(() => server.listen(31234, '127.0.0.1', () => health.publishWebPort('31234')), 35000);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;
		createIssued = true;
		id = docker([
			"container",
			"create",
			"--name",
			name,
			"--pull=never",
			"--label",
			`arr.test.startup-health=${owner}`,
			"--network",
			"none",
			"--read-only",
			"--tmpfs",
			"/tmp:rw,nosuid,nodev,noexec,size=4m,mode=1777",
			"--cap-drop",
			"ALL",
			"--pids-limit",
			"64",
			"--memory",
			"128m",
			"--entrypoint",
			"node",
			"--health-interval",
			"1s",
			"--health-start-interval",
			"1s",
			"--health-retries",
			"1",
			expectedImage,
			"-e",
			fixture,
		]);
		assert.match(id, /^[a-f0-9]{64}$/);
		inspectOwned();
		assert.equal(docker(["container", "start", id]), id);
		let healthy = false;
		const deadline = Date.now() + 60000;
		while (Date.now() < deadline) {
			const state = inspectOwned();
			assert(state.running && state.pid > 0, "Fixture exited before liveness proof");
			if (transitions.at(-1)?.health !== state.health) {
				transitions.push({ health: state.health, elapsedMs: Date.now() - started });
			}
			if (!healthy) {
				assert.notEqual(
					state.health,
					"unhealthy",
					"Valid initialization was classified unhealthy before its first successful probe",
				);
				healthy = state.health === "healthy";
			} else if (state.health === "unhealthy") {
				assert.deepEqual(
					transitions.map((entry) => entry.health),
					["starting", "healthy", "unhealthy"],
				);
				passed = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		assert(
			passed,
			"Early liveness or post-success failure was not detected within the bounded test",
		);
	} finally {
		if (id) {
			if (inspectOwned().running)
				assert.equal(docker(["container", "stop", "--timeout", "5", id]), id);
			const stopped = inspectOwned();
			assert(!stopped.running && stopped.pid === 0, "Fixture stop is unconfirmed");
			assert.equal(docker(["container", "rm", id]), id);
			assert.equal(
				docker(["container", "ls", "-a", "-q", "--no-trunc", "--filter", `id=${id}`]),
				"",
			);
			closed = true;
		} else {
			// A failed CLI reply cannot prove that the daemon created nothing.
			closed = !createIssued;
		}
	}
}

main()
	.catch(() => {
		passed = false;
		process.exitCode = 1;
	})
	.finally(() => {
		console.log(
			JSON.stringify({
				passed,
				fixtureClosureConfirmed: closed,
				unconfirmedFixture: closed
					? null
					: { name, ownerLabel: `arr.test.startup-health=${owner}`, imageId: expectedImage },
				transitions,
				qaTouched: false,
			}),
		);
	});
