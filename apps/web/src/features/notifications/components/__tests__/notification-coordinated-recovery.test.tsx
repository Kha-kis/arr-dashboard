import type { NotificationChannelResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import type {
	ChannelTypeInfo,
	NotificationChannelWithConfig,
} from "../../../../lib/api-client/notifications";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { ChannelForm } from "../channel-form";
import { NotificationsTab } from "../notifications-tab";

// Only browser permission/enrollment is out of scope. Parent/form, API, hooks,
// shared query cache, theme and privacy providers remain real.
vi.mock("../browser-push-card", () => ({ BrowserPushCard: () => null }));

const types: ChannelTypeInfo[] = [
	{
		type: "DISCORD",
		label: "Discord",
		icon: "Send",
		formFields: [{ key: "webhookUrl", label: "Webhook URL", type: "url", required: true }],
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
];
const channel: NotificationChannelWithConfig & NotificationChannelResponse = {
	id: "synthetic-channel",
	name: "Synthetic stored channel",
	type: "WEBHOOK",
	enabled: true,
	createdAt: "2026-10-01T12:00:00Z",
	updatedAt: "2026-10-01T12:00:00Z",
	lastTestedAt: null,
	lastTestResult: null,
	subscriptions: ["SYSTEM_ERROR"],
	configRevision: "a".repeat(64),
	config: { url: "••••••••", method: "POST", secret: "••••••••", headers: "••••••••" },
};
const { config: _config, configRevision: _revision, ...channelRowBase } = channel;
const channelRow = { ...channelRowBase, lastSentAt: null, lastSendResult: null };
const typesPath = "/api/notifications/channel-types";
const configPath = "/api/notifications/channels/synthetic-channel/config";
const channelsPath = "/api/notifications/channels";
const privateError = "synthetic-private-coordinated-read-detail";
const clients: QueryClient[] = [];
const releases: Array<() => void> = [];
const unexpected: Array<{ path: boolean; method: boolean; body: boolean }> = [];

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}
function pending(fallback: unknown) {
	let resolve!: (value: Response) => void;
	const response = new Promise<Response>((finish) => {
		resolve = finish;
	});
	releases.push(() => resolve(json(fallback)));
	return {
		response,
		async finish(value: unknown, status = 200) {
			await act(async () => resolve(json(value, status)));
		},
	};
}
function transport(read: (path: string) => Response | Promise<Response>) {
	const requests: string[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, options: RequestInit = {}) => {
		const path = String(input);
		requests.push(path);
		const violation = {
			path: ![typesPath, configPath, channelsPath].includes(path),
			method: (options.method ?? "GET") !== "GET",
			body: options.body !== undefined,
		};
		if (violation.path || violation.method || violation.body) {
			unexpected.push(violation);
			throw new Error("Out-of-scope coordinated read");
		}
		return read(path);
	});
	return requests;
}
function mount(parent = false) {
	// Matches current root defaults; no fake timers, retryDelay override or query
	// hook substitution. Metadata retains its independent five-minute stale time.
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: 1, staleTime: 30_000, gcTime: 300_000, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	clients.push(client);
	const onSave = vi.fn(),
		onCancel = vi.fn();
	const view = render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					{parent ? (
						<NotificationsTab />
					) : (
						<ChannelForm channelId="synthetic-channel" onSave={onSave} onCancel={onCancel} />
					)}
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return { ...view, client, onSave, onCancel };
}
async function metadataFailed(client: QueryClient) {
	await waitFor(
		() => expect(client.getQueryState(notificationKeys.channelTypes)?.status).toBe("error"),
		{ timeout: 3500 },
	);
}
function blocked() {
	expect(document.body).not.toHaveTextContent(privateError);
	expect(screen.queryByRole("button", { name: /^(Create|Update)$/ })).not.toBeInTheDocument();
}
afterEach(() => {
	cleanup();
	for (const release of releases.splice(0)) release();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	// These assertions are outside fetch/client catches, so writes cannot hide.
	expect(unexpected.splice(0)).toEqual([]);
});

describe("coordinated settings/catalog read recovery with production retry policy", () => {
	// Missing either failed-read retry must leave a required input unavailable.
	it.each(["settings-first", "metadata-first"])(
		"one explicit retry restores both failed reads (%s)",
		async (order) => {
			const metadata = pending(types),
				settings = pending(channel);
			let typeReads = 0,
				configReads = 0;
			const requests = transport((path) =>
				path === typesPath
					? ++typeReads <= 2
						? json({ error: privateError }, 503)
						: metadata.response
					: ++configReads === 1
						? json({ error: privateError }, 503)
						: settings.response,
			);
			const result = mount();
			await metadataFailed(result.client);
			expect(screen.getByRole("alert")).toHaveTextContent(/settings could not be loaded/i);
			blocked();
			expect(typeReads).toBe(2);
			expect(configReads).toBe(1);
			fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
			await waitFor(() => {
				expect(typeReads).toBe(3);
				expect(configReads).toBe(2);
			});
			if (order === "settings-first") await settings.finish(channel);
			else await metadata.finish(types);
			expect(screen.getByRole("status", { busy: true })).toHaveTextContent(/loading.*settings/i);
			blocked();
			if (order === "settings-first") await metadata.finish(types);
			else await settings.finish(channel);
			await screen.findByDisplayValue(channel.name);
			expect(screen.getByLabelText("HTTP Method")).toHaveValue("POST");
			expect(screen.getByLabelText("Webhook URL")).toHaveValue("");
			expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
			expect(result.client.getQueryState(notificationKeys.channelTypes)?.status).toBe("success");
			expect(requests.filter((path) => path === typesPath)).toHaveLength(3);
			expect(requests.filter((path) => path === configPath)).toHaveLength(2);
			expect(result.onSave).not.toHaveBeenCalled();
		},
	);

	it("keeps repeated failures generic and recovers both reads on a later explicit retry", async () => {
		let fail = true;
		const requests = transport((path) =>
			fail ? json({ message: privateError }, 503) : json(path === typesPath ? types : channel),
		);
		const result = mount();
		await metadataFailed(result.client);
		blocked();
		fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
		await waitFor(() => expect(requests.filter((path) => path === typesPath)).toHaveLength(4), {
			timeout: 3500,
		});
		await metadataFailed(result.client);
		expect(screen.getByRole("alert")).toHaveTextContent(/settings could not be loaded/i);
		blocked();
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
		await screen.findByDisplayValue(channel.name);
		expect(requests.filter((path) => path === typesPath)).toHaveLength(5);
		expect(requests.filter((path) => path === configPath)).toHaveLength(3);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(result.onSave).not.toHaveBeenCalled();
	});

	it("retries failed settings without reloading a healthy catalog that lacks the initial type", async () => {
		let configReads = 0;
		const requests = transport((path) =>
			path === typesPath
				? json(types.filter((type) => type.type === "WEBHOOK"))
				: ++configReads === 1
					? json({ message: privateError }, 503)
					: json(channel),
		);
		const result = mount();
		await waitFor(() =>
			expect(result.client.getQueryState(notificationKeys.channelTypes)?.status).toBe("success"),
		);
		expect(screen.getByRole("alert")).toHaveTextContent(/settings could not be loaded/i);
		blocked();
		fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
		await screen.findByDisplayValue(channel.name);
		expect(screen.getByLabelText("HTTP Method")).toHaveValue("POST");
		expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
		expect(requests.filter((path) => path === typesPath)).toHaveLength(1);
		expect(requests.filter((path) => path === configPath)).toHaveLength(2);
		expect(result.onSave).not.toHaveBeenCalled();
	});

	// Unlike manually unmounting a standalone form, this exercises the real
	// parent's cancel state and the shared metadata observer after the child exits.
	it.each(["settings-first", "metadata-first"])(
		"parent closes a pending editor and ignores late reads (%s)",
		async (order) => {
			const metadata = pending(types),
				settings = pending(channel);
			const requests = transport((path) =>
				path === channelsPath
					? json([channelRow])
					: path === typesPath
						? metadata.response
						: settings.response,
			);
			mount(true);
			await screen.findByText(channel.name);
			fireEvent.click(screen.getByRole("button", { name: "Edit channel" }));
			await waitFor(() => expect(requests.filter((path) => path === configPath)).toHaveLength(1));
			expect(screen.getByRole("status", { busy: true })).toHaveTextContent(/loading.*settings/i);
			fireEvent.click(screen.getByRole("button", { name: "Go back" }));
			expect(screen.queryByText(/loading channel settings/i)).not.toBeInTheDocument();
			if (order === "settings-first") {
				await settings.finish(channel);
				await metadata.finish(types);
			} else {
				await metadata.finish(types);
				await settings.finish(channel);
			}
			await screen.findByText("Webhook");
			expect(screen.getByText(channel.name)).toBeInTheDocument();
			expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
			expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
			expect(requests.filter((path) => path === channelsPath)).toHaveLength(1);
			expect(requests.filter((path) => path === typesPath)).toHaveLength(1);
			expect(requests.filter((path) => path === configPath)).toHaveLength(1);
		},
	);

	it("retains verified channel rows through metadata failure and restores shared labels via GET retry", async () => {
		const firstMetadata = pending(types);
		let typeReads = 0;
		const requests = transport((path) =>
			path === channelsPath
				? json([channelRow])
				: ++typeReads === 1
					? firstMetadata.response
					: typeReads === 2
						? json({ error: privateError }, 503)
						: json(types),
		);
		const result = mount(true);
		await screen.findByText(channel.name);
		fireEvent.click(screen.getByRole("button", { name: "Add Channel" }));
		await firstMetadata.finish({ error: privateError }, 503);
		await metadataFailed(result.client);
		expect(screen.getByRole("alert")).toHaveTextContent(/field definitions.*unavailable/i);
		expect(screen.getByText(channel.name)).toBeInTheDocument();
		expect(screen.getByText("WEBHOOK", { exact: true })).toBeInTheDocument();
		blocked();
		fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
		await screen.findByLabelText("Webhook URL");
		const rowHeading = screen.getByText(channel.name).parentElement;
		if (!rowHeading) throw new Error("Missing real channel heading");
		expect(within(rowHeading).getByText("Webhook", { exact: true })).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Synthetic new channel draft" },
		});
		fireEvent.change(screen.getByLabelText("Webhook URL"), {
			target: { value: "https://synthetic.invalid/new-channel" },
		});
		expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
		expect(requests.filter((path) => path === typesPath)).toHaveLength(3);
		expect(requests.filter((path) => path === channelsPath)).toHaveLength(1);
		expect(requests.filter((path) => path === configPath)).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Close channel form" }));
		expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
		expect(screen.getByText(channel.name)).toBeInTheDocument();
	});
});
