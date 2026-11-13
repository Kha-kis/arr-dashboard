import { emailConfigSchema } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { ChannelForm } from "../channel-form";

const marker = "••••••••";
const types = [
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
];
const channel = {
	id: "first",
	name: "Synthetic channel",
	type: "WEBHOOK",
	enabled: true,
	lastTestedAt: null,
	lastTestResult: null,
	createdAt: "2026-10-01T12:00:00.000Z",
	updatedAt: "2026-10-06T12:00:00.000Z",
	subscriptions: [],
	configRevision: "a".repeat(64),
	config: { url: marker, method: "POST", secret: marker, headers: marker },
};
const clients: QueryClient[] = [];
interface ConfigWrite {
	config: Record<string, unknown>;
	expectedRevision?: string;
}
function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function mount(onSave = vi.fn(), channelId: string | null = "first") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	clients.push(client);
	client.setQueryData(notificationKeys.channelTypes, types);
	function view(id: string | null) {
		return (
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<ChannelForm channelId={id} onSave={onSave} onCancel={() => {}} />
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>
		);
	}
	const result = render(view(channelId));
	return { ...result, changeChannel: (id: string) => result.rerender(view(id)), client };
}
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
});

describe("channel edit form uses real hooks/transport and safe retained values", () => {
	it("keeps a masked URL natively valid and sends retained markers on rename", async () => {
		const writes: unknown[] = [];
		vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
			if (options.method === "PUT") {
				expect(path).toBe("/api/notifications/channels/first");
				writes.push(JSON.parse(String(options.body)));
				return json({ ...channel, name: "Renamed synthetic" });
			}
			expect(path).toBe("/api/notifications/channels/first/config");
			return json(channel);
		});
		const onSave = vi.fn();
		mount(onSave);
		const url = (await screen.findByLabelText("Webhook URL")) as HTMLInputElement;
		expect(url).toHaveValue("");
		expect(url.placeholder).toMatch(/stored.*retain/i);
		expect(url.checkValidity()).toBe(true);
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed synthetic" } });
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
		expect(writes).toEqual([
			{
				name: "Renamed synthetic",
				enabled: true,
				config: channel.config,
				expectedRevision: channel.configRevision,
			},
		]);
	});

	it("preserves an unsaved conflict draft without retrying and explicitly reloads a fresh revision", async () => {
		const writes: ConfigWrite[] = [];
		let reads = 0;
		vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
			if (options.method === "PUT") {
				writes.push(JSON.parse(String(options.body)));
				return writes.length === 1
					? json(
							{ code: "CHANNEL_SETTINGS_CONFLICT", message: "synthetic-private-conflict-text" },
							409,
						)
					: json(channel);
			}
			reads++;
			return json(
				reads === 1
					? channel
					: { ...channel, name: "Current server draft", configRevision: "b".repeat(64) },
			);
		});
		const onSave = vi.fn();
		mount(onSave);
		await screen.findByLabelText("Webhook URL");
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved local draft" } });
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/changed elsewhere/i);
		expect(screen.getByLabelText("Name")).toHaveValue("Unsaved local draft");
		expect(screen.queryByText("synthetic-private-conflict-text")).not.toBeInTheDocument();
		expect(onSave).not.toHaveBeenCalled();
		expect(writes).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		expect(writes).toHaveLength(1);
		fireEvent.click(
			screen.getByRole("button", { name: /reload current settings.*discards draft/i }),
		);
		await screen.findByDisplayValue("Current server draft");
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Reapplied local draft" } });
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
		expect(writes[0]?.expectedRevision).toBe("a".repeat(64));
		expect(writes[1]?.expectedRevision).toBe("b".repeat(64));
		expect(reads).toBe(2);
	});

	it.each([undefined, "malformed"])(
		"blocks editing when the config revision is missing or malformed: %s",
		async (configRevision) => {
			let writes = 0;
			vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
				if (options.method === "PUT") writes++;
				return json({ ...channel, configRevision });
			});
			mount();
			await screen.findByRole("button", { name: /retry loading/i });
			expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
			expect(writes).toBe(0);
		},
	);

	it("an unrelated 409 does not expose private text or permanently lock the draft", async () => {
		let puts = 0;
		vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
			if (options.method !== "PUT") return json(channel);
			puts++;
			return puts === 1
				? json({ code: "UNRELATED_CONFLICT", message: "synthetic-private-other-conflict" }, 409)
				: json(channel);
		});
		const onSave = vi.fn();
		mount(onSave);
		await screen.findByLabelText("Webhook URL");
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/could not be saved/i);
		expect(screen.queryByText("synthetic-private-other-conflict")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /reload current settings/i }),
		).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
		expect(puts).toBe(2);
	});

	it("explicitly clears optional stored secrets and headers without changing the retained URL", async () => {
		const writes: ConfigWrite[] = [];
		vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
			if (options.method === "PUT") {
				writes.push(JSON.parse(String(options.body)));
				return json(channel);
			}
			return json(channel);
		});
		mount();
		await screen.findByLabelText("Webhook URL");
		fireEvent.click(screen.getByRole("button", { name: /clear stored signing secret/i }));
		fireEvent.click(screen.getByRole("button", { name: /clear stored custom headers/i }));
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0]?.config).toEqual({ ...channel.config, secret: "", headers: {} });
	});

	it("replaces the URL and custom header map with validated user-entered values", async () => {
		const writes: ConfigWrite[] = [];
		vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
			if (options.method === "PUT") {
				writes.push(JSON.parse(String(options.body)));
				return json(channel);
			}
			return json(channel);
		});
		mount();
		await screen.findByLabelText("Webhook URL");
		fireEvent.change(screen.getByLabelText("Webhook URL"), {
			target: { value: "https://replacement.synthetic.invalid/hook" },
		});
		fireEvent.change(screen.getByLabelText("Custom Headers"), {
			target: { value: '{"Authorization":"Bearer synthetic-replacement"}' },
		});
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0]?.config).toEqual({
			...channel.config,
			url: "https://replacement.synthetic.invalid/hook",
			headers: { Authorization: "Bearer synthetic-replacement" },
		});
	});

	it.each([
		'{"Authorization":"synthetic-private-invalid-json',
		'{"Authorization":{"token":"synthetic-private-nested"}}',
		"[]",
	])("does not submit invalid header JSON or quote it in feedback: %#", async (text) => {
		let puts = 0;
		vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
			if (options.method === "PUT") puts++;
			return json(channel);
		});
		mount();
		await screen.findByLabelText("Webhook URL");
		fireEvent.change(screen.getByLabelText("Custom Headers"), { target: { value: text } });
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		expect(screen.getByRole("alert")).toHaveTextContent(/headers.*JSON object.*string/i);
		expect(screen.getByRole("alert")).not.toHaveTextContent(/synthetic-private/);
		expect(puts).toBe(0);
	});

	it("retains an uncertain-save draft but requires current settings and a fresh revision before deliberate resubmission", async () => {
		const writes: ConfigWrite[] = [];
		let reads = 0;
		vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
			if (options.method === "PUT") {
				expect(path).toBe("/api/notifications/channels/first");
				writes.push(JSON.parse(String(options.body)));
				return writes.length === 1
					? json({ message: "synthetic-private-server-error" }, 503)
					: json({ ...channel, name: "Reapplied draft" });
			}
			expect(options.method).toBe("GET");
			expect(path).toBe("/api/notifications/channels/first/config");
			reads++;
			return json(
				reads === 1
					? channel
					: { ...channel, name: "Current server settings", configRevision: "b".repeat(64) },
			);
		});
		const onSave = vi.fn();
		mount(onSave);
		await screen.findByLabelText("Webhook URL");
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Retained draft" } });
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/outcome could not be verified.*may have been saved.*reload current settings/i,
		);
		expect(document.body).not.toHaveTextContent("synthetic-private-server-error");
		expect(screen.getByLabelText("Name")).toHaveValue("Retained draft");
		expect(onSave).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		expect(writes).toHaveLength(1);
		expect(reads).toBe(1);
		fireEvent.click(
			screen.getByRole("button", { name: /reload current settings.*discards draft/i }),
		);
		await screen.findByDisplayValue("Current server settings");
		expect(writes).toHaveLength(1);
		expect(onSave).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Reapplied draft" } });
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
		expect(writes).toEqual([
			{
				name: "Retained draft",
				enabled: true,
				config: channel.config,
				expectedRevision: channel.configRevision,
			},
			{
				name: "Reapplied draft",
				enabled: true,
				config: channel.config,
				expectedRevision: "b".repeat(64),
			},
		]);
		expect(reads).toBe(2);
	});

	it("retains a known-rejected save draft and retries the same update only on explicit action", async () => {
		let fail = true;
		const writes: unknown[] = [];
		vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
			if (options.method === "PUT") {
				writes.push(JSON.parse(String(options.body)));
				return fail ? json({ message: "synthetic-private-server-error" }, 400) : json(channel);
			}
			return json(channel);
		});
		const onSave = vi.fn();
		mount(onSave);
		await screen.findByLabelText("Webhook URL");
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Retained draft" } });
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved.*retry/i),
		);
		expect(screen.queryByText("synthetic-private-server-error")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Name")).toHaveValue("Retained draft");
		expect(onSave).not.toHaveBeenCalled();
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
		expect(writes).toHaveLength(2);
		expect(writes[1]).toEqual(writes[0]);
	});

	it("ignores late reads for the previous channel and never submits its config for the new selection", async () => {
		let finishFirst: ((response: Response) => void) | undefined;
		const writes: ConfigWrite[] = [];
		vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
			if (options.method === "PUT") {
				writes.push({ path, ...JSON.parse(String(options.body)) });
				return json(channel);
			}
			if (path.endsWith("/first/config"))
				return new Promise<Response>((resolve) => {
					finishFirst = resolve;
				});
			expect(path).toBe("/api/notifications/channels/second/config");
			return json({
				...channel,
				id: "second",
				name: "Second synthetic",
				configRevision: "c".repeat(64),
				config: { ...channel.config, method: "PUT" },
			});
		});
		const result = mount();
		expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
		await waitFor(() => expect(finishFirst).toBeDefined());
		result.changeChannel("second");
		await screen.findByDisplayValue("Second synthetic");
		await act(async () => {
			finishFirst!(json(channel));
		});
		expect(screen.getByLabelText("Name")).toHaveValue("Second synthetic");
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0]).toMatchObject({
			path: "/api/notifications/channels/second",
			name: "Second synthetic",
			expectedRevision: "c".repeat(64),
			config: { ...channel.config, method: "PUT" },
		});
	});

	it("cannot save after a config read failure and recovers through explicit retry", async () => {
		let fail = true;
		let puts = 0;
		vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
			if (options.method === "PUT") puts++;
			return fail ? json({ message: "synthetic-private-config-read" }, 500) : json(channel);
		});
		mount();
		await screen.findByRole("button", { name: /retry loading/i });
		expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
		expect(screen.queryByText("synthetic-private-config-read")).not.toBeInTheDocument();
		expect(puts).toBe(0);
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: /retry loading/i }));
		await screen.findByLabelText("Webhook URL");
		expect(screen.getByLabelText("Name")).toHaveValue(channel.name);
	});

	it("serializes an untouched unchecked SMTP TLS toggle as false when creating a channel", async () => {
		const writes: ConfigWrite[] = [];
		vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
			expect(path).toBe("/api/notifications/channels");
			expect(options.method).toBe("POST");
			const body = JSON.parse(String(options.body));
			writes.push(body);
			return emailConfigSchema.safeParse(body.config).success
				? json({ ...channel, name: body.name, type: "EMAIL", config: undefined })
				: json({ message: "Invalid payload" }, 400);
		});
		const onSave = vi.fn();
		const result = mount(onSave, null);
		act(() =>
			result.client.setQueryData(notificationKeys.channelTypes, [
				{ type: "DISCORD", label: "Discord", formFields: [] },
				{
					type: "EMAIL",
					label: "Email",
					formFields: [
						{ key: "host", label: "Host", type: "text", required: true },
						{ key: "port", label: "Port", type: "number", required: true },
						{ key: "secure", label: "Use TLS", type: "boolean" },
						{ key: "user", label: "Username", type: "text", required: true },
						{ key: "password", label: "Password", type: "password", required: true },
						{ key: "from", label: "From", type: "email", required: true },
						{ key: "to", label: "To", type: "email", required: true },
					],
				},
			]),
		);
		fireEvent.change(await screen.findByLabelText("Type"), { target: { value: "EMAIL" } });
		const values = {
			Name: "Synthetic email",
			Host: "smtp.synthetic.invalid",
			Port: "587",
			Username: "synthetic-user",
			Password: "synthetic-entered-secret",
			From: "from@synthetic.invalid",
			To: "to@synthetic.invalid",
		};
		for (const [label, value] of Object.entries(values))
			fireEvent.change(screen.getByLabelText(label), { target: { value } });
		fireEvent.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() => expect(writes).toHaveLength(1));
		expect(writes[0]?.config).toMatchObject({ secure: false });
		await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
		expect(writes).toEqual([
			{
				name: "Synthetic email",
				type: "EMAIL",
				enabled: true,
				config: {
					host: "smtp.synthetic.invalid",
					port: 587,
					secure: false,
					user: "synthetic-user",
					password: "synthetic-entered-secret",
					from: "from@synthetic.invalid",
					to: "to@synthetic.invalid",
				},
			},
		]);
	});

	it("locks fields and prevents a second submit while the explicit save is pending", async () => {
		let finish: ((response: Response) => void) | undefined;
		let puts = 0;
		vi.stubGlobal("fetch", async (_path: string, options: RequestInit) => {
			if (options.method === "PUT") {
				puts++;
				return new Promise<Response>((resolve) => {
					finish = resolve;
				});
			}
			return json(channel);
		});
		const onSave = vi.fn();
		mount(onSave);
		await screen.findByLabelText("Name");
		fireEvent.click(screen.getByRole("button", { name: "Update" }));
		try {
			await waitFor(() => expect(finish).toBeDefined());
			expect(screen.getByLabelText("Name")).toBeDisabled();
			expect(screen.getByLabelText("Webhook URL")).toBeDisabled();
			expect(screen.getByRole("switch", { name: "Enabled" })).toBeDisabled();
			fireEvent.submit(screen.getByLabelText("Name").closest("form")!);
			expect(puts).toBe(1);
			expect(onSave).not.toHaveBeenCalled();
		} finally {
			await act(async () => {
				finish?.(json(channel));
			});
		}
		await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
	});
});
