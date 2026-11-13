/**
 * Notification delivery statistics queries.
 *
 * Provides aggregate metrics from NotificationLog for the dashboard.
 */

import type { NotificationQueueObservation } from "@arr/shared";
import type { PrismaClientInstance } from "../prisma.js";

/** Independent, read-only native observation. No payload decryption or worker grant. */
export async function getNotificationQueueStatus(
	prisma: PrismaClientInstance,
	userId: string,
): Promise<NotificationQueueObservation> {
	try {
		return await prisma.$transaction(
			async (tx): Promise<NotificationQueueObservation> => {
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
				const eventStages = new Set(["ready", "deferred", "aggregating", "grouped", "terminal"]);
				const deliveryStates = new Set([
					"waiting",
					"ready",
					"submitting",
					"retry-waiting",
					"sent",
					"rejected",
					"uncertain",
					"canceled",
				]);
				const validCount = (count: number) => Number.isSafeInteger(count) && count >= 0;
				if (
					events.some((row) => !eventStages.has(row.stage) || !validCount(row._count._all)) ||
					deliveries.some((row) => !deliveryStates.has(row.state) || !validCount(row._count._all))
				)
					return { state: "unavailable", reason: "state-unavailable" };
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
				if (dates.some((date) => !Number.isFinite(date.getTime())))
					return { state: "unavailable", reason: "state-unavailable" };
				const countEvent = (stage: string) =>
					events.find((row) => row.stage === stage)?._count._all ?? 0;
				const countDelivery = (state: string) =>
					deliveries.find((row) => row.state === state)?._count._all ?? 0;
				return {
					state: "observed",
					observedAt: new Date().toISOString(),
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
						? new Date(Math.min(...dates.map((date) => date.getTime()))).toISOString()
						: null,
				};
			},
			{ isolationLevel: "Serializable" },
		);
	} catch {
		return { state: "unavailable", reason: "storage-unavailable" };
	}
}

export interface DeliveryStatistics {
	period: { days: number; since: string; until: string };
	totals: {
		sent: number;
		failed: number;
		deadLetter: number;
		unclassified: number;
		total: number;
		successRate: number;
	};
	perChannel: Array<{
		channelId: string;
		channelType: string;
		sent: number;
		failed: number;
		unclassified: number;
		successRate: number;
	}>;
	perEventType: Array<{ eventType: string; count: number }>;
	dailyTrend: Array<{ date: string; sent: number; failed: number; unclassified: number }>;
}

export async function getDeliveryStatistics(
	prisma: PrismaClientInstance,
	userChannelIds: string[],
	days: number,
): Promise<DeliveryStatistics> {
	const until = new Date();
	const since = new Date(until);
	since.setDate(since.getDate() - days);

	if (userChannelIds.length === 0) {
		return {
			period: { days, since: since.toISOString(), until: until.toISOString() },
			totals: { sent: 0, failed: 0, deadLetter: 0, unclassified: 0, total: 0, successRate: 0 },
			perChannel: [],
			perEventType: [],
			dailyTrend: [],
		};
	}

	const where = {
		channelId: { in: userChannelIds },
		sentAt: { gte: since, lte: until },
	};

	// Get all logs in the period
	const logs = await prisma.notificationLog.findMany({
		where,
		select: {
			channelId: true,
			channelType: true,
			eventType: true,
			status: true,
			sentAt: true,
		},
	});

	// Totals
	let sent = 0;
	let failed = 0;
	let deadLetter = 0;
	let unclassified = 0;
	for (const log of logs) {
		if (log.status === "sent") sent++;
		else if (log.status === "failed") failed++;
		else if (log.status === "dead_letter") deadLetter++;
		else unclassified++;
	}
	const classified = sent + failed + deadLetter;
	const total = classified + unclassified;
	// Zero is an unused wire sentinel: no classified outcomes means no measured rate.
	const successRate = classified > 0 ? Math.round((sent / classified) * 10000) / 100 : 0;

	// Per-channel aggregation
	const channelMap = new Map<
		string,
		{ channelType: string; sent: number; failed: number; unclassified: number }
	>();
	for (const log of logs) {
		let entry = channelMap.get(log.channelId);
		if (!entry) {
			entry = { channelType: log.channelType, sent: 0, failed: 0, unclassified: 0 };
			channelMap.set(log.channelId, entry);
		}
		if (log.status === "sent") entry.sent++;
		else if (log.status === "failed" || log.status === "dead_letter") entry.failed++;
		else entry.unclassified++;
	}
	const perChannel = [...channelMap.entries()].map(([channelId, data]) => ({
		channelId,
		channelType: data.channelType,
		sent: data.sent,
		failed: data.failed,
		unclassified: data.unclassified,
		successRate:
			data.sent + data.failed > 0
				? Math.round((data.sent / (data.sent + data.failed)) * 10000) / 100
				: 0,
	}));

	// Per-event-type aggregation
	const eventMap = new Map<string, number>();
	for (const log of logs) {
		eventMap.set(log.eventType, (eventMap.get(log.eventType) ?? 0) + 1);
	}
	const perEventType = [...eventMap.entries()]
		.map(([eventType, count]) => ({ eventType, count }))
		.sort((a, b) => b.count - a.count);

	// Daily trend
	const dayMap = new Map<string, { sent: number; failed: number; unclassified: number }>();
	for (const log of logs) {
		const date = log.sentAt.toISOString().slice(0, 10);
		let entry = dayMap.get(date);
		if (!entry) {
			entry = { sent: 0, failed: 0, unclassified: 0 };
			dayMap.set(date, entry);
		}
		if (log.status === "sent") entry.sent++;
		else if (log.status === "failed" || log.status === "dead_letter") entry.failed++;
		else entry.unclassified++;
	}
	const dailyTrend = [...dayMap.entries()]
		.map(([date, data]) => ({
			date,
			sent: data.sent,
			failed: data.failed,
			unclassified: data.unclassified,
		}))
		.sort((a, b) => a.date.localeCompare(b.date));

	return {
		period: { days, since: since.toISOString(), until: until.toISOString() },
		totals: { sent, failed, deadLetter, unclassified, total, successRate },
		perChannel,
		perEventType,
		dailyTrend,
	};
}
