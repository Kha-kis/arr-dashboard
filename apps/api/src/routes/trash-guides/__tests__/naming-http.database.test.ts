import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../../lib/__tests__/test-prisma.js";
import { ArrClientFactory } from "../../../lib/arr/client-factory.js";
import { Encryptor } from "../../../lib/auth/encryption.js";
import { synchronizeRuntimeSchema } from "../../../lib/backup/runtime-schema-startup.js";
import { createCacheManager } from "../../../lib/trash-guides/cache-manager.js";
import { TRASH_CONFIG_TYPES } from "@arr/shared";
import { namingRoutes } from "../naming-routes.js";

type Event = { instance: string; method: string; path: string; body: unknown };
describe("naming HTTP with native history and owned snapshots", () => {
	const prefix = "/api/trash-guides/naming",
		evidenceName = "naming-native.json";
	const selected = { serviceType: "RADARR", filePreset: "Synthetic", folderPreset: null };
	const original = {
		id: 1,
		renameMovies: false,
		standardMovieFormat: "old-file",
		movieFolderFormat: "retained-folder",
		replaceIllegalCharacters: true,
		providerOwned: "retained",
	};
	let current = structuredClone(original),
		refuse = false;
	const register = async (app: ReturnType<typeof Fastify>) => {
		await app.register(namingRoutes, { prefix });
	};
	const reset = async () => {
		current = structuredClone(original);
		refuse = false;
		await prisma.namingDeployHistory.deleteMany();
		await prisma.namingConfig.deleteMany();
		await createCacheManager(prisma).set("RADARR", TRASH_CONFIG_TYPES.NAMING_PRESETS, [
			{
				_service: "RADARR",
				file: { Synthetic: "{Movie CleanTitle} {(Release Year)}" },
				folder: { Synthetic: "not-selected" },
			},
		]);
		respond = (event, response) => {
			assert.equal(event.instance, "north");
			assert.equal(event.path, "/api/v3/config/naming");
			if (event.method === "GET") {
				send(response, current);
				return;
			}
			assert.equal(event.method, "PUT");
			if (refuse) {
				send(response, { message: "synthetic refusal" }, 422);
				return;
			}
			current = event.body as typeof current;
			send(response, current);
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

	it("N1 preview reads live naming but does not write provider, config or history", async () => {
		const response = await post("/preview", {
			instanceId: "north",
			selectedPresets: selected,
			enableRename: true,
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().success).toBe(true);
		expect(events.map(({ method, path }) => ({ method, path }))).toEqual([
			{ method: "GET", path: "/api/v3/config/naming" },
		]);
		expect(current).toEqual(original);
		expect(await prisma.namingDeployHistory.count()).toBe(0);
		expect(await prisma.namingConfig.count()).toBe(0);
	});
	it("N2 applies only selected settings and persists native success/history", async () => {
		const response = await post("/apply", {
			instanceId: "north",
			selectedPresets: selected,
			enableRename: true,
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().success).toBe(true);
		expect(events).toEqual([
			{ instance: "north", method: "GET", path: "/api/v3/config/naming", body: null },
			{
				instance: "north",
				method: "PUT",
				path: "/api/v3/config/naming",
				body: {
					id: 1,
					renameMovies: true,
					standardMovieFormat: "{Movie CleanTitle} {(Release Year)}",
					movieFolderFormat: "retained-folder",
					replaceIllegalCharacters: true,
					providerOwned: "retained",
				},
			},
		]);
		const row = await prisma.namingDeployHistory.findUniqueOrThrow({
			where: { id: response.json().historyId },
		});
		expect(row).toMatchObject({
			instanceId: "north",
			userId: "owner",
			status: "SUCCESS",
			rolledBack: false,
		});
		expect(JSON.parse(row.previousConfig!)).toEqual(original);
		expect(JSON.parse(row.selectedPresets)).toEqual(selected);
		expect(await prisma.namingConfig.findUnique({ where: { instanceId: "north" } })).toMatchObject({
			lastDeployStatus: "SUCCESS",
			userId: "owner",
		});
		const history = await app.inject({ url: prefix + "/history?instanceId=north" });
		expect(history.statusCode).toBe(200);
		expect(history.json().data.history).toHaveLength(1);
		expect(history.json().data.history[0]).toMatchObject({ id: row.id, status: "SUCCESS" });
	});
	it("N3 provider refusal persists FAILED, never completed", async () => {
		refuse = true;
		const response = await post("/apply", { instanceId: "north", selectedPresets: selected });
		expect(response.statusCode).toBe(502);
		expect(response.json().success).toBe(false);
		expect(current).toEqual(original);
		expect(await prisma.namingDeployHistory.findMany()).toMatchObject([
			{ status: "FAILED", userId: "owner" },
		]);
		expect(await prisma.namingDeployHistory.count({ where: { status: "SUCCESS" } })).toBe(0);
		expect(await prisma.namingConfig.findUnique({ where: { instanceId: "north" } })).toMatchObject({
			lastDeployStatus: "FAILED",
		});
	});
	it("N4 rollback writes the stored full snapshot and records native rollback", async () => {
		const applied = await post("/apply", {
			instanceId: "north",
			selectedPresets: selected,
			enableRename: true,
		});
		expect(applied.statusCode).toBe(200);
		const historyId = applied.json().historyId;
		events.length = 0;
		const response = await post("/rollback", { historyId });
		expect(response.statusCode).toBe(200);
		expect(response.json().success).toBe(true);
		expect(events).toEqual([
			{ instance: "north", method: "PUT", path: "/api/v3/config/naming", body: original },
		]);
		expect(current).toEqual(original);
		expect(await prisma.namingDeployHistory.findUnique({ where: { id: historyId } })).toMatchObject(
			{ status: "SUCCESS", rolledBack: true },
		);
		expect(
			await prisma.namingDeployHistory.count({ where: { status: "ROLLED_BACK", userId: "owner" } }),
		).toBe(1);
		expect(await prisma.namingConfig.findUnique({ where: { instanceId: "north" } })).toMatchObject({
			lastDeployStatus: "ROLLED_BACK",
		});
	});
});
