/**
 * Unit tests for the Telegram Bot API notification sender.
 *
 * Mocks global fetch to verify message formatting, HTML escaping,
 * rate limit parsing, truncation, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { telegramSender } from "../telegram-sender.js";
import type { NotificationPayload } from "../../types.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makePayload(overrides?: Partial<NotificationPayload>): NotificationPayload {
	return {
		eventType: "HUNT_COMPLETED" as NotificationPayload["eventType"],
		title: "Test Title",
		body: "Test body content",
		...overrides,
	};
}

function okResponse() {
	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("telegramSender", () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	it("returns success on 2xx response", async () => {
		mockFetch.mockResolvedValue(okResponse());

		const result = await telegramSender.send(
			{ botToken: "123:ABC", chatId: "456" },
			makePayload(),
		);

		expect(result).toEqual({ success: true, retryable: false });
		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.telegram.org/bot123:ABC/sendMessage",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
			}),
		);

		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(body.chat_id).toBe("456");
		expect(body.parse_mode).toBe("HTML");
		expect(body.text).toContain("<b>Test Title</b>");
		expect(body.text).toContain("Test body content");
	});

	it("returns retryable with retryAfterMs on 429", async () => {
		mockFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: false,
					description: "Too Many Requests",
					parameters: { retry_after: 30 },
				}),
				{ status: 429 },
			),
		);

		const result = await telegramSender.send(
			{ botToken: "123:ABC", chatId: "456" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.retryAfterMs).toBe(30000);
		expect(result.error).toContain("429");
	});

	it("escapes HTML special characters in title and body", async () => {
		mockFetch.mockResolvedValue(okResponse());

		const result = await telegramSender.send(
			{ botToken: "123:ABC", chatId: "456" },
			makePayload({
				title: '<script>alert("xss")</script>',
				body: 'Tom & Jerry <> "quotes" \'apos\'',
			}),
		);

		expect(result.success).toBe(true);

		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		const text: string = body.text;

		expect(text).toContain("&lt;script&gt;");
		expect(text).toContain("&amp;");
		expect(text).toContain("&lt;&gt;");
		expect(text).toContain("&quot;");
		expect(text).toContain("&#39;");
		expect(text).not.toContain("<script>");
	});

	it("truncates messages exceeding 4000 chars", async () => {
		mockFetch.mockResolvedValue(okResponse());

		const result = await telegramSender.send(
			{ botToken: "123:ABC", chatId: "456" },
			makePayload({ body: "x".repeat(5000) }),
		);

		expect(result.success).toBe(true);

		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		const text: string = body.text;
		expect(text.length).toBeLessThanOrEqual(4100);
		expect(text).toContain("(truncated)");
	});

	it("returns retryable on 5xx error", async () => {
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ ok: false }), { status: 502, statusText: "Bad Gateway" }),
		);

		const result = await telegramSender.send(
			{ botToken: "123:ABC", chatId: "456" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
	});

	it("returns non-retryable on 4xx (not 429)", async () => {
		mockFetch.mockResolvedValue(
			new Response(
				JSON.stringify({ ok: false, description: "Bad Request: chat not found" }),
				{ status: 400 },
			),
		);

		const result = await telegramSender.send(
			{ botToken: "123:ABC", chatId: "456" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(false);
		expect(result.error).toContain("400");
	});
});
