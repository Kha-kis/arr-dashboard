import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../../generated/prisma/client.js";
import { synchronizeSqliteRuntimeSchema } from "../../backup/runtime-schema-sqlite.js";
import { reconcileQuiAction } from "../action-reconciliation.js";
import { executeQuiAction } from "../action-service.js";
import { createQuiClient, type QuiClient } from "../client-factory.js";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);
const databases: Array<{ clients: PrismaClient[]; directory: string }> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const { clients, directory } of databases.splice(0)) {
		await Promise.all(clients.map(async (client) => await client.$disconnect()));
		await rm(directory, { recursive: true, force: true });
	}
});

async function createDatabase(): Promise<{ first: PrismaClient; second: PrismaClient }> {
	const directory = await mkdtemp(join(tmpdir(), "qui-action-retry-"));
	const databasePath = join(directory, "actions.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "pipe",
	});
	const first = new PrismaClient({
		adapter: new PrismaBetterSqlite3({ url: databasePath, timeout: 5_000 }),
	});
	const second = new PrismaClient({
		adapter: new PrismaBetterSqlite3({ url: databasePath, timeout: 5_000 }),
	});
	await Promise.all([first.$connect(), second.$connect()]);
	databases.push({ clients: [first, second], directory });
	await first.user.create({ data: { id: "user-1", username: "q-action-test" } });
	await first.serviceInstance.create({
		data: {
			id: "qui-1",
			userId: "user-1",
			service: "QUI",
			label: "test",
			baseUrl: "http://qui.invalid",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
		},
	});
	return { first, second };
}

function makeApp(prisma: PrismaClient): FastifyInstance {
	return {
		prisma,
		log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
	} as unknown as FastifyInstance;
}

function makeClient(bulkAction = vi.fn().mockResolvedValue(undefined)): QuiClient {
	return {
		listInstances: vi.fn().mockResolvedValue([{ id: 7, connected: true, isActive: true }]),
		getTorrentsByHash: vi
			.fn()
			.mockImplementation(async (hash: string) => [{ hash, instanceId: 7 }]),
		bulkAction,
	} as unknown as QuiClient;
}

function runAction(app: FastifyInstance, client: QuiClient, hashes: string[]) {
	return executeQuiAction({
		app,
		client,
		userId: "user-1",
		serviceInstanceId: "qui-1",
		qbitInstanceId: 7,
		hashes,
		action: "pause",
	});
}

describe("qUI action durable retry boundary", { timeout: 30_000 }, () => {
	it("holds HTTP-200 unverified acknowledgements and releases only a confirmed bulk action", async () => {
		const { first, second } = await createDatabase();
		const app = {
			...makeApp(first),
			encryptor: { decrypt: () => "synthetic-api-key" },
		} as unknown as FastifyInstance;
		const instance = await first.serviceInstance.findUniqueOrThrow({ where: { id: "qui-1" } });
		const client = createQuiClient(app, instance);
		const mutationCalls = new Map<string, number>();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			if (method === "GET" && url.pathname === "/api/instances") {
				return new Response(
					JSON.stringify([
						{
							id: 7,
							name: "Synthetic qBit",
							host: "http://qbittorrent.invalid",
							connected: true,
							hasLocalFilesystemAccess: true,
							useHardlinks: false,
							useReflinks: false,
							hardlinkBaseDir: null,
							isActive: true,
						},
					]),
					{ status: 200 },
				);
			}
			if (method === "GET" && url.pathname === "/api/torrents/cross-instance") {
				const hash = url.searchParams.get("search");
				if (
					!hash ||
					url.searchParams.get("page") !== "0" ||
					url.searchParams.get("limit") !== "2000"
				) {
					throw new Error("unmatched synthetic qUI inventory request");
				}
				return new Response(
					JSON.stringify({
						cross_instance_torrents: [
							{
								hash,
								name: "Synthetic torrent",
								state: "uploading",
								ratio: 1,
								progress: 1,
								num_seeds: 1,
								num_leechs: 0,
								tags: "",
								category: "",
								save_path: "/synthetic",
								added_on: 0,
								completion_on: 100,
								seeding_time: 0,
								eta: 0,
								dlspeed: 0,
								upspeed: 0,
								priority: 0,
								size: 1,
								instance_id: 7,
								instance_name: "Synthetic qBit",
							},
						],
						total: 1,
						hasMore: false,
						partialResults: false,
					}),
					{ status: 200 },
				);
			}
			if (method === "POST" && url.pathname === "/api/instances/7/torrents/bulk-action") {
				const body = JSON.parse(String(init?.body)) as { hashes?: string[] };
				const hash = body.hashes?.[0];
				if (!hash) throw new Error("unmatched synthetic qUI mutation without a hash");
				mutationCalls.set(hash, (mutationCalls.get(hash) ?? 0) + 1);
				const acknowledgement =
					hash === HASH_A
						? { error: "synthetic mutation failure" }
						: hash === HASH_B
							? {
									message: "Bulk action completed successfully",
									error: "synthetic contradictory failure",
									"synthetic-private-key": "synthetic-private-value",
								}
							: { message: "Bulk action completed successfully" };
				return new Response(JSON.stringify(acknowledgement), { status: 200 });
			}
			throw new Error(`unmatched synthetic fetch: ${method} ${url.pathname}`);
		});

		const errorShaped = await runAction(makeApp(first), client, [HASH_A]);
		const contradictory = await runAction(makeApp(first), client, [HASH_B]);
		const retryError = await runAction(makeApp(second), client, [HASH_A]);
		const retryContradictory = await runAction(makeApp(second), client, [HASH_B]);
		expect(errorShaped.status).toBe("uncertain");
		expect(contradictory.status).toBe("uncertain");
		expect(retryError.status).toBe("failed");
		expect(retryContradictory.status).toBe("failed");
		expect(mutationCalls.get(HASH_A)).toBe(1);
		expect(mutationCalls.get(HASH_B)).toBe(1);
		for (const hash of [HASH_A, HASH_B]) {
			const audit = await second.quiActionLog.findFirstOrThrow({ where: { torrentHash: hash } });
			expect(audit.status).toBe("uncertain");
			expect(audit.completedAt).toBeNull();
			expect(await second.quiActionClaim.count({ where: { torrentHash: hash } })).toBe(1);
		}

		const success = await runAction(makeApp(second), client, [HASH_C]);
		const completed = await second.quiActionLog.findFirstOrThrow({
			where: { torrentHash: HASH_C },
		});
		expect(success.status).toBe("success");
		expect(completed.status).toBe("success");
		expect(completed.completedAt).toBeInstanceOf(Date);
		expect(await second.quiActionClaim.count({ where: { torrentHash: HASH_C } })).toBe(0);
		expect(mutationCalls.get(HASH_C)).toBe(1);
		expect(fetchSpy).toHaveBeenCalled();
	});

	it("pages all 51 same-timestamp per-hash audit rows with the stable cursor", async () => {
		const { first } = await createDatabase();
		const requestedAt = new Date("2026-09-28T00:00:00.000Z");
		await first.quiActionLog.createMany({
			data: Array.from({ length: 51 }, (_, index) => ({
				id: `bulk-${String(index).padStart(3, "0")}`,
				userId: "user-1",
				serviceInstanceId: "qui-1",
				qbitInstanceId: 7,
				torrentHash: index.toString(16).padStart(40, "0"),
				action: "pause",
				status: "uncertain",
				requestedAt,
			})),
		});
		const firstPage = await first.quiActionLog.findMany({
			where: { userId: "user-1", status: "uncertain" },
			orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
			take: 50,
		});
		const last = firstPage.at(-1)!;
		const nextPage = await first.quiActionLog.findMany({
			where: {
				userId: "user-1",
				status: "uncertain",
				OR: [
					{ requestedAt: { lt: last.requestedAt } },
					{ requestedAt: last.requestedAt, id: { lt: last.id } },
				],
			},
			orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
			take: 50,
		});
		expect(firstPage).toHaveLength(50);
		expect(nextPage).toHaveLength(1);
		expect(new Set([...firstPage, ...nextPage].map((row) => row.id)).size).toBe(51);
	});

	it("adds claims and attempt grouping without dropping historical action rows", async () => {
		const directory = await mkdtemp(join(tmpdir(), "qui-action-upgrade-"));
		const clients: PrismaClient[] = [];
		databases.push({ clients, directory });
		const databasePath = join(directory, "upgrade.db");
		const environment = { ...process.env, DATABASE_URL: `file:${databasePath}` };
		const push = (schema: string) =>
			execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", schema], {
				cwd: process.cwd(),
				env: environment,
				stdio: "pipe",
			});
		push("src/lib/history/__tests__/fixtures/pre-history-schema.prisma");
		execFileSync("sqlite3", [
			databasePath,
			`
			INSERT INTO User (id, username, createdAt, updatedAt) VALUES ('user-1', 'upgrade-user', 0, 0);
			INSERT INTO ServiceInstance (id, userId, service, label, baseUrl, encryptedApiKey, encryptionIv, createdAt, updatedAt)
			VALUES ('qui-1', 'user-1', 'QUI', 'test', 'http://qui.invalid', 'encrypted', 'iv', 0, 0);
			INSERT INTO qui_action_logs (id, userId, serviceInstanceId, qbitInstanceId, torrentHash, action, status, requestedAt)
			VALUES ('old-action', 'user-1', 'qui-1', 7, '${HASH_A}', 'pause', 'pending', 0);
		`,
		]);
		await synchronizeSqliteRuntimeSchema(`file:${databasePath}`);
		const prisma = new PrismaClient({
			adapter: new PrismaBetterSqlite3({ url: databasePath, timeout: 5_000 }),
		});
		clients.push(prisma);
		const historical = await prisma.quiActionLog.findUniqueOrThrow({ where: { id: "old-action" } });
		expect(historical.status).toBe("pending");
		expect(historical.attemptId).toBeNull();
		expect(await prisma.quiActionClaim.count()).toBe(0);
		expect(await prisma.user.count()).toBe(1);
		expect(await prisma.serviceInstance.count()).toBe(1);
	});

	it("permits only one dispatch while two API clients race for the same hash", async () => {
		const { first, second } = await createDatabase();
		let dispatchStarted!: () => void;
		let completeDispatch!: () => void;
		const started = new Promise<void>((resolve) => {
			dispatchStarted = resolve;
		});
		const held = new Promise<void>((resolve) => {
			completeDispatch = resolve;
		});
		const bulkAction = vi.fn().mockImplementation(async () => {
			dispatchStarted();
			await held;
		});
		const firstCall = runAction(makeApp(first), makeClient(bulkAction), [HASH_A]);
		await started;
		const competing = await runAction(makeApp(second), makeClient(bulkAction), [HASH_A]);
		expect(competing.status).toBe("failed");
		expect(bulkAction).toHaveBeenCalledTimes(1);
		completeDispatch();
		expect((await firstCall).status).toBe("success");
	});

	it("holds an ambiguous hash across API clients while a different hash remains usable", async () => {
		const { first, second } = await createDatabase();
		const firstClient = makeClient(vi.fn().mockRejectedValue(new Error("response lost")));
		const retryClient = makeClient();

		const ambiguous = await runAction(makeApp(first), firstClient, [HASH_A]);
		const retry = await runAction(makeApp(second), retryClient, [HASH_A.toUpperCase()]);
		const unrelated = await runAction(makeApp(second), retryClient, [HASH_B]);

		expect(ambiguous.status).toBe("uncertain");
		expect(retry.status).toBe("failed");
		expect(retryClient.bulkAction).toHaveBeenCalledTimes(1);
		expect(unrelated.status).toBe("success");
		expect(await second.quiActionLog.count({ where: { torrentHash: HASH_A } })).toBe(1);
	});

	it("does not bypass an unresolved hash through another saved qUI connection", async () => {
		const { first, second } = await createDatabase();
		await first.serviceInstance.create({
			data: {
				id: "qui-alias",
				userId: "user-1",
				service: "QUI",
				label: "alias",
				baseUrl: "http://qui.invalid",
				encryptedApiKey: "encrypted",
				encryptionIv: "iv",
			},
		});
		await runAction(
			makeApp(first),
			makeClient(vi.fn().mockRejectedValue(new Error("response lost"))),
			[HASH_A],
		);
		const aliasClient = makeClient();
		const aliasResult = await executeQuiAction({
			app: makeApp(second),
			client: aliasClient,
			userId: "user-1",
			serviceInstanceId: "qui-alias",
			qbitInstanceId: 7,
			hashes: [HASH_A],
			action: "pause",
		});
		expect(aliasResult.status).toBe("failed");
		expect(aliasClient.bulkAction).not.toHaveBeenCalled();
	});

	it("does not erase an unresolved hold by deleting its qUI connection", async () => {
		const { first, second } = await createDatabase();
		await runAction(
			makeApp(first),
			makeClient(vi.fn().mockRejectedValue(new Error("response lost"))),
			[HASH_A],
		);
		await expect(first.serviceInstance.delete({ where: { id: "qui-1" } })).rejects.toMatchObject({
			code: "P2003",
		});
		expect(await second.quiActionClaim.count({ where: { torrentHash: HASH_A } })).toBe(1);
		expect(await second.quiActionLog.count({ where: { torrentHash: HASH_A } })).toBe(1);
	});

	it("does not dispatch through a mixed-case legacy pending row", async () => {
		const { first, second } = await createDatabase();
		await first.quiActionLog.create({
			data: {
				userId: "user-1",
				serviceInstanceId: "qui-1",
				qbitInstanceId: 7,
				torrentHash: HASH_A.toUpperCase(),
				action: "pause",
				status: "pending",
			},
		});
		const client = makeClient();
		expect((await runAction(makeApp(second), client, [HASH_A])).status).toBe("failed");
		expect(client.bulkAction).not.toHaveBeenCalled();
		expect(await second.quiActionClaim.count()).toBe(0);
	});

	it("retains the claim if database finalization fails after qUI acknowledges", async () => {
		const { first, second } = await createDatabase();
		const app = makeApp(first);
		const realTransaction = first.$transaction.bind(first);
		let transactionCount = 0;
		(app.prisma as unknown as { $transaction: typeof first.$transaction }).$transaction = ((
			callback: Parameters<typeof first.$transaction>[0],
		) => {
			transactionCount += 1;
			if (transactionCount === 3) throw new Error("finalization unavailable");
			return realTransaction(callback as never);
		}) as typeof first.$transaction;
		const result = await runAction(app, makeClient(), [HASH_A]);
		expect(result.status).toBe("audit_unsettled");
		expect(result.error).toContain("audit");
		expect(await second.quiActionClaim.count({ where: { torrentHash: HASH_A } })).toBe(1);
		expect(
			(await second.quiActionLog.findFirstOrThrow({ where: { torrentHash: HASH_A } })).status,
		).toBe("pending");
		expect((await runAction(makeApp(second), makeClient(), [HASH_A])).status).toBe("failed");
	});

	it("releases only an operator-verified target and keeps the distinct audit outcome", async () => {
		const { first, second } = await createDatabase();
		const firstClient = makeClient(vi.fn().mockRejectedValue(new Error("partial response loss")));
		await runAction(makeApp(first), firstClient, [HASH_A, HASH_B]);
		const rowA = await first.quiActionLog.findFirstOrThrow({ where: { torrentHash: HASH_A } });
		await expect(
			reconcileQuiAction({
				prisma: second,
				userId: "user-1",
				actionLogId: rowA.id,
				decision: "not_applied",
			}),
		).rejects.toThrow("qUI action not found or already resolved");
		await first.quiActionLog.update({
			where: { id: rowA.id },
			data: { requestedAt: new Date(Date.now() - 5 * 60_000) },
		});

		const resolved = await reconcileQuiAction({
			prisma: second,
			userId: "user-1",
			actionLogId: rowA.id,
			decision: "not_applied",
		});
		expect(resolved).toBe("operator_verified_not_applied");
		expect((await first.quiActionLog.findUniqueOrThrow({ where: { id: rowA.id } })).status).toBe(
			"operator_verified_not_applied",
		);
		expect(await first.quiActionClaim.count({ where: { torrentHash: HASH_A } })).toBe(0);
		expect(await first.quiActionClaim.count({ where: { torrentHash: HASH_B } })).toBe(1);
		expect((await runAction(makeApp(second), makeClient(), [HASH_A])).status).toBe("success");
		expect((await runAction(makeApp(second), makeClient(), [HASH_B])).status).toBe("failed");
	});

	it("does not release a foreign user's unresolved action", async () => {
		const { first, second } = await createDatabase();
		await runAction(
			makeApp(first),
			makeClient(vi.fn().mockRejectedValue(new Error("response lost"))),
			[HASH_A],
		);
		const row = await first.quiActionLog.findFirstOrThrow({ where: { torrentHash: HASH_A } });
		await expect(
			reconcileQuiAction({
				prisma: second,
				userId: "another-user",
				actionLogId: row.id,
				decision: "applied",
			}),
		).rejects.toThrow("qUI action not found or already resolved");
		expect(await first.quiActionClaim.count({ where: { torrentHash: HASH_A } })).toBe(1);
	});

	it("refuses to resolve a fresh pending intent but permits an old crash-left legacy row", async () => {
		const { first, second } = await createDatabase();
		const row = await first.quiActionLog.create({
			data: {
				userId: "user-1",
				serviceInstanceId: "qui-1",
				qbitInstanceId: 7,
				torrentHash: HASH_A,
				action: "pause",
				status: "pending",
			},
		});
		await expect(
			reconcileQuiAction({
				prisma: second,
				userId: "user-1",
				actionLogId: row.id,
				decision: "applied",
			}),
		).rejects.toThrow("qUI action not found or already resolved");
		expect((await first.quiActionLog.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
			"pending",
		);
		await first.quiActionLog.update({
			where: { id: row.id },
			data: { requestedAt: new Date(Date.now() - 5 * 60_000) },
		});
		await expect(
			reconcileQuiAction({
				prisma: second,
				userId: "user-1",
				actionLogId: row.id,
				decision: "applied",
			}),
		).resolves.toBe("operator_verified_applied");
	});
});
