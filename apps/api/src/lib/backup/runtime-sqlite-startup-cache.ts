import type Database from "better-sqlite3";

type CacheInputs = Readonly<{
	cacheSize: unknown;
	pageSize: unknown;
	constrainedBytes: unknown;
	availableBytes: unknown;
}>;

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Optional advisory page budget, not a bound on total native/process memory. */
export function selectSqliteStartupCacheKiB(input: CacheInputs): number | undefined {
	const { cacheSize, pageSize, constrainedBytes, availableBytes } = input;
	if (
		!positiveInteger(constrainedBytes) ||
		!positiveInteger(availableBytes) ||
		!positiveInteger(pageSize) ||
		typeof cacheSize !== "number" ||
		!Number.isSafeInteger(cacheSize)
	)
		return undefined;
	const currentBytes = cacheSize < 0 ? -cacheSize * 1024 : cacheSize * pageSize;
	if (!Number.isSafeInteger(currentBytes)) return undefined;
	const targetKiB = Math.floor(
		Math.min(64 * 1024 * 1024, constrainedBytes / 32, availableBytes / 8) / 1024,
	);
	return targetKiB > 0 && targetKiB * 1024 > currentBytes ? targetKiB : undefined;
}

/** Connection-local startup hint only; unavailable resource sampling is a no-op. */
export function applySqliteStartupCacheHint(main: Database.Database): void {
	let constrainedBytes: unknown;
	let availableBytes: unknown;
	try {
		if (
			typeof process.constrainedMemory !== "function" ||
			typeof process.availableMemory !== "function"
		)
			return;
		constrainedBytes = process.constrainedMemory();
		availableBytes = process.availableMemory();
	} catch {
		return;
	}
	const targetKiB = selectSqliteStartupCacheKiB({
		cacheSize: main.pragma("main.cache_size", { simple: true }),
		pageSize: main.pragma("main.page_size", { simple: true }),
		constrainedBytes,
		availableBytes,
	});
	// Keep native database failures visible to the existing startup failure path.
	if (targetKiB !== undefined) main.pragma(`main.cache_size = -${targetKiB}`);
}
