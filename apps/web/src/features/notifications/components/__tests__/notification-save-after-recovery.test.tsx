import type { NotificationChannelResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// Enrollment is a separate boundary; editor, parent, hooks and client are real.
vi.mock("../browser-push-card", () => ({ BrowserPushCard: () => null }));

const catalog: ChannelTypeInfo[] = [
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
const original: NotificationChannelResponse & { lastSentAt: string; lastSendResult: string } = {
	id: "recovered-channel",
	name: "Stored synthetic channel",
	type: "WEBHOOK",
	enabled: true,
	createdAt: "2026-10-01T12:00:00.000Z",
	updatedAt: "2026-10-01T12:00:00.000Z",
	lastTestedAt: "2026-10-01T12:30:00.000Z",
	lastTestResult: "success",
	lastSentAt: "2026-10-01T13:00:00.000Z",
	lastSendResult: "success",
	subscriptions: ["SYSTEM_ERROR"],
};
const other: NotificationChannelResponse = {
	id: "unrelated-channel",
	name: "Unrelated synthetic channel",
	type: "DISCORD",
	enabled: false,
	createdAt: "2026-10-01T12:00:00.000Z",
	updatedAt: "2026-10-01T12:00:00.000Z",
	lastTestedAt: null,
	lastTestResult: null,
	subscriptions: [],
};
// Config GET is not the list/update projection: it includes last-send evidence
// but does not return creation timestamps or subscriptions.
const settings: NotificationChannelWithConfig & {
	lastTestedAt: string | null;
	lastTestResult: string | null;
	lastSentAt: string | null;
	lastSendResult: string | null;
} = {
	id: "recovered-channel",
	name: "Stored synthetic channel",
	type: "WEBHOOK",
	enabled: true,
	lastTestedAt: "2026-10-01T12:30:00.000Z",
	lastTestResult: "success",
	lastSentAt: "2026-10-01T13:00:00.000Z",
	lastSendResult: "success",
	configRevision: "b".repeat(64),
	config: { url: "••••••••", method: "POST", secret: "••••••••", headers: "••••••••" },
};
const acknowledgment: NotificationChannelResponse = {
	id: "recovered-channel",
	name: "Recovered synthetic rename",
	type: "WEBHOOK",
	enabled: true,
	createdAt: "2026-10-01T12:00:00.000Z",
	updatedAt: "2026-10-06T12:00:00.000Z",
	lastTestedAt: null,
	lastTestResult: null,
	subscriptions: ["SYSTEM_ERROR"],
};
const expectedWrite = {
	name: "Recovered synthetic rename",
	enabled: true,
	config: { url: "••••••••", method: "PUT", secret: "••••••••", headers: "••••••••" },
	expectedRevision: "b".repeat(64),
};
const typesPath = "/api/notifications/channel-types";
const configPath = "/api/notifications/channels/recovered-channel/config";
const channelsPath = "/api/notifications/channels";
const updatePath = "/api/notifications/channels/recovered-channel";
const logsPath = "/api/notifications/logs?page=1&limit=15";
const privateError = "synthetic-private-recovered-save-detail";
const clients: QueryClient[] = [];
const releases: Array<() => void> = [];
const unexpected: Array<{ path: string; method: string; body: boolean }> = [];

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
function fixture(parent = false, failListReread = false) {
	const metadata = pending(catalog),
		config = pending(settings),
		reload = pending(settings),
		firstSave = pending(acknowledgment),
		secondSave = pending(acknowledgment);
	let typeReads = 0,
		configReads = 0,
		listReads = 0,
		logReads = 0;
	const writes: unknown[] = [];
	let currentRows = [original, other];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, options: RequestInit = {}) => {
		const path = String(input),
			method = options.method ?? "GET";
		const validRead =
			method === "GET" &&
			options.body === undefined &&
			[typesPath, configPath, channelsPath, logsPath].includes(path);
		const validWrite = method === "PUT" && path === updatePath && typeof options.body === "string";
		if (!validRead && !validWrite) {
			unexpected.push({ path, method, body: options.body !== undefined });
			throw new Error("Out-of-scope recovery action");
		}
		if (validWrite) {
			writes.push(JSON.parse(String(options.body)));
			return writes.length === 1 ? firstSave.response : secondSave.response;
		}
		if (path === typesPath)
			return ++typeReads <= 2 ? json({ message: privateError }, 503) : metadata.response;
		if (path === configPath)
			return ++configReads === 1
				? json({ message: privateError }, 503)
				: configReads === 2
					? config.response
					: reload.response;
		if (path === logsPath) {
			logReads++;
			return json({ logs: [], total: 0, page: 1, limit: 15 });
		}
		return ++listReads > 1 && failListReread
			? json({ message: privateError }, 503)
			: json(currentRows);
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: 1, staleTime: 30_000, gcTime: 300_000, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	clients.push(client);
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
							channelId="recovered-channel"
							onSave={onSave}
							onSaved={onSaved}
							onCancel={() => {}}
						/>
					)}
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return {
		client,
		writes,
		reload,
		firstSave,
		secondSave,
		onSave,
		onSaved,
		counts: () => ({ typeReads, configReads, listReads, logReads }),
		async recover(order = "settings-first") {
			if (parent) {
				await screen.findByText("Stored synthetic channel");
				fireEvent.click(screen.getAllByRole("button", { name: "Edit channel" })[0]!);
			}
			await waitFor(
				() => expect(client.getQueryState(notificationKeys.channelTypes)?.status).toBe("error"),
				{ timeout: 3500 },
			);
			expect(screen.getByRole("alert")).toHaveTextContent(/settings could not be loaded/i);
			expect(document.body).not.toHaveTextContent(privateError);
			expect(writes).toHaveLength(0);
			fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
			await waitFor(() => {
				expect(typeReads).toBe(3);
				expect(configReads).toBe(2);
			});
			if (order === "settings-first") await config.finish(settings);
			else await metadata.finish(catalog);
			expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
			expect(writes).toHaveLength(0);
			if (order === "settings-first") await metadata.finish(catalog);
			else await config.finish(settings);
			await screen.findByDisplayValue("Stored synthetic channel");
			expect(screen.getByLabelText("Webhook URL")).toHaveValue("");
		},
		async acknowledge(second = false) {
			currentRows = [{ ...original, ...acknowledgment }, other];
			await (second ? secondSave : firstSave).finish(acknowledgment);
		},
	};
}
function changeAndSubmit() {
	fireEvent.change(screen.getByLabelText("Name"), {
		target: { value: "Recovered synthetic rename" },
	});
	fireEvent.change(screen.getByLabelText("HTTP Method"), { target: { value: "PUT" } });
	fireEvent.click(screen.getByRole("button", { name: "Update" }));
}
function assertPending() {
	expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
	expect(screen.getByLabelText("Name")).toBeDisabled();
	expect(screen.getByLabelText("HTTP Method")).toBeDisabled();
	expect(screen.getByRole("button", { name: "Close channel form" })).toBeDisabled();
}
afterEach(() => {
	try {
		expect(document.body).not.toHaveTextContent(privateError);
	} finally {
		cleanup();
		for (const release of releases.splice(0)) release();
		for (const client of clients.splice(0)) client.clear();
		vi.unstubAllGlobals();
		// Assertions outside transport/client catches detect swallowed bad requests.
		expect(unexpected.splice(0)).toEqual([]);
	}
});

describe("actual save following coordinated settings/catalog recovery", () => {
	it.each(["settings-first", "metadata-first"])(
		"publishes only the acknowledged row after recovery despite failed reread (%s)",
		async (order) => {
			const value = fixture(true, true);
			await value.recover(order);
			changeAndSubmit();
			await waitFor(() => expect(value.writes).toEqual([expectedWrite]));
			assertPending();
			expect(value.client.getQueryData(notificationKeys.channels)).toEqual([original, other]);
			fireEvent.click(screen.getByRole("button", { name: "Update" }));
			expect(value.writes).toHaveLength(1);
			await value.acknowledge();
			await waitFor(() =>
				expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument(),
			);
			expect(screen.getByText("Recovered synthetic rename")).toBeInTheDocument();
			expect(value.client.getQueryData(notificationKeys.channels)).toEqual([
				{ ...original, ...acknowledgment },
				other,
			]);
			await waitFor(
				() => expect(value.client.getQueryState(notificationKeys.channels)?.status).toBe("error"),
				{ timeout: 3500 },
			);
			expect(screen.getByRole("alert")).toHaveTextContent(/last-known.*refresh failed/i);
			expect(screen.getByText("Recovered synthetic rename")).toBeInTheDocument();
			expect(document.body).not.toHaveTextContent(privateError);
			expect(value.counts()).toEqual({ typeReads: 3, configReads: 2, listReads: 3, logReads: 0 });
			expect(value.writes).toEqual([expectedWrite]);
		},
	);

	it("keeps a known-rejected write draft and retries only on an explicit action using the recovered revision", async () => {
		const value = fixture();
		await value.recover();
		changeAndSubmit();
		await waitFor(() => expect(value.writes).toEqual([expectedWrite]));
		assertPending();
		await value.firstSave.finish({ message: privateError }, 400);
		expect(await screen.findByRole("alert")).toHaveTextContent(/could not be saved.*retry/i);
		expect(document.body).not.toHaveTextContent(privateError);
		expect(screen.getByLabelText("Name")).toHaveValue("Recovered synthetic rename");
		expect(screen.getByLabelText("HTTP Method")).toHaveValue("PUT");
		expect(screen.getByLabelText("Webhook URL")).toHaveValue("");
		expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
		expect(value.onSave).not.toHaveBeenCalled();
		expect(value.onSaved).not.toHaveBeenCalled();
		expect(
			value.client
				.getMutationCache()
				.getAll()
				.map((mutation) => mutation.state.status),
		).toEqual(["error"]);
		expect(value.counts()).toEqual({ typeReads: 3, configReads: 2, listReads: 0, logReads: 0 });
		expect(value.writes).toEqual([expectedWrite]);
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(value.writes).toEqual([expectedWrite, expectedWrite]));
		assertPending();
		expect(value.onSave).not.toHaveBeenCalled();
		await value.acknowledge(true);
		await waitFor(() => expect(value.onSave).toHaveBeenCalledOnce());
		expect(value.onSaved).toHaveBeenCalledExactlyOnceWith("recovered-channel");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(value.counts()).toEqual({ typeReads: 3, configReads: 2, listReads: 0, logReads: 0 });
	});

	it("requires a fresh revision after conflict and never replays the stale recovered write", async () => {
		const value = fixture();
		await value.recover();
		changeAndSubmit();
		await waitFor(() => expect(value.writes).toEqual([expectedWrite]));
		await value.firstSave.finish({ code: "CHANNEL_SETTINGS_CONFLICT", message: privateError }, 409);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/changed elsewhere.*not been saved/i,
		);
		expect(document.body).not.toHaveTextContent(privateError);
		expect(screen.getByLabelText("Name")).toHaveValue("Recovered synthetic rename");
		expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		expect(value.writes).toEqual([expectedWrite]);
		fireEvent.click(
			screen.getByRole("button", { name: /reload current settings.*discards draft/i }),
		);
		await waitFor(() => expect(value.counts().configReads).toBe(3));
		expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
		await value.reload.finish({
			...settings,
			name: "Current server channel",
			configRevision: "c".repeat(64),
		});
		await screen.findByDisplayValue("Current server channel");
		changeAndSubmit();
		await waitFor(() =>
			expect(value.writes).toEqual([
				expectedWrite,
				{
					name: "Recovered synthetic rename",
					enabled: true,
					config: { url: "••••••••", method: "PUT", secret: "••••••••", headers: "••••••••" },
					expectedRevision: "c".repeat(64),
				},
			]),
		);
		expect(value.onSave).not.toHaveBeenCalled();
		await value.acknowledge(true);
		await waitFor(() => expect(value.onSave).toHaveBeenCalledOnce());
		expect(value.onSaved).toHaveBeenCalledExactlyOnceWith("recovered-channel");
		expect(value.counts()).toEqual({ typeReads: 3, configReads: 3, listReads: 0, logReads: 0 });
	});

	it("a late save acknowledgment cannot close a new draft after ordinary parent tab navigation", async () => {
		const value = fixture(true);
		await value.recover();
		changeAndSubmit();
		await waitFor(() => expect(value.writes).toEqual([expectedWrite]));
		assertPending();
		fireEvent.click(screen.getByRole("button", { name: "Delivery Log" }));
		await waitFor(() => expect(value.counts().logReads).toBe(1));
		expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Channels" }));
		await waitFor(() => expect(value.counts().configReads).toBe(3));
		await value.reload.finish(settings);
		await screen.findByDisplayValue("Stored synthetic channel");
		fireEvent.click(screen.getByRole("button", { name: "Close channel form" }));
		fireEvent.click(screen.getByRole("button", { name: "Add Channel" }));
		fireEvent.change(await screen.findByLabelText("Name"), {
			target: { value: "New unsaved channel draft" },
		});
		fireEvent.change(screen.getByLabelText("Webhook URL"), {
			target: { value: "https://new.synthetic.invalid/hook" },
		});
		expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
		await value.acknowledge();
		await screen.findByText("Recovered synthetic rename");
		expect(screen.getByLabelText("Name")).toHaveValue("New unsaved channel draft");
		expect(screen.getByLabelText("Webhook URL")).toHaveValue("https://new.synthetic.invalid/hook");
		expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
		expect(value.client.getQueryData(notificationKeys.channels)).toEqual([
			{ ...original, ...acknowledgment },
			other,
		]);
		expect(value.writes).toEqual([expectedWrite]);
		expect(value.counts()).toEqual({ typeReads: 3, configReads: 3, listReads: 2, logReads: 1 });
	});
});
