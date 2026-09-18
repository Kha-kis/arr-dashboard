import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const factory = vi.hoisted(() => ({ createTautulliClient: vi.fn() }));
vi.mock("../../../lib/tautulli/tautulli-client.js", () => factory);

import { registerHistoryRoutes } from "../history-routes.js";

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

function historyItem(title = "Synthetic Movie") {
	return {
		row_id: 1,
		rating_key: "rating-1",
		parent_rating_key: "",
		grandparent_rating_key: "",
		title,
		grandparent_title: "",
		media_type: "movie",
		user: "synthetic-viewer",
		date: 1_757_000_000,
		group_count: 1,
	};
}

function client(rows = [historyItem()]) {
	return {
		getHistory: vi
			.fn()
			.mockResolvedValue({ data: rows, recordsFiltered: rows.length, recordsTotal: rows.length }),
	};
}

describe("Tautulli history availability through the real instance helper", () => {
	let app: FastifyInstance;
	let sources: ReturnType<typeof source>[];
	let clients: Map<string, ReturnType<typeof client>>;

	beforeEach(async () => {
		sources = [source("one")];
		clients = new Map([["one", client()]]);
		factory.createTautulliClient
			.mockReset()
			.mockImplementation((_encryptor, instance) => clients.get(instance.id));
		const matches = (where: Record<string, unknown>) =>
			sources.filter((item) =>
				Object.entries(where).every(([key, value]) =>
					typeof value === "object" && value !== null && "not" in value
						? item[key as keyof typeof item] !== value.not
						: item[key as keyof typeof item] === value,
				),
			);
		app = Fastify({ logger: false });
		app.decorate("prisma", {
			serviceInstance: {
				findMany: vi.fn(async ({ where }) => matches(where)),
				findFirst: vi.fn(async ({ where }) => matches(where)[0] ?? null),
			},
		} as never);
		app.decorate("encryptor", {} as never);
		app.addHook("preHandler", async (request) => {
			request.currentUser = { id: "owner" } as never;
		});
		await app.register(registerHistoryRoutes);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		vi.unstubAllGlobals();
	});

	it("excludes active sessions and reads completed history", async () => {
		const { TautulliClient } = await vi.importActual<
			typeof import("../../../lib/tautulli/tautulli-client.js")
		>("../../../lib/tautulli/tautulli-client.js");
		factory.createTautulliClient.mockReturnValue(
			new TautulliClient("http://one.invalid", "synthetic-key", app.log),
		);
		const requests: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				const parsed = new URL(url);
				requests.push(parsed);
				const active = parsed.searchParams.get("include_activity") !== "0";
				const row = active ? { ...historyItem(), group_count: null } : historyItem();
				return new Response(
					JSON.stringify({
						response: {
							result: "success",
							message: null,
							data: { data: [row], recordsFiltered: 1, recordsTotal: 1 },
						},
					}),
				);
			}),
		);
		await expect(
			new TautulliClient("http://one.invalid", "synthetic-key", app.log).getHistory({
				length: 25,
				start: 0,
			}),
		).rejects.toThrow(/Upstream validation failed/);

		const response = await app.inject({ method: "GET", url: "/?length=25&start=0" });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			history: [expect.objectContaining({ title: "Synthetic Movie" })],
			availability: { status: "complete", configuredSources: 1, availableSources: 1 },
		});
		expect(requests).toHaveLength(2);
		expect(requests[0]?.searchParams.get("include_activity")).toBeNull();
		expect(requests[1]?.searchParams.get("include_activity")).toBe("0");
	});

	it.each(["HTTP", "schema"])("returns generic 503 for an upstream %s failure", async (failure) => {
		const { TautulliClient } = await vi.importActual<
			typeof import("../../../lib/tautulli/tautulli-client.js")
		>("../../../lib/tautulli/tautulli-client.js");
		factory.createTautulliClient.mockReturnValue(
			new TautulliClient("http://one.invalid", "synthetic-key", app.log),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				failure === "HTTP"
					? new Response("private URL/token", { status: 502, statusText: "Bad Gateway" })
					: new Response(
							JSON.stringify({
								response: {
									result: "success",
									message: null,
									data: {
										data: [{ ...historyItem("private URL/token"), group_count: null }],
										recordsFiltered: 1,
										recordsTotal: 1,
									},
								},
							}),
						),
			),
		);

		const response = await app.inject({ method: "GET", url: "/" });

		expect(response.statusCode).toBe(503);
		expect(response.json()).toEqual({
			error: "Tautulli history is unavailable",
			availability: { status: "unavailable", configuredSources: 1, availableSources: 0 },
		});
		expect(response.body).not.toContain("private URL/token");
	});

	it("counts enabled unverified sources but accepts only verified results", async () => {
		sources.push(source("unverified", { identityStatus: "UNVERIFIED", expectedIdentity: null }));

		const response = await app.inject({ method: "GET", url: "/" });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			history: [expect.objectContaining({ title: "Synthetic Movie" })],
			availability: { status: "partial", configuredSources: 2, availableSources: 1 },
		});
	});

	it("returns unavailable when every enabled source is unverified", async () => {
		sources = [
			source("one", { identityStatus: "UNVERIFIED", expectedIdentity: null }),
			source("two", { identityStatus: "UNVERIFIED", expectedIdentity: null }),
		];

		const response = await app.inject({ method: "GET", url: "/" });

		expect(response.statusCode).toBe(503);
		expect(response.json()).toEqual({
			error: "Tautulli history is unavailable",
			availability: { status: "unavailable", configuredSources: 2, availableSources: 0 },
		});
		expect(factory.createTautulliClient).not.toHaveBeenCalled();
	});

	it("keeps successful rows while reporting partial coverage", async () => {
		sources.push(source("two"));
		clients.set("two", client([historyItem("Second Movie")]));
		clients.get("two")!.getHistory.mockRejectedValue(new Error("synthetic failure"));

		const response = await app.inject({ method: "GET", url: "/" });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			history: [expect.objectContaining({ title: "Synthetic Movie" })],
			availability: { status: "partial", configuredSources: 2, availableSources: 1 },
		});
	});

	it("distinguishes a healthy empty source from no configured sources", async () => {
		clients.set("one", client([]));
		const healthy = await app.inject({ method: "GET", url: "/" });
		expect(healthy.statusCode).toBe(200);
		expect(healthy.json()).toMatchObject({
			history: [],
			availability: { status: "complete", configuredSources: 1, availableSources: 1 },
		});

		sources = [source("disabled", { enabled: false }), source("foreign", { userId: "other" })];
		const absent = await app.inject({ method: "GET", url: "/" });
		expect(absent.statusCode).toBe(200);
		expect(absent.json()).toEqual({
			history: [],
			totalCount: 0,
			availability: { status: "not-configured", configuredSources: 0, availableSources: 0 },
		});
	});

	it("does not aggregate a source added after the initial configured snapshot", async () => {
		const findMany = app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>;
		const initial = findMany.getMockImplementation() as unknown as (args: {
			where: Record<string, unknown>;
		}) => Promise<unknown[]>;
		let calls = 0;
		findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => {
			calls += 1;
			if (calls === 2) sources.push(source("added"));
			return initial(args);
		});
		clients.set("added", client([historyItem("Added Movie")]));

		const response = await app.inject({ method: "GET", url: "/" });

		expect(response.statusCode).toBe(200);
		expect(response.json().history).toHaveLength(1);
		expect(response.json().history[0].title).toBe("Synthetic Movie");
	});

	it("does not publish rows after the helper rejects a changed identity", async () => {
		clients.get("one")!.getHistory.mockImplementation(async () => {
			sources[0] = { ...sources[0]!, connectionGeneration: 1 };
			return { data: [historyItem()], recordsFiltered: 1, recordsTotal: 1 };
		});

		const response = await app.inject({ method: "GET", url: "/" });

		expect(response.statusCode).toBe(503);
		expect(response.json().availability).toEqual({
			status: "unavailable",
			configuredSources: 1,
			availableSources: 0,
		});
		expect(response.body).not.toContain("Synthetic Movie");
	});
});
