import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ArrClientFactory } from "../../../lib/arr/client-factory.js";
import { Encryptor } from "../../../lib/auth/encryption.js";
import { openRestoreRuntime } from "../../../lib/backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../../lib/backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../../lib/backup/runtime-schema-startup.js";
import lifecycle from "../../../plugins/lifecycle.js";
import { registerMonitorRoutes } from "../monitor-routes.js";

// No Prisma, executor, factory or SDK doubles. Synthetic native user auth and
// loopback provider HTTP are the only integration seams.
describe("source-bound Library monitoring confirmation", () => {
	let directory: string, database: string, baseUrl: string;
	let runtime: Awaited<ReturnType<typeof openRestoreRuntime>>;
	let native: ReturnType<typeof createRuntimePrismaClient>;
	const app = Fastify({ logger: false });
	const encryptor = new Encryptor("74".repeat(32));
	const key = encryptor.encrypt("synthetic-key");
	const services = ["radarr", "sonarr", "lidarr", "readarr"] as const;
	type Service = (typeof services)[number];
	const types = { radarr: "movie", sonarr: "series", lidarr: "artist", readarr: "author" } as const;
	let ack: unknown, pre: unknown, post: unknown, wrongGet: unknown;
	let writes: { path: string; body: Record<string, unknown> }[];
	let reads: string[], gate: "GET" | "PUT" | undefined;
	let entered: (() => void) | undefined, release: Promise<void> | undefined;
	const resource = () => ({
		id: 41,
		monitored: false,
		title: "private-title",
		keep: 23,
		seasons: [
			{ seasonNumber: 0, monitored: false },
			{ seasonNumber: 1, monitored: false },
		],
	});
	const rows = (monitored: boolean) =>
		[51, 52].map((id) => ({ id, seriesId: 41, artistId: 41, authorId: 41, monitored }));
	const provider = createServer(
		(request, response) =>
			void (async () => {
				const url = new URL(request.url!, "http://owned.invalid");
				if (request.headers["x-api-key"] !== "synthetic-key") {
					response.writeHead(401).end();
					return;
				}
				let text = "";
				for await (const chunk of request) text += String(chunk);
				const body = text ? JSON.parse(text) : undefined;
				if (request.method === "GET") reads.push(url.pathname + url.search);
				else writes.push({ path: url.pathname, body });
				if (request.method === gate) {
					entered?.();
					if (release) await release;
				}
				const bulk = /\/(episode|album|book)(\/monitor)?$/.test(url.pathname);
				if (request.method !== "GET" && url.pathname.endsWith("/book/monitor")) {
					response.writeHead(204).end();
					return;
				}
				let value =
					request.method === "GET"
						? bulk
							? writes.length
								? post
								: pre
							: wrongGet !== undefined
								? wrongGet
								: resource()
						: ack === undefined
							? bulk
								? rows(true)
								: body
							: ack;
				if (value === "http503") {
					response.writeHead(503).end();
					return;
				}
				if (value === "http401") {
					response.writeHead(401).end();
					return;
				}
				if (value === "empty") {
					response.writeHead(204).end();
					return;
				}
				if (value === "timeout") {
					await new Promise((resolve) => setTimeout(resolve, 300));
					response.destroy();
					return;
				}
				response.setHeader("content-type", "application/json");
				response.end(value === "malformed" ? "{bad-json" : JSON.stringify(value));
			})().catch(() => response.destroy()),
	);
	const run = <T>(operation: () => Promise<T>) => runtime.runOperation(operation);
	const cache = (id = "radarr", owner = "owner") =>
		run(() =>
			native.prisma.libraryCache.findFirstOrThrow({
				where: { instanceId: id, arrItemId: 41, instance: { userId: owner } },
			}),
		);
	const top = (service: Service = "radarr", extra = {}) =>
		app.inject({
			method: "POST",
			url: "/api/library/monitor",
			payload: { instanceId: service, service, itemId: 41, monitored: true, ...extra },
		});
	const bulk = (service: "sonarr" | "lidarr" | "readarr", extra = {}) => {
		const kind = { sonarr: "episode", lidarr: "album", readarr: "book" }[service];
		const parent = { sonarr: "seriesId", lidarr: "artistId", readarr: "authorId" }[service];
		return app.inject({
			method: "POST",
			url: `/api/library/${kind}/monitor`,
			payload: {
				instanceId: service,
				[parent]: 41,
				[`${kind}Ids`]: [51, 52],
				monitored: true,
				...extra,
			},
		});
	};
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "arr-monitor-proof-"));
		database = join(directory, "owned.db");
		new Database(database).close();
		await synchronizeRuntimeSchema(`file:${database}`);
		runtime = await openRestoreRuntime({ databaseUrl: `file:${database}` });
		await runtime.bindDestination("synthetic-confirmation");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
		const address = provider.address();
		if (!address || typeof address === "string") throw Error("Missing owned HTTP");
		baseUrl = `http://127.0.0.1:${address.port}`;
		app.decorate("prisma", native.prisma);
		app.decorate("restoreRuntime", runtime);
		app.decorate("encryptor", encryptor);
		app.decorate("arrClientFactory", new ArrClientFactory(encryptor, 150));
		app.decorateRequest("currentUser", null);
		await run(async () => {
			for (const id of ["owner", "other"])
				await native.prisma.user.create({ data: { id, username: `synthetic-${id}` } });
		});
		app.addHook("preHandler", async (request) => {
			request.currentUser = { id: "owner", username: "synthetic-owner" } as NonNullable<
				typeof request.currentUser
			>;
		});
		await app.register(lifecycle);
		await app.register(registerMonitorRoutes, { prefix: "/api" });
		await app.ready();
	});
	beforeEach(async () => {
		ack = undefined;
		pre = rows(false);
		post = rows(true);
		wrongGet = undefined;
		writes = [];
		reads = [];
		gate = undefined;
		entered = undefined;
		release = undefined;
		const sqlite = new Database(database);
		sqlite.exec("DROP TRIGGER IF EXISTS reject_monitor_cache");
		sqlite.close();
		await run(async () => {
			await native.prisma.libraryCache.deleteMany({
				where: { instance: { userId: { in: ["owner", "other"] } } },
			});
			for (const service of services)
				for (const suffix of ["", "-peer", "-foreign"]) {
					const id = service + suffix;
					const data = {
						userId: suffix === "-foreign" ? "other" : "owner",
						service: service.toUpperCase() as "RADARR" | "SONARR" | "LIDARR" | "READARR",
						label: "private-label",
						baseUrl,
						encryptedApiKey: key.value,
						encryptionIv: key.iv,
						enabled: true,
						connectionGeneration: 0,
						identityGeneration: 0,
						encryptedHttpAuthCredentials: null,
						httpAuthEncryptionIv: null,
					};
					await native.prisma.serviceInstance.upsert({
						where: { id },
						create: { id, ...data },
						update: data,
					});
					await native.prisma.libraryCache.create({
						data: {
							instanceId: id,
							arrItemId: 41,
							itemType: types[service],
							title: "private-title",
							monitored: false,
							data: JSON.stringify({ ...resource(), customMetadata: "retained" }),
						},
					});
				}
		});
	});
	afterAll(async () => {
		await app.close();
		provider.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			provider.close((error) => (error ? reject(error) : resolve())),
		);
		await native?.close();
		await runtime?.close();
		const probe = new Database(database, { readonly: true });
		const integrity = probe.pragma("quick_check", { simple: true });
		probe.close();
		await rm(directory, { recursive: true });
		expect(integrity).toBe("ok");
		expect(existsSync(directory)).toBe(false);
	});
	it.each(services)(
		"confirms exact %s ACK and projects actual state without touching collision peers",
		async (service) => {
			const peer = await cache(service + "-peer"),
				foreign = await cache(service + "-foreign", "other");
			expect((await top(service)).statusCode).toBe(204);
			expect(writes).toHaveLength(1);
			expect(writes[0]!.body).toMatchObject({ id: 41, monitored: true, keep: 23 });
			expect((await cache(service)).monitored).toBe(true);
			expect((await cache(service + "-peer")).data).toBe(peer.data);
			expect((await cache(service + "-foreign", "other")).data).toBe(foreign.data);
		},
	);
	it.each(services)(
		"publishes differing valid %s observed state but does not confirm intent",
		async (service) => {
			await run(() =>
				native.prisma.libraryCache.updateMany({
					where: { instanceId: service, instance: { userId: "owner" } },
					data: {
						monitored: true,
						data: JSON.stringify({ ...resource(), monitored: true, customMetadata: "retained" }),
					},
				}),
			);
			ack = { ...resource(), monitored: false };
			expect((await top(service)).statusCode).toBe(502);
			expect(writes).toHaveLength(1);
			expect((await cache(service)).monitored).toBe(false);
			expect(JSON.parse((await cache(service)).data).monitored).toBe(false);
		},
	);
	it.each([
		{
			name: "partial",
			observed: [{ seasonNumber: 1, monitored: false }],
			flags: [true, false],
			count: 1,
		},
		{ name: "empty", observed: [], flags: [true, true], count: 2 },
		{
			name: "new-positive",
			observed: [{ seasonNumber: 2, monitored: true }],
			flags: [true, true, true],
			count: 3,
		},
	])(
		"retains unobserved cached seasons for $name ACK without claiming requested confirmation",
		async ({ observed, flags, count }) => {
			await run(() =>
				native.prisma.libraryCache.updateMany({
					where: { instanceId: "sonarr", instance: { userId: "owner" } },
					data: {
						data: JSON.stringify({
							...resource(),
							seasons: [
								{ seasonNumber: 0, monitored: true, customMetadata: "special-retained" },
								{ seasonNumber: 1, monitored: true, customMetadata: "season-retained" },
							],
							statistics: { monitoredSeasons: 2, episodeCount: 9 },
						}),
					},
				}),
			);
			ack = { id: 41, monitored: true, seasons: observed };
			expect((await top("sonarr")).statusCode).toBe(502);
			expect(writes).toHaveLength(1);
			const data = JSON.parse((await cache("sonarr")).data);
			expect(data.seasons.map((season: { monitored: boolean }) => season.monitored)).toEqual(flags);
			expect(data.seasons[0].customMetadata).toBe("special-retained");
			expect(data.seasons[1].customMetadata).toBe("season-retained");
			expect(data.statistics).toEqual({ monitoredSeasons: count, episodeCount: 9 });
		},
	);
	it.each([
		null,
		{},
		{ id: 42, monitored: true },
		{ id: 41, monitored: "true" },
		"malformed",
		"empty",
	])("does not confirm missing/wrong/malformed ACK %j", async (value) => {
		ack = value;
		const before = (await cache()).data;
		expect((await top()).statusCode).toBe(502);
		expect(writes).toHaveLength(1);
		expect((await cache()).data).toBe(before);
	});
	it.each([{ id: 42 }, {}, null])(
		"wrong/absent pre-target %j cannot authorize a PUT",
		async (value) => {
			wrongGet = value;
			expect((await top()).statusCode).toBe(502);
			expect(writes).toHaveLength(0);
		},
	);
	it.each([0, -1, 1.5, 9007199254740992])(
		"rejects invalid top-level ID %s before provider dispatch",
		async (itemId) => {
			expect((await top("radarr", { itemId })).statusCode).toBe(400);
			expect([...reads, ...writes]).toHaveLength(0);
		},
	);
	it.each([
		{ seasonNumbers: [1, 1] },
		{ seasonNumbers: [-1] },
		{ seasonNumbers: [1.5] },
		{ seasonNumbers: [7] },
	])(
		"rejects invalid/unresolved season selection $seasonNumbers before PUT",
		async ({ seasonNumbers }) => {
			expect((await top("sonarr", { seasonNumbers })).statusCode).toBe(400);
			expect(writes).toHaveLength(0);
		},
	);
	it.each(["sonarr", "lidarr", "readarr"] as const)(
		"confirms %s bulk with bounded selected-ID reads and one write",
		async (service) => {
			expect((await bulk(service)).statusCode).toBe(204);
			expect(writes).toHaveLength(1);
			expect(reads).toHaveLength(service === "readarr" ? 2 : 1);
			for (const url of reads) {
				const query = new URL(url, "http://owned.invalid").search;
				expect(query).toContain("51");
				expect(query).toContain("52");
			}
		},
	);
	it.each(["sonarr", "lidarr", "readarr"] as const)(
		"missing/wrong-parent %s prerequisite prevents writes",
		async (service) => {
			pre = [{ id: 51, seriesId: 99, artistId: 99, authorId: 99, monitored: false }];
			expect((await bulk(service)).statusCode).toBe(502);
			expect(writes).toHaveLength(0);
		},
	);
	it.each(["sonarr", "lidarr", "readarr"] as const)(
		"partial %s post-state cannot confirm all selected IDs",
		async (service) => {
			ack = [rows(true)[0]];
			post = ack;
			expect((await bulk(service)).statusCode).toBe(502);
			expect(writes).toHaveLength(1);
		},
	);
	for (const service of ["sonarr", "lidarr", "readarr"] as const) {
		it.each(["wrong-parent", "duplicate", "malformed-boolean", "different", "unrelated-only"])(
			`${service} exact post-state rejects %s without replay`,
			async (mode) => {
				let value: unknown = rows(true);
				if (mode === "wrong-parent")
					value = rows(true).map((row) => ({ ...row, seriesId: 99, artistId: 99, authorId: 99 }));
				if (mode === "duplicate") value = [...rows(true), rows(true)[0]];
				if (mode === "malformed-boolean")
					value = rows(true).map((row) => ({ ...row, monitored: "true" }));
				if (mode === "different") value = rows(false);
				if (mode === "unrelated-only")
					value = [{ id: 99, seriesId: 41, artistId: 41, authorId: 41, monitored: true }];
				ack = value;
				post = value;
				expect((await bulk(service)).statusCode).toBe(502);
				expect(writes).toHaveLength(1);
			},
		);
		it(`${service} wrong-parent prerequisite with every selected ID still prevents writes`, async () => {
			pre = rows(false).map((row) => ({ ...row, seriesId: 99, artistId: 99, authorId: 99 }));
			expect((await bulk(service)).statusCode).toBe(502);
			expect(writes).toHaveLength(0);
		});
		it(`${service} unrelated additional rows do not replace or revoke valid selected proof`, async () => {
			pre = [
				...rows(false),
				{ id: 99, seriesId: 99, artistId: 99, authorId: 99, monitored: false },
			];
			ack = [...rows(true), { id: 99, seriesId: 99, artistId: 99, authorId: 99, monitored: false }];
			post = ack;
			expect((await bulk(service)).statusCode).toBe(204);
			expect(writes).toHaveLength(1);
		});
	}
	it.each([
		"http503",
		"http401",
		"timeout",
		"malformed",
		[{ id: 51, authorId: 41, monitored: "true" }],
	])("Readarr void ACK requires valid bounded readback %j", async (value) => {
		post = value;
		expect((await bulk("readarr")).statusCode).toBe(502);
		expect(writes).toHaveLength(1);
		expect(reads).toHaveLength(2);
	});
	it("duplicate child IDs cannot dispatch a write", async () => {
		expect((await bulk("sonarr", { episodeIds: [51, 51] })).statusCode).toBe(400);
		expect(writes).toHaveLength(0);
	});
	it.each(["missing", "abort"])(
		"provider ACK with %s cache projection is not 204 and does not replay",
		async (mode) => {
			if (mode === "missing")
				await run(() =>
					native.prisma.libraryCache.deleteMany({
						where: { instanceId: "radarr", instance: { userId: "owner" } },
					}),
				);
			else {
				const sqlite = new Database(database);
				sqlite.exec(
					"CREATE TRIGGER reject_monitor_cache BEFORE UPDATE ON library_cache BEGIN SELECT RAISE(ABORT, 'synthetic-cache-failure'); END",
				);
				sqlite.close();
			}
			const response = await top();
			expect(response.statusCode).toBe(502);
			expect(response.body).not.toMatch(/private|synthetic-cache-failure/);
			expect(writes).toHaveLength(1);
		},
	);
	const changes = [
		{ userId: "other" },
		{ enabled: false },
		{ service: "SONARR" as const },
		{ baseUrl: "http://127.0.0.1:1" },
		{ encryptedApiKey: "changed" },
		{ encryptionIv: "changed" },
		{ encryptedHttpAuthCredentials: "changed" },
		{ httpAuthEncryptionIv: "changed" },
		{ connectionGeneration: 1 },
		{ identityGeneration: 1 },
	];
	for (const phase of ["GET", "PUT"] as const)
		it.each(changes)(`fences source changes during held ${phase}: %j`, async (data) => {
			gate = phase;
			let resume!: () => void;
			const arrived = new Promise<void>((resolve) => {
				entered = resolve;
			});
			release = new Promise<void>((resolve) => {
				resume = resolve;
			});
			const before = (await cache()).data;
			const pending = top();
			await arrived;
			await run(() =>
				native.prisma.serviceInstance.update({ where: { id: "radarr", userId: "owner" }, data }),
			);
			resume();
			expect((await pending).statusCode).toBe(502);
			expect(writes).toHaveLength(phase === "GET" ? 0 : 1);
			const row = await run(() =>
				native.prisma.libraryCache.findFirstOrThrow({
					where: { instanceId: "radarr", instance: { userId: data.userId ?? "owner" } },
				}),
			);
			expect(row.data).toBe(before);
		});
	it("unrelated label change does not revoke a held valid update", async () => {
		gate = "GET";
		let resume!: () => void;
		const arrived = new Promise<void>((resolve) => {
			entered = resolve;
		});
		release = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const pending = top();
		await arrived;
		await run(() =>
			native.prisma.serviceInstance.update({
				where: { id: "radarr", userId: "owner" },
				data: { label: "renamed" },
			}),
		);
		resume();
		expect((await pending).statusCode).toBe(204);
	});
});
