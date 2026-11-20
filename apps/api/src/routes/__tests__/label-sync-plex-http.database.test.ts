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
import { PlexAuthorityService } from "../../lib/plex/plex-authority-service.js";
import { refreshOwnedPlexCache } from "../../lib/plex/plex-refresh-orchestration.js";
import { registerLabelSyncRoutes } from "../label-sync.js";
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
	status?: number;
};

// Real canonical producer and real authority: no seeded cache verdict or SDK/factory/SQL mock.
describe("Label Sync Plex native publication and real authority HTTP", () => {
	const app = Fastify({ logger: false }),
		encryptor = new Encryptor("47".repeat(32));
	let directory: string, database: string, baseUrl: string;
	let runtime: Awaited<ReturnType<typeof openRestoreRuntime>>,
		native: ReturnType<typeof createRuntimePrismaClient>;
	const run = <T>(fn: () => Promise<T>) => runtime.runOperation(fn);
	const request = (method: string, url: string, body?: unknown) =>
		run(() => createInjectAuthenticated(app)(method, url, { body }));
	const events: Event[] = [],
		errors: string[] = [],
		observations: unknown[] = [],
		tasks = new Set<Promise<void>>();
	const labels = new Map<string, string[]>([
		["source", ["source-label"]],
		["dest", ["existing-label"]],
	]);
	let refuse = false;
	const server = createServer((req, res) => {
		const task = (async () => {
			const url = new URL(req.url!, "http://synthetic.invalid"),
				match = /^\/(source|dest)(\/.*)$/.exec(url.pathname);
			assert(match, `Unexpected path ${url.pathname}`);
			assert.equal(req.headers["x-plex-token"], "synthetic-plex-token");
			const instance = match[1]!,
				path = match[2]!,
				ratingKey = instance === "source" ? "101" : "201";
			const event: Event = {
				instance,
				method: req.method!,
				path,
				query: Object.fromEntries(url.searchParams),
			};
			events.push(event);
			const send = (body: unknown, status = 200) => {
				event.status = status;
				res.writeHead(status, { "content-type": "application/json", connection: "close" });
				res.end(JSON.stringify(body));
			};
			if (event.method === "PUT") {
				assert.equal(instance, "dest");
				assert.equal(path, "/library/metadata/201");
				assert.equal(url.searchParams.get("type"), "1");
				assert.equal(url.searchParams.get("label.locked"), "1");
				const label = url.searchParams.get("label[0].tag.tag");
				assert(label === "managed" || label === "recovery-label");
				if (refuse) {
					send({ error: "Synthetic provider refused" }, 422);
					return;
				}
				if (!labels.get(instance)!.includes(label)) labels.get(instance)!.push(label);
				event.status = 200;
				res.writeHead(200, { "content-type": "text/plain", connection: "close" });
				res.end();
				return;
			}
			assert.equal(event.method, "GET");
			if (path === "/identity") {
				send({ MediaContainer: { machineIdentifier: `synthetic-${instance}`, version: "1" } });
				return;
			}
			if (path === "/activities") {
				send({ MediaContainer: { size: 0, Activity: [] } });
				return;
			}
			if (path === "/library/sections") {
				send({
					MediaContainer: {
						size: 1,
						Directory: [
							{
								key: "1",
								uuid: `${instance}-movies-uuid`,
								title: "Synthetic movies",
								type: "movie",
								refreshing: false,
								scannedAt: 1,
								updatedAt: 2,
							},
						],
					},
				});
				return;
			}
			if (path === "/accounts") {
				send({
					MediaContainer: {
						size: 1,
						offset: 0,
						totalSize: 1,
						Account: [{ id: 1, name: "Synthetic" }],
					},
				});
				return;
			}
			const page = (items: unknown[]) => {
				const start = Number(url.searchParams.get("X-Plex-Container-Start") ?? 0),
					limit = Number(url.searchParams.get("X-Plex-Container-Size") ?? 200);
				assert(Number.isInteger(start) && start >= 0 && Number.isInteger(limit) && limit > 0);
				const selected = items.slice(start, start + limit);
				send({
					MediaContainer: {
						offset: start,
						size: selected.length,
						totalSize: items.length,
						Metadata: selected,
					},
				});
			};
			if (path === "/status/sessions/history/all" || path === "/library/onDeck") {
				page([]);
				return;
			}
			if (path === "/library/sections/1/all") {
				page([
					{
						ratingKey,
						type: "movie",
						title: "Synthetic movie",
						Guid: [{ id: "tmdb://42" }],
						viewCount: 0,
						thumb: `/library/metadata/${ratingKey}/thumb/1`,
						addedAt: 1700000000,
						Collection: [],
						Label: labels.get(instance)!.map((tag) => ({ tag })),
					},
				]);
				return;
			}
			if (path === `/library/metadata/${ratingKey}`) {
				assert.equal(url.searchParams.get("includeCollections"), "1");
				assert.equal(url.searchParams.get("includeLabels"), "1");
				send({
					MediaContainer: {
						size: 1,
						Metadata: [
							{ ratingKey, Collection: [], Label: labels.get(instance)!.map((tag) => ({ tag })) },
						],
					},
				});
				return;
			}
			throw new Error(`Unexpected request ${event.method} ${path}`);
		})().catch((error: unknown) => {
			errors.push(String(error));
			res.destroy();
		});
		tasks.add(task);
		void task.finally(() => tasks.delete(task));
	});
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "label-sync-plex-"));
		database = join(directory, "fixture.db");
		new Database(database).close();
		await synchronizeRuntimeSchema(`file:${database}`);
		runtime = await openRestoreRuntime({ databaseUrl: `file:${database}` });
		await runtime.bindDestination("synthetic-label-sync-plex");
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
			for (const id of ["source", "dest", "sibling", "foreign"]) {
				const key = encryptor.encrypt("synthetic-plex-token");
				await native.prisma.serviceInstance.create({
					data: {
						id,
						userId: id === "foreign" ? "foreign" : "owner",
						service: "PLEX",
						label: `Synthetic ${id}`,
						baseUrl: `${baseUrl}/${id}`,
						encryptedApiKey: key.value,
						encryptionIv: key.iv,
						connectionGeneration: 7,
						identityGeneration: 3,
						identityStatus: "VERIFIED",
						identityKind: "PLEX_MACHINE_IDENTIFIER",
						expectedIdentity: `synthetic-${id}`,
						identityVerifiedAt: new Date(),
					},
				});
			}
			expect(await native.prisma.plexCache.count()).toBe(0);
			expect(await native.prisma.plexGenerationTarget.count()).toBe(0);
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
		assert(directory.startsWith(join(tmpdir(), "label-sync-plex-")));
		await rm(directory, { recursive: true, force: true });
		expect(existsSync(directory)).toBe(false);
		if (process.env.ARR_AUTOMATION_EVIDENCE_DIR)
			await writeFile(
				join(process.env.ARR_AUTOMATION_EVIDENCE_DIR, "label-sync-plex-closure.json"),
				JSON.stringify(
					{
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
					},
					(_, v) => (typeof v === "bigint" ? String(v) : v),
				),
			);
	});
	async function publish(id: string) {
		const instance = await run(() =>
			native.prisma.serviceInstance.findUniqueOrThrow({ where: { id } }),
		);
		const publication = await run(() =>
			refreshOwnedPlexCache({ prisma: native.prisma, encryptor, instance, log: app.log }),
		);
		observations.push({ publicationFor: id, publication });
		expect(publication.errors).toBe(0);
		expect(publication.upserted).toBe(1);
		const status = await run(() =>
			native.prisma.cacheRefreshStatus.findFirst({ where: { instanceId: id, cacheType: "plex" } }),
		);
		expect(status).toMatchObject({
			lastResult: "success",
			itemCount: 1,
			connectionGeneration: 7,
			identityGeneration: 3,
		});
		expect(JSON.parse(status!.generationMetadata!)).toMatchObject({
			publicationLevel: "authoritative",
			completeness: "complete",
			itemCount: 1,
		});
		expect(
			await run(() =>
				native.prisma.plexGenerationTarget.findMany({
					where: { instanceId: id, generationId: status!.generationId! },
				}),
			),
		).toMatchObject([
			{
				ratingKey: id === "source" ? "101" : "201",
				tmdbId: 42,
				mediaType: "movie",
				sectionId: "1",
			},
		]);
		const evidence = await run(() =>
			new PlexAuthorityService({
				prisma: native.prisma,
				encryptor,
				log: app.log,
			}).readInstanceSelected({
				userId: "owner",
				instanceId: id,
				selection: { kind: "targets", targets: [{ tmdbId: 42, mediaType: "movie" }] },
				domains: ["membership"],
			}),
		);
		expect(evidence.available).toBe(true);
		observations.push({ selectedEvidenceFor: id, evidence });
	}
	async function createRule(label: string) {
		const created = await request("POST", "/api/label-sync/rules", {
			name: `Synthetic ${label}`,
			enabled: true,
			sourceService: "plex",
			sourceInstanceId: "source",
			sourceTagName: "source-label",
			destService: "plex",
			destInstanceId: "dest",
			destTagName: label,
		});
		expect(created.statusCode).toBe(201);
		return created.json().rule.id as string;
	}
	it("P1 publishes real source/destination authority and adds the selected movie label through native rule route", async () => {
		await publish("source");
		await publish("dest");
		const id = await createRule("managed"),
			start = events.length;
		const result = await request("POST", `/api/label-sync/rules/${id}/run`, {});
		expect(result.statusCode).toBe(200);
		expect(result.json().rule.lastRunStatus).toBe("success");
		expect(result.json().rule.lastRunMessage).toBe(
			'Applied label "managed" to 1 item (1 match from 1 tagged item).',
		);
		const wire = events.slice(start);
		expect(wire.every((e) => e.instance === "source" || e.instance === "dest")).toBe(true);
		expect(wire.filter((e) => e.method === "PUT")).toEqual([
			{
				instance: "dest",
				method: "PUT",
				path: "/library/metadata/201",
				query: { type: "1", "label.locked": "1", "label[0].tag.tag": "managed" },
				status: 200,
			},
		]);
		expect(labels.get("dest")).toEqual(["existing-label", "managed"]);
		expect(
			await run(() => native.prisma.labelSyncRule.findUnique({ where: { id } })),
		).toMatchObject({ userId: "owner", destInstanceId: "dest", lastRunStatus: "success" });
		expect(
			(await request("GET", "/api/label-sync/rules"))
				.json()
				.rules.find((r: { id: string }) => r.id === id).lastRunStatus,
		).toBe("success");
		observations.push({ case: "P1", rule: result.json().rule, wire });
	});
	it("P2 persists provider refusal without a confirmed label and only an explicit run recovers", async () => {
		await publish("source");
		await publish("dest");
		const id = await createRule("recovery-label"),
			start = events.length;
		refuse = true;
		const failed = await request("POST", `/api/label-sync/rules/${id}/run`, {});
		expect(failed.statusCode).toBe(200);
		expect(failed.json().rule.lastRunStatus).toBe("failed");
		expect(failed.json().rule.lastRunMessage).toBe("All 1 attempts failed.");
		expect(labels.get("dest")).not.toContain("recovery-label");
		expect(events.slice(start).filter((e) => e.method === "PUT")).toMatchObject([
			{ instance: "dest", path: "/library/metadata/201", status: 422 },
		]);
		expect(
			await run(() => native.prisma.labelSyncRule.findUnique({ where: { id } })),
		).toMatchObject({ lastRunStatus: "failed" });
		const read = await request("GET", "/api/label-sync/rules");
		expect(read.json().rules.find((r: { id: string }) => r.id === id).lastRunStatus).toBe("failed");
		expect(events.slice(start).filter((e) => e.method === "PUT")).toHaveLength(1);
		refuse = false;
		const recovered = await request("POST", `/api/label-sync/rules/${id}/run`, {});
		expect(recovered.statusCode).toBe(200);
		expect(recovered.json().rule.lastRunStatus).toBe("success");
		expect(labels.get("dest")).toContain("recovery-label");
		expect(events.slice(start).filter((e) => e.method === "PUT")).toMatchObject([
			{ instance: "dest", status: 422 },
			{ instance: "dest", status: 200 },
		]);
		expect(events.slice(start).every((e) => e.instance === "source" || e.instance === "dest")).toBe(
			true,
		);
		observations.push({
			case: "P2",
			failed: failed.json().rule,
			recovered: recovered.json().rule,
			wire: events.slice(start),
		});
	});
});
