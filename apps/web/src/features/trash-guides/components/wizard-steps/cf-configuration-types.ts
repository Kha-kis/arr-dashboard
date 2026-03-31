/** Selection state for a single custom format in the wizard */
export interface CFSelectionState {
	selected: boolean;
	scoreOverride?: number;
	conditionsEnabled: Record<string, boolean>;
}

/** The subset of custom format data needed by the condition editor */
export interface ConditionEditorFormat {
	name: string;
	displayName?: string;
	specifications?: unknown[];
	originalConfig?: {
		specifications?: unknown[];
	};
}

/** Target for the condition editor modal */
export interface ConditionEditorTarget {
	trashId: string;
	format: ConditionEditorFormat;
}

/** CF resolution decision when merging instance CFs with TRaSH template */
export type CFResolutionDecision = "use_trash" | "keep_instance";

/** Resolved CF data to be passed forward from the cf-resolution step */
export interface ResolvedCF {
	instanceCFId: number;
	instanceCFName: string;
	decision: CFResolutionDecision;
	/** If decision is use_trash, this contains the TRaSH CF trash_id */
	trashId?: string;
	/** Recommended score from TRaSH if applicable */
	recommendedScore?: number;
	/** Original instance score */
	instanceScore?: number;
}
