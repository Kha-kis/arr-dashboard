import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RadarrClient } from "arr-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { importCommandFingerprint } from "../../lib/arr/manual-import-command.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import type { PrismaClient } from "../../lib/prisma.js";
import {
	executeEnhancedPreview,
	executeQueueCleaner,
} from "../../lib/queue-cleaner/cleaner-executor.js";
import {
	importConnectionFingerprint,
	queueDownloadKey,
} from "../../lib/queue-cleaner/import-receipt.js";
import { queueItemFingerprint } from "../../lib/queue-cleaner/queue-observation.js";
import { createDeploymentEndpointKey } from "../../lib/trash-guides/deployment-target.js";
import { registerServiceRoutes } from "../services.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

let directory: string;
let databasePath: string;
let prisma: PrismaClient;
let app: FastifyInstance;

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "service-create-atomicity-"));
	databasePath = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "ignore",
	});
	prisma = createTestPrismaClient(databasePath);
	await prisma.user.createMany({
		data: [
			{ id: "user-1", username: "fixture-owner" },
			{ id: "user-2", username: "fixture-other" },
		],
	});
}, 30_000);

beforeEach(async () => {
	await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "reject_service_insert"');
	await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "reject_tag_insert"');
	await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "reject_strike_insert"');
	await prisma.arrImportSourceClaim.deleteMany({});
	await prisma.arrImportOperation.deleteMany({});
	await prisma.serviceInstance.deleteMany({});
	await prisma.serviceTag.deleteMany({});
	app = Fastify({ logger: false });
	app.decorate("prisma", prisma);
	app.decorate("encryptor", new Encryptor("a".repeat(64)));
	setupAuthInjection(app);
	registerTestErrorHandler(app);
	await app.register(registerServiceRoutes);
	await app.ready();
});

afterEach(async () => {
	await app?.close();
});

afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

async function seedDefaults(service: "SONARR" | "QUI") {
	const common = {
		baseUrl: "http://fixture.invalid",
		encryptedApiKey: "fixture-cipher",
		encryptionIv: "fixture-iv",
		isDefault: true,
	};
	await prisma.serviceInstance.createMany({
		data: [
			{ ...common, id: "existing-default", userId: "user-1", service, label: "Existing" },
			{ ...common, id: "other-owner", userId: "user-2", service, label: "Other owner" },
			{
				...common,
				id: "other-service",
				userId: "user-1",
				service: "RADARR",
				label: "Other service",
			},
		],
	});
}

function createDefault(service: "SONARR" | "QUI") {
	return createInjectAuthenticated(app)("POST", "/services", {
		body: {
			label: "Candidate",
			baseUrl: "http://fixture.invalid",
			apiKey: "fixture-key-value",
			service: service.toLowerCase(),
			isDefault: true,
			tags: ["candidate-tag"],
		},
	});
}

describe.each(["SONARR", "QUI"] as const)("%s default creation on populated SQLite", (service) => {
	it.each(["service", "tag"] as const)(
		"retains defaults and rolls back tags after %s insertion fails",
		async (failure) => {
			await seedDefaults(service);
			if (failure === "service") {
				await prisma.$executeRawUnsafe(
					`CREATE TRIGGER reject_service_insert BEFORE INSERT ON ServiceInstance
				 WHEN NEW.label = 'Candidate' BEGIN SELECT RAISE(ABORT, 'fixture_insert_failure'); END`,
				);
			} else {
				await prisma.$executeRawUnsafe(
					`CREATE TRIGGER reject_tag_insert BEFORE INSERT ON ServiceTag
				 WHEN NEW.name = 'candidate-tag' BEGIN SELECT RAISE(ABORT, 'fixture_tag_failure'); END`,
				);
			}

			const response = await createDefault(service);

			expect(response.statusCode).toBe(500);
			expect(await prisma.serviceInstance.count()).toBe(3);
			expect(await prisma.serviceInstance.count({ where: { isDefault: true } })).toBe(3);
			expect(await prisma.serviceTag.count()).toBe(0);
		},
	);

	it("atomically replaces only the owner's matching service default and links its tags", async () => {
		await seedDefaults(service);

		const response = await createDefault(service);

		expect(response.statusCode).toBe(201);
		expect(await prisma.serviceInstance.count()).toBe(4);
		expect(
			await prisma.serviceInstance.findUnique({ where: { id: "existing-default" } }),
		).toMatchObject({
			isDefault: false,
		});
		expect(await prisma.serviceInstance.count({ where: { isDefault: true } })).toBe(3);
		const created = await prisma.serviceInstance.findFirst({
			where: { userId: "user-1", label: "Candidate", service },
			include: { tags: { include: { tag: true } } },
		});
		expect(created).toMatchObject({ isDefault: true });
		expect(created?.tags.map(({ tag }) => tag.name)).toEqual(["candidate-tag"]);
	});
});

it("adds nullable queue identity and command receipt fields to a populated legacy table without changing connections or strikes", async () => {
	await seedDefaults("SONARR");
	await prisma.queueCleanerStrike.create({
		data: {
			id: "legacy-strike",
			instanceId: "existing-default",
			downloadId: "42",
			downloadTitle: "Fixture download",
			downloadHash: "a".repeat(40),
			strikeCount: 2,
			lastRule: "stalled",
			lastReason: "Fixture rule",
		},
	});
	// All DDL is confined to the disposable fixture, never the populated QA database.
	await prisma.$executeRawUnsafe(
		'ALTER TABLE "queue_cleaner_strikes" DROP COLUMN "downloadFingerprint"',
	);
	await prisma.$executeRawUnsafe('DROP TABLE "queue_cleaner_import_receipts"');
	await prisma.$disconnect();
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "ignore",
	});
	await prisma.$connect();
	expect(await prisma.serviceInstance.count()).toBe(3);
	expect(await prisma.serviceInstance.count({ where: { isDefault: true } })).toBe(3);
	expect(
		await prisma.queueCleanerStrike.findUnique({ where: { id: "legacy-strike" } }),
	).toMatchObject({
		downloadId: "42",
		downloadFingerprint: null,
		downloadHash: "a".repeat(40),
		strikeCount: 2,
	});
	expect(await prisma.queueCleanerImportReceipt.count()).toBe(0);
}, 30_000);

async function createImportFixture(options: { seedLegacyReceipt?: boolean } = {}) {
	await seedDefaults("SONARR");
	const instance = await prisma.serviceInstance.findUniqueOrThrow({
		where: { id: "other-service" },
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
			autoImportEnabled: true,
			autoImportSafeOnly: false,
			strikeSystemEnabled: false,
		},
	});
	const item = {
		id: 42,
		title: "Fixture download",
		downloadId: "fixture-download",
		protocol: "usenet",
		movieId: 10,
		added: new Date(Date.now() - 3_600_000).toISOString(),
		trackedDownloadState: "importPending",
	};
	const files = [{ path: "/fixture/movie.mkv", downloadId: item.downloadId, movieId: 10 }];
	const commandFingerprint = importCommandFingerprint(files);
	if (!commandFingerprint) throw new Error("Expected a valid synthetic command fingerprint");
	const del = vi.fn();
	const client = new RadarrClient({ baseUrl: instance.baseUrl, apiKey: "synthetic-key" });
	const post = vi
		.spyOn(client, "post")
		.mockImplementation(
			async (_path, body) => ({ id: 7, name: "ManualImport", status: "queued", body }) as never,
		);
	const get = vi.spyOn(client, "get").mockImplementation(async (path) => {
		if (path.endsWith("/command/7"))
			return { id: 7, name: "ManualImport", status: "started", body: { files } } as never;
		if (path.endsWith("/history")) return { totalRecords: 0, records: [] } as never;
		return [] as never;
	});
	const queueGet = vi.spyOn(client.queue, "get").mockResolvedValue({
		page: 1,
		pageSize: 1000,
		totalRecords: 1,
		records: [item],
	} as never);
	vi.spyOn(client.queue, "getById").mockResolvedValue(item as never);
	const queueDelete = vi.spyOn(client.queue, "delete").mockImplementation(del);
	const manualImportGet = vi.spyOn(client.manualImport, "get").mockResolvedValue([
		{
			id: 1,
			path: "/fixture/movie.mkv",
			downloadId: item.downloadId,
			movie: { id: 10 },
			quality: { quality: { id: 1 } },
			languages: [],
			customFormats: [],
			indexerFlags: [],
			rejections: [],
		} as never,
	]);
	if (options.seedLegacyReceipt !== false) {
		const lastAttemptAt = new Date(Date.now() - 60_000);
		await prisma.queueCleanerImportReceipt.create({
			data: {
				instanceId: instance.id,
				downloadKey: queueDownloadKey(item)!,
				queueId: item.id,
				downloadTitle: item.title,
				connectionFingerprint: importConnectionFingerprint(instance),
				commandFingerprint,
				commandId: 7,
				state: "pending",
				lastAttemptAt,
			},
		});
		await prisma.queueCleanerStrike.create({
			data: {
				instanceId: instance.id,
				downloadId: String(item.id),
				downloadTitle: item.title,
				downloadHash: null,
				downloadFingerprint: queueItemFingerprint(item),
				strikeCount: 1,
				lastRule: "import_pending",
				lastReason: "Fixture legacy import attempt",
				importAttempts: 1,
				lastImportAttempt: lastAttemptAt,
				lastImportError: null,
				firstStrikeAt: lastAttemptAt,
				lastStrikeAt: lastAttemptAt,
			},
		});
	}
	app.arrClientFactory = {
		create: () => client,
		createConnectionCredentialIdentity: () => "fixture-credential",
	} as unknown as FastifyInstance["arrClientFactory"];
	app.deploymentExecutor = {
		runWithEndpointMutation: async (userId, target, _operation, callback) =>
			callback(
				createDeploymentEndpointKey(userId, {
					...target,
					credentialIdentity: "fixture-credential",
				}),
			),
	} as FastifyInstance["deploymentExecutor"];
	return {
		instance,
		config,
		client,
		files,
		queueGet,
		queueDelete,
		manualImportGet,
		post,
		get,
		del,
		run: () => executeQueueCleaner(app, instance, config),
	};
}

it("retains pending command authority across strike clearing and a SQLite reconnect", async () => {
	const fixture = await createImportFixture();
	const seededReceipt = await prisma.queueCleanerImportReceipt.findFirstOrThrow();
	expect(await prisma.queueCleanerStrike.findFirst()).toMatchObject({ importAttempts: 1 });
	expect(await fixture.run()).toMatchObject({ status: "partial", itemsCleaned: 0 });
	await prisma.queueCleanerStrike.deleteMany({ where: { instanceId: fixture.instance.id } });
	await prisma.$disconnect();
	await prisma.$connect();
	expect(await fixture.run()).toMatchObject({ status: "partial", itemsCleaned: 0 });
	expect(
		await prisma.queueCleanerImportReceipt.findUnique({ where: { id: seededReceipt.id } }),
	).toMatchObject({ state: "pending" });
	expect(await prisma.queueCleanerStrike.count()).toBe(0);
	expect(fixture.post).not.toHaveBeenCalled();
	expect(fixture.del).not.toHaveBeenCalled();
});

it.each(["submitting", "pending", "unknown", "failed", "unrecognized"])(
	"does not erase a %s import receipt when its connection is deleted",
	async (state) => {
		const fixture = await createImportFixture();
		await fixture.run();
		await prisma.queueCleanerImportReceipt.updateMany({ data: { state } });
		const response = await createInjectAuthenticated(app)(
			"DELETE",
			`/services/${fixture.instance.id}`,
		);
		expect(response.statusCode).toBe(409);
		expect(response.json().message).toMatch(/import/i);
		expect(await prisma.serviceInstance.count({ where: { id: fixture.instance.id } })).toBe(1);
		expect(await prisma.queueCleanerImportReceipt.count()).toBe(1);
	},
);

it("keeps the connection while an import request remains unsettled", async () => {
	const fixture = await createImportFixture();
	let started!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	fixture.get.mockImplementationOnce(async () => {
		started();
		await held;
		return {
			id: 7,
			name: "ManualImport",
			status: "started",
			body: { files: fixture.files },
		} as never;
	});
	const running = fixture.run();
	await entered;
	try {
		const response = await createInjectAuthenticated(app)(
			"DELETE",
			`/services/${fixture.instance.id}`,
		);
		expect(response.statusCode).toBe(409);
		expect(await prisma.queueCleanerImportReceipt.count()).toBe(1);
	} finally {
		release();
		await running;
	}
});

async function verifyCompletedFixture(fixture: Awaited<ReturnType<typeof createImportFixture>>) {
	fixture.get.mockImplementation(async (path: string) =>
		path.endsWith("/command/7")
			? {
					id: 7,
					name: "ManualImport",
					status: "completed",
					result: "successful",
					body: { files: fixture.files },
				}
			: ({
					totalRecords: 1,
					records: [
						{
							eventType: "downloadFolderImported",
							date: new Date(Date.now() + 1_000).toISOString(),
							movieId: 10,
							downloadId: "fixture-download",
							data: { droppedPath: "/fixture/movie.mkv", fileId: 5 },
						},
					],
				} as never),
	);
	expect(await fixture.run()).toMatchObject({ itemsCleaned: 1 });
	expect(await prisma.queueCleanerImportReceipt.findFirst()).toMatchObject({ state: "completed" });
}

it("retains completed receipt protection while the same source is queued on another owned connection", async () => {
	const fixture = await createImportFixture();
	await verifyCompletedFixture(fixture);
	await prisma.serviceInstance.update({
		where: { id: "existing-default" },
		data: { enabled: false },
	});
	const clearClient = new RadarrClient({
		baseUrl: fixture.instance.baseUrl,
		apiKey: "synthetic-alias",
	});
	vi.spyOn(clearClient.queue, "get").mockResolvedValue({
		page: 1,
		pageSize: 1000,
		totalRecords: 0,
		records: [],
	} as never);
	app.arrClientFactory.create = ((connection: { id: string }) =>
		connection.id === fixture.instance.id
			? clearClient
			: fixture.client) as unknown as FastifyInstance["arrClientFactory"]["create"];
	const response = await createInjectAuthenticated(app)(
		"DELETE",
		`/services/${fixture.instance.id}`,
	);
	// The deleted connection is clear, but even a disabled owned alias retains source protection.
	expect(response.statusCode).toBe(409);
	expect(await prisma.queueCleanerImportReceipt.count()).toBe(1);
});

it("allows a verified completed import connection to be deleted once all owned queues are clear", async () => {
	const fixture = await createImportFixture();
	await verifyCompletedFixture(fixture);
	fixture.queueGet.mockResolvedValue({
		page: 1,
		pageSize: 1000,
		totalRecords: 0,
		records: [],
	});
	const response = await createInjectAuthenticated(app)(
		"DELETE",
		`/services/${fixture.instance.id}`,
	);
	expect(response.statusCode).toBe(204);
	expect(await prisma.serviceInstance.count({ where: { id: fixture.instance.id } })).toBe(0);
	expect(await prisma.queueCleanerImportReceipt.count()).toBe(0);
	expect(fixture.post).not.toHaveBeenCalled();
	expect(fixture.del).not.toHaveBeenCalled();
});

it("does not treat unavailable completed-import source coverage as permission to delete", async () => {
	const fixture = await createImportFixture();
	await verifyCompletedFixture(fixture);
	fixture.queueGet.mockRejectedValue(new Error("fixture provider unavailable"));
	const response = await createInjectAuthenticated(app)(
		"DELETE",
		`/services/${fixture.instance.id}`,
	);
	expect(response.statusCode).toBe(409);
	expect(response.body).not.toContain("fixture provider unavailable");
	expect(await prisma.queueCleanerImportReceipt.count()).toBe(1);
});

it.each(["unknown source", "truncated page"])(
	"retains receipts on %s coverage rather than interpreting it as absence",
	async (failure) => {
		const fixture = await createImportFixture();
		await verifyCompletedFixture(fixture);
		fixture.queueGet.mockResolvedValue({
			page: 1,
			pageSize: 1000,
			totalRecords: 1,
			records: failure === "unknown source" ? [{ id: 99, protocol: "usenet" }] : [],
		});
		const response = await createInjectAuthenticated(app)(
			"DELETE",
			`/services/${fixture.instance.id}`,
		);
		expect(response.statusCode).toBe(409);
		expect(await prisma.queueCleanerImportReceipt.count()).toBe(1);
		expect(fixture.del).not.toHaveBeenCalled();
	},
);

it.each(["SONARR", "LIDARR", "READARR", "QUI"] as const)(
	"retains unresolved receipts even when a saved connection's type is now %s",
	async (service) => {
		const fixture = await createImportFixture();
		await fixture.run();
		await prisma.serviceInstance.update({ where: { id: fixture.instance.id }, data: { service } });
		const response = await createInjectAuthenticated(app)(
			"DELETE",
			`/services/${fixture.instance.id}`,
		);
		expect(response.statusCode).toBe(409);
		expect(await prisma.queueCleanerImportReceipt.count()).toBe(1);
	},
);

it("permits deletion after a legitimate credential change without erasing unsettled authority", async () => {
	const fixture = await createImportFixture();
	await verifyCompletedFixture(fixture);
	fixture.queueGet.mockResolvedValue({
		page: 1,
		pageSize: 1000,
		totalRecords: 0,
		records: [],
	});
	await prisma.serviceInstance.update({
		where: { id: fixture.instance.id },
		data: { encryptedApiKey: "fixture-changed-cipher" },
	});
	const response = await createInjectAuthenticated(app)(
		"DELETE",
		`/services/${fixture.instance.id}`,
	);
	expect(response.statusCode).toBe(204);
	expect(await prisma.queueCleanerImportReceipt.count()).toBe(0);
});

it("allows more than 100 positively completed receipts to retire when all owned queues are clear", async () => {
	const fixture = await createImportFixture();
	await verifyCompletedFixture(fixture);
	const {
		id: _id,
		createdAt: _createdAt,
		updatedAt: _updatedAt,
		...receipt
	} = await prisma.queueCleanerImportReceipt.findFirstOrThrow();
	await prisma.queueCleanerImportReceipt.createMany({
		data: Array.from({ length: 105 }, (_, index) => ({
			...receipt,
			downloadKey: `fixture-completed-${index}`,
		})),
	});
	fixture.queueGet.mockResolvedValue({
		page: 1,
		pageSize: 1000,
		totalRecords: 0,
		records: [],
	});
	expect(
		(await createInjectAuthenticated(app)("DELETE", `/services/${fixture.instance.id}`)).statusCode,
	).toBe(204);
	expect(await prisma.queueCleanerImportReceipt.count()).toBe(0);
});

it("keeps positive completion usable after ARR prunes historical command and History records", async () => {
	const fixture = await createImportFixture();
	await verifyCompletedFixture(fixture);
	fixture.get.mockRejectedValue(new Error("fixture historical evidence pruned"));
	fixture.queueGet.mockResolvedValue({
		page: 1,
		pageSize: 1000,
		totalRecords: 0,
		records: [],
	});
	expect(
		(await createInjectAuthenticated(app)("DELETE", `/services/${fixture.instance.id}`)).statusCode,
	).toBe(204);
	expect(fixture.post).not.toHaveBeenCalled();
	expect(fixture.del).not.toHaveBeenCalled();
});

it("does not degrade positively completed evidence to unknown after connection replacement", async () => {
	const fixture = await createImportFixture();
	await verifyCompletedFixture(fixture);
	const replaced = await prisma.serviceInstance.update({
		where: { id: fixture.instance.id },
		data: { encryptedApiKey: "fixture-replaced-cipher" },
	});
	fixture.queueGet.mockResolvedValue({
		page: 1,
		pageSize: 1000,
		totalRecords: 0,
		records: [],
	});
	await executeQueueCleaner(app, replaced, fixture.config);
	expect(await prisma.queueCleanerImportReceipt.findFirst()).toMatchObject({ state: "completed" });
});

it("releases deletion within its deadline even while a read-only provider request is held", async () => {
	const fixture = await createImportFixture();
	await verifyCompletedFixture(fixture);
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	fixture.queueGet.mockImplementation(async () => {
		entered();
		await held;
		return { page: 1, pageSize: 1000, totalRecords: 0, records: [] };
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	let settled = false;
	const deletion = createInjectAuthenticated(app)(
		"DELETE",
		`/services/${fixture.instance.id}`,
	).then((response) => {
		settled = true;
		return response;
	});
	try {
		await started;
		await vi.advanceTimersByTimeAsync(15_000);
		expect(settled).toBe(true);
		expect((await deletion).statusCode).toBe(409);
		expect(await prisma.queueCleanerImportReceipt.count()).toBe(1);
	} finally {
		release();
		await deletion;
		vi.useRealTimers();
	}
});

it("recovers a blocked connection after actual cleaner reconciliation verifies all files and queues clear", async () => {
	const fixture = await createImportFixture();
	await verifyCompletedFixture(fixture);
	await prisma.queueCleanerImportReceipt.updateMany({ data: { state: "failed" } });
	expect(
		(await createInjectAuthenticated(app)("DELETE", `/services/${fixture.instance.id}`)).statusCode,
	).toBe(409);
	fixture.queueGet.mockResolvedValue({
		page: 1,
		pageSize: 1000,
		totalRecords: 0,
		records: [],
	});
	expect(await fixture.run()).toMatchObject({ itemsCleaned: 1 });
	expect(await prisma.queueCleanerImportReceipt.findFirst()).toMatchObject({ state: "completed" });
	expect(
		(await createInjectAuthenticated(app)("DELETE", `/services/${fixture.instance.id}`)).statusCode,
	).toBe(204);
	expect(fixture.post).not.toHaveBeenCalled();
	expect(fixture.del).not.toHaveBeenCalled();
});

it("does not start a cleaner action while connection deletion owns the topology guard", async () => {
	const fixture = await createImportFixture({ seedLegacyReceipt: false });
	let started!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const original = app.deploymentExecutor.runWithEndpointMutation.bind(app.deploymentExecutor);
	vi.spyOn(app.deploymentExecutor, "runWithEndpointMutation").mockImplementation(
		async (userId, target, operation, callback) => {
			started();
			await held;
			return original(userId, target, operation, callback);
		},
	);
	const deleting = createInjectAuthenticated(app)("DELETE", `/services/${fixture.instance.id}`);
	await entered;
	try {
		expect(await fixture.run()).toMatchObject({ status: "error", itemsCleaned: 0 });
		expect(fixture.queueGet).not.toHaveBeenCalled();
		expect(fixture.post).not.toHaveBeenCalled();
	} finally {
		release();
		expect((await deleting).statusCode).toBe(204);
	}
});

it("does not let another owner's pending receipt block deletion or expose import details", async () => {
	const fixture = await createImportFixture({ seedLegacyReceipt: false });
	await prisma.queueCleanerImportReceipt.create({
		data: {
			instanceId: "other-owner",
			downloadKey: "fixture-other-source",
			queueId: 99,
			downloadTitle: "Fixture private other-owner source",
			connectionFingerprint: "fixture-other-connection",
			commandFingerprint: "fixture-other-command",
			state: "pending",
			lastAttemptAt: new Date(),
		},
	});
	const response = await createInjectAuthenticated(app)(
		"DELETE",
		`/services/${fixture.instance.id}`,
	);
	expect(response.statusCode).toBe(204);
	expect(await prisma.queueCleanerImportReceipt.count()).toBe(1);
	expect(response.body).not.toContain("Fixture private other-owner source");
});

it("rechecks receipts at the delete transaction boundary rather than trusting an earlier empty read", async () => {
	const fixture = await createImportFixture({ seedLegacyReceipt: false });
	const original = app.deploymentExecutor.runWithEndpointMutation.bind(app.deploymentExecutor);
	vi.spyOn(app.deploymentExecutor, "runWithEndpointMutation").mockImplementation(
		async (userId, target, operation, callback) => {
			// Synthetic competing writer: the delete transaction must observe this committed receipt.
			await prisma.queueCleanerImportReceipt.create({
				data: {
					instanceId: fixture.instance.id,
					downloadKey: "fixture-late-source",
					queueId: 99,
					downloadTitle: "Fixture late source",
					connectionFingerprint: "fixture-other-connection",
					commandFingerprint: "fixture-other-command",
					state: "pending",
					lastAttemptAt: new Date(),
				},
			});
			return original(userId, target, operation, callback);
		},
	);
	const response = await createInjectAuthenticated(app)(
		"DELETE",
		`/services/${fixture.instance.id}`,
	);
	expect(response.statusCode).toBe(409);
	expect(await prisma.queueCleanerImportReceipt.count()).toBe(1);
	expect(await prisma.serviceInstance.count({ where: { id: fixture.instance.id } })).toBe(1);
});

it("admits at most one external import across concurrent cleaners on SQLite", async () => {
	const fixture = await createImportFixture({ seedLegacyReceipt: false });
	const results = await Promise.all([fixture.run(), fixture.run()]);
	expect(results.every((result) => result.itemsCleaned === 0)).toBe(true);
	expect(
		await prisma.arrImportOperation.count({ where: { userId: fixture.instance.userId } }),
	).toBe(1);
	expect(await prisma.queueCleanerImportReceipt.count()).toBe(0);
	expect(fixture.post).toHaveBeenCalledOnce();
	expect(fixture.del).not.toHaveBeenCalled();
});

it("rolls back tracked admission when strike tracking fails and never POSTs", async () => {
	const fixture = await createImportFixture({ seedLegacyReceipt: false });
	await prisma.$executeRawUnsafe(
		`CREATE TRIGGER reject_strike_insert BEFORE INSERT ON queue_cleaner_strikes BEGIN SELECT RAISE(ABORT, 'fixture_strike_failure'); END`,
	);
	expect(await fixture.run()).toMatchObject({ status: "partial", itemsCleaned: 0 });
	expect(
		await prisma.arrImportOperation.count({ where: { userId: fixture.instance.userId } }),
	).toBe(0);
	expect(await prisma.queueCleanerImportReceipt.count()).toBe(0);
	expect(fixture.post).not.toHaveBeenCalled();
	expect(fixture.del).not.toHaveBeenCalled();
});

it("protects a pending shared download across same-owner connections without borrowing provider authority", async () => {
	const fixture = await createImportFixture();
	await fixture.run();
	const sourceCommandReads = fixture.get.mock.calls.length;
	const alias = await prisma.serviceInstance.create({
		data: {
			userId: fixture.instance.userId,
			service: "RADARR",
			label: "Fixture shared connection",
			baseUrl: fixture.instance.baseUrl,
			encryptedApiKey: "fixture-alias-cipher",
			encryptionIv: "fixture-alias-iv",
		},
	});
	const config = { ...fixture.config, instanceId: alias.id, autoImportEnabled: false };
	const dry = await executeQueueCleaner(app, alias, { ...config, dryRunMode: true });
	const preview = await executeEnhancedPreview(app, alias, config);
	const live = await executeQueueCleaner(app, alias, config);
	expect(dry.itemsCleaned).toBe(0);
	expect(preview.previewItems[0]?.action).toBe("skip");
	expect(live).toMatchObject({ status: "partial", itemsCleaned: 0 });
	expect(fixture.del).not.toHaveBeenCalled();
	expect(fixture.post).not.toHaveBeenCalled();
	// A command ID belongs to A's provider, never the alias's provider.
	expect(fixture.get).toHaveBeenCalledTimes(sourceCommandReads);
});

it("does not let another owner's receipt authorize or block this owner's cleanup", async () => {
	const fixture = await createImportFixture();
	const firstOwnerReceipt = await prisma.queueCleanerImportReceipt.findFirstOrThrow({
		where: { instanceId: fixture.instance.id },
	});
	const other = await prisma.serviceInstance.update({
		where: { id: "other-owner" },
		data: { service: "RADARR" },
	});
	const config = { ...fixture.config, instanceId: other.id, autoImportEnabled: false };
	expect(await executeQueueCleaner(app, other, config)).toMatchObject({ itemsCleaned: 1 });
	expect(fixture.del).toHaveBeenCalledOnce();
	expect(fixture.post).not.toHaveBeenCalled();
	expect(fixture.get).not.toHaveBeenCalled();
	expect(
		await prisma.queueCleanerImportReceipt.findUnique({ where: { id: firstOwnerReceipt.id } }),
	).toMatchObject({ instanceId: fixture.instance.id, state: "pending" });
});

it("rechecks shared receipts immediately before POST when one appears after initial observation", async () => {
	const fixture = await createImportFixture({ seedLegacyReceipt: false });
	const alias = await prisma.serviceInstance.create({
		data: {
			userId: fixture.instance.userId,
			service: "RADARR",
			label: "Fixture late import connection",
			baseUrl: fixture.instance.baseUrl,
			encryptedApiKey: "fixture-alias-cipher",
			encryptionIv: "fixture-alias-iv",
		},
	});
	fixture.manualImportGet.mockImplementationOnce(async () => {
		await prisma.queueCleanerImportReceipt.create({
			data: {
				instanceId: alias.id,
				downloadKey: createHash("sha256").update("fixture-download").digest("hex"),
				queueId: 99,
				downloadTitle: "Fixture shared source",
				connectionFingerprint: "fixture-other-provider",
				commandFingerprint: "fixture-other-command",
				commandId: 13,
				state: "pending",
				lastAttemptAt: new Date(),
			},
		});
		return [
			{
				id: 1,
				path: "/fixture/movie.mkv",
				downloadId: "fixture-download",
				movie: { id: 10 },
				quality: { quality: { id: 1 } },
				languages: [],
				customFormats: [],
				indexerFlags: [],
				rejections: [],
			} as never,
		];
	});
	expect(await fixture.run()).toMatchObject({ status: "partial", itemsCleaned: 0 });
	expect(fixture.post).not.toHaveBeenCalled();
	expect(fixture.del).not.toHaveBeenCalled();
	expect(fixture.get).not.toHaveBeenCalled();
});

it("withholds import when the connection is disabled after candidates are read", async () => {
	const fixture = await createImportFixture({ seedLegacyReceipt: false });
	fixture.manualImportGet.mockImplementationOnce(async () => {
		await prisma.serviceInstance.update({
			where: { id: fixture.instance.id },
			data: { enabled: false },
		});
		return [
			{
				id: 1,
				path: "/fixture/movie.mkv",
				downloadId: "fixture-download",
				movie: { id: 10 },
				quality: { quality: { id: 1 } },
				languages: [],
				customFormats: [],
				indexerFlags: [],
				rejections: [],
			} as never,
		];
	});
	expect(await fixture.run()).toMatchObject({ status: "partial", itemsCleaned: 0 });
	expect(fixture.post).not.toHaveBeenCalled();
	expect(fixture.del).not.toHaveBeenCalled();
	expect(await prisma.queueCleanerImportReceipt.count()).toBe(0);
});

it("keeps the source action guard while deletion is unsettled so a concurrent alias cannot import it", async () => {
	const fixture = await createImportFixture({ seedLegacyReceipt: false });
	const alias = await prisma.serviceInstance.create({
		data: {
			userId: fixture.instance.userId,
			service: "RADARR",
			label: "Fixture concurrent connection",
			baseUrl: fixture.instance.baseUrl,
			encryptedApiKey: "fixture-alias-cipher",
			encryptionIv: "fixture-alias-iv",
		},
	});
	let beginDelete!: () => void;
	let finishDelete!: () => void;
	const deleting = new Promise<void>((resolve) => {
		beginDelete = resolve;
	});
	const settled = new Promise<void>((resolve) => {
		finishDelete = resolve;
	});
	fixture.del.mockImplementation(async () => {
		beginDelete();
		await settled;
	});
	const removal = executeQueueCleaner(app, fixture.instance, {
		...fixture.config,
		autoImportEnabled: false,
	});
	await deleting;
	try {
		const importResult = await executeQueueCleaner(app, alias, {
			...fixture.config,
			instanceId: alias.id,
		});
		expect(importResult).toMatchObject({ status: "partial", itemsCleaned: 0 });
		expect(fixture.post).not.toHaveBeenCalled();
		expect(await prisma.queueCleanerImportReceipt.count()).toBe(0);
	} finally {
		finishDelete();
		await removal;
	}
	// A settled action releases the guard; it is not a permanent process lock.
	fixture.del.mockResolvedValue(undefined);
	expect(
		await executeQueueCleaner(app, alias, {
			...fixture.config,
			instanceId: alias.id,
			autoImportEnabled: false,
		}),
	).toMatchObject({ itemsCleaned: 1 });
});
