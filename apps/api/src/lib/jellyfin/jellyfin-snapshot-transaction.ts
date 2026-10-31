import { setTimeout as delay } from "node:timers/promises";

const SNAPSHOT_RETRY_DELAYS_MS = [10, 20, 40] as const;

function isSnapshotConflict(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	try {
		// Native SQLite and Prisma errors carry a data property. Never inspect
		// error messages, causes or arbitrary accessors to decide permission.
		return Object.getOwnPropertyDescriptor(error, "code")?.value === "SQLITE_BUSY_SNAPSHOT";
	} catch {
		return false;
	}
}

/** Retry only an entirely rolled-back, local Jellyfin preparation transaction.
 * The factory must open a fresh transaction and recheck current authority on
 * every call. Never pass provider I/O, cleanup, or a commit-unknown operation.
 */
export async function retryJellyfinSnapshotTransaction<T>(
	transaction: () => Promise<T>,
): Promise<T> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await transaction();
		} catch (error) {
			const wait = SNAPSHOT_RETRY_DELAYS_MS[attempt];
			if (wait === undefined || !isSnapshotConflict(error)) throw error;
			await delay(wait);
		}
	}
}
