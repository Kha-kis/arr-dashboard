import { RadarrClient } from "arr-sdk";
import Database from "better-sqlite3";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	interceptScopedWriteCompetition,
	recordScopedWriteEvidence,
	snapshotProtectedRows,
} from "../../__tests__/scoped-write-intent-fixture.js";
import type { ArrClientFactory } from "../../arr/client-factory.js";
import type { Encryptor } from "../../auth/encryption.js";
import { RestoreRuntimeAdmissionError } from "../../backup/restore-runtime-admission.js";
import { type LibraryStreamFn, syncInstance } from "../sync-executor.js";

afterEach(closeScopedWriteFixtures);

async function fixture() {
	const f = await createScopedWriteFixture();
	const instance = await f.plain.serviceInstance.create({
		data: {
			id: "synthetic-radarr",
			userId: "synthetic-user",
			service: "RADARR",
			label: "Synthetic",
			baseUrl: "https://synthetic.invalid",
			encryptedApiKey: "synthetic-cipher",
			encryptionIv: "synthetic-iv",
		},
	});
	await f.plain.libraryCache.create({
		data: {
			id: "synthetic-library-row",
			instanceId: instance.id,
			arrItemId: 1,
			itemType: "movie",
			title: "Synthetic previous",
			sortTitle: "synthetic previous",
			monitored: true,
			hasFile: false,
			data: '{"tags":[]}',
		},
	});
	const client = new RadarrClient({ baseUrl: "https://synthetic.invalid", apiKey: "synthetic" });
	vi.spyOn(client.wanted, "cutoff").mockResolvedValue({
		page: 1,
		pageSize: 1000,
		sortKey: "title",
		sortDirection: "ascending",
		totalRecords: 0,
		records: [],
	});
	vi.spyOn(client.tag, "getAll").mockResolvedValue([]);
	const logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as FastifyBaseLogger;
	return {
		...f,
		instance,
		logger,
		run(streamLibraryItems: LibraryStreamFn) {
			return f.runtime.runOperation(() =>
				syncInstance(
					{
						prisma: f.client.prisma,
						arrClientFactory: { create: () => client } as unknown as ArrClientFactory,
						encryptor: {} as Encryptor,
						log: logger,
						streamLibraryItems,
					},
					instance,
				),
			);
		},
	};
}

const item = {
	id: 1,
	title: "Synthetic current",
	sortTitle: "synthetic current",
	monitored: true,
	hasFile: true,
	status: "released",
	qualityProfileId: 1,
	tags: [],
	images: [],
};

describe("Library sync batch write admission", { timeout: 30_000 }, () => {
	// An ordinary status UPDATE exhausts its connection-local admission deadline
	// here. Failure bookkeeping must use the available writer while this reader holds.
	it("settles failed sync status while the ordinary native reader is held without replay", async () => {
		const f = await fixture();
		const before = await f.plain.libraryCache.findMany();
		const protectedRows = snapshotProtectedRows(f);
		let release!: () => void;
		let entered!: () => void;
		let requestReader!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const requested = new Promise<void>((resolve) => {
			requestReader = resolve;
		});
		let streams = 0;
		let readerSettled = false;
		let writerAvailable = false;
		// Admit the competing operation outside the sync's context so its
		// legitimate ticket remains active until the held reader physically joins.
		const transaction = f.runtime.runOperation(async () => {
			await requested;
			await f.client.prisma.$transaction(
				async (tx) => {
					await tx.$queryRawUnsafe("SELECT value FROM CompetitionProbe WHERE id=1");
					entered();
					await gate;
				},
				{ timeout: 10_000 },
			);
			readerSettled = true;
		});
		try {
			const result = await f.run(async function* () {
				streams++;
				requestReader();
				await ready;
				f.writer.exec("BEGIN IMMEDIATE;ROLLBACK");
				writerAvailable = true;
				yield item;
				throw new Error("Synthetic catalog failure before publication");
			});
			const status = await f.plain.librarySyncStatus.findUniqueOrThrow({
				where: { instanceId: f.instance.id },
			});
			recordScopedWriteEvidence("library-status-reader-held-settlement", {
				result,
				status,
				streams,
				readerSettled,
				writerAvailable,
				losses: f.losses,
			});
			expect(result).toMatchObject({
				success: false,
				itemsProcessed: 0,
				itemsUpdated: 0,
				itemsAdded: 0,
				itemsRemoved: 0,
				newDownloads: [],
				error: "Synthetic catalog failure before publication",
			});
			expect(readerSettled).toBe(false);
			expect(writerAvailable).toBe(true);
			expect(streams).toBe(1);
			expect(await f.plain.libraryCache.findMany()).toEqual(before);
			expect(snapshotProtectedRows(f)).toEqual(protectedRows);
			expect(f.losses).toEqual([]);
			expect(status).toMatchObject({
				syncInProgress: false,
				lastFullSync: null,
				lastError: "Synthetic catalog failure before publication",
			});
		} finally {
			requestReader();
			release();
			await transaction;
		}
	});

	// The same generic category after an actual owner-lock loss is unsafe to
	// recover: neither settlement nor a fresh operation may write through it.
	it("refuses failed-sync settlement after actual native ownership loss", async () => {
		const handles = new Set<Database.Database>();
		const prepare = Database.prototype.prepare;
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			handles.add(this);
			return prepare.call(this, sql);
		});
		const f = await fixture();
		const before = await f.plain.libraryCache.findMany();
		const protectedRows = snapshotProtectedRows(f);
		let streams = 0;
		const result = await f.run(async function* () {
			streams++;
			const owner = [...handles].find(
				(db) => db.open && db.inTransaction && db.name.endsWith("/owner.sqlite3"),
			);
			expect(owner).toBeDefined();
			owner!.exec("ROLLBACK");
			throw new Error("Synthetic catalog failure before publication");
		});
		const status = await f.plain.librarySyncStatus.findUniqueOrThrow({
			where: { instanceId: f.instance.id },
		});
		const logged = vi
			.mocked(f.logger.error)
			.mock.calls.find((call) => call[1] === "Failed to update sync status with error");
		const refusal = (logged?.[0] as { err?: unknown } | undefined)?.err;
		recordScopedWriteEvidence("library-status-native-owner-loss", {
			result,
			status,
			streams,
			losses: f.losses,
			refusal: refusal instanceof Error ? { name: refusal.name, message: refusal.message } : null,
		});
		expect(result).toMatchObject({ success: false, itemsProcessed: 0, newDownloads: [] });
		expect(refusal).toBeInstanceOf(RestoreRuntimeAdmissionError);
		expect(streams).toBe(1);
		expect(status).toMatchObject({ syncInProgress: true, lastFullSync: null, lastError: null });
		expect(await f.plain.libraryCache.findMany()).toEqual(before);
		expect(snapshotProtectedRows(f)).toEqual(protectedRows);
		expect(f.losses).toEqual(["native-owner-unavailable"]);
		await expect(
			f.runtime.runOperation(() =>
				f.client.prisma.librarySyncStatus.update({
					where: { instanceId: f.instance.id },
					data: { syncInProgress: false },
				}),
			),
		).rejects.toBeInstanceOf(RestoreRuntimeAdmissionError);
	});

	// Break caught: an actual commit between guard reads and the cache UPDATE
	// invalidates an unreserved WAL snapshot and aborts this otherwise valid sync.
	it("commits a cached-row update once while preventing a competing stale-snapshot commit", async () => {
		const f = await fixture();
		const protectedRows = snapshotProtectedRows(f);
		let competition: ReturnType<typeof interceptScopedWriteCompetition> | undefined;
		const result = await f.run(async function* () {
			competition = interceptScopedWriteCompetition(f, { compete: true });
			yield item;
		});
		recordScopedWriteEvidence("library-competing-commit", { result, competition });
		expect(result).toMatchObject({
			success: true,
			itemsProcessed: 1,
			itemsUpdated: 1,
			itemsAdded: 0,
			itemsRemoved: 0,
		});
		expect(
			await f.plain.libraryCache.findUniqueOrThrow({ where: { id: "synthetic-library-row" } }),
		).toMatchObject({ title: "Synthetic current", hasFile: true });
		expect(competition).toMatchObject({ reservations: 1, commits: 0, blocked: 1 });
		expect(snapshotProtectedRows(f)).toEqual(protectedRows);
		expect(f.losses).toEqual([]);
	});

	// Break caught: reservation refusal must retain the last known cache and
	// report no successful publication; the next invocation must still work.
	it("retains cached data after refused admission and recovers on a fresh invocation", async () => {
		const f = await fixture();
		const before = await f.plain.libraryCache.findMany();
		const protectedRows = snapshotProtectedRows(f);
		let competition: ReturnType<typeof interceptScopedWriteCompetition> | undefined;
		const failed = await f.run(async function* () {
			competition = interceptScopedWriteCompetition(f, { holdBeforeReservation: true });
			const prepare = vi.mocked(Database.prototype.prepare).getMockImplementation();
			if (!prepare) throw new Error("Expected the native competition observer");
			vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
				this: Database.Database,
				sql,
			) {
				const statement = prepare.call(this, sql);
				if (this === f.writer || this.name !== f.path || sql !== "ROLLBACK") return statement;
				for (const method of ["all", "run"] as const) {
					const invoke = statement[method];
					Reflect.set(statement, method, function (this: typeof statement, ...args: unknown[]) {
						try {
							return Reflect.apply(invoke, this, args);
						} finally {
							if (f.writer.inTransaction) f.writer.exec("ROLLBACK");
						}
					});
				}
				return statement;
			});
			yield item;
		});
		expect(failed).toMatchObject({
			success: false,
			itemsProcessed: 0,
			itemsUpdated: 0,
			itemsAdded: 0,
			itemsRemoved: 0,
			newDownloads: [],
		});
		expect(await f.plain.libraryCache.findMany()).toEqual(before);
		expect(
			await f.plain.librarySyncStatus.findUniqueOrThrow({ where: { instanceId: f.instance.id } }),
		).toMatchObject({ syncInProgress: false, lastFullSync: null });
		expect(competition?.rollbacks).toBeGreaterThanOrEqual(1);
		const recovered = await f.run(async function* () {
			yield item;
		});
		expect(recovered).toMatchObject({ success: true, itemsUpdated: 1, itemsProcessed: 1 });
		expect(
			await f.plain.libraryCache.findUniqueOrThrow({ where: { id: "synthetic-library-row" } }),
		).toMatchObject({ title: "Synthetic current", hasFile: true });
		expect(snapshotProtectedRows(f)).toEqual(protectedRows);
		expect(f.losses).toEqual([]);
		recordScopedWriteEvidence("library-refused-then-recovered", { failed, recovered, competition });
	});

	// Break caught: effects from an entered, rolled-back batch must not be
	// reported as saved updates/downloads or replayed as successful work.
	it("does not replay or report rolled-back effects after an entered batch fails", async () => {
		const f = await fixture();
		const before = await f.plain.libraryCache.findMany();
		const protectedRows = snapshotProtectedRows(f);
		f.writer.exec(`CREATE TRIGGER reject_second_library_row BEFORE INSERT ON library_cache
			WHEN NEW.arrItemId=2 BEGIN SELECT RAISE(ABORT,'Synthetic batch refusal'); END`);
		let competition: ReturnType<typeof interceptScopedWriteCompetition> | undefined;
		let streams = 0;
		const result = await f.run(async function* () {
			streams++;
			competition = interceptScopedWriteCompetition(f);
			yield item;
			yield { ...item, id: 2, title: "Synthetic rejected" };
		});
		recordScopedWriteEvidence("library-entered-batch-rollback", { result, competition, streams });
		expect(result).toMatchObject({
			success: false,
			itemsProcessed: 0,
			itemsUpdated: 0,
			itemsAdded: 0,
			itemsRemoved: 0,
			newDownloads: [],
		});
		expect(streams).toBe(1);
		// One reservation entered the rolled-back batch; the second writes only
		// its failed status, without publishing or replaying any cache effects.
		expect(competition?.reservations).toBe(2);
		expect(
			await f.plain.librarySyncStatus.findUniqueOrThrow({ where: { instanceId: f.instance.id } }),
		).toMatchObject({ syncInProgress: false, lastFullSync: null, lastError: result.error });
		expect(await f.plain.libraryCache.findMany()).toEqual(before);
		expect(snapshotProtectedRows(f)).toEqual(protectedRows);
		expect(f.losses).toEqual([]);
	});
});
