import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManualImportServiceType, ManualImportSubmissionFile } from "@arr/shared";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ArrClientFactory } from "../../lib/arr/client-factory.js";
import { reconcileTrackedImport } from "../../lib/arr/import-operations/reconciliation.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import { openRestoreRuntime } from "../../lib/backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../lib/backup/runtime-schema-startup.js";
import { registerManualImportRoutes } from "../manual-import.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

type WireEvent = { method: string; path: string; query: Record<string, string>; body: unknown };
type ProviderMode =
	| "queued"
	| "candidate-refused"
	| "target-missing"
	| "post-refused"
	| "lost"
	| "contradictory";
const base = {
	path: "/synthetic/reviewed-file",
	folderName: "synthetic-folder",
	downloadId: "synthetic-source",
	quality: { quality: { id: 1, name: "Synthetic quality" } },
	languages: [{ id: 1, name: "Synthetic language" }],
	releaseGroup: "Synthetic group",
	indexerFlags: 4,
};
const branches: Array<{
	service: ManualImportServiceType;
	version: "v1" | "v3";
	mode: "auto" | "move" | "copy";
	media: Partial<ManualImportSubmissionFile>;
	candidate: Record<string, unknown>;
	command: Record<string, unknown>;
}> = [
	{
		service: "sonarr",
		version: "v3",
		mode: "auto",
		media: { seriesId: 12, episodeIds: [13] },
		candidate: {
			series: { id: 12, title: "Synthetic series" },
			episodes: [{ id: 13 }, { id: 14 }],
		},
		command: { seriesId: 12, episodeIds: [13] },
	},
	{
		service: "radarr",
		version: "v3",
		mode: "copy",
		media: { movieId: 12 },
		candidate: { movie: { id: 12, title: "Synthetic movie" } },
		command: { movieId: 12 },
	},
	{
		service: "lidarr",
		version: "v1",
		mode: "move",
		media: { artistId: 12, albumId: 13 },
		candidate: { artist: { id: 12 }, album: { id: 13 }, albumReleaseId: 14, tracks: [{ id: 15 }] },
		command: { artistId: 12, albumId: 13, albumReleaseId: 14, trackIds: [15] },
	},
	{
		service: "readarr",
		version: "v1",
		mode: "copy",
		media: { authorId: 12, bookId: 13 },
		candidate: { author: { id: 12 }, book: { id: 13 }, foreignEditionId: "edition-1" },
		command: { authorId: 12, bookId: 13, foreignEditionId: "edition-1" },
	},
];

let runtime: Awaited<ReturnType<typeof openRestoreRuntime>>;
let native: ReturnType<typeof createRuntimePrismaClient>;
let app: FastifyInstance;
let provider: Awaited<ReturnType<typeof recordingProvider>> | undefined;
const directory = mkdtempSync(join(process.env.V4_DB_ROOT ?? tmpdir(), "arr-manual-sdk-"));
const database = join(directory, "fixture.db");
const encryptor = new Encryptor(Buffer.alloc(32, 9).toString("base64"));
const run = <T>(action: () => Promise<T>) => runtime.runOperation(action);
const receipts: unknown[] = [];

beforeAll(async () => {
	new Database(database).close();
	await synchronizeRuntimeSchema(`file:${database}`);
	runtime = await openRestoreRuntime({ databaseUrl: `file:${database}` });
	await runtime.bindDestination("synthetic-manual-import-sdk-contracts");
	await runtime.activate();
	native = createRuntimePrismaClient(runtime);
});
beforeEach(async () => {
	await run(async () => {
		await native.prisma.user.deleteMany();
		await native.prisma.user.create({ data: { id: "owner", username: "synthetic-owner" } });
	});
	app = Fastify({ logger: false });
	app.decorate("prisma", native.prisma);
	app.decorate("encryptor", encryptor);
	app.decorate("arrClientFactory", new ArrClientFactory(encryptor));
	setupAuthInjection(app, { id: "owner" });
	registerTestErrorHandler(app);
	await app.register(registerManualImportRoutes);
	await app.ready();
});
afterEach(async () => {
	await app?.close();
	if (provider) receipts.push(await provider.close());
	provider = undefined;
});
afterAll(async () => {
	await native?.close();
	await runtime?.close();
	const checks = [];
	for (const file of [
		database,
		`${database}.arr-restore-runtime/owner.sqlite3`,
		`${database}.arr-restore-runtime/operations.sqlite3`,
	]) {
		if (!existsSync(file)) continue;
		const connection = new Database(file, { readonly: true, fileMustExist: true });
		try {
			const quick = connection.pragma("quick_check");
			const fk = connection.pragma("foreign_key_check");
			expect(quick).toEqual([{ quick_check: "ok" }]);
			expect(fk).toEqual([]);
			checks.push({ file, quick, fk });
		} finally {
			connection.close();
			expect(connection.open).toBe(false);
		}
	}
	if (process.env.V4_EVIDENCE_ROOT)
		writeFileSync(
			join(process.env.V4_EVIDENCE_ROOT, "native-cleanup.json"),
			JSON.stringify({ receipts, nativeClosed: true, runtimeClosed: true, checks }, null, 2),
		);
	else rmSync(directory, { recursive: true, force: true });
});

async function recordingProvider(branch: (typeof branches)[number]) {
	const events: WireEvent[] = [];
	const pending = new Set<Promise<void>>();
	const fixtureErrors: string[] = [];
	let mode: ProviderMode = "queued";
	let command: Record<string, unknown> | null = null;
	const server = createServer((request, response) => {
		const task = (async () => {
			const url = new URL(request.url!, "http://synthetic.invalid");
			let raw = "";
			for await (const chunk of request) {
				raw += String(chunk);
				assert(raw.length < 8192);
			}
			const body: unknown = raw ? JSON.parse(raw) : null;
			events.push({
				method: request.method!,
				path: url.pathname,
				query: Object.fromEntries(url.searchParams),
				body,
			});
			assert.equal(request.headers["x-api-key"], "synthetic-key");
			if (request.method === "GET" && url.pathname === `/api/${branch.version}/manualimport`) {
				response.writeHead(mode === "candidate-refused" ? 503 : 200, {
					"content-type": "application/json",
				});
				response.end(
					JSON.stringify(
						mode === "candidate-refused"
							? { message: "Synthetic dependency unavailable" }
							: mode === "target-missing"
								? []
								: [{ id: 1, ...base, ...branch.candidate }],
					),
				);
			} else if (request.method === "POST" && url.pathname === `/api/${branch.version}/command`) {
				command = {
					id: 51,
					name: "ManualImport",
					status: "queued",
					queued: new Date().toISOString(),
					body,
				};
				if (mode === "post-refused") command = null;
				if (mode === "lost") {
					request.socket.destroy();
					return;
				}
				response.writeHead(mode === "post-refused" ? 503 : 201, {
					"content-type": "application/json",
				});
				response.end(
					JSON.stringify(
						mode === "post-refused"
							? { message: "Synthetic refused command" }
							: mode === "contradictory"
								? {
										...command,
										status: "completed",
										result: "successful",
										body: { name: "ManualImport", files: [] },
									}
								: command,
					),
				);
			} else if (request.method === "GET" && url.pathname === `/api/${branch.version}/command`) {
				response
					.writeHead(200, { "content-type": "application/json" })
					.end(JSON.stringify(command ? [command] : []));
			} else if (request.method === "GET" && url.pathname === `/api/${branch.version}/command/51`) {
				response
					.writeHead(200, { "content-type": "application/json" })
					.end(JSON.stringify(command));
			} else {
				response.writeHead(500).end("Unexpected synthetic request");
				throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
			}
		})();
		pending.add(task);
		void task.then(
			() => pending.delete(task),
			(error) => {
				fixtureErrors.push(String(error));
				pending.delete(task);
				response.destroy(error);
			},
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	return {
		events,
		url: `http://127.0.0.1:${address.port}`,
		setMode(value: ProviderMode) {
			mode = value;
		},
		async close() {
			await Promise.all([...pending]);
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			expect(server.listening).toBe(false);
			expect(pending.size).toBe(0);
			expect(fixtureErrors).toEqual([]);
			return { events, listening: server.listening, pendingTasks: pending.size, fixtureErrors };
		},
	};
}

async function fixture(branch = branches[1]!) {
	provider = await recordingProvider(branch);
	const encrypted = encryptor.encrypt("synthetic-key");
	await run(() =>
		native.prisma.serviceInstance.create({
			data: {
				id: "instance",
				userId: "owner",
				service: branch.service.toUpperCase() as "SONARR" | "RADARR" | "LIDARR" | "READARR",
				label: "Synthetic",
				baseUrl: provider!.url,
				encryptedApiKey: encrypted.value,
				encryptionIv: encrypted.iv,
			},
		}),
	);
	const body = {
		instanceId: "instance",
		service: branch.service,
		importMode: branch.mode,
		idempotencyKey: "reviewed-attempt",
		files: [
			{
				path: base.path,
				downloadId: base.downloadId,
				...branch.media,
				quality: { quality: { id: 999 } },
			},
		],
	};
	const inject = createInjectAuthenticated(app);
	return { body, provider, submit: () => run(() => inject("POST", "/manual-import", { body })) };
}

describe("Manual Import installed SDK HTTP and native operation contracts", () => {
	// Catches wrong API versions, wrong mode/media mappings, or trusting browser quality.
	it.each(branches)(
		"sends the reviewed $service payload literally and persists pending, not success",
		async (branch) => {
			const f = await fixture(branch);
			const response = await f.submit();
			expect(response.statusCode).toBe(202);
			expect(f.provider.events).toEqual([
				{
					method: "GET",
					path: `/api/${branch.version}/manualimport`,
					query: { downloadId: "synthetic-source", filterExistingFiles: "false" },
					body: null,
				},
				{
					method: "POST",
					path: `/api/${branch.version}/command`,
					query: {},
					body: {
						name: "ManualImport",
						importMode: branch.mode === "copy" ? "Copy" : "Move",
						files: [{ ...base, ...branch.command }],
					},
				},
			]);
			const result = response.json();
			expect(result).toMatchObject({
				state: "pending",
				selectedFileCount: 1,
				verifiedFileCount: 0,
				canConsiderNewAttempt: false,
			});
			expect(
				await run(() =>
					native.prisma.arrImportOperation.findFirstOrThrow({
						where: { id: result.operationId, userId: "owner" },
						include: { files: true },
					}),
				),
			).toMatchObject({
				service: branch.service.toUpperCase(),
				state: "pending",
				commandId: 51,
				commandState: "pending",
				verifiedFileCount: 0,
				selectedFileCount: 1,
				files: [{ verifiedAt: null }],
			});
		},
	);

	// Dependency/target failure must occur before the durable submission fence or POST.
	it.each(["candidate-refused", "target-missing"] as const)(
		"keeps %s retryable without a native attempt or command",
		async (mode) => {
			const f = await fixture();
			f.provider.setMode(mode);
			const refused = await f.submit();
			expect(refused.statusCode).toBe(mode === "candidate-refused" ? 502 : 409);
			expect(await run(() => native.prisma.arrImportOperation.count())).toBe(0);
			expect(f.provider.events.every((event) => event.method === "GET")).toBe(true);
			f.provider.setMode("queued");
			expect((await f.submit()).json()).toMatchObject({ state: "pending", verifiedFileCount: 0 });
			expect(f.provider.events.filter((event) => event.method === "POST")).toHaveLength(1);
		},
	);

	// Once POST starts, refusal/loss/contradiction cannot authorize a blind replay.
	it.each(["post-refused", "lost", "contradictory"] as const)(
		"retains %s as unknown and observes current provider evidence without replay",
		async (mode) => {
			const f = await fixture();
			f.provider.setMode(mode);
			const response = await f.submit();
			expect(response.statusCode).toBe(202);
			const original = response.json();
			expect(original).toMatchObject({
				state: "unknown",
				verifiedFileCount: 0,
				canConsiderNewAttempt: false,
			});
			expect((await f.submit()).json()).toEqual(original);
			const commandCount = f.provider.events.filter((event) => event.method === "POST").length;
			expect(commandCount).toBe(1);
			const result = await run(() =>
				reconcileTrackedImport(
					{
						prisma: native.prisma,
						encryptor,
						createClient: (instance, options) =>
							app.arrClientFactory.create({ ...instance, service: "RADARR" }, options),
						now: () => new Date(Date.now() + 1000),
					},
					"owner",
					original.operationId,
				),
			);
			expect(result).toBe(mode === "post-refused" ? "unavailable" : "observed");
			const status = await run(() =>
				createInjectAuthenticated(app)("GET", `/manual-import/operations/${original.operationId}`),
			);
			expect(status.json()).toMatchObject({
				operationId: original.operationId,
				state: mode === "post-refused" ? "unknown" : "pending",
				verifiedFileCount: 0,
				canConsiderNewAttempt: false,
			});
			expect(f.provider.events.filter((event) => event.method === "POST")).toHaveLength(1);
			expect(
				f.provider.events.some(
					(event) => event.method === "GET" && event.path.endsWith("/command/51"),
				),
			).toBe(mode !== "post-refused");
		},
	);
});
