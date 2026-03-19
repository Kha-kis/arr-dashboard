/**
 * Unit tests for the ntfy.sh notification sender.
 *
 * Mocks global fetch to verify URL construction, header forwarding,
 * authorization token handling, click URL, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ntfySender } from "../ntfy-sender.js";
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

describe("ntfySender", () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	it("returns success on 200", async () => {
		mockFetch.mockResolvedValue(okResponse());

		const result = await ntfySender.send(
			{ serverUrl: "https://ntfy.sh", topic: "test" },
			makePayload(),
		);

		expect(result).toEqual({ success: true, retryable: false });
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it("sends to correct URL (serverUrl/topic)", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await ntfySender.send(
			{ serverUrl: "https://ntfy.sh", topic: "test" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		expect(call[0]).toBe("https://ntfy.sh/test");
	});

	it("includes X-Title header", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await ntfySender.send(
			{ serverUrl: "https://ntfy.sh", topic: "test" },
			makePayload({ title: "My Notification Title" }),
		);

		const call = mockFetch.mock.calls[0]!;
		const headers: Record<string, string> = call[1].headers;

		expect(headers["X-Title"]).toBe("My Notification Title");
	});

	it("includes X-Priority header", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await ntfySender.send(
			{ serverUrl: "https://ntfy.sh", topic: "test" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		const headers: Record<string, string> = call[1].headers;

		expect(headers["X-Priority"]).toBeDefined();
		expect(typeof headers["X-Priority"]).toBe("string");
	});

	it("includes X-Tags header", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await ntfySender.send(
			{ serverUrl: "https://ntfy.sh", topic: "test" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		const headers: Record<string, string> = call[1].headers;

		expect(headers["X-Tags"]).toBeDefined();
		expect(typeof headers["X-Tags"]).toBe("string");
	});

	it("includes Authorization header when token provided", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await ntfySender.send(
			{ serverUrl: "https://ntfy.sh", topic: "test", token: "tk_abc" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		const headers: Record<string, string> = call[1].headers;

		expect(headers["Authorization"]).toBe("Bearer tk_abc");
	});

	it("does not include Authorization when no token", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await ntfySender.send(
			{ serverUrl: "https://ntfy.sh", topic: "test" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		const headers: Record<string, string> = call[1].headers;

		expect(headers["Authorization"]).toBeUndefined();
	});

	it("includes X-Click header when payload has url", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await ntfySender.send(
			{ serverUrl: "https://ntfy.sh", topic: "test" },
			makePayload({ url: "https://example.com" }),
		);

		const call = mockFetch.mock.calls[0]!;
		const headers: Record<string, string> = call[1].headers;

		expect(headers["X-Click"]).toBe("https://example.com");
	});

	it("returns retryable on 429", async () => {
		mockFetch.mockResolvedValue(
			new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
		);

		const result = await ntfySender.send(
			{ serverUrl: "https://ntfy.sh", topic: "test" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("429");
	});

	it("returns retryable on network error", async () => {
		mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

		const result = await ntfySender.send(
			{ serverUrl: "https://ntfy.sh", topic: "test" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("ECONNREFUSED");
	});
});
