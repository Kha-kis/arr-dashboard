/**
 * Tests for streamLibraryItems — the streaming JSON consumer that replaces
 * the SDK's buffer-then-parse `getAll()` for the bulk library-sync path
 * (issue #427).
 *
 * Coverage:
 * - Yields each top-level array element as a separate object
 * - Handles chunked input where boundaries fall mid-object
 * - Throws on HTTP error status (4xx/5xx)
 * - Throws on malformed JSON
 * - Filters non-object top-level values (defensive — real arr endpoints
 *   return arrays-of-objects, but we should never yield a primitive)
 */

import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ServiceInstance } from "../../../lib/prisma.js";
import type { ArrClientFactory } from "../client-factory.js";
import { streamLibraryItems } from "../library-stream.js";

const INSTANCE_ID = "instance-1";

function makeMockInstance(service: "SONARR" | "RADARR" | "LIDARR" | "READARR") {
	return {
		id: INSTANCE_ID,
		label: `Test ${service}`,
		service,
		baseUrl: "http://localhost:8989",
		encryptedApiKey: "enc-key",
		encryptionIv: "iv",
	} as ServiceInstance & { service: typeof service };
}

function makeMockLog(): FastifyBaseLogger {
	return {
		level: "debug",
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
		trace: vi.fn(),
		silent: vi.fn(),
		child: vi.fn(() => makeMockLog()),
	} as unknown as FastifyBaseLogger;
}

/** Build a Response whose body is a stream of UTF-8 chunks. */
function streamingResponse(chunks: string[], status = 200): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const c of chunks) controller.enqueue(encoder.encode(c));
			controller.close();
		},
	});
	return new Response(stream, { status });
}

function makeFactory(response: Response | Response[]): ArrClientFactory {
	const queue = Array.isArray(response) ? [...response] : [response];
	return {
		rawRequest: vi.fn().mockImplementation(async () => {
			return queue.shift() ?? new Response("", { status: 500 });
		}),
	} as unknown as ArrClientFactory;
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of gen) out.push(item);
	return out;
}

describe("streamLibraryItems", () => {
	it("yields each top-level array element of the JSON response", async () => {
		const body = JSON.stringify([
			{ id: 1, title: "A" },
			{ id: 2, title: "B" },
			{ id: 3, title: "C" },
		]);
		const factory = makeFactory(streamingResponse([body]));
		const log = makeMockLog();

		const items = await collect(streamLibraryItems(factory, makeMockInstance("LIDARR"), log));

		expect(items).toHaveLength(3);
		expect(items[0]).toMatchObject({ id: 1, title: "A" });
		expect(items[2]).toMatchObject({ id: 3, title: "C" });
	});

	it("parses correctly when chunks split mid-object", async () => {
		const body = JSON.stringify([
			{ id: 1, name: "Artist One" },
			{ id: 2, name: "Artist Two" },
		]);
		// Chunk every 7 bytes so boundaries fall mid-string and mid-object.
		const chunks: string[] = [];
		for (let i = 0; i < body.length; i += 7) {
			chunks.push(body.slice(i, i + 7));
		}
		expect(chunks.length).toBeGreaterThan(2);

		const factory = makeFactory(streamingResponse(chunks));
		const items = await collect(
			streamLibraryItems(factory, makeMockInstance("LIDARR"), makeMockLog()),
		);

		expect(items).toHaveLength(2);
		expect(items[1]).toMatchObject({ id: 2, name: "Artist Two" });
	});

	it("throws on HTTP error status with a bounded body preview", async () => {
		const factory = makeFactory(streamingResponse(["Internal Server Error"], 500));
		const log = makeMockLog();

		await expect(
			collect(streamLibraryItems(factory, makeMockInstance("LIDARR"), log)),
		).rejects.toThrow(/HTTP 500/);
	});

	it("throws on malformed JSON", async () => {
		const factory = makeFactory(streamingResponse(['[{"id": 1, "bro']));
		const log = makeMockLog();

		await expect(
			collect(streamLibraryItems(factory, makeMockInstance("LIDARR"), log)),
		).rejects.toThrow();
	});

	it("uses the correct endpoint path per service", async () => {
		// Verify we hit /api/v1/artist for Lidarr (matches the SDK's getAll
		// path for issue #427's affected client).
		const factory = makeFactory(streamingResponse(["[]"]));
		await collect(streamLibraryItems(factory, makeMockInstance("LIDARR"), makeMockLog()));

		expect(factory.rawRequest).toHaveBeenCalledWith(
			expect.objectContaining({ service: "LIDARR" }),
			"/api/v1/artist",
			expect.objectContaining({ method: "GET" }),
		);
	});

	it("uses /api/v3/series for Sonarr and /api/v3/movie for Radarr", async () => {
		const factory = makeFactory([streamingResponse(["[]"]), streamingResponse(["[]"])]);
		await collect(streamLibraryItems(factory, makeMockInstance("SONARR"), makeMockLog()));
		await collect(streamLibraryItems(factory, makeMockInstance("RADARR"), makeMockLog()));

		expect(factory.rawRequest).toHaveBeenNthCalledWith(
			1,
			expect.anything(),
			"/api/v3/series",
			expect.anything(),
		);
		expect(factory.rawRequest).toHaveBeenNthCalledWith(
			2,
			expect.anything(),
			"/api/v3/movie",
			expect.anything(),
		);
	});

	it("skips non-object top-level values (defensive — primitives in an array)", async () => {
		// Real *arr endpoints never return mixed arrays, but be defensive: we
		// only emit Records, not numbers/strings/nulls. This guards against a
		// future endpoint shape change yielding garbage.
		const body = JSON.stringify([{ id: 1, title: "A" }, 42, "skip me", null]);
		const factory = makeFactory(streamingResponse([body]));
		const items = await collect(
			streamLibraryItems(factory, makeMockInstance("LIDARR"), makeMockLog()),
		);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ id: 1, title: "A" });
	});

	it("yields nothing for an empty array without error", async () => {
		const factory = makeFactory(streamingResponse(["[]"]));
		const items = await collect(
			streamLibraryItems(factory, makeMockInstance("READARR"), makeMockLog()),
		);
		expect(items).toEqual([]);
	});

	it("honors options.path override for non-default endpoints (album/book)", async () => {
		// Hunt-executor streams /api/v1/album on a LIDARR instance; verify the
		// path override reaches factory.rawRequest unchanged.
		const factory = makeFactory(streamingResponse(["[]"]));
		await collect(
			streamLibraryItems(factory, makeMockInstance("LIDARR"), makeMockLog(), {
				path: "/api/v1/album",
			}),
		);

		expect(factory.rawRequest).toHaveBeenCalledWith(
			expect.anything(),
			"/api/v1/album",
			expect.objectContaining({ method: "GET" }),
		);
	});

	// ========================================================================
	// Consumer-abort cleanup (issue #427 review-feedback)
	// ========================================================================
	//
	// streamLibraryItems' finally block calls response.body.cancel() so that
	// when the caller aborts early (e.g., a sync transaction rolls back after
	// 100 of 50k items), the HTTP connection to the *arr instance is closed
	// rather than left dangling. A regression that drops cancel() would leak
	// connections under partial-consumption — invisible in unit tests, real
	// pressure on the *arr server under load.

	it("cancels the response body when the consumer breaks out of for-await early", async () => {
		// Spy on body.cancel directly. The underlying ReadableStream's
		// `cancel` callback only fires for in-flight streams; once close()
		// has been signaled the callback no longer runs even though
		// body.cancel() resolves cleanly. What we care about is whether the
		// generator's finally CALLS body.cancel() — the signal-of-intent.
		// Spying on the method captures that intent regardless of underlying
		// stream state, which is exactly what we want this regression test
		// to assert.
		const response = new Response(
			'[{"id":1,"title":"A"},{"id":2,"title":"B"},{"id":3,"title":"C"}]',
		);
		const cancelSpy = vi.spyOn(response.body!, "cancel");
		const factory = makeFactory(response);

		let yielded = 0;
		for await (const _ of streamLibraryItems(factory, makeMockInstance("LIDARR"), makeMockLog())) {
			yielded++;
			if (yielded === 1) break; // abort after first item
		}

		expect(yielded).toBe(1);
		expect(cancelSpy).toHaveBeenCalled();
	});

	it("cancels the response body when the consumer throws inside for-await", async () => {
		const response = new Response('[{"id":1},{"id":2},{"id":3}]');
		const cancelSpy = vi.spyOn(response.body!, "cancel");
		const factory = makeFactory(response);

		await expect(async () => {
			for await (const _ of streamLibraryItems(
				factory,
				makeMockInstance("LIDARR"),
				makeMockLog(),
			)) {
				throw new Error("consumer-side abort");
			}
		}).rejects.toThrow(/consumer-side abort/);

		expect(cancelSpy).toHaveBeenCalled();
	});
});
