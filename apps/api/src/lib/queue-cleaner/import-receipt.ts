import { createHash } from "node:crypto";
import type { ServiceInstance } from "../prisma.js";
import type { RawQueueItem } from "./queue-item-utils.js";
import { normalizeDownloadId } from "./qui-gate.js";

export const PROTECTED_IMPORT_STATES = ["submitting", "pending", "unknown", "completed", "failed"];

const activeSourceActions = new Set<string>();

/** An internal capability. A function with the same shape cannot forge ownership. */
export type QueueSourceActionPermit = () => void;
type SourceActionOwnership = {
	userId: string;
	downloadKey: string;
	key: string;
	releaseRequested: boolean;
	borrowed: boolean;
	borrowSettled: boolean;
};
const sourceActionOwnership = new WeakMap<QueueSourceActionPermit, SourceActionOwnership>();

/**
 * Stable 2.x supports one API process per database (runtime enforcement is
 * tracked separately). Hold this guard until the actual provider request
 * settles, not a scheduler timeout.
 * Persisted receipts retain import protection after the request or restart.
 */
export function acquireQueueSourceAction(
	userId: string,
	item: RawQueueItem,
): QueueSourceActionPermit | null {
	const downloadKey = queueDownloadKey(item);
	if (!userId || !downloadKey) return null;
	const key = JSON.stringify([userId, downloadKey]);
	if (activeSourceActions.has(key)) return null;
	activeSourceActions.add(key);
	const ownership: SourceActionOwnership = {
		userId,
		downloadKey,
		key,
		releaseRequested: false,
		borrowed: false,
		borrowSettled: false,
	};
	const permit = () => {
		if (ownership.releaseRequested) return;
		ownership.releaseRequested = true;
		if (!ownership.borrowed || ownership.borrowSettled) activeSourceActions.delete(key);
	};
	sourceActionOwnership.set(permit, ownership);
	return permit;
}

/**
 * Compose one tracked import with its cleaner's existing single-source guard.
 * This is not reentrancy: only the original owner/source and one child may use
 * the capability. Early parent release waits for the child's actual settlement.
 */
export function acquireBorrowedQueueSourceAction(
	userId: string,
	item: RawQueueItem,
	permit: QueueSourceActionPermit,
): (() => void) | null {
	const ownership = sourceActionOwnership.get(permit);
	if (
		!ownership ||
		ownership.releaseRequested ||
		ownership.borrowed ||
		ownership.userId !== userId ||
		ownership.downloadKey !== queueDownloadKey(item) ||
		!activeSourceActions.has(ownership.key)
	)
		return null;
	ownership.borrowed = true;
	return () => {
		if (ownership.borrowSettled) return;
		ownership.borrowSettled = true;
		if (ownership.releaseRequested) activeSourceActions.delete(ownership.key);
	};
}

export function queueDownloadKey(item: RawQueueItem): string | null {
	if (typeof item.downloadId !== "string" || !item.downloadId.trim()) return null;
	return createHash("sha256")
		.update(normalizeDownloadId(item.downloadId) ?? item.downloadId)
		.digest("hex");
}

/** Changing the provider or its credentials cannot transfer old command authority. */
export function importConnectionFingerprint(instance: ServiceInstance): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				instance.userId,
				instance.id,
				instance.service,
				instance.baseUrl,
				instance.encryptedApiKey,
				instance.encryptionIv,
				instance.encryptedHttpAuthCredentials,
				instance.httpAuthEncryptionIv,
			]),
		)
		.digest("hex");
}
