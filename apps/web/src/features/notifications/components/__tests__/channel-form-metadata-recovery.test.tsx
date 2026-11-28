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

// Complete, hand-checked descriptors; no metadata hook/client/component mocks.
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
			{ key: "method", label: "HTTP Method", type: "text" },
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
const typesPath = "/api/notifications/channel-types";
const configPath = "/api/notifications/channels/synthetic-channel/config";
const privateError = "synthetic-private-metadata-detail";
const clients: QueryClient[] = [];
const releases: Array<() => void> = [];
const unexpectedRequests: Array<{ path: boolean; method: boolean; body: boolean }> = [];
function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function pending() {
	let resolve!: (response: Response) => void;
	const response = new Promise<Response>((finish) => {
		resolve = finish;
	});
	releases.push(() => resolve(json(types)));
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
			path: ![typesPath, configPath].includes(path),
			method: (options.method ?? "GET") !== "GET",
			body: options.body !== undefined,
		};
		if (violation.path || violation.method || violation.body) {
			unexpectedRequests.push(violation);
			throw new Error("Out-of-scope synthetic metadata read");
		}
		return read(path);
	});
	return requests;
}
function mount(edit: boolean, cached = false) {
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				retry: 1,
				staleTime: 30_000,
				gcTime: 300_000,
				refetchOnWindowFocus: false,
			},
			mutations: { retry: false },
		},
	});
	clients.push(client);
	if (cached) client.setQueryData(notificationKeys.channelTypes, types);
	const onCancel = vi.fn(),
		onSave = vi.fn();
	const result = render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<ChannelForm
						channelId={edit ? "synthetic-channel" : null}
						onCancel={onCancel}
						onSave={onSave}
					/>
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return { ...result, client, onCancel, onSave };
}
afterEach(() => {
	cleanup();
	for (const release of releases.splice(0)) release();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	// Fail outside fetch: client error handling must not swallow a write attempt.
	expect(unexpectedRequests.splice(0)).toEqual([]);
});

describe("Channel definitions: actual reads, blocked saves and draft-safe recovery", () => {
	// A success cast must not admit malformed metadata into the real hook/cache.
	// Recovery remains a read and must not reread saved settings or dispatch sends.
	it.each([false, true])("recovers malformed initial definitions (edit=%s)", async (edit) => {
		let reads = 0;
		const malformed = types.map((type) => ({
			...type,
			formFields: type.formFields.map((field) => ({
				...field,
				label: privateError,
				required: "true",
			})),
		}));
		const requests = transport((path) =>
			path === configPath ? json(channel) : json(++reads <= 2 ? malformed : types),
		);
		const result = mount(edit);
		await waitFor(
			() => expect(screen.getByRole("alert")).toHaveTextContent(/field definitions.*unavailable/i),
			{ timeout: 3500 },
		);
		expect(reads).toBe(2);
		expect(result.client.getQueryData(notificationKeys.channelTypes)).toBeUndefined();
		expect(document.body).not.toHaveTextContent(privateError);
		expect(screen.queryByRole("button", { name: /^(Create|Update)$/ })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
		await screen.findByLabelText("Webhook URL");
		expect(result.client.getQueryData(notificationKeys.channelTypes)).toEqual(types);
		expect(requests.filter((path) => path === typesPath)).toHaveLength(3);
		expect(requests.filter((path) => path === configPath)).toHaveLength(edit ? 1 : 0);
		expect(result.onSave).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"rejects an ambiguous reread without losing the exact draft (edit=%s)",
		async (edit) => {
			let reads = 0;
			const requests = transport((path) =>
				path === configPath
					? json(channel)
					: json(++reads <= 2 ? [...types, { ...types[0], label: privateError }] : types),
			);
			const result = mount(edit, true);
			await screen.findByLabelText("Name");
			if (!edit) fireEvent.change(screen.getByLabelText("Type"), { target: { value: "WEBHOOK" } });
			fireEvent.change(screen.getByLabelText("Name"), {
				target: { value: "Synthetic unsaved catalog draft" },
			});
			fireEvent.change(screen.getByLabelText("Webhook URL"), {
				target: { value: "https://synthetic.invalid/catalog-draft" },
			});
			fireEvent.change(screen.getByLabelText("Custom Headers"), {
				target: { value: '{"Synthetic":"catalog-draft"}' },
			});
			await act(async () => {
				void result.client.invalidateQueries({
					queryKey: notificationKeys.channelTypes,
					exact: true,
				});
			});
			await waitFor(
				() =>
					expect(screen.getByRole("alert")).toHaveTextContent(/field definitions.*unavailable/i),
				{ timeout: 3500 },
			);
			expect(result.client.getQueryData(notificationKeys.channelTypes)).toEqual(types);
			expect(result.client.getQueryState(notificationKeys.channelTypes)?.status).toBe("error");
			expect(document.body).not.toHaveTextContent(privateError);
			expect(screen.queryByRole("button", { name: /^(Create|Update)$/ })).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
			await screen.findByDisplayValue("Synthetic unsaved catalog draft");
			expect(screen.getByLabelText("Webhook URL")).toHaveValue(
				"https://synthetic.invalid/catalog-draft",
			);
			expect(screen.getByLabelText("Custom Headers")).toHaveValue('{"Synthetic":"catalog-draft"}');
			expect(requests.filter((path) => path === typesPath)).toHaveLength(3);
			expect(requests.filter((path) => path === configPath)).toHaveLength(edit ? 1 : 0);
			expect(result.onSave).not.toHaveBeenCalled();
		},
	);

	// Guards an unknown-metadata spinner trapping the editor with no accessible
	// state or exit; metadata admission must never enable a save prematurely.
	it.each([false, true])(
		"can close an accessible pending metadata read (edit=%s)",
		async (edit) => {
			const read = pending();
			const requests = transport((path) => (path === typesPath ? read.response : json(channel)));
			const result = mount(edit);
			await waitFor(() => expect(requests).toContain(typesPath));
			expect(screen.getByRole("status", { busy: true })).toHaveTextContent(/loading.*channel/i);
			expect(screen.queryByRole("button", { name: /^(Create|Update)$/ })).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Go back" }));
			expect(result.onCancel).toHaveBeenCalledOnce();
			result.unmount();
			await read.finish(types);
			expect(result.onSave).not.toHaveBeenCalled();
			expect(requests).toEqual(edit ? [typesPath, configPath] : [typesPath]);
		},
	);

	// Guards raw read errors, write replay, or metadata recovery resetting config.
	it.each([false, true])(
		"recovers unavailable initial definitions using GET only (edit=%s)",
		async (edit) => {
			let reads = 0;
			const requests = transport((path) =>
				path === configPath
					? json(channel)
					: ++reads <= 2
						? json({ message: privateError }, 503)
						: json(types),
			);
			const result = mount(edit);
			await waitFor(
				() =>
					expect(screen.getByRole("alert")).toHaveTextContent(/field definitions.*unavailable/i),
				{ timeout: 3500 },
			);
			expect(reads).toBe(2);
			expect(document.body).not.toHaveTextContent(privateError);
			expect(screen.queryByRole("button", { name: /^(Create|Update)$/ })).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
			await screen.findByLabelText("Webhook URL");
			expect(result.client.getQueryState(notificationKeys.channelTypes)?.status).toBe("success");
			expect(screen.getByLabelText("Name")).toHaveValue(edit ? "Synthetic stored channel" : "");
			expect(result.onSave).not.toHaveBeenCalled();
			expect(requests.filter((path) => path === configPath)).toHaveLength(edit ? 1 : 0);
			expect(requests.filter((path) => path === typesPath)).toEqual([
				typesPath,
				typesPath,
				typesPath,
			]);
		},
	);

	it("blocks an empty definition set and admits only a successful explicit reread", async () => {
		let reads = 0;
		const requests = transport(() => json(++reads === 1 ? [] : types));
		mount(false);
		await screen.findByRole("button", { name: "Retry loading" });
		expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
		await screen.findByLabelText("Webhook URL");
		expect(requests).toEqual([typesPath, typesPath]);
	});

	// Guards a metadata refresh rereading saved settings, resetting drafts/type,
	// publishing writes, or losing editable values while the field catalog fails.
	it.each([false, true])(
		"retains the exact draft through a failed catalog reread (edit=%s)",
		async (edit) => {
			let reads = 0;
			const requests = transport((path) =>
				path === configPath
					? json(channel)
					: ++reads <= 2
						? json({ message: privateError }, 503)
						: json(types),
			);
			const result = mount(edit, true);
			await screen.findByLabelText("Name");
			if (!edit) fireEvent.change(screen.getByLabelText("Type"), { target: { value: "WEBHOOK" } });
			fireEvent.change(screen.getByLabelText("Name"), {
				target: { value: "Synthetic unsaved draft" },
			});
			fireEvent.change(screen.getByLabelText("Webhook URL"), {
				target: { value: "https://synthetic.invalid/draft" },
			});
			fireEvent.change(screen.getByLabelText("Signing Secret"), {
				target: { value: "synthetic-draft-secret" },
			});
			fireEvent.change(screen.getByLabelText("Custom Headers"), {
				target: { value: '{"Synthetic":"draft"}' },
			});
			await act(async () => {
				void result.client.invalidateQueries({
					queryKey: notificationKeys.channelTypes,
					exact: true,
				});
			});
			await waitFor(
				() => expect(screen.getByRole("button", { name: "Retry loading" })).toBeInTheDocument(),
				{ timeout: 3500 },
			);
			expect(result.client.getQueryData(notificationKeys.channelTypes)).toEqual(types);
			expect(result.client.getQueryState(notificationKeys.channelTypes)?.status).toBe("error");
			expect(document.body).not.toHaveTextContent(privateError);
			expect(screen.queryByRole("button", { name: /^(Create|Update)$/ })).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
			await screen.findByDisplayValue("Synthetic unsaved draft");
			expect(screen.getByLabelText("Webhook URL")).toHaveValue("https://synthetic.invalid/draft");
			expect(screen.getByLabelText("Signing Secret")).toHaveValue("synthetic-draft-secret");
			expect(screen.getByLabelText("Custom Headers")).toHaveValue('{"Synthetic":"draft"}');
			if (!edit) expect(screen.getByLabelText("Type")).toHaveValue("WEBHOOK");
			expect(requests.filter((path) => path === configPath)).toHaveLength(edit ? 1 : 0);
			expect(requests.filter((path) => path === typesPath)).toEqual([
				typesPath,
				typesPath,
				typesPath,
			]);
			expect(result.onSave).not.toHaveBeenCalled();
		},
	);

	it("can close a settings-only pending read without a late completion reopening the editor", async () => {
		const read = pending();
		const requests = transport(() => read.response);
		const result = mount(true, true);
		await waitFor(() => expect(requests).toEqual([configPath]));
		expect(screen.getByRole("status", { busy: true })).toHaveTextContent(/loading.*channel/i);
		fireEvent.click(screen.getByRole("button", { name: "Go back" }));
		result.unmount();
		await read.finish(channel);
		expect(result.onCancel).toHaveBeenCalledOnce();
		expect(result.onSave).not.toHaveBeenCalled();
		expect(requests).toEqual([configPath]);
	});
});
