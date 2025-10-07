/**
 * Sums an array of numbers, filtering out undefined and non-finite values
 */
export const sumNumbers = (values: Array<number | undefined>): number => {
	let total = 0;
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) {
			total += value;
		}
	}
	return total;
};

/**
 * Clamps a percentage value between 0 and 100
 */
export const clampPercentage = (value: number): number => {
	if (!Number.isFinite(value)) {
		return 0;
	}
	if (value < 0) {
		return 0;
	}
	if (value > 100) {
		return 100;
	}
	return value;
};

/**
 * Safely makes a request and parses JSON, returning undefined on error
 */
export const safeRequestJson = async <T>(
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	path: string,
	init?: RequestInit,
): Promise<T | undefined> => {
	try {
		const response = await fetcher(path, init);
		return (await response.json()) as T;
	} catch (_error) {
		return undefined;
	}
};
