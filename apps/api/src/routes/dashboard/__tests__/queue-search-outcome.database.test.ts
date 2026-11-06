import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { queueRoutes } from "../queue-routes.js";

const services = ["sonarr", "radarr", "lidarr", "readarr"] as const;
type Service = (typeof services)[number];
const cases = [
	["sonarr", { episodeIds: [21], seriesId: 31 }, { name: "EpisodeSearch", episodeIds: [21] }],
	["sonarr", { seriesId: 31 }, { name: "SeriesSearch", seriesId: 31 }],
	["radarr", { movieId: 41 }, { name: "MoviesSearch", movieIds: [41] }],
	["lidarr", { albumId: 51, artistId: 61 }, { name: "AlbumSearch", albumIds: [51] }],
	["lidarr", { artistId: 61 }, { name: "ArtistSearch", artistId: 61 }],
	["readarr", { bookId: 71, authorId: 81 }, { name: "BookSearch", bookIds: [71] }],
	["readarr", { authorId: 81 }, { name: "AuthorSearch", authorId: 81 }],
] as const;
describe("native owned delete-and-search step outcomes", () => {
	let directory = "",
		database = "",
		ready = false;
	let runtime: Awaited<ReturnType<typeof openRestoreRuntime>>;
	let native: ReturnType<typeof createRuntimePrismaClient>;
	const app = Fastify({ logger: false }),
		encryptor = new Encryptor("74".repeat(32));
	const events: Array<{
		service: string;
		method: string;
		path: string;
		query: Record<string, string>;
		body: unknown;
		status: number;
	}> = [];
	const providers: Array<ReturnType<typeof createServer>> = [];
	const records: unknown[] = [];
	let mode: "submitted" | "unconfirmed" | "delete-failed" = "submitted",
		before: unknown;
	const run = <T>(action: () => Promise<T>) => runtime.runOperation(action);
	const snapshot = () =>
		run(async () => ({
			sources: await native.prisma.serviceInstance.findMany({ orderBy: { id: "asc" } }),
			imports: await native.prisma.arrImportOperation.count(),
		}));
	beforeAll(async () => {
		const testRoot = process.env.W1037_DB_ROOT ?? tmpdir();
		await mkdir(testRoot, { recursive: true });
		directory = await mkdtemp(join(testRoot, "native-search-"));
		database = join(directory, "owned.db");
		new Database(database).close();
		await synchronizeRuntimeSchema(`file:${database}`);
		runtime = await openRestoreRuntime({ databaseUrl: `file:${database}` });
		await runtime.bindDestination("synthetic-search-outcome");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		await run(() =>
			native.prisma.user.createMany({
				data: [
					{ id: "owner", username: "Synthetic" },
					{ id: "foreign", username: "Foreign" },
				],
			}),
		);
		for (const service of services) {
			const server = createServer(async (request, reply) => {
				const url = new URL(request.url!, "http://synthetic.invalid");
				let body = "";
				for await (const value of request) body += String(value);
				assert.equal(request.headers["x-api-key"], "synthetic-key");
				const status =
					request.method === "DELETE"
						? mode === "delete-failed"
							? 500
							: 204
						: mode === "unconfirmed"
							? 500
							: 201;
				events.push({
					service,
					method: request.method!,
					path: url.pathname,
					query: Object.fromEntries(url.searchParams),
					body: body ? JSON.parse(body) : null,
					status,
				});
				if (status === 204) reply.writeHead(status).end();
				else
					reply.writeHead(status, { "content-type": "application/json" }).end(
						JSON.stringify(
							status === 201
								? {
										id: 501,
										name: "SyntheticSearch",
										status: "queued",
										queued: "2026-10-25T12:00:00Z",
										body: body ? JSON.parse(body) : {},
									}
								: { message: "Synthetic upstream rejected" },
						),
					);
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			providers.push(server);
			const address = server.address();
			assert(address && typeof address !== "string");
			for (const suffix of ["", "-foreign", "-disabled"]) {
				const key = encryptor.encrypt("synthetic-key");
				await run(() =>
					native.prisma.serviceInstance.create({
						data: {
							id: service + suffix,
							userId: suffix === "-foreign" ? "foreign" : "owner",
							service: service.toUpperCase() as "SONARR" | "RADARR" | "LIDARR" | "READARR",
							baseUrl: `http://127.0.0.1:${address.port}`,
							label: "Synthetic",
							enabled: suffix !== "-disabled",
							encryptedApiKey: key.value,
							encryptionIv: key.iv,
						},
					}),
				);
			}
		}
		app.decorate("prisma", native.prisma);
		app.decorate("restoreRuntime", runtime);
		app.decorate("encryptor", encryptor);
		app.decorate("dbProvider", "sqlite");
		app.decorate("arrClientFactory", new ArrClientFactory(encryptor, 2000));
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (request) => {
			request.currentUser = { id: "owner", username: "Synthetic" } as typeof request.currentUser;
		});
		await app.register(queueRoutes, { prefix: "/api" });
		await app.ready();
		before = await snapshot();
		ready = true;
	}, 30_000);
	beforeEach(() => {
		events.length = 0;
		mode = "submitted";
	});
	async function request(
		service: Service,
		payload?: unknown,
		instanceId: string = service,
		bodyService: Service = service,
	) {
		const input = {
			instanceId,
			service: bodyService,
			itemId: 11,
			action: "delete",
			search: true,
			searchPayload: payload,
			removeFromClient: true,
			blocklist: true,
		};
		const response = await run(() =>
			app.inject({ method: "POST", url: "/api/dashboard/queue/action", payload: input }),
		);
		records.push({
			input,
			status: response.statusCode,
			body: response.body,
			events: structuredClone(events),
		});
		expect(await snapshot()).toEqual(before);
		return response;
	}
	for (const [service, payload, command] of cases)
		it(`${service} maps literal ${command.name} submission after deletion`, async () => {
			const response = await request(service, payload);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({ removal: "completed", search: "submitted" });
			expect(events).toEqual([
				{
					service,
					method: "DELETE",
					path: `/api/${["sonarr", "radarr"].includes(service) ? "v3" : "v1"}/queue/11`,
					query: { removeFromClient: "true", blocklist: "true", changeCategory: "false" },
					body: null,
					status: 204,
				},
				{
					service,
					method: "POST",
					path: `/api/${["sonarr", "radarr"].includes(service) ? "v3" : "v1"}/command`,
					query: {},
					body: command,
					status: 201,
				},
			]);
		});
	for (const [service, payload] of cases)
		it(`${service} returns completed removal but unconfirmed search`, async () => {
			mode = "unconfirmed";
			const response = await request(service, payload);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({ removal: "completed", search: "unconfirmed" });
			expect(response.body).not.toContain("Synthetic upstream");
			expect(events.map((value) => value.method)).toEqual(["DELETE", "POST"]);
		});
	for (const [service, payload] of cases)
		it(`${service} refuses failed removal before command`, async () => {
			mode = "delete-failed";
			const response = await request(service, payload);
			expect(response.statusCode).toBe(500);
			expect(events.map((value) => value.method)).toEqual(["DELETE"]);
		});
	for (const service of services)
		for (const payload of [
			undefined,
			{},
			{ movieId: 0, seriesId: 0, artistId: 0, authorId: 0 },
			{ movieId: 1.2, episodeIds: [], albumId: -1, bookId: 9007199254740992 },
		])
			it(`${service} refuses unusable ${JSON.stringify(payload)} before every write`, async () => {
				const response = await request(service, payload);
				expect(response.statusCode).toBe(400);
				expect(events).toEqual([]);
			});
	for (const suffix of ["-foreign", "-disabled"])
		it(`refuses ${suffix} source before every write`, async () => {
			const response = await request("radarr", { movieId: 41 }, "radarr" + suffix);
			expect([403, 404, 409]).toContain(response.statusCode);
			expect(events).toEqual([]);
		});
	for (const [service, payload] of [
		["sonarr", { episodeIds: [0], seriesId: 31 }],
		["sonarr", { episodeIds: [21, 1.2], seriesId: 31 }],
		["sonarr", { episodeIds: [], seriesId: 31 }],
		["lidarr", { albumId: -1, artistId: 61 }],
		["lidarr", { albumId: 9007199254740992, artistId: 61 }],
		["readarr", { bookId: 0, authorId: 81 }],
	] as const)
		it(`${service} refuses invalid narrower targets instead of searching a broader resource`, async () => {
			expect((await request(service, payload)).statusCode).toBe(400);
			expect(events).toEqual([]);
		});
	it("deduplicates valid episode command targets without broadening to series", async () => {
		expect((await request("sonarr", { episodeIds: [21, 21], seriesId: 31 })).statusCode).toBe(200);
		expect(events[1]?.body).toEqual({ name: "EpisodeSearch", episodeIds: [21] });
	});
	it("does not accept unsupported plural public album aliases", async () => {
		expect((await request("lidarr", { albumIds: [51] })).statusCode).toBe(400);
		expect(events).toEqual([]);
	});
	it("refuses mismatched service without provider writes", async () => {
		expect((await request("radarr", { movieId: 41 }, "radarr", "sonarr")).statusCode).toBe(400);
		expect(events).toEqual([]);
	});
	afterAll(async () => {
		const closeErrors: unknown[] = [];
		for (const close of [() => app.close(), () => native?.close(), () => runtime?.close()]) {
			try {
				await close();
			} catch (error) {
				closeErrors.push(error);
			}
		}
		for (const server of providers) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			expect(server.listening).toBe(false);
		}
		if (closeErrors.length) throw new AggregateError(closeErrors, "Native fixture closure failed");
		try {
			if (!ready) return;
			const checks = [];
			for (const file of [
				database,
				`${database}.arr-restore-runtime/owner.sqlite3`,
				`${database}.arr-restore-runtime/operations.sqlite3`,
			]) {
				const db = new Database(file, { readonly: true, fileMustExist: true });
				try {
					const quick = db.pragma("quick_check"),
						fk = db.pragma("foreign_key_check");
					expect(quick).toEqual([{ quick_check: "ok" }]);
					expect(fk).toEqual([]);
					checks.push({ file, quick, fk });
				} finally {
					db.close();
				}
			}
			if (process.env.W1037_EVIDENCE_ROOT)
				await writeFile(
					join(process.env.W1037_EVIDENCE_ROOT, "native-search.json"),
					`${JSON.stringify({ records, closure: { app: true, native: true, runtime: true, providerCount: providers.length, checks } }, null, 2)}\n`,
					{ flag: "wx", mode: 0o600 },
				);
		} finally {
			if (directory && !process.env.W1037_EVIDENCE_ROOT) await rm(directory, { recursive: true });
		}
	});
});
