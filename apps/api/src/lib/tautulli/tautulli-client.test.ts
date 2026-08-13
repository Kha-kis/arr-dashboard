import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTautulliClient, TautulliClient } from "./tautulli-client.js";

const warn = vi.fn();
const log = { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;

function success(data: unknown): Response {
	return new Response(JSON.stringify({ response: { result: "success", message: null, data } }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function historyPage(start: number, count: number, total = 3) {
	return {
		data: Array.from({ length: count }, (_, index) => ({
			row_id: start + index + 1,
			rating_key: String(start + index + 100),
			parent_rating_key: "0",
			grandparent_rating_key: "0",
			title: "Sensitive title",
			grandparent_title: "Sensitive title",
			media_type: "movie",
			user: "Sensitive user",
			date: 1,
		})),
		recordsFiltered: total,
		recordsTotal: total,
	};
}

afterEach(() => vi.unstubAllGlobals());

describe("TautulliClient", () => {
	it("keeps API-key query authentication when optional HTTP Basic auth is used", async () => {
		const fetchMock = vi.fn().mockResolvedValue(success({ tautulli_version: "2.15.1" }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new TautulliClient("http://tautulli.example", "api-key-value", log, 10_000, {
			Authorization: "Basic cHJveHk6c2VjcmV0",
		});

		await expect(client.getInfo()).resolves.toEqual({ tautulli_version: "2.15.1" });

		const [requestUrl, request] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(new URL(requestUrl).searchParams.get("apikey")).toBe("api-key-value");
		expect(new URL(requestUrl).searchParams.get("cmd")).toBe("get_tautulli_info");
		expect(new Headers(request.headers).get("authorization")).toBe("Basic cHJveHk6c2VjcmV0");
	});

	it("rejects a non-Tautulli instance before decrypting its credentials", () => {
		const decrypt = vi.fn();
		const nonTautulliInstance = {
			id: "plex-instance",
			baseUrl: "http://plex.example",
			encryptedApiKey: "encrypted-plex-key",
			encryptionIv: "plex-iv",
			service: "PLEX",
		};

		expect(() =>
			createTautulliClient({ decrypt } as never, nonTautulliInstance as never, log),
		).toThrow("Instance is not a Tautulli service");
		expect(decrypt).not.toHaveBeenCalled();
	});

	it("returns explicit incomplete pagination metadata when its bounded history scan stops early", async () => {
		const fetchMock = vi.fn().mockResolvedValue(success(historyPage(0, 2)));
		vi.stubGlobal("fetch", fetchMock);
		const client = new TautulliClient("http://tautulli.example", "api-key-value", log);

		await expect(client.getHistorySnapshot({ pageSize: 2, maxPages: 1 })).resolves.toMatchObject({
			items: expect.arrayContaining([expect.objectContaining({ row_id: 1 })]),
			recordsFiltered: 3,
			recordsTotal: 3,
			complete: false,
			incompleteReason: "page_limit_reached",
		});
	});

	it("marks a fully fetched history snapshot complete", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(success(historyPage(0, 2)))
			.mockResolvedValueOnce(success(historyPage(2, 1)));
		vi.stubGlobal("fetch", fetchMock);
		const client = new TautulliClient("http://tautulli.example", "api-key-value", log);

		await expect(client.getHistorySnapshot({ pageSize: 2, maxPages: 2 })).resolves.toMatchObject({
			items: expect.arrayContaining([expect.objectContaining({ row_id: 3 })]),
			recordsFiltered: 3,
			recordsTotal: 3,
			complete: true,
		});
	});

	it("marks a history snapshot incomplete when an upstream page repeats row IDs", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(success(historyPage(0, 2)))
			.mockResolvedValueOnce(success(historyPage(0, 2)));
		vi.stubGlobal("fetch", fetchMock);
		const client = new TautulliClient("http://tautulli.example", "api-key-value", log);

		await expect(client.getHistorySnapshot({ pageSize: 2, maxPages: 2 })).resolves.toMatchObject({
			items: expect.arrayContaining([expect.objectContaining({ row_id: 1 })]),
			complete: false,
			incompleteReason: "duplicate_row_id",
		});
	});

	it("marks a history snapshot incomplete when an upstream row has no stable ID", async () => {
		const page = historyPage(0, 2);
		const missingIdPage = {
			...page,
			data: page.data.map((item, index) => (index === 1 ? { ...item, row_id: undefined } : item)),
		};
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(success(missingIdPage)));
		const client = new TautulliClient("http://tautulli.example", "api-key-value", log);

		await expect(client.getHistorySnapshot({ pageSize: 2, maxPages: 1 })).resolves.toMatchObject({
			complete: false,
			incompleteReason: "missing_row_id",
		});
	});

	it("uses a stable row-id ordering declaration for each paginated history request", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(success(historyPage(0, 2)))
			.mockResolvedValueOnce(success(historyPage(2, 1)));
		vi.stubGlobal("fetch", fetchMock);
		const client = new TautulliClient("http://tautulli.example", "api-key-value", log);

		await client.getHistorySnapshot({ pageSize: 2, maxPages: 2 });

		const firstRequest = new URL(fetchMock.mock.calls[0]![0]);
		expect(JSON.parse(firstRequest.searchParams.get("json_data")!)).toMatchObject({
			columns: [{ data: "row_id", orderable: true, searchable: false }],
			order: [{ column: 0, dir: "asc" }],
			start: 0,
			length: 2,
		});
	});

	it("rejects null or blank history totals instead of coercing them to zero", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(success({ data: [], recordsFiltered: null, recordsTotal: "" })),
		);
		const client = new TautulliClient("http://tautulli.example", "api-key-value", log);

		await expect(client.getHistory()).rejects.toThrow();
	});

	it("uses the documented user watch-time request and response contract", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			success([
				{ query_days: 1, total_plays: 2, total_time: 120 },
				{ query_days: 0, total_plays: 8, total_time: 960 },
			]),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new TautulliClient("http://tautulli.example", "api-key-value", log);

		await expect(client.getUserWatchTimeStats("42", "1,0")).resolves.toEqual([
			{ query_days: 1, total_plays: 2, total_time: 120 },
			{ query_days: 0, total_plays: 8, total_time: 960 },
		]);
		const requestUrl = new URL(fetchMock.mock.calls[0]![0]);
		expect(requestUrl.searchParams.get("user_id")).toBe("42");
		expect(requestUrl.searchParams.get("query_days")).toBe("1,0");
	});

	it("requires a user id for watch-time statistics", () => {
		const client = new TautulliClient("http://tautulli.example", "api-key-value", log);

		expect(() => client.getUserWatchTimeStats(" ")).toThrow(
			"Tautulli user watch-time stats require a user id",
		);
	});

	it("normalizes upstream failures without exposing sensitive values", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 502 })));
		const client = new TautulliClient("http://tautulli.example", "api-key-value", log);

		await expect(client.getMetadata("sensitive-rating-key")).rejects.toThrow("HTTP 502");
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ status: 502, cmd: "get_metadata" }),
			expect.any(String),
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("api-key-value");
		expect(JSON.stringify(warn.mock.calls)).not.toContain("sensitive-rating-key");
	});
});
