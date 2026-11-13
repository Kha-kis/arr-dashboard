import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { Prisma } from "../../prisma.js";
import {
	readRestoreRuntimeControl,
	writeRestoreRuntimeCommit,
} from "../restore-runtime-repository.js";
import { RestoreRuntimeStateError } from "../restore-runtime-state.js";

const execFileAsync = promisify(execFile);
const apiDir = resolve(import.meta.dirname, "../../../..");
const EPOCH = "11111111-1111-4111-8111-111111111111";
const RESTORE = "22222222-2222-4222-8222-222222222222";
const OLDER = "33333333-3333-4333-8333-333333333333";
const oldTime = new Date("2026-10-06T12:00:00.000Z");
const request = Object.freeze({
	runtimeEpoch: EPOCH,
	restoreId: RESTORE,
	destinationInstallationId: "fixture-destination",
	committedAt: "2026-10-07T12:00:00.000Z",
});

describe.skipIf(process.env.TEST_DB !== "true")("Restore runtime singleton repository", () => {
	let directory: string;
	let prisma: ReturnType<typeof createTestPrismaClient>;
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "restore-runtime-repository-"));
		const schemaPath = join(directory, "schema.prisma");
		const config = join(directory, "safe.config.ts");
		const url = `file:${join(directory, "fixture.db")}`;
		const source = await readFile(join(apiDir, "prisma/schema.prisma"), "utf8");
		await writeFile(
			schemaPath,
			source.replace(
				/generator client \{[\s\S]*?\}/,
				'generator client {\n provider = "prisma-client"\n output = "./unused-client"\n}',
			),
			{ mode: 0o600 },
		);
		await writeFile(config, "export default {datasource:{url:process.env.DATABASE_URL}};\n", {
			mode: 0o600,
		});
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
				schemaPath,
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
		prisma = createTestPrismaClient(join(directory, "fixture.db"));
	}, 90000);
	afterAll(async () => {
		await prisma?.$disconnect();
		if (directory) await rm(directory, { recursive: true, force: true });
	});
	beforeEach(async () => {
		await prisma.restoreRuntimeControl.deleteMany();
		await prisma.user.deleteMany();
	});
	async function seed() {
		return prisma.restoreRuntimeControl.create({
			data: {
				id: 1,
				protocolVersion: 1,
				phase: "restore-pending",
				runtimeEpoch: EPOCH,
				ownerBackendPid: null,
				activeRestoreId: RESTORE,
				lastCommittedRestoreId: OLDER,
				lastCommittedAt: oldTime,
				destinationInstallationId: "fixture-destination",
			},
		});
	}
	async function expectRefusal(work: Promise<unknown>) {
		await expect(work).rejects.toMatchObject({
			name: "RestoreRuntimeStateError",
			message: "Restore runtime state is unavailable.",
		});
	}

	it("reads exactly nine fields as normalized immutable evidence", async () => {
		await seed();
		let selected: string[] = [];
		let limit: number | undefined;
		const observed = prisma.$extends({
			query: {
				restoreRuntimeControl: {
					async findMany({ args, query }) {
						selected = Object.keys(args.select ?? {});
						limit = args.take;
						return query(args);
					},
				},
			},
		});
		// Query interception adds no client surface; real delegates still execute.
		const result = await readRestoreRuntimeControl(observed as unknown as typeof prisma);
		expect(selected).toEqual([
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
		expect(limit).toBe(2);
		expect(result).toEqual({
			id: 1,
			protocolVersion: 1,
			phase: "restore-pending",
			runtimeEpoch: EPOCH,
			ownerBackendPid: null,
			activeRestoreId: RESTORE,
			lastCommittedRestoreId: OLDER,
			lastCommittedAt: "2026-10-06T12:00:00.000Z",
			destinationInstallationId: "fixture-destination",
		});
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("rejects missing state without silently creating an idle owner", async () => {
		await expectRefusal(readRestoreRuntimeControl(prisma));
		await expectRefusal(writeRestoreRuntimeCommit(prisma, request));
		expect(await prisma.restoreRuntimeControl.count()).toBe(0);
	});

	it("rejects malformed and ambiguous singleton rows", async () => {
		await seed();
		await prisma.restoreRuntimeControl.update({
			where: { id: 1 },
			data: { phase: "private-fixture-invalid-phase" },
		});
		await expectRefusal(readRestoreRuntimeControl(prisma));
		await prisma.restoreRuntimeControl.update({
			where: { id: 1 },
			data: { phase: "restore-pending" },
		});
		await prisma.restoreRuntimeControl.create({
			data: { id: 2, protocolVersion: 1, phase: "idle" },
		});
		await expectRefusal(readRestoreRuntimeControl(prisma));
		await expectRefusal(writeRestoreRuntimeCommit(prisma, request));
		expect(await prisma.restoreRuntimeControl.count()).toBe(2);
	});

	it("bounds a real query failure without retaining its raw database cause", async () => {
		await prisma.$executeRawUnsafe(
			'ALTER TABLE "RestoreRuntimeControl" RENAME TO "runtime_fixture_unavailable"',
		);
		try {
			await expectRefusal(readRestoreRuntimeControl(prisma));
			await expectRefusal(writeRestoreRuntimeCommit(prisma, request));
			try {
				await readRestoreRuntimeControl(prisma);
			} catch (error) {
				expect(error).toBeInstanceOf(RestoreRuntimeStateError);
				expect(error).not.toHaveProperty("cause");
			}
		} finally {
			await prisma.$executeRawUnsafe(
				'ALTER TABLE "runtime_fixture_unavailable" RENAME TO "RestoreRuntimeControl"',
			);
		}
	});

	it("writes the matching positive marker while preserving runtime identity", async () => {
		await seed();
		await prisma.$transaction(async (tx) => writeRestoreRuntimeCommit(tx, request));
		expect(await prisma.restoreRuntimeControl.findUnique({ where: { id: 1 } })).toEqual({
			id: 1,
			protocolVersion: 1,
			phase: "restart-required",
			runtimeEpoch: EPOCH,
			ownerBackendPid: null,
			activeRestoreId: RESTORE,
			lastCommittedRestoreId: RESTORE,
			lastCommittedAt: new Date("2026-10-07T12:00:00.000Z"),
			destinationInstallationId: "fixture-destination",
		});
	});

	it.each([
		["epoch", { runtimeEpoch: OLDER }],
		["Restore ID", { restoreId: OLDER }],
		["destination", { destinationInstallationId: "other-fixture" }],
	])("rejects a mismatched request %s without changing the row", async (_name, patch) => {
		const initial = await seed();
		await expectRefusal(writeRestoreRuntimeCommit(prisma, { ...request, ...patch }));
		expect(await prisma.restoreRuntimeControl.findUnique({ where: { id: 1 } })).toEqual(initial);
	});

	it.each([
		["id", { id: 2 }],
		["protocol", { protocolVersion: 2 }],
		["phase", { phase: "running" }],
		["epoch", { runtimeEpoch: OLDER }],
		["PID", { ownerBackendPid: 42 }],
		["active ID", { activeRestoreId: OLDER }],
		["historical ID", { lastCommittedRestoreId: RESTORE }],
		["historical time", { lastCommittedAt: new Date("2026-10-05T12:00:00.000Z") }],
		["destination", { destinationInstallationId: "other-fixture" }],
	])("compares the complete snapshot when %s changes before the update", async (_name, patch) => {
		await seed();
		let changed = false;
		const raced = prisma.$extends({
			query: {
				restoreRuntimeControl: {
					async updateMany({ args, query }) {
						await prisma.restoreRuntimeControl.update({ where: { id: 1 }, data: patch });
						changed = true;
						return query(args);
					},
				},
			},
		});
		await expectRefusal(writeRestoreRuntimeCommit(raced as unknown as typeof prisma, request));
		expect(changed).toBe(true);
		expect(await prisma.restoreRuntimeControl.count({ where: { phase: "restart-required" } })).toBe(
			0,
		);
	});

	it("rolls back prior transaction work and the raced epoch after a late CAS failure", async () => {
		const initial = await seed();
		let active: Prisma.TransactionClient | undefined;
		let changed = false;
		const raced = prisma.$extends({
			query: {
				restoreRuntimeControl: {
					async updateMany({ args, query }) {
						if (!active) throw new Error("Fixture transaction is required");
						await active.restoreRuntimeControl.update({
							where: { id: 1 },
							data: { runtimeEpoch: OLDER },
						});
						changed = true;
						return query(args);
					},
				},
			},
		});
		await expectRefusal(
			(raced as unknown as typeof prisma).$transaction(async (tx) => {
				active = tx;
				await tx.user.create({ data: { id: "rolled-back-user", username: "fixture-rollback" } });
				await writeRestoreRuntimeCommit(tx, request);
			}),
		);
		expect(changed).toBe(true);
		expect(await prisma.user.count()).toBe(0);
		expect(await prisma.restoreRuntimeControl.findUnique({ where: { id: 1 } })).toEqual(initial);
	});
});
