/**
 * Shared formatting utilities.
 *
 * Consolidates duplicated formatBytes / formatRuntime implementations
 * from history-utils, library-utils, statistics/formatters, and others.
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * Format bytes into a human-readable string (e.g. "1.5 GB").
 *
 * Precision rules:
 * - >= 100 or base unit (B): 0 decimal places  → "128 MB"
 * - < 100: 1 decimal place                     → "4.7 GB"
 *
 * Returns `"-"` for invalid / negative / non-finite values.
 */
export const formatBytes = (value?: number): string => {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return "-";
	}
	let current = value;
	let index = 0;
	while (current >= 1024 && index < BYTE_UNITS.length - 1) {
		current /= 1024;
		index += 1;
	}
	const digits = current >= 100 || index === 0 ? 0 : 1;
	return `${current.toFixed(digits)} ${BYTE_UNITS[index]}`;
};

/**
 * Format runtime in minutes to a human-readable duration.
 *
 * Supports days for large values:
 * - `90`    → "1h 30m"
 * - `1500`  → "1d 1h"
 * - `45`    → "45m"
 *
 * Returns `"-"` for invalid / non-positive values.
 */
export const formatRuntime = (minutes?: number): string => {
	if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
		return "-";
	}
	const days = Math.floor(minutes / (60 * 24));
	const hours = Math.floor((minutes % (60 * 24)) / 60);
	const remainingMinutes = minutes % 60;

	if (days > 0) {
		return `${days}d ${hours}h`;
	}
	if (hours > 0) {
		return `${hours}h ${remainingMinutes}m`;
	}
	return `${remainingMinutes}m`;
};

/**
 * Format percentage value (e.g. "85.3%").
 *
 * Returns `"-"` for invalid / non-finite values.
 */
const percentFormatter = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 1,
});

export const formatPercent = (value?: number): string => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "-";
	}
	return `${percentFormatter.format(value)}%`;
};
