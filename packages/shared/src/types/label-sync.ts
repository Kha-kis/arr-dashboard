/**
 * Label Sync — generic types for the rule-based mapping that auto-applies
 * tags/labels across media services. Source and destination unions are
 * intentionally identical: a rule may target the same service on both
 * sides (e.g., Plex → Plex) as well as cross-service flows. Lidarr is
 * deferred — see issue #384 + memory/label-sync-generalization-arc.md.
 */

export type LabelSyncService = "sonarr" | "radarr" | "plex" | "jellyfin" | "emby";

export type LabelSyncSourceService = LabelSyncService;
export type LabelSyncDestService = LabelSyncService;

export type LabelSyncRunStatus = "success" | "partial" | "failed";

export const DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE =
	"destination_mutation_authority_unavailable" as const;

export const DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE_MESSAGE =
	"Emby label destinations are temporarily unavailable because the provider cannot yet be re-authorized safely at execution time.";

export type LabelSyncDestinationMutationCapability =
	| { supported: true }
	| {
			supported: false;
			code: typeof DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE;
			message: typeof DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE_MESSAGE;
	  };

/** Destination mutation authority is separate from source-reader support. */
export function getLabelSyncDestinationMutationCapability(
	service: string,
): LabelSyncDestinationMutationCapability {
	if (service === "emby") {
		return {
			supported: false,
			code: DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE,
			message: DESTINATION_MUTATION_AUTHORITY_UNAVAILABLE_MESSAGE,
		};
	}

	return { supported: true };
}

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
	destinationMutationCapability: LabelSyncDestinationMutationCapability;

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
	destService: LabelSyncDestService;
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
