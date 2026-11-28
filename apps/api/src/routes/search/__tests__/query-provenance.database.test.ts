import { randomUUID } from "node:crypto";
import { chmod, mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { multiInstanceSearchResponseSchema } from "@arr/shared";
import Database from "better-sqlite3";
import Fastify, { type FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ArrClientFactory } from "../../../lib/arr/client-factory.js";
import { createArrServiceFingerprint } from "../../../lib/arr/service-fingerprint.js";
import { Encryptor } from "../../../lib/auth/encryption.js";
import {
	openRestoreRuntime,
	type RestoreRuntime,
} from "../../../lib/backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../../lib/backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../../lib/backup/runtime-schema-startup.js";
import type { ServiceInstance, User } from "../../../lib/prisma.js";
import { readSearchGrabSelector } from "../../../lib/search/grab-selector.js";
import lifecyclePlugin from "../../../plugins/lifecycle.js";
import { registerQueryRoutes } from "../query-routes.js";

describe("actual query provenance with native storage and SDK HTTP reads", () => {
	let runtime: RestoreRuntime;
	let native: ReturnType<typeof createRuntimePrismaClient>;
	let provider: Server;
	let app: ReturnType<typeof Fastify>;
	let baseUrl: string;
	let user: User;
	let instance: ServiceInstance;
	let releases: Array<Record<string, unknown>>;
	let reads: number;
	let writes: number;
	let providerStatus: number;
	let delayed: { entered: () => void; resume: Promise<void> } | undefined;
	const encryptor = new Encryptor("44".repeat(32));
	const guid = "opaque:exact/東京😀";
	const run = <T>(operation: () => Promise<T>) => runtime.runOperation(operation);
	const binding = (connection = instance) => ({
		userId: user.id,
		serviceInstanceId: connection.id,
		connectionFingerprint: createArrServiceFingerprint(connection),
	});
	const query = () =>
		app.inject({ method: "POST", url: "/api/search/query", payload: { query: "synthetic" } });
	const release = (extra: Record<string, unknown> = {}) => ({
		guid,
		title: "Synthetic result",
		indexerId: 7,
		protocol: "torrent",
		...extra,
	});
	beforeAll(async () => {
		const directory = await mkdtemp(join(tmpdir(), "arr-grab-query-"));
		await chmod(directory, 0o700);
		const path = join(directory, "owned.db");
		new Database(path).close();
		await chmod(path, 0o600);
		const url = `file:${path}`;
		await synchronizeRuntimeSchema(url);
		runtime = await openRestoreRuntime({ databaseUrl: url });
		await runtime.bindDestination("synthetic-grab-query");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		provider = createServer((request, response) => {
			if (request.method !== "GET") {
				writes++;
				response.writeHead(405).end();
				return;
			}
			reads++;
			const respond = () => {
				response.writeHead(providerStatus, { "content-type": "application/json" });
				response.end(JSON.stringify(releases));
			};
			if (delayed) {
				delayed.entered();
				void delayed.resume.then(respond);
			} else respond();
		});
		await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
		const address = provider.address();
		if (!address || typeof address === "string") throw new Error("Owned loopback fixture required");
		baseUrl = `http://127.0.0.1:${address.port}`;
	}, 30000);
	beforeEach(async () => {
		reads = 0;
		writes = 0;
		providerStatus = 200;
		delayed = undefined;
		releases = [release()];
		await run(async () => {
			user = await native.prisma.user.create({ data: { username: `synthetic-${randomUUID()}` } });
			const key = encryptor.encrypt("synthetic-provider-key");
			instance = await native.prisma.serviceInstance.create({
				data: {
					userId: user.id,
					service: "PROWLARR",
					label: "Synthetic",
					baseUrl,
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				},
			});
		});
		app = Fastify({ logger: false });
		app.decorate("prisma", native.prisma);
		app.decorate("restoreRuntime", runtime);
		app.decorate("encryptor", encryptor);
		app.decorate("arrClientFactory", new ArrClientFactory(encryptor, 1000));
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (request: FastifyRequest) => {
			request.currentUser = user;
		});
		await app.register(lifecyclePlugin);
		await app.register(registerQueryRoutes, { prefix: "/api" });
		await app.ready();
	});
	afterEach(async () => {
		await app?.close();
		expect(writes).toBe(0);
	});
	afterAll(async () => {
		provider?.closeAllConnections();
		if (provider)
			await new Promise<void>((resolve, reject) =>
				provider.close((error) => (error ? reject(error) : resolve())),
			);
		await native?.close();
		await runtime?.close();
	});
	it("issues an opaque selector that survives the actual shared response boundary", async () => {
		const response = await query();
		expect(response.statusCode).toBe(200);
		const data = multiInstanceSearchResponseSchema.parse(response.json()),
			row = data.aggregated[0] as Record<string, unknown>;
		expect(row.grabSelector).toEqual(expect.any(String));
		expect(String(row.grabSelector)).not.toContain(guid);
		expect(readSearchGrabSelector(encryptor, row.grabSelector, binding())).toEqual({
			...binding(),
			guid,
			indexerId: 7,
		});
		expect(data.instances[0]?.data[0]).toEqual(row);
		expect(reads).toBe(1);
	});
	it("binds identical provider tuples independently across two owned instances", async () => {
		const second = await run(() =>
			native.prisma.serviceInstance.create({
				data: {
					userId: user.id,
					service: "PROWLARR",
					label: "Synthetic second",
					baseUrl,
					encryptedApiKey: instance.encryptedApiKey,
					encryptionIv: instance.encryptionIv,
				},
			}),
		);
		const response = await query();
		expect(response.statusCode).toBe(200);
		const data = response.json();
		expect(data.aggregated).toHaveLength(2);
		const first = data.aggregated.find(
				(row: { instanceId: string }) => row.instanceId === instance.id,
			),
			other = data.aggregated.find((row: { instanceId: string }) => row.instanceId === second.id);
		expect(readSearchGrabSelector(encryptor, first.grabSelector, binding()).guid).toBe(guid);
		expect(readSearchGrabSelector(encryptor, other.grabSelector, binding(second)).guid).toBe(guid);
		expect(() => readSearchGrabSelector(encryptor, first.grabSelector, binding(second))).toThrow();
		expect(reads).toBe(2);
	});
	it("retains display rows without inventing a target for missing or invalid action identity", async () => {
		releases = [
			release({ guid: undefined, id: "opaque:display-only" }),
			release({ indexerId: 0 }),
			release({ guid: "opaque:invalid\u0001" }),
		];
		const response = await query();
		expect(response.statusCode).toBe(200);
		const data = response.json();
		expect(data.aggregated).toHaveLength(3);
		expect(
			data.aggregated.every((row: Record<string, unknown>) => row.grabSelector === undefined),
		).toBe(true);
		expect(data.coverage).toMatchObject({ receivedCount: 3, acceptedCount: 3, rejectedCount: 0 });
	});
	it("preserves partial batch coverage and issues provenance only to accepted rows", async () => {
		releases = [release(), release({ guid: { invalid: true } })];
		const response = await query();
		expect(response.statusCode).toBe(200);
		const data = response.json();
		expect(data.aggregated).toHaveLength(1);
		expect(data.coverage).toMatchObject({ receivedCount: 2, acceptedCount: 1, rejectedCount: 1 });
		expect(readSearchGrabSelector(encryptor, data.aggregated[0].grabSelector, binding()).guid).toBe(
			guid,
		);
	});
	it("keeps valid action provenance when optional display metrics are unavailable", async () => {
		releases = [release({ size: { invalid: true } })];
		const response = await query();
		expect(response.statusCode).toBe(200);
		const data = response.json();
		expect(data.aggregated[0]).toMatchObject({ metadataIncomplete: true });
		expect(
			readSearchGrabSelector(encryptor, data.aggregated[0].grabSelector, binding()).indexerId,
		).toBe(7);
		expect(data.coverage).toMatchObject({
			receivedCount: 1,
			acceptedCount: 1,
			rejectedCount: 0,
			metadataIncompleteCount: 1,
		});
	});
	it("never queries disabled, different-service or foreign-owner connections", async () => {
		await run(async () => {
			const other = await native.prisma.user.create({
				data: { username: `synthetic-${randomUUID()}` },
			});
			for (const variant of [
				{ userId: other.id, service: "PROWLARR" as const, enabled: true },
				{ userId: user.id, service: "PROWLARR" as const, enabled: false },
				{ userId: user.id, service: "SONARR" as const, enabled: true },
			])
				await native.prisma.serviceInstance.create({
					data: {
						...variant,
						label: "Synthetic excluded",
						baseUrl,
						encryptedApiKey: instance.encryptedApiKey,
						encryptionIv: instance.encryptionIv,
					},
				});
		});
		const response = await query();
		expect(response.statusCode).toBe(200);
		const data = response.json();
		expect(data.aggregated).toHaveLength(1);
		expect(
			readSearchGrabSelector(encryptor, data.aggregated[0].grabSelector, binding()).userId,
		).toBe(user.id);
		expect(reads).toBe(1);
	});
	it("does not retarget an in-flight query after its stored connection changes", async () => {
		let entered!: () => void, resume!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		delayed = {
			entered,
			resume: new Promise<void>((resolve) => {
				resume = resolve;
			}),
		};
		const pending = query();
		try {
			await ready;
			const changed = await run(() =>
				native.prisma.serviceInstance.update({
					where: { id: instance.id, userId: user.id },
					data: { baseUrl: `${baseUrl}/changed` },
				}),
			);
			resume();
			const response = await pending;
			expect(response.statusCode).toBe(200);
			const row = response.json().aggregated[0];
			expect(readSearchGrabSelector(encryptor, row.grabSelector, binding()).guid).toBe(guid);
			expect(() => readSearchGrabSelector(encryptor, row.grabSelector, binding(changed))).toThrow();
		} finally {
			resume();
			await pending;
		}
	});
	it("reports provider unavailability without returning fabricated empty success or selectors", async () => {
		providerStatus = 503;
		const response = await query();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			aggregated: [],
			totalCount: 0,
			failedInstanceCount: 1,
			instances: [{ success: false, data: [] }],
		});
	});
});
