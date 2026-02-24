/**
 * Notification Service Fastify Plugin
 *
 * Initializes the notification system and decorates app.notificationService.
 * Lazily initializes VAPID keys for browser push on first use.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import webpush from "web-push";
import { createBrowserPushSender } from "../lib/notifications/channels/browser-push-sender.js";
import { NotificationDispatcher } from "../lib/notifications/notification-dispatcher.js";
import { NotificationService } from "../lib/notifications/notification-service.js";

declare module "fastify" {
	interface FastifyInstance {
		notificationService: NotificationService;
	}
}

const notificationServicePlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		const dispatcher = new NotificationDispatcher();

		// Initialize Browser Push sender if VAPID keys exist
		await initBrowserPush(app, dispatcher);

		const service = new NotificationService(app.prisma, app.encryptor, dispatcher, app.log);

		app.decorate("notificationService", service);
		app.log.info("Notification service initialized");
	},
	{
		name: "notification-service",
		dependencies: ["prisma", "security"],
	},
);

/**
 * Initialize VAPID keys for browser push notifications.
 * Generates keys on first use and stores them encrypted in the database.
 */
async function initBrowserPush(
	app: FastifyInstance,
	dispatcher: NotificationDispatcher,
): Promise<void> {
	try {
		let vapidRecord = await app.prisma.vapidKeys.findUnique({ where: { id: 1 } });

		if (!vapidRecord) {
			// Generate new VAPID keys
			const vapidKeys = webpush.generateVAPIDKeys();
			const encrypted = app.encryptor.encrypt(vapidKeys.privateKey);

			vapidRecord = await app.prisma.vapidKeys.create({
				data: {
					id: 1,
					publicKey: vapidKeys.publicKey,
					encryptedPrivateKey: encrypted.value,
					privateKeyIv: encrypted.iv,
				},
			});

			app.log.info("Generated new VAPID keys for browser push notifications");
		}

		// Decrypt private key
		const privateKey = app.encryptor.decrypt({
			value: vapidRecord.encryptedPrivateKey,
			iv: vapidRecord.privateKeyIv,
		});

		const contactEmail = process.env.VAPID_CONTACT_EMAIL ?? "admin@arr-dashboard.local";
		const sender = createBrowserPushSender(vapidRecord.publicKey, privateKey, contactEmail);
		dispatcher.registerSender("BROWSER_PUSH", sender);
	} catch (error) {
		app.log.error(
			{ err: error instanceof Error ? error : new Error(String(error)) },
			"Browser push initialization failed — push notifications will be unavailable",
		);
	}
}

export default notificationServicePlugin;
