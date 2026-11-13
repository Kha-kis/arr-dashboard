import { randomUUID } from "node:crypto";
import { rename, stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ArrClientFactory,
	type ClientFactoryOptions,
	type ClientInstanceData,
} from "../../../lib/arr/client-factory.js";
import { createArrServiceFingerprint } from "../../../lib/arr/service-fingerprint.js";
import type { Encryptor } from "../../../lib/auth/encryption.js";
import {
	assertRestoreRuntimeOperation,
	getRestoreRuntimeClientContext,
	openRestoreRuntime,
	type RestoreRuntime,
} from "../../../lib/backup/restore-runtime-admission.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../../lib/backup/restore-runtime-client.js";
import type { ServiceInstance } from "../../../lib/prisma.js";
import { issueSearchGrabSelector } from "../../../lib/search/grab-selector.js";
import lifecyclePlugin from "../../../plugins/lifecycle.js";
import searchGrabRecoveryPlugin from "../../../plugins/search-grab-recovery.js";
import { registerSearchRoutes } from "../../search.js";
import { createNativeGrabFixture } from "./grab-native.fixture.js";

function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

// The SDK and the production validation hook remain real. Only scheduling
// before that awaited validation is controlled by the synthetic actor.
class PausedFactory extends ArrClientFactory {
	constructor(
		encryptor: Encryptor,
		private readonly entered: () => void,
		private readonly resume: Promise<void>,
	) {
		super(encryptor, 30000);
	}
	override createProwlarrClient(instance: ClientInstanceData, options?: ClientFactoryOptions) {
		return super.createProwlarrClient(instance, {
			...options,
			onRequest: async (request) => {
				this.entered();
				await this.resume;
				await options?.onRequest?.(request);
			},
		});
	}
}

describe("actual native ownership loss during durable Grab transport", () => {
	let fixture: Awaited<ReturnType<typeof createNativeGrabFixture>>;
	let provider: Server;
	let instance: ServiceInstance;
	let next: RestoreRuntime | undefined;
	let native: ReturnType<typeof createRuntimePrismaClient> | undefined;
	let app: FastifyInstance | undefined;
	let responses: ServerResponse[];
	let posts: unknown[];
	let arrivals: ReturnType<typeof deferred>[];
	let releases: Array<() => void>;
	let pending: Array<Promise<unknown>>;
	let oldContext: ReturnType<typeof getRestoreRuntimeClientContext>;

	beforeEach(async () => {
		fixture = await createNativeGrabFixture();
		await fixture.reset();
		responses = [];
		posts = [];
		arrivals = [deferred(), deferred()];
		releases = [];
		pending = [];
		next = undefined;
		native = undefined;
		app = undefined;
		oldContext = getRestoreRuntimeClientContext(fixture.runtime);
		// Independent provider: it must not read through the worker being fenced.
		provider = createServer((request, response) => {
			if (request.method !== "POST" || request.url !== "/api/v1/search") {
				response.writeHead(405).end();
				return;
			}
			let body = "";
			request.on("data", (chunk) => {
				body += String(chunk);
			});
			request.on("end", () => {
				posts.push(JSON.parse(body));
				responses.push(response);
				arrivals[posts.length - 1]?.release();
			});
		});
		await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
		const address = provider.address();
		if (!address || typeof address === "string" || address.address !== "127.0.0.1")
			throw new Error("Owned loopback provider required");
		instance = await fixture.run(() =>
			fixture.native.prisma.serviceInstance.update({
				where: { userId: fixture.user.id, id: fixture.instance.id },
				data: { baseUrl: `http://127.0.0.1:${address.port}` },
			}),
		);
		fixture.app.arrClientFactory = new ArrClientFactory(fixture.encryptor, 30000);
	});

	afterEach(async () => {
		for (const release of releases) release();
		for (const response of responses) if (!response.writableEnded) response.writeHead(503).end();
		await Promise.allSettled(pending);
		await app?.close();
		await native?.close();
		await next?.close();
		await fixture?.close();
		provider?.closeAllConnections();
		if (provider)
			await new Promise<void>((resolve, reject) =>
				provider.close((error) => (error ? reject(error) : resolve())),
			);
	});

	function request(intentId = randomUUID()) {
		return {
			instanceId: instance.id,
			intentId,
			selector: issueSearchGrabSelector(fixture.encryptor, {
				userId: fixture.user.id,
				serviceInstanceId: instance.id,
				connectionFingerprint: createArrServiceFingerprint(instance),
				guid: fixture.guid,
				indexerId: 7,
			}),
		};
	}

	async function loseOldNativeOwnership() {
		if (fixture.engine === "sqlite") {
			const file = oldContext.databaseUrl.slice("file:".length);
			expect(file).toMatch(/^\/tmp\/arr-grab-routes-[A-Za-z0-9]+\/owned\.db$/);
			const ownedDirectory = await stat(dirname(file));
			expect(ownedDirectory.uid).toBe(process.getuid?.());
			expect(ownedDirectory.mode & 0o777).toBe(0o700);
			const path = `${file}.arr-restore-runtime/operations.sqlite3`;
			const retained = `${file}.arr-restore-runtime/overlap-retained-operations.sqlite3`;
			const before = await stat(path, { bigint: true });
			await rename(path, retained);
			try {
				await expect(
					fixture.runtime.runOperation(() => assertRestoreRuntimeOperation(fixture.runtime)),
				).rejects.toThrow();
			} finally {
				await rename(retained, path);
				const after = await stat(path, { bigint: true });
				expect(after.dev).toBe(before.dev);
				expect(after.ino).toBe(before.ino);
			}
		} else {
			const parsed = new URL(oldContext.databaseUrl);
			expect(parsed.hostname).toBe("127.0.0.1");
			expect(parsed.username).toMatch(/^arr_grab_[a-f0-9]{32}_test$/);
			expect(parsed.pathname).toBe(`/${parsed.username}`);
			const observer = new Client({
				connectionString: oldContext.databaseUrl,
				connectionTimeoutMillis: 3000,
				query_timeout: 5000,
			});
			observer.on("error", () => undefined);
			try {
				await observer.connect();
				const identity = await observer.query(
					"SELECT current_database() AS database, current_user AS owner",
				);
				expect(identity.rows[0]).toEqual({ database: parsed.username, owner: parsed.username });
				expect(Number.isInteger(oldContext.ownerBackendPid)).toBe(true);
				expect(oldContext.ownerBackendPid).toBeGreaterThan(0);
				const selected = await observer.query(
					"SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND usename=current_user",
					[oldContext.ownerBackendPid],
				);
				expect(selected.rows[0]?.n).toBe(1);
				const stopped = await observer.query("SELECT pg_terminate_backend($1) AS stopped", [
					oldContext.ownerBackendPid,
				]);
				expect(stopped.rows[0]?.stopped).toBe(true);
				await expect(
					fixture.runtime.runOperation(() => assertRestoreRuntimeOperation(fixture.runtime)),
				).rejects.toThrow();
			} finally {
				await observer.end();
			}
		}
		await expect(fixture.runtime.runOperation(() => 1)).rejects.toThrow();
		if (fixture.engine === "sqlite") {
			// A real retained Prisma SHARED participant must refuse a cutover,
			// even though the old runtime's write authority is already fenced.
			await expect(openRestoreRuntime({ databaseUrl: oldContext.databaseUrl })).rejects.toThrow();
		}
		// Explicit owned native-client fault: close its actual connections, not
		// the still-pending HTTP handler. No production drain rule is changed.
		await fixture.native.close();
	}

	async function bootReplacement() {
		next = await openRestoreRuntime({ databaseUrl: oldContext.databaseUrl });
		await next.bindDestination("synthetic-grab-service");
		expect(getRestoreRuntimeClientContext(next).runtimeEpoch).not.toBe(oldContext.runtimeEpoch);
		native = createRuntimePrismaClient(next);
		app = Fastify({ logger: false });
		app.decorate("restoreRuntime", next);
		app.register(
			fastifyPlugin(
				async (scope) => {
					scope.decorate("prisma", native!.prisma);
				},
				{ name: "prisma" },
			),
		);
		registerRestoreBootstrapPlugin(
			app,
			fastifyPlugin(
				async (scope) => {
					scope.decorate("encryptor", fixture.encryptor);
					scope.decorate("arrClientFactory", new ArrClientFactory(fixture.encryptor, 30000));
				},
				{ name: "security", dependencies: ["prisma"] },
			),
		);
		registerRestoreBootstrapPlugin(app, searchGrabRecoveryPlugin);
		registerRestoreBootstrapPlugin(app, lifecyclePlugin);
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (inbound) => {
			inbound.currentUser = fixture.user;
		});
		app.register(registerSearchRoutes, { prefix: "/api" });
		registerRestoreRuntimeActivation(app);
		await app.ready();
		return { server: app };
	}

	const rows = () =>
		next!.runOperation(() =>
			native!.prisma.searchGrabAttempt.findMany({ where: { userId: fixture.user.id } }),
		);
	const held = () =>
		next!.runOperation(() =>
			native!.prisma.searchGrabClaim.findMany({ where: { userId: fixture.user.id } }),
		);
	function reply(index: number, kind: "ack" | "reject") {
		const response = responses[index];
		if (!response) throw new Error("Synthetic provider reply not pending");
		response.writeHead(kind === "ack" ? 200 : 409, { "content-type": "application/json" });
		response.end(
			JSON.stringify(
				kind === "ack"
					? { guid: fixture.guid, indexerId: 7 }
					: { message: "Synthetic bounded rejection" },
			),
		);
	}

	it.each(["ack", "reject"] as const)(
		"fences late old %s without changing recovered predecessor or active successor hold",
		async (oldReply) => {
			const original = request();
			const oldSubmission = fixture.app.inject({
				method: "POST",
				url: "/api/search/grab",
				payload: original,
			});
			pending.push(oldSubmission);
			await arrivals[0]!.promise;
			const marked = (await fixture.attempts())[0]!;
			expect(marked.state).toBe("submitting");
			expect(marked.dispatchedAt).not.toBeNull();
			expect(await fixture.holds()).toBe(1);
			await loseOldNativeOwnership();
			const { server } = await bootReplacement();
			const recovered = (await rows()).find((row) => row.id === marked.id)!;
			expect(recovered.state).toBe("uncertain");
			expect((await held()).map((hold) => hold.attemptId)).toEqual([marked.id]);
			expect(posts).toEqual([{ guid: fixture.guid, indexerId: 7 }]);
			const status = await server.inject({
				method: "GET",
				url: `/api/search/grab/intents/${original.intentId}`,
			});
			expect(status.statusCode).toBe(200);
			expect(status.json().state).toBe("uncertain");
			const successor = {
				...request(),
				retry: { predecessorId: recovered.id, duplicateRiskConfirmed: true },
			};
			const newSubmission = server.inject({
				method: "POST",
				url: "/api/search/grab",
				payload: successor,
			});
			pending.push(newSubmission);
			await arrivals[1]!.promise;
			const beforeLate = await rows();
			const newAttempt = beforeLate.find((row) => row.intentId === successor.intentId)!;
			expect(newAttempt.state).toBe("submitting");
			expect(newAttempt.predecessorId).toBe(recovered.id);
			expect((await held()).map((hold) => hold.attemptId)).toEqual([newAttempt.id]);
			reply(0, oldReply);
			expect((await oldSubmission).statusCode).not.toBe(204);
			expect(await rows()).toEqual(beforeLate);
			expect((await held()).map((hold) => hold.attemptId)).toEqual([newAttempt.id]);
			reply(1, "ack");
			expect((await newSubmission).statusCode).toBe(204);
			const after = await rows();
			expect(after.find((row) => row.id === recovered.id)).toEqual(recovered);
			expect(after.find((row) => row.id === newAttempt.id)?.state).toBe("acknowledged");
			expect(await held()).toEqual([]);
			expect(posts).toEqual([
				{ guid: fixture.guid, indexerId: 7 },
				{ guid: fixture.guid, indexerId: 7 },
			]);
		},
	);

	it("blocks a marked old request before actual SDK fetch after native loss, without replay", async () => {
		const entered = deferred(),
			resume = deferred();
		releases.push(resume.release);
		fixture.app.arrClientFactory = new PausedFactory(
			fixture.encryptor,
			entered.release,
			resume.promise,
		);
		const original = request();
		const oldSubmission = fixture.app.inject({
			method: "POST",
			url: "/api/search/grab",
			payload: original,
		});
		pending.push(oldSubmission);
		await entered.promise;
		const marked = (await fixture.attempts())[0]!;
		expect(marked.state).toBe("submitting");
		expect(posts).toEqual([]);
		await loseOldNativeOwnership();
		const { server } = await bootReplacement();
		const recovered = (await rows()).find((row) => row.id === marked.id)!;
		expect(recovered.state).toBe("uncertain");
		const before = await rows();
		resume.release();
		expect((await oldSubmission).statusCode).not.toBe(204);
		expect(await rows()).toEqual(before);
		expect((await held()).map((hold) => hold.attemptId)).toEqual([marked.id]);
		const observed = await server.inject({
			method: "GET",
			url: `/api/search/grab/intents/${original.intentId}`,
		});
		expect(observed.statusCode).toBe(200);
		expect(observed.json().state).toBe("uncertain");
		expect(posts).toEqual([]);
	});
});
