/**
 * Unit tests for the Webhook channel notification sender.
 *
 * Mocks global fetch to verify request formatting, HMAC signing,
 * HTTP method configuration, custom headers, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { webhookSender } from "../webhook-sender.js";
import type { NotificationPayload } from "../../types.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makePayload(title = "Test"): NotificationPayload {
	return { eventType: "HUNT_COMPLETED" as any, title, body: "Body text" };
}

function okResponse() {
	return {
		ok: true,
		status: 200,
		headers: new Headers(),
		statusText: "OK",
	};
}

describe("webhookSender", () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	it("returns success on 200 response", async () => {
		mockFetch.mockResolvedValue(okResponse());

		const result = await webhookSender.send(
			{ url: "https://example.com/webhook" },
			makePayload(),
		);

		expect(result).toEqual({ success: true, retryable: false });
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it("sends correct JSON payload structure", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await webhookSender.send(
			{ url: "https://example.com/webhook" },
			makePayload("My Title"),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);

		expect(body).toHaveProperty("version");
		expect(body).toHaveProperty("timestamp");
		expect(body).toHaveProperty("event");
		expect(body).toHaveProperty("title", "My Title");
		expect(body).toHaveProperty("body", "Body text");
		expect(body).toHaveProperty("source", "arr-dashboard");
	});

	it("includes HMAC signature when secret is configured", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await webhookSender.send(
			{ url: "https://example.com/webhook", secret: "test-secret" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		const headers: Record<string, string> = call[1].headers;

		expect(headers["X-Webhook-Signature"]).toBeDefined();
		expect(headers["X-Webhook-Signature"]).toMatch(/^sha256=/);
		expect(headers["X-Webhook-Timestamp"]).toBeDefined();
	});

	it("does not include signature headers when no secret", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await webhookSender.send(
			{ url: "https://example.com/webhook" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		const headers: Record<string, string> = call[1].headers;

		expect(headers["X-Webhook-Signature"]).toBeUndefined();
		expect(headers["X-Webhook-Timestamp"]).toBeUndefined();
	});

	it("returns retryable on 429", async () => {
		const responseHeaders = new Headers();
		responseHeaders.set("Retry-After", "5");
		mockFetch.mockResolvedValue({
			ok: false,
			status: 429,
			statusText: "Too Many Requests",
			headers: responseHeaders,
		});

		const result = await webhookSender.send(
			{ url: "https://example.com/webhook" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("429");
	});

	it("returns retryable on 5xx", async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			headers: new Headers(),
		});

		const result = await webhookSender.send(
			{ url: "https://example.com/webhook" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("500");
	});

	it("returns non-retryable on 4xx", async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 400,
			statusText: "Bad Request",
			headers: new Headers(),
		});

		const result = await webhookSender.send(
			{ url: "https://example.com/webhook" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(false);
		expect(result.error).toContain("400");
	});

	it("returns retryable on network error", async () => {
		mockFetch.mockRejectedValue(new Error("Network connection refused"));

		const result = await webhookSender.send(
			{ url: "https://example.com/webhook" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("Network connection refused");
	});

	it("uses configured HTTP method", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await webhookSender.send(
			{ url: "https://example.com/webhook", method: "PUT" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		expect(call[1].method).toBe("PUT");
	});

	it("includes custom headers", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await webhookSender.send(
			{ url: "https://example.com/webhook", headers: { "X-Custom": "value" } },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		const headers: Record<string, string> = call[1].headers;

		expect(headers["X-Custom"]).toBe("value");
	});
});
