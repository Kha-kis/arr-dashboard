import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRASH_CONFIG_TYPES } from "@arr/shared";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../../lib/__tests__/test-prisma.js";
import { ArrClientFactory } from "../../../lib/arr/client-factory.js";
import { Encryptor } from "../../../lib/auth/encryption.js";
import { synchronizeRuntimeSchema } from "../../../lib/backup/runtime-schema-startup.js";
import { createCacheManager } from "../../../lib/trash-guides/cache-manager.js";
import { createTemplateService } from "../../../lib/trash-guides/template-service.js";
import profileCloneRoutes from "../profile-clone-routes.js";

type Event = { instance: string; method: string; path: string; body: unknown };
type WireProfile = {
	id: number;
	name: string;
	upgradeAllowed: boolean;
	cutoff: number;
	minFormatScore: number;
	cutoffFormatScore: number;
	minUpgradeFormatScore?: number;
	items: Array<{ quality: { id: number; name: string }; allowed: boolean }>;
	formatItems: Array<{ format: number; score: number }>;
};
type WireCF = {
	id: number;
	name: string;
	includeCustomFormatWhenRenaming: boolean;
	specifications: Array<{
		name: string;
		implementation: string;
		negate: boolean;
		required: boolean;
		fields: Array<{ name: string; value: string }>;
	}>;
};

describe("profile clone native lifecycle HTTP", () => {
	const prefix = "/api/trash-guides/profile-clone";
	const app = Fastify({ logger: false });
	const encryptor = new Encryptor("75".repeat(32));
	let directory: string, database: string;
	let prisma: ReturnType<typeof createTestPrismaClient>;
	const events: Event[] = [],
		fixtureErrors: string[] = [],
		observations: unknown[] = [];
	const tasks = new Set<Promise<void>>();
	const profiles = new Map<string, WireProfile[]>(),
		formats = new Map<string, WireCF[]>();
	let refuseTarget = false;
	const sourceProfile = (): WireProfile => ({
		id: 7,
		name: "Synthetic WEB",
		upgradeAllowed: true,
		cutoff: 1,
		minFormatScore: -10,
		cutoffFormatScore: 500,
		items: [
			{ quality: { id: 1, name: "HDTV-720p" }, allowed: true },
			{ quality: { id: 4, name: "HDTV-1080p" }, allowed: false },
		],
		formatItems: [
			{ format: 42, score: -10000 },
			{ format: 43, score: 0 },
		],
	});
	const wireCF = (id: number, name: string): WireCF => ({
		id,
		name,
		includeCustomFormatWhenRenaming: true,
		specifications: [
			{
				name: "Synthetic condition",
				implementation: "ReleaseTitleSpecification",
				negate: false,
				required: true,
				fields: [{ name: "value", value: "synthetic" }],
			},
		],
	});
	const send = (response: ServerResponse, body: unknown, status = 200) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	};
	// Only authentication and the strict loopback provider are synthetic. Routes,
	// services, native SQL/schema, cache, encryption, factory and installed SDK run.
	const provider = createServer((request, response) => {
		const task = (async () => {
			const url = new URL(request.url!, "http://synthetic.invalid");
			const match = /^\/(north|south|foreign)(\/api\/v3\/.*)$/.exec(url.pathname);
			assert(match, `Unexpected provider path ${url.pathname}`);
			assert.equal(request.headers["x-api-key"], "synthetic-trash-key");
			assert.equal(url.search, "");
			let text = "";
			for await (const chunk of request) {
				text += String(chunk);
				assert(text.length < 65536);
			}
			const event: Event = {
				instance: match[1]!,
				method: request.method!,
				path: match[2]!,
				body: text ? JSON.parse(text) : null,
			};
			events.push(event);
			if (event.method === "GET" && event.path === "/api/v3/customformat") {
				send(response, formats.get(event.instance));
				return;
			}
			if (event.method === "GET" && event.path === "/api/v3/qualityprofile") {
				send(response, profiles.get(event.instance));
				return;
			}
			const profileMatch = /^\/api\/v3\/qualityprofile\/(7|70|71)$/.exec(event.path);
			assert(profileMatch, `Unexpected route ${event.path}`);
			const rows = profiles.get(event.instance)!;
			const index = rows.findIndex((p) => p.id === Number(profileMatch[1]));
			assert(index >= 0, "Unexpected profile identity");
			if (event.method === "GET") {
				send(response, rows[index]);
				return;
			}
			assert.equal(event.instance, "south");
			assert.equal(event.method, "PUT");
			assert.equal(profileMatch[1], "70");
			if (refuseTarget) {
				send(response, { message: "synthetic selected target refusal" }, 422);
				return;
			}
			const body = event.body as WireProfile;
			assert.equal(body.id, 70);
			// ARR PUT receives the complete replacement resource; omitted live fields
			// are not silently restored by this peer.
			rows[index] = structuredClone(body);
			send(response, rows[index]);
		})().catch((error: unknown) => {
			fixtureErrors.push(String(error));
			response.destroy();
		});
		tasks.add(task);
		void task.finally(() => tasks.delete(task));
	});
	const post = (path: string, payload: unknown) =>
		app.inject({ method: "POST", url: prefix + path, payload: payload as Record<string, unknown> });
	const details = (instance = "north", id = 7) =>
		app.inject({ url: `${prefix}/profile-details/${instance}/${id}` });
	const writes = () => events.filter((e) => e.method !== "GET");
	const counts = async () => ({
		templates: await prisma.trashTemplate.count(),
		mappings: await prisma.templateQualityProfileMapping.count(),
		histories: await prisma.templateDeploymentHistory.count(),
		syncs: await prisma.trashSyncHistory.count(),
	});
	const templateBody = (token: string) => ({
		serviceType: "SONARR",
		trashId: "cloned-north-7",
		templateName: "Reviewed native clone",
		customFormatSelections: {
			"instance-42": { selected: true, conditionsEnabled: {} },
			"instance-43": { selected: false, conditionsEnabled: {} },
		},
		sourceInstanceId: "north",
		sourceProfileId: 7,
		sourceProfileName: "Stale client name",
		sourceInstanceLabel: "Stale client label",
		sourceStateToken: token,
		profileConfig: {
			upgradeAllowed: false,
			cutoff: 4,
			minFormatScore: 999,
			cutoffFormatScore: 999,
			items: [],
		},
	});
	const imported = async () => {
		const response = await post("/import", { instanceId: "north", profileId: 7 });
		expect(response.statusCode).toBe(200);
		return response.json().data.profile;
	};
	const targetBody = (profile: unknown) => ({
		instanceId: "south",
		profile,
		customFormats: [{ trash_id: "Selected CF", score: -10000 }],
		profileName: "Explicit selected clone",
		existingProfileId: 70,
	});
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "arr-clone-native-"));
		database = join(directory, "owned.db");
		new Database(database).close();
		await synchronizeRuntimeSchema(`file:${database}`);
		prisma = createTestPrismaClient(`file:${database}`);
		await prisma.user.createMany({
			data: [
				{ id: "owner", username: "synthetic-owner" },
				{ id: "other", username: "synthetic-other" },
			],
		});
		await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
		const address = provider.address();
		assert(address && typeof address !== "string");
		for (const id of ["north", "south", "foreign"]) {
			const key = encryptor.encrypt("synthetic-trash-key");
			await prisma.serviceInstance.create({
				data: {
					id,
					userId: id === "foreign" ? "other" : "owner",
					service: "SONARR",
					label: `Synthetic ${id}`,
					baseUrl: `http://127.0.0.1:${address.port}/${id}`,
					enabled: true,
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				},
			});
		}
		app.decorate("prisma", prisma);
		app.decorate("encryptor", encryptor);
		app.decorate("dbProvider", "sqlite");
		app.decorate("arrClientFactory", new ArrClientFactory(encryptor, 1000));
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (request) => {
			request.currentUser = {
				id: "owner",
				username: "synthetic-auth",
			} as typeof request.currentUser;
		});
		await app.register(profileCloneRoutes, { prefix });
		await app.ready();
	});
	let sourcesBefore: unknown;
	beforeEach(async () => {
		events.length = 0;
		refuseTarget = false;
		sourcesBefore = await prisma.serviceInstance.findMany({ orderBy: { id: "asc" } });
		await prisma.trashTemplate.deleteMany();
		profiles.set("north", [sourceProfile()]);
		profiles.set("south", [
			{
				...sourceProfile(),
				id: 70,
				name: "Existing selected",
				minUpgradeFormatScore: 77,
				formatItems: [{ format: 142, score: 10 }],
			},
			{ ...sourceProfile(), id: 71, name: "Unselected target record" },
		]);
		profiles.set("foreign", [sourceProfile()]);
		formats.set("north", [wireCF(42, "Selected CF"), wireCF(43, "Unselected CF")]);
		formats.set("south", [wireCF(142, "Selected CF"), wireCF(143, "Unselected target CF")]);
		formats.set("foreign", [wireCF(42, "Selected CF")]);
		const cache = createCacheManager(prisma);
		await cache.set(
			"SONARR",
			TRASH_CONFIG_TYPES.CUSTOM_FORMATS,
			[
				{
					trash_id: "selected-cache",
					name: "Selected CF",
					trash_scores: { default: -10000 },
					specifications: [
						{
							name: "Synthetic condition",
							implementation: "ReleaseTitleSpecification",
							negate: false,
							required: true,
							fields: { value: "synthetic" },
						},
					],
				},
			],
			"synthetic-commit",
		);
		await cache.set(
			"SONARR",
			TRASH_CONFIG_TYPES.QUALITY_PROFILES,
			[
				{
					trash_id: "synthetic-profile",
					name: "Synthetic WEB",
					formatItems: { "Selected CF": "selected-cache" },
				},
			],
			"synthetic-commit",
		);
		await cache.set("SONARR", TRASH_CONFIG_TYPES.CF_GROUPS, [], "synthetic-commit");
	});
	afterEach(async (context) => {
		expect(await prisma.serviceInstance.findMany({ orderBy: { id: "asc" } })).toEqual(
			sourcesBefore,
		);
		expect(fixtureErrors).toEqual([]);
		observations.push({
			name: context.task.name,
			events: structuredClone(events),
			profiles: Object.fromEntries(profiles),
			counts: await counts(),
		});
	});
	afterAll(async () => {
		const errors: string[] = [];
		let sqlDisconnected = false;
		for (const close of [
			() => app.close(),
			async () => {
				provider.closeAllConnections();
				await new Promise<void>((resolve, reject) =>
					provider.close((error) => (error ? reject(error) : resolve())),
				);
				await Promise.all(tasks);
			},
			async () => {
				await prisma?.$disconnect();
				sqlDisconnected = true;
			},
		]) {
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
			directory?.startsWith(join(tmpdir(), "arr-clone-native-")) &&
				database === join(directory, "owned.db"),
			"Refuse unvalidated fixture cleanup",
		);
		await rm(directory, { recursive: true, force: false });
		const evidence = {
			observations,
			fixtureErrors,
			tasksRemaining: tasks.size,
			providerClosed: !provider.listening,
			sqlDisconnected,
			quick,
			foreignKeys,
			cleanupRemoved: !existsSync(directory),
			errors,
		};
		if (process.env.ARR_TRASH_NATIVE_EVIDENCE_DIR)
			await writeFile(
				join(process.env.ARR_TRASH_NATIVE_EVIDENCE_DIR, "profile-clone-native.json"),
				JSON.stringify(evidence, null, 2),
				{ flag: "wx", mode: 0o600 },
			);
		expect(quick).toEqual([{ quick_check: "ok" }]);
		expect(foreignKeys).toEqual([]);
		expect(tasks.size).toBe(0);
		expect(errors).toEqual([]);
		expect(fixtureErrors).toEqual([]);
	});

	it("C1 native import, CF validation and cached match create an owned template from the actual review", async () => {
		const peerBefore = structuredClone(Object.fromEntries(profiles));
		const review = await details();
		expect(review.statusCode).toBe(200);
		expect(review.json().data.sourceStateToken).toMatch(/^[a-f0-9]{64}$/);
		expect(review.json().data.customFormats).toMatchObject([
			{ id: 42, score: -10000 },
			{ id: 43, score: 0 },
		]);
		expect(await imported()).toMatchObject({
			sourceInstanceId: "north",
			sourceProfileId: 7,
			sourceProfileName: "Synthetic WEB",
			cutoffQuality: { id: 1, name: "HDTV-720p" },
		});
		const validation = await post("/validate-cfs", {
			instanceId: "north",
			profileId: 7,
			serviceType: "SONARR",
		});
		expect(validation.statusCode).toBe(200);
		expect(validation.json()).toMatchObject({
			success: true,
			summary: { total: 2 },
			results: [
				{ instanceCF: { id: 42, score: -10000 }, trashCF: { trash_id: "selected-cache" } },
				{ instanceCF: { id: 43, score: 0 }, trashCF: null },
			],
		});
		const match = await post("/match-profile", {
			profileName: "Synthetic WEB",
			serviceType: "SONARR",
		});
		expect(match.statusCode).toBe(200);
		expect(match.json()).toMatchObject({
			matched: true,
			matchedProfile: { trash_id: "synthetic-profile" },
			recommendations: { total: 1, recommendedTrashIds: ["selected-cache"] },
		});
		const created = await post(
			"/create-template",
			templateBody(review.json().data.sourceStateToken),
		);
		expect(created.statusCode).toBe(201);
		const id = created.json().data.template.id;
		const row = await prisma.trashTemplate.findUniqueOrThrow({ where: { id } });
		expect(row).toMatchObject({
			userId: "owner",
			serviceType: "SONARR",
			sourceQualityProfileName: "Synthetic WEB",
			// Synthetic cache inputs do not claim verified repository provenance.
			trashGuidesCommitHash: null,
			description: "Cloned from Synthetic north: Synthetic WEB",
		});
		const readback = await createTemplateService(prisma, "sqlite").getTemplate(id, "owner");
		expect(readback?.config.customFormats).toHaveLength(1);
		expect(readback?.config).toMatchObject({
			customFormats: [
				{
					trashId: "instance-42",
					scoreOverride: -10000,
					originalConfig: { _instanceId: "north", _instanceCFId: 42 },
				},
			],
			completeQualityProfile: {
				sourceInstanceId: "north",
				sourceInstanceLabel: "Synthetic north",
				sourceProfileName: "Synthetic WEB",
				sourceProfileId: 7,
				sourceConnectionStateToken: expect.stringMatching(/^[a-f0-9]{64}$/),
				cutoff: 1,
				upgradeAllowed: true,
				minFormatScore: -10,
				cutoffFormatScore: 500,
				items: [{ allowed: true }, { allowed: false }],
			},
		});
		expect(await createTemplateService(prisma, "sqlite").getTemplate(id, "other")).toBeNull();
		expect(await counts()).toEqual({ templates: 1, mappings: 0, histories: 0, syncs: 0 });
		expect(writes()).toEqual([]);
		expect(Object.fromEntries(profiles)).toEqual(peerBefore);
	});
	it("C2 clone preview and existing-target deploy preserve selected CF scores and unselected live state", async () => {
		const profile = await imported();
		const peerBefore = structuredClone(Object.fromEntries(profiles)),
			formatsBefore = structuredClone(Object.fromEntries(formats));
		const sqlBefore = await counts();
		const beforeInvalid = events.length;
		expect(
			(await post("/deploy", { ...targetBody(profile), existingProfileId: 0 })).statusCode,
		).toBe(400);
		expect(events).toHaveLength(beforeInvalid);
		const preview = await post("/preview", targetBody(profile));
		expect(preview.statusCode).toBe(200);
		expect(preview.json()).toMatchObject({
			success: true,
			data: { customFormats: { total: 1, matched: 1, unmatched: [] } },
		});
		expect(writes()).toEqual([]);
		expect(await counts()).toEqual(sqlBefore);
		expect(Object.fromEntries(profiles)).toEqual(peerBefore);
		// A preview cannot lend authority to changed target definitions. A refused
		// pre-write attempt can be explicitly reviewed again after correction.
		formats.get("south")![0]!.specifications[0]!.fields[0]!.value = "changed-after-preview";
		const drifted = await post("/deploy", targetBody(profile));
		expect(drifted.statusCode).toBe(400);
		expect(drifted.json()).toMatchObject({
			success: false,
			error: expect.stringContaining("Refresh"),
		});
		expect(writes()).toEqual([]);
		expect(await counts()).toEqual(sqlBefore);
		expect(Object.fromEntries(profiles)).toEqual(peerBefore);
		formats.get("south")![0]!.specifications[0]!.fields[0]!.value = "synthetic";
		expect((await post("/preview", targetBody(profile))).json()).toMatchObject({
			success: true,
			data: { customFormats: { matched: 1, unmatched: [] } },
		});
		const deployed = await post("/deploy", targetBody(profile));
		expect(deployed.statusCode).toBe(200);
		expect(deployed.json()).toEqual({ success: true, data: { profileId: 70 } });
		expect(writes()).toHaveLength(1);
		expect(writes()[0]).toMatchObject({
			instance: "south",
			method: "PUT",
			path: "/api/v3/qualityprofile/70",
		});
		const readback = await details("south", 70);
		expect(readback.statusCode).toBe(200);
		// These desired-state checks catch preview/execution disagreement and a
		// replacement PUT built without fetching and preserving live-only fields.
		expect.soft(readback.json().data.customFormats).toMatchObject([{ id: 142, score: -10000 }]);
		expect.soft(profiles.get("south")![0]).toMatchObject({ minUpgradeFormatScore: 77 });
		expect(profiles.get("south")![1]).toEqual(peerBefore.south![1]);
		expect(profiles.get("north")).toEqual(peerBefore.north);
		expect(profiles.get("foreign")).toEqual(peerBefore.foreign);
		expect(Object.fromEntries(formats)).toEqual(formatsBefore);
		expect(await counts()).toEqual(sqlBefore);
	});
	it("C3 live source drift refuses persistence until fresh review and foreign resources never authorize access", async () => {
		const review = await details();
		expect(review.statusCode).toBe(200);
		profiles.get("north")![0]!.minFormatScore = -20;
		formats.get("north")![0]!.specifications[0]!.fields[0]!.value = "changed-live";
		const stale = await post("/create-template", templateBody(review.json().data.sourceStateToken));
		expect(stale.statusCode).toBe(409);
		expect(await counts()).toEqual({ templates: 0, mappings: 0, histories: 0, syncs: 0 });
		expect(writes()).toEqual([]);
		const fresh = await details();
		expect(fresh.statusCode).toBe(200);
		expect(fresh.json().data.sourceStateToken).not.toBe(review.json().data.sourceStateToken);
		const retry = await post("/create-template", templateBody(fresh.json().data.sourceStateToken));
		expect(retry.statusCode).toBe(201);
		const row = await prisma.trashTemplate.findUniqueOrThrow({
			where: { id: retry.json().data.template.id },
		});
		expect(JSON.parse(row.configData)).toMatchObject({
			completeQualityProfile: { minFormatScore: -20 },
			customFormats: [
				{ originalConfig: { specifications: [{ fields: [{ value: "changed-live" }] }] } },
			],
		});
		const beforeForeign = events.length;
		expect((await details("foreign")).statusCode).toBe(404);
		expect((await post("/import", { instanceId: "foreign", profileId: 7 })).statusCode).toBe(400);
		expect(
			(
				await post("/create-template", {
					...templateBody(fresh.json().data.sourceStateToken),
					sourceInstanceId: "foreign",
					templateName: "Forbidden",
				})
			).statusCode,
		).toBe(404);
		const profile = await imported();
		const beforeTarget = events.length;
		expect(
			(await post("/preview", { ...targetBody(profile), instanceId: "foreign" })).statusCode,
		).toBe(400);
		expect(
			(await post("/deploy", { ...targetBody(profile), instanceId: "foreign" })).statusCode,
		).toBe(400);
		expect(events.slice(beforeForeign, beforeTarget).every((e) => e.instance === "north")).toBe(
			true,
		);
		expect(events.slice(beforeTarget)).toEqual([]);
		expect(events.some((e) => e.instance === "foreign")).toBe(false);
		expect(writes()).toEqual([]);
		expect(await prisma.trashTemplate.count()).toBe(1);
	});
	it("C4 selected provider refusal leaves no success tracking or unintended mutation", async () => {
		const profile = await imported();
		const peerBefore = structuredClone(Object.fromEntries(profiles)),
			formatsBefore = structuredClone(Object.fromEntries(formats));
		const sqlBefore = await counts();
		refuseTarget = true;
		const refused = await post("/deploy", targetBody(profile));
		expect(refused.statusCode).toBe(400);
		expect(refused.json()).toMatchObject({ success: false, error: expect.any(String) });
		expect(refused.json().data).toBeUndefined();
		expect(writes()).toHaveLength(1);
		expect(writes()[0]).toMatchObject({
			instance: "south",
			method: "PUT",
			path: "/api/v3/qualityprofile/70",
		});
		expect(Object.fromEntries(profiles)).toEqual(peerBefore);
		expect(Object.fromEntries(formats)).toEqual(formatsBefore);
		expect(await counts()).toEqual(sqlBefore);
		// No replay: this refused replacement has no reviewed execution authority
		// token or persisted outcome that would justify an automatic retry.
	});
});
