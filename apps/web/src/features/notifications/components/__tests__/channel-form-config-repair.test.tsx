import { emailConfigSchema, type NotificationChannelResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ApiError } from "../../../../lib/api-client/base";
import {
	NotificationChannelUpdateUnverifiedError,
	notificationsApi,
} from "../../../../lib/api-client/notifications";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { ChannelForm } from "../channel-form";
import { NotificationsTab } from "../notifications-tab";

const revision = "a".repeat(64);
const state = {
	id: "owned",
	name: "Synthetic private channel",
	type: "WEBHOOK",
	enabled: false,
	configRevision: revision,
	state: "repair-required",
};
const channel = {
	id: "owned",
	name: state.name,
	type: "WEBHOOK",
	enabled: false,
	lastTestedAt: "2026-01-01T00:00:00Z",
	lastTestResult: "success",
	lastSentAt: "2026-01-01T00:00:00Z",
	lastSendResult: "failed",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	subscriptions: ["HUNT_COMPLETED"],
};
const definitions = [
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
];
const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
type Request = { path: string; method: string; body: unknown };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
beforeEach(() => {
	localStorage.clear();
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function fixture(
	options: {
		state?: unknown;
		ack?: unknown;
		status?: number;
		configReadable?: boolean;
		slowCheck?: Promise<Response>;
		slowSave?: Promise<Response>;
		missingDefinitions?: boolean;
	} = {},
) {
	const requests: Request[] = [];
	let currentState: unknown = options.state ?? state;
	let acknowledgment: unknown = Object.hasOwn(options, "ack")
		? options.ack
		: { ...channel, lastTestedAt: null, lastTestResult: null };
	let saveStatus = options.status ?? 200;
	let checkFailed = false;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input);
		const method = init.method ?? "GET";
		requests.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
		if (method === "PUT") return options.slowSave ?? json(acknowledgment, saveStatus);
		if (path.endsWith("/edit-state"))
			return (
				options.slowCheck ??
				(checkFailed ? json({ message: "synthetic-private-read-error" }, 503) : json(currentState))
			);
		if (path.endsWith("/config"))
			return options.configReadable && requests.some((r) => r.path.endsWith("/edit-state"))
				? json({
						...channel,
						configRevision: revision,
						config: { url: "••••••••", method: "POST" },
					})
				: json({ message: "synthetic-private-config-error" }, 500);
		if (path === "/api/notifications/channel-types")
			return json(options.missingDefinitions ? [] : definitions);
		throw Error("Unexpected synthetic transport");
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	clients.push(client);
	client.setQueryData(notificationKeys.channelTypes, options.missingDefinitions ? [] : definitions);
	client.setQueryData(notificationKeys.channels, [channel]);
	const onSave = vi.fn();
	const onSaved = vi.fn();
	const onCancel = vi.fn();
	const view = (id = "owned", visible = true) => (
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					{visible ? (
						<ChannelForm channelId={id} onSave={onSave} onSaved={onSaved} onCancel={onCancel} />
					) : null}
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
	const result = render(view());
	return {
		...result,
		requests,
		client,
		onSave,
		onSaved,
		onCancel,
		change: (id: string) => result.rerender(view(id)),
		close: () => result.rerender(view("owned", false)),
		setState: (value: unknown) => {
			currentState = value;
		},
		setOutcome: (value: unknown, status = 200) => {
			acknowledgment = value;
			saveStatus = status;
		},
		failCheck: () => {
			checkFailed = true;
		},
	};
}
async function check() {
	fireEvent.click(await screen.findByRole("button", { name: "Check repair options" }));
}
async function enter() {
	await check();
	fireEvent.click(await screen.findByRole("button", { name: "Re-enter configuration" }));
	await screen.findByLabelText("Webhook URL");
}
function fill() {
	fireEvent.change(screen.getByLabelText("Webhook URL"), {
		target: { value: "https://replacement.synthetic.invalid/hook" },
	});
}
const puts = (requests: Request[]) => requests.filter((r) => r.method === "PUT");

describe("repair editor uses actual ChannelForm, hooks, client and query cache with fetch-only fixtures", () => {
	it("discovers repair with GET only, requires explicit blank re-entry and saves one revision-fenced replacement", async () => {
		const f = fixture();
		await screen.findByRole("button", { name: "Retry loading" });
		expect(f.requests.map((r) => r.path)).toEqual(["/api/notifications/channels/owned/config"]);
		await check();
		expect(await screen.findByRole("button", { name: "Re-enter configuration" })).toBeEnabled();
		expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent(/re-enter.*full configuration/i);
		expect(screen.getByRole("alert")).toHaveTextContent(/subscriptions.*rules.*history/i);
		expect(screen.getByRole("alert")).toHaveTextContent(
			/does not recover.*secrets.*encryption key/i,
		);
		expect(puts(f.requests)).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Re-enter configuration" }));
		const url = await screen.findByLabelText("Webhook URL");
		expect(url).toHaveValue("");
		expect(url).toBeRequired();
		expect(screen.getByLabelText("Signing Secret")).toHaveValue("");
		expect(screen.getByLabelText("Custom Headers")).toHaveValue("");
		expect(screen.getByLabelText("Name")).toHaveValue(state.name);
		expect(screen.getByLabelText("Name")).toHaveAttribute("readonly");
		expect(screen.getByRole("switch", { name: "Enabled" })).toBeDisabled();
		fill();
		fireEvent.click(screen.getByRole("button", { name: "Save replacement" }));
		await waitFor(() => expect(f.onSave).toHaveBeenCalledOnce());
		expect(f.onSaved).toHaveBeenCalledWith("owned");
		expect(puts(f.requests)).toEqual([
			{
				path: "/api/notifications/channels/owned",
				method: "PUT",
				body: {
					config: { url: "https://replacement.synthetic.invalid/hook" },
					expectedRevision: revision,
				},
			},
		]);
		expect(f.client.getQueryData(notificationKeys.channels)).toEqual([
			{ ...channel, lastTestedAt: null, lastTestResult: null },
		]);
		expect(f.requests.every((r) => r.method === "GET" || r.method === "PUT")).toBe(true);
		expect(screen.queryByText(/delivered|test passed/i)).not.toBeInTheDocument();
	});
	it("readable admission offers only the ordinary current config read", async () => {
		const f = fixture({ state: { ...state, state: "readable" }, configReadable: true });
		await check();
		expect(await screen.findByRole("button", { name: "Retry loading" })).toBeEnabled();
		expect(
			screen.queryByRole("button", { name: "Re-enter configuration" }),
		).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
		await screen.findByRole("button", { name: "Update" });
		expect(puts(f.requests)).toHaveLength(0);
		expect(f.requests.filter((r) => r.path.endsWith("/config"))).toHaveLength(2);
	});
	it("failed admission stays generic and explicit Retry loading remains GET only", async () => {
		const f = fixture();
		f.failCheck();
		await check();
		expect(await screen.findByRole("alert")).toHaveTextContent(/could not be verified/i);
		expect(screen.queryByText("synthetic-private-read-error")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Re-enter configuration" }),
		).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
		await waitFor(() =>
			expect(f.requests.filter((r) => r.path.endsWith("/config"))).toHaveLength(2),
		);
		expect(puts(f.requests)).toHaveLength(0);
	});
	it.each([
		{ ...state, id: "foreign" },
		{ ...state, configRevision: undefined },
		{ ...state, configRevision: "A".repeat(64) },
		{ ...state, type: "UNKNOWN" },
		{ ...state, state: "unknown" },
		{ ...state, config: { password: "synthetic-private" } },
	])("malformed admission %j cannot open a replacement editor", async (value) => {
		const f = fixture({ state: value });
		await check();
		expect(await screen.findByRole("alert")).toHaveTextContent(/could not be verified/i);
		expect(
			screen.queryByRole("button", { name: "Re-enter configuration" }),
		).not.toBeInTheDocument();
		expect(puts(f.requests)).toHaveLength(0);
	});
	it("missing selected definitions blocks re-entry rather than guessing a type", async () => {
		const f = fixture({ state: { ...state, type: "SLACK" } });
		await check();
		await screen.findByRole("button", { name: "Re-enter configuration" });
		expect(screen.getByRole("button", { name: "Re-enter configuration" })).toBeDisabled();
		expect(puts(f.requests)).toHaveLength(0);
	});
	it("the actual dynamically registered Browser Push empty descriptor cannot admit manual repair", async () => {
		const f = fixture({ state: { ...state, type: "BROWSER_PUSH" } });
		// NotificationDispatcher's dynamic sender manifest deliberately has no manual fields.
		f.client.setQueryData(notificationKeys.channelTypes, [
			...definitions,
			{ type: "BROWSER_PUSH", label: "Browser Push", icon: "Bell", formFields: [] },
		]);
		await check();
		expect(await screen.findByRole("button", { name: "Re-enter configuration" })).toBeDisabled();
		expect(screen.getByRole("alert")).toHaveTextContent(/manual.*cannot.*re-enter/i);
		expect(screen.getByRole("alert")).toHaveTextContent(/reconnect.*action below/i);
		expect(
			screen.getByRole("button", { name: "Reconnect this channel to this browser" }),
		).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Confirm reconnect" })).not.toBeInTheDocument();
		expect(puts(f.requests)).toHaveLength(0);
	});
	it("loss of usable repair fields after re-entry blocks a replacement save", async () => {
		const f = fixture();
		await enter();
		fill();
		await act(async () => {
			f.client.setQueryData(notificationKeys.channelTypes, [{ ...definitions[0], formFields: [] }]);
		});
		await screen.findByRole("alert");
		expect(screen.queryByRole("button", { name: "Save replacement" })).not.toBeInTheDocument();
		expect(puts(f.requests)).toHaveLength(0);
	});
	it("pending checks are single-flight and late results cannot populate a changed channel", async () => {
		const pending = deferred<Response>();
		const f = fixture({ slowCheck: pending.promise });
		const button = await screen.findByRole("button", { name: "Check repair options" });
		fireEvent.click(button);
		fireEvent.click(button);
		expect(f.requests.filter((r) => r.path.endsWith("/edit-state"))).toHaveLength(1);
		f.change("second");
		await act(async () => {
			pending.resolve(json(state));
			await pending.promise;
		});
		await screen.findByRole("button", { name: "Check repair options" });
		expect(
			screen.queryByRole("button", { name: "Re-enter configuration" }),
		).not.toBeInTheDocument();
		expect(screen.queryByDisplayValue(state.name)).not.toBeInTheDocument();
		expect(puts(f.requests)).toHaveLength(0);
	});
	it("late check after unmount cannot enable or save a resource", async () => {
		const pending = deferred<Response>();
		const f = fixture({ slowCheck: pending.promise });
		await check();
		f.close();
		await act(async () => {
			pending.resolve(json(state));
			await pending.promise;
		});
		expect(
			screen.queryByRole("button", { name: "Re-enter configuration" }),
		).not.toBeInTheDocument();
		expect(puts(f.requests)).toHaveLength(0);
		expect(f.onSave).not.toHaveBeenCalled();
	});
	it("cancel before check completion retires the read even if parent retains the form", async () => {
		const pending = deferred<Response>();
		const f = fixture({ slowCheck: pending.promise });
		await check();
		fireEvent.click(screen.getByRole("button", { name: "Go back" }));
		await act(async () => {
			pending.resolve(json(state));
			await pending.promise;
		});
		expect(f.onCancel).toHaveBeenCalledOnce();
		expect(
			screen.queryByRole("button", { name: "Re-enter configuration" }),
		).not.toBeInTheDocument();
		expect(puts(f.requests)).toHaveLength(0);
	});
	it("pending replacement submit is single-flight", async () => {
		const pending = deferred<Response>();
		const f = fixture({ slowSave: pending.promise });
		await enter();
		fill();
		const button = screen.getByRole("button", { name: "Save replacement" });
		fireEvent.click(button);
		fireEvent.click(button);
		await waitFor(() => expect(puts(f.requests)).toHaveLength(1));
		expect(button).toBeDisabled();
		await act(async () => {
			pending.resolve(json({ ...channel, lastTestedAt: null, lastTestResult: null }));
			await pending.promise;
		});
		await waitFor(() => expect(f.onSave).toHaveBeenCalledOnce());
	});
	it.each([
		{
			ack: { code: "CHANNEL_SETTINGS_CONFLICT", message: "synthetic-private-conflict" },
			status: 409,
		},
		{ ack: undefined },
		{ ack: { ...channel, id: "foreign" } },
		{ ack: { error: "synthetic-private-unknown" }, status: 503 },
	])("conflict or unknown ACK preserves draft and blocks blind replay: %j", async (options) => {
		const f = fixture(options);
		await enter();
		fill();
		fireEvent.click(screen.getByRole("button", { name: "Save replacement" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/changed elsewhere|could not be verified/i,
		);
		expect(screen.getByLabelText("Webhook URL")).toHaveValue(
			"https://replacement.synthetic.invalid/hook",
		);
		expect(screen.getByRole("button", { name: "Save replacement" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Save replacement" }));
		expect(puts(f.requests)).toHaveLength(1);
		expect(f.onSave).not.toHaveBeenCalled();
		expect(f.client.getQueryData(notificationKeys.channels)).toEqual([channel]);
		f.setState({ ...state, configRevision: "b".repeat(64) });
		fireEvent.click(
			screen.getByRole("button", { name: /reload current settings.*discards draft/i }),
		);
		fireEvent.click(await screen.findByRole("button", { name: "Re-enter configuration" }));
		expect(await screen.findByLabelText("Webhook URL")).toHaveValue("");
		expect(puts(f.requests)).toHaveLength(1);
	});
	it("headers validation rejects malformed replacement without a PUT", async () => {
		const f = fixture();
		await enter();
		fill();
		fireEvent.change(screen.getByLabelText("Custom Headers"), {
			target: { value: '{"Authorization":{}}' },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save replacement" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/string values/i);
		expect(puts(f.requests)).toHaveLength(0);
	});
	it("explicit current read and re-entry admit a newly typed draft under the fresh revision", async () => {
		const f = fixture({ ack: { code: "CHANNEL_SETTINGS_CONFLICT" }, status: 409 });
		await enter();
		fill();
		fireEvent.click(screen.getByRole("button", { name: "Save replacement" }));
		await screen.findByRole("alert");
		f.setState({ ...state, configRevision: "b".repeat(64) });
		f.setOutcome({ ...channel, lastTestedAt: null, lastTestResult: null });
		fireEvent.click(
			screen.getByRole("button", { name: /reload current settings.*discards draft/i }),
		);
		fireEvent.click(await screen.findByRole("button", { name: "Re-enter configuration" }));
		expect(await screen.findByLabelText("Webhook URL")).toHaveValue("");
		fill();
		fireEvent.change(screen.getByLabelText("Custom Headers"), {
			target: { value: '{"Authorization":"Bearer synthetic-new-secret"}' },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save replacement" }));
		await waitFor(() => expect(f.onSave).toHaveBeenCalledOnce());
		expect(puts(f.requests).map((r) => r.body)).toEqual([
			{ config: { url: "https://replacement.synthetic.invalid/hook" }, expectedRevision: revision },
			{
				config: {
					url: "https://replacement.synthetic.invalid/hook",
					headers: { Authorization: "Bearer synthetic-new-secret" },
				},
				expectedRevision: "b".repeat(64),
			},
		]);
	});
	it("replacement uses existing boolean normalization without a metadata patch", async () => {
		const f = fixture({
			state: { ...state, type: "EMAIL" },
			ack: { ...channel, type: "EMAIL", lastTestedAt: null, lastTestResult: null },
		});
		await check();
		fireEvent.click(await screen.findByRole("button", { name: "Re-enter configuration" }));
		for (const [label, value] of [
			["SMTP Host", "smtp.synthetic.invalid"],
			["SMTP Port", "587"],
			["Username", "synthetic-user"],
			["Password", "synthetic-replacement-password"],
			["From Address", "from@synthetic.invalid"],
			["To Address", "to@synthetic.invalid"],
		])
			fireEvent.change(await screen.findByLabelText(label!), { target: { value } });
		fireEvent.click(screen.getByRole("button", { name: "Save replacement" }));
		await waitFor(() => expect(f.onSave).toHaveBeenCalledOnce());
		expect(puts(f.requests)[0]?.body).toEqual({
			config: {
				host: "smtp.synthetic.invalid",
				port: 587,
				user: "synthetic-user",
				password: "synthetic-replacement-password",
				from: "from@synthetic.invalid",
				to: "to@synthetic.invalid",
				secure: false,
			},
			expectedRevision: revision,
		});
		const payload = puts(f.requests)[0]?.body as { config: unknown } | undefined;
		expect(emailConfigSchema.safeParse(payload?.config).success).toBe(true);
	});
	it("CFG-R2: a legal whitespace-only retained name cannot strand config-only repair", async () => {
		const f = fixture({
			state: { ...state, name: " " },
			ack: { ...channel, name: " ", lastTestedAt: null, lastTestResult: null },
		});
		await enter();
		fill();
		expect(screen.getByLabelText("Name")).toHaveValue(" ");
		expect(screen.getByLabelText("Name")).toHaveAttribute("readonly");
		const save = screen.getByRole("button", { name: "Save replacement" });
		expect(save).toBeEnabled();
		fireEvent.click(save);
		await waitFor(() => expect(f.onSave).toHaveBeenCalledOnce());
		expect(puts(f.requests).map((request) => request.body)).toEqual([
			{ config: { url: "https://replacement.synthetic.invalid/hook" }, expectedRevision: revision },
		]);
		expect(f.client.getQueryData(notificationKeys.channels)).toEqual([
			{ ...channel, name: " ", lastTestedAt: null, lastTestResult: null },
		]);
	});
	it("incognito masks repair metadata and draft and blocks saving", async () => {
		const f = fixture();
		await enter();
		fill();
		await act(async () => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			window.dispatchEvent(new Event("incognito-mode-changed"));
		});
		expect(screen.queryByDisplayValue(state.name)).not.toBeInTheDocument();
		expect(screen.getByLabelText("Webhook URL")).toHaveValue("");
		fireEvent.click(screen.getByRole("button", { name: "Save replacement" }));
		expect(puts(f.requests)).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Turn off incognito to edit" }));
		expect(screen.getByLabelText("Webhook URL")).toHaveValue(
			"https://replacement.synthetic.invalid/hook",
		);
	});
});

type UncertainOutcome = "network" | "server503" | "request408";
function mountedRepairConsumer(outcome: UncertainOutcome, delayed = false) {
	const requests: Request[] = [];
	const original: NotificationChannelResponse = {
		...channel,
		type: "WEBHOOK",
		enabled: true,
		lastTestResult: "success",
		subscriptions: ["HUNT_COMPLETED"],
	};
	const committed: NotificationChannelResponse = {
		...original,
		lastTestedAt: null,
		lastTestResult: null,
		updatedAt: "2026-10-06T12:00:00Z",
	};
	let current = original;
	const writeResponse = deferred<void>();
	const readbacks: Array<ReturnType<typeof deferred<Response>>> = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input),
			method = init.method ?? "GET";
		requests.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
		if (path === "/api/notifications/channels/owned" && method === "PUT") {
			// This transport fixture models a committed encrypted replacement's public metadata.
			// Real encryption/SQLite commit coverage remains in the unchanged API receipt.
			current = committed;
			if (delayed) await writeResponse.promise;
			if (outcome === "network") throw new Error("synthetic-private-lost-response");
			return json(
				{ message: "synthetic-private-uncertain-save" },
				outcome === "server503" ? 503 : 408,
			);
		}
		if (method !== "GET" || init.body !== undefined)
			throw new Error("Forbidden synthetic Test/send/write");
		if (path === "/api/notifications/channels") {
			const pending = deferred<Response>();
			readbacks.push(pending);
			return pending.promise;
		}
		if (path === "/api/notifications/channels/owned/config")
			return current === original
				? json({ message: "synthetic-private-unreadable-settings" }, 500)
				: json({
						...current,
						configRevision: "b".repeat(64),
						config: { url: "••••••••", method: "POST" },
					});
		if (path === "/api/notifications/channels/owned/edit-state")
			return json({ ...state, enabled: true });
		if (path === "/api/notifications/channel-types") return json(definitions);
		if (path === "/api/notifications/subscriptions")
			return json({ channels: [], events: [], subscriptions: [] });
		throw new Error("Unapproved synthetic read");
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	clients.push(client);
	client.setQueryData(notificationKeys.channels, [original]);
	client.setQueryData(notificationKeys.channelTypes, definitions);
	const result = render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<NotificationsTab />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return {
		...result,
		requests,
		client,
		original,
		committed,
		readbacks,
		releaseWrite: () => writeResponse.resolve(),
		releaseRead: async (failed = false) => {
			if (!readbacks[0]) throw Error("Readback was not admitted");
			await act(async () => {
				readbacks[0]!.resolve(
					failed ? json({ message: "synthetic-private-read-failure" }, 503) : json([current]),
				);
			});
		},
	};
}

describe("CFG-R1 actual continuously mounted NotificationsTab reconciliation", () => {
	it.each(["network", "server503", "request408"] as const)(
		"committed repair with %s failure reconciles via GET while the retained Test proof stays last-known",
		async (outcome) => {
			const f = mountedRepairConsumer(outcome);
			expect(screen.getByText("Healthy")).toBeInTheDocument();
			fireEvent.click(screen.getByTitle("Edit channel"));
			await enter();
			fill();
			fireEvent.click(screen.getByRole("button", { name: "Save replacement" }));
			await screen.findByText(/save outcome could not be verified/i);
			await waitFor(() => expect(f.readbacks).toHaveLength(1));
			expect(screen.getByText(/last-known.*checking current settings/i)).toBeInTheDocument();
			expect(screen.getByText("Healthy")).toBeInTheDocument();
			expect(f.client.getQueryData(notificationKeys.channels)).toEqual([f.original]);
			expect(screen.getByLabelText("Webhook URL")).toHaveValue(
				"https://replacement.synthetic.invalid/hook",
			);
			expect(screen.getByRole("button", { name: "Save replacement" })).toBeDisabled();
			fireEvent.click(screen.getByRole("button", { name: "Save replacement" }));
			await f.releaseRead();
			await screen.findByText("Configured");
			expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
			expect(screen.queryByText(/last tested:/i)).not.toBeInTheDocument();
			expect(screen.queryByText(/last-known notification channels/i)).not.toBeInTheDocument();
			expect(f.client.getQueryData(notificationKeys.channels)).toEqual([f.committed]);
			expect(puts(f.requests).map((request) => request.body)).toEqual([
				{
					config: { url: "https://replacement.synthetic.invalid/hook" },
					expectedRevision: revision,
				},
			]);
			expect(
				f.requests.filter((request) => request.method !== "GET" && request.method !== "PUT"),
			).toEqual([]);
			expect(document.body).not.toHaveTextContent("synthetic-private");
		},
	);
	it.each(["network", "server503", "request408"] as const)(
		"failed list read after uncertain %s retains qualified old metadata without inventing completion",
		async (outcome) => {
			const f = mountedRepairConsumer(outcome);
			fireEvent.click(screen.getByTitle("Edit channel"));
			await enter();
			fill();
			fireEvent.click(screen.getByRole("button", { name: "Save replacement" }));
			await waitFor(() => expect(f.readbacks).toHaveLength(1));
			expect(screen.getByText(/last-known.*checking current settings/i)).toBeInTheDocument();
			await f.releaseRead(true);
			await screen.findByText(/last-known.*refresh failed/i);
			expect(screen.getByText("Healthy")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Save replacement" })).toBeDisabled();
			expect(f.client.getQueryData(notificationKeys.channels)).toEqual([f.original]);
			expect(puts(f.requests)).toHaveLength(1);
			expect(
				f.requests.filter((request) => request.method !== "GET" && request.method !== "PUT"),
			).toEqual([]);
			expect(document.body).not.toHaveTextContent("synthetic-private");
		},
	);
	it("navigation unmounts the old editor before lost response while domain reconciliation still protects its mounted observer", async () => {
		const f = mountedRepairConsumer("network", true);
		fireEvent.click(screen.getByTitle("Edit channel"));
		await enter();
		fill();
		fireEvent.click(screen.getByRole("button", { name: "Save replacement" }));
		await waitFor(() => expect(puts(f.requests)).toHaveLength(1));
		fireEvent.click(screen.getByRole("button", { name: "Events" }));
		expect(screen.queryByRole("button", { name: "Save replacement" })).not.toBeInTheDocument();
		await act(async () => {
			f.releaseWrite();
		});
		await waitFor(() => expect(f.readbacks).toHaveLength(1));
		fireEvent.click(screen.getByRole("button", { name: "Channels" }));
		await screen.findByRole("button", { name: "Update" });
		expect(screen.getByLabelText("Webhook URL")).toHaveValue("");
		expect(screen.queryByText(/save outcome could not be verified/i)).not.toBeInTheDocument();
		expect(screen.getByText(/last-known.*checking current settings/i)).toBeInTheDocument();
		await f.releaseRead();
		await screen.findByText("Configured");
		expect(puts(f.requests)).toHaveLength(1);
		expect(
			f.requests.filter((request) => request.method !== "GET" && request.method !== "PUT"),
		).toEqual([]);
	});
	it.each([400, 404, 409, 401, 403, 429])(
		"known %s rejection preserves existing API error semantics",
		async (status) => {
			const requests: Request[] = [];
			vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
				requests.push({ path, method: init.method!, body: JSON.parse(String(init.body)) });
				return json(
					{ code: "CHANNEL_SETTINGS_CONFLICT", message: "synthetic-private-known-rejection" },
					status,
				);
			});
			let error: unknown;
			try {
				await notificationsApi.updateChannel("owned", {
					config: { url: "https://synthetic.invalid" },
					expectedRevision: revision,
				});
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(ApiError);
			expect(error).not.toBeInstanceOf(NotificationChannelUpdateUnverifiedError);
			expect((error as ApiError).status).toBe(status);
			expect(requests).toHaveLength(1);
			expect(requests[0]?.method).toBe("PUT");
		},
	);
	it("successful-response body failure is unverified without private transport detail", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error("synthetic-private-body-read-error"));
						},
					}),
					{ status: 200, headers: { "Content-Type": "text/plain" } },
				),
		);
		await expect(
			notificationsApi.updateChannel("owned", {
				config: { url: "https://synthetic.invalid" },
				expectedRevision: revision,
			}),
		).rejects.toThrow("Channel save outcome could not be verified.");
	});
});

describe("edit-state client rejects untrusted runtime DTOs", () => {
	it.each([
		null,
		{ ...state, id: "other" },
		{ ...state, id: " " },
		{ ...state, name: "" },
		{ ...state, name: "x".repeat(101) },
		{ ...state, configRevision: undefined },
		{ ...state, configRevision: "not-a-revision" },
		{ ...state, enabled: 1 },
		{ ...state, type: "UNKNOWN" },
		{ ...state, state: "unknown" },
		{ ...state, diagnostics: "synthetic-private-diagnostic" },
	])("fails closed for %j", async (value) => {
		vi.stubGlobal("fetch", async () => json(value));
		await expect(notificationsApi.getChannelEditState("owned")).rejects.toThrow(
			"Channel repair options could not be verified.",
		);
	});
	it("accepts only matching strict metadata with no mutation", async () => {
		const requests: RequestInit[] = [];
		vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
			requests.push(options);
			return json(state);
		});
		expect(await notificationsApi.getChannelEditState("owned")).toEqual(state);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ method: "GET", credentials: "include" });
		expect(requests[0]?.body).toBeUndefined();
	});
	it("a stalled repair read has a bounded generic outcome without fallback metadata", async () => {
		vi.useFakeTimers();
		let requestSignal: AbortSignal | undefined;
		vi.stubGlobal("fetch", (_path: string, options: RequestInit) => {
			requestSignal = options.signal ?? undefined;
			return new Promise<Response>(() => {});
		});
		const result = expect(notificationsApi.getChannelEditState("owned")).rejects.toThrow(
			"Channel repair options could not be verified.",
		);
		await vi.advanceTimersByTimeAsync(10_000);
		await result;
		expect(requestSignal?.aborted).toBe(true);
	});
	it("a cancelled repair read rejects a late response instead of returning its metadata", async () => {
		const pending = deferred<Response>();
		const controller = new AbortController();
		vi.stubGlobal("fetch", () => pending.promise);
		const result = expect(
			notificationsApi.getChannelEditState("owned", controller.signal),
		).rejects.toThrow("Channel repair options could not be verified.");
		controller.abort();
		pending.resolve(json(state));
		await result;
	});
});
