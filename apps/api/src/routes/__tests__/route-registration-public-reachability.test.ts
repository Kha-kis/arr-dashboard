/**
 * Public-route reachability contract test.
 *
 * The class of bug this test prevents: a route that should be in
 * `PUBLIC_ROUTE_GROUPS` accidentally ends up under a path prefix already
 * gated by `PROTECTED_ROUTE_GROUPS`'s session preHandler — every request
 * gets rejected with the session-401 before the handler even runs. This
 * is exactly what slipped through code review on PR #396 (auto-tagger
 * webhook): the route was correctly defined inside the protected
 * `/api/auto-tag` group, where the session preHandler 401'd every
 * Sonarr/Radarr Connect call before the Bearer-token auth could run.
 * The whole sub-arc-3 webhook was non-functional in production until
 * PR #396's fix bundle moved the route to a public prefix.
 *
 * What this test does: boots the same `(public + protected)` register
 * tree the production server uses, then for every entry in
 * `PUBLIC_ROUTE_GROUPS` sends a request and asserts the response body is
 * NOT the literal session-401 (`"Authentication required"`). Any other
 * response is fine — including a 404 (no exact route match) or a
 * route-specific 401 (e.g. webhook's "Invalid or missing webhook secret"
 * Bearer rejection) — those prove the session preHandler did not run.
 *
 * What this test does NOT do: it does not assert any positive behavior
 * about what the route returns. Per-route correctness lives in each
 * route's own tests.
 */

import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { SessionService } from "../../lib/auth/session.js";
import { PROTECTED_ROUTE_GROUPS, PUBLIC_ROUTE_GROUPS } from "../route-manifest.js";
import { registerTestErrorHandler } from "./test-helpers.js";

const COOKIE_NAME = "arr_session";
const COOKIE_SECRET = "test-cookie-signing-secret-32-bytes-long!!";

const SESSION_PROTECTION_MESSAGE = "Authentication required";

/**
 * Minimal in-memory prisma stub that satisfies the surfaces session
 * validation + a probe request might touch. Returns empty results
 * everywhere — we only care that the request reached the handler tier
 * without being session-401'd.
 */
function createPrismaStub() {
	const empty = vi.fn().mockResolvedValue([]);
	const single = vi.fn().mockResolvedValue(null);
	return {
		session: {
			findUnique: single,
			create: vi.fn(),
			delete: vi.fn(),
			deleteMany: vi.fn(async () => ({ count: 0 })),
			update: vi.fn(),
			count: vi.fn(async () => 0),
		},
		user: { findUnique: single, findFirst: single, update: vi.fn() },
		serviceInstance: { findMany: empty, findFirst: single },
		oIDCProvider: { findUnique: single, findMany: empty },
		webAuthnCredential: { findMany: empty, findFirst: single },
	};
}

function createEnv() {
	return {
		SESSION_COOKIE_NAME: COOKIE_NAME,
		SESSION_COOKIE_SECRET: COOKIE_SECRET,
		SESSION_TTL_HOURS: 24,
		COOKIE_SECURE: false,
		TRUST_PROXY: false,
	} as never;
}

/** Builds the same scope tree production uses: global session resolve hook, then a protected scope iterating PROTECTED_ROUTE_GROUPS, public routes registered at top level. */
async function buildAppFromManifest() {
	const app = Fastify();
	await app.register(fastifyCookie, { secret: COOKIE_SECRET, hook: "onRequest" });

	const prisma = createPrismaStub();
	const sessionService = new SessionService(prisma as never, createEnv());

	app.decorate("prisma", prisma as never);
	app.decorate("sessionService", sessionService as never);
	app.decorate("encryptor", {
		encrypt: vi.fn().mockReturnValue({ value: "enc", iv: "iv" }),
		decrypt: vi.fn().mockReturnValue("secret"),
	} as never);
	app.decorate("config", {} as never);
	app.decorate("arrClientFactory", { create: vi.fn() } as never);

	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);

	// Global preHandler — mirrors server.ts:84-94
	app.addHook("preHandler", async (request) => {
		(request as never as { currentUser: unknown }).currentUser = null;
		(request as never as { sessionToken: unknown }).sessionToken = null;
		const resolved = await sessionService.validateRequest(request);
		if (resolved) {
			(request as never as { currentUser: unknown }).currentUser = resolved.session.user;
			(request as never as { sessionToken: unknown }).sessionToken = resolved.token;
		}
	});

	registerTestErrorHandler(app);

	// Public routes: registered at top level (no scope wrapper), mirrors
	// bootstrap/public-routes.ts.
	for (const group of PUBLIC_ROUTE_GROUPS) {
		await app.register(group.register, group.prefix ? { prefix: group.prefix } : {});
	}

	// Protected scope: mirrors bootstrap/protected-routes.ts.
	await app.register(async (api) => {
		api.addHook("preHandler", async (request, reply) => {
			if (!(request as never as { currentUser?: { id?: string } }).currentUser?.id) {
				return reply.status(401).send({ error: SESSION_PROTECTION_MESSAGE });
			}
		});
		for (const group of PROTECTED_ROUTE_GROUPS) {
			await api.register(group.register, group.prefix ? { prefix: group.prefix } : {});
		}
	});

	await app.ready();
	return app;
}

describe("public route reachability without session", () => {
	it("every PUBLIC_ROUTE_GROUPS entry is reachable (not session-401'd) without a cookie", async () => {
		const app = await buildAppFromManifest();
		try {
			const offenders: Array<{ path: string; status: number; body: string }> = [];

			for (const group of PUBLIC_ROUTE_GROUPS) {
				// Probe the prefix itself (or path if no prefix). A POST is
				// safer than GET for routes that only define POST handlers
				// (e.g. login, webhook) — Fastify returns 404 for the prefix
				// root if no handler matches, which is FINE because 404 ≠
				// session-401.
				const probeUrl = group.prefix ?? group.path;

				const res = await app.inject({ method: "POST", url: probeUrl });
				const body = typeof res.payload === "string" ? res.payload : JSON.stringify(res.payload);

				if (body.includes(SESSION_PROTECTION_MESSAGE)) {
					offenders.push({ path: group.path, status: res.statusCode, body });
				}
			}

			expect(
				offenders,
				`Public routes were rejected by the session preHandler instead of being routed to the public stack:\n${JSON.stringify(offenders, null, 2)}`,
			).toEqual([]);
		} finally {
			await app.close();
		}
	});

	it("auto-tag webhook reaches its Bearer-auth handler without a session cookie", async () => {
		// Surgical regression test for the exact PR #396 finding #1 bug.
		// The webhook must return its OWN 401 ("Invalid or missing webhook
		// secret") when called without a Bearer token — proves the request
		// reached the webhook handler instead of being session-401'd.
		const app = await buildAppFromManifest();
		try {
			const res = await app.inject({
				method: "POST",
				url: "/api/auto-tag/webhook/some-instance-id",
				payload: { eventType: "Test" },
			});

			// Webhook's own auth message — proves the handler ran.
			expect(res.payload).toContain("webhook secret");
			expect(res.payload).not.toContain(SESSION_PROTECTION_MESSAGE);
		} finally {
			await app.close();
		}
	});
});
