import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Encryptor } from "../../../lib/auth/encryption.js";
import { openRestoreRuntime } from "../../../lib/backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../../lib/backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../../lib/backup/runtime-schema-startup.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";
import { registerScheduleRoutes } from "../schedule-routes.js";
import { registerTemplateRoutes } from "../template-routes.js";

// Real registered routes/services/SQLite; only authenticated session identity is synthetic.
describe("native TRaSH template and schedule controls", () => {
	const app = Fastify({ logger: false });
	const templates = "/api/trash-guides/templates",
		schedules = "/api/trash-guides/schedules";
	let directory: string, database: string;
	let runtime: Awaited<ReturnType<typeof openRestoreRuntime>>;
	let native: ReturnType<typeof createRuntimePrismaClient>;
	const run = <T>(fn: () => Promise<T>) => runtime.runOperation(fn);
	const request = (method: string, url: string, body?: unknown) =>
		run(() => createInjectAuthenticated(app)(method, url, { body }));
	const config = {
		customFormats: [
			{
				trashId: "synthetic-cf",
				name: "Synthetic CF",
				scoreOverride: 42,
				conditionsEnabled: { Synthetic: true },
				originalConfig: {
					trash_id: "synthetic-cf",
					name: "Synthetic CF",
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
		qualityProfile: { upgradeAllowed: true, minFormatScore: 5 },
		syncSettings: { deleteRemovedCFs: false },
	};
	const templateRows = () =>
		run(() => native.prisma.trashTemplate.findMany({ orderBy: { id: "asc" } }));
	const scheduleRows = () =>
		run(() => native.prisma.trashSyncSchedule.findMany({ orderBy: { id: "asc" } }));
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "trash-control-template-"));
		database = join(directory, "fixture.db");
		new Database(database).close();
		await synchronizeRuntimeSchema(`file:${database}`);
		runtime = await openRestoreRuntime({ databaseUrl: `file:${database}` });
		await runtime.bindDestination("synthetic-trash-template-control");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		app.decorate("prisma", native.prisma);
		app.decorate("restoreRuntime", runtime);
		app.decorate("dbProvider", "sqlite");
		app.decorate("encryptor", new Encryptor("49".repeat(32)));
		setupAuthInjection(app, { id: "owner" });
		registerTestErrorHandler(app);
		await app.register(registerTemplateRoutes, { prefix: templates });
		await app.register(registerScheduleRoutes, { prefix: schedules });
		await app.ready();
	});
	beforeEach(async () =>
		run(async () => {
			await native.prisma.trashSyncSchedule.deleteMany();
			await native.prisma.templateQualityProfileMapping.deleteMany();
			await native.prisma.trashTemplate.deleteMany();
			await native.prisma.user.deleteMany();
			await native.prisma.user.createMany({
				data: [
					{ id: "owner", username: "synthetic-owner" },
					{ id: "other", username: "synthetic-other" },
				],
			});
			const encrypted = app.encryptor.encrypt("synthetic-unused-key");
			for (const id of ["selected", "peer", "foreign"]) {
				const userId = id === "foreign" ? "other" : "owner";
				await native.prisma.serviceInstance.create({
					data: {
						id,
						userId,
						service: "RADARR",
						label: "Same synthetic label",
						baseUrl: "http://unused.invalid",
						encryptedApiKey: encrypted.value,
						encryptionIv: encrypted.iv,
					},
				});
				await native.prisma.trashTemplate.create({
					data: {
						id,
						userId,
						name: id === "peer" ? "Synthetic peer" : "Same synthetic name",
						serviceType: "RADARR",
						configData: JSON.stringify({
							...config,
							qualityProfile: { minFormatScore: id === "foreign" ? 999 : 5 },
						}),
					},
				});
				await native.prisma.templateQualityProfileMapping.create({
					data: {
						id: `link-${id}`,
						instanceId: id,
						templateId: id,
						qualityProfileId: 1,
						qualityProfileName: "Synthetic saved link",
					},
				});
				if (id !== "selected")
					await native.prisma.trashSyncSchedule.create({
						data: {
							id: `schedule-${id}`,
							userId,
							templateId: id,
							instanceId: id,
							frequency: "DAILY",
							enabled: true,
						},
					});
			}
		}),
	);
	afterAll(async () => {
		await app.close();
		await native?.close();
		await runtime?.close();
		const checks = [];
		for (const file of [
			database,
			`${database}.arr-restore-runtime/owner.sqlite3`,
			`${database}.arr-restore-runtime/operations.sqlite3`,
		]) {
			const db = new Database(file, { readonly: true, fileMustExist: true });
			try {
				const quick = db.pragma("quick_check"),
					foreign = db.pragma("foreign_key_check");
				expect(quick).toEqual([{ quick_check: "ok" }]);
				expect(foreign).toEqual([]);
				checks.push({ file, quick, foreign });
			} finally {
				db.close();
				expect(db.open).toBe(false);
			}
		}
		expect(directory.startsWith(join(tmpdir(), "trash-control-template-"))).toBe(true);
		await rm(directory, { recursive: true, force: false });
		if (process.env.ARR_AUTOMATION_EVIDENCE_DIR)
			await writeFile(
				join(process.env.ARR_AUTOMATION_EVIDENCE_DIR, "template-control-closure.json"),
				JSON.stringify({
					nativeClosed: true,
					runtimeClosed: true,
					checks,
					cleanupRemoved: !existsSync(directory),
				}),
			);
	});
	it("T1 persists selected template CRUD and deep duplicate config while retaining populated peers", async () => {
		const before = await templateRows();
		const created = await request("POST", templates, {
			name: "Synthetic created",
			serviceType: "RADARR",
			config,
		});
		expect(created.statusCode).toBe(201);
		const id: string = created.json().template.id;
		expect(created.json().template.config).toEqual(config);
		const changed = {
			...config,
			customFormats: [{ ...config.customFormats[0], scoreOverride: 77 }],
			qualityProfile: { upgradeAllowed: false, minFormatScore: 8 },
		};
		const updated = await request("PUT", `${templates}/${id}`, {
			name: "Synthetic updated",
			description: "Selected edit",
			config: changed,
		});
		expect(updated.statusCode).toBe(200);
		expect(updated.json().template).toMatchObject({
			id,
			name: "Synthetic updated",
			config: changed,
			hasUserModifications: true,
			lastModifiedBy: "owner",
		});
		expect((await request("GET", `${templates}/${id}`)).json().template.config).toEqual(changed);
		expect(
			JSON.parse(
				(await run(() => native.prisma.trashTemplate.findUniqueOrThrow({ where: { id } })))
					.configData,
			),
		).toEqual(changed);
		const copied = await request("POST", `${templates}/${id}/duplicate`, {
			newName: "Synthetic copy",
		});
		expect(copied.statusCode).toBe(201);
		expect(copied.json().template.config).toEqual(changed);
		expect(copied.json().template.id).not.toBe(id);
		const listed = await request("GET", templates);
		expect(listed.statusCode).toBe(200);
		expect(
			listed
				.json()
				.templates.map((t: { id: string }) => t.id)
				.sort(),
		).toEqual(["selected", "peer", id, copied.json().template.id].sort());
		expect((await request("DELETE", `${templates}/${id}`)).statusCode).toBe(200);
		expect((await request("GET", `${templates}/${id}`)).statusCode).toBe(404);
		expect(
			(await run(() => native.prisma.trashTemplate.findUniqueOrThrow({ where: { id } }))).deletedAt,
		).toBeInstanceOf(Date);
		expect(
			(await request("GET", `${templates}?includeDeleted=true`))
				.json()
				.templates.some((t: { id: string }) => t.id === id),
		).toBe(true);
		expect((await templateRows()).filter((t) => before.some((b) => b.id === t.id))).toEqual(before);
	});
	it("T2 refuses foreign/missing template edits, deletes and copies without disclosure or SQL changes", async () => {
		const before = await templateRows();
		for (const id of ["foreign", "missing"]) {
			expect.soft((await request("GET", `${templates}/${id}`)).statusCode).toBe(404);
			for (const [method, suffix, body] of [
				["PUT", "", { name: "Attempted edit" }],
				["POST", "/duplicate", { newName: "Attempted copy" }],
				["DELETE", "", undefined],
			] as const) {
				const response = await request(method, `${templates}/${id}${suffix}`, body);
				expect.soft(response.statusCode, `${method} ${id}${suffix} must refuse`).toBe(404);
				expect.soft(response.body).not.toContain("999");
				expect.soft(response.json()).not.toHaveProperty("template");
			}
		}
		expect(
			(await request("PUT", `${templates}/selected`, { config: { customFormats: "invalid" } }))
				.statusCode,
		).toBe(400);
		expect(await templateRows()).toEqual(before);
	});
	it("T3 persists saved-link schedule create/read/update/toggle/delete without executing a scheduler", async () => {
		const before = await scheduleRows();
		const links = await run(() =>
			native.prisma.templateQualityProfileMapping.findMany({ orderBy: { id: "asc" } }),
		);
		const started = Date.now();
		const created = await request("POST", schedules, {
			templateId: "selected",
			instanceId: "selected",
			frequency: "WEEKLY",
		});
		expect(created.statusCode).toBe(201);
		const id: string = created.json().data.id;
		expect(created.json().data).toMatchObject({
			userId: "owner",
			frequency: "WEEKLY",
			enabled: true,
			autoApply: false,
			notifyUser: true,
			lastRunAt: null,
		});
		const next = Date.parse(created.json().data.nextRunAt);
		expect(next).toBeGreaterThanOrEqual(started + 7 * 86400000);
		expect(next).toBeLessThanOrEqual(Date.now() + 7 * 86400000);
		expect(
			(await request("GET", `${schedules}/by-link?templateId=selected&instanceId=selected`)).json()
				.data.id,
		).toBe(id);
		expect(
			(
				await request("POST", schedules, {
					templateId: "selected",
					instanceId: "selected",
					frequency: "DAILY",
				})
			).statusCode,
		).toBe(409);
		const updated = await request("PUT", `${schedules}/${id}`, {
			frequency: "MONTHLY",
			autoApply: true,
			notifyUser: false,
		});
		expect(updated.statusCode).toBe(200);
		expect(updated.json().data).toMatchObject({
			frequency: "MONTHLY",
			autoApply: true,
			notifyUser: false,
		});
		expect(Date.parse(updated.json().data.nextRunAt)).toBeGreaterThan(next);
		const toggled = await request("PUT", `${schedules}/${id}`, { enabled: false });
		expect(toggled.statusCode).toBe(200);
		expect(toggled.json().data.nextRunAt).toBe(updated.json().data.nextRunAt);
		expect(
			await run(() => native.prisma.trashSyncSchedule.findUniqueOrThrow({ where: { id } })),
		).toMatchObject({ enabled: false, frequency: "MONTHLY", lastRunAt: null });
		const listed = await request("GET", schedules);
		expect(listed.statusCode).toBe(200);
		expect(
			listed
				.json()
				.data.map((s: { id: string }) => s.id)
				.sort(),
		).toEqual([id, "schedule-peer"].sort());
		expect((await request("DELETE", `${schedules}/${id}`)).statusCode).toBe(200);
		expect(
			(await request("GET", `${schedules}/by-link?templateId=selected&instanceId=selected`)).json()
				.data,
		).toBeNull();
		expect(await scheduleRows()).toEqual(before);
		expect(
			await run(() =>
				native.prisma.templateQualityProfileMapping.findMany({ orderBy: { id: "asc" } }),
			),
		).toEqual(links);
	});
	it("T4 rejects invalid/foreign schedule targets and scopes by-link reads without native mutations", async () => {
		const before = await scheduleRows(),
			beforeTemplates = await templateRows();
		for (const id of ["schedule-foreign", "missing"])
			for (const method of ["PUT", "DELETE"])
				expect(
					(
						await request(
							method,
							`${schedules}/${id}`,
							method === "PUT" ? { enabled: false } : undefined,
						)
					).statusCode,
				).toBe(404);
		for (const [templateId, instanceId] of [
			["foreign", "selected"],
			["selected", "foreign"],
			["missing", "selected"],
			["selected", "missing"],
		])
			expect(
				(await request("POST", schedules, { templateId, instanceId, frequency: "DAILY" }))
					.statusCode,
			).toBe(404);
		expect(
			(
				await request("POST", schedules, {
					templateId: "selected",
					instanceId: "selected",
					frequency: "HOURLY",
				})
			).statusCode,
		).toBe(400);
		expect(
			(await request("PUT", `${schedules}/schedule-peer`, { frequency: "HOURLY" })).statusCode,
		).toBe(400);
		expect(
			(await request("GET", `${schedules}/by-link?templateId=foreign&instanceId=foreign`)).json()
				.data,
		).toBeNull();
		expect((await request("GET", `${schedules}/by-link?templateId=selected`)).statusCode).toBe(400);
		expect(await scheduleRows()).toEqual(before);
		expect(await templateRows()).toEqual(beforeTemplates);
	});
});
