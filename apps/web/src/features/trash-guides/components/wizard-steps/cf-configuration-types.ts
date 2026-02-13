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
