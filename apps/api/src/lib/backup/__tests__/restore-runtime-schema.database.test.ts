import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";

const execFileAsync = promisify(execFile);
const apiDir = resolve(import.meta.dirname, "../../../..");

describe.skipIf(process.env.TEST_DB !== "true")("Restore runtime additive SQLite schema", () => {
	let directory: string;
	let prisma: ReturnType<typeof createTestPrismaClient>;
	let oldSchema: string;
	let currentSchema: string;
	let config: string;
	let url: string;

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "restore-runtime-schema-"));
		url = `file:${join(directory, "upgrade.db")}`;
		const source = await readFile(join(apiDir, "prisma/schema.prisma"), "utf8");
		const schema = source.replace(
			/generator client \{[\s\S]*?\}/,
			'generator client {\n provider = "prisma-client"\n output = "./unused-client"\n}',
		);
		oldSchema = join(directory, "before.prisma");
		currentSchema = join(directory, "after.prisma");
		config = join(directory, "safe.config.ts");
		await writeFile(
			oldSchema,
			schema.replace(/^model RestoreRuntimeControl \{[\s\S]*?^\}\n?/m, ""),
			{ mode: 0o600 },
		);
		await writeFile(currentSchema, schema, { mode: 0o600 });
		await writeFile(config, "export default {datasource:{url:process.env.DATABASE_URL}};\n", {
			mode: 0o600,
		});
		prisma = createTestPrismaClient(join(directory, "upgrade.db"));
	});

	afterAll(async () => {
		await prisma?.$disconnect();
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	async function push(schema: string) {
		const env = Object.fromEntries(
			["PATH", "LANG", "LC_ALL", "TZ"].flatMap((name) =>
				process.env[name] ? [[name, process.env[name]]] : [],
			),
		);
		await execFileAsync(
			process.execPath,
			[
				join(apiDir, "node_modules/prisma/build/index.js"),
				"db",
				"push",
				"--schema",
				schema,
				"--config",
				config,
				"--url",
				url,
			],
			{
				cwd: directory,
				env: { ...env, DATABASE_URL: url, CHECKPOINT_DISABLE: "1" },
				timeout: 60000,
			},
		);
	}

	it("adds only the nullable journal and preserves populated existing rows", async () => {
		await push(oldSchema);
		await prisma.user.create({ data: { id: "preserved-owner", username: "fixture-owner" } });
		await prisma.session.create({
			data: {
				id: "preserved-session",
				userId: "preserved-owner",
				expiresAt: new Date("2030-01-01T00:00:00.000Z"),
			},
		});
		await push(currentSchema);

		const tables = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
			"SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='RestoreRuntimeControl'",
		);
		expect(Number(tables[0]!.count)).toBe(1);
		expect(await prisma.user.count({ where: { id: "preserved-owner" } })).toBe(1);
		expect(
			await prisma.session.count({ where: { id: "preserved-session", userId: "preserved-owner" } }),
		).toBe(1);
		const columns = await prisma.$queryRawUnsafe<Array<{ name: string; notnull: bigint }>>(
			'PRAGMA table_info("RestoreRuntimeControl")',
		);
		expect(columns.map((column) => column.name)).toEqual([
			"id",
			"protocolVersion",
			"phase",
			"runtimeEpoch",
			"ownerBackendPid",
			"activeRestoreId",
			"lastCommittedRestoreId",
			"lastCommittedAt",
			"destinationInstallationId",
		]);
		expect(
			columns
				.filter((column) => !["id", "protocolVersion", "phase"].includes(column.name))
				.map((column) => Number(column.notnull)),
		).toEqual([0, 0, 0, 0, 0, 0]);
		// Upgrade never invents a runtime owner or implicitly opens admission.
		expect(await prisma.$queryRawUnsafe('SELECT * FROM "RestoreRuntimeControl"')).toEqual([]);
		await prisma.$executeRawUnsafe(
			'INSERT INTO "RestoreRuntimeControl" ("id", "protocolVersion", "phase") VALUES (1, 1, ?)',
			"idle",
		);
		expect(await prisma.$queryRawUnsafe('SELECT * FROM "RestoreRuntimeControl"')).toEqual([
			{
				id: 1,
				protocolVersion: 1,
				phase: "idle",
				runtimeEpoch: null,
				ownerBackendPid: null,
				activeRestoreId: null,
				lastCommittedRestoreId: null,
				lastCommittedAt: null,
				destinationInstallationId: null,
			},
		]);
	}, 120000);
});
