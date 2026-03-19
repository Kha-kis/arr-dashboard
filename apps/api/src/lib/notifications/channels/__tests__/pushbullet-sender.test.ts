/**
 * Unit tests for the Pushbullet notification sender.
 *
 * Mocks global fetch to verify API URL, Access-Token header,
 * push type selection, metadata formatting, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { pushbulletSender } from "../pushbullet-sender.js";
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

describe("pushbulletSender", () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	it("returns success on 200", async () => {
		mockFetch.mockResolvedValue(okResponse());

		const result = await pushbulletSender.send(
			{ apiToken: "o.abc123" },
			makePayload(),
		);

		expect(result).toEqual({ success: true, retryable: false });
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it("sends correct URL to Pushbullet API", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await pushbulletSender.send(
			{ apiToken: "o.abc123" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		expect(call[0]).toBe("https://api.pushbullet.com/v2/pushes");
	});

	it("includes Access-Token header", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await pushbulletSender.send(
			{ apiToken: "o.abc123" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		const headers: Record<string, string> = call[1].headers;
		expect(headers["Access-Token"]).toBe("o.abc123");
	});

	it("sends 'link' type when payload has url", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await pushbulletSender.send(
			{ apiToken: "o.abc123" },
			makePayload({ url: "https://example.com" }),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);
		expect(body.type).toBe("link");
		expect(body.url).toBe("https://example.com");
	});

	it("sends 'note' type when payload has no url", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await pushbulletSender.send(
			{ apiToken: "o.abc123" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);
		expect(body.type).toBe("note");
	});

	it("includes metadata fields in body text", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await pushbulletSender.send(
			{ apiToken: "o.abc123" },
			makePayload({ metadata: { instance: "Sonarr", count: 5 } }),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);
		expect(body.body).toContain("Sonarr");
		expect(body.body).toContain("5");
	});

	it("returns retryable on 429", async () => {
		mockFetch.mockResolvedValue(
			new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
		);

		const result = await pushbulletSender.send(
			{ apiToken: "o.abc123" },
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

		const result = await pushbulletSender.send(
			{ apiToken: "o.abc123" },
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

		const result = await pushbulletSender.send(
			{ apiToken: "o.abc123" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(false);
		expect(result.error).toContain("400");
	});

	it("returns retryable on network error", async () => {
		mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

		const result = await pushbulletSender.send(
			{ apiToken: "o.abc123" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("ECONNREFUSED");
	});
});
