/**
 * Route-level auth enforcement integration tests.
 *
 * Existing route tests in this directory all use `setupAuthInjection()` from
 * test-helpers.ts, which sets `request.currentUser` in a preHandler when a
 * test header is present. That bypasses the real cookie -> unsignCookie ->
 * SessionService.validateRequest -> protected-scope gate. Unit coverage of
 * SessionService.validateRequest exists in `lib/auth/__tests__/session-validation.test.ts`,
 * but nothing wires the full HTTP stack together.
 *
 * These tests stand up the exact preHandler pair used in production
 * (server.ts global hook + bootstrap/protected-routes.ts scope hook) with a
 * real SessionService backed by @fastify/cookie + an in-memory prisma stub,
 * and exercise a real protected route (registerServiceRoutes) through
 * genuine cookie-based auth. Regressions that break cookie signing, the
 * hashing contract between createSession and validateRequest, the expiry
 * cleanup side effect, or the 401 response shape will surface here.
 */
import fastifyCookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionService } from "../../lib/auth/session.js";
import { registerServiceRoutes } from "../services.js";
import { registerTestErrorHandler } from "./test-helpers.js";

const COOKIE_NAME = "arr_session";
const COOKIE_SECRET = "test-cookie-signing-secret-32-bytes-long!!";
const TTL_HOURS = 24;

/** In-memory prisma stub covering the surfaces SessionService + services GET touch. */
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

	return {
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
			deleteMany: vi.fn(async () => ({ count: 0 })),
			update: vi.fn(async ({ where, data }: any) => {
				const row = sessions.get(where.id);
				if (row) Object.assign(row, data);
				return row;
			}),
			count: vi.fn(async () => sessions.size),
		},
		// Used by the services GET handler below the auth gate. Empty result
		// is fine — we only care that the handler *ran*, i.e. auth passed.
		serviceInstance: {
			findMany: vi.fn().mockResolvedValue([]),
		},
	};
}

function createEnv() {
	return {
		SESSION_COOKIE_NAME: COOKIE_NAME,
		SESSION_COOKIE_SECRET: COOKIE_SECRET,
		SESSION_TTL_HOURS: TTL_HOURS,
		COOKIE_SECURE: false,
		TRUST_PROXY: false,
	} as never;
}

/**
 * Build an app wired like production: cookie plugin with signing, global
 * preHandler populates currentUser via sessionService, protected scope
 * rejects when currentUser is missing. Mirrors server.ts lines 81-94 and
 * bootstrap/protected-routes.ts lines 30-35 intentionally — if either of
 * those evolves, update this too.
 */
async function buildApp(prisma: ReturnType<typeof createPrismaStub>) {
	const app = Fastify();
	await app.register(fastifyCookie, { secret: COOKIE_SECRET, hook: "onRequest" });

	const sessionService = new SessionService(prisma as any, createEnv());

	app.decorate("prisma", prisma as any);
	app.decorate("sessionService", sessionService as any);
	app.decorate("encryptor", {
		encrypt: vi.fn().mockReturnValue({ value: "enc", iv: "iv" }),
		decrypt: vi.fn().mockReturnValue("secret"),
	} as never);

	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);

	// --- Global preHandler: resolve session if any (mirrors server.ts:84-94) ---
	app.addHook("preHandler", async (request) => {
		(request as any).currentUser = null;
		(request as any).sessionToken = null;
		const resolved = await sessionService.validateRequest(request);
		if (resolved) {
			(request as any).currentUser = resolved.session.user;
			(request as any).sessionToken = resolved.token;
		}
	});

	registerTestErrorHandler(app);

	// --- Protected scope (mirrors bootstrap/protected-routes.ts:30-35) ---
	await app.register(async (api) => {
		api.addHook("preHandler", async (request, reply) => {
			if (!(request as any).currentUser?.id) {
				return reply.status(401).send({ error: "Authentication required" });
			}
		});
		await api.register(registerServiceRoutes);
	});

	await app.ready();
	return { app, sessionService };
}

/**
 * Inject a request carrying a session token that has been cookie-signed
 * through the SAME @fastify/cookie instance the app uses. This preserves
 * the signing contract end-to-end.
 */
async function injectWithToken(app: FastifyInstance, token: string | null) {
	const headers: Record<string, string> = {};
	if (token !== null) {
		const signed = (app as any).signCookie(token) as string;
		headers.cookie = `${COOKIE_NAME}=${signed}`;
	}
	return app.inject({ method: "GET", url: "/services", headers });
}

describe("Route-level auth enforcement (protected scope gate)", () => {
	let prisma: ReturnType<typeof createPrismaStub>;
	let app: FastifyInstance;
	let sessionService: SessionService;

	beforeEach(async () => {
		prisma = createPrismaStub();
		const built = await buildApp(prisma);
		app = built.app;
		sessionService = built.sessionService;
	});

	afterEach(async () => {
		await app?.close();
	});

	it("rejects an unauthenticated request to a protected route with 401", async () => {
		const res = await injectWithToken(app, null);

		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.payload)).toEqual({ error: "Authentication required" });
		// The handler below the gate must NOT have been reached.
		expect(prisma.serviceInstance.findMany).not.toHaveBeenCalled();
		// Validation must not have been attempted — no cookie present.
		expect(prisma.session.findUnique).not.toHaveBeenCalled();
	});

	it("allows a request carrying a valid session and reaches the downstream handler", async () => {
		const { token } = await sessionService.createSession("user-1", false, {
			userAgent: "vitest",
			ipAddress: "127.0.0.1",
		});

		const res = await injectWithToken(app, token);

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body).toEqual({ services: [] });

		// Prove the handler ran scoped to the right user — the services list
		// query is filtered by the session-resolved user id.
		expect(prisma.serviceInstance.findMany).toHaveBeenCalledTimes(1);
		const findArgs = prisma.serviceInstance.findMany.mock.calls[0]![0] as {
			where: { userId: string };
		};
		expect(findArgs.where.userId).toBe("user-1");
	});

	it("rejects a tampered / unsigned cookie with 401 and never hits the DB lookup", async () => {
		// Raw token written directly into the cookie header — no signature.
		const res = await app.inject({
			method: "GET",
			url: "/services",
			headers: { cookie: `${COOKIE_NAME}=unsigned-raw-token` },
		});

		expect(res.statusCode).toBe(401);
		expect(prisma.session.findUnique).not.toHaveBeenCalled();
		expect(prisma.serviceInstance.findMany).not.toHaveBeenCalled();
	});

	it("rejects an unknown session token with 401 (validated but not found)", async () => {
		// Cookie is signed correctly, but the token does not exist in the session store.
		const res = await injectWithToken(app, "nonexistent-token");

		expect(res.statusCode).toBe(401);
		// Signature was valid, so we DID reach the DB lookup — and then bounced.
		expect(prisma.session.findUnique).toHaveBeenCalledTimes(1);
		expect(prisma.serviceInstance.findMany).not.toHaveBeenCalled();
	});

	it("rejects an expired session with 401 AND best-effort deletes the stale row", async () => {
		const { token } = await sessionService.createSession("user-1");
		const hashedId = [...prisma._sessions.keys()][0]!;
		// Force expiry in the past.
		prisma._sessions.get(hashedId)!.expiresAt = new Date(Date.now() - 1000);

		const res = await injectWithToken(app, token);

		expect(res.statusCode).toBe(401);
		expect(prisma.serviceInstance.findMany).not.toHaveBeenCalled();
		// Side effect: the expired row must be gone — validateRequest cleans
		// up on miss so a replay of the same cookie stays rejected.
		expect(prisma._sessions.has(hashedId)).toBe(false);
		expect(prisma.session.delete).toHaveBeenCalled();
	});

	it("rejects a previously-valid token after the session is invalidated", async () => {
		const { token } = await sessionService.createSession("user-1");

		// First call succeeds.
		const ok = await injectWithToken(app, token);
		expect(ok.statusCode).toBe(200);

		// Simulate logout.
		await sessionService.invalidateSession(token);

		// Same signed cookie — now rejected because the row is gone.
		const after = await injectWithToken(app, token);
		expect(after.statusCode).toBe(401);
	});
});
