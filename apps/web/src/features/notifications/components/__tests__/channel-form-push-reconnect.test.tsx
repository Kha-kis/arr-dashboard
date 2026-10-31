import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { authKeys, notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { ChannelForm } from "../channel-form";

const revision = "a".repeat(64),
	freshRevision = "b".repeat(64),
	savedRevision = "c".repeat(64);
const endpoint = "https://synthetic.invalid/current-browser";
const keys = { p256dh: "generated-key", auth: "generated-auth" };
const state = {
	id: "selected",
	name: "Synthetic",
	type: "BROWSER_PUSH",
	enabled: false,
	configRevision: revision,
	state: "repair-required",
};
const ack = {
	channelId: "selected",
	configRevision: savedRevision,
	state: "disabled",
	subscribedEventCount: 2,
};
const definitions = [{ type: "BROWSER_PUSH", label: "Browser Push", icon: "Bell", formFields: [] }];
type Request = { path: string; method: string; body: unknown };
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const clients: QueryClient[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
function fixture(
	options: {
		permission?: NotificationPermission;
		ack?: unknown;
		slowEdit?: Promise<Response>;
		slowWrite?: Promise<Response>;
		missingSubscription?: boolean;
		enabled?: boolean;
		readback?: unknown;
		writeFails?: boolean;
		slowNative?: Promise<PushSubscription | null>;
		slowPermission?: Promise<NotificationPermission>;
		vapidFails?: boolean;
		missingCapability?: "serviceWorker" | "PushManager";
	} = {},
) {
	const requests: Request[] = [];
	let repaired = false;
	let editReads = 0;
	let permission = options.permission ?? "granted";
	let native: PushSubscription | null = options.missingSubscription ? null : subscription();
	let permissionCalls = 0,
		subscriptions = 0,
		unsubscribes = 0;
	function subscription(url = endpoint) {
		return {
			endpoint: url,
			expirationTime: null,
			options: { applicationServerKey: null, userVisibleOnly: true },
			getKey: () => null,
			toJSON: () => ({ endpoint: url, keys }),
			unsubscribe: async () => {
				unsubscribes++;
				return true;
			},
		} as PushSubscription;
	}
	const registration = {
		pushManager: {
			getSubscription: async () => options.slowNative ?? native,
			subscribe: async () => {
				subscriptions++;
				native = subscription();
				return native;
			},
		},
	} as unknown as ServiceWorkerRegistration;
	const worker = { register: async () => registration, ready: Promise.resolve(registration) };
	vi.stubGlobal("navigator", { serviceWorker: worker });
	vi.stubGlobal("PushManager", class {});
	vi.stubGlobal("Notification", {
		get permission() {
			return permission;
		},
		requestPermission: () => {
			permissionCalls++;
			permission = "granted";
			return options.slowPermission ?? Promise.resolve(permission);
		},
	});
	if (options.missingCapability === "serviceWorker") vi.stubGlobal("navigator", {});
	if (options.missingCapability === "PushManager") vi.stubGlobal("PushManager", undefined);
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input),
			method = init.method ?? "GET",
			body = init.body ? JSON.parse(String(init.body)) : undefined;
		requests.push({ path, method, body });
		if (path.endsWith("/config")) return json({ error: "synthetic-private" }, 500);
		if (path.endsWith("/edit-state")) {
			editReads++;
			return editReads > 1 && options.slowEdit
				? options.slowEdit
				: json({
						...state,
						enabled: options.enabled ?? false,
						configRevision: repaired ? savedRevision : editReads > 1 ? freshRevision : revision,
						state: repaired ? "readable" : "repair-required",
					});
		}
		if (path.endsWith("/reconnect")) {
			if (options.writeFails) throw Error("synthetic-private-write");
			repaired = true;
			return (
				options.slowWrite ??
				json(
					Object.hasOwn(options, "ack")
						? options.ack
						: { ...ack, state: options.enabled ? "enabled" : "disabled" },
				)
			);
		}
		if (path.endsWith("/state"))
			return json(
				Object.hasOwn(options, "readback")
					? options.readback
					: { ...ack, state: options.enabled ? "enabled" : "disabled" },
			);
		if (path.endsWith("/vapid-public-key"))
			return options.vapidFails
				? json({ error: "synthetic-private-vapid" }, 503)
				: json({ publicKey: "AQID" });
		if (path.endsWith("/channel-types")) return json(definitions);
		throw Error("Unexpected synthetic request");
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	clients.push(client);
	client.setQueryData(authKeys.currentUser, {
		id: "owner",
		username: "synthetic",
		mustChangePassword: false,
		createdAt: "2026-01-01T00:00:00Z",
		hasTmdbApiKey: false,
		hasPassword: true,
	});
	client.setQueryData(notificationKeys.channelTypes, definitions);
	const onSave = vi.fn(),
		onSaved = vi.fn();
	const view = render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<ChannelForm channelId="selected" onSave={onSave} onSaved={onSaved} onCancel={() => {}} />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	localStorage.setItem("arr-dashboard:browser-push:v1:owner", "unrelated-retained");
	return {
		...view,
		requests,
		client,
		onSave,
		onSaved,
		permissionCalls: () => permissionCalls,
		subscriptions: () => subscriptions,
		unsubscribes: () => unsubscribes,
		changeBrowser: () => {
			native = subscription("https://synthetic.invalid/changed");
		},
		changeWorker: () => {
			vi.stubGlobal("navigator", { serviceWorker: { ...worker } });
		},
		setPermission: (value: NotificationPermission) => {
			permission = value;
		},
		loseCapability: () => {
			vi.stubGlobal("navigator", {});
		},
	};
}
const writes = (f: ReturnType<typeof fixture>) =>
	f.requests.filter((r) => r.path.endsWith("/reconnect"));
async function prepare() {
	const check = await screen.findByRole("button", { name: "Check repair options" });
	await waitFor(() => expect(check).toBeEnabled());
	fireEvent.click(check);
	const reconnect = await screen.findByRole("button", {
		name: "Reconnect this channel to this browser",
	});
	await waitFor(() => expect(reconnect).toBeEnabled());
	fireEvent.click(reconnect);
}
async function confirm() {
	const button = await screen.findByRole("button", { name: "Confirm reconnect" });
	await waitFor(() => expect(button).toBeEnabled());
	fireEvent.click(button);
}
describe("selected push repair through mounted ChannelForm and real client", () => {
	it("waits for the current owner before preparing an actionable reconnect", async () => {
		const f = fixture();
		const owner = f.client.getQueryData(authKeys.currentUser);
		await screen.findByRole("button", { name: "Check repair options" });
		await act(async () => {
			f.client.setQueryData(authKeys.currentUser, null);
		});
		let completed = false;
		const preparing = prepare().then(() => {
			completed = true;
		});
		try {
			expect(
				await screen.findByRole("button", { name: "Reconnect this channel to this browser" }),
			).toBeDisabled();
			await act(async () => {
				await Promise.resolve();
			});
			expect(completed).toBe(false);
			expect(writes(f)).toHaveLength(0);
			expect(f.subscriptions()).toBe(0);
		} finally {
			await act(async () => {
				f.client.setQueryData(authKeys.currentUser, owner);
			});
			await preparing;
		}
		expect(await screen.findByRole("button", { name: "Confirm reconnect" })).toBeEnabled();
		expect(writes(f)).toHaveLength(0);
		expect(f.subscriptions()).toBe(0);
	});
	it("BP-REG-1: selected repair guidance distinguishes generated reconnect from manual re-entry", async () => {
		fixture();
		await prepare();
		expect(screen.getByRole("alert")).toHaveTextContent(/manual.*cannot.*re-enter/i);
		expect(screen.getByRole("alert")).toHaveTextContent(/reconnect.*action below/i);
		expect(screen.getByRole("alert")).not.toHaveTextContent(
			/re-enter the full configuration|cannot be replaced in this editor/i,
		);
		expect(screen.getByText(/former browser destination/i)).toBeInTheDocument();
	});
	it("BP-REG-2: granted-to-denied permission on confirm gives blocked guidance without enrollment", async () => {
		const f = fixture();
		await prepare();
		f.setPermission("denied");
		await confirm();
		expect(await screen.findByText(/blocked.*browser permission/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Confirm reconnect" })).not.toBeInTheDocument();
		expect(writes(f)).toHaveLength(0);
		expect(f.subscriptions()).toBe(0);
		expect(f.permissionCalls()).toBe(0);
	});
	it.each(["serviceWorker", "PushManager"] as const)(
		"BP-REG-2: missing %s gates preparation with unsupported guidance",
		async (missingCapability) => {
			const f = fixture({ missingCapability });
			await prepare();
			expect(await screen.findByText(/unsupported.*browser/i)).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Confirm reconnect" })).not.toBeInTheDocument();
			expect(writes(f)).toHaveLength(0);
			expect(f.subscriptions()).toBe(0);
			expect(f.permissionCalls()).toBe(0);
		},
	);
	it("BP-REG-2: capability lost after preparation produces guidance at confirm", async () => {
		const f = fixture();
		await prepare();
		f.loseCapability();
		await confirm();
		expect(await screen.findByText(/unsupported.*browser/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Confirm reconnect" })).not.toBeInTheDocument();
		expect(writes(f)).toHaveLength(0);
	});
	it.each(["cancel", "privacy", "account"])(
		"BP-DS-1: %s retains selected same-owner recovery across a held dispatched ACK",
		async (change) => {
			const slow = deferred<Response>();
			const f = fixture({ slowWrite: slow.promise });
			await prepare();
			await confirm();
			await waitFor(() => expect(writes(f)).toHaveLength(1));
			if (change === "cancel")
				fireEvent.click(screen.getByRole("button", { name: "Cancel reconnect" }));
			if (change === "privacy") {
				await act(async () => {
					localStorage.setItem("arr-dashboard-incognito-mode", "true");
					window.dispatchEvent(new Event("incognito-mode-changed"));
				});
				expect(
					await screen.findByRole("button", { name: "Recheck current binding" }),
				).toBeDisabled();
				await act(async () => {
					localStorage.setItem("arr-dashboard-incognito-mode", "false");
					window.dispatchEvent(new Event("incognito-mode-changed"));
				});
			}
			if (change === "account") {
				await act(async () => {
					f.client.setQueryData(authKeys.currentUser, {
						id: "other",
						username: "other",
						mustChangePassword: false,
						createdAt: "2026-01-01T00:00:00Z",
						hasTmdbApiKey: false,
						hasPassword: true,
					});
				});
				// Query notifications are scheduled: observe the away-owner render before returning.
				await screen.findByRole("button", { name: "Reconnect this channel to this browser" });
				expect(screen.queryByText(/change may have been saved/i)).not.toBeInTheDocument();
				expect(
					screen.queryByRole("button", { name: "Recheck current binding" }),
				).not.toBeInTheDocument();
				await act(async () => {
					f.client.setQueryData(authKeys.currentUser, {
						id: "owner",
						username: "synthetic",
						mustChangePassword: false,
						createdAt: "2026-01-01T00:00:00Z",
						hasTmdbApiKey: false,
						hasPassword: true,
					});
				});
			}
			expect(await screen.findByText(/change may have been saved/i)).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "Reconnect this channel to this browser" }),
			).not.toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Recheck current binding" })).toBeEnabled();
			await act(async () => slow.resolve(json(ack)));
			expect(f.onSave).not.toHaveBeenCalled();
			expect(writes(f)).toHaveLength(1);
			fireEvent.click(screen.getByRole("button", { name: "Recheck current binding" }));
			await waitFor(() => expect(f.onSave).toHaveBeenCalledOnce());
			expect(writes(f)).toHaveLength(1);
			expect(f.unsubscribes()).toBe(0);
		},
	);
	it("requires explicit warning and cancellation without generated manual fields or enrollment", async () => {
		const f = fixture();
		await prepare();
		expect(screen.getByText(/former browser/i)).toBeInTheDocument();
		expect(screen.getByText(/history.*enabled setting/i)).toBeInTheDocument();
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		expect(writes(f)).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Cancel reconnect" }));
		expect(screen.queryByRole("button", { name: "Confirm reconnect" })).not.toBeInTheDocument();
		expect(f.subscriptions()).toBe(0);
	});
	it("permission stays a separate direct click and never automatically enrolls", async () => {
		const f = fixture({ permission: "default", missingSubscription: true });
		await prepare();
		expect(f.permissionCalls()).toBe(0);
		fireEvent.click(screen.getByRole("button", { name: "Allow notifications" }));
		expect(f.permissionCalls()).toBe(1);
		await screen.findByRole("button", { name: "Confirm reconnect" });
		expect(writes(f)).toHaveLength(0);
		expect(f.subscriptions()).toBe(0);
		await confirm();
		await waitFor(() => expect(f.onSave).toHaveBeenCalledOnce());
		expect(f.subscriptions()).toBe(1);
	});
	it.each([false, true])(
		"fresh selected revision and generated native config retain enabled=%s and unrelated handle",
		async (enabled) => {
			const f = fixture({ enabled });
			await prepare();
			await confirm();
			await waitFor(() => expect(f.onSave).toHaveBeenCalledOnce());
			expect(writes(f)).toEqual([
				{
					path: "/api/notifications/push-subscription/reconnect",
					method: "POST",
					body: { channelId: "selected", expectedRevision: freshRevision, endpoint, keys },
				},
			]);
			expect(f.requests.find((r) => r.path.endsWith("/state"))?.body).toEqual({
				channelId: "selected",
				endpoint,
			});
			expect(f.onSaved).toHaveBeenCalledWith("selected");
			expect(localStorage.getItem("arr-dashboard:browser-push:v1:owner")).toBe(
				"unrelated-retained",
			);
			expect(f.unsubscribes()).toBe(0);
		},
	);
	it.each([
		{ ...ack, channelId: "wrong" },
		{ ...ack, state: "unregistered" },
		{ ...ack, configRevision: null },
		{ ...ack, state: "enabled" },
		{ ...ack, extra: "synthetic-private" },
		null,
	])("unknown ACK requires read-only recovery and never replays %j", async (value) => {
		const f = fixture({ ack: value });
		await prepare();
		await confirm();
		await screen.findByText(/outcome could not be verified/i);
		expect(f.onSave).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Confirm reconnect" })).not.toBeInTheDocument();
		expect(writes(f)).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Recheck current binding" }));
		await waitFor(() => expect(f.onSave).toHaveBeenCalledOnce());
		expect(writes(f)).toHaveLength(1);
		expect(f.unsubscribes()).toBe(0);
	});
	it.each(["account", "incognito", "unmount"])(
		"fences late fresh read on %s change",
		async (change) => {
			const slow = deferred<Response>();
			const f = fixture({ slowEdit: slow.promise });
			await prepare();
			await confirm();
			await waitFor(() =>
				expect(f.requests.filter((r) => r.path.endsWith("/edit-state"))).toHaveLength(2),
			);
			await act(async () => {
				if (change === "account") f.client.setQueryData(authKeys.currentUser, { id: "other" });
				if (change === "incognito") {
					localStorage.setItem("arr-dashboard-incognito-mode", "true");
					window.dispatchEvent(new Event("incognito-mode-changed"));
				}
				if (change === "unmount") f.unmount();
				slow.resolve(json({ ...state, configRevision: freshRevision }));
			});
			expect(writes(f)).toHaveLength(0);
			expect(f.onSave).not.toHaveBeenCalled();
		},
	);
	it("changed native destination after dispatch cannot receive a success claim or remove subscription", async () => {
		const pending = deferred<Response>();
		const f = fixture({ slowWrite: pending.promise });
		await prepare();
		await confirm();
		await waitFor(() => expect(writes(f)).toHaveLength(1));
		f.changeBrowser();
		await act(async () => pending.resolve(json(ack)));
		await screen.findByText(/outcome could not be verified/i);
		expect(f.onSave).not.toHaveBeenCalled();
		expect(f.unsubscribes()).toBe(0);
	});
	it("recheck rejects a state revision inconsistent with its fresh owned read", async () => {
		const f = fixture({ ack: null, readback: { ...ack, configRevision: "d".repeat(64) } });
		await prepare();
		await confirm();
		await screen.findByText(/outcome could not be verified/i);
		fireEvent.click(screen.getByRole("button", { name: "Recheck current binding" }));
		await waitFor(() => expect(f.requests.some((r) => r.path.endsWith("/state"))).toBe(true));
		await screen.findByText(/outcome could not be verified/i);
		expect(f.onSave).not.toHaveBeenCalled();
		expect(writes(f)).toHaveLength(1);
	});
	it("timeout keeps pending dispatch unverified and blocks replay despite a late ACK", async () => {
		const slow = deferred<Response>();
		const f = fixture({ slowWrite: slow.promise });
		await prepare();
		vi.useFakeTimers();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Confirm reconnect" }));
		});
		expect(writes(f)).toHaveLength(1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_001);
		});
		expect(screen.getByText(/outcome could not be verified/i)).toBeInTheDocument();
		await act(async () => slow.resolve(json(ack)));
		expect(f.onSave).not.toHaveBeenCalled();
		expect(writes(f)).toHaveLength(1);
		expect(f.unsubscribes()).toBe(0);
	});
	it("failed write only permits new explicit intent after a read-only repair check", async () => {
		const f = fixture({ writeFails: true });
		await prepare();
		await confirm();
		await screen.findByText(/outcome could not be verified/i);
		fireEvent.click(screen.getByRole("button", { name: "Recheck current binding" }));
		await screen.findByText(/still requires repair/i);
		expect(writes(f)).toHaveLength(1);
		expect(
			screen.getByRole("button", { name: "Reconnect this channel to this browser" }),
		).toBeEnabled();
		expect(f.onSave).not.toHaveBeenCalled();
	});
	it.each(["denied", "default"] as const)(
		"does not reconnect under permission %s without another native action",
		async (permission) => {
			const f = fixture({ permission });
			await prepare();
			expect(screen.queryByRole("button", { name: "Confirm reconnect" })).not.toBeInTheDocument();
			expect(writes(f)).toHaveLength(0);
			expect(f.permissionCalls()).toBe(0);
		},
	);
	it.each(["account", "incognito", "unmount"])(
		"late dispatched ACK is fenced after %s change",
		async (change) => {
			const slow = deferred<Response>();
			const f = fixture({ slowWrite: slow.promise });
			await prepare();
			await confirm();
			await waitFor(() => expect(writes(f)).toHaveLength(1));
			await act(async () => {
				if (change === "account") f.client.setQueryData(authKeys.currentUser, { id: "other" });
				if (change === "incognito") {
					localStorage.setItem("arr-dashboard-incognito-mode", "true");
					window.dispatchEvent(new Event("incognito-mode-changed"));
				}
				if (change === "unmount") f.unmount();
				slow.resolve(json(ack));
			});
			expect(f.onSave).not.toHaveBeenCalled();
			expect(writes(f)).toHaveLength(1);
			expect(f.unsubscribes()).toBe(0);
		},
	);
	it("native worker changed before dispatch prevents server replacement", async () => {
		const slow = deferred<Response>();
		const f = fixture({ slowEdit: slow.promise });
		await prepare();
		await confirm();
		await waitFor(() =>
			expect(f.requests.filter((r) => r.path.endsWith("/edit-state"))).toHaveLength(2),
		);
		f.changeWorker();
		await act(async () => slow.resolve(json({ ...state, configRevision: freshRevision })));
		await screen.findByText(/could not be prepared/i);
		expect(writes(f)).toHaveLength(0);
		expect(f.unsubscribes()).toBe(0);
	});
	it("late consent after cancel cannot enroll or confirm a replacement", async () => {
		const slow = deferred<NotificationPermission>();
		const f = fixture({ permission: "default", slowPermission: slow.promise });
		await prepare();
		fireEvent.click(screen.getByRole("button", { name: "Allow notifications" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel reconnect" }));
		await act(async () => slow.resolve("granted"));
		expect(screen.queryByRole("button", { name: "Confirm reconnect" })).not.toBeInTheDocument();
		expect(writes(f)).toHaveLength(0);
		expect(f.subscriptions()).toBe(0);
	});
	it("VAPID preparation failure cannot dispatch, unsubscribe, or reveal private error", async () => {
		const f = fixture({ missingSubscription: true, vapidFails: true });
		await prepare();
		await confirm();
		await screen.findByText(/could not be prepared/i);
		expect(writes(f)).toHaveLength(0);
		expect(f.subscriptions()).toBe(0);
		expect(f.unsubscribes()).toBe(0);
		expect(screen.queryByText(/synthetic-private-vapid/i)).not.toBeInTheDocument();
	});
	it.each([
		{ ...ack, channelId: "wrong" },
		{ ...ack, state: "enabled" },
		{ ...ack, configRevision: "d".repeat(64) },
		null,
	])("readback %j cannot certify saved binding", async (readback) => {
		const f = fixture({ readback });
		await prepare();
		await confirm();
		await screen.findByText(/outcome could not be verified/i);
		expect(f.onSave).not.toHaveBeenCalled();
		expect(writes(f)).toHaveLength(1);
		expect(f.unsubscribes()).toBe(0);
	});
});
