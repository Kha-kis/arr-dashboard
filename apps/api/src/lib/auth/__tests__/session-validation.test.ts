/**
 * SessionService.validateRequest integration tests.
 *
 * Existing route tests bypass real session validation via setupAuthInjection,
 * so the actual cookie -> hash -> DB lookup -> expiry check pipeline has no
 * direct coverage. These tests exercise the full pipeline against an
 * in-memory Prisma stub, including the createSession round-trip so the
 * hashing contract between create and validate is locked in.
 */

import type { FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionService } from "../session.js";

const COOKIE_NAME = "arr_session";
const TTL_HOURS = 24;

function createEnv() {
	return {
		SESSION_COOKIE_NAME: COOKIE_NAME,
		SESSION_TTL_HOURS: TTL_HOURS,
		COOKIE_SECURE: false,
		TRUST_PROXY: false,
	} as never; // ApiEnv has many other fields irrelevant to SessionService
}

/**
 * In-memory Prisma stub matching the surface SessionService touches.
 * Stores sessions by hashed id and supports findUnique / create / delete /
 * deleteMany / update / count.
 */
function createPrismaStub() {
	const sessions = new Map<
		string,
		{
			id: string;
			userId: string;
			expiresAt: Date;
			createdAt: Date;
			lastAccessedAt: Date;
			userAgent: string | null;
			ipAddress: string | null;
			user: {
				id: string;
				username: string;
				mustChangePassword: boolean;
				createdAt: Date;
				updatedAt: Date;
			};
		}
	>();

	const prisma = {
		_sessions: sessions,
		session: {
			create: vi.fn(async ({ data }: any) => {
				const row = {
					id: data.id,
					userId: data.userId,
					expiresAt: data.expiresAt,
					createdAt: new Date(),
					lastAccessedAt: new Date(),
					userAgent: data.userAgent ?? null,
					ipAddress: data.ipAddress ?? null,
					user: {
						id: data.userId,
						username: "admin",
						mustChangePassword: false,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				};
				sessions.set(row.id, row);
				return row;
			}),
			findUnique: vi.fn(async ({ where }: any) => sessions.get(where.id) ?? null),
			delete: vi.fn(async ({ where }: any) => {
				const row = sessions.get(where.id);
				if (!row) {
					const err = new Error("not found");
					(err as any).code = "P2025";
					throw err;
				}
				sessions.delete(where.id);
				return row;
			}),
			deleteMany: vi.fn(async ({ where }: any) => {
				let count = 0;
				for (const [id, row] of sessions.entries()) {
					const matchesId =
						where?.id === undefined ||
						where.id === id ||
						(typeof where.id === "object" && where.id.not !== id);
					const matchesUser = where?.userId === undefined || where.userId === row.userId;
					const matchesExpiry =
						where?.expiresAt?.gt === undefined || row.expiresAt > where.expiresAt.gt;
					if (matchesId && matchesUser && matchesExpiry) {
						sessions.delete(id);
						count += 1;
					}
				}
				return { count };
			}),
			update: vi.fn(async ({ where, data }: any) => {
				const row = sessions.get(where.id);
				if (row) Object.assign(row, data);
				return row;
			}),
			count: vi.fn(async () => sessions.size),
		},
	};

	return {
		...prisma,
		$transaction: vi.fn(async (fn: (tx: typeof prisma) => unknown) => fn(prisma)),
	};
}

/**
 * Build a stub FastifyRequest that exposes only `cookies` + `unsignCookie`,
 * matching the @fastify/cookie contract. validateRequest treats unsigned
 * cookies as invalid.
 */
function makeRequest(
	rawCookie: string | undefined,
	unsigned: { valid: boolean; value: string | null },
): FastifyRequest {
	return {
		cookies: rawCookie ? { [COOKIE_NAME]: rawCookie } : {},
		unsignCookie: () => unsigned,
	} as unknown as FastifyRequest;
}

describe("SessionService.validateRequest", () => {
	let prisma: ReturnType<typeof createPrismaStub>;
	let service: SessionService;

	beforeEach(() => {
		prisma = createPrismaStub();
		service = new SessionService(prisma as any, createEnv());
	});

	it("returns null when no session cookie is present", async () => {
		const req = makeRequest(undefined, { valid: false, value: null });
		await expect(service.validateRequest(req)).resolves.toBeNull();
		expect(prisma.session.findUnique).not.toHaveBeenCalled();
	});

	it("returns null when the cookie signature is invalid (tampered)", async () => {
		const req = makeRequest("tampered.cookie", { valid: false, value: null });
		await expect(service.validateRequest(req)).resolves.toBeNull();
		expect(prisma.session.findUnique).not.toHaveBeenCalled();
	});

	it("returns null when the session token is unknown to the database", async () => {
		const req = makeRequest("signed-cookie", { valid: true, value: "unknown-token" });
		await expect(service.validateRequest(req)).resolves.toBeNull();
		expect(prisma.session.findUnique).toHaveBeenCalledTimes(1);
	});

	it("returns null AND best-effort deletes the row when the session is expired", async () => {
		const created = await service.createSession("user-1");
		const hashedId = [...prisma._sessions.keys()][0]!;
		prisma._sessions.get(hashedId)!.expiresAt = new Date(Date.now() - 1000);

		const req = makeRequest("signed-cookie", { valid: true, value: created.token });

		await expect(service.validateRequest(req)).resolves.toBeNull();

		// Best-effort cleanup: row should be gone after the failed validation
		expect(prisma._sessions.has(hashedId)).toBe(false);
		expect(prisma.session.delete).toHaveBeenCalled();
	});

	it("returns the session + token round-trip from createSession", async () => {
		const { token, expiresAt } = await service.createSession("user-1", false, {
			userAgent: "vitest",
			ipAddress: "127.0.0.1",
		});

		const req = makeRequest("signed-cookie", { valid: true, value: token });
		const result = await service.validateRequest(req);

		expect(result).not.toBeNull();
		expect(result!.token).toBe(token);
		expect(result!.session.userId).toBe("user-1");
		expect(result!.session.user.username).toBe("admin");
		expect(result!.session.userAgent).toBe("vitest");
		expect(result!.session.ipAddress).toBe("127.0.0.1");
		expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
	});

	it("rememberMe extends the TTL beyond the default session TTL", async () => {
		const standard = await service.createSession("user-1", false);
		const remembered = await service.createSession("user-1", true);

		// Remember-me TTL (30d) should significantly exceed standard TTL (24h)
		const standardTtlMs = standard.expiresAt.getTime() - Date.now();
		const rememberedTtlMs = remembered.expiresAt.getTime() - Date.now();
		expect(rememberedTtlMs).toBeGreaterThan(standardTtlMs * 10);
	});

	it("atomically rotates only a still-active session and runs the authorized mutation", async () => {
		const current = await service.createSession("user-1");
		const onRotate = vi.fn().mockResolvedValue(undefined);

		const replacement = await service.rotateActiveSession(
			current.token,
			"user-1",
			true,
			{ userAgent: "vitest" },
			{ onRotate },
		);

		expect(replacement).not.toBeNull();
		expect(onRotate).toHaveBeenCalledTimes(1);
		await expect(
			service.validateRequest(makeRequest("signed-cookie", { valid: true, value: current.token })),
		).resolves.toBeNull();
		await expect(
			service.validateRequest(
				makeRequest("signed-cookie", { valid: true, value: replacement!.token }),
			),
		).resolves.not.toBeNull();
	});

	it("does not rotate or mutate after the initiating session is revoked", async () => {
		const current = await service.createSession("user-1");
		await service.invalidateSession(current.token);
		const onRotate = vi.fn().mockResolvedValue(undefined);

		await expect(
			service.rotateActiveSession(current.token, "user-1", true, undefined, { onRotate }),
		).resolves.toBeNull();
		expect(onRotate).not.toHaveBeenCalled();
	});

	it("revokes every other user session before creating the rotated replacement", async () => {
		const current = await service.createSession("user-1");
		const otherSession = await service.createSession("user-1");
		const otherUserSession = await service.createSession("user-2");
		const onRotate = vi.fn(async () => {
			// The initiating session is consumed first, while revocation runs
			// after the credential mutation callback.
			expect(prisma._sessions.size).toBe(2);
		});

		const replacement = await service.rotateActiveSession(
			current.token,
			"user-1",
			true,
			undefined,
			{ onRotate, revokeOtherSessions: true },
		);

		expect(replacement).not.toBeNull();
		await expect(
			service.validateRequest(
				makeRequest("signed-cookie", { valid: true, value: otherSession.token }),
			),
		).resolves.toBeNull();
		await expect(
			service.validateRequest(
				makeRequest("signed-cookie", { valid: true, value: otherUserSession.token }),
			),
		).resolves.not.toBeNull();
		await expect(
			service.validateRequest(
				makeRequest("signed-cookie", { valid: true, value: replacement!.token }),
			),
		).resolves.not.toBeNull();
	});

	it("creates a session only when the transactional authorization check succeeds", async () => {
		const authorized = await service.createSessionIfAuthorized(
			"user-1",
			true,
			undefined,
			async () => true,
		);
		const denied = await service.createSessionIfAuthorized(
			"user-1",
			true,
			undefined,
			async () => false,
		);

		expect(authorized).not.toBeNull();
		expect(denied).toBeNull();
		expect(prisma._sessions.size).toBe(1);
	});

	it("invalidateAllUserSessions(userId, exceptToken) hashes the exceptToken before scoping the delete", async () => {
		const a = await service.createSession("user-1");
		await service.createSession("user-1");
		expect(prisma._sessions.size).toBe(2);

		await service.invalidateAllUserSessions("user-1", a.token);

		expect(prisma.session.deleteMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				id: { not: expect.any(String) },
			},
		});

		// CRITICAL contract: exceptToken must be hashed, never raw — otherwise the
		// "preserve current session" semantics break (raw token != stored hashed id).
		const calls = prisma.session.deleteMany.mock.calls as unknown as Array<
			[{ where: { id: { not: string } } }]
		>;
		expect(calls.length).toBeGreaterThan(0);
		const callArg = calls[0]![0];
		expect(callArg.where.id.not).not.toBe(a.token);
		expect(typeof callArg.where.id.not).toBe("string");
		expect(callArg.where.id.not.length).toBe(64); // sha256 hex length
	});
});
