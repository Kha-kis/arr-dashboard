import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerProtectedRoutes } from "../../../bootstrap/protected-routes.js";
import type { ArrClientFactory, ClientInstanceData } from "../../arr/client-factory.js";

vi.mock("../../../routes/route-manifest.js", async () => ({
	PROTECTED_ROUTE_GROUPS: [
		{
			prefix: "/api/seerr",
			register: (await import("../../../routes/seerr/index.js")).registerSeerrRoutes,
		},
	],
}));

const instance = {
	id: "owned",
	userId: "owner",
	service: "SEERR" as const,
	enabled: true,
	baseUrl: "http://synthetic.invalid",
	encryptedApiKey: "synthetic-unused",
	encryptionIv: "synthetic-unused",
};
const second = { ...instance, id: "owned-second" };
const foreign = { ...instance, id: "foreign", userId: "other" };
const server = (id: number, extra = {}) => ({
	id,
	name: `Synthetic server ${id}`,
	is4k: false,
	isDefault: id === 1,
	activeProfileId: id + 10,
	activeDirectory: `/synthetic/${id}`,
	activeTags: [],
	...extra,
});
const detail = (id: number, extra = {}) => ({
	server: server(id, extra),
	profiles: [{ id: id + 10, name: "Synthetic profile" }],
	rootFolders: [{ id: id + 100, path: `/synthetic/${id}` }],
	tags: [],
	languageProfiles: null,
});
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
type TransportOptions = NonNullable<Parameters<ArrClientFactory["rawRequest"]>[2]>;
let app: ReturnType<typeof Fastify>;
let configured: ReturnType<typeof server>[];
let listStatus: number;
let responses: Map<number, () => Response>;
let calls: { instance: ClientInstanceData; path: string; method: string; body?: unknown }[];
let lookups: { where: { id: string; userId: string } }[];
let currentUserId: string | null;
const get = (mediaType = "movie", id = "owned") =>
	app.inject({
		method: "GET",
		url: `/api/seerr/discover/${id}/request-options?mediaType=${mediaType}`,
	});

beforeEach(async () => {
	configured = [server(1)];
	listStatus = 200;
	responses = new Map();
	calls = [];
	lookups = [];
	currentUserId = "owner";
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw Error("Live network forbidden");
		}),
	);
	app = Fastify({ logger: false });
	app.decorate("prisma", {
		serviceInstance: {
			findFirst: async ({ where }: { where: { id: string; userId: string } }) => {
				lookups.push({ where: { ...where } });
				return (
					[instance, second, foreign].find(
						(row) => row.id === where.id && row.userId === where.userId,
					) ?? null
				);
			},
		},
	});
	app.decorate("arrClientFactory", {
		rawRequest: async (row: ClientInstanceData, path: string, options: TransportOptions) => {
			calls.push({
				instance: row,
				path,
				method: options.method ?? "GET",
				...(options.body ? { body: options.body } : {}),
			});
			if (options.method === "GET" && path === "/api/v1/status")
				return json({
					version: "synthetic",
					commitTag: "synthetic",
					updateAvailable: false,
					commitsBehind: 0,
				});
			if (options.method === "POST" && path === "/api/v1/request")
				return json({
					id: 23,
					status: 1,
					type: "movie",
					is4k: false,
					createdAt: "synthetic",
					media: { id: 8, tmdbId: 7, status: 1, createdAt: "synthetic", updatedAt: "synthetic" },
				});
			if (options.method !== "GET") throw Error("Mutation forbidden in options fixture");
			if (/^\/api\/v1\/service\/(radarr|sonarr)$/.test(path)) return json(configured, listStatus);
			const id = Number(path.split("/").at(-1));
			if (/^\/api\/v1\/service\/(radarr|sonarr)\/\d+$/.test(path))
				return responses.get(id)?.() ?? json(detail(id));
			throw Error("Unexpected synthetic transport");
		},
	});
	app.decorateRequest("currentUser", null);
	app.addHook("onRequest", async (request: FastifyRequest) => {
		if (currentUserId)
			request.currentUser = { id: currentUserId } as NonNullable<typeof request.currentUser>;
	});
	registerProtectedRoutes(app);
	await app.ready();
});
afterEach(async () => {
	await app.close();
	vi.unstubAllGlobals();
});

describe("registered request-options coverage", () => {
	// Catch successful-empty publication after detail errors at the real aggregation boundary.
	it.each(["movie", "tv"])("publishes complete verified %s options", async (mediaType) => {
		const response = await get(mediaType);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			servers: [detail(1)],
			coverage: "complete",
			configuredServerCount: 1,
			unavailableServerCount: 0,
		});
		expect(calls.map((call) => call.path)).toEqual(
			mediaType === "movie"
				? ["/api/v1/service/radarr", "/api/v1/service/radarr/1"]
				: ["/api/v1/service/sonarr", "/api/v1/service/sonarr/1"],
		);
	});
	it("distinguishes verified empty configuration", async () => {
		configured = [];
		expect((await get()).json()).toEqual({
			servers: [],
			coverage: "complete",
			configuredServerCount: 0,
			unavailableServerCount: 0,
		});
		expect(calls).toHaveLength(1);
	});
	it("keeps list failure as query failure", async () => {
		listStatus = 403;
		expect((await get()).statusCode).toBe(403);
		expect(calls).toHaveLength(1);
	});
	it.each(["403", "503", "malformed"])(
		"reports unavailable after all details %s",
		async (kind) => {
			responses.set(1, () =>
				kind === "malformed"
					? json({ server: server(1), profiles: "invalid" })
					: json({ message: "Synthetic private error" }, Number(kind)),
			);
			const response = await get();
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				servers: [],
				coverage: "unavailable",
				configuredServerCount: 1,
				unavailableServerCount: 1,
			});
		},
		10_000,
	);
	it("retains verified alternate when the default is unavailable", async () => {
		configured = [server(1), server(2)];
		responses.set(1, () => json({}, 403));
		expect((await get()).json()).toEqual({
			servers: [detail(2)],
			coverage: "partial",
			configuredServerCount: 2,
			unavailableServerCount: 1,
		});
	});
	it.each([
		["id", { id: 2 }],
		["is4k", { is4k: true }],
		["default", { isDefault: false }],
	])("rejects detail %s disagreement", async (_label, extra) => {
		responses.set(1, () => json(detail(1, extra)));
		expect((await get()).json()).toEqual({
			servers: [],
			coverage: "unavailable",
			configuredServerCount: 1,
			unavailableServerCount: 1,
		});
	});
	it("rejects both duplicate identities while retaining a distinct verified server", async () => {
		configured = [server(1), server(1), server(2)];
		expect((await get()).json()).toEqual({
			servers: [detail(2)],
			coverage: "partial",
			configuredServerCount: 3,
			unavailableServerCount: 2,
		});
	});
	it("verifies zero identity without substituting another server", async () => {
		configured = [server(0)];
		expect((await get()).json()).toEqual({
			servers: [detail(0)],
			coverage: "complete",
			configuredServerCount: 1,
			unavailableServerCount: 0,
		});
		expect(calls[1]?.path).toBe("/api/v1/service/radarr/0");
	});
	it("binds two authorized instances separately", async () => {
		expect((await get("movie", "owned")).statusCode).toBe(200);
		expect((await get("tv", "owned-second")).statusCode).toBe(200);
		expect(calls.map((call) => call.instance.id)).toEqual([
			"owned",
			"owned",
			"owned-second",
			"owned-second",
		]);
		expect(lookups).toEqual([
			{ where: { id: "owned", userId: "owner" } },
			{ where: { id: "owned-second", userId: "owner" } },
		]);
		expect(calls.map((call) => ({ path: call.path, method: call.method }))).toEqual([
			{ path: "/api/v1/service/radarr", method: "GET" },
			{ path: "/api/v1/service/radarr/1", method: "GET" },
			{ path: "/api/v1/service/sonarr", method: "GET" },
			{ path: "/api/v1/service/sonarr/1", method: "GET" },
		]);
	});
	it("denies foreign ownership before transport", async () => {
		expect((await get("movie", "foreign")).statusCode).toBe(404);
		expect(lookups).toEqual([{ where: { id: "foreign", userId: "owner" } }]);
		expect(calls).toHaveLength(0);
	});
	it("denies unauthenticated reads before transport", async () => {
		currentUserId = null;
		expect((await get()).statusCode).toBe(401);
		expect(lookups).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});
	it("dispatches an explicitly selected zero server on create", async () => {
		const payload = {
			mediaId: 7,
			mediaType: "movie",
			serverId: 0,
			profileId: 10,
			rootFolder: "/synthetic/0",
		};
		const response = await app.inject({
			method: "POST",
			url: "/api/seerr/discover/owned/request",
			payload,
		});
		expect(response.statusCode).toBe(200);
		expect(calls.filter((call) => call.method === "POST")).toEqual([
			{ instance, path: "/api/v1/request", method: "POST", body: payload },
		]);
	});
	it.each([-1, 0.5])(
		"denies invalid server identity %s before create dispatch",
		async (serverId) => {
			const response = await app.inject({
				method: "POST",
				url: "/api/seerr/discover/owned/request",
				payload: { mediaId: 7, mediaType: "movie", serverId },
			});
			expect(response.statusCode).toBe(400);
			expect(calls).toHaveLength(0);
		},
	);
});
