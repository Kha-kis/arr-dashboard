import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManualImportServiceType, ManualImportSubmissionFile } from "@arr/shared";
import { LidarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../../__tests__/test-prisma.js";
import { Encryptor } from "../../../auth/encryption.js";
import { importCommandFingerprint } from "../../manual-import-command.js";
import { reconcileTrackedImport } from "../reconciliation.js";
import { parseImportReconcileCursor } from "../reconciliation-lease.js";
import { readOwnedImportAttempt } from "../repository.js";
import { ImportOperationScheduler } from "../scheduler.js";
import { submitTrackedImport } from "../submission.js";

let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;
const encryptor = new Encryptor(Buffer.alloc(32, 9).toString("base64"));
beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "arr-import-reconcile-"));
	const databasePath = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "pipe",
	});
	prisma = createTestPrismaClient(`file:${databasePath}`);
}, 30_000);
beforeEach(async () => {
	await prisma.user.deleteMany();
	await prisma.user.create({ data: { id: "owner", username: "synthetic" } });
});
afterEach(() => {
	vi.restoreAllMocks();
});
afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

type Case = {
	service: ManualImportServiceType;
	Client: typeof SonarrClient | typeof RadarrClient | typeof LidarrClient | typeof ReadarrClient;
	media: Partial<ManualImportSubmissionFile>;
	candidate: Record<string, unknown>;
	eventType: string;
};
const services: [Case, Case, Case, Case] = [
	{
		service: "sonarr",
		Client: SonarrClient,
		media: { seriesId: 12, episodeIds: [13, 14] },
		candidate: { series: { id: 12 }, episodes: [{ id: 13 }, { id: 14 }] },
		eventType: "downloadFolderImported",
	},
	{
		service: "radarr",
		Client: RadarrClient,
		media: { movieId: 12 },
		candidate: { movie: { id: 12 } },
		eventType: "downloadFolderImported",
	},
	{
		service: "lidarr",
		Client: LidarrClient,
		media: { artistId: 12, albumId: 13 },
		candidate: { artist: { id: 12 }, album: { id: 13 }, albumReleaseId: 14, tracks: [{ id: 15 }] },
		eventType: "trackFileImported",
	},
	{
		service: "readarr",
		Client: ReadarrClient,
		media: { authorId: 12, bookId: 13 },
		candidate: { author: { id: 12 }, book: { id: 13 }, foreignEditionId: "edition-1" },
		eventType: "bookFileImported",
	},
];

async function fixture(item: Case = services[1], sourceCount = 1) {
	await prisma.serviceInstance.create({
		data: {
			id: "instance",
			userId: "owner",
			service: item.service.toUpperCase() as "SONARR" | "RADARR" | "LIDARR" | "READARR",
			label: "Synthetic",
			baseUrl: "https://fixture.invalid",
			encryptedApiKey: "synthetic-cipher",
			encryptionIv: "synthetic-iv",
		},
	});
	const files: ManualImportSubmissionFile[] = Array.from({ length: sourceCount }, (_, index) => ({
		path: `/synthetic/file-${index}`,
		downloadId: `source-${index}`,
		...item.media,
	}));
	const client = new item.Client({ baseUrl: "https://fixture.invalid", apiKey: "synthetic-key" });
	const candidates = files.map((file, id) => ({
		id: id + 1,
		path: file.path,
		downloadId: file.downloadId,
		quality: { quality: { id: 1 } },
		...item.candidate,
	}));
	const candidateReader = vi.fn(async (...args: unknown[]) => {
		const options = args.find(
			(arg) => arg !== null && typeof arg === "object" && "downloadId" in arg,
		) as { downloadId?: string } | undefined;
		return candidates.filter((candidate) => candidate.downloadId === options?.downloadId);
	});
	if (client instanceof SonarrClient || client instanceof RadarrClient)
		vi.spyOn(client.manualImport, "get").mockImplementation(candidateReader as never);
	else vi.spyOn(client, "get").mockImplementation(candidateReader as never);
	let command: Record<string, unknown> = {};
	const posts = vi.spyOn(client, "post").mockImplementation(async (_path, body) => {
		command = { id: 51, name: "ManualImport", status: "queued", body };
		return command as never;
	});
	const operation = await submitTrackedImport(
		{ prisma, encryptor, createClient: () => client },
		{
			userId: "owner",
			instanceId: "instance",
			service: item.service,
			origin: "manual",
			idempotencyKey: "intentional-attempt",
			importMode: "auto",
			files,
		},
	);
	let clock = new Date(Date.now() + 1000);
	command = { ...command, status: "completed", result: "successful", ended: clock.toISOString() };
	const histories = new Map<string, unknown[]>();
	for (const file of files)
		histories.set(
			file.downloadId,
			(item.service === "sonarr" ? [13, 14] : [undefined]).map((episodeId) => ({
				eventType: item.eventType,
				downloadId: file.downloadId,
				...item.media,
				episodeId,
				date: new Date(operation.submissionStartedAt!.getTime() + 1).toISOString(),
				data: { droppedPath: file.path, fileId: 31 },
			})),
		);
	const reader = vi.fn(async (path: string, options?: Record<string, unknown>) => {
		if (path.endsWith("/command/51")) return command;
		if (path.endsWith("/command")) return [command];
		if (path.endsWith("/history") && options) {
			const rows = histories.get(String(options.downloadId)) ?? [];
			const page = Number(options.page);
			const pageSize = Number(options.pageSize);
			return {
				page,
				pageSize,
				totalRecords: rows.length,
				records: rows.slice((page - 1) * pageSize, page * pageSize),
			};
		}
		throw new Error("Unexpected synthetic GET");
	});
	vi.spyOn(client, "get").mockImplementation(reader as never);
	return {
		operation,
		files,
		client,
		posts,
		reader,
		histories,
		get command() {
			return command;
		},
		set command(value: Record<string, unknown>) {
			command = value;
		},
		context: { prisma, encryptor, createClient: () => client, now: () => clock },
		advance() {
			clock = new Date(clock.getTime() + 60_000);
		},
	};
}

describe("bounded durable import reconciliation", () => {
	it.each([services[2], services[3]])(
		"observes stored old $service mappings without redispatch",
		async (item) => {
			const f = await fixture(item);
			const body = f.command.body as { files: Record<string, unknown>[] };
			// Seed the pre-correction persisted representation, not a new dispatch permission.
			const oldFiles = body.files.map(
				({ trackIds: _tracks, foreignEditionId: _edition, ...file }) => file,
			);
			const fingerprint = importCommandFingerprint(oldFiles)!;
			const encrypted = encryptor.encrypt(
				JSON.stringify({ version: 1, service: item.service, files: oldFiles }),
			);
			await prisma.arrImportOperation.update({
				where: { id: f.operation.id, userId: "owner" },
				data: {
					commandFingerprint: fingerprint,
					encryptedSources: encrypted.value,
					sourcesEncryptionIv: encrypted.iv,
				},
			});
			const proof = f.operation.files[0]!;
			const identity = proof.identityJson as Record<string, unknown>;
			const { trackIds: _tracks, foreignEditionId: _edition, ...oldIdentity } = identity;
			await prisma.arrImportFileProof.update({
				where: { id: proof.id, operation: { userId: "owner" } },
				data: {
					fileFingerprint: importCommandFingerprint([oldFiles[0]])!,
					identityJson: oldIdentity as never,
				},
			});
			f.command = {
				...f.command,
				body: {
					...body,
					files: oldFiles.map((file) =>
						item.service === "readarr" ? { ...file, foreignEditionId: null } : file,
					),
				},
			};
			const sameKey = await submitTrackedImport(f.context, {
				userId: "owner",
				instanceId: "instance",
				service: item.service,
				origin: "manual",
				idempotencyKey: "intentional-attempt",
				importMode: "auto",
				files: f.files,
			});
			expect(sameKey.id).toBe(f.operation.id);
			expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("observed");
			expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
				state: "completed",
				verifiedFileCount: 1,
				commandFingerprint: fingerprint,
			});
			expect(f.posts).toHaveBeenCalledOnce();
		},
	);
	it.each([
		{ item: services[2], fields: { trackIds: [99] } },
		{ item: services[2], fields: { albumReleaseId: 99 } },
		{ item: services[3], fields: { foreignEditionId: "edition-2" } },
		{ item: services[3], fields: { foreignEditionId: null } },
	])(
		"does not complete when a provider command alters its exact mapping %#",
		async ({ item, fields }) => {
			const f = await fixture(item);
			const body = f.command.body as { files: Record<string, unknown>[] };
			f.command = {
				...f.command,
				body: { ...body, files: body.files.map((file) => ({ ...file, ...fields })) },
			};
			expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("unavailable");
			expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
				verifiedFileCount: 0,
			});
			expect((await readOwnedImportAttempt(prisma, "owner", f.operation.id))?.state).not.toBe(
				"completed",
			);
			expect(f.posts).toHaveBeenCalledOnce();
		},
	);
	it("retains covered compound episode facts across full passes, restart and pruned History", async () => {
		const f = await fixture(services[0]);
		f.command = { ...f.command, status: "failed", result: "unsuccessful" };
		const positives = f.histories.get("source-0")!;
		f.histories.set("source-0", [positives[0]]);
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("observed");
		const first = await readOwnedImportAttempt(prisma, "owner", f.operation.id);
		expect(first).toMatchObject({
			verifiedFileCount: 0,
			reconcileCursor: {
				version: 2,
				sourceIndex: 1,
				witnesses: [],
				retainedWitnesses: [{ fileId: 31, episodeIds: [13] }],
			},
		});
		const fresh = createTestPrismaClient(`file:${join(directory, "fixture.db")}`);
		try {
			f.advance();
			f.command = {};
			f.histories.set("source-0", [positives[1]]);
			expect(
				await reconcileTrackedImport({ ...f.context, prisma: fresh }, "owner", f.operation.id),
			).toBe("observed");
			expect(await readOwnedImportAttempt(fresh, "owner", f.operation.id)).toMatchObject({
				state: "completed",
				verifiedFileCount: 1,
				reconcileCursor: { retainedWitnesses: [{ fileId: 31, episodeIds: [13, 14] }] },
			});
			expect(f.posts).toHaveBeenCalledOnce();
		} finally {
			await fresh.$disconnect();
		}
	});
	it.each(["empty-history", "read-failure", "connection-change"])(
		"does not erase covered episode facts after %s",
		async (kind) => {
			const f = await fixture(services[0]);
			f.command = { ...f.command, status: "failed", result: "unsuccessful" };
			f.histories.set("source-0", [f.histories.get("source-0")![0]]);
			await reconcileTrackedImport(f.context, "owner", f.operation.id);
			const first = await readOwnedImportAttempt(prisma, "owner", f.operation.id);
			expect(first).toMatchObject({
				reconcileCursor: { retainedWitnesses: [{ episodeIds: [13] }] },
			});
			f.advance();
			if (kind === "empty-history") f.histories.set("source-0", []);
			else if (kind === "read-failure")
				f.reader.mockRejectedValue(new Error("Synthetic read unavailable"));
			else
				await prisma.serviceInstance.updateMany({
					where: { id: "instance", userId: "owner" },
					data: { encryptedApiKey: "changed-synthetic-cipher" },
				});
			await reconcileTrackedImport(f.context, "owner", f.operation.id);
			expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
				verifiedFileCount: 0,
				reconcileCursor: { retainedWitnesses: [{ fileId: 31, episodeIds: [13] }] },
			});
			expect(f.posts).toHaveBeenCalledOnce();
		},
	);
	it("retains contradictory file identities across full passes without selecting a winner", async () => {
		const f = await fixture(services[0]);
		f.command = { ...f.command, status: "failed", result: "unsuccessful" };
		const positives = f.histories.get("source-0")!;
		f.histories.set("source-0", [positives[0]]);
		await reconcileTrackedImport(f.context, "owner", f.operation.id);
		f.advance();
		const next = positives[1] as { data: Record<string, unknown> };
		f.histories.set("source-0", [{ ...next, data: { ...next.data, fileId: 32 } }]);
		await reconcileTrackedImport(f.context, "owner", f.operation.id);
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			verifiedFileCount: 0,
			reconcileCursor: {
				retainedWitnesses: [],
				retainedAmbiguousFiles: [f.operation.files[0]!.fileFingerprint],
			},
		});
		f.advance();
		f.histories.set("source-0", positives);
		await reconcileTrackedImport(f.context, "owner", f.operation.id);
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			verifiedFileCount: 0,
			reconcileCursor: { retainedAmbiguousFiles: [f.operation.files[0]!.fileFingerprint] },
		});
	});
	it("retains covered facts for several sources across a budget yield and new database client", async () => {
		const f = await fixture(services[0], 5);
		f.command = { ...f.command, status: "failed", result: "unsuccessful" };
		for (const [source, rows] of f.histories) f.histories.set(source, [rows[0]]);
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("yielded");
		const first = await readOwnedImportAttempt(prisma, "owner", f.operation.id);
		const firstCursor = first!.reconcileCursor as { retainedWitnesses: unknown[] };
		expect(firstCursor.retainedWitnesses).toHaveLength(3);
		expect(first!.verifiedFileCount).toBe(0);
		const fresh = createTestPrismaClient(`file:${join(directory, "fixture.db")}`);
		try {
			f.advance();
			f.command = {};
			expect(
				await reconcileTrackedImport({ ...f.context, prisma: fresh }, "owner", f.operation.id),
			).toBe("observed");
			const saved = await readOwnedImportAttempt(fresh, "owner", f.operation.id);
			expect(
				(saved!.reconcileCursor as { retainedWitnesses: unknown[] }).retainedWitnesses,
			).toHaveLength(5);
			expect(saved).toMatchObject({
				verifiedFileCount: 0,
				state: "failed",
				reconcileCursor: { sourceIndex: 5, witnesses: [] },
			});
			expect(f.posts).toHaveBeenCalledOnce();
		} finally {
			await fresh.$disconnect();
		}
	});
	it("discards only a provisional page prefix on changed coverage, retaining the prior completed pass", async () => {
		const f = await fixture(services[0]);
		f.command = { ...f.command, status: "failed", result: "unsuccessful" };
		const positives = f.histories.get("source-0")!;
		f.histories.set("source-0", [positives[0]]);
		await reconcileTrackedImport(f.context, "owner", f.operation.id);
		f.advance();
		const rows: unknown[] = Array.from({ length: 401 }, () => ({ eventType: "grabbed" }));
		rows[0] = positives[1];
		f.histories.set("source-0", rows);
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("yielded");
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			verifiedFileCount: 0,
			reconcileCursor: {
				witnesses: [{ episodeIds: [14] }],
				retainedWitnesses: [{ episodeIds: [13] }],
			},
		});
		rows.push({ eventType: "grabbed" });
		f.advance();
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("unavailable");
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			verifiedFileCount: 0,
			reconcileCursor: { witnesses: [], retainedWitnesses: [{ episodeIds: [13] }] },
		});
		f.histories.set("source-0", []);
		f.advance();
		await reconcileTrackedImport(f.context, "owner", f.operation.id);
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			verifiedFileCount: 0,
			reconcileCursor: { retainedWitnesses: [{ episodeIds: [13] }] },
		});
	});
	it("upgrades a valid version-one continuation without inventing covered facts", async () => {
		const f = await fixture(services[0]);
		const positives = f.histories.get("source-0")!;
		const rows: unknown[] = Array.from({ length: 351 }, () => ({ eventType: "grabbed" }));
		rows[0] = positives[0];
		rows[350] = positives[1];
		f.histories.set("source-0", rows);
		await reconcileTrackedImport(f.context, "owner", f.operation.id);
		const operation = await readOwnedImportAttempt(prisma, "owner", f.operation.id);
		const current = parseImportReconcileCursor(
			operation!,
			operation!.reconcileCursor,
			f.context.now(),
		);
		if (current?.version !== 2) throw new Error("Expected a synthetic version-two cursor");
		const { retainedWitnesses: _retained, retainedAmbiguousFiles: _ambiguous, ...old } = current;
		await prisma.arrImportOperation.updateMany({
			where: { id: f.operation.id, userId: "owner" },
			data: {
				reconcileCursor: {
					...old,
					version: 1,
					witnesses: old.witnesses.map((witness) => ({
						...witness,
						episodeIds: [...witness.episodeIds],
					})),
				},
			},
		});
		f.advance();
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("observed");
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			verifiedFileCount: 1,
			reconcileCursor: { version: 2, retainedWitnesses: [{ episodeIds: [13, 14] }] },
		});
		expect(f.posts).toHaveBeenCalledOnce();
	});
	it.each(["remaining", "positive", "mixed", "remapped", "ambiguous"])(
		"admits only an explicitly selected fresh %s episode subset after restart",
		async (kind) => {
			const f = await fixture(services[0]);
			f.command = { ...f.command, status: "failed", result: "unsuccessful" };
			const positives = f.histories.get("source-0")!;
			f.histories.set("source-0", [positives[0]]);
			await reconcileTrackedImport(f.context, "owner", f.operation.id);
			if (kind === "ambiguous") {
				f.advance();
				const second = positives[1] as { data: Record<string, unknown> };
				f.histories.set("source-0", [{ ...second, data: { ...second.data, fileId: 32 } }]);
				await reconcileTrackedImport(f.context, "owner", f.operation.id);
			}
			const fresh = createTestPrismaClient(`file:${join(directory, "fixture.db")}`);
			try {
				// Keep the new real submission after the prior synthetic observation.
				vi.useFakeTimers({ toFake: ["Date"] });
				vi.setSystemTime(new Date(f.context.now().getTime() + 1));
				const prior = await readOwnedImportAttempt(fresh, "owner", f.operation.id);
				const nextPost = f.posts.mockImplementation(
					async (_path, body) =>
						({
							id: 52,
							name: "ManualImport",
							status: "queued",
							body,
						}) as never,
				);
				const input = {
					userId: "owner",
					instanceId: "instance",
					service: "sonarr" as const,
					origin: "manual" as const,
					idempotencyKey: "explicit-episode-remainder",
					remainderOf: f.operation.id,
					importMode: "auto" as const,
					files: [
						{
							...f.files[0]!,
							seriesId: kind === "remapped" ? 99 : 12,
							episodeIds: kind === "positive" ? [13] : kind === "mixed" ? [13, 14] : [14],
						},
					],
				};
				// Fresh provider candidates are still read after a new Prisma client starts.
				const submit = () =>
					submitTrackedImport({ prisma: fresh, encryptor, createClient: () => f.client }, input);
				if (kind === "remaining") {
					const next = await submit();
					expect(next).toMatchObject({ commandId: 52, selectedFileCount: 1, verifiedFileCount: 0 });
					expect(nextPost).toHaveBeenCalledTimes(2);
					expect(nextPost.mock.calls[1]![1]).toMatchObject({
						name: "ManualImport",
						files: [{ seriesId: 12, episodeIds: [14] }],
					});
					await submit();
					expect(nextPost).toHaveBeenCalledTimes(2);
				} else {
					await expect(submit()).rejects.toMatchObject({ statusCode: 409 });
					expect(nextPost).toHaveBeenCalledOnce();
				}
				expect(await readOwnedImportAttempt(fresh, "owner", f.operation.id)).toEqual(prior);
			} finally {
				vi.useRealTimers();
				await fresh.$disconnect();
			}
		},
	);
	it.each(services)(
		"scheduler observes $service progress from actual SDK reads without replay",
		async (service) => {
			const f = await fixture(service);
			const scheduler = new ImportOperationScheduler(f.context, { info: vi.fn(), warn: vi.fn() });
			await scheduler.tick();
			expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
				state: "completed",
				commandTerminal: true,
				verifiedFileCount: 1,
				reconcileToken: null,
			});
			expect(f.reader).toHaveBeenCalled();
			expect(f.posts).toHaveBeenCalledOnce(); // Only the original operator submission.
			await scheduler.stop();
			await new ImportOperationScheduler(f.context, { info: vi.fn(), warn: vi.fn() }).tick();
			expect(f.posts).toHaveBeenCalledOnce();
		},
	);
	it.each(services)("positively verifies $service files without another POST", async (service) => {
		const f = await fixture(service);
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("observed");
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			state: "completed",
			commandTerminal: true,
			verifiedFileCount: 1,
			reconcileToken: null,
		});
		expect(f.posts).toHaveBeenCalledOnce();
		const reads = f.reader.mock.calls.length;
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("observed");
		expect(f.reader.mock.calls.length).toBe(reads);
	});
	it("verifies multiple download sources rather than only the first", async () => {
		const f = await fixture(services[1], 2);
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("observed");
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			state: "completed",
			selectedFileCount: 2,
			verifiedFileCount: 2,
		});
		expect(
			new Set(
				f.reader.mock.calls
					.filter(([path]) => path.endsWith("/history"))
					.map(([, options]) => options?.downloadId),
			),
		).toEqual(new Set(["source-0", "source-1"]));
	});
	it("resumes compound-file witnesses across a bounded slice and command-log pruning", async () => {
		const f = await fixture(services[0]);
		const positives = f.histories.get("source-0")!;
		const rows: unknown[] = Array.from({ length: 351 }, () => ({ eventType: "grabbed" }));
		rows[299] = positives[0];
		rows[350] = positives[1];
		f.histories.set("source-0", rows);
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("yielded");
		const partial = await readOwnedImportAttempt(prisma, "owner", f.operation.id);
		expect(partial).toMatchObject({
			verifiedFileCount: 0,
			reconcileToken: null,
			reconcileCursor: { page: 4, seenRecords: 300, witnesses: [{ fileId: 31, episodeIds: [13] }] },
		});
		expect(f.reader).toHaveBeenCalledTimes(4);
		expect(JSON.stringify(partial?.reconcileCursor)).not.toContain("/synthetic");
		expect(JSON.stringify(partial?.reconcileCursor)).not.toContain("source-0");
		f.advance();
		f.command = {};
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("observed");
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			state: "completed",
			verifiedFileCount: 1,
		});
		expect(f.reader).toHaveBeenCalledTimes(5);
		expect(f.posts).toHaveBeenCalledOnce();
	});
	it("retains failed partial progress without converting missing files to completion", async () => {
		const f = await fixture(services[1], 2);
		f.command = { ...f.command, status: "failed", result: "unsuccessful" };
		f.histories.set("source-1", []);
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("observed");
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			state: "partial",
			commandTerminal: true,
			verifiedFileCount: 1,
		});
		expect(f.posts).toHaveBeenCalledOnce();
	});
	it.each(["body", "mode", "ended"])("refuses unverified command %s evidence", async (kind) => {
		const f = await fixture();
		if (kind === "body")
			f.command = {
				...f.command,
				body: {
					files: [{ path: "/foreign", downloadId: "foreign", movieId: 99 }],
					importMode: "Move",
				},
			};
		if (kind === "mode")
			f.command = { ...f.command, body: { ...(f.command.body as object), importMode: "Copy" } };
		if (kind === "ended") f.command = { ...f.command, ended: undefined };
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("unavailable");
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			verifiedFileCount: 0,
			reason: "evidence-unavailable",
			reconcileToken: null,
		});
		expect(f.posts).toHaveBeenCalledOnce();
	});
	it("refuses foreign-owner observation without provider access", async () => {
		const f = await fixture();
		expect(await reconcileTrackedImport(f.context, "other", f.operation.id)).toBe("not-due");
		expect(f.reader).not.toHaveBeenCalled();
	});
	it("retains truth and refuses old authority after connection replacement", async () => {
		const f = await fixture();
		await prisma.serviceInstance.updateMany({
			where: { id: "instance", userId: "owner" },
			data: { baseUrl: "https://replacement.invalid" },
		});
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("unavailable");
		expect(f.reader).not.toHaveBeenCalled();
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			state: "pending",
			verifiedFileCount: 0,
			reason: "connection-changed",
		});
	});
	it("recovers one exact lost acknowledgement without replaying the import", async () => {
		const f = await fixture();
		await prisma.arrImportOperation.updateMany({
			where: { id: f.operation.id, userId: "owner" },
			data: { commandId: null, commandState: "unknown", state: "unknown" },
		});
		f.command = {
			...f.command,
			queued: new Date(f.operation.submissionStartedAt!.getTime() + 1).toISOString(),
		};
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("observed");
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			commandId: 51,
			state: "completed",
			verifiedFileCount: 1,
		});
		expect(f.reader).toHaveBeenCalledTimes(3);
		expect(f.posts).toHaveBeenCalledOnce();
	});
	it.each(["missing", "ambiguous", "before-submission", "different-mode"])(
		"retains an unknown lost acknowledgement when discovery is %s",
		async (kind) => {
			const f = await fixture();
			await prisma.arrImportOperation.updateMany({
				where: { id: f.operation.id, userId: "owner" },
				data: { commandId: null, commandState: "unknown", state: "unknown" },
			});
			f.command = {
				...f.command,
				queued: new Date(
					f.operation.submissionStartedAt!.getTime() + (kind === "before-submission" ? -1 : 1),
				).toISOString(),
			};
			if (kind === "different-mode")
				f.command = { ...f.command, body: { ...(f.command.body as object), importMode: "Copy" } };
			f.reader.mockResolvedValue(
				kind === "missing"
					? []
					: kind === "ambiguous"
						? [f.command, { ...f.command, id: 52 }]
						: [f.command],
			);
			expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("unavailable");
			expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
				commandId: null,
				state: "unknown",
				verifiedFileCount: 0,
				reason: "evidence-unavailable",
				reconcileToken: null,
			});
			expect(f.reader).toHaveBeenCalledOnce();
			expect(f.posts).toHaveBeenCalledOnce();
		},
	);
	it("discards an incomplete source pass when totals change, then recovers without replay", async () => {
		const f = await fixture(services[0]);
		const positives = f.histories.get("source-0")!;
		const rows: unknown[] = Array.from({ length: 351 }, () => ({ eventType: "grabbed" }));
		rows[0] = positives[0];
		rows[350] = positives[1];
		f.histories.set("source-0", rows);
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("yielded");
		f.advance();
		rows.push({ eventType: "grabbed" });
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("unavailable");
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			verifiedFileCount: 0,
			reason: "coverage-incomplete",
			reconcileCursor: { page: 1, seenRecords: 0, witnesses: [], totalRecords: null },
		});
		f.advance();
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("observed");
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			state: "completed",
			verifiedFileCount: 1,
		});
		expect(f.posts).toHaveBeenCalledOnce();
	});
	it.each(["missing-total", "premature-empty", "wrong-page", "oversized-page"])(
		"refuses %s History pagination rather than publishing a file proof",
		async (kind) => {
			const f = await fixture();
			const original = f.reader.getMockImplementation()!;
			f.reader.mockImplementation(async (path, options) => {
				const response = await original(path, options);
				if (!path.endsWith("/history")) return response;
				const page = response as Record<string, unknown>;
				if (kind === "missing-total") return { ...page, totalRecords: undefined };
				if (kind === "premature-empty") return { ...page, records: [] };
				if (kind === "wrong-page") return { ...page, page: 2 };
				return { ...page, pageSize: 101 };
			});
			expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("unavailable");
			expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
				verifiedFileCount: 0,
				reason: "coverage-incomplete",
				reconcileToken: null,
			});
			expect(f.posts).toHaveBeenCalledOnce();
		},
	);
	it("accepts consistently clamped pages and proves a compound file only after the last page", async () => {
		const f = await fixture(services[0]);
		const original = f.reader.getMockImplementation()!;
		f.reader.mockImplementation(async (path, options) => {
			if (!path.endsWith("/history")) return original(path, options);
			const rows = f.histories.get(String(options?.downloadId))!;
			const page = Number(options?.page);
			return { page, pageSize: 1, totalRecords: rows.length, records: rows.slice(page - 1, page) };
		});
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("observed");
		expect(f.reader.mock.calls.filter(([path]) => path.endsWith("/history"))).toHaveLength(2);
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			state: "completed",
			verifiedFileCount: 1,
		});
	});
	it("rejects a late command response after its worker lease expires and safely retries observation", async () => {
		const f = await fixture();
		const original = f.reader.getMockImplementation()!;
		f.reader.mockImplementationOnce(async (path, options) => {
			f.advance();
			return original(path, options);
		});
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("superseded");
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			state: "pending",
			commandTerminal: false,
			verifiedFileCount: 0,
		});
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("observed");
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			state: "completed",
			verifiedFileCount: 1,
		});
		expect(f.posts).toHaveBeenCalledOnce();
	});
	it("yields when its wall-clock budget is spent even with request allowance remaining", async () => {
		const f = await fixture();
		let clock = Date.now() + 2000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const context = { ...f.context, now: () => new Date(clock) };
		const original = f.reader.getMockImplementation()!;
		f.reader.mockImplementationOnce(async (path, options) => {
			clock += 16_000;
			return original(path, options);
		});
		expect(await reconcileTrackedImport(context, "owner", f.operation.id)).toBe("yielded");
		expect(f.reader).toHaveBeenCalledOnce();
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			verifiedFileCount: 0,
			reason: "budget-yield",
			reconcileToken: null,
		});
		clock += 1001;
		expect(await reconcileTrackedImport(context, "owner", f.operation.id)).toBe("observed");
		expect(f.posts).toHaveBeenCalledOnce();
	});
	it("does not consume a provider response that arrives after the GET timeout", async () => {
		const f = await fixture();
		const originalTimer = globalThis.setTimeout;
		const timer = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation(((
				callback: Parameters<typeof setTimeout>[0],
				ms: number | undefined,
				...args: unknown[]
			) => originalTimer(callback, Number(ms) >= 10_000 ? 0 : ms, ...args)) as typeof setTimeout);
		let settle: (value: Record<string, unknown>) => void = () => {};
		f.reader.mockImplementationOnce(
			() =>
				new Promise<Record<string, unknown>>((resolve) => {
					settle = resolve;
				}),
		);
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("yielded");
		timer.mockRestore();
		const beforeLateResponse = await readOwnedImportAttempt(prisma, "owner", f.operation.id);
		settle(f.command);
		await Promise.resolve();
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toEqual(
			beforeLateResponse,
		);
		expect(beforeLateResponse).toMatchObject({
			state: "pending",
			verifiedFileCount: 0,
			reconcileToken: null,
		});
		f.advance();
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("observed");
		expect(f.posts).toHaveBeenCalledOnce();
	});
	it("returns only a generic failure when encrypted lookup material is corrupt", async () => {
		const f = await fixture();
		await prisma.arrImportOperation.updateMany({
			where: { id: f.operation.id, userId: "owner" },
			data: { encryptedSources: "synthetic-corruption" },
		});
		expect(await reconcileTrackedImport(f.context, "owner", f.operation.id)).toBe("unavailable");
		expect(f.reader).not.toHaveBeenCalled();
		expect(await readOwnedImportAttempt(prisma, "owner", f.operation.id)).toMatchObject({
			verifiedFileCount: 0,
			reason: "evidence-unavailable",
			reconcileToken: null,
		});
	});
});
