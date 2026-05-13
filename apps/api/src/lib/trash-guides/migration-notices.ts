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
 *
 * Anchor (`keptGroupTrashId`) choice — two valid patterns:
 *   1. **Split-source anchor**: the group the introduced CFs were pulled
 *      out of. Use when the split is global (every user with the
 *      kept group is in scope). Example: #2711 anchors on
 *      [Optional] Miscellaneous because the unwanted CFs were pulled
 *      out of it.
 *   2. **Audience-marker anchor**: a different group that signals the
 *      user is in scope for the migration, even if the introduced CFs
 *      did not literally come from it. Use when the split is scoped to
 *      a sub-audience (e.g. language-specific). Example: #2719/#2721
 *      anchor on [Release Groups] German/French because the upstream
 *      split pulled language-specific CFs out of the generic unwanted
 *      group, but firing the notice for every English-only user would
 *      be noise. The language-presence anchor scopes correctly.
 *
 * If you "fix" an audience-marker anchor back to a split-source anchor
 * without understanding this distinction, you'll create false positives.
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
	{
		serviceType: "RADARR",
		// Radarr [Release Groups] German — anchor for German-focused templates.
		keptGroupTrashId: "bc85e56ee3bd0f01467866d5f1261543",
		// Radarr [Unwanted] Unwanted Formats German — new in PR #2719, marked
		// default-enabled upstream so the merger auto-adopts on sync.
		introducedGroupTrashId: "0ca61b4b233178d07113082a7acff72d",
		notice: {
			id: "trash-pr-2719-radarr-german-unwanted",
			title: "TRaSH split German unwanted formats",
			body: "Upstream split the German-specific unwanted-format CFs into a dedicated [Unwanted] Unwanted Formats German group. The new group is default-enabled upstream, so syncing will keep the same CFs in your template — just sourced from a German-specific group.",
			severity: "info",
		},
	},
	{
		serviceType: "SONARR",
		// Sonarr [Release Groups] German — anchor for German-focused templates.
		keptGroupTrashId: "cae54a0be4f9773169e82e129dd1fcfb",
		// Sonarr [Unwanted] Unwanted Formats German — new in PR #2719, marked
		// default-enabled upstream so the merger auto-adopts on sync.
		introducedGroupTrashId: "6f0872eebfc95b1f93474b7ac866ced0",
		notice: {
			id: "trash-pr-2719-sonarr-german-unwanted",
			title: "TRaSH split German unwanted formats",
			body: "Upstream split the German-specific unwanted-format CFs into a dedicated [Unwanted] Unwanted Formats German group. The new group is default-enabled upstream, so syncing will keep the same CFs in your template — just sourced from a German-specific group.",
			severity: "info",
		},
	},
	{
		serviceType: "RADARR",
		// Radarr [Release Groups] French — anchor for French-focused templates.
		keptGroupTrashId: "12a919c8a5e2342db6e9c0b4e3c0756e",
		// Radarr [Unwanted] Unwanted Formats French — new in PR #2721, marked
		// default-enabled upstream so the merger auto-adopts on sync.
		introducedGroupTrashId: "59f7ab9ff64d0026b011b985b1cc8670",
		notice: {
			id: "trash-pr-2721-radarr-french-unwanted",
			title: "TRaSH split French unwanted formats",
			body: "Upstream split the French-specific unwanted-format CFs into a dedicated [Unwanted] Unwanted Formats French group. The new group is default-enabled upstream, so syncing will keep the same CFs in your template — just sourced from a French-specific group.",
			severity: "info",
		},
	},
	{
		serviceType: "SONARR",
		// Sonarr [Release Groups] French — anchor for French-focused templates.
		keptGroupTrashId: "9fa0bf3c8f8f00154431c3323a29eef2",
		// Sonarr [Unwanted] Unwanted Formats French — new in PR #2721, marked
		// default-enabled upstream so the merger auto-adopts on sync.
		introducedGroupTrashId: "a23c8675c79118544fd74153394fa589",
		notice: {
			id: "trash-pr-2721-sonarr-french-unwanted",
			title: "TRaSH split French unwanted formats",
			body: "Upstream split the French-specific unwanted-format CFs into a dedicated [Unwanted] Unwanted Formats French group. The new group is default-enabled upstream, so syncing will keep the same CFs in your template — just sourced from a French-specific group.",
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
