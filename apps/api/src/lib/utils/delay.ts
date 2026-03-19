/**
 * Async delay utility — wraps setTimeout in a Promise.
 *
 * @param ms - Milliseconds to wait
 */
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run a promise and fail if it does not settle within the specified timeout.
 *
 * @param promise - The promise to race against the timeout
 * @param timeoutMs - Timeout duration in milliseconds
 * @param timeoutMessage - Error message used if the timeout elapses
 * @returns The resolved value of `promise`
 */
export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	timeoutMessage: string,
): Promise<T> {
	let timeoutId: NodeJS.Timeout | undefined;

	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => {
			reject(new Error(timeoutMessage));
		}, timeoutMs);
	});

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
