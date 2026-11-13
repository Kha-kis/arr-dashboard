import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { envSchema } from "../../../config/env.js";
import { buildServer } from "../../../server.js";
import {
	getRestoreRuntimeShutdownStatus,
	openRestoreRuntime,
	retainRestoreRuntimeOperation,
} from "../restore-runtime-admission.js";
import { acquirePostgresRestoreRuntimeOwnership } from "../restore-runtime-postgres.js";

/** Real server/plugins/client; only the database and outbound webhook are synthetic. */
describe("actual PostgreSQL application runtime admission", () => {
	let app: FastifyInstance | undefined;
	let fixture: Client;
	let url: string;
	let data: string;
	let secretFile: string;
	let installationId: string;
	beforeAll(() => {
		const project = process.env.RESTORE_RUNTIME_TEST_PROJECT;
		if (
			!project ||
			resolve(process.cwd()) !== resolve(project) ||
			!project.includes("/artifacts/restore-application-admission-")
		)
			throw new Error("Private application working directory required");
		data = join(project, "data");
		mkdirSync(data, { mode: 0o700 });
		secretFile = join(data, "secrets.json");
		installationId = randomBytes(16).toString("hex");
		writeFileSync(
			secretFile,
			JSON.stringify({
				encryptionKey: randomBytes(32).toString("hex"),
				sessionCookieSecret: randomBytes(32).toString("hex"),
				installationId,
			}),
			{ mode: 0o600, flag: "wx" },
		);
	});
	beforeEach(async () => {
		url = process.env.RESTORE_RUNTIME_TEST_PG_URL!;
		const parsed = new URL(url);
		if (
			parsed.hostname !== "127.0.0.1" ||
			!parsed.pathname.endsWith("_test") ||
			parsed.search ||
			parsed.hash
		)
			throw new Error("Owned isolated PostgreSQL database required");
		fixture = new Client({ connectionString: url });
		await fixture.connect();
		// Delivery history deliberately has no cascading channel/user foreign key.
		await fixture.query(
			'TRUNCATE TABLE "User", "RestoreRuntimeControl", notification_logs RESTART IDENTITY CASCADE',
		);
		await fixture.query(
			'INSERT INTO "RestoreRuntimeControl" (id,"protocolVersion",phase) VALUES(1,1,\'idle\')',
		);
	});
	afterEach(async () => {
		const runtime = app?.hasDecorator("restoreRuntime") ? app.restoreRuntime : undefined;
		await app?.close();
		await runtime?.close();
		app = undefined;
		await fixture?.end();
		vi.restoreAllMocks();
	});
	afterAll(() => {
		// Only this suite's exclusive, synthetic secrets directory, after native shutdown.
		if (data) rmSync(data, { recursive: true });
	});
	function create() {
		app = buildServer({
			logger: false,
			env: envSchema.parse({
				NODE_ENV: "test",
				DATABASE_URL: url,
				API_HOST: "127.0.0.1",
				API_PORT: 0,
				COOKIE_SECURE: "false",
				TRUST_PROXY: "false",
				APP_URL: "http://127.0.0.1",
				TMDB_BASE_URL: "https://synthetic.invalid",
				TMDB_IMAGE_BASE_URL: "https://synthetic.invalid",
			}),
		});
		return app;
	}
	async function terminateOwner() {
		const row = (
			await fixture.query('SELECT "ownerBackendPid" FROM "RestoreRuntimeControl" WHERE id=1')
		).rows[0];
		expect(Number.isInteger(row?.ownerBackendPid)).toBe(true);
		expect(
			(await fixture.query("SELECT pg_terminate_backend($1) AS stopped", [row.ownerBackendPid]))
				.rows,
		).toEqual([{ stopped: true }]);
	}
	async function countUsers() {
		return Number((await fixture.query('SELECT COUNT(*) AS count FROM "User"')).rows[0].count);
	}
	async function participantPids() {
		return (
			await fixture.query(`
SELECT a.pid FROM pg_stat_activity a
WHERE a.datname = current_database() AND a.state = 'idle in transaction'
AND EXISTS (
 SELECT 1 FROM pg_locks l
 WHERE l.pid = a.pid AND l.locktype = 'advisory' AND l.granted
 AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
 AND l.classid = 1095914052::oid AND l.objid = 2::oid AND l.objsubid = 2
 AND l.mode = 'ShareLock'
)`)
		).rows as { pid: number }[];
	}
	async function operationRuntime(onUnavailable?: () => void) {
		const runtime = await openRestoreRuntime({ databaseUrl: url, onUnavailable });
		try {
			await runtime.bindDestination(installationId);
			await runtime.activate();
			return runtime;
		} catch (error) {
			await runtime.close();
			throw error;
		}
	}
	it("first admission validates on its held participant without a redundant native connection", async () => {
		const runtime = await operationRuntime();
		const connections = vi.spyOn(Client.prototype, "connect");
		const queries = vi.spyOn(Client.prototype, "query");
		let release!: () => void, enter!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const operation = runtime.runIndependentOperation(async () => {
			enter();
			await gate;
		});
		try {
			await ready;
			expect(connections.mock.calls).toHaveLength(1);
			expect(queries.mock.calls.length).toBeLessThanOrEqual(10);
			expect(await participantPids()).toHaveLength(1);
			release();
			await operation;
			expect(await participantPids()).toHaveLength(0);
		} finally {
			release();
			await operation;
			connections.mockRestore();
			queries.mockRestore();
			await runtime.close();
		}
	}, 30000);
	it("overlapping admission reads changed journal state instead of reusing the participant's initial proof", async () => {
		const runtime = await operationRuntime();
		let release!: () => void, enter!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const operation = runtime.runIndependentOperation(async () => {
			enter();
			await gate;
		});
		let nextEntered = false;
		try {
			await ready;
			expect(await participantPids()).toHaveLength(1);
			await fixture.query(
				'UPDATE "RestoreRuntimeControl" SET "destinationInstallationId" = $1 WHERE id = 1',
				[randomBytes(16).toString("hex")],
			);
			await expect(
				runtime.runIndependentOperation(async () => {
					nextEntered = true;
				}),
			).rejects.toThrow();
			expect(nextEntered).toBe(false);
			expect(await participantPids()).toHaveLength(1);
			release();
			await operation;
			expect(await participantPids()).toHaveLength(0);
		} finally {
			release();
			await operation;
			await runtime.close();
		}
	}, 30000);
	it("failed native participation acquisition refuses the callback and permanently fences admission", async () => {
		let losses = 0,
			entered = false;
		const runtime = await operationRuntime(() => {
			losses++;
		});
		let locked = false;
		try {
			await fixture.query("SELECT pg_advisory_lock($1, $2)", [1095914052, 2]);
			locked = true;
			await expect(
				runtime.runIndependentOperation(async () => {
					entered = true;
				}),
			).rejects.toThrow();
			expect(entered).toBe(false);
			expect(losses).toBe(1);
			expect(await participantPids()).toHaveLength(0);
			await fixture.query("SELECT pg_advisory_unlock($1, $2)", [1095914052, 2]);
			locked = false;
			await expect(
				runtime.runIndependentOperation(async () => {
					entered = true;
				}),
			).rejects.toThrow();
			expect(entered).toBe(false);
		} finally {
			if (locked) await fixture.query("SELECT pg_advisory_unlock($1, $2)", [1095914052, 2]);
			await runtime.close();
		}
	}, 30000);
	it("admission closure joins a pending participant acquisition and refuses its callback", async () => {
		const runtime = await operationRuntime();
		let release!: () => void, enter!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const original = Client.prototype.query;
		let armed = true,
			callbackEntered = false;
		const query = vi.spyOn(Client.prototype, "query").mockImplementation(function (
			this: Client,
			...args: unknown[]
		) {
			if (armed && args[0] === "SELECT pg_try_advisory_xact_lock_shared($1, $2) AS acquired") {
				armed = false;
				enter();
				return gate.then(() => Reflect.apply(original, this, args));
			}
			return Reflect.apply(original, this, args);
		});
		const operation = runtime
			.runIndependentOperation(async () => {
				callbackEntered = true;
			})
			.then(
				() => "entered",
				() => "refused",
			);
		try {
			await ready;
			runtime.closeAdmission();
			let drained = false;
			const draining = runtime.drain().then(() => {
				drained = true;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(drained).toBe(false);
			release();
			expect(await operation).toBe("refused");
			await draining;
			expect(callbackEntered).toBe(false);
			expect(await participantPids()).toHaveLength(0);
		} finally {
			release();
			query.mockRestore();
			await operation;
			await runtime.close();
		}
	}, 30000);
	it("independent and nested operations share one physical participant until the last settlement", async () => {
		const runtime = await operationRuntime();
		const gates = Array.from({ length: 12 }, () => {
			let release!: () => void, enter!: () => void;
			return {
				gate: new Promise<void>((resolve) => {
					release = resolve;
				}),
				ready: new Promise<void>((resolve) => {
					enter = resolve;
				}),
				release: () => release(),
				enter: () => enter(),
			};
		});
		const operations = gates.map((gate) =>
			runtime.runIndependentOperation(async () => {
				await runtime.runOperation(async () => {});
				gate.enter();
				await gate.gate;
			}),
		);
		let releaseNext!: () => void, enterNext!: () => void;
		const nextGate = new Promise<void>((resolve) => {
			releaseNext = resolve;
		});
		const nextReady = new Promise<void>((resolve) => {
			enterNext = resolve;
		});
		let next: Promise<void> | undefined;
		try {
			await Promise.all(gates.map((gate) => gate.ready));
			expect(await participantPids()).toHaveLength(1);
			for (const gate of gates.slice(0, 6)) gate.release();
			await Promise.all(operations.slice(0, 6));
			expect(await participantPids()).toHaveLength(1);
			for (const gate of gates.slice(6)) gate.release();
			next = runtime.runIndependentOperation(async () => {
				enterNext();
				await nextGate;
			});
			await nextReady;
			await Promise.all(operations);
			expect(await participantPids()).toHaveLength(1);
			releaseNext();
			await next;
			expect(await participantPids()).toHaveLength(0);
		} finally {
			for (const gate of gates) gate.release();
			releaseNext();
			await Promise.allSettled([...operations, next]);
			await runtime.close();
		}
	}, 30000);
	it("a retained callback owns participation only for its actual execution lifetime", async () => {
		const runtime = await operationRuntime();
		const retained = await runtime.runOperation(async () => retainRestoreRuntimeOperation());
		let release!: () => void, enter!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			enter = resolve;
		});
		let operation: Promise<void> | undefined;
		let released = false;
		try {
			expect(retained).toBeDefined();
			expect(await participantPids()).toHaveLength(0);
			operation = retained!.run(async () => {
				enter();
				await gate;
			});
			await ready;
			expect(await participantPids()).toHaveLength(1);
			const releasing = retained!.release().then(() => {
				released = true;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(released).toBe(false);
			release();
			await operation;
			await releasing;
			expect(await participantPids()).toHaveLength(0);
			await expect(retained!.run(async () => {})).rejects.toThrow();
		} finally {
			release();
			await Promise.allSettled([operation, retained?.release()]);
			await runtime.close();
		}
	}, 30000);
	it.each(["false", "rejected"] as const)(
		"a %s participation-close acknowledgement cannot complete operation or drain before physical end",
		async (mode) => {
			let losses = 0;
			const runtime = await operationRuntime(() => {
				losses++;
			});
			const ownerPid = (
				await fixture.query('SELECT "ownerBackendPid" FROM "RestoreRuntimeControl" WHERE id=1')
			).rows[0].ownerBackendPid as number;
			let release!: () => void, enter!: () => void, endCalled!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const ready = new Promise<void>((resolve) => {
				enter = resolve;
			});
			const endRequested = new Promise<void>((resolve) => {
				endCalled = resolve;
			});
			let operationSettled = false,
				runtimeClosed = false;
			const operation = runtime
				.runIndependentOperation(async () => {
					enter();
					await gate;
				})
				.then(
					() => "completed",
					() => "failed",
				)
				.finally(() => {
					operationSettled = true;
				});
			const actualEnd = Client.prototype.end;
			let intercepted: Client | undefined;
			let restoreEnd = () => {};
			let closing: Promise<void> | undefined;
			let queued: Promise<string> | undefined;
			let queuedEntered = false;
			try {
				await ready;
				const participants = await participantPids();
				expect(participants).toHaveLength(1);
				const pid = participants[0]!.pid;
				const endSpy = vi.spyOn(Client.prototype, "end").mockImplementation(function (
					this: Client,
					...args: unknown[]
				) {
					if ((this as unknown as { processID: number }).processID === pid) {
						intercepted = this;
						endCalled();
						return mode === "false"
							? Promise.resolve()
							: Promise.reject(new Error("Synthetic close acknowledgement failure"));
					}
					return Reflect.apply(actualEnd, this, args);
				});
				restoreEnd = () => endSpy.mockRestore();
				release();
				await endRequested;
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(operationSettled).toBe(false);
				expect(await participantPids()).toHaveLength(1);
				queued = runtime
					.runIndependentOperation(async () => {
						queuedEntered = true;
					})
					.then(
						() => "entered",
						() => "refused",
					);
				closing = runtime.close().then(() => {
					runtimeClosed = true;
				});
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(runtimeClosed).toBe(false);
				restoreEnd();
				await Reflect.apply(actualEnd, intercepted!, []);
				expect(await operation).toBe("completed");
				expect(await queued).toBe("refused");
				expect(queuedEntered).toBe(false);
				await closing;
				expect(await participantPids()).toHaveLength(0);
				expect(losses).toBe(mode === "rejected" ? 1 : 0);
			} finally {
				restoreEnd();
				if (intercepted) await Reflect.apply(actualEnd, intercepted, []);
				release();
				await operation;
				await queued;
				let cleanupClosed = false;
				const cleanup = runtime.close().then(
					() => {
						cleanupClosed = true;
					},
					() => {},
				);
				let timer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([
					cleanup,
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, 1000);
					}),
				]);
				if (timer) clearTimeout(timer);
				// A failing regression may leave the ticket stuck. Tear down only this
				// fixture runtime's exact owner; never grant it successful drain evidence.
				if (!cleanupClosed) await fixture.query("SELECT pg_terminate_backend($1)", [ownerPid]);
			}
		},
		30000,
	);
	it("actual bootstrap, authenticated route metadata and same-database restart preserve installation and data", async () => {
		const server = create();
		await server.ready();
		expect(server.dbProvider).toBe("postgresql");
		expect(
			(await fixture.query('SELECT phase,"destinationInstallationId" FROM "RestoreRuntimeControl"'))
				.rows,
		).toEqual([{ phase: "running", destinationInstallationId: installationId }]);
		expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
		expect((await server.inject({ method: "GET", url: "/auth/me" })).statusCode).toBe(401);
		await expect(server.prisma.user.count()).rejects.toThrow();
		const session = await server.restoreRuntime.runOperation(async () => {
			const user = await server.prisma.user.create({
				data: { username: "fixture-pg-session", mustChangePassword: false },
			});
			await server.prisma.serviceInstance.create({
				data: {
					userId: user.id,
					service: "JELLYFIN",
					label: "Synthetic",
					baseUrl: "http://synthetic.invalid",
					enabled: false,
					encryptedApiKey: "synthetic",
					encryptionIv: "synthetic",
				},
			});
			const session = await server.sessionService.createSession(user.id);
			await server.prisma.session.updateMany({ data: { lastAccessedAt: new Date(0) } });
			return session;
		});
		const cookie = server.signCookie(session.token);
		expect(
			(await server.inject({ method: "GET", url: "/auth/me", cookies: { arr_session: cookie } }))
				.statusCode,
		).toBe(200);
		await server.sessionService.drainValidations();
		expect(
			await server.schedulerRegistry.track("session-cleanup", () => server.prisma.user.count()),
		).toBe(1);
		await server.restoreRuntime.runOperation(async () => {
			expect(
				(await server.prisma.session.findFirstOrThrow()).lastAccessedAt.getTime(),
			).toBeGreaterThan(0);
		});
		const previousEpoch = (
			await fixture.query('SELECT "runtimeEpoch" FROM "RestoreRuntimeControl"')
		).rows[0].runtimeEpoch;
		const secrets = readFileSync(secretFile);
		await server.close();
		await server.restoreRuntime.close();
		await expect(
			server.schedulerRegistry.track("session-cleanup", () => server.prisma.user.count()),
		).rejects.toThrow();
		const restarted = create();
		await restarted.ready();
		expect(restarted.installationId).toBe(installationId);
		expect(readFileSync(secretFile).equals(secrets)).toBe(true);
		expect(
			(await fixture.query('SELECT "runtimeEpoch" FROM "RestoreRuntimeControl"')).rows[0]
				.runtimeEpoch,
		).not.toBe(previousEpoch);
		expect(
			(await restarted.inject({ method: "GET", url: "/auth/me", cookies: { arr_session: cookie } }))
				.statusCode,
		).toBe(200);
		await restarted.restoreRuntime.runOperation(async () => {
			expect(await restarted.prisma.user.count()).toBe(1);
			expect(await restarted.prisma.session.count()).toBe(1);
			expect(await restarted.prisma.serviceInstance.count()).toBe(1);
		});
	}, 30000);
	it.each(["ordinary-close", "owner-loss"] as const)(
		"actual scheduler transaction joins shutdown and fences prospective publication: %s",
		async (mode) => {
			const server = create();
			await server.ready();
			let release!: () => void, entered!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const ready = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const operation = server.schedulerRegistry.track("session-cleanup", () =>
				server.prisma.$transaction(async (tx) => {
					await tx.user.create({ data: { username: "fixture-pg-first" } });
					entered();
					await gate;
					await tx.user.create({ data: { username: "fixture-pg-second" } });
				}),
			);
			// Observe rejection immediately so the owner-loss callback cannot produce an unhandled rejection.
			const observed = operation.then(
				() => "completed" as const,
				() => "fenced" as const,
			);
			let contender: Awaited<ReturnType<typeof acquirePostgresRestoreRuntimeOwnership>> | undefined;
			try {
				await ready;
				if (mode === "owner-loss") {
					await terminateOwner();
					contender = await acquirePostgresRestoreRuntimeOwnership(url);
					expect(await contender.tryAcquireExclusive()).toBe(false);
				}
				let closed = false;
				const closing = server.restoreRuntime.close().then(() => {
					closed = true;
				});
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(closed).toBe(false);
				release();
				expect(await observed).toBe(mode === "owner-loss" ? "fenced" : "completed");
				await closing;
				expect(await countUsers()).toBe(mode === "owner-loss" ? 0 : 2);
				contender ??= await acquirePostgresRestoreRuntimeOwnership(url);
				expect(await contender.tryAcquireExclusive()).toBe(true);
			} finally {
				release();
				await observed;
				await contender?.close();
			}
		},
		30000,
	);
	it.each(["ordinary-close", "owner-loss", "owner-loss-after-idle-retirement"] as const)(
		"actual early-response HTTP handler remains admitted until settlement: %s",
		async (mode) => {
			const server = create();
			let release!: () => void, entered!: () => void, finished!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const ready = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const settled = new Promise<void>((resolve) => {
				finished = resolve;
			});
			let outcome = "pending";
			let ordinaryPid: number | undefined;
			server.register(async (scope) => {
				scope.get("/fixture-pg-handler", async (_request, reply) => {
					if (mode === "owner-loss-after-idle-retirement") {
						const [backend] = await scope.prisma.$queryRaw<
							{ pid: number }[]
						>`SELECT pg_backend_pid() AS pid`;
						ordinaryPid = backend?.pid;
					} else {
						await scope.prisma.user.count();
					}
					entered();
					reply.send({ accepted: true });
					try {
						await gate;
						await scope.prisma.user.create({ data: { username: "fixture-pg-handler" } });
						outcome = "completed";
					} catch {
						outcome = "fenced";
					} finally {
						finished();
					}
				});
			});
			let contender: Awaited<ReturnType<typeof acquirePostgresRestoreRuntimeOwnership>> | undefined;
			try {
				if (mode === "owner-loss-after-idle-retirement") {
					await server.ready();
					await vi.waitFor(() => {
						expect(getRestoreRuntimeShutdownStatus(server.restoreRuntime).activeOperations).toBe(0);
					});
				}
				expect(
					(await server.inject({ method: "GET", url: "/fixture-pg-handler" })).statusCode,
				).toBe(200);
				await ready;
				if (mode === "owner-loss-after-idle-retirement") {
					// Ordinary idle pool retirement must not end the accepted handler's
					// database-visible exclusion before its actual promise settles.
					expect(Number.isInteger(ordinaryPid)).toBe(true);
					const participants = await participantPids();
					expect(participants).toHaveLength(1);
					const [participant] = participants;
					if (!participant) throw new Error("Missing handler operation participant");
					expect(participant.pid).not.toBe(ordinaryPid);
					const operationLocks = `
FROM pg_locks l
WHERE l.locktype = 'advisory' AND l.granted AND l.mode = 'ShareLock'
AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
AND l.classid = 1095914052::oid AND l.objid = 2::oid AND l.objsubid = 2`;
					const idleBackends = `
FROM pg_stat_activity a
WHERE a.datname = current_database() AND a.state = 'idle'
AND a.pid <> pg_backend_pid() AND a.pid <> $1
AND a.pid <> (SELECT "ownerBackendPid" FROM "RestoreRuntimeControl" WHERE id = 1)
AND a.pid IN (SELECT l.pid ${operationLocks})`;
					let idlePids: number[] = [];
					await vi.waitFor(
						async () => {
							const idle = await fixture.query(`SELECT a.pid ${idleBackends} ORDER BY a.pid`, [
								participant.pid,
							]);
							idlePids = idle.rows.map(({ pid }) => pid);
							expect(idlePids).toContain(ordinaryPid);
							const locks = await fixture.query(`SELECT l.pid ${operationLocks}`);
							expect(locks.rows.map(({ pid }) => pid).sort((a, b) => a - b)).toEqual(
								[participant.pid, ...idlePids].sort((a, b) => a - b),
							);
						},
						{ timeout: 5000, interval: 20 },
					);
					const retired = await fixture.query(
						`SELECT a.pid, pg_terminate_backend(a.pid, 2000) AS stopped
						 ${idleBackends} AND a.pid = ANY($2::int[]) ORDER BY a.pid`,
						[participant.pid, idlePids],
					);
					expect(retired.rows).toEqual(idlePids.map((pid) => ({ pid, stopped: true })));
					expect((await fixture.query(`SELECT l.pid ${operationLocks}`)).rows).toEqual(
						participants,
					);
				}
				if (mode !== "ordinary-close") {
					await terminateOwner();
					contender = await acquirePostgresRestoreRuntimeOwnership(url);
					expect(await contender.tryAcquireExclusive()).toBe(false);
				}
				let closed = false;
				const closing = server.restoreRuntime.close().then(() => {
					closed = true;
				});
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(closed).toBe(false);
				release();
				await settled;
				await closing;
				expect(outcome).toBe(mode === "ordinary-close" ? "completed" : "fenced");
				expect(await countUsers()).toBe(mode === "ordinary-close" ? 1 : 0);
				contender ??= await acquirePostgresRestoreRuntimeOwnership(url);
				expect(await contender.tryAcquireExclusive()).toBe(true);
			} finally {
				release();
				await contender?.close();
			}
		},
		30000,
	);
	it.each([
		[200, false],
		[400, false],
		[503, false],
		[200, true],
	] as const)(
		"actual encrypted queued notification joins close with honest outcome: %s revoked=%s",
		async (status, revoked) => {
			const server = create();
			await server.ready();
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let requests = 0;
			const endpoint = createServer(async (request, response) => {
				request.resume();
				if (request.method !== "POST" || request.url !== "/synthetic-notification") {
					response.writeHead(404).end();
					return;
				}
				requests++;
				await gate;
				response.writeHead(status).end();
			});
			await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
			const address = endpoint.address();
			if (!address || typeof address === "string") throw new Error("Fixture listener");
			const logicalUrl = "https://synthetic-notification.invalid/synthetic-notification";
			const physicalUrl = `http://127.0.0.1:${address.port}/synthetic-notification`;
			const actualFetch = globalThis.fetch;
			// Keep real stored-config validation and sender behavior; map only the
			// synthetic transport to the actual held HTTP endpoint, never a provider.
			const fetchMapping = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
				if (input !== logicalUrl || init?.method !== "POST")
					throw new Error("Unexpected synthetic notification request");
				return actualFetch(physicalUrl, init);
			});
			let notifying: Promise<void> | undefined;
			let closing: Promise<void> | undefined;
			try {
				const userId = await server.restoreRuntime.runOperation(async () => {
					const user = await server.prisma.user.create({ data: { username: "fixture-pg-digest" } });
					const config = server.encryptor.encrypt(JSON.stringify({ url: logicalUrl }));
					await server.prisma.notificationChannel.create({
						data: {
							id: "fixture-pg-digest",
							userId: user.id,
							name: "Synthetic",
							type: "WEBHOOK",
							encryptedConfig: config.value,
							configIv: config.iv,
							subscriptions: { create: { eventType: "HUNT_COMPLETED" } },
						},
					});
					await server.prisma.notificationAggregationConfig.create({
						data: {
							userId: user.id,
							eventType: "HUNT_COMPLETED",
							enabled: true,
							windowSeconds: 60,
							maxBatchSize: 2,
						},
					});
					return user.id;
				});
				await server.restoreRuntime.runOperation(() =>
					server.notificationService.notify(
						{ eventType: "HUNT_COMPLETED", title: "Synthetic", body: "Synthetic" },
						{ userId },
					),
				);
				expect(requests).toBe(0);
				const accepted = await server.restoreRuntime.runOperation(() =>
					server.prisma.notificationOutboxEvent.findFirstOrThrow({
						where: { userId, stage: "aggregating" },
						select: { id: true, dueAt: true },
					}),
				);
				if (!revoked) {
					// Dispatch eligibility comes from a full batch, never from closing the app.
					// notify retains the real send lifetime while this loopback response is held.
					notifying = server.restoreRuntime.runOperation(() =>
						server.notificationService.notify(
							{ eventType: "HUNT_COMPLETED", title: "Synthetic second", body: "Synthetic" },
							{ userId },
						),
					);
					await vi.waitFor(() => expect(requests).toBe(1), { timeout: 2000, interval: 10 });
				}
				if (revoked)
					await server.restoreRuntime.runOperation(() =>
						server.prisma.notificationChannel.update({
							where: { id: "fixture-pg-digest" },
							data: { enabled: false },
						}),
					);
				let closed = false;
				closing = server.close().then(() => {
					closed = true;
				});
				if (!revoked) {
					await vi.waitFor(() => expect(requests).toBe(1), { timeout: 2000, interval: 10 });
					expect(closed).toBe(false);
					await expect(acquirePostgresRestoreRuntimeOwnership(url)).rejects.toThrow();
				}
				release();
				await notifying;
				await closing;
				await server.restoreRuntime.close();
				const logs = (
					await fixture.query(
						'SELECT status FROM notification_logs WHERE "channelId"=$1 ORDER BY status',
						["fixture-pg-digest"],
					)
				).rows;
				expect(logs.map((row) => row.status)).toEqual(
					revoked ? [] : status === 200 ? ["sent"] : ["failed"],
				);
				const events = (
					await fixture.query(
						'SELECT id, stage, "dueAt", "aggregateParentId" FROM "NotificationOutboxEvent" WHERE "userId"=$1',
						[userId],
					)
				).rows;
				const deliveries = (
					await fixture.query(
						'SELECT "eventId", state, "attemptOrdinal", "nextAttemptAt" FROM "NotificationOutboxDelivery" WHERE "userId"=$1',
						[userId],
					)
				).rows;
				if (revoked) {
					// Future work retains the exact accepted identity/deadline and no fake attempt.
					expect(events).toEqual([
						{
							id: accepted.id,
							stage: "aggregating",
							dueAt: accepted.dueAt,
							aggregateParentId: null,
						},
					]);
					expect(deliveries).toEqual([
						{
							eventId: accepted.id,
							state: "waiting",
							attemptOrdinal: 0,
							nextAttemptAt: accepted.dueAt,
						},
					]);
				} else {
					expect(events).toHaveLength(3);
					const digest = events.filter((event) => event.stage !== "grouped");
					expect(digest).toHaveLength(1);
					expect(digest[0].stage).toBe(status === 503 ? "ready" : "terminal");
					expect(
						events
							.filter((event) => event.stage === "grouped")
							.map((event) => event.aggregateParentId),
					).toEqual([digest[0].id, digest[0].id]);
					expect(deliveries).toHaveLength(3);
					const attempted = deliveries.filter((delivery) => delivery.eventId === digest[0].id);
					expect(attempted).toHaveLength(1);
					expect(attempted[0]).toMatchObject({
						state: status === 200 ? "sent" : status === 503 ? "retry-waiting" : "rejected",
						attemptOrdinal: status === 503 ? 1 : 0,
					});
					expect(
						deliveries
							.filter((delivery) => delivery.eventId !== digest[0].id)
							.map((delivery) => delivery.state),
					).toEqual(["canceled", "canceled"]);
					if (status === 503) {
						const failed = (
							await fixture.query(
								'SELECT "sentAt" FROM notification_logs WHERE "channelId"=$1 AND status=\'failed\'',
								["fixture-pg-digest"],
							)
						).rows[0];
						expect(attempted[0].nextAttemptAt.getTime() - failed.sentAt.getTime()).toBe(30_000);
						expect(attempted[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
					}
				}
				expect(
					(
						await fixture.query('SELECT "lastSendResult" FROM notification_channels WHERE id=$1', [
							"fixture-pg-digest",
						])
					).rows,
				).toEqual([{ lastSendResult: revoked ? null : status === 200 ? "success" : "failed" }]);
				expect(requests).toBe(revoked ? 0 : 1);
				const successor = await acquirePostgresRestoreRuntimeOwnership(url);
				try {
					expect(await successor.tryAcquireExclusive()).toBe(true);
				} finally {
					await successor.close();
				}
			} finally {
				release();
				await Promise.allSettled([notifying, closing].filter((work) => work !== undefined));
				endpoint.closeAllConnections();
				await new Promise<void>((resolve) => endpoint.close(() => resolve()));
				fetchMapping.mockRestore();
			}
		},
		30000,
	);
});
