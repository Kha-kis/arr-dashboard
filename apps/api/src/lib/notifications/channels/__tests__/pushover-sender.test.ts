/**
 * Unit tests for the Pushover notification sender.
 *
 * Mocks global fetch to verify API URL, form body fields,
 * priority mapping, URL attachment, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { pushoverSender } from "../pushover-sender.js";
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
	return new Response(JSON.stringify({ status: 1 }), { status: 200, statusText: "OK" });
}

describe("pushoverSender", () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	it("returns success on 200", async () => {
		mockFetch.mockResolvedValue(okResponse());

		const result = await pushoverSender.send(
			{ userKey: "ukey123", apiToken: "atoken456" },
			makePayload(),
		);

		expect(result).toEqual({ success: true, retryable: false });
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it("sends to correct Pushover API URL", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await pushoverSender.send(
			{ userKey: "ukey123", apiToken: "atoken456" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		expect(call[0]).toBe("https://api.pushover.net/1/messages.json");
	});

	it("includes token and user in body", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await pushoverSender.send(
			{ userKey: "ukey123", apiToken: "atoken456" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);
		expect(body.token).toBe("atoken456");
		expect(body.user).toBe("ukey123");
	});

	it("sets html: 1 in body", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await pushoverSender.send(
			{ userKey: "ukey123", apiToken: "atoken456" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);
		expect(body.html).toBe(1);
	});

	it("maps ERROR/FAILED events to priority 1 (high)", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await pushoverSender.send(
			{ userKey: "ukey123", apiToken: "atoken456" },
			makePayload({ eventType: "HUNT_FAILED" as any }),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);
		expect(body.priority).toBe(1);
	});

	it("maps STARTUP events to priority -1 (low)", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await pushoverSender.send(
			{ userKey: "ukey123", apiToken: "atoken456" },
			makePayload({ eventType: "STARTUP" as any }),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);
		expect(body.priority).toBe(-1);
	});

	it("maps normal events to priority 0", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await pushoverSender.send(
			{ userKey: "ukey123", apiToken: "atoken456" },
			makePayload({ eventType: "HUNT_COMPLETED" as any }),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);
		expect(body.priority).toBe(0);
	});

	it("includes url and url_title when payload has url", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await pushoverSender.send(
			{ userKey: "ukey123", apiToken: "atoken456" },
			makePayload({ url: "https://example.com/details" }),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);
		expect(body.url).toBe("https://example.com/details");
		expect(body.url_title).toBe("View Details");
	});

	it("returns retryable on 429", async () => {
		mockFetch.mockResolvedValue(
			new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
		);

		const result = await pushoverSender.send(
			{ userKey: "ukey123", apiToken: "atoken456" },
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

		const result = await pushoverSender.send(
			{ userKey: "ukey123", apiToken: "atoken456" },
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

		const result = await pushoverSender.send(
			{ userKey: "ukey123", apiToken: "atoken456" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(false);
		expect(result.error).toContain("400");
	});

	it("returns retryable on network error", async () => {
		mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

		const result = await pushoverSender.send(
			{ userKey: "ukey123", apiToken: "atoken456" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("ECONNREFUSED");
	});
});
