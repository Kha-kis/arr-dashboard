import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../../generated/prisma/client.js";
import { Encryptor } from "../../auth/encryption.js";
import { reconcileQuiAction } from "../action-reconciliation.js";
import { executeQuiAction } from "../action-service.js";
import type { QuiClient } from "../client-factory.js";
import { executeQuiDrawerAction, type QuiDrawerActionInput } from "../drawer-action-service.js";
import { projectQuiTrackerViews } from "../tracker-selection.js";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const databases: Array<{ clients: PrismaClient[]; directory: string }> = [];

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const { clients, directory } of databases.splice(0)) {
		await Promise.all(clients.map(async (client) => await client.$disconnect()));
		await rm(directory, { recursive: true, force: true });
	}
});

async function createDatabase(): Promise<{ first: PrismaClient; second: PrismaClient }> {
	const directory = await mkdtemp(join(tmpdir(), "qui-drawer-recovery-"));
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
	await first.user.create({ data: { id: "user-1", username: "q-drawer-test" } });
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
		encryptor: new Encryptor("x".repeat(32)),
		log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
	} as unknown as FastifyInstance;
}

function makeClient(overrides: Partial<QuiClient> = {}): QuiClient {
	return {
		listInstances: vi.fn().mockResolvedValue([{ id: 7, connected: true, isActive: true }]),
		getTorrentsByHash: vi
			.fn()
			.mockImplementation(async (hash: string) => [{ hash, instanceId: 7 }]),
		getTrackers: vi.fn().mockResolvedValue([
			{
				url: "https://tracker.example/announce?passkey=private-token",
				status: 2,
				health: "working",
				msg: "private tracker response",
				numSeeds: 4,
				numLeeches: 1,
				numPeers: 5,
				tier: 0,
			},
		]),
		bulkAction: vi.fn().mockResolvedValue(undefined),
		renameTorrent: vi.fn().mockResolvedValue(undefined),
		addTrackers: vi.fn().mockResolvedValue(undefined),
		removeTrackers: vi.fn().mockResolvedValue(undefined),
		editTracker: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as QuiClient;
}

function runBulk(app: FastifyInstance, client: QuiClient, hash: string) {
	return executeQuiAction({
		app,
		client,
		userId: "user-1",
		serviceInstanceId: "qui-1",
		qbitInstanceId: 7,
		hashes: [hash],
		action: "pause",
	});
}

function runDrawer(
	app: FastifyInstance,
	client: QuiClient,
	hash: string,
	operation: QuiDrawerActionInput,
	serviceInstanceId = "qui-1",
	userId = "user-1",
) {
	return executeQuiDrawerAction({
		app,
		client,
		userId,
		serviceInstanceId,
		qbitInstanceId: 7,
		hash,
		operation,
	});
}

describe("qUI drawer action durable recovery against SQLite", { timeout: 30_000 }, () => {
	it("retains a restart-visible rename hold and does not persist the private name", async () => {
		const { first, second } = await createDatabase();
		const firstClient = makeClient({
			renameTorrent: vi.fn().mockRejectedValue(new Error("response lost after dispatch")),
		});
		const retryClient = makeClient();
		const bulkRetryClient = makeClient();
		const input = {
			action: "renameTorrent",
			input: { name: "Private requested torrent name" },
		} as const;

		const uncertain = await runDrawer(makeApp(first), firstClient, HASH_A, input);
		const blocked = await runDrawer(makeApp(second), retryClient, HASH_A, input);
		const bulkBlocked = await runBulk(makeApp(second), bulkRetryClient, HASH_A);
		const audit = await second.quiActionLog.findFirstOrThrow({ where: { torrentHash: HASH_A } });

		expect(uncertain.status).toBe("uncertain");
		expect(blocked.status).toBe("failed");
		expect(bulkBlocked.status).toBe("failed");
		expect(firstClient.renameTorrent).toHaveBeenCalledTimes(1);
		expect(retryClient.renameTorrent).not.toHaveBeenCalled();
		expect(bulkRetryClient.bulkAction).not.toHaveBeenCalled();
		expect(audit.action).toBe("renameTorrent");
		expect(audit.payload).toBeNull();
		expect(audit.status).toBe("uncertain");
		expect(await second.quiActionClaim.count({ where: { torrentHash: HASH_A } })).toBe(1);
	});

	it("re-resolves a stale selector after another client's successful release", async () => {
		const { first, second } = await createDatabase();
		const app = makeApp(first);
		const providerTrackers = [
			{
				url: "https://tracker.example/announce?passkey=private-token",
				status: 2,
				health: "working" as const,
				msg: "private tracker response",
				numSeeds: 4,
				numLeeches: 1,
				numPeers: 5,
				tier: 0,
			},
		];
		const selector = projectQuiTrackerViews(
			app.encryptor,
			{ userId: "user-1", serviceInstanceId: "qui-1", qbitInstanceId: 7, hash: HASH_A },
			providerTrackers,
		)[0]!.trackerSelector!;
		let enterTransaction!: () => void;
		let allowTransaction!: () => void;
		const transactionEntered = new Promise<void>((resolve) => {
			enterTransaction = resolve;
		});
		const transactionGate = new Promise<void>((resolve) => {
			allowTransaction = resolve;
		});
		const originalTransaction = first.$transaction.bind(first);
		let firstTransaction = true;
		vi.spyOn(first, "$transaction").mockImplementation((async (callback: unknown) => {
			if (firstTransaction) {
				firstTransaction = false;
				enterTransaction();
				await transactionGate;
			}
			return await (originalTransaction as (callback: unknown) => Promise<unknown>)(callback);
		}) as never);
		const staleClient = makeClient({
			getTrackers: vi.fn().mockImplementation(async () => providerTrackers),
			removeTrackers: vi.fn(),
		});
		const editingClient = makeClient({
			getTrackers: vi.fn().mockImplementation(async () => providerTrackers),
			editTracker: vi.fn().mockImplementation(async () => {
				providerTrackers[0] = {
					...providerTrackers[0]!,
					url: "https://tracker.example/new-announce?passkey=rotated-token",
				};
			}),
		});
		const removeRequestedAt = new Date("2026-10-07T10:00:00.000Z");
		const editRequestedAt = new Date("2026-10-07T10:00:01.000Z");
		// Mock Date only; database timeouts and transaction gates keep real timers.
		vi.setSystemTime(removeRequestedAt);
		const delayed = runDrawer(makeApp(first), staleClient, HASH_A, {
			action: "removeTrackers",
			input: { trackerSelectors: [selector] },
		});
		await transactionEntered;
		vi.setSystemTime(editRequestedAt);
		const intervening = await runDrawer(makeApp(second), editingClient, HASH_A, {
			action: "editTracker",
			input: { trackerSelectors: [selector], newURL: "https://tracker.example/new-announce" },
		});
		const claimsReleasedBeforeDelayedClaim = await second.quiActionClaim.count({
			where: { torrentHash: HASH_A },
		});
		allowTransaction();
		const delayedResult = await delayed;
		const rows = await second.quiActionLog.findMany({
			where: { torrentHash: HASH_A },
			orderBy: { requestedAt: "asc" },
		});

		expect(intervening.status).toBe("success");
		expect(claimsReleasedBeforeDelayedClaim).toBe(0);
		expect(delayedResult.status).toBe("failed");
		expect(delayedResult.error).toContain("no command was dispatched");
		expect(staleClient.removeTrackers).not.toHaveBeenCalled();
		expect(rows).toHaveLength(2);
		const editAudit = rows.find((row) => row.action === "editTracker")!;
		const removeAudit = rows.find((row) => row.action === "removeTrackers")!;
		expect(editAudit).toMatchObject({ status: "success", requestedAt: editRequestedAt });
		expect(removeAudit).toMatchObject({ status: "failed", requestedAt: removeRequestedAt });
		expect(editAudit.completedAt).not.toBeNull();
		expect(removeAudit.completedAt).not.toBeNull();
		expect(await second.quiActionClaim.count({ where: { torrentHash: HASH_A } })).toBe(0);
	});

	it("repeats the live target guard under claim before preparing dispatch", async () => {
		const { first, second } = await createDatabase();
		const getTorrentsByHash = vi
			.fn()
			.mockResolvedValueOnce([{ hash: HASH_A, instanceId: 7 }])
			.mockResolvedValueOnce([]);
		const client = makeClient({ getTorrentsByHash });
		const result = await runDrawer(makeApp(first), client, HASH_A, {
			action: "renameTorrent",
			input: { name: "Target disappeared before dispatch" },
		});
		const audit = await second.quiActionLog.findFirstOrThrow({ where: { torrentHash: HASH_A } });

		expect(getTorrentsByHash).toHaveBeenCalledTimes(2);
		expect(result.status).toBe("failed");
		expect(result.error).toContain("no command was dispatched");
		expect(client.renameTorrent).not.toHaveBeenCalled();
		expect(audit.status).toBe("failed");
		expect(audit.completedAt).not.toBeNull();
		expect(await second.quiActionClaim.count({ where: { torrentHash: HASH_A } })).toBe(0);
	});

	it("acknowledges and releases claims for all four drawer operations", async () => {
		const { first, second } = await createDatabase();
		const app = makeApp(first);
		const client = makeClient();
		const trackers = await client.getTrackers(7, HASH_A);
		const selector = projectQuiTrackerViews(
			app.encryptor,
			{
				userId: "user-1",
				serviceInstanceId: "qui-1",
				qbitInstanceId: 7,
				hash: HASH_A,
			},
			trackers,
		)[0]!.trackerSelector!;
		const operations: QuiDrawerActionInput[] = [
			{ action: "renameTorrent", input: { name: "Private exact name" } },
			{
				action: "addTrackers",
				input: { urls: ["https://new.example/announce?passkey=private-add"] },
			},
			{ action: "removeTrackers", input: { trackerSelectors: [selector] } },
			{
				action: "editTracker",
				input: {
					trackerSelectors: [selector],
					newURL: "https://edit.example/announce?passkey=private-edit",
				},
			},
		];

		for (const operation of operations) {
			const result = await runDrawer(app, client, HASH_A, operation);
			expect(result.status).toBe("success");
			expect(await second.quiActionClaim.count({ where: { torrentHash: HASH_A } })).toBe(0);
		}
		const rows = await second.quiActionLog.findMany({
			where: { torrentHash: HASH_A },
			orderBy: { requestedAt: "asc" },
		});
		expect(rows.map((row) => row.action)).toEqual([
			"renameTorrent",
			"addTrackers",
			"removeTrackers",
			"editTracker",
		]);
		expect(rows.every((row) => row.status === "success" && row.completedAt !== null)).toBe(true);
		expect(rows.map((row) => row.payload)).toEqual([
			null,
			JSON.stringify({ trackerCount: 1 }),
			JSON.stringify({ trackerCount: 1 }),
			JSON.stringify({ trackerCount: 1 }),
		]);
		expect(JSON.stringify(rows)).not.toContain("Private exact name");
		expect(JSON.stringify(rows)).not.toContain("private-add");
		expect(JSON.stringify(rows)).not.toContain("private-edit");
		expect(client.removeTrackers).toHaveBeenCalledWith(7, HASH_A, [
			"https://tracker.example/announce?passkey=private-token",
		]);
		expect(client.editTracker).toHaveBeenCalledWith(
			7,
			HASH_A,
			"https://tracker.example/announce?passkey=private-token",
			"https://edit.example/announce?passkey=private-edit",
		);
	});

	it("fences drawer actions behind a bulk hold across owners and connection aliases", async () => {
		const { first, second } = await createDatabase();
		await first.user.create({ data: { id: "user-2", username: "q-drawer-other" } });
		await first.serviceInstance.createMany({
			data: [
				{
					id: "qui-alias",
					userId: "user-1",
					service: "QUI",
					label: "alias",
					baseUrl: "http://qui.invalid",
					encryptedApiKey: "encrypted",
					encryptionIv: "iv",
				},
				{
					id: "qui-other-owner",
					userId: "user-2",
					service: "QUI",
					label: "other owner",
					baseUrl: "http://qui.invalid",
					encryptedApiKey: "encrypted",
					encryptionIv: "iv",
				},
			],
		});
		const bulkClient = makeClient({
			bulkAction: vi.fn().mockRejectedValue(new Error("response lost")),
		});
		const drawerClient = makeClient();
		const uncertain = await runBulk(makeApp(first), bulkClient, HASH_A);
		const alias = await runDrawer(
			makeApp(second),
			drawerClient,
			HASH_A,
			{ action: "addTrackers", input: { urls: ["https://new.example/announce?passkey=private"] } },
			"qui-alias",
		);
		const otherOwner = await runDrawer(
			makeApp(second),
			drawerClient,
			HASH_A,
			{ action: "renameTorrent", input: { name: "another name" } },
			"qui-other-owner",
			"user-2",
		);

		expect(uncertain.status).toBe("uncertain");
		expect(alias.status).toBe("failed");
		expect(otherOwner.status).toBe("failed");
		expect(drawerClient.addTrackers).not.toHaveBeenCalled();
		expect(drawerClient.renameTorrent).not.toHaveBeenCalled();
		expect(await second.quiActionLog.count({ where: { torrentHash: HASH_A } })).toBe(1);
	});

	it("stores only a tracker count and preserves all-or-nothing dispatch", async () => {
		const { first, second } = await createDatabase();
		const client = makeClient();
		const failedSelection = await runDrawer(makeApp(first), client, HASH_A, {
			action: "removeTrackers",
			input: { hostnames: ["tracker.example", "missing.example"] },
		});
		expect(failedSelection.status).toBe("failed");
		expect(client.removeTrackers).not.toHaveBeenCalled();
		expect(await first.quiActionClaim.count({ where: { torrentHash: HASH_A } })).toBe(0);
		const failedAudit = await second.quiActionLog.findFirstOrThrow({
			where: { torrentHash: HASH_A },
		});
		expect(failedAudit.action).toBe("removeTrackers");
		expect(failedAudit.status).toBe("failed");
		expect(failedAudit.completedAt).not.toBeNull();
		expect(failedAudit.error).toContain("no command was dispatched");
		expect(failedAudit.error).not.toContain("missing.example");

		const completed = await runDrawer(makeApp(first), client, HASH_B, {
			action: "addTrackers",
			input: { urls: ["https://new.example/announce?passkey=do-not-retain"] },
		});
		const audit = await second.quiActionLog.findFirstOrThrow({ where: { torrentHash: HASH_B } });
		expect(completed.status).toBe("success");
		expect(JSON.parse(audit.payload!)).toEqual({ trackerCount: 1 });
		expect(audit.payload).not.toContain("do-not-retain");
		expect(audit.payload).not.toContain("new.example");
		expect(client.addTrackers).toHaveBeenCalledWith(7, HASH_B, [
			"https://new.example/announce?passkey=do-not-retain",
		]);
	});

	it("serializes concurrent bulk and drawer attempts through the real unique claim", async () => {
		const { first, second } = await createDatabase();
		let started!: () => void;
		let finish!: () => void;
		const dispatchStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const holdDispatch = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const bulkClient = makeClient({
			bulkAction: vi.fn().mockImplementation(async () => {
				started();
				await holdDispatch;
			}),
		});
		const drawerClient = makeClient();
		const bulkPromise = runBulk(makeApp(first), bulkClient, HASH_A);
		await dispatchStarted;
		const drawerResult = await runDrawer(makeApp(second), drawerClient, HASH_A, {
			action: "renameTorrent",
			input: { name: "concurrent name" },
		});
		expect(drawerResult.status).toBe("failed");
		expect(drawerClient.renameTorrent).not.toHaveBeenCalled();
		finish();
		expect((await bulkPromise).status).toBe("success");
		expect(bulkClient.bulkAction).toHaveBeenCalledTimes(1);
	});

	it("retains a truthful no-dispatch hold when preflight-abort bookkeeping fails", async () => {
		const { first, second } = await createDatabase();
		const originalTransaction = first.$transaction.bind(first);
		let transactionNumber = 0;
		vi.spyOn(first, "$transaction").mockImplementation((async (callback: unknown) => {
			transactionNumber += 1;
			if (transactionNumber === 2) throw new Error("synthetic abort transaction failure");
			return await (originalTransaction as (callback: unknown) => Promise<unknown>)(callback);
		}) as never);
		const client = makeClient();
		const result = await runDrawer(makeApp(first), client, HASH_A, {
			action: "removeTrackers",
			input: { hostnames: ["missing.example"] },
		});
		const audit = await second.quiActionLog.findFirstOrThrow({ where: { torrentHash: HASH_A } });

		expect(result.status).toBe("audit_unsettled");
		expect(result.error).toContain("No qUI command was dispatched");
		expect(result.error).not.toContain("acknowledged");
		expect(client.removeTrackers).not.toHaveBeenCalled();
		expect(audit.status).toBe("pending");
		expect(await second.quiActionClaim.count({ where: { torrentHash: HASH_A } })).toBe(1);
	});

	it("does not dispatch or overwrite a revoked attempt after a final read resumes", async () => {
		const { first, second } = await createDatabase();
		const app = makeApp(first);
		const initialClient = makeClient();
		const trackers = await initialClient.getTrackers(7, HASH_A);
		const selector = projectQuiTrackerViews(
			app.encryptor,
			{ userId: "user-1", serviceInstanceId: "qui-1", qbitInstanceId: 7, hash: HASH_A },
			trackers,
		)[0]!.trackerSelector!;
		let finishFinalRead!: () => void;
		let finalReadStarted!: () => void;
		const finalReadGate = new Promise<void>((resolve) => {
			finishFinalRead = resolve;
		});
		const finalReadReached = new Promise<void>((resolve) => {
			finalReadStarted = resolve;
		});
		const slowClient = makeClient({
			getTrackers: vi.fn().mockImplementation(async () => {
				finalReadStarted();
				await finalReadGate;
				return trackers;
			}),
			removeTrackers: vi.fn(),
		});
		const slowedAttempt = runDrawer(app, slowClient, HASH_A, {
			action: "removeTrackers",
			input: { trackerSelectors: [selector] },
		});
		await finalReadReached;
		const oldRow = await second.quiActionLog.findFirst({ where: { torrentHash: HASH_A } });
		const heldClaimCount = await second.quiActionClaim.count({ where: { torrentHash: HASH_A } });
		let resolution: string | null = null;
		let replacementResult: Awaited<ReturnType<typeof runDrawer>> | null = null;
		if (oldRow) {
			await second.quiActionLog.update({
				where: { id: oldRow.id },
				data: { requestedAt: new Date(Date.now() - 5 * 60_000) },
			});
			resolution = await reconcileQuiAction({
				prisma: second,
				userId: "user-1",
				actionLogId: oldRow.id,
				decision: "not_applied",
			});
			replacementResult = await runDrawer(makeApp(second), makeClient(), HASH_A, {
				action: "renameTorrent",
				input: { name: "Authorized replacement attempt" },
			});
		}
		finishFinalRead();
		const staleResult = await slowedAttempt;
		const attempts = await second.quiActionLog.findMany({
			where: { torrentHash: HASH_A },
			orderBy: { requestedAt: "asc" },
		});

		expect(oldRow).not.toBeNull();
		expect(heldClaimCount).toBe(1);
		expect(resolution).toBe("operator_verified_not_applied");
		expect(replacementResult?.status).toBe("success");
		expect(staleResult.status).toBe("failed");
		expect(staleResult.error).toContain("no qUI command was dispatched");
		expect(slowClient.removeTrackers).not.toHaveBeenCalled();
		expect(attempts).toHaveLength(2);
		expect(attempts[0]!.status).toBe("operator_verified_not_applied");
		expect(attempts[1]!.action).toBe("renameTorrent");
		expect(attempts[1]!.status).toBe("success");
		expect(attempts[0]!.attemptId).not.toBe(attempts[1]!.attemptId);
		expect(await second.quiActionClaim.count({ where: { torrentHash: HASH_A } })).toBe(0);
	});

	it("keeps a drawer claim when acknowledged dispatch bookkeeping cannot finalize", async () => {
		const { first, second } = await createDatabase();
		const originalTransaction = first.$transaction.bind(first);
		let transactionNumber = 0;
		vi.spyOn(first, "$transaction").mockImplementation((async (callback: unknown) => {
			transactionNumber += 1;
			if (transactionNumber === 3) throw new Error("synthetic finalization failure");
			return await (originalTransaction as (callback: unknown) => Promise<unknown>)(callback);
		}) as never);
		const client = makeClient();
		const result = await runDrawer(makeApp(first), client, HASH_A, {
			action: "renameTorrent",
			input: { name: "Acknowledged but not finalized" },
		});
		const audit = await second.quiActionLog.findFirstOrThrow({ where: { torrentHash: HASH_A } });
		expect(result.status).toBe("audit_unsettled");
		expect(client.renameTorrent).toHaveBeenCalledOnce();
		expect(audit.status).toBe("pending");
		expect(audit.payload).toBeNull();
		expect(await second.quiActionClaim.count({ where: { torrentHash: HASH_A } })).toBe(1);
	});

	it("requires explicit reconciliation before another drawer attempt and uses a new attempt fence", async () => {
		const { first, second } = await createDatabase();
		const firstClient = makeClient({
			renameTorrent: vi.fn().mockRejectedValue(new Error("response lost")),
		});
		const firstAttempt = await runDrawer(makeApp(first), firstClient, HASH_A, {
			action: "renameTorrent",
			input: { name: "First attempt" },
		});
		const original = await second.quiActionLog.findFirstOrThrow({ where: { torrentHash: HASH_A } });
		const beforeDecision = await runDrawer(makeApp(second), makeClient(), HASH_A, {
			action: "renameTorrent",
			input: { name: "Do not replay automatically" },
		});
		expect(firstAttempt.status).toBe("uncertain");
		expect(beforeDecision.status).toBe("failed");
		await second.quiActionLog.update({
			where: { id: original.id },
			data: { requestedAt: new Date(Date.now() - 5 * 60_000) },
		});
		const decision = await reconcileQuiAction({
			prisma: second,
			userId: "user-1",
			actionLogId: original.id,
			decision: "not_applied",
		});
		expect(decision).toBe("operator_verified_not_applied");
		expect(await second.quiActionClaim.count({ where: { torrentHash: HASH_A } })).toBe(0);
		const retryClient = makeClient();
		const retry = await runDrawer(makeApp(second), retryClient, HASH_A, {
			action: "renameTorrent",
			input: { name: "Operator authorized new attempt" },
		});
		const attempts = await second.quiActionLog.findMany({
			where: { torrentHash: HASH_A },
			orderBy: { requestedAt: "asc" },
		});
		expect(retry.status).toBe("success");
		expect(attempts).toHaveLength(2);
		expect(attempts[0]!.attemptId).not.toBe(attempts[1]!.attemptId);
		expect(retryClient.renameTorrent).toHaveBeenCalledOnce();
	});
});
