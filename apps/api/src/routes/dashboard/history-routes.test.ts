import { PassThrough } from "node:stream";
import fastifyCookie from "@fastify/cookie";
import Fastify, { type FastifyBaseLogger } from "fastify";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	executeOnInstances,
	isLidarrClient,
	isProwlarrClient,
	isRadarrClient,
	isReadarrClient,
	isSonarrClient,
} from "../../lib/arr/client-helpers.js";
import { SessionService } from "../../lib/auth/session.js";
import { parseHistoryReadQuery } from "../../lib/history/history-read-contract.js";
import { readHistoryRepository } from "../../lib/history/history-read-repository.js";
import { historyRoutes } from "./history-routes.js";

vi.mock("../../lib/arr/client-helpers.js", () => ({
	executeOnInstances: vi.fn(),
	isSonarrClient: vi.fn(),
	isRadarrClient: vi.fn(),
	isProwlarrClient: vi.fn(),
	isLidarrClient: vi.fn(),
	isReadarrClient: vi.fn(),
}));

vi.mock("../../lib/history/history-read-repository.js", () => ({
	readHistoryRepository: vi.fn(),
}));

const COOKIE_NAME = "arr_session";
const COOKIE_SECRET = "test-cookie-signing-secret-32-bytes-long!!";
const OWNER_ID = "history-user";
const CURSOR = "opaque-cursor-token";
const SEARCH = "private search";

const HISTORY_CURSOR_INVALID_MESSAGE = "History pagination cursor is invalid.";
const HISTORY_CURSOR_STALE_MESSAGE = "History pagination cursor is stale.";
const HISTORY_QUERY_INVALID_MESSAGE = "History query is invalid.";
const HISTORY_READ_UNAVAILABLE_MESSAGE = "History is temporarily unavailable.";

const providerHelpers = [
	executeOnInstances,
	isSonarrClient,
	isRadarrClient,
	isProwlarrClient,
	isLidarrClient,
	isReadarrClient,
];

type CapturedLogger = FastifyBaseLogger & {
	entries: string[];
	flush: (callback: () => void) => void;
};

function createLogger(): CapturedLogger {
	const entries: string[] = [];
	const stream = new PassThrough();
	stream.on("data", (chunk: Buffer) => entries.push(chunk.toString()));
	return Object.assign(pino({ level: "info" }, stream), { entries }) as CapturedLogger;
}

function flushLogger(logger: CapturedLogger) {
	return new Promise<void>((resolve) => logger.flush(resolve));
}

function createPrismaStub() {
	const sessions = new Map<string, any>();
	return {
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
						username: "history-user",
						mustChangePassword: false,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				};
				sessions.set(row.id, row);
				return row;
			}),
			findUnique: vi.fn(async ({ where }: any) => sessions.get(where.id) ?? null),
			update: vi.fn(async ({ where, data }: any) => {
				const row = sessions.get(where.id);
				if (row) Object.assign(row, data);
				return row;
			}),
			delete: vi.fn(async ({ where }: any) => {
				sessions.delete(where.id);
			}),
		},
	};
}

const emptyHistoryResponse = () => ({
	version: 2 as const,
	items: [],
	sources: [],
	pageInfo: { nextCursor: null, hasNextPage: false, matchingObservedCount: 0 },
});

async function buildApp(options: { authenticated?: boolean; logger?: CapturedLogger } = {}) {
	const prisma = createPrismaStub();
	const logger = options.logger ?? createLogger();
	const app = Fastify({ loggerInstance: logger });
	await app.register(fastifyCookie, { secret: COOKIE_SECRET, hook: "onRequest" });

	const sessionService = new SessionService(
		prisma as never,
		{
			SESSION_COOKIE_NAME: COOKIE_NAME,
			SESSION_COOKIE_SECRET: COOKIE_SECRET,
			SESSION_TTL_HOURS: 24,
			COOKIE_SECURE: false,
			TRUST_PROXY: false,
		} as never,
	);
	app.decorate("prisma", prisma as never);
	app.decorate("encryptor", { encrypt: vi.fn(), decrypt: vi.fn() } as never);
	app.decorate("dbProvider", "sqlite");
	const arrClientFactory = vi.fn(() => {
		throw new Error("provider seam must remain unused");
	});
	app.decorate("arrClientFactory", arrClientFactory as never);
	app.decorate("sessionService", sessionService as never);
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);

	// This is the same global session resolver and protected-scope gate used by
	// production, including the exact 401 body for an absent session.
	app.addHook("preHandler", async (request) => {
		request.currentUser = null;
		request.sessionToken = null;
		const resolved = await sessionService.validateRequest(request);
		if (resolved) {
			request.currentUser = resolved.session.user;
			request.sessionToken = resolved.token;
			request.log = request.log.child({ userId: resolved.session.user.id });
		}
	});
	await app.register(async (protectedScope) => {
		protectedScope.addHook("preHandler", async (request, reply) => {
			if (!request.currentUser?.id) {
				return reply.status(401).send({ error: "Authentication required" });
			}
		});
		await protectedScope.register(historyRoutes, { prefix: "/api" });
	});

	await app.ready();
	const token =
		options.authenticated === false ? null : (await sessionService.createSession(OWNER_ID)).token;
	return { app, arrClientFactory, logger, prisma, token };
}

async function inject(app: any, token: string | null, query = "", path = "/api/dashboard/history") {
	const headers: Record<string, string> = {};
	if (token) headers.cookie = `${COOKIE_NAME}=${(app as any).signCookie(token)}`;
	return app.inject({ method: "GET", url: `${path}${query}`, headers });
}

function expectNoProviderCalls(arrClientFactory: ReturnType<typeof vi.fn>) {
	expect(arrClientFactory).not.toHaveBeenCalled();
	for (const helper of providerHelpers) expect(helper).not.toHaveBeenCalled();
}

describe("public History v2 route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(readHistoryRepository).mockResolvedValue({
			kind: "ok",
			response: emptyHistoryResponse(),
		});
	});

	it("serves the public path from the repository without provider calls", async () => {
		const { app, arrClientFactory, token } = await buildApp();
		try {
			const response = await app.inject({
				method: "GET",
				url: "/api/dashboard/history",
				headers: { cookie: `${COOKIE_NAME}=${(app as any).signCookie(token)}` },
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual(emptyHistoryResponse());
			expect(readHistoryRepository).toHaveBeenCalledTimes(1);
			expectNoProviderCalls(arrClientFactory);
		} finally {
			await app.close();
		}
	});

	it("does not register the staging path and never calls repository or providers", async () => {
		const { app, arrClientFactory, token } = await buildApp();
		try {
			const response = await inject(app, token, "", "/api/dashboard/history-v2");
			expect(response.statusCode).toBe(404);
			expect(readHistoryRepository).not.toHaveBeenCalled();
			expectNoProviderCalls(arrClientFactory);
		} finally {
			await app.close();
		}
	});

	it("uses the production protected gate and returns 401 before the repository", async () => {
		const { app, arrClientFactory } = await buildApp({ authenticated: false });
		try {
			const response = await inject(app, null);
			expect(response.statusCode).toBe(401);
			expect(response.json()).toEqual({ error: "Authentication required" });
			expect(readHistoryRepository).not.toHaveBeenCalled();
			expectNoProviderCalls(arrClientFactory);
		} finally {
			await app.close();
		}
	});

	it("maps a malformed query without a cursor to a generic query-invalid 400", async () => {
		const { app, arrClientFactory, token } = await buildApp();
		try {
			const response = await inject(app, token, "?limit=not-a-number");
			expect(response.statusCode).toBe(400);
			expect(response.json()).toEqual({ error: HISTORY_QUERY_INVALID_MESSAGE });
			expect(readHistoryRepository).not.toHaveBeenCalled();
			expectNoProviderCalls(arrClientFactory);
		} finally {
			await app.close();
		}
	});

	it.each([
		[{ kind: "cursor-invalid" }, 400, HISTORY_CURSOR_INVALID_MESSAGE],
		[{ kind: "cursor-stale" }, 409, HISTORY_CURSOR_STALE_MESSAGE],
		[{ kind: "unavailable" }, 503, HISTORY_READ_UNAVAILABLE_MESSAGE],
	] as const)("maps %j to the generic %i response", async (result, status, message) => {
		vi.mocked(readHistoryRepository).mockResolvedValue(result as never);
		const { app, arrClientFactory, token } = await buildApp();
		try {
			const response = await inject(app, token);
			expect(response.statusCode).toBe(status);
			expect(response.json()).toEqual({ error: message });
			expectNoProviderCalls(arrClientFactory);
		} finally {
			await app.close();
		}
	});

	it.each([
		{ arbitrary: "seam-detail" },
		{ kind: "ok", response: { version: 2, items: [], sources: [], pageInfo: {} } },
	] as const)("fails closed for malformed repository result %j", async (result) => {
		vi.mocked(readHistoryRepository).mockResolvedValue(result as never);
		const { app, arrClientFactory, token } = await buildApp();
		try {
			const response = await inject(app, token);
			expect(response.statusCode).toBe(503);
			expect(response.json()).toEqual({ error: HISTORY_READ_UNAVAILABLE_MESSAGE });
			expect(response.payload).not.toContain("seam-detail");
			expectNoProviderCalls(arrClientFactory);
		} finally {
			await app.close();
		}
	});

	it("forwards only the authenticated owner and canonical server dependencies", async () => {
		const { app, arrClientFactory, token, prisma } = await buildApp();
		try {
			const rawQuery = { limit: "7", search: ` ${SEARCH} `, hideProwlarrRss: "true" };
			const parsed = parseHistoryReadQuery(rawQuery);
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;
			const response = await inject(
				app,
				token,
				`?limit=7&search=${encodeURIComponent(` ${SEARCH} `)}&hideProwlarrRss=true`,
			);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual(emptyHistoryResponse());
			expect(readHistoryRepository).toHaveBeenCalledTimes(1);
			const input = vi.mocked(readHistoryRepository).mock.calls[0]?.[0] as any;
			expect(input.prisma).toBe(prisma);
			expect(input.encryptor).toBe(app.encryptor);
			expect(input.dialect).toBe("sqlite");
			expect(input.ownerId).toBe(OWNER_ID);
			expect(input.query).toEqual(parsed.query);
			expectNoProviderCalls(arrClientFactory);
		} finally {
			await app.close();
		}
	});

	it("keeps successful and validation-failure requests silent and excludes private values from logs", async () => {
		const logger = createLogger();
		const { app, arrClientFactory, token } = await buildApp({ logger });
		try {
			logger.info("safe-canary");
			await flushLogger(logger);
			expect(logger.entries.join("\n")).toContain("safe-canary");
			const success = await inject(
				app,
				token,
				`?cursor=${CURSOR}&search=${encodeURIComponent(SEARCH)}`,
			);
			expect(success.statusCode).toBe(200);
			vi.mocked(readHistoryRepository).mockRejectedValueOnce(new Error("caught-error"));
			const failed = await inject(
				app,
				token,
				`?cursor=${CURSOR}&search=${encodeURIComponent(SEARCH)}`,
			);
			expect(failed.statusCode).toBe(503);
			const invalid = await inject(
				app,
				token,
				`?cursor=${CURSOR}&unknown=${encodeURIComponent("caught-error")}`,
			);
			expect(invalid.statusCode).toBe(400);
			const logs = logger.entries.join("\n");
			expect(logs).not.toContain("/api/dashboard/history-v2");
			expect(logs).not.toContain(CURSOR);
			expect(logs).not.toContain(SEARCH);
			expect(logs).not.toContain(OWNER_ID);
			expect(logs).not.toContain("caught-error");
			expectNoProviderCalls(arrClientFactory);
		} finally {
			await app.close();
		}
	});
});
