import type { QuiClient } from "./client-factory.js";

const HASH_PATTERN = /^[a-fA-F0-9]{40,64}$/;
const UNVERIFIED_TARGET = "qUI action target could not be verified";

/**
 * Resolve every action target from qUI immediately before a mutation.
 * Neither a previously rendered row nor the numeric instance in the URL is
 * sufficient authority to mutate a torrent, especially after a reconnect.
 */
export async function assertQuiActionTargets(
	client: Pick<QuiClient, "listInstances" | "getTorrentsByHash">,
	qbitInstanceId: number,
	hashes: readonly string[],
): Promise<void> {
	if (!Number.isSafeInteger(qbitInstanceId) || qbitInstanceId <= 0 || hashes.length === 0) {
		throw new Error(UNVERIFIED_TARGET);
	}
	const normalized = hashes.map((hash) => hash.toLowerCase());
	if (normalized.some((hash) => !HASH_PATTERN.test(hash))) {
		throw new Error(UNVERIFIED_TARGET);
	}
	if (new Set(normalized).size !== normalized.length) {
		throw new Error("qUI action selection contains duplicate hashes");
	}

	try {
		const instances = await client.listInstances();
		if (
			instances.filter(
				(instance) => instance.id === qbitInstanceId && instance.connected && instance.isActive,
			).length !== 1
		) {
			throw new Error(UNVERIFIED_TARGET);
		}
		for (const hash of normalized) {
			const matches = await client.getTorrentsByHash(hash);
			if (
				matches.filter(
					(torrent) => torrent.hash.toLowerCase() === hash && torrent.instanceId === qbitInstanceId,
				).length !== 1
			) {
				throw new Error(UNVERIFIED_TARGET);
			}
		}
	} catch {
		// Provider errors can contain connection details. The caller may log
		// a category, but the action response must not echo those details.
		throw new Error(UNVERIFIED_TARGET);
	}
}
