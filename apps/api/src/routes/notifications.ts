import {
	channelConfigSchemaMap,
	createNotificationChannelSchema,
	type NotificationChannelType,
	type NotificationEventType,
	pushSubscriptionSchema,
	updateNotificationChannelSchema,
	updateSubscriptionsSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { getErrorMessage } from "../lib/utils/error-message.js";
import { validateRequest } from "../lib/utils/validate.js";

const idParamsSchema = z.object({ id: z.string().min(1) });
const logsQuerySchema = z.object({
	page: z.coerce.number().int().min(1).optional().default(1),
	limit: z.coerce.number().int().min(1).max(100).optional().default(50),
	channelId: z.string().optional(),
});

export const registerNotificationRoutes: FastifyPluginCallback = (app, _opts, done) => {
	// ── Channels CRUD ──────────────────────────────────────────────────

	/** GET /api/notifications/channels — List all channels for current user */
	app.get("/channels", async (request, reply) => {
		const userId = request.currentUser!.id;
		const channels = await app.prisma.notificationChannel.findMany({
			where: { userId },
			include: { subscriptions: true },
			orderBy: { createdAt: "asc" },
		});

		return reply.send(
			channels.map((ch) => ({
				id: ch.id,
				name: ch.name,
				type: ch.type,
				enabled: ch.enabled,
				lastTestedAt: ch.lastTestedAt?.toISOString() ?? null,
				lastTestResult: ch.lastTestResult,
				createdAt: ch.createdAt.toISOString(),
				updatedAt: ch.updatedAt.toISOString(),
				subscriptions: ch.subscriptions.map((s) => s.eventType),
			})),
		);
	});

	/** POST /api/notifications/channels — Create a channel */
	app.post("/channels", async (request, reply) => {
		const userId = request.currentUser!.id;
		const body = validateRequest(createNotificationChannelSchema, request.body);

		// Validate config for the specific channel type
		const configSchema = channelConfigSchemaMap[body.type];
		const validatedConfig = validateRequest(configSchema as z.ZodType, body.config);

		// Encrypt config
		const encrypted = app.encryptor.encrypt(JSON.stringify(validatedConfig));

		const channel = await app.prisma.notificationChannel.create({
			data: {
				userId,
				name: body.name,
				type: body.type,
				enabled: body.enabled,
				encryptedConfig: encrypted.value,
				configIv: encrypted.iv,
			},
		});

		return reply.status(201).send({
			id: channel.id,
			name: channel.name,
			type: channel.type,
			enabled: channel.enabled,
			lastTestedAt: null,
			lastTestResult: null,
			createdAt: channel.createdAt.toISOString(),
			updatedAt: channel.updatedAt.toISOString(),
			subscriptions: [],
		});
	});

	/** PUT /api/notifications/channels/:id — Update a channel */
	app.put("/channels/:id", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(idParamsSchema, request.params);
		const body = validateRequest(updateNotificationChannelSchema, request.body);

		const existing = await app.prisma.notificationChannel.findFirst({
			where: { id, userId },
		});
		if (!existing) {
			return reply.status(404).send({ error: "Channel not found" });
		}

		const updateData: Record<string, unknown> = {};
		if (body.name !== undefined) updateData.name = body.name;
		if (body.enabled !== undefined) updateData.enabled = body.enabled;

		if (body.config) {
			// Merge redacted placeholder fields with existing decrypted config
			const REDACTED = "••••••••";
			let mergedConfig = body.config;
			const hasRedacted = Object.values(body.config).some((v) => v === REDACTED);
			if (hasRedacted) {
				const existingJson = app.encryptor.decrypt({
					value: existing.encryptedConfig,
					iv: existing.configIv,
				});
				const existingConfig = JSON.parse(existingJson) as Record<string, unknown>;
				mergedConfig = Object.fromEntries(
					Object.entries(body.config).map(([k, v]) => [k, v === REDACTED ? existingConfig[k] : v]),
				);
			}

			// Validate and re-encrypt config
			const configSchema = channelConfigSchemaMap[existing.type as NotificationChannelType];
			const validatedConfig = validateRequest(configSchema as z.ZodType, mergedConfig);
			const encrypted = app.encryptor.encrypt(JSON.stringify(validatedConfig));
			updateData.encryptedConfig = encrypted.value;
			updateData.configIv = encrypted.iv;
		}

		const updated = await app.prisma.notificationChannel.update({
			where: { id },
			data: updateData,
			include: { subscriptions: true },
		});

		return reply.send({
			id: updated.id,
			name: updated.name,
			type: updated.type,
			enabled: updated.enabled,
			lastTestedAt: updated.lastTestedAt?.toISOString() ?? null,
			lastTestResult: updated.lastTestResult,
			createdAt: updated.createdAt.toISOString(),
			updatedAt: updated.updatedAt.toISOString(),
			subscriptions: updated.subscriptions.map((s) => s.eventType),
		});
	});

	/** DELETE /api/notifications/channels/:id — Delete a channel */
	app.delete("/channels/:id", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(idParamsSchema, request.params);

		const existing = await app.prisma.notificationChannel.findFirst({
			where: { id, userId },
		});
		if (!existing) {
			return reply.status(404).send({ error: "Channel not found" });
		}

		await app.prisma.notificationChannel.delete({ where: { id } });
		return reply.status(204).send();
	});

	/** POST /api/notifications/channels/:id/test — Test channel delivery */
	app.post(
		"/channels/:id/test",
		{ config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = validateRequest(idParamsSchema, request.params);

			try {
				await app.notificationService.testChannel(id, userId);
				return reply.send({ success: true });
			} catch (error) {
				// Update test result even on failure
				await app.prisma.notificationChannel
					.updateMany({
						where: { id, userId },
						data: {
							lastTestedAt: new Date(),
							lastTestResult: `failed: ${getErrorMessage(error).replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "<redacted>").slice(0, 200)}`,
						},
					})
					.catch((err) => {
						request.log.debug({ err }, "Failed to update notification test result in database");
					});

				return reply.status(400).send({
					error: "Test failed",
					message: getErrorMessage(error),
				});
			}
		},
	);

	/** GET /api/notifications/channels/:id/config — Get decrypted config (for edit form) */
	app.get("/channels/:id/config", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(idParamsSchema, request.params);

		try {
			const config = await app.notificationService.getDecryptedConfig(id, userId);
			return reply.send(config);
		} catch (error) {
			const msg = getErrorMessage(error);
			if (msg === "Channel not found") {
				return reply.status(404).send({ error: "Channel not found" });
			}
			// Config corruption or decryption failure — surface the details
			request.log.error({ err: error, channelId: id }, "Failed to decrypt channel config");
			return reply.status(500).send({ error: "Failed to read channel config", message: msg });
		}
	});

	// ── Subscriptions ──────────────────────────────────────────────────

	/** GET /api/notifications/subscriptions — Get subscription grid */
	app.get("/subscriptions", async (request, reply) => {
		const userId = request.currentUser!.id;

		const channels = await app.prisma.notificationChannel.findMany({
			where: { userId },
			select: { id: true, name: true, type: true },
			orderBy: { createdAt: "asc" },
		});

		const subscriptions = await app.prisma.notificationSubscription.findMany({
			where: { channel: { userId } },
			select: { channelId: true, eventType: true },
		});

		// All event types from the enum
		const events: NotificationEventType[] = [
			"HUNT_CONTENT_FOUND",
			"HUNT_COMPLETED",
			"QUEUE_ITEMS_REMOVED",
			"QUEUE_STRIKES_ISSUED",
			"TRASH_PROFILE_UPDATED",
			"TRASH_SYNC_ERROR",
			"BACKUP_COMPLETED",
			"BACKUP_FAILED",
			"LIBRARY_NEW_CONTENT",
			"SYSTEM_STARTUP",
			"SYSTEM_ERROR",
			"CLEANUP_ITEMS_FLAGGED",
			"CLEANUP_ITEMS_REMOVED",
		];

		return reply.send({
			channels: channels.map((ch) => ({
				id: ch.id,
				name: ch.name,
				type: ch.type,
			})),
			events,
			subscriptions: subscriptions.map((s) => ({
				channelId: s.channelId,
				eventType: s.eventType,
			})),
		});
	});

	/** PUT /api/notifications/subscriptions — Bulk update subscriptions */
	app.put("/subscriptions", async (request, reply) => {
		const userId = request.currentUser!.id;
		const body = validateRequest(updateSubscriptionsSchema, request.body);

		// Verify all channels belong to this user
		const userChannelIds = new Set(
			(
				await app.prisma.notificationChannel.findMany({
					where: { userId },
					select: { id: true },
				})
			).map((ch) => ch.id),
		);

		const validSubs = body.subscriptions.filter((s) => userChannelIds.has(s.channelId));

		// Process in a transaction: delete disabled subs, upsert enabled ones
		await app.prisma.$transaction(async (tx) => {
			const toRemove = validSubs.filter((s) => !s.enabled);
			const toAdd = validSubs.filter((s) => s.enabled);

			// Remove unsubscriptions
			if (toRemove.length > 0) {
				for (const sub of toRemove) {
					await tx.notificationSubscription.deleteMany({
						where: {
							channelId: sub.channelId,
							eventType: sub.eventType,
						},
					});
				}
			}

			// Upsert subscriptions
			for (const sub of toAdd) {
				await tx.notificationSubscription.upsert({
					where: {
						channelId_eventType: {
							channelId: sub.channelId,
							eventType: sub.eventType,
						},
					},
					create: {
						channelId: sub.channelId,
						eventType: sub.eventType,
					},
					update: {},
				});
			}
		});

		return reply.send({ success: true });
	});

	// ── Logs ───────────────────────────────────────────────────────────

	/** GET /api/notifications/logs — Paginated delivery log */
	app.get("/logs", async (request, reply) => {
		const userId = request.currentUser!.id;
		const query = validateRequest(logsQuerySchema, request.query);

		// Only show logs for channels owned by this user
		const userChannelIds = (
			await app.prisma.notificationChannel.findMany({
				where: { userId },
				select: { id: true },
			})
		).map((ch) => ch.id);

		const where: Record<string, unknown> = {
			channelId: { in: userChannelIds },
		};
		if (query.channelId) {
			if (userChannelIds.includes(query.channelId)) {
				where.channelId = query.channelId;
			} else {
				return reply.send({ logs: [], total: 0, page: query.page, limit: query.limit });
			}
		}

		const [logs, total] = await Promise.all([
			app.prisma.notificationLog.findMany({
				where,
				orderBy: { sentAt: "desc" },
				skip: (query.page - 1) * query.limit,
				take: query.limit,
			}),
			app.prisma.notificationLog.count({ where }),
		]);

		return reply.send({
			logs: logs.map((log) => ({
				id: log.id,
				channelId: log.channelId,
				channelType: log.channelType,
				eventType: log.eventType,
				title: log.title,
				body: log.body,
				status: log.status,
				error: log.error,
				sentAt: log.sentAt.toISOString(),
			})),
			total,
			page: query.page,
			limit: query.limit,
		});
	});

	// ── Browser Push ───────────────────────────────────────────────────

	/** GET /api/notifications/vapid-public-key — VAPID public key for browser push */
	app.get("/vapid-public-key", async (_request, reply) => {
		const vapid = await app.prisma.vapidKeys.findUnique({ where: { id: 1 } });
		if (!vapid) {
			return reply.status(404).send({ error: "VAPID keys not configured" });
		}
		return reply.send({ publicKey: vapid.publicKey });
	});

	/** POST /api/notifications/push-subscription — Register browser push subscription as a channel */
	app.post("/push-subscription", async (request, reply) => {
		const userId = request.currentUser!.id;
		const body = validateRequest(pushSubscriptionSchema, request.body);

		// Store as a BROWSER_PUSH channel with the push subscription as config
		const config = {
			endpoint: body.endpoint,
			p256dh: body.keys.p256dh,
			auth: body.keys.auth,
		};
		const encrypted = app.encryptor.encrypt(JSON.stringify(config));

		// Check all existing BROWSER_PUSH channels for a matching endpoint
		const existingChannels = await app.prisma.notificationChannel.findMany({
			where: { userId, type: "BROWSER_PUSH" },
		});

		for (const existing of existingChannels) {
			try {
				const existingConfig = JSON.parse(
					app.encryptor.decrypt({
						value: existing.encryptedConfig,
						iv: existing.configIv,
					}),
				) as Record<string, unknown>;

				if (existingConfig.endpoint === body.endpoint) {
					// Same endpoint — update keys
					await app.prisma.notificationChannel.update({
						where: { id: existing.id },
						data: {
							encryptedConfig: encrypted.value,
							configIv: encrypted.iv,
						},
					});
					return reply.send({ id: existing.id, updated: true });
				}
			} catch (err) {
				// Couldn't decrypt — skip this channel and continue checking others
				request.log.debug({ err, channelId: existing.id }, "Could not decrypt browser push channel for dedup check");
			}
		}

		// Cap browser push channels at 10 per user
		const MAX_BROWSER_PUSH = 10;
		if (existingChannels.length >= MAX_BROWSER_PUSH) {
			return reply.status(400).send({
				error: `Maximum of ${MAX_BROWSER_PUSH} browser push subscriptions reached`,
			});
		}

		const channel = await app.prisma.notificationChannel.create({
			data: {
				userId,
				name: `Browser Push (${new Date().toLocaleDateString()})`,
				type: "BROWSER_PUSH",
				enabled: true,
				encryptedConfig: encrypted.value,
				configIv: encrypted.iv,
			},
		});

		return reply.status(201).send({ id: channel.id, updated: false });
	});

	done();
};
