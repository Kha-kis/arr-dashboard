import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerProtectedRoutes } from "../../../bootstrap/protected-routes.js";
import type { ArrClientFactory, ClientInstanceData } from "../../arr/client-factory.js";
import { SeerrClient } from "../seerr-client.js";

// Keep the actual protected scope, Seerr registration, route, and client.
// Only unrelated route groups and external identity/transport are replaced.
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
const secondInstance = { ...instance, id: "owned-second", baseUrl: "http://second.invalid" };
const otherOwnerInstance = { ...instance, id: "other-owner", userId: "other" };
const payload = { mediaId: 7, mediaType: "movie" as const };
const accepted = {
	id: 23,
	status: 1,
	type: "movie",
	media: {
		id: 8,
		tmdbId: 7,
		mediaType: "movie",
		status: 1,
		createdAt: "synthetic",
		updatedAt: "synthetic",
	},
	createdAt: "synthetic",
	is4k: false,
};
const providerStatus = {
	version: "synthetic-version",
	commitTag: "synthetic-commit",
	updateAvailable: false,
	commitsBehind: 0,
};
const unknownOutcome = "Action outcome is unknown. Check Seerr before retrying.";
const rejection = { message: "Synthetic CSRF rejection", code: "EBADCSRFTOKEN" };

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function csrf(
	generation: string,
	options: { status?: number; contentType?: string | null; body?: string } = {},
): Response {
	const headers = new Headers();
	if (options.contentType !== null) {
		headers.set("content-type", options.contentType ?? "application/json");
	}
	headers.append("set-cookie", `_csrf=synthetic-secret-${generation}; HttpOnly; Path=/`);
	headers.append("set-cookie", `XSRF-TOKEN=synthetic%20token%20${generation}; Path=/`);
	// Uint8Array prevents Response from adding text/plain to the missing-MIME control.
	return new Response(new TextEncoder().encode(options.body ?? JSON.stringify(providerStatus)), {
		status: options.status ?? 200,
		headers,
	});
}

function redirected(url: string): Response {
	const response = csrf("new");
	Object.defineProperties(response, { redirected: { value: true }, url: { value: url } });
	return response;
}

const invalidResponses: [string, () => Response][] = [
	...[401, 403, 404, 429, 500, 503].map((status): [string, () => Response] => [
		`HTTP ${status}`,
		() => csrf("new", { status }),
	]),
	["unfollowed redirect", () => csrf("new", { status: 302 })],
	["HTML", () => csrf("new", { contentType: "text/html", body: "<p>Synthetic login</p>" })],
	["cross-origin redirect", () => redirected("http://synthetic-login.invalid/")],
	["same-origin redirect", () => redirected("http://synthetic.invalid/login")],
	["missing MIME", () => csrf("new", { contentType: null })],
	["wrong MIME", () => csrf("new", { contentType: "text/plain" })],
	["non-application JSON", () => csrf("new", { contentType: "text/vendor+json" })],
	["malformed JSON", () => csrf("new", { body: "synthetic-private-bootstrap-body{" })],
	["missing status fields", () => csrf("new", { body: "{}" })],
	[
		"incorrect status field type",
		() => csrf("new", { body: JSON.stringify({ ...providerStatus, updateAvailable: "false" }) }),
	],
];

type TransportOptions = NonNullable<Parameters<ArrClientFactory["rawRequest"]>[2]>;
type Dispatch = { instance: ClientInstanceData; path: string; options: TransportOptions };
type StatusResponse = (row: ClientInstanceData) => Response | Promise<Response>;

let app: ReturnType<typeof Fastify>;
let raw: ReturnType<typeof vi.fn>;
let lookups: ReturnType<typeof vi.fn>;
let dispatches: Dispatch[];
let statusReads: Map<string, number>;
let writeCounts: Map<string, number>;
let initial: StatusResponse;
let refresh: StatusResponse;
let firstWrite: StatusResponse;
let replay: StatusResponse;
let currentUserId: string | null;

const writes = (id = "owned") =>
	dispatches.filter((call) => call.instance.id === id && call.options.method === "POST");
const post = (id = "owned", body: Record<string, unknown> = payload) =>
	app.inject({ method: "POST", url: `/api/seerr/discover/${id}/request`, payload: body });

function expectWrites(count: number, id = "owned") {
	expect(writes(id)).toHaveLength(count);
	for (const call of writes(id)) {
		expect(call.instance).toMatchObject({ id, userId: "owner", service: "SEERR" });
		expect(call.path).toBe("/api/v1/request");
		expect(call.options).toMatchObject({ method: "POST", body: payload });
	}
}

beforeEach(async () => {
	dispatches = [];
	statusReads = new Map();
	writeCounts = new Map();
	currentUserId = "owner";
	initial = () => csrf("old");
	refresh = () => csrf("new");
	firstWrite = () => json(rejection, 403);
	replay = () => json(accepted);
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Real network forbidden");
		}),
	);
	lookups = vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
		return (
			[instance, secondInstance, otherOwnerInstance].find(
				(row) => row.id === where.id && row.userId === where.userId,
			) ?? null
		);
	});
	raw = vi.fn(async (row: ClientInstanceData, path: string, options: TransportOptions) => {
		dispatches.push({ instance: row, path, options });
		if (options.method === "GET" && path === "/api/v1/status") {
			const count = (statusReads.get(row.id) ?? 0) + 1;
			statusReads.set(row.id, count);
			return count === 1 ? initial(row) : refresh(row);
		}
		if (options.method === "POST" && path === "/api/v1/request") {
			const count = (writeCounts.get(row.id) ?? 0) + 1;
			writeCounts.set(row.id, count);
			return count === 1 ? firstWrite(row) : replay(row);
		}
		throw new Error("Unexpected synthetic provider request");
	});
	app = Fastify({ logger: false });
	app.decorate("prisma", { serviceInstance: { findFirst: lookups } });
	app.decorate("arrClientFactory", { rawRequest: raw });
	app.decorateRequest("currentUser", null);
	app.addHook("onRequest", async (request: FastifyRequest) => {
		if (currentUserId) {
			request.currentUser = { id: currentUserId } as NonNullable<typeof request.currentUser>;
		}
	});
	registerProtectedRoutes(app);
	await app.ready();
});

afterEach(async () => {
	await app.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("registered Discover request CSRF recovery", () => {
	it("replaces credentials for exactly one replay with the same target, method, and payload", async () => {
		const response = await post();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual(accepted);
		expectWrites(2);
		expect(statusReads.get("owned")).toBe(2);
		expect(lookups).toHaveBeenCalledExactlyOnceWith({
			where: { id: "owned", userId: "owner", enabled: true },
		});
		expect(writes()[0]?.options.headers).toEqual({
			"x-xsrf-token": "synthetic token old",
			Cookie: "_csrf=synthetic-secret-old; XSRF-TOKEN=synthetic%20token%20old",
		});
		expect(writes()[1]?.options.headers).toEqual({
			"x-xsrf-token": "synthetic token new",
			Cookie: "_csrf=synthetic-secret-new; XSRF-TOKEN=synthetic%20token%20new",
		});
	});

	it.each(invalidResponses)(
		"retains the original 403 without replay for %s with cookies",
		async (_name, makeResponse) => {
			refresh = makeResponse;
			const response = await post();
			expect(response.statusCode).toBe(403);
			expect(response.json().message).toContain("Synthetic CSRF rejection");
			expectWrites(1);
			expect(statusReads.get("owned")).toBe(2);
		},
	);

	it.each([
		"Application/JSON; Charset=UTF-8",
		"application/vnd.synthetic.status+json; charset=utf-8",
	])("admits normalized %s and additional upstream fields", async (contentType) => {
		refresh = () =>
			csrf("new", {
				contentType,
				body: JSON.stringify({ ...providerStatus, additionalUpstreamField: true }),
			});
		const response = await post();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual(accepted);
		expectWrites(2);
		expect(writes()[1]?.options.headers?.["x-xsrf-token"]).toBe("synthetic token new");
	});

	it("stops after a second definite 403", async () => {
		replay = () => json({ message: "Synthetic second rejection" }, 403);
		const response = await post();
		expect(response.statusCode).toBe(403);
		expect(response.json().message).toContain("Synthetic second rejection");
		expectWrites(2);
		expect(statusReads.get("owned")).toBe(2);
	});

	it.each(["network", "HTTP 503", "invalid success schema", "malformed success JSON"])(
		"reports an unknown outcome after replay %s without a third write",
		async (kind) => {
			replay = () => {
				if (kind === "network") throw new Error("Synthetic response lost");
				if (kind === "HTTP 503") return json({ message: "Synthetic failure" }, 503);
				if (kind === "malformed success JSON")
					return new Response("{", { headers: { "content-type": "application/json" } });
				return json({ unexpected: true });
			};
			const response = await post();
			expect(response.statusCode).toBe(502);
			expect(response.json().message).toBe(unknownOutcome);
			expectWrites(2);
			expect(statusReads.get("owned")).toBe(2);
		},
	);

	it.each(["throws", "no token", "empty token", "bad token encoding"])(
		"does not replay when replacement status %s",
		async (kind) => {
			refresh = () => {
				if (kind === "throws") throw new Error("Synthetic status unavailable");
				const response = json(providerStatus);
				if (kind !== "no token") {
					response.headers.set(
						"set-cookie",
						`XSRF-TOKEN=${kind === "empty token" ? "" : "%E0%A4%A"}; Path=/`,
					);
				}
				return response;
			};
			const response = await post();
			expect(response.statusCode).toBe(403);
			expect(response.json().message).toContain("Synthetic CSRF rejection");
			expectWrites(1);
			expect(statusReads.get("owned")).toBe(2);
		},
	);

	it("keeps malformed bootstrap body and parse errors out of debug diagnostics", async () => {
		const debug = vi.spyOn(app.log, "debug");
		refresh = () => csrf("new", { body: "synthetic-private-bootstrap-body{" });
		const response = await post();
		expect(response.statusCode).toBe(403);
		expectWrites(1);
		expect(debug).toHaveBeenCalled();
		expect(JSON.stringify(debug.mock.calls)).not.toContain("synthetic-private-bootstrap-body");
		expect(debug.mock.calls.flat().some((value) => typeof value === "object")).toBe(false);
	});
});

describe("initial bootstrap and scoped dispatch", () => {
	it.each(invalidResponses)(
		"omits initial credentials for %s while retaining tokenless dispatch",
		async (_name, makeResponse) => {
			initial = makeResponse;
			firstWrite = () => json(accepted);
			const response = await post();
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual(accepted);
			expectWrites(1);
			expect(writes()[0]?.options.headers).toBeUndefined();
			expect(statusReads.get("owned")).toBe(1);
		},
	);

	it("does not cache invalid initial credentials across actions on the same client", async () => {
		initial = () => csrf("invalid", { status: 503 });
		firstWrite = () => json(accepted);
		const client = new SeerrClient(app.arrClientFactory, instance, app.log);
		await expect(client.createRequest(payload)).resolves.toEqual(accepted);
		await expect(client.createRequest(payload)).resolves.toEqual(accepted);
		expectWrites(2);
		expect(statusReads.get("owned")).toBe(2);
		expect(writes()[0]?.options.headers).toBeUndefined();
		expect(writes()[1]?.options.headers?.["x-xsrf-token"]).toBe("synthetic token new");
	});

	it("rejects an instance belonging to another owner before any provider dispatch", async () => {
		const response = await post("other-owner");
		expect(response.statusCode).toBe(404);
		expect(lookups).toHaveBeenCalledExactlyOnceWith({
			where: { id: "other-owner", userId: "owner", enabled: true },
		});
		expect(dispatches).toHaveLength(0);
	});

	it("rejects unauthenticated callers before owner lookup or provider dispatch", async () => {
		currentUserId = null;
		const response = await post();
		expect(response.statusCode).toBe(401);
		expect(lookups).not.toHaveBeenCalled();
		expect(dispatches).toHaveLength(0);
	});

	it("validates the request before provider dispatch", async () => {
		const response = await post("owned", { ...payload, mediaId: -1 });
		expect(response.statusCode).toBe(400);
		expect(lookups).not.toHaveBeenCalled();
		expect(dispatches).toHaveLength(0);
	});

	it("keeps admitted credentials isolated from a second instance with invalid evidence", async () => {
		initial = (row) =>
			row.id === "owned" ? csrf("first") : csrf("second-invalid", { status: 503 });
		refresh = () => csrf("second-invalid", { contentType: "text/html" });
		firstWrite = (row) => (row.id === "owned" ? json(accepted) : json(rejection, 403));
		const firstClient = new SeerrClient(app.arrClientFactory, instance, app.log);
		await expect(firstClient.createRequest(payload)).resolves.toEqual(accepted);
		const secondResponse = await post("owned-second");
		expect(secondResponse.statusCode).toBe(403);
		expect(secondResponse.json().message).toContain("Synthetic CSRF rejection");
		await expect(firstClient.createRequest(payload)).resolves.toEqual(accepted);
		expectWrites(2);
		expectWrites(1, "owned-second");
		expect(statusReads.get("owned")).toBe(1);
		expect(statusReads.get("owned-second")).toBe(2);
		for (const call of writes()) {
			expect(call.options.headers?.["x-xsrf-token"]).toBe("synthetic token first");
			expect(call.instance.baseUrl).toBe("http://synthetic.invalid");
		}
		expect(writes("owned-second")[0]?.options.headers).toBeUndefined();
		expect(writes("owned-second")[0]?.instance.baseUrl).toBe("http://second.invalid");
	});
});
