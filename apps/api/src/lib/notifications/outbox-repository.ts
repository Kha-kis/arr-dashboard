import { randomUUID } from "node:crypto";
import {
	notificationChannelTypeSchema,
	notificationEventTypeSchema,
	notificationFailureCategorySchema,
	notificationFailureMessage,
} from "@arr/shared";
import { z } from "zod";
import type { Encryptor } from "../auth/encryption.js";
import {
	assertRestoreRuntimeOperation,
	getRestoreRuntimeClientContext,
	type RestoreRuntime,
	RestoreRuntimeAdmissionError,
} from "../backup/restore-runtime-admission.js";
import { type NotificationOutboxEvent, Prisma, type PrismaClientInstance } from "../prisma.js";
import { validateStoredNotificationConfig } from "./config-privacy.js";
import {
	type NotificationOutboxAdmission,
	type NotificationOutboxAttempt,
	NotificationOutboxError,
	type NotificationOutboxOutcome,
	type NotificationOutboxQueueStatus,
	type NotificationOutboxWork,
} from "./outbox-types.js";
import { captureDeliveryAttempt } from "./types.js";

const payloadSchema = z
	.object({
		eventType: notificationEventTypeSchema,
		title: z.string(),
		body: z.string(),
		url: z.string().optional(),
		metadata: z.record(z.string(), z.json()).optional(),
	})
	.strict();
const recipientSchema = z
	.object({
		channelId: z.string().min(1),
		channelType: notificationChannelTypeSchema,
		subscriptionEventType: notificationEventTypeSchema,
	})
	.strict();
const policySchema = z.discriminatedUnion("stage", [
	z.object({ stage: z.literal("ready") }).strict(),
	z.object({ stage: z.literal("deferred"), dueAt: z.iso.datetime() }).strict(),
	z
		.object({
			stage: z.literal("aggregating"),
			windowSeconds: z.number().int().min(60).max(3600),
			maxBatchSize: z.number().int().min(2).max(100),
		})
		.strict(),
]);
const envelopeSchema = z
	.object({
		purpose: z.literal("arr-dashboard:notification-outbox-event"),
		version: z.literal(1),
		eventId: z.string().uuid(),
		userId: z.string().min(1),
		payload: payloadSchema,
		recipients: z.array(recipientSchema).min(1),
		fallbackEventTypes: z.array(notificationEventTypeSchema),
		policy: policySchema,
		acceptedAt: z.iso.datetime(),
		dueAt: z.iso.datetime(),
		destinationInstallationId: z.string().min(1),
		restoreCommitId: z.string().nullable(),
		aggregationMemberIds: z.array(z.string().uuid()).min(1).max(100).optional(),
	})
	.strict();
const rawSerializationRollback = z.object({
	cause: z.object({
		kind: z.literal("TransactionWriteConflict"),
		originalCode: z.literal("40001"),
	}),
});
function isProvedSerializationRollback(error: unknown): boolean {
	if (error instanceof Prisma.PrismaClientKnownRequestError)
		return (
			error.code === "P2034" ||
			(error.code === "P2010" &&
				rawSerializationRollback.safeParse(error.meta?.driverAdapterError).success)
		);
	return (
		error instanceof Error &&
		error.name === "DriverAdapterError" &&
		rawSerializationRollback.safeParse(error).success
	);
}
const eventStages = z.enum(["ready", "deferred", "aggregating", "grouped", "terminal"]);
const deliveryStates = z.enum([
	"waiting",
	"ready",
	"submitting",
	"retry-waiting",
	"sent",
	"rejected",
	"uncertain",
	"canceled",
]);
const terminalStates = ["sent", "rejected", "uncertain", "canceled"];
const resultSchema = z
	.object({
		success: z.boolean(),
		retryable: z.boolean(),
		failureCategory: notificationFailureCategorySchema.optional(),
		retryAfterMs: z.unknown().optional(),
	})
	.refine((result) => !(result.success && result.retryable));

function freezeJson<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const item of Object.values(value)) freezeJson(item);
		Object.freeze(value);
	}
	return value;
}

/** Do not acknowledge JSON's silent removal/coercion of producer metadata. */
function faithfulJson(value: unknown, ancestors = new Set<object>()): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (typeof value !== "object" || ancestors.has(value))
		throw new NotificationOutboxError("payload-unavailable");
	if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
		throw new NotificationOutboxError("payload-unavailable");
	ancestors.add(value);
	try {
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Reflect.ownKeys(value).some((key) => typeof key === "symbol"))
			throw new NotificationOutboxError("payload-unavailable");
		if (Array.isArray(value) && Object.keys(descriptors).length !== value.length + 1)
			throw new NotificationOutboxError("payload-unavailable");
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (Array.isArray(value) && key === "length") continue;
			if (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
				throw new NotificationOutboxError("payload-unavailable");
			if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
				throw new NotificationOutboxError("payload-unavailable");
			faithfulJson(descriptor.value, ancestors);
		}
	} finally {
		ancestors.delete(value);
	}
}

/** Short native-authorized persistence only. Provider I/O belongs outside this repository. */
export function createNotificationOutboxRepository(
	prisma: PrismaClientInstance,
	runtime: RestoreRuntime,
	encryptor: Encryptor,
	userId: string,
	options: { clock?: () => Date } = {},
) {
	const context = getRestoreRuntimeClientContext(runtime);
	const clock = options.clock ?? (() => new Date());
	const issuedAttempts = new WeakSet<NotificationOutboxAttempt>();
	const currentTime = () => {
		const now = new Date(clock());
		if (!Number.isFinite(now.getTime())) throw new NotificationOutboxError("state-unavailable");
		return now;
	};
	const fingerprint = (domain: string, value: unknown) =>
		encryptor.fingerprint(JSON.stringify([domain, 1, userId, value]));
	const dedup = (payload: z.infer<typeof payloadSchema>) =>
		fingerprint("notification-content", [payload.eventType, payload.title, payload.body]);
	const scope = (envelope: z.infer<typeof envelopeSchema>) =>
		fingerprint("notification-scope", [
			envelope.payload.eventType,
			envelope.recipients,
			envelope.fallbackEventTypes,
			envelope.policy.stage === "aggregating" ? envelope.policy : envelope.policy.stage,
		]);
	async function transaction<T>(
		operation: (tx: Prisma.TransactionClient) => Promise<T>,
	): Promise<T> {
		await assertRestoreRuntimeOperation(runtime);
		for (let retry = 0; ; retry++) {
			try {
				const result = await prisma.$transaction(operation, { isolationLevel: "Serializable" });
				await assertRestoreRuntimeOperation(runtime);
				return result;
			} catch (error) {
				// Only proved rolled-back local transactions may retry; never an external send.
				if (retry < 2 && isProvedSerializationRollback(error)) {
					await assertRestoreRuntimeOperation(runtime);
					continue;
				}
				if (
					error instanceof NotificationOutboxError ||
					error instanceof RestoreRuntimeAdmissionError
				)
					throw error;
				throw new NotificationOutboxError("storage-unavailable");
			}
		}
	}
	async function readStored(
		tx: Prisma.TransactionClient,
		event: NotificationOutboxEvent,
	): Promise<NotificationOutboxWork> {
		try {
			const envelope = envelopeSchema.parse(
				JSON.parse(encryptor.decrypt({ value: event.encryptedPayload, iv: event.payloadIv })),
			);
			if (
				envelope.userId !== userId ||
				event.userId !== userId ||
				envelope.eventId !== event.id ||
				envelope.payload.eventType !== event.eventType ||
				envelope.acceptedAt !== event.acceptedAt.toISOString() ||
				envelope.dueAt !== event.dueAt.toISOString() ||
				envelope.dueAt !==
					(envelope.policy.stage === "deferred"
						? envelope.policy.dueAt
						: envelope.policy.stage === "aggregating"
							? new Date(
									event.acceptedAt.getTime() + envelope.policy.windowSeconds * 1000,
								).toISOString()
							: envelope.acceptedAt) ||
				envelope.destinationInstallationId !== event.destinationInstallationId ||
				envelope.restoreCommitId !== event.restoreCommitId ||
				dedup(envelope.payload) !== event.dedupFingerprint ||
				scope(envelope) !== event.scopeFingerprint ||
				(envelope.policy.stage === "aggregating"
					? envelope.policy.windowSeconds !== event.aggregationWindowSeconds ||
						envelope.policy.maxBatchSize !== event.maxBatchSize
					: event.aggregationWindowSeconds !== null || event.maxBatchSize !== null)
			)
				throw new NotificationOutboxError("payload-unavailable");
			const deliveries = await tx.notificationOutboxDelivery.findMany({
				where: { eventId: event.id, userId },
				select: { channelId: true, channelType: true, subscriptionEventType: true },
				orderBy: { channelId: "asc" },
			});
			if (JSON.stringify(deliveries) !== JSON.stringify(envelope.recipients))
				throw new NotificationOutboxError("payload-unavailable");
			const members = await tx.notificationOutboxEvent.findMany({
				where: { aggregateParentId: event.id, userId },
				orderBy: [{ acceptedAt: "asc" }, { id: "asc" }],
				select: { id: true, stage: true },
				take: 101,
			});
			if (
				envelope.aggregationMemberIds === undefined
					? members.length !== 0
					: envelope.policy.stage !== "ready" ||
						members.some((row) => row.stage !== "grouped") ||
						JSON.stringify(members.map((row) => row.id)) !==
							JSON.stringify(envelope.aggregationMemberIds)
			)
				throw new NotificationOutboxError("payload-unavailable");
			return {
				eventId: event.id,
				payload: envelope.payload,
				recipients: envelope.recipients,
				fallbackEventTypes: envelope.fallbackEventTypes,
				policy:
					envelope.policy.stage === "deferred"
						? { stage: "deferred", dueAt: new Date(envelope.policy.dueAt) }
						: envelope.policy,
			};
		} catch (error) {
			if (error instanceof RestoreRuntimeAdmissionError || isProvedSerializationRollback(error))
				throw error;
			throw new NotificationOutboxError("payload-unavailable");
		}
	}
	async function lockOwner(tx: Prisma.TransactionClient): Promise<void> {
		if (
			(await tx.$executeRaw(Prisma.sql`UPDATE "User" SET "id" = "id" WHERE "id" = ${userId}`)) !== 1
		)
			throw new NotificationOutboxError("owner-unavailable");
	}
	async function currentBinding(tx: Prisma.TransactionClient) {
		const control = await tx.restoreRuntimeControl.findUnique({ where: { id: 1 } });
		if (
			!control?.destinationInstallationId ||
			control.runtimeEpoch !== context.runtimeEpoch ||
			control.phase !== "running"
		)
			throw new NotificationOutboxError("binding-unavailable");
		return {
			destinationInstallationId: control.destinationInstallationId,
			restoreCommitId: control.lastCommittedRestoreId,
		};
	}
	async function retireEvent(tx: Prisma.TransactionClient, eventId: string): Promise<void> {
		const remaining = await tx.notificationOutboxDelivery.count({
			where: { userId, eventId, state: { notIn: terminalStates } },
		});
		if (remaining === 0)
			await tx.notificationOutboxEvent.updateMany({
				where: { userId, id: eventId, stage: { in: ["ready", "deferred", "aggregating"] } },
				data: { stage: "terminal" },
			});
	}
	async function admit(
		input: NotificationOutboxAdmission,
	): Promise<{ created: boolean; eventId: string }> {
		let snapshot: {
			payload: z.infer<typeof payloadSchema>;
			recipients: z.infer<typeof recipientSchema>[];
			fallbackEventTypes: z.infer<typeof notificationEventTypeSchema>[];
			policy: z.infer<typeof policySchema>;
		};
		let acceptedAt: Date;
		try {
			// Snapshot without invoking producer getters or silently changing JSON values.
			faithfulJson(input.payload);
			faithfulJson(input.recipients);
			faithfulJson(input.fallbackEventTypes ?? []);
			const rawPolicy =
				input.policy.stage === "deferred"
					? { stage: "deferred", dueAt: input.policy.dueAt.toISOString() }
					: input.policy;
			faithfulJson(rawPolicy);
			snapshot = {
				payload: payloadSchema.parse(JSON.parse(JSON.stringify(input.payload))),
				recipients: z
					.array(recipientSchema)
					.min(1)
					.parse(JSON.parse(JSON.stringify(input.recipients))),
				fallbackEventTypes: z
					.array(notificationEventTypeSchema)
					.parse([...new Set(input.fallbackEventTypes ?? [])].sort()),
				policy: policySchema.parse(rawPolicy),
			};
			snapshot.recipients.sort((a, b) =>
				a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0,
			);
			if (
				new Set(snapshot.recipients.map((item) => item.channelId)).size !==
				snapshot.recipients.length
			)
				throw new NotificationOutboxError("recipient-unavailable");
			acceptedAt = new Date(clock());
			if (!Number.isFinite(acceptedAt.getTime()))
				throw new NotificationOutboxError("payload-unavailable");
		} catch (error) {
			if (error instanceof NotificationOutboxError) throw error;
			throw new NotificationOutboxError("payload-unavailable");
		}
		const dueAt =
			snapshot.policy.stage === "deferred"
				? new Date(snapshot.policy.dueAt)
				: snapshot.policy.stage === "aggregating"
					? new Date(acceptedAt.getTime() + snapshot.policy.windowSeconds * 1000)
					: acceptedAt;
		const contentFingerprint = dedup(snapshot.payload);
		return transaction(async (tx) => {
			// Lock the existing owner without mutating its @updatedAt business timestamp.
			if (
				(await tx.$executeRaw(Prisma.sql`UPDATE "User" SET "id" = "id" WHERE "id" = ${userId}`)) !==
				1
			)
				throw new NotificationOutboxError("owner-unavailable");
			const control = await tx.restoreRuntimeControl.findUnique({ where: { id: 1 } });
			if (
				!control?.destinationInstallationId ||
				control.runtimeEpoch !== context.runtimeEpoch ||
				control.phase !== "running"
			)
				throw new NotificationOutboxError("binding-unavailable");
			const existing = await tx.notificationOutboxEvent.findFirst({
				where: {
					userId,
					dedupFingerprint: contentFingerprint,
					acceptedAt: { gt: new Date(acceptedAt.getTime() - 60_000) },
				},
				orderBy: [{ acceptedAt: "desc" }, { id: "desc" }],
			});
			if (existing) {
				await readStored(tx, existing);
				return { created: false, eventId: existing.id };
			}
			for (const recipient of snapshot.recipients) {
				if (
					![snapshot.payload.eventType, ...snapshot.fallbackEventTypes].includes(
						recipient.subscriptionEventType,
					) ||
					!(await tx.notificationChannel.findFirst({
						where: {
							id: recipient.channelId,
							userId,
							enabled: true,
							type: recipient.channelType,
							subscriptions: { some: { eventType: recipient.subscriptionEventType } },
						},
						select: { id: true },
					}))
				)
					throw new NotificationOutboxError("recipient-unavailable");
			}
			const eventId = randomUUID();
			const envelope: z.infer<typeof envelopeSchema> = {
				purpose: "arr-dashboard:notification-outbox-event",
				version: 1,
				eventId,
				userId,
				...snapshot,
				acceptedAt: acceptedAt.toISOString(),
				dueAt: dueAt.toISOString(),
				destinationInstallationId: control.destinationInstallationId,
				restoreCommitId: control.lastCommittedRestoreId,
			};
			const encrypted = encryptor.encrypt(JSON.stringify(envelope));
			await tx.notificationOutboxEvent.create({
				data: {
					id: eventId,
					userId,
					eventType: snapshot.payload.eventType,
					encryptedPayload: encrypted.value,
					payloadIv: encrypted.iv,
					dedupFingerprint: contentFingerprint,
					scopeFingerprint: scope(envelope),
					stage: snapshot.policy.stage,
					dueAt,
					acceptedAt,
					destinationInstallationId: envelope.destinationInstallationId,
					restoreCommitId: envelope.restoreCommitId,
					aggregationWindowSeconds:
						snapshot.policy.stage === "aggregating" ? snapshot.policy.windowSeconds : null,
					maxBatchSize:
						snapshot.policy.stage === "aggregating" ? snapshot.policy.maxBatchSize : null,
				},
			});
			for (const recipient of snapshot.recipients)
				await tx.notificationOutboxDelivery.create({
					data: {
						userId,
						eventId,
						...recipient,
						state: snapshot.policy.stage === "ready" ? "ready" : "waiting",
						nextAttemptAt: dueAt,
					},
				});
			return { created: true, eventId };
		});
	}
	async function readEvent(eventId: string): Promise<NotificationOutboxWork | null> {
		return transaction(async (tx) => {
			const event = await tx.notificationOutboxEvent.findFirst({ where: { id: eventId, userId } });
			return event ? readStored(tx, event) : null;
		});
	}
	async function groupDue(limit = 100): Promise<string[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new NotificationOutboxError("state-unavailable");
		const now = currentTime();
		// Only eligible scopes enter the bound; future partial groups cannot hide due work.
		const scopes = await transaction(async (tx) => {
			const binding = await currentBinding(tx);
			const due = await tx.notificationOutboxEvent.groupBy({
				by: ["scopeFingerprint"],
				where: { userId, ...binding, stage: "aggregating", dueAt: { lte: now } },
				_min: { dueAt: true },
				orderBy: [{ _min: { dueAt: "asc" } }, { scopeFingerprint: "asc" }],
				take: limit,
			});
			const restore =
				binding.restoreCommitId === null
					? Prisma.sql`"restoreCommitId" IS NULL`
					: Prisma.sql`"restoreCommitId" = ${binding.restoreCommitId}`;
			const full = await tx.$queryRaw<{ scopeFingerprint: string }[]>(Prisma.sql`
				SELECT "scopeFingerprint" FROM "NotificationOutboxEvent"
				WHERE "userId" = ${userId} AND "destinationInstallationId" = ${binding.destinationInstallationId}
				AND ${restore} AND "stage" = 'aggregating'
				GROUP BY "scopeFingerprint" HAVING COUNT(*) >= MIN("maxBatchSize")
				ORDER BY MIN("dueAt"), "scopeFingerprint" LIMIT ${limit}`);
			return [...new Set([...due, ...full].map((row) => row.scopeFingerprint))].slice(0, limit);
		});
		const committed: string[] = [];
		let unavailable: NotificationOutboxError | undefined;
		for (const scopeFingerprint of scopes) {
			// A digest is one atomic unit; do not retain a transaction across unrelated batches.
			const digestId = await transaction(async (tx) => {
				await lockOwner(tx);
				const binding = await currentBinding(tx);
				const members = await tx.notificationOutboxEvent.findMany({
					where: { userId, ...binding, scopeFingerprint, stage: "aggregating" },
					orderBy: [{ acceptedAt: "asc" }, { id: "asc" }],
					take: 100,
				});
				const first = members[0];
				if (!first) return null;
				const firstWork = await readStored(tx, first);
				if (firstWork.policy.stage !== "aggregating" || first.aggregateParentId !== null)
					throw new NotificationOutboxError("state-unavailable");
				const maximum = firstWork.policy.maxBatchSize;
				const inWindow = members.filter((member) => member.acceptedAt < first.dueAt);
				if (inWindow.length < maximum && first.dueAt > now) return null;
				const selected = inWindow.slice(0, maximum);
				const works: NotificationOutboxWork[] = [];
				for (const member of selected) {
					const work = member.id === first.id ? firstWork : await readStored(tx, member);
					if (
						member.aggregateParentId !== null ||
						work.policy.stage !== "aggregating" ||
						JSON.stringify([
							work.recipients,
							work.fallbackEventTypes,
							work.policy,
							work.payload.eventType,
						]) !==
							JSON.stringify([
								firstWork.recipients,
								firstWork.fallbackEventTypes,
								firstWork.policy,
								firstWork.payload.eventType,
							])
					)
						throw new NotificationOutboxError("state-unavailable");
					works.push(work);
				}
				const ids = selected.map((member) => member.id);
				const deliveries = await tx.notificationOutboxDelivery.findMany({
					where: { userId, eventId: { in: ids } },
				});
				if (
					deliveries.length !== works.length * firstWork.recipients.length ||
					deliveries.some(
						(row) =>
							row.state !== "waiting" ||
							row.attemptOrdinal !== 0 ||
							row.attemptToken !== null ||
							row.workerEpoch !== null ||
							row.dispatchedAt !== null ||
							row.completedAt !== null ||
							row.attemptConfigFingerprint !== null,
					)
				)
					throw new NotificationOutboxError("state-unavailable");
				const titles = [...new Set(works.map((work) => work.payload.title))];
				const summary =
					titles.length <= 3
						? titles.join(", ")
						: `${titles.slice(0, 3).join(", ")} and ${titles.length - 3} more`;
				const payload: z.infer<typeof payloadSchema> = {
					eventType: firstWork.payload.eventType,
					title: `[${works.length}x] ${summary}`,
					body: `Aggregated ${works.length} ${firstWork.payload.eventType} notifications`,
					metadata: {
						aggregated: true,
						count: works.length,
						items: works
							.map((work) => ({ title: work.payload.title, body: work.payload.body }))
							.slice(0, 10),
					},
				};
				const eventId = randomUUID();
				const envelope: z.infer<typeof envelopeSchema> = {
					purpose: "arr-dashboard:notification-outbox-event",
					version: 1,
					eventId,
					userId,
					payload,
					recipients: firstWork.recipients,
					fallbackEventTypes: firstWork.fallbackEventTypes,
					policy: { stage: "ready" },
					aggregationMemberIds: ids,
					acceptedAt: now.toISOString(),
					dueAt: now.toISOString(),
					...binding,
				};
				const encrypted = encryptor.encrypt(JSON.stringify(envelope));
				await tx.notificationOutboxEvent.create({
					data: {
						id: eventId,
						userId,
						...binding,
						eventType: payload.eventType,
						stage: "ready",
						acceptedAt: now,
						dueAt: now,
						encryptedPayload: encrypted.value,
						payloadIv: encrypted.iv,
						dedupFingerprint: dedup(payload),
						scopeFingerprint: scope(envelope),
					},
				});
				for (const recipient of firstWork.recipients)
					await tx.notificationOutboxDelivery.create({
						data: {
							userId,
							eventId,
							...recipient,
							state: "ready",
							nextAttemptAt: now,
						},
					});
				const retired = await tx.notificationOutboxDelivery.updateMany({
					where: {
						userId,
						eventId: { in: ids },
						state: "waiting",
						attemptOrdinal: 0,
						attemptToken: null,
					},
					data: { state: "canceled", outcomeCategory: "aggregated", completedAt: now },
				});
				const grouped = await tx.notificationOutboxEvent.updateMany({
					where: {
						userId,
						id: { in: ids },
						stage: "aggregating",
						aggregateParentId: null,
						...binding,
					},
					data: { stage: "grouped", aggregateParentId: eventId },
				});
				if (retired.count !== deliveries.length || grouped.count !== ids.length)
					throw new NotificationOutboxError("storage-unavailable");
				return eventId;
			}).catch((error: unknown) => {
				if (
					error instanceof NotificationOutboxError &&
					["payload-unavailable", "state-unavailable"].includes(error.category)
				) {
					unavailable ??= error;
					return null;
				}
				throw error;
			});
			if (digestId) committed.push(digestId);
		}
		// Report incomplete work without undoing independently validated digests.
		if (unavailable) throw unavailable;
		return committed;
	}
	async function listDueDeliveryIds(limit = 100): Promise<string[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
			throw new NotificationOutboxError("state-unavailable");
		const now = currentTime();
		return transaction(async (tx) => {
			const binding = await currentBinding(tx);
			const rows = await tx.notificationOutboxDelivery.findMany({
				where: {
					userId,
					state: { in: ["ready", "retry-waiting"] },
					nextAttemptAt: { lte: now },
					event: { userId, ...binding, stage: "ready", dueAt: { lte: now } },
				},
				select: { id: true },
				orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
				take: limit,
			});
			return rows.map((row) => row.id);
		});
	}
	async function beginAttempt(deliveryId: string): Promise<NotificationOutboxAttempt | null> {
		const now = currentTime();
		const attempt = await transaction(async (tx) => {
			await lockOwner(tx);
			const binding = await currentBinding(tx);
			const delivery = await tx.notificationOutboxDelivery.findFirst({
				where: { id: deliveryId, userId },
				include: { event: true },
			});
			if (!delivery || !["ready", "retry-waiting"].includes(delivery.state)) return null;
			const event = delivery.event;
			if (delivery.nextAttemptAt > now || event.stage !== "ready" || event.dueAt > now) return null;
			const work = await readStored(tx, event);
			if (
				!Number.isInteger(delivery.attemptOrdinal) ||
				delivery.attemptOrdinal < 0 ||
				delivery.attemptOrdinal > 3 ||
				(delivery.state === "ready"
					? delivery.attemptOrdinal !== 0
					: delivery.attemptOrdinal === 0) ||
				delivery.attemptToken !== null ||
				delivery.workerEpoch !== null ||
				delivery.dispatchedAt !== null ||
				delivery.completedAt !== null ||
				(delivery.state === "ready"
					? delivery.attemptConfigFingerprint !== null || delivery.outcomeCategory !== null
					: delivery.attemptConfigFingerprint === null || delivery.outcomeCategory === null) ||
				work.policy.stage === "aggregating"
			)
				throw new NotificationOutboxError("state-unavailable");
			const cancel = async (outcomeCategory: string) => {
				await tx.notificationOutboxDelivery.updateMany({
					where: { id: deliveryId, userId, state: delivery.state },
					data: { state: "canceled", outcomeCategory, completedAt: now },
				});
				await retireEvent(tx, event.id);
				return null;
			};
			if (
				event.destinationInstallationId !== binding.destinationInstallationId ||
				event.restoreCommitId !== binding.restoreCommitId
			)
				return cancel("restored-not-replayed");
			// The row lock also fences concurrent owner/config changes through resolution.
			const locked = await tx.$executeRaw(
				Prisma.sql`UPDATE "notification_channels" SET "id" = "id" WHERE "id" = ${delivery.channelId} AND "userId" = ${userId}`,
			);
			if (locked !== 1) return cancel("recipient-unavailable");
			const channel = await tx.notificationChannel.findFirst({
				where: {
					id: delivery.channelId,
					userId,
					enabled: true,
					type: delivery.channelType,
					subscriptions: { some: { eventType: delivery.subscriptionEventType } },
				},
			});
			if (!channel) return cancel("recipient-unavailable");
			const channelType = notificationChannelTypeSchema.parse(channel.type);
			let config: Record<string, unknown>;
			try {
				config = validateStoredNotificationConfig(
					channelType,
					JSON.parse(encryptor.decrypt({ value: channel.encryptedConfig, iv: channel.configIv })),
				);
			} catch {
				return cancel("configuration");
			}
			const captured = captureDeliveryAttempt(channel);
			const configFingerprint = fingerprint("notification-attempt-config", captured);
			const token = randomUUID();
			const claimed = await tx.notificationOutboxDelivery.updateMany({
				where: {
					id: deliveryId,
					userId,
					state: delivery.state,
					attemptOrdinal: delivery.attemptOrdinal,
					nextAttemptAt: delivery.nextAttemptAt,
				},
				data: {
					state: "submitting",
					attemptToken: token,
					workerEpoch: context.runtimeEpoch,
					attemptConfigFingerprint: configFingerprint,
					dispatchedAt: now,
					outcomeCategory: null,
					completedAt: null,
				},
			});
			if (claimed.count !== 1) return null;
			return Object.freeze({
				deliveryId,
				eventId: event.id,
				userId,
				token,
				epoch: context.runtimeEpoch,
				ordinal: delivery.attemptOrdinal,
				configFingerprint,
				payload: freezeJson(work.payload),
				recipient: Object.freeze({ config: freezeJson(config), context: captured }),
			});
		});
		// Membership is granted only after the marker transaction and native guard succeed.
		if (attempt) issuedAttempts.add(attempt);
		return attempt;
	}
	async function finishAttempt(
		attempt: NotificationOutboxAttempt,
		outcome: NotificationOutboxOutcome,
	): Promise<boolean> {
		await assertRestoreRuntimeOperation(runtime);
		if (!attempt || !issuedAttempts.has(attempt) || attempt.userId !== userId)
			throw new NotificationOutboxError("attempt-unavailable");
		const uncertain = z
			.object({ outcome: z.literal("uncertain") })
			.strict()
			.safeParse(outcome).success;
		const result = uncertain ? null : resultSchema.safeParse(outcome);
		if (!uncertain && !result?.success) throw new NotificationOutboxError("outcome-unavailable");
		const observed = result?.success ? result.data : null;
		const now = currentTime();
		return transaction(async (tx) => {
			await lockOwner(tx);
			const binding = await currentBinding(tx);
			const delivery = await tx.notificationOutboxDelivery.findFirst({
				where: { id: attempt.deliveryId, userId },
				include: { event: true },
			});
			if (
				delivery?.state !== "submitting" ||
				delivery.eventId !== attempt.eventId ||
				delivery.attemptToken !== attempt.token ||
				delivery.workerEpoch !== attempt.epoch ||
				attempt.epoch !== context.runtimeEpoch ||
				delivery.attemptOrdinal !== attempt.ordinal ||
				delivery.attemptConfigFingerprint !== attempt.configFingerprint ||
				delivery.event.destinationInstallationId !== binding.destinationInstallationId ||
				delivery.event.restoreCommitId !== binding.restoreCommitId
			)
				return false;
			const work = await readStored(tx, delivery.event);
			const retry = !!observed && !observed.success && observed.retryable && attempt.ordinal < 3;
			const retryDelay = observed?.retryAfterMs;
			const delay =
				typeof retryDelay === "number" &&
				Number.isFinite(retryDelay) &&
				retryDelay >= 0 &&
				retryDelay <= 2_147_483_647
					? retryDelay
					: [30_000, 120_000, 600_000][attempt.ordinal]!;
			const state = uncertain
				? "uncertain"
				: observed?.success
					? "sent"
					: retry
						? "retry-waiting"
						: "rejected";
			const category = uncertain
				? "unconfirmed"
				: observed?.success
					? "acknowledged"
					: (observed?.failureCategory ?? "unknown");
			const finalized = await tx.notificationOutboxDelivery.updateMany({
				where: {
					id: attempt.deliveryId,
					userId,
					state: "submitting",
					attemptToken: attempt.token,
					workerEpoch: attempt.epoch,
				},
				data: {
					state,
					outcomeCategory: category,
					completedAt: retry ? null : now,
					...(retry
						? {
								attemptOrdinal: attempt.ordinal + 1,
								nextAttemptAt: new Date(now.getTime() + delay),
								attemptToken: null,
								workerEpoch: null,
								dispatchedAt: null,
							}
						: {}),
				},
			});
			if (finalized.count !== 1) throw new NotificationOutboxError("storage-unavailable");
			// Preserve existing initial-failure / final-retry history policy. Pending is not a send.
			const logStatus = uncertain
				? null
				: observed?.success
					? "sent"
					: retry && attempt.ordinal > 0
						? null
						: attempt.ordinal > 0
							? "dead_letter"
							: "failed";
			if (logStatus) {
				const owned = await tx.$executeRaw(
					Prisma.sql`UPDATE "notification_channels" SET "id" = "id" WHERE "id" = ${delivery.channelId} AND "userId" = ${userId}`,
				);
				if (owned === 1) {
					await tx.notificationLog.create({
						data: {
							channelId: delivery.channelId,
							channelType: delivery.channelType,
							eventType: work.payload.eventType,
							title: work.payload.title,
							body: work.payload.body,
							status: logStatus,
							error:
								logStatus === "sent" ? null : notificationFailureMessage(observed?.failureCategory),
							retryCount: attempt.ordinal,
							sentAt: now,
						},
					});
					await tx.notificationChannel.updateMany({
						where: {
							id: attempt.recipient.context.id,
							userId,
							type: attempt.recipient.context.type,
							encryptedConfig: attempt.recipient.context.encryptedConfig,
							configIv: attempt.recipient.context.configIv,
						},
						data: { lastSentAt: now, lastSendResult: logStatus === "sent" ? "success" : "failed" },
					});
				}
			}
			await retireEvent(tx, attempt.eventId);
			return true;
		});
	}
	async function recoverInterrupted(): Promise<number> {
		const now = currentTime();
		const eligible = (
			binding: Awaited<ReturnType<typeof currentBinding>>,
		): Prisma.NotificationOutboxDeliveryWhereInput => {
			const mismatch: Prisma.NotificationOutboxEventWhereInput = {
				OR: [
					{ destinationInstallationId: { not: binding.destinationInstallationId } },
					...(binding.restoreCommitId === null
						? [{ restoreCommitId: { not: null } }]
						: [{ restoreCommitId: null }, { restoreCommitId: { not: binding.restoreCommitId } }]),
				],
			};
			return {
				userId,
				state: { in: ["waiting", "ready", "retry-waiting", "submitting"] },
				OR: [
					{
						state: "submitting",
						OR: [{ workerEpoch: null }, { workerEpoch: { not: context.runtimeEpoch } }],
					},
					{ event: { userId, ...mismatch } },
					{
						state: "waiting",
						event: { userId, stage: "deferred", dueAt: { lte: now }, ...binding },
					},
				],
			};
		};
		const eventIds = await transaction(async (tx) => {
			await lockOwner(tx);
			const rows = await tx.notificationOutboxDelivery.findMany({
				where: eligible(await currentBinding(tx)),
				select: { eventId: true },
				orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
				take: 1000,
			});
			return [...new Set(rows.map((row) => row.eventId))];
		});
		let changed = 0;
		let unavailable: NotificationOutboxError | undefined;
		for (const eventId of eventIds) {
			// Re-resolve authority and eligibility; one event's recipients stay atomic.
			changed += await transaction(async (tx) => {
				await lockOwner(tx);
				const binding = await currentBinding(tx);
				const rows = await tx.notificationOutboxDelivery.findMany({
					where: { ...eligible(binding), eventId },
					include: { event: true },
				});
				const event = rows[0]?.event;
				if (!event) return 0;
				await readStored(tx, event);
				const imported =
					event.destinationInstallationId !== binding.destinationInstallationId ||
					event.restoreCommitId !== binding.restoreCommitId;
				let recovered = 0;
				let activated = false;
				for (const row of rows) {
					if (imported || row.state === "submitting") {
						const updated = await tx.notificationOutboxDelivery.updateMany({
							where: { id: row.id, userId, state: row.state },
							data: {
								state: row.state === "submitting" ? "uncertain" : "canceled",
								outcomeCategory: imported ? "restored-not-replayed" : "unconfirmed",
								completedAt: now,
							},
						});
						recovered += updated.count;
					} else if (row.state === "waiting" && event.stage === "deferred" && !activated) {
						await tx.notificationOutboxEvent.updateMany({
							where: { id: eventId, userId, stage: "deferred", ...binding, dueAt: { lte: now } },
							data: { stage: "ready" },
						});
						const updated = await tx.notificationOutboxDelivery.updateMany({
							where: { eventId, userId, state: "waiting", nextAttemptAt: { lte: now } },
							data: { state: "ready" },
						});
						recovered += updated.count;
						activated = true;
					}
				}
				await retireEvent(tx, eventId);
				return recovered;
			}).catch((error: unknown) => {
				if (
					error instanceof NotificationOutboxError &&
					["payload-unavailable", "state-unavailable"].includes(error.category)
				) {
					unavailable ??= error;
					return 0;
				}
				throw error;
			});
		}
		if (unavailable) throw unavailable;
		return changed;
	}
	async function readQueueStatus(): Promise<NotificationOutboxQueueStatus> {
		return transaction(async (tx) => {
			await currentBinding(tx);
			const events = await tx.notificationOutboxEvent.groupBy({
				by: ["stage"],
				where: { userId },
				_count: { _all: true },
			});
			const deliveries = await tx.notificationOutboxDelivery.groupBy({
				by: ["state"],
				where: { userId },
				_count: { _all: true },
			});
			if (
				events.some((row) => !eventStages.safeParse(row.stage).success) ||
				deliveries.some((row) => !deliveryStates.safeParse(row.state).success)
			)
				throw new NotificationOutboxError("state-unavailable");
			const countEvent = (stage: string) =>
				events.find((row) => row.stage === stage)?._count._all ?? 0;
			const countDelivery = (state: string) =>
				deliveries.find((row) => row.state === state)?._count._all ?? 0;
			const nextDelivery = await tx.notificationOutboxDelivery.findFirst({
				where: { userId, state: { in: ["ready", "retry-waiting"] } },
				select: { nextAttemptAt: true },
				orderBy: { nextAttemptAt: "asc" },
			});
			const nextEvent = await tx.notificationOutboxEvent.findFirst({
				where: { userId, stage: { in: ["deferred", "aggregating"] } },
				select: { dueAt: true },
				orderBy: { dueAt: "asc" },
			});
			const dates = [nextDelivery?.nextAttemptAt, nextEvent?.dueAt].filter(
				(date): date is Date => !!date,
			);
			return {
				events: {
					ready: countEvent("ready"),
					deferred: countEvent("deferred"),
					aggregating: countEvent("aggregating"),
				},
				deliveries: {
					ready: countDelivery("ready"),
					retryWaiting: countDelivery("retry-waiting"),
					submitting: countDelivery("submitting"),
					uncertain: countDelivery("uncertain"),
				},
				oldestDueAt: dates.length
					? new Date(Math.min(...dates.map((date) => date.getTime())))
					: null,
			};
		});
	}
	return Object.freeze({
		admit,
		readEvent,
		groupDue,
		listDueDeliveryIds,
		beginAttempt,
		finishAttempt,
		recoverInterrupted,
		readQueueStatus,
	});
}
