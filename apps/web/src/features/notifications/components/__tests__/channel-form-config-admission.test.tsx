import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ApiError, NetworkError } from "../../../../lib/api-client/base";
import { type ChannelTypeInfo, notificationsApi } from "../../../../lib/api-client/notifications";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { ChannelForm } from "../channel-form";

const marker = "••••••••";
const privateDetail = "synthetic-private-config-detail";
const revision = "a".repeat(64);
const configs = {
	DISCORD: { webhookUrl: marker },
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
	WEBHOOK: { url: marker, method: "POST", headers: marker, secret: marker },
	SLACK: { webhookUrl: marker },
	NTFY: { serverUrl: marker, topic: "synthetic-topic", token: marker },
};
const types: ChannelTypeInfo[] = [
	{
		type: "WEBHOOK",
		label: "Webhook",
		icon: "Globe",
		formFields: [
			{ key: "url", label: "Webhook URL", type: "url", required: true },
			{ key: "method", label: "HTTP Method", type: "text" },
			{ key: "secret", label: "Signing Secret", type: "password" },
			{ key: "headers", label: "Custom Headers", type: "headers" },
		],
	},
	{
		type: "EMAIL",
		label: "Email",
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
function dto(type: keyof typeof configs = "WEBHOOK", id = "first") {
	return {
		id,
		name: "Synthetic channel",
		type,
		enabled: true,
		config: configs[type],
		configRevision: revision,
		lastTestedAt: null,
		lastTestResult: null,
		lastSentAt: null,
		lastSendResult: null,
	};
}
function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}
class EditorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override render() {
		return this.state.failed ? <div>Synthetic editor crash</div> : this.props.children;
	}
}
const clients: QueryClient[] = [];
function mount(onSave = vi.fn()) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	clients.push(client);
	client.setQueryData(notificationKeys.channelTypes, types);
	function view(id: string) {
		return (
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<EditorBoundary>
							<ChannelForm channelId={id} onSave={onSave} onCancel={() => {}} />
						</EditorBoundary>
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>
		);
	}
	const result = render(view("first"));
	return { ...result, changeChannel: (id: string) => result.rerender(view(id)), client };
}
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	localStorage.removeItem("arr-dashboard-incognito-mode");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("real editor config-read admission", () => {
	it.each([
		["missing config", { config: undefined }],
		["null config", { config: null }],
		["array config", { config: [] }],
		["primitive config", { config: privateDetail }],
		["non-string name", { name: { detail: privateDetail } }],
		["empty name", { name: "" }],
		["oversized name", { name: "x".repeat(101) }],
		["non-boolean enabled", { enabled: "false" }],
		["missing URL", { config: { method: "POST" } }],
		["invalid method", { config: { ...configs.WEBHOOK, method: "DELETE" } }],
		["public marker", { config: { ...configs.WEBHOOK, method: marker } }],
		[
			"invalid headers",
			{ config: { ...configs.WEBHOOK, headers: { Authorization: { token: privateDetail } } } },
		],
		["string SMTP port", { type: "EMAIL", config: { ...configs.EMAIL, port: "587" } }],
		["SMTP port range", { type: "EMAIL", config: { ...configs.EMAIL, port: 65536 } }],
		["SMTP boolean", { type: "EMAIL", config: { ...configs.EMAIL, secure: "false" } }],
		["public SMTP marker", { type: "EMAIL", config: { ...configs.EMAIL, user: marker } }],
		["incomplete SMTP", { type: "EMAIL", config: { ...configs.EMAIL, password: undefined } }],
		["invalid SMTP address", { type: "EMAIL", config: { ...configs.EMAIL, to: privateDetail } }],
		["wrong id", { id: "foreign" }],
		["bad revision", { configRevision: "A".repeat(64) }],
		["unsupported type", { type: "UNKNOWN" }],
	])("fails closed without an editable draft: %s", async (_label, changes) => {
		// Capture known product render failures as assertion failures, not setup errors.
		vi.spyOn(console, "error").mockImplementation(() => {});
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
			requests.push(`${options.method ?? "GET"} ${path}`);
			return json({ ...dto(), ...changes });
		});
		const onSave = vi.fn();
		mount(onSave);
		await waitFor(() => expect(screen.queryByText(/loading channel/i)).not.toBeInTheDocument());
		expect(screen.queryByText("Synthetic editor crash")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /retry loading/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /check repair/i })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
		expect(screen.queryByText(privateDetail)).not.toBeInTheDocument();
		expect(onSave).not.toHaveBeenCalled();
		expect(requests).toEqual(["GET /api/notifications/channels/first/config"]);
	});

	it.each(["WEBHOOK", "EMAIL"] as const)(
		"preserves real %s retained fields on deliberate save",
		async (type) => {
			const writes: unknown[] = [];
			vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
				if (options.method !== "PUT") return json(dto(type));
				writes.push(JSON.parse(String(options.body)));
				return json({
					id: "first",
					name: "Renamed synthetic",
					type,
					enabled: true,
					createdAt: "2026-10-01T12:00:00Z",
					updatedAt: "2026-10-06T12:00:00Z",
					lastTestedAt: null,
					lastTestResult: null,
					subscriptions: [],
				});
			});
			const onSave = vi.fn();
			mount(onSave);
			const privateInput = await screen.findByLabelText(
				type === "EMAIL" ? "Password" : "Webhook URL",
			);
			expect(privateInput).toHaveValue("");
			expect((privateInput as HTMLInputElement).checkValidity()).toBe(true);
			fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed synthetic" } });
			fireEvent.click(screen.getByRole("button", { name: "Update" }));
			await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
			expect(writes).toEqual([
				{
					name: "Renamed synthetic",
					enabled: true,
					config: configs[type],
					expectedRevision: revision,
				},
			]);
		},
	);

	it("requires explicit reread after malformed data before a deliberate save", async () => {
		let reads = 0;
		let writes = 0;
		vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
			if (options.method === "PUT") {
				writes++;
				return json({
					...dto(),
					createdAt: "2026-10-01T12:00:00Z",
					updatedAt: "2026-10-06T12:00:00Z",
					subscriptions: [],
				});
			}
			return json(++reads === 1 ? { ...dto(), enabled: privateDetail } : dto());
		});
		mount();
		fireEvent.click(await screen.findByRole("button", { name: /retry loading/i }));
		await screen.findByLabelText("Webhook URL");
		expect(reads).toBe(2);
		expect(writes).toBe(0);
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(writes).toBe(1));
	});

	it("ignores a late malformed read from a previous selection", async () => {
		let finish!: (response: Response) => void;
		const held = new Promise<Response>((resolve) => {
			finish = resolve;
		});
		vi.stubGlobal("fetch", (path: string) =>
			path.includes("/first/") ? held : Promise.resolve(json(dto("WEBHOOK", "second"))),
		);
		const view = mount();
		view.changeChannel("second");
		await screen.findByLabelText("Webhook URL");
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Second local draft" } });
		await act(async () => finish(json({ ...dto(), config: null })));
		expect(screen.getByLabelText("Name")).toHaveValue("Second local draft");
		expect(screen.queryByText("Synthetic editor crash")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /retry loading/i })).not.toBeInTheDocument();
	});

	it("keeps admitted private settings hidden and blocks writes in incognito", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
			requests.push(options.method ?? "GET");
			return json({ ...dto("EMAIL"), name: privateDetail });
		});
		mount();
		await screen.findByText(/hidden and editing is locked/i);
		for (const label of ["Name", "SMTP Host", "Username", "Password", "From Address", "To Address"])
			expect(screen.getByLabelText(label)).toHaveValue("");
		expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
		expect(screen.queryByText(privateDetail)).not.toBeInTheDocument();
		expect(requests).toEqual(["GET"]);
	});

	it("does not publish a malformed read to the existing list cache", async () => {
		vi.stubGlobal("fetch", async () => json({ ...dto(), enabled: privateDetail }));
		const view = mount();
		const listed = [{ id: "first", name: "Unchanged list evidence" }];
		view.client.setQueryDefaults(notificationKeys.channels, { gcTime: Infinity });
		view.client.setQueryData(notificationKeys.channels, listed);
		await screen.findByRole("button", { name: /retry loading/i });
		expect(view.client.getQueryData(notificationKeys.channels)).toEqual(listed);
	});
});

describe("real config client admission", () => {
	it.each(Object.keys(configs) as Array<keyof typeof configs>)(
		"admits and projects the actual six-field %s DTO",
		async (type) => {
			vi.stubGlobal("fetch", async () =>
				json({
					...dto(type),
					debug: privateDetail,
					config: { ...configs[type], debug: privateDetail },
				}),
			);
			expect(await notificationsApi.getChannelConfig("first")).toEqual({
				id: "first",
				name: "Synthetic channel",
				type,
				enabled: true,
				configRevision: revision,
				config: configs[type],
			});
		},
	);
	it.each([null, [], { ...dto(), id: "foreign" }, { ...dto(), config: null }])(
		"rejects inadmissible data with a private generic error: %#",
		async (value) => {
			vi.stubGlobal("fetch", async () => json(value));
			await expect(notificationsApi.getChannelConfig("first")).rejects.toMatchObject({
				message: "Channel settings could not be verified.",
			});
		},
	);
	it.each([401, 403, 404, 503])(
		"preserves existing transport classification: %s",
		async (status) => {
			vi.stubGlobal("fetch", async () => json({ message: "Synthetic transport error" }, status));
			const error = await notificationsApi
				.getChannelConfig("first")
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(ApiError);
			expect(error).toMatchObject({ status });
		},
	);
	it("preserves network errors rather than reclassifying transport as schema failure", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new Error("Synthetic network failure");
		});
		await expect(notificationsApi.getChannelConfig("first")).rejects.toBeInstanceOf(NetworkError);
	});
	it("excludes raw schema issues, payload and cause from malformed-read feedback", async () => {
		vi.stubGlobal("fetch", async () =>
			json({
				...dto(),
				config: { ...configs.WEBHOOK, headers: { privateDetail: { value: privateDetail } } },
			}),
		);
		const error = await notificationsApi
			.getChannelConfig("first")
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ message: "Channel settings could not be verified." });
		expect(error).not.toHaveProperty("cause");
		expect(error).not.toHaveProperty("issues");
		expect(error).not.toHaveProperty("payload");
		expect(String(error)).not.toContain(privateDetail);
	});
});
