import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Only newly owned synthetic storage and the actual pre-launch actor. No app,
// provider connections, network requests or production database is involved.
describe.skipIf(process.platform !== "linux")("native startup phase diagnostics", () => {
	let directory: string;
	let path: string;
	const actors = new Set<{ child: ChildProcess; closed: Promise<unknown> }>();
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "arr-startup-phase-"));
		chmodSync(directory, 0o700);
		path = join(directory, "owned.db");
	});
	afterEach(async () => {
		for (const actor of actors) {
			if (actor.child.exitCode === null && actor.child.signalCode === null)
				actor.child.kill("SIGKILL");
			await actor.closed;
		}
		actors.clear();
		expect(realpathSync(directory)).toBe(directory);
		expect(directory.startsWith(join(tmpdir(), "arr-startup-phase-"))).toBe(true);
		rmSync(directory, { recursive: true });
	});
	async function launch() {
		const child = spawn(
			process.execPath,
			[
				"--import",
				import.meta.resolve("tsx/esm"),
				fileURLToPath(new URL("../schema-startup.ts", import.meta.url)),
			],
			{
				cwd: directory,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					PATH: process.env.PATH,
					LANG: "C.UTF-8",
					TZ: "UTC",
					NODE_ENV: "test",
					DOTENV_CONFIG_PATH: "/dev/null",
					DATABASE_URL: `file:${path}`,
				},
			},
		);
		let stdout = "",
			stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.length > 65536) child.kill("SIGKILL");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (stderr.length > 65536) child.kill("SIGKILL");
		});
		const deadline = setTimeout(() => child.kill("SIGKILL"), 4000);
		const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
			(resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code, signal) => resolve({ code, signal }));
			},
		);
		const actor = { child, closed };
		actors.add(actor);
		try {
			const result = await closed;
			return { ...result, stdout, stderr };
		} finally {
			clearTimeout(deadline);
			actors.delete(actor);
		}
	}
	function events(stderr: string): Array<Record<string, unknown>> {
		return stderr
			.split("\n")
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}
	it("keeps stdout a closed-writer settings result while reporting bounded phase durations", async () => {
		for (let iteration = 0; iteration < 2; iteration++) {
			const result = await launch();
			expect(result.code).toBe(0);
			expect(result.signal).toBeNull();
			expect(JSON.parse(result.stdout)).toEqual({
				apiPort: null,
				webPort: null,
				listenAddress: null,
			});
			const timings = events(result.stderr);
			expect(timings.map((event) => event.phase)).toEqual([
				"catalog-preflight",
				"date-plan",
				"schema-apply",
				"catalog-postflight",
				"date-apply",
				"foreign-key-check",
				"commit",
				"total",
			]);
			for (const event of timings) {
				expect(Object.keys(event).sort()).toEqual([
					"category",
					"elapsedMs",
					"level",
					"outcome",
					"phase",
				]);
				expect(event.category).toBe("sqlite-startup-phase");
				expect(event.outcome).toBe("completed");
				expect(event.elapsedMs).toEqual(expect.any(Number));
				expect(Number.isFinite(event.elapsedMs)).toBe(true);
				expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
			}
			expect(result.stderr).not.toContain(directory);
			// A successful return still proves the native writer/owner closed.
			const database = new Database(path, { fileMustExist: true });
			try {
				database.exec("BEGIN EXCLUSIVE; ROLLBACK;");
				expect(database.prepare("SELECT COUNT(*) AS count FROM User").get()).toEqual({
					count: iteration,
				});
				if (iteration === 0)
					database
						.prepare("INSERT INTO User(id,username,createdAt,updatedAt) VALUES(?,?,?,?)")
						.run(
							"synthetic-conserved-owner",
							"synthetic-conserved-owner",
							"2026-10-17T00:00:00.000+00:00",
							"2026-10-17T00:00:00.000+00:00",
						);
			} finally {
				database.close();
			}
		}
	});
	it("retains date rejection and withholds settings without logging the invalid value", async () => {
		expect((await launch()).code).toBe(0);
		const database = new Database(path, { fileMustExist: true });
		try {
			database
				.prepare("INSERT INTO User(id,username,createdAt,updatedAt) VALUES(?,?,?,?)")
				.run("synthetic-owner", "synthetic-owner", "private-invalid-date", "private-invalid-date");
		} finally {
			database.close();
		}
		const result = await launch();
		expect(result.code).toBe(1);
		expect(result.signal).toBeNull();
		expect(result.stdout).toBe("");
		expect(events(result.stderr).map((event) => [event.phase, event.outcome])).toEqual([
			["catalog-preflight", "completed"],
			["date-plan", "failed"],
			["total", "failed"],
		]);
		expect(result.stderr).toContain("Database schema startup is unavailable");
		expect(result.stderr).not.toContain("private-invalid-date");
		expect(result.stderr).not.toContain("synthetic-owner");
		expect(result.stderr).not.toContain(directory);
	});
});
