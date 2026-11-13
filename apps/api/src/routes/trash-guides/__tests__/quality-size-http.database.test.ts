import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { qualitySizeRoutes } from "../quality-size-routes.js";

type Event = { instance: string; method: string; path: string; body: unknown };
describe("quality size installed-client HTTP and native mapping", () => {
	const prefix = "/api/trash-guides/quality-size",
		evidenceName = "quality-size-native.json";
	const qualities = [{ quality: "WEBDL-1080p", min: 12, preferred: 34, max: 56 }];
	const definitions = [
		{
			id: 7,
			quality: { id: 3, name: "WEBDL-1080p", source: "webdl", resolution: 1080, modifier: "none" },
			title: "Provider display alias",
			weight: 10,
			minSize: 1,
			preferredSize: 2,
			maxSize: 3,
			providerOwned: "retain",
		},
		{
			id: 8,
			quality: { id: 4, name: "Bluray-720p", source: "bluray", resolution: 720, modifier: "none" },
			title: "Bluray-720p",
			weight: 20,
			minSize: 4,
			preferredSize: 5,
			maxSize: 6,
		},
	];
	let refuse = false,
		current = structuredClone(definitions),
		commandState = "not-admitted";
	const register = async (app: ReturnType<typeof Fastify>) => {
		await app.register(qualitySizeRoutes, { prefix });
	};
	const reset = async () => {
		refuse = false;
		current = structuredClone(definitions);
		commandState = "not-admitted";
		await prisma.qualitySizeMapping.deleteMany();
		await createCacheManager(prisma).set("RADARR", TRASH_CONFIG_TYPES.QUALITY_SIZE, [
			{ trash_id: "synthetic-size", type: "Synthetic size", qualities },
		]);
		respond = (event, response) => {
			assert.equal(event.instance, "north");
			if (event.method === "GET" && event.path === "/api/v3/qualitydefinition") {
				send(response, current);
				return;
			}
			if (event.method === "PUT" && event.path === "/api/v3/qualitydefinition/update") {
				if (refuse) {
					send(response, { message: "synthetic refusal" }, 422);
					return;
				}
				current = event.body as typeof current;
				send(response, current);
				return;
			}
			if (event.method === "POST" && event.path === "/api/v3/command") {
				assert.deepEqual(event.body, { name: "ResetQualityDefinitions" });
				commandState = "queued";
				send(
					response,
					{
						id: 71,
						name: "ResetQualityDefinitions",
						status: "queued",
						queued: "2026-01-01T00:00:00Z",
						trigger: "manual",
					},
					201,
				);
				return;
			}
			throw Error("Unexpected quality-size HTTP operation");
		};
	};

	// Real native SQL, routes, cache, encryption, factory and installed SDK.
	// Only authentication and the strictly loopback external HTTP peer are synthetic.
	const app = Fastify({ logger: false });
	const encryptor = new Encryptor("74".repeat(32));
	let directory: string, database: string;
	let prisma: ReturnType<typeof createTestPrismaClient>;
	let owner = "owner";
	const events: Event[] = [],
		fixtureErrors: string[] = [],
		observations: unknown[] = [];
	const tasks = new Set<Promise<void>>();
	let respond: (event: Event, response: ServerResponse) => void;
	const send = (response: ServerResponse, body: unknown, status = 200) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	};
	const provider = createServer((request, response) => {
		const task = (async () => {
			const url = new URL(request.url!, "http://synthetic.invalid");
			const match = /^\/(north|south|foreign)(\/api\/v3\/.*)$/.exec(url.pathname);
			assert(match, "Unexpected provider path " + url.pathname);
			assert.equal(request.headers["x-api-key"], "synthetic-trash-key");
			assert.equal(url.search, "");
			let text = "";
			for await (const chunk of request) {
				text += String(chunk);
				assert(text.length < 65536);
			}
			const event = {
				instance: match[1]!,
				method: request.method!,
				path: match[2]!,
				body: text ? JSON.parse(text) : null,
			};
			events.push(event);
			respond(event, response);
		})().catch((error: unknown) => {
			fixtureErrors.push(String(error));
			response.destroy();
		});
		tasks.add(task);
		void task.finally(() => tasks.delete(task));
	});
	const post = (path: string, payload: unknown) =>
		app.inject({ method: "POST", url: prefix + path, payload: payload as Record<string, unknown> });
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "arr-trash-native-"));
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
		await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
		const address = provider.address();
		assert(address && typeof address !== "string");
		for (const id of ["north", "south", "foreign"]) {
			const key = encryptor.encrypt("synthetic-trash-key");
			await prisma.serviceInstance.create({
				data: {
					id,
					userId: id === "foreign" ? "other" : "owner",
					service: "RADARR",
					label: "Synthetic provider",
					baseUrl: "http://127.0.0.1:" + address.port + "/" + id,
					enabled: true,
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				},
			});
		}
		app.decorate("prisma", prisma);
		app.decorate("encryptor", encryptor);
		app.decorate("arrClientFactory", new ArrClientFactory(encryptor, 1000));
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (request) => {
			request.currentUser = { id: owner, username: "synthetic-auth" } as typeof request.currentUser;
		});
		await register(app);
		await app.ready();
	});
	let sourcesBefore: unknown;
	beforeEach(async () => {
		owner = "owner";
		events.length = 0;
		sourcesBefore = await prisma.serviceInstance.findMany({ orderBy: { id: "asc" } });
		await reset();
	});
	afterEach(async (context) => {
		expect(await prisma.serviceInstance.findMany({ orderBy: { id: "asc" } })).toEqual(
			sourcesBefore,
		);
		expect(fixtureErrors).toEqual([]);
		observations.push({ name: context.task.name, events: structuredClone(events) });
	});
	afterAll(async () => {
		const errors: unknown[] = [];
		for (const close of [
			() => app.close(),
			async () => {
				provider.closeAllConnections();
				await new Promise<void>((resolve, reject) =>
					provider.close((error) => (error ? reject(error) : resolve())),
				);
				await Promise.all(tasks);
			},
			() => prisma?.$disconnect(),
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
		const validDirectory =
			directory &&
			directory.startsWith(join(tmpdir(), "arr-trash-native-")) &&
			database === join(directory, "owned.db");
		assert(validDirectory, "Refuse unvalidated fixture cleanup");
		await rm(directory, { recursive: true, force: false });
		const evidence = {
			observations,
			fixtureErrors,
			tasksRemaining: tasks.size,
			providerClosed: !provider.listening,
			sqlDisconnected: true,
			quick,
			foreignKeys,
			cleanupRemoved: !existsSync(directory),
			errors,
		};
		if (process.env.ARR_TRASH_NATIVE_EVIDENCE_DIR)
			await writeFile(
				join(process.env.ARR_TRASH_NATIVE_EVIDENCE_DIR, evidenceName),
				JSON.stringify(evidence, null, 2),
				{ flag: "wx", mode: 0o600 },
			);
		expect(quick).toEqual([{ quick_check: "ok" }]);
		expect(foreignKeys).toEqual([]);
		expect(tasks.size).toBe(0);
		expect(errors).toEqual([]);
		expect(fixtureErrors).toEqual([]);
	});

	it("S1 maps by live quality name, preserves unselected definitions, persists strategy/hash", async () => {
		const response = await post("/apply", {
			instanceId: "north",
			presetTrashId: "synthetic-size",
			syncStrategy: "notify",
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: true, appliedCount: 1, totalQualities: 1 });
		expect(events).toEqual([
			{ instance: "north", method: "GET", path: "/api/v3/qualitydefinition", body: null },
			{
				instance: "north",
				method: "PUT",
				path: "/api/v3/qualitydefinition/update",
				body: [
					{
						id: 7,
						quality: {
							id: 3,
							name: "WEBDL-1080p",
							source: "webdl",
							resolution: 1080,
							modifier: "none",
						},
						title: "Provider display alias",
						weight: 10,
						minSize: 12,
						preferredSize: 34,
						maxSize: 56,
						providerOwned: "retain",
					},
					{
						id: 8,
						quality: {
							id: 4,
							name: "Bluray-720p",
							source: "bluray",
							resolution: 720,
							modifier: "none",
						},
						title: "Bluray-720p",
						weight: 20,
						minSize: 4,
						preferredSize: 5,
						maxSize: 6,
					},
				],
			},
		]);
		expect(
			await prisma.qualitySizeMapping.findUnique({ where: { instanceId: "north" } }),
		).toMatchObject({
			userId: "owner",
			presetTrashId: "synthetic-size",
			presetType: "Synthetic size",
			serviceType: "RADARR",
			syncStrategy: "notify",
			appliedDataHash: createHash("sha256").update(JSON.stringify(qualities)).digest("hex"),
		});
		const mapping = await app.inject({ url: prefix + "/mapping?instanceId=north" });
		expect(mapping.statusCode).toBe(200);
		expect(mapping.json().mapping).toMatchObject({
			presetTrashId: "synthetic-size",
			syncStrategy: "notify",
		});
	});
	it("S2 upstream refusal cannot publish a successful mapping", async () => {
		refuse = true;
		const response = await post("/apply", {
			instanceId: "north",
			presetTrashId: "synthetic-size",
			syncStrategy: "auto",
		});
		expect(response.statusCode).toBeGreaterThanOrEqual(400);
		expect(response.json().success).not.toBe(true);
		expect(events.map((event) => event.method)).toEqual(["GET", "PUT"]);
		expect(current).toEqual(definitions);
		expect(await prisma.qualitySizeMapping.count()).toBe(0);
	});
	it("S3 default reset admits an actual queued command and removes the stored mapping", async () => {
		const applied = await post("/apply", {
			instanceId: "north",
			presetTrashId: "synthetic-size",
			syncStrategy: "manual",
		});
		expect(applied.statusCode).toBe(200);
		expect(await prisma.qualitySizeMapping.count()).toBe(1);
		const beforeReset = structuredClone(current);
		events.length = 0;
		const response = await post("/apply", { instanceId: "north", presetTrashId: "default" });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: true,
			resetStatus: "requested",
			appliedCount: 0,
			totalQualities: 0,
		});
		expect(response.json().message).toMatch(/requested.*not confirmed/i);
		expect(events).toEqual([
			{
				instance: "north",
				method: "POST",
				path: "/api/v3/command",
				body: { name: "ResetQualityDefinitions" },
			},
		]);
		expect(commandState).toBe("queued");
		expect(current).toEqual(beforeReset);
		expect(await prisma.qualitySizeMapping.count()).toBe(0);
		// There is no in-process worker or polling branch in this route. The HTTP
		// task is joined by inject/teardown; no upstream completion is inferred.
		expect(tasks.size).toBe(0);
	});
	it("S4 fallback direct reset ACK remains requested rather than proven completed", async () => {
		respond = (event, response) => {
			assert.equal(event.instance, "north");
			if (event.method === "POST" && event.path === "/api/v3/command") {
				send(response, { message: "Command unsupported" }, 400);
				return;
			}
			assert.equal(event.method, "PUT");
			assert.equal(event.path, "/api/v3/qualitydefinition/reset");
			send(response, { accepted: true });
		};
		const response = await post("/apply", { instanceId: "north", presetTrashId: "default" });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: true,
			resetStatus: "requested",
			appliedCount: 0,
			totalQualities: 0,
		});
		expect(response.json().message).toMatch(/requested.*not confirmed/i);
		expect(events.map((event) => [event.method, event.path])).toEqual([
			["POST", "/api/v3/command"],
			["PUT", "/api/v3/qualitydefinition/reset"],
		]);
		expect(current).toEqual(definitions);
		expect(await prisma.qualitySizeMapping.count()).toBe(0);
	});
});
