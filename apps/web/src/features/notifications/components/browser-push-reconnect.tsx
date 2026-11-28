"use client";

import type { BrowserPushState, CurrentUser } from "@arr/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useCurrentUser } from "@/hooks/api/useAuth";
import { notificationsApi } from "../../../lib/api-client/notifications";
import { useIncognitoMode } from "../../../lib/incognito";
import { authKeys, notificationKeys } from "../../../lib/query-keys";

type Operation = { active: () => boolean; wait: <T>(promise: PromiseLike<T>) => Promise<T> };
type NativeBinding = {
	worker: ServiceWorkerContainer;
	notification: typeof Notification;
	endpoint: string;
};
const warning =
	"Reconnect replaces this channel’s former browser destination with this browser. Event subscriptions, rules, history and the enabled setting are retained. This does not recover old keys or guarantee notification delivery.";
const unknown =
	"Reconnect outcome could not be verified. The change may have been saved. Recheck current binding before another reconnect.";

/** This editor never reads or replaces the global browser card's retained handle. */
export function BrowserPushReconnect({
	channelId,
	onSaved,
	onSave,
}: {
	channelId: string;
	onSaved?: (channelId: string | null) => void;
	onSave: () => void;
}) {
	const client = useQueryClient();
	const { data: user } = useCurrentUser(false);
	const userId = user?.id;
	const [incognito] = useIncognitoMode();
	const privacy = useRef(incognito);
	privacy.current = incognito;
	const mounted = useRef(true);
	const generation = useRef(0);
	const running = useRef(false);
	const [prepared, setPrepared] = useState(false);
	const [pending, setPending] = useState(false);
	const [needsRead, setNeedsRead] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [permission, setPermission] = useState<NotificationPermission | null>(null);
	const scope = JSON.stringify([userId, channelId]);
	const [viewScope, setViewScope] = useState(scope);
	// Dispatch uncertainty outlives cancelled UI intent, but never crosses an owner/channel.
	const dispatchedBindings = useRef(new Map<string, NativeBinding>());
	const captured = useRef<NativeBinding | null>(null);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Account and privacy changes must invalidate in-flight selected intent.
	useEffect(() => {
		generation.current++;
		running.current = false;
		setPending(false);
		setPrepared(false);
		const retained = dispatchedBindings.current.get(scope);
		setViewScope(scope);
		setMessage(retained ? unknown : null);
		setNeedsRead(!!retained);
		captured.current = retained ?? null;
	}, [scope, incognito]);

	function invalidate() {
		void client.invalidateQueries({ queryKey: notificationKeys.channels });
		void client.invalidateQueries({ queryKey: notificationKeys.subscriptions });
	}
	function begin(): Operation | null {
		if (
			running.current ||
			!userId ||
			privacy.current ||
			!mounted.current ||
			client.getQueryData<CurrentUser | null>(authKeys.currentUser)?.id !== userId
		)
			return null;
		running.current = true;
		const token = ++generation.current;
		setPending(true);
		setMessage(null);
		const active = () =>
			mounted.current &&
			!privacy.current &&
			generation.current === token &&
			client.getQueryData<CurrentUser | null>(authKeys.currentUser)?.id === userId;
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
	function prepare() {
		if (
			incognito ||
			!userId ||
			running.current ||
			dispatchedBindings.current.has(scope) ||
			client.getQueryData<CurrentUser | null>(authKeys.currentUser)?.id !== userId
		)
			return;
		setPrepared(true);
		refreshAvailability();
	}
	function cancel() {
		generation.current++;
		running.current = false;
		setPending(false);
		setPrepared(false);
		const retained = dispatchedBindings.current.get(scope);
		setNeedsRead(!!retained);
		setMessage(retained ? unknown : null);
	}
	function allow() {
		if (!capabilitiesAvailable() || Notification.permission !== "default") {
			refreshAvailability();
			return;
		}
		const operation = begin();
		if (!operation) return;
		try {
			// Invoke directly in the click; resolving consent never starts enrollment.
			const consent = Notification.requestPermission();
			void operation
				.wait(consent)
				.then(() => {
					if (operation.active()) refreshAvailability();
				})
				.catch(() => {
					if (operation.active()) setMessage("Browser permission could not be verified.");
				})
				.finally(() => finish(operation));
		} catch {
			if (operation.active()) setMessage("Browser permission could not be verified.");
			finish(operation);
		}
	}
	function capabilitiesAvailable() {
		return (
			typeof Notification !== "undefined" &&
			typeof Notification.requestPermission === "function" &&
			typeof navigator !== "undefined" &&
			typeof navigator.serviceWorker?.register === "function" &&
			typeof navigator.serviceWorker?.ready?.then === "function" &&
			typeof window.PushManager !== "undefined"
		);
	}
	function browserAvailable() {
		return capabilitiesAvailable() && Notification.permission === "granted";
	}
	function refreshAvailability() {
		const supported = capabilitiesAvailable();
		const current = supported ? Notification.permission : null;
		setPermission(current);
		setMessage(
			!supported
				? "Push notifications are unsupported in this browser."
				: current === "denied"
					? "Push notifications are blocked. Review browser permission settings."
					: null,
		);
		return current === "granted";
	}
	async function assertNative(
		operation: Operation,
		registration: ServiceWorkerRegistration,
		endpoint: string,
		worker: ServiceWorkerContainer,
		notification: typeof Notification,
	) {
		const actual = await operation.wait(registration.pushManager.getSubscription());
		if (
			!actual ||
			actual.endpoint !== endpoint ||
			navigator.serviceWorker !== worker ||
			Notification !== notification ||
			!browserAvailable()
		)
			throw new Error("unverified");
	}
	function verified(operation: Operation, server: BrowserPushState) {
		if (!operation.active() || server.channelId !== channelId) throw new Error("unverified");
		dispatchedBindings.current.delete(scope);
		captured.current = null;
		setNeedsRead(false);
		invalidate();
		onSaved?.(channelId);
		onSave();
	}
	async function reconnect() {
		if (needsRead || dispatchedBindings.current.has(scope) || !prepared) return;
		if (!refreshAvailability()) return;
		const operation = begin();
		if (!operation) return;
		let dispatched = false;
		try {
			const worker = navigator.serviceWorker,
				notification = Notification;
			const current = await operation.wait(notificationsApi.getChannelEditState(channelId));
			if (current.type !== "BROWSER_PUSH") throw new Error("unverified");
			await operation.wait(worker.register("/sw.js"));
			const registration = await operation.wait(worker.ready);
			let subscription = await operation.wait(registration.pushManager.getSubscription());
			if (!subscription) {
				const vapid = await operation.wait(notificationsApi.getVapidPublicKey());
				if (!vapid || typeof vapid.publicKey !== "string" || !vapid.publicKey)
					throw new Error("unverified");
				const padded = vapid.publicKey + "=".repeat((4 - (vapid.publicKey.length % 4)) % 4);
				const raw = window.atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
				if (
					!operation.active() ||
					navigator.serviceWorker !== worker ||
					Notification !== notification ||
					!browserAvailable()
				)
					throw new Error("unverified");
				subscription = await operation.wait(
					registration.pushManager.subscribe({
						userVisibleOnly: true,
						applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)),
					}),
				);
			}
			const config = subscription.toJSON();
			const endpoint = subscription.endpoint;
			if (
				config.endpoint !== endpoint ||
				typeof config.keys?.p256dh !== "string" ||
				typeof config.keys.auth !== "string"
			)
				throw new Error("unverified");
			await assertNative(operation, registration, endpoint, worker, notification);
			captured.current = { worker, notification, endpoint };
			dispatchedBindings.current.set(scope, captured.current);
			dispatched = true;
			const acknowledged = await operation.wait(
				notificationsApi.reconnectPushSubscription({
					channelId,
					expectedRevision: current.configRevision,
					endpoint,
					keys: { p256dh: config.keys.p256dh, auth: config.keys.auth },
				}),
			);
			if (acknowledged.state !== (current.enabled ? "enabled" : "disabled"))
				throw new Error("unverified");
			await assertNative(operation, registration, endpoint, worker, notification);
			const server = await operation.wait(notificationsApi.readPushState({ channelId, endpoint }));
			if (
				server.configRevision !== acknowledged.configRevision ||
				server.state !== acknowledged.state
			)
				throw new Error("unverified");
			await assertNative(operation, registration, endpoint, worker, notification);
			verified(operation, server);
		} catch {
			if (
				dispatched &&
				client.getQueryData<CurrentUser | null>(authKeys.currentUser)?.id === userId
			)
				invalidate();
			if (operation.active()) {
				setNeedsRead(true);
				setMessage(
					dispatched
						? unknown
						: "Reconnect could not be prepared. Recheck current binding before trying again.",
				);
			}
		} finally {
			finish(operation);
		}
	}
	async function recheck() {
		const operation = begin();
		if (!operation) return;
		try {
			const current = await operation.wait(notificationsApi.getChannelEditState(channelId));
			if (current.type !== "BROWSER_PUSH") throw new Error("unverified");
			if (current.state === "repair-required") {
				dispatchedBindings.current.delete(scope);
				captured.current = null;
				setNeedsRead(false);
				setPrepared(false);
				setMessage(
					"Current channel still requires repair. A new explicit reconnect can be prepared.",
				);
				return;
			}
			if (!browserAvailable()) throw new Error("unverified");
			const worker = navigator.serviceWorker,
				notification = Notification;
			const registration = await operation.wait(worker.ready);
			const subscription = await operation.wait(registration.pushManager.getSubscription());
			const retained = captured.current;
			if (
				!subscription ||
				(retained &&
					(retained.worker !== worker ||
						retained.notification !== notification ||
						retained.endpoint !== subscription.endpoint))
			)
				throw new Error("unverified");
			const server = await operation.wait(
				notificationsApi.readPushState({ channelId, endpoint: subscription.endpoint }),
			);
			if (
				server.state !== (current.enabled ? "enabled" : "disabled") ||
				server.configRevision !== current.configRevision
			)
				throw new Error("unverified");
			await assertNative(operation, registration, subscription.endpoint, worker, notification);
			verified(operation, server);
		} catch {
			if (operation.active()) setMessage(unknown);
		} finally {
			finish(operation);
		}
	}
	const visible =
		viewScope === scope &&
		client.getQueryData<CurrentUser | null>(authKeys.currentUser)?.id === userId;
	return (
		<div className="space-y-3 text-sm">
			{visible && message ? <p role="status">{message}</p> : null}
			{visible && needsRead ? (
				<button
					type="button"
					disabled={pending || incognito || !userId}
					onClick={() => void recheck()}
					className="underline disabled:opacity-50"
				>
					Recheck current binding
				</button>
			) : visible && prepared ? (
				<>
					<p>{warning}</p>
					{permission === "default" ? (
						<button
							type="button"
							disabled={pending || incognito}
							onClick={allow}
							className="underline disabled:opacity-50"
						>
							Allow notifications
						</button>
					) : permission === "granted" ? (
						<button
							type="button"
							disabled={pending || incognito}
							onClick={() => void reconnect()}
							className="underline disabled:opacity-50"
						>
							Confirm reconnect
						</button>
					) : !message ? (
						<p>
							Browser notifications are blocked or unsupported. Review browser permission settings.
						</p>
					) : null}
					<button type="button" onClick={cancel} className="ml-3 underline">
						Cancel reconnect
					</button>
				</>
			) : (
				<button
					type="button"
					disabled={incognito || pending || !userId || !visible}
					onClick={prepare}
					className="underline disabled:opacity-50"
				>
					Reconnect this channel to this browser
				</button>
			)}
		</div>
	);
}
