import {
	differenceInDays,
	differenceInHours,
	differenceInMinutes,
	format,
	isToday,
	isYesterday,
	startOfDay,
	subDays,
	subHours,
} from "date-fns";

export type TimeRangePreset = "24h" | "7d" | "30d" | "all";

/** Convert a native date input into a canonical UTC instant using local-day semantics. */
export const canonicalizeDateInput = (value: string, boundary: "start" | "end"): string | null => {
	if (value === "") return "";
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(
		year,
		month - 1,
		day,
		boundary === "start" ? 0 : 23,
		boundary === "start" ? 0 : 59,
		boundary === "start" ? 0 : 59,
		boundary === "start" ? 0 : 999,
	);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
		return null;
	}
	return date.toISOString();
};

export const localDateInputValue = (canonical: string): string => {
	const date = new Date(canonical);
	if (Number.isNaN(date.getTime())) return "";
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

export const validateDateRange = (startDate: string, endDate: string): boolean =>
	!startDate || !endDate || startDate <= endDate;

/**
 * Returns an ISO date string for the start of the given time range preset.
 * Returns undefined for "all" (no date filter).
 */
export const getTimeRangeStart = (preset: TimeRangePreset): string | undefined => {
	const now = new Date();
	switch (preset) {
		case "24h":
			return subHours(now, 24).toISOString();
		case "7d":
			return startOfDay(subDays(now, 7)).toISOString();
		case "30d":
			return startOfDay(subDays(now, 30)).toISOString();
		case "all":
			return undefined;
	}
};

/**
 * Formats a date as a compact relative time string.
 * - < 1 min: "Just now"
 * - < 60 min: "5m ago"
 * - < 24 hours: "2h ago"
 * - < 7 days: "3d ago"
 * - >= 7 days: "Feb 3"
 */
export const formatCompactRelativeTime = (dateStr?: string): string => {
	if (!dateStr) return "-";
	const date = new Date(dateStr);
	if (Number.isNaN(date.getTime())) return dateStr;

	const now = new Date();
	const mins = differenceInMinutes(now, date);

	if (mins < 1) return "Just now";
	if (mins < 60) return `${mins}m ago`;

	const hours = differenceInHours(now, date);
	if (hours < 24) return `${hours}h ago`;

	const days = differenceInDays(now, date);
	if (days < 7) return `${days}d ago`;

	return format(date, "MMM d");
};

/**
 * Formats a date as a full absolute datetime string for tooltips.
 * Example: "Feb 10, 2026, 8:45 PM"
 */
export const formatAbsoluteDateTime = (dateStr?: string): string => {
	if (!dateStr) return "-";
	const date = new Date(dateStr);
	if (Number.isNaN(date.getTime())) return dateStr;

	return format(date, "MMM d, yyyy, h:mm a");
};

/**
 * Returns a human-readable label for a day separator.
 * - Today → "Today"
 * - Yesterday → "Yesterday"
 * - Other → "Mon, Feb 10"
 */
export const getDaySeparatorLabel = (date: Date): string => {
	if (isToday(date)) return "Today";
	if (isYesterday(date)) return "Yesterday";
	return format(date, "EEE, MMM d");
};

export interface DayGroup<T> {
	date: string;
	label: string;
	items: T[];
}

/**
 * Groups items by day based on a date accessor.
 * Items without a valid canonical date are omitted; v2 payloads require eventAt.
 * Groups are returned in descending order (most recent first).
 */
export const groupByDay = <T>(
	items: T[],
	getDate: (item: T) => string | undefined,
): DayGroup<T>[] => {
	const groups = new Map<string, { date: Date; items: T[] }>();

	for (const item of items) {
		const dateStr = getDate(item);
		if (!dateStr) continue;

		const date = new Date(dateStr);
		if (Number.isNaN(date.getTime())) continue;

		const dayKey = format(startOfDay(date), "yyyy-MM-dd");
		const existing = groups.get(dayKey);
		if (existing) {
			existing.items.push(item);
		} else {
			groups.set(dayKey, { date: startOfDay(date), items: [item] });
		}
	}

	return Array.from(groups.entries())
		.sort(([a], [b]) => b.localeCompare(a))
		.map(([key, { date, items: dayItems }]) => ({
			date: key,
			label: getDaySeparatorLabel(date),
			items: dayItems,
		}));
};
