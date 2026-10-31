import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinClient } from "../jellyfin-client.js";

const log = { warn: vi.fn() } as unknown as FastifyBaseLogger;
const pageStages = [
	"request-start",
	"headers-received",
	"body-read",
	"validation",
	"page-accepted",
];

function response(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
	});
}

function movie(index: number) {
	return { Id: `private-item-${index}`, Name: "private-title", Type: "Movie" };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("Jellyfin canonical library read progress", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("accepts page one before held page two and maps only after complete pagination", async () => {
		const secondStarted = deferred<void>();
		const second = deferred<Response>();
		const stages: string[] = [];
		const requests: URL[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			requests.push(new URL(url));
			if (requests.length === 1) return response({ Items: [movie(1)], TotalRecordCount: 2 });
			secondStarted.resolve();
			return await second.promise;
		});
		const client = new JellyfinClient("http://synthetic.test", "private-token", log);
		const reading = client.getLibraryItemsWithCoverage("private-user", "private-library", {
			includeItemTypes: "Movie",
			onReadStage: (stage: string) => stages.push(stage),
		});
		try {
			await secondStarted.promise;
			expect(stages).toEqual([...pageStages, "request-start"]);
		} finally {
			second.resolve(response({ Items: [movie(2)], TotalRecordCount: 2 }));
		}
		const result = await reading;
		expect(result).toMatchObject({
			items: [{ id: "private-item-1" }, { id: "private-item-2" }],
			expectedRawCount: 2,
			pagesAttempted: 2,
			pagesCompleted: 2,
			rawObserved: 2,
			reason: null,
		});
		expect(stages).toEqual([...pageStages, ...pageStages, "items-mapped"]);
		expect(requests.map((url) => url.searchParams.get("StartIndex"))).toEqual(["0", "1"]);
		expect(requests.map((url) => url.searchParams.get("Limit"))).toEqual(["1000", "1000"]);
		expect(requests.every((url) => url.searchParams.get("IncludeItemTypes") === "Movie")).toBe(
			true,
		);
	});

	it("reports headers and body entry before a held JSON body is consumed", async () => {
		const bodyStarted = deferred<void>();
		const body = deferred<void>();
		const stages: string[] = [];
		const reply = new Response(
			new ReadableStream<Uint8Array>(
				{
					async pull(controller) {
						bodyStarted.resolve();
						await body.promise;
						controller.enqueue(
							new TextEncoder().encode(JSON.stringify({ Items: [movie(1)], TotalRecordCount: 1 })),
						);
						controller.close();
					},
				},
				{ highWaterMark: 0 },
			),
			{ headers: { "Content-Type": "application/json" } },
		);
		vi.stubGlobal("fetch", async () => reply);
		const client = new JellyfinClient("http://synthetic.test", "private-token", log);
		const reading = client.getLibraryItemsWithCoverage("private-user", "private-library", {
			onReadStage: (stage: string) => stages.push(stage),
		});
		try {
			await bodyStarted.promise;
			expect(stages).toEqual(["request-start", "headers-received", "body-read"]);
		} finally {
			body.resolve();
		}
		await expect(reading).resolves.toMatchObject({ reason: null });
		expect(stages).toEqual([...pageStages, "items-mapped"]);
	});

	it.each([
		["schema", { Items: [{ Id: "private-invalid" }], TotalRecordCount: 1 }],
		["duplicate", { Items: [movie(1), movie(1)], TotalRecordCount: 2 }],
		["blank identity", { Items: [{ ...movie(1), Id: " " }], TotalRecordCount: 1 }],
		["cardinality", { Items: [movie(1)], TotalRecordCount: 0 }],
	] as const)("observes validation but never accepts a %s failure", async (_kind, body) => {
		const stages: string[] = [];
		vi.stubGlobal("fetch", async () => response(body));
		const client = new JellyfinClient("http://synthetic.test", "private-token", log);
		const result = await client.getLibraryItemsWithCoverage("private-user", "private-library", {
			onReadStage: (stage: string) => stages.push(stage),
		});
		expect(result).toMatchObject({ items: [], pagesCompleted: 0, reason: "page-failure" });
		expect(stages).toEqual(["request-start", "headers-received", "body-read", "validation"]);
	});

	it.each([
		["changed total", { Items: [movie(2)], TotalRecordCount: 3 }],
		["repeated identity", { Items: [movie(1)], TotalRecordCount: 2 }],
	] as const)(
		"does not accept a second page with %s or expose partial rows",
		async (_kind, body) => {
			const stages: string[] = [];
			let requests = 0;
			vi.stubGlobal("fetch", async () =>
				response(++requests === 1 ? { Items: [movie(1)], TotalRecordCount: 2 } : body),
			);
			const client = new JellyfinClient("http://synthetic.test", "private-token", log);
			const result = await client.getLibraryItemsWithCoverage("private-user", "private-library", {
				onReadStage: (stage: string) => stages.push(stage),
			});
			expect(result).toMatchObject({
				items: [],
				pagesAttempted: 2,
				pagesCompleted: 1,
				rawObserved: 1,
				reason: "page-failure",
			});
			expect(stages).toEqual([
				...pageStages,
				"request-start",
				"headers-received",
				"body-read",
				"validation",
			]);
			expect(requests).toBe(2);
		},
	);

	it("retains the same successful result when every stage observer throws", async () => {
		vi.stubGlobal("fetch", async () => response({ Items: [movie(1)], TotalRecordCount: 1 }));
		const client = new JellyfinClient("http://synthetic.test", "private-token", log);
		const ordinary = await client.getLibraryItemsWithCoverage("private-user", "private-library");
		const observed: unknown[][] = [];
		const result = await client.getLibraryItemsWithCoverage("private-user", "private-library", {
			onReadStage: (...args: string[]) => {
				observed.push(args);
				throw new Error("private-observer-failure");
			},
		});
		expect(result).toEqual(ordinary);
		expect(observed).toEqual([...pageStages, "items-mapped"].map((stage) => [stage]));
	});

	it.each([false, true])(
		"preserves caller cancellation with throwing observer = %s",
		async (throwing) => {
			const controller = new AbortController();
			const observed: string[] = [];
			let requests = 0;
			vi.stubGlobal("fetch", async () => {
				requests++;
				controller.abort();
				throw new DOMException("private-cancellation", "AbortError");
			});
			const client = new JellyfinClient(
				"http://synthetic.test",
				"private-token",
				log,
				undefined,
				{},
				"JELLYFIN",
				controller.signal,
			);
			await expect(
				client.getLibraryItemsWithCoverage("private-user", "private-library", {
					onReadStage: (stage: string) => {
						observed.push(stage);
						if (throwing) throw new Error("private-observer-failure");
					},
				}),
			).rejects.toThrow("Provider read cancelled.");
			expect(observed).toEqual(["request-start"]);
			expect(requests).toBe(1);
		},
	);

	it("does not observe or dispatch a pre-cancelled read", async () => {
		const controller = new AbortController();
		controller.abort();
		const stages: string[] = [];
		let requests = 0;
		vi.stubGlobal("fetch", async () => {
			requests++;
			return response({});
		});
		const client = new JellyfinClient(
			"http://synthetic.test",
			"private-token",
			log,
			undefined,
			{},
			"JELLYFIN",
			controller.signal,
		);
		await expect(
			client.getLibraryItemsWithCoverage("private-user", "private-library", {
				onReadStage: (stage: string) => stages.push(stage),
			}),
		).rejects.toThrow("Provider read cancelled.");
		expect(stages).toEqual([]);
		expect(requests).toBe(0);
	});
});
