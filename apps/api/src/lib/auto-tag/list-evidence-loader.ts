import type { PrismaClient } from "../prisma.js";
import { listMembershipKey, type ListMembershipKey } from "../library-cleanup/types.js";

export const LIST_EVIDENCE_FRESHNESS_MS = 12 * 60 * 60 * 1000;

export interface CompleteListEvidence {
	memberships: Map<string, Set<ListMembershipKey>>;
	completedAt: Date | null;
}

/**
 * Load only rows belonging to each list's current successful complete
 * generation. A status without a pointer, stale metadata, count mismatch,
 * invalid media type, or interrupted replacement makes the whole requested
 * provider inventory unavailable so negative membership remains UNKNOWN.
 */
export async function loadCompleteListEvidence(
	prisma: PrismaClient,
	userId: string,
	provider: "tmdb" | "trakt",
	listKeys: readonly string[],
	now: Date = new Date(),
): Promise<CompleteListEvidence | undefined> {
	const keys = [...new Set(listKeys)].sort();
	if (keys.length === 0) return { memberships: new Map(), completedAt: null };

	return await prisma.$transaction(async (tx) => {
		const statuses = await tx.listCacheRefreshStatus.findMany({
			where: { userId, provider, listKey: { in: keys } },
			orderBy: { listKey: "asc" },
		});
		if (
			statuses.length !== keys.length ||
			statuses.some(
				(status) =>
					status.lastResult !== "success" ||
					status.lastAttemptResult !== "success" ||
					status.lastErrorMessage !== null ||
					status.lastAttemptErrorMessage !== null ||
					!status.generationId ||
					!status.lastRefreshedAt ||
					now.getTime() - status.lastRefreshedAt.getTime() > LIST_EVIDENCE_FRESHNESS_MS,
			)
		) {
			return undefined;
		}

		const memberships = new Map<string, Set<ListMembershipKey>>();
		for (const status of statuses) {
			const rows =
				provider === "tmdb"
					? await tx.tmdbListCache.findMany({
							where: {
								userId,
								listId: status.listKey,
								generation: status.generationId!,
							},
							select: { tmdbId: true, mediaType: true },
						})
					: await tx.traktListCache.findMany({
							where: {
								userId,
								listSlug: status.listKey,
								generation: status.generationId!,
							},
							select: { tmdbId: true, mediaType: true },
						});
			if (rows.length !== status.itemCount) return undefined;
			const values = new Set<ListMembershipKey>();
			for (const row of rows) {
				if (row.mediaType !== "movie" && row.mediaType !== "series") return undefined;
				const key = listMembershipKey(row.mediaType, row.tmdbId);
				if (values.has(key)) return undefined;
				values.add(key);
			}
			memberships.set(status.listKey, values);
		}
		return {
			memberships,
			completedAt: new Date(
				Math.min(...statuses.map((status) => status.lastRefreshedAt!.getTime())),
			),
		};
	});
}
