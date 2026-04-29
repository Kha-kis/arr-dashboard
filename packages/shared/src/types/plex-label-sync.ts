/**
 * Plex Label Sync — types for the rule-based mapping that auto-applies
 * Plex labels based on Sonarr/Radarr tags. See issue #384.
 */

export type ArrServiceForLabelSync = "sonarr" | "radarr";

export type PlexLabelSyncRunStatus = "success" | "partial" | "failed";

export interface PlexLabelSyncRule {
	id: string;
	userId: string;
	name: string;
	enabled: boolean;
	arrService: ArrServiceForLabelSync;
	/** null means "all instances of arrService" */
	arrInstanceId: string | null;
	arrTagName: string;
	plexInstanceId: string;
	plexLabel: string;
	lastRunAt: string | null;
	lastRunStatus: PlexLabelSyncRunStatus | null;
	lastRunMessage: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface CreatePlexLabelSyncRuleRequest {
	name: string;
	enabled?: boolean;
	arrService: ArrServiceForLabelSync;
	arrInstanceId?: string | null;
	arrTagName: string;
	plexInstanceId: string;
	plexLabel: string;
}

export interface UpdatePlexLabelSyncRuleRequest {
	name?: string;
	enabled?: boolean;
	arrService?: ArrServiceForLabelSync;
	arrInstanceId?: string | null;
	arrTagName?: string;
	plexInstanceId?: string;
	plexLabel?: string;
}

export interface PlexLabelSyncRulesResponse {
	rules: PlexLabelSyncRule[];
}

export interface PlexLabelSyncRuleResponse {
	rule: PlexLabelSyncRule;
}
