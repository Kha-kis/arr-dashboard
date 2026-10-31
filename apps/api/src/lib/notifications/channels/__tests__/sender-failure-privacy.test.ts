import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationFailureError } from "../../failure-diagnostics.js";
import type { ChannelSender, NotificationPayload } from "../../types.js";
import { createBrowserPushSender } from "../browser-push-sender.js";
import { discordSender } from "../discord-sender.js";
import { closeAllTransports, emailSender } from "../email-sender.js";
import { gotifySender } from "../gotify-sender.js";
import { ntfySender } from "../ntfy-sender.js";
import { pushbulletSender } from "../pushbullet-sender.js";
import { pushoverSender } from "../pushover-sender.js";
import { slackSender } from "../slack-sender.js";
import { telegramSender } from "../telegram-sender.js";
import { webhookSender } from "../webhook-sender.js";

const { sendMail, sendNotification, createTransport } = vi.hoisted(() => {
	const sendMail = vi.fn();
	return {
		sendMail,
		sendNotification: vi.fn(),
		createTransport: vi.fn(() => ({ sendMail, close: vi.fn() })),
	};
});
vi.mock("nodemailer", () => ({ default: { createTransport } }));
vi.mock("web-push", () => ({
	default: { setVapidDetails: vi.fn(), sendNotification },
}));

const SECRET = "synthetic-credential-DO-NOT-RETAIN";
const PRIVATE_URL = `https://private-user:${SECRET}@private.example.invalid/recipient/${SECRET}`;
const payload: NotificationPayload = {
	eventType: "SYSTEM_STARTUP",
	title: "Synthetic notification",
	body: "Synthetic body",
};
const mockFetch = vi.fn();
const httpSenders: Array<{
	name: string;
	sender: ChannelSender;
	config: Record<string, unknown>;
}> = [
	{ name: "Discord", sender: discordSender, config: { webhookUrl: PRIVATE_URL } },
	{ name: "Gotify", sender: gotifySender, config: { serverUrl: PRIVATE_URL, appToken: SECRET } },
	{
		name: "ntfy",
		sender: ntfySender,
		config: { serverUrl: PRIVATE_URL, topic: SECRET, token: SECRET },
	},
	{ name: "Pushbullet", sender: pushbulletSender, config: { apiToken: SECRET } },
	{ name: "Pushover", sender: pushoverSender, config: { apiToken: SECRET, userKey: SECRET } },
	{ name: "Slack", sender: slackSender, config: { webhookUrl: PRIVATE_URL } },
	{ name: "Telegram", sender: telegramSender, config: { botToken: SECRET, chatId: SECRET } },
	{ name: "Webhook", sender: webhookSender, config: { url: PRIVATE_URL, secret: SECRET } },
];
const httpFailures = [
	{ status: 401, category: "authentication", retryable: false },
	{ status: 403, category: "authentication", retryable: false },
	{ status: 429, category: "rate-limited", retryable: true },
	{ status: 500, category: "provider-unavailable", retryable: true },
	{ status: 503, category: "provider-unavailable", retryable: true },
	{ status: 400, category: "rejected", retryable: false },
] as const;
const networkFailures = [
	{ name: "Error", category: "transport" },
	{ name: "AbortError", category: "timeout" },
	{ name: "TimeoutError", category: "timeout" },
] as const;

function expectPrivateDiagnostic(value: unknown): void {
	const serialized =
		value instanceof Error
			? `${value.message} ${value.stack} ${JSON.stringify(value)}`
			: JSON.stringify(value);
	expect(serialized).not.toContain(SECRET);
	expect(serialized).not.toContain("private.example.invalid");
	expect(serialized).not.toContain("private-user");
}

async function expectPrivateTestFailure(
	sender: ChannelSender,
	config: Record<string, unknown>,
	category: string,
): Promise<void> {
	const error = await sender.test(config).then(
		() => undefined,
		(error: unknown) => error,
	);
	expectPrivateDiagnostic(error);
	expect(error).toBeInstanceOf(NotificationFailureError);
	expect(error).toMatchObject({ category });
	expect(error).not.toHaveProperty("cause");
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFetch.mockReset();
	vi.stubGlobal("fetch", mockFetch);
	closeAllTransports();
});
afterEach(() => {
	closeAllTransports();
	vi.unstubAllGlobals();
});

describe.each(httpSenders)("$name sender diagnostics", ({ sender, config }) => {
	it.each(httpFailures)(
		"conceals provider body and statusText on HTTP $status",
		async ({ status, category, retryable }) => {
			mockFetch.mockResolvedValue(
				new Response(JSON.stringify({ description: PRIVATE_URL, errors: [SECRET] }), {
					status,
					statusText: SECRET,
				}),
			);
			const result = await sender.send(config, payload);
			expectPrivateDiagnostic(result);
			expect(result).toMatchObject({ success: false, retryable, failureCategory: category });
			expect(result.error).toBeTruthy();
		},
	);
	it.each(httpFailures)(
		"test throws a safe typed failure on HTTP $status",
		async ({ status, category }) => {
			mockFetch.mockResolvedValue(
				new Response(JSON.stringify({ description: PRIVATE_URL, errors: [SECRET] }), {
					status,
					statusText: SECRET,
				}),
			);
			await expectPrivateTestFailure(sender, config, category);
		},
	);
	it.each(networkFailures)(
		"conceals $name throwable message and cause",
		async ({ name, category }) => {
			const error = new Error(PRIVATE_URL, { cause: { credentials: SECRET } });
			error.name = name;
			mockFetch.mockRejectedValue(error);
			const result = await sender.send(config, payload);
			expectPrivateDiagnostic(result);
			expect(result).toMatchObject({ success: false, retryable: true, failureCategory: category });
		},
	);
	it.each(networkFailures)(
		"test replaces $name throwable with a safe typed failure",
		async ({ name, category }) => {
			const error = new Error(PRIVATE_URL, { cause: { credentials: SECRET } });
			error.name = name;
			mockFetch.mockRejectedValue(error);
			await expectPrivateTestFailure(sender, config, category);
		},
	);
});

describe.each(httpSenders)("$name failed response cleanup", ({ name, sender, config }) => {
	const failures = [
		{ status: 401, category: "authentication", retryable: false },
		...(name === "Telegram" ? [] : [{ status: 429, category: "rate-limited", retryable: true }]),
	];

	function failureResponse(status: number, rejectCancellation = false) {
		const lifecycle = { cancelled: false, chunksRead: 0 };
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					lifecycle.chunksRead++;
					controller.enqueue(new TextEncoder().encode(PRIVATE_URL));
					controller.close();
				},
				cancel() {
					lifecycle.cancelled = true;
					if (rejectCancellation) throw new Error(PRIVATE_URL);
				},
			},
			{ highWaterMark: 0 },
		);
		return { lifecycle, response: new Response(stream, { status, statusText: SECRET }) };
	}

	it.each(failures)(
		"cancels unread HTTP $status body after send failure",
		async ({ status, category, retryable }) => {
			const { lifecycle, response } = failureResponse(status);
			mockFetch.mockResolvedValue(response);
			const result = await sender.send(config, payload);
			expectPrivateDiagnostic(result);
			expect(result).toMatchObject({ success: false, retryable, failureCategory: category });
			expect(lifecycle).toEqual({ cancelled: true, chunksRead: 0 });
		},
	);
	it.each(failures)(
		"cancels unread HTTP $status body after test failure",
		async ({ status, category }) => {
			const { lifecycle, response } = failureResponse(status);
			mockFetch.mockResolvedValue(response);
			await expectPrivateTestFailure(sender, config, category);
			expect(lifecycle).toEqual({ cancelled: true, chunksRead: 0 });
		},
	);
	it("preserves send classification when body cancellation rejects", async () => {
		const { lifecycle, response } = failureResponse(401, true);
		mockFetch.mockResolvedValue(response);
		const result = await sender.send(config, payload);
		expectPrivateDiagnostic(result);
		expect(result).toMatchObject({
			success: false,
			retryable: false,
			failureCategory: "authentication",
		});
		expect(lifecycle).toEqual({ cancelled: true, chunksRead: 0 });
	});
	it("preserves test classification when body cancellation rejects", async () => {
		const { lifecycle, response } = failureResponse(401, true);
		mockFetch.mockResolvedValue(response);
		await expectPrivateTestFailure(sender, config, "authentication");
		expect(lifecycle).toEqual({ cancelled: true, chunksRead: 0 });
	});
});

describe("Telegram rate-limit body consumption", () => {
	it.each([
		{ name: "null body", body: null },
		{ name: "string body", body: SECRET },
		{ name: "null parameters", body: { parameters: null } },
		{ name: "string parameters", body: { parameters: SECRET } },
		{ name: "numeric string retry_after", body: { parameters: { retry_after: "30" } } },
		{ name: "boolean retry_after", body: { parameters: { retry_after: true } } },
		{ name: "array retry_after", body: { parameters: { retry_after: [30] } } },
	])("keeps HTTP429 rate-limited with no delay for $name", async ({ body }) => {
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify(body), { status: 429, statusText: SECRET }),
		);
		const result = await telegramSender.send({ botToken: SECRET, chatId: SECRET }, payload);
		expectPrivateDiagnostic(result);
		expect(result).toMatchObject({
			success: false,
			retryable: true,
			failureCategory: "rate-limited",
		});
		expect(result.retryAfterMs).toBeUndefined();
	});
	it("test retains rate-limit category when the HTTP429 JSON body is null", async () => {
		mockFetch.mockResolvedValue(new Response("null", { status: 429, statusText: SECRET }));
		await expectPrivateTestFailure(
			telegramSender,
			{ botToken: SECRET, chatId: SECRET },
			"rate-limited",
		);
	});
	it.each(["send", "test"] as const)("consumes retry JSON in the %s path", async (method) => {
		let consumed = false;
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						consumed = true;
						controller.enqueue(
							new TextEncoder().encode(
								JSON.stringify({ description: PRIVATE_URL, parameters: { retry_after: 30 } }),
							),
						);
						controller.close();
					},
					cancel() {
						cancelled = true;
					},
				},
				{ highWaterMark: 0 },
			),
			{ status: 429 },
		);
		mockFetch.mockResolvedValue(response);
		const config = { botToken: SECRET, chatId: SECRET };
		if (method === "send") {
			const result = await telegramSender.send(config, payload);
			expectPrivateDiagnostic(result);
			expect(result).toMatchObject({
				success: false,
				retryable: true,
				failureCategory: "rate-limited",
				retryAfterMs: 30000,
			});
		} else {
			await expectPrivateTestFailure(telegramSender, config, "rate-limited");
		}
		expect(consumed).toBe(true);
		expect(cancelled).toBe(false);
	});
});

describe("provider retry delays", () => {
	it.each(httpSenders.filter(({ name }) => ["Discord", "Slack", "Webhook"].includes(name)))(
		"preserves $name Retry-After without leaking provider text",
		async ({ sender, config }) => {
			mockFetch.mockResolvedValue(
				new Response(SECRET, {
					status: 429,
					statusText: SECRET,
					headers: { "Retry-After": "2.5" },
				}),
			);
			const result = await sender.send(config, payload);
			expectPrivateDiagnostic(result);
			expect(result).toMatchObject({
				success: false,
				retryable: true,
				failureCategory: "rate-limited",
				retryAfterMs: 2500,
			});
		},
	);
	it("preserves Telegram retry_after without leaking the description", async () => {
		mockFetch.mockResolvedValue(
			new Response(JSON.stringify({ description: PRIVATE_URL, parameters: { retry_after: 30 } }), {
				status: 429,
				statusText: SECRET,
			}),
		);
		const result = await telegramSender.send({ botToken: SECRET, chatId: SECRET }, payload);
		expectPrivateDiagnostic(result);
		expect(result).toMatchObject({
			success: false,
			retryable: true,
			failureCategory: "rate-limited",
			retryAfterMs: 30000,
		});
	});
});

describe("browser push diagnostics", () => {
	const config = { endpoint: PRIVATE_URL, p256dh: SECRET, auth: SECRET };
	const sender = createBrowserPushSender("synthetic-public", SECRET, "synthetic@example.invalid");
	const failures = [
		...httpFailures,
		{ status: 410, category: "subscription-expired", retryable: false },
	] as const;
	it.each(failures)(
		"conceals push provider failure on HTTP $status",
		async ({ status, category, retryable }) => {
			sendNotification.mockRejectedValue(
				Object.assign(new Error(PRIVATE_URL), { statusCode: status, body: SECRET }),
			);
			const result = await sender.send(config, payload);
			expectPrivateDiagnostic(result);
			expect(result).toMatchObject({ success: false, retryable, failureCategory: category });
		},
	);
	it.each(failures)("test safely classifies HTTP $status", async ({ status, category }) => {
		sendNotification.mockRejectedValue(
			Object.assign(new Error(PRIVATE_URL), { statusCode: status, body: SECRET }),
		);
		await expectPrivateTestFailure(sender, config, category);
	});
	it.each(networkFailures)("conceals push $name throwable", async ({ name, category }) => {
		const error = new Error(PRIVATE_URL);
		error.name = name;
		sendNotification.mockRejectedValue(error);
		const result = await sender.send(config, payload);
		expectPrivateDiagnostic(result);
		expect(result).toMatchObject({ success: false, retryable: true, failureCategory: category });
	});
	it.each(networkFailures)("test safely classifies push $name", async ({ name, category }) => {
		const error = new Error(PRIVATE_URL);
		error.name = name;
		sendNotification.mockRejectedValue(error);
		await expectPrivateTestFailure(sender, config, category);
	});
});

describe("SMTP diagnostics", () => {
	const config = {
		host: "synthetic.example.invalid",
		port: 587,
		secure: false,
		user: SECRET,
		password: SECRET,
		from: "synthetic@example.invalid",
		to: "synthetic@example.invalid",
	};
	const failures = [
		{ code: "EAUTH", category: "authentication", retryable: false },
		{ code: "ETIMEDOUT", category: "timeout", retryable: true },
		{ code: "ECONNREFUSED", category: "transport", retryable: true },
		{ code: "ENOTFOUND", category: "transport", retryable: true },
		{ code: "ESOCKET", category: "transport", retryable: true },
		{ code: "ECONNRESET", category: "transport", retryable: true },
		{ code: SECRET, category: "unknown", retryable: false },
		{ code: undefined, category: "unknown", retryable: false },
	] as const;
	it.each(failures)(
		"conceals SMTP throwable with code $code",
		async ({ code, category, retryable }) => {
			sendMail.mockRejectedValue(
				Object.assign(new Error(`EAUTH authentication failed ${PRIVATE_URL}`), { code }),
			);
			const result = await emailSender.send(config, payload);
			expectPrivateDiagnostic(result);
			expect(result).toMatchObject({ success: false, retryable, failureCategory: category });
		},
	);
	it.each(failures)("test safely classifies SMTP code $code", async ({ code, category }) => {
		sendMail.mockRejectedValue(Object.assign(new Error(PRIVATE_URL), { code }));
		await expectPrivateTestFailure(emailSender, config, category);
	});
});
