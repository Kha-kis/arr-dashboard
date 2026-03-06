"use client";

import { Bell, BellOff, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { GlassmorphicCard, StatusBadge } from "@/components/layout/premium-components";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { notificationsApi } from "../../../lib/api-client/notifications";

type PushState = "loading" | "unsupported" | "denied" | "enabled" | "disabled" | "error";

/**
 * Convert a base64 URL-safe string to a Uint8Array for the applicationServerKey.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
	const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
	const rawData = window.atob(base64);
	const outputArray = new Uint8Array(rawData.length) as Uint8Array<ArrayBuffer>;
	for (let i = 0; i < rawData.length; ++i) {
		outputArray[i] = rawData.charCodeAt(i);
	}
	return outputArray;
}

export function BrowserPushCard() {
	const { gradient } = useThemeGradient();
	const [state, setState] = useState<PushState>("loading");
	const [error, setError] = useState<string | null>(null);
	const [isSubscribing, setIsSubscribing] = useState(false);

	useEffect(() => {
		checkPushState();
	}, []);

	async function checkPushState() {
		if (!("Notification" in window) || !("serviceWorker" in navigator)) {
			setState("unsupported");
			return;
		}

		if (Notification.permission === "denied") {
			setState("denied");
			return;
		}

		try {
			// Ensure the service worker is registered (idempotent if already registered)
			await navigator.serviceWorker.register("/sw.js");
			const registration = await navigator.serviceWorker.ready;
			const subscription = await registration.pushManager.getSubscription();
			setState(subscription ? "enabled" : "disabled");
		} catch {
			setState("disabled");
		}
	}

	const handleEnable = useCallback(async () => {
		setIsSubscribing(true);
		setError(null);
		try {
			// Request notification permission
			const permission = await Notification.requestPermission();
			if (permission !== "granted") {
				setState("denied");
				return;
			}

			// Get VAPID key
			const { publicKey } = await notificationsApi.getVapidPublicKey();

			// Register service worker if not already
			const registration = await navigator.serviceWorker.ready;

			// Subscribe
			const subscription = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(publicKey),
			});

			// Send to backend
			const json = subscription.toJSON();
			await notificationsApi.registerPushSubscription({
				endpoint: json.endpoint!,
				keys: {
					p256dh: json.keys!["p256dh"]!,
					auth: json.keys!["auth"]!,
				},
			});

			setState("enabled");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to enable push notifications");
			setState("error");
		} finally {
			setIsSubscribing(false);
		}
	}, []);

	const handleDisable = useCallback(async () => {
		try {
			const registration = await navigator.serviceWorker.ready;
			const subscription = await registration.pushManager.getSubscription();
			if (subscription) {
				await subscription.unsubscribe();
			}
			setState("disabled");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to disable push notifications");
		}
	}, []);

	// Don't render at all if not supported
	if (state === "unsupported") return null;

	return (
		<GlassmorphicCard padding="md">
			<div className="flex items-center gap-4">
				<div
					className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
					style={{ backgroundColor: gradient.fromLight }}
				>
					{state === "enabled" ? (
						<Bell className="h-5 w-5" style={{ color: gradient.from }} />
					) : (
						<BellOff className="h-5 w-5 text-muted-foreground" />
					)}
				</div>

				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="font-medium">Browser Push Notifications</span>
						<StatusBadge
							status={
								state === "enabled" ? "success" : state === "denied" ? "error" : "info"
							}
						>
							{state === "enabled"
								? "Active"
								: state === "denied"
									? "Blocked"
									: state === "loading"
										? "Checking..."
										: "Inactive"}
						</StatusBadge>
					</div>
					<p className="text-xs text-muted-foreground mt-0.5">
						{state === "denied"
							? "Permission denied. Update your browser settings to allow notifications."
							: state === "enabled"
								? "You'll receive push notifications in this browser."
								: "Enable push notifications to get alerts in this browser."}
					</p>
					{error && <p className="text-xs text-red-400 mt-1">{error}</p>}
				</div>

				<div>
					{state === "loading" ? (
						<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
					) : state === "enabled" ? (
						<button
							type="button"
							onClick={handleDisable}
							className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-card/50 transition-colors"
						>
							Disable
						</button>
					) : state !== "denied" ? (
						<button
							type="button"
							onClick={handleEnable}
							disabled={isSubscribing}
							className="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors disabled:opacity-50"
							style={{ backgroundColor: gradient.from }}
						>
							{isSubscribing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
							Enable
						</button>
					) : null}
				</div>
			</div>
		</GlassmorphicCard>
	);
}
