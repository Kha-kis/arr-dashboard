import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastifyCookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envSchema } from "../../../config/env.js";
import lifecyclePlugin from "../../../plugins/lifecycle.js";
import { registerHealthRoutes, registerLiveRoutes } from "../../../routes/health.js";
import { registerSessionValidationHook } from "../../../server.js";
import { SessionService } from "../../auth/session.js";
import { openRestoreRuntime, type RestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../backup/runtime-schema-startup.js";

describe("actual native production-session-hook liveness admission", () => {
	let directory: string;
	let app: FastifyInstance | undefined;
	let runtime: RestoreRuntime | undefined;
	let native: ReturnType<typeof createRuntimePrismaClient> | undefined;
	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "arr-liveness-admission-"));
		const databaseUrl = `file:${join(directory, "fixture.db")}`;
		await synchronizeRuntimeSchema(databaseUrl);
		runtime = await openRestoreRuntime({ databaseUrl });
		native = createRuntimePrismaClient(runtime);
		await runtime.runStarting(() => native!.prisma.$connect());
		await runtime.bindDestination("synthetic-liveness-destination");
		await runtime.activate();
		app = Fastify({ logger: false });
		app.decorate(
			"config",
			envSchema.parse({
				NODE_ENV: "test",
				DATABASE_URL: databaseUrl,
				API_HOST: "127.0.0.1",
				API_PORT: 0,
				APP_URL: "http://127.0.0.1",
				TMDB_BASE_URL: "https://synthetic.invalid",
				TMDB_IMAGE_BASE_URL: "https://synthetic.invalid",
			}),
		);
		app.decorate("restoreRuntime", runtime);
		app.decorate("prisma", native.prisma);
		app.decorate("sessionService", new SessionService(native.prisma, app.config, app.log));
		app.register(fastifyCookie, { secret: "synthetic-liveness-cookie-signing-secret" });
		app.decorateRequest("currentUser", null);
		app.decorateRequest("sessionToken", null);
		registerSessionValidationHook(app);
		app.register(lifecyclePlugin);
		app.register(registerHealthRoutes, { prefix: "/health" });
		app.register(registerLiveRoutes, { prefix: "/live" });
		app.get("/ordinary", async (request, reply) => {
			if (!request.currentUser) return reply.code(401).send({ status: "unauthorized" });
			return { status: "ok" };
		});
		await app.ready();
	});
	afterEach(async () => {
		await app?.close();
		await app?.sessionService.drainValidations();
		await native?.close();
		await runtime?.close();
		app = undefined;
		native = undefined;
		runtime = undefined;
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	it("keeps liveness public without weakening ordinary authentication", async () => {
		expect((await app!.inject({ method: "GET", url: "/live" })).statusCode).toBe(200);
		expect((await app!.inject({ method: "HEAD", url: "/live" })).statusCode).toBe(200);
		expect((await app!.inject({ method: "GET", url: "/ordinary" })).statusCode).toBe(401);
		expect((await app!.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
	});

	it("keeps only explicit liveness available when native admission is closed", async () => {
		app!.restoreRuntime.closeAdmission();
		await app!.restoreRuntime.drain();
		expect((await app!.inject({ method: "GET", url: "/live" })).statusCode).toBe(200);
		expect((await app!.inject({ method: "HEAD", url: "/live" })).statusCode).toBe(200);
		expect((await app!.inject({ method: "GET", url: "/ordinary" })).statusCode).toBe(503);
		expect((await app!.inject({ method: "GET", url: "/health" })).statusCode).toBe(503);
		expect(
			(await app!.inject({ method: "GET", url: "/ordinary?runtimeLiveness=true" })).statusCode,
		).toBe(503);
		expect((await app!.inject({ method: "POST", url: "/live" })).statusCode).toBeGreaterThanOrEqual(
			400,
		);
	});

	it("still refuses liveness after HTTP shutdown admission closes", async () => {
		app!.lifecycle.closeHttpHandlerAdmission();
		expect((await app!.inject({ method: "GET", url: "/live" })).statusCode).toBe(503);
		await app!.lifecycle.drainHttpHandlers();
	});
});
