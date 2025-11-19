/**
 * Template Sharing Types
 *
 * Enhanced types for template export/import with metadata and validation
 */

export interface TemplateExportFormat {
	// Format version
	version: string;

	// Export metadata
	exportedAt: string;
	exportedBy?: string;

	// Template data
	template: {
		name: string;
		description: string | null;
		serviceType: "RADARR" | "SONARR";
		config: any; // TemplateConfig from trash-guides.ts

		// Enhanced metadata
		metadata?: TemplateMetadata;
	};
}

export interface TemplateMetadata {
	// Author information
	author?: string;
	authorUrl?: string;

	// Classification
	tags?: string[];
	category?: "anime" | "movies" | "tv" | "remux" | "web" | "general";

	// Version tracking
	trashGuidesVersion?: string;
	lastSync?: string;

	// Compatibility
	compatibleWith?: string[]; // ["radarr-v4", "radarr-v5", "sonarr-v3"]
	minimumVersion?: string;

	// Usage stats
	usageCount?: number;
	lastUpdated?: string;

	// Source tracking
	sourceTemplate?: string; // ID of template this was cloned from
	sourceInstance?: string; // ID of instance this was imported from

	// Notes
	notes?: string;
	changeLog?: string;
}

export interface TemplateImportValidation {
	valid: boolean;
	errors: ValidationError[];
	warnings: ValidationWarning[];
	conflicts: TemplateConflict[];
}

export interface ValidationError {
	field: string;
	message: string;
	severity: "error";
}

export interface ValidationWarning {
	field: string;
	message: string;
	severity: "warning";
	suggestion?: string;
}

export interface TemplateConflict {
	type: "name" | "customFormat" | "qualityProfile" | "version";
	message: string;
	existingValue?: any;
	incomingValue?: any;
	resolution?: "rename" | "replace" | "merge" | "skip";
}

export interface TemplateImportOptions {
	// Conflict resolution
	onNameConflict?: "rename" | "replace" | "cancel";
	onCustomFormatConflict?: "merge" | "replace" | "skip";
	onQualityProfileConflict?: "merge" | "replace" | "skip";

	// Import filters
	includeQualitySettings?: boolean;
	includeCustomConditions?: boolean;
	includeMetadata?: boolean;

	// Validation
	strictValidation?: boolean;
	allowPartialImport?: boolean;
}

export interface TemplateExportOptions {
	// Export filters
	includeQualitySettings?: boolean;
	includeCustomConditions?: boolean;
	includeMetadata?: boolean;

	// Metadata overrides
	author?: string;
	tags?: string[];
	category?: TemplateMetadata["category"];
	notes?: string;
}

export interface TemplateCompatibility {
	compatible: boolean;
	issues: CompatibilityIssue[];
}

export interface CompatibilityIssue {
	type: "version" | "service" | "customFormat" | "feature";
	severity: "error" | "warning" | "info";
	message: string;
	affectedFeatures?: string[];
}
