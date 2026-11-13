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
import { registerAutoTagRoutes } from "../auto-tag.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

type Resource = {
	id: number;
	title: string;
	monitored: boolean;
	hasFile: boolean;
	tags: number[];
	qualityProfileId: number;
	tvdbId: number;
	tmdbId: number;
	year: number;
	status: string;
	path: string;
	statistics: { episodeFileCount: number; sizeOnDisk: number };
	sizeOnDisk: number;
	providerOwned: { retain: boolean };
	added: string;
};
type Event = {
	instance: string;
	method: string;
	path: string;
	query: Record<string, string>;
	body: unknown;
};
const resource = (): Resource => ({
	id: 10,
	title: "Synthetic item",
	monitored: true,
	hasFile: true,
	tags: [3],
	qualityProfileId: 9,
	tvdbId: 8401,
	tmdbId: 42,
	year: 2020,
	status: "continuing",
	path: "/synthetic/item",
	statistics: { episodeFileCount: 1, sizeOnDisk: 1234 },
	sizeOnDisk: 1234,
	providerOwned: { retain: true },
	added: "2020-01-01T00:00:00Z",
});

// No native-presence criterion is used: monitored is an owned ARR-data condition.
// The cache proves that field explicitly and the real executor revalidates it live.
describe("AutoTag native rule CRUD and installed-SDK writes", () => {
	const app = Fastify({ logger: false }),
		encryptor = new Encryptor("49".repeat(32));
	let runtime: Awaited<ReturnType<typeof openRestoreRuntime>>,
		native: ReturnType<typeof createRuntimePrismaClient>;
	let directory: string, database: string, baseUrl: string;
	const run = <T>(fn: () => Promise<T>) => runtime.runOperation(fn);
	const request = (method: string, url: string, body?: unknown) =>
		run(() => createInjectAuthenticated(app)(method, url, { body }));
	const resources = new Map<string, Resource>(),
		tags = new Map<string, Array<{ id: number; label: string }>>();
	const events: Event[] = [],
		errors: string[] = [],
		tasks = new Set<Promise<void>>(),
		observations: unknown[] = [];
	const server = createServer((req, res) => {
		const task = (async () => {
			const url = new URL(req.url!, "http://synthetic.invalid"),
				match = /^\/(sonarr|radarr|refused)\/api\/v3\/(series\/10|movie\/10|tag)$/.exec(
					url.pathname,
				);
			assert(match, `Unexpected path ${url.pathname}`);
			assert.equal(req.headers["x-api-key"], "synthetic-tag-key");
			let raw = "";
			for await (const chunk of req) {
				raw += String(chunk);
				assert(raw.length < 16384);
			}
			const event: Event = {
				instance: match[1]!,
				method: req.method!,
				path: `/api/v3/${match[2]}`,
				query: Object.fromEntries(url.searchParams),
				body: raw ? JSON.parse(raw) : null,
			};
			events.push(event);
			const send = (body: unknown, status = 200) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(body));
			};
			if (event.method === "GET" && match[2] === "tag") {
				send(tags.get(event.instance));
				return;
			}
			if (event.method === "POST" && match[2] === "tag") {
				assert.deepEqual(event.body, { label: "reviewed" });
				const created = { id: 7, label: "reviewed" };
				tags.get(event.instance)!.push(created);
				send(created, 201);
				return;
			}
			assert.equal(match[2], event.instance === "sonarr" ? "series/10" : "movie/10");
			if (event.method === "GET") {
				send(resources.get(event.instance));
				return;
			}
			if (event.method === "PUT") {
				if (event.instance === "refused") {
					send({ message: "Synthetic write refused" }, 422);
					return;
				}
				resources.set(event.instance, event.body as Resource);
				send(resources.get(event.instance));
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
		directory = await mkdtemp(join(tmpdir(), "auto-tag-sdk-"));
		database = join(directory, "fixture.db");
		new Database(database).close();
		await synchronizeRuntimeSchema(`file:${database}`);
		runtime = await openRestoreRuntime({ databaseUrl: `file:${database}` });
		await runtime.bindDestination("synthetic-auto-tag-sdk");
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
		setupAuthInjection(app, { id: "owner" });
		registerTestErrorHandler(app);
		await app.register(registerAutoTagRoutes, { prefix: "/api/auto-tag" });
		await app.ready();
		await run(async () => {
			await native.prisma.user.createMany({
				data: [
					{ id: "owner", username: "synthetic-owner" },
					{ id: "other", username: "synthetic-other" },
				],
			});
			for (const id of ["sonarr", "radarr", "refused", "foreign"]) {
				const key = encryptor.encrypt("synthetic-tag-key");
				await native.prisma.serviceInstance.create({
					data: {
						id,
						userId: id === "foreign" ? "other" : "owner",
						service: id === "sonarr" ? "SONARR" : "RADARR",
						label: `Synthetic ${id}`,
						baseUrl: `${baseUrl}/${id}`,
						encryptedApiKey: key.value,
						encryptionIv: key.iv,
					},
				});
				await native.prisma.libraryCache.create({
					data: {
						instanceId: id,
						arrItemId: 10,
						itemType: id === "sonarr" ? "series" : "movie",
						title: "Synthetic item",
						monitored: true,
						hasFile: true,
						qualityProfileId: 9,
						status: "continuing",
						sizeOnDisk: 1234n,
						data: JSON.stringify({
							...resource(),
							service: id === "sonarr" ? "sonarr" : "radarr",
							_arrDashboardEvidence: {
								monitored: true,
								hasFile: true,
								sizeOnDisk: true,
								rating: false,
								imdbRating: false,
							},
						}),
					},
				});
				resources.set(id, resource());
				tags.set(
					id,
					id === "radarr"
						? [{ id: 3, label: "existing" }]
						: [
								{ id: 3, label: "existing" },
								{ id: 7, label: "reviewed" },
							],
				);
			}
		});
	});
	afterEach(() => {
		expect(errors).toEqual([]);
	});
	afterAll(async () => {
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
				join(process.env.ARR_AUTOMATION_EVIDENCE_DIR, "auto-tag-closure.json"),
				JSON.stringify({
					serverClosed: true,
					pendingHttpTasks: tasks.size,
					nativeClosed: true,
					runtimeClosed: true,
					errors,
					observations,
					checks,
				}),
			);
		await rm(directory, { recursive: true, force: true });
	});
	async function createRule(id: string) {
		const created = await request("POST", "/api/auto-tag/rules", {
			name: `Synthetic ${id}`,
			ruleType: "monitored",
			parameters: {},
			tagName: "reviewed",
			enabled: true,
			serviceFilter: [id === "sonarr" ? "sonarr" : "radarr"],
			instanceFilter: [id],
		});
		expect(created.statusCode).toBe(201);
		const ruleId = created.json().rule.id;
		const patched = await request("PATCH", `/api/auto-tag/rules/${ruleId}`, {
			name: `Reviewed ${id}`,
			parameters: {},
			excludeTags: [99],
			excludeTitles: ["^Excluded$"],
		});
		expect(patched.statusCode).toBe(200);
		expect(
			await run(() => native.prisma.autoTagRule.findUnique({ where: { id: ruleId } })),
		).toMatchObject({
			userId: "owner",
			name: `Reviewed ${id}`,
			ruleType: "monitored",
			parameters: "{}",
			instanceFilter: JSON.stringify([id]),
			excludeTags: "[99]",
			excludeTitles: '["^Excluded$"]',
			lastRunAt: null,
			lastRunStatus: null,
		});
		return ruleId as string;
	}
	it.each(["sonarr", "radarr"])(
		"previews read-only, runs %s full live PUT, persists outcome and converges on repeat",
		async (id) => {
			const start = events.length,
				ruleId = await createRule(id);
			const before = await run(() =>
				native.prisma.autoTagRule.findUnique({ where: { id: ruleId } }),
			);
			const cacheBefore = await run(() =>
				native.prisma.libraryCache.findMany({ orderBy: { id: "asc" } }),
			);
			const preview = await request("GET", `/api/auto-tag/rules/${ruleId}/preview`);
			expect(preview.statusCode).toBe(200);
			expect(preview.json()).toMatchObject({
				itemsScanned: 1,
				itemsMatched: 1,
				itemsUnknown: 0,
				items: [{ instanceId: id, arrItemId: 10, state: "true" }],
			});
			expect(events.slice(start)).toEqual([]);
			expect(
				await run(() => native.prisma.autoTagRule.findUnique({ where: { id: ruleId } })),
			).toEqual(before);
			const executed = await request("POST", `/api/auto-tag/rules/${ruleId}/run`, {});
			expect(executed.statusCode).toBe(200);
			expect(executed.json().rule).toMatchObject({ lastRunStatus: "success" });
			expect(executed.json().rule.lastRunAt).not.toBeNull();
			const wire = events.slice(start);
			expect(wire.every((e) => e.instance === id)).toBe(true);
			const writes = wire.filter((e) => e.method === "PUT");
			expect(writes).toHaveLength(1);
			expect(writes[0]).toMatchObject({
				instance: id,
				path: id === "sonarr" ? "/api/v3/series/10" : "/api/v3/movie/10",
				body: {
					id: 10,
					title: "Synthetic item",
					monitored: true,
					hasFile: true,
					tags: [3, 7],
					qualityProfileId: 9,
					tvdbId: 8401,
					tmdbId: 42,
					year: 2020,
					status: "continuing",
					path: "/synthetic/item",
					statistics: { episodeFileCount: 1, sizeOnDisk: 1234 },
					sizeOnDisk: 1234,
					providerOwned: { retain: true },
					added: "2020-01-01T00:00:00Z",
				},
			});
			expect(wire.filter((e) => e.method === "POST")).toEqual(
				id === "radarr"
					? [
							{
								instance: "radarr",
								method: "POST",
								path: "/api/v3/tag",
								query: {},
								body: { label: "reviewed" },
							},
						]
					: [],
			);
			const repeat = await request("POST", `/api/auto-tag/rules/${ruleId}/run`, {});
			expect(repeat.statusCode).toBe(200);
			expect(repeat.json().rule.lastRunStatus).toBe("success");
			expect(events.slice(start).filter((e) => e.method === "PUT")).toHaveLength(1);
			expect(events.slice(start).filter((e) => e.method === "POST")).toHaveLength(
				id === "radarr" ? 1 : 0,
			);
			const read = await request("GET", "/api/auto-tag/rules");
			expect(read.json().rules.find((r: { id: string }) => r.id === ruleId)).toMatchObject({
				name: `Reviewed ${id}`,
				lastRunStatus: "success",
				parameters: {},
				excludeTags: [99],
				instanceFilter: [id],
			});
			expect(
				await run(() => native.prisma.libraryCache.findMany({ orderBy: { id: "asc" } })),
			).toEqual(cacheBefore);
			expect((await request("DELETE", `/api/auto-tag/rules/${ruleId}`)).statusCode).toBe(204);
			expect(
				(await request("GET", "/api/auto-tag/rules"))
					.json()
					.rules.some((r: { id: string }) => r.id === ruleId),
			).toBe(false);
			expect(
				await run(() => native.prisma.autoTagRule.findUnique({ where: { id: ruleId } })),
			).toBeNull();
			observations.push({ id, wire: events.slice(start) });
		},
	);
	it("persists refused provider PUT as failed and never claims a confirmed tag", async () => {
		const start = events.length,
			ruleId = await createRule("refused");
		const executed = await request("POST", `/api/auto-tag/rules/${ruleId}/run`, {});
		expect(executed.statusCode).toBe(200);
		expect(executed.json().rule).toMatchObject({ lastRunStatus: "failed" });
		expect(events.slice(start).filter((e) => e.method === "PUT")).toHaveLength(1);
		expect(resources.get("refused")?.tags).toEqual([3]);
		expect(
			await run(() => native.prisma.autoTagRule.findUnique({ where: { id: ruleId } })),
		).toMatchObject({ lastRunStatus: "failed" });
		expect(
			(await request("GET", "/api/auto-tag/rules"))
				.json()
				.rules.find((r: { id: string }) => r.id === ruleId).lastRunStatus,
		).toBe("failed");
		observations.push({ id: "refused", wire: events.slice(start) });
	});
});
