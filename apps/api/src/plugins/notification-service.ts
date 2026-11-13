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
import { closeAllTransports } from "../lib/notifications/channels/email-sender.js";
import { purgeOldLogsBatched } from "../lib/notifications/log-retention.js";
import { NotificationDispatcher } from "../lib/notifications/notification-dispatcher.js";
import { NotificationService } from "../lib/notifications/notification-service.js";
import { RuleEngine } from "../lib/notifications/rule-engine.js";

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

		const ruleEngine = new RuleEngine();

		// Resolve the public-facing base URL for notification links.
		// Prefer admin-configured externalUrl so links resolve behind reverse proxies;
		// fall back to APP_URL env var (defaults to http://localhost:3000).
		const settings = await app.prisma.systemSettings.findUnique({ where: { id: 1 } });
		const baseUrl = settings?.externalUrl?.replace(/\/$/, "") ?? app.config.APP_URL;

		const service = new NotificationService(
			app.prisma,
			app.encryptor,
			dispatcher,
			app.log,
			undefined,
			undefined,
			baseUrl,
			ruleEngine,
			undefined,
			{ runtime: app.restoreRuntime },
		);

		app.decorate("notificationService", service);

		// Wire validation health degradation notifications
		const { integrationHealth } = await import("../lib/validation/integration-health.js");
		integrationHealth.setNotifyFn((payload) => {
			return service
				.runProducer(() =>
					app.restoreRuntime.runIndependentOperation(() =>
						service.notify(payload as Parameters<typeof service.notify>[0]),
					),
				)
				.catch((err: unknown) => {
					app.log.warn(
						{ operation: "notification-admission", status: "unavailable" },
						"Failed to submit validation health notification",
					);
					// The registry consumes rejection and retains bounded retry admission.
					throw err;
				});
		});

		// Log retention: purge old logs every 6 hours
		const LOG_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
		let logRetentionInterval: ReturnType<typeof setInterval> | null = null;
		let retentionAdmissionClosed = false;
		const pendingRetentions = new Set<Promise<void>>();

		const closeRetentionAdmission = () => {
			retentionAdmissionClosed = true;
			if (logRetentionInterval) {
				clearInterval(logRetentionInterval);
				logRetentionInterval = null;
			}
		};

		const runLogRetention = async () => {
			if (retentionAdmissionClosed) return;
			// Register before the first query; clearing a timer cannot cancel accepted work.
			let settle!: () => void;
			const completion = new Promise<void>((resolve) => {
				settle = resolve;
			});
			pendingRetentions.add(completion);
			try {
				await app.restoreRuntime.runIndependentOperation(async () => {
					const settings = await app.prisma.systemSettings.findUnique({ where: { id: 1 } });
					const retentionDays = settings?.notificationLogRetentionDays ?? 90;
					const deleted = await purgeOldLogsBatched(app.prisma, retentionDays);
					if (deleted > 0) {
						app.log.info({ deleted, retentionDays }, "Purged old notification logs");
					}
				});
			} catch {
				app.log.error(
					{ operation: "notification-log-retention", status: "unavailable" },
					"Failed to purge old notification logs",
				);
			} finally {
				pendingRetentions.delete(completion);
				settle();
			}
		};

		app.addHook("onReady", async () => {
			await runLogRetention();
			if (!retentionAdmissionClosed) {
				logRetentionInterval = setInterval(runLogRetention, LOG_RETENTION_INTERVAL_MS);
			}
		});

		app.addHook("preClose", async () => {
			// Close admission without delaying sibling plugins' preClose hooks.
			closeRetentionAdmission();
			service.closeAdmission();
		});

		// Join actual producers/sends; durable future work is not forced or canceled.
		app.addHook("onClose", async () => {
			closeRetentionAdmission();
			service.closeAdmission();
			while (pendingRetentions.size > 0) {
				await Promise.all(pendingRetentions);
			}
			await service.shutdown();
			closeAllTransports();
			app.log.info("Notification workers shut down; queued work remains durable");
		});

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
	} catch {
		app.log.error(
			{ operation: "browser-push-initialization", status: "unavailable" },
			"Browser push initialization failed — push notifications will be unavailable",
		);
	}
}

export default notificationServicePlugin;
