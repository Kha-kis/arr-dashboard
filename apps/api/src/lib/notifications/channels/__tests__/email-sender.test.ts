/**
 * Unit tests for the Email (SMTP) notification sender.
 *
 * Mocks nodemailer to verify transport creation, email content
 * generation, pool reuse, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendMail = vi.fn();
const mockClose = vi.fn();

vi.mock("nodemailer", () => {
	return {
		default: {
			createTransport: vi.fn(() => ({ sendMail: mockSendMail, close: mockClose })),
		},
		createTransport: vi.fn(() => ({ sendMail: mockSendMail, close: mockClose })),
	};
});

import nodemailer from "nodemailer";
import { emailSender, closeAllTransports } from "../email-sender.js";
import type { NotificationPayload } from "../../types.js";

const mockCreateTransport = nodemailer.createTransport as ReturnType<typeof vi.fn>;

function makePayload(overrides?: Partial<NotificationPayload>): NotificationPayload {
	return {
		eventType: "HUNT_COMPLETED" as any,
		title: "Test Title",
		body: "Test body content",
		...overrides,
	};
}

const baseConfig = {
	host: "smtp.example.com",
	port: 587,
	secure: false,
	user: "user@example.com",
	password: "secret",
	from: "noreply@example.com",
	to: "admin@example.com",
};

describe("emailSender", () => {
	beforeEach(() => {
		mockSendMail.mockReset();
		mockClose.mockReset();
		mockCreateTransport.mockClear();
		// Clear the transport pool between tests
		closeAllTransports();
	});

	it("returns success when sendMail resolves", async () => {
		mockSendMail.mockResolvedValue({ messageId: "abc" });

		const result = await emailSender.send(baseConfig, makePayload());

		expect(result).toEqual({ success: true, retryable: false });
		expect(mockSendMail).toHaveBeenCalledOnce();
	});

	it("generates HTML body with title and body content", async () => {
		mockSendMail.mockResolvedValue({ messageId: "abc" });

		await emailSender.send(baseConfig, makePayload());

		const call = mockSendMail.mock.calls[0]![0];
		expect(call.html).toContain("Test Title");
		expect(call.html).toContain("Test body content");
		expect(call.subject).toBe("Test Title");
		expect(call.from).toBe("noreply@example.com");
		expect(call.to).toBe("admin@example.com");
	});

	it("includes metadata fields in email body", async () => {
		mockSendMail.mockResolvedValue({ messageId: "abc" });

		await emailSender.send(
			baseConfig,
			makePayload({ metadata: { instance: "Sonarr", count: 5 } }),
		);

		const call = mockSendMail.mock.calls[0]![0];
		expect(call.html).toContain("Sonarr");
		expect(call.html).toContain("5");
		expect(call.text).toContain("Sonarr");
		expect(call.text).toContain("5");
	});

	it("includes 'View Details' link when payload has url", async () => {
		mockSendMail.mockResolvedValue({ messageId: "abc" });

		await emailSender.send(
			baseConfig,
			makePayload({ url: "https://example.com/details" }),
		);

		const call = mockSendMail.mock.calls[0]![0];
		expect(call.html).toContain("View Details");
		expect(call.html).toContain("https://example.com/details");
		expect(call.text).toContain("https://example.com/details");
	});

	it("returns retryable on ECONNREFUSED error code", async () => {
		const error = new Error("Connection refused") as Error & { code?: string };
		error.code = "ECONNREFUSED";
		mockSendMail.mockRejectedValue(error);

		const result = await emailSender.send(baseConfig, makePayload());

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("Connection refused");
	});

	it("returns retryable on ETIMEDOUT error code", async () => {
		const error = new Error("Connection timed out") as Error & { code?: string };
		error.code = "ETIMEDOUT";
		mockSendMail.mockRejectedValue(error);

		const result = await emailSender.send(baseConfig, makePayload());

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.error).toContain("Connection timed out");
	});

	it("returns non-retryable on unknown error (no error code)", async () => {
		mockSendMail.mockRejectedValue(new Error("Authentication failed"));

		const result = await emailSender.send(baseConfig, makePayload());

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(false);
		expect(result.error).toContain("Authentication failed");
	});

	it("pool reuses transport for same config", async () => {
		mockSendMail.mockResolvedValue({ messageId: "abc" });

		await emailSender.send(baseConfig, makePayload());
		await emailSender.send(baseConfig, makePayload());

		expect(mockCreateTransport).toHaveBeenCalledTimes(1);
		expect(mockSendMail).toHaveBeenCalledTimes(2);
	});

	it("closeAllTransports clears the pool", async () => {
		mockSendMail.mockResolvedValue({ messageId: "abc" });

		await emailSender.send(baseConfig, makePayload());
		expect(mockCreateTransport).toHaveBeenCalledTimes(1);

		closeAllTransports();
		expect(mockClose).toHaveBeenCalled();

		await emailSender.send(baseConfig, makePayload());
		expect(mockCreateTransport).toHaveBeenCalledTimes(2);
	});
});
