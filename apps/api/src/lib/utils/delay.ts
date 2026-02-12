/**
 * Async delay utility — wraps setTimeout in a Promise.
 *
 * @param ms - Milliseconds to wait
 */
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
