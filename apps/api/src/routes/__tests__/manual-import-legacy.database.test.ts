import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RadarrClient } from "arr-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { observeLegacyImport } from "../../lib/arr/import-operations/legacy-observation.js";
import { reconcileTrackedImport } from "../../lib/arr/import-operations/reconciliation.js";
import { importCommandFingerprint } from "../../lib/arr/manual-import-command.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import {
	importConnectionFingerprint,
	queueDownloadKey,
} from "../../lib/queue-cleaner/import-receipt.js";
import { registerManualImportRoutes } from "../manual-import.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;
let app: FastifyInstance;
const encryptor = new Encryptor(Buffer.alloc(32, 19).toString("base64"));
const factory = vi.fn();
beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "arr-import-legacy-route-"));
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
	app = Fastify({ logger: false });
	app.decorate("prisma", prisma);
	app.decorate("encryptor", encryptor);
	app.decorate("arrClientFactory", { create: factory } as never);
	setupAuthInjection(app, { id: "owner" });
	registerTestErrorHandler(app);
	await app.register(registerManualImportRoutes);
	await app.ready();
	factory.mockReset();
});
afterEach(async () => {
	await app?.close();
	vi.restoreAllMocks();
});
afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});
async function fixture(userId = "owner", source = "source") {
	const instance = await prisma.serviceInstance.create({
		data: {
			id: "instance",
			userId,
			service: "RADARR",
			label: "Synthetic private label",
			baseUrl: "https://fixture.invalid",
			encryptedApiKey: "synthetic-cipher",
			encryptionIv: "synthetic-iv",
		},
	});
	const now = new Date();
	const started = new Date(now.getTime() - 4_000);
	const file = { path: "/synthetic/private-path", downloadId: source, movieId: 12 };
	const receipt = await prisma.queueCleanerImportReceipt.create({
		data: {
			id: "receipt",
			instanceId: instance.id,
			downloadKey: queueDownloadKey(file)!,
			queueId: 7,
			downloadTitle: "Synthetic private title",
			connectionFingerprint: importConnectionFingerprint(instance),
			commandFingerprint: importCommandFingerprint([file])!,
			commandId: 51,
			state: "completed",
			lastAttemptAt: started,
		},
	});
	const client = new RadarrClient({ baseUrl: "https://fixture.invalid", apiKey: "synthetic-key" });
	const get = vi.spyOn(client, "get").mockImplementation(async (path, options) => {
		if (String(path).includes("/command/"))
			return {
				id: 51,
				name: "ManualImport",
				status: "completed",
				result: "successful",
				queued: new Date(started.getTime() + 1).toISOString(),
				ended: new Date(started.getTime() + 2_000).toISOString(),
				body: { importMode: "Move", files: [file] },
			} as never;
		const query = options as { page: number; pageSize: number };
		return {
			page: query.page,
			pageSize: query.pageSize,
			totalRecords: 1,
			records: [
				{
					eventType: "downloadFolderImported",
					downloadId: source,
					movieId: 12,
					date: new Date(started.getTime() + 1_000).toISOString(),
					data: { droppedPath: file.path, fileId: 31 },
				},
			],
		} as never;
	});
	const post = vi.spyOn(client, "post").mockRejectedValue(new Error("No POST"));
	const context = { prisma, encryptor, now: () => now, createClient: () => client };
	const query = () =>
		createInjectAuthenticated(app)(
			"GET",
			`/manual-import/legacy?instanceId=instance&service=radarr&downloadId=${encodeURIComponent(source)}`,
		);
	return { instance, receipt, context, get, post, query };
}
describe("cached-only owned legacy import route", () => {
	it.each([
		{ status: "started", state: "pending", reason: null },
		{ status: "unrecognized", state: "unknown", reason: "evidence-unavailable" },
	])(
		"returns factual counts for $state legacy work without replay permission or provider reads",
		async ({ status, state, reason }) => {
			const view = await fixture();
			const receipt = await prisma.queueCleanerImportReceipt.update({
				where: { id: "receipt" },
				data: { state: "pending" },
			});
			const provider = view.get.getMockImplementation()!;
			view.get.mockImplementationOnce(async (...args) => {
				const command = (await provider(...args)) as Record<string, unknown>;
				return { ...command, status, ended: undefined } as never;
			});
			expect((await observeLegacyImport(view.context, "owner", "receipt")).kind).toBe("bound");
			view.get.mockClear();
			const response = await view.query();
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				kind: "observed",
				operation: {
					state,
					reason,
					selectedFileCount: 1,
					verifiedFileCount: 0,
					canConsiderNewAttempt: false,
				},
			});
			expect(view.get).not.toHaveBeenCalled();
			expect(factory).not.toHaveBeenCalled();
			expect(view.post).not.toHaveBeenCalled();
			expect(await prisma.arrImportSourceClaim.count()).toBe(0);
			expect(
				await prisma.queueCleanerImportReceipt.findFirst({
					where: { id: "receipt", instance: { userId: "owner" } },
				}),
			).toEqual(receipt);
			expect(response.body).not.toMatch(
				/synthetic|fixture.invalid|commandId|downloadId|encrypted|private-path|private title/,
			);
		},
	);
	it("exposes unavailable rather than fabricated zero counts for an unadopted completed receipt", async () => {
		const view = await fixture();
		const response = await view.query();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ kind: "unavailable", reason: "evidence-unavailable" });
		expect(view.get).not.toHaveBeenCalled();
		expect(factory).not.toHaveBeenCalled();
		expect(await prisma.arrImportOperation.count()).toBe(0);
		expect(
			await prisma.queueCleanerImportReceipt.findFirst({
				where: { id: "receipt", instance: { userId: "owner" } },
			}),
		).toEqual(view.receipt);
	});
	it("returns adopted cached file counts, not aggregate legacy completion, with no provider reads", async () => {
		const view = await fixture();
		const bound = await observeLegacyImport(view.context, "owner", "receipt");
		expect(bound.kind).toBe("bound");
		view.get.mockClear();
		const response = await view.query();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			kind: "observed",
			operation: { state: "unknown", selectedFileCount: 1, verifiedFileCount: 0 },
		});
		expect(view.get).not.toHaveBeenCalled();
		expect(factory).not.toHaveBeenCalled();
		expect(response.body).not.toMatch(
			/synthetic|fixture.invalid|commandId|downloadId|encrypted|private-path|private title/,
		);
	});
	it("retains positively completed cached progress after permitted fixture connection removal", async () => {
		const view = await fixture();
		const bound = await observeLegacyImport(view.context, "owner", "receipt");
		if (bound.kind !== "bound") throw new Error("Expected bound operation");
		await reconcileTrackedImport(view.context, "owner", bound.operation.id);
		await prisma.serviceInstance.delete({ where: { id: "instance" } });
		view.get.mockClear();
		const response = await view.query();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			kind: "observed",
			operation: {
				operationId: bound.operation.id,
				state: "completed",
				selectedFileCount: 1,
				verifiedFileCount: 1,
			},
		});
		expect(view.get).not.toHaveBeenCalled();
		expect(view.post).not.toHaveBeenCalled();
	});
	it("does not expose foreign owner receipts or operations", async () => {
		const view = await fixture("other");
		expect((await view.query()).statusCode).toBe(404);
		expect((await observeLegacyImport(view.context, "other", "receipt")).kind).toBe("bound");
		expect((await view.query()).statusCode).toBe(404);
		expect(factory).not.toHaveBeenCalled();
	});
	it("normalizes torrent casing but preserves case-sensitive opaque sources", async () => {
		const view = await fixture("owner", "a".repeat(40));
		const upper = await createInjectAuthenticated(app)(
			"GET",
			`/manual-import/legacy?instanceId=instance&service=radarr&downloadId=${"A".repeat(40)}`,
		);
		expect(upper.statusCode).toBe(200);
		expect(upper.json().kind).toBe("unavailable");
		const other = await createInjectAuthenticated(app)(
			"GET",
			"/manual-import/legacy?instanceId=instance&service=radarr&downloadId=SOURCE",
		);
		expect(other.statusCode).toBe(200);
		expect(other.json()).toEqual({ kind: "none" });
		expect(view.get).not.toHaveBeenCalled();
	});
	it("does not borrow a matching source on another owned connection", async () => {
		const view = await fixture();
		await prisma.serviceInstance.create({
			data: {
				id: "alias",
				userId: "owner",
				service: "RADARR",
				label: "Alias",
				baseUrl: "https://fixture.invalid",
				encryptedApiKey: "synthetic-cipher",
				encryptionIv: "synthetic-iv",
			},
		});
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/manual-import/legacy?instanceId=alias&service=radarr&downloadId=source",
		);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ kind: "none" });
		expect(view.get).not.toHaveBeenCalled();
	});
	it.each([
		{ downloadId: "" },
		{ downloadId: " source" },
		{ downloadId: "x".repeat(1025) },
		{ service: "plex" },
		{ instanceId: "" },
		{ instanceId: "x".repeat(129) },
		{ userId: "other" },
	])("validates bounded status query %#", async (change) => {
		await fixture();
		const query = new URLSearchParams({
			instanceId: "instance",
			service: "radarr",
			downloadId: "source",
		});
		for (const [key, value] of Object.entries(change)) {
			if (value !== undefined) query.set(key, value);
		}
		expect(
			(await createInjectAuthenticated(app)("GET", `/manual-import/legacy?${query}`)).statusCode,
		).toBe(400);
		expect(factory).not.toHaveBeenCalled();
	});
	it("keeps disabled and retargeted unadopted receipts unavailable without provider access", async () => {
		const view = await fixture();
		await prisma.serviceInstance.update({
			where: { id: "instance" },
			data: { enabled: false, baseUrl: "https://other.invalid" },
		});
		const response = await view.query();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ kind: "unavailable", reason: "evidence-unavailable" });
		expect(view.get).not.toHaveBeenCalled();
		expect(factory).not.toHaveBeenCalled();
	});
	it("does not pick one of two historical legacy links after receipt removal", async () => {
		const view = await fixture();
		const bound = await observeLegacyImport(view.context, "owner", "receipt");
		if (bound.kind !== "bound") throw new Error("Expected bound operation");
		await prisma.serviceInstance.delete({ where: { id: "instance" } });
		const { files, id: _id, reconcileCursor: _cursor, ...operation } = bound.operation;
		await prisma.arrImportOperation.create({
			data: {
				...operation,
				instanceId: null,
				idempotencyKey: "another-historical-key",
				legacyReceiptId: "another-historical-receipt",
				files: {
					create: files.map((file) => ({
						downloadKey: file.downloadKey,
						fileFingerprint: file.fileFingerprint,
						identityJson: { movieId: 12, pathHash: "a".repeat(64) },
					})),
				},
			},
		});
		view.get.mockClear();
		const response = await view.query();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ kind: "unavailable", reason: "evidence-unavailable" });
		expect(view.get).not.toHaveBeenCalled();
		expect(factory).not.toHaveBeenCalled();
	});
	it("reports corrupted adopted counts as unavailable rather than publishing progress", async () => {
		const view = await fixture();
		const bound = await observeLegacyImport(view.context, "owner", "receipt");
		if (bound.kind !== "bound") throw new Error("Expected bound operation");
		await prisma.arrImportOperation.updateMany({
			where: { id: bound.operation.id, userId: "owner" },
			data: { verifiedFileCount: 1 },
		});
		view.get.mockClear();
		const response = await view.query();
		expect(response.statusCode).toBe(503);
		expect(response.body).not.toMatch(/synthetic|fixture.invalid|private/);
		expect(view.get).not.toHaveBeenCalled();
	});
});

async function trackedFixture(
	service: "SONARR" | "RADARR" | "LIDARR" | "READARR" = "RADARR",
	origin = "queue-cleaner",
) {
	const view = await fixture();
	await prisma.queueCleanerImportReceipt.delete({ where: { id: "receipt" } });
	await prisma.serviceInstance.update({ where: { id: "instance" }, data: { service } });
	const operation = await prisma.arrImportOperation.create({
		data: {
			id: "tracked-operation",
			userId: "owner",
			instanceId: "instance",
			originalInstanceId: "instance",
			service,
			origin,
			mode: "Move",
			idempotencyKey: "other-session-attempt",
			requestFingerprint: "a".repeat(64),
			commandFingerprint: "b".repeat(64),
			connectionFingerprint: "c".repeat(64),
			encryptedSources: "synthetic-cipher",
			sourcesEncryptionIv: "synthetic-iv",
			state: "pending",
			commandId: 51,
			commandState: "pending",
			selectedFileCount: 1,
			preparationExpiresAt: new Date(),
			submissionStartedAt: new Date(),
			files: {
				create: {
					downloadKey: queueDownloadKey({ downloadId: "source" })!,
					fileFingerprint: `v1:${"d".repeat(64)}`,
					identityJson: { pathHash: "e".repeat(64), movieId: 12 },
				},
			},
		},
		include: { files: true },
	});
	const claim = await prisma.arrImportSourceClaim.create({
		data: {
			userId: "owner",
			downloadKey: operation.files[0]!.downloadKey,
			activeOperationId: operation.id,
		},
	});
	const query = (instanceId = "instance", downloadId = "source") =>
		createInjectAuthenticated(app)(
			"GET",
			`/manual-import/source?instanceId=${instanceId}&service=${service.toLowerCase()}&downloadId=${downloadId}`,
		);
	return { ...view, operation, claim, query };
}

describe("cached source-scoped tracked recovery without a browser attempt key", () => {
	it("recovers durable progress with a fresh database client and route instance", async () => {
		await trackedFixture();
		const restartedPrisma = createTestPrismaClient(`file:${join(directory, "fixture.db")}`);
		const restartedApp = Fastify({ logger: false });
		restartedApp.decorate("prisma", restartedPrisma);
		restartedApp.decorate("arrClientFactory", { create: factory } as never);
		setupAuthInjection(restartedApp, { id: "owner" });
		registerTestErrorHandler(restartedApp);
		try {
			await restartedApp.register(registerManualImportRoutes);
			const response = await createInjectAuthenticated(restartedApp)(
				"GET",
				"/manual-import/source?instanceId=instance&service=radarr&downloadId=source",
			);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				kind: "observed",
				operation: { operationId: "tracked-operation", state: "pending", selectedFileCount: 1 },
			});
			expect(factory).not.toHaveBeenCalled();
		} finally {
			await restartedApp.close();
			await restartedPrisma.$disconnect();
		}
	});
	it.each(
		(["SONARR", "RADARR", "LIDARR", "READARR"] as const).flatMap((service) =>
			["manual", "queue-cleaner"].map((origin) => ({ service, origin })),
		),
	)(
		"observes $service $origin work and preserves every cached row without provider access",
		async ({ service, origin }) => {
			const view = await trackedFixture(service, origin);
			const response = await view.query();
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				kind: "observed",
				operation: {
					operationId: "tracked-operation",
					state: "pending",
					reason: null,
					selectedFileCount: 1,
					verifiedFileCount: 0,
					canConsiderNewAttempt: false,
				},
			});
			expect(
				await prisma.arrImportOperation.findFirst({
					where: { id: view.operation.id, userId: "owner" },
					include: { files: true },
				}),
			).toEqual(view.operation);
			expect(
				await prisma.arrImportSourceClaim.findFirst({
					where: { id: view.claim.id, userId: "owner" },
				}),
			).toEqual(view.claim);
			expect(factory).not.toHaveBeenCalled();
			expect(view.get).not.toHaveBeenCalled();
			expect(view.post).not.toHaveBeenCalled();
			expect(response.body).not.toMatch(
				/synthetic|private|cipher|downloadKey|fingerprint|idempotencyKey|commandId/,
			);
		},
	);
	it("selects an exact current claim rather than earlier historical completion", async () => {
		const view = await trackedFixture();
		const { files: _files, reconcileCursor: _cursor, ...historical } = view.operation;
		await prisma.arrImportOperation.create({
			data: {
				...historical,
				id: "historical",
				idempotencyKey: "historical-attempt",
				state: "completed",
				commandState: "completed",
				commandTerminal: true,
				verifiedFileCount: 1,
				files: {
					create: {
						downloadKey: view.claim.downloadKey,
						fileFingerprint: `v1:${"f".repeat(64)}`,
						identityJson: { pathHash: "e".repeat(64), movieId: 12 },
						verifiedAt: new Date(),
					},
				},
			},
		});
		const response = await view.query();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			kind: "observed",
			operation: { operationId: "tracked-operation", state: "pending", verifiedFileCount: 0 },
		});
		expect(await prisma.arrImportOperation.count({ where: { userId: "owner" } })).toBe(2);
	});
	it("keeps a unique terminal observation after its claim was released", async () => {
		const view = await trackedFixture();
		await prisma.arrImportSourceClaim.updateMany({
			where: { userId: "owner" },
			data: { activeOperationId: null },
		});
		await prisma.arrImportOperation.updateMany({
			where: { userId: "owner", id: view.operation.id },
			data: { commandTerminal: true, commandState: "failed", state: "failed" },
		});
		const response = await view.query();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			kind: "observed",
			operation: { state: "failed", verifiedFileCount: 0, canConsiderNewAttempt: true },
		});
		expect(view.get).not.toHaveBeenCalled();
	});
	it.each(["dangling", "foreign", "wrong-instance", "wrong-service", "wrong-source"])(
		"does not borrow a %s active operation or publish none",
		async (failure) => {
			const view = await trackedFixture();
			if (failure === "dangling")
				await prisma.arrImportSourceClaim.updateMany({
					where: { userId: "owner" },
					data: { activeOperationId: "missing" },
				});
			if (failure === "foreign")
				await prisma.arrImportOperation.updateMany({
					where: { userId: "owner" },
					data: { userId: "other" },
				});
			if (failure === "wrong-instance")
				await prisma.arrImportOperation.updateMany({
					where: { userId: "owner" },
					data: { originalInstanceId: "alias" },
				});
			if (failure === "wrong-service")
				await prisma.arrImportOperation.updateMany({
					where: { userId: "owner" },
					data: { service: "SONARR" },
				});
			if (failure === "wrong-source")
				await prisma.arrImportFileProof.updateMany({
					where: { operation: { userId: "owner" } },
					data: { downloadKey: "1".repeat(64) },
				});
			const response = await view.query();
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({ kind: "unavailable", reason: "evidence-unavailable" });
			expect(factory).not.toHaveBeenCalled();
			expect(view.get).not.toHaveBeenCalled();
		},
	);
	it("never chooses an arbitrary latest historical attempt without an active claim", async () => {
		const view = await trackedFixture();
		await prisma.arrImportSourceClaim.updateMany({
			where: { userId: "owner" },
			data: { activeOperationId: null },
		});
		const { files: _files, reconcileCursor: _cursor, ...operation } = view.operation;
		await prisma.arrImportOperation.create({
			data: {
				...operation,
				id: "another-operation",
				idempotencyKey: "another-attempt",
				files: {
					create: {
						downloadKey: view.claim.downloadKey,
						fileFingerprint: `v1:${"f".repeat(64)}`,
						identityJson: { pathHash: "e".repeat(64), movieId: 12 },
					},
				},
			},
		});
		expect((await view.query()).json()).toEqual({
			kind: "history",
			operations: ["another-operation", "tracked-operation"].map((operationId) => ({
				operationId,
				state: "pending",
				reason: null,
				selectedFileCount: 1,
				verifiedFileCount: 0,
				canConsiderNewAttempt: false,
			})),
			nextCursor: null,
		});
		expect(await prisma.arrImportOperation.count({ where: { userId: "owner" } })).toBe(2);
	});
	it("pages all distinct cached attempts and preserves claims, proofs and provider isolation", async () => {
		const view = await trackedFixture();
		await prisma.arrImportSourceClaim.updateMany({
			where: { userId: "owner" },
			data: { activeOperationId: null },
		});
		const { files: _files, reconcileCursor: _cursor, ...operation } = view.operation;
		for (let i = 0; i < 41; i++)
			await prisma.arrImportOperation.create({
				data: {
					...operation,
					id: `history-${String(i).padStart(3, "0")}`,
					idempotencyKey: `history-key-${i}`,
					files: {
						create: {
							downloadKey: view.claim.downloadKey,
							fileFingerprint: `v1:${"f".repeat(64)}`,
							identityJson: { movieId: 12, pathHash: "e".repeat(64) },
						},
					},
				},
			});
		const before = await prisma.arrImportOperation.findMany({
			where: { userId: "owner" },
			orderBy: { id: "asc" },
			include: { files: true },
		});
		const ids: string[] = [];
		let cursor: string | null = null;
		const sizes: number[] = [];
		do {
			const response = await createInjectAuthenticated(app)(
				"GET",
				`/manual-import/source?instanceId=instance&service=radarr&downloadId=source${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
			);
			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body.kind).toBe("history");
			sizes.push(body.operations.length);
			ids.push(...body.operations.map((row: { operationId: string }) => row.operationId));
			cursor = body.nextCursor;
			expect(response.body).not.toMatch(
				/synthetic|cipher|downloadKey|fingerprint|idempotencyKey|commandId|private/,
			);
		} while (cursor);
		expect(sizes).toEqual([20, 20, 2]);
		expect(ids).toEqual(before.map((row) => row.id));
		const end = await createInjectAuthenticated(app)(
			"GET",
			"/manual-import/source?instanceId=instance&service=radarr&downloadId=source&cursor=tracked-operation",
		);
		expect(end.json()).toEqual({ kind: "history", operations: [], nextCursor: null });
		expect(
			await prisma.arrImportOperation.findMany({
				where: { userId: "owner" },
				orderBy: { id: "asc" },
				include: { files: true },
			}),
		).toEqual(before);
		expect(factory).not.toHaveBeenCalled();
		expect(view.get).not.toHaveBeenCalled();
		expect(view.post).not.toHaveBeenCalled();
	});
	it.each(["missing", "foreign", "wrong-instance", "wrong-service", "wrong-source"])(
		"refuses a %s history cursor without publishing absence",
		async (failure) => {
			const view = await trackedFixture();
			await prisma.arrImportSourceClaim.updateMany({
				where: { userId: "owner" },
				data: { activeOperationId: null },
			});
			if (failure === "foreign")
				await prisma.arrImportOperation.updateMany({
					where: { id: view.operation.id, userId: "owner" },
					data: { userId: "other" },
				});
			if (failure === "wrong-instance")
				await prisma.arrImportOperation.updateMany({
					where: { id: view.operation.id, userId: "owner" },
					data: { originalInstanceId: "alias" },
				});
			if (failure === "wrong-service")
				await prisma.arrImportOperation.updateMany({
					where: { id: view.operation.id, userId: "owner" },
					data: { service: "SONARR" },
				});
			if (failure === "wrong-source")
				await prisma.arrImportFileProof.updateMany({
					where: { operation: { userId: "owner" } },
					data: { downloadKey: "1".repeat(64) },
				});
			const response = await createInjectAuthenticated(app)(
				"GET",
				`/manual-import/source?instanceId=instance&service=radarr&downloadId=source&cursor=${failure === "missing" ? "missing" : "tracked-operation"}`,
			);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({ kind: "unavailable", reason: "evidence-unavailable" });
			expect(factory).not.toHaveBeenCalled();
		},
	);
	it("prioritizes an exact active claim when inspecting a historical page", async () => {
		const view = await trackedFixture();
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/manual-import/source?instanceId=instance&service=radarr&downloadId=source&cursor=missing",
		);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			kind: "observed",
			operation: { operationId: view.operation.id },
		});
	});
	it("falls back to recorded legacy evidence without performing adoption", async () => {
		const view = await fixture();
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/manual-import/source?instanceId=instance&service=radarr&downloadId=source",
		);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ kind: "unavailable", reason: "evidence-unavailable" });
		expect(await prisma.arrImportOperation.count()).toBe(0);
		expect(view.get).not.toHaveBeenCalled();
	});
	it("does not expose another owner's recorded source", async () => {
		await fixture("other");
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/manual-import/source?instanceId=instance&service=radarr&downloadId=source",
		);
		expect(response.statusCode).toBe(404);
		expect(response.body).not.toMatch(/other|synthetic|private/);
	});
	it("does not transfer an active shared-source claim to an owned alias", async () => {
		const view = await trackedFixture();
		await prisma.serviceInstance.create({
			data: {
				id: "alias",
				userId: "owner",
				service: "RADARR",
				label: "Private alias",
				baseUrl: "https://fixture.invalid",
				encryptedApiKey: "synthetic-cipher",
				encryptionIv: "synthetic-iv",
			},
		});
		expect((await view.query("alias")).json()).toEqual({
			kind: "unavailable",
			reason: "evidence-unavailable",
		});
		expect(view.get).not.toHaveBeenCalled();
	});
	it("returns the same missing-resource status for a foreign connection despite an owned source claim", async () => {
		const view = await trackedFixture();
		await prisma.serviceInstance.create({
			data: {
				id: "foreign-instance",
				userId: "other",
				service: "RADARR",
				label: "Private foreign",
				baseUrl: "https://fixture.invalid",
				encryptedApiKey: "synthetic-cipher",
				encryptionIv: "synthetic-iv",
			},
		});
		const foreign = await view.query("foreign-instance");
		const absent = await view.query("absent-instance");
		expect(foreign.statusCode).toBe(404);
		expect(absent.statusCode).toBe(404);
		expect(foreign.json()).toEqual(absent.json());
	});
	it("does not treat another owner's source claim as this owner's work", async () => {
		const view = await trackedFixture();
		await prisma.arrImportSourceClaim.deleteMany({ where: { userId: "owner" } });
		await prisma.arrImportOperation.deleteMany({ where: { userId: "owner" } });
		await prisma.arrImportSourceClaim.create({
			data: { userId: "other", downloadKey: view.claim.downloadKey, activeOperationId: "foreign" },
		});
		expect((await view.query()).json()).toEqual({ kind: "none" });
	});
	it("retains whole-batch counts when the selected batch covers multiple downloads", async () => {
		const view = await trackedFixture();
		await prisma.arrImportFileProof.create({
			data: {
				operationId: view.operation.id,
				downloadKey: "1".repeat(64),
				fileFingerprint: `v1:${"f".repeat(64)}`,
				identityJson: { movieId: 13, pathHash: "e".repeat(64) },
			},
		});
		await prisma.arrImportOperation.updateMany({
			where: { id: view.operation.id, userId: "owner" },
			data: { selectedFileCount: 2 },
		});
		expect((await view.query()).json()).toMatchObject({
			kind: "observed",
			operation: { selectedFileCount: 2, verifiedFileCount: 0 },
		});
	});
	it("contains unknown operation states without permitting reconsideration", async () => {
		const view = await trackedFixture();
		await prisma.arrImportOperation.updateMany({
			where: { id: view.operation.id, userId: "owner" },
			data: { state: "future-private-state", reason: "private-details" },
		});
		expect((await view.query()).json()).toMatchObject({
			kind: "observed",
			operation: {
				state: "unknown",
				reason: "evidence-unavailable",
				selectedFileCount: 1,
				canConsiderNewAttempt: false,
			},
		});
	});
	it("rejects corrupted proof counts instead of manufacturing progress", async () => {
		const view = await trackedFixture();
		await prisma.arrImportOperation.updateMany({
			where: { id: view.operation.id, userId: "owner" },
			data: { verifiedFileCount: 1 },
		});
		const response = await view.query();
		expect(response.statusCode).toBe(503);
		expect(response.body).not.toMatch(/synthetic|private|cipher/);
	});
	it("retains cached completed history after permitted fixture connection removal", async () => {
		const view = await trackedFixture();
		await prisma.arrImportSourceClaim.updateMany({
			where: { userId: "owner" },
			data: { activeOperationId: null },
		});
		await prisma.arrImportOperation.updateMany({
			where: { id: view.operation.id, userId: "owner" },
			data: {
				state: "completed",
				commandState: "completed",
				commandTerminal: true,
				verifiedFileCount: 1,
			},
		});
		await prisma.arrImportFileProof.updateMany({
			where: { operation: { userId: "owner" } },
			data: { verifiedAt: new Date() },
		});
		await prisma.serviceInstance.delete({ where: { id: "instance" } });
		expect((await view.query()).json()).toMatchObject({
			kind: "observed",
			operation: { state: "completed", verifiedFileCount: 1 },
		});
		expect(view.get).not.toHaveBeenCalled();
	});
	it.each(["", " source", "x".repeat(1025)])(
		"rejects an invalid source query %#",
		async (downloadId) => {
			await trackedFixture();
			const response = await createInjectAuthenticated(app)(
				"GET",
				`/manual-import/source?instanceId=instance&service=radarr&downloadId=${encodeURIComponent(downloadId)}`,
			);
			expect(response.statusCode).toBe(400);
			expect(factory).not.toHaveBeenCalled();
		},
	);
});
