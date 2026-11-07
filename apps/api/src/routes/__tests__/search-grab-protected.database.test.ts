import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { envSchema } from "../../config/env.js";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { createArrServiceFingerprint } from "../../lib/arr/service-fingerprint.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import * as runtimePrisma from "../../lib/backup/restore-runtime-client.js";
import { synchronizeSqliteRuntimeSchema } from "../../lib/backup/runtime-schema-sqlite.js";
import type { PrismaClient } from "../../lib/prisma.js";
import { issueSearchGrabSelector } from "../../lib/search/grab-selector.js";
import { buildServer } from "../../server.js";

// Replace startup/catalog/filesystem logging only. Actual buildServer owns
// session admission, the protected gate, cookie signing and error serialization.
vi.mock("../../bootstrap/index.js", async () => {
	const { registerNativeProtectedInfrastructure } = await import(
		"./native-protected-infrastructure.js"
	);
	const { registerProtectedRoutes } = await import("../../bootstrap/protected-routes.js");
	return {
		registerInfrastructure: registerNativeProtectedInfrastructure,
		registerProtectedRoutes,
		registerPublicRoutes() {},
		registerSchedulers() {},
	};
});
vi.mock("../route-manifest.js", async () => {
	const { registerSearchRoutes } = await import("../search.js");
	return { PROTECTED_ROUTE_GROUPS: [{ prefix: "/api", register: registerSearchRoutes }] };
});
vi.mock("../../lib/logger.js", () => ({
	logger: {},
	loggers: { api: {}, auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const fixtureRoot = resolve(tmpdir());
const fixturePrefix = "search-grab-protected-";
const encryptor = new Encryptor("0123456789abcdef0123456789abcdef");
const apiKey = "synthetic-grab-api-key";
const privateMarker = "synthetic-private-grab-dependency";
const origins = {
	north: "https://north.grab.invalid",
	south: "https://south.grab.invalid",
	foreign: "https://foreign.grab.invalid",
	disabled: "https://disabled.grab.invalid",
	relocated: "https://relocated.grab.invalid",
};
const release = {
	id: "synthetic-release-guid",
	guid: "synthetic-release-guid",
	title: "Synthetic private release title",
	indexer: "Synthetic indexer",
	indexerId: 7,
	protocol: "torrent",
};
const acknowledgement = { guid: "synthetic-release-guid", indexerId: 7 };
type Admission = { origin: string; method: "GET" | "POST"; search: string; remaining: number };
type Dispatch = {
	origin: string;
	method: string;
	search: string;
	body: unknown;
	key: string | null;
};
let directory: string;
let database: string;
let prisma: PrismaClient;
let app: FastifyInstance | undefined;
let ownerCookie: string;
let foreignCookie: string;
let expiredCookie: string;
let unsignedCookie: string;
let badSignatureCookie: string;
let admissions: Admission[];
let dispatches: Dispatch[];
let violations: string[];
let providerReply: () => Response | Promise<Response>;

/** Observe the actual guarded read lane, retaining its acquisition and SQL. */
function observeIsolatedReaders(observe: (reader: FastifyInstance["prisma"]) => void) {
	const read = runtimePrisma.withIsolatedRuntimePrismaReadClient;
	const seen = new WeakSet<object>();
	vi.spyOn(runtimePrisma, "withIsolatedRuntimePrismaReadClient").mockImplementation(
		(client, operation) =>
			read(client, (reader) => {
				if (!seen.has(reader)) {
					seen.add(reader);
					observe(reader);
				}
				return operation(reader);
			}),
	);
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeAll(async () => {
	directory = mkdtempSync(join(fixtureRoot, fixturePrefix));
	chmodSync(directory, 0o700);
	database = join(directory, "fixture.db");
	const api = resolve(import.meta.dirname, "../../..");
	const require = createRequire(join(api, "package.json"));
	const config = join(directory, "prisma.config.mjs");
	// Push the full actual schema only into this private DB. No repository
	// dotenv/config loading, inherited database target or client generation.
	writeFileSync(
		config,
		`import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(join(api, "package.json"))});
const { defineConfig } = require('prisma/config');
if (process.env.DATABASE_URL !== ${JSON.stringify(`file:${database}`)}) throw new Error('Unowned fixture database');
export default defineConfig({ schema: ${JSON.stringify(join(api, "prisma/schema.prisma"))}, datasource: { url: process.env.DATABASE_URL } });`,
		{ mode: 0o600 },
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) =>
			["PATH", "LANG", "LC_ALL", "TZ", "LD_LIBRARY_PATH", "SystemRoot"].includes(key),
		),
	);
	const cli = join(
		dirname(require.resolve("prisma/package.json")),
		require("prisma/package.json").bin.prisma,
	);
	execFileSync(process.execPath, [cli, "db", "push", "--config", config], {
		cwd: directory,
		env: {
			...env,
			CI: "1",
			CHECKPOINT_DISABLE: "1",
			PRISMA_HIDE_UPDATE_MESSAGE: "1",
			DATABASE_URL: `file:${database}`,
			TMPDIR: directory,
		},
		timeout: 30_000,
		stdio: "pipe",
	});
	chmodSync(database, 0o600);
	prisma = createTestPrismaClient(database);
	await prisma.user.createMany({
		data: [
			{ id: "owner", username: "synthetic-owner" },
			{ id: "foreign", username: "synthetic-foreign" },
		],
	});
}, 30_000);

beforeEach(async () => {
	// Only the completed owned fixture is cleared; no production recovery state.
	await prisma.searchGrabClaim.deleteMany({});
	await prisma.searchGrabAttempt.deleteMany({});
	await prisma.session.deleteMany({});
	await prisma.serviceInstance.deleteMany({});
	const encrypted = encryptor.encrypt(apiKey);
	await prisma.serviceInstance.createMany({
		data: [
			{ id: "north", userId: "owner", baseUrl: origins.north, enabled: true },
			{ id: "south", userId: "owner", baseUrl: origins.south, enabled: true },
			{ id: "foreign", userId: "foreign", baseUrl: origins.foreign, enabled: true },
			{ id: "disabled", userId: "owner", baseUrl: origins.disabled, enabled: false },
		].map((instance) => ({
			...instance,
			label: `Synthetic ${instance.id}`,
			service: "PROWLARR" as const,
			encryptedApiKey: encrypted.value,
			encryptionIv: encrypted.iv,
		})),
	});
	admissions = [];
	dispatches = [];
	violations = [];
	providerReply = () => json(acknowledgement);
	// Never forward to original fetch. Every external call must match an exact
	// synthetic origin, method, endpoint, query and per-test dispatch allowance.
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = new URL(String(input));
		const admission = admissions.find(
			(item) =>
				item.origin === url.origin &&
				item.method === init.method &&
				item.search === url.search &&
				item.remaining > 0,
		);
		if (
			!url.hostname.endsWith(".grab.invalid") ||
			url.pathname !== "/api/v1/search" ||
			!admission ||
			url.username ||
			url.password ||
			url.hash
		) {
			violations.push("Unadmitted synthetic provider dispatch");
			throw new Error("Unadmitted synthetic provider dispatch");
		}
		admission.remaining--;
		if (init.method === "POST") {
			const marked = await prisma.searchGrabAttempt.findMany({
				where: { state: "submitting", dispatchedAt: { not: null } },
			});
			expect(marked).toHaveLength(1);
			expect(await prisma.searchGrabClaim.count({ where: { attemptId: marked[0]!.id } })).toBe(1);
		}
		dispatches.push({
			origin: url.origin,
			method: init.method!,
			search: url.search,
			body: init.body ? JSON.parse(String(init.body)) : undefined,
			key: new Headers(init.headers).get("X-Api-Key"),
		});
		return providerReply();
	});
	// The cold writer requires physical closure of the fixture's seeding client.
	await prisma.$disconnect();
	await synchronizeSqliteRuntimeSchema(`file:${database}`);
	prisma = createTestPrismaClient(database);
	app = buildServer({
		logger: false,
		env: envSchema.parse({
			NODE_ENV: "test",
			DATABASE_URL: `file:${database}`,
			ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
			SESSION_COOKIE_SECRET: "synthetic-grab-cookie-secret-for-private-fixture",
			SESSION_COOKIE_NAME: "fixture_session",
			COOKIE_SECURE: "false",
			API_RATE_LIMIT_MAX: 10_000,
		}),
	});
	await app.ready();
	const foreign = await app.restoreRuntime.runOperation(() =>
		app!.sessionService.createSession("foreign"),
	);
	const expired = await app.restoreRuntime.runOperation(() =>
		app!.sessionService.createSession("owner"),
	);
	await prisma.session.updateMany({
		where: { userId: "owner" },
		data: { expiresAt: new Date(Date.now() - 60_000) },
	});
	const owner = await app.restoreRuntime.runOperation(() =>
		app!.sessionService.createSession("owner"),
	);
	ownerCookie = signedCookie(owner.token);
	foreignCookie = signedCookie(foreign.token);
	expiredCookie = signedCookie(expired.token);
	unsignedCookie = `fixture_session=${owner.token}`;
	badSignatureCookie = `${ownerCookie}invalid`;
});

async function closeServer() {
	// A rejected close must retain the native runtime reference for diagnosis.
	await app?.close();
	await app?.sessionService.drainValidations();
	app = undefined;
}
afterEach(async () => {
	try {
		await closeServer();
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
	expect(violations).toEqual([]);
	expect(admissions.every((item) => item.remaining === 0)).toBe(true);
	for (const dispatch of dispatches) {
		expect(dispatch.key).toBe(apiKey);
		if (dispatch.method === "POST")
			expect(dispatch.body).toEqual({ guid: "synthetic-release-guid", indexerId: 7 });
	}
});
function removeFixtureTree() {
	if (directory) {
		expect(dirname(directory)).toBe(fixtureRoot);
		expect(basename(directory).startsWith(fixturePrefix)).toBe(true);
		rmSync(directory, { recursive: true, force: true });
	}
}
async function disposeFixture(remove = removeFixtureTree) {
	await closeServer();
	await prisma?.$disconnect();
	// Remove owned files only after both native and observer closure succeed.
	remove();
}
afterAll(() => disposeFixture());

function signedCookie(token: string) {
	return `fixture_session=${encodeURIComponent(app!.signCookie(token))}`;
}
function admitGrab(origin = origins.north) {
	admissions.push({ origin, method: "POST", search: "", remaining: 1 });
}
function admitQuery(origin: string) {
	admissions.push({
		origin,
		method: "GET",
		search: "?query=Synthetic+query&limit=1",
		remaining: 1,
	});
}
async function grabPayload(instanceId = "north", result: unknown = release) {
	const displayed = result as { grabSelector?: string };
	if (typeof displayed?.grabSelector === "string")
		return { instanceId, intentId: randomUUID(), selector: displayed.grabSelector };
	const row =
		(await prisma.serviceInstance.findUnique({ where: { id: instanceId } })) ??
		(await prisma.serviceInstance.findUniqueOrThrow({ where: { id: "north" } }));
	return {
		instanceId,
		intentId: randomUUID(),
		selector: issueSearchGrabSelector(encryptor, {
			userId: row.userId,
			serviceInstanceId: row.id,
			connectionFingerprint: createArrServiceFingerprint(row),
			guid: release.guid,
			indexerId: release.indexerId,
		}),
	};
}
function injectGrab(payload: Record<string, unknown>, cookie = ownerCookie) {
	return app!.inject({
		method: "POST",
		url: "/api/search/grab",
		headers: cookie ? { cookie } : {},
		payload,
	});
}
async function grab(instanceId = "north", cookie = ownerCookie, result: unknown = release) {
	return injectGrab(await grabPayload(instanceId, result), cookie);
}
function query(instanceId: string) {
	return app!.inject({
		method: "POST",
		url: "/api/search/query",
		headers: { cookie: ownerCookie },
		payload: { query: "Synthetic query", limit: 1, filters: [{ instanceId }] },
	});
}
function assertGenericFailure(
	response: {
		statusCode: number;
		json: () => unknown;
		payload: string;
	},
	statusCode = 502,
) {
	expect(response.statusCode).toBe(statusCode);
	if (statusCode === 500)
		expect(response.json()).toEqual({
			statusCode: 500,
			error: "InternalServerError",
			message: "Internal server error",
		});
	else
		expect(response.json()).toMatchObject({
			category: statusCode === 409 ? "connection-unavailable" : "status-unavailable",
		});
	expect(response.payload).not.toContain(privateMarker);
	expect(response.payload).not.toContain(apiKey);
}

describe("actual server Grab session, SQL ownership and SDK acknowledgement boundary", () => {
	it("retains fixture files and the native server reference when closure refuses", async () => {
		const held = app!;
		const refusal = new Error("Synthetic fixture close refusal");
		const close = vi.spyOn(held, "close").mockRejectedValueOnce(refusal);
		const disconnect = vi.spyOn(prisma, "$disconnect");
		const remove = vi.fn();
		try {
			await expect(disposeFixture(remove)).rejects.toBe(refusal);
			expect(app === held).toBe(true);
			expect(disconnect).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
			expect(existsSync(database)).toBe(true);
			expect(existsSync(`${database}.arr-restore-runtime`)).toBe(true);
		} finally {
			// A RED witness must retain/rejoin the actual fixture, never delete it.
			app = held;
			close.mockRestore();
			disconnect.mockRestore();
		}
	});
	// Catches weakened cookie/session admission or route catalog protection:
	// neither a Grab nor a Query may reach instance SQL before authentication.
	for (const route of ["grab", "query"] as const) {
		it.each(["missing", "bad-signature", "unsigned", "unknown", "expired"])(
			`rejects %s session before ${route} instance SQL or dispatch`,
			async (kind) => {
				const readOne = vi.spyOn(app!.prisma.serviceInstance, "findFirst");
				const readMany = vi.spyOn(app!.prisma.serviceInstance, "findMany");
				const cookies: Record<string, string> = {
					missing: "",
					"bad-signature": badSignatureCookie,
					unsigned: unsignedCookie,
					unknown: signedCookie("synthetic-unknown-session"),
					expired: expiredCookie,
				};
				const response = await app!.inject({
					method: "POST",
					url: `/api/search/${route}`,
					headers: cookies[kind] ? { cookie: cookies[kind] } : {},
					payload:
						route === "grab"
							? { instanceId: "north", result: release }
							: { query: "Synthetic query" },
				});
				expect(response.statusCode).toBe(401);
				expect(response.json()).toEqual({ error: "Authentication required" });
				expect(readOne).not.toHaveBeenCalled();
				expect(readMany).not.toHaveBeenCalled();
				expect(dispatches).toEqual([]);
			},
		);
	}

	// Catches trusting client identity claims instead of the session's owner.
	it("rejects forged owner claims without a signed session before SQL", async () => {
		const read = vi.spyOn(app!.prisma.serviceInstance, "findFirst");
		const response = await app!.inject({
			method: "POST",
			url: "/api/search/grab?userId=owner&ownerId=owner",
			headers: { "x-user-id": "owner", "x-test-auth": "1" },
			payload: { instanceId: "north", userId: "owner", result: release },
		});
		expect(response.statusCode).toBe(401);
		expect(read).not.toHaveBeenCalled();
		expect(dispatches).toEqual([]);
	});
	it.each(["foreign", "disabled", "missing"])(
		"denies %s despite forged owner body, query and headers",
		async (instanceId) => {
			const read = vi.spyOn(app!.prisma.serviceInstance, "findFirst");
			const response = await app!.inject({
				method: "POST",
				url: "/api/search/grab?userId=foreign&ownerId=foreign",
				headers: { cookie: ownerCookie, "x-user-id": "foreign", "x-owner-id": "foreign" },
				payload: { instanceId, userId: "foreign", ownerId: "foreign", result: release },
			});
			expect(response.statusCode).toBe(400);
			expect(read).not.toHaveBeenCalled();
			const denied = await app!.inject({
				method: "POST",
				url: "/api/search/grab?userId=foreign&ownerId=foreign",
				headers: { cookie: ownerCookie, "x-user-id": "foreign", "x-owner-id": "foreign" },
				payload: await grabPayload(instanceId),
			});
			expect(denied.statusCode).toBe(409);
			expect(denied.json()).toMatchObject({ category: "connection-unavailable" });
			expect(read).toHaveBeenCalledExactlyOnceWith({
				where: { id: instanceId, userId: "owner", enabled: true, service: "PROWLARR" },
			});
			expect(dispatches).toEqual([]);
		},
	);
	it("uses the foreign session only for its own persisted instance", async () => {
		const denied = await grab("north", foreignCookie);
		expect(denied.statusCode).toBe(409);
		expect(denied.json()).toMatchObject({ category: "connection-unavailable" });
		expect(dispatches).toEqual([]);
		admitGrab(origins.foreign);
		const allowed = await grab("foreign", foreignCookie);
		expect(allowed.statusCode).toBe(204);
		expect(allowed.payload).toBe("");
		expect(dispatches.map((item) => item.origin)).toEqual(["https://foreign.grab.invalid"]);
	});

	// Catches early success before ACK, or replaying an acknowledged action.
	it("returns 204 only after one matching acknowledgement arrives", async () => {
		admitGrab();
		let arrived!: () => void;
		let resolveReply!: (reply: Response) => void;
		const arrival = new Promise<void>((resolve) => {
			arrived = resolve;
		});
		const reply = new Promise<Response>((resolve) => {
			resolveReply = resolve;
		});
		providerReply = () => {
			arrived();
			return reply;
		};
		let settled = false;
		const input = await grabPayload();
		const pending = injectGrab(input).then((response) => {
			settled = true;
			return response;
		});
		await arrival;
		try {
			// Give an incorrectly early injected response time to settle while
			// the provider acknowledgement is still deliberately withheld.
			await setImmediate();
			expect(settled).toBe(false);
			expect(dispatches).toHaveLength(1);
		} finally {
			// A failed pending assertion must not strand the request at teardown.
			resolveReply(json(acknowledgement));
			await pending;
		}
		const response = await pending;
		expect(response.statusCode).toBe(204);
		expect(response.payload).toBe("");
		expect(dispatches).toHaveLength(1);
		expect(await prisma.searchGrabAttempt.findMany()).toEqual([
			expect.objectContaining({ intentId: input.intentId, userId: "owner", state: "acknowledged" }),
		]);
		expect(await prisma.searchGrabClaim.count()).toBe(0);
		expect((await injectGrab(input)).statusCode).toBe(204);
		expect(dispatches).toHaveLength(1);
	});

	// Catches losing SQL-resolved origin/owner identity when release coordinates
	// collide; real Query/fanout/normalizer/SDK supplies the positive Grab body.
	it("queries only enabled owned instances and grabs identical coordinates at each resolved origin", async () => {
		admitQuery(origins.north);
		admitQuery(origins.south);
		providerReply = () =>
			json([
				{
					...release,
					size: 1234,
					seeders: 3,
					leechers: 1,
					categories: [2000],
					publishDate: "2026-01-30T12:00:00Z",
				},
			]);
		const read = vi.fn();
		observeIsolatedReaders((reader) => {
			const lookup = reader.serviceInstance.findMany;
			vi.spyOn(reader.serviceInstance, "findMany").mockImplementation(
				new Proxy(lookup, {
					apply(target, receiver, args) {
						read(...args);
						return Reflect.apply(target, receiver, args);
					},
				}),
			);
		});
		const response = await app!.inject({
			method: "POST",
			url: "/api/search/query",
			headers: { cookie: ownerCookie },
			payload: { query: "Synthetic query", limit: 1 },
		});
		expect(response.statusCode).toBe(200);
		expect(read).toHaveBeenCalledExactlyOnceWith({
			where: { userId: "owner", enabled: true, service: { in: ["PROWLARR"] } },
			orderBy: { label: "asc" },
		});
		const body = response.json();
		expect(body).toMatchObject({
			totalCount: 2,
			failedInstanceCount: 0,
			coverage: {
				receivedCount: 2,
				acceptedCount: 2,
				rejectedCount: 0,
				metadataIncompleteCount: 0,
			},
		});
		expect(body.aggregated).toEqual([
			expect.objectContaining({
				id: "synthetic-release-guid",
				guid: "synthetic-release-guid",
				indexerId: 7,
				instanceId: "north",
				title: "Synthetic private release title",
				size: 1234,
			}),
			expect.objectContaining({
				id: "synthetic-release-guid",
				guid: "synthetic-release-guid",
				indexerId: 7,
				instanceId: "south",
				title: "Synthetic private release title",
				size: 1234,
			}),
		]);
		providerReply = () => json(acknowledgement);
		admitGrab(origins.north);
		admitGrab(origins.south);
		for (const result of body.aggregated)
			expect((await grab(result.instanceId, ownerCookie, result)).statusCode).toBe(204);
		expect(dispatches.map((item) => `${item.method} ${item.origin}`).sort()).toEqual([
			"GET https://north.grab.invalid",
			"GET https://south.grab.invalid",
			"POST https://north.grab.invalid",
			"POST https://south.grab.invalid",
		]);
	});

	// Catches accepting unverified provider responses, or leaking echoed data in
	// the actual durable status serializer. No failure grants replay authority.
	it.each([
		["wrong GUID", { guid: "other-guid", indexerId: 7 }],
		["wrong indexer", { guid: "synthetic-release-guid", indexerId: 8 }],
		["missing identity", { title: release.title, url: origins.north, apiKey }],
		["null", null],
		["array", [acknowledgement]],
		["string indexer", { guid: "synthetic-release-guid", indexerId: "7" }],
		["numeric GUID", { guid: 7, indexerId: 7 }],
	])(
		"serializes %s acknowledgement as bounded unknown 502 without replay",
		async (_label, body) => {
			admitGrab();
			providerReply = () => json(body);
			const response = await grab();
			expect(response.statusCode).toBe(502);
			expect(response.json()).toMatchObject({
				status: {
					state: "uncertain",
					outcomeCategory: "transport-unconfirmed",
					nextAction: "inspect-before-confirmed-retry",
				},
			});
			expect(await prisma.searchGrabClaim.count()).toBe(1);
			for (const marker of [release.title, origins.north, apiKey])
				expect(response.payload).not.toContain(marker);
			expect(dispatches).toHaveLength(1);
		},
	);
	it.each(["HTML", "no content"])(
		"keeps %s acknowledgement unknown through actual serializer",
		async (kind) => {
			admitGrab();
			providerReply = () =>
				kind === "HTML"
					? new Response(`<html>${release.title} ${apiKey}</html>`, {
							status: 200,
							headers: { "Content-Type": "text/html" },
						})
					: new Response(null, { status: 204 });
			const response = await grab();
			expect(response.statusCode).toBe(502);
			expect(response.json()).toMatchObject({
				status: { state: "uncertain", outcomeCategory: "transport-unconfirmed" },
			});
			expect(await prisma.searchGrabClaim.count()).toBe(1);
			expect(dispatches).toHaveLength(1);
		},
	);
	// Catches bypassing central SDK status handling or converting rejection to204.
	it.each([
		[400, "ArrError"],
		[401, "UnauthorizedError"],
		[403, "ForbiddenError"],
		[404, "NotFoundError"],
		[409, "ConflictError"],
		[422, "ArrError"],
	] as const)(
		"records provider %s refusal through actual SDK %s without replay",
		async (status, _sdkErrorName) => {
			admitGrab();
			providerReply = () => json({ message: "Synthetic provider rejection" }, status);
			const response = await grab();
			expect(response.statusCode).toBe(422);
			expect(response.json()).toMatchObject({
				status: {
					state: "rejected",
					outcomeCategory: "provider-rejected",
					nextAction: "new-search",
				},
			});
			expect(response.payload).not.toContain("Synthetic provider rejection");
			expect(await prisma.searchGrabClaim.count()).toBe(0);
			expect(dispatches).toHaveLength(1);
		},
	);
	// Catches losing uncertainty when SDK transport or body parsing throws before
	// the matching-acknowledgement check. These replies do not authorize a retry.
	it.each([
		"network-loss",
		"timeout",
		"malformed-json",
		"body-read",
		"http408",
		"http429",
		"http500",
		"http503",
	])("keeps %s after dispatch bounded unknown without replay", async (kind) => {
		admitGrab();
		providerReply = () => {
			if (kind === "network-loss") throw new TypeError(privateMarker);
			if (kind === "timeout") throw new DOMException(privateMarker, "TimeoutError");
			if (kind === "malformed-json")
				return new Response('{"synthetic":', {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			if (kind === "body-read") {
				const response = json(acknowledgement);
				Object.defineProperty(response, "json", {
					value: async () => {
						throw new TypeError(privateMarker);
					},
				});
				return response;
			}
			return json({ message: privateMarker }, Number(kind.slice(4)));
		};
		const response = await grab();
		expect(dispatches).toHaveLength(1);
		expect(response.statusCode).toBe(502);
		expect(response.json()).toMatchObject({
			status: { state: "uncertain", outcomeCategory: "transport-unconfirmed" },
		});
		expect(await prisma.searchGrabClaim.count()).toBe(1);
		for (const marker of [privateMarker, release.title, origins.north, apiKey])
			expect(response.payload).not.toContain(marker);
	});

	// Catches skipping request validation before SQL/client construction.
	it.each([
		{ instanceId: "north", result: release },
		{ instanceId: "north", selector: "sg1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAA" },
		{ instanceId: "north", intentId: "11111111-1111-4111-8111-111111111111", selector: "invalid" },
	])("rejects invalid Grab input before SQL and provider dispatch (%#)", async (payload) => {
		const read = vi.spyOn(app!.prisma.serviceInstance, "findFirst");
		const response = await injectGrab(payload);
		expect(response.statusCode).toBe(400);
		expect(response.json()).toMatchObject({
			error: "ZodValidationError",
			message: "Invalid payload",
		});
		expect(read).not.toHaveBeenCalled();
		expect(dispatches).toEqual([]);
	});

	// Catches reusing a displayed/cached connection instead of current SQL.
	it.each(["disable", "remove"])(
		"denies Grab when SQL %ss the instance after Query",
		async (change) => {
			admitQuery(origins.north);
			providerReply = () => json([release]);
			const displayed = await query("north");
			expect(displayed.statusCode).toBe(200);
			expect(displayed.json().aggregated).toHaveLength(1);
			if (change === "disable")
				await prisma.serviceInstance.update({ where: { id: "north" }, data: { enabled: false } });
			else await prisma.serviceInstance.delete({ where: { id: "north" } });
			const response = await grab("north", ownerCookie, displayed.json().aggregated[0]);
			expect(response.statusCode).toBe(409);
			expect(response.json()).toMatchObject({ category: "connection-unavailable" });
			expect(dispatches.map((item) => item.method)).toEqual(["GET"]);
		},
	);
	// A previously accepted result cannot authorize a new destination after repoint.
	it("refuses origin rebinding after a displayed Query result without dispatch", async () => {
		admitQuery(origins.north);
		providerReply = () => json([release]);
		const displayed = await query("north");
		expect(displayed.statusCode).toBe(200);
		await prisma.serviceInstance.update({
			where: { id: "north" },
			data: { baseUrl: origins.relocated },
		});
		providerReply = () => json(acknowledgement);
		const denied = await grab("north", ownerCookie, displayed.json().aggregated[0]);
		expect(denied.statusCode).toBe(409);
		expect(denied.json()).toMatchObject({ category: "connection-unavailable" });
		expect(dispatches.map((item) => item.origin)).toEqual(["https://north.grab.invalid"]);
		expect(await prisma.searchGrabAttempt.count()).toBe(0);
	});

	// Catches decrypt-error fallthrough into dispatch or exposing credential data.
	it("fails closed on corrupt encrypted credentials and recovers after repair", async () => {
		await prisma.serviceInstance.update({
			where: { id: "north" },
			data: { encryptedApiKey: privateMarker, encryptionIv: "invalid" },
		});
		assertGenericFailure(await grab(), 409);
		expect(dispatches).toEqual([]);
		const repaired = encryptor.encrypt(apiKey);
		await prisma.serviceInstance.update({
			where: { id: "north" },
			data: { encryptedApiKey: repaired.value, encryptionIv: repaired.iv },
		});
		admitGrab();
		expect((await grab()).statusCode).toBe(204);
		expect(dispatches).toHaveLength(1);
	});

	// Failure injection is explicitly synthetic; ordinary reads still use SQL.
	// Catches swallowing dependency failure, leaking details or poisoning recovery.
	it.each(["session", "instance"])(
		"serializes one-shot %s SQL dependency failure generically and recovers",
		async (dependency) => {
			const instanceRead = vi.spyOn(app!.prisma.serviceInstance, "findFirst");
			if (dependency === "session") {
				let injected = false;
				observeIsolatedReaders((reader) => {
					if (injected) return;
					injected = true;
					vi.spyOn(reader.session, "findUnique").mockRejectedValueOnce(new Error(privateMarker));
				});
			} else instanceRead.mockRejectedValueOnce(new Error(privateMarker));
			assertGenericFailure(await grab(), dependency === "session" ? 500 : 502);
			if (dependency === "session") expect(instanceRead).not.toHaveBeenCalled();
			expect(dispatches).toEqual([]);
			admitGrab();
			expect((await grab()).statusCode).toBe(204);
			expect(dispatches).toHaveLength(1);
		},
	);
});
