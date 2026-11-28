import type { SearchRequest, SearchResult } from "@arr/shared";
import { ProwlarrClient } from "arr-sdk";
import type { Release } from "arr-sdk/prowlarr";
import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Encryptor } from "../../../lib/auth/encryption.js";
import type { ServiceInstance } from "../../../lib/prisma.js";
import { registerQueryRoutes } from "../query-routes.js";

const north: ServiceInstance = {
	id: "synthetic-north",
	userId: "synthetic-owner",
	service: "PROWLARR",
	label: "Synthetic North",
	baseUrl: "https://north.example.invalid",
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
const south: ServiceInstance = {
	...north,
	id: "synthetic-south",
	label: "Synthetic South",
	baseUrl: "https://south.example.invalid",
	isDefault: false,
};
const instances: ServiceInstance[] = [
	north,
	south,
	{ ...north, id: "synthetic-foreign", userId: "another-synthetic-owner" },
	{ ...north, id: "synthetic-disabled", enabled: false },
];
const release = {
	age: 1,
	ageHours: 24,
	ageMinutes: 1440,
	categories: [],
	commentUrl: null,
	downloadClientId: null,
	downloadUrl: "https://north.example.invalid/download/7",
	fileName: null,
	files: 1,
	grabs: 2,
	guid: "synthetic-release-guid",
	id: 7,
	imdbId: 0,
	indexer: "Synthetic Indexer",
	indexerFlags: [],
	indexerId: 7,
	infoHash: null,
	infoUrl: "https://north.example.invalid/info/7",
	leechers: 1,
	magnetUrl: null,
	posterUrl: null,
	protocol: "torrent",
	publishDate: "2026-10-06T12:00:00Z",
	releaseHash: null,
	seeders: 4,
	size: 1024,
	sortTitle: "synthetic release",
	subGroup: null,
	title: "Synthetic Release",
	tmdbId: 0,
	tvdbId: 0,
	tvMazeId: 0,
} satisfies Release;
const missingIndexer = { ...release, indexerId: undefined };
const query: SearchRequest = {
	query: "  synthetic query  ",
	type: "tv",
	limit: 25,
	filters: [{ instanceId: "synthetic-north", indexerIds: [7], categories: [5000] }],
};
type Lookup = {
	where: {
		userId?: string;
		enabled?: boolean;
		service?: { in: string[] };
		id?: { in: string[] };
	};
	orderBy: { label: "asc" };
};

let app: ReturnType<typeof Fastify>;
let findInstances: ReturnType<typeof vi.fn>;
let replies: Map<string, { body: unknown; status: number }>;
let requests: Array<{ origin: string; method: string; path: string; params: [string, string][] }>;
let violations: string[];
let readAllowance: number;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
const displayRows = (rows: SearchResult[]) =>
	rows.map((row) => {
		const display = { ...row };
		delete display.grabSelector;
		return display;
	});

beforeEach(async () => {
	replies = new Map([
		[north.baseUrl, { body: [release], status: 200 }],
		[south.baseUrl, { body: [release], status: 200 }],
	]);
	requests = [];
	violations = [];
	readAllowance = 0;
	findInstances = vi.fn(async ({ where }: Lookup) =>
		instances.filter(
			(instance) =>
				(where.userId === undefined || instance.userId === where.userId) &&
				(where.enabled === undefined || instance.enabled === where.enabled) &&
				(!where.service || where.service.in.includes(instance.service)) &&
				(!where.id || where.id.in.includes(instance.id)),
		),
	);
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = new URL(String(input));
		const method = init.method ?? "GET";
		const reply = replies.get(url.origin);
		if (
			!reply ||
			method !== "GET" ||
			url.pathname !== "/api/v1/search" ||
			init.body !== undefined ||
			readAllowance === 0
		) {
			violations.push(`${method} ${url.pathname}`);
			throw new Error("Unexpected synthetic provider request");
		}
		readAllowance--;
		requests.push({
			origin: url.origin,
			method,
			path: url.pathname,
			params: [...url.searchParams.entries()],
		});
		return json(reply.body, reply.status);
	});
	app = Fastify();
	app.decorate("encryptor", new Encryptor("55".repeat(32)));
	app.decorate("prisma", { serviceInstance: { findMany: findInstances } } as never);
	app.decorate("arrClientFactory", {
		create: (instance: ServiceInstance) =>
			new ProwlarrClient({ baseUrl: instance.baseUrl, apiKey: "synthetic-sdk-key" }),
	} as never);
	app.decorateRequest("currentUser", null);
	app.addHook("preHandler", async (request: FastifyRequest) => {
		request.currentUser = { id: "synthetic-owner" } as never;
	});
	await app.register(registerQueryRoutes, { prefix: "/api" });
	await app.ready();
});

afterEach(async () => {
	await app.close();
	vi.unstubAllGlobals();
	expect(violations).toEqual([]);
	expect(readAllowance).toBe(0);
});

async function search(payload: SearchRequest = query, allowedReads = 1) {
	readAllowance += allowedReads;
	const response = await app.inject({ method: "POST", url: "/api/search/query", payload });
	expect(response.statusCode).toBe(200);
	return response.json();
}

describe("Search normalization coverage through real SDK, fan-out and route", () => {
	it("preserves SDK category object ids through provider GET, normalization and returned-batch coverage", async () => {
		const sdkRelease = {
			...release,
			categories: [
				{ id: 5000, name: "Synthetic TV", subCategories: [{ id: 5030, name: "Synthetic SD" }] },
				{ id: 5040, name: "Synthetic HD", description: null, subCategories: [] },
			],
		} satisfies Release;
		replies.set(north.baseUrl, { body: [sdkRelease], status: 200 });
		const body = await search();
		expect(body.aggregated).toHaveLength(1);
		expect(body.aggregated[0]).toMatchObject({
			id: "7",
			guid: "synthetic-release-guid",
			indexerId: 7,
			instanceId: "synthetic-north",
			categories: [5000, 5040],
		});
		expect(body.aggregated[0]).not.toHaveProperty("metadataIncomplete");
		expect(body.coverage).toEqual({
			receivedCount: 1,
			acceptedCount: 1,
			rejectedCount: 0,
			metadataIncompleteCount: 0,
		});
		expect(body.instances[0].coverage).toEqual({
			receivedCount: 1,
			acceptedCount: 1,
			rejectedCount: 0,
			metadataIncompleteCount: 0,
		});
		expect(requests).toHaveLength(1);
	});
	it("retains valid SDK categories while exposing malformed category evidence rather than inventing assignments", async () => {
		replies.set(north.baseUrl, {
			body: [
				{
					...release,
					categories: [
						{ id: 5000 },
						{ name: "Synthetic", subCategories: [{ id: 5030 }] },
						{ id: null },
					],
				},
			],
			status: 200,
		});
		const body = await search();
		expect(body.aggregated).toHaveLength(1);
		expect(body.aggregated[0]).toMatchObject({
			id: "7",
			indexerId: 7,
			categories: [5000],
			metadataIncomplete: true,
		});
		expect(body.coverage).toEqual({
			receivedCount: 1,
			acceptedCount: 1,
			rejectedCount: 0,
			metadataIncompleteCount: 1,
		});
		expect(requests).toHaveLength(1);
	});
	it("valid category metadata cannot rescue invalid actionable release identity", async () => {
		replies.set(north.baseUrl, {
			body: [{ ...missingIndexer, categories: [{ id: 5000 }] }],
			status: 200,
		});
		const body = await search();
		expect(body.aggregated).toEqual([]);
		expect(body.coverage).toEqual({
			receivedCount: 1,
			acceptedCount: 0,
			rejectedCount: 1,
			metadataIncompleteCount: 0,
		});
		expect(requests).toHaveLength(1);
	});
	it("control: keeps usable rows and maps the owned filtered query into one provider GET", async () => {
		const body = await search();
		expect(body).toMatchObject({
			failedInstanceCount: 0,
			totalCount: 1,
			coverage: {
				receivedCount: 1,
				acceptedCount: 1,
				rejectedCount: 0,
				metadataIncompleteCount: 0,
			},
			instances: [{ instanceId: "synthetic-north", success: true }],
			aggregated: [
				{
					id: "7",
					guid: "synthetic-release-guid",
					title: "Synthetic Release",
					indexerId: 7,
					indexer: "Synthetic Indexer",
					protocol: "torrent",
					size: 1024,
					seeders: 4,
					leechers: 1,
					peers: 5,
					grabs: 2,
					instanceId: "synthetic-north",
					instanceName: "Synthetic North",
					instanceUrl: "https://north.example.invalid",
				},
			],
		});
		expect(findInstances).toHaveBeenCalledExactlyOnceWith({
			where: {
				userId: "synthetic-owner",
				enabled: true,
				service: { in: ["PROWLARR"] },
				id: { in: ["synthetic-north"] },
			},
			orderBy: { label: "asc" },
		});
		expect(requests).toEqual([
			{
				origin: "https://north.example.invalid",
				method: "GET",
				path: "/api/v1/search",
				params: [
					["query", "synthetic query"],
					["type", "tvsearch"],
					["limit", "25"],
					["indexerIds", "7"],
					["categories", "5000"],
				],
			},
		]);
	});

	it("control: a genuinely empty provider response remains a verified empty search", async () => {
		replies.set(north.baseUrl, { body: [], status: 200 });
		const body = await search();
		expect(body).toMatchObject({
			failedInstanceCount: 0,
			totalCount: 0,
			coverage: {
				receivedCount: 0,
				acceptedCount: 0,
				rejectedCount: 0,
				metadataIncompleteCount: 0,
			},
			aggregated: [],
			instances: [{ instanceId: "synthetic-north", success: true, data: [] }],
		});
		expect(requests).toHaveLength(1);
	});

	// Catches losing coverage evidence when all received rows are rejected by normalization.
	it.each([
		["missing indexer coordinate", missingIndexer],
		["negative indexer coordinate", { ...release, indexerId: -1 }],
		["fractional indexer coordinate", { ...release, indexerId: 1.5 }],
		["blank indexer coordinate", { ...release, indexerId: " " }],
		["null release", null],
	] as const)("distinguishes %s from a genuinely empty provider response", async (_name, raw) => {
		replies.set(north.baseUrl, { body: [], status: 200 });
		const trulyEmpty = await search();
		replies.set(north.baseUrl, { body: [raw], status: 200 });
		const dropped = await search();
		expect(dropped.aggregated).toEqual([]);
		expect(requests).toHaveLength(2);
		expect(trulyEmpty.coverage).toEqual({
			receivedCount: 0,
			acceptedCount: 0,
			rejectedCount: 0,
			metadataIncompleteCount: 0,
		});
		expect(dropped.coverage).toEqual({
			receivedCount: 1,
			acceptedCount: 0,
			rejectedCount: 1,
			metadataIncompleteCount: 0,
		});
		expect(dropped.instances[0].coverage).toEqual({
			receivedCount: 1,
			acceptedCount: 0,
			rejectedCount: 1,
			metadataIncompleteCount: 0,
		});
	});

	it("retains identity-valid rows with invalid optional size as incomplete unknown metadata", async () => {
		replies.set(north.baseUrl, { body: [{ ...release, size: -1 }], status: 200 });
		const body = await search();
		expect(body.aggregated).toHaveLength(1);
		expect(body.aggregated[0]).toMatchObject({
			id: "7",
			indexerId: 7,
			metadataIncomplete: true,
			seeders: 4,
		});
		expect(body.aggregated[0]).not.toHaveProperty("size");
		expect(body.coverage).toEqual({
			receivedCount: 1,
			acceptedCount: 1,
			rejectedCount: 0,
			metadataIncompleteCount: 1,
		});
	});

	// Catches hiding rejected rows while retaining the same falsely complete valid-only envelope.
	it("preserves a usable row while distinguishing a mixed response from valid-only coverage", async () => {
		const validOnly = await search();
		replies.set(north.baseUrl, { body: [release, missingIndexer], status: 200 });
		const mixed = await search();
		expect(displayRows(mixed.aggregated)).toEqual(displayRows(validOnly.aggregated));
		expect(mixed.aggregated[0].grabSelector).not.toBe(validOnly.aggregated[0].grabSelector);
		expect(mixed.totalCount).toBe(1);
		expect(requests).toHaveLength(2);
		expect(mixed.coverage).toEqual({
			receivedCount: 2,
			acceptedCount: 1,
			rejectedCount: 1,
			metadataIncompleteCount: 0,
		});
	});

	it("retains the healthy instance while distinguishing another instance's rejected rows from empty", async () => {
		const selected: SearchRequest = {
			...query,
			filters: [
				{ instanceId: "synthetic-north", indexerIds: [7] },
				{ instanceId: "synthetic-south", indexerIds: [7] },
			],
		};
		replies.set(south.baseUrl, { body: [], status: 200 });
		const healthyAndEmpty = await search(selected, 2);
		replies.set(south.baseUrl, { body: [missingIndexer], status: 200 });
		const healthyAndDropped = await search(selected, 2);
		expect(displayRows(healthyAndDropped.aggregated)).toEqual(
			displayRows(healthyAndEmpty.aggregated),
		);
		expect(healthyAndDropped.aggregated).toHaveLength(1);
		expect(healthyAndDropped.aggregated[0]?.instanceId).toBe("synthetic-north");
		expect(requests).toHaveLength(4);
		expect(healthyAndDropped.coverage).toEqual({
			receivedCount: 2,
			acceptedCount: 1,
			rejectedCount: 1,
			metadataIncompleteCount: 0,
		});
		expect(healthyAndDropped.instances[1].coverage).toEqual({
			receivedCount: 1,
			acceptedCount: 0,
			rejectedCount: 1,
			metadataIncompleteCount: 0,
		});
	});

	it("control: a provider503 marks unknown coverage without losing another instance's usable rows", async () => {
		replies.set(north.baseUrl, {
			body: { message: "Synthetic provider unavailable" },
			status: 503,
		});
		const body = await search(
			{
				...query,
				filters: [{ instanceId: "synthetic-north" }, { instanceId: "synthetic-south" }],
			},
			2,
		);
		expect(body).toMatchObject({
			failedInstanceCount: 1,
			totalCount: 1,
			instances: [
				{ instanceId: "synthetic-north", success: false, data: [] },
				{ instanceId: "synthetic-south", success: true },
			],
		});
		expect(body.aggregated).toHaveLength(1);
		expect(body.aggregated[0]?.instanceId).toBe("synthetic-south");
		expect(body.coverage).toEqual({
			receivedCount: 1,
			acceptedCount: 1,
			rejectedCount: 0,
			metadataIncompleteCount: 0,
		});
		expect(body.instances[0]).not.toHaveProperty("coverage");
		expect(requests).toHaveLength(2);
	});

	it("control: a later explicit query recovers provider failure without replay or provider writes", async () => {
		replies.set(north.baseUrl, {
			body: { message: "Synthetic provider unavailable" },
			status: 503,
		});
		expect(await search()).toMatchObject({ failedInstanceCount: 1, aggregated: [], totalCount: 0 });
		expect(requests).toHaveLength(1);
		replies.set(north.baseUrl, { body: [release], status: 200 });
		expect(await search()).toMatchObject({ failedInstanceCount: 0, totalCount: 1 });
		expect(requests).toHaveLength(2);
	});

	it("control: foreign and disabled selected instances remain unknown without provider access", async () => {
		const body = await search(
			{
				...query,
				filters: [{ instanceId: "synthetic-foreign" }, { instanceId: "synthetic-disabled" }],
			},
			0,
		);
		expect(body).toMatchObject({
			failedInstanceCount: 2,
			totalCount: 0,
			instances: [],
			aggregated: [],
		});
		expect(JSON.stringify(body)).not.toContain("synthetic-foreign");
		expect(JSON.stringify(body)).not.toContain("synthetic-disabled");
		expect(requests).toEqual([]);
		expect(body).not.toHaveProperty("coverage");
	});
});
