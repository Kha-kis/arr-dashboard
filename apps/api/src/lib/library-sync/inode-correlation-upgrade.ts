import type { PrismaClient } from "../prisma.js";

/** New writes are distinguishable from pre-ownership-proof inode correlations. */
export const CURRENT_INODE_SOURCE = "inode-v2";

/** Stored inode hashes are hints until the current index confirms them. */
export function isStoredInodeSource(source: string | null | undefined): boolean {
	return source === "inode" || source === CURRENT_INODE_SOURCE;
}

/**
 * Retire derived correlations that may have come from an unbounded shared
 * save-directory walk. A transaction prevents a partially upgraded database
 * from becoming request-visible if either table update fails. The old label
 * is never written again, so later startups are idempotent no-ops.
 */
export async function retireLegacyInodeCorrelations(
	prisma: PrismaClient,
): Promise<{ libraryRows: number; episodeRows: number }> {
	return prisma.$transaction(
		async (tx) => {
			const where = { infoHashSource: "inode" };
			const data = {
				infoHash: null,
				infoHashSource: null,
				torrentState: null,
				torrentRatio: null,
				torrentSyncedAt: null,
			};
			const library = await tx.libraryCache.updateMany({ where, data });
			const episode = await tx.episodeFileCache.updateMany({ where, data });
			return { libraryRows: library.count, episodeRows: episode.count };
		},
		{ timeout: 60_000 },
	);
}
