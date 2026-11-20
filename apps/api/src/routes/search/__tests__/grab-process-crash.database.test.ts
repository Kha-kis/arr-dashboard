import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArrClientFactory } from "../../../lib/arr/client-factory.js";
import { createArrServiceFingerprint } from "../../../lib/arr/service-fingerprint.js";
import {
	getRestoreRuntimeClientContext,
	openRestoreRuntime,
	type RestoreRuntime,
} from "../../../lib/backup/restore-runtime-admission.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../../lib/backup/restore-runtime-client.js";
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

describe("physical native Grab worker crash and actual startup recovery", () => {
	let seed: Awaited<ReturnType<typeof createNativeGrabFixture>>;
	let seedClosed: boolean;
	let provider: Server;
	let next: RestoreRuntime | undefined;
	let native: ReturnType<typeof createRuntimePrismaClient> | undefined;
	let app: FastifyInstance | undefined;
	let child: ChildProcess | undefined;
	let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
	let posts: unknown[];
	let responses: ServerResponse[];
	let arrived: ReturnType<typeof deferred>;
	let autoAck: boolean;
	let databaseUrl: string;
	let original: { instanceId: string; intentId: string; selector: string };
	let inbox: Array<{ kind: string; nonce?: string; stage?: string }>;
	let listeners: Array<() => void>;

	beforeEach(async () => {
		seed = await createNativeGrabFixture();
		await seed.reset();
		seedClosed = false;
		next = undefined;
		native = undefined;
		app = undefined;
		child = undefined;
		exit = undefined;
		posts = [];
		responses = [];
		inbox = [];
		listeners = [];
		arrived = deferred();
		autoAck = false;
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
				if (autoAck) {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ guid: seed.guid, indexerId: 7 }));
				}
				arrived.release();
			});
		});
		await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
		const address = provider.address();
		if (!address || typeof address === "string" || address.address !== "127.0.0.1")
			throw new Error("Owned loopback provider required");
		const instance = await seed.run(() =>
			seed.native.prisma.serviceInstance.update({
				where: { userId: seed.user.id, id: seed.instance.id },
				data: { baseUrl: `http://127.0.0.1:${address.port}` },
			}),
		);
		original = {
			instanceId: instance.id,
			intentId: randomUUID(),
			selector: issueSearchGrabSelector(seed.encryptor, {
				userId: seed.user.id,
				serviceInstanceId: instance.id,
				connectionFingerprint: createArrServiceFingerprint(instance),
				guid: seed.guid,
				indexerId: 7,
			}),
		};
		databaseUrl = getRestoreRuntimeClientContext(seed.runtime).databaseUrl;
		await seed.close();
		seedClosed = true;
	});

	afterEach(async () => {
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await exit;
		}
		for (const response of responses) if (!response.writableEnded) response.writeHead(503).end();
		await app?.close();
		await native?.close();
		await next?.close();
		if (!seedClosed) await seed?.close();
		provider?.closeAllConnections();
		if (provider)
			await new Promise<void>((resolve, reject) =>
				provider.close((error) => (error ? reject(error) : resolve())),
			);
	});

	function wait(kind: string, nonce?: string) {
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				listeners = listeners.filter((listener) => listener !== check);
				reject(new Error("Owned crash actor observation timed out"));
			}, 10000);
			function check() {
				const failed = inbox.find((message) => message.kind === "failed");
				if (failed) {
					clearTimeout(timer);
					listeners = listeners.filter((listener) => listener !== check);
					reject(new Error(`Owned crash actor failed at ${failed.stage}`));
				} else if (
					inbox.some((message) => message.kind === kind && (!nonce || message.nonce === nonce))
				) {
					clearTimeout(timer);
					listeners = listeners.filter((listener) => listener !== check);
					resolve();
				}
			}
			listeners.push(check);
			check();
		});
	}

	async function startActor(mode: "prepared" | "marked") {
		const require = createRequire(import.meta.url),
			nonce = randomUUID();
		child = fork(fileURLToPath(new URL("./grab-crash.actor.mjs", import.meta.url)), [], {
			execArgv: ["--import", require.resolve("tsx")],
			cwd: process.cwd(),
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				LANG: "C.UTF-8",
				TZ: "UTC",
				NODE_ENV: "test",
				DOTENV_CONFIG_PATH: "/dev/null",
			},
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		child.stdout?.resume();
		child.stderr?.resume();
		exit = new Promise((resolve) => {
			child!.once("exit", (code, signal) => resolve({ code, signal }));
		});
		child.on("message", (message) => {
			inbox.push(message as (typeof inbox)[number]);
			for (const listener of [...listeners]) listener();
		});
		await wait("waiting");
		child.send({ databaseUrl, userId: seed.user.id, request: original, mode, nonce });
		await wait("ready", nonce);
		expect(child.exitCode).toBeNull();
		expect(child.signalCode).toBeNull();
		child.send({ kind: "execute", nonce });
		if (mode === "prepared") await wait("prepared", nonce);
		else await arrived.promise;
		return { nonce };
	}

	async function bootReplacement() {
		next = await openRestoreRuntime({ databaseUrl });
		await next.bindDestination("synthetic-grab-service");
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
					scope.decorate("encryptor", seed.encryptor);
					scope.decorate("arrClientFactory", new ArrClientFactory(seed.encryptor, 30000));
				},
				{ name: "security", dependencies: ["prisma"] },
			),
		);
		registerRestoreBootstrapPlugin(app, searchGrabRecoveryPlugin);
		registerRestoreBootstrapPlugin(app, lifecyclePlugin);
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (request) => {
			request.currentUser = seed.user;
		});
		app.register(registerSearchRoutes, { prefix: "/api" });
		registerRestoreRuntimeActivation(app);
		await app.ready();
		return { server: app };
	}

	const rows = () =>
		next!.runOperation(() =>
			native!.prisma.searchGrabAttempt.findMany({ where: { userId: seed.user.id } }),
		);
	const held = () =>
		next!.runOperation(() =>
			native!.prisma.searchGrabClaim.findMany({ where: { userId: seed.user.id } }),
		);

	it.each(["prepared", "marked"] as const)(
		"survives SIGKILL of the %s worker without replay or false success",
		async (mode) => {
			const { nonce } = await startActor(mode);
			expect(
				inbox.some(
					(message) => message.nonce === nonce && message.kind === "unexpected-settlement",
				),
			).toBe(false);
			expect(posts).toEqual(mode === "prepared" ? [] : [{ guid: seed.guid, indexerId: 7 }]);
			const actor = child!;
			expect(actor.pid).toBeGreaterThan(0);
			expect(actor.exitCode).toBeNull();
			expect(actor.signalCode).toBeNull();
			expect(actor.kill("SIGKILL")).toBe(true);
			expect(await exit).toEqual({ code: null, signal: "SIGKILL" });
			const { server } = await bootReplacement();
			const recoveredRows = await rows();
			expect(recoveredRows).toHaveLength(1);
			const recovered = recoveredRows[0]!;
			expect(recovered.intentId).toBe(original.intentId);
			expect(recovered.serviceInstanceId).toBe(original.instanceId);
			expect(recovered.state).toBe(mode === "prepared" ? "rejected" : "uncertain");
			expect(recovered.dispatchedAt === null).toBe(mode === "prepared");
			expect(recovered.outcomeCategory).toBe(
				mode === "prepared" ? "interrupted-before-dispatch" : "interrupted-after-marker",
			);
			expect((await held()).map((hold) => hold.attemptId)).toEqual(
				mode === "prepared" ? [] : [recovered.id],
			);
			const before = await rows();
			const count = posts.length;
			expect(
				(
					await server.inject({
						method: "GET",
						url: `/api/search/grab/intents/${original.intentId}`,
					})
				).statusCode,
			).toBe(200);
			expect(
				(await server.inject({ method: "POST", url: "/api/search/grab", payload: original }))
					.statusCode,
			).toBe(mode === "prepared" ? 422 : 502);
			expect(await rows()).toEqual(before);
			expect(posts).toHaveLength(count);
			autoAck = true;
			const fresh = {
				...original,
				intentId: randomUUID(),
				...(mode === "marked"
					? { retry: { predecessorId: recovered.id, duplicateRiskConfirmed: true } }
					: {}),
			};
			expect(
				(await server.inject({ method: "POST", url: "/api/search/grab", payload: fresh }))
					.statusCode,
			).toBe(204);
			expect(posts).toHaveLength(count + 1);
			expect((await rows()).find((row) => row.id === recovered.id)).toEqual(recovered);
			expect((await rows()).find((row) => row.intentId === fresh.intentId)?.state).toBe(
				"acknowledged",
			);
			expect(await held()).toEqual([]);
		},
	);
});
