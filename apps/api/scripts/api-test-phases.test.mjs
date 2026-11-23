import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { selectApiTestPhases as select } from "./api-test-phases.mjs";

test("default and explicit all retain both providers, argument order, and default workers", () => {
	const expected = {
		phase: "all",
		vitestArguments: ["src/a.test.ts", "--reporter=dot"],
		sqliteWorkers: "4",
		runSqlite: true,
		runPostgres: true,
	};
	assert.deepEqual(select(["run", "src/a.test.ts", "--run", "--reporter=dot"]), expected);
	assert.deepEqual(select(["--phase=all", "src/a.test.ts", "--reporter=dot"]), expected);
});

test("explicit SQLite forwards legal Vitest selection and consumes only its phase", () => {
	const argv = ["--phase=sqlite", "--shard=1/2", "--testNamePattern", "native case"];
	assert.deepEqual(select(argv, "2"), {
		phase: "sqlite",
		vitestArguments: argv.slice(1),
		sqliteWorkers: "2",
		runSqlite: true,
		runPostgres: false,
	});
	assert.equal(argv[0], "--phase=sqlite");
	assert.equal(select(["--phase", "sqlite"]).phase, "sqlite");
});

test("explicit PostgreSQL selects only the serial native provider sequence", () => {
	assert.deepEqual(select(["run", "--phase=postgres", "--run"]), {
		phase: "postgres",
		vitestArguments: [],
		sqliteWorkers: "4",
		runSqlite: false,
		runPostgres: true,
	});
	for (const extra of ["src/a.test.ts", "--shard=1/2", "--reporter=dot"]) {
		assert.throws(() => select(["--phase=postgres", extra]), /PostgreSQL-only.*Vitest/i);
	}
});

test("missing, invalid and duplicate phase selection fails closed", () => {
	for (const argv of [
		["--phase"],
		["--phase="],
		["--phase=other"],
		["--phase", "--shard=1/2"],
		["--phase=sqlite", "--phase=sqlite"],
		["--phase", "all", "--phase=postgres"],
	]) {
		assert.throws(() => select(argv), /phase/i, JSON.stringify(argv));
	}
});

test("explicit false interactive flags remain valid noninteractive Vitest arguments", () => {
	const flags = ["--watch=false", "--ui=false", "--no-watch"];
	for (const prefix of [[], ["--phase=sqlite"]]) {
		assert.deepEqual(select([...prefix, ...flags]).vitestArguments, flags);
	}
});

test("interactive mode and unsupported worker limits remain refused", () => {
	for (const flag of ["--watch", "--ui", "--watch=true", "--ui=true"]) {
		assert.throws(() => select([flag]), /noninteractive/);
	}
	for (const workers of ["", "1", "3", "8"])
		assert.throws(() => select([], workers), /ARR_API_TEST_WORKERS/);
});

// Exercise the current driver source without compiling actors or starting a real
// database. The fixture doubles expose the same API; Vitest is a real child that
// records its exit, so selection, ordering and disposal remain caller regressions.
function runDriverProbe(context, args, failPhase) {
	const directory = mkdtempSync(join(tmpdir(), "arr-api-driver-phase-"));
	chmodSync(directory, 0o700);
	const write = (file, source) => writeFileSync(file, source, { mode: 0o600 });
	const callsFile = join(directory, "calls.jsonl");
	let childrenExited = false;
	try {
		for (const child of ["scripts", "node_modules", "node_modules/vitest"])
			mkdirSync(join(directory, child), { mode: 0o700 });
		write(join(directory, "package.json"), JSON.stringify({ type: "module" }));
		write(
			join(directory, "node_modules/vitest/package.json"),
			JSON.stringify({ name: "vitest", type: "module" }),
		);
		for (const file of ["run-api-tests.mjs", "api-test-phases.mjs"])
			write(join(directory, "scripts", file), readFileSync(new URL(file, import.meta.url)));
		write(callsFile, "");
		const prelude = `import { appendFileSync } from "node:fs";
const record = (event) => appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(event) + "\\n");
`;
		const environment = JSON.stringify({ PROBE_LOG: callsFile, FAIL_PHASE: failPhase ?? "" });
		write(
			join(directory, "scripts/native-test-actors.mjs"),
			`${prelude}
export async function prepareNativeTestActors() {
  record({ event: "prepare-sqlite" });
  return {
    directory: ${JSON.stringify(directory)}, environment: ${environment},
    dispose: async (options) => record({ event: "dispose-sqlite", options }),
  };
}
`,
		);
		write(
			join(directory, "scripts/native-postgres-test-fixture.mjs"),
			`${prelude}
export async function prepareNativePostgresFixture() {
  record({ event: "prepare-postgres" });
  return {
    config: "inventory", schemaStartupConfig: "startup", admissionConfig: "admission",
    project: ${JSON.stringify(directory)}, environment: ${environment},
    dispose: async (options) => record({ event: "dispose-postgres", options }),
    stopDatabase: async () => record({ event: "stop-postgres" }),
  };
}
`,
		);
		write(
			join(directory, "node_modules/vitest/vitest.mjs"),
			`${prelude}
const args = process.argv.slice(2);
const config = args[args.indexOf("--config") + 1];
const phase = config.endsWith("vitest.sqlite.mjs") ? "sqlite" : config;
record({ event: "run:" + phase, args, engine: process.env.RESTORE_RUNTIME_ENGINE, pid: process.pid });
process.on("exit", () => record({ event: "exited:" + phase }));
setTimeout(() => process.exit(process.env.FAIL_PHASE === phase ? 1 : 0), 10);
`,
		);
		const child = spawnSync(
			process.execPath,
			[join(directory, "scripts/run-api-tests.mjs"), ...args],
			{
				cwd: directory,
				env: { PATH: process.env.PATH, HOME: directory, LANG: "C.UTF-8", TZ: "UTC" },
				encoding: "utf8",
			},
		);
		assert.ifError(child.error);
		assert.equal(child.signal, null, child.stderr);
		const calls = readFileSync(callsFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		for (const call of calls.filter((call) => call.pid))
			assert.throws(() => process.kill(call.pid, 0), { code: "ESRCH" });
		childrenExited = true;
		for (const call of calls.filter((call) => call.event.startsWith("dispose-")))
			assert.deepEqual(call.options, { childrenExited: true });
		return { code: child.status, calls };
	} finally {
		// Keep uncertain child state for diagnosis instead of deleting executing code.
		if (childrenExited) {
			rmSync(directory, { recursive: true });
			assert.equal(existsSync(directory), false);
			context.diagnostic("Owned driver scratch removed after physical child joins.");
		}
	}
}

const sqliteSequence = ["prepare-sqlite", "run:sqlite", "exited:sqlite"];
const postgresSequence = [
	"prepare-postgres",
	"run:inventory",
	"exited:inventory",
	"run:startup",
	"exited:startup",
	"run:admission",
	"exited:admission",
];
for (const { name, args, failPhase, code, events } of [
	{
		name: "default preserves SQLite then all three serial PostgreSQL phases",
		args: [],
		code: 0,
		events: [...sqliteSequence, ...postgresSequence, "dispose-postgres", "dispose-sqlite"],
	},
	{
		name: "SQLite shard never prepares PostgreSQL",
		args: ["--phase=sqlite", "--shard=1/2", "--watch=false", "--ui=false"],
		code: 0,
		events: [...sqliteSequence, "dispose-sqlite"],
	},
	{
		name: "PostgreSQL-only never prepares an unused SQLite fixture",
		args: ["--phase=postgres"],
		code: 0,
		events: [...postgresSequence, "dispose-postgres"],
	},
	{
		name: "SQLite failure retains its fixture and stops before PostgreSQL",
		args: [],
		failPhase: "sqlite",
		code: 1,
		events: sqliteSequence,
	},
	{
		name: "PostgreSQL failure stops later phases and retains the failed provider fixture",
		args: [],
		failPhase: "startup",
		code: 1,
		events: [...sqliteSequence, ...postgresSequence.slice(0, 5), "stop-postgres", "dispose-sqlite"],
	},
]) {
	test(`actual driver: ${name}`, (context) => {
		const result = runDriverProbe(context, args, failPhase);
		assert.equal(result.code, code);
		assert.deepEqual(
			result.calls.map((call) => call.event),
			events,
		);
		if (args.includes("--phase=sqlite")) {
			const sqliteArgs = result.calls.find((call) => call.event === "run:sqlite").args;
			for (const argument of args.slice(1)) assert.ok(sqliteArgs.includes(argument), argument);
			assert.ok(!sqliteArgs.some((argument) => argument.startsWith("--phase")));
		}
		const admission = result.calls.find((call) => call.event === "run:admission");
		if (admission) assert.equal(admission.engine, "postgres");
	});
}
