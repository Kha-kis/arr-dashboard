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
import { registerFetchRoutes } from "../fetch-routes.js";
import { registerMonitorRoutes } from "../monitor-routes.js";

// Real admitted database, registered routes, encrypted instance and SDK HTTP.
// Only the loopback provider and native fixture-user authentication are synthetic.
describe("acknowledged Sonarr season cache readback", () => {
	let directory: string, database: string;
	let runtime: Awaited<ReturnType<typeof openRestoreRuntime>>;
	let native: ReturnType<typeof createRuntimePrismaClient>;
	const app = Fastify({ logger: false });
	const resource = () => ({
		id: 41,
		title: "Synthetic series",
		monitored: true,
		qualityProfileId: 23,
		tags: [2, 7],
		customSentinel: { keep: true },
		seasons: [
			{
				seasonNumber: 0,
				monitored: true,
				statistics: { totalEpisodeCount: 2, episodeFileCount: 1 },
			},
			{
				seasonNumber: 1,
				monitored: false,
				statistics: { totalEpisodeCount: 4, episodeFileCount: 1 },
			},
			{
				seasonNumber: 2,
				monitored: true,
				statistics: { totalEpisodeCount: 8, episodeFileCount: 3 },
			},
		],
	});
	let stored = resource(),
		mode = "normal",
		entered: (() => void) | undefined,
		release: Promise<void> | undefined;
	let requests: { method: string; body?: ReturnType<typeof resource> }[] = [];
	const provider = createServer(
		(request, response) =>
			void (async () => {
				if (
					request.url !== "/api/v3/series/41" ||
					request.headers["x-api-key"] !== "synthetic-key"
				) {
					response.writeHead(404).end();
					return;
				}
				let text = "";
				for await (const chunk of request) text += String(chunk);
				const body = text ? JSON.parse(text) : undefined;
				requests.push({ method: request.method!, body });
				if (request.method === "GET") {
					response.setHeader("content-type", "application/json");
					response.end(JSON.stringify(stored));
					return;
				}
				entered?.();
				if (release) await release;
				if (mode === "reject") {
					response.writeHead(503).end();
					return;
				}
				stored = structuredClone(body);
				if (mode === "lost") {
					request.socket.destroy();
					return;
				}
				const acknowledged: Record<string, unknown> = structuredClone(stored);
				if (mode === "different") {
					stored.seasons[2]!.monitored = true;
					acknowledged.seasons = stored.seasons;
				}
				if (mode === "missing") delete acknowledged.seasons;
				if (mode === "malformed") acknowledged.seasons = [{ seasonNumber: 2, monitored: "false" }];
				if (mode === "wrong-target") acknowledged.id = 42;
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify(acknowledged));
			})().catch(() => response.destroy()),
	);
	const run = <T>(operation: () => Promise<T>) => runtime.runOperation(operation);
	const row = (instanceId = "sonarr-b") =>
		run(() =>
			native.prisma.libraryCache.findFirstOrThrow({ where: { instanceId, arrItemId: 41 } }),
		);
	const cached = async () => JSON.parse((await row()).data);
	const change = (monitored: boolean, seasonNumbers?: number[]) =>
		app.inject({
			method: "POST",
			url: "/api/library/monitor",
			payload: {
				instanceId: "sonarr-b",
				service: "sonarr",
				itemId: 41,
				monitored,
				...(seasonNumbers ? { seasonNumbers } : {}),
			},
		});
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "arr-season-readback-"));
		database = join(directory, "owned.db");
		new Database(database).close();
		await synchronizeRuntimeSchema(`file:${database}`);
		runtime = await openRestoreRuntime({ databaseUrl: `file:${database}` });
		await runtime.bindDestination("synthetic-season");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
		const address = provider.address();
		if (!address || typeof address === "string") throw Error("Missing owned provider");
		const encryptor = new Encryptor("73".repeat(32));
		app.decorate("prisma", native.prisma);
		app.decorate("restoreRuntime", runtime);
		app.decorate("encryptor", encryptor);
		app.decorate("arrClientFactory", new ArrClientFactory(encryptor, 1500));
		app.decorateRequest("currentUser", null);
		await run(async () => {
			for (const id of ["owner", "other"])
				await native.prisma.user.create({ data: { id, username: `synthetic-${id}` } });
			for (const id of ["sonarr-a", "sonarr-b", "sonarr-f"]) {
				const key = encryptor.encrypt("synthetic-key");
				await native.prisma.serviceInstance.create({
					data: {
						id,
						userId: id === "sonarr-f" ? "other" : "owner",
						service: "SONARR",
						label: "Synthetic series",
						baseUrl: `http://127.0.0.1:${address.port}`,
						encryptedApiKey: key.value,
						encryptionIv: key.iv,
					},
				});
			}
		});
		app.addHook("preHandler", async (request) => {
			request.currentUser = { id: "owner", username: "synthetic-owner" } as NonNullable<
				typeof request.currentUser
			>;
		});
		await app.register(lifecycle);
		await app.register(registerMonitorRoutes, { prefix: "/api" });
		await app.register(registerFetchRoutes, { prefix: "/api" });
		await app.ready();
	});
	beforeEach(async () => {
		stored = resource();
		requests = [];
		mode = "normal";
		entered = undefined;
		release = undefined;
		await run(async () => {
			for (const instanceId of ["sonarr-a", "sonarr-b", "sonarr-f"]) {
				const data = JSON.stringify({
					id: 41,
					instanceId,
					instanceName: "Synthetic series",
					service: "sonarr",
					type: "series",
					title: "Synthetic series",
					monitored: true,
					customMetadata: { keep: "cached" },
					statistics: { monitoredSeasons: 2, episodeCount: 14, episodeFileCount: 5 },
					seasons: [
						{
							seasonNumber: 0,
							monitored: true,
							episodeCount: 2,
							episodeFileCount: 1,
							missingEpisodeCount: 1,
						},
						{
							seasonNumber: 1,
							monitored: false,
							episodeCount: 4,
							episodeFileCount: 1,
							missingEpisodeCount: 0,
						},
						{
							seasonNumber: 2,
							title: "Synthetic season title",
							monitored: true,
							episodeCount: 8,
							episodeFileCount: 3,
							missingEpisodeCount: 5,
							customMetadata: "retained",
						},
					],
				});
				await native.prisma.libraryCache.upsert({
					where: {
						instanceId_arrItemId_itemType: { instanceId, arrItemId: 41, itemType: "series" },
					},
					create: {
						instanceId,
						arrItemId: 41,
						itemType: "series",
						title: "Synthetic series",
						monitored: true,
						data,
					},
					update: { monitored: true, data },
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
	});
	it("publishes acknowledged selected-season flags and derived counts only after ACK, retaining peers and metadata", async () => {
		const peers = [(await row("sonarr-a")).data, (await row("sonarr-f")).data];
		let resume!: () => void;
		const arrived = new Promise<void>((resolve) => {
			entered = resolve;
		});
		release = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const pending = change(false, [2]);
		await arrived;
		expect((await cached()).seasons[2].monitored).toBe(true);
		resume();
		expect((await pending).statusCode).toBe(204);
		expect(stored.seasons.map((s) => s.monitored)).toEqual([true, false, false]);
		const item = await cached();
		expect(item.seasons[2]).toMatchObject({
			monitored: false,
			missingEpisodeCount: 0,
			episodeCount: 8,
			episodeFileCount: 3,
			title: "Synthetic season title",
			customMetadata: "retained",
		});
		expect(item.statistics).toEqual({ monitoredSeasons: 1, episodeCount: 14, episodeFileCount: 5 });
		expect(item.customMetadata).toEqual({ keep: "cached" });
		expect(item.seasons.map((season: { monitored: boolean }) => season.monitored)).toEqual([
			true,
			false,
			false,
		]);
		expect(item.seasons[0]).toEqual({
			seasonNumber: 0,
			monitored: true,
			episodeCount: 2,
			episodeFileCount: 1,
			missingEpisodeCount: 1,
		});
		expect(item.seasons[1]).toEqual({
			seasonNumber: 1,
			monitored: false,
			episodeCount: 4,
			episodeFileCount: 1,
			missingEpisodeCount: 0,
		});
		expect((await row()).monitored).toBe(false);
		const list = await app.inject({ url: "/api/library?instanceId=sonarr-b" });
		expect(list.statusCode).toBe(200);
		expect(list.json().items[0].seasons[2].monitored).toBe(false);
		expect((await change(true, [2])).statusCode).toBe(204);
		expect((await cached()).seasons[2]).toMatchObject({ monitored: true, missingEpisodeCount: 5 });
		expect((await cached()).statistics.monitoredSeasons).toBe(2);
		expect([(await row("sonarr-a")).data, (await row("sonarr-f")).data]).toEqual(peers);
		expect(requests.filter((r) => r.method === "PUT")).toHaveLength(2);
		expect(requests[1]!.body).toMatchObject({
			customSentinel: { keep: true },
			qualityProfileId: 23,
			tags: [2, 7],
		});
	});
	it.each([
		{ monitored: true, flags: [false, true, true], count: 2 },
		{ monitored: false, flags: [false, false, false], count: 0 },
	])(
		"keeps whole-series specials policy for monitored=$monitored",
		async ({ monitored, flags, count }) => {
			expect((await change(monitored)).statusCode).toBe(204);
			expect(stored.seasons.map((s) => s.monitored)).toEqual(flags);
			expect((await cached()).seasons.map((s: { monitored: boolean }) => s.monitored)).toEqual(
				flags,
			);
			expect((await cached()).statistics.monitoredSeasons).toBe(count);
		},
	);
	it("uses actual accepted resource flags rather than assuming the requested flags were accepted", async () => {
		mode = "different";
		expect((await change(false, [2])).statusCode).toBe(502);
		expect(stored.seasons[2]!.monitored).toBe(true);
		expect((await cached()).seasons[2].monitored).toBe(true);
		expect(requests).toHaveLength(2);
	});
	it.each(["reject", "lost"])(
		"does not publish or replay when provider reply is %s",
		async (failure) => {
			mode = failure;
			const before = (await row()).data;
			expect((await change(false, [2])).statusCode).toBeGreaterThanOrEqual(400);
			expect((await row()).data).toBe(before);
			expect(requests.filter((r) => r.method === "PUT")).toHaveLength(1);
			expect(stored.seasons[2]!.monitored).toBe(failure === "reject");
		},
	);
	it.each(["missing", "malformed"])(
		"retains prior season evidence when acknowledged seasons are %s",
		async (responseMode) => {
			mode = responseMode;
			const before = await cached();
			expect((await change(false, [2])).statusCode).toBe(502);
			expect((await cached()).seasons).toEqual(before.seasons);
			expect((await cached()).statistics).toEqual(before.statistics);
			expect(requests).toHaveLength(2);
		},
	);
	it("does not publish a PUT resource for another target", async () => {
		mode = "wrong-target";
		const before = (await row()).data;
		await change(false, [2]);
		expect((await row()).data).toBe(before);
		expect(requests).toHaveLength(2);
	});
});
