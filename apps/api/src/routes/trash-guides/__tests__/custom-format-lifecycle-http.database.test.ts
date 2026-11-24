import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRASH_CONFIG_TYPES } from "@arr/shared";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../../lib/__tests__/test-prisma.js";
import { ArrClientFactory } from "../../../lib/arr/client-factory.js";
import { Encryptor } from "../../../lib/auth/encryption.js";
import { synchronizeRuntimeSchema } from "../../../lib/backup/runtime-schema-startup.js";
import { acquireCleanupRunLease } from "../../../lib/library-cleanup/cleanup-run-lease.js";
import { createDeploymentConnectionStateToken } from "../../../lib/trash-guides/deployment-target.js";
import { DeploymentExecutorService } from "../../../lib/trash-guides/deployment-executor.js";
import { registerSyncRoutes } from "../sync-routes.js";
import { createCacheManager } from "../../../lib/trash-guides/cache-manager.js";
import { registerCustomFormatRoutes } from "../custom-format-routes.js";
import { registerUserCustomFormatRoutes } from "../user-custom-format-routes.js";

type Event = { instance: string; method: string; path: string; body: unknown };
type WireCF = {
	id: number;
	name: string;
	includeCustomFormatWhenRenaming: boolean;
	specifications: unknown[];
};
describe("standalone and user custom format native lifecycle HTTP", () => {
	const prefix = "/api/trash-guides/custom-formats",
		evidenceName = "custom-format-native.json";
	const userPrefix = "/api/trash-guides/user-custom-formats";
	const specifications = [
		{
			name: "Synthetic condition",
			implementation: "ReleaseTitleSpecification",
			negate: false,
			required: true,
			fields: { value: "synthetic" },
		},
	];
	const formats = new Map<string, WireCF[]>();
	let sourceMode: "complete" | "valid-empty" | "late-loss" = "complete";
	const register = async (app: ReturnType<typeof Fastify>) => {
		await app.register(registerCustomFormatRoutes, { prefix });
		await app.register(registerUserCustomFormatRoutes, { prefix: userPrefix });
		await app.register(registerSyncRoutes, { prefix: "/api/trash-guides/sync" });
	};
	const reset = async () => {
		sourceMode = "complete";
		await prisma.libraryCleanupConfig.deleteMany();
		await prisma.trashSyncHistory.deleteMany();
		await prisma.standaloneCFDeployment.deleteMany();
		await prisma.userCustomFormat.deleteMany();
		for (const id of ["north", "south", "foreign"]) formats.set(id, []);
		await createCacheManager(prisma).set(
			"RADARR",
			TRASH_CONFIG_TYPES.CUSTOM_FORMATS,
			[
				{
					trash_id: "selected-cache",
					name: "Selected cached CF",
					includeCustomFormatWhenRenaming: true,
					specifications,
				},
				{ trash_id: "unselected-cache", name: "Unselected cached CF", specifications },
			],
			"synthetic-commit",
		);
		respond = (event, response) => {
			if (event.method === "GET" && /^\/api\/v3\/customformat\/\d+$/.test(event.path)) {
				send(
					response,
					formats
						.get(event.instance)!
						.find((format) => format.id === Number(event.path.split("/").at(-1))),
				);
				return;
			}
			assert.equal(event.path, "/api/v3/customformat");
			if (event.method === "GET") {
				send(response, formats.get(event.instance));
				return;
			}
			assert.equal(event.method, "POST");
			if (event.instance === "south") {
				send(response, { message: "synthetic refusal" }, 422);
				return;
			}
			const body = event.body as Omit<WireCF, "id">;
			const stored = { id: 31 + formats.get(event.instance)!.length, ...body };
			formats.get(event.instance)!.push(stored);
			send(response, stored, 201);
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
		app.decorate("deploymentExecutor", new DeploymentExecutorService(prisma, app.arrClientFactory));
		const nativeFetch = globalThis.fetch;
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.startsWith("https://api.github.com/repos/TRaSH-Guides/Guides/commits/"))
				return Response.json({
					sha: "a".repeat(40),
					commit: { author: { date: "2026-11-23T00:00:00Z" }, message: "synthetic" },
					html_url: "https://synthetic.invalid/commit",
				});
			if (
				url.startsWith("https://api.github.com/repos/TRaSH-Guides/Guides/contents/") &&
				url.endsWith("?ref=" + "a".repeat(40))
			)
				return Response.json(
					sourceMode === "late-loss"
						? [
								{ name: "synthetic.json", type: "file" },
								{ name: "late.json", type: "file" },
							]
						: [{ name: "synthetic.json", type: "file" }],
				);
			if (
				url.startsWith(
					"https://raw.githubusercontent.com/TRaSH-Guides/Guides/" + "a".repeat(40) + "/",
				) &&
				url.endsWith("/synthetic.json")
			)
				return Response.json(
					sourceMode === "valid-empty"
						? []
						: [
								{
									trash_id: "selected-cache",
									name: "Selected cached CF",
									includeCustomFormatWhenRenaming: true,
									specifications,
								},
								{ trash_id: "unselected-cache", name: "Unselected cached CF", specifications },
							],
				);
			if (
				url.startsWith(
					"https://raw.githubusercontent.com/TRaSH-Guides/Guides/" + "a".repeat(40) + "/",
				) &&
				url.endsWith("/late.json")
			)
				return Response.json({ message: "synthetic late file loss" }, { status: 422 });
			assert(url.startsWith("http://127.0.0.1:"), "Refuse unexpected external fetch " + url);
			return nativeFetch(input, init);
		});
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (request) => {
			request.currentUser = { id: owner, username: "synthetic-auth" } as typeof request.currentUser;
		});
		await register(app);
		await app.ready();
	});
	let sourcesBefore: unknown;
	let cacheBefore: unknown;
	beforeEach(async () => {
		owner = "owner";
		events.length = 0;
		sourcesBefore = await prisma.serviceInstance.findMany({ orderBy: { id: "asc" } });
		await reset();
		cacheBefore = await prisma.trashCache.findMany();
	});
	afterEach(async (context) => {
		expect(await prisma.serviceInstance.findMany({ orderBy: { id: "asc" } })).toEqual(
			sourcesBefore,
		);
		expect(fixtureErrors).toEqual([]);
		expect(await prisma.trashCache.findMany()).toEqual(cacheBefore);
		observations.push({ name: context.task.name, events: structuredClone(events) });
	});
	afterAll(async () => {
		vi.unstubAllGlobals();
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

	it("C1 selected cached CF tracks only the owned target whose provider accepted", async () => {
		const first = await post("/deploy-multiple", {
			instanceId: "north",
			serviceType: "RADARR",
			trashIds: ["selected-cache"],
		});
		expect(first.statusCode).toBe(200);
		expect(first.json()).toMatchObject({
			success: true,
			created: ["Selected cached CF"],
			updated: [],
			failed: [],
		});
		const second = await post("/deploy-multiple", {
			instanceId: "south",
			serviceType: "RADARR",
			trashIds: ["selected-cache"],
		});
		expect(second.statusCode).toBe(200);
		expect(second.json().success).toBe(false);
		expect(second.json().failed).toHaveLength(1);
		expect(events).toEqual([
			{ instance: "north", method: "GET", path: "/api/v3/customformat", body: null },
			{
				instance: "north",
				method: "POST",
				path: "/api/v3/customformat",
				body: {
					name: "Selected cached CF",
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
				},
			},
			{ instance: "north", method: "GET", path: "/api/v3/customformat/31", body: null },
			{ instance: "south", method: "GET", path: "/api/v3/customformat", body: null },
			{
				instance: "south",
				method: "POST",
				path: "/api/v3/customformat",
				body: {
					name: "Selected cached CF",
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
				},
			},
		]);
		expect(await prisma.standaloneCFDeployment.findMany()).toMatchObject([
			{
				userId: "owner",
				instanceId: "north",
				cfTrashId: "selected-cache",
				cfName: "Selected cached CF",
				serviceType: "RADARR",
				commitHash: JSON.stringify({
					version: 1,
					sources: [
						{ repository: "trash-guides/guides", branch: "master", commitHash: "a".repeat(40) },
					],
				}),
			},
		]);
		expect(await prisma.standaloneCFDeployment.count()).toBe(1);
		expect(formats.get("north")!.map((format) => format.name)).toEqual(["Selected cached CF"]);
		expect(formats.get("south")).toEqual([]);
	});
	it.each(["valid-empty", "late-loss"] as const)(
		"preserves prior cache bytes/hash/generation for %s source",
		async (mode) => {
			sourceMode = mode;
			const response = await post("/deploy-multiple", {
				instanceId: "north",
				serviceType: "RADARR",
				trashIds: ["selected-cache"],
			});
			expect(response.statusCode).toBe(mode === "valid-empty" ? 409 : 500);
			expect(events).toEqual([]);
			expect(await prisma.trashCache.findMany()).toEqual(cacheBefore);
			expect(await prisma.standaloneCFDeployment.count()).toBe(0);
		},
	);
	it("retains an actionable pre-send hold across abandoned execution without replay", async () => {
		const instance = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "north" } });
		const hold = await prisma.trashSyncHistory.create({
			data: {
				userId: "owner",
				instanceId: "north",
				syncType: "MANUAL",
				status: "UNCERTAIN",
				errorLog: JSON.stringify({
					type: "STANDALONE_CUSTOM_FORMATS",
					connectionStateToken: createDeploymentConnectionStateToken(instance),
				}),
				appliedConfigs: "[]",
				failedConfigs: JSON.stringify([
					{ name: "Selected cached CF", trashId: "selected-cache", status: "unconfirmed" },
				]),
			},
		});
		const blocked = await post("/deploy-multiple", {
			instanceId: "north",
			serviceType: "RADARR",
			trashIds: ["selected-cache"],
		});
		expect(blocked.statusCode).toBe(400);
		expect(events).toEqual([]);
		const acknowledged = await app.inject({
			method: "POST",
			url: "/api/trash-guides/sync/" + hold.id + "/acknowledge-review",
		});
		expect(acknowledged.statusCode, acknowledged.body).toBe(200);
		expect(
			(await prisma.trashSyncHistory.findUniqueOrThrow({ where: { id: hold.id } })).status,
		).toBe("FAILED");
		expect(events).toEqual([]);
	});
	it("refuses manual acknowledgement while the same endpoint is sending", async () => {
		const original = respond;
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		respond = (event, response) => {
			if (event.method === "POST" && event.instance === "north") {
				release = () => original(event, response);
				entered();
			} else original(event, response);
		};
		const pending = post("/deploy-multiple", {
			instanceId: "north",
			serviceType: "RADARR",
			trashIds: ["selected-cache"],
		});
		await started;
		try {
			const hold = await prisma.trashSyncHistory.findFirstOrThrow({
				where: { instanceId: "north", userId: "owner" },
			});
			expect(hold.status).toBe("UNCERTAIN");
			const response = await app.inject({
				method: "POST",
				url: "/api/trash-guides/sync/" + hold.id + "/acknowledge-review",
			});
			expect(response.statusCode).toBe(400);
			expect(
				(await prisma.trashSyncHistory.findUniqueOrThrow({ where: { id: hold.id } })).status,
			).toBe("UNCERTAIN");
		} finally {
			release();
		}
		expect((await pending).json().success).toBe(true);
		expect(
			(
				await prisma.trashSyncHistory.findFirstOrThrow({
					where: { instanceId: "north", userId: "owner" },
				})
			).status,
		).toBe("SUCCESS");
	});

	it("renews the database topology lease while a provider request is held", async () => {
		const interval = vi.spyOn(globalThis, "setInterval");
		const original = respond;
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		respond = (event, response) => {
			if (event.method === "POST" && event.instance === "north") {
				release = () => original(event, response);
				entered();
			} else original(event, response);
		};
		const pending = post("/deploy-multiple", {
			instanceId: "north",
			serviceType: "RADARR",
			trashIds: ["selected-cache"],
		});
		await started;
		try {
			const config = await prisma.libraryCleanupConfig.findUniqueOrThrow({
				where: { userId: "owner" },
			});
			const nearExpiry = new Date(Date.now() - 2 * 60 * 60 * 1000 + 10_000);
			await prisma.libraryCleanupConfig.update({
				where: { id: config.id },
				data: { runClaimedAt: nearExpiry },
			});
			const heartbeat = interval.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
			assert.equal(typeof heartbeat, "function");
			(heartbeat as () => void)();
			await vi.waitFor(async () =>
				expect(
					(
						await prisma.libraryCleanupConfig.findUniqueOrThrow({ where: { id: config.id } })
					).runClaimedAt!.getTime(),
				).toBeGreaterThan(nearExpiry.getTime()),
			);
			expect(await acquireCleanupRunLease(prisma, "owner", config.id)).toBeNull();
		} finally {
			interval.mockRestore();
			release();
		}
		expect((await pending).json().success).toBe(true);
	});
	it("keeps the original hold when lease loss permits a connection repoint during an in-flight write", async () => {
		const original = respond;
		const before = await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "north" } });
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		respond = (event, response) => {
			if (event.method === "POST" && event.instance === "north") {
				release = () => original(event, response);
				entered();
			} else original(event, response);
		};
		const pending = post("/deploy-multiple", {
			instanceId: "north",
			serviceType: "RADARR",
			trashIds: ["selected-cache"],
		});
		await started;
		try {
			const hold = await prisma.trashSyncHistory.findFirstOrThrow({
				where: { userId: "owner", instanceId: "north" },
			});
			expect(JSON.parse(hold.errorLog!).connectionStateToken).toBe(
				createDeploymentConnectionStateToken(before),
			);
			await prisma.libraryCleanupConfig.updateMany({
				where: { userId: "owner" },
				data: { runClaimToken: "synthetic-other-owner", runClaimedAt: new Date() },
			});
			await prisma.serviceInstance.update({
				where: { id: "north" },
				data: {
					connectionGeneration: before.connectionGeneration + 1,
					baseUrl: before.baseUrl.replace("/north", "/south"),
				},
			});
			const acknowledgement = await app.inject({
				method: "POST",
				url: "/api/trash-guides/sync/" + hold.id + "/acknowledge-review",
			});
			expect(acknowledgement.statusCode, acknowledgement.body).toBe(409);
			expect(acknowledgement.json().error).toBe("REVIEW_CONNECTION_CHANGED");
			expect(
				(await prisma.trashSyncHistory.findUniqueOrThrow({ where: { id: hold.id } })).status,
			).toBe("UNCERTAIN");
			release();
			const result = await pending;
			expect(result.json()).toMatchObject({
				success: false,
				outcome: "uncertain",
				created: [],
				targets: [{ status: "uncertain", tracked: false }],
			});
			expect(await prisma.standaloneCFDeployment.count()).toBe(0);
			expect(events.filter((event) => event.method === "POST")).toHaveLength(1);
			expect(events.every((event) => event.instance === "north")).toBe(true);
			expect(
				(await prisma.trashSyncHistory.findUniqueOrThrow({ where: { id: hold.id } })).status,
			).toBe("UNCERTAIN");
		} finally {
			if (!formats.get("north")!.length) release();
			await pending;
			await prisma.serviceInstance.update({
				where: { id: "north" },
				data: {
					connectionGeneration: before.connectionGeneration,
					baseUrl: before.baseUrl,
					updatedAt: before.updatedAt,
				},
			});
		}
	});

	it("C2 user-CF CRUD/import/deploy persists normalized fields and selects only requested record", async () => {
		const created = await app.inject({
			method: "POST",
			url: userPrefix + "/",
			payload: { name: "Owned CF", serviceType: "RADARR", specifications, defaultScore: 12 },
		});
		expect(created.statusCode).toBe(201);
		const id = created.json().customFormat.id;
		const updated = await app.inject({
			method: "PUT",
			url: userPrefix + "/" + id,
			payload: {
				name: "Updated owned CF",
				defaultScore: 42,
				includeCustomFormatWhenRenaming: true,
			},
		});
		expect(updated.statusCode).toBe(200);
		const imported = await app.inject({
			method: "POST",
			url: userPrefix + "/import-json",
			payload: {
				serviceType: "RADARR",
				customFormats: [
					{
						name: "Imported not selected",
						specifications: [
							{
								name: "Imported condition",
								implementation: "ReleaseTitleSpecification",
								fields: [{ name: "value", value: "imported" }],
							},
						],
					},
				],
			},
		});
		expect(imported.statusCode).toBe(200);
		expect(imported.json().created).toHaveLength(1);
		const native = await prisma.userCustomFormat.findUniqueOrThrow({ where: { id } });
		expect(native).toMatchObject({
			userId: "owner",
			name: "Updated owned CF",
			defaultScore: 42,
			includeCustomFormatWhenRenaming: true,
		});
		expect(JSON.parse(native.specifications)).toEqual(specifications);
		const importedRow = await prisma.userCustomFormat.findFirstOrThrow({
			where: { name: "Imported not selected" },
		});
		expect(JSON.parse(importedRow.specifications)).toEqual([
			{
				name: "Imported condition",
				implementation: "ReleaseTitleSpecification",
				negate: false,
				required: false,
				fields: { value: "imported" },
			},
		]);
		const listed = await app.inject({ url: userPrefix + "/" });
		expect(listed.statusCode).toBe(200);
		expect(listed.json().customFormats).toHaveLength(2);
		const deployed = await app.inject({
			method: "POST",
			url: userPrefix + "/deploy",
			payload: { instanceId: "north", userCFIds: [id] },
		});
		expect(deployed.statusCode).toBe(200);
		expect(deployed.json()).toMatchObject({
			success: true,
			created: ["Updated owned CF"],
			updated: [],
			failed: [],
		});
		expect(events).toEqual([
			{ instance: "north", method: "GET", path: "/api/v3/customformat", body: null },
			{
				instance: "north",
				method: "POST",
				path: "/api/v3/customformat",
				body: {
					name: "Updated owned CF",
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
				},
			},
		]);
		expect(await prisma.standaloneCFDeployment.count()).toBe(0);
		const deleted = await app.inject({ method: "DELETE", url: userPrefix + "/" + id });
		expect(deleted.statusCode).toBe(200);
		expect(await prisma.userCustomFormat.findUnique({ where: { id } })).toBeNull();
		expect(
			await prisma.userCustomFormat.findUnique({ where: { id: importedRow.id } }),
		).not.toBeNull();
	});
	it("C3 foreign instance and foreign stored CF cannot authorize provider writes", async () => {
		const cached = await post("/deploy-multiple", {
			instanceId: "foreign",
			serviceType: "RADARR",
			trashIds: ["selected-cache"],
		});
		expect(cached.statusCode).toBe(404);
		const foreign = await prisma.userCustomFormat.create({
			data: {
				userId: "other",
				name: "Foreign CF",
				serviceType: "RADARR",
				specifications: JSON.stringify(specifications),
			},
		});
		const stored = await app.inject({
			method: "POST",
			url: userPrefix + "/deploy",
			payload: { instanceId: "north", userCFIds: [foreign.id] },
		});
		expect(stored.statusCode).toBe(404);
		expect(events).toEqual([]);
		expect(await prisma.standaloneCFDeployment.count()).toBe(0);
		expect(await prisma.userCustomFormat.count({ where: { userId: "other" } })).toBe(1);
	});
	it("C4 instance picker/import persists only selected owned CF with normalized fields and no provider write", async () => {
		formats.set("north", [
			{
				id: 11,
				name: "Selected instance CF",
				includeCustomFormatWhenRenaming: true,
				specifications: [
					{
						name: "Imported title",
						implementation: "ReleaseTitleSpecification",
						fields: [{ name: "value", value: "synthetic-import" }],
					},
				],
			},
			{
				id: 12,
				name: "Unselected instance CF",
				includeCustomFormatWhenRenaming: false,
				specifications: [],
			},
		]);
		await prisma.userCustomFormat.createMany({
			data: [
				{
					id: "owner-peer",
					userId: "owner",
					name: "Owned peer CF",
					serviceType: "RADARR",
					specifications: "[]",
				},
				{
					id: "foreign-peer",
					userId: "other",
					name: "Selected instance CF",
					serviceType: "RADARR",
					specifications: "[]",
				},
			],
		});
		const before = await prisma.userCustomFormat.findMany({ orderBy: { id: "asc" } });
		const picker = await app.inject({ url: userPrefix + "/instance-cfs/north" });
		expect(picker.statusCode).toBe(200);
		expect(picker.json()).toEqual({
			success: true,
			data: [
				{ id: 11, name: "Selected instance CF" },
				{ id: 12, name: "Unselected instance CF" },
			],
		});
		const imported = await app.inject({
			method: "POST",
			url: userPrefix + "/import-from-instance",
			payload: { instanceId: "north", cfIds: [11], defaultScore: 37 },
		});
		expect(imported.statusCode).toBe(200);
		expect(imported.json()).toEqual({
			success: true,
			created: ["Selected instance CF"],
			skipped: [],
			failed: [],
		});
		const row = await prisma.userCustomFormat.findFirstOrThrow({
			where: { userId: "owner", name: "Selected instance CF" },
		});
		expect(row).toMatchObject({
			userId: "owner",
			serviceType: "RADARR",
			includeCustomFormatWhenRenaming: true,
			defaultScore: 37,
			sourceInstanceId: "north",
			sourceCFId: 11,
		});
		expect(JSON.parse(row.specifications)).toEqual([
			{
				name: "Imported title",
				implementation: "ReleaseTitleSpecification",
				negate: false,
				required: false,
				fields: { value: "synthetic-import" },
			},
		]);
		expect(
			await prisma.userCustomFormat.findMany({
				where: { id: { not: row.id } },
				orderBy: { id: "asc" },
			}),
		).toEqual(before);
		expect(await prisma.userCustomFormat.count({ where: { name: "Unselected instance CF" } })).toBe(
			0,
		);
		expect(events).toEqual([
			{ instance: "north", method: "GET", path: "/api/v3/customformat", body: null },
			{ instance: "north", method: "GET", path: "/api/v3/customformat", body: null },
		]);
		const allRows = await prisma.userCustomFormat.findMany({ orderBy: { id: "asc" } });
		expect((await app.inject({ url: userPrefix + "/instance-cfs/foreign" })).statusCode).toBe(404);
		expect(
			(
				await app.inject({
					method: "POST",
					url: userPrefix + "/import-from-instance",
					payload: { instanceId: "foreign", cfIds: [11] },
				})
			).statusCode,
		).toBe(404);
		expect(events).toHaveLength(2);
		expect(await prisma.userCustomFormat.findMany({ orderBy: { id: "asc" } })).toEqual(allRows);
		expect(await prisma.standaloneCFDeployment.count()).toBe(0);
	});
});
