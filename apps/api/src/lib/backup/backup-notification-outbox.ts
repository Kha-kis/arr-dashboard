/** Portable notification evidence is accepted work, never permission to replay it. */
import {
	type BackupData,
	notificationChannelTypeSchema,
	notificationEventTypeSchema,
} from "@arr/shared";
import { z } from "zod";
import type { Encryptor } from "../auth/encryption.js";

export const NOTIFICATION_OUTBOX_PAYLOAD_FIELDS = [
	"notificationOutboxEvents",
	"notificationOutboxDeliveries",
] as const;
const text = z.string().min(1);
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z
	.union([z.date(), z.string()])
	.refine((value) => Number.isFinite(new Date(value).getTime()));
const eventSchema = z
	.object({
		id: uuid,
		userId: text,
		eventType: notificationEventTypeSchema,
		encryptedPayload: text,
		payloadIv: text,
		dedupFingerprint: hash,
		scopeFingerprint: hash,
		stage: z.enum(["ready", "deferred", "aggregating", "grouped", "terminal"]),
		dueAt: date,
		aggregationWindowSeconds: z.number().int().min(60).max(3600).nullable(),
		maxBatchSize: z.number().int().min(2).max(100).nullable(),
		aggregateParentId: uuid.nullable(),
		destinationInstallationId: text,
		restoreCommitId: z.string().nullable(),
		acceptedAt: date,
		updatedAt: date,
	})
	.strict();
const deliverySchema = z
	.object({
		id: uuid,
		userId: text,
		eventId: uuid,
		channelId: text,
		channelType: notificationChannelTypeSchema,
		subscriptionEventType: notificationEventTypeSchema,
		state: z.enum([
			"waiting",
			"ready",
			"submitting",
			"retry-waiting",
			"sent",
			"rejected",
			"uncertain",
			"canceled",
		]),
		attemptOrdinal: z.number().int().min(0).max(3),
		nextAttemptAt: date,
		attemptToken: uuid.nullable(),
		workerEpoch: text.nullable(),
		attemptConfigFingerprint: hash.nullable(),
		dispatchedAt: date.nullable(),
		outcomeCategory: text.nullable(),
		completedAt: date.nullable(),
		createdAt: date,
		updatedAt: date,
	})
	.strict();
const envelopeSchema = z
	.object({
		purpose: z.literal("arr-dashboard:notification-outbox-event"),
		version: z.literal(1),
		eventId: uuid,
		userId: text,
		payload: z
			.object({
				eventType: notificationEventTypeSchema,
				title: z.string(),
				body: z.string(),
				url: z.string().optional(),
				metadata: z.record(z.string(), z.json()).optional(),
			})
			.strict(),
		recipients: z
			.array(
				z
					.object({
						channelId: text,
						channelType: notificationChannelTypeSchema,
						subscriptionEventType: notificationEventTypeSchema,
					})
					.strict(),
			)
			.min(1),
		fallbackEventTypes: z.array(notificationEventTypeSchema),
		policy: z.discriminatedUnion("stage", [
			z.object({ stage: z.literal("ready") }).strict(),
			z.object({ stage: z.literal("deferred"), dueAt: z.iso.datetime() }).strict(),
			z
				.object({
					stage: z.literal("aggregating"),
					windowSeconds: z.number().int().min(60).max(3600),
					maxBatchSize: z.number().int().min(2).max(100),
				})
				.strict(),
		]),
		acceptedAt: z.iso.datetime(),
		dueAt: z.iso.datetime(),
		destinationInstallationId: text,
		restoreCommitId: z.string().nullable(),
		aggregationMemberIds: z.array(uuid).min(1).max(100).optional(),
	})
	.strict();
type Event = z.infer<typeof eventSchema>;
type Delivery = z.infer<typeof deliverySchema>;
const terminalStates = new Set(["sent", "rejected", "uncertain", "canceled"]);
function check(condition: unknown): asserts condition {
	if (!condition) throw new Error("Invalid portable notification backup state");
}
function unique<T>(values: T[], key: (value: T) => string): Map<string, T> {
	const result = new Map<string, T>();
	for (const value of values) {
		const id = key(value);
		check(!result.has(id));
		result.set(id, value);
	}
	return result;
}
function referenceRows(value: unknown): { id: string; userId?: string }[] {
	const parsed = z
		.array(z.object({ id: text, userId: text.optional() }).passthrough())
		.safeParse(value);
	check(parsed.success);
	return parsed.data;
}
function validateDelivery(row: Delivery, event: Event): void {
	const noMarker =
		row.attemptToken === null && row.workerEpoch === null && row.dispatchedAt === null;
	const completeMarker =
		row.attemptToken !== null &&
		row.workerEpoch !== null &&
		row.dispatchedAt !== null &&
		row.attemptConfigFingerprint !== null;
	if (row.state === "waiting" || row.state === "ready") {
		check(
			noMarker &&
				row.attemptOrdinal === 0 &&
				row.attemptConfigFingerprint === null &&
				row.outcomeCategory === null &&
				row.completedAt === null,
		);
		check(
			row.state === "ready"
				? event.stage === "ready"
				: event.stage === "deferred" || event.stage === "aggregating",
		);
	} else if (row.state === "retry-waiting") {
		check(
			event.stage === "ready" &&
				noMarker &&
				row.attemptOrdinal > 0 &&
				row.attemptConfigFingerprint !== null &&
				row.outcomeCategory !== null &&
				row.completedAt === null,
		);
	} else if (row.state === "submitting") {
		check(
			event.stage === "ready" &&
				completeMarker &&
				row.outcomeCategory === null &&
				row.completedAt === null,
		);
	} else if (row.state === "canceled") {
		// Cancellation does not manufacture an actual send. A known failed retry
		// can retain its old configuration proof, but no in-flight marker.
		check(
			noMarker &&
				row.completedAt !== null &&
				row.outcomeCategory !== null &&
				(row.attemptOrdinal === 0
					? row.attemptConfigFingerprint === null
					: row.attemptConfigFingerprint !== null),
		);
	} else {
		check(completeMarker && row.completedAt !== null && row.outcomeCategory !== null);
		if (row.state === "sent") check(row.outcomeCategory === "acknowledged");
		if (row.state === "uncertain")
			check(
				row.outcomeCategory === "unconfirmed" || row.outcomeCategory === "restored-not-replayed",
			);
	}
}
const recipients = (rows: Delivery[]) =>
	JSON.stringify(
		rows
			.map(({ channelId, channelType, subscriptionEventType }) => ({
				channelId,
				channelType,
				subscriptionEventType,
			}))
			.sort((a, b) => (a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0)),
	);

/** Validate additive legacy evidence too; omission is not complete empty coverage. */
export function validatePortableNotificationOutbox(data: BackupData["data"]): void {
	if (
		data.notificationOutboxEvents === undefined &&
		data.notificationOutboxDeliveries === undefined
	)
		return;
	const parsedEvents = z.array(eventSchema).safeParse(data.notificationOutboxEvents);
	const parsedDeliveries = z.array(deliverySchema).safeParse(data.notificationOutboxDeliveries);
	check(parsedEvents.success && parsedDeliveries.success);
	const events = parsedEvents.data,
		deliveries = parsedDeliveries.data;
	const byId = unique(events, (row) => row.id);
	unique(deliveries, (row) => row.id);
	unique(deliveries, (row) => JSON.stringify([row.eventId, row.channelId]));
	const users = unique(referenceRows(data.users), (row) => row.id);
	const channels = unique(referenceRows(data.notificationChannel ?? []), (row) => row.id);
	const byEvent = new Map<string, Delivery[]>();
	for (const row of deliveries) {
		const event = byId.get(row.eventId),
			channel = channels.get(row.channelId);
		check(users.has(row.userId) && event && event.userId === row.userId);
		// Removed recipients remain historical evidence. An existing channel
		// owned by someone else must never become a substitute destination.
		check(!channel || channel.userId === row.userId);
		validateDelivery(row, event);
		const selected = byEvent.get(event.id) ?? [];
		selected.push(row);
		byEvent.set(event.id, selected);
	}
	for (const event of events) {
		const selected = byEvent.get(event.id) ?? [];
		check(users.has(event.userId) && selected.length > 0);
		check((event.aggregationWindowSeconds === null) === (event.maxBatchSize === null));
		if (event.stage === "aggregating" || event.stage === "grouped")
			check(event.aggregationWindowSeconds !== null);
		if (event.stage === "deferred" || event.stage === "ready")
			check(event.aggregationWindowSeconds === null);
		const allTerminal = selected.every((row) => terminalStates.has(row.state));
		check(event.stage === "terminal" || event.stage === "grouped" ? allTerminal : !allTerminal);
		if (event.stage === "grouped") {
			const parent =
				event.aggregateParentId === null ? undefined : byId.get(event.aggregateParentId);
			check(
				parent &&
					parent.id !== event.id &&
					parent.userId === event.userId &&
					parent.eventType === event.eventType &&
					parent.aggregateParentId === null &&
					parent.aggregationWindowSeconds === null &&
					(parent.stage === "ready" || parent.stage === "terminal") &&
					parent.destinationInstallationId === event.destinationInstallationId &&
					parent.restoreCommitId === event.restoreCommitId,
			);
			check(
				selected.every(
					(row) =>
						row.state === "canceled" &&
						row.attemptOrdinal === 0 &&
						row.outcomeCategory === "aggregated",
				),
			);
			check(recipients(selected) === recipients(byEvent.get(parent.id) ?? []));
		} else check(event.aggregateParentId === null);
	}
}

/** Representation translation and explicit non-delivery, not ordinary restart recovery. */
export function translatePortableNotificationOutbox(
	original: BackupData["data"],
	translated: BackupData["data"],
	source: Encryptor,
	destination: Encryptor,
): void {
	validatePortableNotificationOutbox(original);
	if (original.notificationOutboxEvents === undefined) return;
	const events = z.array(eventSchema).parse(original.notificationOutboxEvents);
	const deliveries = z.array(deliverySchema).parse(original.notificationOutboxDeliveries);
	const outgoing = z.array(eventSchema).safeParse(translated.notificationOutboxEvents);
	const outgoingDeliveries = z
		.array(deliverySchema)
		.safeParse(translated.notificationOutboxDeliveries);
	check(outgoing.success && outgoingDeliveries.success);
	const afterById = unique(
		translated.notificationOutboxEvents as Record<string, unknown>[],
		(row) => String(row.id),
	);
	check(afterById.size === events.length);
	const originalById = unique(events, (row) => row.id);
	const byEvent = new Map<string, Delivery[]>();
	for (const row of deliveries) {
		const selected = byEvent.get(row.eventId) ?? [];
		selected.push(row);
		byEvent.set(row.eventId, selected);
	}
	const groups = new Map<string, Event[]>();
	for (const event of events) {
		if (event.stage !== "grouped" || event.aggregateParentId === null) continue;
		const members = groups.get(event.aggregateParentId) ?? [];
		members.push(event);
		groups.set(event.aggregateParentId, members);
	}
	const digestProjections = new Map<string, z.infer<typeof envelopeSchema>["payload"]>();
	for (const [parentId, members] of groups) {
		members.sort(
			(a, b) =>
				new Date(a.acceptedAt).getTime() - new Date(b.acceptedAt).getTime() ||
				a.id.localeCompare(b.id),
		);
		const first = members[0]!;
		const parent = originalById.get(parentId);
		check(parent && first.maxBatchSize !== null && members.length <= first.maxBatchSize);
		check(
			members.length === first.maxBatchSize || new Date(parent.acceptedAt) >= new Date(first.dueAt),
		);
		check(
			members.every(
				(event) =>
					event.scopeFingerprint === first.scopeFingerprint &&
					event.aggregationWindowSeconds === first.aggregationWindowSeconds &&
					event.maxBatchSize === first.maxBatchSize &&
					new Date(event.acceptedAt) < new Date(first.dueAt),
			),
		);
		// A bounded digest projection, not a second retained plaintext inventory.
		const titles = new Set<string>();
		const items: { title: string; body: string }[] = [];
		for (const event of members) {
			const envelope = envelopeSchema.parse(
				JSON.parse(source.decrypt({ value: event.encryptedPayload, iv: event.payloadIv })),
			);
			titles.add(envelope.payload.title);
			if (items.length < 10)
				items.push({ title: envelope.payload.title, body: envelope.payload.body });
		}
		const uniqueTitles = [...titles];
		const summary =
			uniqueTitles.length <= 3
				? uniqueTitles.join(", ")
				: `${uniqueTitles.slice(0, 3).join(", ")} and ${uniqueTitles.length - 3} more`;
		digestProjections.set(parentId, {
			eventType: first.eventType,
			title: `[${members.length}x] ${summary}`,
			body: `Aggregated ${members.length} ${first.eventType} notifications`,
			metadata: { aggregated: true, count: members.length, items },
		});
	}
	// Check one envelope at a time rather than retaining a second plaintext
	// inventory. Fingerprints are key-dependent representations of the same
	// immutable tuple, so they must be authenticated before being translated.
	for (const event of events) {
		const cleartext = source.decrypt({ value: event.encryptedPayload, iv: event.payloadIv });
		const parsed = envelopeSchema.safeParse(JSON.parse(cleartext));
		check(parsed.success);
		const envelope = parsed.data;
		const members = groups.get(event.id);
		check(
			members
				? envelope.policy.stage === "ready" &&
						JSON.stringify(envelope.aggregationMemberIds) ===
							JSON.stringify(members.map((row) => row.id)) &&
						JSON.stringify(envelope.payload) === JSON.stringify(digestProjections.get(event.id))
				: envelope.aggregationMemberIds === undefined,
		);
		const due =
			envelope.policy.stage === "deferred"
				? envelope.policy.dueAt
				: envelope.policy.stage === "aggregating"
					? new Date(
							new Date(envelope.acceptedAt).getTime() + envelope.policy.windowSeconds * 1000,
						).toISOString()
					: envelope.acceptedAt;
		check(
			envelope.eventId === event.id &&
				envelope.userId === event.userId &&
				envelope.payload.eventType === event.eventType &&
				envelope.acceptedAt === new Date(event.acceptedAt).toISOString() &&
				envelope.dueAt === new Date(event.dueAt).toISOString() &&
				envelope.dueAt === due &&
				envelope.destinationInstallationId === event.destinationInstallationId &&
				envelope.restoreCommitId === event.restoreCommitId,
		);
		check(
			envelope.policy.stage === "aggregating"
				? envelope.policy.windowSeconds === event.aggregationWindowSeconds &&
						envelope.policy.maxBatchSize === event.maxBatchSize &&
						["aggregating", "grouped", "terminal"].includes(event.stage)
				: event.aggregationWindowSeconds === null &&
						event.maxBatchSize === null &&
						(envelope.policy.stage === "ready"
							? event.stage === "ready" || event.stage === "terminal"
							: ["deferred", "ready", "terminal"].includes(event.stage)),
		);
		check(JSON.stringify(envelope.recipients) === recipients(byEvent.get(event.id) ?? []));
		check(
			JSON.stringify(envelope.fallbackEventTypes) ===
				JSON.stringify([...new Set(envelope.fallbackEventTypes)].sort()),
		);
		check(
			envelope.recipients.every((row) =>
				[envelope.payload.eventType, ...envelope.fallbackEventTypes].includes(
					row.subscriptionEventType,
				),
			),
		);
		const content = JSON.stringify([
			"notification-content",
			1,
			event.userId,
			[envelope.payload.eventType, envelope.payload.title, envelope.payload.body],
		]);
		const scope = JSON.stringify([
			"notification-scope",
			1,
			event.userId,
			[
				envelope.payload.eventType,
				envelope.recipients,
				envelope.fallbackEventTypes,
				envelope.policy.stage === "aggregating" ? envelope.policy : envelope.policy.stage,
			],
		]);
		check(
			source.fingerprint(content) === event.dedupFingerprint &&
				source.fingerprint(scope) === event.scopeFingerprint,
		);
		const after = afterById.get(event.id);
		check(after && after.userId === event.userId);
		// The shared crypto manifest already translated ciphertext. Verify that
		// exact plaintext rather than replacing admission or Restore bindings.
		check(
			destination.decrypt({
				value: after.encryptedPayload as string,
				iv: after.payloadIv as string,
			}) === cleartext,
		);
		after.dedupFingerprint = destination.fingerprint(content);
		after.scopeFingerprint = destination.fingerprint(scope);
	}
	const restoredAt = new Date().toISOString();
	for (const row of translated.notificationOutboxDeliveries as Record<string, unknown>[]) {
		if (!["ready", "waiting", "retry-waiting", "submitting"].includes(String(row.state))) continue;
		// An issued request may have reached its provider. Keep its exact marker
		// as historical evidence, not a current process's WeakSet send capability.
		row.state = row.state === "submitting" ? "uncertain" : "canceled";
		row.outcomeCategory = "restored-not-replayed";
		row.completedAt = restoredAt;
		row.updatedAt = restoredAt;
	}
	for (const row of translated.notificationOutboxEvents as Record<string, unknown>[]) {
		if (row.stage === "grouped" || row.stage === "terminal") continue;
		row.stage = "terminal";
		row.updatedAt = restoredAt;
	}
	validatePortableNotificationOutbox(translated);
}
