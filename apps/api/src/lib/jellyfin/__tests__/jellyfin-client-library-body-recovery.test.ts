import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinClient } from "../jellyfin-client.js";

// Synthetic data only. These tests catch cursor advancement on failed reads,
// unbounded retries, partial-success exposure, and recovery outside library GETs.
const PRIVATE = "synthetic-private-body-sentinel";
const warn = vi.fn();
const log = { warn } as unknown as FastifyBaseLogger;
const movie = (id: number) => ({ Id: `item-${id}`, Name: PRIVATE, Type: "Movie" });
const page = (ids: number[], total = ids.length) => ({
	Items: ids.map(movie),
	TotalRecordCount: total,
});
const json = (body: unknown) =>
	new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

function brokenBody(
	error: unknown = new TypeError(PRIVATE, { cause: { code: "UND_ERR_SOCKET" } }),
) {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.error(error);
			},
		}),
		{ headers: { "Content-Type": "application/json" } },
	);
}

function stubPages(replies: Array<Response | Error | (() => Response)>) {
	const requests: URL[] = [];
	vi.stubGlobal("fetch", async (input: string) => {
		requests.push(new URL(input));
		const reply = replies[requests.length - 1];
		if (!reply) throw new Error("Unexpected additional provider request");
		if (reply instanceof Error) throw reply;
		return typeof reply === "function" ? reply() : reply;
	});
	return requests;
}

function cursors(requests: URL[]) {
	return requests.map((url) => [url.searchParams.get("StartIndex"), url.searchParams.get("Limit")]);
}

function client(signal?: AbortSignal) {
	return new JellyfinClient(
		"http://synthetic.test",
		PRIVATE,
		log,
		undefined,
		{},
		"JELLYFIN",
		signal,
	);
}

async function loopback(handle: (url: URL, reply: ServerResponse) => void) {
	const sockets = new Set<Socket>();
	const requests: URL[] = [];
	const server = createServer((request, reply) => {
		const url = new URL(request.url!, "http://synthetic.test");
		requests.push(url);
		handle(url, reply);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Loopback address required");
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		async close() {
			const closed = new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
			for (const socket of sockets) socket.destroy();
			await closed;
		},
	};
}

describe("Jellyfin canonical library body recovery", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it("recovers a real headers-flushed held-body deadline at the same cursor with a smaller page", async () => {
		const fixture = await loopback((url, reply) => {
			reply.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
			if (url.searchParams.get("Limit") === "1000") {
				reply.flushHeaders();
				return; // Own request deadline must stop this incomplete response body.
			}
			reply.end(
				JSON.stringify(url.searchParams.get("StartIndex") === "0" ? page([1, 2], 3) : page([3], 3)),
			);
		});
		const stages: string[] = [];
		try {
			const result = await new JellyfinClient(
				fixture.url,
				PRIVATE,
				log,
				200,
			).getLibraryItemsWithCoverage("user/id", "library/id", {
				includeItemTypes: "Movie,Series",
				onReadStage: (stage) => stages.push(stage),
			});
			expect(result).toMatchObject({
				items: [{ id: "item-1" }, { id: "item-2" }, { id: "item-3" }],
				expectedRawCount: 3,
				pagesAttempted: 2,
				pagesCompleted: 2,
				rawObserved: 3,
				reason: null,
			});
			expect(cursors(fixture.requests)).toEqual([
				["0", "1000"],
				["0", "500"],
				["2", "500"],
			]);
			expect(stages.slice(0, 4)).toEqual([
				"request-start",
				"headers-received",
				"body-read",
				"request-start",
			]);
			expect(stages.filter((stage) => stage === "page-accepted")).toHaveLength(2);
			expect(stages.at(-1)).toBe("items-mapped");
			for (const request of fixture.requests) {
				expect(request.pathname).toBe("/Users/user%2Fid/Items");
				expect(
					Object.fromEntries(
						[...request.searchParams].filter(([key]) => !["StartIndex", "Limit"].includes(key)),
					),
				).toEqual({
					ParentId: "library/id",
					Fields: "ProviderIds,DateCreated,ImageTags",
					Recursive: "true",
					CollapseBoxSetItems: "false",
					IncludeItemTypes: "Movie,Series",
				});
			}
			expect(warn.mock.calls).toEqual([
				[
					{
						category: "jellyfin-provider-read-failure",
						phase: "body",
						kind: "timeout",
						status: 200,
						elapsedMs: expect.any(Number),
						transportCode: null,
					},
					"Jellyfin provider read failed",
				],
			]);
			expect(JSON.stringify(warn.mock.calls)).not.toContain(PRIVATE);
		} finally {
			await fixture.close();
		}
	});

	it("stops real sustained held bodies at 125 without exposing rows", async () => {
		const fixture = await loopback((_url, reply) => {
			reply.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
			reply.flushHeaders();
		});
		try {
			const result = await new JellyfinClient(
				fixture.url,
				PRIVATE,
				log,
				200,
			).getLibraryItemsWithCoverage("user", "library");
			expect(result).toEqual({
				items: [],
				expectedRawCount: null,
				pagesAttempted: 1,
				pagesCompleted: 0,
				rawObserved: 0,
				reason: "page-failure",
			});
			expect(cursors(fixture.requests)).toEqual([
				["0", "1000"],
				["0", "500"],
				["0", "250"],
				["0", "125"],
			]);
			expect(
				warn.mock.calls.every(([fields]) => fields.phase === "body" && fields.kind === "timeout"),
			).toBe(true);
		} finally {
			await fixture.close();
		}
	});

	it("stops caller cancellation during a real held body without a retry", async () => {
		const controller = new AbortController();
		const fixture = await loopback((_url, reply) => {
			reply.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
			reply.flushHeaders();
		});
		try {
			const reading = new JellyfinClient(
				fixture.url,
				PRIVATE,
				log,
				1000,
				{},
				"JELLYFIN",
				controller.signal,
			).getLibraryItemsWithCoverage("user", "library", {
				onReadStage(stage) {
					if (stage === "body-read") controller.abort();
				},
			});
			await expect(reading).rejects.toThrow("Provider read cancelled.");
			expect(cursors(fixture.requests)).toEqual([["0", "1000"]]);
			expect(warn.mock.calls[0]?.[0]).toMatchObject({ phase: "body", kind: "aborted" });
		} finally {
			controller.abort();
			await fixture.close();
		}
	});

	it("preserves accepted rows and cursor through a later transport failure", async () => {
		const requests = stubPages([
			json(page([1], 3)),
			brokenBody(),
			json(page([2], 3)),
			json(page([3], 3)),
		]);
		const result = await client().getLibraryItemsWithCoverage("user", "library");
		expect(result).toMatchObject({
			reason: null,
			pagesAttempted: 3,
			pagesCompleted: 3,
			rawObserved: 3,
			expectedRawCount: 3,
			items: [{ id: "item-1" }, { id: "item-2" }, { id: "item-3" }],
		});
		expect(cursors(requests)).toEqual([
			["0", "1000"],
			["1", "1000"],
			["1", "500"],
			["2", "500"],
		]);
	});

	it("shares three reductions across the entire call and resets on the next call", async () => {
		const requests = stubPages([
			brokenBody(),
			json(page([1], 3)),
			brokenBody(),
			json(page([2], 3)),
			brokenBody(),
			json(page([3], 3)),
			brokenBody(),
			brokenBody(),
			brokenBody(),
			brokenBody(),
		]);
		const instance = client();
		expect(await instance.getLibraryItemsWithCoverage("user", "library")).toMatchObject({
			reason: null,
			pagesAttempted: 3,
			pagesCompleted: 3,
		});
		expect(await instance.getLibraryItemsWithCoverage("user", "library")).toMatchObject({
			items: [],
			reason: "page-failure",
			pagesAttempted: 1,
			pagesCompleted: 0,
		});
		expect(cursors(requests)).toEqual([
			["0", "1000"],
			["0", "500"],
			["1", "500"],
			["1", "250"],
			["2", "250"],
			["2", "125"],
			["0", "1000"],
			["0", "500"],
			["0", "250"],
			["0", "125"],
		]);
	});

	it("does not replenish reductions after accepted pages", async () => {
		const requests = stubPages([
			brokenBody(),
			json(page([1], 4)),
			brokenBody(),
			json(page([2], 4)),
			brokenBody(),
			json(page([3], 4)),
			brokenBody(),
		]);
		expect(await client().getLibraryItemsWithCoverage("user", "library")).toEqual({
			items: [],
			expectedRawCount: 4,
			pagesAttempted: 4,
			pagesCompleted: 3,
			rawObserved: 3,
			reason: "page-failure",
		});
		expect(cursors(requests).at(-1)).toEqual(["3", "125"]);
		expect(requests).toHaveLength(7);
	});

	it.each([
		["changed total", page([2], 3)],
		["duplicate accepted identity", page([1], 2)],
		["duplicate page identity", page([2, 2], 3)],
		["blank identity", { Items: [{ ...movie(2), Id: " " }], TotalRecordCount: 2 }],
		["premature empty", page([], 2)],
		["overrun", page([2, 3], 2)],
		[
			"oversized reduced page",
			{ Items: Array.from({ length: 501 }, (_, i) => movie(i + 2)), TotalRecordCount: 1000 },
		],
		["schema failure", { Items: [{ Id: "bad" }], TotalRecordCount: 2 }],
	] as const)("discards accepted rows after reduced-page %s", async (kind, body) => {
		const total =
			kind === "oversized reduced page" ? 1000 : kind === "duplicate page identity" ? 3 : 2;
		const requests = stubPages([json(page([1], total)), brokenBody(), json(body)]);
		expect(await client().getLibraryItemsWithCoverage("user", "library")).toEqual({
			items: [],
			expectedRawCount: total,
			pagesAttempted: 2,
			pagesCompleted: 1,
			rawObserved: 1,
			reason: "page-failure",
		});
		expect(cursors(requests)).toEqual([
			["0", "1000"],
			["1", "1000"],
			["1", "500"],
		]);
	});

	it.each([
		["request timeout", () => new DOMException(PRIVATE, "TimeoutError")],
		["request transport", () => new TypeError(PRIVATE)],
		["authentication", () => new Response(null, { status: 401 })],
		["authorization", () => new Response(null, { status: 403 })],
		["rate limit", () => new Response(null, { status: 429 })],
		["HTTP failure", () => new Response(null, { status: 503 })],
		["content type", () => new Response(PRIVATE, { headers: { "Content-Type": "text/html" } })],
		[
			"JSON syntax",
			() => new Response(`{${PRIVATE}`, { headers: { "Content-Type": "application/json" } }),
		],
		["schema", () => json({ Items: [{ Id: "bad" }], TotalRecordCount: 1 })],
		["unclassified body error", () => brokenBody(new Error(PRIVATE))],
		["body abort without own deadline", () => brokenBody(new DOMException(PRIVATE, "AbortError"))],
		["safe item ceiling", () => json(page([], 100001))],
	] as const)("does not adapt on %s", async (_kind, reply) => {
		const requests = stubPages([reply()]);
		expect(await client().getLibraryItemsWithCoverage("user", "library")).toMatchObject({
			items: [],
			reason: "page-failure",
			pagesAttempted: 1,
			pagesCompleted: 0,
		});
		expect(cursors(requests)).toEqual([["0", "1000"]]);
		expect(JSON.stringify(warn.mock.calls)).not.toContain(PRIVATE);
	});

	it("checks cancellation before recovery even when the body error looks retryable", async () => {
		const controller = new AbortController();
		const requests = stubPages([
			() => {
				controller.abort();
				return brokenBody();
			},
		]);
		await expect(
			client(controller.signal).getLibraryItemsWithCoverage("user", "library"),
		).rejects.toThrow("Provider read cancelled.");
		expect(requests).toHaveLength(1);
	});

	it.each(["identity", "on-deck", "episodes", "native", "mutation"] as const)(
		"does not adapt the %s path",
		async (kind) => {
			const requests = stubPages(
				kind === "native" ? [brokenBody(), brokenBody(), brokenBody()] : [brokenBody()],
			);
			const instance = client();
			if (kind === "identity") await expect(instance.getServerInfo()).rejects.toThrow();
			if (kind === "on-deck") await expect(instance.getResumeItems("user")).rejects.toThrow();
			if (kind === "episodes")
				expect(await instance.getEpisodesWithCoverage("user", "series")).toMatchObject({
					items: [],
					reason: "page-failure",
				});
			if (kind === "native")
				expect(await instance.getNativeLibraryItemsWithCoverage("library")).toMatchObject({
					items: [],
					reason: "page-failure",
				});
			if (kind === "mutation") await expect(instance.readMutationTarget("item")).rejects.toThrow();
			expect(requests).toHaveLength(kind === "native" ? 3 : 1);
			if (kind === "native")
				expect(cursors(requests)).toEqual([
					["0", "1000"],
					["0", "1000"],
					["0", "1000"],
				]);
		},
	);
});
