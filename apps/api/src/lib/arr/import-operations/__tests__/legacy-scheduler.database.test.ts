import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LidarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../../__tests__/test-prisma.js";
import { Encryptor } from "../../../auth/encryption.js";
import {
	withCleanupMaintenanceGuard,
	withExclusiveCleanupOperationGuard,
} from "../../../library-cleanup/cleanup-maintenance-gate.js";
import {
	importConnectionFingerprint,
	queueDownloadKey,
} from "../../../queue-cleaner/import-receipt.js";
import { importCommandFingerprint } from "../../manual-import-command.js";
import { observeLegacyImport } from "../legacy-observation.js";
import { IMPORT_OBSERVATION_FAILURE, ImportOperationScheduler } from "../scheduler.js";

let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;
const encryptor = new Encryptor(Buffer.alloc(32, 17).toString("base64"));
const log = { info: vi.fn(), warn: vi.fn() };
let now: Date;
const providers = new Map<string, SonarrClient | RadarrClient | LidarrClient | ReadarrClient>();
const commands = new Map<number, Record<string, unknown>>();
const histories = new Map<string, unknown[]>();
const reads: Array<{ instanceId: string; path: string }> = [];
const posts = vi.fn();
let sequence = 0;
beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "arr-import-legacy-scheduler-"));
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: `file:${join(directory, "fixture.db")}` },
		stdio: "pipe",
	});
	prisma = createTestPrismaClient(`file:${join(directory, "fixture.db")}`);
}, 30_000);
beforeEach(async () => {
	await prisma.user.deleteMany();
	await prisma.user.createMany({
		data: [
			{ id: "owner", username: "synthetic" },
			{ id: "other", username: "synthetic-other" },
		],
	});
	providers.clear();
	commands.clear();
	histories.clear();
	reads.length = 0;
	sequence = 0;
	now = new Date();
	vi.clearAllMocks();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});
const services = [
	{
		service: "SONARR",
		Client: SonarrClient,
		media: { seriesId: 12, episodeIds: [13] },
		event: "downloadFolderImported",
	},
	{
		service: "RADARR",
		Client: RadarrClient,
		media: { movieId: 12 },
		event: "downloadFolderImported",
	},
	{
		service: "LIDARR",
		Client: LidarrClient,
		media: { artistId: 12, albumId: 13 },
		event: "trackFileImported",
	},
	{
		service: "READARR",
		Client: ReadarrClient,
		media: { authorId: 12, bookId: 13 },
		event: "bookFileImported",
	},
] as const;
async function receipt(
	id: string,
	instanceId = "instance",
	userId = "owner",
	item: (typeof services)[number] = services[1],
	state = "pending",
) {
	const instance = await prisma.serviceInstance.upsert({
		where: { id: instanceId },
		create: {
			id: instanceId,
			userId,
			service: item.service,
			label: "Synthetic private label",
			baseUrl: "https://fixture.invalid",
			encryptedApiKey: "synthetic-cipher",
			encryptionIv: "synthetic-iv",
		},
		update: {},
	});
	const file = {
		path: `/synthetic/${id}`,
		downloadId: `source-${id}`,
		...item.media,
		...(item.service === "SONARR" ? { episodeIds: [13] } : {}),
	};
	const commandId = ++sequence + 50;
	const started = new Date(now.getTime() - 4_000);
	const saved = await prisma.queueCleanerImportReceipt.create({
		data: {
			id,
			instanceId,
			downloadKey: queueDownloadKey(file)!,
			queueId: commandId,
			downloadTitle: "Synthetic private title",
			connectionFingerprint: importConnectionFingerprint(instance),
			commandFingerprint: importCommandFingerprint([file])!,
			commandId,
			state,
			lastAttemptAt: started,
		},
	});
	commands.set(commandId, {
		id: commandId,
		name: "ManualImport",
		status: "completed",
		result: "successful",
		queued: new Date(started.getTime() + 1).toISOString(),
		ended: new Date(started.getTime() + 2_000).toISOString(),
		body: { importMode: "Move", files: [file] },
	});
	histories.set(file.downloadId, [
		{
			eventType: item.event,
			downloadId: file.downloadId,
			...item.media,
			episodeId: item.service === "SONARR" ? 13 : undefined,
			date: new Date(started.getTime() + 1_000).toISOString(),
			data: { droppedPath: file.path, fileId: 31 },
		},
	]);
	if (!providers.has(instanceId)) {
		const client = new item.Client({ baseUrl: "https://fixture.invalid", apiKey: "synthetic-key" });
		vi.spyOn(client, "get").mockImplementation(async (path, options) => {
			reads.push({ instanceId, path: String(path) });
			if (String(path).includes("/command/"))
				return (commands.get(Number(String(path).split("/").at(-1))) ?? {}) as never;
			if (String(path).endsWith("/history")) {
				const query = options as { downloadId: string; page: number; pageSize: number };
				const rows = histories.get(query.downloadId) ?? [];
				return {
					page: query.page,
					pageSize: query.pageSize,
					totalRecords: rows.length,
					records: rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
				} as never;
			}
			throw new Error("Unexpected provider read");
		});
		vi.spyOn(client, "post").mockImplementation(posts);
		providers.set(instanceId, client);
	}
	return saved;
}
function context(database = prisma) {
	return {
		prisma: database,
		encryptor,
		now: () => now,
		createClient: (instance: { id: string }) => {
			const client = providers.get(instance.id);
			if (!client) throw new Error("Provider unavailable");
			return client;
		},
	};
}
function worker(database = prisma) {
	return new ImportOperationScheduler(context(database), log as never);
}

describe("registered observer legacy recovery on populated SQLite", () => {
	it("keeps pending legacy work observable across scheduler restart until positive terminal evidence", async () => {
		const saved = await receipt("receipt");
		const terminal = commands.get(saved.commandId!) as Record<string, unknown>;
		commands.set(saved.commandId!, { ...terminal, status: "started", ended: undefined });
		const scheduler = worker();
		await scheduler.tick();
		expect(
			await prisma.arrImportOperation.findFirst({
				where: { userId: "owner", legacyReceiptId: saved.id },
			}),
		).toMatchObject({
			state: "pending",
			commandTerminal: false,
			selectedFileCount: 1,
			verifiedFileCount: 0,
		});
		await scheduler.tick();
		expect(reads.some((read) => read.path.endsWith("/history"))).toBe(false);
		expect(await prisma.arrImportFileProof.count({ where: { verifiedAt: { not: null } } })).toBe(0);
		commands.set(saved.commandId!, terminal);
		now = new Date(now.getTime() + 60_001);
		const peer = createTestPrismaClient(`file:${join(directory, "fixture.db")}`);
		try {
			await worker(peer).tick();
			expect(
				await peer.arrImportOperation.findFirst({
					where: { userId: "owner", legacyReceiptId: saved.id },
				}),
			).toMatchObject({ state: "completed", selectedFileCount: 1, verifiedFileCount: 1 });
		} finally {
			await peer.$disconnect();
		}
		expect(
			await prisma.queueCleanerImportReceipt.findFirst({
				where: { id: saved.id, instance: { userId: "owner" } },
			}),
		).toEqual(saved);
		expect(await prisma.arrImportSourceClaim.count()).toBe(0);
		expect(posts).not.toHaveBeenCalled();
	});
	it("discovers all four services then reconciles positive file progress without submitting", async () => {
		const original = await Promise.all(
			services.map((item, index) =>
				receipt(`receipt-${index}`, `instance-${index}`, index === 3 ? "other" : "owner", item),
			),
		);
		const scheduler = worker();
		await scheduler.tick();
		expect(await prisma.arrImportOperation.count()).toBe(4);
		expect(await prisma.arrImportFileProof.count({ where: { verifiedAt: { not: null } } })).toBe(0);
		expect(reads).toHaveLength(4);
		await scheduler.tick();
		expect(
			await prisma.arrImportOperation.count({
				where: { state: "completed", selectedFileCount: 1, verifiedFileCount: 1 },
			}),
		).toBe(4);
		for (const saved of original)
			expect(
				await prisma.queueCleanerImportReceipt.findFirst({
					where: {
						id: saved.id,
						instance: { userId: saved.instanceId === "instance-3" ? "other" : "owner" },
					},
				}),
			).toEqual(saved);
		expect(posts).not.toHaveBeenCalled();
	});
	it("rotates past unreadable receipts on one connection without altering their history", async () => {
		const original = await receipt("receipt-0");
		commands.delete(original.commandId!);
		for (let index = 1; index < 6; index++) await receipt(`receipt-${index}`);
		const scheduler = worker();
		for (let index = 0; index < 12; index++)
			await scheduler.tick().catch((error) => {
				expect(error.message).toBe(IMPORT_OBSERVATION_FAILURE);
			});
		expect(await prisma.arrImportOperation.count()).toBe(5);
		expect(await prisma.arrImportOperation.count({ where: { state: "completed" } })).toBe(5);
		expect(
			await prisma.queueCleanerImportReceipt.findFirst({
				where: { id: original.id, instance: { userId: "owner" } },
			}),
		).toEqual(original);
		expect(
			reads.filter((read) => read.path.endsWith(`/command/${original.commandId}`)),
		).toHaveLength(1);
		expect(posts).not.toHaveBeenCalled();
	});
	it("caps connections and does not let one large legacy connection starve other owners", async () => {
		for (let index = 0; index < 6; index++) await receipt(`receipt-a-${index}`, "instance-0");
		for (let index = 1; index < 7; index++)
			await receipt(`receipt-b-${index}`, `instance-${index}`, index === 6 ? "other" : "owner");
		const scheduler = worker();
		await scheduler.tick();
		expect(reads).toHaveLength(4);
		expect(new Set(reads.map((read) => read.instanceId)).size).toBe(4);
		for (let index = 0; index < 6; index++) await scheduler.tick();
		const linked = await prisma.arrImportOperation.findMany({
			select: { originalInstanceId: true, userId: true },
		});
		expect(new Set(linked.map((row) => row.originalInstanceId)).size).toBe(7);
		expect(linked).toContainEqual({ originalInstanceId: "instance-6", userId: "other" });
		expect(posts).not.toHaveBeenCalled();
	});
	it("advances past another connection's unreadable receipt independently of the first backlog", async () => {
		for (let index = 0; index < 20; index++)
			await receipt(`a-${String(index).padStart(3, "0")}`, "instance-a");
		const unreadable = await receipt("b-000", "instance-b", "other");
		const valid = await receipt("b-001", "instance-b", "other");
		commands.delete(unreadable.commandId!);
		const scheduler = worker();
		for (let tick = 0; tick < 4; tick++)
			await scheduler
				.tick()
				.catch((error) => expect(error.message).toBe(IMPORT_OBSERVATION_FAILURE));
		expect(
			await prisma.arrImportOperation.findFirst({
				where: { userId: "other", legacyReceiptId: valid.id },
			}),
		).toMatchObject({ selectedFileCount: 1, verifiedFileCount: 1, state: "completed" });
		expect(
			await prisma.arrImportOperation.count({ where: { originalInstanceId: "instance-a" } }),
		).toBeLessThan(20);
		expect(
			await prisma.queueCleanerImportReceipt.findFirst({
				where: { id: unreadable.id, instance: { userId: "other" } },
			}),
		).toEqual(unreadable);
		expect(
			reads.filter((read) => read.path.endsWith(`/command/${unreadable.commandId}`)),
		).toHaveLength(1);
		expect(posts).not.toHaveBeenCalled();
	});
	it("a fresh scheduler and database client resume adopted work without rediscovery or POST", async () => {
		await receipt("receipt");
		await worker().tick();
		reads.length = 0;
		const peer = createTestPrismaClient(`file:${join(directory, "fixture.db")}`);
		try {
			await worker(peer).tick();
			expect(
				await peer.arrImportOperation.count({ where: { userId: "owner", state: "completed" } }),
			).toBe(1);
			expect(reads.filter((read) => read.path.includes("/command/"))).toHaveLength(1);
			expect(posts).not.toHaveBeenCalled();
		} finally {
			await peer.$disconnect();
		}
	});
	it("alternates legacy discovery with already tracked work even when that provider is unavailable", async () => {
		const first = await receipt("receipt-a", "instance-a");
		expect((await observeLegacyImport(context(), "owner", first.id)).kind).toBe("bound");
		commands.delete(first.commandId!);
		const second = await receipt("receipt-b", "instance-b");
		const scheduler = worker();
		await expect(scheduler.tick()).rejects.toThrow(IMPORT_OBSERVATION_FAILURE);
		await scheduler.tick();
		expect(
			await prisma.arrImportOperation.findFirst({
				where: { userId: "owner", legacyReceiptId: second.id },
			}),
		).toMatchObject({ state: "unknown", verifiedFileCount: 0 });
		expect(posts).not.toHaveBeenCalled();
	});
	it("isolates unknown states and disabled connections without provider reads", async () => {
		await receipt("unknown", "unknown-instance", "owner", services[1], "future-state");
		await receipt("disabled", "disabled-instance");
		await prisma.serviceInstance.update({
			where: { id: "disabled-instance" },
			data: { enabled: false },
		});
		await worker().tick();
		expect(reads).toHaveLength(0);
		expect(await prisma.arrImportOperation.count()).toBe(0);
	});
	it("honors maintenance before discovering or linking legacy rows", async () => {
		await receipt("receipt");
		await withCleanupMaintenanceGuard(async () => {
			await expect(worker().tick()).rejects.toThrow();
		});
		expect(reads).toHaveLength(0);
		expect(await prisma.arrImportOperation.count()).toBe(0);
	});
	it("backs off a completed unavailable sweep, then retries current evidence without POST", async () => {
		const saved = await receipt("receipt");
		const command = commands.get(saved.commandId!)!;
		commands.delete(saved.commandId!);
		const scheduler = worker();
		await expect(scheduler.tick()).rejects.toThrow(IMPORT_OBSERVATION_FAILURE);
		for (let index = 0; index < 20; index++) await scheduler.tick();
		expect(reads).toHaveLength(1);
		expect(await prisma.arrImportOperation.count()).toBe(0);
		commands.set(saved.commandId!, command);
		now = new Date(now.getTime() + 60_001);
		await scheduler.tick();
		expect(await prisma.arrImportOperation.count()).toBe(1);
		expect(reads).toHaveLength(2);
		expect(posts).not.toHaveBeenCalled();
	});
	it("discovers a lower-ID receipt added during a sweep on the next bounded sweep", async () => {
		await receipt("z-receipt-1");
		await receipt("z-receipt-2");
		const scheduler = worker();
		await scheduler.tick();
		await scheduler.tick();
		const added = await receipt("a-new-receipt");
		await scheduler.tick();
		await scheduler.tick();
		expect(
			await prisma.arrImportOperation.findFirst({
				where: { userId: "owner", legacyReceiptId: added.id },
			}),
		).toBeNull();
		now = new Date(now.getTime() + 60_001);
		await scheduler.tick();
		expect(
			await prisma.arrImportOperation.findFirst({
				where: { userId: "owner", legacyReceiptId: added.id },
			}),
		).toMatchObject({ selectedFileCount: 1, verifiedFileCount: 0 });
		await scheduler.tick();
		expect(
			await prisma.arrImportOperation.findFirst({
				where: { userId: "owner", legacyReceiptId: added.id },
			}),
		).toMatchObject({ state: "completed", selectedFileCount: 1, verifiedFileCount: 1 });
		expect(posts).not.toHaveBeenCalled();
	});
	it("does not transfer legacy authority after connection identity changes", async () => {
		await receipt("receipt");
		await prisma.serviceInstance.update({
			where: { id: "instance" },
			data: { baseUrl: "https://other.invalid" },
		});
		await expect(worker().tick()).rejects.toThrow(IMPORT_OBSERVATION_FAILURE);
		expect(reads).toHaveLength(0);
		expect(await prisma.arrImportOperation.count()).toBe(0);
	});
	it("reports only aggregate categories when a provider throws private details", async () => {
		await receipt("receipt");
		vi.spyOn(providers.get("instance")!, "get").mockRejectedValue(
			new Error("private-sentinel-title-token-path"),
		);
		await expect(worker().tick()).rejects.toThrow(IMPORT_OBSERVATION_FAILURE);
		expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls])).not.toMatch(
			/private-sentinel|Synthetic private|source-receipt|fixture.invalid/,
		);
		expect(log.info).toHaveBeenCalledWith(
			expect.objectContaining({ legacyBoundCount: 0, unavailableCount: 1 }),
			expect.any(String),
		);
	});
	it("waits for an admitted legacy observer during shutdown and admits no other connection", async () => {
		await receipt("receipt-a", "instance-a");
		await receipt("receipt-b", "instance-b");
		let release!: (value: never) => void;
		let signal!: () => void;
		const began = new Promise<void>((resolve) => {
			signal = resolve;
		});
		const held = new Promise<never>((resolve) => {
			release = resolve;
		});
		vi.spyOn(providers.get("instance-a")!, "get").mockImplementationOnce(() => {
			signal();
			return held;
		});
		const scheduler = worker();
		const active = scheduler.tick();
		const started = await Promise.race([began.then(() => true), active.then(() => false)]);
		expect(started).toBe(true);
		if (!started) return;
		let closed = false;
		const closing = scheduler.stop().then(() => {
			closed = true;
		});
		try {
			await Promise.resolve();
			expect(closed).toBe(false);
			await expect(withExclusiveCleanupOperationGuard(async () => undefined)).rejects.toThrow();
		} finally {
			release(commands.get(51)! as never);
			await Promise.all([active, closing]);
		}
		expect(closed).toBe(true);
		expect(await prisma.arrImportOperation.count()).toBe(1);
		expect(reads.some((read) => read.instanceId === "instance-b")).toBe(false);
		await scheduler.tick();
		expect(await prisma.arrImportOperation.count()).toBe(1);
	});
});
