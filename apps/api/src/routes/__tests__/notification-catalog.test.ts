import { channelConfigSchemaMap, type NotificationChannelType } from "@arr/shared";
import Fastify, { type FastifyInstance } from "fastify";
import nodemailer from "nodemailer";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { registerProtectedRoutes } from "../../bootstrap/protected-routes.js";
import { discordPlugin } from "../../lib/notifications/channels/discord-sender.js";
import { emailPlugin } from "../../lib/notifications/channels/email-sender.js";
import { gotifyPlugin } from "../../lib/notifications/channels/gotify-sender.js";
import { ntfyPlugin } from "../../lib/notifications/channels/ntfy-sender.js";
import { pushbulletPlugin } from "../../lib/notifications/channels/pushbullet-sender.js";
import { pushoverPlugin } from "../../lib/notifications/channels/pushover-sender.js";
import { slackPlugin } from "../../lib/notifications/channels/slack-sender.js";
import { telegramPlugin } from "../../lib/notifications/channels/telegram-sender.js";
import { webhookPlugin } from "../../lib/notifications/channels/webhook-sender.js";
import { NotificationDispatcher } from "../../lib/notifications/notification-dispatcher.js";
import { NotificationService } from "../../lib/notifications/notification-service.js";
import type { ChannelSender } from "../../lib/notifications/types.js";
import { AUTH_HEADER, setupAuthInjection } from "./test-helpers.js";

// Isolate filesystem logging and unrelated route groups, retaining the actual
// protected gate, notifications route, service, dispatcher and plugin manifests.
vi.mock("../../lib/logger.js", () => ({ logger: {}, loggers: { api: {} } }));
vi.mock("../route-manifest.js", async () => {
	const { registerNotificationRoutes } = await import("../notifications.js");
	return {
		PROTECTED_ROUTE_GROUPS: [
			{ prefix: "/api/notifications", register: registerNotificationRoutes },
		],
	};
});

type Catalog = ReturnType<NotificationService["getChannelTypes"]>;
type ServiceDependencies = ConstructorParameters<typeof NotificationService>;

// Independently checked wire contract; do not derive expectations from plugins.
const expectedCatalog: Catalog = [
	{
		type: "DISCORD",
		label: "Discord",
		icon: "Send",
		formFields: [{ key: "webhookUrl", label: "Webhook URL", type: "url", required: true }],
	},
	{
		type: "TELEGRAM",
		label: "Telegram",
		icon: "Send",
		formFields: [
			{ key: "botToken", label: "Bot Token", type: "password", required: true },
			{ key: "chatId", label: "Chat ID", type: "text", required: true },
		],
	},
	{
		type: "EMAIL",
		label: "Email (SMTP)",
		icon: "Mail",
		formFields: [
			{ key: "host", label: "SMTP Host", type: "text", required: true },
			{ key: "port", label: "SMTP Port", type: "number", required: true },
			{ key: "secure", label: "Use TLS", type: "boolean" },
			{ key: "user", label: "Username", type: "text", required: true },
			{ key: "password", label: "Password", type: "password", required: true },
			{ key: "from", label: "From Address", type: "email", required: true },
			{ key: "to", label: "To Address", type: "email", required: true },
		],
	},
	{
		type: "PUSHBULLET",
		label: "Pushbullet",
		icon: "Send",
		formFields: [{ key: "apiToken", label: "API Token", type: "password", required: true }],
	},
	{
		type: "PUSHOVER",
		label: "Pushover",
		icon: "Send",
		formFields: [
			{ key: "userKey", label: "User Key", type: "password", required: true },
			{ key: "apiToken", label: "API Token", type: "password", required: true },
		],
	},
	{
		type: "GOTIFY",
		label: "Gotify",
		icon: "Server",
		formFields: [
			{ key: "serverUrl", label: "Server URL", type: "url", required: true },
			{ key: "appToken", label: "Application Token", type: "password", required: true },
		],
	},
	{
		type: "WEBHOOK",
		label: "Webhook",
		icon: "Globe",
		formFields: [
			{ key: "url", label: "Webhook URL", type: "url", required: true },
			{ key: "method", label: "HTTP Method", type: "text", placeholder: "POST" },
			{ key: "secret", label: "Signing Secret", type: "password" },
			{ key: "headers", label: "Custom Headers", type: "headers" },
		],
	},
	{
		type: "SLACK",
		label: "Slack",
		icon: "Hash",
		formFields: [{ key: "webhookUrl", label: "Webhook URL", type: "url", required: true }],
	},
	{
		type: "NTFY",
		label: "ntfy.sh",
		icon: "Bell",
		formFields: [
			{
				key: "serverUrl",
				label: "Server URL",
				type: "url",
				required: true,
				placeholder: "https://ntfy.sh",
			},
			{ key: "topic", label: "Topic", type: "text", required: true },
			{ key: "token", label: "Access Token", type: "password" },
		],
	},
];

// Literal schema-valid configurations, including every optional exposed key.
// These are synthetic values and are never sent to a provider or persisted.
const validConfigs: Record<
	Exclude<NotificationChannelType, "BROWSER_PUSH">,
	Record<string, unknown>
> = {
	DISCORD: { webhookUrl: "https://example.com/discord" },
	TELEGRAM: { botToken: "synthetic-bot-token", chatId: "synthetic-chat-id" },
	EMAIL: {
		host: "smtp.example.com",
		port: 587,
		secure: false,
		user: "synthetic-user",
		password: "synthetic-password",
		from: "sender@example.com",
		to: "recipient@example.com",
	},
	PUSHBULLET: { apiToken: "synthetic-pushbullet-token" },
	PUSHOVER: { userKey: "synthetic-user-key", apiToken: "synthetic-pushover-token" },
	GOTIFY: { serverUrl: "https://example.com/gotify", appToken: "synthetic-app-token" },
	WEBHOOK: {
		url: "https://example.com/webhook",
		method: "PUT",
		secret: "synthetic-signing-secret",
		headers: { "X-Synthetic-Header": "synthetic-value" },
	},
	SLACK: { webhookUrl: "https://example.com/slack" },
	NTFY: {
		serverUrl: "https://example.com/ntfy",
		topic: "synthetic-topic",
		token: "synthetic-access-token",
	},
};

const plugins = [
	discordPlugin,
	telegramPlugin,
	emailPlugin,
	pushbulletPlugin,
	pushoverPlugin,
	gotifyPlugin,
	webhookPlugin,
	slackPlugin,
	ntfyPlugin,
];
const catalogUrl = "/api/notifications/channel-types";
let app: FastifyInstance | undefined;
let service: NotificationService;
let dispatcher: NotificationDispatcher;
let forbiddenAccesses: string[];
let senderSpies: Array<MockInstance<ChannelSender["send"]> | MockInstance<ChannelSender["test"]>>;
let dynamicSender: ChannelSender;

function deny(operation: string): never {
	forbiddenAccesses.push(operation);
	throw new Error(`Catalog fixture forbids ${operation}`);
}

function deniedDependency<T extends object>(name: string): T {
	return new Proxy({} as T, {
		get(_target, property) {
			return deny(`${name}.${String(property)}`);
		},
	});
}

beforeEach(async () => {
	forbiddenAccesses = [];
	// Keep real sender implementations: passthrough spies only count invocation.
	senderSpies = plugins.flatMap(({ sender }) => [
		vi.spyOn(sender, "send"),
		vi.spyOn(sender, "test"),
	]);
	// All static plugins use fetch or SMTP. Deny both before construction;
	// counters below fail even when production catches a provider exception.
	vi.stubGlobal(
		"fetch",
		vi.fn(() => deny("provider.fetch")),
	);
	vi.spyOn(nodemailer, "createTransport").mockImplementation(() => deny("provider.smtp"));
	dynamicSender = {
		send: vi.fn(() => deny("browser-push.send")),
		test: vi.fn(() => deny("browser-push.test")),
	};
	dispatcher = new NotificationDispatcher();
	service = new NotificationService(
		deniedDependency<ServiceDependencies[0]>("database"),
		deniedDependency<ServiceDependencies[1]>("encryption"),
		dispatcher,
		deniedDependency<ServiceDependencies[3]>("notification-logger"),
		deniedDependency<NonNullable<ServiceDependencies[4]>>("dedup"),
		deniedDependency<NonNullable<ServiceDependencies[5]>>("retry"),
		"https://example.com/dashboard",
	);
	// No runtime/bootstrap or recovery worker runs for a catalog-only service.
	service.closeAdmission();

	app = Fastify({ logger: false });
	// Existing synthetic auth injection exercises the real protected gate;
	// this fixture does not establish signed-session/cookie cryptography.
	setupAuthInjection(app);
	app.decorate("prisma", { getter: () => deny("route.database") });
	app.decorate("encryptor", { getter: () => deny("route.encryption") });
	app.decorate("notificationService", service);
	registerProtectedRoutes(app);
	await app.ready();
});

afterEach(async () => {
	try {
		service?.dispose();
		await app?.close();
		expect(forbiddenAccesses).toEqual([]);
		for (const spy of senderSpies) expect(spy).not.toHaveBeenCalled();
		expect(dynamicSender.send).not.toHaveBeenCalled();
		expect(dynamicSender.test).not.toHaveBeenCalled();
	} finally {
		app = undefined;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});

async function readCatalog(): Promise<Catalog> {
	const response = await app!.inject({
		method: "GET",
		url: catalogUrl,
		headers: { [AUTH_HEADER]: "1" },
	});
	expect(response.statusCode).toBe(200);
	return response.json<Catalog>();
}

describe("real protected notification catalog contract", () => {
	it("rejects unauthenticated reads before invoking the service or dispatcher", async () => {
		const serviceRead = vi.spyOn(service, "getChannelTypes");
		const dispatcherRead = vi.spyOn(dispatcher, "getPluginManifests");
		const response = await app!.inject({ method: "GET", url: catalogUrl });

		expect(response.statusCode).toBe(401);
		expect(response.json()).toEqual({ error: "Authentication required" });
		expect(serviceRead).not.toHaveBeenCalled();
		expect(dispatcherRead).not.toHaveBeenCalled();
	});

	it("projects all nine real plugins through the dispatcher and service into GET metadata", async () => {
		const serviceRead = vi.spyOn(service, "getChannelTypes");
		const dispatcherRead = vi.spyOn(dispatcher, "getPluginManifests");
		const catalog = await readCatalog();

		expect(serviceRead).toHaveBeenCalledOnce();
		expect(dispatcherRead).toHaveBeenCalledOnce();
		expect(catalog).toEqual(expectedCatalog);
		expect(new Set(catalog.map(({ type }) => type)).size).toBe(9);
		for (const descriptor of catalog) {
			expect(Object.keys(descriptor).sort()).toEqual(["formFields", "icon", "label", "type"]);
			expect(descriptor).not.toHaveProperty("sender");
			expect(descriptor).not.toHaveProperty("configSchema");
			expect(dispatcher.hasSender(descriptor.type as NotificationChannelType)).toBe(true);
		}
	});

	it("exposes every key needed for independently checked valid static channel configurations", async () => {
		const catalog = await readCatalog();
		expect(catalog).toEqual(expectedCatalog);
		for (const descriptor of catalog) {
			const type = descriptor.type as Exclude<NotificationChannelType, "BROWSER_PUSH">;
			const config = validConfigs[type];
			const keys = descriptor.formFields.map(({ key }) => key);
			expect([...keys].sort()).toEqual(Object.keys(config).sort());
			expect(new Set(keys).size).toBe(keys.length);
			const exposedConfig = Object.fromEntries(keys.map((key) => [key, config[key]]));
			const parsed = channelConfigSchemaMap[type].safeParse(exposedConfig);
			expect(parsed.success).toBe(true);
			if (parsed.success) expect(parsed.data).toEqual(config);
		}
	});

	it("adds a zero-field Browser Push descriptor only after inert dynamic registration", async () => {
		expect(dispatcher.hasSender("BROWSER_PUSH")).toBe(false);
		expect(await readCatalog()).toEqual(expectedCatalog);

		dispatcher.registerSender("BROWSER_PUSH", dynamicSender);
		expect(dispatcher.hasSender("BROWSER_PUSH")).toBe(true);
		expect(await readCatalog()).toEqual([
			...expectedCatalog,
			{ type: "BROWSER_PUSH", label: "BROWSER PUSH", icon: "Bell", formFields: [] },
		]);
	});
});
