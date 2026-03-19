/**
 * Unit tests for the Slack incoming webhook notification sender.
 *
 * Mocks global fetch to verify Block Kit payload structure, color coding,
 * text truncation, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { slackSender } from "../slack-sender.js";
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
	return new Response("ok", { status: 200, statusText: "OK" });
}

describe("slackSender", () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	it("returns success on 200", async () => {
		mockFetch.mockResolvedValue(okResponse());

		const result = await slackSender.send(
			{ webhookUrl: "https://hooks.slack.com/services/T00/B00/abc" },
			makePayload(),
		);

		expect(result).toEqual({ success: true, retryable: false });
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it("sends Block Kit payload with header and section blocks", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await slackSender.send(
			{ webhookUrl: "https://hooks.slack.com/services/T00/B00/abc" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);

		expect(body).toHaveProperty("blocks");
		expect(Array.isArray(body.blocks)).toBe(true);

		const blockTypes = body.blocks.map((b: Record<string, unknown>) => b.type);
		expect(blockTypes).toContain("header");
		expect(blockTypes).toContain("section");
	});

	it("includes color attachment", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await slackSender.send(
			{ webhookUrl: "https://hooks.slack.com/services/T00/B00/abc" },
			makePayload(),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);

		expect(body).toHaveProperty("attachments");
		expect(Array.isArray(body.attachments)).toBe(true);
		expect(body.attachments[0]).toHaveProperty("color");
		expect(typeof body.attachments[0].color).toBe("string");
	});

	it("uses red color for FAILED events", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await slackSender.send(
			{ webhookUrl: "https://hooks.slack.com/services/T00/B00/abc" },
			makePayload({ eventType: "HUNT_FAILED" as any }),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);

		expect(body.attachments[0].color).toBe("#e74c3c");
	});

	it("uses green color for COMPLETED events", async () => {
		mockFetch.mockResolvedValue(okResponse());

		await slackSender.send(
			{ webhookUrl: "https://hooks.slack.com/services/T00/B00/abc" },
			makePayload({ eventType: "HUNT_COMPLETED" as any }),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);

		expect(body.attachments[0].color).toBe("#2ecc71");
	});

	it("truncates body at 3000 chars", async () => {
		mockFetch.mockResolvedValue(okResponse());

		const longBody = "x".repeat(5000);

		await slackSender.send(
			{ webhookUrl: "https://hooks.slack.com/services/T00/B00/abc" },
			makePayload({ body: longBody }),
		);

		const call = mockFetch.mock.calls[0]!;
		const body = JSON.parse(call[1].body);

		const sectionBlock = body.blocks.find(
			(b: Record<string, unknown>) => b.type === "section" && (b.text as any)?.type === "mrkdwn",
		);
		expect(sectionBlock).toBeDefined();
		expect((sectionBlock.text as any).text.length).toBeLessThanOrEqual(3000);
	});

	it("returns retryable on 429", async () => {
		mockFetch.mockResolvedValue(
			new Response("rate limited", { status: 429, statusText: "Too Many Requests", headers: {} }),
		);

		const result = await slackSender.send(
			{ webhookUrl: "https://hooks.slack.com/services/T00/B00/abc" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("429");
	});

	it("returns non-retryable on 4xx", async () => {
		mockFetch.mockResolvedValue(
			new Response("bad request", { status: 400, statusText: "Bad Request" }),
		);

		const result = await slackSender.send(
			{ webhookUrl: "https://hooks.slack.com/services/T00/B00/abc" },
			makePayload(),
		);

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(false);
		expect(result.error).toContain("400");
	});
});
