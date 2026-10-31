import type { NotificationChannelResponse, NotificationChannelType } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationDispatcher } from "../../../../../../api/src/lib/notifications/notification-dispatcher";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ApiError, UnauthorizedError } from "../../../../lib/api-client/base";
import {
	type CreateChannelRequest,
	notificationsApi,
} from "../../../../lib/api-client/notifications";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
} from "../../../../lib/auth-session-signal";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { ChannelForm } from "../channel-form";
import { NotificationsTab } from "../notifications-tab";

type OrdinaryType = Exclude<NotificationChannelType, "BROWSER_PUSH">;
interface ProviderCase {
	type: OrdinaryType;
	inputs: Record<string, string | number | boolean>;
	want: Record<string, unknown>;
}
// GUI inputs and POST config expectations are independent hand-checked literals.
// No retained markers belong in CREATE; these are synthetic new credentials.
const providers: ProviderCase[] = [
	{
		type: "DISCORD",
		inputs: { webhookUrl: "https://discord.synthetic.invalid/create" },
		want: { webhookUrl: "https://discord.synthetic.invalid/create" },
	},
	{
		type: "TELEGRAM",
		inputs: { botToken: "synthetic-create-bot-token", chatId: "synthetic-chat" },
		want: { botToken: "synthetic-create-bot-token", chatId: "synthetic-chat" },
	},
	{
		type: "EMAIL",
		inputs: {
			host: "smtp.synthetic.invalid",
			port: 587,
			secure: false,
			user: "synthetic-user",
			password: "synthetic-create-password",
			from: "from@synthetic.invalid",
			to: "to@synthetic.invalid",
		},
		want: {
			host: "smtp.synthetic.invalid",
			port: 587,
			secure: false,
			user: "synthetic-user",
			password: "synthetic-create-password",
			from: "from@synthetic.invalid",
			to: "to@synthetic.invalid",
		},
	},
	{
		type: "PUSHBULLET",
		inputs: { apiToken: "synthetic-create-pushbullet-token" },
		want: { apiToken: "synthetic-create-pushbullet-token" },
	},
	{
		type: "PUSHOVER",
		inputs: { userKey: "synthetic-create-user-key", apiToken: "synthetic-create-pushover-token" },
		want: { userKey: "synthetic-create-user-key", apiToken: "synthetic-create-pushover-token" },
	},
	{
		type: "GOTIFY",
		inputs: {
			serverUrl: "https://gotify.synthetic.invalid/create",
			appToken: "synthetic-create-app-token",
		},
		want: {
			serverUrl: "https://gotify.synthetic.invalid/create",
			appToken: "synthetic-create-app-token",
		},
	},
	{
		type: "WEBHOOK",
		inputs: {
			url: "https://webhook.synthetic.invalid/create",
			method: "PUT",
			secret: "synthetic-create-signing-secret",
			headers: '{"Authorization":"synthetic-create-header"}',
		},
		want: {
			url: "https://webhook.synthetic.invalid/create",
			method: "PUT",
			secret: "synthetic-create-signing-secret",
			headers: { Authorization: "synthetic-create-header" },
		},
	},
	{
		type: "SLACK",
		inputs: { webhookUrl: "https://slack.synthetic.invalid/create" },
		want: { webhookUrl: "https://slack.synthetic.invalid/create" },
	},
	{
		type: "NTFY",
		inputs: {
			serverUrl: "https://ntfy.synthetic.invalid/create",
			topic: "synthetic-topic",
			token: "synthetic-create-ntfy-token",
		},
		want: {
			serverUrl: "https://ntfy.synthetic.invalid/create",
			topic: "synthetic-topic",
			token: "synthetic-create-ntfy-token",
		},
	},
];
const webhook = providers.find((item) => item.type === "WEBHOOK")!;
// Actual metadata only; never invoke dispatcher test/send/provider transports.
const manifests = new NotificationDispatcher().getPluginManifests();
const name = "Synthetic created channel";
const privateDetail = "synthetic-private-create-detail";
const channelsPath = "/api/notifications/channels";
const typesPath = "/api/notifications/channel-types";
function ack(type: OrdinaryType = "WEBHOOK", enabled = true): NotificationChannelResponse {
	return {
		id: "created-channel",
		name,
		type,
		enabled,
		createdAt: "2026-10-06T12:00:00.000Z",
		updatedAt: "2026-10-06T12:00:00.000Z",
		lastTestedAt: null,
		lastTestResult: null,
		subscriptions: [],
	};
}
const other: NotificationChannelResponse = {
	id: "other-channel",
	name: "Other synthetic channel",
	type: "DISCORD",
	enabled: false,
	createdAt: "2026-10-01T12:00:00.000Z",
	updatedAt: "2026-10-02T12:00:00.000Z",
	lastTestedAt: null,
	lastTestResult: null,
	subscriptions: ["SYSTEM_ERROR"],
};
const request: CreateChannelRequest = {
	name,
	type: "WEBHOOK",
	enabled: true,
	config: {
		url: "https://webhook.synthetic.invalid/create",
		method: "PUT",
		secret: "synthetic-create-signing-secret",
		headers: { Authorization: "synthetic-create-header" },
	},
};
function json(value: unknown, status = 201) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}
const malformed = [
	{ label: "null201", reply: () => json(null) },
	{ label: "bodyless204", reply: () => new Response(null, { status: 204 }) },
	{ label: "empty object201", reply: () => json({ message: privateDetail }) },
	{ label: "array201", reply: () => json([ack()]) },
	{ label: "blank id201", reply: () => json({ ...ack(), id: " " }) },
	{ label: "missing date201", reply: () => json({ ...ack(), createdAt: undefined }) },
	{ label: "invalid date201", reply: () => json({ ...ack(), updatedAt: "invalid" }) },
	{ label: "missing Test metadata201", reply: () => json({ ...ack(), lastTestedAt: undefined }) },
	{
		label: "nonfresh Test metadata201",
		reply: () => json({ ...ack(), lastTestResult: "success" }),
	},
	{
		label: "nonfresh subscriptions201",
		reply: () => json({ ...ack(), subscriptions: ["SYSTEM_ERROR"] }),
	},
	{
		label: "wrong submitted name201",
		reply: () => json({ ...ack(), name: "Different synthetic name" }),
	},
	{ label: "wrong submitted type201", reply: () => json({ ...ack(), type: "DISCORD" }) },
	{ label: "wrong submitted enabled201", reply: () => json({ ...ack(), enabled: false }) },
	{ label: "nonboolean enabled201", reply: () => json({ ...ack(), enabled: "true" }) },
];
const uncertain = [
	{
		label: "network response loss",
		reply: () => {
			throw new Error(privateDetail);
		},
	},
	{
		label: "invalid JSON201",
		reply: () =>
			new Response(privateDetail, { status: 201, headers: { "content-type": "application/json" } }),
	},
	{
		label: "body read loss201",
		reply: () => {
			const response = json(ack());
			response.json = async () => {
				throw new Error(privateDetail);
			};
			return response;
		},
	},
	{ label: "request408", reply: () => json({ message: privateDetail }, 408) },
	{ label: "server500", reply: () => json({ message: privateDetail }, 500) },
	{ label: "server503", reply: () => json({ message: privateDetail }, 503) },
];
const clients: QueryClient[] = [];
const violations: string[] = [];
const releases: Array<() => void> = [];
function held() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((finish) => {
		resolve = finish;
	});
	releases.push(() => resolve(json([], 200)));
	return {
		promise,
		finish: async (response: Response) => {
			await act(async () => resolve(response));
		},
	};
}
function transport(
	reply: () => Response | Promise<Response>,
	list: (count: number) => Response | Promise<Response> = () => json([other], 200),
) {
	const posts: unknown[] = [];
	const reads: string[] = [];
	let listReads = 0;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input),
			method = init.method ?? "GET";
		if (path === channelsPath && method === "POST" && typeof init.body === "string") {
			posts.push(JSON.parse(init.body));
			return reply();
		}
		if (method === "GET" && init.body === undefined && path === typesPath) {
			reads.push(path);
			return json(manifests, 200);
		}
		if (method === "GET" && init.body === undefined && path === channelsPath) {
			reads.push(path);
			return list(++listReads);
		}
		violations.push(`${method} ${path}`);
		throw new Error("Unexpected synthetic create request");
	});
	return { posts, reads, listReads: () => listReads };
}
function mount(options: { parent?: boolean; cache?: unknown; retry?: number } = {}) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: 30_000, gcTime: Infinity, refetchOnWindowFocus: false },
			mutations: { retry: options.retry ?? false, retryDelay: 0 },
		},
	});
	clients.push(client);
	if (options.cache !== undefined) client.setQueryData(notificationKeys.channels, options.cache);
	const onSave = vi.fn(),
		onSaved = vi.fn(),
		onCancel = vi.fn();
	const tree = (content: ReactNode) => (
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>{content}</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
	const view = render(
		tree(
			options.parent ? (
				<NotificationsTab />
			) : (
				<ChannelForm channelId={null} onSave={onSave} onSaved={onSaved} onCancel={onCancel} />
			),
		),
	);
	return {
		...view,
		client,
		onSave,
		onSaved,
		onCancel,
		hideParent: () => view.rerender(tree(null)),
		showParent: () => view.rerender(tree(<NotificationsTab />)),
	};
}
async function fill(fixture: ProviderCase = webhook, enabled = true) {
	await screen.findByRole("button", { name: "Create" });
	fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
	fireEvent.change(screen.getByLabelText("Type"), { target: { value: fixture.type } });
	const descriptor = manifests.find((item) => item.type === fixture.type)!;
	expect(descriptor.formFields.map((item) => item.key).sort()).toEqual(
		Object.keys(fixture.inputs).sort(),
	);
	for (const field of descriptor.formFields) {
		const value = fixture.inputs[field.key];
		if (field.type === "boolean") {
			if (value === true) fireEvent.click(screen.getByRole("switch", { name: field.label }));
			continue;
		}
		const control = screen.getByLabelText(field.label);
		fireEvent.change(control, { target: { value: String(value) } });
		if (field.type === "headers") expect(control.tagName).toBe("TEXTAREA");
		else {
			expect(control).toHaveAttribute("type", field.type);
			expect((control as HTMLInputElement).checkValidity()).toBe(true);
		}
	}
	if (!enabled) fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));
	expect((screen.getByLabelText("Name").closest("form") as HTMLFormElement).checkValidity()).toBe(
		true,
	);
}
async function startParent() {
	fireEvent.click(await screen.findByRole("button", { name: /add channel/i }));
	await fill();
}
function create() {
	fireEvent.click(screen.getByRole("button", { name: "Create" }));
}
async function settled(client: QueryClient) {
	await waitFor(() => {
		const mutations = client.getMutationCache().getAll();
		expect(mutations).toHaveLength(1);
		expect(["success", "error"]).toContain(mutations[0]?.state.status);
	});
}
afterEach(async () => {
	cleanup();
	for (const release of releases.splice(0)) release();
	for (const client of clients.splice(0)) client.clear();
	localStorage.removeItem("arr-dashboard-incognito-mode");
	acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
	vi.unstubAllGlobals();
	expect(violations.splice(0)).toEqual([]);
});

describe("real CREATE client acknowledgment admission", () => {
	it.each([...malformed, ...uncertain])(
		"does not certify $label and excludes private causes",
		async ({ reply }) => {
			const calls = transport(reply);
			const result = await notificationsApi.createChannel(request).then(
				(value) => ({ accepted: true, value }),
				(error: unknown) => ({ accepted: false, error }),
			);
			expect(result.accepted).toBe(false);
			if ("error" in result) {
				expect(result.error).toBeInstanceOf(Error);
				expect(String(result.error)).toMatch(/creation outcome.*not.*verified/i);
				expect(String(result.error)).not.toContain(privateDetail);
				expect(result.error).not.toHaveProperty("cause");
			}
			expect(calls.posts).toEqual([request]);
			expect(calls.reads).toEqual([]);
		},
	);
	it("accepts the actual fresh201 metadata control", async () => {
		const calls = transport(() => json(ack()));
		await expect(notificationsApi.createChannel(request)).resolves.toEqual(ack());
		expect(calls.posts).toEqual([request]);
	});
	it("projects a truthful ACK without provider/config/diagnostic extras", async () => {
		transport(() =>
			json({
				...ack(),
				config: { secret: privateDetail },
				provider: privateDetail,
				message: privateDetail,
				lastSendResult: privateDetail,
			}),
		);
		await expect(notificationsApi.createChannel(request)).resolves.toEqual(ack());
	});
	it("admits actual enabled-default true and explicitly disabled fresh metadata", async () => {
		transport(() => json(ack()));
		const { enabled: _enabled, ...defaultRequest } = request;
		await expect(notificationsApi.createChannel(defaultRequest)).resolves.toEqual(ack());
		transport(() => json(ack("WEBHOOK", false)));
		await expect(notificationsApi.createChannel({ ...request, enabled: false })).resolves.toEqual(
			ack("WEBHOOK", false),
		);
	});
	it.each([400, 401, 403, 404, 409])(
		"preserves known%s rejection/auth classification",
		async (status) => {
			transport(() => json({ message: privateDetail }, status));
			const error = await notificationsApi
				.createChannel(request)
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(ApiError);
			expect(error).toMatchObject({ status });
			if (status === 401) {
				expect(error).toBeInstanceOf(UnauthorizedError);
				expect(getPendingUnauthorizedRevision()).toBeGreaterThan(0);
			}
		},
	);
});

describe("real new form/hook unknown-create boundary", () => {
	it.each([...malformed.slice(0, 3), ...malformed.slice(10, 13), ...uncertain])(
		"keeps $label unknown without closing, publishing or replaying",
		async ({ reply }) => {
			const calls = transport(reply);
			const view = mount({ cache: [other] });
			await fill();
			create();
			await settled(view.client);
			expect(view.onSave).not.toHaveBeenCalled();
			expect(view.onSaved).not.toHaveBeenCalled();
			expect(screen.getByRole("alert")).toHaveTextContent(/may have.*created|may.*completed/i);
			expect(document.body).not.toHaveTextContent(privateDetail);
			expect(screen.getByLabelText("Name")).toHaveValue(name);
			expect(screen.getByLabelText("Webhook URL")).toHaveValue(
				"https://webhook.synthetic.invalid/create",
			);
			expect(screen.getByLabelText("Custom Headers")).toHaveValue(
				'{"Authorization":"synthetic-create-header"}',
			);
			const submit = screen.getByRole("button", { name: "Create" });
			expect(submit).toBeDisabled();
			fireEvent.submit(submit.closest("form") as HTMLFormElement);
			await act(async () => {});
			expect(calls.posts).toEqual([request]);
			expect(view.client.getQueryData(notificationKeys.channels)).toEqual([other]);
			expect(
				screen.queryByRole("button", { name: /reload current settings/i }),
			).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: /review.*channel.*list/i }));
			expect(view.onCancel).toHaveBeenCalledOnce();
			expect(view.onSave).not.toHaveBeenCalled();
		},
	);
	it("overrides caller mutation retry2 and proves the complete settled uncertain attempt has one POST", async () => {
		const calls = transport(uncertain[0]!.reply);
		const view = mount({ cache: [], retry: 2 });
		await fill();
		create();
		await settled(view.client);
		expect(calls.posts).toEqual([request]);
		expect(view.onSave).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
	});
});

describe.each(providers)("actual ordinary $type CREATE controls", (fixture) => {
	it("submits complete native-valid typed inputs and accepts the real201 ACK", async () => {
		const calls = transport(() => json(ack(fixture.type)));
		const view = mount();
		await fill(fixture);
		create();
		await settled(view.client);
		expect(view.onSave).toHaveBeenCalledOnce();
		expect(view.onSaved).toHaveBeenCalledExactlyOnceWith(null);
		expect(calls.posts).toEqual([
			{
				name: "Synthetic created channel",
				type: fixture.type,
				enabled: true,
				config: fixture.want,
			},
		]);
		expect(calls.reads).toEqual([typesPath]);
	});
	it("preserves known400 rejected inputs and retries only on explicit Create", async () => {
		let writes = 0;
		const calls = transport(() =>
			++writes === 1 ? json({ message: privateDetail }, 400) : json(ack(fixture.type)),
		);
		const view = mount();
		await fill(fixture);
		create();
		await settled(view.client);
		expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved.*retry/i);
		expect(view.onSave).not.toHaveBeenCalled();
		expect(screen.getByLabelText("Name")).toHaveValue(name);
		for (const field of manifests.find((item) => item.type === fixture.type)!.formFields) {
			if (field.type === "boolean")
				expect(screen.getByRole("switch", { name: field.label })).toHaveAttribute(
					"aria-checked",
					"false",
				);
			else {
				const value = fixture.inputs[field.key];
				if (typeof value !== "string" && typeof value !== "number")
					throw new Error("Invalid literal CREATE input");
				expect(screen.getByLabelText(field.label)).toHaveValue(value);
			}
		}
		expect(document.body).not.toHaveTextContent(privateDetail);
		expect(calls.posts).toHaveLength(1);
		create();
		await waitFor(() => expect(view.onSave).toHaveBeenCalledOnce());
		expect(calls.posts).toEqual([
			{ name, type: fixture.type, enabled: true, config: fixture.want },
			{ name, type: fixture.type, enabled: true, config: fixture.want },
		]);
	});
});

describe("actual Tab list readers and CREATE cache authority", () => {
	it.each([
		{ label: "empty", baseline: [] },
		{ label: "populated", baseline: [other] },
	])(
		"unknown result starts GET-only reconciliation for $label cached list",
		async ({ baseline }) => {
			const reread = held();
			const calls = transport(uncertain[0]!.reply, () => reread.promise);
			const view = mount({ parent: true, cache: baseline });
			await startParent();
			create();
			await settled(view.client);
			await waitFor(() => expect(calls.listReads()).toBe(1));
			expect(view.client.getQueryData(notificationKeys.channels)).toEqual(baseline);
			expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
			expect(calls.posts).toEqual([request]);
		},
	);
	it("never closes the actual Tab editor after arbitrary successful null metadata", async () => {
		const reread = held();
		transport(
			() => json(null),
			() => reread.promise,
		);
		const view = mount({ parent: true, cache: [] });
		await startParent();
		create();
		await settled(view.client);
		expect(screen.getByLabelText("Name")).toHaveValue(name);
		expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
		expect(view.client.getQueryData(notificationKeys.channels)).toEqual([]);
	});
	it("qualifies last-known empty cache while an independent list reread is pending after uncertain creation", async () => {
		const reread = held();
		transport(uncertain[0]!.reply, () => reread.promise);
		const view = mount({ parent: true, cache: [] });
		await startParent();
		void view.client.refetchQueries({ queryKey: notificationKeys.channels, exact: true });
		create();
		await settled(view.client);
		expect(screen.getByText(/last-known notification channels.*checking/i)).toBeInTheDocument();
		expect(screen.queryByText("No notification channels configured yet.")).not.toBeInTheDocument();
	});
	it("qualifies last-known empty cache after a list reread fails, without asserting no channels", async () => {
		const reread = held();
		transport(uncertain[0]!.reply, () => reread.promise);
		const view = mount({ parent: true, cache: [] });
		await startParent();
		void view.client.refetchQueries({ queryKey: notificationKeys.channels, exact: true });
		create();
		await settled(view.client);
		await reread.finish(json({ message: privateDetail }, 503));
		await waitFor(() =>
			expect(view.client.getQueryState(notificationKeys.channels)?.fetchStatus).toBe("idle"),
		);
		expect(
			screen.getByText(/last-known notification channels.*refresh failed/i),
		).toBeInTheDocument();
		expect(screen.queryByText("No notification channels configured yet.")).not.toBeInTheDocument();
	});
	it("a GET row with the same name cannot verify the uncertain POST or authorize replay", async () => {
		const calls = transport(uncertain[0]!.reply, () => json([{ ...other, name }], 200));
		const view = mount({ parent: true, cache: [] });
		await startParent();
		create();
		await settled(view.client);
		await act(async () => {
			await view.client.refetchQueries({ queryKey: notificationKeys.channels, exact: true });
		});
		expect(view.client.getQueryData(notificationKeys.channels)).toEqual([{ ...other, name }]);
		expect(screen.getByLabelText("Name")).toHaveValue(name);
		expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
		expect(calls.posts).toEqual([request]);
	});
	it.each(["slow", "failed"])(
		"publishes admitted201 metadata and closes without waiting for %s list reread",
		async (mode) => {
			const reread = held();
			const calls = transport(
				() => json(ack()),
				() => (mode === "slow" ? reread.promise : json({ message: privateDetail }, 503)),
			);
			const view = mount({ parent: true, cache: [other] });
			await startParent();
			create();
			await settled(view.client);
			expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
			expect(view.client.getQueryData(notificationKeys.channels)).toEqual([other, ack()]);
			expect(calls.posts).toEqual([request]);
			expect(calls.listReads()).toBe(1);
		},
	);
	it("a late older list GET cannot remove the admitted created row", async () => {
		const older = held(),
			current = held();
		const calls = transport(
			() => json(ack()),
			(count) => (count === 1 ? older.promise : current.promise),
		);
		const view = mount({ parent: true, cache: [other] });
		await startParent();
		void view.client.refetchQueries({ queryKey: notificationKeys.channels, exact: true });
		await waitFor(() => expect(calls.listReads()).toBe(1));
		create();
		await settled(view.client);
		await older.finish(json([other], 200));
		expect(view.client.getQueryData(notificationKeys.channels)).toEqual([other, ack()]);
		expect(calls.posts).toEqual([request]);
	});
	it("an ACK arriving after editor unmount still publishes without closing a newer draft", async () => {
		const write = held(),
			reread = held();
		const calls = transport(
			() => write.promise,
			() => reread.promise,
		);
		const view = mount({ parent: true, cache: [other] });
		await startParent();
		create();
		await waitFor(() => expect(calls.posts).toHaveLength(1));
		// The pending editor's Close is disabled. Exercise real component lifetime
		// by leaving/re-entering the Tab while retaining the actual shared cache.
		view.hideParent();
		view.showParent();
		fireEvent.click(screen.getByRole("button", { name: /add channel/i }));
		await fill();
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Newer unsaved draft" } });
		await write.finish(json(ack()));
		await settled(view.client);
		expect(screen.getByLabelText("Name")).toHaveValue("Newer unsaved draft");
		expect(view.client.getQueryData(notificationKeys.channels)).toEqual([other, ack()]);
		expect(calls.listReads()).toBe(1);
	});
	it("preserves a richer already-known same-ID row and other rows when ACK arrives", async () => {
		const write = held(),
			reread = held();
		transport(
			() => write.promise,
			() => reread.promise,
		);
		const view = mount({ parent: true, cache: [other] });
		await startParent();
		create();
		const richer = {
			...ack(),
			name: "Newer existing channel",
			enabled: false,
			updatedAt: "2026-10-06T12:30:00.000Z",
			subscriptions: ["SYSTEM_ERROR"],
			lastTestedAt: "2026-10-06T12:20:00.000Z",
			lastTestResult: "success",
			lastSentAt: "2026-10-06T12:25:00.000Z",
			lastSendResult: "success",
		};
		view.client.setQueryData(notificationKeys.channels, [other, richer]);
		await write.finish(json(ack()));
		await settled(view.client);
		expect(view.client.getQueryData(notificationKeys.channels)).toEqual([other, richer]);
		expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
	});
	it.each([undefined, { unknownBaseline: true }])(
		"does not fabricate a complete list from missing/non-array cache %#",
		async (baseline) => {
			transport(() => json(ack()));
			const view = mount({ cache: baseline });
			await fill();
			create();
			await settled(view.client);
			expect(view.onSave).toHaveBeenCalledOnce();
			expect(view.client.getQueryData(notificationKeys.channels)).toEqual(baseline);
		},
	);
	it("preserves explicitly disabled typed CREATE inputs and valid matching ACK", async () => {
		const calls = transport(() => json(ack("WEBHOOK", false)));
		const view = mount();
		await fill(webhook, false);
		create();
		await settled(view.client);
		expect(view.onSave).toHaveBeenCalledOnce();
		expect(calls.posts).toEqual([{ name, type: "WEBHOOK", enabled: false, config: webhook.want }]);
	});
});
