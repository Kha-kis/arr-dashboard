import type {
	NotificationLogEntry,
	NotificationQueueObservation,
	NotificationStatisticsResponse,
} from "@arr/shared";

type PublicLogPage = {
	logs: NotificationLogEntry[];
	total: number;
	page: number;
	limit: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonblankString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveCounter(value: unknown): value is number {
	return isCounter(value) && value > 0;
}

function isRate(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isUtcTimestamp(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
	)
		return false;
	const timestamp = Date.parse(value);
	// Reject normalized calendar/time rollovers, allowing the historic serialized
	// UTC forms with omitted or one-to-three fractional-second digits unchanged.
	return (
		Number.isFinite(timestamp) &&
		new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19)
	);
}

function isUtcDate(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const timestamp = Date.parse(`${value}T00:00:00.000Z`);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

/** Admit the entire requested page without deriving snapshot consistency from
 * row counts. Historic string tags remain read metadata, never write authority. */
export function projectNotificationLogs(
	value: unknown,
	expectedPage: number,
	expectedLimit: number,
): PublicLogPage | undefined {
	if (
		!isRecord(value) ||
		!Array.isArray(value.logs) ||
		!isCounter(value.total) ||
		!isPositiveCounter(value.page) ||
		!isPositiveCounter(value.limit) ||
		value.page !== expectedPage ||
		value.limit !== expectedLimit
	)
		return undefined;
	const ids = new Set<string>();
	const logs: NotificationLogEntry[] = [];
	for (const row of value.logs) {
		if (
			!isRecord(row) ||
			!isNonblankString(row.id) ||
			ids.has(row.id) ||
			!isNonblankString(row.channelId) ||
			!isNonblankString(row.channelType) ||
			!isNonblankString(row.eventType) ||
			typeof row.title !== "string" ||
			typeof row.body !== "string" ||
			!isNonblankString(row.status) ||
			(row.error !== null && typeof row.error !== "string") ||
			!isCounter(row.retryCount) ||
			!isUtcTimestamp(row.sentAt)
		)
			return undefined;
		ids.add(row.id);
		logs.push({
			id: row.id,
			channelId: row.channelId,
			// Creation unions are narrower than owned historical read metadata.
			channelType: row.channelType as NotificationLogEntry["channelType"],
			eventType: row.eventType as NotificationLogEntry["eventType"],
			title: row.title,
			body: row.body,
			status: row.status as NotificationLogEntry["status"],
			error: row.error,
			retryCount: row.retryCount,
			sentAt: row.sentAt,
		});
	}
	return { logs, total: value.total, page: value.page, limit: value.limit };
}

function safeSum(values: number[]): number | undefined {
	const sum = values.reduce((total, value) => total + value, 0);
	return isCounter(sum) ? sum : undefined;
}

function classifiedRate(sent: number, classified: number): number {
	return classified > 0 ? Math.round((sent / classified) * 10000) / 100 : 0;
}

/** Queue evidence is independent of History. Invalid evidence is unavailable,
 * not an invented empty queue or permission to retain private wire fields. */
function projectQueue(value: unknown): NotificationQueueObservation {
	if (
		isRecord(value) &&
		value.state === "unavailable" &&
		(value.reason === "storage-unavailable" || value.reason === "state-unavailable")
	)
		return { state: "unavailable", reason: value.reason };
	if (
		!isRecord(value) ||
		value.state !== "observed" ||
		!isUtcTimestamp(value.observedAt) ||
		!isRecord(value.events) ||
		!isRecord(value.deliveries) ||
		!isCounter(value.events.ready) ||
		!isCounter(value.events.deferred) ||
		!isCounter(value.events.aggregating) ||
		!isCounter(value.deliveries.ready) ||
		!isCounter(value.deliveries.retryWaiting) ||
		!isCounter(value.deliveries.submitting) ||
		!isCounter(value.deliveries.uncertain) ||
		(value.oldestDueAt !== null && !isUtcTimestamp(value.oldestDueAt))
	)
		return { state: "unavailable", reason: "state-unavailable" };
	return {
		state: "observed",
		observedAt: value.observedAt,
		events: {
			ready: value.events.ready,
			deferred: value.events.deferred,
			aggregating: value.events.aggregating,
		},
		deliveries: {
			ready: value.deliveries.ready,
			retryWaiting: value.deliveries.retryWaiting,
			submitting: value.deliveries.submitting,
			uncertain: value.deliveries.uncertain,
		},
		oldestDueAt: value.oldestDueAt,
	};
}

/** Legacy observations remain literal, unverified read metadata. Explicit
 * classification must be complete and consistent, without clamping counts or
 * imposing exact elapsed hours on captured calendar windows. */
export function projectNotificationStatistics(
	value: unknown,
	expectedDays: number,
): NotificationStatisticsResponse | undefined {
	if (
		!isRecord(value) ||
		!isRecord(value.period) ||
		!isRecord(value.totals) ||
		!Array.isArray(value.perChannel) ||
		!Array.isArray(value.perEventType) ||
		!Array.isArray(value.dailyTrend)
	)
		return undefined;
	const { period, totals } = value;
	const hasClassification = [totals, ...value.perChannel, ...value.dailyTrend].some(
		(row) => isRecord(row) && Object.hasOwn(row, "unclassified"),
	);
	if (hasClassification && !isCounter(totals.unclassified)) return undefined;
	if (
		!isPositiveCounter(period.days) ||
		period.days !== expectedDays ||
		!isUtcTimestamp(period.since) ||
		!isUtcTimestamp(period.until) ||
		Date.parse(period.since) > Date.parse(period.until) ||
		!isCounter(totals.sent) ||
		!isCounter(totals.failed) ||
		!isCounter(totals.deadLetter) ||
		!isCounter(totals.total) ||
		!isRate(totals.successRate)
	)
		return undefined;
	const channelIds = new Set<string>();
	const perChannel: NotificationStatisticsResponse["perChannel"] = [];
	for (const row of value.perChannel) {
		if (
			!isRecord(row) ||
			!isNonblankString(row.channelId) ||
			channelIds.has(row.channelId) ||
			!isNonblankString(row.channelType) ||
			!isCounter(row.sent) ||
			!isCounter(row.failed) ||
			(hasClassification && !isCounter(row.unclassified)) ||
			!isRate(row.successRate)
		)
			return undefined;
		channelIds.add(row.channelId);
		perChannel.push({
			channelId: row.channelId,
			// Preserve nonblank historical tags without granting creation authority.
			channelType:
				row.channelType as NotificationStatisticsResponse["perChannel"][number]["channelType"],
			sent: row.sent,
			failed: row.failed,
			...(hasClassification ? { unclassified: row.unclassified as number } : {}),
			successRate: row.successRate,
		});
	}
	const eventTypes = new Set<string>();
	const perEventType: NotificationStatisticsResponse["perEventType"] = [];
	for (const row of value.perEventType) {
		if (
			!isRecord(row) ||
			!isNonblankString(row.eventType) ||
			eventTypes.has(row.eventType) ||
			!isCounter(row.count)
		)
			return undefined;
		eventTypes.add(row.eventType);
		perEventType.push({
			eventType:
				row.eventType as NotificationStatisticsResponse["perEventType"][number]["eventType"],
			count: row.count,
		});
	}
	const dates = new Set<string>();
	const dailyTrend: NotificationStatisticsResponse["dailyTrend"] = [];
	for (const row of value.dailyTrend) {
		if (
			!isRecord(row) ||
			!isUtcDate(row.date) ||
			dates.has(row.date) ||
			!isCounter(row.sent) ||
			!isCounter(row.failed) ||
			(hasClassification && !isCounter(row.unclassified))
		)
			return undefined;
		dates.add(row.date);
		dailyTrend.push({
			date: row.date,
			sent: row.sent,
			failed: row.failed,
			...(hasClassification ? { unclassified: row.unclassified as number } : {}),
		});
	}
	if (hasClassification) {
		const classified = safeSum([totals.sent, totals.failed, totals.deadLetter]);
		if (
			classified === undefined ||
			safeSum([classified, totals.unclassified as number]) !== totals.total ||
			totals.successRate !== classifiedRate(totals.sent, classified) ||
			safeSum(perEventType.map((row) => row.count)) !== totals.total
		)
			return undefined;
		for (const channel of perChannel) {
			const count = safeSum([channel.sent, channel.failed]);
			if (count === undefined || channel.successRate !== classifiedRate(channel.sent, count))
				return undefined;
		}
		// These groups originate from the same owned, bounded log query. Legacy
		// reads predate that classification contract and are not reconciled here.
		for (const rows of [perChannel, dailyTrend]) {
			if (
				safeSum(rows.map((row) => row.sent)) !== totals.sent ||
				safeSum(rows.map((row) => row.failed)) !== safeSum([totals.failed, totals.deadLetter]) ||
				safeSum(rows.map((row) => row.unclassified as number)) !== totals.unclassified
			)
				return undefined;
		}
	}
	return {
		...(Object.hasOwn(value, "queue") ? { queue: projectQueue(value.queue) } : {}),
		period: { days: period.days, since: period.since, until: period.until },
		totals: {
			sent: totals.sent,
			failed: totals.failed,
			deadLetter: totals.deadLetter,
			...(hasClassification ? { unclassified: totals.unclassified as number } : {}),
			total: totals.total,
			successRate: totals.successRate,
		},
		perChannel,
		perEventType,
		dailyTrend,
	};
}
