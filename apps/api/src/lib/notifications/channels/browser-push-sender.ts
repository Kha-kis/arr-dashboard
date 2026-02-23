import type { BrowserPushConfig } from "@arr/shared";
import webpush from "web-push";
import type { ChannelSender, NotificationPayload } from "../types.js";

/**
 * Browser Push sender using the Web Push protocol (VAPID).
 * Requires VAPID keys to be configured (generated at first use).
 */
export function createBrowserPushSender(
	vapidPublicKey: string,
	vapidPrivateKey: string,
	contactEmail: string,
): ChannelSender {
	webpush.setVapidDetails(`mailto:${contactEmail}`, vapidPublicKey, vapidPrivateKey);

	return {
		async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<void> {
			const pushConfig = config as BrowserPushConfig;

			const subscription: webpush.PushSubscription = {
				endpoint: pushConfig.endpoint,
				keys: {
					p256dh: pushConfig.p256dh,
					auth: pushConfig.auth,
				},
			};

			await webpush.sendNotification(
				subscription,
				JSON.stringify({
					title: payload.title,
					body: payload.body,
					url: payload.url,
					eventType: payload.eventType,
				}),
				{ TTL: 86400 }, // 24 hours
			);
		},

		async test(config: Record<string, unknown>): Promise<void> {
			const pushConfig = config as BrowserPushConfig;

			const subscription: webpush.PushSubscription = {
				endpoint: pushConfig.endpoint,
				keys: {
					p256dh: pushConfig.p256dh,
					auth: pushConfig.auth,
				},
			};

			await webpush.sendNotification(
				subscription,
				JSON.stringify({
					title: "Test Notification",
					body: "Arr Dashboard browser push is working!",
				}),
				{ TTL: 300 },
			);
		},
	};
}
