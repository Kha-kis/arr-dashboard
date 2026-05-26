/**
 * Library Cleanup × qui seeding gate (Phase 2.2).
 *
 * When `LibraryCleanupConfig.respectQuiSeeding` is enabled, the cleanup
 * candidate query must exclude items currently seeding/downloading via
 * qui. This honors operator-significant seeding obligations — private
 * trackers, ratio targets, manual seed-pinning — without arr-dashboard
 * having to model those obligations directly. qui already knows.
 *
 * Sibling of `lib/queue-cleaner/qui-gate.ts` (which gates the strike
 * loop on qui state). Both feature-bound `lib/<feature>/qui-*.ts` files
 * keep cross-feature qui dependencies near their consumers — `lib/qui/`
 * stays focused on pure-qui-client logic and doesn't grow tendrils into
 * every feature that reads qui state.
 *
 * No-op semantics for users without qui: their `LibraryCache` rows all
 * carry NULL `torrentState`, the OR clause keeps NULL candidates in the
 * set, and the filter has zero behavioral impact.
 */

/**
 * qui torrent states that mean "actively obligated; don't touch."
 * Distinct from `lib/queue-cleaner/qui-gate.ts:GATED_STATES`, which
 * keys on "paused/error" (qui or operator is already acting). The two
 * features key on different state subsets on purpose — cleanup is
 * "should we proceed with removal" while queue-cleaner is "should we
 * proceed with strikes."
 */
const SEEDING_STATES = ["seeding", "downloading"] as const;

/**
 * Shape of the WHERE clause this filter contributes to. Kept narrow so
 * the caller doesn't need to import a Prisma WhereInput type (which is
 * generated code and changes across schema updates).
 */
export interface CleanupBaseWhere {
	instanceId: { in: string[] };
	OR?: object[];
}

/**
 * Mutate the WHERE clause to skip rows qui has confirmed are seeding,
 * while keeping NULL-state rows (users without qui configured, or items
 * qui doesn't know about) in the candidate set.
 *
 * Returns the same object reference for chainability — the function is
 * intentionally side-effectful because the call site is building one
 * cumulative WHERE across multiple optional gates.
 */
export function applyQuiSeedingFilter(
	baseWhere: CleanupBaseWhere,
	respectQuiSeeding: boolean,
): CleanupBaseWhere {
	if (!respectQuiSeeding) return baseWhere;
	baseWhere.OR = [{ torrentState: null }, { torrentState: { notIn: [...SEEDING_STATES] } }];
	return baseWhere;
}
