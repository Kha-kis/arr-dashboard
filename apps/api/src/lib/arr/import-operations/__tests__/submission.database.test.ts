import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManualImportServiceType, ManualImportSubmissionFile } from "@arr/shared";
import { LidarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../../__tests__/test-prisma.js";
import { Encryptor } from "../../../auth/encryption.js";
import { withExclusiveCleanupOperationGuard } from "../../../library-cleanup/cleanup-maintenance-gate.js";
import {
	acquireQueueSourceAction,
	importConnectionFingerprint,
	queueDownloadKey,
} from "../../../queue-cleaner/import-receipt.js";
import { queueItemFingerprint } from "../../../queue-cleaner/queue-observation.js";
import { withImportConnectionWriteGuard } from "../connection-guards.js";
import { recordVerifiedImportFiles, releaseTerminalImportSources } from "../repository.js";
import * as submission from "../submission.js";
import { submitTrackedImport, type TrackedImportInput } from "../submission.js";

let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;
const encryptor = new Encryptor(Buffer.alloc(32, 7).toString("base64"));
const sources: [string, string] = ["A".repeat(40), "B".repeat(40)];
const submissionHash = (value: string) => createHash("sha256").update(value).digest("hex");

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "arr-tracked-submission-"));
	const databasePath = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "pipe",
	});
	prisma = createTestPrismaClient(`file:${databasePath}`);
}, 30_000);
beforeEach(async () => {
	await prisma.user.deleteMany();
	await prisma.user.create({ data: { id: "owner", username: "synthetic-owner" } });
});
afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

type ServiceCase = {
	service: ManualImportServiceType;
	Client: typeof SonarrClient | typeof RadarrClient | typeof LidarrClient | typeof ReadarrClient;
	media: Omit<ManualImportSubmissionFile, "path" | "downloadId">;
	candidateMedia: Record<string, unknown>;
};
const services: [ServiceCase, ServiceCase, ServiceCase, ServiceCase] = [
	{
		service: "sonarr" as const,
		Client: SonarrClient,
		media: { seriesId: 12, episodeIds: [13] },
		candidateMedia: { series: { id: 12 }, episodes: [{ id: 13 }] },
	},
	{
		service: "radarr" as const,
		Client: RadarrClient,
		media: { movieId: 12 },
		candidateMedia: { movie: { id: 12 } },
	},
	{
		service: "lidarr" as const,
		Client: LidarrClient,
		media: { artistId: 12, albumId: 13 },
		candidateMedia: {
			artist: { id: 12 },
			album: { id: 13 },
			albumReleaseId: 14,
			tracks: [{ id: 15 }],
		},
	},
	{
		service: "readarr" as const,
		Client: ReadarrClient,
		media: { authorId: 12, bookId: 13 },
		candidateMedia: { author: { id: 12 }, book: { id: 13 }, foreignEditionId: "edition-1" },
	},
];

function first<T>(rows: T[]): T {
	const value = rows[0];
	if (value === undefined) throw new Error("Expected a populated fixture");
	return value;
}
async function fixture(service: ServiceCase) {
	await prisma.serviceInstance.create({
		data: {
			id: "instance",
			userId: "owner",
			service: service.service.toUpperCase() as "SONARR" | "RADARR" | "LIDARR" | "READARR",
			label: "Synthetic",
			baseUrl: "https://fixture.invalid",
			encryptedApiKey: "synthetic-ciphertext",
			encryptionIv: "synthetic-iv",
		},
	});
	const client = new service.Client({
		baseUrl: "https://fixture.invalid",
		apiKey: "synthetic-key",
	});
	const candidates = [
		{
			id: 1,
			path: "/synthetic/file",
			downloadId: sources[0],
			quality: { quality: { id: 1 } },
			...service.candidateMedia,
		},
	];
	const reads = vi.fn().mockResolvedValue(candidates);
	if (client instanceof SonarrClient || client instanceof RadarrClient)
		vi.spyOn(client.manualImport, "get").mockImplementation(reads);
	else vi.spyOn(client, "get").mockImplementation(reads);
	const posts = vi
		.spyOn(client, "post")
		.mockImplementation(
			async (_path, body) => ({ id: 51, name: "ManualImport", status: "queued", body }) as never,
		);
	const context = { prisma, encryptor, createClient: () => client };
	const input: TrackedImportInput = {
		userId: "owner",
		instanceId: "instance",
		service: service.service,
		origin: "manual" as const,
		importMode: "auto" as const,
		idempotencyKey: "intentional-attempt",
		files: [{ path: first(candidates).path, downloadId: sources[0], ...service.media }],
	};
	return { context, input, client, reads, posts, candidates };
}

async function automaticFixture(service: ServiceCase) {
	const f = await fixture(service);
	const item = {
		id: 42,
		downloadId: sources[0],
		protocol: "usenet",
		trackedDownloadState: "importPending",
		...service.media,
		...(service.service === "sonarr" ? { episodeId: 13 } : {}),
	};
	const queueRead = vi.fn().mockResolvedValue(item);
	const queuePages = vi.spyOn(f.client.queue, "get").mockImplementation(
		async (options?: { page?: number }) =>
			({
				page: options?.page ?? 1,
				pageSize: 1000,
				totalRecords: 1,
				records: [await queueRead()],
			}) as never,
	);
	if (!(f.client instanceof LidarrClient))
		vi.spyOn(f.client.queue, "getById").mockImplementation(queueRead);
	const instance = await prisma.serviceInstance.findFirstOrThrow({
		where: { id: f.input.instanceId, userId: f.input.userId },
	});
	const config = await prisma.queueCleanerConfig.create({
		data: {
			instanceId: instance.id,
			enabled: true,
			dryRunMode: false,
			autoImportEnabled: true,
			autoImportSafeOnly: false,
			autoImportCooldownMins: 0,
		},
	});
	const permit = acquireQueueSourceAction(f.input.userId, item);
	if (!permit) throw new Error("Expected an acquired synthetic cleaner source");
	const input = {
		userId: f.input.userId,
		instanceId: f.input.instanceId,
		service: service.service,
		downloadId: sources[0],
		queueId: 42,
		queueFingerprint: queueItemFingerprint(item)!,
		attemptOrdinal: 1,
		connectionFingerprint: importConnectionFingerprint(instance),
	};
	const gate = vi.fn(async () => true);
	return {
		...f,
		config,
		item,
		queueRead,
		queuePages,
		permit,
		automaticInput: input,
		gate,
		automatic: () =>
			submission.submitTrackedAutomaticImport(f.context, input, {
				sourcePermit: permit,
				currentQueueGate: gate,
			}),
	};
}

describe("automatic import uses the shared durable lifecycle", () => {
	it.each(["status-pattern", "queue-state"])(
		"does not submit when %s changes after preparation",
		async (change) => {
			const f = await automaticFixture(services[1]);
			let reads = 0;
			f.queueRead.mockImplementation(async () => {
				if (++reads === 1) return f.item;
				return change === "queue-state"
					? { ...f.item, trackedDownloadState: "downloading" }
					: { ...f.item, statusMessages: [{ messages: ["password protected"] }] };
			});
			try {
				await expect(f.automatic()).rejects.toMatchObject({ statusCode: 409 });
				expect(f.posts).not.toHaveBeenCalled();
				expect(
					await prisma.arrImportOperation.findFirst({ where: { userId: "owner" } }),
				).toMatchObject({
					state: "not-submitted",
					submissionStartedAt: null,
				});
			} finally {
				f.permit();
			}
		},
	);
	it("commits the cleaner's attempt counter with preparation before POST and never increments a retry", async () => {
		const f = await automaticFixture(services[1]);
		try {
			f.posts.mockImplementation(async (_path, body) => {
				const operation = await prisma.arrImportOperation.findFirstOrThrow({
					where: { userId: f.input.userId, origin: "queue-cleaner" },
				});
				const strike = await prisma.queueCleanerStrike.findFirstOrThrow({
					where: {
						instanceId: f.input.instanceId,
						instance: { userId: f.input.userId },
						downloadId: "42",
					},
				});
				expect(strike.importAttempts).toBe(1);
				expect(strike.lastImportAttempt).toEqual(operation.createdAt);
				expect(strike.downloadFingerprint).toBe(f.automaticInput.queueFingerprint);
				expect(operation.state).toBe("submitting");
				return { id: 51, name: "ManualImport", status: "queued", body } as never;
			});
			const operation = await f.automatic();
			expect(operation.state).toBe("pending");
			await f.automatic();
			expect(f.posts).toHaveBeenCalledOnce();
			expect(
				await prisma.queueCleanerStrike.findFirst({
					where: { instanceId: f.input.instanceId, instance: { userId: f.input.userId } },
				}),
			).toMatchObject({ importAttempts: 1 });
		} finally {
			f.permit();
		}
	});
	it("rolls back preparation, file rows and claims if cleaner attempt persistence fails", async () => {
		const f = await automaticFixture(services[1]);
		await prisma.$executeRawUnsafe(
			`CREATE TRIGGER reject_automatic_attempt BEFORE INSERT ON queue_cleaner_strikes BEGIN SELECT RAISE(ABORT, 'synthetic_attempt_failure'); END`,
		);
		try {
			await expect(f.automatic()).rejects.toBeDefined();
			expect(f.posts).not.toHaveBeenCalled();
			expect(await prisma.arrImportOperation.count()).toBe(0);
			expect(await prisma.arrImportFileProof.count()).toBe(0);
			expect(await prisma.arrImportSourceClaim.count()).toBe(0);
		} finally {
			await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "reject_automatic_attempt"');
			f.permit();
		}
	});
	it.each(["auto-disabled", "config-dry-run", "counter-cleared"])(
		"retains a prepared source when %s changes before the submission marker",
		async (change) => {
			const f = await automaticFixture(services[1]);
			f.queueRead.mockResolvedValueOnce(f.item).mockImplementation(async () => {
				if (change === "auto-disabled")
					await prisma.queueCleanerConfig.updateMany({
						where: { id: f.config.id, instance: { userId: f.input.userId } },
						data: { autoImportEnabled: false },
					});
				if (change === "config-dry-run")
					await prisma.queueCleanerConfig.updateMany({
						where: { id: f.config.id, instance: { userId: f.input.userId } },
						data: { dryRunMode: true },
					});
				if (change === "counter-cleared")
					await prisma.queueCleanerStrike.deleteMany({
						where: { instanceId: f.input.instanceId, instance: { userId: f.input.userId } },
					});
				return f.item;
			});
			try {
				await expect(f.automatic()).rejects.toMatchObject({ statusCode: 409 });
				expect(f.posts).not.toHaveBeenCalled();
				expect(
					await prisma.arrImportOperation.findFirst({ where: { userId: f.input.userId } }),
				).toMatchObject({ state: "not-submitted", submissionStartedAt: null });
			} finally {
				f.permit();
			}
		},
	);
	it("allows a new policy-admitted ordinal after proved non-submission without rewriting history", async () => {
		const f = await automaticFixture(services[1]);
		let nextPermit: (() => void) | null = null;
		try {
			f.gate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
			await expect(f.automatic()).rejects.toMatchObject({ statusCode: 409 });
			const old = await f.automatic();
			expect(old.state).toBe("not-submitted");
			expect(old.submissionStartedAt).toBeNull();
			expect(f.posts).not.toHaveBeenCalled();
			f.permit();
			nextPermit = acquireQueueSourceAction(f.input.userId, f.item);
			if (!nextPermit) throw new Error("Expected a fresh synthetic cleaner action");
			f.gate.mockResolvedValue(true);
			const next = await submission.submitTrackedAutomaticImport(
				f.context,
				{
					...f.automaticInput,
					attemptOrdinal: 2,
				},
				{ sourcePermit: nextPermit, currentQueueGate: f.gate },
			);
			expect(next.id).not.toBe(old.id);
			expect(next.state).toBe("pending");
			expect(await prisma.arrImportOperation.count({ where: { userId: f.input.userId } })).toBe(2);
			expect(
				await prisma.arrImportOperation.findFirst({
					where: { id: old.id, userId: f.input.userId },
				}),
			).toMatchObject({ state: "not-submitted", submissionStartedAt: null });
			expect(f.posts).toHaveBeenCalledOnce();
		} finally {
			nextPermit?.();
			f.permit();
		}
	});
	it("holds source, connection and topology guards through an actual held automatic POST", async () => {
		const f = await automaticFixture(services[1]);
		let announce!: () => void;
		let settle!: () => void;
		const started = new Promise<void>((resolve) => {
			announce = resolve;
		});
		const settlement = new Promise<void>((resolve) => {
			settle = resolve;
		});
		f.posts.mockImplementation(async (_path, body) => {
			announce();
			await settlement;
			return { id: 51, name: "ManualImport", status: "queued", body } as never;
		});
		const work = f.automatic();
		try {
			await Promise.race([started, work]);
			f.permit();
			expect(acquireQueueSourceAction(f.input.userId, f.item)).toBeNull();
			await expect(
				withImportConnectionWriteGuard(f.input.userId, f.input.instanceId, async () => true),
			).rejects.toMatchObject({ statusCode: 409 });
			await expect(withExclusiveCleanupOperationGuard(async () => true)).rejects.toMatchObject({
				statusCode: 409,
			});
		} finally {
			settle();
			await work;
			f.permit();
		}
		const released = acquireQueueSourceAction(f.input.userId, f.item);
		expect(released).not.toBeNull();
		released?.();
	});
	it.each(["foreign-owner", "disabled", "connection-changed"])(
		"refuses %s before automatic provider reads",
		async (change) => {
			const f = await automaticFixture(services[1]);
			try {
				if (change === "foreign-owner") f.automaticInput.userId = "other-owner";
				if (change === "disabled")
					await prisma.serviceInstance.updateMany({
						where: { id: f.input.instanceId, userId: f.input.userId },
						data: { enabled: false },
					});
				if (change === "connection-changed")
					f.automaticInput.connectionFingerprint = "a".repeat(64);
				await expect(f.automatic()).rejects.toMatchObject({ statusCode: 409 });
				expect(f.queueRead).not.toHaveBeenCalled();
				expect(f.reads).not.toHaveBeenCalled();
				expect(f.posts).not.toHaveBeenCalled();
			} finally {
				f.permit();
			}
		},
	);
	it("refuses a late legacy receipt after preparing its own operation", async () => {
		const f = await automaticFixture(services[1]);
		f.queueRead.mockResolvedValueOnce(f.item).mockImplementation(async () => {
			expect(
				await prisma.arrImportOperation.count({
					where: { userId: f.input.userId, state: "preparing" },
				}),
			).toBe(1);
			await prisma.queueCleanerImportReceipt.create({
				data: {
					instanceId: f.input.instanceId,
					downloadKey: queueDownloadKey(f.item)!,
					queueId: 42,
					downloadTitle: "Synthetic",
					connectionFingerprint: f.automaticInput.connectionFingerprint,
					commandFingerprint: `v1:${"b".repeat(64)}`,
					state: "pending",
					lastAttemptAt: new Date(),
				},
			});
			return f.item;
		});
		try {
			await expect(f.automatic()).rejects.toMatchObject({ statusCode: 409 });
			expect(f.posts).not.toHaveBeenCalled();
			expect(
				await prisma.arrImportOperation.findFirst({ where: { userId: f.input.userId } }),
			).toMatchObject({ state: "not-submitted", submissionStartedAt: null });
			expect(
				await prisma.queueCleanerImportReceipt.count({
					where: { instance: { userId: f.input.userId } },
				}),
			).toBe(1);
		} finally {
			f.permit();
		}
	});
	it.each(services)(
		"submits $service once with real file counts and cached automatic retries",
		async (service) => {
			const f = await automaticFixture(service);
			try {
				f.posts.mockImplementation(async (_path, body) => {
					const marker = await prisma.arrImportOperation.findFirstOrThrow({
						where: { userId: f.input.userId, origin: "queue-cleaner" },
					});
					expect(marker.state).toBe("submitting");
					expect(marker.submissionStartedAt).not.toBeNull();
					expect(acquireQueueSourceAction(f.input.userId, f.item)).toBeNull();
					return { id: 51, name: "ManualImport", status: "queued", body } as never;
				});
				const operation = await f.automatic();
				const reads = f.reads.mock.calls.length;
				const queueReads = f.queueRead.mock.calls.length;
				expect(operation).toMatchObject({
					origin: "queue-cleaner",
					state: "pending",
					selectedFileCount: 1,
					verifiedFileCount: 0,
				});
				expect((await f.automatic()).id).toBe(operation.id);
				expect(f.reads).toHaveBeenCalledTimes(reads);
				expect(f.queueRead).toHaveBeenCalledTimes(queueReads);
				expect(f.posts).toHaveBeenCalledOnce();
			} finally {
				f.permit();
			}
		},
	);
	it.each(["failed", "unknown", "completed"])(
		"never automatically replays a submitted %s command",
		async (state) => {
			const f = await automaticFixture(services[1]);
			try {
				f.posts.mockImplementation(
					async (_path, body) =>
						({
							id: 51,
							name: "ManualImport",
							status: state,
							result: state === "completed" ? "successful" : undefined,
							body,
						}) as never,
				);
				const operation = await f.automatic();
				expect(operation.verifiedFileCount).toBe(0);
				expect((await f.automatic()).id).toBe(operation.id);
				await expect(
					submission.submitTrackedAutomaticImport(
						f.context,
						{
							...f.automaticInput,
							attemptOrdinal: 2,
						},
						{ sourcePermit: f.permit, currentQueueGate: f.gate },
					),
				).rejects.toMatchObject({ statusCode: 409 });
				expect(f.posts).toHaveBeenCalledOnce();
			} finally {
				f.permit();
			}
		},
	);
	it.each(["queue-identity", "eligibility", "source-claim"])(
		"does not POST when %s changes during automatic preparation",
		async (change) => {
			const f = await automaticFixture(services[1]);
			try {
				f.reads.mockImplementation(async () => {
					if (change === "queue-identity")
						f.queueRead.mockResolvedValue({ ...f.item, movieId: 99 });
					if (change === "eligibility") f.gate.mockResolvedValue(false);
					if (change === "source-claim")
						await prisma.queueCleanerImportReceipt.upsert({
							where: {
								instanceId_downloadKey: {
									instanceId: f.input.instanceId,
									downloadKey: queueDownloadKey(f.item)!,
								},
							},
							create: {
								instanceId: f.input.instanceId,
								downloadKey: queueDownloadKey(f.item)!,
								queueId: 42,
								downloadTitle: "Synthetic",
								connectionFingerprint: f.automaticInput.connectionFingerprint,
								commandFingerprint: `v1:${"b".repeat(64)}`,
								state: "pending",
								lastAttemptAt: new Date(),
							},
							update: {},
						});
					return f.candidates;
				});
				await expect(f.automatic()).rejects.toMatchObject({ statusCode: 409 });
				expect(f.posts).not.toHaveBeenCalled();
				expect(
					await prisma.arrImportOperation.count({
						where: { userId: f.input.userId, submissionStartedAt: { not: null } },
					}),
				).toBe(0);
			} finally {
				f.permit();
			}
		},
	);
	it("retains the source if a selected file acquires a rejection on the final candidate read", async () => {
		const f = await automaticFixture(services[1]);
		try {
			f.reads
				.mockResolvedValueOnce(f.candidates)
				.mockResolvedValue([
					{ ...first(f.candidates), rejections: [{ reason: "Synthetic provider rejection" }] },
				]);
			await expect(f.automatic()).rejects.toMatchObject({ statusCode: 409 });
			expect(f.posts).not.toHaveBeenCalled();
		} finally {
			f.permit();
		}
	});
	it("refuses a prior failed manual operation even after its submission claim is released", async () => {
		const f = await fixture(services[1]);
		if (!(f.client instanceof RadarrClient)) throw new Error("Expected a synthetic Radarr client");
		f.posts.mockImplementation(
			async (_path, body) => ({ id: 51, name: "ManualImport", status: "failed", body }) as never,
		);
		const failed = await submitTrackedImport(f.context, f.input);
		const { releaseTerminalImportSources } = await import("../repository.js");
		await releaseTerminalImportSources(prisma, f.input.userId, failed.id);
		const item = {
			id: 42,
			downloadId: sources[0],
			movieId: 12,
			protocol: "usenet",
			trackedDownloadState: "importPending",
		};
		vi.spyOn(f.client.queue, "getById").mockResolvedValue(item as never);
		const permit = acquireQueueSourceAction(f.input.userId, item);
		if (!permit) throw new Error("Expected a synthetic source permit");
		try {
			await expect(
				submission.submitTrackedAutomaticImport(
					f.context,
					{
						userId: f.input.userId,
						instanceId: f.input.instanceId,
						service: "radarr",
						downloadId: sources[0],
						queueId: 42,
						attemptOrdinal: 2,
						queueFingerprint: queueItemFingerprint(item)!,
						connectionFingerprint: failed.connectionFingerprint,
					},
					{ sourcePermit: permit, currentQueueGate: async () => true },
				),
			).rejects.toMatchObject({ statusCode: 409 });
			expect(f.posts).toHaveBeenCalledOnce();
			expect(await prisma.arrImportOperation.count()).toBe(1);
		} finally {
			permit();
		}
	});
});

describe("deliberate remaining-file admission", () => {
	async function failedPair(service = services[1]) {
		const f = await fixture(service);
		const remaining = { ...first(f.candidates), id: 2, path: "/synthetic/remaining" };
		f.candidates.push(remaining);
		f.input.files.push({ ...first(f.input.files), path: remaining.path });
		f.posts.mockImplementation(
			async (_path, body) => ({ id: 51, name: "ManualImport", status: "failed", body }) as never,
		);
		const prior = await submitTrackedImport(f.context, f.input);
		const proved = prior.files.find(
			(file) =>
				file.identityJson &&
				typeof file.identityJson === "object" &&
				!Array.isArray(file.identityJson) &&
				file.identityJson.pathHash === submissionHash("/synthetic/file"),
		);
		if (!proved || prior.commandId === null) throw new Error("Expected a synthetic file binding");
		expect(
			await recordVerifiedImportFiles(prisma, f.input.userId, prior.id, {
				expectedRevision: prior.revision,
				connectionFingerprint: prior.connectionFingerprint,
				commandFingerprint: prior.commandFingerprint,
				commandId: prior.commandId,
				fileFingerprints: [proved.fileFingerprint],
				verifiedAt: new Date(),
			}),
		).toBe(true);
		expect(await releaseTerminalImportSources(prisma, f.input.userId, prior.id)).toBe(true);
		const next = {
			...f.input,
			idempotencyKey: "explicit-remainder",
			remainderOf: prior.id,
			files: [{ ...first(f.input.files), path: remaining.path }],
		};
		return { ...f, prior, proved, next };
	}
	it.each(services)(
		"admits only fresh explicit remaining files for $service and observes the same key",
		async (service) => {
			const f = await failedPair(service);
			const old = await prisma.arrImportOperation.findFirstOrThrow({
				where: { id: f.prior.id, userId: "owner" },
				include: { files: true },
			});
			const next = await submitTrackedImport(f.context, f.next);
			expect(next.id).not.toBe(f.prior.id);
			expect(next).toMatchObject({ state: "failed", selectedFileCount: 1, verifiedFileCount: 0 });
			expect(f.posts).toHaveBeenCalledTimes(2);
			expect(
				await prisma.arrImportOperation.findFirst({
					where: { id: f.prior.id, userId: "owner" },
					include: { files: true },
				}),
			).toEqual(old);
			f.reads.mockRejectedValue(new Error("Provider unavailable"));
			expect((await submitTrackedImport(f.context, f.next)).id).toBe(next.id);
			expect(f.posts).toHaveBeenCalledTimes(2);
		},
	);
	it("does not silently replay terminal work merely by minting a different key", async () => {
		const f = await failedPair();
		const { remainderOf: _prior, ...unlinked } = f.next;
		await expect(submitTrackedImport(f.context, unlinked)).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(f.posts).toHaveBeenCalledOnce();
	});
	it.each(services)(
		"keeps a new $service remainder bound to its terminal parent after genuine non-submission",
		async (service) => {
			const f = await failedPair(service);
			await expect(
				submitTrackedImport(f.context, f.next, { verifyCurrentTarget: async () => false }),
			).rejects.toBeDefined();
			const notSubmitted = await prisma.arrImportOperation.findFirstOrThrow({
				where: { userId: f.input.userId, idempotencyKey: f.next.idempotencyKey },
				include: { files: true },
			});
			expect(notSubmitted).toMatchObject({ state: "not-submitted", submissionStartedAt: null });
			expect(f.posts).toHaveBeenCalledOnce();
			const nextInput = { ...f.next, idempotencyKey: "next-deliberate-remainder" };
			await expect(
				submitTrackedImport(f.context, { ...nextInput, remainderOf: notSubmitted.id }),
			).rejects.toMatchObject({ statusCode: 409 });
			expect(f.posts).toHaveBeenCalledOnce();
			const next = await submitTrackedImport(f.context, nextInput);
			expect(next.id).not.toBe(notSubmitted.id);
			expect(f.posts).toHaveBeenCalledTimes(2);
			expect((await submitTrackedImport(f.context, nextInput)).id).toBe(next.id);
			expect(f.posts).toHaveBeenCalledTimes(2);
			expect(
				await prisma.arrImportOperation.findFirstOrThrow({
					where: { id: notSubmitted.id, userId: f.input.userId },
					include: { files: true },
				}),
			).toEqual(notSubmitted);
		},
	);
	it("excludes positive physical file evidence despite changed provider quality", async () => {
		const f = await failedPair();
		f.reads.mockResolvedValue(
			f.candidates.map((candidate) => ({ ...candidate, quality: { quality: { id: 5 } } })),
		);
		await expect(
			submitTrackedImport(f.context, { ...f.next, files: [first(f.input.files)] }),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(f.posts).toHaveBeenCalledOnce();
	});
	it("rejects a fresh path that was never selected by the referenced attempt", async () => {
		const f = await failedPair();
		f.candidates.push({ ...first(f.candidates), id: 3, path: "/synthetic/not-original" });
		await expect(
			submitTrackedImport(f.context, {
				...f.next,
				files: [{ ...first(f.next.files), path: "/synthetic/not-original" }],
			}),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(f.posts).toHaveBeenCalledOnce();
	});
	it("rechecks new positive proof immediately before POST and cancels only the new preparation", async () => {
		const f = await failedPair();
		await expect(
			submitTrackedImport(f.context, f.next, {
				verifyCurrentTarget: async () => {
					const old = await prisma.arrImportOperation.findFirstOrThrow({
						where: { id: f.prior.id, userId: "owner" },
						include: { files: true },
					});
					const file = old.files.find((row) => row.verifiedAt === null)!;
					return recordVerifiedImportFiles(prisma, "owner", old.id, {
						expectedRevision: old.revision,
						connectionFingerprint: old.connectionFingerprint,
						commandFingerprint: old.commandFingerprint,
						commandId: 51,
						fileFingerprints: [file.fileFingerprint],
						verifiedAt: new Date(),
					});
				},
			}),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(f.posts).toHaveBeenCalledOnce();
		expect(
			await prisma.arrImportOperation.findFirst({
				where: { userId: "owner", idempotencyKey: f.next.idempotencyKey },
			}),
		).toMatchObject({ state: "not-submitted", submissionStartedAt: null });
	});
	it("binds predecessor identity on same-key recovery", async () => {
		const f = await failedPair();
		await submitTrackedImport(f.context, f.next);
		f.reads.mockClear();
		await expect(
			submitTrackedImport(f.context, { ...f.next, remainderOf: "another-attempt" }),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(f.reads).not.toHaveBeenCalled();
		expect(f.posts).toHaveBeenCalledTimes(2);
	});
	it.each(["pending", "unknown", "future-state"])(
		"rejects %s source history even with a missing claim",
		async (state) => {
			const f = await fixture(services[1]);
			const old = await submitTrackedImport(f.context, f.input);
			await prisma.arrImportOperation.updateMany({
				where: { id: old.id, userId: "owner" },
				data: { state, commandState: state, commandTerminal: false },
			});
			await prisma.arrImportSourceClaim.updateMany({
				where: { userId: "owner" },
				data: { activeOperationId: null },
			});
			await expect(
				submitTrackedImport(f.context, { ...f.input, idempotencyKey: "new-key" }),
			).rejects.toMatchObject({ statusCode: 409 });
			expect(f.posts).toHaveBeenCalledOnce();
		},
	);
});

describe("tracked import submission with real durable storage", () => {
	it.each([
		{ item: services[2], want: { artistId: 12, albumId: 13, albumReleaseId: 14, trackIds: [15] } },
		{ item: services[3], want: { authorId: 12, bookId: 13, foreignEditionId: "edition-1" } },
	])("encrypts and persists the exact provider mapping %#", async ({ item, want }) => {
		const f = await fixture(item);
		const operation = await submitTrackedImport(f.context, f.input);
		expect(first(operation.files).identityJson).toMatchObject(want);
		const clear = JSON.parse(
			encryptor.decrypt({ value: operation.encryptedSources, iv: operation.sourcesEncryptionIv }),
		);
		expect(clear.files).toEqual([
			{
				path: "/synthetic/file",
				downloadId: sources[0].toLowerCase(),
				quality: { quality: { id: 1 } },
				...want,
			},
		]);
		expect(operation.encryptedSources).not.toContain("/synthetic");
		expect(f.posts).toHaveBeenCalledExactlyOnceWith("/api/v1/command", {
			name: "ManualImport",
			importMode: "Move",
			files: [
				{
					path: "/synthetic/file",
					folderName: "",
					downloadId: sources[0].toLowerCase(),
					quality: { quality: { id: 1 } },
					languages: [],
					releaseGroup: undefined,
					indexerFlags: 0,
					...want,
				},
			],
		});
	});
	it.each([
		{ item: services[2], fields: { tracks: undefined } },
		{ item: services[2], fields: { albumReleaseId: 0 } },
		{ item: services[2], fields: { tracks: [{ id: 15 }, { id: 15 }] } },
		{ item: services[3], fields: { foreignEditionId: undefined } },
		{ item: services[3], fields: { foreignEditionId: "" } },
	])(
		"rejects incomplete provider mapping before a durable attempt or POST %#",
		async ({ item, fields }) => {
			const f = await fixture(item);
			f.reads.mockResolvedValue([{ ...first(f.candidates), ...fields }]);
			await expect(submitTrackedImport(f.context, f.input)).rejects.toBeDefined();
			expect(f.posts).not.toHaveBeenCalled();
			expect(await prisma.arrImportOperation.count({ where: { userId: "owner" } })).toBe(0);
		},
	);
	it.each(services)(
		"admits a distinct explicit $service intention only after actual pre-POST denial",
		async (service) => {
			const { context, input, posts, reads } = await fixture(service);
			await expect(
				submitTrackedImport(context, input, { verifyCurrentTarget: async () => false }),
			).rejects.toBeDefined();
			expect(posts).not.toHaveBeenCalled();
			const original = await prisma.arrImportOperation.findFirstOrThrow({
				where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
				include: { files: true },
			});
			expect(original).toMatchObject({
				state: "not-submitted",
				submissionStartedAt: null,
				commandId: null,
			});
			expect((await submitTrackedImport(context, input)).id).toBe(original.id);
			expect(posts).not.toHaveBeenCalled();
			const nextInput = { ...input, idempotencyKey: "new-explicit-intention" };
			const next = await submitTrackedImport(context, nextInput);
			expect(next.id).not.toBe(original.id);
			expect(next.state).toBe("pending");
			expect(posts).toHaveBeenCalledOnce();
			expect(reads).toHaveBeenCalledTimes(2);
			expect((await submitTrackedImport(context, nextInput)).id).toBe(next.id);
			expect(posts).toHaveBeenCalledOnce();
			expect(
				await prisma.arrImportOperation.findFirstOrThrow({
					where: { id: original.id, userId: input.userId },
					include: { files: true },
				}),
			).toEqual(original);
		},
	);
	it.each(["denied", "read-failed"])(
		"retains a proved unsubmitted attempt when the final target check is %s",
		async (state) => {
			const { context, input, posts } = await fixture(services[1]);
			await expect(
				submitTrackedImport(context, input, {
					verifyCurrentTarget: async (operationId) => {
						expect(
							await prisma.arrImportOperation.count({
								where: { id: operationId, userId: input.userId, state: "preparing" },
							}),
						).toBe(1);
						if (state === "read-failed") throw new Error("Synthetic unavailable target");
						return false;
					},
				}),
			).rejects.toBeDefined();
			expect(posts).not.toHaveBeenCalled();
			const attempt = await prisma.arrImportOperation.findFirstOrThrow({
				where: { userId: input.userId },
			});
			expect(attempt.state).toBe("not-submitted");
			expect(attempt.submissionStartedAt).toBeNull();
			expect(
				await prisma.arrImportSourceClaim.count({
					where: { userId: input.userId, activeOperationId: attempt.id },
				}),
			).toBe(0);
		},
	);
	it("shares an automatic preparation deadline rather than restarting its budget", async () => {
		const { context, input, reads, posts } = await fixture(services[1]);
		await expect(
			submitTrackedImport(context, input, { preparationDeadline: Date.now() - 1 }),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(reads).not.toHaveBeenCalled();
		expect(posts).not.toHaveBeenCalled();
		expect(await prisma.arrImportOperation.count()).toBe(0);
	});
	it("submits once under the cleaner's owned source permit without releasing source protection", async () => {
		const { context, input, posts } = await fixture(services[1]);
		const permit = acquireQueueSourceAction(input.userId, { downloadId: sources[0] });
		if (!permit) throw new Error("Expected an acquired synthetic source");
		posts.mockImplementation(async (_path, body) => {
			expect(acquireQueueSourceAction(input.userId, { downloadId: sources[0] })).toBeNull();
			const marker = await prisma.arrImportOperation.findFirstOrThrow({
				where: { userId: input.userId, idempotencyKey: input.idempotencyKey },
			});
			expect(marker.state).toBe("submitting");
			return { id: 51, name: "ManualImport", status: "queued", body } as never;
		});
		try {
			const result = await submitTrackedImport(context, input, { sourcePermit: permit });
			expect(result.state).toBe("pending");
			expect(posts).toHaveBeenCalledOnce();
			expect(acquireQueueSourceAction(input.userId, { downloadId: sources[0] })).toBeNull();
		} finally {
			permit();
		}
		const released = acquireQueueSourceAction(input.userId, { downloadId: sources[0] });
		expect(released).not.toBeNull();
		released?.();
	});
	it("persists the submission fence before the real SDK POST boundary", async () => {
		const { context, input, posts } = await fixture(services[1]);
		posts.mockImplementation(async (_path, body) => {
			const fenced = await prisma.arrImportOperation.findFirstOrThrow({
				where: { userId: "owner", idempotencyKey: input.idempotencyKey },
			});
			expect(fenced.state).toBe("submitting");
			expect(fenced.submissionStartedAt).not.toBeNull();
			expect(
				await prisma.arrImportSourceClaim.count({
					where: { userId: "owner", activeOperationId: fenced.id },
				}),
			).toBe(1);
			return { id: 51, name: "ManualImport", status: "queued", body } as never;
		});
		await submitTrackedImport(context, input);
		expect(posts).toHaveBeenCalledOnce();
	});
	it("returns an actionable batch limit instead of silently dropping source selections", async () => {
		const { context, input, reads, posts } = await fixture(services[1]);
		const tooLarge = {
			...input,
			files: Array.from({ length: 33 }, (_, id) => ({
				...first(input.files),
				path: `/synthetic/${id}`,
				downloadId: `source-${id}`,
			})),
		};
		await expect(submitTrackedImport(context, tooLarge)).rejects.toMatchObject({
			statusCode: 413,
			message: expect.stringMatching(/smaller import batches/i),
		});
		expect(reads).not.toHaveBeenCalled();
		expect(posts).not.toHaveBeenCalled();
	});
	it.each(services)(
		"submits $service once and makes identical retries cached observations",
		async (service) => {
			const { context, input, reads, posts } = await fixture(service);
			const first = await submitTrackedImport(context, input);
			const repeat = await submitTrackedImport(context, input);
			expect(first.id).toBe(repeat.id);
			expect(first.state).toBe("pending");
			expect(first.verifiedFileCount).toBe(0);
			expect(reads).toHaveBeenCalledOnce();
			expect(posts).toHaveBeenCalledOnce();
			expect(await prisma.arrImportOperation.count({ where: { userId: "owner" } })).toBe(1);
			expect(
				await prisma.arrImportSourceClaim.count({
					where: { userId: "owner", activeOperationId: first.id },
				}),
			).toBe(1);
		},
	);
	it.each(services)(
		"refuses absent/changed $service current candidates before provider POST",
		async (service) => {
			const { context, input, reads, posts } = await fixture(service);
			reads.mockResolvedValue([]);
			await expect(submitTrackedImport(context, input)).rejects.toMatchObject({ statusCode: 409 });
			expect(posts).not.toHaveBeenCalled();
			expect(await prisma.arrImportOperation.count()).toBe(0);
		},
	);
	it.each(["disabled", "foreign-owner"])(
		"refuses a %s connection without provider reads/writes",
		async (kind) => {
			const { context, input, reads, posts } = await fixture(services[1]);
			if (kind === "disabled")
				await prisma.serviceInstance.update({
					where: { id: "instance" },
					data: { enabled: false },
				});
			else input.userId = "another-owner";
			await expect(submitTrackedImport(context, input)).rejects.toMatchObject({ statusCode: 409 });
			expect(reads).not.toHaveBeenCalled();
			expect(posts).not.toHaveBeenCalled();
		},
	);
	it.each(["failed", "unknown", "completed"])(
		"keeps a %s command distinct from positive file completion",
		async (commandState) => {
			const { context, input, posts } = await fixture(services[1]);
			posts.mockImplementation(
				async (_path, body) =>
					({
						id: 51,
						name: "ManualImport",
						status: commandState,
						result: commandState === "completed" ? "successful" : undefined,
						body,
					}) as never,
			);
			const operation = await submitTrackedImport(context, input);
			expect(operation.verifiedFileCount).toBe(0);
			expect(operation.state).toBe(commandState === "failed" ? "failed" : "unknown");
			expect(operation.commandTerminal).toBe(commandState !== "unknown");
		},
	);
	it("retains an ambiguous transport outcome and never replays its POST", async () => {
		const { context, input, posts } = await fixture(services[1]);
		posts.mockRejectedValue(new Error("synthetic transport unavailable"));
		const first = await submitTrackedImport(context, input);
		expect(first.state).toBe("unknown");
		expect(first.submissionStartedAt).not.toBeNull();
		await submitTrackedImport(context, input);
		expect(posts).toHaveBeenCalledOnce();
	});
	it("fences a changed connection during target verification", async () => {
		const { context, input, reads, posts, candidates } = await fixture(services[1]);
		reads.mockImplementation(async () => {
			await prisma.serviceInstance.update({
				where: { id: "instance" },
				data: { encryptedApiKey: "changed-ciphertext" },
			});
			return candidates;
		});
		await expect(submitTrackedImport(context, input)).rejects.toMatchObject({ statusCode: 409 });
		expect(posts).not.toHaveBeenCalled();
	});
	it("rejects a changed selection or mode reused under an existing attempt key", async () => {
		const { context, input, posts } = await fixture(services[1]);
		await submitTrackedImport(context, input);
		await expect(
			submitTrackedImport(context, { ...input, importMode: "copy" }),
		).rejects.toMatchObject({ statusCode: 409 });
		await expect(
			submitTrackedImport(context, {
				...input,
				files: [{ ...first(input.files), path: "/other" }],
			}),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(posts).toHaveBeenCalledOnce();
	});
	it("stores source lookup material encrypted and persists only hashed file/source identities", async () => {
		const { context, input } = await fixture(services[1]);
		const operation = await submitTrackedImport(context, input);
		expect(operation.encryptedSources).not.toContain("/synthetic");
		expect(JSON.stringify(operation.files)).not.toContain("/synthetic");
		const sourcePayload = JSON.parse(
			encryptor.decrypt({ value: operation.encryptedSources, iv: operation.sourcesEncryptionIv }),
		);
		expect(sourcePayload.version).toBe(1);
		expect(sourcePayload.files[0].path).toBe("/synthetic/file");
	});
});
