/**
 * Unit tests for the Browser Push (Web Push / VAPID) notification sender.
 *
 * Mocks web-push to verify VAPID setup, payload structure,
 * subscription expiry handling, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("web-push", () => ({
	default: {
		setVapidDetails: vi.fn(),
		sendNotification: vi.fn(),
	},
}));

import webpush from "web-push";
import { createBrowserPushSender } from "../browser-push-sender.js";
import type { NotificationPayload } from "../../types.js";

const mockSetVapidDetails = webpush.setVapidDetails as ReturnType<typeof vi.fn>;
const mockSendNotification = webpush.sendNotification as ReturnType<typeof vi.fn>;

function makePayload(overrides?: Partial<NotificationPayload>): NotificationPayload {
	return {
		eventType: "HUNT_COMPLETED" as any,
		title: "Test Title",
		body: "Test body content",
		...overrides,
	};
}

const pushConfig = {
	endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
	p256dh: "BNcRdreALR...",
	auth: "tBHItJ...",
};

describe("browserPushSender", () => {
	beforeEach(() => {
		mockSetVapidDetails.mockReset();
		mockSendNotification.mockReset();
	});

	it("createBrowserPushSender calls setVapidDetails with correct args", () => {
		createBrowserPushSender("vapidPub", "vapidPriv", "admin@example.com");

		expect(mockSetVapidDetails).toHaveBeenCalledWith(
			"mailto:admin@example.com",
			"vapidPub",
			"vapidPriv",
		);
	});

	it("returns success when sendNotification resolves", async () => {
		mockSendNotification.mockResolvedValue({ statusCode: 201 });

		const sender = createBrowserPushSender("vapidPub", "vapidPriv", "admin@example.com");
		const result = await sender.send(pushConfig, makePayload());

		expect(result).toEqual({ success: true, retryable: false });
		expect(mockSendNotification).toHaveBeenCalledOnce();
	});

	it("sends correct payload structure (title, body, url, eventType, metadata)", async () => {
		mockSendNotification.mockResolvedValue({ statusCode: 201 });

		const sender = createBrowserPushSender("vapidPub", "vapidPriv", "admin@example.com");
		await sender.send(
			pushConfig,
			makePayload({ url: "https://example.com", metadata: { key: "val" } }),
		);

		const call = mockSendNotification.mock.calls[0]!;
		const payload = JSON.parse(call[1]);

		expect(payload.title).toBe("Test Title");
		expect(payload.body).toBe("Test body content");
		expect(payload.url).toBe("https://example.com");
		expect(payload.eventType).toBe("HUNT_COMPLETED");
		expect(payload.metadata).toEqual({ key: "val" });
	});

	it("returns non-retryable on 410 Gone (subscription expired)", async () => {
		const error = new Error("Push failed") as Error & { statusCode?: number };
		error.statusCode = 410;
		mockSendNotification.mockRejectedValue(error);

		const sender = createBrowserPushSender("vapidPub", "vapidPriv", "admin@example.com");
		const result = await sender.send(pushConfig, makePayload());

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(false);
		expect(result.error).toContain("410");
	});

	it("returns retryable on 429", async () => {
		const error = new Error("Too Many Requests") as Error & { statusCode?: number };
		error.statusCode = 429;
		mockSendNotification.mockRejectedValue(error);

		const sender = createBrowserPushSender("vapidPub", "vapidPriv", "admin@example.com");
		const result = await sender.send(pushConfig, makePayload());

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("429");
	});

	it("returns retryable on 5xx (500, 503)", async () => {
		const error = new Error("Server Error") as Error & { statusCode?: number };
		error.statusCode = 503;
		mockSendNotification.mockRejectedValue(error);

		const sender = createBrowserPushSender("vapidPub", "vapidPriv", "admin@example.com");
		const result = await sender.send(pushConfig, makePayload());

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("503");
	});

	it("returns non-retryable on 4xx (400, 403)", async () => {
		const error = new Error("Bad Request") as Error & { statusCode?: number };
		error.statusCode = 400;
		mockSendNotification.mockRejectedValue(error);

		const sender = createBrowserPushSender("vapidPub", "vapidPriv", "admin@example.com");
		const result = await sender.send(pushConfig, makePayload());

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(false);
		expect(result.error).toContain("400");
	});

	it("returns retryable on network error (no statusCode)", async () => {
		mockSendNotification.mockRejectedValue(new Error("ECONNREFUSED"));

		const sender = createBrowserPushSender("vapidPub", "vapidPriv", "admin@example.com");
		const result = await sender.send(pushConfig, makePayload());

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("ECONNREFUSED");
	});
});
