/**
 * Serializes dashboard-initiated Prowlarr indexer updates across all configured
 * instances, including aliases of the same server. Prowlarr requires a full
 * resource PUT, so a second writer must not fetch until the first writer's
 * read/write/readback sequence has ended. Stable 2.x supports one API process
 * per database but does not enforce that topology; this in-process guard does
 * not coordinate unsupported multi-API deployments or external Prowlarr edits.
 */
let pendingUpdate: Promise<void> = Promise.resolve();

export async function withProwlarrIndexerUpdateGuard<T>(operation: () => Promise<T>): Promise<T> {
	const previous = pendingUpdate;
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	pendingUpdate = current;

	await previous;
	try {
		return await operation();
	} finally {
		release();
	}
}
