"use client";

import type { BrowserPushState, CurrentUser } from "@arr/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type DomainStatus, DomainStatusBadge } from "@/components/layout/premium-components";
import { useCurrentUser } from "@/hooks/api/useAuth";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { notificationsApi } from "../../../lib/api-client/notifications";
import { authKeys, notificationKeys } from "../../../lib/query-keys";

type Status =
	| "loading"
	| "unsupported"
	| "denied"
	| "unverified"
	| "enabled"
	| "disabled"
	| "absent"
	| "browser-only"
	| "delivery-disabled"
	| "browser-missing";
type Observation = {
	server: BrowserPushState | null;
	subscription: PushSubscription | null;
	registration: ServiceWorkerRegistration;
	bound: boolean;
};
type Operation = { active: () => boolean; wait: <T>(promise: PromiseLike<T>) => Promise<T> };
const labels: Record<Status, string> = {
	loading: "Checking…",
	unsupported: "Unsupported",
	denied: "Blocked",
	unverified: "Unverified",
	enabled: "Active",
	disabled: "Inactive",
	absent: "Not enabled in this browser",
	"browser-only": "Browser only",
	"delivery-disabled": "Delivery disabled",
	"browser-missing": "Browser missing",
};
const unverifiedMessage =
	"Browser push device state could not be verified. Recheck before trying again.";
const retentionMessage =
	"Device settings could not be retained in this browser. Browser removal was not started.";

function validHandle(value: string | null): value is string {
	return (
		typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
	);
}
function observedStatus(
	server: BrowserPushState | null,
	subscription: PushSubscription | null,
): Status {
	if (!server) return subscription ? "browser-only" : "absent";
	if (server.state === "enabled") return subscription ? "enabled" : "browser-missing";
	if (server.state === "disabled") return subscription ? "delivery-disabled" : "disabled";
	return subscription ? "browser-only" : "absent";
}
function domainStatus(status: Status): DomainStatus {
	if (status === "enabled") return "healthy";
	if (status === "disabled" || status === "absent") return "disabled";
	if (status === "denied" || status === "unverified") return "offline";
	return "configured";
}
function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
	const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
	const raw = window.atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function BrowserPushCard() {
	const { gradient } = useThemeGradient();
	const queryClient = useQueryClient();
	const { data: user } = useCurrentUser(false);
	const userId = user?.id;
	const generation = useRef(0);
	const running = useRef(false);
	const handle = useRef<string | null>(null);
	// Ephemeral recovery evidence from this account's explicit enable attempt only.
	const enableRecovery = useRef<{ channelId: string; endpoint: string } | null>(null);
	const unverifiedWrite = useRef(false);
	const [permission, setPermission] = useState<NotificationPermission>("default");
	const [reconnectPrepared, setReconnectPrepared] = useState(false);
	const [status, setStatus] = useState<Status>("loading");
	const [server, setServer] = useState<BrowserPushState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [removalEndpoint, setRemovalEndpoint] = useState<string | null>(null);
	const storageKey = userId ? `arr-dashboard:browser-push:v1:${userId}` : null;

	function begin(): Operation | null {
		if (
			running.current ||
			!userId ||
			queryClient.getQueryData<CurrentUser | null>(authKeys.currentUser)?.id !== userId
		)
			return null;
		running.current = true;
		const token = ++generation.current;
		setPending(true);
		setError(null);
		const active = () =>
			generation.current === token &&
			queryClient.getQueryData<CurrentUser | null>(authKeys.currentUser)?.id === userId;
		return {
			active,
			async wait<T>(promise: PromiseLike<T>): Promise<T> {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const result = await Promise.race([
						promise,
						new Promise<never>((_resolve, reject) => {
							timer = setTimeout(() => reject(new Error("unverified")), 10_000);
						}),
					]);
					if (!active()) throw new Error("stale");
					return result;
				} finally {
					if (timer !== undefined) clearTimeout(timer);
				}
			},
		};
	}
	function finish(operation: Operation) {
		if (operation.active()) {
			running.current = false;
			setPending(false);
		}
	}
	function retain(id: string) {
		if (!storageKey || !validHandle(id)) throw new Error("retention");
		handle.current = id;
		localStorage.setItem(storageKey, id);
		if (localStorage.getItem(storageKey) !== id) throw new Error("retention");
	}
	function invalidate() {
		void queryClient.invalidateQueries({ queryKey: notificationKeys.channels });
		void queryClient.invalidateQueries({ queryKey: notificationKeys.subscriptions });
	}
	function apply(observation: Observation) {
		if (unverifiedWrite.current) {
			invalidate();
			unverifiedWrite.current = false;
		}
		setServer(observation.server);
		if (observation.server?.channelId) handle.current = observation.server.channelId;
		setStatus(
			observation.subscription && !observation.bound
				? "browser-only"
				: observedStatus(observation.server, observation.subscription),
		);
		if (observation.bound && observation.server?.state === "disabled" && observation.subscription)
			setRemovalEndpoint(observation.subscription.endpoint);
	}
	async function observe(operation: Operation, reconnect = false): Promise<Observation> {
		await operation.wait(navigator.serviceWorker.register("/sw.js"));
		const registration = await operation.wait(navigator.serviceWorker.ready);
		const subscription = await operation.wait(registration.pushManager.getSubscription());
		if (reconnect) {
			if (!handle.current) throw new Error("unverified");
			const actual = await operation.wait(
				notificationsApi.readPushState({ channelId: handle.current }),
			);
			return { server: actual, subscription, registration, bound: !subscription };
		}
		const selector = {
			...(subscription ? { endpoint: subscription.endpoint } : {}),
			...(handle.current ? { channelId: handle.current } : {}),
		};
		try {
			const actual =
				selector.endpoint || selector.channelId
					? await operation.wait(notificationsApi.readPushState(selector))
					: null;
			return { server: actual, subscription, registration, bound: true };
		} catch {
			const recovery = enableRecovery.current;
			if (
				!operation.active() ||
				!recovery ||
				recovery.channelId !== handle.current ||
				recovery.endpoint !== subscription?.endpoint
			)
				throw new Error("unverified");
			const actual = await operation.wait(
				notificationsApi.readPushState({ channelId: recovery.channelId }),
			);
			// This proves the retained registration, not its binding to the new browser.
			return { server: actual, subscription, registration, bound: false };
		}
	}
	async function readState() {
		const operation = begin();
		if (!operation) return;
		try {
			apply(await observe(operation));
		} catch {
			if (operation.active()) {
				setStatus("unverified");
				setError(unverifiedMessage);
			}
		} finally {
			finish(operation);
		}
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: Account identity owns this lifecycle; render-local callbacks must not reset an active operation.
	useEffect(() => {
		generation.current++;
		running.current = false;
		const cleanup = () => {
			generation.current++;
			running.current = false;
		};
		handle.current = null;
		enableRecovery.current = null;
		unverifiedWrite.current = false;
		setReconnectPrepared(false);
		setServer(null);
		setError(null);
		setRemovalEndpoint(null);
		setPending(false);
		setStatus("loading");
		if (
			!("Notification" in window) ||
			!("serviceWorker" in navigator) ||
			!("PushManager" in window)
		) {
			setStatus("unsupported");
			return cleanup;
		}
		setPermission(Notification.permission);
		if (Notification.permission === "denied") {
			setStatus("denied");
			return cleanup;
		}
		if (!storageKey) {
			setStatus("unverified");
			return cleanup;
		}
		try {
			const saved = localStorage.getItem(storageKey);
			if (saved !== null && !validHandle(saved)) throw new Error("retention");
			handle.current = saved;
		} catch {
			setStatus("unverified");
			setError("Device settings could not be read in this browser.");
			return cleanup;
		}
		void readState();
		return cleanup;
		// Account identity owns this lifecycle. Callback identities must not restart it.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [userId]);

	async function requestConsent() {
		const operation = begin();
		if (!operation) return;
		try {
			// Consent consumes transient activation: call directly in this click,
			// before any asynchronous preflight, and never enroll after its result.
			const result =
				Notification.permission === "default"
					? await operation.wait(Notification.requestPermission())
					: Notification.permission;
			if (!operation.active()) return;
			setPermission(result);
			if (result === "denied") setStatus("denied");
			else if (result === "default")
				setError("Permission was not granted. Choose Allow notifications to try again.");
		} catch {
			if (operation.active()) setError("Notification permission could not be verified. Try again.");
		} finally {
			finish(operation);
		}
	}
	function admitPermission(reconnect: boolean) {
		const actual = Notification.permission;
		setPermission(actual);
		if (actual === "granted") return true;
		setReconnectPrepared(reconnect);
		if (actual === "denied") setStatus("denied");
		return false;
	}
	async function enable(reconnect = reconnectPrepared) {
		const operation = begin();
		if (!operation) return;
		let dispatched = false;
		try {
			const observation = await observe(operation, reconnect);
			apply(observation);
			if (!admitPermission(reconnect)) return;
			const { publicKey } = await operation.wait(notificationsApi.getVapidPublicKey());
			if (!admitPermission(reconnect)) return;
			const subscription =
				observation.subscription ??
				(await operation.wait(
					observation.registration.pushManager.subscribe({
						userVisibleOnly: true,
						applicationServerKey: urlBase64ToUint8Array(publicKey),
					}),
				));
			if (!admitPermission(reconnect)) return;
			const json = subscription.toJSON();
			if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("unverified");
			const selected = observation.server;
			if (selected?.channelId)
				enableRecovery.current = { channelId: selected.channelId, endpoint: subscription.endpoint };
			dispatched = true;
			const confirmed = await operation.wait(
				notificationsApi.enablePushSubscription({
					endpoint: json.endpoint,
					keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
					...(selected?.channelId && selected.configRevision
						? { channelId: selected.channelId, expectedRevision: selected.configRevision }
						: {}),
				}),
			);
			apply({ ...observation, subscription, server: confirmed, bound: true });
			enableRecovery.current = null;
			setReconnectPrepared(false);
			invalidate();
			try {
				retain(confirmed.channelId!);
			} catch {
				setError(
					"Device delivery is enabled, but its settings could not be retained in this browser. Keep the browser subscription until storage is available.",
				);
			}
			setRemovalEndpoint(null);
		} catch {
			// Query ownership outlives the card; a dispatched write can settle after navigation.
			if (
				dispatched &&
				queryClient.getQueryData<CurrentUser | null>(authKeys.currentUser)?.id === userId
			)
				invalidate();
			if (operation.active()) {
				if (dispatched) {
					unverifiedWrite.current = true;
				}
				setStatus("unverified");
				setError(unverifiedMessage);
			}
		} finally {
			finish(operation);
		}
	}

	async function disable(retryRemoval = false) {
		const operation = begin();
		if (!operation) return;
		let confirmed: BrowserPushState | null = null;
		let dispatched = false;
		try {
			const observation = await observe(operation);
			apply(observation);
			const selected = observation.server;
			if (!selected?.channelId || !selected.configRevision) throw new Error("unverified");
			try {
				retain(selected.channelId);
			} catch {
				setError(retentionMessage);
				return;
			}
			const expectedEndpoint = retryRemoval
				? removalEndpoint
				: (observation.subscription?.endpoint ?? null);
			if (selected.state === "disabled") confirmed = selected;
			else {
				dispatched = true;
				confirmed = await operation.wait(
					notificationsApi.disablePushSubscription({
						...(observation.subscription ? { endpoint: observation.subscription.endpoint } : {}),
						channelId: selected.channelId,
						expectedRevision: selected.configRevision,
					}),
				);
			}
			if (selected.state !== "disabled") invalidate();
			setServer(confirmed);
			setRemovalEndpoint(expectedEndpoint);
			const current = await operation.wait(observation.registration.pushManager.getSubscription());
			if (!current) {
				setStatus("disabled");
				setRemovalEndpoint(null);
				return;
			}
			if (!expectedEndpoint || current.endpoint !== expectedEndpoint) {
				setStatus("delivery-disabled");
				setError(
					"Device delivery is disabled, but the browser subscription changed. Recheck its state before continuing.",
				);
				return;
			}
			await operation.wait(current.unsubscribe());
			const remaining = await operation.wait(
				observation.registration.pushManager.getSubscription(),
			);
			if (remaining) {
				setStatus("delivery-disabled");
				setError(
					"Device delivery is disabled, but the browser subscription remains. Retry browser removal.",
				);
			} else {
				setStatus("disabled");
				setRemovalEndpoint(null);
			}
		} catch {
			if (
				dispatched &&
				!confirmed &&
				queryClient.getQueryData<CurrentUser | null>(authKeys.currentUser)?.id === userId
			)
				invalidate();
			if (operation.active()) {
				if (dispatched && !confirmed) {
					unverifiedWrite.current = true;
				}
				setStatus(confirmed ? "delivery-disabled" : "unverified");
				setError(
					confirmed
						? "Device delivery is disabled. Browser removal could not be verified. Recheck before retrying."
						: unverifiedMessage,
				);
			}
		} finally {
			finish(operation);
		}
	}

	if (status === "unsupported") return null;
	const canDisable = status === "enabled" || status === "browser-missing";
	const canEnable =
		status === "disabled" ||
		status === "absent" ||
		status === "browser-only" ||
		status === "delivery-disabled";
	const canRequestConsent = permission === "default" && (canEnable || reconnectPrepared);
	return (
		<div className="rounded-xl border border-border/30 bg-muted/10 p-4">
			<div className="flex items-center gap-4">
				<div
					className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
					style={{ backgroundColor: gradient.fromLight }}
				>
					{status === "enabled" ? (
						<Bell className="h-5 w-5" style={{ color: gradient.from }} />
					) : (
						<BellOff className="h-5 w-5 text-muted-foreground" />
					)}
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="font-medium">Browser Push Notifications</span>
						<DomainStatusBadge
							status={domainStatus(status)}
							label={labels[status]}
							title={
								status === "enabled"
									? "Browser subscription and enabled device registration are confirmed. Delivery also depends on selected events and provider availability."
									: labels[status]
							}
						/>
					</div>
					<p className="text-xs text-muted-foreground mt-0.5">
						{status === "denied"
							? "Permission denied. Update your browser settings to allow notifications."
							: status === "enabled"
								? "Browser subscription and device delivery are enabled."
								: status === "delivery-disabled"
									? "Device delivery is disabled; browser removal is incomplete or unverified."
									: status === "browser-missing"
										? "Device delivery is enabled, but this browser has no subscription."
										: status === "unverified"
											? "Current device state is unverified."
											: canRequestConsent
												? "First allow browser notifications, then choose Enable to register this device."
												: "Enable push notifications to get alerts in this browser."}
					</p>
					{status === "enabled" && server?.subscribedEventCount === 0 ? (
						<p className="text-xs text-muted-foreground mt-1">
							No events are selected for this device. Choose events in the Events tab.
						</p>
					) : null}
					{error ? (
						<p role="status" className="text-xs text-destructive mt-1">
							{error}
						</p>
					) : null}
				</div>
				<div className="flex flex-col gap-1">
					{status === "loading" ? (
						<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
					) : null}
					{canDisable ? (
						<button
							type="button"
							onClick={() => void disable()}
							disabled={pending}
							className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
						>
							Disable
						</button>
					) : null}
					{status === "delivery-disabled" && removalEndpoint ? (
						<button
							type="button"
							onClick={() => void disable(true)}
							disabled={pending}
							className="rounded-lg px-3 py-1.5 text-sm disabled:opacity-50"
						>
							Retry browser removal
						</button>
					) : null}
					{status === "unverified" || (status === "delivery-disabled" && !removalEndpoint) ? (
						<button
							type="button"
							onClick={() => void readState()}
							disabled={pending}
							className="rounded-lg px-3 py-1.5 text-sm disabled:opacity-50"
						>
							Retry
						</button>
					) : null}
					{status === "unverified" && handle.current ? (
						<button
							type="button"
							onClick={() => void enable(true)}
							disabled={pending}
							className="rounded-lg px-3 py-1.5 text-sm disabled:opacity-50"
						>
							Reconnect device
						</button>
					) : null}
					{canRequestConsent ? (
						<button
							type="button"
							onClick={() => void requestConsent()}
							disabled={pending}
							className="rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50"
						>
							Allow notifications
						</button>
					) : null}
					{permission === "granted" && (canEnable || reconnectPrepared) ? (
						<button
							type="button"
							onClick={() => void enable()}
							disabled={pending}
							className="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
							style={{ backgroundColor: gradient.from }}
						>
							{pending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}Enable
						</button>
					) : null}
				</div>
			</div>
		</div>
	);
}
