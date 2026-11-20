import type { NotificationChannelResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationsApi } from "../../../../lib/api-client/notifications";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { ChannelForm } from "../channel-form";
import { NotificationsTab } from "../notifications-tab";

// Permission/enrollment is a separate boundary; editor, list, hooks and transport are real.
vi.mock("../browser-push-card", () => ({ BrowserPushCard: () => null }));

const channel: NotificationChannelResponse = {
	id: "synthetic-owned-channel",
	name: "Original synthetic channel",
	type: "WEBHOOK",
	enabled: true,
	createdAt: "2026-10-01T12:00:00.000Z",
	updatedAt: "2026-10-01T12:00:00.000Z",
	lastTestedAt: "2026-10-01T12:30:00.000Z",
	lastTestResult: "success",
	subscriptions: ["SYSTEM_ERROR"],
};
const acknowledgment: NotificationChannelResponse = {
	id: "synthetic-owned-channel",
	name: "Synthetic renamed channel",
	type: "WEBHOOK",
	enabled: true,
	createdAt: "2026-10-01T12:00:00.000Z",
	updatedAt: "2026-10-06T12:00:00.000Z",
	lastTestedAt: null,
	lastTestResult: null,
	subscriptions: ["SYSTEM_ERROR"],
};
const draft = {
	name: "Synthetic renamed channel",
	enabled: true,
	config: { url: "••••••••", method: "PUT", secret: "••••••••", headers: "••••••••" },
	expectedRevision: "b".repeat(64),
};
const config = {
	id: "synthetic-owned-channel",
	name: "Original synthetic channel",
	type: "WEBHOOK",
	enabled: true,
	lastTestedAt: "2026-10-01T12:30:00.000Z",
	lastTestResult: "success",
	lastSentAt: null,
	lastSendResult: null,
	configRevision: "b".repeat(64),
	config: { url: "••••••••", method: "POST", secret: "••••••••", headers: "••••••••" },
};
const catalog = [
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
const privateError = "synthetic-private-unverified-ack-detail";
const updatePath = "/api/notifications/channels/synthetic-owned-channel";
const configPath = "/api/notifications/channels/synthetic-owned-channel/config";
const typesPath = "/api/notifications/channel-types";
const listPath = "/api/notifications/channels";
const clients: QueryClient[] = [];
const violations: Array<{ path: string; method: string; body: boolean }> = [];

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}
const badAcks = [
	{ label: "foreign id", value: { ...acknowledgment, id: "synthetic-foreign-channel" } },
	{
		label: "incomplete matching id",
		value: { id: "synthetic-owned-channel", message: privateError },
	},
	{ label: "null", value: null },
];
function transport(
	reply: () => Response,
	options: { configuration?: () => unknown; list?: () => Response | Promise<Response> } = {},
) {
	const writes: unknown[] = [];
	const reads: string[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, request: RequestInit = {}) => {
		const path = String(input),
			method = request.method ?? "GET";
		if (path === updatePath && method === "PUT" && typeof request.body === "string") {
			writes.push(JSON.parse(String(request.body)));
			return reply();
		}
		if (method === "GET" && request.body === undefined && [configPath, typesPath].includes(path)) {
			reads.push(path);
			return json(path === configPath ? (options.configuration?.() ?? config) : catalog);
		}
		if (path === listPath && method === "GET" && request.body === undefined && options.list) {
			reads.push(path);
			return options.list();
		}
		violations.push({ path, method, body: request.body !== undefined });
		throw new Error("Unapproved synthetic update request");
	});
	return { writes, reads };
}
function mount(parent = false) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: 1, staleTime: 30_000, gcTime: 300_000, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	clients.push(client);
	client.setQueryData(notificationKeys.channels, [channel]);
	const onSave = vi.fn(),
		onSaved = vi.fn();
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					{parent ? (
						<NotificationsTab />
					) : (
						<ChannelForm
							channelId="synthetic-owned-channel"
							onSave={onSave}
							onSaved={onSaved}
							onCancel={() => {}}
						/>
					)}
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return { client, onSave, onSaved };
}
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	// Fail outside client catches if an unexpected read or write was attempted.
	expect(violations.splice(0)).toEqual([]);
});

describe("notification PUT acknowledgment admission at real boundaries", () => {
	// These catch apiRequest's unchecked unknown-success cast before onSuccess.
	it.each(badAcks)("client rejects $label without certifying success", async ({ value }) => {
		const requests = transport(() => json(value));
		const outcome = await notificationsApi.updateChannel("synthetic-owned-channel", draft).then(
			(result) => ({ accepted: true, result }),
			(error: unknown) => ({ accepted: false, error }),
		);
		expect(outcome.accepted).toBe(false);
		expect(requests.writes).toEqual([draft]);
		expect(requests.reads).toEqual([]);
		if (!outcome.accepted && "error" in outcome) {
			expect(outcome.error).toBeInstanceOf(Error);
			expect(String(outcome.error)).not.toContain(privateError);
		}
	});

	it("client rejects bodyless successful acknowledgment", async () => {
		const requests = transport(() => new Response(null, { status: 204 }));
		await expect(
			notificationsApi.updateChannel("synthetic-owned-channel", draft),
		).rejects.toThrow();
		expect(requests.writes).toEqual([draft]);
		expect(requests.reads).toEqual([]);
	});

	it("client accepts the complete matching acknowledgment without extra reads or writes", async () => {
		const requests = transport(() => json(acknowledgment));
		await expect(notificationsApi.updateChannel("synthetic-owned-channel", draft)).resolves.toEqual(
			acknowledgment,
		);
		expect(requests.writes).toEqual([draft]);
		expect(requests.reads).toEqual([]);
	});

	it.each([
		{ label: "array", value: [acknowledgment] },
		{ label: "nonboolean enabled", value: { ...acknowledgment, enabled: "true" } },
		{ label: "missing Test timestamp", value: { ...acknowledgment, lastTestedAt: undefined } },
		{ label: "invalid creation date", value: { ...acknowledgment, createdAt: "not-a-date" } },
		{ label: "invalid updated date", value: { ...acknowledgment, updatedAt: 1 } },
		{ label: "nonarray subscriptions", value: { ...acknowledgment, subscriptions: {} } },
		{ label: "invalid event entry", value: { ...acknowledgment, subscriptions: [null] } },
		{ label: "private Test result", value: { ...acknowledgment, lastTestResult: privateError } },
	])("client rejects $label metadata before cache publication", async ({ value }) => {
		const requests = transport(() => json(value));
		await expect(notificationsApi.updateChannel(channel.id, draft)).rejects.toThrow();
		expect(requests.writes).toEqual([draft]);
		expect(requests.reads).toEqual([]);
	});

	it("publishes only allowed update metadata, never unexpected configuration or provider details", async () => {
		transport(() =>
			json({
				...acknowledgment,
				config: { secret: privateError },
				message: privateError,
				lastSendResult: privateError,
			}),
		);
		await expect(notificationsApi.updateChannel(channel.id, draft)).resolves.toEqual(
			acknowledgment,
		);
	});

	// Hook cache identity protection alone must not certify a successful editor save.
	it.each(badAcks)(
		"form keeps $label outcome unverified, preserving draft and preventing stale replay",
		async ({ value }) => {
			const requests = transport(() => json(value));
			const result = mount();
			await screen.findByDisplayValue("Original synthetic channel");
			fireEvent.change(screen.getByLabelText("Name"), {
				target: { value: "Synthetic renamed channel" },
			});
			fireEvent.change(screen.getByLabelText("HTTP Method"), { target: { value: "PUT" } });
			fireEvent.click(screen.getByRole("button", { name: "Update" }));
			await waitFor(() => {
				const mutations = result.client.getMutationCache().getAll();
				expect(mutations).toHaveLength(1);
				expect(["success", "error"]).toContain(mutations[0]?.state.status);
			});
			expect(result.onSave).not.toHaveBeenCalled();
			expect(result.onSaved).not.toHaveBeenCalled();
			expect(screen.getByRole("alert")).toHaveTextContent(/outcome.*not.*verified/i);
			expect(document.body).not.toHaveTextContent(privateError);
			expect(screen.getByLabelText("Name")).toHaveValue("Synthetic renamed channel");
			expect(screen.getByLabelText("HTTP Method")).toHaveValue("PUT");
			expect(screen.getByLabelText("Webhook URL")).toHaveValue("");
			expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
			fireEvent.click(screen.getByRole("button", { name: "Update" }));
			expect(requests.writes).toEqual([draft]);
			expect(result.client.getQueryData(notificationKeys.channels)).toEqual([channel]);
			expect(requests.reads.filter((path) => path === configPath)).toHaveLength(1);
			expect(requests.reads.filter((path) => path === typesPath)).toHaveLength(1);
		},
	);

	it("unknown outcome requires explicit current-settings reload before a fresh-revision write", async () => {
		let response = 0;
		let configuration = config;
		const requests = transport(() => (++response === 1 ? json(null) : json(acknowledgment)), {
			configuration: () => configuration,
		});
		const result = mount();
		await screen.findByDisplayValue("Original synthetic channel");
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: draft.name } });
		fireEvent.change(screen.getByLabelText("HTTP Method"), { target: { value: "PUT" } });
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(/outcome.*not.*verified/i),
		);
		expect(requests.writes).toHaveLength(1);
		configuration = {
			...config,
			name: "Current committed settings",
			configRevision: "c".repeat(64),
		};
		fireEvent.click(
			screen.getByRole("button", { name: /reload current settings.*discards draft/i }),
		);
		await screen.findByDisplayValue("Current committed settings");
		expect(screen.getByLabelText("HTTP Method")).toHaveValue("POST");
		expect(requests.writes).toHaveLength(1);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: draft.name } });
		fireEvent.change(screen.getByLabelText("HTTP Method"), { target: { value: "PUT" } });
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(result.onSave).toHaveBeenCalledOnce());
		expect(result.onSaved).toHaveBeenCalledExactlyOnceWith(channel.id);
		expect(requests.writes).toEqual([draft, { ...draft, expectedRevision: "c".repeat(64) }]);
		expect(requests.reads.filter((path) => path === configPath)).toHaveLength(2);
	});

	it.each(["pending", "failed"] as const)(
		"closing an unknown save leaves last-known channels honestly labeled during %s readback",
		async (mode) => {
			const pending: Array<(value: Response) => void> = [];
			const requests = transport(() => json(null), {
				list: () =>
					mode === "failed"
						? json({ message: privateError }, 503)
						: new Promise((resolve) => pending.push(resolve)),
			});
			const result = mount(true);
			fireEvent.click(screen.getByTitle("Edit channel"));
			await screen.findByDisplayValue("Original synthetic channel");
			fireEvent.change(screen.getByLabelText("Name"), { target: { value: draft.name } });
			fireEvent.click(screen.getByRole("button", { name: "Update" }));
			await waitFor(() => expect(screen.getByRole("button", { name: "Update" })).toBeDisabled());
			await waitFor(() =>
				expect(requests.reads.filter((path) => path === listPath).length).toBeGreaterThan(0),
			);
			fireEvent.click(screen.getByRole("button", { name: "Close channel form" }));
			expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
			await screen.findByText(/showing last-known notification channels/i);
			if (mode === "failed") {
				await screen.findByText(/last-known.*refresh failed/i, {}, { timeout: 3000 });
				expect(requests.reads.filter((path) => path === listPath)).toHaveLength(2);
			} else {
				expect(pending).toHaveLength(1);
				await act(async () => pending[0]!(json([acknowledgment])));
				await screen.findByText("Synthetic renamed channel");
				expect(
					screen.queryByText(/showing last-known notification channels/i),
				).not.toBeInTheDocument();
			}
			expect(document.body).not.toHaveTextContent(privateError);
			expect(requests.writes).toHaveLength(1);
			if (mode === "failed")
				expect(result.client.getQueryData(notificationKeys.channels)).toEqual([channel]);
		},
	);
});
