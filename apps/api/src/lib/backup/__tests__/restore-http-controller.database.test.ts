import { restoreBackupResponseSchema } from "@arr/shared";
import { rm } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	bootRestoreHttpFixture,
	createRestoreHttpTemplate,
	readRestoreFixtureRows,
	restoreHttpFixtureModes,
} from "../../../routes/__tests__/fixtures/backup-restore-http-actor.js";
import { acquireIndependentCleanupOperationGuard } from "../../library-cleanup/cleanup-maintenance-gate.js";
import { RestorePreparationError } from "../backup-restore-preparation.js";
import {
	preparePublicationCredentialFixture,
	publicationCredentialColumns,
} from "./fixtures/restore-runtime-replacement-actor.js";

async function controllerModule() {
	const module = await import("../restore-http-controller.js").catch(() => undefined);
	expect(module, "real protected Restore controller implementation must exist").toBeDefined();
	expect(module!.runRestoreHttpController).toBeTypeOf("function");
	return module!;
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((release) => {
		resolve = release;
	});
	return { promise, resolve };
}

let template: string;
beforeAll(async () => {
	template = await createRestoreHttpTemplate();
}, 90000);
afterAll(async () => {
	if (template) await rm(template, { recursive: true, force: true });
});

describe.each(restoreHttpFixtureModes)("trusted Restore dispatch with actual %s", (mode) => {
	let fixture: Awaited<ReturnType<typeof bootRestoreHttpFixture>>;
	let app: FastifyInstance;
	let cookie: string;
	beforeEach(async () => {
		fixture = await bootRestoreHttpFixture(template, mode, undefined, { routes: false });
		app = fixture.app;
		cookie = fixture.cookie;
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await fixture?.dispose();
	});

	async function journal() {
		return (
			await readRestoreFixtureRows(
				fixture,
				'SELECT phase, "activeRestoreId", "lastCommittedRestoreId" FROM "RestoreRuntimeControl"',
			)
		)[0];
	}
	async function expectHealthy() {
		expect(await journal()).toEqual({
			phase: "running",
			activeRestoreId: null,
			lastCommittedRestoreId: null,
		});
		expect(await app.restoreRuntime.runOperation(() => app.prisma.user.count())).toBe(1);
	}

	it("rejects bad preparation before maintenance and leaves ordinary native reads healthy", async () => {
		const { runRestoreHttpController } = await controllerModule();
		app.post("/restore", { config: { runtimeRestoreController: true } }, (request) =>
			runRestoreHttpController(app, request, async () => {
				throw new RestorePreparationError("authentication-failed");
			}),
		);
		const response = await app.inject({ method: "POST", url: "/restore", headers: { cookie } });
		expect(response.statusCode).toBe(400);
		await expectHealthy();
	});

	it("rejects an unstable destination before admitting expensive preparation", async () => {
		const { runRestoreHttpController } = await controllerModule();
		app.secretsSynchronized = false;
		let preparations = 0;
		app.post("/restore", { config: { runtimeRestoreController: true } }, (request) =>
			runRestoreHttpController(app, request, async () => {
				preparations++;
				throw new RestorePreparationError("invalid-envelope");
			}),
		);
		expect(
			(await app.inject({ method: "POST", url: "/restore", headers: { cookie } })).statusCode,
		).toBe(503);
		expect(preparations).toBe(0);
		await expectHealthy();
	});

	it.each(["revoked", "expired"] as const)(
		"revalidates a session %s during actual preparation",
		async (change) => {
			const { runRestoreHttpController } = await controllerModule();
			const prepared = await preparePublicationCredentialFixture(
				app.restoreRuntime,
				app.prisma,
				true,
			);
			const entered = deferred(),
				release = deferred();
			app.post("/restore", { config: { runtimeRestoreController: true } }, (request) =>
				runRestoreHttpController(app, request, async () => {
					await app.prisma.user.count();
					entered.resolve();
					await release.promise;
					return prepared;
				}),
			);
			const response = app.inject({ method: "POST", url: "/restore", headers: { cookie } });
			try {
				await entered.promise;
				await app.restoreRuntime.runIndependentOperation(async () => {
					if (change === "revoked") await app.prisma.session.deleteMany();
					else await app.prisma.session.updateMany({ data: { expiresAt: new Date(0) } });
				});
			} finally {
				release.resolve();
			}
			expect((await response).statusCode).toBe(401);
			await expectHealthy();
		},
	);

	it("refuses a second controller without starting a second preparation", async () => {
		const { runRestoreHttpController } = await controllerModule();
		const entered = deferred(),
			release = deferred();
		let preparations = 0;
		app.post("/restore", { config: { runtimeRestoreController: true } }, (request) =>
			runRestoreHttpController(app, request, async () => {
				preparations++;
				entered.resolve();
				await release.promise;
				throw new RestorePreparationError("invalid-envelope");
			}),
		);
		const first = app.inject({ method: "POST", url: "/restore", headers: { cookie } });
		try {
			await entered.promise;
			expect(
				(await app.inject({ method: "POST", url: "/restore", headers: { cookie } })).statusCode,
			).toBe(409);
			expect(preparations).toBe(1);
		} finally {
			release.resolve();
		}
		expect((await first).statusCode).toBe(400);
		await expectHealthy();
	});

	it("refuses competing cleanup before cutover and leaves native admission open", async () => {
		const { runRestoreHttpController } = await controllerModule();
		const prepared = await preparePublicationCredentialFixture(
			app.restoreRuntime,
			app.prisma,
			true,
		);
		app.post("/restore", { config: { runtimeRestoreController: true } }, (request) =>
			runRestoreHttpController(app, request, async () => prepared),
		);
		const release = acquireIndependentCleanupOperationGuard();
		try {
			expect(
				(await app.inject({ method: "POST", url: "/restore", headers: { cookie } })).statusCode,
			).toBe(409);
		} finally {
			release();
		}
		await expectHealthy();
	});

	it("refuses a structural prepared-value clone before reserving native replacement", async () => {
		const { runRestoreHttpController } = await controllerModule();
		const prepared = await preparePublicationCredentialFixture(
			app.restoreRuntime,
			app.prisma,
			true,
		);
		app.post("/restore", { config: { runtimeRestoreController: true } }, (request) =>
			runRestoreHttpController(app, request, async () => ({ ...prepared })),
		);
		expect(
			(await app.inject({ method: "POST", url: "/restore", headers: { cookie } })).statusCode,
		).toBe(400);
		await expectHealthy();
	});

	it("publishes exactly one real native replacement with translated credentials and revoked sessions", async () => {
		const { runRestoreHttpController } = await controllerModule();
		const prepared = await preparePublicationCredentialFixture(
			app.restoreRuntime,
			app.prisma,
			true,
		);
		let preparations = 0;
		app.post("/restore", { config: { runtimeRestoreController: true } }, (request) =>
			runRestoreHttpController(app, request, async (destination) => {
				preparations++;
				expect(destination.installationId).toBe("synthetic-destination");
				expect(destination.stableForRestart).toBe(true);
				expect(await app.prisma.user.count()).toBe(1);
				return prepared;
			}),
		);
		const response = await app.inject({ method: "POST", url: "/restore", headers: { cookie } });
		expect(response.statusCode, response.body).toBe(200);
		const result = restoreBackupResponseSchema.parse(response.json());
		expect(result).toMatchObject({
			outcome: "committed",
			success: true,
			reason: null,
			restartRequired: true,
			restart: "manual-required",
		});
		expect(preparations).toBe(1);
		expect(await journal()).toEqual({
			phase: "restart-required",
			activeRestoreId: result.restoreId,
			lastCommittedRestoreId: result.restoreId,
		});
		for (const [table, value, iv, plaintext] of publicationCredentialColumns) {
			const rows = (await readRestoreFixtureRows(
				fixture,
				`SELECT "${value}" AS value, "${iv}" AS iv FROM "${table}"`,
			)) as Array<{ value: string; iv: string }>;
			expect(rows).toHaveLength(1);
			expect(app.encryptor.decrypt(rows[0]!)).toBe(plaintext);
		}
		expect(await readRestoreFixtureRows(fixture, 'SELECT username FROM "User"')).toEqual([
			{ username: "synthetic-restored" },
		]);
		expect(
			Number(
				(await readRestoreFixtureRows(fixture, 'SELECT COUNT(*) AS count FROM "sessions"'))[0]!
					.count,
			),
		).toBe(0);
		expect(
			await readRestoreFixtureRows(
				fixture,
				'SELECT id, state FROM "queue_cleaner_import_receipts"',
			),
		).toEqual([{ id: "credential-receipt", state: "unknown" }]);
		await expect(app.restoreRuntime.runOperation(() => app.prisma.user.count())).rejects.toThrow();
	});

	it("returns verified non-commit without deleting a safety hold added after preparation", async () => {
		const { runRestoreHttpController } = await controllerModule();
		const prepared = await preparePublicationCredentialFixture(
			app.restoreRuntime,
			app.prisma,
			true,
		);
		await app.restoreRuntime.runOperation(() =>
			app.prisma.queueCleanerImportReceipt.create({
				data: {
					id: "late-hold",
					instanceId: "credential-instance",
					downloadKey: "b".repeat(64),
					queueId: 8,
					downloadTitle: "synthetic-late",
					connectionFingerprint: `v1:${"c".repeat(64)}`,
					commandFingerprint: `v1:${"d".repeat(64)}`,
					commandId: 43,
					state: "unknown",
					lastAttemptAt: new Date(),
				},
			}),
		);
		app.post("/restore", { config: { runtimeRestoreController: true } }, async (request, reply) => {
			const result = await runRestoreHttpController(app, request, async () => prepared);
			return reply.code(result.outcome === "not-committed" ? 409 : 200).send(result);
		});
		const response = await app.inject({ method: "POST", url: "/restore", headers: { cookie } });
		expect(response.statusCode, response.body).toBe(409);
		const result = restoreBackupResponseSchema.parse(response.json());
		expect(result).toMatchObject({
			outcome: "not-committed",
			success: false,
			reason: "state-changed",
			restart: "manual-required",
		});
		expect(await journal()).toEqual({
			phase: "restore-pending",
			activeRestoreId: result.restoreId,
			lastCommittedRestoreId: null,
		});
		expect(
			await readRestoreFixtureRows(
				fixture,
				'SELECT id, state FROM "queue_cleaner_import_receipts" ORDER BY id',
			),
		).toEqual([
			{ id: "credential-receipt", state: "unknown" },
			{ id: "late-hold", state: "unknown" },
		]);
		expect(await readRestoreFixtureRows(fixture, 'SELECT username FROM "User"')).toEqual([
			{ username: "synthetic-old" },
		]);
		expect(
			Number(
				(await readRestoreFixtureRows(fixture, 'SELECT COUNT(*) AS count FROM "sessions"'))[0]!
					.count,
			),
		).toBe(1);
		await expect(app.restoreRuntime.runOperation(() => app.prisma.user.count())).rejects.toThrow();
	});

	it("retains verified commitment and requests manual recovery if automatic restart cannot be requested", async () => {
		const { runRestoreHttpController } = await controllerModule();
		const prepared = await preparePublicationCredentialFixture(
			app.restoreRuntime,
			app.prisma,
			true,
		);
		vi.stubEnv("LAUNCHER_MANAGED", "true");
		vi.spyOn(app.lifecycle, "restart").mockRejectedValue(
			new Error("Synthetic restart-request failure"),
		);
		app.post("/restore", { config: { runtimeRestoreController: true } }, (request) =>
			runRestoreHttpController(app, request, async () => prepared),
		);
		const response = await app.inject({ method: "POST", url: "/restore", headers: { cookie } });
		expect(response.statusCode, response.body).toBe(200);
		const result = restoreBackupResponseSchema.parse(response.json());
		expect(result).toMatchObject({
			outcome: "committed",
			success: true,
			reason: null,
			restart: "manual-required",
		});
		expect(await journal()).toMatchObject({
			phase: "restart-required",
			lastCommittedRestoreId: result.restoreId,
		});
	});

	it("does not grant an implicit database ticket to a trusted Restore controller", async () => {
		app.post("/controller", { config: { runtimeRestoreController: true } }, async () => {
			try {
				await app.prisma.user.count();
				return { implicitDatabaseAccess: true };
			} catch {
				return { implicitDatabaseAccess: false };
			}
		});
		const response = await app.inject({
			method: "POST",
			url: "/controller",
			headers: { cookie },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ implicitDatabaseAccess: false });
		expect(await app.restoreRuntime.runOperation(() => app.prisma.user.count())).toBe(1);
	});

	it("releases an explicit preparation ticket before returning to the controller", async () => {
		app.post("/controller", { config: { runtimeRestoreController: true } }, async () => {
			const count = await app.restoreRuntime.runOperation(() => app.prisma.user.count());
			try {
				await app.prisma.user.count();
				return { count, accessAfterPreparation: true };
			} catch {
				return { count, accessAfterPreparation: false };
			}
		});
		const response = await app.inject({
			method: "POST",
			url: "/controller",
			headers: { cookie },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ count: 1, accessAfterPreparation: false });
	});

	it("ignores client-supplied controller flags on an ordinary mutation", async () => {
		app.post("/ordinary", async () => ({ count: await app.prisma.user.count() }));
		const response = await app.inject({
			method: "POST",
			url: "/ordinary?runtimeRestoreController=true",
			headers: { cookie, "runtime-restore-controller": "true" },
			payload: { runtimeRestoreController: true, config: { runtimeRestoreController: true } },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ count: 1 });
	});

	it("still validates a real signed session for the trusted controller", async () => {
		let executions = 0;
		app.post("/controller", { config: { runtimeRestoreController: true } }, async () => {
			executions++;
			return { authorized: true };
		});
		expect((await app.inject({ method: "POST", url: "/controller" })).statusCode).toBe(401);
		expect(
			(
				await app.inject({
					method: "POST",
					url: "/controller",
					headers: { cookie: "arr_session=synthetic-invalid-signature" },
				})
			).statusCode,
		).toBe(401);
		expect(executions).toBe(0);
		expect(
			(await app.inject({ method: "POST", url: "/controller", headers: { cookie } })).statusCode,
		).toBe(200);
		expect(executions).toBe(1);
	});
});
