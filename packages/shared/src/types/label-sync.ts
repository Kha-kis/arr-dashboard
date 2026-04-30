/**
 * Label Sync — generic types for the rule-based mapping that auto-applies
 * tags/labels across media services. Source service can be Sonarr/Radarr
 * (sub-arc 1) and will expand to Plex/Jellyfin/Emby in sub-arc 3;
 * destination service is currently Plex with Jellyfin/Emby/*arr coming
 * in sub-arc 2. See issue #384 + memory/label-sync-generalization-arc.md.
 */

export type LabelSyncSourceService = "sonarr" | "radarr";
// Will expand to "lidarr" | "plex" | "jellyfin" | "emby" in later sub-arcs

export type LabelSyncDestService = "plex";
// Will expand to "jellyfin" | "emby" | "sonarr" | "radarr" | "lidarr" in later sub-arcs

export type LabelSyncRunStatus = "success" | "partial" | "failed";

export interface LabelSyncRule {
	id: string;
	userId: string;
	name: string;
	enabled: boolean;

	/** Where to read the tag/label from */
	sourceService: LabelSyncSourceService;
	/** null means "all instances of sourceService" */
	sourceInstanceId: string | null;
	sourceTagName: string;

	/** Where to apply the matching tag/label */
	destService: LabelSyncDestService;
	destInstanceId: string;
	destTagName: string;

	lastRunAt: string | null;
	lastRunStatus: LabelSyncRunStatus | null;
	lastRunMessage: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface CreateLabelSyncRuleRequest {
	name: string;
	enabled?: boolean;
	sourceService: LabelSyncSourceService;
	sourceInstanceId?: string | null;
	sourceTagName: string;
	destService?: LabelSyncDestService;
	destInstanceId: string;
	destTagName: string;
}

export interface UpdateLabelSyncRuleRequest {
	name?: string;
	enabled?: boolean;
	sourceService?: LabelSyncSourceService;
	sourceInstanceId?: string | null;
	sourceTagName?: string;
	destService?: LabelSyncDestService;
	destInstanceId?: string;
	destTagName?: string;
}

export interface LabelSyncRulesResponse {
	rules: LabelSyncRule[];
}

export interface LabelSyncRuleResponse {
	rule: LabelSyncRule;
}
