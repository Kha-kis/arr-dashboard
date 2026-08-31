const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const clockPath = path.join(__dirname, "stop-timing-clock.cjs");
const queryPath = path.join(__dirname, "stop-timing-query.sh");
const { withinTimingLimit } = require("./stop-timing-clock.cjs");

function runQuery(args, options = {}) {
	return spawnSync("/bin/sh", [queryPath, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...options.env },
	});
}

function writeExecutable(filePath, contents) {
	fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

function createDockerStateFixture(t) {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "stop-timing-ownership-"));
	t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
	writeExecutable(
		path.join(fixture, "docker"),
		`#!/bin/sh
if [ "\${FAKE_DOCKER_MODE:-absent}" = query-error ]; then
	exit 17
fi
case "\${1:-}" in
	ps)
		if [ "\${FAKE_DOCKER_MODE:-absent}" = present ]; then
			printf '%s\\n' "\${FAKE_CONTAINER_NAME:-owned-container}"
		fi
		;;
	inspect)
		printf '%s\\n' "\${FAKE_RUNTIME_STATE:-running}"
		;;
	*) exit 64 ;;
esac
`,
	);
	return {
		ledger: path.join(fixture, "ports"),
		env: (dockerMode, runtimeState = "running") => ({
			PATH: `${fixture}:${process.env.PATH}`,
			FAKE_CONTAINER_NAME: "owned-container",
			FAKE_DOCKER_MODE: dockerMode,
			FAKE_RUNTIME_STATE: runtimeState,
		}),
	};
}

test("clock CLI returns integer monotonic milliseconds", () => {
	const result = spawnSync(process.execPath, [clockPath], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^\d+\n$/);
});

test("one process measures one command with the monotonic clock", () => {
	const result = spawnSync(
		process.execPath,
		[clockPath, "measure", process.execPath, "-e", "setTimeout(() => {}, 25)"],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^\d+\n$/);
	const elapsedMilliseconds = Number(result.stdout.trim());
	assert.ok(elapsedMilliseconds >= 20, result.stdout);
	assert.ok(elapsedMilliseconds < 1_000, result.stdout);
});

test("one process propagates the measured command failure", () => {
	const result = spawnSync(process.execPath, [
		clockPath,
		"measure",
		process.execPath,
		"-e",
		"process.exit(23)",
	], {
		encoding: "utf8",
	});
	assert.equal(result.status, 23, result.stderr);
	assert.match(result.stdout, /^\d+\n$/);
});

test("whole-second subtraction can false-fail restart", () => {
	const startMilliseconds = 999;
	const endMilliseconds = 10_998;
	assert.equal(endMilliseconds - startMilliseconds, 9_999);
	assert.equal(
		Math.floor(endMilliseconds / 1_000) - Math.floor(startMilliseconds / 1_000),
		10,
	);
});

test("whole-second subtraction can false-pass stubborn stop", () => {
	const startMilliseconds = 0;
	const endMilliseconds = 9_999;
	assert.equal(endMilliseconds - startMilliseconds, 9_999);
	assert.equal(
		Math.floor(endMilliseconds / 1_000) - Math.floor(startMilliseconds / 1_000),
		9,
	);
});

test("exact boundaries preserve every timing contract", () => {
	assert.equal(withinTimingLimit("stubborn", 8_999), true);
	assert.equal(withinTimingLimit("stubborn", 9_000), false);
	assert.equal(withinTimingLimit("restart", 9_999), true);
	assert.equal(withinTimingLimit("restart", 10_000), false);
	assert.equal(withinTimingLimit("prompt", 4_000), true);
	assert.equal(withinTimingLimit("prompt", 4_001), false);
	assert.equal(withinTimingLimit("collision", 8_999), false);
	assert.equal(withinTimingLimit("collision", 9_000), true);
});

test("Docker classification proves real PRESENT and ABSENT states", (t) => {
	const image = process.env.STOP_TIMING_TEST_IMAGE || "arr-dashboard:smoke";
	const name = `test-stop-timing-query-${process.pid}`;
	t.after(() => spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" }));
	const create = spawnSync(
		"docker",
		["create", "--name", name, "--entrypoint", "/bin/true", image],
		{ encoding: "utf8" },
	);
	assert.equal(create.status, 0, create.stderr);
	const present = runQuery(["container-state", name]);
	assert.equal(present.status, 0, present.stderr);
	assert.equal(present.stdout, "PRESENT\n");
	const remove = spawnSync("docker", ["rm", name], { encoding: "utf8" });
	assert.equal(remove.status, 0, remove.stderr);
	const absent = runQuery(["container-state", name]);
	assert.equal(absent.status, 0, absent.stderr);
	assert.equal(absent.stdout, "ABSENT\n");
});

test("invalid Docker endpoint is QUERY_ERROR", () => {
	const result = runQuery(["container-state", "not-present"], {
		env: {
			DOCKER_HOST: `unix://${path.join(os.tmpdir(), `missing-docker-${process.pid}.sock`)}`,
		},
	});
	assert.equal(result.status, 2, result.stderr);
	assert.equal(result.stdout, "QUERY_ERROR\n");
});

for (const [name, body] of [
	["API", "echo simulated-api-error >&2\nexit 17"],
	["permission", "echo permission-denied >&2\nexit 13"],
	["execution", "exit 126"],
]) {
	test(`Docker ${name} failure is QUERY_ERROR`, (t) => {
		const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "stop-timing-query-"));
		t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
		writeExecutable(path.join(fixture, "docker"), `#!/bin/sh\n${body}\n`);
		const result = runQuery(["container-state", "not-present"], {
			env: { PATH: `${fixture}:${process.env.PATH}` },
		});
		assert.equal(result.status, 2, result.stderr);
		assert.equal(result.stdout, "QUERY_ERROR\n");
	});
}

test("malformed Docker output is QUERY_ERROR", (t) => {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "stop-timing-query-"));
	t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
	writeExecutable(
		path.join(fixture, "docker"),
		"#!/bin/sh\nprintf '%s\\n' 'malformed container name'\n",
	);
	const result = runQuery(["container-state", "not-present"], {
		env: { PATH: `${fixture}:${process.env.PATH}` },
	});
	assert.equal(result.status, 2, result.stderr);
	assert.equal(result.stdout, "QUERY_ERROR\n");
});

test("verified release permits reuse while live ownership rejects it", (t) => {
	const { ledger, env } = createDockerStateFixture(t);
	for (const [internalPort, hostPort] of [
		["3001", "41001"],
		["3000", "41002"],
	]) {
		const acquired = runQuery([
			"record-port",
			ledger,
			"generation-a",
			"owned-container",
			internalPort,
			hostPort,
		]);
		assert.equal(acquired.status, 0, acquired.stderr);
	}

	const liveConflict = runQuery([
		"record-port",
		ledger,
		"generation-b",
		"owned-container",
		"3001",
		"41001",
	]);
	assert.equal(liveConflict.status, 1, liveConflict.stderr);

	const released = runQuery(
		["release-ports", ledger, "generation-a", "owned-container", "absent"],
		{ env: env("absent") },
	);
	assert.equal(released.status, 0, released.stderr);

	const reused = runQuery([
		"record-port",
		ledger,
		"generation-b",
		"owned-container",
		"3001",
		"41001",
	]);
	assert.equal(reused.status, 0, reused.stderr);
	assert.equal(reused.stdout, "41001\n");

	const finalRelease = runQuery(
		["release-ports", ledger, "generation-b", "owned-container", "absent"],
		{ env: env("absent") },
	);
	assert.equal(finalRelease.status, 0, finalRelease.stderr);
	const finalActive = runQuery(["active-ports", ledger]);
	assert.equal(finalActive.status, 0, finalActive.stderr);
	assert.equal(finalActive.stdout, "");
});

test("failed unknown and mismatched release retain exact ownership", (t) => {
	const { ledger, env } = createDockerStateFixture(t);
	const acquired = runQuery([
		"record-port",
		ledger,
		"generation-a",
		"owned-container",
		"3001",
		"42001",
	]);
	assert.equal(acquired.status, 0, acquired.stderr);

	for (const [owner, expectedState, dockerMode, runtimeState, expectedStatus] of [
		["generation-b", "absent", "absent", "running", 1],
		["generation-a", "absent", "present", "running", 1],
		["generation-a", "running", "present", "paused", 1],
		["generation-a", "absent", "query-error", "running", 2],
	]) {
		const result = runQuery(
			["release-ports", ledger, owner, "owned-container", expectedState],
			{ env: env(dockerMode, runtimeState) },
		);
		assert.equal(result.status, expectedStatus, result.stderr);
		const stillReserved = runQuery([
			"record-port",
			ledger,
			"generation-b",
			"owned-container",
			"3001",
			"42001",
		]);
		assert.equal(stillReserved.status, 1, stillReserved.stderr);
	}
});

test("restart generation transition retires old active mappings", (t) => {
	const { ledger, env } = createDockerStateFixture(t);
	for (const [internalPort, hostPort] of [
		["3001", "43001"],
		["3000", "43002"],
	]) {
		const acquired = runQuery([
			"record-port",
			ledger,
			"restart-generation-1",
			"owned-container",
			internalPort,
			hostPort,
		]);
		assert.equal(acquired.status, 0, acquired.stderr);
	}

	const retired = runQuery(
		[
			"release-ports",
			ledger,
			"restart-generation-1",
			"owned-container",
			"running",
		],
		{ env: env("present", "running") },
	);
	assert.equal(retired.status, 0, retired.stderr);

	for (const [internalPort, hostPort] of [
		["3001", "43001"],
		["3000", "43002"],
	]) {
		const reacquired = runQuery([
			"record-port",
			ledger,
			"restart-generation-2",
			"owned-container",
			internalPort,
			hostPort,
		]);
		assert.equal(reacquired.status, 0, reacquired.stderr);
	}

	const active = runQuery(["active-ports", ledger]);
	assert.equal(active.status, 0, active.stderr);
	assert.equal(
		active.stdout,
		"restart-generation-2|owned-container|3001|43001\nrestart-generation-2|owned-container|3000|43002\n",
	);

	const finalRelease = runQuery(
		[
			"release-ports",
			ledger,
			"restart-generation-2",
			"owned-container",
			"absent",
		],
		{ env: env("absent") },
	);
	assert.equal(finalRelease.status, 0, finalRelease.stderr);
	const finalActive = runQuery(["active-ports", ledger]);
	assert.equal(finalActive.status, 0, finalActive.stderr);
	assert.equal(finalActive.stdout, "");
});

test("malformed port ownership input fails before writing", (t) => {
	const { ledger } = createDockerStateFixture(t);
	for (const args of [
		["generation-a", "owned-container", "3001:3000", "44001"],
		["generation-a", "owned-container", "3001", "44001:44002"],
		["bad:owner", "owned-container", "3001", "44001"],
		["generation-a", "bad:container", "3001", "44001"],
	]) {
		const result = runQuery(["record-port", ledger, ...args]);
		assert.equal(result.status, 2, result.stderr);
		assert.equal(result.stdout, "QUERY_ERROR\n");
	}
	assert.equal(fs.existsSync(ledger), false);
});

test("release rejects an existing owner paired with a different container", (t) => {
	const { ledger, env } = createDockerStateFixture(t);
	const acquired = runQuery([
		"record-port",
		ledger,
		"generation-a",
		"owned-container",
		"3001",
		"45001",
	]);
	assert.equal(acquired.status, 0, acquired.stderr);

	const mismatched = runQuery(
		["release-ports", ledger, "generation-a", "unrelated-container", "absent"],
		{ env: env("absent") },
	);
	assert.equal(mismatched.status, 1, mismatched.stderr);

	const stillReserved = runQuery([
		"record-port",
		ledger,
		"generation-b",
		"unrelated-container",
		"3001",
		"45001",
	]);
	assert.equal(stillReserved.status, 1, stillReserved.stderr);
});

test("corrupt ledgers preserve QUERY_ERROR for record and release", (t) => {
	const { ledger, env } = createDockerStateFixture(t);
	fs.writeFileSync(ledger, "malformed-ledger-row\n");

	const record = runQuery([
		"record-port",
		ledger,
		"generation-a",
		"owned-container",
		"3001",
		"46001",
	]);
	assert.equal(record.status, 2, record.stderr);
	assert.equal(record.stdout, "QUERY_ERROR\n");

	const release = runQuery(
		["release-ports", ledger, "generation-a", "owned-container", "absent"],
		{ env: env("absent") },
	);
	assert.equal(release.status, 2, release.stderr);
	assert.equal(release.stdout, "QUERY_ERROR\n");
});
