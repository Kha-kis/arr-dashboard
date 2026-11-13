import { ProwlarrClient } from "arr-sdk";
import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceInstance } from "../../../lib/prisma.js";
import { registerIndexerRoutes } from "../indexer-routes.js";

const diagnostic = "synthetic-private-test-diagnostic";
const instance: ServiceInstance = {
	id: "synthetic-private-instance",
	userId: "synthetic-owner",
	service: "PROWLARR",
	label: "Synthetic private provider",
	baseUrl: "https://provider.example.invalid",
	externalUrl: null,
	encryptedApiKey: "synthetic-ciphertext",
	encryptionIv: "synthetic-iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	isDefault: true,
	enabled: true,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	connectionGeneration: 0,
	expectedIdentity: null,
	identityKind: null,
	identityStatus: "UNVERIFIED",
	identityGeneration: 0,
	identityVerifiedAt: null,
	identityLastCheckedAt: null,
	createdAt: new Date("2026-10-01T12:00:00Z"),
	updatedAt: new Date("2026-10-06T12:00:00Z"),
};
const definition = {
	id: 7,
	name: "Synthetic provider indexer",
	implementation: "SyntheticIndexer",
	configContract: "SyntheticSettings",
	protocol: "torrent",
	enable: true,
	supportsRss: true,
	supportsSearch: true,
	supportsRedirect: false,
	appProfileId: 1,
	priority: 10,
	tags: [1],
	fields: [{ name: "apiKey", type: "password", value: diagnostic }],
};

let app: ReturnType<typeof Fastify>;
let currentUserId: string | null;
let findInstance: ReturnType<typeof vi.fn>;
let createClient: ReturnType<typeof vi.fn>;
let client: ProwlarrClient;
let logs: string[];
let requests: Array<{ method: string; path: string; body?: unknown }>;
let violations: string[];
let failure: { stage: "definition" | "test"; kind: "http" | "network" } | null;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

beforeEach(async () => {
	currentUserId = "synthetic-owner";
	findInstance = vi.fn().mockResolvedValue(instance);
	client = new ProwlarrClient({
		baseUrl: "https://provider.example.invalid",
		apiKey: "synthetic-sdk-key",
	});
	createClient = vi.fn(() => client);
	logs = [];
	requests = [];
	violations = [];
	failure = null;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = new URL(String(input));
		const method = init.method ?? "GET";
		const stage =
			method === "GET" && url.pathname === "/api/v1/indexer/7"
				? "definition"
				: method === "POST" && url.pathname === "/api/v1/indexer/test"
					? "test"
					: null;
		if (url.origin !== "https://provider.example.invalid" || url.search || !stage) {
			violations.push(`${method} ${url.pathname}`);
			throw new Error("Unexpected synthetic SDK request");
		}
		requests.push({
			method,
			path: url.pathname,
			...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
		});
		if (failure?.stage === stage) {
			if (failure.kind === "network") {
				throw new Error(diagnostic, {
					cause: { request: { url: diagnostic, authorization: diagnostic }, body: diagnostic },
				});
			}
			return json(
				[{ propertyName: "apiKey", errorMessage: diagnostic, attemptedValue: diagnostic }],
				400,
			);
		}
		return stage === "definition" ? json(definition) : new Response(null, { status: 204 });
	});
	app = Fastify({
		logger: { level: "error", stream: { write: (chunk: string) => logs.push(chunk) } },
	});
	app.decorate("prisma", { serviceInstance: { findFirst: findInstance } } as never);
	app.decorate("arrClientFactory", { create: createClient } as never);
	app.decorateRequest("currentUser", null);
	app.addHook("preHandler", async (request: FastifyRequest) => {
		request.currentUser = currentUserId ? ({ id: currentUserId } as never) : null;
	});
	await app.register(registerIndexerRoutes, { prefix: "/api" });
	await app.ready();
});

afterEach(async () => {
	await app.close();
	vi.unstubAllGlobals();
	expect(violations).toEqual([]);
});

const sendTest = (payload: unknown = { instanceId: "synthetic-private-instance", indexerId: 7 }) =>
	app.inject({ method: "POST", url: "/api/search/indexers/test", payload });

const loggedErrors = () =>
	logs
		.join("")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

describe("Indexer Test API diagnostic privacy through real SDK and request logger", () => {
	// Catches copying provider errors into response guidance or Pino's error serializer.
	it.each([
		{ stage: "definition" as const, kind: "http" as const },
		{ stage: "definition" as const, kind: "network" as const },
		{ stage: "test" as const, kind: "http" as const },
		{ stage: "test" as const, kind: "network" as const },
	])("keeps $stage $kind failure diagnostics out of response and serialized logs", async (mode) => {
		failure = mode;
		const response = await sendTest();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: false, message: expect.any(String) });
		expect.soft(response.payload).not.toContain(diagnostic);
		expect.soft(response.json().message).toMatch(/check.*(?:settings|prowlarr)|retry/i);
		expect.soft(logs.join("")).not.toContain(diagnostic);
		expect.soft(logs.join("")).not.toContain("synthetic-private-instance");
		const errors = loggedErrors();
		expect(errors).toHaveLength(1);
		expect.soft(errors[0]?.category).toEqual(expect.stringMatching(/indexer.*test/i));
		for (const field of ["err", "error", "cause", "details", "stack", "instance", "indexerId"]) {
			expect.soft(errors[0]).not.toHaveProperty(field);
		}
		expect(requests.map(({ method, path }) => ({ method, path }))).toEqual(
			mode.stage === "definition"
				? [{ method: "GET", path: "/api/v1/indexer/7" }]
				: [
						{ method: "GET", path: "/api/v1/indexer/7" },
						{ method: "POST", path: "/api/v1/indexer/test" },
					],
		);
	});

	it("control: reports success only after one SDK Test with the complete current definition", async () => {
		const response = await sendTest();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ success: true });
		expect(loggedErrors()).toEqual([]);
		expect(findInstance).toHaveBeenCalledExactlyOnceWith({
			where: { id: "synthetic-private-instance", userId: "synthetic-owner", enabled: true },
		});
		expect(requests).toEqual([
			{ method: "GET", path: "/api/v1/indexer/7" },
			{ method: "POST", path: "/api/v1/indexer/test", body: definition },
		]);
	});

	it("control: a later explicit request recovers a failure without an automatic provider replay", async () => {
		failure = { stage: "test", kind: "network" };
		const first = await sendTest();
		expect(first.json().success).toBe(false);
		expect(requests).toHaveLength(2);
		failure = null;
		const second = await sendTest();
		expect(second.json()).toEqual({ success: true });
		expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
			{ method: "GET", path: "/api/v1/indexer/7" },
			{ method: "POST", path: "/api/v1/indexer/test" },
			{ method: "GET", path: "/api/v1/indexer/7" },
			{ method: "POST", path: "/api/v1/indexer/test" },
		]);
	});

	it("control: unauthenticated Test dispatches neither lookup nor provider requests", async () => {
		currentUserId = null;
		const response = await sendTest();
		expect(response.statusCode).toBe(401);
		expect(response.json().success).toBe(false);
		expect(findInstance).not.toHaveBeenCalled();
		expect(createClient).not.toHaveBeenCalled();
		expect(requests).toEqual([]);
	});

	it("control: missing or inaccessible enabled target returns 404 without provider requests", async () => {
		findInstance.mockResolvedValueOnce(null);
		const response = await sendTest();
		expect(response.statusCode).toBe(404);
		expect(response.json().success).toBe(false);
		expect(createClient).not.toHaveBeenCalled();
		expect(requests).toEqual([]);
	});

	it("control: wrong client kind returns 400 without provider requests", async () => {
		createClient.mockReturnValueOnce({});
		const response = await sendTest();
		expect(response.statusCode).toBe(400);
		expect(response.json().success).toBe(false);
		expect(requests).toEqual([]);
	});

	it("control: invalid Test payload returns 400 before lookup or provider requests", async () => {
		const response = await sendTest({ instanceId: "synthetic-private-instance", indexerId: -1 });
		expect(response.statusCode).toBe(400);
		expect(findInstance).not.toHaveBeenCalled();
		expect(createClient).not.toHaveBeenCalled();
		expect(requests).toEqual([]);
	});
});
