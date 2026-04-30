/**
 * Label-sync UI service registry.
 *
 * Single source of truth for the dropdown options on either side of a rule.
 * Keep `LabelSyncService` (in @arr/shared) and this list in lockstep —
 * adding a new service requires both edits.
 */

import type { LabelSyncService } from "@arr/shared";

export interface LabelSyncServiceOption {
	value: LabelSyncService;
	/** Human-readable label shown in dropdowns and rule tables. */
	label: string;
	/** Lowercase service slug used to match `ServiceInstanceSummary.service`. */
	matchSlug: string;
}

export const LABEL_SYNC_SERVICE_OPTIONS: readonly LabelSyncServiceOption[] = [
	{ value: "sonarr", label: "Sonarr", matchSlug: "sonarr" },
	{ value: "radarr", label: "Radarr", matchSlug: "radarr" },
	{ value: "plex", label: "Plex", matchSlug: "plex" },
	{ value: "jellyfin", label: "Jellyfin", matchSlug: "jellyfin" },
	{ value: "emby", label: "Emby", matchSlug: "emby" },
];

export const SERVICE_LABEL_BY_VALUE: Record<LabelSyncService, string> =
	LABEL_SYNC_SERVICE_OPTIONS.reduce(
		(acc, option) => {
			acc[option.value] = option.label;
			return acc;
		},
		{} as Record<LabelSyncService, string>,
	);
