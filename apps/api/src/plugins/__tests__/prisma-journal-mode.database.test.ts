import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prismaPlugin } from "../prisma.js";

describe("Prisma plugin SQLite journal mode", () => {
	let directory: string;
	let path: string;
	let app: ReturnType<typeof Fastify> | undefined;
	let schemaProcessJoined = false;
	beforeAll(async () => {
		directory = mkdtempSync(join(tmpdir(), "prisma-journal-mode-"));
		path = join(directory, "fixture.db");
		// Real startup consumes an initialized current schema, not an empty
		// file. Keep schema-engine work outside the ordinary Prisma plugin.
		const api = resolve(import.meta.dirname, "../../..");
		const source = readFileSync(join(api, "prisma/schema.prisma"), "utf8").replace(
			/generator client \{[\s\S]*?\}/,
			'generator client {\n provider = "prisma-client"\n output = "./unused-client"\n}',
		);
		const schema = join(directory, "schema.prisma"),
			config = join(directory, "safe.config.ts");
		writeFileSync(schema, source, { mode: 0o600 });
		writeFileSync(config, "export default {datasource:{url:process.env.DATABASE_URL}};\n", {
			mode: 0o600,
		});
		const env = Object.fromEntries(
			["PATH", "LANG", "LC_ALL", "TZ"].flatMap((key) =>
				process.env[key] ? [[key, process.env[key]]] : [],
			),
		);
		await promisify(execFile)(
			process.execPath,
			[
				join(api, "node_modules/prisma/build/index.js"),
				"db",
				"push",
				"--schema",
				schema,
				"--config",
				config,
				"--url",
				`file:${path}`,
			],
			{
				cwd: directory,
				env: { ...env, DATABASE_URL: `file:${path}`, CHECKPOINT_DISABLE: "1" },
				timeout: 60000,
			},
		).finally(() => {
			schemaProcessJoined = true;
		});
		chmodSync(path, 0o600);
	}, 65000);
	afterAll(async () => {
		if (!schemaProcessJoined) throw new Error("Schema fixture process closure is unverified");
		// Do not remove a fixture until its real application runtime has closed.
		if (app) await app.close();
		if (directory) rmSync(directory, { recursive: true, force: true });
	});
	it("verifies an explicit WAL opt-in before the database is exposed", async () => {
		app = Fastify({ logger: false });
		app.decorate("config", { DATABASE_URL: `file:${path}`, SQLITE_JOURNAL_MODE: "wal" } as never);
		await app.register(prismaPlugin);
		await app.ready();
		expect(app.dbProvider).toBe("sqlite");
		const observer = new Database(path);
		try {
			expect(observer.pragma("journal_mode", { simple: true })).toBe("wal");
		} finally {
			observer.close();
		}
	});
});
