import { afterEach, describe, expect, it, vi } from "vitest";
import {
	asRecord,
	boundedInteger,
	pageParams,
	SABNZBD_MAX_RESPONSE_BYTES,
	sabCall,
	text,
} from "./client.js";

function jsonResponse(body: string, headers: Record<string, string> = {}) {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "application/json", ...headers },
	});
}

describe("SABnzbd API client", () => {
	afterEach(() => vi.restoreAllMocks());

	it("sends API requests once with JSON output and rejects redirects", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse('{"queue":{}}'));
		await sabCall("http://sab.example/base/", "secret-api-key", { mode: "queue", limit: "50" });
		const [input, init] = fetchMock.mock.calls[0]!;
		const sent = new URL(String(input));
		expect(sent.pathname).toBe("/base/api");
		expect(sent.searchParams.get("output")).toBe("json");
		expect(sent.searchParams.get("apikey")).toBe("secret-api-key");
		expect(init?.redirect).toBe("error");
		expect(new Headers(init?.headers).has("authorization")).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("forwards only the optional same-request proxy authorization and still refuses redirects", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse('{"queue":{}}'));
		await sabCall(
			"http://sab.example/base",
			"api-key",
			{ mode: "queue" },
			{
				headers: { Authorization: "Basic synthetic" },
			},
		);
		const [, init] = fetchMock.mock.calls[0]!;
		expect(new Headers(init?.headers).get("authorization")).toBe("Basic synthetic");
		expect(init?.redirect).toBe("error");
	});

	it("does not surface credential-bearing fetch errors", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new TypeError("redirect from http://sab/api?apikey=secret-api-key"),
		);
		await expect(
			sabCall("http://sab.example", "secret-api-key", { mode: "queue" }),
		).rejects.toThrow("Could not connect to SABnzbd");
	});

	it("rejects non-JSON and non-object responses", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
		);
		await expect(
			sabCall("http://sab.example", "secret-api-key", { mode: "queue" }),
		).rejects.toThrow("unsupported response format");
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse("[]"));
		await expect(
			sabCall("http://sab.example", "secret-api-key", { mode: "queue" }),
		).rejects.toThrow("invalid response envelope");
	});

	it("rejects API-level errors without exposing provider text", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse('{"error":"API Key Incorrect: secret-api-key"}'),
		);
		await expect(
			sabCall("http://sab.example", "secret-api-key", { mode: "queue" }),
		).rejects.toThrow("SABnzbd rejected the request");
	});

	it("caps response size before JSON parsing", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse("x".repeat(SABNZBD_MAX_RESPONSE_BYTES + 1)),
		);
		await expect(
			sabCall("http://sab.example", "secret-api-key", { mode: "queue" }),
		).rejects.toThrow("exceeded the supported size");
	});

	it("bounds queue and history page parameters", () => {
		expect(pageParams("-10", "10000")).toEqual({ start: 0, limit: 100 });
		expect(pageParams("not-a-number", "0")).toEqual({ start: 0, limit: 1 });
		expect(boundedInteger(3.2, 0, 100)).toBe(0);
	});

	it("uses safe projections for unknown records", () => {
		expect(asRecord(null)).toEqual({});
		expect(asRecord([])).toEqual({});
		expect(text({ toString: () => "secret" })).toBe("");
	});
});
