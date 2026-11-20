import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ArrClientFactory } from "../../arr/client-factory.js";
import { Encryptor } from "../../auth/encryption.js";
import { synchronizeRuntimeSchema } from "../../backup/runtime-schema-startup.js";
import { openRestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import { backfillInfoHashForRow } from "../infohash-backfill.js";
const fixtures: Awaited<ReturnType<typeof buildFixture>>[] = [];
async function fixture() {
	const f = await buildFixture();
	fixtures.push(f);
	return f;
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}
async function buildFixture() {
	const directory = await mkdtemp(join(tmpdir(), "qui-history-fence-")),
		file = join(directory, "owned.db");
	new Database(file).close();
	await synchronizeRuntimeSchema("file:" + file);
	const runtime = await openRestoreRuntime({ databaseUrl: "file:" + file });
	await runtime.bindDestination("synthetic-history-fence");
	await runtime.activate();
	const native = createRuntimePrismaClient(runtime),
		prisma = native.prisma,
		run = <T>(fn: () => Promise<T>) => runtime.runOperation(fn),
		encryptor = new Encryptor("44".repeat(32)),
		key = encryptor.encrypt("synthetic-token"),
		entered = deferred(),
		release = deferred();
	let held = true;
	const requests: string[] = [];
	const server = createServer(async (req, res) => {
		requests.push(req.method + " " + req.url);
		if (req.method !== "GET" || req.url !== "/api/v3/history/movie?movieId=1") {
			res.writeHead(404).end();
			return;
		}
		entered.resolve();
		if (held) await release.promise;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify([{ downloadId: "f".repeat(45) }, { downloadId: "A".repeat(40) }]));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const address = server.address();
	if (!address || typeof address === "string") throw Error("address");
	await run(async () => {
		for (const id of ["owner", "foreign"])
			await prisma.user.create({ data: { id, username: "synthetic-" + id } });
		for (const userId of ["owner", "foreign"])
			await prisma.serviceInstance.create({
				data: {
					id: userId + "-arr",
					userId,
					service: "RADARR",
					label: "Synthetic",
					baseUrl: "http://127.0.0.1:" + address.port,
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
					connectionGeneration: 7,
					identityGeneration: 3,
				},
			});
		await prisma.libraryCache.create({
			data: {
				id: "row",
				instanceId: "owner-arr",
				itemType: "movie",
				arrItemId: 1,
				title: "Synthetic",
				data: '{"revision":1}',
			},
		});
	});
	const app = Fastify();
	app.decorate("prisma", prisma);
	app.decorate("arrClientFactory", new ArrClientFactory(encryptor));
	const f = {
		directory,
		file,
		runtime,
		native,
		prisma,
		run,
		app,
		server,
		entered,
		release,
		requests,
		unhold: () => {
			held = false;
			release.resolve();
		},
	};
	return f;
}
afterEach(async () => {
	for (const f of fixtures.splice(0)) {
		f.unhold();
		await f.app.close();
		await new Promise<void>((resolve, reject) =>
			f.server.close((e) => (e ? reject(e) : resolve())),
		);
		await f.native.close();
		await f.runtime.close();
		const db = new Database(f.file, { readonly: true });
		expect(db.pragma("quick_check", { simple: true })).toBe("ok");
		db.close();
		await rm(f.directory, { recursive: true });
	}
});
const args = (f: Awaited<ReturnType<typeof buildFixture>>) => ({
	app: f.app,
	cacheRowId: "row",
	userId: "owner",
	arrInstanceId: "owner-arr",
	itemType: "movie" as const,
	arrItemId: 1,
});
describe("history preimage and ARR ownership fences on native runtime and real HTTP", () => {
	it("rejects arbitrary row/source coordinates before any provider GET", async () => {
		const f = await fixture();
		for (const extra of [
			{ userId: "foreign" },
			{ arrInstanceId: "foreign-arr" },
			{ arrItemId: 2 },
			{ itemType: "series" as const },
			{ cacheRowId: "missing" },
		])
			expect(await f.run(() => backfillInfoHashForRow({ ...args(f), ...extra }))).toBeNull();
		expect(f.requests).toEqual([]);
	});
	it("does not overwrite a newer correlation or row preimage and accepts the next valid current retry", async () => {
		for (const data of [{ infoHash: "b".repeat(40) }, { data: '{"revision":2}' }]) {
			const f = await fixture(),
				pending = f.run(() => backfillInfoHashForRow(args(f)));
			await f.entered.promise;
			await f.run(() => f.prisma.libraryCache.update({ where: { id: "row" }, data }));
			const before = await f.run(() =>
				f.prisma.libraryCache.findUniqueOrThrow({ where: { id: "row" } }),
			);
			f.unhold();
			expect(await pending).toBeNull();
			expect(
				await f.run(() => f.prisma.libraryCache.findUniqueOrThrow({ where: { id: "row" } })),
			).toEqual(before);
			if (!("infoHash" in data))
				expect(await f.run(() => backfillInfoHashForRow(args(f)))).toBe("a".repeat(40));
		}
	});
	it.each([
		{ binding: "connection generation", data: { connectionGeneration: 8 } },
		{ binding: "identity generation", data: { identityGeneration: 4 } },
		{ binding: "enabled state", data: { enabled: false } },
		{ binding: "provider origin", data: { baseUrl: "http://127.0.0.1:1" } },
	])(
		"rejects held old history after the $binding changes, with normal retry recovery",
		async ({ data }) => {
			const f = await fixture(),
				pending = f.run(() => backfillInfoHashForRow(args(f)));
			await f.entered.promise;
			const before = await f.run(() =>
				f.prisma.serviceInstance.findUniqueOrThrow({ where: { id: "owner-arr" } }),
			);
			await f.run(() => f.prisma.serviceInstance.update({ where: { id: "owner-arr" }, data }));
			f.unhold();
			expect(await pending).toBeNull();
			expect(
				(await f.run(() => f.prisma.libraryCache.findUniqueOrThrow({ where: { id: "row" } })))
					.infoHash,
			).toBeNull();
			await f.run(() =>
				f.prisma.serviceInstance.update({
					where: { id: "owner-arr" },
					data: { baseUrl: before.baseUrl, enabled: true },
				}),
			);
			expect(await f.run(() => backfillInfoHashForRow(args(f)))).toBe("a".repeat(40));
			expect(f.requests).toEqual([
				"GET /api/v3/history/movie?movieId=1",
				"GET /api/v3/history/movie?movieId=1",
			]);
		},
	);
});
