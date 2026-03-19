/**
 * Account Helpers
 *
 * Pure functions for deduplicating Plex user account names
 * aggregated from multiple instances.
 */

/**
 * Deduplicate and sort account names from an aggregated result.
 * Handles mixed-type arrays (filters to strings only) and returns
 * a sorted unique list.
 */
export function deduplicateAccounts(aggregated: unknown[]): string[] {
	const allUsers = new Set<string>();
	for (const name of aggregated) {
		if (typeof name === "string") allUsers.add(name);
	}
	return [...allUsers].sort();
}
