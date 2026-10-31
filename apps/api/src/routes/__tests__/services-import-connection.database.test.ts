import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RadarrClient } from "arr-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { ArrClientFactory } from "../../lib/arr/client-factory.js";
import { withImportConnectionWriteGuard } from "../../lib/arr/import-operations/connection-guards.js";
import {
	readOwnedImportAttempt,
	recordImportCommandObservation,
	recordVerifiedImportFiles,
} from "../../lib/arr/import-operations/repository.js";
import {
	submitTrackedImport,
	type TrackedImportInput,
} from "../../lib/arr/import-operations/submission.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import { registerServiceRoutes } from "../services.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;
let app: FastifyInstance;
const encryptor = new Encryptor(Buffer.alloc(32, 8).toString("base64"));

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "arr-import-connection-"));
	const databasePath = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "pipe",
	});
	prisma = createTestPrismaClient(`file:${databasePath}`);
}, 30_000);
beforeEach(async () => {
	await prisma.user.deleteMany();
	await prisma.user.createMany({
		data: [
			{ id: "owner", username: "synthetic-owner" },
			{ id: "other", username: "synthetic-other" },
		],
	});
	const encrypted = encryptor.encrypt("synthetic-api-key");
	await prisma.serviceInstance.createMany({
		data: ["owner", "other"].map((userId) => ({
			id: userId === "owner" ? "instance" : "other-instance",
			userId,
			service: "RADARR" as const,
			label: "Synthetic",
			baseUrl: "https://fixture.invalid",
			encryptedApiKey: encrypted.value,
			encryptionIv: encrypted.iv,
		})),
	});
	app = Fastify({ logger: false });
	app.decorate("prisma", prisma);
	app.decorate("encryptor", encryptor);
	app.decorate("arrClientFactory", new ArrClientFactory(encryptor));
	setupAuthInjection(app, { id: "owner" });
	registerTestErrorHandler(app);
	await app.register(registerServiceRoutes);
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

async function startImport(hold?: () => Promise<void>) {
	const client = new RadarrClient({
		baseUrl: "https://fixture.invalid",
		apiKey: "synthetic-api-key",
	});
	vi.spyOn(client.manualImport, "get").mockResolvedValue([
		{
			id: 1,
			path: "/synthetic/file",
			downloadId: "source",
			movie: { id: 12 },
			quality: { quality: { id: 1 } },
		},
	] as never);
	vi.spyOn(client, "post").mockImplementation(async (_path, body) => {
		await hold?.();
		return { id: 51, name: "ManualImport", status: "queued", body } as never;
	});
	const input: TrackedImportInput = {
		userId: "owner",
		instanceId: "instance",
		service: "radarr",
		origin: "manual",
		idempotencyKey: "intentional-attempt",
		importMode: "auto",
		files: [{ path: "/synthetic/file", downloadId: "source", movieId: 12 }],
	};
	return submitTrackedImport({ prisma, encryptor, createClient: () => client }, input);
}

const connectionEdits = [
	{ field: "URL", body: { baseUrl: "https://replacement.invalid" } },
	{ field: "API key", body: { apiKey: "replacement-api-key" } },
	{ field: "HTTP auth", body: { httpAuth: { username: "synthetic", password: "synthetic" } } },
	{ field: "service", body: { service: "sonarr" } },
	{ field: "enabled", body: { enabled: false } },
];

describe("actual service connection writes versus durable imports", () => {
	it("refuses connection deletion after acknowledgement and retains the import record", async () => {
		const operation = await startImport();
		const response = await createInjectAuthenticated(app)("DELETE", "/services/instance");
		expect(response.statusCode).toBe(409);
		expect(await readOwnedImportAttempt(prisma, "owner", operation.id)).toEqual(operation);
		expect(await prisma.serviceInstance.count({ where: { id: "instance", userId: "owner" } })).toBe(
			1,
		);
	});
	it("refuses deletion while the actual import POST is still settling", async () => {
		let announce!: () => void;
		let settle!: () => void;
		const started = new Promise<void>((resolve) => {
			announce = resolve;
		});
		const settlement = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const work = startImport(async () => {
			announce();
			await settlement;
		});
		await started;
		try {
			const response = await createInjectAuthenticated(app)("DELETE", "/services/instance");
			expect(response.statusCode).toBe(409);
			expect(
				await prisma.serviceInstance.count({ where: { id: "instance", userId: "owner" } }),
			).toBe(1);
		} finally {
			settle();
			await work;
		}
	});
	it("refuses provider work if connection editing acquired authority first", async () => {
		await withImportConnectionWriteGuard("owner", "instance", async () => {
			await expect(startImport()).rejects.toMatchObject({ statusCode: 409 });
			expect(await prisma.arrImportOperation.count({ where: { userId: "owner" } })).toBe(0);
		});
	});
	it.each(connectionEdits)(
		"refuses a $field change after import acknowledgement",
		async ({ body }) => {
			await startImport();
			const before = await prisma.serviceInstance.findFirstOrThrow({
				where: { id: "instance", userId: "owner" },
			});
			const response = await createInjectAuthenticated(app)("PUT", "/services/instance", { body });
			expect(response.statusCode).toBe(409);
			expect(
				await prisma.serviceInstance.findFirstOrThrow({
					where: { id: "instance", userId: "owner" },
				}),
			).toEqual(before);
			expect(
				await prisma.arrImportOperation.count({ where: { userId: "owner", state: "pending" } }),
			).toBe(1);
		},
	);
	it("blocks a changed connection while the actual import POST is unsettled", async () => {
		let announce!: () => void;
		let settle!: () => void;
		const started = new Promise<void>((resolve) => {
			announce = resolve;
		});
		const settlement = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const work = startImport(async () => {
			announce();
			await settlement;
		});
		await started;
		try {
			const response = await createInjectAuthenticated(app)("PUT", "/services/instance", {
				body: { baseUrl: "https://replacement.invalid" },
			});
			expect(response.statusCode).toBe(409);
		} finally {
			settle();
			await work;
		}
	});
	it("does not freeze non-authority presentation edits", async () => {
		await startImport();
		const response = await createInjectAuthenticated(app)("PUT", "/services/instance", {
			body: { label: "Updated synthetic label", tags: ["synthetic"] },
		});
		expect(response.statusCode).toBe(200);
		expect(
			await prisma.arrImportOperation.count({ where: { userId: "owner", state: "pending" } }),
		).toBe(1);
	});
	it("preserves completed positive evidence when credentials are legitimately replaced", async () => {
		const operation = await startImport();
		expect(
			await recordImportCommandObservation(prisma, "owner", operation.id, {
				expectedRevision: operation.revision,
				connectionFingerprint: operation.connectionFingerprint,
				commandFingerprint: operation.commandFingerprint,
				commandId: 51,
				state: "completed",
				terminal: true,
				checkedAt: new Date(),
			}),
		).toBe(true);
		const observed = await readOwnedImportAttempt(prisma, "owner", operation.id);
		if (!observed) throw new Error("Missing synthetic attempt");
		expect(
			await recordVerifiedImportFiles(prisma, "owner", operation.id, {
				expectedRevision: observed.revision,
				connectionFingerprint: operation.connectionFingerprint,
				commandFingerprint: operation.commandFingerprint,
				commandId: 51,
				fileFingerprints: observed.files.map((file) => file.fileFingerprint),
				verifiedAt: new Date(),
			}),
		).toBe(true);
		const historical = await readOwnedImportAttempt(prisma, "owner", operation.id);
		expect(historical).toMatchObject({ state: "completed", verifiedFileCount: 1 });
		const response = await createInjectAuthenticated(app)("PUT", "/services/instance", {
			body: { apiKey: "replacement-api-key" },
		});
		expect(response.statusCode).toBe(200);
		expect(await readOwnedImportAttempt(prisma, "owner", operation.id)).toEqual(historical);
	});
	it.each([
		{ state: "unknown", commandState: "unknown", commandTerminal: false, commandId: null },
		{ state: "completed", commandState: "pending", commandTerminal: false, commandId: 51 },
		{ state: "not-submitted", commandState: "pending", commandTerminal: false, commandId: 51 },
		{ state: "future-state", commandState: "completed", commandTerminal: true, commandId: 51 },
		{ state: "unknown", commandState: "unknown", commandTerminal: true, commandId: 51 },
		{ state: "failed", commandState: "failed", commandTerminal: true, commandId: null },
	])(
		"fails closed on unresolved/inconsistent stored command $state/$commandState",
		async (data) => {
			const operation = await startImport();
			await prisma.arrImportOperation.updateMany({
				where: { id: operation.id, userId: "owner" },
				data,
			});
			const response = await createInjectAuthenticated(app)("PUT", "/services/instance", {
				body: { baseUrl: "https://replacement.invalid" },
			});
			expect(response.statusCode).toBe(409);
		},
	);
	it.each(["submitting", "pending", "unknown", "failed", "future-state"])(
		"retains unresolved legacy %s protection",
		async (state) => {
			await prisma.queueCleanerImportReceipt.create({
				data: {
					instanceId: "instance",
					downloadKey: "a".repeat(64),
					queueId: 1,
					downloadTitle: "Synthetic",
					connectionFingerprint: "b".repeat(64),
					commandFingerprint: `v1:${"c".repeat(64)}`,
					commandId: 51,
					state,
					lastAttemptAt: new Date(),
				},
			});
			const response = await createInjectAuthenticated(app)("PUT", "/services/instance", {
				body: { baseUrl: "https://replacement.invalid" },
			});
			expect(response.statusCode).toBe(409);
		},
	);
	it("rechecks a newly admitted import inside the connection-write transaction", async () => {
		const originalTransaction = prisma.$transaction.bind(prisma);
		vi.spyOn(prisma, "$transaction").mockImplementationOnce(async (callback) => {
			await prisma.queueCleanerImportReceipt.create({
				data: {
					instanceId: "instance",
					downloadKey: "a".repeat(64),
					queueId: 1,
					downloadTitle: "Synthetic",
					connectionFingerprint: "b".repeat(64),
					commandFingerprint: `v1:${"c".repeat(64)}`,
					state: "submitting",
					lastAttemptAt: new Date(),
				},
			});
			return originalTransaction(callback as never);
		});
		const response = await createInjectAuthenticated(app)("PUT", "/services/instance", {
			body: { baseUrl: "https://replacement.invalid" },
		});
		expect(response.statusCode).toBe(409);
		expect(
			await prisma.serviceInstance.findFirstOrThrow({ where: { id: "instance", userId: "owner" } }),
		).toMatchObject({ baseUrl: "https://fixture.invalid" });
	});
	it("does not borrow another owner's receipt authority", async () => {
		await prisma.queueCleanerImportReceipt.create({
			data: {
				instanceId: "other-instance",
				downloadKey: "a".repeat(64),
				queueId: 1,
				downloadTitle: "Synthetic",
				connectionFingerprint: "b".repeat(64),
				commandFingerprint: "v1:c".padEnd(67, "c"),
				state: "unknown",
				lastAttemptAt: new Date(),
			},
		});
		const response = await createInjectAuthenticated(app)("PUT", "/services/instance", {
			body: { baseUrl: "https://replacement.invalid" },
		});
		expect(response.statusCode).toBe(200);
	});
});
