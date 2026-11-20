import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envSchema } from "../../config/env.js";
import { ArrClientFactory } from "../../lib/arr/client-factory.js";
import { createArrServiceFingerprint } from "../../lib/arr/service-fingerprint.js";
import { SecretManager } from "../../lib/auth/secret-manager.js";
import {
	getRestoreRuntimeClientContext,
	openRestoreRuntime,
	type RestoreRuntime,
	RestoreRuntimeAdmissionError,
} from "../../lib/backup/restore-runtime-admission.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { createSearchGrabRepository } from "../../lib/search/grab-repository.js";
import { createNativeGrabFixture } from "../../routes/search/__tests__/grab-native.fixture.js";
import { registerGrabStatusRoutes } from "../../routes/search/grab-status-routes.js";
import { buildServer } from "../../server.js";
import lifecyclePlugin from "../lifecycle.js";
import searchGrabRecoveryPlugin from "../search-grab-recovery.js";

describe("actual native Grab startup recovery", () => {
	let fixture: Awaited<ReturnType<typeof createNativeGrabFixture>>;
	let fixtureClosed = false;
	let app: FastifyInstance | undefined;
	let runtime: RestoreRuntime | undefined;
	let native: ReturnType<typeof createRuntimePrismaClient> | undefined;
	beforeEach(async () => {
		fixture = await createNativeGrabFixture();
		await fixture.reset();
		fixtureClosed = false;
	});
	afterEach(async () => {
		await app?.close();
		await native?.close();
		await runtime?.close();
		if (!fixtureClosed) await fixture.close();
		app = undefined;
		runtime = undefined;
		native = undefined;
		vi.restoreAllMocks();
	});
	async function record(
		state: "prepared" | "submitting" | "uncertain" | "acknowledged" | "rejected",
		retry?: { predecessorId: string; duplicateRiskConfirmed: true },
		guid = `synthetic:${randomUUID()}`,
	) {
		return fixture.run(async () => {
			const repo = createSearchGrabRepository(
				fixture.native.prisma,
				fixture.runtime,
				fixture.encryptor,
				fixture.user.id,
			);
			const admission = await repo.admit({
				intentId: randomUUID(),
				target: { ...fixture.target(), guid },
				retry,
			});
			if (state !== "prepared") await repo.claimDispatch(admission.attempt.id);
			if (state === "uncertain" || state === "acknowledged" || state === "rejected")
				await repo.settle(admission.attempt.id, state);
			return admission.attempt.id;
		});
	}
	async function stopSeed() {
		const url = getRestoreRuntimeClientContext(fixture.runtime).databaseUrl;
		await fixture.close();
		fixtureClosed = true;
		return url;
	}
	async function boot(observer?: (scope: FastifyInstance) => Promise<void>) {
		const url = await stopSeed();
		runtime = await openRestoreRuntime({ databaseUrl: url });
		await runtime.bindDestination("synthetic-grab-service");
		native = createRuntimePrismaClient(runtime);
		app = Fastify({ logger: false });
		app.decorate("restoreRuntime", runtime);
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
					scope.decorate("arrClientFactory", new ArrClientFactory(fixture.encryptor));
				},
				{ name: "security", dependencies: ["prisma"] },
			),
		);
		registerRestoreBootstrapPlugin(app, searchGrabRecoveryPlugin);
		registerRestoreBootstrapPlugin(app, lifecyclePlugin);
		if (observer)
			registerRestoreBootstrapPlugin(
				app,
				fastifyPlugin(
					async (scope) => {
						scope.addHook("onReady", async () => observer(scope));
					},
					{ name: "synthetic-grab-ready-observer", dependencies: ["search-grab-recovery"] },
				),
			);
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (request) => {
			request.currentUser = fixture.user;
		});
		app.register(registerGrabStatusRoutes, { prefix: "/api" });
		registerRestoreRuntimeActivation(app);
		// Fastify is thenable: returning it from an async helper would start ready early.
		return { server: app };
	}
	const rows = () =>
		runtime!.runOperation(() =>
			native!.prisma.searchGrabAttempt.findMany({ where: { userId: fixture.user.id } }),
		);
	const held = () =>
		runtime!.runOperation(() =>
			native!.prisma.searchGrabClaim.findMany({ where: { userId: fixture.user.id } }),
		);
	it("classifies old work before later ready hooks and keeps status GET strictly read-only", async () => {
		const prepared = await record("prepared"),
			marked = await record("submitting");
		const terminalIds = [
			await record("acknowledged"),
			await record("rejected"),
			await record("uncertain"),
		];
		const before = await fixture.attempts();
		let observed = false;
		const { server } = await boot(async (scope) => {
			const classified = await scope.prisma.searchGrabAttempt.findMany({
				where: { userId: fixture.user.id },
			});
			expect(classified.find((row) => row.id === prepared)).toMatchObject({
				state: "rejected",
				dispatchedAt: null,
				outcomeCategory: "interrupted-before-dispatch",
			});
			expect(classified.find((row) => row.id === marked)).toMatchObject({
				state: "uncertain",
				outcomeCategory: "interrupted-after-marker",
			});
			await expect(
				scope.restoreRuntime.runOperation(() => scope.prisma.user.count()),
			).rejects.toBeInstanceOf(RestoreRuntimeAdmissionError);
			observed = true;
		});
		await server.ready();
		expect(observed).toBe(true);
		const after = await rows();
		for (const id of terminalIds)
			expect(after.find((row) => row.id === id)).toEqual(before.find((row) => row.id === id));
		expect(await held()).toHaveLength(2);
		const intent = after.find((row) => row.id === prepared)!.intentId;
		expect(
			(await server.inject({ method: "GET", url: `/api/search/grab/intents/${intent}` }))
				.statusCode,
		).toBe(200);
		expect(await rows()).toEqual(after);
		await server.ready();
		expect(await rows()).toEqual(after);
		expect(fixture.posts).toEqual([]);
	});
	it("recovers imported null-epoch prepared and marked records without dispatch", async () => {
		const prepared = await record("prepared"),
			marked = await record("submitting");
		await fixture.run(() =>
			fixture.native.prisma.searchGrabAttempt.updateMany({
				where: { userId: fixture.user.id },
				data: { workerEpoch: null },
			}),
		);
		await (await boot()).server.ready();
		const after = await rows();
		expect(after.find((row) => row.id === prepared)).toMatchObject({
			state: "rejected",
			dispatchedAt: null,
			workerEpoch: null,
		});
		expect(after.find((row) => row.id === marked)).toMatchObject({
			state: "uncertain",
			workerEpoch: null,
		});
		expect((await held()).map((row) => row.attemptId)).toEqual([marked]);
		expect(fixture.posts).toEqual([]);
	});
	it("returns an old unsent successor claim to the original uncertain predecessor", async () => {
		const guid = `synthetic:${randomUUID()}`,
			predecessorId = await record("uncertain", undefined, guid);
		const original = (await fixture.attempts()).find((row) => row.id === predecessorId);
		const successorId = await record(
			"prepared",
			{ predecessorId, duplicateRiskConfirmed: true },
			guid,
		);
		await (await boot()).server.ready();
		const after = await rows();
		expect(after.find((row) => row.id === predecessorId)).toEqual(original);
		expect(after.find((row) => row.id === successorId)).toMatchObject({
			state: "rejected",
			dispatchedAt: null,
		});
		expect((await held()).map((row) => row.attemptId)).toEqual([predecessorId]);
		expect(fixture.posts).toEqual([]);
	});
	it("leaves current-epoch prepared and marked work untouched", async () => {
		const oldId = await record("prepared");
		const { server } = await boot();
		const currentIds: string[] = [];
		await runtime!.runStarting(async () => {
			const repo = createSearchGrabRepository(
				native!.prisma,
				runtime!,
				fixture.encryptor,
				fixture.user.id,
			);
			for (const mark of [false, true]) {
				const admission = await repo.admit({
					intentId: randomUUID(),
					target: { ...fixture.target(), guid: `synthetic:${randomUUID()}` },
				});
				if (mark) await repo.claimDispatch(admission.attempt.id);
				currentIds.push(admission.attempt.id);
			}
		});
		const before = await runtime!.runStarting(() =>
			native!.prisma.searchGrabAttempt.findMany({
				where: { id: { in: currentIds }, userId: fixture.user.id },
			}),
		);
		await server.ready();
		const after = await rows();
		for (const row of before) expect(after.find((value) => value.id === row.id)).toEqual(row);
		expect(after.find((row) => row.id === oldId)?.state).toBe("rejected");
		expect(await held()).toHaveLength(2);
		expect(fixture.posts).toEqual([]);
	});
	it("continues past a bounded batch to recover every affected owner", async () => {
		const ownerIds: string[] = [];
		await fixture.run(async () => {
			for (let index = 0; index < 101; index++) {
				const user = await fixture.native.prisma.user.create({
					data: { username: `synthetic-owner-${randomUUID()}` },
				});
				ownerIds.push(user.id);
				const instance = await fixture.native.prisma.serviceInstance.create({
					data: {
						userId: user.id,
						service: "PROWLARR",
						label: "Synthetic",
						baseUrl: fixture.instance.baseUrl,
						encryptedApiKey: fixture.instance.encryptedApiKey,
						encryptionIv: fixture.instance.encryptionIv,
					},
				});
				const repo = createSearchGrabRepository(
					fixture.native.prisma,
					fixture.runtime,
					fixture.encryptor,
					user.id,
				);
				await repo.admit({
					intentId: randomUUID(),
					target: {
						...fixture.target(),
						userId: user.id,
						serviceInstanceId: instance.id,
						connectionFingerprint: createArrServiceFingerprint(instance),
					},
				});
			}
		});
		await (await boot()).server.ready();
		const counts = await runtime!.runOperation(async () => ({
			rejected: await native!.prisma.searchGrabAttempt.count({
				where: { userId: { in: ownerIds }, state: "rejected" },
			}),
			held: await native!.prisma.searchGrabClaim.count({ where: { userId: { in: ownerIds } } }),
		}));
		expect(counts).toEqual({ rejected: 101, held: 0 });
		expect(fixture.posts).toEqual([]);
	}, 30000);
	it("native recovery failure refuses readiness and running admission with sanitized diagnostics", async () => {
		await record("prepared");
		const before = await fixture.attempts();
		const { server } = await boot();
		const error = vi.spyOn(server.log, "error");
		const diagnostic = "synthetic-private-recovery-diagnostic";
		let readinessOpened = false;
		await runtime!.runStarting(async () => {
			if (fixture.engine === "sqlite")
				await native!.prisma.$executeRawUnsafe(
					`CREATE TRIGGER synthetic_grab_recovery_fault BEFORE UPDATE OF state ON SearchGrabAttempt BEGIN SELECT RAISE(ABORT, '${diagnostic}'); END`,
				);
			else {
				await native!.prisma.$executeRawUnsafe(
					`CREATE FUNCTION synthetic_grab_recovery_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${diagnostic}'; END $$`,
				);
				await native!.prisma.$executeRawUnsafe(
					'CREATE TRIGGER synthetic_grab_recovery_fault BEFORE UPDATE OF state ON "SearchGrabAttempt" FOR EACH ROW EXECUTE FUNCTION synthetic_grab_recovery_fault()',
				);
			}
		});
		try {
			await expect(
				server.ready().then(() => {
					readinessOpened = true;
				}),
			).rejects.toThrow("Search submission recovery failed");
			await expect(runtime!.runOperation(() => native!.prisma.user.count())).rejects.toBeInstanceOf(
				RestoreRuntimeAdmissionError,
			);
			const after = await runtime!.runStarting(() =>
				native!.prisma.searchGrabAttempt.findMany({ where: { userId: fixture.user.id } }),
			);
			expect(after).toEqual(before);
			expect(JSON.stringify(error.mock.calls)).not.toContain(diagnostic);
			expect(fixture.posts).toEqual([]);
		} finally {
			const cleanup = async () => {
				await native!.prisma.$executeRawUnsafe(
					fixture.engine === "sqlite"
						? "DROP TRIGGER synthetic_grab_recovery_fault"
						: 'DROP TRIGGER synthetic_grab_recovery_fault ON "SearchGrabAttempt"',
				);
				if (fixture.engine === "postgresql")
					await native!.prisma.$executeRawUnsafe("DROP FUNCTION synthetic_grab_recovery_fault()");
			};
			if (readinessOpened) await runtime!.runOperation(cleanup);
			else await runtime!.runStarting(cleanup);
		}
	});
	it("the actual full server registers recovery before native activation", async () => {
		const id = await record("submitting"),
			url = await stopSeed();
		// Only file-based local configuration lookup is synthetic. No secret files are accessed.
		vi.spyOn(SecretManager.prototype, "getOrCreateSecrets").mockReturnValue({
			encryptionKey: "77".repeat(32),
			sessionCookieSecret: "88".repeat(32),
			installationId: "synthetic-grab-service",
		});
		app = buildServer({
			logger: false,
			env: envSchema.parse({
				NODE_ENV: "test",
				DATABASE_URL: url,
				API_PORT: 0,
				API_HOST: "127.0.0.1",
				COOKIE_SECURE: "false",
				TRUST_PROXY: "false",
				APP_URL: "http://127.0.0.1",
				TMDB_BASE_URL: "https://synthetic.invalid",
				TMDB_IMAGE_BASE_URL: "https://synthetic.invalid",
			}),
		});
		await app.ready();
		runtime = app.restoreRuntime;
		native = createRuntimePrismaClient(runtime);
		expect((await rows()).find((row) => row.id === id)).toMatchObject({
			state: "uncertain",
			outcomeCategory: "interrupted-after-marker",
		});
		expect((await held()).map((row) => row.attemptId)).toEqual([id]);
		expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
		expect(fixture.posts).toEqual([]);
	}, 30000);
});
