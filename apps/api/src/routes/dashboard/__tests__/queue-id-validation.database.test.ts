import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ArrClientFactory } from "../../../lib/arr/client-factory.js";
import { Encryptor } from "../../../lib/auth/encryption.js";
import { openRestoreRuntime } from "../../../lib/backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../../lib/backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../../lib/backup/runtime-schema-startup.js";
import { queueRoutes } from "../queue-routes.js";

const services = ["sonarr", "radarr", "lidarr", "readarr"] as const;
type Service = (typeof services)[number];
type Flags = { removeFromClient?: boolean; blocklist?: boolean; changeCategory?: boolean };
type Event = {
	method: string | undefined;
	path: string;
	query: Record<string, string>;
	body: unknown;
	authValid: boolean;
	accepted: boolean;
};

// Only synthetic request auth and recording provider HTTP are seams. Runtime,
// native Prisma owner lookup, encrypted factory and installed SDK are real.
describe("strict queue IDs at native owner and installed SDK HTTP boundary", () => {
	let directory: string, database: string;
	let runtime: Awaited<ReturnType<typeof openRestoreRuntime>>;
	let native: ReturnType<typeof createRuntimePrismaClient>;
	const app = Fastify({ logger: false });
	const encryptor = new Encryptor("74".repeat(32));
	const wires = new Map<Service, Awaited<ReturnType<typeof wire>>>();
	const evidence: Array<Record<string, unknown>> = [];
	let before: unknown, lastRequest: unknown, lastResponse: unknown, caseName: string;
	const run = <T>(action: () => Promise<T>) => runtime.runOperation(action);
	const snapshot = () =>
		run(async () => ({
			sources: await native.prisma.serviceInstance.findMany({ orderBy: { id: "asc" } }),
			trackedImportOperations: await native.prisma.arrImportOperation.count(),
		}));

	async function wire(service: Service) {
		const events: Event[] = [],
			tasks = new Set<Promise<void>>();
		const server = createServer((request, response) => {
			const task = (async () => {
				const url = new URL(request.url!, "http://synthetic.invalid");
				let text = "";
				for await (const chunk of request) {
					text += String(chunk);
					assert(text.length < 4096);
				}
				const accepted =
					request.method === "DELETE" &&
					/^\/api\/v[13]\/queue\/[^/]+$/.test(url.pathname) &&
					request.headers["x-api-key"] === "synthetic-queue-key";
				events.push({
					method: request.method,
					path: url.pathname,
					query: Object.fromEntries(url.searchParams),
					body: text ? JSON.parse(text) : null,
					authValid: request.headers["x-api-key"] === "synthetic-queue-key",
					accepted,
				});
				response.writeHead(accepted ? 204 : 405).end();
			})().catch(() => {
				response.destroy();
			});
			tasks.add(task);
			void task.finally(() => tasks.delete(task));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert(address && typeof address !== "string");
		return {
			service,
			url: `http://127.0.0.1:${address.port}`,
			events,
			async close() {
				await Promise.all([...tasks]);
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				expect(tasks.size).toBe(0);
				expect(server.listening).toBe(false);
			},
		};
	}

	beforeAll(async () => {
		const base = process.env.ARR_QUEUE_ID_TEST_ROOT ?? tmpdir();
		await mkdir(base, { recursive: true });
		directory = await mkdtemp(join(base, "arr-queue-id-"));
		database = join(directory, "owned.db");
		new Database(database).close();
		await synchronizeRuntimeSchema(`file:${database}`);
		runtime = await openRestoreRuntime({ databaseUrl: `file:${database}` });
		await runtime.bindDestination("synthetic-queue-id-regression");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		await run(() =>
			native.prisma.user.createMany({
				data: [
					{ id: "owner", username: "synthetic-owner" },
					{ id: "foreign", username: "synthetic-foreign" },
				],
			}),
		);
		for (const service of services) {
			const provider = await wire(service);
			wires.set(service, provider);
			for (const suffix of ["", "-foreign", "-disabled"]) {
				const key = encryptor.encrypt("synthetic-queue-key");
				await run(() =>
					native.prisma.serviceInstance.create({
						data: {
							id: service + suffix,
							userId: suffix === "-foreign" ? "foreign" : "owner",
							service: service.toUpperCase() as "SONARR" | "RADARR" | "LIDARR" | "READARR",
							baseUrl: provider.url,
							label: "Synthetic queue source",
							enabled: suffix !== "-disabled",
							encryptedApiKey: key.value,
							encryptionIv: key.iv,
							connectionGeneration: 7,
							identityGeneration: 3,
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
		app.addHook("preHandler", async (request, reply) => {
			if (request.headers.authorization !== "Bearer synthetic-owner-auth")
				return reply.code(401).send({ error: "Synthetic auth refused" });
			request.currentUser = {
				id: "owner",
				username: "synthetic-owner",
			} as typeof request.currentUser;
		});
		await app.register(queueRoutes, { prefix: "/api" });
		await app.ready();
	});
	beforeEach(async (context) => {
		caseName = context.task.name;
		lastRequest = undefined;
		lastResponse = undefined;
		for (const provider of wires.values()) provider.events.length = 0;
		before = await snapshot();
	});
	afterEach(async () => {
		const after = await snapshot();
		evidence.push({
			caseName,
			request: lastRequest,
			response: lastResponse,
			before,
			after,
			providers: [...wires.values()].map((provider) => ({
				service: provider.service,
				events: structuredClone(provider.events),
			})),
		});
		expect(after).toEqual(before);
		expect(after.trackedImportOperations).toBe(0);
	});
	afterAll(async () => {
		await app.close();
		await native?.close();
		await runtime?.close();
		for (const provider of wires.values()) await provider.close();
		const checks = [];
		for (const file of [
			database,
			`${database}.arr-restore-runtime/owner.sqlite3`,
			`${database}.arr-restore-runtime/operations.sqlite3`,
		]) {
			const probe = new Database(file, { readonly: true, fileMustExist: true });
			try {
				const integrity = probe.pragma("quick_check"),
					foreignKeys = probe.pragma("foreign_key_check");
				expect(integrity).toEqual([{ quick_check: "ok" }]);
				expect(foreignKeys).toEqual([]);
				checks.push({ file, integrity, foreignKeyViolations: 0 });
			} finally {
				probe.close();
				expect(probe.open).toBe(false);
			}
		}
		if (process.env.ARR_QUEUE_ID_EVIDENCE_ROOT)
			await writeFile(
				join(process.env.ARR_QUEUE_ID_EVIDENCE_ROOT, "queue-id-native-evidence.json"),
				`${JSON.stringify(
					{
						directory,
						database,
						cases: evidence,
						closure: {
							appClosed: true,
							nativeClosed: true,
							runtimeClosed: true,
							providersClosed: true,
							checks,
						},
					},
					null,
					2,
				)}\n`,
				{ flag: "wx", mode: 0o600 },
			);
		else await rm(directory, { recursive: true });
	});

	async function request(
		service: Service,
		bulk: boolean,
		target: string | number | Array<string | number>,
		action: "retry" | "delete" = "delete",
		flags: Flags = {},
		instanceId: string = service,
		bodyService: Service = service,
	) {
		const payload = {
			instanceId,
			service: bodyService,
			...(bulk ? { ids: target } : { itemId: target }),
			action,
			...flags,
			search: false,
		};
		lastRequest = {
			method: "POST",
			path: `/api/dashboard/queue/${bulk ? "bulk" : "action"}`,
			payload,
		};
		const response = await run(() =>
			app.inject({
				method: "POST",
				url: `/api/dashboard/queue/${bulk ? "bulk" : "action"}`,
				headers: { authorization: "Bearer synthetic-owner-auth" },
				payload,
			}),
		);
		lastResponse = { statusCode: response.statusCode, body: response.body };
		return response;
	}
	function expectNoWrites() {
		expect([...wires.values()].flatMap((provider) => provider.events)).toEqual([]);
	}
	function expectLiteralDelete(service: Service, bulk: boolean, flags: Required<Flags>) {
		const version = service === "sonarr" || service === "radarr" ? "v3" : "v1";
		const combined = service === "lidarr" && bulk;
		expect(wires.get(service)!.events).toEqual([
			{
				method: "DELETE",
				path: `/api/${version}/queue/${bulk ? "bulk" : "11"}`,
				query: combined
					? {}
					: {
							removeFromClient: String(flags.removeFromClient),
							blocklist: String(flags.blocklist),
							changeCategory: String(flags.changeCategory),
						},
				body: bulk ? (combined ? { ids: [11, 12], ...flags } : { ids: [11, 12] }) : null,
				authValid: true,
				accepted: true,
			},
		]);
		for (const other of services.filter((name) => name !== service))
			expect(wires.get(other)!.events).toEqual([]);
	}
	for (const service of services)
		describe(service, () => {
			it("refuses malformed single identity before provider dispatch", async () => {
				const response = await request(service, false, "11garbage");
				expect(response.statusCode).toBe(400);
				expectNoWrites();
			});
			it("refuses mixed malformed bulk identity before every provider write", async () => {
				const response = await request(service, true, [11, "12garbage"]);
				expect(response.statusCode).toBe(400);
				expectNoWrites();
			});
			it.each([11.5, 0, 9007199254740992])("refuses invalid numeric single %s", async (value) => {
				expect((await request(service, false, value)).statusCode).toBe(400);
				expectNoWrites();
			});
			it.each([11.5, 0, 9007199254740992])(
				"refuses mixed invalid numeric bulk %s all-or-none",
				async (value) => {
					expect((await request(service, true, [11, value])).statusCode).toBe(400);
					expectNoWrites();
				},
			);
			it("preserves numeric single retry and default options", async () => {
				expect((await request(service, false, 11, "retry")).statusCode).toBe(204);
				expectLiteralDelete(service, false, {
					removeFromClient: true,
					blocklist: false,
					changeCategory: false,
				});
			});
			it("preserves formatted decimal single and explicit remove options", async () => {
				const flags = { removeFromClient: false, blocklist: true, changeCategory: true };
				expect((await request(service, false, " 0011 ", "delete", flags)).statusCode).toBe(204);
				expectLiteralDelete(service, false, flags);
			});
			it("preserves numeric bulk retry and default options", async () => {
				expect((await request(service, true, [11, 12], "retry")).statusCode).toBe(204);
				expectLiteralDelete(service, true, {
					removeFromClient: true,
					blocklist: false,
					changeCategory: false,
				});
			});
			it("preserves formatted decimal bulk and explicit remove options", async () => {
				const flags = { removeFromClient: false, blocklist: true, changeCategory: true };
				expect((await request(service, true, ["0011", " 12 "], "delete", flags)).statusCode).toBe(
					204,
				);
				expectLiteralDelete(service, true, flags);
			});
			it.each(["-foreign", "-disabled"])(
				"retains native owned/enabled refusal for %s",
				async (suffix) => {
					expect(
						(await request(service, false, 11, "delete", {}, service + suffix)).statusCode,
					).toBe(404);
					expectNoWrites();
				},
			);
			it("retains service-mismatch refusal without provider writes", async () => {
				expect(
					(
						await request(
							service,
							false,
							11,
							"delete",
							{},
							service,
							service === "sonarr" ? "radarr" : "sonarr",
						)
					).statusCode,
				).toBe(400);
				expectNoWrites();
			});
		});
});
