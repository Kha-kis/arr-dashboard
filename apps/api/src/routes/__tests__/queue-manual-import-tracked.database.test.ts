import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manualImportOperationStatusSchema } from "@arr/shared";
import { LidarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { ArrClientFactory } from "../../lib/arr/client-factory.js";
import { withImportConnectionWriteGuard } from "../../lib/arr/import-operations/connection-guards.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import {
	acquireQueueSourceAction,
	queueDownloadKey,
} from "../../lib/queue-cleaner/import-receipt.js";
import { queueRoutes } from "../dashboard/queue-routes.js";
import { registerManualImportRoutes } from "../manual-import.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;
let app: FastifyInstance;
let principal: { id: string };
const encryptor = new Encryptor(Buffer.alloc(32, 9).toString("base64"));
const services = [
	{
		service: "sonarr",
		Client: SonarrClient,
		media: { seriesId: 12, episodeId: 13 },
		candidate: { series: { id: 12 }, episodes: [{ id: 13 }] },
	},
	{
		service: "radarr",
		Client: RadarrClient,
		media: { movieId: 12 },
		candidate: { movie: { id: 12 } },
	},
	{
		service: "lidarr",
		Client: LidarrClient,
		media: { artistId: 12, albumId: 13 },
		candidate: { artist: { id: 12 }, album: { id: 13 }, albumReleaseId: 14, tracks: [{ id: 15 }] },
	},
	{
		service: "readarr",
		Client: ReadarrClient,
		media: { authorId: 12, bookId: 13 },
		candidate: { author: { id: 12 }, book: { id: 13 }, foreignEditionId: "edition-1" },
	},
] as const;
beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "arr-queue-import-route-"));
	const databaseUrl = `file:${join(directory, "fixture.db")}`;
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: databaseUrl },
		stdio: "pipe",
	});
	prisma = createTestPrismaClient(databaseUrl);
}, 30_000);
beforeEach(async () => {
	await prisma.user.deleteMany();
	await prisma.user.createMany({
		data: [
			{ id: "owner", username: "synthetic-owner" },
			{ id: "other", username: "synthetic-other" },
		],
	});
	app = Fastify({ logger: false });
	app.decorate("prisma", prisma);
	app.decorate("encryptor", encryptor);
	app.decorate("arrClientFactory", new ArrClientFactory(encryptor));
	principal = { id: "owner" };
	setupAuthInjection(app, principal);
	registerTestErrorHandler(app);
	await app.register(queueRoutes);
	await app.register(registerManualImportRoutes);
	await app.ready();
});
afterEach(async () => {
	await app?.close();
	vi.restoreAllMocks();
});
afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

async function fixture(service: (typeof services)[number] = services[1]) {
	const encrypted = encryptor.encrypt("synthetic-api-key");
	const instance = await prisma.serviceInstance.create({
		data: {
			id: "instance",
			userId: "owner",
			service: service.service.toUpperCase() as "SONARR" | "RADARR" | "LIDARR" | "READARR",
			label: "Synthetic",
			baseUrl: "https://fixture.invalid",
			encryptedApiKey: encrypted.value,
			encryptionIv: encrypted.iv,
		},
	});
	const client = new service.Client({
		baseUrl: "https://fixture.invalid",
		apiKey: "synthetic-api-key",
	});
	const candidate = {
		id: 1,
		path: "/synthetic/file",
		downloadId: "source",
		quality: { quality: { id: 1 } },
		...service.candidate,
	};
	const reads = vi.fn().mockResolvedValue([candidate]);
	if (client instanceof SonarrClient || client instanceof RadarrClient)
		vi.spyOn(client.manualImport, "get").mockImplementation(reads);
	else vi.spyOn(client, "get").mockImplementation(reads);
	const item = {
		id: 7,
		downloadId: "source",
		protocol: "usenet",
		trackedDownloadState: "importPending",
		...service.media,
	};
	const queueReads = vi.fn().mockResolvedValue(item);
	if (client instanceof LidarrClient) {
		vi.spyOn(client.queue, "get").mockImplementation(
			async () =>
				({ page: 1, pageSize: 1000, totalRecords: 1, records: [await queueReads()] }) as never,
		);
	} else vi.spyOn(client.queue, "getById").mockImplementation(queueReads);
	const posts = vi
		.spyOn(client, "post")
		.mockImplementation(
			async (_path, body) => ({ id: 51, name: "ManualImport", status: "queued", body }) as never,
		);
	const deletes = vi.spyOn(client.queue, "delete").mockResolvedValue(undefined as never);
	const factory = vi.spyOn(app.arrClientFactory, "create").mockReturnValue(client);
	const body = {
		instanceId: "instance",
		service: service.service,
		itemId: 7,
		action: "manualImport",
		downloadId: "source",
	};
	const inject = createInjectAuthenticated(app);
	const submit = (payload: unknown = body) =>
		inject("POST", "/dashboard/queue/action", { body: payload });
	return {
		instance,
		body,
		item,
		candidate,
		reads,
		queueReads,
		posts,
		deletes,
		factory,
		submit,
		inject,
	};
}

describe("Queue Manual Import durable producer", () => {
	it.each(["7garbage", "7.5", 0, -1, 7.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid queue identifier %j without reading or submitting",
		async (itemId) => {
			const f = await fixture();
			expect((await f.submit({ ...f.body, itemId })).statusCode).toBe(400);
			expect(f.factory).not.toHaveBeenCalled();
			expect(f.posts).not.toHaveBeenCalled();
		},
	);
	it.each(services)(
		"$service persists pending file proof and repeats only observe",
		async (service) => {
			const f = await fixture(service);
			const first = await f.submit();
			expect(first.statusCode).toBe(202);
			const status = manualImportOperationStatusSchema.parse(first.json());
			expect(status).toMatchObject({
				state: "pending",
				selectedFileCount: 1,
				verifiedFileCount: 0,
				canConsiderNewAttempt: false,
			});
			const operation = await prisma.arrImportOperation.findFirstOrThrow({
				where: { userId: "owner" },
				include: { files: true },
			});
			expect(operation.files).toHaveLength(1);
			expect(operation.origin).toBe("manual");
			expect(
				await prisma.arrImportSourceClaim.count({
					where: { userId: "owner", activeOperationId: operation.id },
				}),
			).toBe(1);
			f.factory.mockClear();
			f.reads.mockClear();
			f.queueReads.mockClear();
			expect((await f.submit()).json()).toEqual(status);
			expect(f.factory).not.toHaveBeenCalled();
			expect(f.reads).not.toHaveBeenCalled();
			expect(f.queueReads).not.toHaveBeenCalled();
			expect(f.posts).toHaveBeenCalledTimes(1);
			expect(f.deletes).not.toHaveBeenCalled();
			expect(first.body).not.toMatch(
				/synthetic\/file|synthetic-api-key|fixture.invalid|encryptedSources|downloadId/,
			);
			expect(
				(await f.inject("GET", `/manual-import/operations/${status.operationId}`)).json(),
			).toEqual(status);
		},
	);
	it("does not replay after a lost acknowledgement", async () => {
		const f = await fixture();
		f.posts.mockRejectedValue(new Error("synthetic-private-provider-error"));
		const first = await f.submit();
		expect(first.statusCode).toBe(202);
		expect(first.json()).toMatchObject({ state: "unknown", verifiedFileCount: 0 });
		expect((await f.submit()).json()).toEqual(first.json());
		expect(f.posts).toHaveBeenCalledTimes(1);
		expect(first.body).not.toContain("synthetic-private-provider-error");
	});
	it("a replaced queue ID still observes the same original source attempt", async () => {
		const f = await fixture();
		const first = await f.submit();
		expect(first.statusCode).toBe(202);
		f.factory.mockClear();
		expect((await f.submit({ ...f.body, itemId: 99 })).json()).toEqual(first.json());
		expect(f.factory).not.toHaveBeenCalled();
		expect(f.posts).toHaveBeenCalledTimes(1);
	});
	it("canonical torrent casing cannot mint another attempt", async () => {
		const f = await fixture();
		const source = "a".repeat(40);
		f.reads.mockResolvedValue([{ ...f.candidate, downloadId: source }]);
		f.queueReads.mockResolvedValue({ ...f.item, downloadId: source });
		const first = await f.submit({ ...f.body, downloadId: source });
		expect(first.statusCode).toBe(202);
		expect((await f.submit({ ...f.body, downloadId: source.toUpperCase() })).json()).toEqual(
			first.json(),
		);
		expect(f.posts).toHaveBeenCalledTimes(1);
	});
	it("another owner cannot recover or submit through an owned attempt", async () => {
		const f = await fixture();
		const first = await f.submit();
		expect(first.statusCode).toBe(202);
		principal.id = "other";
		f.factory.mockClear();
		expect((await f.submit()).statusCode).toBe(409);
		expect(
			(await f.inject("GET", `/manual-import/operations/${first.json().operationId}`)).statusCode,
		).toBe(404);
		expect(f.factory).not.toHaveBeenCalled();
		expect(f.posts).toHaveBeenCalledTimes(1);
		expect(await prisma.arrImportOperation.count({ where: { userId: "other" } })).toBe(0);
	});
	it("a new server instance recovers the cached operation without provider reads", async () => {
		const f = await fixture();
		const first = await f.submit();
		expect(first.statusCode).toBe(202);
		await app.close();
		app = Fastify({ logger: false });
		app.decorate("prisma", prisma);
		app.decorate("encryptor", encryptor);
		app.decorate("arrClientFactory", new ArrClientFactory(encryptor));
		setupAuthInjection(app, { id: "owner" });
		registerTestErrorHandler(app);
		await app.register(queueRoutes);
		await app.ready();
		const factory = vi.spyOn(app.arrClientFactory, "create");
		const response = await createInjectAuthenticated(app)("POST", "/dashboard/queue/action", {
			body: f.body,
		});
		expect(response.statusCode).toBe(202);
		expect(response.json()).toEqual(first.json());
		expect(factory).not.toHaveBeenCalled();
		expect(f.posts).toHaveBeenCalledTimes(1);
	});
	it.each([false, true])(
		"legacy protection inserted during preparation=%s blocks submission",
		async (duringPreparation) => {
			const f = await fixture();
			const protect = () =>
				prisma.queueCleanerImportReceipt.create({
					data: {
						instanceId: "instance",
						downloadKey: queueDownloadKey(f.item)!,
						queueId: 7,
						downloadTitle: "Synthetic",
						connectionFingerprint: "a".repeat(64),
						commandFingerprint: `v1:${"b".repeat(64)}`,
						state: "unknown",
						lastAttemptAt: new Date(),
					},
				});
			if (!duringPreparation) await protect();
			else
				f.queueReads.mockImplementation(async () => {
					if (
						await prisma.arrImportOperation.count({
							where: { userId: "owner", state: "preparing" },
						})
					)
						await protect();
					return f.item;
				});
			expect((await f.submit()).statusCode).toBe(409);
			expect(f.posts).not.toHaveBeenCalled();
		},
	);
	it.each(["completed", "failed"])(
		"aggregate %s is not per-file success or permission to replay",
		async (state) => {
			const f = await fixture();
			f.posts.mockImplementation(
				async (_path, body) => ({ id: 51, name: "ManualImport", status: state, body }) as never,
			);
			const first = await f.submit();
			expect(first.statusCode).toBe(202);
			expect(first.json()).toMatchObject({
				state: state === "failed" ? "failed" : "unknown",
				verifiedFileCount: 0,
			});
			expect((await f.submit()).json()).toEqual(first.json());
			expect(f.posts).toHaveBeenCalledTimes(1);
		},
	);
	it.each([{ downloadId: "other-source" }, { id: 8 }, { movieId: 99 }, { movieId: undefined }])(
		"rejects changed or missing current queue identity %j",
		async (change) => {
			const f = await fixture();
			f.queueReads.mockResolvedValue({ ...f.item, ...change });
			expect((await f.submit()).statusCode).toBe(409);
			expect(f.posts).not.toHaveBeenCalled();
			expect(await prisma.arrImportOperation.count({ where: { userId: "owner" } })).toBe(0);
		},
	);
	it("rechecks queue media immediately before submission", async () => {
		const f = await fixture();
		f.queueReads.mockResolvedValueOnce(f.item).mockResolvedValue({ ...f.item, movieId: 99 });
		expect((await f.submit()).statusCode).toBe(409);
		expect(f.posts).not.toHaveBeenCalled();
		expect(await prisma.arrImportOperation.findFirst({ where: { userId: "owner" } })).toMatchObject(
			{ state: "not-submitted", submissionStartedAt: null },
		);
	});
	it.each([
		{ movie: { id: 99 } },
		{ downloadId: "other-source" },
		{ rejections: [{ reason: "synthetic-private-rejection" }] },
	])("rejects incomplete eligible selection %j", async (change) => {
		const f = await fixture();
		f.reads.mockResolvedValue([
			f.candidate,
			{ ...f.candidate, id: 2, path: "/synthetic/second", ...change },
		]);
		const response = await f.submit();
		expect(response.statusCode).toBe(409);
		expect(f.posts).not.toHaveBeenCalled();
		expect(response.body).not.toMatch(/synthetic\/second|synthetic-private-rejection/);
	});
	it("rejects a rejection appearing during shared revalidation", async () => {
		const f = await fixture();
		f.reads
			.mockResolvedValueOnce([f.candidate])
			.mockResolvedValue([{ ...f.candidate, rejections: [{ reason: "new-rejection" }] }]);
		expect((await f.submit()).statusCode).toBe(409);
		expect(f.posts).not.toHaveBeenCalled();
	});
	it.each(["foreign", "disabled", "mismatched"])(
		"rejects %s connection without constructing a client",
		async (kind) => {
			const f = await fixture();
			await prisma.serviceInstance.update({
				where: { id: "instance", userId: "owner" },
				data:
					kind === "foreign"
						? { userId: "other" }
						: kind === "disabled"
							? { enabled: false }
							: { service: "SONARR" },
			});
			expect((await f.submit()).statusCode).toBe(409);
			expect(f.factory).not.toHaveBeenCalled();
			expect(f.posts).not.toHaveBeenCalled();
		},
	);
	it("retains cached history after a connection is removed", async () => {
		const f = await fixture();
		const first = await f.submit();
		expect(first.statusCode).toBe(202);
		await prisma.serviceInstance.delete({ where: { id: "instance", userId: "owner" } });
		f.factory.mockClear();
		expect((await f.submit()).json()).toEqual(first.json());
		expect(f.factory).not.toHaveBeenCalled();
		expect(f.posts).toHaveBeenCalledTimes(1);
	});
	it("same-owner aliases cannot overlap the protected source", async () => {
		const f = await fixture();
		await f.submit();
		await prisma.serviceInstance.create({ data: { ...f.instance, id: "alias" } });
		expect((await f.submit({ ...f.body, instanceId: "alias" })).statusCode).toBe(409);
		expect(f.posts).toHaveBeenCalledTimes(1);
	});
	it("an existing source action prevents preparation", async () => {
		const f = await fixture();
		const release = acquireQueueSourceAction("owner", f.item);
		expect(release).not.toBeNull();
		try {
			expect((await f.submit()).statusCode).toBe(409);
			expect(f.reads).not.toHaveBeenCalled();
			expect(f.posts).not.toHaveBeenCalled();
		} finally {
			release?.();
		}
	});
	it("a held POST preserves source and connection ownership while retries observe", async () => {
		const f = await fixture();
		const settlements: Array<(value: never) => void> = [];
		f.posts.mockImplementation(
			() =>
				new Promise((resolve) => {
					settlements.push(resolve);
				}),
		);
		const submitting = f.submit();
		let observing: ReturnType<typeof f.submit> | undefined;
		try {
			await vi.waitFor(() => expect(f.posts).toHaveBeenCalledTimes(1));
			observing = f.submit();
			const response = await Promise.race([
				observing,
				new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 250)),
			]);
			expect(response?.statusCode).toBe(202);
			expect(response?.json()).toMatchObject({ state: "submitting", verifiedFileCount: 0 });
			expect(acquireQueueSourceAction("owner", f.item)).toBeNull();
			await expect(
				withImportConnectionWriteGuard("owner", "instance", async () => true),
			).rejects.toMatchObject({ statusCode: 409 });
		} finally {
			for (const settle of settlements)
				settle({
					id: 51,
					name: "ManualImport",
					status: "queued",
					body: f.posts.mock.calls[0]?.[1],
				} as never);
			await submitting;
			await observing;
		}
	});
	it("does not submit an oversized source", async () => {
		const f = await fixture();
		f.reads.mockResolvedValue(
			Array.from({ length: 1001 }, (_, index) => ({
				...f.candidate,
				id: index + 1,
				path: `/synthetic/${index}`,
			})),
		);
		expect((await f.submit()).statusCode).toBe(413);
		expect(f.posts).not.toHaveBeenCalled();
	});
	it.each(["retry", "delete"])("%s keeps the established 204/deletion contract", async (action) => {
		const f = await fixture();
		expect((await f.submit({ ...f.body, action })).statusCode).toBe(204);
		expect(f.deletes).toHaveBeenCalledWith(7, {
			removeFromClient: true,
			blocklist: false,
			changeCategory: false,
		});
		expect(f.posts).not.toHaveBeenCalled();
		expect(await prisma.arrImportOperation.count({ where: { userId: "owner" } })).toBe(0);
	});
});
