import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LidarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { withImportConnectionWriteGuard } from "../../arr/import-operations/connection-guards.js";
import {
	beginImportAttempt,
	cancelUnsubmittedImportAttempt,
	readOwnedImportAttempt,
	recordImportCommandObservation,
	recordVerifiedImportFiles,
	releaseTerminalImportSources,
} from "../../arr/import-operations/repository.js";
import { ImportOperationScheduler } from "../../arr/import-operations/scheduler.js";
import { submitTrackedImport } from "../../arr/import-operations/submission.js";
import { Encryptor } from "../../auth/encryption.js";
import { withExclusiveCleanupOperationGuard } from "../../library-cleanup/cleanup-maintenance-gate.js";
import { loggers } from "../../logger.js";
import { executeEnhancedPreview, executeQueueCleaner } from "../cleaner-executor.js";
import {
	acquireQueueSourceAction,
	importConnectionFingerprint,
	queueDownloadKey,
} from "../import-receipt.js";
import { queueItemFingerprint } from "../queue-observation.js";

let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;
const encryptor = new Encryptor(Buffer.alloc(32, 6).toString("base64"));
beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "arr-import-cleaner-"));
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
			{ id: "owner", username: "synthetic-owner" },
			{ id: "other", username: "synthetic-other" },
		],
	});
	await prisma.serviceInstance.createMany({
		data: ["origin", "alias", "foreign"].map((id) => ({
			id,
			userId: id === "foreign" ? "other" : "owner",
			service: "RADARR" as const,
			label: "Synthetic",
			baseUrl: "https://fixture.invalid",
			encryptedApiKey: "synthetic-cipher",
			encryptionIv: "synthetic-iv",
		})),
	});
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

async function startImport(userId = "owner", instanceId = "origin") {
	const client = new RadarrClient({ baseUrl: "https://fixture.invalid", apiKey: "synthetic-key" });
	vi.spyOn(client.manualImport, "get").mockResolvedValue([
		{
			id: 1,
			path: "/synthetic/file",
			downloadId: "source",
			movie: { id: 12 },
			quality: { quality: { id: 1 } },
		},
	] as never);
	const post = vi
		.spyOn(client, "post")
		.mockImplementation(
			async (_path, body) => ({ id: 51, name: "ManualImport", status: "queued", body }) as never,
		);
	const operation = await submitTrackedImport(
		{ prisma, encryptor, createClient: () => client },
		{
			userId,
			instanceId,
			service: "radarr",
			origin: "manual",
			importMode: "auto",
			idempotencyKey: "intentional-attempt",
			files: [{ path: "/synthetic/file", downloadId: "source", movieId: 12 }],
		},
	);
	return { operation, post };
}
async function complete(operation: Awaited<ReturnType<typeof startImport>>["operation"]) {
	expect(
		await recordImportCommandObservation(prisma, operation.userId, operation.id, {
			expectedRevision: operation.revision,
			connectionFingerprint: operation.connectionFingerprint,
			commandFingerprint: operation.commandFingerprint,
			commandId: 51,
			state: "completed",
			terminal: true,
			checkedAt: new Date(),
		}),
	).toBe(true);
	const observed = await readOwnedImportAttempt(prisma, operation.userId, operation.id);
	if (!observed) throw new Error("Missing synthetic attempt");
	expect(
		await recordVerifiedImportFiles(prisma, operation.userId, operation.id, {
			expectedRevision: observed.revision,
			connectionFingerprint: operation.connectionFingerprint,
			commandFingerprint: operation.commandFingerprint,
			commandId: 51,
			fileFingerprints: observed.files.map((file) => file.fileFingerprint),
			verifiedAt: new Date(),
		}),
	).toBe(true);
	await releaseTerminalImportSources(prisma, operation.userId, operation.id);
}
async function cleanerFixture() {
	const instance = await prisma.serviceInstance.findFirstOrThrow({
		where: { id: "alias", userId: "owner" },
	});
	const config = await prisma.queueCleanerConfig.create({
		data: {
			instanceId: instance.id,
			enabled: true,
			dryRunMode: false,
			minQueueAgeMins: 0,
			stalledEnabled: false,
			importPendingEnabled: true,
			importPendingThresholdMins: 0,
			autoImportEnabled: false,
			strikeSystemEnabled: false,
			lastSeedProtection: false,
		},
	});
	const item = {
		id: 42,
		title: "Synthetic",
		downloadId: "source",
		protocol: "usenet",
		movieId: 12,
		added: new Date(Date.now() - 3_600_000).toISOString(),
		trackedDownloadState: "importPending",
	};
	const client = new RadarrClient({ baseUrl: "https://fixture.invalid", apiKey: "synthetic-key" });
	vi.spyOn(client.queue, "get").mockImplementation(
		async (options?: { page?: number }) =>
			({ page: options?.page ?? 1, pageSize: 1000, totalRecords: 1, records: [item] }) as never,
	);
	const current = vi.spyOn(client.queue, "getById").mockImplementation(async () => item as never);
	const remove = vi.spyOn(client.queue, "delete").mockResolvedValue(undefined as never);
	const post = vi.spyOn(client, "post").mockRejectedValue(new Error("Unexpected synthetic POST"));
	vi.spyOn(client, "get").mockRejectedValue(new Error("Unexpected synthetic provider GET"));
	const app = {
		prisma,
		encryptor,
		arrClientFactory: { create: () => client },
	} as unknown as FastifyInstance;
	return {
		app,
		instance,
		config,
		item,
		client,
		current,
		remove,
		post,
		run: () => executeQueueCleaner(app, instance, config),
	};
}
async function journal() {
	return {
		operations: await prisma.arrImportOperation.findMany({ where: { userId: "owner" } }),
		proofs: await prisma.arrImportFileProof.findMany({ where: { operation: { userId: "owner" } } }),
		claims: await prisma.arrImportSourceClaim.findMany({ where: { userId: "owner" } }),
		strikes: await prisma.queueCleanerStrike.findMany({ where: { instance: { userId: "owner" } } }),
	};
}

async function automaticCleanerFixture() {
	const f = await cleanerFixture();
	const config = await prisma.queueCleanerConfig.update({
		where: { id: f.config.id },
		data: { autoImportEnabled: true, autoImportSafeOnly: false, autoImportCooldownMins: 0 },
	});
	const candidates = vi.spyOn(f.client.manualImport, "get").mockResolvedValue([
		{
			id: 1,
			path: "/synthetic/file",
			downloadId: "source",
			movie: { id: 12 },
			quality: { quality: { id: 1 } },
		},
	] as never);
	f.post.mockImplementation(
		async (_path, body) => ({ id: 51, name: "ManualImport", status: "queued", body }) as never,
	);
	return { ...f, config, candidates, run: () => executeQueueCleaner(f.app, f.instance, config) };
}

const automaticServices = [
	{
		service: "SONARR",
		Client: SonarrClient,
		media: { seriesId: 12, episodeId: 13 },
		candidate: { series: { id: 12 }, episodes: [{ id: 13 }] },
		commandMapping: { seriesId: 12, episodeIds: [13] },
	},
	{
		service: "RADARR",
		Client: RadarrClient,
		media: { movieId: 12 },
		candidate: { movie: { id: 12 } },
		commandMapping: { movieId: 12 },
	},
	{
		service: "LIDARR",
		Client: LidarrClient,
		media: { artistId: 12, albumId: 13 },
		candidate: {
			artist: { id: 12 },
			album: { id: 13 },
			albumReleaseId: 14,
			tracks: [{ id: 15 }],
		},
		commandMapping: { artistId: 12, albumId: 13, albumReleaseId: 14, trackIds: [15] },
	},
	{
		service: "READARR",
		Client: ReadarrClient,
		media: { authorId: 12, bookId: 13 },
		candidate: { author: { id: 12 }, book: { id: 13 }, foreignEditionId: "edition-1" },
		commandMapping: { authorId: 12, bookId: 13, foreignEditionId: "edition-1" },
	},
] as const;

async function automaticServiceFixture(
	service: (typeof automaticServices)[number],
	candidateOverrides: Record<string, unknown> = {},
) {
	const f = await automaticCleanerFixture();
	const instance = await prisma.serviceInstance.update({
		where: { id: f.instance.id, userId: "owner" },
		data: { service: service.service },
	});
	const client = new service.Client({
		baseUrl: "https://fixture.invalid",
		apiKey: "synthetic-key",
	});
	const item = { ...f.item, movieId: undefined, ...service.media };
	vi.spyOn(client.queue, "get").mockImplementation(
		async (options?: { page?: number }) =>
			({ page: options?.page ?? 1, pageSize: 1000, totalRecords: 1, records: [item] }) as never,
	);
	if (!(client instanceof LidarrClient))
		vi.spyOn(client.queue, "getById").mockResolvedValue(item as never);
	const rows = [
		{
			id: 1,
			path: "/synthetic/file",
			downloadId: "source",
			quality: { quality: { id: 1 } },
			...service.candidate,
			...candidateOverrides,
		},
	];
	if (client instanceof SonarrClient || client instanceof RadarrClient)
		vi.spyOn(client.manualImport, "get").mockResolvedValue(rows as never);
	else vi.spyOn(client, "get").mockResolvedValue(rows as never);
	const post = vi
		.spyOn(client, "post")
		.mockImplementation(
			async (_path, body) => ({ id: 51, name: "ManualImport", status: "queued", body }) as never,
		);
	const remove = vi.spyOn(client.queue, "delete").mockResolvedValue(undefined as never);
	const app = {
		...f.app,
		arrClientFactory: { create: () => client },
	} as unknown as FastifyInstance;
	return {
		...f,
		instance,
		item,
		client,
		post,
		remove,
		run: () => executeQueueCleaner(app, instance, f.config),
	};
}

describe("Cleaner preview models attempted imports without removal authority", () => {
	it.each(["maximum", "cooldown"])(
		"preserves the current ineligible-%s policy without inventing import authority",
		async (kind) => {
			const f = await automaticCleanerFixture();
			const config = await prisma.queueCleanerConfig.update({
				where: { id: f.config.id },
				data: { autoImportMaxAttempts: kind === "maximum" ? 1 : 3, autoImportCooldownMins: 30 },
			});
			await prisma.queueCleanerStrike.create({
				data: {
					instanceId: f.instance.id,
					downloadId: "42",
					downloadTitle: "Synthetic",
					downloadFingerprint: queueItemFingerprint(f.item),
					strikeCount: 0,
					lastRule: "import_pending",
					lastReason: "Synthetic",
					importAttempts: 1,
					lastImportAttempt: new Date(),
				},
			});
			const before = await journal();
			expect(await executeEnhancedPreview(f.app, f.instance, config)).toMatchObject({
				wouldRemove: 1,
				wouldImport: 0,
				previewItems: [expect.objectContaining({ action: "remove", autoImportEligible: false })],
			});
			const dryRun = await executeQueueCleaner(f.app, f.instance, { ...config, dryRunMode: true });
			expect(dryRun.skippedItems[0]?.reason).toContain("Would remove");
			expect(await journal()).toEqual(before);
			expect(f.post).not.toHaveBeenCalled();
			expect(f.remove).not.toHaveBeenCalled();
			const execution = await executeQueueCleaner(f.app, f.instance, config);
			expect(execution.cleanedItems.map((item) => item.id)).toEqual([42]);
			expect(f.remove).toHaveBeenCalledOnce();
			expect(f.post).not.toHaveBeenCalled();
		},
	);
	it("applies the combined action cap in the same order for imports and removals", async () => {
		const f = await automaticCleanerFixture();
		const config = await prisma.queueCleanerConfig.update({
			where: { id: f.config.id },
			data: { maxRemovalsPerRun: 2 },
		});
		const items = [
			f.item,
			{ ...f.item, id: 43, downloadId: "blocked-source", errorMessage: "sample only" },
			{ ...f.item, id: 44, downloadId: "later-source" },
		];
		vi.mocked(f.client.queue.get).mockResolvedValue({
			page: 1,
			pageSize: 1000,
			totalRecords: items.length,
			records: items,
		} as never);
		f.current.mockImplementation(async (id) => items.find((item) => item.id === id) as never);
		const before = await journal();
		const preview = await executeEnhancedPreview(f.app, f.instance, config);
		expect(preview).toMatchObject({ wouldRemove: 1, wouldImport: 1, wouldSkip: 1 });
		expect(preview.previewItems.map((item) => item.action)).toEqual(["import", "remove", "skip"]);
		const dryRun = await executeQueueCleaner(f.app, f.instance, { ...config, dryRunMode: true });
		expect(dryRun.skippedItems.map((item) => item.id)).toEqual([42, 43, 44]);
		expect(dryRun.skippedItems[0]?.reason).toContain("Would attempt import");
		expect(dryRun.skippedItems[1]?.reason).toContain("Would remove");
		expect(dryRun.skippedItems[2]?.reason).toContain("max removals");
		expect(await journal()).toEqual(before);
		const execution = await executeQueueCleaner(f.app, f.instance, config);
		expect(execution.cleanedItems.map((item) => item.id)).toEqual([43]);
		expect(f.post).toHaveBeenCalledOnce();
		expect(f.remove).toHaveBeenCalledOnce();
		expect(f.remove).toHaveBeenCalledWith(43, expect.anything());
	});
	it.each(automaticServices)(
		"previews $service import attempts without writing",
		async (service) => {
			const f = await automaticServiceFixture(service);
			const app = {
				...f.app,
				arrClientFactory: { create: () => f.client },
			} as unknown as FastifyInstance;
			const before = await journal();
			const preview = await executeEnhancedPreview(app, f.instance, f.config);
			expect(preview).toMatchObject({ wouldRemove: 0, wouldImport: 1, wouldWarn: 0, wouldSkip: 0 });
			expect(preview.previewItems[0]).toMatchObject({
				id: 42,
				action: "import",
				autoImportEligible: true,
			});
			expect(preview.previewItems[0]?.detailedReason).toContain("source retained");
			const dryRun = await executeQueueCleaner(app, f.instance, { ...f.config, dryRunMode: true });
			expect(dryRun).toMatchObject({ isDryRun: true, itemsCleaned: 0 });
			expect(dryRun.skippedItems[0]?.reason).toContain("Would attempt import");
			expect(dryRun.skippedItems[0]?.reason).not.toContain("Would remove");
			expect(dryRun.message).toContain("attempt import");
			expect(await journal()).toEqual(before);
			expect(f.post).not.toHaveBeenCalled();
			expect(f.remove).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ maxRemovalsPerRun: 100, wouldImport: 10, reason: "import budget" },
		{ maxRemovalsPerRun: 2, wouldImport: 2, reason: "max removals" },
	])(
		"shows capped actions as kept ($maxRemovalsPerRun)",
		async ({ maxRemovalsPerRun, wouldImport, reason }) => {
			const f = await automaticCleanerFixture();
			const items = Array.from({ length: 11 }, (_, index) => ({
				...f.item,
				id: index + 1,
				downloadId: `source-${index}`,
			}));
			vi.mocked(f.client.queue.get).mockResolvedValue({
				page: 1,
				pageSize: 1000,
				totalRecords: items.length,
				records: items,
			} as never);
			const config = { ...f.config, maxRemovalsPerRun };
			const before = await journal();
			const preview = await executeEnhancedPreview(f.app, f.instance, config);
			expect(preview).toMatchObject({ wouldRemove: 0, wouldImport, wouldSkip: 11 - wouldImport });
			expect(preview.previewItems.filter((item) => item.action === "import")).toHaveLength(
				wouldImport,
			);
			expect(preview.previewItems.at(-1)).toMatchObject({
				action: "skip",
				reason: expect.stringContaining(reason),
			});
			const dryRun = await executeQueueCleaner(f.app, f.instance, { ...config, dryRunMode: true });
			expect(
				dryRun.skippedItems.filter((item) => item.reason.includes("Would attempt import")),
			).toHaveLength(wouldImport);
			expect(dryRun.skippedItems.at(-1)?.reason).toContain(reason);
			expect(await journal()).toEqual(before);
			expect(f.candidates).not.toHaveBeenCalled();
			expect(f.post).not.toHaveBeenCalled();
			expect(f.remove).not.toHaveBeenCalled();
		},
	);
	it("keeps capped removal rows consistent with their count", async () => {
		const f = await cleanerFixture();
		const items = [f.item, { ...f.item, id: 43, downloadId: "other-source" }];
		vi.mocked(f.client.queue.get).mockResolvedValue({
			page: 1,
			pageSize: 1000,
			totalRecords: 2,
			records: items,
		} as never);
		const preview = await executeEnhancedPreview(f.app, f.instance, {
			...f.config,
			maxRemovalsPerRun: 1,
		});
		expect(preview).toMatchObject({ wouldRemove: 1, wouldImport: 0, wouldSkip: 1 });
		expect(preview.previewItems.map((item) => item.action)).toEqual(["remove", "skip"]);
		expect(f.remove).not.toHaveBeenCalled();
	});
	it("warns below the strike threshold instead of promising an import", async () => {
		const f = await automaticCleanerFixture();
		const config = { ...f.config, strikeSystemEnabled: true, maxStrikes: 2 };
		const before = await journal();
		expect(await executeEnhancedPreview(f.app, f.instance, config)).toMatchObject({
			wouldRemove: 0,
			wouldImport: 0,
			wouldWarn: 1,
			previewItems: [expect.objectContaining({ action: "warn", autoImportEligible: true })],
		});
		const dryRun = await executeQueueCleaner(f.app, f.instance, { ...config, dryRunMode: true });
		expect(dryRun.warnedItems).toHaveLength(1);
		expect(dryRun.skippedItems).toHaveLength(0);
		expect(await journal()).toEqual(before);
		expect(f.post).not.toHaveBeenCalled();
	});
});

describe("cleaner produces shared tracked import operations", () => {
	it.each(["eligible", "cooldown", "disabled", "counter-race"])(
		"handles %s automatic allowance after genuine non-submission without permitting removal",
		async (kind) => {
			const f = await automaticCleanerFixture();
			const config = await prisma.queueCleanerConfig.update({
				where: { id: f.config.id },
				data: { autoImportMaxAttempts: 2 },
			});
			f.current.mockImplementation(async () => {
				const preparing = await prisma.arrImportOperation.count({
					where: { userId: "owner", state: "preparing" },
				});
				return {
					...f.item,
					...(preparing ? { trackedDownloadState: "downloading" } : {}),
				} as never;
			});
			await executeQueueCleaner(f.app, f.instance, config);
			const denied = await prisma.arrImportOperation.findFirstOrThrow({
				where: { userId: "owner" },
			});
			expect(denied).toMatchObject({ state: "not-submitted", submissionStartedAt: null });
			f.current.mockResolvedValue(f.item as never);
			const currentConfig = await prisma.queueCleanerConfig.update({
				where: { id: config.id },
				data: {
					autoImportEnabled: kind !== "disabled",
					autoImportCooldownMins: kind === "cooldown" ? 30 : 0,
				},
			});
			const retained = await journal();
			expect(await executeEnhancedPreview(f.app, f.instance, currentConfig)).toMatchObject({
				wouldImport: kind === "cooldown" || kind === "disabled" ? 0 : 1,
				wouldRemove: 0,
				previewItems: [
					expect.objectContaining({
						action: kind === "cooldown" || kind === "disabled" ? "skip" : "import",
					}),
				],
			});
			const dry = await executeQueueCleaner(f.app, f.instance, {
				...currentConfig,
				dryRunMode: true,
			});
			expect(dry.itemsCleaned).toBe(0);
			expect(dry.skippedItems[0]?.reason).not.toContain("Would remove");
			expect(await journal()).toEqual(retained);
			expect(f.post).not.toHaveBeenCalled();
			if (kind === "counter-race") {
				const find = prisma.queueCleanerStrike.findMany.bind(prisma.queueCleanerStrike);
				vi.spyOn(prisma.queueCleanerStrike, "findMany").mockImplementation((args) => {
					// This consumer awaits the read, never batches it into a transaction.
					const result = (async () => {
						if (!args?.take) {
							await prisma.queueCleanerStrike.updateMany({
								where: { instanceId: f.instance.id },
								data: { importAttempts: 2 },
							});
							const rows = await find(args);
							await prisma.queueCleanerStrike.deleteMany({ where: { instanceId: f.instance.id } });
							return rows;
						}
						return find(args);
					})();
					return {
						// biome-ignore lint/suspicious/noThenProperty: Intentionally model PrismaPromise for this awaited read, not transaction batching.
						then: result.then.bind(result),
						catch: result.catch.bind(result),
						finally: result.finally.bind(result),
						[Symbol.toStringTag]: "PrismaPromise" as const,
					};
				});
			}
			expect(await executeQueueCleaner(f.app, f.instance, currentConfig)).toMatchObject({
				itemsCleaned: 0,
			});
			expect(
				await prisma.arrImportOperation.count({ where: { userId: "owner", state: "pending" } }),
			).toBe(kind === "eligible" ? 1 : 0);
			expect(
				await prisma.arrImportOperation.findFirst({ where: { id: denied.id, userId: "owner" } }),
			).toEqual(denied);
			expect(
				await prisma.queueCleanerStrike.findFirst({ where: { instanceId: f.instance.id } }),
			).toEqual(
				kind === "counter-race"
					? null
					: expect.objectContaining({ importAttempts: kind === "eligible" ? 2 : 1 }),
			);
			expect(f.post).toHaveBeenCalledTimes(kind === "eligible" ? 1 : 0);
			expect(f.remove).not.toHaveBeenCalled();
		},
	);
	it.each(["final-denial", "restart-recovery"])(
		"retains an exhausted automatic non-submission after %s and allows deliberate manual recovery",
		async (kind) => {
			const f = await automaticCleanerFixture();
			const config = await prisma.queueCleanerConfig.update({
				where: { id: f.config.id },
				data: { autoImportMaxAttempts: 1 },
			});
			f.current.mockImplementation(async () => {
				const preparing = await prisma.arrImportOperation.findFirst({
					where: { userId: "owner", state: "preparing" },
				});
				return {
					...f.item,
					...(preparing ? { trackedDownloadState: "downloading" } : {}),
				} as never;
			});
			expect(await executeQueueCleaner(f.app, f.instance, config)).toMatchObject({
				itemsCleaned: 0,
			});
			const denied = await prisma.arrImportOperation.findFirstOrThrow({
				where: { userId: "owner", origin: "queue-cleaner" },
			});
			expect(denied).toMatchObject({ state: "not-submitted", submissionStartedAt: null });
			expect(
				await prisma.queueCleanerStrike.findFirst({ where: { instanceId: f.instance.id } }),
			).toMatchObject({ importAttempts: 1 });
			expect(
				await prisma.arrImportSourceClaim.count({ where: { activeOperationId: { not: null } } }),
			).toBe(0);
			expect(f.post).not.toHaveBeenCalled();
			if (kind === "restart-recovery") {
				await prisma.arrImportOperation.update({
					where: { id: denied.id, userId: "owner" },
					data: { state: "preparing", preparationExpiresAt: new Date(Date.now() - 1_000) },
				});
				await prisma.arrImportSourceClaim.updateMany({
					where: { userId: "owner" },
					data: { activeOperationId: denied.id },
				});
				await prisma.$disconnect();
				await prisma.$connect();
				await new ImportOperationScheduler({ prisma, encryptor, createClient: () => f.client }, {
					info: vi.fn(),
					warn: vi.fn(),
				} as never).tick();
			}
			f.current.mockResolvedValue(f.item as never);
			// Use the owner's alias, not only the original Cleaner connection.
			const alias = await prisma.serviceInstance.findFirstOrThrow({
				where: { id: "origin", userId: "owner" },
			});
			const retained = await journal();
			expect(await executeEnhancedPreview(f.app, f.instance, config)).toMatchObject({
				wouldRemove: 0,
				wouldImport: 0,
			});
			const preview = await executeEnhancedPreview(f.app, alias, config);
			expect(preview).toMatchObject({ wouldRemove: 0, wouldImport: 0 });
			expect(preview.previewItems[0]).toMatchObject({ action: "skip" });
			const dry = await executeQueueCleaner(f.app, alias, { ...config, dryRunMode: true });
			expect(dry.itemsCleaned).toBe(0);
			expect(dry.skippedItems[0]?.reason).not.toContain("Would remove");
			expect(await journal()).toEqual(retained);
			expect(await executeQueueCleaner(f.app, alias, config)).toMatchObject({ itemsCleaned: 0 });
			expect(await executeQueueCleaner(f.app, f.instance, config)).toMatchObject({
				itemsCleaned: 0,
			});
			expect(f.post).not.toHaveBeenCalled();
			expect(f.remove).not.toHaveBeenCalled();
			const recovered = await startImport();
			expect(recovered.operation).toMatchObject({ origin: "manual", state: "pending" });
			expect(recovered.post).toHaveBeenCalledOnce();
			expect(await readOwnedImportAttempt(prisma, "owner", denied.id)).toEqual(
				retained.operations[0] ? { ...retained.operations[0], files: retained.proofs } : null,
			);
			expect(f.remove).not.toHaveBeenCalled();
		},
	);
	it("does not report completion merely because a submitted source disappears from the queue", async () => {
		const f = await automaticCleanerFixture();
		await f.run();
		vi.mocked(f.client.queue.get).mockResolvedValue({
			page: 1,
			pageSize: 1000,
			totalRecords: 0,
			records: [],
		} as never);
		expect(await f.run()).toMatchObject({ status: "partial", itemsCleaned: 0 });
		expect(await prisma.arrImportOperation.findFirst({ where: { userId: "owner" } })).toMatchObject(
			{ state: "pending", verifiedFileCount: 0 },
		);
		expect(f.post).toHaveBeenCalledOnce();
		expect(f.remove).not.toHaveBeenCalled();
	});
	it.each(automaticServices)(
		"selects and tracks exact $service files through the real executor",
		async (service) => {
			const f = await automaticServiceFixture(service);
			expect(await f.run()).toMatchObject({ status: "partial", itemsCleaned: 0, cleanedItems: [] });
			expect(
				await prisma.arrImportOperation.findFirst({
					where: { userId: "owner" },
					include: { files: true },
				}),
			).toMatchObject({
				origin: "queue-cleaner",
				service: service.service,
				state: "pending",
				selectedFileCount: 1,
				verifiedFileCount: 0,
				files: [expect.objectContaining({ verifiedAt: null })],
			});
			const operation = await prisma.arrImportOperation.findFirstOrThrow({
				where: { userId: "owner" },
				include: { files: true },
			});
			expect(operation.files[0]?.identityJson).toMatchObject(service.commandMapping);
			const sources = JSON.parse(
				encryptor.decrypt({
					value: operation.encryptedSources,
					iv: operation.sourcesEncryptionIv,
				}),
			);
			expect(sources.files).toEqual([
				expect.objectContaining({
					path: "/synthetic/file",
					downloadId: "source",
					...service.commandMapping,
				}),
			]);
			await f.run();
			expect(f.post).toHaveBeenCalledOnce();
			expect(f.post.mock.calls[0]?.[1]).toMatchObject({
				name: "ManualImport",
				importMode: "Move",
				files: [
					expect.objectContaining({
						downloadId: "source",
						path: "/synthetic/file",
						...service.commandMapping,
					}),
				],
			});
			expect(f.remove).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ service: automaticServices[2], category: "missing tracks", fields: { tracks: undefined } },
		{
			service: automaticServices[2],
			category: "missing release",
			fields: { albumReleaseId: undefined },
		},
		{
			service: automaticServices[2],
			category: "duplicate tracks",
			fields: { tracks: [{ id: 15 }, { id: 15 }] },
		},
		{
			service: automaticServices[3],
			category: "missing edition",
			fields: { foreignEditionId: undefined },
		},
		{
			service: automaticServices[3],
			category: "null edition",
			fields: { foreignEditionId: null },
		},
		{
			service: automaticServices[3],
			category: "empty edition",
			fields: { foreignEditionId: "" },
		},
	])(
		"retains the source without dispatch when provider mapping has $category",
		async (testCase) => {
			const f = await automaticServiceFixture(testCase.service, testCase.fields);
			for (let run = 0; run < 2; run++) {
				expect(await f.run()).toMatchObject({
					status: "partial",
					itemsCleaned: 0,
					cleanedItems: [],
				});
				expect(await prisma.arrImportOperation.count({ where: { userId: "owner" } })).toBe(0);
				expect(
					await prisma.arrImportFileProof.count({ where: { operation: { userId: "owner" } } }),
				).toBe(0);
				expect(await prisma.arrImportSourceClaim.count({ where: { userId: "owner" } })).toBe(0);
			}
			expect(f.post).not.toHaveBeenCalled();
			expect(f.remove).not.toHaveBeenCalled();
		},
	);
	it("logs only generic automatic-import categories, never provider titles or errors", async () => {
		const f = await automaticCleanerFixture();
		f.item.title = "Synthetic private title sentinel";
		f.candidates.mockRejectedValue(new Error("Synthetic private error sentinel"));
		const info = vi.spyOn(loggers.queueCleaner, "info");
		const warn = vi.spyOn(loggers.queueCleaner, "warn");
		await f.run();
		const logs = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
		expect(logs).not.toContain("Synthetic private title sentinel");
		expect(logs).not.toContain("Synthetic private error sentinel");
		expect(f.remove).not.toHaveBeenCalled();
	});
	it("retains later eligible sources when the per-run import budget is exhausted", async () => {
		const f = await automaticCleanerFixture();
		const config = await prisma.queueCleanerConfig.update({
			where: { id: f.config.id },
			data: { maxRemovalsPerRun: 100 },
		});
		const items = Array.from({ length: 11 }, (_, index) => ({
			...f.item,
			id: index + 1,
			downloadId: `source-${index}`,
		}));
		vi.mocked(f.client.queue.get).mockImplementation(
			async (options) =>
				({
					page: options?.page ?? 1,
					pageSize: 1000,
					totalRecords: items.length,
					records: items,
				}) as never,
		);
		f.current.mockImplementation(async (id) => items.find((item) => item.id === id) as never);
		f.candidates.mockImplementation(async (options) => {
			if (!options?.downloadId) throw new Error("Expected one exact synthetic source");
			return [
				{
					id: 1,
					path: `/synthetic/${options.downloadId}`,
					downloadId: options.downloadId,
					movie: { id: 12 },
					quality: { quality: { id: 1 } },
				},
			] as never;
		});
		const result = await executeQueueCleaner(f.app, f.instance, config);
		expect(result).toMatchObject({ status: "partial", itemsCleaned: 0 });
		expect(result.skippedItems.find((item) => item.id === 11)?.reason).toContain("import budget");
		expect(f.post).toHaveBeenCalledTimes(10);
		expect(f.remove).not.toHaveBeenCalled();
		expect(await prisma.arrImportOperation.count({ where: { userId: "owner" } })).toBe(10);
		expect(
			await prisma.queueCleanerStrike.count({ where: { instance: { userId: "owner" } } }),
		).toBe(10);
		// A later run can admit the deferred source without replaying the ten
		// submitted attempts or changing source-retention authority.
		expect(await executeQueueCleaner(f.app, f.instance, config)).toMatchObject({ itemsCleaned: 0 });
		expect(f.post).toHaveBeenCalledTimes(11);
		expect(f.remove).not.toHaveBeenCalled();
		expect(await prisma.arrImportOperation.count({ where: { userId: "owner" } })).toBe(11);
	});
	it("retains submitted source authority after counter clearing and a database reconnect", async () => {
		const f = await automaticCleanerFixture();
		await f.run();
		await prisma.queueCleanerStrike.deleteMany({
			where: { instanceId: f.instance.id, instance: { userId: "owner" } },
		});
		await prisma.$disconnect();
		await prisma.$connect();
		expect(await f.run()).toMatchObject({ status: "partial", itemsCleaned: 0 });
		expect(await prisma.arrImportOperation.count({ where: { userId: "owner" } })).toBe(1);
		expect(await prisma.queueCleanerStrike.count()).toBe(0);
		expect(f.post).toHaveBeenCalledOnce();
		expect(f.remove).not.toHaveBeenCalled();
	});
	it("admits at most one shared operation across concurrent real executors", async () => {
		const f = await automaticCleanerFixture();
		const results = await Promise.all([f.run(), f.run()]);
		expect(results.every((result) => result.itemsCleaned === 0)).toBe(true);
		expect(await prisma.arrImportOperation.count({ where: { userId: "owner" } })).toBe(1);
		expect(f.post).toHaveBeenCalledOnce();
		expect(f.remove).not.toHaveBeenCalled();
	});
	it("holds source, connection and topology guards until the actual provider write settles", async () => {
		const f = await automaticCleanerFixture();
		let settle!: () => void;
		const held = new Promise<void>((resolve) => {
			settle = resolve;
		});
		f.post.mockImplementation(async (_path, body) => {
			await held;
			return { id: 51, name: "ManualImport", status: "queued", body } as never;
		});
		const running = f.run();
		try {
			await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce());
			expect(acquireQueueSourceAction("owner", f.item)).toBeNull();
			await expect(
				withImportConnectionWriteGuard("owner", f.instance.id, async () => true),
			).rejects.toMatchObject({ statusCode: 409 });
			await expect(withExclusiveCleanupOperationGuard(async () => true)).rejects.toMatchObject({
				statusCode: 409,
			});
			expect(
				await prisma.arrImportOperation.findFirst({ where: { userId: "owner" } }),
			).toMatchObject({ state: "submitting" });
			expect(await f.run()).toMatchObject({ itemsCleaned: 0 });
			expect(f.post).toHaveBeenCalledOnce();
		} finally {
			settle();
			await running;
		}
		const permit = acquireQueueSourceAction("owner", f.item);
		expect(permit).not.toBeNull();
		permit?.();
		expect(f.remove).not.toHaveBeenCalled();
	});
	it("does not exclude legacy evidence appearing after its own preparation", async () => {
		const f = await automaticCleanerFixture();
		let seeded = false;
		f.current.mockImplementation(async () => {
			if (
				!seeded &&
				(await prisma.arrImportOperation.count({ where: { userId: "owner", state: "preparing" } }))
			) {
				seeded = true;
				await prisma.queueCleanerImportReceipt.create({
					data: {
						instanceId: "origin",
						downloadKey: queueDownloadKey(f.item)!,
						queueId: 42,
						downloadTitle: "Synthetic",
						connectionFingerprint: "a".repeat(64),
						commandFingerprint: `v1:${"b".repeat(64)}`,
						state: "unknown",
						lastAttemptAt: new Date(),
					},
				});
			}
			return f.item as never;
		});
		expect(await f.run()).toMatchObject({ status: "partial", itemsCleaned: 0 });
		expect(seeded).toBe(true);
		expect(await prisma.arrImportOperation.findFirst({ where: { userId: "owner" } })).toMatchObject(
			{ state: "not-submitted", submissionStartedAt: null },
		);
		expect(f.post).not.toHaveBeenCalled();
		expect(f.remove).not.toHaveBeenCalled();
	});
	it("commits one operation, selected file and attempt before POST, then observes without replay", async () => {
		const f = await automaticCleanerFixture();
		let admittedBeforePost = false;
		f.post.mockImplementation(async (_path, body) => {
			const operation = await prisma.arrImportOperation.findFirst({
				where: { userId: "owner", originalInstanceId: f.instance.id },
				include: { files: true },
			});
			const strike = await prisma.queueCleanerStrike.findFirst({
				where: { instanceId: f.instance.id, downloadId: "42", instance: { userId: "owner" } },
			});
			admittedBeforePost =
				operation?.state === "submitting" &&
				operation.files.length === 1 &&
				strike?.importAttempts === 1 &&
				strike.lastImportAttempt?.getTime() === operation.createdAt.getTime();
			return { id: 51, name: "ManualImport", status: "queued", body } as never;
		});
		expect(await f.run()).toMatchObject({ itemsCleaned: 0, cleanedItems: [] });
		expect(admittedBeforePost).toBe(true);
		expect(await prisma.arrImportOperation.findFirst({ where: { userId: "owner" } })).toMatchObject(
			{ origin: "queue-cleaner", state: "pending", verifiedFileCount: 0 },
		);
		expect(await prisma.queueCleanerImportReceipt.count()).toBe(0);
		await f.run();
		expect(await prisma.arrImportOperation.count()).toBe(1);
		expect(
			await prisma.queueCleanerStrike.findFirst({
				where: { instanceId: f.instance.id, downloadId: "42" },
			}),
		).toMatchObject({ importAttempts: 1 });
		expect(f.post).toHaveBeenCalledOnce();
		expect(f.remove).not.toHaveBeenCalled();
	});
	it("stops before POST when current automatic policy is disabled during candidate validation", async () => {
		const f = await automaticCleanerFixture();
		f.candidates.mockImplementation(async () => {
			await prisma.queueCleanerConfig.update({
				where: { id: f.config.id },
				data: { autoImportEnabled: false },
			});
			return [
				{
					id: 1,
					path: "/synthetic/file",
					downloadId: "source",
					movie: { id: 12 },
					quality: { quality: { id: 1 } },
				},
			] as never;
		});
		expect(await f.run()).toMatchObject({ status: "partial", itemsCleaned: 0 });
		expect(f.post).not.toHaveBeenCalled();
		expect(f.remove).not.toHaveBeenCalled();
	});
	it("retains an ambiguous write in durable operation history and never automatically replays it", async () => {
		const f = await automaticCleanerFixture();
		f.post.mockRejectedValue(new Error("Synthetic private provider failure"));
		expect(await f.run()).toMatchObject({ status: "partial", itemsCleaned: 0 });
		expect(await prisma.arrImportOperation.findFirst({ where: { userId: "owner" } })).toMatchObject(
			{ state: "unknown", commandId: null },
		);
		await f.run();
		expect(f.post).toHaveBeenCalledOnce();
		expect(f.remove).not.toHaveBeenCalled();
	});
	it("does not convert a pre-submit candidate failure into cleanup permission", async () => {
		const f = await automaticCleanerFixture();
		f.candidates.mockRejectedValue(new Error("Synthetic private candidate failure"));
		const result = await f.run();
		expect(result).toMatchObject({ status: "partial", itemsCleaned: 0 });
		expect(JSON.stringify(result)).not.toContain("Synthetic private candidate failure");
		expect(f.post).not.toHaveBeenCalled();
		expect(f.remove).not.toHaveBeenCalled();
	});
});

describe("cleaner coexistence with shared import evidence", () => {
	it.each(["pending", "submitting", "unknown", "failed", "partial", "future-state"])(
		"preview, dry-run and execution retain a %s source across owned aliases",
		async (state) => {
			const tracked = await startImport();
			await prisma.arrImportOperation.updateMany({
				where: { id: tracked.operation.id, userId: "owner" },
				data: { state },
			});
			const f = await cleanerFixture();
			const before = await journal();
			const preview = await executeEnhancedPreview(f.app, f.instance, f.config);
			expect(preview.wouldRemove).toBe(0);
			expect(preview.previewItems[0]?.action).toBe("skip");
			const dry = await executeQueueCleaner(f.app, f.instance, { ...f.config, dryRunMode: true });
			expect(dry.skippedItems[0]?.reason).not.toContain("Would remove");
			expect(await journal()).toEqual(before);
			expect(await f.run()).toMatchObject({ itemsCleaned: 0 });
			expect(f.remove).not.toHaveBeenCalled();
			expect(f.post).not.toHaveBeenCalled();
			expect(tracked.post).toHaveBeenCalledOnce();
		},
	);
	it("retains a completed queued source even after its submission claim is released", async () => {
		const tracked = await startImport();
		await complete(tracked.operation);
		const f = await cleanerFixture();
		expect(await executeEnhancedPreview(f.app, f.instance, f.config)).toMatchObject({
			wouldRemove: 0,
		});
		expect(await f.run()).toMatchObject({ itemsCleaned: 0 });
		expect(f.remove).not.toHaveBeenCalled();
	});
	it("does not let another owner's operation block or authorize cleanup", async () => {
		await startImport("other", "foreign");
		const f = await cleanerFixture();
		expect(await executeEnhancedPreview(f.app, f.instance, f.config)).toMatchObject({
			wouldRemove: 1,
		});
		expect(await f.run()).toMatchObject({ itemsCleaned: 1 });
		expect(f.remove).toHaveBeenCalledOnce();
		expect(f.remove.mock.calls[0]?.[0]).toBe(42);
	});
	it("protects a dangling active source claim without borrowing a command", async () => {
		await prisma.arrImportSourceClaim.create({
			data: {
				userId: "owner",
				downloadKey: createHash("sha256").update("source").digest("hex"),
				activeOperationId: "missing-operation",
			},
		});
		const f = await cleanerFixture();
		expect(await executeEnhancedPreview(f.app, f.instance, f.config)).toMatchObject({
			wouldRemove: 0,
		});
		expect(await f.run()).toMatchObject({ itemsCleaned: 0 });
		expect(f.remove).not.toHaveBeenCalled();
	});
	it("does not publish an available preview or mutate when protection lookup fails", async () => {
		const f = await cleanerFixture();
		vi.spyOn(prisma.arrImportOperation, "findMany").mockRejectedValue(
			new Error("Synthetic private provider detail"),
		);
		const preview = await executeEnhancedPreview(f.app, f.instance, f.config);
		expect(preview.wouldRemove).toBe(0);
		expect(preview.previewItems[0]?.reason).toContain("unavailable");
		expect(preview.previewItems[0]?.reason).not.toContain("Synthetic private provider detail");
		expect(await f.run()).toMatchObject({ status: "partial", itemsCleaned: 0 });
		expect(f.remove).not.toHaveBeenCalled();
	});
	it("rechecks a new shared import admitted after initial queue observation", async () => {
		const f = await cleanerFixture();
		f.current.mockImplementationOnce(async () => {
			await startImport();
			return f.item as never;
		});
		expect(await f.run()).toMatchObject({ itemsCleaned: 0 });
		expect(f.remove).not.toHaveBeenCalled();
		expect(f.post).not.toHaveBeenCalled();
		expect(
			await prisma.arrImportOperation.count({ where: { userId: "owner", state: "pending" } }),
		).toBe(1);
	});
	it("blocks submission while the actual source DELETE is still settling", async () => {
		const f = await cleanerFixture();
		let announce!: () => void;
		let settle!: () => void;
		const started = new Promise<void>((resolve) => {
			announce = resolve;
		});
		const settlement = new Promise<void>((resolve) => {
			settle = resolve;
		});
		f.remove.mockImplementation(async () => {
			announce();
			await settlement;
			return undefined as never;
		});
		const work = f.run();
		await started;
		try {
			await expect(startImport()).rejects.toMatchObject({ statusCode: 409 });
			expect(await prisma.arrImportOperation.count({ where: { userId: "owner" } })).toBe(0);
		} finally {
			settle();
			await work;
		}
		expect(f.remove).toHaveBeenCalledOnce();
	});
	it("does not replay a failed manual attempt even with automatic import enabled", async () => {
		const tracked = await startImport();
		await prisma.arrImportOperation.updateMany({
			where: { id: tracked.operation.id, userId: "owner" },
			data: { state: "failed", commandState: "failed", commandTerminal: true },
		});
		await releaseTerminalImportSources(prisma, "owner", tracked.operation.id);
		const f = await cleanerFixture();
		f.config.autoImportEnabled = true;
		f.config.autoImportSafeOnly = false;
		expect(await f.run()).toMatchObject({ itemsCleaned: 0 });
		expect(f.post).not.toHaveBeenCalled();
		expect(f.remove).not.toHaveBeenCalled();
	});
	it("permits current cleanup after proved unsubmitted preparation cancellation", async () => {
		const f = await cleanerFixture();
		const instance = await prisma.serviceInstance.findFirstOrThrow({
			where: { userId: "owner", id: "origin" },
		});
		const prepared = await beginImportAttempt(prisma, {
			userId: "owner",
			instanceId: instance.id,
			connectionFingerprint: importConnectionFingerprint(instance),
			service: "RADARR",
			origin: "manual",
			mode: "Move",
			idempotencyKey: "unsubmitted-attempt",
			requestFingerprint: `v1:${"a".repeat(64)}`,
			commandFingerprint: `v1:${"b".repeat(64)}`,
			encryptedSources: "synthetic",
			sourcesEncryptionIv: "synthetic",
			now: new Date(),
			preparationExpiresAt: new Date(Date.now() + 60_000),
			files: [
				{
					fileFingerprint: `v1:${"c".repeat(64)}`,
					downloadKey: createHash("sha256").update("source").digest("hex"),
					identity: { pathHash: "d".repeat(64), movieId: 12 },
				},
			],
		});
		if (prepared.kind === "protected") throw new Error("Unexpected fixture claim conflict");
		expect(await cancelUnsubmittedImportAttempt(prisma, "owner", prepared.operation.id)).toBe(true);
		await releaseTerminalImportSources(prisma, "owner", prepared.operation.id);
		expect(await executeEnhancedPreview(f.app, f.instance, f.config)).toMatchObject({
			wouldRemove: 1,
		});
		expect(await f.run()).toMatchObject({ itemsCleaned: 1 });
		expect(f.remove).toHaveBeenCalledOnce();
	});
});
