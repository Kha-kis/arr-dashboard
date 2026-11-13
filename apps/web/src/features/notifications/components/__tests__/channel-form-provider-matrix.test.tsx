import type { NotificationChannelType } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationDispatcher } from "../../../../../../api/src/lib/notifications/notification-dispatcher";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { ChannelForm } from "../channel-form";

type OrdinaryType = Exclude<NotificationChannelType, "BROWSER_PUSH">;
interface ProviderCase {
	type: OrdinaryType;
	stored: Record<string, unknown>;
	wantRetained: Record<string, unknown>;
	replaceKey: string;
	replaceValue: string;
	wantReplacement: Record<string, unknown>;
}
// Independent, hand-checked input and expected payloads. No privacy/schema helper
// computes either expected config, and no duplicate plugin descriptors are used.
const cases: ProviderCase[] = [
	{
		type: "DISCORD",
		stored: { webhookUrl: "••••••••" },
		wantRetained: { webhookUrl: "••••••••" },
		replaceKey: "webhookUrl",
		replaceValue: "https://discord.synthetic.invalid/replacement",
		wantReplacement: { webhookUrl: "https://discord.synthetic.invalid/replacement" },
	},
	{
		type: "TELEGRAM",
		stored: { botToken: "••••••••", chatId: "synthetic-chat" },
		wantRetained: { botToken: "••••••••", chatId: "synthetic-chat" },
		replaceKey: "botToken",
		replaceValue: "synthetic-new-bot-token",
		wantReplacement: { botToken: "synthetic-new-bot-token", chatId: "synthetic-chat" },
	},
	{
		type: "EMAIL",
		stored: {
			host: "smtp.synthetic.invalid",
			port: 587,
			secure: false,
			user: "synthetic-user",
			password: "••••••••",
			from: "from@synthetic.invalid",
			to: "to@synthetic.invalid",
		},
		wantRetained: {
			host: "smtp.synthetic.invalid",
			port: 587,
			secure: false,
			user: "synthetic-user",
			password: "••••••••",
			from: "from@synthetic.invalid",
			to: "to@synthetic.invalid",
		},
		replaceKey: "password",
		replaceValue: "synthetic-new-smtp-password",
		wantReplacement: {
			host: "smtp.synthetic.invalid",
			port: 587,
			secure: false,
			user: "synthetic-user",
			password: "synthetic-new-smtp-password",
			from: "from@synthetic.invalid",
			to: "to@synthetic.invalid",
		},
	},
	{
		type: "PUSHBULLET",
		stored: { apiToken: "••••••••" },
		wantRetained: { apiToken: "••••••••" },
		replaceKey: "apiToken",
		replaceValue: "synthetic-new-pushbullet-token",
		wantReplacement: { apiToken: "synthetic-new-pushbullet-token" },
	},
	{
		type: "PUSHOVER",
		stored: { userKey: "••••••••", apiToken: "••••••••" },
		wantRetained: { userKey: "••••••••", apiToken: "••••••••" },
		replaceKey: "apiToken",
		replaceValue: "synthetic-new-pushover-token",
		wantReplacement: { userKey: "••••••••", apiToken: "synthetic-new-pushover-token" },
	},
	{
		type: "GOTIFY",
		stored: { serverUrl: "••••••••", appToken: "••••••••" },
		wantRetained: { serverUrl: "••••••••", appToken: "••••••••" },
		replaceKey: "serverUrl",
		replaceValue: "https://gotify.synthetic.invalid/replacement",
		wantReplacement: {
			serverUrl: "https://gotify.synthetic.invalid/replacement",
			appToken: "••••••••",
		},
	},
	{
		type: "WEBHOOK",
		stored: { url: "••••••••", method: "POST", secret: "••••••••", headers: "••••••••" },
		wantRetained: { url: "••••••••", method: "POST", secret: "••••••••", headers: "••••••••" },
		replaceKey: "url",
		replaceValue: "https://webhook.synthetic.invalid/replacement",
		wantReplacement: {
			url: "https://webhook.synthetic.invalid/replacement",
			method: "POST",
			secret: "••••••••",
			headers: "••••••••",
		},
	},
	{
		type: "SLACK",
		stored: { webhookUrl: "••••••••" },
		wantRetained: { webhookUrl: "••••••••" },
		replaceKey: "webhookUrl",
		replaceValue: "https://slack.synthetic.invalid/replacement",
		wantReplacement: { webhookUrl: "https://slack.synthetic.invalid/replacement" },
	},
	{
		type: "NTFY",
		stored: { serverUrl: "••••••••", topic: "synthetic-topic", token: "••••••••" },
		wantRetained: { serverUrl: "••••••••", topic: "synthetic-topic", token: "••••••••" },
		replaceKey: "serverUrl",
		replaceValue: "https://ntfy.synthetic.invalid/replacement",
		wantReplacement: {
			serverUrl: "https://ntfy.synthetic.invalid/replacement",
			topic: "synthetic-topic",
			token: "••••••••",
		},
	},
];
// Construction only registers existing sender objects in memory. Neither sender
// registration overrides nor test/send/transporter methods are ever invoked.
const manifests = new NotificationDispatcher().getPluginManifests();
const typesPath = "/api/notifications/channel-types";
const configPath = "/api/notifications/channels/owned-channel/config";
const updatePath = "/api/notifications/channels/owned-channel";
const marker = "••••••••";
const revision = "c".repeat(64);
const privateError = "synthetic-private-provider-error";
const clients: QueryClient[] = [];
const unexpectedRequests: string[] = [];
interface RequestRecord {
	path: string;
	method: string;
	body: unknown;
}
function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}
function Editor({ onSave }: { onSave: () => void }) {
	const [open, setOpen] = useState(true);
	return open ? (
		<ChannelForm
			channelId="owned-channel"
			onSave={() => {
				onSave();
				setOpen(false);
			}}
			onCancel={() => setOpen(false)}
		/>
	) : (
		<div>Editor closed after acknowledgment</div>
	);
}
function mount(
	fixture: ProviderCase,
	options: {
		rejectFirstWrite?: boolean;
		failFirstRead?: boolean;
		stored?: Record<string, unknown>;
	} = {},
) {
	const requests: RequestRecord[] = [];
	let configReads = 0;
	let puts = 0;
	const ack = {
		id: "owned-channel",
		name: "Renamed synthetic channel",
		type: fixture.type,
		enabled: true,
		createdAt: "2026-10-01T12:00:00.000Z",
		updatedAt: "2026-10-06T12:00:00.000Z",
		subscriptions: ["SYSTEM_ERROR"],
		lastTestedAt: null,
		lastTestResult: null,
	};
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input);
		const method = init.method ?? "GET";
		const body: unknown = init.body === undefined ? undefined : JSON.parse(String(init.body));
		requests.push({ path, method, body });
		if (path === typesPath && method === "GET" && body === undefined) return json(manifests);
		if (path === configPath && method === "GET" && body === undefined) {
			configReads++;
			if (options.failFirstRead && configReads === 1) return json({ message: privateError }, 503);
			return json({
				id: "owned-channel",
				name: "Stored synthetic channel",
				type: fixture.type,
				enabled: true,
				config: options.stored ?? fixture.stored,
				configRevision: revision,
				lastTestedAt: null,
				lastTestResult: null,
				lastSentAt: null,
				lastSendResult: null,
			});
		}
		if (path === updatePath && method === "PUT") {
			puts++;
			return options.rejectFirstWrite && puts === 1
				? json({ message: privateError }, 400)
				: json(ack);
		}
		unexpectedRequests.push(`${method} ${path}`);
		throw new Error("Unexpected synthetic matrix request");
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	clients.push(client);
	// Preserve a real list row so useUpdateChannel reconciliation is observable.
	client.setQueryDefaults(notificationKeys.channels, { gcTime: Infinity });
	client.setQueryData(notificationKeys.channels, [{ ...ack, name: "Stored synthetic channel" }]);
	const onSave = vi.fn();
	const view = render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<Editor onSave={onSave} />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return { ...view, requests, client, onSave };
}
function manifest(fixture: ProviderCase) {
	const found = manifests.find((item) => item.type === fixture.type);
	if (!found) throw new Error(`Missing actual ordinary provider manifest: ${fixture.type}`);
	return found;
}
function field(fixture: ProviderCase, key: string) {
	const found = manifest(fixture).formFields.find((item) => item.key === key);
	if (!found) throw new Error(`Missing actual provider field: ${key}`);
	return found.type === "boolean"
		? screen.getByRole("switch", { name: found.label })
		: screen.getByLabelText(found.label);
}
async function ready(fixture: ProviderCase) {
	await screen.findByRole("button", { name: "Update" });
	// Literal configurations contain all real descriptor fields; omitting a
	// registered field cannot silently shrink this matrix's UI checks.
	const actual = manifest(fixture);
	expect(actual.formFields.map((item) => item.key).sort()).toEqual(
		Object.keys(fixture.stored).sort(),
	);
	for (const descriptor of actual.formFields) {
		const control = field(fixture, descriptor.key);
		const stored = fixture.stored[descriptor.key];
		if (descriptor.type === "boolean") {
			expect(control).toHaveAttribute("aria-checked", String(stored));
			continue;
		}
		if (descriptor.type === "headers") expect(control.tagName).toBe("TEXTAREA");
		else expect(control).toHaveAttribute("type", descriptor.type);
		if (stored === marker) {
			expect(control).toHaveValue("");
			expect(control).toHaveAttribute("placeholder", expect.stringMatching(/stored.*retain/i));
			if (descriptor.required) {
				expect(control).not.toBeRequired();
				expect((control as HTMLInputElement).checkValidity()).toBe(true);
			}
		} else {
			if (typeof stored !== "string" && typeof stored !== "number")
				throw new Error("Unexpected non-input value in the literal provider fixture");
			expect(control).toHaveValue(stored);
		}
	}
	expect((screen.getByLabelText("Name").closest("form") as HTMLFormElement).checkValidity()).toBe(
		true,
	);
}
function rename() {
	fireEvent.change(screen.getByLabelText("Name"), {
		target: { value: "Renamed synthetic channel" },
	});
}
function expectedWrite(config: Record<string, unknown>) {
	return {
		path: updatePath,
		method: "PUT",
		body: { name: "Renamed synthetic channel", enabled: true, config, expectedRevision: revision },
	};
}
async function saved(view: ReturnType<typeof mount>) {
	await screen.findByText("Editor closed after acknowledgment");
	expect(view.onSave).toHaveBeenCalledOnce();
	expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
	expect(view.client.getQueryData(notificationKeys.channels)).toEqual([
		expect.objectContaining({ id: "owned-channel", name: "Renamed synthetic channel" }),
	]);
}
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	localStorage.removeItem("arr-dashboard-incognito-mode");
	vi.unstubAllGlobals();
	expect(unexpectedRequests.splice(0)).toEqual([]);
});

describe.each(cases)("actual registered $type editor", (fixture) => {
	it("renders the real GET catalogue and retained/public controls without dispatching a write", async () => {
		const view = mount(fixture);
		await ready(fixture);
		expect(view.requests).toEqual(
			expect.arrayContaining([
				{ path: typesPath, method: "GET", body: undefined },
				{ path: configPath, method: "GET", body: undefined },
			]),
		);
		expect(view.requests).toHaveLength(2);
		expect(view.onSave).not.toHaveBeenCalled();
	});
	it("renames with typed retained values/current revision and closes once after valid ACK", async () => {
		const view = mount(fixture);
		await ready(fixture);
		rename();
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await saved(view);
		expect(view.requests.filter((request) => request.method !== "GET")).toEqual([
			expectedWrite(fixture.wantRetained),
		]);
		expect(view.requests).toHaveLength(3);
	});
	it("replaces the selected private value without dropping other markers/public values", async () => {
		const view = mount(fixture);
		await ready(fixture);
		rename();
		fireEvent.change(field(fixture, fixture.replaceKey), {
			target: { value: fixture.replaceValue },
		});
		expect((field(fixture, fixture.replaceKey) as HTMLInputElement).checkValidity()).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await saved(view);
		expect(view.requests.filter((request) => request.method !== "GET")).toEqual([
			expectedWrite(fixture.wantReplacement),
		]);
		expect(view.requests).toHaveLength(3);
	});
	it("retains a known400 rejected draft without automatic replay and retries deliberately", async () => {
		const view = mount(fixture, { rejectFirstWrite: true });
		await ready(fixture);
		rename();
		fireEvent.change(field(fixture, fixture.replaceKey), {
			target: { value: fixture.replaceValue },
		});
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/could not be saved.*retry/i);
		expect(screen.queryByText(privateError)).not.toBeInTheDocument();
		expect(screen.getByLabelText("Name")).toHaveValue("Renamed synthetic channel");
		expect(field(fixture, fixture.replaceKey)).toHaveValue(fixture.replaceValue);
		expect(view.onSave).not.toHaveBeenCalled();
		await act(async () => {});
		expect(view.requests.filter((request) => request.method !== "GET")).toEqual([
			expectedWrite(fixture.wantReplacement),
		]);
		await waitFor(() => expect(screen.getByRole("button", { name: "Update" })).not.toBeDisabled());
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await saved(view);
		expect(view.requests.filter((request) => request.method !== "GET")).toEqual([
			expectedWrite(fixture.wantReplacement),
			expectedWrite(fixture.wantReplacement),
		]);
		expect(view.requests).toHaveLength(4);
	});
	it("recovers a failed config GET only on explicit Retry loading before deliberate save", async () => {
		const view = mount(fixture, { failFirstRead: true });
		const retry = await screen.findByRole("button", { name: /retry loading/i });
		expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
		expect(screen.queryByText(privateError)).not.toBeInTheDocument();
		expect(view.requests).toHaveLength(2);
		fireEvent.click(retry);
		await ready(fixture);
		expect(view.requests.filter((request) => request.path === configPath)).toHaveLength(2);
		expect(view.requests.filter((request) => request.method !== "GET")).toEqual([]);
		rename();
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await saved(view);
		expect(view.requests.filter((request) => request.method !== "GET")).toEqual([
			expectedWrite(fixture.wantRetained),
		]);
		expect(view.requests).toHaveLength(4);
	});
	it("hides all text values and rejects forced submit under incognito", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		const view = mount(fixture);
		await screen.findByText(/hidden and editing is locked/i);
		expect(screen.getByLabelText("Name")).toHaveValue("");
		for (const descriptor of manifest(fixture).formFields) {
			const control = field(fixture, descriptor.key);
			if (descriptor.type === "number") {
				expect(control).toHaveValue(null);
				expect((control as HTMLInputElement).value).toBe("");
			} else if (descriptor.type !== "boolean") expect(control).toHaveValue("");
			expect(control).toBeDisabled();
		}
		const submit = screen.getByRole("button", { name: "Update" });
		expect(submit).toBeDisabled();
		fireEvent.submit(submit.closest("form") as HTMLFormElement);
		await act(async () => {});
		expect(view.requests).toHaveLength(2);
		expect(view.onSave).not.toHaveBeenCalled();
		expect(screen.queryByDisplayValue("synthetic-chat")).not.toBeInTheDocument();
		expect(screen.queryByDisplayValue("synthetic-topic")).not.toBeInTheDocument();
	});
});

describe("real descriptor typed/optional controls", () => {
	it("EMAIL edits remain numeric/boolean in the saved configuration", async () => {
		const fixture = cases.find((item) => item.type === "EMAIL")!;
		const view = mount(fixture);
		await ready(fixture);
		rename();
		fireEvent.change(field(fixture, "port"), { target: { value: "465" } });
		fireEvent.click(field(fixture, "secure"));
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await saved(view);
		expect(view.requests.filter((request) => request.method !== "GET")).toEqual([
			expectedWrite({
				host: "smtp.synthetic.invalid",
				port: 465,
				secure: true,
				user: "synthetic-user",
				password: "••••••••",
				from: "from@synthetic.invalid",
				to: "to@synthetic.invalid",
			}),
		]);
	});
	it("WEBHOOK serializes a stored headers object and deliberately clears optional retained signing secret", async () => {
		const fixture = cases.find((item) => item.type === "WEBHOOK")!;
		const view = mount(fixture, {
			stored: {
				url: marker,
				method: "PUT",
				secret: marker,
				headers: { Authorization: "synthetic-stored-header" },
			},
		});
		await screen.findByRole("button", { name: "Update" });
		rename();
		expect(field(fixture, "headers")).toHaveValue(
			'{\n  "Authorization": "synthetic-stored-header"\n}',
		);
		fireEvent.click(screen.getByRole("button", { name: /clear stored signing secret/i }));
		fireEvent.change(field(fixture, "headers"), {
			target: { value: '{"Authorization":"synthetic-replacement-header","X-Synthetic":"value"}' },
		});
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await saved(view);
		expect(view.requests.filter((request) => request.method !== "GET")).toEqual([
			expectedWrite({
				url: "••••••••",
				method: "PUT",
				secret: "",
				headers: { Authorization: "synthetic-replacement-header", "X-Synthetic": "value" },
			}),
		]);
	});
	it("NTFY explicitly clears the optional stored token without changing retained server/public topic", async () => {
		const fixture = cases.find((item) => item.type === "NTFY")!;
		const view = mount(fixture);
		await ready(fixture);
		rename();
		fireEvent.click(screen.getByRole("button", { name: /clear stored access token/i }));
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await saved(view);
		expect(view.requests.filter((request) => request.method !== "GET")).toEqual([
			expectedWrite({ serverUrl: "••••••••", topic: "synthetic-topic", token: "" }),
		]);
	});
});
