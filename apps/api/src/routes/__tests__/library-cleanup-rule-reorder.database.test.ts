import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ArrClientFactory } from "../../lib/arr/client-factory.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import { openRestoreRuntime } from "../../lib/backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../lib/backup/runtime-schema-startup.js";
import {
	acquireCleanupRunLease,
	releaseCleanupRunLease,
} from "../../lib/library-cleanup/cleanup-run-lease.js";
import lifecycle from "../../plugins/lifecycle.js";
import { registerLibraryCleanupRoutes } from "../library-cleanup.js";

// Real routes, runtime admission, Prisma, lease and transaction. Only session
// admission is synthetic; a loopback sentinel detects any unintended provider I/O.
describe("native cleanup rule reorder complete owned set", () => {
	let directory: string, database: string;
	let runtime: Awaited<ReturnType<typeof openRestoreRuntime>>;
	let native: ReturnType<typeof createRuntimePrismaClient>;
	const app = Fastify({ logger: false });
	const encryptor = new Encryptor("76".repeat(32));
	const requests: string[] = [];
	const provider = createServer((request, response) => {
		requests.push(request.method + " " + request.url);
		response.writeHead(503).end();
	});
	const run = <T>(operation: () => Promise<T>) => runtime.runOperation(operation);
	const rows = () =>
		run(() => native.prisma.libraryCleanupRule.findMany({ orderBy: { id: "asc" } }));
	const reorder = (payload: unknown) =>
		app.inject({
			method: "PUT",
			url: "/api/library-cleanup/rules/reorder",
			payload: payload as Record<string, unknown>,
		});
	const ownerConfig = () =>
		run(() => native.prisma.libraryCleanupConfig.findUniqueOrThrow({ where: { userId: "owner" } }));
	async function seed(ids = ["rule-a", "rule-b"]) {
		await run(async () => {
			await native.prisma.libraryCleanupConfig.deleteMany({
				where: { userId: { in: ["owner", "other"] } },
			});
			for (const userId of ["owner", "other"])
				await native.prisma.libraryCleanupConfig.create({
					data: {
						id: userId + "-config",
						userId,
						enabled: false,
						rules: {
							create: (userId === "owner" ? ids : ["foreign-rule"]).map((id, index) => ({
								id,
								name: "Synthetic " + id,
								enabled: true,
								priority: userId === "other" ? 17 : [3, 8, 12][index]!,
								ruleType: "age",
								parameters: '{"field":"arrAddedAt","operator":"older_than","days":30}',
								serviceFilter: '["SONARR"]',
								targetScope: "series",
								action: "unmonitor",
							})),
						},
					},
				});
		});
	}
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "arr-cleanup-reorder-"));
		database = join(directory, "owned.db");
		new Database(database).close();
		await synchronizeRuntimeSchema("file:" + database);
		runtime = await openRestoreRuntime({ databaseUrl: "file:" + database });
		await runtime.bindDestination("synthetic-reorder");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
		const address = provider.address();
		if (!address || typeof address === "string") throw Error("Missing owned sentinel");
		const owner = await run(async () => {
			const owner = await native.prisma.user.create({
				data: { id: "owner", username: "synthetic-owner" },
			});
			await native.prisma.user.create({ data: { id: "other", username: "synthetic-other" } });
			const key = encryptor.encrypt("synthetic-reorder-key");
			await native.prisma.serviceInstance.create({
				data: {
					id: "sonarr-owned",
					userId: owner.id,
					service: "SONARR",
					label: "Synthetic",
					baseUrl: "http://127.0.0.1:" + address.port,
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				},
			});
			return owner;
		});
		app.decorate("prisma", native.prisma);
		app.decorate("restoreRuntime", runtime);
		app.decorate("encryptor", encryptor);
		app.decorate("arrClientFactory", new ArrClientFactory(encryptor, 150));
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (request) => {
			request.currentUser = owner;
		});
		await app.register(lifecycle);
		await app.register(registerLibraryCleanupRoutes, { prefix: "/api" });
		await app.ready();
	});
	beforeEach(async () => {
		requests.length = 0;
		await seed();
	});
	afterEach(() => {
		expect(requests).toEqual([]);
	});
	afterAll(async () => {
		await app.close();
		provider.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			provider.close((error) => (error ? reject(error) : resolve())),
		);
		await native?.close();
		await runtime?.close();
		const probe = new Database(database, { readonly: true, fileMustExist: true });
		const integrity = probe.pragma("quick_check", { simple: true });
		probe.close();
		expect(integrity).toBe("ok");
		await rm(directory, { recursive: true });
		expect(existsSync(directory)).toBe(false);
	});
	it.each([
		{
			name: "two-rule duplicate omits another owner rule",
			ids: ["rule-a", "rule-b"],
			submitted: ["rule-a", "rule-a"],
		},
		{
			name: "three-rule duplicate omits the middle owner rule",
			ids: ["rule-a", "rule-b", "rule-c"],
			submitted: ["rule-c", "rule-a", "rule-c"],
		},
	])("$name returns400 without changing any owned or foreign rule", async ({ ids, submitted }) => {
		await seed(ids);
		const before = await rows();
		const response = await reorder({ ruleIds: submitted });
		expect.soft(response.statusCode).toBe(400);
		expect.soft(await rows()).toEqual(before);
	});
	it.each([
		{
			name: "complete reverse order",
			ids: ["rule-a", "rule-b"],
			submitted: ["rule-b", "rule-a"],
			want: [
				{ id: "rule-b", priority: 0 },
				{ id: "rule-a", priority: 1 },
			],
		},
		{
			name: "single owned rule",
			ids: ["rule-a"],
			submitted: ["rule-a"],
			want: [{ id: "rule-a", priority: 0 }],
		},
	])("$name persists exact priorities and fresh readback", async ({ ids, submitted, want }) => {
		await seed(ids);
		const foreign = (await rows()).filter((r) => r.configId === "other-config");
		const response = await reorder({ ruleIds: submitted });
		expect(response.statusCode).toBe(200);
		expect(
			response
				.json()
				.rules.map((r: { id: string; priority: number }) => ({ id: r.id, priority: r.priority })),
		).toEqual(want);
		expect(
			(await app.inject({ method: "GET", url: "/api/library-cleanup/config" }))
				.json()
				.rules.map((r: { id: string; priority: number }) => ({ id: r.id, priority: r.priority })),
		).toEqual(want);
		expect(
			await run(() =>
				native.prisma.libraryCleanupRule.findMany({
					where: { config: { userId: "owner" } },
					orderBy: { priority: "asc" },
					select: { id: true, priority: true },
				}),
			),
		).toEqual(want);
		expect((await rows()).filter((r) => r.configId === "other-config")).toEqual(foreign);
		expect(await ownerConfig()).toMatchObject({
			enabled: false,
			runClaimToken: null,
			runClaimedAt: null,
		});
	});
	it.each([
		{ name: "missing owner ID", payload: { ruleIds: ["rule-a"] } },
		{ name: "foreign replacement ID", payload: { ruleIds: ["rule-a", "foreign-rule"] } },
		{ name: "unknown replacement ID", payload: { ruleIds: ["rule-a", "unknown-rule"] } },
		{ name: "empty selection", payload: { ruleIds: [] } },
		{ name: "non-array selection", payload: { ruleIds: "rule-a" } },
		{ name: "non-string ID", payload: { ruleIds: ["rule-a", 7] } },
		{ name: "empty ID", payload: { ruleIds: ["rule-a", ""] } },
		{ name: "missing selection", payload: {} },
	])("$name returns400 without partial rule changes", async ({ payload }) => {
		const before = await rows();
		const response = await reorder(payload);
		expect(response.statusCode).toBe(400);
		expect(await rows()).toEqual(before);
	});
	it("valid selection with missing owner config returns404 and leaves foreign policy", async () => {
		await run(() => native.prisma.libraryCleanupConfig.delete({ where: { userId: "owner" } }));
		const before = await rows();
		expect((await reorder({ ruleIds: ["foreign-rule"] })).statusCode).toBe(404);
		expect(await rows()).toEqual(before);
		expect(await run(() => native.prisma.libraryCleanupConfig.count())).toBe(1);
	});
	it("duplicate malformed selection is admitted as400 before missing-config lookup", async () => {
		await run(() => native.prisma.libraryCleanupConfig.delete({ where: { userId: "owner" } }));
		const before = await rows();
		expect((await reorder({ ruleIds: ["rule-a", "rule-a"] })).statusCode).toBe(400);
		expect(await rows()).toEqual(before);
	});
	it("native active cleanup lease blocks valid reorder until exact owner releases it", async () => {
		expect(
			await run(() =>
				acquireCleanupRunLease(native.prisma, "owner", "owner-config", new Date(), "synthetic-run"),
			),
		).toBe("synthetic-run");
		const before = await rows();
		try {
			expect((await reorder({ ruleIds: ["rule-b", "rule-a"] })).statusCode).toBe(409);
			expect(await rows()).toEqual(before);
			expect((await ownerConfig()).runClaimToken).toBe("synthetic-run");
		} finally {
			expect(
				await run(() =>
					releaseCleanupRunLease(native.prisma, "owner", "owner-config", "synthetic-run"),
				),
			).toBe(true);
		}
		expect((await reorder({ ruleIds: ["rule-b", "rule-a"] })).statusCode).toBe(200);
		expect((await ownerConfig()).runClaimToken).toBeNull();
	});
	it("native transaction rolls back earlier priority update on a later write failure and releases lease", async () => {
		const before = await rows();
		const sqlite = new Database(database);
		sqlite.exec(
			"CREATE TRIGGER reject_reorder BEFORE UPDATE OF priority ON library_cleanup_rules WHEN NEW.id = 'rule-a' BEGIN SELECT RAISE(ABORT, 'synthetic reorder abort'); END",
		);
		sqlite.close();
		try {
			expect((await reorder({ ruleIds: ["rule-b", "rule-a"] })).statusCode).toBe(500);
			expect(await rows()).toEqual(before);
			expect((await ownerConfig()).runClaimToken).toBeNull();
		} finally {
			const cleanup = new Database(database);
			cleanup.exec("DROP TRIGGER reject_reorder");
			cleanup.close();
		}
		expect((await reorder({ ruleIds: ["rule-b", "rule-a"] })).statusCode).toBe(200);
	});
});
