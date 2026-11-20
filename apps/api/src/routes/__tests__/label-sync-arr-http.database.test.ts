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
import { registerLabelSyncRoutes } from "../label-sync.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

type Resource = {
	id: number;
	tmdbId: number;
	tvdbId: number;
	title: string;
	tags: number[];
	qualityProfileId: number;
	monitored: boolean;
	path: string;
	providerOwned: { retain: boolean };
};
type Event = {
	instance: string;
	method: string;
	path: string;
	query: Record<string, string>;
	body: unknown;
	status?: number;
};
const resource = (id = 10): Resource => ({
	id,
	tmdbId: 42,
	tvdbId: 8401,
	title: "Synthetic item",
	tags: [3, 8],
	qualityProfileId: 9,
	monitored: true,
	path: "/synthetic/item",
	providerOwned: { retain: true },
});

// Catches replacing live tags with a stale list snapshot while preserving other full-resource fields.
describe("Label Sync ARR native route and installed SDK HTTP", () => {
	const app = Fastify({ logger: false }),
		encryptor = new Encryptor("48".repeat(32));
	let runtime: Awaited<ReturnType<typeof openRestoreRuntime>>,
		native: ReturnType<typeof createRuntimePrismaClient>;
	let directory: string, database: string, baseUrl: string;
	const run = <T>(fn: () => Promise<T>) => runtime.runOperation(fn);
	const request = (method: string, url: string, body?: unknown) =>
		run(() => createInjectAuthenticated(app)(method, url, { body }));
	const resources = new Map<string, Resource>(),
		listed = new Set<string>();
	const events: Event[] = [],
		errors: string[] = [],
		observations: unknown[] = [],
		tasks = new Set<Promise<void>>();
	const server = createServer((req, res) => {
		const task = (async () => {
			const url = new URL(req.url!, "http://synthetic.invalid"),
				match =
					/^\/(source-sonarr|dest-sonarr|source-radarr|dest-radarr|refused)\/api\/v3\/(tag|series|movie)(\/10)?$/.exec(
						url.pathname,
					);
			assert(match, `Unexpected path ${url.pathname}`);
			assert.equal(req.headers["x-api-key"], "synthetic-label-key");
			let raw = "";
			for await (const chunk of req) {
				raw += String(chunk);
				assert(raw.length < 16384);
			}
			const event: Event = {
				instance: match[1]!,
				method: req.method!,
				path: `/api/v3/${match[2]}${match[3] ?? ""}`,
				query: Object.fromEntries(url.searchParams),
				body: raw ? JSON.parse(raw) : null,
			};
			events.push(event);
			const send = (body: unknown, status = 200) => {
				event.status = status;
				res.writeHead(status, { "content-type": "application/json", connection: "close" });
				res.end(JSON.stringify(body));
			};
			const source = event.instance.startsWith("source-");
			if (event.method === "GET" && match[2] === "tag") {
				send(
					source
						? [{ id: 5, label: "source-label" }]
						: [
								{ id: 3, label: "existing" },
								{ id: 7, label: "managed" },
								{ id: 8, label: "late-live" },
							],
				);
				return;
			}
			assert.equal(match[2], event.instance.endsWith("sonarr") ? "series" : "movie");
			if (event.method === "GET" && !match[3]) {
				if (source)
					send([
						{ ...resource(), tags: [5] },
						{ ...resource(11), tmdbId: 99, tags: [] },
					]);
				else {
					const current = resources.get(event.instance)!;
					send([{ ...current, tags: listed.has(event.instance) ? current.tags : [3] }]);
					listed.add(event.instance);
				}
				return;
			}
			if (event.method === "GET" && match[3]) {
				assert(!source);
				send(resources.get(event.instance));
				return;
			}
			if (event.method === "PUT" && match[3]) {
				assert(!source);
				if (event.instance === "refused") {
					send({ message: "Synthetic write refused" }, 422);
					return;
				}
				resources.set(event.instance, event.body as Resource);
				send(event.body);
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
		directory = await mkdtemp(join(tmpdir(), "label-sync-arr-"));
		database = join(directory, "fixture.db");
		new Database(database).close();
		await synchronizeRuntimeSchema(`file:${database}`);
		runtime = await openRestoreRuntime({ databaseUrl: `file:${database}` });
		await runtime.bindDestination("synthetic-label-sync-arr");
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
		await app.register(registerLabelSyncRoutes, { prefix: "/api/label-sync" });
		await app.ready();
		await run(async () => {
			await native.prisma.user.createMany({
				data: [
					{ id: "owner", username: "synthetic-owner" },
					{ id: "foreign", username: "synthetic-foreign" },
				],
			});
			for (const id of [
				"source-sonarr",
				"dest-sonarr",
				"source-radarr",
				"dest-radarr",
				"refused",
				"sibling",
				"foreign",
				"disabled",
			]) {
				const key = encryptor.encrypt("synthetic-label-key");
				await native.prisma.serviceInstance.create({
					data: {
						id,
						userId: id === "foreign" ? "foreign" : "owner",
						service: id.endsWith("sonarr") ? "SONARR" : "RADARR",
						label: `Synthetic ${id}`,
						baseUrl: `${baseUrl}/${id}`,
						enabled: id !== "disabled",
						encryptedApiKey: key.value,
						encryptionIv: key.iv,
					},
				});
				resources.set(id, resource());
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
		assert(directory.startsWith(join(tmpdir(), "label-sync-arr-")));
		await rm(directory, { recursive: true, force: true });
		expect(existsSync(directory)).toBe(false);
		if (process.env.ARR_AUTOMATION_EVIDENCE_DIR)
			await writeFile(
				join(process.env.ARR_AUTOMATION_EVIDENCE_DIR, "label-sync-arr-closure.json"),
				JSON.stringify({
					serverClosed: true,
					pendingHttpTasks: tasks.size,
					nativeClosed: true,
					runtimeClosed: true,
					directory,
					removed: !existsSync(directory),
					errors,
					events,
					observations,
					checks,
				}),
			);
	});
	const payload = (service: string, dest: string) => ({
		name: `Synthetic ${dest}`,
		sourceService: service,
		sourceInstanceId: `source-${service}`,
		sourceTagName: "source-label",
		destService: service,
		destInstanceId: dest,
		destTagName: "managed",
		enabled: true,
	});
	async function createRule(service: string, dest: string) {
		const r = await request("POST", "/api/label-sync/rules", payload(service, dest));
		expect(r.statusCode).toBe(201);
		const id = r.json().rule.id as string;
		expect(
			await run(() => native.prisma.labelSyncRule.findUnique({ where: { id } })),
		).toMatchObject({
			userId: "owner",
			sourceInstanceId: `source-${service}`,
			destInstanceId: dest,
			lastRunStatus: null,
		});
		return id;
	}
	it.each(["sonarr", "radarr"])(
		"A1/A2 %s preserves live tags/full fields through selected native run and explicit repeat",
		async (service) => {
			const dest = `dest-${service}`,
				id = await createRule(service, dest),
				start = events.length;
			const result = await request("POST", `/api/label-sync/rules/${id}/run`, {});
			expect(result.statusCode).toBe(200);
			expect(result.json().rule.lastRunStatus).toBe("success");
			const wire = events.slice(start),
				puts = wire.filter((e) => e.method === "PUT");
			expect(wire.every((e) => e.instance === `source-${service}` || e.instance === dest)).toBe(
				true,
			);
			expect(puts).toHaveLength(1);
			expect(puts[0]).toMatchObject({
				instance: dest,
				path: service === "sonarr" ? "/api/v3/series/10" : "/api/v3/movie/10",
				body: {
					id: 10,
					tmdbId: 42,
					tvdbId: 8401,
					title: "Synthetic item",
					qualityProfileId: 9,
					monitored: true,
					path: "/synthetic/item",
					providerOwned: { retain: true },
				},
			});
			expect.soft((puts[0]!.body as Resource).tags).toEqual([3, 8, 7]);
			expect.soft(resources.get(dest)?.tags).toEqual([3, 8, 7]);
			const repeat = await request("POST", `/api/label-sync/rules/${id}/run`, {});
			expect(repeat.statusCode).toBe(200);
			expect(repeat.json().rule.lastRunStatus).toBe("success");
			expect(events.slice(start).filter((e) => e.method === "PUT")).toHaveLength(1);
			expect(
				await run(() => native.prisma.labelSyncRule.findUnique({ where: { id } })),
			).toMatchObject({ lastRunStatus: "success" });
			const read = await request("GET", "/api/label-sync/rules");
			expect(read.json().rules.find((r: { id: string }) => r.id === id)).toMatchObject({
				sourceInstanceId: `source-${service}`,
				destInstanceId: dest,
				lastRunStatus: "success",
			});
			observations.push({ case: service, rule: result.json().rule, wire: events.slice(start) });
		},
	);
	it("A3 selected PUT422 persists failure without a confirmed label or another instance write", async () => {
		const id = await createRule("radarr", "refused"),
			start = events.length;
		const result = await request("POST", `/api/label-sync/rules/${id}/run`, {});
		expect(result.statusCode).toBe(200);
		expect(result.json().rule.lastRunStatus).toBe("failed");
		expect(result.json().rule.lastRunMessage).toBe("All 1 attempts failed.");
		expect(resources.get("refused")?.tags).toEqual([3, 8]);
		expect(events.slice(start).filter((e) => e.method === "PUT")).toMatchObject([
			{ instance: "refused", status: 422 },
		]);
		expect(
			events.slice(start).every((e) => ["source-radarr", "refused"].includes(e.instance)),
		).toBe(true);
		expect(
			await run(() => native.prisma.labelSyncRule.findUnique({ where: { id } })),
		).toMatchObject({ lastRunStatus: "failed" });
		expect(
			(await request("GET", "/api/label-sync/rules"))
				.json()
				.rules.find((r: { id: string }) => r.id === id).lastRunStatus,
		).toBe("failed");
		observations.push({ case: "422", rule: result.json().rule, wire: events.slice(start) });
	});
	it("A4 refuses foreign/disabled destinations and rechecks a destination disabled after rule creation without HTTP", async () => {
		const before = await run(() =>
				native.prisma.labelSyncRule.findMany({ orderBy: { id: "asc" } }),
			),
			start = events.length;
		for (const dest of ["foreign", "disabled"])
			expect(
				(await request("POST", "/api/label-sync/rules", payload("radarr", dest))).statusCode,
			).toBe(404);
		expect(
			await run(() => native.prisma.labelSyncRule.findMany({ orderBy: { id: "asc" } })),
		).toEqual(before);
		const id = await createRule("radarr", "sibling");
		await run(() =>
			native.prisma.serviceInstance.update({ where: { id: "sibling" }, data: { enabled: false } }),
		);
		const result = await request("POST", `/api/label-sync/rules/${id}/run`, {});
		expect(result.statusCode).toBe(200);
		expect(result.json().rule.lastRunStatus).toBe("failed");
		expect(result.json().rule.lastRunMessage).toBe(
			"Destination radarr instance not found or disabled.",
		);
		expect(events.slice(start)).toEqual([]);
		expect(
			await run(() =>
				native.prisma.labelSyncRule.findMany({
					where: { id: { not: id } },
					orderBy: { id: "asc" },
				}),
			),
		).toEqual(before);
		observations.push({ case: "foreign-disabled", rule: result.json().rule, zeroHttp: true });
	});
});
