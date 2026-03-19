/**
 * Notification delivery statistics queries.
 *
 * Provides aggregate metrics from NotificationLog for the dashboard.
 */

import type { PrismaClientInstance } from "../prisma.js";

export interface DeliveryStatistics {
	period: { days: number; since: string; until: string };
	totals: { sent: number; failed: number; deadLetter: number; total: number; successRate: number };
	perChannel: Array<{
		channelId: string;
		channelType: string;
		sent: number;
		failed: number;
		successRate: number;
	}>;
	perEventType: Array<{ eventType: string; count: number }>;
	dailyTrend: Array<{ date: string; sent: number; failed: number }>;
}

export async function getDeliveryStatistics(
	prisma: PrismaClientInstance,
	userChannelIds: string[],
	days: number,
): Promise<DeliveryStatistics> {
	const since = new Date();
	since.setDate(since.getDate() - days);
	const until = new Date();

	if (userChannelIds.length === 0) {
		return {
			period: { days, since: since.toISOString(), until: until.toISOString() },
			totals: { sent: 0, failed: 0, deadLetter: 0, total: 0, successRate: 100 },
			perChannel: [],
			perEventType: [],
			dailyTrend: [],
		};
	}

	const where = {
		channelId: { in: userChannelIds },
		sentAt: { gte: since },
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
	for (const log of logs) {
		if (log.status === "sent") sent++;
		else if (log.status === "failed") failed++;
		else if (log.status === "dead_letter") deadLetter++;
	}
	const total = sent + failed + deadLetter;
	const successRate = total > 0 ? Math.round((sent / total) * 10000) / 100 : 100;

	// Per-channel aggregation
	const channelMap = new Map<string, { channelType: string; sent: number; failed: number }>();
	for (const log of logs) {
		let entry = channelMap.get(log.channelId);
		if (!entry) {
			entry = { channelType: log.channelType, sent: 0, failed: 0 };
			channelMap.set(log.channelId, entry);
		}
		if (log.status === "sent") entry.sent++;
		else entry.failed++;
	}
	const perChannel = [...channelMap.entries()].map(([channelId, data]) => ({
		channelId,
		channelType: data.channelType,
		sent: data.sent,
		failed: data.failed,
		successRate:
			data.sent + data.failed > 0
				? Math.round((data.sent / (data.sent + data.failed)) * 10000) / 100
				: 100,
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
	const dayMap = new Map<string, { sent: number; failed: number }>();
	for (const log of logs) {
		const date = log.sentAt.toISOString().slice(0, 10);
		let entry = dayMap.get(date);
		if (!entry) {
			entry = { sent: 0, failed: 0 };
			dayMap.set(date, entry);
		}
		if (log.status === "sent") entry.sent++;
		else entry.failed++;
	}
	const dailyTrend = [...dayMap.entries()]
		.map(([date, data]) => ({ date, sent: data.sent, failed: data.failed }))
		.sort((a, b) => a.date.localeCompare(b.date));

	return {
		period: { days, since: since.toISOString(), until: until.toISOString() },
		totals: { sent, failed, deadLetter, total, successRate },
		perChannel,
		perEventType,
		dailyTrend,
	};
}
