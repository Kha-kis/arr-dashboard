import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RadarrClient } from "arr-sdk";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import {
	readOwnedImportAttempt,
	recordImportCommandObservation,
	recordVerifiedImportFiles,
} from "../../arr/import-operations/repository.js";
import { submitTrackedImport } from "../../arr/import-operations/submission.js";
import { Encryptor } from "../../auth/encryption.js";
import { assertImportDeletionFence, prepareImportDeletion } from "../import-deletion-guard.js";

let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;
const encryptor = new Encryptor(Buffer.alloc(32, 7).toString("base64"));
beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "arr-import-delete-"));
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
		data: ["target", "alias", "foreign"].map((id) => ({
			id,
			userId: id === "foreign" ? "other" : "owner",
			service: "RADARR" as const,
			label: "Synthetic",
			baseUrl: "https://fixture.invalid",
			encryptedApiKey: "synthetic-cipher",
			encryptionIv: "synthetic-iv",
			enabled: id !== "alias",
		})),
	});
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
	const instance = await prisma.serviceInstance.findFirstOrThrow({
		where: { id: "target", userId: "owner" },
	});
	const queues = new Map<string, unknown[]>();
	const queueRead = vi.fn(async (connection: { id: string }, options: { page?: number }) => ({
		page: options.page,
		pageSize: 1000,
		totalRecords: (queues.get(connection.id) ?? []).length,
		records: queues.get(connection.id) ?? [],
	}));
	const create = vi.fn((connection: { id: string }) => ({
		queue: { get: (options: { page?: number }) => queueRead(connection, options) },
	}));
	const app = { prisma, arrClientFactory: { create } } as unknown as FastifyInstance;
	return { app, instance, queues, queueRead, create };
}
async function startImport(instanceId = "target", userId = "owner") {
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
	vi.spyOn(client, "post").mockImplementation(
		async (_path, body) => ({ id: 51, name: "ManualImport", status: "queued", body }) as never,
	);
	return submitTrackedImport(
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
}
async function complete(operation: Awaited<ReturnType<typeof startImport>>) {
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
	if (!observed) throw new Error("Missing synthetic operation");
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
}

describe("connection deletion preserves both import generations", () => {
	it.each(["pending", "submitting", "unknown", "failed", "partial", "future-state"])(
		"refuses a new %s import before provider reads",
		async (state) => {
			const f = await fixture();
			const operation = await startImport();
			await prisma.arrImportOperation.updateMany({
				where: { id: operation.id, userId: "owner" },
				data: { state },
			});
			await expect(prepareImportDeletion(f.app, f.instance)).rejects.toMatchObject({
				statusCode: 409,
			});
			expect(f.create).not.toHaveBeenCalled();
			expect(await prisma.serviceInstance.count({ where: { id: "target", userId: "owner" } })).toBe(
				1,
			);
		},
	);
	it("rejects aggregate command completion without every positive file", async () => {
		const f = await fixture();
		const operation = await startImport();
		await prisma.arrImportOperation.updateMany({
			where: { id: operation.id, userId: "owner" },
			data: {
				state: "completed",
				commandTerminal: true,
				commandState: "completed",
				verifiedFileCount: 1,
			},
		});
		await expect(prepareImportDeletion(f.app, f.instance)).rejects.toMatchObject({
			statusCode: 409,
		});
	});
	it("allows verified completion plus current owned-source absence while retaining history", async () => {
		const f = await fixture();
		const operation = await startImport();
		await complete(operation);
		const before = await readOwnedImportAttempt(prisma, "owner", operation.id);
		const fence = await prepareImportDeletion(f.app, f.instance);
		expect(f.create.mock.calls.map(([connection]) => connection.id).sort()).toEqual([
			"alias",
			"target",
		]);
		expect(f.queueRead).toHaveBeenCalledTimes(4);
		await prisma.$transaction(async (tx) => {
			await assertImportDeletionFence(tx, "owner", "target", fence);
			await tx.serviceInstance.delete({ where: { id: "target", userId: "owner" } });
		});
		const after = await readOwnedImportAttempt(prisma, "owner", operation.id);
		expect(after).toEqual({ ...before, instanceId: null });
	});
	it("does not require provider connectivity for a proved unsubmitted preparation", async () => {
		const f = await fixture();
		const operation = await startImport();
		await prisma.arrImportOperation.updateMany({
			where: { id: operation.id, userId: "owner" },
			data: {
				state: "not-submitted",
				submissionStartedAt: null,
				commandId: null,
				commandState: null,
				commandTerminal: false,
			},
		});
		const fence = await prepareImportDeletion(f.app, f.instance);
		await expect(
			assertImportDeletionFence(prisma, "owner", "target", fence),
		).resolves.toBeUndefined();
		expect(f.create).not.toHaveBeenCalled();
	});
	it("blocks a completed source still queued on a disabled owned alias", async () => {
		const f = await fixture();
		await complete(await startImport());
		f.queues.set("alias", [
			{ id: 42, downloadId: "source", title: "Synthetic", protocol: "torrent" },
		]);
		await expect(prepareImportDeletion(f.app, f.instance)).rejects.toMatchObject({
			statusCode: 409,
		});
	});
	it("fails closed when current source coverage cannot be read", async () => {
		const f = await fixture();
		await complete(await startImport());
		f.queueRead.mockRejectedValue(new Error("Synthetic provider detail"));
		await expect(prepareImportDeletion(f.app, f.instance)).rejects.toMatchObject({
			statusCode: 409,
			message: expect.not.stringContaining("Synthetic provider detail"),
		});
	});
	it("does not borrow a foreign owner's source or command authority", async () => {
		const f = await fixture();
		await startImport("foreign", "other");
		const fence = await prepareImportDeletion(f.app, f.instance);
		await expect(
			assertImportDeletionFence(prisma, "owner", "target", fence),
		).resolves.toBeUndefined();
		expect(f.create).not.toHaveBeenCalled();
	});
	it("rechecks a newly admitted operation before the cascading transaction", async () => {
		const f = await fixture();
		const fence = await prepareImportDeletion(f.app, f.instance);
		await startImport();
		await expect(
			prisma.$transaction(async (tx) => {
				await assertImportDeletionFence(tx, "owner", "target", fence);
				await tx.serviceInstance.delete({ where: { id: "target", userId: "owner" } });
			}),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(await prisma.serviceInstance.count({ where: { id: "target", userId: "owner" } })).toBe(
			1,
		);
	});
	it("rechecks actual file proofs rather than a cached completed label", async () => {
		const f = await fixture();
		const operation = await startImport();
		await complete(operation);
		const fence = await prepareImportDeletion(f.app, f.instance);
		await prisma.arrImportFileProof.updateMany({
			where: { operation: { id: operation.id, userId: "owner" } },
			data: { verifiedAt: null },
		});
		await expect(assertImportDeletionFence(prisma, "owner", "target", fence)).rejects.toMatchObject(
			{ statusCode: 409 },
		);
	});
	it.each([false, true])(
		"checks 101 historical operations without a lifetime-count cutoff (corrupt last page: %s)",
		async (corrupt) => {
			const f = await fixture();
			const operation = await startImport();
			await complete(operation);
			const historical = await readOwnedImportAttempt(prisma, "owner", operation.id);
			if (!historical) throw new Error("Missing synthetic history");
			const { id: _originalId, files, ...scalar } = historical;
			const copies = Array.from({ length: 100 }, (_, index) => ({
				...scalar,
				id: `synthetic-history-${String(index).padStart(3, "0")}`,
				idempotencyKey: `synthetic-intent-${index}`,
				reconcileCursor: undefined,
			}));
			await prisma.arrImportOperation.createMany({ data: copies });
			await prisma.arrImportFileProof.createMany({
				data: copies.map((copy) => ({
					operationId: copy.id,
					fileFingerprint: files[0]!.fileFingerprint,
					downloadKey: files[0]!.downloadKey,
					identityJson: { pathHash: "a".repeat(64), movieId: 12 },
					verifiedAt: files[0]!.verifiedAt,
				})),
			});
			if (corrupt)
				await prisma.arrImportFileProof.updateMany({
					where: { operation: { userId: "owner", id: copies.at(-1)!.id } },
					data: { verifiedAt: null },
				});
			const read = vi.spyOn(prisma.arrImportOperation, "findMany");
			if (corrupt) {
				await expect(prepareImportDeletion(f.app, f.instance)).rejects.toMatchObject({
					statusCode: 409,
				});
			} else {
				const fence = await prepareImportDeletion(f.app, f.instance);
				expect(fence.operationCount).toBe(101);
				await expect(
					assertImportDeletionFence(prisma, "owner", "target", fence),
				).resolves.toBeUndefined();
			}
			expect(read.mock.calls.length).toBe(corrupt ? 3 : 6);
			expect(
				read.mock.calls.every(([args]) => args?.take === 40 && args?.where?.userId === "owner"),
			).toBe(true);
		},
	);
	it("retains unresolved legacy protection when new evidence is complete", async () => {
		const f = await fixture();
		await complete(await startImport());
		await prisma.queueCleanerImportReceipt.create({
			data: {
				instanceId: "target",
				downloadKey: "a".repeat(64),
				queueId: 1,
				downloadTitle: "Synthetic",
				connectionFingerprint: "b".repeat(64),
				commandFingerprint: `v1:${"c".repeat(64)}`,
				state: "unknown",
				lastAttemptAt: new Date(),
			},
		});
		await expect(prepareImportDeletion(f.app, f.instance)).rejects.toMatchObject({
			statusCode: 409,
		});
	});
});
