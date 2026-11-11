import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRestoreRuntimeClientContext } from "../../lib/backup/restore-runtime-admission.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import * as runtimePrisma from "../../lib/backup/restore-runtime-client.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { resolveSecretsPath } from "../../lib/utils/secrets-path.js";
import { registerSessionValidationHook } from "../../server.js";
import lifecyclePlugin from "../lifecycle.js";
import { securityPlugin } from "../security.js";

// Only persistent secrets-file I/O is synthetic. Native SQL, signed cookies,
// Encryptor, security/lifecycle and exported session validation remain real.
// Secrets-file persistence is UNTESTED; no existing file is read or written.
const boundary = vi.hoisted(() => ({ path: "", scope: "", constructors: 0 }));
vi.mock("../../lib/auth/secret-manager.js", () => ({
	SecretManager: class {
		readonly installationIdIsPersistent = true;
		readonly secretsSynchronized = true;
		constructor(path: string) {
			if (path !== boundary.path) throw new Error("Unexpected owned secrets path");
			boundary.constructors++;
		}
		getOrCreateEnvironmentSecrets(
			overrides: { encryptionKey: string; sessionCookieSecret: string },
			scope: string,
		) {
			if (
				scope !== boundary.scope ||
				overrides.encryptionKey !== "9".repeat(64) ||
				overrides.sessionCookieSecret !== "synthetic-only-cookie-signing-secret-32bytes"
			)
				throw new Error("Unexpected synthetic secret scope");
			return { ...overrides, installationId: "synthetic-notification-outbox-destination" };
		}
	},
}));
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((release) => {
		resolve = release;
	});
	return { promise, resolve };
}
async function settle() {
	await new Promise<void>((done) => setImmediate(done));
}
async function waitForNative(observe: () => boolean) {
	const deadline = performance.now() + 4000;
	while (!observe()) {
		if (performance.now() >= deadline) return false;
		await settle();
	}
	return true;
}
type Native = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;
const apps: FastifyInstance[] = [],
	releases: Array<() => void> = [];
const fixtures = new Map<Native, { owners: string[]; ids: string[]; reopened: boolean }>();
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(apps.splice(0).map((app) => app.close()));
	vi.restoreAllMocks();
	for (const [native, owned] of fixtures) {
		await native.runtime.drain();
		if (!owned.reopened) {
			await native.restart();
			owned.reopened = true;
		}
		await native.run(async () => {
			const where = { id: { in: owned.ids }, userId: { in: owned.owners } };
			const count = await native.prisma.session.count({ where });
			expect((await native.prisma.session.deleteMany({ where })).count).toBe(count);
			expect(await native.prisma.session.count({ where })).toBe(0);
			expect(
				(await native.prisma.user.deleteMany({ where: { id: { in: owned.owners } } })).count,
			).toBe(2);
			expect(await native.prisma.user.count({ where: { id: { in: owned.owners } } })).toBe(0);
		});
		await native.close();
	}
	fixtures.clear();
});
type Phase = "lookup" | "metadata" | "expiry";
type FixtureOptions = {
	lookup?: Promise<void>;
	metadata?: Array<Promise<void>>;
	expiry?: Promise<void>;
	beforeValidation?: Promise<void>;
	reject?: Phase;
	record?: "valid" | "expired" | "missing";
	journal?: "DELETE" | "WAL";
	beforeMetadata?: (db: Database.Database) => void;
};
async function boot(options: FixtureOptions = {}) {
	const native = await createNotificationOutboxNativeFixture(),
		siblingOwner = await native.createOwner();
	const token = "synthetic-only-session-token",
		hash = createHash("sha256").update(token).digest("hex"),
		siblingHash = createHash("sha256").update("synthetic-sibling-session-token").digest("hex");
	const owned = {
		owners: [native.userId, siblingOwner.userId],
		ids: [hash, siblingHash],
		reopened: false,
	};
	fixtures.set(native, owned);
	const expiresAt =
		options.record === "expired" ? new Date(0) : new Date(Date.now() + 24 * 60 * 60 * 1000);
	const siblingData = {
		id: siblingHash,
		userId: siblingOwner.userId,
		expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
		lastAccessedAt: new Date(0),
		userAgent: "synthetic-sibling",
		ipAddress: "127.0.0.2",
	};
	await native.run(async () => {
		if (options.record !== "missing")
			await native.prisma.session.create({
				data: { id: hash, userId: native.userId, expiresAt, lastAccessedAt: new Date(0) },
			});
		await native.prisma.session.create({ data: siblingData });
	});
	await native.restart(false);
	const databaseUrl = getRestoreRuntimeClientContext(native.runtime).databaseUrl;
	if (options.journal) {
		const db = new Database(databaseUrl.slice(5), { fileMustExist: true });
		db.pragma(`journal_mode=${options.journal}`);
		db.close();
	}
	boundary.path = resolveSecretsPath(databaseUrl);
	boundary.scope = `${databaseUrl}\0http://synthetic.invalid`;
	boundary.constructors = 0;
	const client = createRuntimePrismaClient(native.runtime),
		prisma = client.prisma;
	const started = { lookup: deferred(), metadata: deferred(), expiry: deferred() },
		entered = { lookup: false, metadata: false, expiry: false },
		closing = deferred(),
		socketClosed = deferred(),
		beforeValidationStarted = deferred();
	const state = {
		calls: { lookup: 0, metadata: 0, expiry: 0 },
		pending: 0,
		queriesAfterTeardown: 0,
		teardownCount: 0,
		pendingAtTeardown: -1,
		handlerCount: 0,
		metadataTimeouts: [] as number[],
		metadataOpenBeforeRuntimeClose: -1,
	};
	const metadataConnections = new Set<Database.Database>();
	async function query<T>(
		phase: Phase,
		gate: Promise<void> | undefined,
		operation: () => PromiseLike<T>,
	) {
		if (state.teardownCount > 0) state.queriesAfterTeardown++;
		state.calls[phase]++;
		state.pending++;
		entered[phase] = true;
		started[phase].resolve();
		try {
			await gate;
			if (options.reject === phase) throw new Error("Synthetic session database failure");
			return await operation();
		} finally {
			state.pending--;
		}
	}
	const instrumentedReads = new WeakSet<object>();
	function instrumentLookup(client: typeof prisma) {
		const reads: { $queryRaw: AwaitOnly<typeof prisma.$queryRaw> } = client;
		if (instrumentedReads.has(reads)) return;
		instrumentedReads.add(reads);
		const lookup = client.$queryRaw.bind(client);
		vi.spyOn(reads, "$queryRaw").mockImplementation((...args) => {
			expect(args).toHaveLength(2);
			expect(args[1]).toBe(hash);
			return query("lookup", options.lookup, () => lookup(...args));
		});
	}
	instrumentLookup(prisma);
	// Preserve real guarded acquisition and SQL; observe the delegate actually
	// used for validation so lookup abort/drain gates cover isolated readers too.
	const isolatedRead = runtimePrisma.withIsolatedRuntimePrismaReadClient;
	vi.spyOn(runtimePrisma, "withIsolatedRuntimePrismaReadClient").mockImplementation(
		(client, operation) =>
			isolatedRead(client, (reader) => {
				instrumentLookup(reader);
				return operation(reader);
			}),
	);
	if (native.engine === "sqlite") {
		const connect = PrismaBetterSqlite3.prototype.connect;
		vi.spyOn(PrismaBetterSqlite3.prototype, "connect").mockImplementation(async function (
			this: PrismaBetterSqlite3,
		) {
			const driver = await connect.call(this);
			const db = Reflect.get(driver, "client") as Database.Database;
			const queryRaw = driver.queryRaw.bind(driver);
			vi.spyOn(driver, "queryRaw").mockImplementation((statement) => {
				if (/^\s*UPDATE\b/i.test(statement.sql) && statement.sql.includes("sessions")) {
					expect(statement.args).toContain(hash);
					metadataConnections.add(db);
					state.metadataTimeouts.push(Number(db.pragma("busy_timeout", { simple: true })));
					options.beforeMetadata?.(db);
					return query("metadata", options.metadata?.[state.calls.metadata], () =>
						queryRaw(statement),
					);
				}
				return queryRaw(statement);
			});
			return driver;
		});
	} else {
		const update = prisma.session.update.bind(prisma.session);
		const writes: { update: AwaitOnly<typeof prisma.session.update> } = prisma.session;
		vi.spyOn(writes, "update").mockImplementation((args) => {
			expect(args).toEqual({ where: { id: hash }, data: { lastAccessedAt: expect.any(Date) } });
			return query("metadata", options.metadata?.[state.calls.metadata], () => update(args));
		});
	}
	const remove = prisma.session.delete.bind(prisma.session);
	const deletes: { delete: AwaitOnly<typeof prisma.session.delete> } = prisma.session;
	vi.spyOn(deletes, "delete").mockImplementation((args) => {
		expect(args).toEqual({ where: { id: hash } });
		return query("expiry", options.expiry, () => remove(args));
	});
	const app = Fastify({ logger: false });
	apps.push(app);
	app.decorate("config", {
		DATABASE_URL: databaseUrl,
		APP_URL: "http://synthetic.invalid",
		ENCRYPTION_KEY: "9".repeat(64),
		SESSION_COOKIE_SECRET: "synthetic-only-cookie-signing-secret-32bytes",
		SESSION_COOKIE_NAME: "fixture_session",
		SESSION_TTL_HOURS: 24,
		COOKIE_SECURE: false,
		TRUST_PROXY: false,
	} as never);
	await app.register(
		fp(
			async (server) => {
				server.decorate("prisma", prisma);
				server.decorate("restoreRuntime", native.runtime);
				server.decorate("dbProvider", native.engine as "sqlite" | "postgresql");
				server.addHook("preClose", async () => native.runtime.closeAdmission());
				server.addHook("onClose", async () => {
					await native.runtime.drain();
					state.pendingAtTeardown = state.pending;
					await client.close();
					state.metadataOpenBeforeRuntimeClose = [...metadataConnections].filter(
						(db) => db.open,
					).length;
					await native.runtime.close();
					state.teardownCount++;
				});
			},
			{ name: "prisma" },
		),
	);
	registerRestoreBootstrapPlugin(app, securityPlugin);
	registerRestoreBootstrapPlugin(app, lifecyclePlugin);
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);
	app.addHook("preHandler", async (request) => {
		request.raw.socket.once("close", socketClosed.resolve);
		beforeValidationStarted.resolve();
		await options.beforeValidation;
	});
	registerSessionValidationHook(app);
	await app.register(async (scope) => {
		scope.addHook("preHandler", async (request, reply) => {
			if (!request.currentUser?.id) return reply.status(401).send({ error: "Unauthenticated" });
		});
		scope.get("/synthetic", async (request) => {
			expect(request.currentUser!.id).toBe(native.userId);
			expect(request.sessionToken).toBe(token);
			state.handlerCount++;
			return { authenticated: true };
		});
	});
	app.addHook("preClose", async () => closing.resolve());
	registerRestoreRuntimeActivation(app);
	await app.ready();
	expect(boundary.constructors).toBe(1);
	expect(app.installationId).toBe("synthetic-notification-outbox-destination");
	const cipher = native.encryptor.encrypt("synthetic-key-parity");
	expect(app.encryptor.decrypt(cipher)).toBe("synthetic-key-parity");
	const assertPersisted = async (expected: { metadata: boolean; deleted?: boolean }) => {
		expect(state.teardownCount).toBe(1);
		expect(state.pendingAtTeardown).toBe(0);
		expect(state.pending).toBe(0);
		expect(state.queriesAfterTeardown).toBe(0);
		if (native.engine === "sqlite") {
			expect(state.metadataOpenBeforeRuntimeClose).toBe(0);
			expect(state.metadataTimeouts).toEqual(Array(state.calls.metadata).fill(0));
		}
		// Old app/validation/client/runtime have joined. Reopen ONLY the same owned
		// observer normally, for observation and scoped disposal, never auth replay.
		if (!owned.reopened) {
			await native.restart();
			owned.reopened = true;
		}
		const [primary, sibling] = await native.run(() =>
			Promise.all([
				native.prisma.session.findUnique({ where: { id: hash } }),
				native.prisma.session.findUnique({ where: { id: siblingHash } }),
			]),
		);
		expect(sibling).toMatchObject(siblingData);
		if (expected.deleted || options.record === "missing") expect(primary).toBeNull();
		else {
			expect(primary).toMatchObject({
				id: hash,
				userId: native.userId,
				expiresAt,
				userAgent: null,
				ipAddress: null,
			});
			if (expected.metadata) expect(primary!.lastAccessedAt.getTime()).toBeGreaterThan(0);
			else expect(primary!.lastAccessedAt).toEqual(new Date(0));
		}
	};
	return {
		app,
		state,
		started,
		closing: closing.promise,
		socketClosed: socketClosed.promise,
		beforeValidationStarted: beforeValidationStarted.promise,
		cookie: `fixture_session=${encodeURIComponent(app.signCookie(token))}`,
		assertPersisted,
		waitForPhase: (phase: Phase) => waitForNative(() => entered[phase]),
		checkpoint: async () => {
			expect(state.pending).toBeGreaterThan(0);
			await settle();
		},
	};
}

async function abortDuringValidation(fixture: Awaited<ReturnType<typeof boot>>, phase: Phase) {
	const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
	const request = httpRequest(`${address}/synthetic`, {
		agent: false,
		headers: { cookie: fixture.cookie },
	});
	const clientClosed = new Promise<void>((done) => request.once("close", done));
	request.on("error", () => undefined); // Expected abort; never print raw request data.
	request.end();
	await fixture.started[phase].promise;
	request.destroy();
	await fixture.socketClosed;
	await clientClosed;
}

describe("session validation shutdown", () => {
	// Break caught: even a fire-and-forget metadata UPDATE can block the API
	// reactor when the synchronous native driver waits for a concurrent writer.
	it
		.skipIf(process.env.NOTIFICATION_OUTBOX_TEST_ENGINE === "postgresql")
		.each(["DELETE", "WAL"] as const)(
		"keeps valid authentication responsive during %s metadata write contention",
		async (journal) => {
			let writer: Database.Database | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let delay = 0;
			let busyTimeout = -1;
			let armed = false;
			const released = deferred();
			const release = () => {
				if (writer?.inTransaction) writer.exec("ROLLBACK");
				released.resolve();
			};
			releases.push(release);
			const fixture = await boot({
				journal,
				beforeMetadata: (db) => {
					if (!armed) {
						armed = true;
						busyTimeout = Number(db.pragma("busy_timeout", { simple: true }));
						writer = new Database(db.name, { fileMustExist: true, timeout: 0 });
						writer.exec("BEGIN IMMEDIATE");
						const start = performance.now();
						timer = setTimeout(() => {
							delay = performance.now() - start;
							release();
						}, 50);
					}
				},
			});
			try {
				const response = await fixture.app.inject({
					url: "/synthetic",
					headers: { cookie: fixture.cookie },
				});
				await released.promise;
				await fixture.app.close();
				expect(response.statusCode).toBe(200);
				expect(armed).toBe(true);
				expect(delay).toBeLessThan(500);
				expect(busyTimeout).toBe(0);
				await fixture.assertPersisted({ metadata: false });
				if (process.env.OBSERVATIONS)
					appendFileSync(
						process.env.OBSERVATIONS,
						`${JSON.stringify({ journal, releaseDelayMs: Math.round(delay), busyTimeoutMs: busyTimeout, status: response.statusCode, metadataOpenBeforeRuntimeClose: fixture.state.metadataOpenBeforeRuntimeClose })}\n`,
						{ mode: 0o600 },
					);
			} finally {
				if (timer) clearTimeout(timer);
				release();
				writer?.close();
			}
		},
	);

	it.each([false, true])(
		"keeps valid authentication nonblocking, but drains its metadata update (reject=%s)",
		async (reject) => {
			const metadata = deferred();
			releases.push(metadata.resolve);
			const fixture = await boot({
				metadata: [metadata.promise],
				...(reject ? { reject: "metadata" as const } : {}),
			});
			const response = await fixture.app.inject({
				url: "/synthetic",
				headers: { cookie: fixture.cookie },
			});
			expect(response.statusCode).toBe(200);
			expect(fixture.state.handlerCount).toBe(1);
			expect(await fixture.waitForPhase("metadata")).toBe(true);
			expect(fixture.state.pending).toBe(1);
			const close = fixture.app.close();
			try {
				await fixture.closing;
				await fixture.checkpoint();
				expect(fixture.state.teardownCount).toBe(0);
			} finally {
				metadata.resolve();
				await close;
			}
			expect(fixture.state.pendingAtTeardown).toBe(0);
			expect(fixture.state.queriesAfterTeardown).toBe(0);
			await fixture.assertPersisted({ metadata: !reject });
		},
	);

	it("drains disconnected validation and metadata work created after shutdown started", async () => {
		const lookup = deferred();
		const metadata = deferred();
		releases.push(lookup.resolve, metadata.resolve);
		const fixture = await boot({ lookup: lookup.promise, metadata: [metadata.promise] });
		await abortDuringValidation(fixture, "lookup");
		const close = fixture.app.close();
		try {
			await fixture.closing;
			await fixture.checkpoint();
			expect(fixture.state.teardownCount).toBe(0);
			lookup.resolve();
			expect({
				entered: await fixture.waitForPhase("metadata"),
				calls: fixture.state.calls,
				pending: fixture.state.pending,
			}).toMatchObject({ entered: true, calls: { lookup: 1, metadata: 1, expiry: 0 }, pending: 1 });
			await fixture.checkpoint();
			expect(fixture.state.teardownCount).toBe(0);
			expect(fixture.state.handlerCount).toBe(0);
		} finally {
			lookup.resolve();
			metadata.resolve();
			await close;
		}
		expect(fixture.state.pendingAtTeardown).toBe(0);
		expect(fixture.state.queriesAfterTeardown).toBe(0);
		await fixture.assertPersisted({ metadata: true });
	});

	it("waits for a disconnected validation query that eventually rejects", async () => {
		const lookup = deferred();
		releases.push(lookup.resolve);
		const fixture = await boot({ lookup: lookup.promise, reject: "lookup" });
		await abortDuringValidation(fixture, "lookup");
		const close = fixture.app.close();
		try {
			await fixture.closing;
			await fixture.checkpoint();
			expect(fixture.state.teardownCount).toBe(0);
		} finally {
			lookup.resolve();
			await close;
		}
		expect(fixture.state.pendingAtTeardown).toBe(0);
		expect(fixture.state.calls.metadata).toBe(0);
		await fixture.assertPersisted({ metadata: false });
	});

	it.each([false, true])(
		"drains best-effort expired-session cleanup (reject=%s)",
		async (reject) => {
			const expiry = deferred();
			releases.push(expiry.resolve);
			const fixture = await boot({
				record: "expired",
				expiry: expiry.promise,
				...(reject ? { reject: "expiry" as const } : {}),
			});
			await abortDuringValidation(fixture, "expiry");
			const close = fixture.app.close();
			try {
				await fixture.closing;
				await fixture.checkpoint();
				expect(fixture.state.teardownCount).toBe(0);
			} finally {
				expiry.resolve();
				await close;
			}
			expect(fixture.state.pendingAtTeardown).toBe(0);
			expect(fixture.state.calls.metadata).toBe(0);
			expect(fixture.state.handlerCount).toBe(0);
			await fixture.assertPersisted({ metadata: false, deleted: !reject });
		},
	);

	it("returns unavailable, not logged out, when validation begins after closing admission", async () => {
		const releaseHook = deferred();
		releases.push(releaseHook.resolve);
		const fixture = await boot({ beforeValidation: releaseHook.promise });
		const response = fixture.app.inject({ url: "/synthetic", headers: { cookie: fixture.cookie } });
		await fixture.beforeValidationStarted;
		const close = fixture.app.close();
		await fixture.closing;
		releaseHook.resolve();
		const unavailable = await response;
		expect(unavailable.statusCode).toBe(503);
		expect(unavailable.headers["set-cookie"]).toBeUndefined();
		await close;
		expect(fixture.state.calls.lookup).toBe(0);
		expect(fixture.state.calls.metadata).toBe(0);
		expect(fixture.state.handlerCount).toBe(0);
		await fixture.assertPersisted({ metadata: false });
	});

	it("drains both concurrent metadata updates across duplicate closes", async () => {
		const first = deferred();
		const second = deferred();
		releases.push(first.resolve, second.resolve);
		const fixture = await boot({ metadata: [first.promise, second.promise] });
		const responses = await Promise.all([
			fixture.app.inject({ url: "/synthetic", headers: { cookie: fixture.cookie } }),
			fixture.app.inject({ url: "/synthetic", headers: { cookie: fixture.cookie } }),
		]);
		expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
		expect(await waitForNative(() => fixture.state.pending === 2)).toBe(true);
		expect(fixture.state.pending).toBe(2);
		const close = fixture.app.close();
		const duplicateClose = fixture.app.close();
		try {
			await fixture.closing;
			first.resolve();
			expect(await waitForNative(() => fixture.state.pending === 1)).toBe(true);
			await fixture.checkpoint();
			expect(fixture.state.teardownCount).toBe(0);
			expect(fixture.state.pending).toBe(1);
		} finally {
			first.resolve();
			second.resolve();
			await Promise.all([close, duplicateClose]);
		}
		expect(fixture.state.teardownCount).toBe(1);
		expect(fixture.state.pendingAtTeardown).toBe(0);
		await fixture.assertPersisted({ metadata: true });
	});

	it.each(["absent", "tampered", "unknown"] as const)(
		"retains normal rejection of an %s cookie and settles shutdown",
		async (kind) => {
			const fixture = await boot({ ...(kind === "unknown" ? { record: "missing" as const } : {}) });
			const response = await fixture.app.inject({
				url: "/synthetic",
				headers:
					kind === "absent"
						? {}
						: { cookie: kind === "tampered" ? "fixture_session=invalid" : fixture.cookie },
			});
			expect(response.statusCode).toBe(401);
			await fixture.app.close();
			expect(fixture.state.calls.lookup).toBe(kind === "unknown" ? 1 : 0);
			expect(fixture.state.calls.metadata).toBe(0);
			expect(fixture.state.pendingAtTeardown).toBe(0);
			await fixture.assertPersisted({ metadata: false });
		},
	);
});
