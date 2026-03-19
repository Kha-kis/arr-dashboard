/**
 * Notification Service Fastify Plugin
 *
 * Initializes the notification system and decorates app.notificationService.
 * Lazily initializes VAPID keys for browser push on first use.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import webpush from "web-push";
import { AggregationBuffer } from "../lib/notifications/aggregation-buffer.js";
import { createBrowserPushSender } from "../lib/notifications/channels/browser-push-sender.js";
import { closeAllTransports } from "../lib/notifications/channels/email-sender.js";
import { DedupGate } from "../lib/notifications/dedup-gate.js";
import { NotificationDispatcher } from "../lib/notifications/notification-dispatcher.js";
import { NotificationService } from "../lib/notifications/notification-service.js";
import { RetryHandler } from "../lib/notifications/retry-handler.js";
import { purgeOldLogsBatched } from "../lib/notifications/log-retention.js";
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

		const dedupGate = new DedupGate();

		// Create the service first (needed for logDelivery reference)
		// We'll set retryHandler after construction via a temporary holder
		const sendFn = dispatcher.send.bind(dispatcher);

		// Build the service with retry handler wired to the dispatcher and service's logDelivery
		let service: NotificationService;

		const retryHandler = new RetryHandler(
			sendFn,
			(channelId, channelType, payload, status, error, retryCount) => {
				return service.logDelivery(channelId, channelType, payload, status, error, retryCount);
			},
			app.log,
		);

		const ruleEngine = new RuleEngine();

		const aggregationBuffer = new AggregationBuffer(async (digest) => {
			// When a digest flushes, feed it back through the service's notify()
			await service.notify(digest);
		});

		service = new NotificationService(
			app.prisma,
			app.encryptor,
			dispatcher,
			app.log,
			dedupGate,
			retryHandler,
			ruleEngine,
			aggregationBuffer,
		);

		app.decorate("notificationService", service);

		// Wire validation health degradation notifications
		const { integrationHealth } = await import("../lib/validation/integration-health.js");
		integrationHealth.setNotifyFn((payload) => {
			service
				.notify(payload as Parameters<typeof service.notify>[0])
				.catch((err: unknown) =>
					app.log.warn({ err }, "Failed to send validation health notification"),
				);
		});

		// Log retention: purge old logs every 6 hours
		const LOG_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
		let logRetentionInterval: ReturnType<typeof setInterval> | null = null;

		const runLogRetention = async () => {
			try {
				const settings = await app.prisma.systemSettings.findUnique({ where: { id: 1 } });
				const retentionDays = settings?.notificationLogRetentionDays ?? 90;
				const deleted = await purgeOldLogsBatched(app.prisma, retentionDays);
				if (deleted > 0) {
					app.log.info({ deleted, retentionDays }, "Purged old notification logs");
				}
			} catch (error) {
				app.log.error({ err: error }, "Failed to purge old notification logs");
			}
		};

		app.addHook("onReady", async () => {
			await runLogRetention();
			logRetentionInterval = setInterval(runLogRetention, LOG_RETENTION_INTERVAL_MS);
		});

		// Graceful shutdown: flush pending retries, destroy dedup gate, flush aggregation, close email transports
		app.addHook("onClose", async () => {
			if (logRetentionInterval) {
				clearInterval(logRetentionInterval);
				logRetentionInterval = null;
			}
			aggregationBuffer.flushAll();
			retryHandler.flush();
			dedupGate.destroy();
			closeAllTransports();
			app.log.info(
				{
					pendingRetries: retryHandler.pendingCount,
					pendingAggregation: aggregationBuffer.pendingCount,
				},
				"Notification service shut down",
			);
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
	} catch (error) {
		app.log.error(
			{ err: error instanceof Error ? error : new Error(String(error)) },
			"Browser push initialization failed — push notifications will be unavailable",
		);
	}
}

export default notificationServicePlugin;
