import assert from "node:assert/strict";
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

test("interactive mode and unsupported worker limits remain refused", () => {
	for (const flag of ["--watch", "--ui", "--watch=true", "--ui=true"]) {
		assert.throws(() => select([flag]), /noninteractive/);
	}
	for (const workers of ["", "1", "3", "8"])
		assert.throws(() => select([], workers), /ARR_API_TEST_WORKERS/);
});
