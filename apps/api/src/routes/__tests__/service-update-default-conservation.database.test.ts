import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { ArrClientFactory } from "../../lib/arr/client-factory.js";
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
const encryptor = new Encryptor(Buffer.alloc(32, 11).toString("base64"));

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "service-update-default-conservation-"));
	const databasePath = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "pipe",
		timeout: 25_000,
	});
	prisma = createTestPrismaClient(databasePath);
}, 30_000);

beforeEach(async () => {
	await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "reject_candidate_update"');
	await prisma.user.deleteMany();
	await prisma.user.createMany({
		data: [
			{ id: "user-1", username: "fixture-owner" },
			{ id: "user-2", username: "fixture-other" },
		],
	});
	const encrypted = encryptor.encrypt("synthetic-api-key");
	const common = {
		baseUrl: "http://fixture.invalid",
		encryptedApiKey: encrypted.value,
		encryptionIv: encrypted.iv,
		isDefault: true,
		enabled: true,
	};
	await prisma.serviceInstance.createMany({
		data: [
			{ ...common, id: "sonarr-default", userId: "user-1", service: "SONARR", label: "Sonarr" },
			{ ...common, id: "radarr-default", userId: "user-1", service: "RADARR", label: "Radarr" },
			{ ...common, id: "other-sonarr", userId: "user-2", service: "SONARR", label: "Other" },
			{ ...common, id: "other-radarr", userId: "user-2", service: "RADARR", label: "Other" },
			{
				...common,
				id: "candidate",
				userId: "user-1",
				service: "SONARR",
				label: "Synthetic disabled service",
				baseUrl: "http://candidate.invalid",
				isDefault: false,
				enabled: false,
			},
		],
	});
	app = Fastify({ logger: false });
	app.decorate("prisma", prisma);
	app.decorate("encryptor", encryptor);
	app.decorate("arrClientFactory", new ArrClientFactory(encryptor));
	setupAuthInjection(app);
	registerTestErrorHandler(app);
	await app.register(registerServiceRoutes);
	await app.ready();
});

afterEach(async () => {
	await app?.close();
});

afterAll(async () => {
	try {
		await prisma?.$disconnect();
	} finally {
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

function readServices() {
	return prisma.serviceInstance.findMany({
		orderBy: { id: "asc" },
		select: {
			id: true,
			userId: true,
			service: true,
			label: true,
			baseUrl: true,
			externalUrl: true,
			enabled: true,
			isDefault: true,
			storageGroupId: true,
			encryptedApiKey: true,
			encryptionIv: true,
		},
	});
}

// The browser submits service/isDefault and omits a blank edit API key.
function browserEdit(overrides: Record<string, unknown> = {}) {
	return {
		label: "Edited synthetic service",
		baseUrl: "http://candidate.invalid",
		externalUrl: null,
		service: "sonarr",
		enabled: false,
		isDefault: false,
		tags: [],
		storageGroupId: null,
		...overrides,
	};
}

function update(id: string, body: Record<string, unknown>) {
	return createInjectAuthenticated(app)("PUT", `/services/${id}`, { body });
}

describe("service update default conservation on populated SQLite", () => {
	it.each([
		{ name: "label-only browser edit", change: {} },
		{ name: "non-default URL edit", change: { baseUrl: "http://replacement.invalid" } },
		{ name: "non-default enabled edit", change: { enabled: true } },
	])("preserves peer defaults and credentials for $name", async ({ change }) => {
		const before = await readServices();
		const response = await update("candidate", browserEdit(change));
		expect(response.statusCode).toBe(200);
		expect(await readServices()).toEqual(
			before.map((row) =>
				row.id === "candidate" ? { ...row, label: "Edited synthetic service", ...change } : row,
			),
		);
	});

	it("preserves defaults when a non-default service edit omits isDefault", async () => {
		const before = await readServices();
		const response = await update("candidate", { service: "sonarr", label: "Edited" });
		expect(response.statusCode).toBe(200);
		expect(await readServices()).toEqual(
			before.map((row) => (row.id === "candidate" ? { ...row, label: "Edited" } : row)),
		);
	});

	it("promotes only the selected owner's service and conserves all credentials", async () => {
		const before = await readServices();
		const response = await update("candidate", browserEdit({ isDefault: true }));
		expect(response.statusCode).toBe(200);
		expect(await readServices()).toEqual(
			before.map((row) =>
				row.id === "candidate"
					? { ...row, label: "Edited synthetic service", isDefault: true }
					: row.id === "sonarr-default"
						? { ...row, isDefault: false }
						: row,
			),
		);
	});

	it.each([{}, { isDefault: true }])(
		"moves an existing default into its new service with default option %j",
		async (defaultOption) => {
			const before = await readServices();
			const response = await update("sonarr-default", { service: "radarr", ...defaultOption });
			expect(response.statusCode).toBe(200);
			expect(await readServices()).toEqual(
				before.map((row) =>
					row.id === "sonarr-default"
						? { ...row, service: "RADARR" }
						: row.id === "radarr-default"
							? { ...row, isDefault: false }
							: row,
				),
			);
		},
	);

	it.each([{}, { isDefault: false }])(
		"conserves the destination default when moving a non-default with option %j",
		async (defaultOption) => {
			const before = await readServices();
			const response = await update("candidate", { service: "radarr", ...defaultOption });
			expect(response.statusCode).toBe(200);
			expect(await readServices()).toEqual(
				before.map((row) => (row.id === "candidate" ? { ...row, service: "RADARR" } : row)),
			);
		},
	);

	it("demotes a moved default without clearing the destination's default", async () => {
		const before = await readServices();
		const response = await update("sonarr-default", { service: "radarr", isDefault: false });
		expect(response.statusCode).toBe(200);
		expect(await readServices()).toEqual(
			before.map((row) =>
				row.id === "sonarr-default" ? { ...row, service: "RADARR", isDefault: false } : row,
			),
		);
	});

	it("rolls back peer demotion and all connection fields when the target update fails", async () => {
		const before = await readServices();
		await prisma.$executeRawUnsafe(
			`CREATE TRIGGER reject_candidate_update BEFORE UPDATE ON ServiceInstance
			 WHEN NEW.id = 'candidate' BEGIN SELECT RAISE(ABORT, 'fixture_update_failure'); END`,
		);
		const response = await update("candidate", browserEdit({ isDefault: true }));
		expect(response.statusCode).toBe(500);
		expect(await readServices()).toEqual(before);
	});
});
