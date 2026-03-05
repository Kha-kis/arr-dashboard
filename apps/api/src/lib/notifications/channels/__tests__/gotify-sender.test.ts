/**
 * Unit tests for the Gotify notification sender.
 *
 * Mocks global fetch to verify URL construction, auth headers,
 * Markdown extras, priority mapping, click URL, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { gotifySender } from "../gotify-sender.js";
import type { NotificationPayload } from "../../types.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makePayload(overrides?: Partial<NotificationPayload>): NotificationPayload {
	return {
		eventType: "HUNT_COMPLETED" as any,
		title: "Test Title",
		body: "Test body content",
		...overrides,
	};
}

function okResponse() {
	return new Response("{}", { status: 200, statusText: "OK" });
}

describe("gotifySender", () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	it("returns success on 200", async () => {
		mockFetch.mockResolvedValue(okResponse());

		const result = await gotifySender.send(
			{ serverUrl: "https://gotify.example.com", appToken: "Atk123" },
			makePayload(),
		);

		expect(result).toEqual({ success: true, retryable: false });
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it("sends to correct URL ({serverUrl}/message)", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await gotifySender.send(
			{ serverUrl: "https://gotify.example.com", appToken: "Atk123" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		expect(call[0]).toBe("https://gotify.example.com/message");
	});

	it("strips trailing slash from serverUrl", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await gotifySender.send(
			{ serverUrl: "https://gotify.example.com/", appToken: "Atk123" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		expect(call[0]).toBe("https://gotify.example.com/message");
	});

	it("includes X-Gotify-Key header with appToken", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await gotifySender.send(
			{ serverUrl: "https://gotify.example.com", appToken: "Atk123" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		const headers: Record<string, string> = call[1].headers;
		expect(headers["X-Gotify-Key"]).toBe("Atk123");
	});

	it("includes Markdown content type in extras", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await gotifySender.send(
			{ serverUrl: "https://gotify.example.com", appToken: "Atk123" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);
		expect(body.extras["client::display"]).toEqual({ contentType: "text/markdown" });
	});

	it("maps ERROR/FAILED events to priority 8", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await gotifySender.send(
			{ serverUrl: "https://gotify.example.com", appToken: "Atk123" },
			makePayload({ eventType: "HUNT_FAILED" as any }),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);
		expect(body.priority).toBe(8);
	});

	it("maps FOUND/REMOVED events to priority 5", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await gotifySender.send(
			{ serverUrl: "https://gotify.example.com", appToken: "Atk123" },
			makePayload({ eventType: "HUNT_FOUND" as any }),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);
		expect(body.priority).toBe(5);
	});

	it("maps STARTUP events to priority 2", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await gotifySender.send(
			{ serverUrl: "https://gotify.example.com", appToken: "Atk123" },
			makePayload({ eventType: "STARTUP" as any }),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);
		expect(body.priority).toBe(2);
	});

	it("default priority is 4", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await gotifySender.send(
			{ serverUrl: "https://gotify.example.com", appToken: "Atk123" },
			makePayload({ eventType: "HUNT_COMPLETED" as any }),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);
		expect(body.priority).toBe(4);
	});

	it("includes click URL in extras when payload has url", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await gotifySender.send(
			{ serverUrl: "https://gotify.example.com", appToken: "Atk123" },
			makePayload({ url: "https://example.com/details" }),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);
		expect(body.extras["client::notification"]).toEqual({ click: { url: "https://example.com/details" } });
	});

	it("returns retryable on 429", async () => {
		mockFetch.mockResolvedValue(
			new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
		);

		const result = await gotifySender.send(
			{ serverUrl: "https://gotify.example.com", appToken: "Atk123" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("429");
	});

	it("returns retryable on 5xx", async () => {
		mockFetch.mockResolvedValue(
			new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }),
		);

		const result = await gotifySender.send(
			{ serverUrl: "https://gotify.example.com", appToken: "Atk123" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("500");
	});

	it("returns non-retryable on 4xx", async () => {
		mockFetch.mockResolvedValue(
			new Response("bad request", { status: 400, statusText: "Bad Request" }),
		);

		const result = await gotifySender.send(
			{ serverUrl: "https://gotify.example.com", appToken: "Atk123" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(false);
		expect(result.error).toContain("400");
	});

	it("returns retryable on network error", async () => {
		mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

		const result = await gotifySender.send(
			{ serverUrl: "https://gotify.example.com", appToken: "Atk123" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("ECONNREFUSED");
	});
});
