import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../../../config/env.js";
import { PrismaClient } from "../../../generated/prisma/client.js";
import {
	loadRuntimeSchemaRegistry,
	prepareRuntimeSchemaExecution,
} from "../../backup/runtime-schema-registry.js";
import { synchronizeSqliteRuntimeSchema } from "../../backup/runtime-schema-sqlite.js";
import { createRecoverableSqliteAdapter } from "../../sqlite-adapter.js";
import { SessionService } from "../session.js";

const NOW = new Date("2030-01-01T00:00:00.123Z");
const FUTURE = new Date("2030-01-02T00:00:00.123Z");
const OWNER = "session-date-owner";
const OTHER = "session-date-other";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const fixtures: Array<{
	directory: string;
	prisma: PrismaClient;
	services: SessionService[];
}> = [];
const env = {
	SESSION_COOKIE_NAME: "fixture_session",
	SESSION_TTL_HOURS: 24,
	COOKIE_SECURE: false,
	TRUST_PROXY: false,
} as ApiEnv;

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await Promise.all(fixture.services.map((service) => service.drainValidations()));
		await fixture.prisma.$disconnect();
		expect(fixture.directory.startsWith(join(tmpdir(), "arr-session-date-"))).toBe(true);
		expect(lstatSync(fixture.directory).isSymbolicLink()).toBe(false);
		rmSync(fixture.directory, { recursive: true });
	}
	vi.useRealTimers();
});

// Only the signed-cookie boundary is synthetic; hashing, Prisma, native startup,
// expiration, transactions and background metadata writes are the real consumers.
function request(token: string): FastifyRequest {
	return {
		cookies: { fixture_session: "synthetic-signed-cookie" },
		unsignCookie: () => ({ valid: true, renew: false, value: token }),
	} as unknown as FastifyRequest;
}

async function createFixture(adopt = true) {
	const directory = mkdtempSync(join(tmpdir(), "arr-session-date-"));
	const path = join(directory, "sessions.db");
	const db = new Database(path);
	try {
		db.pragma("foreign_keys=ON");
		db.pragma("journal_mode=WAL");
		db.exec("BEGIN EXCLUSIVE");
		await prepareRuntimeSchemaExecution(loadRuntimeSchemaRegistry("sqlite"), {
			provider: "sqlite",
			tables: [],
		}).execute((sql) => {
			db.exec(sql);
		});
		db.exec("DROP TABLE ArrSchemaMigrationReceipt; DROP TABLE ArrRuntimeDataFormatReceipt;");
		const user = db.prepare(
			"INSERT INTO User(id,username,hashedPassword,createdAt,updatedAt) VALUES(?,?,?,0,0)",
		);
		for (const id of [OWNER, OTHER]) user.run(id, id, "opaque-password-fixture");
		const session = db.prepare(
			"INSERT INTO sessions(id,userId,expiresAt,createdAt,lastAccessedAt,userAgent,ipAddress) VALUES(?,?,?,0,'2020-01-01 00:00:00',?,?)",
		);
		for (const [token, expiry] of [
			["future-numeric", FUTURE.getTime()],
			["future-offset", "2030-01-02T03:00:00.123+03:00"],
			["expired-numeric", NOW.getTime() - 1],
			["expired-text", "2020-01-01 00:00:00"],
			["equal", NOW.getTime()],
		] as const) {
			session.run(hash(token), OWNER, expiry, "opaque-agent", "opaque-address");
		}
		db.exec("COMMIT");
	} finally {
		db.close();
	}
	if (adopt) await synchronizeSqliteRuntimeSchema(`file:${path}`);
	const statements: string[] = [];
	const prisma = new PrismaClient({
		log: [{ emit: "event", level: "query" }],
		adapter: createRecoverableSqliteAdapter({ url: path, timeout: 5_000 }),
	});
	prisma.$on("query", (event) => statements.push(event.query));
	const service = new SessionService(prisma, env);
	const fixture = { directory, prisma, services: [service] };
	fixtures.push(fixture);
	await prisma.$connect();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	return { ...fixture, service, path, statements };
}

describe("real SessionService after native SQLite date admission", () => {
	it("loads the complete session and principal with one committed SELECT", async () => {
		const { service, prisma, statements } = await createFixture();
		await prisma.user.update({ where: { id: OWNER }, data: { mustChangePassword: true } });
		const expected = await prisma.session.findUnique({
			where: { id: hash("future-offset") },
			include: {
				user: {
					select: {
						id: true,
						username: true,
						mustChangePassword: true,
						createdAt: true,
						updatedAt: true,
					},
				},
			},
		});
		statements.length = 0;
		const result = await service.validateRequest(request("future-offset"));
		await service.drainValidations();
		expect(result?.session).toEqual(expected);
		expect(result?.session.user).toEqual({
			id: OWNER,
			username: OWNER,
			mustChangePassword: true,
			createdAt: new Date(0),
			updatedAt: NOW,
		});
		expect(result?.session.expiresAt).toEqual(FUTURE);
		expect(result?.session.createdAt).toEqual(new Date(0));
		expect(result?.session.lastAccessedAt).toEqual(new Date("2020-01-01T00:00:00Z"));
		const reads = statements.filter((sql) => /^\s*SELECT\b/i.test(sql));
		expect(reads).toHaveLength(1);
	});

	it("rereads principal changes and rejects a subsequently revoked or expired session", async () => {
		const { service, prisma } = await createFixture();
		expect(
			(await service.validateRequest(request("future-numeric")))?.session.user.mustChangePassword,
		).toBe(false);
		await prisma.user.update({ where: { id: OWNER }, data: { mustChangePassword: true } });
		expect(
			(await service.validateRequest(request("future-numeric")))?.session.user.mustChangePassword,
		).toBe(true);
		await prisma.session.update({
			where: { id: hash("future-numeric") },
			data: { expiresAt: NOW },
		});
		expect(await service.validateRequest(request("future-numeric"))).toBeNull();
		await prisma.session.delete({ where: { id: hash("future-offset") } });
		expect(await service.validateRequest(request("future-offset"))).toBeNull();
	});

	it("characterizes the unsafe mixed-format precursor without disabling actual cleanup", async () => {
		const { service, prisma } = await createFixture(false);
		// This is deliberately NOT an admitted application database. The actual
		// consumer demonstrates why normalization must precede startup cleanup.
		expect(await service.cleanupExpiredSessions()).toBe(4);
		expect(await prisma.session.findUnique({ where: { id: hash("future-numeric") } })).toBeNull();
	});

	it("preserves future instants and opaque fields while removing only genuinely expired sessions", async () => {
		const { service, prisma } = await createFixture();
		expect(await service.getSessionStats()).toEqual({ total: 5, expired: 2, active: 3 });
		expect(await service.cleanupExpiredSessions()).toBe(2);
		expect(await service.getSessionStats()).toEqual({ total: 3, expired: 0, active: 3 });
		const rows = await prisma.session.findMany({ orderBy: { id: "asc" } });
		expect(rows.map((row) => row.id).sort()).toEqual(
			["future-numeric", "future-offset", "equal"].map(hash).sort(),
		);
		for (const row of rows) {
			expect(row).toMatchObject({
				userId: OWNER,
				userAgent: "opaque-agent",
				ipAddress: "opaque-address",
				createdAt: new Date(0),
			});
			expect(row.expiresAt).toEqual(row.id === hash("equal") ? NOW : FUTURE);
		}
	});

	it("retains cleanup equality but rejects authentication at the exact expiration instant", async () => {
		const { service, prisma } = await createFixture();
		expect(await service.cleanupExpiredSessions()).toBe(2);
		expect(await prisma.session.findUnique({ where: { id: hash("equal") } })).not.toBeNull();
		expect(await service.validateRequest(request("equal"))).toBeNull();
		expect(await prisma.session.findUnique({ where: { id: hash("equal") } })).toBeNull();
		expect(await service.getSessionStats()).toEqual({ total: 2, expired: 0, active: 2 });
	});

	it("validates a converted future session and joins its real canonical metadata update", async () => {
		const { service, prisma } = await createFixture();
		const result = await service.validateRequest(request("future-numeric"));
		expect(result?.session.expiresAt).toEqual(FUTURE);
		await service.drainValidations();
		const row = await prisma.session.findUnique({ where: { id: hash("future-numeric") } });
		expect(row?.lastAccessedAt).toEqual(NOW);
		const dates = await prisma.$queryRawUnsafe<Array<{ access: string }>>(
			"SELECT CAST(lastAccessedAt AS TEXT) AS access FROM sessions WHERE id = ?",
			hash("future-numeric"),
		);
		expect(dates).toEqual([{ access: "2030-01-01T00:00:00.123+00:00" }]);
	});

	it("rotates a converted session once without extending expiry or crossing ownership", async () => {
		const { service, prisma } = await createFixture();
		expect(await service.rotateActiveSession("future-numeric", OTHER)).toBeNull();
		const replacement = await service.rotateActiveSession("future-numeric", OWNER);
		if (!replacement) throw new Error("expected rotation");
		expect(replacement.expiresAt).toEqual(FUTURE);
		expect(await service.rotateActiveSession("future-numeric", OWNER)).toBeNull();
		expect(await service.validateRequest(request("future-numeric"))).toBeNull();
		expect((await service.validateRequest(request(replacement.token)))?.session.userId).toBe(OWNER);
		expect(await prisma.session.count()).toBe(5);
	});

	it("revoke and exclude-current operations remain scoped to the actual owner", async () => {
		const { service, prisma } = await createFixture();
		const other = await service.createSession(OTHER);
		expect(await service.revokeSessionById(hash("future-numeric"), OTHER)).toBe(false);
		expect(await service.revokeSessionById(hash("future-offset"), OWNER)).toBe(true);
		await service.invalidateAllUserSessions(OWNER, "future-numeric");
		expect(await prisma.session.count({ where: { userId: OWNER } })).toBe(1);
		expect((await service.validateRequest(request(other.token)))?.session.userId).toBe(OTHER);
		await service.invalidateSession("future-numeric");
		expect(await service.validateRequest(request("future-numeric"))).toBeNull();
	});

	it("concurrent real cleanup is idempotent and never deletes future rows", async () => {
		const { service, prisma, services } = await createFixture();
		const peer = new SessionService(prisma, env);
		services.push(peer);
		const results = await Promise.all([
			service.cleanupExpiredSessions(),
			peer.cleanupExpiredSessions(),
		]);
		expect(results.reduce((sum, count) => sum + count, 0)).toBe(2);
		expect(await prisma.session.count()).toBe(3);
		expect(await service.cleanupExpiredSessions()).toBe(0);
	});
});
