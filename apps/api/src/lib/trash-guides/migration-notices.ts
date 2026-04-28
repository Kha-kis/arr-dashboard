/**
 * Registry of advisory notices for upstream TRaSH Guides restructures.
 *
 * When upstream renames/splits/regroups CF Groups in a way that's
 * functionally seamless for our trashId-keyed sync but visually
 * confusing in the diff preview, register an entry here so the diff
 * modal can narrate the linkage to the user.
 *
 * Trigger: presence of `keptGroupTrashId` in the user's template
 * customFormatGroups AND absence of `introducedGroupTrashId`. Once the
 * user has both groups, the migration is complete and the notice falls
 * silent — re-displaying it indefinitely would be misleading.
 */

import type { TemplateMigrationNotice } from "@arr/shared";

interface MigrationRegistryEntry {
	notice: TemplateMigrationNotice;
	serviceType: "RADARR" | "SONARR";
	keptGroupTrashId: string;
	introducedGroupTrashId: string;
}

const REGISTRY: readonly MigrationRegistryEntry[] = [
	{
		serviceType: "RADARR",
		// Radarr [Optional] Miscellaneous — preserved trash_id across the
		// optional-misc → optional-miscellaneous rename in upstream PR #2711.
		keptGroupTrashId: "9337080378236ce4c0b183e35790d2a7",
		// Radarr [Unwanted] Unwanted Formats — new in PR #2711, marked
		// default-enabled upstream so the merger auto-adopts on sync.
		introducedGroupTrashId: "a3ac6af01d78e4f21fcb75f601ac96df",
		notice: {
			id: "trash-pr-2711-radarr-unwanted-formats",
			title: "TRaSH split [Optional] Miscellaneous",
			body: "Upstream moved the unwanted-format CFs (3D, BR-DISK, LQ, etc.) into a new [Unwanted] Unwanted Formats group. The new group is default-enabled upstream, so syncing will keep the same CFs in your template — just sourced from a different group.",
			severity: "info",
		},
	},
	{
		serviceType: "SONARR",
		// Sonarr [Optional] Miscellaneous — preserved trash_id across the
		// optional-misc → optional-miscellaneous rename in upstream PR #2711.
		keptGroupTrashId: "f4a0410a1df109a66d6e47dcadcce014",
		// Sonarr [Unwanted] Unwanted Formats — new in PR #2711, marked
		// default-enabled upstream so the merger auto-adopts on sync.
		introducedGroupTrashId: "59c3af66780d08332fdc64e68297098f",
		notice: {
			id: "trash-pr-2711-sonarr-unwanted-formats",
			title: "TRaSH split [Optional] Miscellaneous",
			body: "Upstream moved the unwanted-format CFs (AV1, BR-DISK, LQ, etc.) into a new [Unwanted] Unwanted Formats group. The new group is default-enabled upstream, so syncing will keep the same CFs in your template — just sourced from a different group.",
			severity: "info",
		},
	},
];

/**
 * Return any migration notices applicable to a template based on the
 * group trashIds it currently contains. Suppresses notices for migrations
 * that are already complete (both kept and introduced groups present).
 */
export function getMigrationNotices(
	serviceType: "RADARR" | "SONARR",
	templateGroupTrashIds: ReadonlySet<string>,
): TemplateMigrationNotice[] {
	const matched: TemplateMigrationNotice[] = [];
	for (const entry of REGISTRY) {
		if (entry.serviceType !== serviceType) continue;
		if (!templateGroupTrashIds.has(entry.keptGroupTrashId)) continue;
		if (templateGroupTrashIds.has(entry.introducedGroupTrashId)) continue;
		matched.push(entry.notice);
	}
	return matched;
}
