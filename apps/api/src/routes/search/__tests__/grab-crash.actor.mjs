import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.umask(0o077);
const configuration = new Promise((done) => process.once("message", done));
process.send?.({ kind: "waiting" });
const config = await configuration;
let stage = "configuration";
try {
	assert.ok(config && typeof config === "object");
	assert.match(config.nonce, /^[a-f0-9-]{36}$/);
	assert.ok(["prepared", "marked"].includes(config.mode));
	if (config.databaseUrl.startsWith("file:")) {
		assert.match(config.databaseUrl, /^file:\/tmp\/arr-grab-routes-[A-Za-z0-9]+\/owned\.db$/);
	} else {
		const parsed = new URL(config.databaseUrl);
		assert.equal(parsed.hostname, "127.0.0.1");
		assert.match(parsed.username, /^arr_grab_[a-f0-9]{32}_test$/);
		assert.equal(parsed.pathname, `/${parsed.username}`);
		assert.ok(parsed.password && parsed.port && !parsed.search && !parsed.hash);
	}
	const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
	const require = createRequire(`${root}/package.json`);
	const Fastify = require("fastify"),
		fastifyPlugin = require("fastify-plugin");
	const load = (path) => import(pathToFileURL(`${root}/src/${path}`).href);
	const { openRestoreRuntime } = await load("lib/backup/restore-runtime-admission.ts");
	const { createRuntimePrismaClient } = await load("lib/backup/restore-runtime-client.ts");
	const { registerRestoreBootstrapPlugin, registerRestoreRuntimeActivation } = await load(
		"lib/backup/restore-runtime-bootstrap.ts",
	);
	const { Encryptor } = await load("lib/auth/encryption.ts");
	const { ArrClientFactory } = await load("lib/arr/client-factory.ts");
	const { createArrServiceFingerprint } = await load("lib/arr/service-fingerprint.ts");
	const { createSearchGrabRepository } = await load("lib/search/grab-repository.ts");
	const { readSearchGrabSelector } = await load("lib/search/grab-selector.ts");
	const { default: lifecyclePlugin } = await load("plugins/lifecycle.ts");
	const { default: searchGrabRecoveryPlugin } = await load("plugins/search-grab-recovery.ts");
	const { registerSearchRoutes } = await load("routes/search.ts");
	stage = "native-startup";
	const runtime = await openRestoreRuntime({ databaseUrl: config.databaseUrl });
	await runtime.bindDestination("synthetic-grab-service");
	const native = createRuntimePrismaClient(runtime),
		encryptor = new Encryptor("77".repeat(32));
	const user = await runtime.runStarting(() =>
		native.prisma.user.findFirst({ where: { id: config.userId } }),
	);
	assert.ok(user && user.id === config.userId);
	const app = Fastify({ logger: false });
	app.decorate("restoreRuntime", runtime);
	app.register(
		fastifyPlugin(
			async (scope) => {
				scope.decorate("prisma", native.prisma);
			},
			{ name: "prisma" },
		),
	);
	registerRestoreBootstrapPlugin(
		app,
		fastifyPlugin(
			async (scope) => {
				scope.decorate("encryptor", encryptor);
				scope.decorate("arrClientFactory", new ArrClientFactory(encryptor, 30000));
			},
			{ name: "security", dependencies: ["prisma"] },
		),
	);
	registerRestoreBootstrapPlugin(app, searchGrabRecoveryPlugin);
	registerRestoreBootstrapPlugin(app, lifecyclePlugin);
	app.decorateRequest("currentUser", null);
	app.addHook("preHandler", async (request) => {
		request.currentUser = user;
	});
	app.register(registerSearchRoutes, { prefix: "/api" });
	registerRestoreRuntimeActivation(app);
	await app.ready();
	const execute = new Promise((done) => process.once("message", done));
	process.send?.({ kind: "ready", nonce: config.nonce });
	const command = await execute;
	assert.equal(command?.kind, "execute");
	assert.equal(command?.nonce, config.nonce);
	stage = "submission";
	if (config.mode === "prepared") {
		await runtime.runOperation(async () => {
			const instance = await native.prisma.serviceInstance.findFirst({
				where: {
					id: config.request.instanceId,
					userId: user.id,
					service: "PROWLARR",
					enabled: true,
				},
			});
			assert.ok(instance);
			const target = readSearchGrabSelector(
				encryptor,
				config.request.selector,
				{
					userId: user.id,
					serviceInstanceId: instance.id,
					connectionFingerprint: createArrServiceFingerprint(instance),
				},
				Date.now(),
			);
			const admission = await createSearchGrabRepository(
				native.prisma,
				runtime,
				encryptor,
				user.id,
			).admit({ intentId: config.request.intentId, target });
			assert.equal(admission.created, true);
			assert.equal(admission.attempt.state, "prepared");
			assert.equal(admission.attempt.dispatchedAt, null);
		});
		process.send?.({ kind: "prepared", nonce: config.nonce });
		// Keep the actual native owner and clients alive until the parent's exact
		// ChildProcess SIGKILL. No orderly-close simulation replaces the crash.
		await new Promise(() => {});
	} else {
		const response = await app.inject({
			method: "POST",
			url: "/api/search/grab",
			payload: config.request,
		});
		process.send?.({
			kind: "unexpected-settlement",
			nonce: config.nonce,
			status: response.statusCode,
		});
		await new Promise(() => {});
	}
} catch {
	process.send?.({ kind: "failed", nonce: config?.nonce ?? null, stage });
	process.exitCode = 1;
	process.disconnect?.();
}
