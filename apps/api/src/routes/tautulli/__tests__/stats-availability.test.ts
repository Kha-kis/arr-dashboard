import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const factory = vi.hoisted(() => ({ createTautulliClient: vi.fn() }));
vi.mock("../../../lib/tautulli/tautulli-client.js", () => factory);

import { registerStatsRoutes } from "../stats-routes.js";

function source(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		userId: "owner",
		service: "TAUTULLI",
		enabled: true,
		label: `Private ${id}`,
		baseUrl: `http://${id}.invalid`,
		encryptedApiKey: "synthetic-encrypted",
		encryptionIv: "synthetic-iv",
		identityStatus: "VERIFIED",
		expectedIdentity: `pms-${id}`,
		identityKind: "TAUTULLI_PMS_IDENTIFIER",
		connectionGeneration: 0,
		identityGeneration: 0,
		...overrides,
	};
}

function client(empty = false) {
	return {
		getHomeStats: vi.fn().mockResolvedValue([]),
		getUserStats: vi.fn().mockResolvedValue(
			empty
				? []
				: [
						{
							user_id: 1,
							friendly_name: "Synthetic viewer",
							total_plays: 7,
							total_duration: 7200,
						},
					],
		),
		getPlaysByDate: vi.fn().mockResolvedValue(
			empty
				? { categories: [], series: [] }
				: {
						categories: ["2026-09-01"],
						series: [{ name: "Synthetic series", data: [7] }],
					},
		),
	};
}

describe("Tautulli statistics provider availability through the real instance helper", () => {
	let app: FastifyInstance;
	let sources: ReturnType<typeof source>[];
	let clients: Map<string, ReturnType<typeof client>>;
	let reads: Array<Record<string, unknown>>;

	beforeEach(async () => {
		sources = [source("one")];
		clients = new Map([["one", client()]]);
		reads = [];
		factory.createTautulliClient
			.mockReset()
			.mockImplementation((_encryptor, instance) => clients.get(instance.id));
		const matching = (where: Record<string, unknown>) => {
			reads.push(where);
			return sources.filter((s) =>
				Object.entries(where).every(([key, value]) =>
					typeof value === "object" && value !== null && "not" in value
						? s[key as keyof typeof s] !== value.not
						: s[key as keyof typeof s] === value,
				),
			);
		};
		app = Fastify({ logger: false });
		app.decorate("prisma", {
			serviceInstance: {
				findMany: vi.fn(async ({ where }) => matching(where)),
				findFirst: vi.fn(async ({ where }) => matching(where)[0] ?? null),
			},
		} as never);
		app.decorate("encryptor", {} as never);
		app.addHook("preHandler", async (request) => {
			request.currentUser = { id: "owner" } as never;
		});
		await app.register(registerStatsRoutes, { prefix: "/stats" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		vi.unstubAllGlobals();
	});

	it("uses the real HTTP client contract for all-user time-filtered statistics", async () => {
		const { TautulliClient } = await vi.importActual<
			typeof import("../../../lib/tautulli/tautulli-client.js")
		>("../../../lib/tautulli/tautulli-client.js");
		factory.createTautulliClient.mockReturnValue(
			new TautulliClient("http://one.invalid", "synthetic-key", app.log),
		);
		const requests: Array<{ command: string | null; range: string | null; stat: string | null }> =
			[];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				const params = new URL(url).searchParams;
				requests.push({
					command: params.get("cmd"),
					range: params.get("time_range"),
					stat: params.get("stat_id"),
				});
				const valid = params.get("cmd") === "get_home_stats";
				const data =
					params.get("stat_id") === "top_users"
						? {
								stat_id: "top_users",
								stat_title: "Most Active Users",
								rows: [
									{
										user_id: 7,
										user: "synthetic",
										friendly_name: null,
										total_plays: 3,
										total_duration: 120,
										private_extra: "must-not-escape",
									},
								],
							}
						: [];
				return new Response(
					JSON.stringify({
						response: {
							result: valid ? "success" : "error",
							message: valid ? null : "user_id required",
							data,
						},
					}),
				);
			}),
		);
		const response = await app.inject({ method: "GET", url: "/stats?timeRange=7" });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			userStats: [{ userId: 7, friendlyName: "synthetic", totalPlays: 3, totalDuration: 120 }],
			availability: { status: "complete" },
			timeRange: 7,
		});
		expect(response.body).not.toContain("must-not-escape");
		expect(requests).toEqual([
			{ command: "get_home_stats", range: "7", stat: null },
			{ command: "get_home_stats", range: "7", stat: "top_users" },
		]);
	});

	it.each(["/stats", "/stats/plays-by-date"])(
		"%s does not turn a provider failure into a healthy empty response",
		async (url) => {
			const failed = clients.get("one")!;
			failed.getHomeStats.mockRejectedValue(new Error("private URL/token must not escape"));
			failed.getPlaysByDate.mockRejectedValue(new Error("private URL/token must not escape"));
			const response = await app.inject({ method: "GET", url });
			expect(response.statusCode).toBe(503);
			expect(response.json()).toEqual({
				error: "Tautulli statistics are unavailable",
				availability: {
					status: "unavailable",
					configuredSources: 1,
					availableSources: 0,
				},
			});
			expect(response.body).not.toContain("private URL/token");
		},
	);

	it.each(["/stats", "/stats/plays-by-date"])(
		"%s preserves useful results and discloses a failed second source",
		async (url) => {
			sources.push(source("two"));
			const failed = client();
			failed.getHomeStats.mockRejectedValue(new Error("synthetic failure"));
			failed.getPlaysByDate.mockRejectedValue(new Error("synthetic failure"));
			clients.set("two", failed);
			const response = await app.inject({ method: "GET", url });
			expect(response.statusCode).toBe(200);
			expect(response.json().availability).toEqual({
				status: "partial",
				configuredSources: 2,
				availableSources: 1,
			});
			if (url === "/stats") expect(response.json().userStats[0].totalPlays).toBe(7);
			else expect(response.json().series[0].data).toEqual([7]);
		},
	);

	it.each(["/stats", "/stats/plays-by-date"])(
		"%s treats an enabled unverified source as unavailable, not empty",
		async (url) => {
			sources[0] = source("one", { identityStatus: "UNVERIFIED", expectedIdentity: null });
			const response = await app.inject({ method: "GET", url });
			expect(response.statusCode).toBe(503);
			expect(response.json().availability).toEqual({
				status: "unavailable",
				configuredSources: 1,
				availableSources: 0,
			});
			expect(factory.createTautulliClient).not.toHaveBeenCalled();
		},
	);

	it.each(["/stats", "/stats/plays-by-date"])(
		"%s discloses an omitted unverified source alongside a successful one",
		async (url) => {
			sources.push(source("two", { identityStatus: "UNVERIFIED", expectedIdentity: null }));
			const response = await app.inject({ method: "GET", url });
			expect(response.statusCode).toBe(200);
			expect(response.json().availability).toEqual({
				status: "partial",
				configuredSources: 2,
				availableSources: 1,
			});
		},
	);

	it.each(["/stats", "/stats/plays-by-date"])(
		"%s marks a genuine successful empty response complete",
		async (url) => {
			clients.set("one", client(true));
			const response = await app.inject({ method: "GET", url });
			expect(response.statusCode).toBe(200);
			expect(response.json().availability).toEqual({
				status: "complete",
				configuredSources: 1,
				availableSources: 1,
			});
			if (url === "/stats") expect(response.json().userStats).toEqual([]);
			else expect(response.json().series).toEqual([]);
		},
	);

	it.each(["/stats", "/stats/plays-by-date"])(
		"%s distinguishes absent optional services and excludes other owners/disabled sources",
		async (url) => {
			sources = [
				source("foreign", { userId: "another-owner" }),
				source("disabled", { enabled: false }),
			];
			const response = await app.inject({ method: "GET", url });
			expect(response.statusCode).toBe(200);
			expect(response.json().availability).toEqual({
				status: "not-configured",
				configuredSources: 0,
				availableSources: 0,
			});
			expect(factory.createTautulliClient).not.toHaveBeenCalled();
			expect(
				reads.every(
					(where) =>
						where.userId === "owner" && where.service === "TAUTULLI" && where.enabled === true,
				),
			).toBe(true);
		},
	);

	it("does not count an authority-rejected observation as a successful empty result", async () => {
		clients.get("one")!.getUserStats.mockImplementation(async () => {
			sources[0] = source("one", { connectionGeneration: 1 });
			return [
				{ user_id: 1, friendly_name: "Synthetic viewer", total_plays: 99, total_duration: 7200 },
			];
		});
		const response = await app.inject({ method: "GET", url: "/stats" });
		expect(response.statusCode).toBe(503);
		expect(response.json().availability.availableSources).toBe(0);
		expect(response.body).not.toContain("Synthetic viewer");
	});
});
