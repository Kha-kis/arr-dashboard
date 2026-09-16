import type { ServiceInstance } from "../prisma.js";

const tails = new Map<string, Promise<void>>();

/** Serialize the live read/merge/PUT across rules and webhooks in this app process.
 * Use the endpoint so two configured instances of the same ARR also share a lock. */
export async function acquireAutoTagTargetLock(
	instance: ServiceInstance,
	arrItemId: number,
): Promise<() => void> {
	const endpoint = new URL(instance.baseUrl).toString().replace(/\/+$/, "");
	const key = JSON.stringify([instance.service, endpoint, arrItemId]);
	const previous = tails.get(key) ?? Promise.resolve();
	let unlock!: () => void;
	const next = new Promise<void>((resolve) => {
		unlock = resolve;
	});
	const tail = previous.then(() => next);
	tails.set(key, tail);
	await previous;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		unlock();
		if (tails.get(key) === tail) tails.delete(key);
	};
}
