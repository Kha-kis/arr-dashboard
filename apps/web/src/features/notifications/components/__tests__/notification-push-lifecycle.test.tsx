import type { CurrentUser } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import {
	useNotificationChannels,
	useNotificationSubscriptions,
} from "../../../../hooks/api/useNotifications";
import { notificationsApi } from "../../../../lib/api-client/notifications";
import { authKeys, notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { BrowserPushCard } from "../browser-push-card";

const endpoint = "https://synthetic.invalid/private-device-one";
const secondEndpoint = "https://synthetic.invalid/private-device-two";
const revision = "a".repeat(64);
const disabledRevision = "b".repeat(64);
const enabled = {
	channelId: "opaque-device",
	configRevision: revision,
	state: "enabled",
	subscribedEventCount: 1,
};
const disabled = {
	channelId: "opaque-device",
	configRevision: disabledRevision,
	state: "disabled",
	subscribedEventCount: 1,
};
const unregistered = {
	channelId: null,
	configRevision: null,
	state: "unregistered",
	subscribedEventCount: 0,
};
const storageKey = "arr-dashboard:browser-push:v1:synthetic-owner";
const owner: CurrentUser = {
	id: "synthetic-owner",
	username: "synthetic-name",
	mustChangePassword: false,
	createdAt: "2026-01-01T00:00:00Z",
	hasTmdbApiKey: false,
	hasPassword: true,
};
const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
	localStorage.clear();
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function ChannelEvidence() {
	const channels = useNotificationChannels();
	const subscriptions = useNotificationSubscriptions();
	return (
		<>
			<p>
				{channels.data?.[0]?.enabled ? "Sibling enabled" : "Sibling disabled"}
				{channels.isFetching || channels.isError ? " (last known)" : " (current)"}
			</p>
			<p>Selected events: {subscriptions.data?.subscriptions.length ?? 0}</p>
		</>
	);
}

function fixture(
	options: {
		local?: boolean;
		state?: unknown;
		readFailure?: boolean;
		browserFailure?: boolean;
		unsubscribe?: "true-present" | "false-present" | "false-null" | "throw";
		disableFailure?: boolean;
		disableAck?: unknown;
		enableFailure?: boolean;
		enableAck?: unknown;
		permission?: NotificationPermission;
		activeChannels?: boolean;
	} = {},
) {
	const trace: string[] = [];
	const requests: Array<{ path: string; body: unknown; credentials: unknown }> = [];
	let state: unknown = options.state ?? enabled;
	let readFailure = options.readFailure ?? false;
	let disableFailure = options.disableFailure ?? false;
	let enableFailure = options.enableFailure ?? false;
	let unsubscribeMode = options.unsubscribe;
	let current: PushSubscription | null;
	const subscription = (url: string): PushSubscription =>
		({
			endpoint: url,
			expirationTime: null,
			options: { applicationServerKey: null, userVisibleOnly: true },
			getKey: () => null,
			toJSON: () => ({
				endpoint: url,
				expirationTime: null,
				keys: { p256dh: "synthetic-key", auth: "synthetic-auth" },
			}),
			unsubscribe: async () => {
				trace.push("unsubscribe");
				if (unsubscribeMode === "throw") throw Error("synthetic-private-browser-error");
				if (unsubscribeMode !== "false-present" && unsubscribeMode !== "true-present")
					current = null;
				return unsubscribeMode !== "false-present" && unsubscribeMode !== "false-null";
			},
		}) as PushSubscription;
	current = options.local === false ? null : subscription(endpoint);
	const manager = {
		getSubscription: async () => {
			trace.push("browser-read");
			if (options.browserFailure) throw Error("synthetic-private-browser-error");
			return current;
		},
		subscribe: async () => {
			trace.push("subscribe");
			current = subscription(secondEndpoint);
			return current;
		},
	};
	const registration = { pushManager: manager } as unknown as ServiceWorkerRegistration;
	Object.defineProperty(navigator, "serviceWorker", {
		configurable: true,
		value: {
			register: async () => {
				trace.push("worker-register");
				return registration;
			},
			ready: Promise.resolve(registration),
		},
	});
	vi.stubGlobal("PushManager", () => {});
	vi.stubGlobal("Notification", {
		permission: options.permission ?? "granted",
		requestPermission: async () => {
			trace.push("permission");
			return options.permission ?? "granted";
		},
	});
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input);
		requests.push({
			path,
			body: init.body ? JSON.parse(String(init.body)) : undefined,
			credentials: init.credentials,
		});
		trace.push(path.split("/").at(-1)!);
		if (path === "/api/notifications/channels")
			return json([
				{
					id: "opaque-device",
					name: "Synthetic device",
					type: "BROWSER_PUSH",
					enabled: (state as { state: string }).state === "enabled",
					lastTestedAt: null,
					lastTestResult: null,
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					subscriptions: ["HUNT_COMPLETED"],
				},
			]);
		if (path === "/api/notifications/subscriptions")
			return json({
				channels: [{ id: "opaque-device", name: "Synthetic device", type: "BROWSER_PUSH" }],
				events: ["HUNT_COMPLETED"],
				subscriptions: [{ channelId: "opaque-device", eventType: "HUNT_COMPLETED" }],
			});
		if (path === "/api/notifications/vapid-public-key") return json({ publicKey: "AQID" });
		if (path === "/api/notifications/push-subscription/state")
			return readFailure ? json({ message: "synthetic-private-server-error" }, 503) : json(state);
		if (path === "/api/notifications/push-subscription/disable") {
			if (disableFailure) return json({ message: "synthetic-private-server-error" }, 503);
			state = disabled;
			return json(Object.hasOwn(options, "disableAck") ? options.disableAck : disabled);
		}
		if (path === "/api/notifications/push-subscription/enable") {
			if (enableFailure) return json({ message: "synthetic-private-server-error" }, 503);
			state = enabled;
			return json(Object.hasOwn(options, "enableAck") ? options.enableAck : enabled);
		}
		throw Error("Unexpected synthetic transport");
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	clients.push(client);
	client.setQueryData(authKeys.currentUser, owner);
	client.setQueryData(
		notificationKeys.channels,
		options.activeChannels
			? [
					{
						id: "opaque-device",
						name: "Synthetic device",
						type: "BROWSER_PUSH",
						enabled: (state as { state: string }).state === "enabled",
						lastTestedAt: null,
						lastTestResult: null,
						createdAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
						subscriptions: ["HUNT_COMPLETED"],
					},
				]
			: [],
	);
	client.setQueryData(notificationKeys.subscriptions, {
		channels: [],
		events: [],
		subscriptions: [],
	});
	const view = (showCard = true) => (
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					{showCard ? <BrowserPushCard /> : null}
					{options.activeChannels ? <ChannelEvidence /> : null}
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
	const mount = () => render(view());
	const rendered = mount();
	return {
		client,
		trace,
		requests,
		manager,
		rendered,
		mount,
		unmountCard: () => rendered.rerender(view(false)),
		remountCard: () => rendered.rerender(view()),
		get current() {
			return current;
		},
		setCurrent(url: string | null) {
			current = url ? subscription(url) : null;
		},
		setState(value: unknown) {
			state = value;
		},
		allowRead() {
			readFailure = false;
		},
		allowDisable() {
			disableFailure = false;
		},
		allowEnable() {
			enableFailure = false;
		},
		allowRemoval() {
			unsubscribeMode = "false-null";
		},
	};
}
const mutations = (f: ReturnType<typeof fixture>) =>
	f.requests.filter(
		(r) =>
			r.path.endsWith("/disable") ||
			r.path.endsWith("/enable") ||
			r.path.endsWith("/push-subscription"),
	);
async function loaded(label = "Active") {
	await waitFor(() => expect(screen.getByText(label)).toBeInTheDocument());
}
function click(name: string) {
	fireEvent.click(screen.getByRole("button", { name }));
}

describe("BrowserPushCard actual providers/client browser lifecycle", () => {
	it.each([
		["enable", false],
		["enable", true],
		["disable", false],
		["disable", true],
	] as const)(
		"reconciles same-account sibling cache after dispatched %s settles following card navigation (unknown ACK: %s)",
		async (action, unknownAck) => {
			localStorage.setItem(storageKey, "opaque-device");
			const f = fixture({
				activeChannels: true,
				state: action === "disable" ? enabled : disabled,
				...(unknownAck
					? action === "disable"
						? { disableAck: { id: "legacy" } }
						: { enableAck: { id: "legacy" } }
					: {}),
			});
			await loaded(action === "disable" ? "Active" : "Delivery disabled");
			const transport = globalThis.fetch;
			let release!: () => Promise<void>;
			vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
				const committed = transport(input, init);
				if (String(input).endsWith(`/${action}`))
					return new Promise<Response>((resolve) => {
						release = async () => resolve(await committed);
					});
				return committed;
			});
			const writes = vi.spyOn(Storage.prototype, "setItem");
			click(action === "disable" ? "Disable" : "Enable");
			await waitFor(() => expect(typeof release).toBe("function"));
			const writesBeforeExit = writes.mock.calls.length;
			f.unmountCard();
			f.remountCard();
			await loaded(action === "disable" ? "Delivery disabled" : "Active");
			await act(async () => release());
			await waitFor(() =>
				expect(f.requests.filter((r) => r.path === "/api/notifications/channels")).toHaveLength(1),
			);
			expect(
				screen.getByText(
					action === "disable" ? "Sibling disabled (current)" : "Sibling enabled (current)",
				),
			).toBeInTheDocument();
			expect(f.requests.filter((r) => r.path === "/api/notifications/subscriptions")).toHaveLength(
				1,
			);
			expect(mutations(f)).toHaveLength(1);
			expect(writes.mock.calls).toHaveLength(writesBeforeExit);
			expect(f.trace).not.toContain("unsubscribe");
		},
	);
	it("reconciles a dispatched timed-out write after unmount without resuming late browser work", async () => {
		const f = fixture({ activeChannels: true });
		await loaded();
		const transport = globalThis.fetch;
		let release!: () => Promise<void>;
		vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
			const committed = transport(input, init);
			if (String(input).endsWith("/disable"))
				return new Promise<Response>((resolve) => {
					release = async () => resolve(await committed);
				});
			return committed;
		});
		vi.useFakeTimers();
		click("Disable");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(typeof release).toBe("function");
		f.unmountCard();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_001);
		});
		expect(f.requests.filter((r) => r.path === "/api/notifications/channels")).toHaveLength(1);
		expect(screen.getByText("Sibling disabled (current)")).toBeInTheDocument();
		await act(async () => release());
		expect(mutations(f)).toHaveLength(1);
		expect(f.requests.filter((r) => r.path === "/api/notifications/channels")).toHaveLength(1);
		expect(f.trace).not.toContain("unsubscribe");
	});
	it.each(["enable", "disable"] as const)(
		"does not reconcile a different account after dispatched %s settles",
		async (action) => {
			localStorage.setItem(storageKey, "opaque-device");
			const f = fixture({ activeChannels: true, state: action === "disable" ? enabled : disabled });
			await loaded(action === "disable" ? "Active" : "Delivery disabled");
			const transport = globalThis.fetch;
			let release!: () => Promise<void>;
			vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
				const committed = transport(input, init);
				if (String(input).endsWith(`/${action}`))
					return new Promise<Response>((resolve) => {
						release = async () => resolve(await committed);
					});
				return committed;
			});
			click(action === "disable" ? "Disable" : "Enable");
			await waitFor(() => expect(typeof release).toBe("function"));
			f.unmountCard();
			await act(async () =>
				f.client.setQueryData(authKeys.currentUser, { ...owner, id: "synthetic-other" }),
			);
			await act(async () => release());
			expect(
				f.requests.filter((r) =>
					["/api/notifications/channels", "/api/notifications/subscriptions"].includes(r.path),
				),
			).toEqual([]);
			expect(f.client.getQueryState(notificationKeys.channels)?.isInvalidated).toBe(false);
			expect(f.trace).not.toContain("unsubscribe");
		},
	);
	it("requests consent in the direct click before delayed preflight and requires another Enable", async () => {
		const f = fixture({ local: false, permission: "default" });
		await loaded("Not enabled in this browser");
		let activationUntil = 0;
		vi.stubGlobal("Notification", {
			permission: "default",
			requestPermission: () => {
				f.trace.push("permission");
				const result = Date.now() < activationUntil ? "granted" : "denied";
				Object.assign(Notification, { permission: result });
				activationUntil = 0;
				return Promise.resolve(result);
			},
		});
		f.manager.getSubscription = () =>
			new Promise((resolve) => setTimeout(() => resolve(f.current), 6_000));
		vi.useFakeTimers();
		activationUntil = Date.now() + 5_000;
		fireEvent.click(
			screen.queryByRole("button", { name: "Allow notifications" }) ??
				screen.getByRole("button", { name: "Enable" }),
		);
		expect(f.trace.at(-1)).toBe("permission");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(6_001);
		});
		expect(f.trace.filter((step) => step === "permission")).toHaveLength(1);
		expect(Notification.permission).toBe("granted");
		expect(mutations(f)).toEqual([]);
		expect(f.trace).not.toContain("subscribe");
		expect(screen.getByRole("button", { name: "Enable" })).toBeEnabled();
		activationUntil = Date.now() + 5_000;
		click("Enable");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(6_001);
		});
		expect(screen.getByText("Active")).toBeInTheDocument();
		expect(f.trace.filter((step) => step === "permission")).toHaveLength(1);
		expect(mutations(f)).toHaveLength(1);
	});
	it("does not re-request already granted consent before explicit Enable", async () => {
		const f = fixture({ local: false });
		await loaded("Not enabled in this browser");
		click("Enable");
		await loaded();
		expect(f.trace).not.toContain("permission");
	});
	it("dismissed consent stays retryable and never enrolls or claims denial", async () => {
		const f = fixture({ local: false, permission: "default" });
		await loaded("Not enabled in this browser");
		expect(f.trace).not.toContain("permission");
		click("Allow notifications");
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Allow notifications" })).toBeEnabled(),
		);
		expect(screen.getByText(/Permission was not granted/)).toBeInTheDocument();
		expect(screen.queryByText("Blocked")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();
		expect(mutations(f)).toEqual([]);
		expect(f.trace).not.toContain("subscribe");
	});
	it("reconnect admits permission only after owned evidence then freshly admits subsequent Enable", async () => {
		localStorage.setItem(storageKey, "opaque-device");
		const f = fixture({ permission: "default", state: disabled });
		const transport = globalThis.fetch;
		vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
			if (String(input).endsWith("/state") && JSON.parse(String(init.body)).endpoint)
				return Promise.resolve(json({ error: "Device conflict" }, 409));
			return transport(input, init);
		});
		await loaded("Unverified");
		expect(screen.queryByRole("button", { name: "Allow notifications" })).not.toBeInTheDocument();
		click("Reconnect device");
		await loaded("Browser only");
		expect(f.requests.at(-1)?.body).toEqual({ channelId: "opaque-device" });
		expect(f.trace).not.toContain("permission");
		vi.stubGlobal("Notification", {
			permission: "default",
			requestPermission: () => {
				f.trace.push("permission");
				Object.assign(Notification, { permission: "granted" });
				return Promise.resolve("granted");
			},
		});
		const reads = f.requests.length;
		click("Allow notifications");
		await waitFor(() => expect(screen.getByRole("button", { name: "Enable" })).toBeEnabled());
		expect(f.requests).toHaveLength(reads);
		expect(mutations(f)).toEqual([]);
		f.setState({ ...disabled, configRevision: "c".repeat(64) });
		click("Enable");
		await loaded();
		expect(f.requests[reads]?.body).toEqual({ channelId: "opaque-device" });
		expect(mutations(f)[0]?.body).toEqual({
			endpoint,
			keys: { p256dh: "synthetic-key", auth: "synthetic-auth" },
			channelId: "opaque-device",
			expectedRevision: "c".repeat(64),
		});
		expect(f.trace.filter((step) => step === "permission")).toHaveLength(1);
	});
	it("stops pending Enable when permission returns to default and offers a fresh consent action", async () => {
		const f = fixture({ local: false });
		await loaded("Not enabled in this browser");
		let resolve!: (subscription: PushSubscription | null) => void;
		f.manager.getSubscription = () =>
			new Promise((done) => {
				resolve = done;
			});
		click("Enable");
		await waitFor(() => expect(typeof resolve).toBe("function"));
		Object.assign(Notification, { permission: "default" });
		await act(async () => resolve(null));
		expect(screen.getByRole("button", { name: "Allow notifications" })).toBeEnabled();
		expect(f.trace).not.toContain("permission");
		expect(f.trace).not.toContain("subscribe");
		expect(mutations(f)).toEqual([]);
	});
	it("rejects a direct consent click after cached actor changes before React rerenders", async () => {
		const f = fixture({ local: false, permission: "default" });
		await loaded("Not enabled in this browser");
		const consent = screen.getByRole("button", { name: "Allow notifications" });
		act(() => {
			f.client.setQueryData(authKeys.currentUser, { ...owner, id: "synthetic-other" });
			fireEvent.click(consent);
		});
		expect(f.trace).not.toContain("permission");
		expect(mutations(f)).toEqual([]);
	});
	it.each(["disable", "enable"] as const)(
		"refreshes active populated sibling caches after unknown committed %s without replay",
		async (action) => {
			if (action === "enable") localStorage.setItem(storageKey, "opaque-device");
			const f = fixture({
				activeChannels: true,
				state: action === "disable" ? enabled : disabled,
				...(action === "disable"
					? { disableAck: { id: "legacy" } }
					: { enableAck: { id: "legacy" } }),
			});
			await loaded(action === "disable" ? "Active" : "Delivery disabled");
			await waitFor(() =>
				expect(
					screen.getByText(
						action === "disable" ? "Sibling enabled (current)" : "Sibling disabled (current)",
					),
				).toBeInTheDocument(),
			);
			click(action === "disable" ? "Disable" : "Enable");
			await loaded("Unverified");
			await waitFor(() =>
				expect(
					f.requests.filter((request) => request.path === "/api/notifications/channels"),
				).toHaveLength(1),
			);
			await waitFor(() =>
				expect(
					screen.getByText(
						action === "disable" ? "Sibling disabled (current)" : "Sibling enabled (current)",
					),
				).toBeInTheDocument(),
			);
			expect(
				f.requests.filter((request) => request.path === "/api/notifications/subscriptions"),
			).toHaveLength(1);
			expect(f.trace).not.toContain("unsubscribe");
			click("Retry");
			await loaded(action === "disable" ? "Delivery disabled" : "Active");
			await waitFor(() =>
				expect(
					f.requests.filter((request) => request.path === "/api/notifications/channels"),
				).toHaveLength(2),
			);
			if (action === "disable") {
				click("Retry browser removal");
				await loaded("Inactive");
			}
			expect(mutations(f)).toHaveLength(1);
		},
	);
	it("invalidates immediately while sibling reread is pending and recovers failed reread on read-first Retry", async () => {
		const f = fixture({ activeChannels: true, disableAck: { id: "legacy" } });
		await loaded();
		const transport = globalThis.fetch;
		let refreshes = 0;
		let resolve!: (response: Response) => void;
		vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
			if (String(input) === "/api/notifications/channels") {
				refreshes++;
				if (refreshes === 1)
					return new Promise<Response>((done) => {
						resolve = done;
					});
			}
			return transport(input, init);
		});
		click("Disable");
		await loaded("Unverified");
		await waitFor(() => expect(refreshes).toBe(1));
		expect(screen.getByText("Sibling enabled (last known)")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
		await act(async () => resolve(json({ error: "Unavailable" }, 503)));
		await waitFor(() =>
			expect(f.client.getQueryState(notificationKeys.channels)?.status).toBe("error"),
		);
		expect(screen.getByText("Sibling enabled (last known)")).toBeInTheDocument();
		click("Retry");
		await loaded("Delivery disabled");
		await waitFor(() => expect(screen.getByText("Sibling disabled (current)")).toBeInTheDocument());
		expect(refreshes).toBe(2);
		expect(mutations(f)).toHaveLength(1);
		expect(f.trace).not.toContain("unsubscribe");
	});
	it.each(["unmount", "account change"] as const)(
		"installs cleanup after storage-read recovery before %s during Disable",
		async (exit) => {
			const get = Storage.prototype.getItem;
			let fail = true;
			vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
				if (key === storageKey && fail) throw Error("Synthetic storage unavailable");
				return get.call(this, key);
			});
			const f = fixture();
			await loaded("Unverified");
			fail = false;
			click("Retry");
			await loaded();
			const reads = f.requests.length;
			const writes = vi.spyOn(Storage.prototype, "setItem");
			let resolve!: (subscription: PushSubscription | null) => void;
			f.manager.getSubscription = () =>
				new Promise((done) => {
					resolve = done;
				});
			click("Disable");
			await waitFor(() => expect(typeof resolve).toBe("function"));
			if (exit === "unmount") f.rendered.unmount();
			else
				await act(async () => {
					f.client.setQueryData(authKeys.currentUser, { ...owner, id: "synthetic-other" });
				});
			await act(async () => resolve(f.current));
			expect(f.requests).toHaveLength(reads);
			expect(mutations(f)).toEqual([]);
			expect(writes).not.toHaveBeenCalled();
			expect(f.trace).not.toContain("unsubscribe");
		},
	);
	it("requires owned server-enabled state rather than local subscription presence", async () => {
		const f = fixture({ state: disabled });
		await loaded("Delivery disabled");
		expect(screen.queryByText("Active")).not.toBeInTheDocument();
		expect(mutations(f)).toEqual([]);
		expect(f.requests).toEqual([
			{
				path: "/api/notifications/push-subscription/state",
				body: { endpoint },
				credentials: "include",
			},
		]);
	});
	it("shows unverified and read-only Retry on browser read failure", async () => {
		const f = fixture({ browserFailure: true });
		await loaded("Unverified");
		click("Retry");
		await waitFor(() => expect(f.trace.filter((t) => t === "browser-read")).toHaveLength(2));
		expect(mutations(f)).toEqual([]);
		expect(document.body.textContent).not.toContain("synthetic-private");
	});
	it("does not enroll on mount or read Retry, and makes no extra auth request", async () => {
		const f = fixture({ readFailure: true });
		await loaded("Unverified");
		f.allowRead();
		click("Retry");
		await loaded();
		expect(mutations(f)).toEqual([]);
		expect(f.trace).not.toContain("permission");
		expect(f.trace).not.toContain("subscribe");
		expect(f.requests.every((r) => r.path === "/api/notifications/push-subscription/state")).toBe(
			true,
		);
	});
	it("distinguishes zero event selection without promising received delivery", async () => {
		fixture({ state: { ...enabled, subscribedEventCount: 0 } });
		await loaded();
		expect(screen.getByText(/Choose events in the Events tab/)).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "Select events" })).not.toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/will be delivered|You'll receive/);
	});
	it("accepts selected events without select-events guidance", async () => {
		fixture();
		await loaded();
		expect(screen.queryByText(/Choose events in the Events tab/)).not.toBeInTheDocument();
	});
	it.each([
		{ id: "legacy", updated: true },
		{ ...enabled, configRevision: null },
		{ ...unregistered, channelId: "contradiction" },
		{ ...enabled, subscribedEventCount: -1 },
		{ ...enabled, subscribedEventCount: 1.5 },
	])("rejects malformed/legacy/contradictory state %j", async (state) => {
		const f = fixture({ state });
		await loaded("Unverified");
		expect(mutations(f)).toEqual([]);
		expect(screen.queryByText("Active")).not.toBeInTheDocument();
	});
	it("disables server before removing browser and retains only scoped opaque ID", async () => {
		const f = fixture();
		await loaded();
		click("Disable");
		await loaded("Inactive");
		expect(f.trace.indexOf("disable")).toBeLessThan(f.trace.indexOf("unsubscribe"));
		expect(mutations(f)).toEqual([
			{
				path: "/api/notifications/push-subscription/disable",
				body: { endpoint, channelId: "opaque-device", expectedRevision: revision },
				credentials: "include",
			},
		]);
		expect(localStorage.getItem(storageKey)).toBe("opaque-device");
		expect(localStorage.getItem(storageKey)).not.toContain("private");
		expect(f.client.getQueryState(notificationKeys.channels)?.isInvalidated).toBe(true);
		expect(f.client.getQueryState(notificationKeys.subscriptions)?.isInvalidated).toBe(true);
	});
	it.each([
		{ disableFailure: true },
		{ disableAck: { id: "legacy", updated: true } },
		{ disableAck: enabled },
	])("never unsubscribes after failed/unknown server disable %j", async (options) => {
		const f = fixture(options);
		await loaded();
		click("Disable");
		await loaded("Unverified");
		expect(f.trace).not.toContain("unsubscribe");
		expect(f.current).not.toBeNull();
		expect(document.body.textContent).not.toContain("synthetic-private");
	});
	it.each(["false-present", "true-present"] as const)(
		"does not claim inactive after %s",
		async (unsubscribe) => {
			const f = fixture({ unsubscribe });
			await loaded();
			click("Disable");
			await loaded("Delivery disabled");
			expect(f.current).not.toBeNull();
			f.allowRemoval();
			click("Retry browser removal");
			await loaded("Inactive");
			expect(mutations(f)).toHaveLength(1);
			expect(f.trace.filter((t) => t === "unsubscribe")).toHaveLength(2);
		},
	);
	it("fresh null establishes browser removal when unsubscribe returns false", async () => {
		const f = fixture({ unsubscribe: "false-null" });
		await loaded();
		click("Disable");
		await loaded("Inactive");
		expect(f.current).toBeNull();
	});
	it("preserves partial state on browser failure and targets retry", async () => {
		const f = fixture({ unsubscribe: "throw" });
		await loaded();
		click("Disable");
		await loaded("Delivery disabled");
		f.allowRemoval();
		click("Retry browser removal");
		await loaded("Inactive");
		expect(mutations(f)).toHaveLength(1);
	});
	it("never unsubscribes a changed browser device after server confirmation", async () => {
		const f = fixture();
		await loaded();
		let reads = 0;
		f.manager.getSubscription = async () => {
			reads++;
			if (reads === 2) f.setCurrent(secondEndpoint);
			return f.current;
		};
		click("Disable");
		await loaded("Delivery disabled");
		expect(f.trace).not.toContain("unsubscribe");
		expect(f.current?.endpoint).toBe(secondEndpoint);
	});
	it("reads retained enabled registration with no local subscription and disables server", async () => {
		localStorage.setItem(storageKey, "opaque-device");
		const f = fixture({ local: false });
		await loaded("Browser missing");
		click("Disable");
		await loaded("Inactive");
		expect(f.requests[0]?.body).toEqual({ channelId: "opaque-device" });
		expect(f.trace).not.toContain("unsubscribe");
		expect(mutations(f)).toHaveLength(1);
	});
	it("shows browser-only absence without submitting an empty selector", async () => {
		const f = fixture({ local: false });
		await loaded("Not enabled in this browser");
		expect(f.requests).toEqual([]);
		expect(screen.getByRole("button", { name: "Enable" })).toBeEnabled();
	});
	it("retains handle across reload and explicitly re-enables same channel on changed endpoint", async () => {
		const f = fixture();
		await loaded();
		click("Disable");
		await loaded("Inactive");
		f.rendered.unmount();
		f.mount();
		await loaded("Inactive");
		expect(f.requests.at(-1)?.body).toEqual({ channelId: "opaque-device" });
		click("Enable");
		await loaded();
		expect(mutations(f).at(-1)).toEqual({
			path: "/api/notifications/push-subscription/enable",
			body: {
				endpoint: secondEndpoint,
				keys: { p256dh: "synthetic-key", auth: "synthetic-auth" },
				channelId: "opaque-device",
				expectedRevision: disabledRevision,
			},
			credentials: "include",
		});
		expect(localStorage.getItem(storageKey)).toBe("opaque-device");
	});
	it("keeps newly created browser subscription on server enable failure with read-first Retry", async () => {
		const f = fixture({ local: false, state: unregistered, enableFailure: true });
		await loaded("Not enabled in this browser");
		click("Enable");
		await loaded("Unverified");
		expect(f.current).not.toBeNull();
		expect(f.trace).not.toContain("unsubscribe");
		expect(mutations(f)).toHaveLength(1);
		f.allowEnable();
		click("Retry");
		await loaded("Browser only");
		expect(mutations(f)).toHaveLength(1);
		click("Enable");
		await loaded();
		expect(mutations(f)).toHaveLength(2);
	});
	it("read-first recovery rebinds retained channel after changed-endpoint enable failure", async () => {
		localStorage.setItem(storageKey, "opaque-device");
		const f = fixture({ local: false, state: disabled, enableFailure: true });
		await loaded("Inactive");
		const transport = globalThis.fetch;
		vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
			const body = init.body ? JSON.parse(String(init.body)) : {};
			if (String(input).endsWith("/state") && body.endpoint === secondEndpoint)
				return Promise.resolve(json({ error: "Device conflict" }, 409));
			return transport(input, init);
		});
		click("Enable");
		await loaded("Unverified");
		expect(f.current?.endpoint).toBe(secondEndpoint);
		f.allowEnable();
		click("Retry");
		await loaded("Browser only");
		expect(mutations(f)).toHaveLength(1);
		click("Enable");
		await loaded();
		expect(mutations(f)).toHaveLength(2);
		expect(mutations(f).at(-1)?.body).toEqual({
			endpoint: secondEndpoint,
			keys: { p256dh: "synthetic-key", auth: "synthetic-auth" },
			channelId: "opaque-device",
			expectedRevision: disabledRevision,
		});
		expect(f.trace).not.toContain("unsubscribe");
	});
	it("unrelated retained handle mismatch remains unverified without fallback or mutation", async () => {
		localStorage.setItem(storageKey, "opaque-device");
		const f = fixture({ readFailure: true });
		await loaded("Unverified");
		expect(f.requests).toHaveLength(1);
		expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();
		click("Retry");
		await waitFor(() => expect(f.requests).toHaveLength(2));
		expect(mutations(f)).toEqual([]);
	});
	it("reload after failed retained enable requires explicit reconnect to same channel", async () => {
		localStorage.setItem(storageKey, "opaque-device");
		const f = fixture({ local: false, state: disabled, enableFailure: true });
		await loaded("Inactive");
		const transport = globalThis.fetch;
		vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
			const body = init.body ? JSON.parse(String(init.body)) : {};
			if (String(input).endsWith("/state") && body.endpoint === secondEndpoint)
				return Promise.resolve(json({ error: "Device conflict" }, 409));
			return transport(input, init);
		});
		click("Enable");
		await loaded("Unverified");
		f.rendered.unmount();
		f.mount();
		await loaded("Unverified");
		expect(mutations(f)).toHaveLength(1);
		f.allowEnable();
		click("Reconnect device");
		await loaded();
		expect(mutations(f)).toHaveLength(2);
		expect(mutations(f).at(-1)?.body).toEqual({
			endpoint: secondEndpoint,
			keys: { p256dh: "synthetic-key", auth: "synthetic-auth" },
			channelId: "opaque-device",
			expectedRevision: disabledRevision,
		});
		expect(f.trace).not.toContain("unsubscribe");
		expect(localStorage.getItem(storageKey)).toBe("opaque-device");
	});
	it("explicit reconnect requires fresh owned retained read and never mutates on unavailable evidence", async () => {
		localStorage.setItem(storageKey, "opaque-device");
		const f = fixture({ readFailure: true });
		await loaded("Unverified");
		click("Reconnect device");
		await waitFor(() => expect(f.requests).toHaveLength(2));
		expect(f.requests.at(-1)?.body).toEqual({ channelId: "opaque-device" });
		expect(mutations(f)).toEqual([]);
		expect(f.trace).not.toContain("permission");
		expect(f.trace).not.toContain("unsubscribe");
	});
	it("reload with server-disabled browser present offers targeted browser-only removal", async () => {
		localStorage.setItem(storageKey, "opaque-device");
		const f = fixture({ state: disabled });
		await loaded("Delivery disabled");
		click("Retry browser removal");
		await loaded("Inactive");
		expect(mutations(f)).toEqual([]);
		expect(f.trace.filter((t) => t === "unsubscribe")).toHaveLength(1);
	});
	it.each([404, 409])(
		"explicit reconnect aborts on missing/foreign/unreadable handle evidence %i",
		async (code) => {
			localStorage.setItem(storageKey, "opaque-device");
			const f = fixture({ readFailure: true, permission: "default" });
			await loaded("Unverified");
			const transport = globalThis.fetch;
			vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
				if (
					init.body &&
					JSON.parse(String(init.body)).channelId &&
					!JSON.parse(String(init.body)).endpoint
				)
					return Promise.resolve(json({ error: "Device unavailable" }, code));
				return transport(input, init);
			});
			click("Reconnect device");
			await waitFor(() =>
				expect(screen.getByRole("button", { name: "Reconnect device" })).toBeEnabled(),
			);
			expect(mutations(f)).toEqual([]);
			expect(f.trace).not.toContain("permission");
			expect(f.trace).not.toContain("unsubscribe");
		},
	);
	it("targeted removal re-disables only when fresh server evidence shows enabled", async () => {
		const f = fixture({ unsubscribe: "false-present" });
		await loaded();
		click("Disable");
		await loaded("Delivery disabled");
		f.setState(enabled);
		f.allowRemoval();
		click("Retry browser removal");
		await loaded("Inactive");
		expect(mutations(f)).toHaveLength(2);
		expect(mutations(f).at(-1)?.body).toEqual({
			endpoint,
			channelId: "opaque-device",
			expectedRevision: revision,
		});
	});
	it("unknown disable acknowledgment requires read-first recovery without replay", async () => {
		const f = fixture({ disableAck: { id: "legacy" } });
		await loaded();
		click("Disable");
		await loaded("Unverified");
		click("Retry");
		await loaded("Delivery disabled");
		expect(mutations(f)).toHaveLength(1);
		click("Retry browser removal");
		await loaded("Inactive");
		expect(mutations(f)).toHaveLength(1);
	});
	it("scoped storage read failure remains generic and read-only", async () => {
		const get = Storage.prototype.getItem;
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
			if (key === storageKey) throw Error("synthetic-private-storage-error");
			return get.call(this, key);
		});
		const f = fixture();
		await loaded("Unverified");
		expect(f.requests).toEqual([]);
		expect(document.body.textContent).not.toContain("synthetic-private");
	});
	it.each([
		{ enableAck: disabled },
		{ enableAck: { ...enabled, channelId: "wrong-device" } },
		{ enableAck: { id: "legacy" } },
	])(
		"retained enable unknown acknowledgment keeps browser and requires read %j",
		async (options) => {
			localStorage.setItem(storageKey, "opaque-device");
			const f = fixture({ local: false, state: disabled, ...options });
			await loaded("Inactive");
			click("Enable");
			await loaded("Unverified");
			expect(f.current).not.toBeNull();
			expect(f.trace).not.toContain("unsubscribe");
			expect(mutations(f)).toHaveLength(1);
		},
	);
	it("bounds hung disable transport and ignores late response before browser removal", async () => {
		const f = fixture();
		await loaded();
		const transport = globalThis.fetch;
		let resolve!: (value: Response) => void;
		vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) =>
			String(input).endsWith("/disable")
				? new Promise<Response>((done) => {
						resolve = done;
					})
				: transport(input, init),
		);
		vi.useFakeTimers();
		click("Disable");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(typeof resolve).toBe("function");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10001);
		});
		expect(screen.getByText("Unverified")).toBeInTheDocument();
		await act(async () => resolve(json(disabled)));
		expect(f.trace).not.toContain("unsubscribe");
		expect(f.current).not.toBeNull();
	});
	it("bounds browser removal hang and ignores late completion without claiming inactive", async () => {
		const f = fixture();
		await loaded();
		let resolve!: (value: boolean) => void;
		const local = f.current!;
		local.unsubscribe = () =>
			new Promise((done) => {
				resolve = done;
			});
		vi.useFakeTimers();
		click("Disable");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(typeof resolve).toBe("function");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10001);
		});
		expect(screen.getByText("Delivery disabled")).toBeInTheDocument();
		await act(async () => resolve(true));
		expect(screen.queryByText("Inactive")).not.toBeInTheDocument();
	});
	it("read-only initial worker timeout remains unverified with no late enrollment", async () => {
		vi.useFakeTimers();
		const f = fixture();
		let resolve!: (value: ServiceWorkerRegistration) => void;
		f.rendered.unmount();
		Object.defineProperty(navigator.serviceWorker, "ready", {
			configurable: true,
			value: new Promise((done) => {
				resolve = done;
			}),
		});
		f.mount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10001);
		});
		expect(screen.getByText("Unverified")).toBeInTheDocument();
		await act(async () =>
			resolve({ pushManager: f.manager } as unknown as ServiceWorkerRegistration),
		);
		expect(mutations(f)).toEqual([]);
		expect(f.requests).toEqual([]);
	});
	it("unsupported browser is omitted", async () => {
		const f = fixture();
		f.rendered.unmount();
		vi.stubGlobal("PushManager", undefined);
		delete (window as unknown as Record<string, unknown>).PushManager;
		f.mount();
		await waitFor(() =>
			expect(screen.queryByText("Browser Push Notifications")).not.toBeInTheDocument(),
		);
		expect(mutations(f)).toEqual([]);
	});
	it("does not remove only browser binding when scoped storage cannot retain ID", async () => {
		const f = fixture();
		await loaded();
		vi.spyOn(Storage.prototype, "setItem").mockImplementation((key) => {
			if (key === storageKey) throw Error("synthetic-private-storage-error");
		});
		click("Disable");
		await waitFor(() => expect(screen.getByText(/could not be retained/i)).toBeInTheDocument());
		expect(f.trace).not.toContain("unsubscribe");
		expect(mutations(f)).toEqual([]);
		expect(document.body.textContent).not.toContain("synthetic-private");
	});
	it("blocks overlapping enable/disable/read while a server change is pending", async () => {
		const f = fixture();
		await loaded();
		let resolve!: (value: Response) => void;
		vi.stubGlobal(
			"fetch",
			async () =>
				new Promise<Response>((done) => {
					resolve = done;
				}),
		);
		click("Disable");
		await waitFor(() => expect(screen.getByRole("button", { name: "Disable" })).toBeDisabled());
		fireEvent.click(screen.getByRole("button", { name: "Disable" }));
		expect(f.trace).not.toContain("unsubscribe");
		await act(async () => resolve(json(enabled)));
	});
	it("times out browser wait and ignores late completion without starting server work", async () => {
		const f = fixture();
		await loaded();
		vi.useFakeTimers();
		let resolve!: (value: PushSubscription | null) => void;
		f.manager.getSubscription = () =>
			new Promise((done) => {
				resolve = done;
			});
		click("Disable");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10001);
		});
		expect(screen.getByText("Unverified")).toBeInTheDocument();
		await act(async () => resolve(f.current));
		expect(mutations(f)).toEqual([]);
		expect(f.trace).not.toContain("unsubscribe");
	});
	it("ignores pending work after unmount before any mutation or storage continuation", async () => {
		const f = fixture();
		await loaded();
		let resolve!: (value: PushSubscription | null) => void;
		f.manager.getSubscription = () =>
			new Promise((done) => {
				resolve = done;
			});
		click("Disable");
		await waitFor(() => expect(typeof resolve).toBe("function"));
		f.rendered.unmount();
		await act(async () => resolve(f.current));
		expect(mutations(f)).toEqual([]);
		expect(localStorage.getItem(storageKey)).toBeNull();
	});
	it("isolates pending work across cached account change", async () => {
		const f = fixture();
		await loaded();
		let resolve!: (value: PushSubscription | null) => void;
		f.manager.getSubscription = () =>
			new Promise((done) => {
				resolve = done;
			});
		click("Disable");
		await waitFor(() => expect(typeof resolve).toBe("function"));
		await act(async () =>
			f.client.setQueryData(authKeys.currentUser, {
				...owner,
				id: "synthetic-other",
				username: "other",
			}),
		);
		await act(async () => resolve(f.current));
		expect(mutations(f)).toEqual([]);
		expect(localStorage.getItem(storageKey)).toBeNull();
	});
	it("permission denied remains blocked without enrollment", async () => {
		const f = fixture({ permission: "denied" });
		await loaded("Blocked");
		expect(mutations(f)).toEqual([]);
	});
});

describe("push lifecycle validated API client", () => {
	it("projects approved DTO fields only", async () => {
		vi.stubGlobal("fetch", async () =>
			json({ ...enabled, endpoint, keys: { auth: "private" }, unexpected: "private" }),
		);
		expect(await notificationsApi.readPushState({ endpoint })).toEqual(enabled);
	});
	it("bounds a hung transport and never blindly replays", async () => {
		vi.useFakeTimers();
		let calls = 0;
		vi.stubGlobal("fetch", () => {
			calls++;
			return new Promise(() => {});
		});
		const result = notificationsApi.disablePushSubscription({ endpoint }).catch((error) => error);
		await vi.advanceTimersByTimeAsync(10001);
		expect((await result).message).toMatch(/verified/i);
		expect(calls).toBe(1);
	});
});
