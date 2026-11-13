// Controlled shell integration only. /app and /config MUST be disposable tmpfs.
// Real shell/CLI/processes; provider gate, native I/O, health and web are fixtures.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync, spawn } = require("node:child_process");
const { mkdirSync, writeFileSync, readdirSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { createRequire } = require("node:module");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: Standalone namespace fixture, not a Turbo task; this safety guard refuses other execution.
assert.equal(process.env.ARR_COMBINED_STARTUP_TEST_MODE, "isolated-tmpfs");
assert.equal(process.getuid(), 1000);
assert.deepEqual(readdirSync("/app"), []);
assert.deepEqual(readdirSync("/config"), []);
const source = resolve(__dirname, ".."),
	apiRequire = createRequire(join(source, "apps/api/package.json")),
	loader = apiRequire.resolve("tsx");
const protocol = join(source, "apps/api/src/lib/lifecycle/combined-startup.ts");
function fixture(path, text) {
	mkdirSync(require("node:path").dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, text, { mode: 0o600, flag: "wx" });
}
fixture("/app/api/package.json", '{"type":"module"}');
fixture("/app/web/package.json", '{"type":"module"}');
mkdirSync("/app/web/apps/web/.next/cache", { recursive: true, mode: 0o700 });
fixture(
	"/app/api/validate-provider-runtime.cjs",
	"process.exit(process.env.TEST_PROVIDER_FAILURE==='true'?1:0);\n",
);
fixture(
	"/app/api/providers/sqlite/dist/schema-startup.js",
	'process.stderr.write("TEST_NATIVE_PRELAUNCH\\n");process.stdout.write(JSON.stringify({apiPort:3011,webPort:3010,listenAddress:"127.0.0.1"})+"\\n");\n',
);
fixture(
	"/app/api/providers/sqlite/dist/combined-startup.js",
	`if(process.env.TEST_CONSUMER_REFUSAL==='true'&&process.argv[2]==='read')process.exit(1);await import(${JSON.stringify(join(source, "apps/api/src/combined-startup.ts"))});\n`,
);
fixture(
	"/app/api/providers/sqlite/dist/launcher.js",
	`import {readCombinedStartupChannel,publishCombinedStartupResult} from ${JSON.stringify(protocol)};
if(process.env.TEST_REAL_LAUNCHER==='true'){await import(${JSON.stringify(join(source, "apps/api/src/launcher.ts"))});}else{
process.stdout.write('TEST_NATIVE_API\\n');
process.stdout.write('TEST_SHUTDOWN_GRACE:'+process.env.SHUTDOWN_GRACE+'\\n');
if(!process.env.ARR_COMBINED_STARTUP_NONCE)process.exit(0);
process.on('SIGTERM',()=>{process.stdout.write('TEST_API_CLOSED\\n');process.exit(Number(process.env.TEST_API_STOP_CODE??(process.env.TEST_STOP_FAILURE==='true'?3:0)))});
if(process.env.TEST_STARTUP_FAILURE==='true')process.exit(1);
const channel=readCombinedStartupChannel(process.env);
if(process.env.TEST_WAIT_HANDOFF==='true'){process.stdout.write('TEST_WAITING_HANDOFF\\n');}else{
process.stdout.write('TEST_LISTEN_READY\\n');
publishCombinedStartupResult(channel,{kind:'arr-combined-startup',version:1,nonce:channel.nonce,apiPort:3011,webPort:3010,listenAddress:'127.0.0.1'});
}
setInterval(()=>{},1000);}\n`,
);
fixture(
	"/app/runtime-health.cjs",
	"process.stdout.write('TEST_HEALTH_PORT:'+process.argv[3]+'\\n');\n",
);
fixture(
	"/app/web/server.js",
	"const hold=process.env.TEST_WEB_HOLD==='true';\nif(hold)process.on('SIGTERM',()=>{if(process.env.TEST_WEB_IGNORE_TERM==='true')return;process.stdout.write('TEST_WEB_CLOSED\\n');process.exit(Number(process.env.TEST_WEB_STOP_CODE??0));});\nprocess.stdout.write('TEST_WEB_STARTED\\n');process.stdout.write('TEST_WEB_BINDING:'+process.env.PORT+':'+process.env.API_HOST+'\\n');\nif(!hold)process.exit(process.env.TEST_WEB_EARLY_EXIT==='true'?143:0);else setTimeout(()=>{process.stdout.write('TEST_WEB_DEADLINE\\n');process.exit(99);},4000);\n",
);

const environment = (extra) => ({
	PATH: process.env.PATH,
	NODE_OPTIONS: `--import=${loader}`,
	NODE_ENV: "production",
	PUID: "1000",
	PGID: "1000",
	SHUTDOWN_GRACE: "1",
	ARR_COMBINED_STARTUP_TEST_MODE: "isolated-tmpfs",
	...extra,
});
function run(extra = {}) {
	// The shipped BusyBox ash accepts SIG-prefixed trap names; host dash does not.
	// Bash executes this controlled host fixture; the actual image remains a gate.
	const r = spawnSync("/bin/bash", [join(source, "docker/start-combined.sh")], {
		env: environment(extra),
		encoding: "utf8",
		timeout: 10000,
		maxBuffer: 65536,
	});
	assert.equal(r.error, undefined, "shell did not close within the owned test deadline");
	assert.equal(r.signal, null);
	return {
		code: r.status,
		out: r.stdout,
		errors: r.stderr,
		native:
			(r.stdout.match(/TEST_NATIVE_API/g) ?? []).length +
			(r.stderr.match(/TEST_NATIVE_PRELAUNCH/g) ?? []).length,
	};
}
for (const [configured, expected] of [
	[undefined, "90"],
	["", "90"],
	["abc", "90"],
	["-1", "90"],
	["2147484", "90"],
	["999999999999999999999999999", "90"],
	["00012", "12"],
	["0000", "0"],
])
	test(`shared shutdown window normalizes safely: ${configured}`, () => {
		const result = run({ SHUTDOWN_GRACE: configured });
		assert.equal(result.code, 1, "deliberate web exit remains fatal");
		assert(result.out.includes(`TEST_SHUTDOWN_GRACE:${expected}\n`));
		assert(result.out.includes("TEST_API_CLOSED"));
	});

test("default shared shutdown window joins real API drain past six seconds", async () => {
	const child = spawn("/bin/bash", [join(source, "docker/start-combined.sh")], {
		env: environment({
			SHUTDOWN_GRACE: undefined,
			TEST_REAL_LAUNCHER: "true",
			TEST_COMBINED_MODE: "delayed-close",
			TEST_WEB_HOLD: "true",
			NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import=${join(source, "apps/api/src/lib/lifecycle/__tests__/fixtures/combined-startup-loader.mjs")}`,
		}),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "",
		errors = "",
		signalled = false,
		expired = false;
	child.stdout.on("data", (bytes) => {
		output += bytes;
		if (!signalled && output.includes("TEST_WEB_STARTED")) {
			signalled = true;
			child.kill("SIGTERM");
		}
	});
	child.stderr.on("data", (bytes) => {
		errors += bytes;
	});
	const timer = setTimeout(() => {
		expired = true;
		child.kill("SIGKILL");
	}, 15_000);
	const result = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	clearTimeout(timer);
	assert(!expired && signalled, `Controlled fixture did not reach signal boundary: ${errors}`);
	assert.deepEqual(result, { code: 0, signal: null });
	assert(output.includes('"event":"draining"'));
	assert(output.includes("Services stopped gracefully"));
	assert(!errors.includes("SIGKILL"));
	const children = output
		.split("\n")
		.filter((line) => line.startsWith('{"event":"child"'))
		.map((line) => JSON.parse(line));
	assert.equal(children.length, 1);
	for (const event of children) assert.throws(() => process.kill(event.pid, 0));
	assert.deepEqual(
		[...output.matchAll(/SUPERVISOR_WAIT_COMPLETED pid=\d+ status=(\d+)/g)].map((match) =>
			Number(match[1]),
		),
		[0, 0],
	);
});

test("combined shell delegates one startup to the API and publishes health/web only after handoff", () => {
	const r = run();
	assert(r.native > 0, `controlled fixture did not reach validation: ${r.errors}`);
	assert.equal(
		r.native,
		1,
		"native startup must not run in a pre-launch actor or diagnostic relaunch",
	);
	assert(r.out.indexOf("TEST_LISTEN_READY") >= 0);
	assert(r.out.indexOf("TEST_HEALTH_PORT:3010") > r.out.indexOf("TEST_LISTEN_READY"));
	assert(r.out.indexOf("TEST_WEB_STARTED") > r.out.indexOf("TEST_HEALTH_PORT:3010"));
	assert(r.out.includes("TEST_WEB_BINDING:3010:http://localhost:3011"));
	assert(r.out.includes("TEST_API_CLOSED"), "fatal web exit must physically stop the tracked API");
	assert.equal(r.code, 1, "the deliberate web exit must remain a fatal supervisor outcome");
});
test("native failure never starts health/web or a diagnostic replacement", () => {
	const r = run({ TEST_STARTUP_FAILURE: "true" });
	assert.equal(r.code, 1);
	assert.equal(r.native, 1);
	assert(!r.out.includes("TEST_HEALTH_PORT:"));
	assert(!r.out.includes("TEST_WEB_STARTED"));
	assert(r.errors.includes("Destructive schema changes are intentionally rejected at startup"));
	assert(r.errors.includes("An unacknowledged commit is unknown; do not assume rollback"));
	assert(
		r.errors.includes(
			"Keep services stopped and consult the release notes for an explicit upgrade path",
		),
	);
	assert(!r.errors.includes("Existing constraints were preserved"));
});
test("provider validation failure starts no API, health publisher or web", () => {
	const r = run({ TEST_PROVIDER_FAILURE: "true" });
	assert.equal(r.code, 1);
	assert.equal(r.native, 0);
	assert(!r.out.includes("TEST_HEALTH_PORT:"));
	assert(!r.out.includes("TEST_WEB_STARTED"));
});
test("consumer refusal stops and joins the API without starting web", () => {
	const r = run({ TEST_CONSUMER_REFUSAL: "true" });
	assert.equal(r.code, 1);
	assert.equal(r.native, 1);
	assert(r.out.includes("TEST_API_CLOSED"));
	assert(!r.out.includes("TEST_HEALTH_PORT:"));
	assert(!r.out.includes("TEST_WEB_STARTED"));
});
for (const mode of ["normal", "failed-stop", "real-held-native"])
	test(`a signal before handoff joins the API and reports ${mode} truthfully`, async () => {
		const real = mode === "real-held-native";
		const child = spawn("/bin/bash", [join(source, "docker/start-combined.sh")], {
			env: environment({
				TEST_WAIT_HANDOFF: "true",
				TEST_STOP_FAILURE: String(mode === "failed-stop"),
				...(real
					? {
							TEST_REAL_LAUNCHER: "true",
							TEST_COMBINED_MODE: "held-native",
							NODE_OPTIONS: `--disable-warning=ExperimentalWarning --import=${join(source, "apps/api/src/lib/lifecycle/__tests__/fixtures/combined-startup-loader.mjs")}`,
						}
					: {}),
			}),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "",
			signalled = false,
			expired = false;
		child.stdout.on("data", (bytes) => {
			output += bytes;
			if (
				!signalled &&
				output.includes(real ? '"event":"waiting-native"' : "TEST_WAITING_HANDOFF")
			) {
				signalled = true;
				child.kill("SIGTERM");
			}
		});
		child.stderr.resume();
		const timer = setTimeout(() => {
			expired = true;
			child.kill("SIGKILL");
		}, 6000);
		const result = await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve({ code, signal }));
		});
		clearTimeout(timer);
		assert.equal(expired, false);
		assert.equal(signalled, true);
		assert.deepEqual(result, { code: mode === "normal" ? 0 : 1, signal: null });
		if (real) {
			const events = output
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line));
			const children = events.filter((event) => event.event === "child");
			assert.equal(children.length, 1);
			for (const event of children) assert.throws(() => process.kill(event.pid, 0));
		} else assert(output.includes("TEST_API_CLOSED"));
		assert.equal(output.includes("Services stopped gracefully"), mode === "normal");
		assert(!output.includes("TEST_WEB_STARTED"));
		assert(!output.includes("TEST_HEALTH_PORT:"));
	});

for (const scenario of [
	{ name: "web-zero", web: 0, api: 0, expected: 0 },
	{ name: "web-expected-term", web: 143, api: 0, expected: 0 },
	{ name: "web-error", web: 3, api: 0, expected: 1 },
	{ name: "web-wrong-signal", web: 130, api: 0, expected: 1 },
	{ name: "web-kill-status", web: 137, api: 0, expected: 1 },
	{ name: "api-term-is-not-success", web: 0, api: 143, expected: 1 },
	{ name: "forced-web-is-not-success", web: 137, api: 0, expected: 1, ignoreTerm: true },
])
	test("intentional shutdown preserves exact child evidence: " + scenario.name, async () => {
		const child = spawn("/bin/bash", [join(source, "docker/start-combined.sh")], {
			env: environment({
				TEST_WEB_HOLD: "true",
				TEST_WEB_STOP_CODE: String(scenario.web),
				TEST_API_STOP_CODE: String(scenario.api),
				TEST_WEB_IGNORE_TERM: String(scenario.ignoreTerm === true),
			}),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "",
			signalled = false,
			expired = false,
			overflow = false;
		child.stdout.on("data", (b) => {
			output += b.toString();
			if (Buffer.byteLength(output) > 65536) {
				overflow = true;
				child.kill("SIGKILL");
			}
			if (!signalled && output.includes("TEST_WEB_STARTED")) {
				signalled = true;
				child.kill("SIGTERM");
			}
		});
		child.stderr.resume();
		const timer = setTimeout(() => {
			expired = true;
			child.kill("SIGKILL");
		}, 8000);
		const result = await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve({ code, signal }));
		});
		clearTimeout(timer);
		assert(!expired && !overflow);
		assert(signalled);
		assert.deepEqual(result, { code: scenario.expected, signal: null });
		const statuses = [...output.matchAll(/SUPERVISOR_WAIT_COMPLETED pid=\d+ status=(\d+)/g)].map(
			(x) => Number(x[1]),
		);
		assert.deepEqual(
			statuses,
			[scenario.web, scenario.api],
			"raw child outcomes must not be normalized or replaced by a shell wrapper",
		);
		assert.equal(output.includes("Services stopped gracefully"), scenario.expected === 0);
		if (!scenario.ignoreTerm)
			assert(output.includes("TEST_WEB_CLOSED"), "the tracked web leaf must handle termination");
		assert(output.includes("TEST_API_CLOSED"));
	});
test("unexpected web143 exit remains fatal without an intentional shutdown", () => {
	const r = run({ TEST_WEB_EARLY_EXIT: "true" });
	assert.equal(r.code, 1);
	assert(r.out.includes("TEST_API_CLOSED"));
	assert(!r.out.includes("Services stopped gracefully"));
});
test("already-dead web143 cannot become a successful requested stop", () => {
	const script = readFileSync(join(source, "docker/start-combined.sh"), "utf8");
	const start = script.indexOf("stop_services() {"),
		end = script.indexOf("\ncleanup_startup_channel()", start);
	assert(start >= 0 && end > start);
	const r = spawnSync(
		"/bin/bash",
		[
			"-c",
			`set -e
process_is_alive(){ return 1; }
signal_tracked(){ :; }
kill(){ return 1; }
wait_for_exit(){ return 0; }
reap_tracked(){ if [ "$1" = web ]; then _REAPED=143; else _REAPED=0; fi; }
WEB_PID=web; API_PID=api; SHUTDOWN_GRACE=0
${script.slice(start, end)}
stop_services
printf '%s\\n' "$STOP_FAILED"
`,
		],
		{ env: environment({}), encoding: "utf8", timeout: 1000, maxBuffer: 4096 },
	);
	assert.equal(r.error, undefined);
	assert.equal(r.signal, null);
	assert.equal(r.status, 0);
	assert.equal(r.stderr, "");
	assert.equal(r.stdout, "1\n");
});
