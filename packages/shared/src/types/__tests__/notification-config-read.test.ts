import { describe, expect, it } from "vitest";
import {
	channelConfigSchemaMap,
	NOTIFICATION_CONFIG_PRIVATE_FIELDS,
	notificationChannelConfigReadSchema,
} from "../notifications";

const marker = "••••••••";
// Literal contract, independently copied from the pre-change API privacy policy.
const privateFields = {
	DISCORD: ["webhookUrl"],
	SLACK: ["webhookUrl"],
	TELEGRAM: ["botToken"],
	EMAIL: ["password"],
	BROWSER_PUSH: ["endpoint", "p256dh", "auth"],
	PUSHBULLET: ["apiToken"],
	PUSHOVER: ["userKey", "apiToken"],
	GOTIFY: ["serverUrl", "appToken"],
	NTFY: ["serverUrl", "token"],
	WEBHOOK: ["url", "headers", "secret"],
};
const redacted = {
	DISCORD: { webhookUrl: marker },
	SLACK: { webhookUrl: marker },
	TELEGRAM: { botToken: marker, chatId: "synthetic-chat" },
	EMAIL: {
		host: "smtp.synthetic.invalid",
		port: 587,
		secure: false,
		user: "synthetic-user",
		password: marker,
		from: "from@synthetic.invalid",
		to: "to@synthetic.invalid",
	},
	BROWSER_PUSH: { endpoint: marker, p256dh: marker, auth: marker },
	PUSHBULLET: { apiToken: marker },
	PUSHOVER: { userKey: marker, apiToken: marker },
	GOTIFY: { serverUrl: marker, appToken: marker },
	NTFY: { serverUrl: marker, topic: "synthetic-topic", token: marker },
	WEBHOOK: { url: marker, method: "POST", headers: marker, secret: marker },
};
const real = {
	DISCORD: { webhookUrl: "https://discord.synthetic.invalid/hook" },
	SLACK: { webhookUrl: "https://slack.synthetic.invalid/hook" },
	TELEGRAM: { botToken: "synthetic-token", chatId: "synthetic-chat" },
	EMAIL: { ...redacted.EMAIL, password: "synthetic-password" },
	BROWSER_PUSH: {
		endpoint: "https://push.synthetic.invalid/device",
		p256dh: "synthetic-key",
		auth: "synthetic-auth",
	},
	PUSHBULLET: { apiToken: "synthetic-token" },
	PUSHOVER: { userKey: "synthetic-user", apiToken: "synthetic-token" },
	GOTIFY: { serverUrl: "https://gotify.synthetic.invalid", appToken: "synthetic-token" },
	NTFY: {
		serverUrl: "https://ntfy.synthetic.invalid",
		topic: "synthetic-topic",
		token: "synthetic-token",
	},
	WEBHOOK: {
		url: "https://webhook.synthetic.invalid/hook",
		method: "POST",
		headers: { Authorization: "synthetic-token" },
		secret: "synthetic-secret",
	},
};
function dto(type: keyof typeof redacted = "WEBHOOK", config: unknown = redacted[type]) {
	return {
		id: "synthetic-channel",
		name: "Synthetic channel",
		type,
		enabled: true,
		configRevision: "a".repeat(64),
		config,
	};
}
describe("notification config-read contract", () => {
	it("retains exactly the established private-field membership", () => {
		expect(NOTIFICATION_CONFIG_PRIVATE_FIELDS).toEqual(privateFields);
	});
	it.each(Object.keys(redacted) as Array<keyof typeof redacted>)(
		"admits %s redacted and real provider configuration",
		(type) => {
			expect(notificationChannelConfigReadSchema.parse(dto(type))).toEqual(dto(type));
			expect(notificationChannelConfigReadSchema.parse(dto(type, real[type]))).toEqual(
				dto(type, real[type]),
			);
			// Read marker allowance must not loosen the original provider write schema.
			expect(channelConfigSchemaMap[type].safeParse(real[type]).success).toBe(true);
		},
	);
	it.each(Object.keys(redacted) as Array<keyof typeof redacted>)(
		"rejects missing required %s configuration",
		(type) => {
			expect(notificationChannelConfigReadSchema.safeParse(dto(type, {})).success).toBe(false);
		},
	);
	it.each([
		["TELEGRAM", "chatId"],
		["EMAIL", "host"],
		["EMAIL", "user"],
		["EMAIL", "port"],
		["EMAIL", "secure"],
		["EMAIL", "from"],
		["EMAIL", "to"],
		["WEBHOOK", "method"],
		["NTFY", "topic"],
	] as const)("rejects retained marker in public %s.%s", (type, field) => {
		expect(
			notificationChannelConfigReadSchema.safeParse(
				dto(type, { ...redacted[type], [field]: marker }),
			).success,
		).toBe(false);
	});
	it.each([
		["EMAIL", "port", "587"],
		["EMAIL", "port", 0],
		["EMAIL", "port", 65536],
		["EMAIL", "port", 1.5],
		["EMAIL", "secure", "false"],
		["EMAIL", "host", ""],
		["EMAIL", "to", "invalid"],
		["EMAIL", "password", null],
		["WEBHOOK", "method", "DELETE"],
		["WEBHOOK", "headers", []],
		["WEBHOOK", "headers", { Authorization: { nested: "synthetic" } }],
		["WEBHOOK", "url", "http://127.0.0.1/private"],
		["WEBHOOK", "secret", 1],
		["NTFY", "token", 1],
		["BROWSER_PUSH", "auth", ""],
	] as const)("preserves %s.%s typed validation: %#", (type, field, value) => {
		expect(
			notificationChannelConfigReadSchema.safeParse(
				dto(type, { ...redacted[type], [field]: value }),
			).success,
		).toBe(false);
	});
	it.each([undefined, null, [], "synthetic", 1, true])(
		"rejects non-object configuration: %#",
		(config) => {
			expect(notificationChannelConfigReadSchema.safeParse({ ...dto(), config }).success).toBe(
				false,
			);
		},
	);
	it.each([
		{ name: null },
		{ name: "" },
		{ name: "x".repeat(101) },
		{ enabled: "false" },
		{ enabled: 0 },
		{ id: " " },
		{ type: "UNKNOWN" },
		{ configRevision: "A".repeat(64) },
		{ configRevision: "a".repeat(63) },
		{ configRevision: undefined },
	])("rejects malformed editor metadata: %#", (changes) => {
		expect(notificationChannelConfigReadSchema.safeParse({ ...dto(), ...changes }).success).toBe(
			false,
		);
	});
	it("preserves legitimate whitespace-only stored names", () => {
		expect(notificationChannelConfigReadSchema.parse({ ...dto(), name: "   " }).name).toBe("   ");
	});
	it("projects exactly six fields and strips unexpected config/outer diagnostics", () => {
		expect(
			notificationChannelConfigReadSchema.parse({
				...dto(),
				lastTestedAt: "synthetic",
				lastTestResult: "success",
				lastSentAt: "synthetic",
				lastSendResult: "failed",
				createdAt: "synthetic",
				updatedAt: "synthetic",
				subscriptions: [],
				debug: "synthetic-private",
				config: { ...redacted.WEBHOOK, debug: "synthetic-private" },
			}),
		).toEqual(dto());
	});
	it("preserves optional empty private fields and the WEBHOOK method default", () => {
		expect(
			notificationChannelConfigReadSchema.parse(
				dto("WEBHOOK", { url: marker, secret: "", headers: {} }),
			).config,
		).toEqual({ url: marker, method: "POST", secret: "", headers: {} });
		expect(
			notificationChannelConfigReadSchema.parse(dto("WEBHOOK", { url: marker })).config,
		).toEqual({ url: marker, method: "POST" });
		expect(
			notificationChannelConfigReadSchema.parse(
				dto("NTFY", { serverUrl: marker, topic: "synthetic", token: "" }),
			).config,
		).toEqual({ serverUrl: marker, topic: "synthetic", token: "" });
		expect(
			notificationChannelConfigReadSchema.parse(
				dto("NTFY", { serverUrl: marker, topic: "synthetic" }),
			).config,
		).toEqual({ serverUrl: marker, topic: "synthetic" });
	});
	it("does not change original required URL and headers write validation", () => {
		expect(channelConfigSchemaMap.WEBHOOK.safeParse(redacted.WEBHOOK).success).toBe(false);
		expect(channelConfigSchemaMap.BROWSER_PUSH.safeParse(redacted.BROWSER_PUSH).success).toBe(
			false,
		);
	});
});
