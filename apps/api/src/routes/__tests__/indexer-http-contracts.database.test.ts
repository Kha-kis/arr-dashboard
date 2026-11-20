import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ArrClientFactory } from "../../lib/arr/client-factory.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import { openRestoreRuntime } from "../../lib/backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../lib/backup/runtime-schema-startup.js";
import { registerIndexerRoutes } from "../search/indexer-routes.js";

type Resource = {
	id: number;
	name: string;
	enable: boolean;
	priority: number;
	implementation: string;
	configContract: string;
	providerOwned: { retain: boolean };
	fields: { name: string; type: string; value: string; providerMetadata?: string }[];
};
const resource = (): Resource => ({
	id: 7,
	name: "Synthetic same indexer",
	enable: true,
	priority: 10,
	implementation: "Synthetic",
	configContract: "SyntheticSettings",
	providerOwned: { retain: true },
	fields: [
		{ name: "host", type: "textbox", value: "old.synthetic.invalid", providerMetadata: "retain" },
		{ name: "apiKey", type: "password", value: "synthetic-private-provider-key" },
	],
});
type Event = {
	instance: string;
	method: string;
	path: string;
	query: Record<string, string>;
	body: unknown;
	keyAccepted: boolean;
};
type Fault =
	| "none"
	| "refuse"
	| "lost"
	| "readback-refuse"
	| "stale-readback"
	| "wrong-id"
	| "test-refuse"
	| "test-timeout";

// Native SQLite ownership, real encryption/factory/installed SDK, real registered
// routes and loopback recording HTTP. Only request authentication is synthetic.
describe("indexer native ownership and installed-client HTTP contracts", () => {
	const evidenceFile = process.env.ARR_INDEXER_HTTP_EVIDENCE_FILE;
	const app = Fastify({ logger: false });
	const encryptor = new Encryptor("74".repeat(32));
	let directory: string, database: string;
	let runtime: Awaited<ReturnType<typeof openRestoreRuntime>>;
	let native: ReturnType<typeof createRuntimePrismaClient>;
	const run = <T>(operation: () => Promise<T>) => runtime.runOperation(operation);
	const resources = new Map<string, Resource>();
	const events: Event[] = [],
		accepted: Event[] = [],
		fixtureErrors: string[] = [];
	const tasks = new Set<Promise<void>>();
	let fault: Fault = "none",
		owner = "owner";
	let sourcesBefore: unknown;
	const observations: unknown[] = [];
	const provider = createServer((request, response) => {
		const task = (async () => {
			const url = new URL(request.url!, "http://synthetic.invalid");
			const match =
				/^\/(north|south|foreign|disabled|wrong)\/api\/v1\/(indexer(?:\/7|\/test)?|indexerstats)$/.exec(
					url.pathname,
				);
			assert(match, `Unexpected synthetic provider path ${url.pathname}`);
			let text = "";
			for await (const chunk of request) {
				text += String(chunk);
				assert(text.length < 8192);
			}
			const instance = match[1]!,
				path = `/api/v1/${match[2]}`;
			const event: Event = {
				instance,
				method: request.method!,
				path,
				query: Object.fromEntries(url.searchParams),
				body: text ? JSON.parse(text) : null,
				keyAccepted: request.headers["x-api-key"] === "synthetic-v6-key",
			};
			events.push(event);
			assert(event.keyAccepted);
			const send = (body: unknown, status = 200) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(body));
			};
			if (event.method === "GET" && path === "/api/v1/indexerstats") {
				send({ indexers: [] });
				return;
			}
			if (event.method === "GET" && path === "/api/v1/indexer/7") {
				if (fault === "readback-refuse" && accepted.length) {
					send({ message: "synthetic private read refusal" }, 422);
					return;
				}
				if (fault === "wrong-id") {
					send({ ...resource(), id: 8 });
					return;
				}
				send(fault === "stale-readback" && accepted.length ? resource() : resources.get(instance));
				return;
			}
			if (event.method === "PUT" && path === "/api/v1/indexer/7") {
				if (fault === "refuse") {
					send({ message: "synthetic-private-refusal" }, 422);
					return;
				}
				resources.set(instance, event.body as Resource);
				accepted.push(event);
				if (fault === "lost") {
					request.socket.destroy();
					return;
				}
				send(resources.get(instance));
				return;
			}
			if (event.method === "POST" && path === "/api/v1/indexer/test") {
				if (fault === "test-refuse") {
					send({ message: "synthetic-private-test-diagnostic" }, 422);
					return;
				}
				if (fault === "test-timeout") {
					await new Promise<void>((resolve) => request.socket.once("close", () => resolve()));
					return;
				}
				accepted.push(event);
				send({});
				return;
			}
			throw Error("Unexpected synthetic provider operation");
		})().catch((error: unknown) => {
			fixtureErrors.push(String(error));
			response.destroy();
		});
		tasks.add(task);
		void task.finally(() => tasks.delete(task));
	});
	const send = (instance: string, changes: unknown = { enable: false }) =>
		run(async () =>
			app.inject({
				method: "PUT",
				url: `/api/search/indexers/${instance}/7`,
				payload: { changes },
			}),
		);
	const test = (instance = "south") =>
		run(async () =>
			app.inject({
				method: "POST",
				url: "/api/search/indexers/test",
				payload: { instanceId: instance, indexerId: 7 },
			}),
		);
	const snapshot = () =>
		run(() => native.prisma.serviceInstance.findMany({ orderBy: { id: "asc" } }));
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "arr-indexer-http-"));
		database = join(directory, "owned.db");
		new Database(database).close();
		await synchronizeRuntimeSchema(`file:${database}`);
		runtime = await openRestoreRuntime({ databaseUrl: `file:${database}` });
		await runtime.bindDestination("synthetic-indexer-v6");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		await run(() =>
			native.prisma.user.createMany({
				data: [
					{ id: "owner", username: "synthetic-owner" },
					{ id: "other", username: "synthetic-other" },
				],
			}),
		);
		await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
		const address = provider.address();
		assert(address && typeof address !== "string");
		for (const id of ["north", "south", "foreign", "disabled", "wrong"]) {
			const key = encryptor.encrypt("synthetic-v6-key");
			await run(() =>
				native.prisma.serviceInstance.create({
					data: {
						id,
						userId: id === "foreign" ? "other" : "owner",
						service: id === "wrong" ? "SONARR" : "PROWLARR",
						label: "Synthetic same provider",
						baseUrl: `http://127.0.0.1:${address.port}/${id}`,
						enabled: id !== "disabled",
						encryptedApiKey: key.value,
						encryptionIv: key.iv,
					},
				}),
			);
		}
		app.decorate("prisma", native.prisma);
		app.decorate("restoreRuntime", runtime);
		app.decorate("encryptor", encryptor);
		app.decorate("arrClientFactory", new ArrClientFactory(encryptor, 100));
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (request) => {
			request.currentUser = {
				id: owner,
				username: "synthetic-auth-user",
			} as typeof request.currentUser;
		});
		await app.register(registerIndexerRoutes, { prefix: "/api" });
		await app.ready();
	});
	beforeEach(async () => {
		fault = "none";
		owner = "owner";
		events.length = 0;
		accepted.length = 0;
		for (const id of ["north", "south", "foreign", "disabled", "wrong"])
			resources.set(id, resource());
		sourcesBefore = await snapshot();
	});
	afterEach(async (context) => {
		expect(await snapshot()).toEqual(sourcesBefore);
		expect(fixtureErrors).toEqual([]);
		observations.push({
			name: context.task.name,
			events: structuredClone(events),
			accepted: structuredClone(accepted),
		});
	});
	afterAll(async () => {
		const checks = [];
		const closureErrors: unknown[] = [];
		const closers = [
			() => app.close(),
			async () => {
				provider.closeAllConnections();
				await Promise.all([...tasks]);
				if (provider.listening)
					await new Promise<void>((resolve) => provider.close(() => resolve()));
			},
			() => native?.close(),
			() => runtime?.close(),
		];
		try {
			for (const close of closers) {
				try {
					await close();
				} catch (error) {
					closureErrors.push(error);
				}
			}
			if (closureErrors.length)
				throw new AggregateError(closureErrors, "Indexer fixture closure failed");
			expect(provider.listening).toBe(false);
			expect(tasks.size).toBe(0);
			for (const file of native
				? [
						database,
						`${database}.arr-restore-runtime/owner.sqlite3`,
						`${database}.arr-restore-runtime/operations.sqlite3`,
					]
				: []) {
				const db = new Database(file, { readonly: true, fileMustExist: true });
				try {
					const integrity = db.pragma("quick_check", { simple: true }),
						foreignKeys = db.pragma("foreign_key_check");
					expect(integrity).toBe("ok");
					expect(foreignKeys).toEqual([]);
					checks.push({ integrity, foreignKeys });
				} finally {
					db.close();
					expect(db.open).toBe(false);
				}
			}
		} finally {
			// Uncertain closure retains the fixture; never unlink a possibly live database.
			if (directory && closureErrors.length === 0) await rm(directory, { recursive: true });
			if (evidenceFile)
				await writeFile(
					evidenceFile,
					JSON.stringify(
						{
							observations,
							checks,
							allResourcesClosed: closureErrors.length === 0,
							directory,
							removed: !!directory && !existsSync(directory),
						},
						null,
						2,
					),
					{ flag: "wx", mode: 0o600 },
				);
		}
	});
	// Catches removing full GET/spread PUT preservation or selecting the other source's ID 7.
	it("GETs the exact owned resource, spreads full provider metadata into PUT, then verifies readback", async () => {
		const result = await send("south", {
			enable: false,
			priority: 30,
			fields: [{ name: "host", value: "new.synthetic.invalid" }],
		});
		expect(result.statusCode).toBe(200);
		expect(result.json()).toMatchObject({
			status: "verified",
			indexer: { id: 7, instanceId: "south", enable: false, priority: 30 },
		});
		expect(result.json().indexer.fields).toEqual(
			expect.arrayContaining([{ name: "host", type: "textbox", value: "new.synthetic.invalid" }]),
		);
		const mutations = events.filter((e) => e.method !== "GET");
		expect(mutations).toHaveLength(1);
		expect(events[0]).toMatchObject({
			instance: "south",
			method: "GET",
			path: "/api/v1/indexer/7",
			query: {},
			body: null,
		});
		expect(mutations[0]).toEqual({
			instance: "south",
			method: "PUT",
			path: "/api/v1/indexer/7",
			query: {},
			keyAccepted: true,
			body: {
				...resource(),
				enable: false,
				priority: 30,
				fields: [
					{
						name: "host",
						type: "textbox",
						value: "new.synthetic.invalid",
						providerMetadata: "retain",
					},
					{ name: "apiKey", type: "password", value: "synthetic-private-provider-key" },
				],
			},
		});
		expect(events.filter((e) => e.path === "/api/v1/indexer/7").map((e) => e.method)).toEqual([
			"GET",
			"PUT",
			"GET",
		]);
		expect(events.every((e) => e.instance === "south")).toBe(true);
		expect(resources.get("north")).toEqual(resource());
	});
	it.each(["foreign", "disabled", "missing", "wrong"] as const)(
		"rejects update and Test on %s before provider HTTP",
		async (instance) => {
			const wanted = instance === "wrong" ? 400 : 404;
			expect((await send(instance)).statusCode).toBe(wanted);
			expect((await test(instance)).statusCode).toBe(wanted);
			expect(events).toEqual([]);
		},
	);
	it("does not trust client-supplied source or resource fields", async () => {
		const result = await run(async () =>
			app.inject({
				method: "PUT",
				url: "/api/search/indexers/south/7",
				payload: { instanceId: "north", changes: { enable: false }, indexer: resource() },
			}),
		);
		expect(result.statusCode).toBe(400);
		expect(events).toEqual([]);
	});
	it("fails closed when fetched indexer identity differs", async () => {
		fault = "wrong-id";
		const result = await send("south");
		expect(result.statusCode).toBe(409);
		expect(accepted).toEqual([]);
		expect(events.map((e) => e.method)).toEqual(["GET"]);
	});
	it.each(["lost", "readback-refuse", "stale-readback"] as const)(
		"reports %s honestly and permits read recovery without PUT replay",
		async (mode) => {
			fault = mode;
			const result = await send("south");
			expect(result.statusCode).toBe(202);
			expect(result.json()).toEqual({
				status: mode === "lost" ? "outcome-unknown" : "applied-unverified",
			});
			expect(accepted).toHaveLength(1);
			expect(events.filter((e) => e.method === "PUT")).toHaveLength(1);
			fault = "none";
			const read = await run(async () =>
				app.inject({ method: "GET", url: "/api/search/indexers/south/7" }),
			);
			expect(read.statusCode).toBe(200);
			expect(read.json()).toMatchObject({ indexer: { instanceId: "south", id: 7, enable: false } });
			expect(events.filter((e) => e.method === "PUT")).toHaveLength(1);
		},
	);
	it("definite provider refusal preserves state and a later explicit update can recover", async () => {
		fault = "refuse";
		const result = await send("south");
		expect(result.statusCode).toBe(502);
		expect(result.json().message).toBe("Prowlarr rejected the indexer update");
		expect(accepted).toEqual([]);
		expect(resources.get("south")).toEqual(resource());
		fault = "none";
		expect((await send("south")).json()).toMatchObject({ status: "verified" });
		expect(accepted).toHaveLength(1);
	});
	it("reauthorizes ownership after an earlier verified update", async () => {
		const initial = await run(() =>
			native.prisma.serviceInstance.findUniqueOrThrow({ where: { id: "south" } }),
		);
		expect((await send("south")).json()).toMatchObject({ status: "verified" });
		await run(() =>
			native.prisma.serviceInstance.update({ where: { id: "south" }, data: { userId: "other" } }),
		);
		events.length = 0;
		accepted.length = 0;
		try {
			expect((await send("south")).statusCode).toBe(404);
			expect((await test()).statusCode).toBe(404);
			expect(events).toEqual([]);
			owner = "other";
			expect((await send("south", { priority: 30 })).json()).toMatchObject({ status: "verified" });
			expect(accepted).toHaveLength(1);
		} finally {
			await run(() =>
				native.prisma.serviceInstance.update({
					where: { id: "south" },
					data: { userId: "owner", updatedAt: initial.updatedAt },
				}),
			);
		}
	});
	it.each(["none", "test-refuse", "test-timeout"] as const)(
		"Test %s uses full exact definition and never PUTs configuration",
		async (mode) => {
			fault = mode;
			const result = await test();
			expect(result.statusCode).toBe(200);
			expect(result.json()).toMatchObject({ success: mode === "none" });
			expect(result.body).not.toContain("synthetic-private");
			expect(events.filter((e) => e.method !== "GET")).toEqual([
				{
					instance: "south",
					method: "POST",
					path: "/api/v1/indexer/test",
					query: {},
					body: resource(),
					keyAccepted: true,
				},
			]);
			expect(resources.get("south")).toEqual(resource());
			expect(resources.get("north")).toEqual(resource());
		},
	);
});
