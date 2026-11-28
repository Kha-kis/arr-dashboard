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

	it("disables file and URL access on the SMTP transport", async () => {
		mockSendMail.mockResolvedValue({ messageId: "abc" });

		await emailSender.send(baseConfig, makePayload());

		expect(mockCreateTransport).toHaveBeenCalledWith(
			expect.objectContaining({
				disableFileAccess: true,
				disableUrlAccess: true,
			}),
		);
	});

	it("includes metadata fields in email body", async () => {
		mockSendMail.mockResolvedValue({ messageId: "abc" });

		await emailSender.send(baseConfig, makePayload({ metadata: { instance: "Sonarr", count: 5 } }));

		const call = mockSendMail.mock.calls[0]![0];
		expect(call.html).toContain("Sonarr");
		expect(call.html).toContain("5");
		expect(call.text).toContain("Sonarr");
		expect(call.text).toContain("5");
	});

	it("includes 'View Details' link when payload has url", async () => {
		mockSendMail.mockResolvedValue({ messageId: "abc" });

		await emailSender.send(baseConfig, makePayload({ url: "https://example.com/details" }));

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
		expect(result.failureCategory).toBe("transport");
	});

	it("returns retryable on ETIMEDOUT error code", async () => {
		const error = new Error("Connection timed out") as Error & { code?: string };
		error.code = "ETIMEDOUT";
		mockSendMail.mockRejectedValue(error);

		const result = await emailSender.send(baseConfig, makePayload());

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(true);
		expect(result.failureCategory).toBe("timeout");
	});

	it("returns non-retryable on unknown error (no error code)", async () => {
		mockSendMail.mockRejectedValue(new Error("Authentication failed"));

		const result = await emailSender.send(baseConfig, makePayload());

		expect(result.success).toBe(false);
		expect(result.retryable).toBe(false);
		expect(result.failureCategory).toBe("unknown");
	});

	describe.each([
		{ code: "ETLS", responseCode: undefined, category: "transport" },
		{ code: "EENVELOPE", responseCode: 550, category: "rejected" },
		{ code: "EMESSAGE", responseCode: 552, category: "rejected" },
		{ code: "EENVELOPE", responseCode: 450, category: "rejected" },
		{ code: "EENVELOPE", responseCode: undefined, category: "unknown" },
		{ code: "EMESSAGE", responseCode: "552", category: "unknown" },
		{ code: "EMESSAGE", responseCode: Number.NaN, category: "unknown" },
		{ code: "EMESSAGE", responseCode: 552.5, category: "unknown" },
		{ code: "EENVELOPE", responseCode: 250, category: "unknown" },
		{ code: "EMESSAGE", responseCode: 600, category: "unknown" },
		{ code: "UNRECOGNIZED", responseCode: 550, category: "unknown" },
	])("SMTP $code / $responseCode", ({ code, responseCode, category }) => {
		const privateText = "synthetic-private-smtp-recipient-and-secret";
		const messages: Record<string, string> = {
			transport: "Network delivery failed. Check connectivity, TLS and proxy settings.",
			rejected: "Provider rejected delivery. Check channel settings and recipient permissions.",
			unknown: "Delivery was not confirmed. Check channel settings and provider availability.",
		};

		it("classifies a send failure without changing retry eligibility or exposing SMTP text", async () => {
			mockSendMail.mockRejectedValue(
				Object.assign(new Error(privateText), { code, responseCode, response: privateText }),
			);

			const result = await emailSender.send(baseConfig, makePayload());

			expect(result).toEqual({
				success: false,
				retryable: false,
				failureCategory: category,
				error: messages[category],
			});
			expect(JSON.stringify(result)).not.toContain(privateText);
		});

		it("classifies a test failure without propagating SMTP text or a raw cause", async () => {
			mockSendMail.mockRejectedValue(
				Object.assign(new Error(privateText), { code, responseCode, response: privateText }),
			);

			let failure: unknown;
			try {
				await emailSender.test(baseConfig);
			} catch (err) {
				failure = err;
			}

			expect(failure).toBeInstanceOf(Error);
			expect(failure).toMatchObject({ category, message: messages[category] });
			expect(failure).not.toHaveProperty("cause");
			expect(JSON.stringify(failure)).not.toContain(privateText);
		});
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
