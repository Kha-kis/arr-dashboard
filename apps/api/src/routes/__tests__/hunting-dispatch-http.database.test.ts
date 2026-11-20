import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ArrClientFactory } from "../../lib/arr/client-factory.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import { openRestoreRuntime } from "../../lib/backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../lib/backup/runtime-schema-startup.js";
import { getHuntingScheduler } from "../../lib/hunting/scheduler.js";
import { registerHuntingRoutes } from "../hunting.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

type Event = {
	instance: string;
	method: string;
	path: string;
	query: Record<string, string>;
	body: unknown;
};
const branches = [
	{
		service: "SONARR",
		id: "sonarr",
		version: "v3",
		parentPath: "series",
		parent: {
			id: 12,
			title: "Synthetic series",
			monitored: true,
			tags: [],
			qualityProfileId: 1,
			status: "continuing",
			year: 2020,
			statistics: { episodeFileCount: 0 },
		},
		wanted: {
			id: 13,
			seriesId: 12,
			title: "Synthetic episode",
			seasonNumber: 1,
			episodeNumber: 1,
			monitored: true,
			hasFile: false,
			airDateUtc: "2020-01-01T00:00:00Z",
		},
		command: { name: "EpisodeSearch", episodeIds: [13] },
		mediaType: "episode",
		mediaId: 13,
	},
	{
		service: "RADARR",
		id: "radarr",
		version: "v3",
		parentPath: "movie",
		parent: {
			id: 12,
			title: "Synthetic movie",
			year: 2020,
			monitored: true,
			hasFile: false,
			tags: [],
			qualityProfileId: 1,
			status: "released",
			digitalRelease: "2020-01-01T00:00:00Z",
		},
		wanted: {
			id: 12,
			title: "Synthetic movie",
			year: 2020,
			monitored: true,
			hasFile: false,
			tags: [],
			qualityProfileId: 1,
			status: "released",
			digitalRelease: "2020-01-01T00:00:00Z",
		},
		command: { name: "MoviesSearch", movieIds: [12] },
		mediaType: "movie",
		mediaId: 12,
	},
	{
		service: "LIDARR",
		id: "lidarr",
		version: "v1",
		parentPath: "artist",
		parent: {
			id: 12,
			artistName: "Synthetic artist",
			monitored: true,
			tags: [],
			qualityProfileId: 1,
			status: "continuing",
		},
		wanted: {
			id: 13,
			artistId: 12,
			title: "Synthetic album",
			monitored: true,
			releaseDate: "2020-01-01T00:00:00Z",
			statistics: { trackFileCount: 0 },
		},
		command: { name: "AlbumSearch", albumIds: [13] },
		mediaType: "album",
		mediaId: 13,
	},
	{
		service: "READARR",
		id: "readarr",
		version: "v1",
		parentPath: "author",
		parent: {
			id: 12,
			authorName: "Synthetic author",
			monitored: true,
			tags: [],
			qualityProfileId: 1,
			status: "continuing",
		},
		wanted: {
			id: 13,
			authorId: 12,
			title: "Synthetic book",
			monitored: true,
			releaseDate: "2020-01-01T00:00:00Z",
			statistics: { bookFileCount: 0 },
		},
		command: { name: "BookSearch", bookIds: [13] },
		mediaType: "book",
		mediaId: 13,
	},
] as const;

// Real singleton scheduler/executor/SQL/encryption/factory/installed SDK and HTTP.
// Session identity is injected; no provider implementation or clock is mocked.
describe("Hunting native installed-SDK dispatch", () => {
	const app = Fastify({ logger: false }),
		encryptor = new Encryptor("48".repeat(32)),
		scheduler = getHuntingScheduler();
	let runtime: Awaited<ReturnType<typeof openRestoreRuntime>>,
		native: ReturnType<typeof createRuntimePrismaClient>;
	let directory: string, database: string, baseUrl: string;
	const run = <T>(fn: () => Promise<T>) => runtime.runOperation(fn);
	const request = (method: string, url: string, body?: unknown) =>
		run(() => createInjectAuthenticated(app)(method, url, { body }));
	const events: Event[] = [],
		errors: string[] = [],
		tasks = new Set<Promise<void>>(),
		observations: unknown[] = [];
	const server = createServer((req, res) => {
		const task = (async () => {
			const url = new URL(req.url!, "http://synthetic.invalid"),
				match = /^\/(sonarr|radarr|lidarr|readarr|refused)\/api\/(v1|v3)\/(.+)$/.exec(url.pathname);
			assert(match, `Unexpected path ${url.pathname}`);
			assert.equal(req.headers["x-api-key"], "synthetic-hunt-key");
			let raw = "";
			for await (const chunk of req) {
				raw += String(chunk);
				assert(raw.length < 8192);
			}
			const event: Event = {
				instance: match[1]!,
				method: req.method!,
				path: `/api/${match[2]}/${match[3]}`,
				query: Object.fromEntries(url.searchParams),
				body: raw ? JSON.parse(raw) : null,
			};
			events.push(event);
			const branch = branches.find((b) => b.id === event.instance) ?? branches[1];
			assert.equal(match[2], branch.version);
			const send = (body: unknown, status = 200) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(body));
			};
			if (event.method === "GET" && match[3] === "queue") {
				send(
					event.instance === "refused"
						? { message: "Synthetic queue read refused" }
						: { page: 1, pageSize: 1, totalRecords: 0, records: [] },
					event.instance === "refused" ? 422 : 200,
				);
				return;
			}
			if (event.method === "GET" && match[3] === branch.parentPath) {
				send([branch.parent]);
				return;
			}
			if (event.method === "GET" && match[3] === "wanted/missing") {
				send({ page: 1, pageSize: 1000, totalRecords: 1, records: [branch.wanted] });
				return;
			}
			if (event.method === "GET" && match[3] === "history") {
				send({ page: 1, pageSize: 100, totalRecords: 0, records: [] });
				return;
			}
			if (event.method === "POST" && match[3] === "command") {
				send(
					{
						id: 51,
						name: branch.command.name,
						status: "queued",
						queued: new Date().toISOString(),
						body: event.body,
					},
					201,
				);
				return;
			}
			throw new Error(`Unexpected request ${event.method} ${event.path}`);
		})().catch((error: unknown) => {
			errors.push(String(error));
			res.destroy();
		});
		tasks.add(task);
		void task.finally(() => tasks.delete(task));
	});
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "hunting-sdk-"));
		database = join(directory, "fixture.db");
		new Database(database).close();
		await synchronizeRuntimeSchema(`file:${database}`);
		runtime = await openRestoreRuntime({ databaseUrl: `file:${database}` });
		await runtime.bindDestination("synthetic-hunting-sdk");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		baseUrl = `http://127.0.0.1:${address.port}`;
		app.decorate("prisma", native.prisma);
		app.decorate("restoreRuntime", runtime);
		app.decorate("encryptor", encryptor);
		app.decorate("arrClientFactory", new ArrClientFactory(encryptor));
		app.decorate("huntingSchedulerEnabled", true);
		setupAuthInjection(app, { id: "owner" });
		registerTestErrorHandler(app);
		await app.register(registerHuntingRoutes, { prefix: "/api" });
		await app.ready();
		await run(async () => {
			await native.prisma.user.create({ data: { id: "owner", username: "synthetic-owner" } });
			for (const branch of [...branches, { ...branches[1], id: "refused" }]) {
				const key = encryptor.encrypt("synthetic-hunt-key");
				await native.prisma.serviceInstance.create({
					data: {
						id: branch.id,
						userId: "owner",
						service: branch.service,
						label: `Synthetic ${branch.id}`,
						baseUrl: `${baseUrl}/${branch.id}`,
						encryptedApiKey: key.value,
						encryptionIv: key.iv,
					},
				});
				await native.prisma.huntConfig.create({
					data: {
						instanceId: branch.id,
						missingBatchSize: 1,
						queueThreshold: 25,
						monitoredOnly: true,
					},
				});
			}
		});
		await run(() => scheduler.initialize(app));
	});
	afterEach(() => {
		expect(errors).toEqual([]);
	});
	afterAll(async () => {
		await scheduler.shutdown();
		await app.close();
		server.closeAllConnections();
		await Promise.all([...tasks]);
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		expect(server.listening).toBe(false);
		expect(tasks.size).toBe(0);
		await native?.close();
		await runtime?.close();
		const checks = [];
		for (const file of [
			database,
			`${database}.arr-restore-runtime/owner.sqlite3`,
			`${database}.arr-restore-runtime/operations.sqlite3`,
		]) {
			if (!existsSync(file)) continue;
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
		if (process.env.ARR_AUTOMATION_EVIDENCE_DIR)
			await writeFile(
				join(process.env.ARR_AUTOMATION_EVIDENCE_DIR, "hunting-dispatch-closure.json"),
				JSON.stringify({
					schedulerStopped: !scheduler.isRunning(),
					serverClosed: true,
					pendingHttpTasks: tasks.size,
					errors,
					observations,
					checks,
				}),
			);
		await rm(directory, { recursive: true, force: true });
	});
	it.each(branches)(
		"dispatches $service through the actual scheduler and installed SDK and records terminal state",
		// Each real hunt waits ten seconds before observing provider grab history.
		{ timeout: 30_000 },
		async (branch) => {
			const start = events.length,
				started = Date.now();
			const trigger = await request("POST", `/api/hunting/trigger/${branch.id}`, {
				type: "missing",
			});
			expect(trigger.statusCode).toBe(200);
			expect(trigger.json()).toMatchObject({ queued: true });
			const duplicate = await request("POST", `/api/hunting/trigger/${branch.id}`, {
				type: "missing",
			});
			expect(duplicate.statusCode).toBe(429);
			expect(duplicate.json()).toMatchObject({ queued: false });
			await expect
				.poll(
					async () =>
						(
							await run(() =>
								native.prisma.huntLog.findFirst({
									where: { instanceId: branch.id },
									orderBy: { startedAt: "desc" },
								}),
							)
						)?.status,
					{ timeout: 20000 },
				)
				.toBe("completed");
			await expect
				.poll(
					async () =>
						(
							await run(() =>
								native.prisma.huntConfig.findUnique({ where: { instanceId: branch.id } }),
							)
						)?.lastMissingHunt,
					{ timeout: 3000 },
				)
				.not.toBeNull();
			const wire = events.slice(start);
			expect(wire.every((e) => e.instance === branch.id)).toBe(true);
			expect(wire.filter((e) => e.method === "POST")).toEqual([
				{
					instance: branch.id,
					method: "POST",
					path: `/api/${branch.version}/command`,
					query: {},
					body: branch.command,
				},
			]);
			expect(wire.some((e) => e.path === `/api/${branch.version}/wanted/missing`)).toBe(true);
			expect(wire.some((e) => e.path === `/api/${branch.version}/history`)).toBe(true);
			const logs = await request("GET", `/api/hunting/logs?instanceId=${branch.id}`);
			expect(logs.json()).toMatchObject({
				totalCount: 1,
				logs: [
					{
						instanceId: branch.id,
						huntType: "missing",
						status: "completed",
						itemsSearched: 1,
						itemsGrabbed: 0,
					},
				],
			});
			const config = (await request("GET", "/api/hunting/configs"))
				.json()
				.configs.find((c: { instanceId: string }) => c.instanceId === branch.id);
			expect(config.apiCallsThisHour).toBeGreaterThanOrEqual(4);
			expect(config.lastMissingHunt).not.toBeNull();
			expect(
				await run(() =>
					native.prisma.huntSearchHistory.findMany({
						where: { config: { instanceId: branch.id } },
					}),
				),
			).toMatchObject([
				{
					mediaType: branch.mediaType,
					mediaId: branch.mediaId,
					huntType: "missing",
					searchCount: 1,
				},
			]);
			observations.push({ service: branch.service, elapsedMs: Date.now() - started, wire });
		},
	);
	it("records a refused provider read as error with no command or searched history", async () => {
		const start = events.length;
		expect(
			(await request("POST", "/api/hunting/trigger/refused", { type: "missing" })).statusCode,
		).toBe(200);
		await expect
			.poll(
				async () =>
					(await run(() => native.prisma.huntLog.findFirst({ where: { instanceId: "refused" } })))
						?.status,
				{ timeout: 5000 },
			)
			.toBe("error");
		const wire = events.slice(start);
		expect(wire.map((e) => ({ method: e.method, path: e.path }))).toEqual([
			{ method: "GET", path: "/api/v3/queue" },
		]);
		expect(
			await run(() =>
				native.prisma.huntSearchHistory.count({ where: { config: { instanceId: "refused" } } }),
			),
		).toBe(0);
		expect((await request("GET", "/api/hunting/logs?instanceId=refused")).json()).toMatchObject({
			totalCount: 1,
			logs: [{ status: "error", itemsSearched: 0, itemsGrabbed: 0 }],
		});
		observations.push({ service: "RADARR", refused: true, wire });
	});
});
