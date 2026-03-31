/**
 * Wizard-specific types for the TRaSH Guides quality profile wizard.
 *
 * These represent the *enriched projections* of TRaSH data as they flow
 * through the wizard — not the raw upstream types from @arr/shared.
 * Each type adds display metadata (displayName, description) and
 * wizard-specific state (scoreOverride, source, locked).
 */

import type { CustomFormatSpecification, TrashCustomFormat } from "@arr/shared";

// ============================================================================
// Custom Format Types
// ============================================================================

/** Source of a custom format in the wizard context */
export type WizardCFSource = "template" | "instance" | "trash" | "user_created";

/**
 * A custom format as represented in the wizard's mandatory/selected CF list.
 * Enriched with display metadata and wizard-specific scoring.
 */
export interface WizardCustomFormat {
	trash_id: string;
	name: string;
	displayName: string;
	description: string;
	defaultScore: number;
	scoreOverride?: number;
	score?: number;
	source: WizardCFSource;
	locked: boolean;
	required?: boolean;
	specifications?: CustomFormatSpecification[];
	originalConfig?: TrashCustomFormat | Record<string, unknown>;
}

/**
 * An available custom format in the catalog (for selection).
 * Lighter than WizardCustomFormat — no selection state.
 */
export interface WizardAvailableFormat {
	trash_id: string;
	name: string;
	displayName: string;
	description: string;
	score?: number;
	_source?: "user_created";
	originalConfig: TrashCustomFormat | Record<string, unknown>;
}

// ============================================================================
// CF Group Types
// ============================================================================

/** A custom format group enriched for wizard display */
export interface WizardCFGroup {
	trash_id: string;
	name: string;
	trash_description?: string;
	custom_formats: Array<
		| {
				name: string;
				trash_id: string;
				required: boolean;
				default?: string | boolean;
				defaultChecked?: boolean;
		  }
		| string
	>;
	default?: string | boolean;
	defaultEnabled?: boolean;
	required?: boolean;
	quality_profiles?: {
		include?: Record<string, string>;
		exclude?: Record<string, string>;
		score?: number;
	};
}

// ============================================================================
// Quality Item Types
// ============================================================================

/** A quality definition item for the quality group editor */
export interface WizardQualityItem {
	name: string;
	allowed: boolean;
	source?: string;
	resolution?: number;
	items?: string[];
}

// ============================================================================
// Configuration Result Types
// ============================================================================

/** Stats returned alongside CF configuration data */
export interface WizardCFStats {
	mandatoryCount: number;
	optionalGroupCount: number;
	totalOptionalCFs: number;
}

/** Profile summary included in normal/cloned mode results */
export interface WizardProfileSummary {
	name: string;
	upgradeAllowed?: boolean;
	cutoff?: string | number;
	minFormatScore?: number;
	cutoffFormatScore?: number;
	minUpgradeFormatScore?: number;
}

/**
 * The full result returned by useCFConfiguration's queryFn.
 * This is the union of all three modes (edit, cloned, normal).
 */
export interface WizardCFConfigurationResult {
	cfGroups: WizardCFGroup[];
	mandatoryCFs: WizardCustomFormat[];
	availableFormats: WizardAvailableFormat[];
	stats: WizardCFStats;
	qualityItems: WizardQualityItem[];
	/** Present in normal mode — the full profile detail response */
	profile?: WizardProfileSummary;
	/** Present in cloned mode */
	isClonedProfile?: boolean;
	/** Present in normal mode — TRaSH-specific fields */
	trashScoreSet?: string;
	cfDescriptions?: Record<string, { description: string; displayName: string }>;
	/** Spread from normal mode profileData */
	[key: string]: unknown;
}

// ============================================================================
// Template Types (for edit mode)
// ============================================================================

/** Template CF entry as stored in template.config.customFormats */
export interface TemplateCFEntry {
	trashId: string;
	name?: string;
	scoreOverride?: number;
	conditionsEnabled: Record<string, boolean>;
	originalConfig?: Record<string, unknown>;
}

/** Template CF group entry as stored in template.config.customFormatGroups */
export interface TemplateCFGroupEntry {
	trashId: string;
	name?: string;
	originalConfig?: Record<string, unknown>;
}

/** The shape of a template as passed to the wizard in edit mode */
export interface WizardEditingTemplate {
	id: string;
	name: string;
	serviceType: "RADARR" | "SONARR";
	config: Record<string, unknown> & {
		customFormats?: TemplateCFEntry[];
		customFormatGroups?: TemplateCFGroupEntry[];
		qualityProfile?: Record<string, unknown>;
	};
	[key: string]: unknown;
}

// ============================================================================
// Score Resolution
// ============================================================================

/** Callback type for resolving the effective score of a CF */
export type ResolveScoreFn = (
	cf: WizardCustomFormat | WizardAvailableFormat | Record<string, unknown>,
	fallback?: number,
) => number;
