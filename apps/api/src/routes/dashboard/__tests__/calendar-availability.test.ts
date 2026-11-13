import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LidarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calendarRoutes } from "../calendar-routes.js";

const fixture = {
	id: 31,
	title: "Synthetic event",
	airDate: "2026-10-15",
	airDateUtc: "2026-10-15T12:00:00Z",
	inCinemas: "2026-10-15",
	releaseDate: "2026-10-15",
	series: { id: 7, title: "Synthetic series" },
};
const providers = [
	["SONARR", SonarrClient],
	["RADARR", RadarrClient],
	["LIDARR", LidarrClient],
	["READARR", ReadarrClient],
] as const;
const states = new Map<string, { status: number; payload: unknown }>();
const clients = new Map<string, unknown>();
let selected: Array<{
	id: string;
	service: string;
	label: string;
	userId: string;
	enabled: boolean;
}> = [];
let server: Server;
let app: FastifyInstance;
let origin: string;
let reads = 0;

beforeAll(async () => {
	server = createServer((request, response) => {
		const url = new URL(request.url!, "http://127.0.0.1");
		const state = states.get(url.pathname.split("/")[1]!);
		if (
			request.method !== "GET" ||
			!/^\/[a-z-]+\/api\/v[13]\/calendar$/.test(url.pathname) ||
			!state
		) {
			response.writeHead(404).end();
			return;
		}
		reads++;
		response.writeHead(state.status, { "content-type": "application/json" });
		response.end(JSON.stringify(state.payload));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	app = Fastify({ logger: false });
	app.decorateRequest("currentUser", null);
	app.addHook("preHandler", async (request) => {
		request.currentUser = { id: "fixture-owner" } as typeof request.currentUser;
	});
	app.decorate("prisma", {
		serviceInstance: {
			findMany: async ({ where }: { where: unknown }) => {
				expect(where).toEqual({
					userId: "fixture-owner",
					enabled: true,
					service: { in: ["SONARR", "RADARR", "LIDARR", "READARR"] },
				});
				return selected;
			},
		},
	} as unknown as FastifyInstance["prisma"]);
	app.decorate("arrClientFactory", {
		create: (instance: { id: string }) => clients.get(instance.id),
	} as unknown as FastifyInstance["arrClientFactory"]);
	app.register(calendarRoutes, { prefix: "/api" });
	await app.ready();
});
afterAll(async () => {
	await app?.close();
	server?.closeAllConnections();
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
});
function add(
	id: string,
	service: (typeof providers)[number][0],
	ctor: (typeof providers)[number][1],
) {
	clients.set(id, new ctor({ baseUrl: `${origin}/${id}`, apiKey: "synthetic-unused" }));
	states.set(id, { status: 200, payload: [] });
	return { id, service, label: "Synthetic", userId: "fixture-owner", enabled: true };
}
async function read(providerRead = true) {
	const before = reads;
	const response = await app.inject({
		method: "GET",
		url: "/api/dashboard/calendar?start=2026-10-01&end=2026-10-31",
	});
	expect(response.statusCode).toBe(200);
	if (providerRead) expect(reads).toBeGreaterThan(before);
	return response.json();
}
describe("registered Calendar route with real SDK owned HTTP reads", () => {
	for (const [service, ctor] of providers) {
		it.each([
			[200, [], "available", null, 0, 0],
			[503, { message: "Synthetic unavailable" }, "unavailable", "provider-unavailable", 0, 0],
			[200, { items: [] }, "unavailable", "invalid-response", 0, 0],
			[200, [fixture, null], "partial", "invalid-items", 1, 1],
			[
				200,
				[null, { id: 0 }, { id: 1, releaseDate: "2026-02-30" }],
				"unavailable",
				"invalid-items",
				0,
				3,
			],
			[200, [fixture], "available", null, 1, 0],
		] as const)(
			`${service} literal availability %#`,
			async (status, payload, availability, reason, count, rejectedItemCount) => {
				const id = service.toLowerCase();
				selected = [add(id, service, ctor)];
				states.set(id, { status, payload });
				const result = await read();
				expect(result.availability).toBe(availability);
				expect(result.totalCount).toBe(count);
				expect(result.aggregated).toHaveLength(count);
				expect(result.instances[0]).toMatchObject({ availability, reason, rejectedItemCount });
				expect(result.instances[0].data).toHaveLength(count);
				if (count) expect(result.aggregated[0]).toMatchObject({ id: 31, service: id });
			},
		);
	}
	it.each([{ positive: [] }, { positive: [fixture] }])(
		"retains honest mixed coverage %#",
		async ({ positive }) => {
			selected = [add("north", "SONARR", SonarrClient), add("south", "RADARR", RadarrClient)];
			states.set("north", { status: 200, payload: positive });
			states.set("south", { status: 503, payload: {} });
			const result = await read();
			expect(result.availability).toBe("partial");
			expect(result.totalCount).toBe(positive.length);
			if (positive.length) expect(result.aggregated[0].id).toBe(31);
		},
	);
	it("reports no configured sources", async () => {
		selected = [];
		expect(await read(false)).toEqual({
			instances: [],
			aggregated: [],
			totalCount: 0,
			availability: "not-configured",
		});
	});
	it("bounds unsupported clients as invalid responses", async () => {
		selected = [add("unsupported", "SONARR", SonarrClient)];
		clients.set("unsupported", {});
		const result = await read(false);
		expect(result.instances[0]).toMatchObject({
			availability: "unavailable",
			reason: "invalid-response",
			rejectedItemCount: 0,
			data: [],
		});
	});
	it("keeps a valid neighbor through malformed nested data and recovers later", async () => {
		selected = [add("north", "SONARR", SonarrClient)];
		states.set("north", { status: 200, payload: [fixture, { ...fixture, id: 32, series: [] }] });
		const partial = await read();
		expect(partial.totalCount).toBe(1);
		expect(partial.aggregated[0].id).toBe(31);
		expect(partial.instances[0]).toMatchObject({
			availability: "partial",
			reason: "invalid-items",
			rejectedItemCount: 1,
		});
		states.set("north", { status: 200, payload: [fixture] });
		const recovered = await read();
		expect(recovered.instances[0]).toMatchObject({
			availability: "available",
			reason: null,
			rejectedItemCount: 0,
		});
		expect(recovered.aggregated[0].id).toBe(31);
	});
});
