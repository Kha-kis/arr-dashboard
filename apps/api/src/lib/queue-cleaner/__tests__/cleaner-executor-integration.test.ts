/**
 * Queue Cleaner executor integration tests.
 *
 * These exercise the end-to-end executor contract — ARR client is mocked,
 * Prisma is mocked, but the real executeQueueCleaner function runs the full
 * fetch -> validate -> evaluate -> remove pipeline. Existing unit tests
 * cover rule evaluation and auto-import in isolation; this file covers:
 *
 *  - successful clean path: queue item matched by a rule -> client.queue.del
 *    actually called with the item id (side-effect verification)
 *  - silent-failure contract: ARR queue.get throws -> executor returns a
 *    status:"error" result object WITHOUT throwing, so the scheduler sees a
 *    structured failure instead of an unhandled promise rejection
 *  - defensive config parsing: invalid whitelist JSON aborts the clean
 *    instead of silently running with an empty whitelist
 *  - registry integration: wrapping the executor in registry.track() surfaces
 *    both the successful result AND the failure result correctly
 *    (track() only observes thrown errors, so a structured error result
 *    counts as a successful tick from the registry's perspective — verifying
 *    this documents the contract between the two layers)
 */

import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type {
	QueueCleanerConfig,
	QueueCleanerImportReceipt,
	ServiceInstance,
} from "../../prisma.js";
import type { QuiObservationRead } from "../../qui/torrent-observation-repository.js";
import { JOB_ID } from "../../scheduler-registry/job-definitions.js";
import { SchedulerRegistry } from "../../scheduler-registry/scheduler-registry.js";

const quiMocks = vi.hoisted(() => ({
	createQuiClient: vi.fn(),
	listQuiInstances: vi.fn(),
	readObservation: vi.fn<(...args: unknown[]) => Promise<QuiObservationRead>>(),
}));

const autoImportMocks = vi.hoisted(() => ({
	attemptAutoImport: vi.fn(),
}));

vi.mock("../../qui/client-factory.js", () => ({
	createQuiClient: quiMocks.createQuiClient,
}));

vi.mock("../../qui/instance-helpers.js", () => ({
	listQuiInstances: quiMocks.listQuiInstances,
}));
// Explicit repository INPUT seam; native producer/publication proof is separate.
vi.mock("../../qui/torrent-observation-repository.js", () => ({
	readQuiTorrentObservations: quiMocks.readObservation,
}));

vi.mock("../auto-import-handler.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../auto-import-handler.js")>();
	return {
		...actual,
		attemptAutoImport: autoImportMocks.attemptAutoImport,
	};
});

import { importCommandFingerprint } from "../../arr/manual-import-command.js";
import { executeEnhancedPreview, executeQueueCleaner } from "../cleaner-executor.js";
import { importConnectionFingerprint, queueDownloadKey } from "../import-receipt.js";
import * as lastSeedGate from "../last-seed-gate.js";
import { queueItemFingerprint, readCompleteQueue } from "../queue-observation.js";

function makeInstance(overrides: Partial<ServiceInstance> = {}): ServiceInstance {
	return {
		id: "inst-1",
		userId: "user-1",
		service: "SONARR",
		label: "Sonarr",
		baseUrl: "http://sonarr:8989",
		externalUrl: null,
		encryptedApiKey: "x",
		encryptionIv: "y",
		enabled: true,
		isDefault: true,
		storageGroupId: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as ServiceInstance;
}

function makeConfig(overrides: Partial<QueueCleanerConfig> = {}): QueueCleanerConfig {
	// Conservative config: only the stalled rule, no strike system, live mode.
	// This keeps the executor path short and deterministic.
	return {
		id: "cfg-1",
		instanceId: "inst-1",
		enabled: true,
		dryRunMode: false,
		minQueueAgeMins: 0,
		maxRemovalsPerRun: 100,
		// Stalled rule: remove items stalled > 0 mins (so our old stalled item always matches)
		stalledEnabled: true,
		stalledThresholdMins: 0,
		// Other rules off
		slowEnabled: false,
		slowSpeedThreshold: 0,
		slowGracePeriodMins: 0,
		importPendingEnabled: false,
		importPendingMins: 0,
		importBlockEnabled: false,
		importBlockCleanupLevel: "item",
		importBlockPatternMode: "any",
		errorPatternsEnabled: false,
		errorPatterns: null,
		fileExtensionAllowlistEnabled: false,
		allowedFileExtensions: null,
		seedingTimeoutEnabled: false,
		seedingTimeoutHours: 0,
		estimatedEnabled: false,
		estimatedMultiplier: 2,
		skipFutureEpisodes: false,
		whitelistEnabled: false,
		whitelistPatterns: null,
		tagFilterMode: "all",
		tagFilterIds: null,
		profileFilterMode: "all",
		profileFilterIds: null,
		strikeSystemEnabled: false,
		maxStrikes: 3,
		strikeDecayHours: 24,
		autoImportEnabled: false,
		blocklistOnRemove: false,
		removeFromClient: true,
		addToBlocklist: true,
		searchAfterRemoval: false,
		changeCategoryEnabled: false,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as QueueCleanerConfig;
}

/**
 * Build a mock FastifyInstance with just enough surface for executeQueueCleaner.
 * Accepts a queue-get behavior so we can inject success and failure.
 */
function makeApp(queueBehavior: {
	get: (options?: Record<string, unknown>) => Promise<unknown>;
	getById?: (id: number) => Promise<unknown>;
	del: ReturnType<typeof vi.fn>;
	apiGet?: ReturnType<typeof vi.fn>;
	apiPost?: ReturnType<typeof vi.fn>;
	manualImportGet?: ReturnType<typeof vi.fn>;
}): FastifyInstance {
	const get = async (options?: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const page = (await queueBehavior.get(options)) as Record<string, unknown>;
		// Older fixtures describe one complete page; model the real paging envelope.
		return {
			page: options?.page ?? 1,
			pageSize: options?.pageSize ?? 1000,
			totalRecords: Array.isArray(page.records) ? page.records.length : undefined,
			...page,
		};
	};
	const app = {
		arrClientFactory: {
			create: () => ({
				get: queueBehavior.apiGet,
				post: queueBehavior.apiPost,
				manualImport: { get: queueBehavior.manualImportGet },
				queue: {
					get,
					getById:
						queueBehavior.getById ??
						(async (id: number) => {
							const page = await get();
							return (page as { records: Array<{ id: number }> }).records.find(
								(item) => item.id === id,
							);
						}),
					delete: queueBehavior.del,
				},
			}),
		},
		prisma: {
			arrImportOperation: { findMany: vi.fn().mockResolvedValue([]) },
			arrImportSourceClaim: { findMany: vi.fn().mockResolvedValue([]) },
			$transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
			serviceInstance: { findUnique: vi.fn().mockResolvedValue(makeInstance()) },
			queueCleanerImportReceipt: {
				findMany: vi.fn().mockResolvedValue([]),
				findUnique: vi.fn().mockResolvedValue(null),
				create: vi.fn().mockResolvedValue({ id: "receipt-1" }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			queueCleanerStrike: {
				findMany: vi.fn().mockResolvedValue([]),
				create: vi.fn(),
				update: vi.fn(),
				upsert: vi.fn(),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
				deleteMany: vi.fn(),
			},
		},
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
	};
	app.prisma.$transaction = vi.fn(async (fn) => fn(app.prisma));
	return app as unknown as FastifyInstance;
}

describe("executeQueueCleaner — integration", () => {
	const STALLED_ITEM = {
		id: 42,
		title: "Stalled.Show.S01E01",
		added: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
		size: 1_000_000_000,
		sizeleft: 1_000_000_000,
		status: "warning",
		trackedDownloadStatus: "warning",
		trackedDownloadState: "stalled",
		statusMessages: [
			{ title: "Stalled", messages: ["The download is stalled with no connections"] },
		],
		downloadId: "dl-42",
		protocol: "torrent",
		indexer: "TestIndexer",
		errorMessage: "The download is stalled with no connections",
	};

	async function importFixture() {
		autoImportMocks.attemptAutoImport.mockReset().mockImplementation(async () => ({
			attempted: false,
			success: false,
			safetyBlocked: true,
		}));
		const item = {
			...STALLED_ITEM,
			protocol: "usenet",
			movieId: 10,
			trackedDownloadState: "importPending",
			statusMessages: [],
			errorMessage: undefined,
		};
		let records: unknown[] = [item];
		const del = vi.fn();
		const apiGet = vi.fn();
		const apiPost = vi.fn();
		const manualImportGet = vi
			.fn()
			.mockResolvedValue([
				{ id: 1, path: "/fixture/movie.mkv", movie: { id: 10 }, downloadId: item.downloadId },
			]);
		const app = makeApp({ get: async () => ({ records }), del, apiGet, apiPost, manualImportGet });
		vi.mocked(app.prisma.serviceInstance.findUnique).mockResolvedValue(
			makeInstance({ service: "RADARR" }),
		);
		const receipts: QueueCleanerImportReceipt[] = [];
		Object.assign(app.prisma.queueCleanerImportReceipt, {
			findMany: vi.fn(async () => receipts.map((receipt) => ({ ...receipt }))),
			findUnique: vi.fn(
				async ({ where }: { where: { instanceId_downloadKey: { downloadKey: string } } }) =>
					receipts.find(
						(receipt) => receipt.downloadKey === where.instanceId_downloadKey?.downloadKey,
					) ?? null,
			),
			create: vi.fn(async ({ data }: { data: Partial<QueueCleanerImportReceipt> }) => {
				if (receipts.some((receipt) => receipt.downloadKey === data.downloadKey))
					throw new Error("fixture unique constraint");
				const receipt = {
					id: "receipt-1",
					createdAt: new Date(),
					updatedAt: new Date(),
					...data,
				} as QueueCleanerImportReceipt;
				receipts.push(receipt);
				return receipt;
			}),
			updateMany: vi.fn(
				async ({
					where,
					data,
				}: {
					where: Partial<QueueCleanerImportReceipt>;
					data: Partial<QueueCleanerImportReceipt>;
				}) => {
					if (!where || !(where.lastAttemptAt instanceof Date)) return { count: 0 };
					const receipt = receipts.find(
						(receipt) =>
							receipt.id === where?.id &&
							receipt.state === where?.state &&
							receipt.lastAttemptAt.getTime() === (where.lastAttemptAt as Date).getTime(),
					);
					if (!receipt) return { count: 0 };
					Object.assign(receipt, data);
					return { count: 1 };
				},
			),
		});
		const config = makeConfig({
			stalledEnabled: false,
			importPendingEnabled: true,
			importPendingThresholdMins: 0,
			autoImportEnabled: true,
			autoImportMaxAttempts: 2,
			autoImportCooldownMins: 0,
			autoImportSafeOnly: false,
		});
		return {
			app,
			item,
			instance: makeInstance({ service: "RADARR" }),
			config,
			receipts,
			del,
			apiGet,
			apiPost,
			manualImportGet,
			clearQueue: () => {
				records = [];
			},
			setQueueId: (id: number) => {
				records = [{ ...item, id }];
			},
		};
	}

	async function seedLegacyReceipt(
		f: Awaited<ReturnType<typeof importFixture>>,
		overrides: Partial<QueueCleanerImportReceipt> = {},
		files: Array<Record<string, unknown>> = [
			{ path: "/fixture/movie.mkv", downloadId: f.item.downloadId, movieId: 10 },
		],
	) {
		const receipt = {
			id: "legacy-receipt-1",
			instanceId: f.instance.id,
			downloadKey: queueDownloadKey(f.item),
			queueId: f.item.id,
			downloadTitle: f.item.title,
			connectionFingerprint: importConnectionFingerprint(f.instance),
			commandFingerprint: importCommandFingerprint(files),
			commandId: 7,
			state: "pending",
			lastAttemptAt: new Date(Date.now() - 60_000),
			createdAt: new Date(Date.now() - 60_000),
			updatedAt: new Date(Date.now() - 60_000),
			...overrides,
		} as QueueCleanerImportReceipt;
		f.receipts.push(receipt);
		f.apiGet.mockImplementation(async (path) => {
			if (path.endsWith("/command")) return [];
			if (path.endsWith("/history")) return { totalRecords: 0, records: [] };
			if (!path.includes("/command/")) return {};
			const status = receipt.state === "failed" ? "failed" : "started";
			return {
				id: receipt.commandId ?? undefined,
				name: "ManualImport",
				status,
				result: status === "failed" ? "unsuccessful" : undefined,
				body: { files },
			};
		});
		return receipt;
	}

	it("reconciles an explicitly seeded legacy receipt and counts only verified completion once", async () => {
		const f = await importFixture();
		const legacy = await seedLegacyReceipt(f);
		const body = {
			files: [{ path: "/fixture/movie.mkv", downloadId: f.item.downloadId, movieId: 10 }],
		};
		const run = () => executeQueueCleaner(f.app, f.instance, f.config);
		expect(await run()).toMatchObject({ status: "partial", itemsCleaned: 0 });
		expect(f.receipts[0]).toMatchObject({
			commandId: 7,
			state: "pending",
			id: legacy.id,
		});
		f.apiGet.mockResolvedValue({ id: 7, name: "ManualImport", status: "started" });
		f.setQueueId(99); // The same source keeps its receipt despite a changed queue slot.
		expect(await run()).toMatchObject({ status: "partial", itemsCleaned: 0 });
		f.clearQueue();
		f.apiGet
			.mockResolvedValueOnce({
				id: 7,
				name: "ManualImport",
				status: "completed",
				result: "successful",
				body,
			})
			.mockResolvedValueOnce({
				totalRecords: 1,
				records: [
					{
						id: 1,
						eventType: "downloadFolderImported",
						downloadId: f.item.downloadId,
						movieId: 10,
						date: new Date(Date.now() + 1000).toISOString(),
						data: { droppedPath: "/fixture/movie.mkv", fileId: "21" },
					},
				],
			});
		expect(await run()).toMatchObject({ status: "completed", itemsCleaned: 1 });
		expect(await run()).toMatchObject({ status: "completed", itemsCleaned: 0 });
		expect(f.receipts[0]?.state).toBe("completed");
		expect(f.apiPost).not.toHaveBeenCalled();
		expect(f.del).not.toHaveBeenCalled();
	});

	it("retains a seeded unknown legacy attempt when its source leaves the queue", async () => {
		const f = await importFixture();
		await seedLegacyReceipt(f, { state: "unknown", commandId: null });
		expect(await executeQueueCleaner(f.app, f.instance, f.config)).toMatchObject({
			status: "partial",
			itemsCleaned: 0,
		});
		expect(f.receipts[0]?.state).toBe("unknown");
		f.apiGet.mockResolvedValue([]);
		f.clearQueue();
		expect(await executeQueueCleaner(f.app, f.instance, f.config)).toMatchObject({
			status: "partial",
			itemsCleaned: 0,
		});
		expect(f.apiPost).not.toHaveBeenCalled();
		expect(f.del).not.toHaveBeenCalled();
	});

	it("does not delete or submit when legacy receipt evidence cannot be read", async () => {
		const f = await importFixture();
		await seedLegacyReceipt(f);
		vi.mocked(f.app.prisma.queueCleanerImportReceipt.findMany).mockRejectedValue(
			new Error("fixture database unavailable"),
		);
		expect(await executeQueueCleaner(f.app, f.instance, f.config)).toMatchObject({
			status: "error",
			itemsCleaned: 0,
		});
		expect(f.apiPost).not.toHaveBeenCalled();
		expect(f.del).not.toHaveBeenCalled();
	});

	it("does not turn a lost legacy receipt fence into removal permission", async () => {
		const f = await importFixture();
		f.apiPost.mockResolvedValue({ id: 7, name: "ManualImport", status: "queued" });
		await seedLegacyReceipt(f, { state: "submitting" });
		vi.mocked(f.app.prisma.queueCleanerImportReceipt.updateMany).mockResolvedValue({ count: 0 });
		expect(await executeQueueCleaner(f.app, f.instance, f.config)).toMatchObject({
			status: "error",
			itemsCleaned: 0,
		});
		expect(f.receipts[0]?.state).toBe("submitting");
		expect(f.del).not.toHaveBeenCalled();
	});

	it("preserves preview parity and prevents transferring command authority to a changed provider", async () => {
		const f = await importFixture();
		await seedLegacyReceipt(f);
		await executeQueueCleaner(f.app, f.instance, f.config);
		const dry = await executeQueueCleaner(f.app, f.instance, { ...f.config, dryRunMode: true });
		const preview = await executeEnhancedPreview(f.app, f.instance, f.config);
		expect(dry.skippedItems[0]?.reason).not.toContain("Would remove");
		expect(preview.previewItems[0]?.action).toBe("skip");
		expect(f.apiGet).toHaveBeenCalledOnce();
		expect(f.app.prisma.queueCleanerImportReceipt.updateMany).toHaveBeenCalledOnce();
		expect(
			await executeQueueCleaner(
				f.app,
				{ ...f.instance, baseUrl: "http://replacement:7878" },
				f.config,
			),
		).toMatchObject({ status: "partial", itemsCleaned: 0 });
		expect(f.apiGet).toHaveBeenCalledOnce();
		expect(f.apiPost).not.toHaveBeenCalled();
		expect(f.del).not.toHaveBeenCalled();
	});

	it("does not delete or resubmit a seeded failed legacy command", async () => {
		const f = await importFixture();
		await seedLegacyReceipt(f, { state: "failed" });
		expect(await executeQueueCleaner(f.app, f.instance, f.config)).toMatchObject({
			status: "partial",
			itemsCleaned: 0,
		});
		expect(f.receipts[0]?.state).toBe("failed");
		expect(f.del).not.toHaveBeenCalled();
	});

	it.each([
		{ autoImportEnabled: false, autoImportMaxAttempts: 0 },
		{ autoImportEnabled: true, autoImportMaxAttempts: 0 },
		{ autoImportEnabled: true, autoImportMaxAttempts: 2 },
	])(
		"retains a partial batch's sources in preview and execution with retry policy %j",
		async (retryPolicy) => {
			const f = await importFixture();
			const files = [
				{ path: "/fixture/movie.mkv", downloadId: f.item.downloadId, movieId: 10 },
				{ path: "/fixture/second.mkv", downloadId: f.item.downloadId, movieId: 10 },
			];
			await seedLegacyReceipt(
				f,
				{ state: "failed", commandFingerprint: importCommandFingerprint(files)! },
				files,
			);
			f.apiGet.mockImplementation(async (path) =>
				path.includes("/command/")
					? {
							id: 7,
							name: "ManualImport",
							status: "failed",
							result: "unsuccessful",
							body: {
								files: [
									{ path: "/fixture/movie.mkv", downloadId: f.item.downloadId, movieId: 10 },
									{ path: "/fixture/second.mkv", downloadId: f.item.downloadId, movieId: 10 },
								],
							},
						}
					: {
							totalRecords: 1,
							records: [
								{
									eventType: "downloadFolderImported",
									downloadId: f.item.downloadId,
									movieId: 10,
									date: new Date().toISOString(),
									data: { droppedPath: "/fixture/movie.mkv", fileId: "21" },
								},
							],
						},
			);
			const config = { ...f.config, ...retryPolicy };
			expect(await executeQueueCleaner(f.app, f.instance, config)).toMatchObject({
				status: "partial",
				itemsCleaned: 0,
			});
			const dry = await executeQueueCleaner(f.app, f.instance, { ...config, dryRunMode: true });
			const preview = await executeEnhancedPreview(f.app, f.instance, config);
			expect(dry.skippedItems[0]?.reason).not.toContain("Would remove");
			expect(preview.previewItems[0]?.action).toBe("skip");
			expect(f.apiPost).not.toHaveBeenCalled();
			expect(f.del).not.toHaveBeenCalled();
		},
	);

	it("withholds source actions with missing download identity in all modes, including Usenet", async () => {
		const del = vi.fn();
		const app = makeApp({
			get: async () => ({
				records: [{ ...STALLED_ITEM, protocol: "usenet", downloadId: undefined }],
			}),
			del,
		});
		const config = makeConfig({ lastSeedProtection: false });
		const live = await executeQueueCleaner(app, makeInstance(), config);
		const dry = await executeQueueCleaner(app, makeInstance(), { ...config, dryRunMode: true });
		const preview = await executeEnhancedPreview(app, makeInstance(), config);
		expect(live).toMatchObject({ status: "partial", itemsCleaned: 0 });
		expect(dry.skippedItems[0]?.reason).toContain("identity");
		expect(preview.previewItems[0]?.action).toBe("skip");
		expect(del).not.toHaveBeenCalled();
	});

	it.each(["torrent", undefined, "unknown"])(
		"defers %s items without a hash consistently in all modes",
		async (protocol) => {
			const del = vi.fn();
			const app = makeApp({ get: async () => ({ records: [{ ...STALLED_ITEM, protocol }] }), del });
			const config = makeConfig({ lastSeedProtection: true });
			const live = await executeQueueCleaner(app, makeInstance(), config);
			const dry = await executeQueueCleaner(app, makeInstance(), { ...config, dryRunMode: true });
			const preview = await executeEnhancedPreview(app, makeInstance(), config);
			for (const result of [live, dry]) {
				expect(result.itemsCleaned).toBe(0);
				expect(result.skippedItems[0]?.reason).toContain("identity");
			}
			expect(preview.previewItems[0]?.action).toBe("skip");
			expect(preview.previewItems[0]?.reason).toContain("identity");
			expect(del).not.toHaveBeenCalled();
		},
	);

	it("does not apply torrent hash requirements to known Usenet", async () => {
		const del = vi.fn().mockResolvedValue(undefined);
		const app = makeApp({
			get: async () => ({ records: [{ ...STALLED_ITEM, protocol: "usenet" }] }),
			del,
		});
		const result = await executeQueueCleaner(
			app,
			makeInstance(),
			makeConfig({ lastSeedProtection: true }),
		);
		expect(result.itemsCleaned).toBe(1);
		expect(del).toHaveBeenCalledOnce();
	});

	it("reads every advertised queue page in preview and execution", async () => {
		const first = Array.from({ length: 1000 }, (_, index) => ({
			...STALLED_ITEM,
			id: index + 1,
			downloadId: `download-${index + 1}`,
			protocol: "usenet",
		}));
		const last = { ...STALLED_ITEM, id: 1001, downloadId: "download-1001", protocol: "usenet" };
		const get = vi.fn(async (options?: Record<string, unknown>) => ({
			records: options?.page === 2 ? [last] : first,
			totalRecords: 1001,
		}));
		const del = vi.fn();
		const app = makeApp({ get, del });
		const config = makeConfig({ dryRunMode: true, maxRemovalsPerRun: 2000 });
		const dry = await executeQueueCleaner(app, makeInstance(), config);
		const preview = await executeEnhancedPreview(app, makeInstance(), config);
		expect(dry.skippedItems).toHaveLength(1001);
		expect(preview.queueSummary.totalItems).toBe(1001);
		expect(preview.wouldRemove).toBe(1001);
		expect(get).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
		expect(del).not.toHaveBeenCalled();
	});

	it.each([
		{ records: [STALLED_ITEM], totalRecords: 2 },
		{ records: [STALLED_ITEM], totalRecords: undefined },
		{ records: [STALLED_ITEM, STALLED_ITEM], totalRecords: 2 },
		{ records: [{ ...STALLED_ITEM, id: 0 }], totalRecords: 1 },
		{ records: null, totalRecords: 0 },
	])("rejects incomplete or ambiguous queue envelopes before any writes (%j)", async (page) => {
		const del = vi.fn();
		const app = makeApp({ get: async () => page, del });
		const result = await executeQueueCleaner(
			app,
			makeInstance(),
			makeConfig({ strikeSystemEnabled: true }),
		);
		expect(result.status).toBe("error");
		expect(del).not.toHaveBeenCalled();
		expect(app.prisma.$transaction).not.toHaveBeenCalled();
		const preview = await executeEnhancedPreview(app, makeInstance(), makeConfig());
		expect(preview.errorMessage).toBeTruthy();
		expect(preview.wouldRemove).toBe(0);
	});

	it.each([
		{ downloadId: "another-download" },
		{ protocol: "usenet" },
		{
			trackedDownloadState: "downloading",
			statusMessages: [],
			errorMessage: undefined,
			trackedDownloadStatus: "ok",
			sizeleft: 500_000_000,
		},
		{ seriesId: 999 },
	])("defers a changed target before strikes or removal (%j)", async (change) => {
		const del = vi.fn();
		const app = makeApp({
			get: async () => ({ records: [STALLED_ITEM] }),
			getById: async () => ({ ...STALLED_ITEM, ...change }),
			del,
		});
		const result = await executeQueueCleaner(
			app,
			makeInstance(),
			makeConfig({ strikeSystemEnabled: true, maxStrikes: 1 }),
		);
		expect(result.itemsCleaned).toBe(0);
		expect(result.skippedItems[0]?.reason).toMatch(/changed|eligible|identity/);
		expect(del).not.toHaveBeenCalled();
		expect(app.prisma.queueCleanerStrike.create).not.toHaveBeenCalled();
		expect(app.prisma.queueCleanerStrike.update).not.toHaveBeenCalled();
	});

	it("reports a deletion 404 as unavailable, not a successful cleanup", async () => {
		const del = vi.fn().mockRejectedValue(new Error("404 Not Found"));
		const app = makeApp({ get: async () => ({ records: [STALLED_ITEM] }), del });
		const result = await executeQueueCleaner(app, makeInstance(), makeConfig());
		expect(result.itemsCleaned).toBe(0);
		expect(result.status).toBe("partial");
		expect(result.skippedItems[0]?.reason).toContain("outcome");
	});

	it.each([null, "previous-download-fingerprint"])(
		"does not inherit legacy/recycled strikes (%s)",
		async (downloadFingerprint) => {
			const del = vi.fn();
			const app = makeApp({ get: async () => ({ records: [STALLED_ITEM] }), del });
			vi.mocked(app.prisma.queueCleanerStrike.findMany).mockResolvedValue([
				{
					id: "existing-strike",
					instanceId: "inst-1",
					downloadId: "42",
					downloadHash: null,
					downloadTitle: "Old slot occupant",
					strikeCount: 2,
					lastRule: "stalled",
					lastReason: "old",
					importAttempts: 2,
					lastImportAttempt: new Date(),
					lastImportError: "old",
					firstStrikeAt: new Date(),
					lastStrikeAt: new Date(),
					...{ downloadFingerprint },
				},
			]);
			const config = makeConfig({ strikeSystemEnabled: true, maxStrikes: 3 });
			const dry = await executeQueueCleaner(app, makeInstance(), { ...config, dryRunMode: true });
			const preview = await executeEnhancedPreview(app, makeInstance(), config);
			const live = await executeQueueCleaner(app, makeInstance(), config);
			expect(dry.warnedItems[0]?.strikeCount).toBe(1);
			expect(preview.previewItems[0]?.strikeInfo?.currentStrikes).toBe(1);
			expect(live.warnedItems[0]?.strikeCount).toBe(1);
			expect(del).not.toHaveBeenCalled();
			expect(app.prisma.queueCleanerStrike.update).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						downloadFingerprint: queueItemFingerprint(STALLED_ITEM),
						strikeCount: 1,
						importAttempts: 0,
					}),
				}),
			);
		},
	);

	it("revalidates again after strike admission before the upstream action", async () => {
		const del = vi.fn();
		const getById = vi
			.fn()
			.mockResolvedValueOnce(STALLED_ITEM)
			.mockResolvedValue({ ...STALLED_ITEM, downloadId: "replacement" });
		const app = makeApp({ get: async () => ({ records: [STALLED_ITEM] }), getById, del });
		const result = await executeQueueCleaner(app, makeInstance(), makeConfig());
		expect(result.itemsCleaned).toBe(0);
		expect(result.skippedItems[0]?.reason).toContain("identity changed");
		expect(del).not.toHaveBeenCalled();
	});

	it("fails closed when the last-seed dependency unexpectedly throws in every mode", async () => {
		const lookup = vi
			.spyOn(lastSeedGate, "resolveLibraryReferencedItemIds")
			.mockRejectedValue(new Error("fixture dependency failure"));
		try {
			const del = vi.fn();
			const app = makeApp({
				get: async () => ({ records: [{ ...STALLED_ITEM, downloadId: "a".repeat(40) }] }),
				del,
			});
			const config = makeConfig({ lastSeedProtection: true });
			for (const dryRunMode of [false, true]) {
				const result = await executeQueueCleaner(app, makeInstance(), { ...config, dryRunMode });
				expect(result.skippedItems[0]?.reason).toContain("reference evidence is unavailable");
			}
			const preview = await executeEnhancedPreview(app, makeInstance(), config);
			expect(preview.previewItems[0]?.action).toBe("skip");
			expect(preview.previewItems[0]?.reason).toContain("reference evidence is unavailable");
			expect(del).not.toHaveBeenCalled();
		} finally {
			lookup.mockRestore();
		}
	});

	it("rechecks cross-instance references before removal", async () => {
		const hash = "a".repeat(40);
		const del = vi.fn();
		const app = makeApp({
			get: async () => ({ records: [{ ...STALLED_ITEM, downloadId: hash }] }),
			del,
		});
		const libraryLookup = vi
			.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValue([{ infoHash: hash }]);
		Object.assign(app.prisma, {
			libraryCache: { findMany: libraryLookup },
			episodeFileCache: { findMany: vi.fn().mockResolvedValue([]) },
		});
		const result = await executeQueueCleaner(
			app,
			makeInstance(),
			makeConfig({ lastSeedProtection: true }),
		);
		expect(result.itemsCleaned).toBe(0);
		expect(result.skippedItems[0]?.reason).toContain("library still references");
		expect(libraryLookup).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ instance: { userId: "user-1" } }),
			}),
		);
		expect(del).not.toHaveBeenCalled();
	});

	it("rejects same-total pagination churn before a partial set can prune strikes", async () => {
		const records = (ids: number[]) =>
			ids.map((id) => ({ ...STALLED_ITEM, id, downloadId: `download-${id}` }));
		const get = vi
			.fn()
			.mockResolvedValueOnce({ page: 1, pageSize: 2, totalRecords: 3, records: records([1, 2]) })
			.mockResolvedValueOnce({ page: 2, pageSize: 2, totalRecords: 3, records: records([4]) })
			.mockResolvedValueOnce({ page: 1, pageSize: 2, totalRecords: 3, records: records([2, 3]) })
			.mockResolvedValueOnce({ page: 2, pageSize: 2, totalRecords: 3, records: records([4]) });
		const app = makeApp({ get, del: vi.fn() });
		await expect(
			readCompleteQueue(app.arrClientFactory.create(makeInstance()) as never, "SONARR"),
		).rejects.toThrow("changed");
		expect(app.prisma.queueCleanerStrike.deleteMany).not.toHaveBeenCalled();
	});

	it("reports unavailable current-target evidence as partial, not a successful run", async () => {
		const del = vi.fn();
		const app = makeApp({
			get: async () => ({ records: [STALLED_ITEM] }),
			getById: vi.fn().mockRejectedValue(new Error("fixture read failure")),
			del,
		});
		const result = await executeQueueCleaner(app, makeInstance(), makeConfig());
		expect(result.status).toBe("partial");
		expect(result.message).toContain("deferred");
		expect(del).not.toHaveBeenCalled();
	});

	it("distinguishes a reference lookup outage from a verified library reference", async () => {
		const del = vi.fn();
		const app = makeApp({
			get: async () => ({ records: [{ ...STALLED_ITEM, downloadId: "a".repeat(40) }] }),
			del,
		});
		Object.assign(app.prisma, {
			libraryCache: {
				findMany: vi.fn().mockRejectedValue(new Error("fixture database unavailable")),
			},
			episodeFileCache: { findMany: vi.fn().mockResolvedValue([]) },
		});
		const result = await executeQueueCleaner(
			app,
			makeInstance(),
			makeConfig({ lastSeedProtection: true }),
		);
		expect(result.status).toBe("partial");
		expect(result.skippedItems[0]?.reason).toContain("reference evidence is unavailable");
		expect(result.skippedItems[0]?.reason).not.toContain("library still references");
		expect(del).not.toHaveBeenCalled();
	});

	it("matches a stalled queue item and calls client.queue.del (side-effect verification)", async () => {
		const del = vi.fn().mockResolvedValue(undefined);
		const app = makeApp({
			get: async () => ({ records: [STALLED_ITEM] }),
			del,
		});

		const result = await executeQueueCleaner(app, makeInstance(), makeConfig());

		// Structured result surfaces the matched item
		expect(result.status).toBe("completed");
		expect(result.isDryRun).toBe(false);
		expect(result.itemsCleaned).toBeGreaterThanOrEqual(1);
		expect(result.cleanedItems.some((i) => i.id === 42)).toBe(true);

		// Side effect: ARR client was actually asked to remove the item
		expect(del).toHaveBeenCalled();
		const delArgs = del.mock.calls[0];
		expect(delArgs?.[0]).toBe(42); // item id
	});

	it("fails closed after an incomplete multi-qUI sync invalidates correlated evidence", async () => {
		const hash = "a".repeat(40);
		const del = vi.fn().mockResolvedValue(undefined);
		const app = makeApp({
			get: async () => ({ records: [{ ...STALLED_ITEM, downloadId: hash }] }),
			del,
		});
		quiMocks.readObservation.mockResolvedValue({ status: "unavailable" });

		const result = await executeQueueCleaner(
			app,
			makeInstance(),
			makeConfig({ quiAwareMode: true }),
		);

		expect(result.itemsCleaned).toBe(0);
		expect(result.skippedItems[0]?.reason).toContain("qUI evidence is unavailable or stale");
		expect(del).not.toHaveBeenCalled();
	});

	it("keeps preview and execution aligned when qUI evidence is only partially populated", async () => {
		const observedHash = "b".repeat(40);
		const missingHash = "c".repeat(40);
		const observedItem = { ...STALLED_ITEM, id: 43, downloadId: observedHash };
		const missingItem = { ...STALLED_ITEM, id: 44, downloadId: missingHash };
		const del = vi.fn().mockResolvedValue(undefined);
		const app = makeApp({
			get: async () => ({ records: [observedItem, missingItem] }),
			del,
		});
		const config = makeConfig({ quiAwareMode: true });
		quiMocks.readObservation.mockResolvedValue({ status: "unavailable" });
		const partial = await executeQueueCleaner(app, makeInstance(), config);
		expect(partial.itemsCleaned).toBe(0);
		expect(partial.skippedItems.map((i) => i.id)).toEqual([43, 44]);
		expect(
			partial.skippedItems.every((i) => i.reason.includes("qUI evidence is unavailable or stale")),
		).toBe(true);
		const partialPreview = await executeEnhancedPreview(app, makeInstance(), config);
		expect(partialPreview.wouldRemove).toBe(0);
		expect(partialPreview.previewItems.every((i) => i.action === "skip")).toBe(true);
		const partialDry = await executeQueueCleaner(app, makeInstance(), {
			...config,
			dryRunMode: true,
		});
		expect(partialDry.itemsCleaned).toBe(0);
		expect(del).not.toHaveBeenCalled();
		quiMocks.readObservation.mockResolvedValue({
			status: "available",
			generation: "complete-input",
			observedAt: new Date(),
			rows: new Map([
				[observedHash, { state: "seeding", ratio: 1 }],
				[missingHash, { state: "paused", ratio: 0 }],
			]),
		});

		const execution = await executeQueueCleaner(app, makeInstance(), config);

		expect(execution.cleanedItems.map((item) => item.id)).toEqual([43]);
		expect(execution.skippedItems).toEqual([
			expect.objectContaining({
				id: 44,
				reason: expect.stringContaining("torrent is paused or errored in qui"),
			}),
		]);
		expect(del).toHaveBeenCalledOnce();
		expect(del).toHaveBeenCalledWith(43, expect.objectContaining({ removeFromClient: true }));

		del.mockClear();
		const preview = await executeEnhancedPreview(app, makeInstance(), config);
		const previewById = new Map(preview.previewItems.map((item) => [item.id, item]));
		expect(previewById.get(43)?.action).toBe("remove");
		expect(previewById.get(44)).toMatchObject({ action: "skip" });
		expect(previewById.get(44)?.reason).toContain("torrent is paused or errored in qui");
		expect(preview.wouldRemove).toBe(1);
		expect(del).not.toHaveBeenCalled();
		quiMocks.readObservation.mockResolvedValue({
			status: "available",
			generation: "complete-empty-input",
			observedAt: new Date(),
			rows: new Map(),
		});
		const absent = await executeEnhancedPreview(app, makeInstance(), config);
		expect(absent.wouldRemove).toBe(2);
		expect(absent.previewItems.every((i) => i.action === "remove")).toBe(true);
		expect(del).not.toHaveBeenCalled();
	});

	it("dry-run mode returns the same matches WITHOUT calling client.queue.del", async () => {
		const del = vi.fn();
		const app = makeApp({
			get: async () => ({ records: [STALLED_ITEM] }),
			del,
		});

		const result = await executeQueueCleaner(app, makeInstance(), makeConfig({ dryRunMode: true }));

		expect(result.isDryRun).toBe(true);
		expect(del).not.toHaveBeenCalled();
	});

	it("keeps both previews aligned when execution blocks unsafe retained-torrent recategorization", async () => {
		const del = vi.fn();
		const app = makeApp({
			get: async () => ({ records: [{ ...STALLED_ITEM, protocol: "Torrent" }] }),
			del,
		});
		const config = makeConfig({
			removeFromClient: false,
			addToBlocklist: false,
			changeCategoryEnabled: true,
		});

		const execution = await executeQueueCleaner(app, makeInstance(), config);
		const dryRun = await executeQueueCleaner(app, makeInstance(), {
			...config,
			dryRunMode: true,
		});
		const enhancedPreview = await executeEnhancedPreview(app, makeInstance(), config);

		expect(execution.itemsCleaned).toBe(0);
		expect(execution.skippedItems).toEqual([
			expect.objectContaining({
				id: 42,
				reason: expect.stringContaining("blocklist"),
			}),
		]);
		expect(dryRun.itemsCleaned).toBe(0);
		expect(dryRun.skippedItems).toEqual([
			expect.objectContaining({
				id: 42,
				reason: expect.stringContaining("blocklist"),
			}),
		]);
		expect(enhancedPreview.previewItems).toEqual([
			expect.objectContaining({
				id: 42,
				action: "skip",
				reason: expect.stringContaining("blocklist"),
			}),
		]);
		expect(enhancedPreview.wouldRemove).toBe(0);
		expect(del).not.toHaveBeenCalled();
	});

	it("blocks unsafe retained torrents before auto-import or import-attempt persistence", async () => {
		autoImportMocks.attemptAutoImport.mockReset();
		autoImportMocks.attemptAutoImport.mockResolvedValue({ attempted: true, success: true });
		const del = vi.fn();
		const importPendingItem = {
			...STALLED_ITEM,
			trackedDownloadState: "importPending",
			statusMessages: [],
			errorMessage: undefined,
		};
		const app = makeApp({
			get: async () => ({ records: [importPendingItem] }),
			del,
		});
		const config = makeConfig({
			stalledEnabled: false,
			importPendingEnabled: true,
			importPendingThresholdMins: 0,
			autoImportEnabled: true,
			autoImportMaxAttempts: 2,
			autoImportCooldownMins: 0,
			autoImportSafeOnly: false,
			autoImportCustomPatterns: null,
			autoImportNeverPatterns: null,
			removeFromClient: false,
			addToBlocklist: false,
			changeCategoryEnabled: true,
		});

		const execution = await executeQueueCleaner(app, makeInstance(), config);
		const dryRun = await executeQueueCleaner(app, makeInstance(), {
			...config,
			dryRunMode: true,
		});
		const enhancedPreview = await executeEnhancedPreview(app, makeInstance(), config);

		expect(execution.skippedItems).toEqual([
			expect.objectContaining({ id: 42, reason: expect.stringContaining("blocklist") }),
		]);
		expect(dryRun.skippedItems).toEqual([
			expect.objectContaining({ id: 42, reason: expect.stringContaining("blocklist") }),
		]);
		expect(enhancedPreview.previewItems).toEqual([
			expect.objectContaining({
				id: 42,
				action: "skip",
				reason: expect.stringContaining("blocklist"),
			}),
		]);
		expect(autoImportMocks.attemptAutoImport).not.toHaveBeenCalled();
		expect(app.prisma.queueCleanerStrike.create).not.toHaveBeenCalled();
		expect(app.prisma.queueCleanerStrike.update).not.toHaveBeenCalled();
		expect(del).not.toHaveBeenCalled();
	});

	it("does not turn an auto-import safety failure into deletion permission", async () => {
		autoImportMocks.attemptAutoImport.mockReset();
		autoImportMocks.attemptAutoImport.mockResolvedValue({
			attempted: false,
			success: false,
			safetyBlocked: true,
		});
		const del = vi.fn();
		const app = makeApp({
			get: async () => ({
				records: [
					{
						...STALLED_ITEM,
						trackedDownloadState: "importPending",
						statusMessages: [],
						errorMessage: undefined,
					},
				],
			}),
			del,
		});
		const result = await executeQueueCleaner(
			app,
			makeInstance(),
			makeConfig({
				stalledEnabled: false,
				importPendingEnabled: true,
				importPendingThresholdMins: 0,
				autoImportEnabled: true,
				autoImportMaxAttempts: 2,
				autoImportCooldownMins: 0,
				autoImportSafeOnly: false,
			}),
		);
		expect(result.itemsCleaned).toBe(0);
		expect(result.skippedItems[0]?.reason).toContain("identity or media mapping");
		expect(app.prisma.queueCleanerStrike.create).not.toHaveBeenCalled();
		expect(app.prisma.queueCleanerStrike.update).not.toHaveBeenCalled();
		expect(del).not.toHaveBeenCalled();
	});

	it("applies the removal cap after retained-torrent authorization in every mode", async () => {
		const unsafeTorrent = { ...STALLED_ITEM, id: 42 };
		const safeUsenet = {
			...STALLED_ITEM,
			id: 43,
			title: "Stalled.Show.S01E02",
			downloadId: "dl-43",
			protocol: "usenet",
		};
		const del = vi.fn().mockResolvedValue(undefined);
		const app = makeApp({
			get: async () => ({ records: [unsafeTorrent, safeUsenet] }),
			del,
		});
		const config = makeConfig({
			maxRemovalsPerRun: 1,
			removeFromClient: false,
			addToBlocklist: false,
			changeCategoryEnabled: true,
		});

		const execution = await executeQueueCleaner(app, makeInstance(), config);
		expect(execution.cleanedItems).toEqual([expect.objectContaining({ id: 43 })]);
		expect(execution.skippedItems).toEqual([
			expect.objectContaining({ id: 42, reason: expect.stringContaining("blocklist") }),
		]);
		expect(del).toHaveBeenCalledTimes(1);
		expect(del).toHaveBeenCalledWith(43, expect.any(Object));

		del.mockClear();
		const dryRun = await executeQueueCleaner(app, makeInstance(), {
			...config,
			dryRunMode: true,
		});
		expect(dryRun.skippedItems).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: 42, reason: expect.stringContaining("blocklist") }),
				expect.objectContaining({ id: 43, reason: expect.stringContaining("Would remove") }),
			]),
		);
		expect(del).not.toHaveBeenCalled();

		const enhancedPreview = await executeEnhancedPreview(app, makeInstance(), config);
		expect(enhancedPreview.previewItems).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: 42, action: "skip" }),
				expect.objectContaining({ id: 43, action: "remove" }),
			]),
		);
		expect(enhancedPreview.wouldRemove).toBe(1);
		expect(del).not.toHaveBeenCalled();
	});

	it("preserves a strike warning until the retained-torrent policy would authorize removal", async () => {
		const del = vi.fn();
		const app = makeApp({
			get: async () => ({ records: [STALLED_ITEM] }),
			del,
		});

		const preview = await executeEnhancedPreview(
			app,
			makeInstance(),
			makeConfig({
				removeFromClient: false,
				addToBlocklist: false,
				changeCategoryEnabled: true,
				strikeSystemEnabled: true,
				maxStrikes: 3,
			}),
		);

		expect(preview.previewItems).toEqual([
			expect.objectContaining({
				id: 42,
				action: "warn",
				strikeInfo: {
					currentStrikes: 1,
					maxStrikes: 3,
					wouldTriggerRemoval: false,
				},
			}),
		]);
		expect(preview.wouldWarn).toBe(1);
		expect(del).not.toHaveBeenCalled();
	});

	it("retains and recategorizes a torrent when the exact release is blocklisted", async () => {
		const del = vi.fn().mockResolvedValue(undefined);
		const app = makeApp({
			get: async () => ({ records: [STALLED_ITEM] }),
			del,
		});

		const result = await executeQueueCleaner(
			app,
			makeInstance(),
			makeConfig({
				removeFromClient: false,
				addToBlocklist: true,
				searchAfterRemoval: false,
				changeCategoryEnabled: true,
			}),
		);

		expect(result.itemsCleaned).toBe(1);
		expect(del).toHaveBeenCalledWith(42, {
			removeFromClient: false,
			blocklist: true,
			skipRedownload: true,
			changeCategory: true,
		});
	});

	it("silent-failure contract: ARR queue.get throwing yields status:error, NOT an unhandled rejection", async () => {
		const del = vi.fn();
		const app = makeApp({
			get: async () => {
				throw new Error("Connection refused");
			},
			del,
		});

		// CRITICAL: must not throw. Silent rejection here would crash the scheduler tick
		// and leave the user with no structured error in queueCleanerLog.
		const result = await executeQueueCleaner(app, makeInstance(), makeConfig());

		expect(result.status).toBe("error");
		expect(result.message).toContain("Failed to fetch queue");
		expect(result.message).toContain("Connection refused");
		expect(result.itemsCleaned).toBe(0);
		expect(del).not.toHaveBeenCalled();
	});

	it("invalid whitelist JSON aborts the clean for safety (defensive failure, not silent success)", async () => {
		const del = vi.fn();
		const app = makeApp({
			get: async () => ({ records: [STALLED_ITEM] }),
			del,
		});

		const result = await executeQueueCleaner(
			app,
			makeInstance(),
			makeConfig({
				whitelistEnabled: true,
				whitelistPatterns: "not-valid-json{{{",
			}),
		);

		expect(result.status).toBe("error");
		expect(result.message).toContain("Whitelist");
		expect(result.itemsCleaned).toBe(0);
		// Under no circumstances should a broken whitelist cause deletions
		expect(del).not.toHaveBeenCalled();
	});

	it("an enabled file policy with an empty allowlist aborts before fetching or deleting", async () => {
		const get = vi.fn().mockResolvedValue({ records: [STALLED_ITEM] });
		const del = vi.fn();
		const app = makeApp({ get, del });

		const result = await executeQueueCleaner(
			app,
			makeInstance(),
			makeConfig({
				fileExtensionAllowlistEnabled: true,
				allowedFileExtensions: null,
			}),
		);

		expect(result.status).toBe("error");
		expect(result.message).toContain("allowlist");
		expect(get).not.toHaveBeenCalled();
		expect(del).not.toHaveBeenCalled();
	});

	it("deletes the whole torrent payload when a mixed manifest has an unexpected file", async () => {
		const hash = "b".repeat(40);
		const del = vi.fn().mockResolvedValue(undefined);
		const app = makeApp({
			get: async () => ({
				records: [
					{
						...STALLED_ITEM,
						id: 55,
						downloadId: hash,
						trackedDownloadStatus: "ok",
						trackedDownloadState: "downloading",
						statusMessages: [],
						errorMessage: undefined,
					},
				],
			}),
			del,
		});
		quiMocks.listQuiInstances.mockResolvedValue([
			{ id: "qui-1", userId: "user-1", service: "QUI", enabled: true },
		]);
		quiMocks.createQuiClient.mockReturnValue({
			getTorrentByHash: vi.fn().mockResolvedValue({ hash, instanceId: 9 }),
			getTorrentFiles: vi.fn().mockResolvedValue([
				{ index: 0, name: "Movie.mkv", size: 1, progress: 1, priority: 1 },
				{ index: 1, name: "unexpected.exe", size: 1, progress: 0, priority: 0 },
			]),
		});

		const result = await executeQueueCleaner(
			app,
			makeInstance(),
			makeConfig({
				stalledEnabled: false,
				failedEnabled: false,
				fileExtensionAllowlistEnabled: true,
				allowedFileExtensions: '["mkv"]',
				removeFromClient: false,
				addToBlocklist: false,
				changeCategoryEnabled: true,
				lastSeedProtection: false,
			}),
		);

		expect(result.cleanedItems[0]).toMatchObject({
			id: 55,
			rule: "disallowed_file_extension",
		});
		expect(del).toHaveBeenCalledWith(55, {
			removeFromClient: true,
			blocklist: false,
			skipRedownload: true,
			changeCategory: false,
		});
	});

	it("does not remove a torrent when every manifest file is allowed", async () => {
		const hash = "c".repeat(40);
		const del = vi.fn();
		const app = makeApp({
			get: async () => ({
				records: [
					{
						...STALLED_ITEM,
						downloadId: hash,
						trackedDownloadStatus: "ok",
						trackedDownloadState: "downloading",
						statusMessages: [],
						errorMessage: undefined,
					},
				],
			}),
			del,
		});
		quiMocks.listQuiInstances.mockResolvedValue([
			{ id: "qui-1", userId: "user-1", service: "QUI", enabled: true },
		]);
		quiMocks.createQuiClient.mockReturnValue({
			getTorrentByHash: vi.fn().mockResolvedValue({ hash, instanceId: 9 }),
			getTorrentFiles: vi.fn().mockResolvedValue([
				{ index: 0, name: "Movie.MKV", size: 1, progress: 1, priority: 1 },
				{ index: 1, name: "Movie.srt", size: 1, progress: 1, priority: 1 },
			]),
		});

		const result = await executeQueueCleaner(
			app,
			makeInstance(),
			makeConfig({
				stalledEnabled: false,
				failedEnabled: false,
				fileExtensionAllowlistEnabled: true,
				allowedFileExtensions: '["mkv","srt"]',
			}),
		);

		expect(result.itemsCleaned).toBe(0);
		expect(del).not.toHaveBeenCalled();
	});

	it("defers file-policy removal when qui cannot return a manifest", async () => {
		const hash = "d".repeat(40);
		const del = vi.fn();
		const app = makeApp({
			get: async () => ({
				records: [
					{
						...STALLED_ITEM,
						downloadId: hash,
					},
				],
			}),
			del,
		});
		quiMocks.listQuiInstances.mockResolvedValue([
			{ id: "qui-1", userId: "user-1", service: "QUI", enabled: true },
		]);
		quiMocks.createQuiClient.mockReturnValue({
			getTorrentByHash: vi.fn().mockResolvedValue({ hash, instanceId: 9 }),
			getTorrentFiles: vi.fn().mockResolvedValue([]),
		});

		const result = await executeQueueCleaner(
			app,
			makeInstance(),
			makeConfig({
				failedEnabled: false,
				fileExtensionAllowlistEnabled: true,
				allowedFileExtensions: '["mkv"]',
			}),
		);

		expect(result.itemsCleaned).toBe(0);
		expect(result.skippedItems[0]).toMatchObject({ rule: "file_policy_deferred" });
		expect(del).not.toHaveBeenCalled();
	});

	it("shows the same mixed-manifest violation in enhanced preview without deleting", async () => {
		const hash = "e".repeat(40);
		const del = vi.fn();
		const app = makeApp({
			get: async () => ({
				records: [
					{
						...STALLED_ITEM,
						id: 88,
						downloadId: hash,
						trackedDownloadStatus: "ok",
						trackedDownloadState: "downloading",
						statusMessages: [],
						errorMessage: undefined,
					},
				],
			}),
			del,
		});
		quiMocks.listQuiInstances.mockResolvedValue([
			{ id: "qui-1", userId: "user-1", service: "QUI", enabled: true },
		]);
		quiMocks.createQuiClient.mockReturnValue({
			getTorrentByHash: vi.fn().mockResolvedValue({ hash, instanceId: 9 }),
			getTorrentFiles: vi.fn().mockResolvedValue([
				{ index: 0, name: "Movie.mkv", size: 1, progress: 1, priority: 1 },
				{ index: 1, name: "unexpected.exe", size: 1, progress: 0, priority: 0 },
			]),
		});

		const result = await executeEnhancedPreview(
			app,
			makeInstance(),
			makeConfig({
				stalledEnabled: false,
				failedEnabled: false,
				fileExtensionAllowlistEnabled: true,
				allowedFileExtensions: '["mkv"]',
				removeFromClient: false,
				addToBlocklist: false,
				changeCategoryEnabled: true,
				lastSeedProtection: false,
			}),
		);

		expect(result.previewItems[0]).toMatchObject({
			id: 88,
			action: "remove",
			rule: "disallowed_file_extension",
		});
		expect(result.wouldRemove).toBe(1);
		expect(del).not.toHaveBeenCalled();
	});

	it("registry.track wrapping captures a structured-error result as a SUCCESSFUL tick (documents contract)", async () => {
		// The executor returns structured errors instead of throwing. This means
		// the registry — which observes thrown errors — will see the tick as
		// successful. This test documents that contract so future refactors that
		// change the error shape (e.g. to throwing) would need to update the
		// registry wiring to match.
		const app = makeApp({
			get: async () => {
				throw new Error("boom");
			},
			del: vi.fn(),
		});

		const registry = new SchedulerRegistry();
		registry.register({
			id: JOB_ID.queueCleaner,
			label: "Queue cleaner",
			description: "test",
			concurrency: "per-instance",
		});

		const result = await registry.track(JOB_ID.queueCleaner, () =>
			executeQueueCleaner(app, makeInstance(), makeConfig()),
		);

		// Structured error result is returned, not thrown
		expect(result.status).toBe("error");

		const status = registry.getStatus(JOB_ID.queueCleaner)!;
		// From the registry's perspective the tick completed successfully
		expect(status.totalRuns).toBe(1);
		expect(status.totalFailures).toBe(0);
		expect(status.lastSuccessAt).not.toBeNull();
		// The contract for surfacing structured errors to operators is queueCleanerLog,
		// not registry.lastError — this test locks that in.
	});

	it("registry.track wrapping surfaces a thrown error as a FAILED tick", async () => {
		// Mirror: if the delegate does throw (e.g. an unexpected bug escapes the
		// executor's try/catch), the registry counter MUST increment so ops sees it.
		const registry = new SchedulerRegistry();
		registry.register({
			id: JOB_ID.queueCleaner,
			label: "Queue cleaner",
			description: "test",
			concurrency: "per-instance",
		});

		await expect(
			registry.track(JOB_ID.queueCleaner, async () => {
				throw new Error("unexpected executor bug");
			}),
		).rejects.toThrow("unexpected executor bug");

		const status = registry.getStatus(JOB_ID.queueCleaner)!;
		expect(status.totalFailures).toBe(1);
		expect(status.consecutiveFailures).toBe(1);
		expect(status.lastError).toBe("unexpected executor bug");
	});
});
