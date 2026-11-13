import type { NotificationChannelType } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider, useIncognitoMode } from "../../../../contexts/IncognitoContext";
import type { ChannelTypeInfo } from "../../../../lib/api-client/notifications";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { ChannelForm } from "../channel-form";

const marker = "••••••••";
const privateName = "Synthetic private channel name";
const privateValue = "synthetic-private-config-value";
const cases: Array<{
	type: NotificationChannelType;
	config: Record<string, unknown>;
	fields: ChannelTypeInfo["formFields"];
}> = [
	{
		type: "DISCORD",
		config: { webhookUrl: marker },
		fields: [{ key: "webhookUrl", label: "Webhook URL", type: "url", required: true }],
	},
	{
		type: "SLACK",
		config: { webhookUrl: marker },
		fields: [{ key: "webhookUrl", label: "Webhook URL", type: "url", required: true }],
	},
	{
		type: "TELEGRAM",
		config: { botToken: marker, chatId: privateValue },
		fields: [
			{ key: "botToken", label: "Bot token", type: "password", required: true },
			{ key: "chatId", label: "Chat ID", type: "text", required: true },
		],
	},
	{
		type: "EMAIL",
		config: {
			host: `${privateValue}.invalid`,
			port: 587,
			secure: false,
			user: privateValue,
			password: marker,
			from: `${privateValue}@from.invalid`,
			to: `${privateValue}@to.invalid`,
		},
		fields: [
			{ key: "host", label: "Host", type: "text", required: true },
			{ key: "port", label: "Port", type: "number", required: true },
			{ key: "secure", label: "Use TLS", type: "boolean" },
			{ key: "user", label: "Username", type: "text", required: true },
			{ key: "password", label: "Password", type: "password", required: true },
			{ key: "from", label: "From", type: "email", required: true },
			{ key: "to", label: "To", type: "email", required: true },
		],
	},
	{
		type: "BROWSER_PUSH",
		config: { endpoint: marker, p256dh: marker, auth: marker },
		fields: [
			{ key: "endpoint", label: "Endpoint", type: "url", required: true },
			{ key: "p256dh", label: "Public key", type: "password", required: true },
			{ key: "auth", label: "Auth", type: "password", required: true },
		],
	},
	{
		type: "PUSHBULLET",
		config: { apiToken: marker },
		fields: [{ key: "apiToken", label: "API token", type: "password", required: true }],
	},
	{
		type: "PUSHOVER",
		config: { userKey: marker, apiToken: marker },
		fields: [
			{ key: "userKey", label: "User key", type: "password", required: true },
			{ key: "apiToken", label: "API token", type: "password", required: true },
		],
	},
	{
		type: "GOTIFY",
		config: { serverUrl: marker, appToken: marker },
		fields: [
			{ key: "serverUrl", label: "Server URL", type: "url", required: true },
			{ key: "appToken", label: "App token", type: "password", required: true },
		],
	},
	{
		type: "NTFY",
		config: { serverUrl: marker, topic: privateValue, token: marker },
		fields: [
			{ key: "serverUrl", label: "Server URL", type: "url", required: true },
			{ key: "topic", label: "Topic", type: "text", required: true },
			{ key: "token", label: "Token", type: "password" },
		],
	},
	{
		type: "WEBHOOK",
		config: { url: marker, method: "POST", headers: marker, secret: marker },
		fields: [
			{ key: "url", label: "Webhook URL", type: "url", required: true },
			{ key: "method", label: "HTTP method", type: "text" },
			{ key: "headers", label: "Headers", type: "headers" },
			{ key: "secret", label: "Signing secret", type: "password" },
		],
	},
];
const clients: QueryClient[] = [];

function json(value: unknown) {
	return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function mount(
	type: NotificationChannelType,
	options: { deferredRead?: boolean; newChannel?: boolean } = {},
) {
	const fixture = cases.find((item) => item.type === type)!;
	const channel = {
		id: "owned-channel",
		name: privateName,
		type,
		enabled: true,
		lastTestedAt: null,
		lastTestResult: null,
		createdAt: "2026-10-01T12:00:00.000Z",
		updatedAt: "2026-10-06T12:00:00.000Z",
		subscriptions: [],
		configRevision: "a".repeat(64),
		config: fixture.config,
	};
	const writes: Array<{ method: string; data: Record<string, unknown> }> = [];
	let reads = 0;
	let finishRead: ((response: Response) => void) | undefined;
	vi.stubGlobal("fetch", async (path: string, request: RequestInit = {}) => {
		if (request.method === "PUT" || request.method === "POST") {
			writes.push({ method: request.method, data: JSON.parse(String(request.body)) });
			expect(path).toBe(
				options.newChannel
					? "/api/notifications/channels"
					: "/api/notifications/channels/owned-channel",
			);
			return json({ ...channel, config: undefined });
		}
		expect(path).toBe("/api/notifications/channels/owned-channel/config");
		reads++;
		if (options.deferredRead)
			return new Promise<Response>((resolve) => {
				finishRead = resolve;
			});
		return json(channel);
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	clients.push(client);
	client.setQueryData(notificationKeys.channelTypes, [
		{ type, label: type, icon: "Bell", formFields: fixture.fields },
	]);
	const saved = vi.fn();
	const cancelled = vi.fn();
	function Controls() {
		const [mode, setMode] = useIncognitoMode();
		return (
			<>
				<button type="button" onClick={() => setMode(!mode)}>
					Toggle privacy
				</button>
				<ChannelForm
					channelId={options.newChannel ? null : channel.id}
					onSave={saved}
					onCancel={cancelled}
				/>
			</>
		);
	}
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<Controls />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return {
		fixture,
		writes,
		saved,
		cancelled,
		get reads() {
			return reads;
		},
		async finishRead() {
			if (!finishRead) throw new Error("Synthetic read missing");
			await act(async () => finishRead!(json(channel)));
		},
	};
}

function privateInputs() {
	return Array.from(
		screen
			.getByLabelText("Name")
			.closest("form")!
			.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea"),
	);
}

beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("notification channel editor respects actual incognito context without modifying drafts", () => {
	it("allows closing a locked editor without leaving privacy mode or writing", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		const fixture = mount("EMAIL");
		await screen.findByLabelText("Name");
		fireEvent.click(screen.getByRole("button", { name: "Close channel form" }));
		expect(fixture.cancelled).toHaveBeenCalledOnce();
		expect(localStorage.getItem("arr-dashboard-incognito-mode")).toBe("true");
		expect(fixture.writes).toHaveLength(0);
	});
	it.each(cases)("masks and locks stored identifying fields for $type", async ({ type }) => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		const fixture = mount(type);
		await screen.findByLabelText("Name");
		expect(screen.getByLabelText("Name")).not.toHaveValue(privateName);
		for (const input of privateInputs()) {
			expect(input).toBeDisabled();
			expect(input.value).not.toContain(privateValue);
		}
		expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
		fireEvent.submit(screen.getByLabelText("Name").closest("form")!);
		expect(fixture.writes).toHaveLength(0);
		expect(fixture.saved).not.toHaveBeenCalled();
	});

	it("explicitly exits privacy and saves actual values, never aliases or blanks", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		const fixture = mount("EMAIL");
		await screen.findByLabelText("Name");
		fireEvent.click(screen.getByRole("button", { name: /turn off incognito to edit/i }));
		expect(screen.getByLabelText("Name")).toHaveValue(privateName);
		expect(screen.getByLabelText("Username")).toHaveValue(privateValue);
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(fixture.saved).toHaveBeenCalledOnce());
		expect(fixture.writes).toEqual([
			{
				method: "PUT",
				data: {
					name: privateName,
					enabled: true,
					config: fixture.fixture.config,
					expectedRevision: "a".repeat(64),
				},
			},
		]);
		expect(fixture.reads).toBe(1);
	});

	it("masks a live unsaved URL/header/secret draft and restores it without a reread or write", async () => {
		const fixture = mount("WEBHOOK");
		await screen.findByLabelText("Name");
		const url = `https://synthetic.invalid/${privateValue}`;
		const headers = JSON.stringify({ Authorization: privateValue });
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved private name" } });
		fireEvent.change(screen.getByLabelText("Webhook URL"), { target: { value: url } });
		fireEvent.change(screen.getByLabelText("Headers"), { target: { value: headers } });
		fireEvent.change(screen.getByLabelText("Signing secret"), { target: { value: privateValue } });
		fireEvent.click(screen.getByRole("button", { name: "Toggle privacy" }));
		for (const input of privateInputs()) {
			expect(input).toBeDisabled();
			expect(input.value).not.toContain(privateValue);
		}
		expect(screen.getByLabelText("Name")).not.toHaveValue("Unsaved private name");
		fireEvent.submit(screen.getByLabelText("Name").closest("form")!);
		expect(fixture.writes).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: /turn off incognito to edit/i }));
		expect(screen.getByLabelText("Name")).toHaveValue("Unsaved private name");
		expect(screen.getByLabelText("Webhook URL")).toHaveValue(url);
		expect(screen.getByLabelText("Headers")).toHaveValue(headers);
		expect(screen.getByLabelText("Signing secret")).toHaveValue(privateValue);
		expect(fixture.reads).toBe(1);
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(fixture.saved).toHaveBeenCalledOnce());
		expect(fixture.writes[0]?.data).toEqual({
			name: "Unsaved private name",
			enabled: true,
			expectedRevision: "a".repeat(64),
			config: {
				url,
				method: "POST",
				headers: { Authorization: privateValue },
				secret: privateValue,
			},
		});
	});

	it("a late settings read cannot expose fields after privacy was enabled", async () => {
		const fixture = mount("EMAIL", { deferredRead: true });
		await waitFor(() => expect(fixture.reads).toBe(1));
		fireEvent.click(screen.getByRole("button", { name: "Toggle privacy" }));
		await fixture.finishRead();
		await screen.findByLabelText("Name");
		expect(screen.getByLabelText("Name")).not.toHaveValue(privateName);
		expect(screen.getByLabelText("Username")).not.toHaveValue(privateValue);
		expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
		expect(fixture.writes).toHaveLength(0);
	});

	it("protects a new channel draft without saving or resetting it", async () => {
		const fixture = mount("DISCORD", { newChannel: true });
		await screen.findByLabelText("Name");
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New private draft" } });
		fireEvent.change(screen.getByLabelText("Webhook URL"), {
			target: { value: `https://synthetic.invalid/${privateValue}` },
		});
		fireEvent.click(screen.getByRole("button", { name: "Toggle privacy" }));
		expect(screen.getByLabelText("Name")).not.toHaveValue("New private draft");
		expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
		fireEvent.submit(screen.getByLabelText("Name").closest("form")!);
		expect(fixture.writes).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: /turn off incognito to edit/i }));
		expect(screen.getByLabelText("Name")).toHaveValue("New private draft");
		expect(screen.getByLabelText("Webhook URL")).toHaveValue(
			`https://synthetic.invalid/${privateValue}`,
		);
		expect(fixture.reads).toBe(0);
	});
});
