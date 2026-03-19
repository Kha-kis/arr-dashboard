/**
 * Seerr Enrichment Helpers
 *
 * Shared utilities for library enrichment routes.
 */

/**
 * Run an array of async functions with bounded concurrency.
 * Returns results in the same order as the input.
 */
export async function runWithConcurrency<T>(
	tasks: (() => Promise<T>)[],
	limit: number,
): Promise<PromiseSettledResult<T>[]> {
	const results: PromiseSettledResult<T>[] = new Array(tasks.length);
	let nextIndex = 0;

	async function runNext(): Promise<void> {
		while (nextIndex < tasks.length) {
			const index = nextIndex++;
			try {
				const value = await tasks[index]!();
				results[index] = { status: "fulfilled", value };
			} catch (reason) {
				results[index] = { status: "rejected", reason };
			}
		}
	}

	const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
	await Promise.all(workers);
	return results;
}
