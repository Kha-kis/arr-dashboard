import type { BrowserPushConfig } from "@arr/shared";
import webpush from "web-push";
import {
	httpFailureCategory,
	networkFailureCategory,
	notificationFailure,
	NotificationFailureError,
} from "../failure-diagnostics.js";
import type { ChannelSender, NotificationPayload, SendResult } from "../types.js";

function pushStatusCode(err: unknown): number | undefined {
	if (typeof err !== "object" || err === null || !("statusCode" in err)) return undefined;
	return typeof err.statusCode === "number" ? err.statusCode : undefined;
}

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
				const statusCode = pushStatusCode(err);

				// 410 Gone = subscription expired, not retryable
				if (statusCode === 410) {
					return notificationFailure("subscription-expired", false);
				}
				// 429 or 5xx = retryable
				if (statusCode === 429 || (statusCode && statusCode >= 500)) {
					return notificationFailure(httpFailureCategory(statusCode), true);
				}
				// 4xx = not retryable
				if (statusCode && statusCode >= 400 && statusCode < 500) {
					return notificationFailure(httpFailureCategory(statusCode), false);
				}
				// Network/other errors = retryable
				return notificationFailure(networkFailureCategory(err), true);
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

			try {
				await webpush.sendNotification(
					subscription,
					JSON.stringify({
						title: "Test Notification",
						body: "Arr Dashboard browser push is working!",
					}),
					{ TTL: 300 },
				);
			} catch (err) {
				const statusCode = pushStatusCode(err);
				throw new NotificationFailureError(
					statusCode === 410
						? "subscription-expired"
						: statusCode && statusCode >= 400
							? httpFailureCategory(statusCode)
							: networkFailureCategory(err),
				);
			}
		},
	};
}
