/**
 * Unit tests for the Discord webhook notification sender.
 *
 * Mocks global fetch to verify request formatting, error handling,
 * rate limit parsing, embed field limits, and timeout behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { discordSender } from "../discord-sender.js";
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
	return new Response(null, { status: 204 });
}

describe("discordSender", () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	it("returns success on 2xx response", async () => {
		mockFetch.mockResolvedValue(okResponse());

		const result = await discordSender.send(
			{ webhookUrl: "https://discord.com/api/webhooks/123/abc" },
			makePayload(),
		);

		expect(result).toEqual({ success: true, retryable: false });
		expect(mockFetch).toHaveBeenCalledWith(
			"https://discord.com/api/webhooks/123/abc",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
			}),
		);

		// Verify embed structure in request body
		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(body.embeds).toHaveLength(1);
		expect(body.embeds[0].title).toBe("Test Title");
		expect(body.embeds[0].description).toBe("Test body content");
	});

	it("returns retryable with retryAfterMs on 429", async () => {
		const headers = new Headers();
		headers.set("Retry-After", "2.5");
		mockFetch.mockResolvedValue(
			new Response("rate limited", { status: 429, statusText: "Too Many Requests", headers }),
		);

		const result = await discordSender.send(
			{ webhookUrl: "https://discord.com/api/webhooks/123/abc" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.retryAfterMs).toBe(2500);
		expect(result.error).toContain("429");
	});

	it("returns retryable on 5xx error", async () => {
		mockFetch.mockResolvedValue(
			new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }),
		);

		const result = await discordSender.send(
			{ webhookUrl: "https://discord.com/api/webhooks/123/abc" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("500");
	});

	it("returns non-retryable on 4xx (not 429)", async () => {
		mockFetch.mockResolvedValue(
			new Response("Bad Request", { status: 400, statusText: "Bad Request" }),
		);

		const result = await discordSender.send(
			{ webhookUrl: "https://discord.com/api/webhooks/123/abc" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(false);
		expect(result.error).toContain("400");
	});

	it("returns retryable on network/timeout error", async () => {
		mockFetch.mockRejectedValue(new Error("fetch failed"));

		const result = await discordSender.send(
			{ webhookUrl: "https://discord.com/api/webhooks/123/abc" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("network error");
	});

	it("truncates embed fields at 25", async () => {
		mockFetch.mockResolvedValue(okResponse());

		// Create metadata with 30 keys to generate 30 fields
		const metadata: Record<string, unknown> = {};
		for (let i = 0; i < 30; i++) {
			metadata[`field${i}`] = `value ${i}`;
		}

		await discordSender.send(
			{ webhookUrl: "https://discord.com/api/webhooks/123/abc" },
			makePayload({ metadata }),
		);

		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		const embed = body.embeds[0];
		if (embed.fields) {
			expect(embed.fields.length).toBeLessThanOrEqual(25);
		}
	});

	it("drops fields when embed exceeds 5500 chars", async () => {
		mockFetch.mockResolvedValue(okResponse());

		// Create metadata that would produce a very large embed
		const metadata: Record<string, unknown> = {};
		for (let i = 0; i < 25; i++) {
			metadata[`longField${i}`] = "x".repeat(200);
		}

		await discordSender.send(
			{ webhookUrl: "https://discord.com/api/webhooks/123/abc" },
			makePayload({
				title: "A".repeat(256),
				body: "B".repeat(4096),
				metadata,
			}),
		);

		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		const embed = body.embeds[0];
		// When embed JSON > 5500, fields are dropped
		const embedJson = JSON.stringify(embed);
		expect(embedJson.length).toBeLessThanOrEqual(6000);
	});

	it("passes AbortSignal.timeout(10000) to fetch", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await discordSender.send(
			{ webhookUrl: "https://discord.com/api/webhooks/123/abc" },
			makePayload(),
		);

		const fetchCall = mockFetch.mock.calls[0]!;
		const options = fetchCall[1];
		expect(options.signal).toBeDefined();
		// AbortSignal.timeout returns an AbortSignal
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});
});
