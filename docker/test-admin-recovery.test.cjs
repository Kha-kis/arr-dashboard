const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");
const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function run(environment = {}, args = [], options = {}) {
	const root = mkdtempSync(join(tmpdir(), "arr-recovery-wrapper-"));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin);
	const recoveryDirectory = join(root, "config", "heap-snapshots");
	if (options.createRecoveryDirectory !== false) mkdirSync(recoveryDirectory, { recursive: true });
	// Only the private copy changes fixed paths; production accepts no runtime-root override.
	const wrapper = join(root, "reset.sh");
	writeFileSync(
		wrapper,
		readFileSync(join(__dirname, "reset-admin-password.sh"), "utf8")
			.replaceAll("/app/api", join(root, "api"))
			.replaceAll("/config/heap-snapshots", recoveryDirectory),
	);
	writeFileSync(
		join(bin, "id"),
		'#!/bin/sh\nif [ "$1" = "-u" ]; then if [ -n "$TEST_UID" ]; then echo "$TEST_UID"; else echo 1234; fi; else echo 4321; fi\n',
		{ mode: 0o700 },
	);
	writeFileSync(join(bin, "su-exec"), '#!/bin/sh\nexport TEST_DROPPED="$1"\nshift\nexec "$@"\n', {
		mode: 0o700,
	});
	writeFileSync(
		join(bin, "node"),
		'#!/bin/sh\ncase "$1" in -e) if [ -n "$TEST_CLASSIFIER_STATUS" ]; then exit "$TEST_CLASSIFIER_STATUS"; fi; exec "$TEST_NODE_BINARY" "$@" ;; */validate-provider-runtime.cjs) if [ "$TEST_VALIDATE_STATUS" = 1 ]; then exit 1; else exit 0; fi ;; esac\nif [ -z "$TEST_DROPPED" ]; then TEST_DROPPED=retained; fi\nprintf "%s|%s|%s" "$1" "$DATABASE_URL" "$TEST_DROPPED"\nif [ "$TEST_REPORT_CWD" = 1 ]; then printf "|%s" "$PWD"; fi\nprintf "\\n"\n',
		{ mode: 0o700 },
	);
	const result = spawnSync("/bin/sh", [wrapper, ...args], {
		env: { PATH: bin, TEST_NODE_BINARY: process.execPath, ...environment },
		encoding: "utf8",
		timeout: 5000,
	});
	return { ...result, recoveryDirectory };
}
test("relative SQLite recovery uses the normal API working directory for both privilege branches", () => {
	for (const TEST_UID of ["0", "1234"]) {
		const result = run({ DATABASE_URL: "file:../prod.db", TEST_UID, TEST_REPORT_CWD: "1" });
		assert.equal(result.status, 0);
		assert.equal(result.stdout.trim().split("|").at(-1), result.recoveryDirectory);
		assert.match(result.stdout, /\|file:\.\.\/prod\.db\|/);
	}
});
test("absolute SQLite and PostgreSQL recovery keep their existing working directory", () => {
	for (const DATABASE_URL of ["file:/config/prod.db", "postgresql://synthetic@127.0.0.1/db"]) {
		for (const TEST_UID of ["0", "1234"]) {
			const result = run({ DATABASE_URL, TEST_UID, TEST_REPORT_CWD: "1" });
			assert.equal(result.status, 0);
			assert.equal(result.stdout.trim().split("|").at(-1), process.cwd());
		}
	}
});
test("relative SQLite recovery refuses when the normal working directory is unavailable", () => {
	for (const TEST_UID of ["0", "1234"]) {
		const result = run({ DATABASE_URL: "file:../synthetic-private.db", TEST_UID }, [], {
			createRecoveryDirectory: false,
		});
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.doesNotMatch(result.stderr, /synthetic-private|heap-snapshots/);
	}
});
test("absolute SQLite whitespace matches the native resolver without a recovery directory", () => {
	for (const DATABASE_URL of [
		"file: /config/prod.db",
		"file:\u00a0/config/prod.db",
		"file:\u2003/config/prod.db",
	]) {
		for (const TEST_UID of ["0", "1234"]) {
			const result = run({ DATABASE_URL, TEST_UID, TEST_REPORT_CWD: "1" }, [], {
				createRecoveryDirectory: false,
			});
			assert.equal(result.status, 0);
			assert.equal(result.stdout.trim().split("|").at(-1), process.cwd());
		}
	}
});
test("a failed path classifier refuses without executing the recovery actor", () => {
	for (const TEST_UID of ["0", "1234"]) {
		const result = run({
			DATABASE_URL: "file:../synthetic-private.db",
			TEST_UID,
			TEST_CLASSIFIER_STATUS: "1",
		});
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.doesNotMatch(result.stderr, /synthetic-private/);
	}
});
test("defaults blank URL to the same Docker SQLite path without package managers", () => {
	for (const DATABASE_URL of [undefined, ""]) {
		const result = run(DATABASE_URL === undefined ? {} : { DATABASE_URL });
		assert.equal(result.status, 0);
		assert.match(
			result.stdout,
			/\/providers\/sqlite\/dist\/reset-admin-password\.js\|file:\/config\/prod\.db\|retained/,
		);
	}
});
test("selects only the exact allowlisted provider", () => {
	for (const DATABASE_URL of [
		"postgres://synthetic@127.0.0.1/db",
		"postgresql://synthetic@127.0.0.1/db",
	]) {
		const result = run({ DATABASE_URL });
		assert.equal(result.status, 0);
		assert.match(result.stdout, /\/providers\/postgresql\/dist\/reset-admin-password\.js/);
	}
	for (const DATABASE_URL of [
		"mysql://synthetic.invalid",
		"/config/prod.db",
		"https://synthetic.invalid",
		"FILE:/config/prod.db",
	]) {
		const result = run({ DATABASE_URL });
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.doesNotMatch(result.stderr, /synthetic|prod\.db/);
	}
});
test("validates the provider manifest before actor execution", () => {
	const result = run({ TEST_VALIDATE_STATUS: "1" });
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
});
test("drops root to configured numeric IDs and preserves actual nonroot identity", () => {
	assert.match(run({ TEST_UID: "0", PUID: "123", PGID: "456" }).stdout, /\|123:456/);
	assert.match(run({ TEST_UID: "0" }).stdout, /\|911:911/);
	assert.match(run({ TEST_UID: "1234", PUID: "invalid", PGID: "invalid" }).stdout, /\|retained/);
	for (const PUID of ["-1", "abc", "123;echo private", "99999999999"]) {
		const result = run({ TEST_UID: "0", PUID });
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
	}
});
test("rejects password arguments without printing or forwarding them", () => {
	const result = run({}, ["synthetic-private-password"]);
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.doesNotMatch(result.stderr, /synthetic-private-password/);
});
