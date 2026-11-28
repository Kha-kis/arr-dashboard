import {
	browserPushDisableRequestSchema,
	browserPushEnableRequestSchema,
	browserPushReconnectRequestSchema,
	browserPushStateRequestSchema,
	channelConfigSchemaMap,
	createNotificationChannelSchema,
	createNotificationRuleSchema,
	type NotificationChannelType,
	notificationEventTypeSchema,
	notificationFailureMessage,
	pushSubscriptionSchema,
	updateAggregationConfigSchema,
	updateNotificationChannelSchema,
	updateNotificationRuleSchema,
	updateSubscriptionsSchema,
} from "@arr/shared";
import { dequal } from "dequal";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import {
	BrowserPushLifecycleError,
	disableBrowserPush,
	enableBrowserPush,
	readBrowserPushState,
	reconnectBrowserPush,
} from "../lib/notifications/browser-push-lifecycle.js";
import { channelConfigRevision } from "../lib/notifications/channel-config-revision.js";
import { readChannelEditState } from "../lib/notifications/channel-edit-state.js";
import {
	hasRetainedNotificationConfig,
	rejectNewNotificationConfigMarkers,
	resolveRetainedNotificationConfig,
	validateStoredNotificationConfig,
} from "../lib/notifications/config-privacy.js";
import {
	NotificationFailureError,
	safeNotificationFailureMessage,
} from "../lib/notifications/failure-diagnostics.js";
import {
	getDeliveryStatistics,
	getNotificationQueueStatus,
} from "../lib/notifications/statistics.js";
import { Prisma } from "../lib/prisma.js";
import { getErrorMessage } from "../lib/utils/error-message.js";
import { validateRequest } from "../lib/utils/validate.js";

const idParamsSchema = z.object({ id: z.string().min(1) });
const logDateQuerySchema = z
	.string()
	.refine((value) => Number.isFinite(new Date(value).getTime()), "Invalid date filter");
const logsQuerySchema = z.object({
	page: z.coerce.number().int().min(1).optional().default(1),
	limit: z.coerce.number().int().min(1).max(100).optional().default(50),
	channelId: z.string().optional(),
	status: z.enum(["sent", "failed", "dead_letter"]).optional(),
	eventType: z.string().optional(),
	since: logDateQuerySchema.optional(),
	until: logDateQuerySchema.optional(),
});
const statisticsQuerySchema = z.object({
	days: z.coerce.number().int().min(1).max(365).optional().default(30),
});
const channelSettingsConflict = {
	error: "Channel settings changed",
	code: "CHANNEL_SETTINGS_CONFLICT",
	message: "Reload the channel settings and reapply your changes.",
};
const ruleSettingsConflict = {
	error: "Rule settings changed",
	code: "RULE_SETTINGS_CONFLICT",
	message: "Reload the rules and reapply your changes.",
};
const subscriptionOwnershipConflict = {
	error: "Channel ownership changed",
	code: "SUBSCRIPTION_OWNERSHIP_CONFLICT",
	message: "Reload the subscriptions and reapply your changes.",
};
class SubscriptionOwnershipConflictError extends Error {}

/** The same owned projection is used for reads and committed save confirmation. */
async function readOwnedSubscriptionGrid(
	client: Pick<Prisma.TransactionClient, "notificationChannel" | "notificationSubscription">,
	userId: string,
) {
	const channels = await client.notificationChannel.findMany({
		where: { userId },
		select: { id: true, name: true, type: true },
		orderBy: { createdAt: "asc" },
	});
	const subscriptions = await client.notificationSubscription.findMany({
		where: { channel: { userId } },
		select: { channelId: true, eventType: true },
	});
	return {
		channels: channels.map(({ id, name, type }) => ({ id, name, type })),
		events: notificationEventTypeSchema.options,
		subscriptions: subscriptions.map(({ channelId, eventType }) => ({ channelId, eventType })),
	};
}

/** Status text is public metadata, not a transport for historical provider errors. */
function publicNotificationStatus(value: string | null | undefined): "success" | "failed" | null {
	if (value == null) return null;
	return value === "success" ? "success" : "failed";
}

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
				lastTestResult: publicNotificationStatus(ch.lastTestResult),
				lastSentAt: ch.lastSentAt?.toISOString() ?? null,
				lastSendResult: publicNotificationStatus(ch.lastSendResult),
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
		rejectNewNotificationConfigMarkers(body.config);

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
		if (
			body.expectedRevision !== undefined &&
			body.expectedRevision !== channelConfigRevision(existing)
		) {
			return reply.status(409).send(channelSettingsConflict);
		}

		const updateData: Record<string, unknown> = {};
		if (body.name !== undefined) updateData.name = body.name;
		if (body.enabled !== undefined) updateData.enabled = body.enabled;

		if (body.config) {
			let mergedConfig = body.config;
			let existingConfig: Record<string, unknown> | undefined;
			try {
				existingConfig = validateStoredNotificationConfig(
					existing.type as NotificationChannelType,
					JSON.parse(
						app.encryptor.decrypt({ value: existing.encryptedConfig, iv: existing.configIv }),
					),
				);
			} catch {
				// A complete valid replacement can repair unreadable stored settings.
				// Retained secrets, however, require a valid owned configuration.
				if (hasRetainedNotificationConfig(body.config)) {
					throw new NotificationFailureError("configuration");
				}
			}
			if (hasRetainedNotificationConfig(body.config)) {
				mergedConfig = resolveRetainedNotificationConfig(
					existing.type as NotificationChannelType,
					body.config,
					existingConfig!,
				);
			}

			// Compare normalized settings, including schema defaults and unordered headers.
			const configSchema = channelConfigSchemaMap[existing.type as NotificationChannelType];
			const validatedConfig = validateRequest(configSchema as z.ZodType, mergedConfig);
			if (!dequal(existingConfig, validatedConfig)) {
				const encrypted = app.encryptor.encrypt(JSON.stringify(validatedConfig));
				updateData.encryptedConfig = encrypted.value;
				updateData.configIv = encrypted.iv;
				updateData.lastTestedAt = null;
				updateData.lastTestResult = null;
			}
		}

		let updated: Prisma.NotificationChannelGetPayload<{ include: { subscriptions: true } }>;
		try {
			// Fence the read/write gap even for legacy callers that intentionally omit a revision.
			updated = await app.prisma.notificationChannel.update({
				where: {
					id,
					userId,
					type: existing.type,
					name: existing.name,
					enabled: existing.enabled,
					encryptedConfig: existing.encryptedConfig,
					configIv: existing.configIv,
				},
				data: updateData,
				include: { subscriptions: true },
			});
		} catch (error) {
			if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2025") {
				throw error;
			}
			const current = await app.prisma.notificationChannel.findFirst({
				where: { id, userId },
				select: { id: true },
			});
			if (!current) {
				return reply.status(404).send({ error: "Channel not found" });
			}
			return reply.status(409).send(channelSettingsConflict);
		}

		return reply.send({
			id: updated.id,
			name: updated.name,
			type: updated.type,
			enabled: updated.enabled,
			lastTestedAt: updated.lastTestedAt?.toISOString() ?? null,
			lastTestResult: publicNotificationStatus(updated.lastTestResult),
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

		try {
			await app.prisma.notificationChannel.delete({ where: { id, userId } });
		} catch (error) {
			if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2025") {
				throw error;
			}
			return reply.status(404).send({ error: "Channel not found" });
		}
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
				const result = await app.notificationService.testChannel(id, userId);
				if (result.success) return reply.send(result);
				return reply.status(400).send({
					...result,
					error: "Test failed",
					message: notificationFailureMessage(result.failureCategory),
				});
			} catch {
				return reply.status(400).send({
					success: false,
					statusRecorded: false,
					failureCategory: "unknown",
					error: "Test failed",
					message: notificationFailureMessage("unknown"),
				});
			}
		},
	);

	/** GET /api/notifications/channels/:id/edit-state — Read owned repair admission only */
	app.get("/channels/:id/edit-state", async (request, reply) => {
		const { id } = validateRequest(idParamsSchema, request.params);
		try {
			const state = await readChannelEditState(
				app.prisma,
				app.encryptor,
				id,
				request.currentUser!.id,
			);
			if (!state) return reply.status(404).send({ error: "Channel not found" });
			return reply.send(state);
		} catch {
			// Neither errors nor logs transport stored secrets, query details or ciphertext.
			request.log.error("Channel repair options could not be read");
			return reply.status(500).send({ error: "Channel repair options could not be read" });
		}
	});

	/** GET /api/notifications/channels/:id/config — Get decrypted config (for edit form) */
	app.get("/channels/:id/config", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(idParamsSchema, request.params);

		try {
			const config = await app.notificationService.getDecryptedConfig(id, userId);
			return reply.send({
				...config,
				lastTestResult: publicNotificationStatus(config.lastTestResult),
				lastSendResult: publicNotificationStatus(config.lastSendResult),
			});
		} catch (error) {
			const msg = getErrorMessage(error);
			if (msg === "Channel not found") {
				return reply.status(404).send({ error: "Channel not found" });
			}
			// Exception text/cause may contain decrypted data or provider credentials.
			request.log.error(
				{ operation: "notification-config-read", status: "failed" },
				"Failed to read notification channel config",
			);
			return reply.status(500).send({
				error: "Failed to read channel config",
				message:
					"Notification channel settings could not be read. Try reopening settings; if this persists, check the channel configuration.",
			});
		}
	});

	// ── Subscriptions ──────────────────────────────────────────────────

	/** GET /api/notifications/subscriptions — Get subscription grid */
	app.get("/subscriptions", async (request, reply) => {
		const userId = request.currentUser!.id;
		return reply.send(await readOwnedSubscriptionGrid(app.prisma, userId));
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

		try {
			const grid = await app.prisma.$transaction(async (tx) => {
				// Lock every submitted owned channel before any subscription mutation.
				// Sorted row locks avoid lock-order inversion on PostgreSQL. Raw no-op
				// updates leave channel metadata (including Prisma @updatedAt) untouched.
				const channelIds = [...new Set(validSubs.map((sub) => sub.channelId))].sort();
				for (const channelId of channelIds) {
					const locked =
						await tx.$executeRaw`UPDATE "notification_channels" SET "id" = "id" WHERE "id" = ${channelId} AND "userId" = ${userId}`;
					if (locked !== 1) throw new SubscriptionOwnershipConflictError();
				}

				const toRemove = validSubs.filter((s) => !s.enabled);
				const toAdd = validSubs.filter((s) => s.enabled);
				for (const sub of toRemove) {
					await tx.notificationSubscription.deleteMany({
						where: {
							channelId: sub.channelId,
							eventType: sub.eventType,
							channel: { userId },
						},
					});
				}

				// The channel row locks retain ownership through these inserts and commit.
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
				// A failed result read rolls back the writes; never acknowledge a
				// submitted draft or emit success before the transaction commits.
				return readOwnedSubscriptionGrid(tx, userId);
			});
			return reply.send({
				success: true,
				grid,
				omittedCount: body.subscriptions.length - validSubs.length,
			});
		} catch (error) {
			if (!(error instanceof SubscriptionOwnershipConflictError)) throw error;
			return reply.status(409).send(subscriptionOwnershipConflict);
		}
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
		if (query.status) {
			where.status = query.status;
		}
		if (query.eventType) {
			where.eventType = query.eventType;
		}
		if (query.since) {
			const sinceDate = new Date(query.since);
			if (!Number.isNaN(sinceDate.getTime())) {
				where.sentAt = { ...((where.sentAt as Record<string, unknown>) ?? {}), gte: sinceDate };
			}
		}
		if (query.until) {
			const untilDate = new Date(query.until);
			if (!Number.isNaN(untilDate.getTime())) {
				where.sentAt = { ...((where.sentAt as Record<string, unknown>) ?? {}), lte: untilDate };
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
				error:
					log.error == null || log.status === "sent"
						? null
						: safeNotificationFailureMessage(log.error),
				retryCount: log.retryCount,
				sentAt: log.sentAt.toISOString(),
			})),
			total,
			page: query.page,
			limit: query.limit,
		});
	});

	// ── Browser Push ───────────────────────────────────────────────────
	app.post("/push-subscription/state", async (request, reply) => {
		const body = validateRequest(browserPushStateRequestSchema, request.body);
		try {
			return reply.send(
				await readBrowserPushState(app.prisma, app.encryptor, request.currentUser!.id, body),
			);
		} catch (error) {
			if (!(error instanceof BrowserPushLifecycleError))
				request.log.error(
					{ operation: "browser-push-state", failureCategory: "unknown" },
					"Browser push state unavailable",
				);
			return reply
				.status(error instanceof BrowserPushLifecycleError ? error.statusCode : 500)
				.send({ error: "Browser push device state could not be verified." });
		}
	});
	app.post("/push-subscription/disable", async (request, reply) => {
		const body = validateRequest(browserPushDisableRequestSchema, request.body);
		try {
			return reply.send(
				await disableBrowserPush(app.prisma, app.encryptor, request.currentUser!.id, body),
			);
		} catch (error) {
			if (!(error instanceof BrowserPushLifecycleError))
				request.log.error(
					{ operation: "browser-push-disable", failureCategory: "unknown" },
					"Browser push disable unavailable",
				);
			return reply
				.status(error instanceof BrowserPushLifecycleError ? error.statusCode : 500)
				.send({ error: "Browser push device state could not be verified." });
		}
	});
	app.post("/push-subscription/enable", async (request, reply) => {
		const body = validateRequest(browserPushEnableRequestSchema, request.body);
		try {
			return reply.send(
				await enableBrowserPush(app.prisma, app.encryptor, request.currentUser!.id, body),
			);
		} catch (error) {
			if (!(error instanceof BrowserPushLifecycleError))
				request.log.error(
					{ operation: "browser-push-enable", failureCategory: "unknown" },
					"Browser push enable unavailable",
				);
			return reply
				.status(error instanceof BrowserPushLifecycleError ? error.statusCode : 500)
				.send({ error: "Browser push device state could not be verified." });
		}
	});

	app.post("/push-subscription/reconnect", async (request, reply) => {
		const body = validateRequest(browserPushReconnectRequestSchema, request.body);
		try {
			return reply.send(
				await reconnectBrowserPush(app.prisma, app.encryptor, request.currentUser!.id, body),
			);
		} catch (error) {
			if (!(error instanceof BrowserPushLifecycleError))
				request.log.error(
					{ operation: "browser-push-reconnect", failureCategory: "unknown" },
					"Browser push reconnect unavailable",
				);
			return reply
				.status(error instanceof BrowserPushLifecycleError ? error.statusCode : 500)
				.send({ error: "Browser push device state could not be verified." });
		}
	});

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
		try {
			const result = await app.prisma.$transaction(async (tx) => {
				// Lock the owned User row before selection or cap admission. This no-op SQL
				// leaves User metadata unchanged and serializes registrations across processes
				// on both SQLite and PostgreSQL without a new schema or an in-memory mutex.
				const locked = await tx.$executeRaw`UPDATE "User" SET "id" = "id" WHERE "id" = ${userId}`;
				if (locked !== 1) return { status: 409, body: channelSettingsConflict };

				const existingChannels = await tx.notificationChannel.findMany({
					where: { userId, type: "BROWSER_PUSH" },
				});

				for (const existing of existingChannels) {
					let existingConfig: Record<string, unknown>;
					try {
						existingConfig = validateStoredNotificationConfig(
							"BROWSER_PUSH",
							JSON.parse(
								app.encryptor.decrypt({ value: existing.encryptedConfig, iv: existing.configIv }),
							),
						);
					} catch {
						// Preserve the unreadable-channel skip policy without logging credentials,
						// exception text, or treating an invalid stored endpoint as a match.
						request.log.debug(
							{ operation: "browser-push-registration", failureCategory: "configuration" },
							"Could not read browser push channel for dedup check",
						);
						continue;
					}
					if (existingConfig.endpoint !== config.endpoint) continue;

					let data: Prisma.NotificationChannelUpdateInput = {};
					if (!dequal(existingConfig, config)) {
						const encrypted = app.encryptor.encrypt(JSON.stringify(config));
						data = {
							encryptedConfig: encrypted.value,
							configIv: encrypted.iv,
							lastTestedAt: null,
							lastTestResult: null,
						};
					}
					try {
						// Even a semantic no-op must verify the selected owner, type and config
						// generation. Persistence failures never become decode fallbacks.
						await tx.notificationChannel.update({
							where: {
								id: existing.id,
								userId,
								type: "BROWSER_PUSH",
								encryptedConfig: existing.encryptedConfig,
								configIv: existing.configIv,
							},
							data,
						});
					} catch (error) {
						if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
							return { status: 409, body: channelSettingsConflict };
						}
						throw error;
					}
					return { status: 200, body: { id: existing.id, updated: true } };
				}

				const MAX_BROWSER_PUSH = 10;
				if (existingChannels.length >= MAX_BROWSER_PUSH) {
					return {
						status: 400,
						body: { error: `Maximum of ${MAX_BROWSER_PUSH} browser push subscriptions reached` },
					};
				}
				const encrypted = app.encryptor.encrypt(JSON.stringify(config));
				const channel = await tx.notificationChannel.create({
					data: {
						userId,
						name: `Browser Push (${new Date().toLocaleDateString()})`,
						type: "BROWSER_PUSH",
						enabled: true,
						encryptedConfig: encrypted.value,
						configIv: encrypted.iv,
					},
				});
				return { status: 201, body: { id: channel.id, updated: false } };
			});
			return reply.status(result.status).send(result.body);
		} catch {
			request.log.error(
				{ operation: "browser-push-registration", status: "failed", failureCategory: "unknown" },
				"Failed to register browser push subscription",
			);
			return reply.status(500).send({ error: "Failed to register browser push subscription" });
		}
	});

	// ── Rules CRUD ────────────────────────────────────────────────────

	/** GET /api/notifications/rules — List rules */
	app.get("/rules", async (request, reply) => {
		const userId = request.currentUser!.id;
		const rules = await app.prisma.notificationRule.findMany({
			where: { userId },
			orderBy: { priority: "asc" },
		});
		return reply.send(
			rules.map((r) => ({
				id: r.id,
				name: r.name,
				enabled: r.enabled,
				priority: r.priority,
				action: r.action,
				conditions: JSON.parse(r.conditions),
				targetChannelIds: r.targetChannelIds ? JSON.parse(r.targetChannelIds) : null,
				throttleMinutes: r.throttleMinutes,
				quietHoursStart: r.quietHoursStart,
				quietHoursEnd: r.quietHoursEnd,
				quietHoursTimezone: r.quietHoursTimezone,
				createdAt: r.createdAt.toISOString(),
				updatedAt: r.updatedAt.toISOString(),
			})),
		);
	});

	/** POST /api/notifications/rules — Create a rule */
	app.post("/rules", async (request, reply) => {
		const userId = request.currentUser!.id;
		const body = validateRequest(createNotificationRuleSchema, request.body);

		// Quiet hours requires start and end times
		if (body.action === "quiet_hours" && (!body.quietHoursStart || !body.quietHoursEnd)) {
			return reply.status(400).send({
				error: "Start and end times are required for quiet hours rules",
			});
		}

		const rule = await app.prisma.notificationRule.create({
			data: {
				userId,
				name: body.name,
				enabled: body.enabled,
				priority: body.priority,
				action: body.action,
				conditions: JSON.stringify(body.conditions),
				targetChannelIds: body.targetChannelIds ? JSON.stringify(body.targetChannelIds) : null,
				throttleMinutes: body.throttleMinutes ?? null,
				quietHoursStart: body.quietHoursStart ?? null,
				quietHoursEnd: body.quietHoursEnd ?? null,
				quietHoursTimezone: body.quietHoursTimezone ?? null,
			},
		});

		return reply.status(201).send({
			id: rule.id,
			name: rule.name,
			enabled: rule.enabled,
			priority: rule.priority,
			action: rule.action,
			conditions: body.conditions,
			targetChannelIds: body.targetChannelIds ?? null,
			throttleMinutes: body.throttleMinutes ?? null,
			quietHoursStart: rule.quietHoursStart,
			quietHoursEnd: rule.quietHoursEnd,
			quietHoursTimezone: rule.quietHoursTimezone,
			createdAt: rule.createdAt.toISOString(),
			updatedAt: rule.updatedAt.toISOString(),
		});
	});

	/** PUT /api/notifications/rules/:id — Update a rule */
	app.put("/rules/:id", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(idParamsSchema, request.params);
		const body = validateRequest(updateNotificationRuleSchema, request.body);

		const existing = await app.prisma.notificationRule.findFirst({
			where: { id, userId },
		});
		if (!existing) {
			return reply.status(404).send({ error: "Rule not found" });
		}

		if (
			(body.action ?? existing.action) === "quiet_hours" &&
			(!(body.quietHoursStart ?? existing.quietHoursStart) ||
				!(body.quietHoursEnd ?? existing.quietHoursEnd))
		) {
			return reply.status(400).send({
				error: "Start and end times are required for quiet hours rules",
			});
		}

		const updateData: Record<string, unknown> = {};
		if (body.name !== undefined) updateData.name = body.name;
		if (body.enabled !== undefined) updateData.enabled = body.enabled;
		if (body.priority !== undefined) updateData.priority = body.priority;
		if (body.action !== undefined) updateData.action = body.action;
		if (body.conditions !== undefined) updateData.conditions = JSON.stringify(body.conditions);
		if (body.targetChannelIds !== undefined)
			updateData.targetChannelIds = JSON.stringify(body.targetChannelIds);
		if (body.throttleMinutes !== undefined) updateData.throttleMinutes = body.throttleMinutes;
		if (body.quietHoursStart !== undefined) updateData.quietHoursStart = body.quietHoursStart;
		if (body.quietHoursEnd !== undefined) updateData.quietHoursEnd = body.quietHoursEnd;
		if (body.quietHoursTimezone !== undefined)
			updateData.quietHoursTimezone = body.quietHoursTimezone;

		let updated: Prisma.NotificationRuleGetPayload<Record<string, never>>;
		try {
			// Fence ownership and every setting used by this partial-update snapshot.
			updated = await app.prisma.notificationRule.update({
				where: {
					id,
					userId,
					name: existing.name,
					enabled: existing.enabled,
					priority: existing.priority,
					action: existing.action,
					conditions: existing.conditions,
					targetChannelIds: existing.targetChannelIds,
					throttleMinutes: existing.throttleMinutes,
					quietHoursStart: existing.quietHoursStart,
					quietHoursEnd: existing.quietHoursEnd,
					quietHoursTimezone: existing.quietHoursTimezone,
				},
				data: updateData,
			});
		} catch (error) {
			if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2025") {
				throw error;
			}
			const current = await app.prisma.notificationRule.findFirst({
				where: { id, userId },
				select: { id: true },
			});
			if (!current) return reply.status(404).send({ error: "Rule not found" });
			return reply.status(409).send(ruleSettingsConflict);
		}

		return reply.send({
			id: updated.id,
			name: updated.name,
			enabled: updated.enabled,
			priority: updated.priority,
			action: updated.action,
			conditions: JSON.parse(updated.conditions),
			targetChannelIds: updated.targetChannelIds ? JSON.parse(updated.targetChannelIds) : null,
			throttleMinutes: updated.throttleMinutes,
			quietHoursStart: updated.quietHoursStart,
			quietHoursEnd: updated.quietHoursEnd,
			quietHoursTimezone: updated.quietHoursTimezone,
			createdAt: updated.createdAt.toISOString(),
			updatedAt: updated.updatedAt.toISOString(),
		});
	});

	/** DELETE /api/notifications/rules/:id — Delete a rule */
	app.delete("/rules/:id", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = validateRequest(idParamsSchema, request.params);

		const existing = await app.prisma.notificationRule.findFirst({
			where: { id, userId },
		});
		if (!existing) {
			return reply.status(404).send({ error: "Rule not found" });
		}

		try {
			await app.prisma.notificationRule.delete({ where: { id, userId } });
		} catch (error) {
			if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2025") {
				throw error;
			}
			return reply.status(404).send({ error: "Rule not found" });
		}
		return reply.status(204).send();
	});

	// ── Aggregation Config ────────────────────────────────────────────

	/** GET /api/notifications/aggregation — Get aggregation configs */
	app.get("/aggregation", async (request, reply) => {
		const userId = request.currentUser!.id;
		const configs = await app.prisma.notificationAggregationConfig.findMany({
			where: { userId },
		});
		return reply.send(
			configs.map((c) => ({
				eventType: c.eventType,
				windowSeconds: c.windowSeconds,
				maxBatchSize: c.maxBatchSize,
				enabled: c.enabled,
			})),
		);
	});

	/** PUT /api/notifications/aggregation — Update aggregation configs */
	app.put("/aggregation", async (request, reply) => {
		const userId = request.currentUser!.id;
		const body = validateRequest(updateAggregationConfigSchema, request.body);

		// One Save Changes request is one commit, including explicit disables.
		await app.prisma.$transaction(async (tx) => {
			for (const config of body.configs) {
				await tx.notificationAggregationConfig.upsert({
					where: {
						userId_eventType: {
							userId,
							eventType: config.eventType,
						},
					},
					create: {
						userId,
						eventType: config.eventType,
						windowSeconds: config.windowSeconds,
						maxBatchSize: config.maxBatchSize,
						enabled: config.enabled,
					},
					update: {
						windowSeconds: config.windowSeconds,
						maxBatchSize: config.maxBatchSize,
						enabled: config.enabled,
					},
				});
			}
		});

		return reply.send({ success: true });
	});

	// ── Statistics ─────────────────────────────────────────────────────

	/** GET /api/notifications/statistics — Delivery statistics */
	app.get("/statistics", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { days } = validateRequest(statisticsQuerySchema, request.query);

		const userChannelIds = (
			await app.prisma.notificationChannel.findMany({
				where: { userId },
				select: { id: true },
			})
		).map((ch) => ch.id);

		const stats = await getDeliveryStatistics(app.prisma, userChannelIds, days);
		const queue = await getNotificationQueueStatus(app.prisma, userId);
		return reply.send({ ...stats, queue });
	});

	/** GET /api/notifications/channel-types — Available channel types with form metadata */
	app.get("/channel-types", async (_request, reply) => {
		const manifests = app.notificationService.getChannelTypes();
		return reply.send(manifests);
	});

	done();
};
