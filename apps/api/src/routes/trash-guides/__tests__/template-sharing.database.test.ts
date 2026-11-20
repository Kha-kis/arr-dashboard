import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../../lib/__tests__/test-prisma.js";
import { synchronizeRuntimeSchema } from "../../../lib/backup/runtime-schema-startup.js";
import templateSharingRoutes from "../template-sharing-routes.js";
import { registerTemplateRoutes } from "../template-routes.js";

// No provider is needed for JSON sharing: native SQLite, production services and
// registered Fastify routes run unchanged. Only request authentication is synthetic.
describe("template JSON sharing persisted route roundtrip", () => {
	const app = Fastify({ logger: false });
	const prefix = "/api/trash-guides/sharing";
	let directory: string, database: string;
	let prisma: ReturnType<typeof createTestPrismaClient>;
	const observations: unknown[] = [];
	const config = {
		customFormats: [
			{
				trashId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				name: "Synthetic selected CF",
				enabled: true,
				scoreOverride: 42,
				conditionsEnabled: { Synthetic: true },
				originalConfig: {
					trash_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					name: "Synthetic selected CF",
					includeCustomFormatWhenRenaming: true,
					specifications: [
						{
							name: "Synthetic",
							implementation: "ReleaseTitleSpecification",
							negate: false,
							required: true,
							fields: { value: "synthetic" },
						},
					],
				},
			},
		],
		customFormatGroups: [],
		qualityProfile: { upgradeAllowed: true, cutoff: "WEBDL-1080p", minFormatScore: 5 },
		syncSettings: { deleteRemovedCFs: false },
		namingSelection: { serviceType: "RADARR", filePreset: "Synthetic", folderPreset: null },
	};
	const exportOptions = {
		includeQualitySettings: true,
		includeCustomConditions: true,
		includeMetadata: true,
		author: "Synthetic author",
		tags: ["synthetic"],
		category: "movies",
		notes: "Synthetic note",
	};
	const post = (path: string, payload: unknown) =>
		app.inject({ method: "POST", url: prefix + path, payload: payload as Record<string, unknown> });
	const snapshot = () => prisma.trashTemplate.findMany({ orderBy: { id: "asc" } });
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "arr-sharing-native-"));
		database = join(directory, "owned.db");
		new Database(database).close();
		await synchronizeRuntimeSchema("file:" + database);
		prisma = createTestPrismaClient("file:" + database);
		await prisma.user.createMany({
			data: [
				{ id: "owner", username: "synthetic-owner" },
				{ id: "other", username: "synthetic-other" },
			],
		});
		app.decorate("prisma", prisma);
		app.decorate("dbProvider", "sqlite");
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (request) => {
			request.currentUser = {
				id: "owner",
				username: "synthetic-auth",
			} as typeof request.currentUser;
		});
		await app.register(templateSharingRoutes, { prefix });
		await app.register(registerTemplateRoutes, { prefix: "/api/trash-guides/templates" });
		await app.ready();
	});
	beforeEach(async () => {
		await prisma.trashTemplate.deleteMany();
		await prisma.trashTemplate.createMany({
			data: [
				{
					id: "owned-template",
					userId: "owner",
					name: "Synthetic template",
					serviceType: "RADARR",
					configData: JSON.stringify(config),
				},
				{
					id: "foreign-template",
					userId: "other",
					name: "Foreign private template",
					serviceType: "RADARR",
					configData: JSON.stringify(config),
				},
			],
		});
	});
	afterEach(async (context) => {
		observations.push({
			name: context.task.name,
			templateCount: await prisma.trashTemplate.count(),
			ownerCount: await prisma.trashTemplate.count({ where: { userId: "owner" } }),
		});
	});
	afterAll(async () => {
		const errors: unknown[] = [];
		for (const close of [() => app.close(), () => prisma?.$disconnect()]) {
			try {
				await close();
			} catch (error) {
				errors.push(String(error));
			}
		}
		let quick: unknown, foreignKeys: unknown;
		if (database && existsSync(database)) {
			const db = new Database(database, { readonly: true });
			try {
				quick = db.pragma("quick_check");
				foreignKeys = db.pragma("foreign_key_check");
			} finally {
				db.close();
			}
		}
		assert(
			directory &&
				directory.startsWith(join(tmpdir(), "arr-sharing-native-")) &&
				database === join(directory, "owned.db"),
		);
		await rm(directory, { recursive: true, force: false });
		if (process.env.ARR_TRASH_NATIVE_EVIDENCE_DIR)
			await writeFile(
				join(process.env.ARR_TRASH_NATIVE_EVIDENCE_DIR, "sharing-native.json"),
				JSON.stringify(
					{
						observations,
						sqlDisconnected: true,
						quick,
						foreignKeys,
						cleanupRemoved: !existsSync(directory),
						errors,
					},
					null,
					2,
				),
				{ flag: "wx", mode: 0o600 },
			);
		expect(errors).toEqual([]);
		expect(quick).toEqual([{ quick_check: "ok" }]);
		expect(foreignKeys).toEqual([]);
	});
	it("J1 export/validate/preview preserve selected config/options without mutating SQL", async () => {
		const before = await snapshot();
		const exported = await post("/export", {
			templateId: "owned-template",
			options: exportOptions,
		});
		expect(exported.statusCode).toBe(200);
		const data = exported.json();
		expect(data).toMatchObject({
			version: "2.0",
			exportedBy: "owner",
			template: {
				name: "Synthetic template",
				serviceType: "RADARR",
				config,
				metadata: {
					author: "Synthetic author",
					tags: ["synthetic"],
					category: "movies",
					notes: "Synthetic note",
				},
			},
		});
		const validated = await post("/validate", { jsonData: exported.body });
		expect(validated.statusCode).toBe(200);
		expect(validated.json().data.valid).toBe(true);
		const preview = await post("/preview", { jsonData: exported.body });
		expect(preview.statusCode).toBe(200);
		expect(preview.json().data.template.config).toEqual(config);
		expect(await snapshot()).toEqual(before);
	});
	it("J2 import honors selected options and current route reads back the persisted config", async () => {
		const exported = await post("/export", {
			templateId: "owned-template",
			options: exportOptions,
		});
		expect(exported.statusCode).toBe(200);
		const imported = await post("/import", {
			jsonData: exported.body,
			options: {
				onNameConflict: "rename",
				includeQualitySettings: false,
				includeCustomConditions: true,
				includeMetadata: true,
				strictValidation: true,
				allowPartialImport: false,
			},
		});
		expect(imported.statusCode).toBe(201);
		expect(imported.json().success).toBe(true);
		const id = imported.json().data.template.id;
		const native = await prisma.trashTemplate.findUniqueOrThrow({ where: { id } });
		expect(native).toMatchObject({
			userId: "owner",
			name: "Synthetic template (1)",
			serviceType: "RADARR",
		});
		const expected = {
			customFormats: [
				{
					trashId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					name: "Synthetic selected CF",
					enabled: true,
					scoreOverride: 42,
					conditionsEnabled: { Synthetic: true },
					originalConfig: {
						trash_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						name: "Synthetic selected CF",
						includeCustomFormatWhenRenaming: true,
						specifications: [
							{
								name: "Synthetic",
								implementation: "ReleaseTitleSpecification",
								negate: false,
								required: true,
								fields: { value: "synthetic" },
							},
						],
					},
				},
			],
			customFormatGroups: [],
			syncSettings: { deleteRemovedCFs: false },
			namingSelection: { serviceType: "RADARR", filePreset: "Synthetic", folderPreset: null },
		};
		expect(JSON.parse(native.configData)).toEqual(expected);
		const current = await app.inject({ url: "/api/trash-guides/templates/" + id });
		expect(current.statusCode).toBe(200);
		expect(current.json().template).toMatchObject({
			id,
			name: "Synthetic template (1)",
			config: expected,
		});
		expect(await prisma.trashTemplate.count({ where: { userId: "owner" } })).toBe(2);
	});
	it("J3 invalid JSON is rejected without creating or replacing any template", async () => {
		const before = await snapshot();
		for (const path of ["/preview", "/import"]) {
			const response = await post(path, { jsonData: "{invalid-json" });
			expect(response.statusCode).toBe(400);
			expect(response.json().success).toBe(false);
		}
		expect(await snapshot()).toEqual(before);
	});
	it("J4 another owner's export/readback is refused without SQL mutation or private JSON", async () => {
		const before = await snapshot();
		const exported = await post("/export", {
			templateId: "foreign-template",
			options: exportOptions,
		});
		expect(exported.statusCode).toBeGreaterThanOrEqual(400);
		expect(exported.body).not.toContain("Foreign private template");
		expect(exported.body).not.toContain("scoreOverride");
		const current = await app.inject({ url: "/api/trash-guides/templates/foreign-template" });
		expect(current.statusCode).toBe(404);
		expect(await snapshot()).toEqual(before);
	});
});
