import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManualImportSubmissionFile } from "@arr/shared";
import { manualImportSubmissionFileSchema } from "@arr/shared";
import { LidarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { submitManualImportCommandWithSdk } from "../../../../routes/manual-import-utils.js";
import { createTestPrismaClient } from "../../../__tests__/test-prisma.js";
import { Encryptor } from "../../../auth/encryption.js";
import {
	importConnectionFingerprint,
	queueDownloadKey,
} from "../../../queue-cleaner/import-receipt.js";
import { importCommandFingerprint } from "../../manual-import-command.js";
import { observeLegacyImport } from "../legacy-observation.js";
import { reconcileTrackedImport } from "../reconciliation.js";
import { findImportSourceProtection } from "../repository.js";

let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;
const encryptor = new Encryptor(Buffer.alloc(32, 13).toString("base64"));
beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "arr-import-legacy-observe-"));
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
	await prisma.user.create({ data: { id: "other", username: "synthetic-other" } });
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
		service: "sonarr",
		Client: SonarrClient,
		media: { seriesId: 12, episodeIds: [13, 14] },
		event: "downloadFolderImported",
	},
	{
		service: "radarr",
		Client: RadarrClient,
		media: { movieId: 12 },
		event: "downloadFolderImported",
	},
	{
		service: "lidarr",
		Client: LidarrClient,
		media: { artistId: 12, albumId: 13 },
		event: "trackFileImported",
	},
	{
		service: "readarr",
		Client: ReadarrClient,
		media: { authorId: 12, bookId: 13 },
		event: "bookFileImported",
	},
] as const;
async function fixture(item: (typeof services)[number] = services[1], state = "pending") {
	const instance = await prisma.serviceInstance.create({
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
	const now = new Date();
	const started = new Date(now.getTime() - 4000);
	const media =
		item.service === "sonarr"
			? { seriesId: item.media.seriesId, episodeIds: [...item.media.episodeIds] }
			: item.media;
	const files: ManualImportSubmissionFile[] = [0, 1].map((id) => ({
		path: `/synthetic/file-${id}`,
		downloadId: "source",
		...media,
	}));
	const receipt = await prisma.queueCleanerImportReceipt.create({
		data: {
			id: "receipt",
			instanceId: instance.id,
			downloadKey: queueDownloadKey(files[0]!)!,
			queueId: 7,
			downloadTitle: "Synthetic private title",
			connectionFingerprint: importConnectionFingerprint(instance),
			commandFingerprint: importCommandFingerprint(files)!,
			commandId: 51,
			state,
			lastAttemptAt: started,
		},
	});
	let command: Record<string, unknown> = {
		id: 51,
		name: "ManualImport",
		status: "completed",
		result: "successful",
		queued: new Date(started.getTime() + 1).toISOString(),
		ended: new Date(started.getTime() + 2000).toISOString(),
		body: { name: "ManualImport", importMode: "Move", files },
	};
	let commands: unknown[] | null = null;
	let histories: unknown[] = files.flatMap((file, index) =>
		(item.service === "sonarr" ? [13, 14] : [undefined]).map((episodeId) => ({
			eventType: item.event,
			downloadId: file.downloadId,
			...item.media,
			episodeId,
			date: new Date(started.getTime() + 1000).toISOString(),
			data: { droppedPath: file.path, fileId: index + 31 },
		})),
	);
	const client = new item.Client({ baseUrl: "https://fixture.invalid", apiKey: "synthetic-key" });
	const reads = vi.spyOn(client, "get").mockImplementation(async (path, options) => {
		if (String(path).endsWith("/command")) return (commands ?? [command]) as never;
		if (String(path).includes("/command/")) return command as never;
		if (String(path).endsWith("/history")) {
			const query = options as { page: number; pageSize: number };
			const offset = (query.page - 1) * query.pageSize;
			return {
				page: query.page,
				pageSize: query.pageSize,
				totalRecords: histories.length,
				records: histories.slice(offset, offset + query.pageSize),
			} as never;
		}
		throw new Error("unexpected provider read");
	});
	const posts = vi.spyOn(client, "post").mockRejectedValue(new Error("No POST permitted"));
	const createClient = vi.fn(() => client);
	const context = { prisma, encryptor, createClient, now: () => now };
	return {
		item,
		instance,
		files,
		receipt,
		reads,
		posts,
		context,
		setCommand: (value: Record<string, unknown>) => {
			command = value;
		},
		getCommand: () => command,
		setCommands: (value: unknown[]) => {
			commands = value;
		},
		setHistory: (value: unknown[]) => {
			histories = value;
		},
		getHistory: () => histories,
	};
}
async function bind(view: Awaited<ReturnType<typeof fixture>>) {
	const result = await observeLegacyImport(view.context, "owner", view.receipt.id);
	expect(result.kind).toBe("bound");
	if (result.kind !== "bound") throw new Error("expected bound legacy observation");
	return result.operation;
}
describe("Exact legacy import observation", () => {
	it.each([undefined, null])(
		"retains historical Readarr edition %j through pending observation and restarted History proof",
		async (foreignEditionId) => {
			const view = await fixture(services[3]);
			const terminal = view.getCommand();
			const body = terminal.body as { files: ManualImportSubmissionFile[] };
			const rawFiles = body.files.map((file) => ({ ...file, foreignEditionId }));
			expect(importCommandFingerprint(rawFiles)).toBe(
				"v1:df0839f64874809e4f1e203c875f50ed3e9ad096bedee0f2ac1257e187ef7968",
			);
			view.setCommand({
				...terminal,
				status: "started",
				ended: undefined,
				body: { ...body, importMode: "Move", files: rawFiles },
			});
			const operation = await bind(view);
			expect(rawFiles[0]).toHaveProperty("foreignEditionId", foreignEditionId);
			expect(operation).toMatchObject({
				state: "pending",
				commandTerminal: false,
				verifiedFileCount: 0,
				commandFingerprint: "v1:df0839f64874809e4f1e203c875f50ed3e9ad096bedee0f2ac1257e187ef7968",
			});
			const lookup = JSON.parse(
				encryptor.decrypt({ value: operation.encryptedSources, iv: operation.sourcesEncryptionIv }),
			);
			expect(lookup.files).toEqual([
				{ path: "/synthetic/file-0", downloadId: "source", authorId: 12, bookId: 13 },
				{ path: "/synthetic/file-1", downloadId: "source", authorId: 12, bookId: 13 },
			]);
			expect(
				operation.files.every(
					(file) => !Object.hasOwn(file.identityJson as object, "foreignEditionId"),
				),
			).toBe(true);
			expect(await reconcileTrackedImport(view.context, "owner", operation.id)).toBe("observed");
			expect(view.reads.mock.calls.some(([path]) => String(path).endsWith("/history"))).toBe(false);
			view.reads.mockClear();
			const peer = createTestPrismaClient(`file:${join(directory, "fixture.db")}`);
			try {
				expect(
					await observeLegacyImport({ ...view.context, prisma: peer }, "owner", "receipt"),
				).toMatchObject({ kind: "bound", operation: { id: operation.id, verifiedFileCount: 0 } });
				expect(view.reads).not.toHaveBeenCalled();
				view.setCommand({ ...terminal, body: { ...body, importMode: "Move", files: rawFiles } });
				expect(
					await reconcileTrackedImport(
						{
							...view.context,
							prisma: peer,
							now: () => new Date(view.context.now().getTime() + 60_000),
						},
						"owner",
						operation.id,
					),
				).toBe("observed");
				expect(
					await peer.arrImportOperation.findFirstOrThrow({
						where: { id: operation.id, userId: "owner" },
					}),
				).toMatchObject({ state: "completed", verifiedFileCount: 2 });
			} finally {
				await peer.$disconnect();
			}
			expect(
				await prisma.queueCleanerImportReceipt.findFirstOrThrow({
					where: { id: "receipt", instance: { userId: "owner" } },
				}),
			).toEqual(view.receipt);
			expect(view.posts).not.toHaveBeenCalled();
		},
	);
	it.each(["started", "completed"])(
		"discovers an exact typed-null Readarr %s command without POST",
		async (status) => {
			const view = await fixture(services[3]);
			const command = view.getCommand();
			const body = command.body as { files: ManualImportSubmissionFile[] };
			const receipt = await prisma.queueCleanerImportReceipt.update({
				where: { id: "receipt" },
				data: { commandId: null },
			});
			const rawFiles = body.files.map((file) => ({ ...file, foreignEditionId: null }));
			view.setCommand({
				...command,
				status,
				...(status === "started" ? { ended: undefined } : {}),
				body: { ...body, importMode: "Move", files: rawFiles },
			});
			const operation = await bind(view);
			expect(operation).toMatchObject({
				commandId: 51,
				verifiedFileCount: 0,
				commandTerminal: status === "completed",
				commandFingerprint: "v1:df0839f64874809e4f1e203c875f50ed3e9ad096bedee0f2ac1257e187ef7968",
			});
			expect(view.reads.mock.calls.map(([path]) => path)).toEqual([
				"/api/v1/command",
				"/api/v1/command/51",
			]);
			expect(rawFiles[0]).toHaveProperty("foreignEditionId", null);
			if (status === "completed") {
				expect(await reconcileTrackedImport(view.context, "owner", operation.id)).toBe("observed");
				expect(
					await prisma.arrImportOperation.findFirstOrThrow({
						where: { id: operation.id, userId: "owner" },
					}),
				).toMatchObject({ state: "completed", verifiedFileCount: 2 });
			}
			expect(
				await prisma.queueCleanerImportReceipt.findFirstOrThrow({
					where: { id: "receipt", instance: { userId: "owner" } },
				}),
			).toEqual(receipt);
			expect(view.posts).not.toHaveBeenCalled();
		},
	);
	it("adopts a terminal typed-null Readarr command without command-only file success", async () => {
		const view = await fixture(services[3]);
		const command = view.getCommand();
		const body = command.body as { files: ManualImportSubmissionFile[] };
		view.setCommand({
			...command,
			body: {
				...body,
				importMode: "Move",
				files: body.files.map((file) => ({ ...file, foreignEditionId: null })),
			},
		});
		view.setHistory([]);
		const operation = await bind(view);
		expect(operation).toMatchObject({
			commandTerminal: true,
			verifiedFileCount: 0,
			state: "unknown",
		});
		expect(await reconcileTrackedImport(view.context, "owner", operation.id)).toBe("observed");
		expect(
			await prisma.arrImportOperation.findFirstOrThrow({
				where: { id: operation.id, userId: "owner" },
			}),
		).toMatchObject({ verifiedFileCount: 0, state: "unknown" });
		expect(view.posts).not.toHaveBeenCalled();
		expect(
			await prisma.queueCleanerImportReceipt.findFirstOrThrow({
				where: { id: "receipt", instance: { userId: "owner" } },
			}),
		).toEqual(view.receipt);
	});
	it("preserves a valid historical Readarr edition in encrypted lookup and immutable media identity", async () => {
		const view = await fixture(services[3]);
		const command = view.getCommand();
		const body = command.body as { files: ManualImportSubmissionFile[] };
		const rawFiles = body.files.map((file) => ({ ...file, foreignEditionId: "edition-1" }));
		const receipt = await prisma.queueCleanerImportReceipt.update({
			where: { id: "receipt" },
			data: { commandFingerprint: importCommandFingerprint(rawFiles)! },
		});
		view.setCommand({ ...command, body: { ...body, importMode: "Move", files: rawFiles } });
		const operation = await bind(view);
		const lookup = JSON.parse(
			encryptor.decrypt({ value: operation.encryptedSources, iv: operation.sourcesEncryptionIv }),
		);
		expect(lookup.files).toEqual([
			{
				path: "/synthetic/file-0",
				downloadId: "source",
				authorId: 12,
				bookId: 13,
				foreignEditionId: "edition-1",
			},
			{
				path: "/synthetic/file-1",
				downloadId: "source",
				authorId: 12,
				bookId: 13,
				foreignEditionId: "edition-1",
			},
		]);
		expect(operation.files).toHaveLength(2);
		for (const file of operation.files)
			expect(file.identityJson).toMatchObject({
				authorId: 12,
				bookId: 13,
				foreignEditionId: "edition-1",
			});
		expect(await reconcileTrackedImport(view.context, "owner", operation.id)).toBe("observed");
		expect(
			await prisma.arrImportOperation.findFirstOrThrow({
				where: { id: operation.id, userId: "owner" },
			}),
		).toMatchObject({ state: "completed", verifiedFileCount: 2 });
		expect(
			await prisma.queueCleanerImportReceipt.findFirstOrThrow({
				where: { id: "receipt", instance: { userId: "owner" } },
			}),
		).toEqual(receipt);
		expect(view.posts).not.toHaveBeenCalled();
	});
	it.each(services.slice(0, 3))(
		"rejects a foreign edition in historical $service command media",
		async (item) => {
			const view = await fixture(item);
			const command = view.getCommand();
			const body = command.body as { files: ManualImportSubmissionFile[] };
			const rawFiles = body.files.map((file) => ({ ...file, foreignEditionId: "edition-1" }));
			await prisma.queueCleanerImportReceipt.update({
				where: { id: "receipt" },
				data: { commandFingerprint: importCommandFingerprint(rawFiles)! },
			});
			view.setCommand({ ...command, body: { ...body, importMode: "Move", files: rawFiles } });
			expect(await observeLegacyImport(view.context, "owner", "receipt")).toEqual({
				kind: "unavailable",
			});
			expect(await prisma.arrImportOperation.count()).toBe(0);
			expect(view.posts).not.toHaveBeenCalled();
		},
	);
	it.each(["", " edition", "edition ", "x".repeat(1025), 12])(
		"rejects malformed historical Readarr edition %#",
		async (foreignEditionId) => {
			const view = await fixture(services[3]);
			const command = view.getCommand();
			const body = command.body as { files: ManualImportSubmissionFile[] };
			view.setCommand({
				...command,
				body: {
					...body,
					importMode: "Move",
					files: body.files.map((file) => ({ ...file, foreignEditionId })),
				},
			});
			expect(await observeLegacyImport(view.context, "owner", "receipt")).toEqual({
				kind: "unavailable",
			});
			expect(await prisma.arrImportOperation.count()).toBe(0);
			expect(view.posts).not.toHaveBeenCalled();
		},
	);
	it.each([undefined, null, "", " edition"])(
		"does not authorize new Readarr dispatch with edition %j",
		async (foreignEditionId) => {
			const view = await fixture(services[3]);
			const files = view.files.map((file) => ({ ...file, foreignEditionId }));
			if (foreignEditionId !== undefined)
				expect(manualImportSubmissionFileSchema.safeParse(files[0]).success).toBe(false);
			await expect(
				submitManualImportCommandWithSdk(
					view.context.createClient(),
					"readarr",
					files as ManualImportSubmissionFile[],
					"move",
				),
			).rejects.toBeDefined();
			expect(view.posts).not.toHaveBeenCalled();
		},
	);
	it.each(services)(
		"retains exact pending $service selection across restart without premature proof",
		async (item) => {
			const view = await fixture(item);
			const terminal = view.getCommand();
			view.setCommand({ ...terminal, status: "started", result: undefined, ended: undefined });
			const operation = await bind(view);
			expect(operation).toMatchObject({
				state: "pending",
				commandState: "pending",
				commandTerminal: false,
				selectedFileCount: 2,
				verifiedFileCount: 0,
			});
			expect(await reconcileTrackedImport(view.context, "owner", operation.id)).toBe("observed");
			expect(view.reads.mock.calls.some(([path]) => String(path).endsWith("/history"))).toBe(false);
			expect(await prisma.arrImportFileProof.count({ where: { verifiedAt: { not: null } } })).toBe(
				0,
			);
			expect(await prisma.arrImportSourceClaim.count()).toBe(0);
			view.reads.mockClear();
			const peer = createTestPrismaClient(`file:${join(directory, "fixture.db")}`);
			try {
				expect(
					await observeLegacyImport({ ...view.context, prisma: peer }, "owner", "receipt"),
				).toMatchObject({
					kind: "bound",
					operation: {
						id: operation.id,
						state: "pending",
						selectedFileCount: 2,
						verifiedFileCount: 0,
					},
				});
				expect(view.reads).not.toHaveBeenCalled();
				view.setCommand(terminal);
				expect(
					await reconcileTrackedImport(
						{
							...view.context,
							prisma: peer,
							now: () => new Date(view.context.now().getTime() + 60_000),
						},
						"owner",
						operation.id,
					),
				).toBe("observed");
				expect(
					await peer.arrImportOperation.findFirst({ where: { id: operation.id, userId: "owner" } }),
				).toMatchObject({
					state: "completed",
					commandTerminal: true,
					selectedFileCount: 2,
					verifiedFileCount: 2,
				});
			} finally {
				await peer.$disconnect();
			}
			expect(
				await prisma.queueCleanerImportReceipt.findFirst({
					where: { id: "receipt", instance: { userId: "owner" } },
				}),
			).toEqual(view.receipt);
			expect(await findImportSourceProtection(prisma, "owner", [view.receipt.downloadKey])).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: "legacy" }),
					expect.objectContaining({ kind: "operation" }),
				]),
			);
			expect(view.posts).not.toHaveBeenCalled();
		},
	);
	it.each(services)(
		"retains known $service selection with unknown command outcome without terminal authority",
		async (item) => {
			const view = await fixture(item);
			view.setCommand({ ...view.getCommand(), status: "unrecognized", ended: undefined });
			const operation = await bind(view);
			expect(operation).toMatchObject({
				state: "unknown",
				reason: "evidence-unavailable",
				commandState: "unknown",
				commandTerminal: false,
				selectedFileCount: 2,
				verifiedFileCount: 0,
			});
			expect(await reconcileTrackedImport(view.context, "owner", operation.id)).toBe("unavailable");
			expect(view.reads.mock.calls.some(([path]) => String(path).endsWith("/history"))).toBe(false);
			expect(await prisma.arrImportFileProof.count({ where: { verifiedAt: { not: null } } })).toBe(
				0,
			);
			expect(await prisma.arrImportSourceClaim.count()).toBe(0);
			expect(view.posts).not.toHaveBeenCalled();
		},
	);
	it.each(["started", "unrecognized"])(
		"binds the unique exact %s lost acknowledgement without claiming completion",
		async (status) => {
			const view = await fixture();
			await prisma.queueCleanerImportReceipt.update({
				where: { id: "receipt" },
				data: { commandId: null },
			});
			view.setCommand({ ...view.getCommand(), status, ended: undefined });
			const operation = await bind(view);
			expect(operation).toMatchObject({
				commandId: 51,
				commandTerminal: false,
				selectedFileCount: 2,
				verifiedFileCount: 0,
			});
			expect(view.reads.mock.calls.map(([path]) => path)).toEqual([
				"/api/v3/command",
				"/api/v3/command/51",
			]);
			expect(view.posts).not.toHaveBeenCalled();
		},
	);
	it.each(["completed", "failed"])(
		"does not downgrade historical %s for pending or unknown current evidence",
		async (state) => {
			const view = await fixture(services[1], state);
			for (const status of ["started", "unrecognized"]) {
				view.setCommand({ ...view.getCommand(), status, ended: undefined });
				expect(await observeLegacyImport(view.context, "owner", "receipt")).toEqual({
					kind: "unavailable",
				});
			}
			expect(await prisma.arrImportOperation.count()).toBe(0);
			expect(
				await prisma.queueCleanerImportReceipt.findFirst({
					where: { id: "receipt", instance: { userId: "owner" } },
				}),
			).toEqual(view.receipt);
			expect(view.posts).not.toHaveBeenCalled();
		},
	);
	it.each(["started", "unrecognized"])(
		"does not bind %s when its exact file list is missing or changed",
		async (status) => {
			const view = await fixture();
			for (const files of [undefined, [{ ...view.files[0], path: "/changed" }]]) {
				view.setCommand({
					...view.getCommand(),
					status,
					ended: undefined,
					body: { importMode: "Move", files },
				});
				expect(await observeLegacyImport(view.context, "owner", "receipt")).toEqual({
					kind: "unavailable",
				});
			}
			expect(await prisma.arrImportOperation.count()).toBe(0);
			expect(view.posts).not.toHaveBeenCalled();
		},
	);
	it.each(services)(
		"recovers $service file bindings and obtains only positive per-file completion without replay",
		async (item) => {
			const view = await fixture(item);
			const operation = await bind(view);
			expect(operation).toMatchObject({
				legacyReceiptId: "receipt",
				origin: "queue-cleaner",
				selectedFileCount: 2,
				verifiedFileCount: 0,
				state: "unknown",
				commandId: 51,
				commandTerminal: true,
			});
			expect(operation.files.every((file) => file.verifiedAt === null)).toBe(true);
			expect(await reconcileTrackedImport(view.context, "owner", operation.id)).toBe("observed");
			expect(
				await prisma.arrImportOperation.findFirst({ where: { id: operation.id, userId: "owner" } }),
			).toMatchObject({ state: "completed", selectedFileCount: 2, verifiedFileCount: 2 });
			expect(
				await prisma.queueCleanerImportReceipt.findFirst({
					where: { id: "receipt", instance: { userId: "owner" } },
				}),
			).toEqual(view.receipt);
			expect(view.posts).not.toHaveBeenCalled();
			expect(await findImportSourceProtection(prisma, "owner", [view.receipt.downloadKey])).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: "legacy" }),
					expect.objectContaining({ kind: "operation", state: "completed" }),
				]),
			);
		},
	);
	it("uses cached linkage after restart and connection removal without provider access", async () => {
		const view = await fixture();
		const operation = await bind(view);
		view.reads.mockClear();
		view.context.createClient.mockClear();
		const peer = createTestPrismaClient(`file:${join(directory, "fixture.db")}`);
		try {
			await prisma.serviceInstance.delete({ where: { id: "instance" } });
			const result = await observeLegacyImport(
				{ ...view.context, prisma: peer },
				"owner",
				"receipt",
			);
			expect(result).toMatchObject({
				kind: "bound",
				operation: { id: operation.id, originalInstanceId: "instance", instanceId: null },
			});
			expect(view.reads).not.toHaveBeenCalled();
			expect(view.context.createClient).not.toHaveBeenCalled();
		} finally {
			await peer.$disconnect();
		}
	});
	it("never borrows another owner's legacy receipt or linked operation", async () => {
		const view = await fixture();
		expect(await observeLegacyImport(view.context, "other", "receipt")).toEqual({
			kind: "unavailable",
		});
		expect(view.context.createClient).not.toHaveBeenCalled();
		await bind(view);
		view.context.createClient.mockClear();
		expect(await observeLegacyImport(view.context, "other", "receipt")).toEqual({
			kind: "unavailable",
		});
		expect(view.context.createClient).not.toHaveBeenCalled();
	});
	it.each(["changed", "disabled"])("blocks %s connection before provider reads", async (change) => {
		const view = await fixture();
		await prisma.serviceInstance.update({
			where: { id: "instance" },
			data: change === "changed" ? { baseUrl: "https://other.invalid" } : { enabled: false },
		});
		expect(await observeLegacyImport(view.context, "owner", "receipt")).toEqual({
			kind: "unavailable",
		});
		expect(view.context.createClient).not.toHaveBeenCalled();
		expect(await prisma.arrImportOperation.count()).toBe(0);
	});
	it.each([
		"id",
		"fingerprint",
		"mode",
		"time",
		"future-end",
		"source",
		"media",
		"missing-end",
		"malformed",
	])("does not adopt %s-mismatched provider evidence", async (change) => {
		const view = await fixture();
		const command = view.getCommand();
		const body = command.body as { files: ManualImportSubmissionFile[]; importMode: string };
		const changed = { ...command };
		if (change === "id") changed.id = 52;
		if (change === "fingerprint")
			changed.body = { ...body, files: [{ ...view.files[0], path: "/different" }] };
		if (change === "mode") changed.body = { ...body, importMode: "Copy" };
		if (change === "time")
			changed.queued = new Date(view.receipt.lastAttemptAt.getTime() - 1).toISOString();
		if (change === "future-end") changed.ended = new Date(Date.now() + 60_000).toISOString();
		if (change === "source") {
			changed.body = {
				...body,
				files: view.files.map((file) => ({ ...file, downloadId: "other-source" })),
			};
			await prisma.queueCleanerImportReceipt.update({
				where: { id: "receipt" },
				data: {
					commandFingerprint: importCommandFingerprint((changed.body as typeof body).files)!,
				},
			});
		}
		if (change === "media") {
			changed.body = { ...body, files: view.files.map((file) => ({ ...file, seriesId: 99 })) };
			await prisma.queueCleanerImportReceipt.update({
				where: { id: "receipt" },
				data: {
					commandFingerprint: importCommandFingerprint((changed.body as typeof body).files)!,
				},
			});
		}
		if (change === "missing-end") changed.ended = undefined;
		if (change === "malformed") changed.body = { files: null };
		view.setCommand(changed);
		expect(await observeLegacyImport(view.context, "owner", "receipt")).toEqual({
			kind: "unavailable",
		});
		expect(await prisma.arrImportOperation.count()).toBe(0);
		expect(view.posts).not.toHaveBeenCalled();
	});
	it.each([0, 2])(
		"keeps lost acknowledgement unavailable with %s exact command matches",
		async (count) => {
			const view = await fixture();
			await prisma.queueCleanerImportReceipt.update({
				where: { id: "receipt" },
				data: { commandId: null },
			});
			view.setCommands(
				Array.from({ length: count }, (_, index) => ({ ...view.getCommand(), id: index + 51 })),
			);
			expect(await observeLegacyImport(view.context, "owner", "receipt")).toEqual({
				kind: "unavailable",
			});
			expect(await prisma.arrImportOperation.count()).toBe(0);
		},
	);
	it("discovers one exact lost acknowledgement and rechecks its full command", async () => {
		const view = await fixture();
		await prisma.queueCleanerImportReceipt.update({
			where: { id: "receipt" },
			data: { commandId: null },
		});
		const operation = await bind(view);
		expect(operation.commandId).toBe(51);
		expect(view.reads.mock.calls.map(([path]) => path)).toEqual([
			"/api/v3/command",
			"/api/v3/command/51",
		]);
	});
	it.each(["started", "unrecognized"])(
		"does not ignore an exact %s match during lost-acknowledgement discovery",
		async (status) => {
			const view = await fixture();
			await prisma.queueCleanerImportReceipt.update({
				where: { id: "receipt" },
				data: { commandId: null },
			});
			view.setCommands([
				view.getCommand(),
				{ ...view.getCommand(), id: 52, status, ended: undefined },
			]);
			expect(await observeLegacyImport(view.context, "owner", "receipt")).toEqual({
				kind: "unavailable",
			});
			expect(await prisma.arrImportOperation.count()).toBe(0);
			expect(view.reads.mock.calls.map(([path]) => path)).toEqual(["/api/v3/command"]);
			expect(view.posts).not.toHaveBeenCalled();
		},
	);
	it("preserves completed legacy history while missing current file evidence remains unavailable", async () => {
		const view = await fixture(services[1], "completed");
		view.setHistory([]);
		const operation = await bind(view);
		await reconcileTrackedImport(view.context, "owner", operation.id);
		expect(
			await prisma.arrImportOperation.findFirst({ where: { id: operation.id, userId: "owner" } }),
		).toMatchObject({ state: "unknown", verifiedFileCount: 0 });
		expect(
			await prisma.queueCleanerImportReceipt.findFirst({
				where: { id: "receipt", instance: { userId: "owner" } },
			}),
		).toEqual(view.receipt);
	});
	it("resumes recovered legacy History across a bounded slice and database-client restart", async () => {
		const view = await fixture(services[0]);
		const positives = view.getHistory();
		const rows: unknown[] = Array.from({ length: 352 }, () => ({ eventType: "grabbed" }));
		rows[0] = positives[0];
		rows[299] = positives[1];
		rows[350] = positives[2];
		rows[351] = positives[3];
		view.setHistory(rows);
		const operation = await bind(view);
		view.reads.mockClear();
		expect(await reconcileTrackedImport(view.context, "owner", operation.id)).toBe("yielded");
		expect(view.reads).toHaveBeenCalledTimes(4);
		const yielded = await prisma.arrImportOperation.findFirst({
			where: { id: operation.id, userId: "owner" },
		});
		expect(yielded).toMatchObject({
			reconcileToken: null,
			reconcileCursor: { page: 4, seenRecords: 300 },
		});
		expect(JSON.stringify(yielded?.reconcileCursor)).not.toContain("/synthetic");
		expect(JSON.stringify(yielded?.reconcileCursor)).not.toContain('"source"');
		const peer = createTestPrismaClient(`file:${join(directory, "fixture.db")}`);
		try {
			view.setCommand({});
			expect(
				await reconcileTrackedImport(
					{
						...view.context,
						prisma: peer,
						now: () => new Date(view.context.now().getTime() + 60_000),
					},
					"owner",
					operation.id,
				),
			).toBe("observed");
			expect(
				await peer.arrImportOperation.findFirst({ where: { id: operation.id, userId: "owner" } }),
			).toMatchObject({ state: "completed", selectedFileCount: 2, verifiedFileCount: 2 });
			expect(view.reads).toHaveBeenCalledTimes(5);
			expect(
				await peer.queueCleanerImportReceipt.findFirst({
					where: { id: "receipt", instance: { userId: "owner" } },
				}),
			).toEqual(view.receipt);
			expect(view.posts).not.toHaveBeenCalled();
		} finally {
			await peer.$disconnect();
		}
	});
	it("requires the discovered command detail to retain its exact file binding", async () => {
		const view = await fixture();
		await prisma.queueCleanerImportReceipt.update({
			where: { id: "receipt" },
			data: { commandId: null },
		});
		view.setCommands([view.getCommand()]);
		view.setCommand({
			...view.getCommand(),
			body: { importMode: "Move", files: [{ ...view.files[0], path: "/different" }] },
		});
		expect(await observeLegacyImport(view.context, "owner", "receipt")).toEqual({
			kind: "unavailable",
		});
		expect(await prisma.arrImportOperation.count()).toBe(0);
	});
	it.each(["rejected", "pruned", "non-array", "too-many", "utf8-limit"])(
		"keeps %s provider evidence unavailable without replay",
		async (kind) => {
			const view = await fixture();
			if (kind === "too-many" || kind === "non-array")
				await prisma.queueCleanerImportReceipt.update({
					where: { id: "receipt" },
					data: { commandId: null },
				});
			if (kind === "rejected")
				view.reads.mockRejectedValue(new Error("synthetic provider failure"));
			if (kind === "pruned") view.setCommand({});
			if (kind === "non-array") view.reads.mockResolvedValue({ records: [] } as never);
			if (kind === "too-many")
				view.setCommands(
					Array.from({ length: 1001 }, (_, id) => ({ ...view.getCommand(), id: id + 1 })),
				);
			if (kind === "utf8-limit") {
				const files = [{ ...view.files[0]!, path: "界".repeat(1_500_000) }];
				await prisma.queueCleanerImportReceipt.update({
					where: { id: "receipt" },
					data: { commandFingerprint: importCommandFingerprint(files)! },
				});
				view.setCommand({ ...view.getCommand(), body: { importMode: "Move", files } });
			}
			expect(await observeLegacyImport(view.context, "owner", "receipt")).toEqual({
				kind: "unavailable",
			});
			expect(await prisma.arrImportOperation.count()).toBe(0);
			expect(view.posts).not.toHaveBeenCalled();
		},
	);
	it("does not persist a provider read that settles after the observation deadline", async () => {
		const view = await fixture();
		let signalRead!: () => void;
		const started = new Promise<void>((resolve) => {
			signalRead = resolve;
		});
		let settle!: (value: never) => void;
		const held = new Promise<never>((resolve) => {
			settle = resolve;
		});
		view.reads.mockImplementationOnce(() => {
			signalRead();
			return held;
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const observation = observeLegacyImport(view.context, "owner", "receipt");
		await started;
		await vi.advanceTimersByTimeAsync(15_001);
		expect(await observation).toEqual({ kind: "unavailable" });
		settle(view.getCommand() as never);
		await Promise.resolve();
		vi.useRealTimers();
		expect(await prisma.arrImportOperation.count()).toBe(0);
		expect(view.posts).not.toHaveBeenCalled();
	});
	it.each(["unrecognized", "invalid"])("does not reinterpret %s legacy state", async (state) => {
		const view = await fixture(services[1], state);
		expect(await observeLegacyImport(view.context, "owner", "receipt")).toEqual({
			kind: "unavailable",
		});
		expect(view.context.createClient).not.toHaveBeenCalled();
		expect(await prisma.arrImportOperation.count()).toBe(0);
	});
	it.each(["completed", "failed"])(
		"does not overwrite historical %s with contradictory terminal evidence",
		async (state) => {
			const view = await fixture(services[1], state);
			view.setCommand({
				...view.getCommand(),
				status: state === "completed" ? "failed" : "completed",
				result: state === "completed" ? "unsuccessful" : "successful",
			});
			expect(await observeLegacyImport(view.context, "owner", "receipt")).toEqual({
				kind: "unavailable",
			});
			expect(await prisma.arrImportOperation.count()).toBe(0);
			expect(
				await prisma.queueCleanerImportReceipt.findFirst({
					where: { id: "receipt", instance: { userId: "owner" } },
				}),
			).toEqual(view.receipt);
		},
	);
	it("rejects a mismatched SDK client before provider reads", async () => {
		const view = await fixture();
		const client = new SonarrClient({
			baseUrl: "https://fixture.invalid",
			apiKey: "synthetic-key",
		});
		const get = vi.spyOn(client, "get");
		expect(
			await observeLegacyImport(
				{ ...view.context, createClient: () => client },
				"owner",
				"receipt",
			),
		).toEqual({ kind: "unavailable" });
		expect(get).not.toHaveBeenCalled();
		expect(await prisma.arrImportOperation.count()).toBe(0);
	});
	it("preserves failed legacy command and truthful partial file progress without removing protection", async () => {
		const view = await fixture(services[1], "failed");
		view.setCommand({ ...view.getCommand(), status: "failed", result: "unsuccessful" });
		view.setHistory(view.getHistory().slice(0, 1));
		const operation = await bind(view);
		expect(operation).toMatchObject({ state: "failed", verifiedFileCount: 0 });
		await reconcileTrackedImport(view.context, "owner", operation.id);
		expect(
			await prisma.arrImportOperation.findFirst({ where: { id: operation.id, userId: "owner" } }),
		).toMatchObject({ state: "partial", selectedFileCount: 2, verifiedFileCount: 1 });
		expect(
			await prisma.queueCleanerImportReceipt.findFirst({
				where: { id: "receipt", instance: { userId: "owner" } },
			}),
		).toEqual(view.receipt);
		expect(view.posts).not.toHaveBeenCalled();
	});
	it("rejects a legacy receipt changed while its command GET was in flight", async () => {
		const view = await fixture();
		view.reads.mockImplementationOnce(async () => {
			await prisma.queueCleanerImportReceipt.update({
				where: { id: "receipt" },
				data: { commandId: 52 },
			});
			return view.getCommand() as never;
		});
		expect(await observeLegacyImport(view.context, "owner", "receipt")).toEqual({
			kind: "unavailable",
		});
		expect(await prisma.arrImportOperation.count()).toBe(0);
	});
	it("never steals an existing source claim", async () => {
		const view = await fixture();
		await prisma.arrImportSourceClaim.create({
			data: {
				userId: "owner",
				downloadKey: view.receipt.downloadKey,
				activeOperationId: "existing-worker",
			},
		});
		expect(await observeLegacyImport(view.context, "owner", "receipt")).toEqual({
			kind: "unavailable",
		});
		expect(await prisma.arrImportOperation.count()).toBe(0);
		expect(
			await prisma.arrImportSourceClaim.findFirst({ where: { userId: "owner" } }),
		).toMatchObject({ activeOperationId: "existing-worker" });
	});
	it("retains one atomic observation when two callers race and supports cached retry", async () => {
		const view = await fixture();
		const results = await Promise.all([
			observeLegacyImport(view.context, "owner", "receipt"),
			observeLegacyImport(view.context, "owner", "receipt"),
		]);
		expect(results.some((result) => result.kind === "bound")).toBe(true);
		expect(await prisma.arrImportOperation.count()).toBe(1);
		expect(await prisma.arrImportFileProof.count()).toBe(2);
		expect((await observeLegacyImport(view.context, "owner", "receipt")).kind).toBe("bound");
		expect(view.posts).not.toHaveBeenCalled();
	});
});
