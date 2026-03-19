import type { BrowserPushConfig } from "@arr/shared";
import webpush from "web-push";
import type { ChannelSender, NotificationPayload, SendResult } from "../types.js";

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
		async send(config: Record<string, unknown>, payload: NotificationPayload): Promise<SendResult> {
			const pushConfig = config as BrowserPushConfig;

			const subscription: webpush.PushSubscription = {
				endpoint: pushConfig.endpoint,
				keys: {
					p256dh: pushConfig.p256dh,
					auth: pushConfig.auth,
				},
			};

			try {
				await webpush.sendNotification(
					subscription,
					JSON.stringify({
						title: payload.title,
						body: payload.body,
						url: payload.url,
						eventType: payload.eventType,
						metadata: payload.metadata,
					}),
					{ TTL: 86400 }, // 24 hours
				);
				return { success: true, retryable: false };
			} catch (err) {
				const statusCode = (err as { statusCode?: number }).statusCode;
				const error = err instanceof Error ? err.message : String(err);

				// 410 Gone = subscription expired, not retryable
				if (statusCode === 410) {
					return {
						success: false,
						retryable: false,
						error: `Browser push subscription expired (410 Gone): ${error}`,
					};
				}
				// 429 or 5xx = retryable
				if (statusCode === 429 || (statusCode && statusCode >= 500)) {
					return {
						success: false,
						retryable: true,
						error: `Browser push failed (${statusCode}): ${error}`,
					};
				}
				// 4xx = not retryable
				if (statusCode && statusCode >= 400 && statusCode < 500) {
					return {
						success: false,
						retryable: false,
						error: `Browser push failed (${statusCode}): ${error}`,
					};
				}
				// Network/other errors = retryable
				return { success: false, retryable: true, error: `Browser push error: ${error}` };
			}
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
