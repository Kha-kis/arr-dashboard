/**
 * CF Conflict Checker
 *
 * Pure utility that cross-references a set of selected custom format trash_ids
 * against upstream TRaSH Guides conflict groups to detect mutually exclusive selections.
 */

import type { TrashConflictGroup } from "@arr/shared";

export interface CFConflictWarning {
	groupMembers: Array<{ trashId: string; name: string }>;
	message: string;
}

/**
 * Check whether any selected CFs belong to the same mutual exclusion group.
 * Returns one warning per violated group, listing all selected members.
 *
 * This is a pure function — no I/O, no cache access.
 */
export function checkMutualExclusions(
	selectedTrashIds: Set<string>,
	conflictGroups: TrashConflictGroup[],
): CFConflictWarning[] {
	const warnings: CFConflictWarning[] = [];

	for (const group of conflictGroups) {
		const selectedMembers = group.members.filter((m) => selectedTrashIds.has(m.trashId));

		if (selectedMembers.length >= 2) {
			const names = selectedMembers.map((m) => `"${m.name}"`).join(" and ");
			warnings.push({
				groupMembers: selectedMembers.map((m) => ({ trashId: m.trashId, name: m.name })),
				message: `Mutually exclusive Custom Formats selected: ${names}. These CFs conflict with each other — using both may cause unexpected scoring behavior.`,
			});
		}
	}

	return warnings;
}
