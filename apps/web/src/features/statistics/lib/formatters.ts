/**
 * Statistics Formatters
 *
 * Utility functions for formatting statistics values.
 * Shared across statistics components.
 */

const percentFormatter = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 1,
});

/**
 * Format bytes to human-readable size
 */
export const formatBytes = (value?: number): string => {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return "-";
	}
	const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
	let current = value;
	let index = 0;
	while (current >= 1024 && index < units.length - 1) {
		current /= 1024;
		index += 1;
	}
	const digits = current >= 100 || index === 0 ? 0 : 1;
	return `${current.toFixed(digits)} ${units[index]}`;
};

/**
 * Format percentage value
 */
export const formatPercent = (value?: number): string => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "-";
	}
	return `${percentFormatter.format(value)}%`;
};
