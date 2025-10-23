/**
 * ARR Sync → Template Overlay Migration Helper
 *
 * Converts legacy ArrSyncSettings to the new TemplateOverlay format.
 *
 * Migration mapping:
 * - presets[] → includes[]
 * - overrides.customFormats{} where enabled=false → excludes[]
 * - overrides.customFormats{} with scoreOverride → overrides{} with score field
 * - overrides.scores{} → merged into overrides{} with score field
 */

import type {
	ArrSyncSettings,
	CustomFormatOverride,
} from "@arr/shared";
import type { TemplateOverlayDto, CfOverride } from "@arr/shared";

/**
 * Convert ArrSyncSettings to TemplateOverlayDto
 *
 * @param settings - Legacy ArrSyncSettings
 * @returns Converted TemplateOverlayDto
 */
export function migrateArrSyncToTemplateOverlay(
	settings: ArrSyncSettings,
): TemplateOverlayDto {
	const includes: string[] = [];
	const excludes: string[] = [];
	const overrides: Record<string, CfOverride> = {};

	// Phase 1: Map presets to includes
	// Presets are template identifiers in the old system
	if (settings.presets && settings.presets.length > 0) {
		includes.push(...settings.presets);
	}

	// Phase 2: Process custom format overrides
	if (settings.overrides?.customFormats) {
		for (const [cfId, cfOverride] of Object.entries(
			settings.overrides.customFormats,
		)) {
			// If CF is disabled, add to excludes
			if (cfOverride.enabled === false) {
				excludes.push(cfId);
				continue; // Don't process further if excluded
			}

			// Build override object
			const override: CfOverride = {};

			// Map scoreOverride to score
			if (cfOverride.scoreOverride !== undefined) {
				override.score = cfOverride.scoreOverride;
			}

			// Note: addTerms/removeTerms don't have a direct mapping
			// These would need to be handled via spec overrides in the new system
			// For now, add a comment in the migration guide

			// Only add to overrides if there's actual data
			if (Object.keys(override).length > 0) {
				overrides[cfId] = override;
			}
		}
	}

	// Phase 3: Process score overrides
	// These are per-CF score adjustments
	if (settings.overrides?.scores) {
		for (const [cfName, score] of Object.entries(settings.overrides.scores)) {
			// Merge with existing override or create new one
			if (overrides[cfName]) {
				overrides[cfName].score = score;
			} else {
				overrides[cfName] = { score };
			}
		}
	}

	return {
		includes,
		excludes,
		overrides,
	};
}

/**
 * Generate a migration report for user review
 *
 * @param settings - Legacy ArrSyncSettings
 * @returns Human-readable migration report
 */
export function generateMigrationReport(settings: ArrSyncSettings): {
	summary: string;
	details: string[];
	warnings: string[];
	converted: TemplateOverlayDto;
} {
	const details: string[] = [];
	const warnings: string[] = [];

	const converted = migrateArrSyncToTemplateOverlay(settings);

	// Summary
	let summary = "ARR Sync → Template Overlay Migration";

	// Details
	if (converted.includes.length > 0) {
		details.push(
			`✓ Migrated ${converted.includes.length} template(s): ${converted.includes.join(", ")}`,
		);
	}

	if (converted.excludes.length > 0) {
		details.push(
			`✓ Migrated ${converted.excludes.length} exclusion(s): ${converted.excludes.join(", ")}`,
		);
	}

	if (Object.keys(converted.overrides).length > 0) {
		details.push(
			`✓ Migrated ${Object.keys(converted.overrides).length} override(s)`,
		);
		for (const [cfId, override] of Object.entries(converted.overrides)) {
			const changes = [];
			if (override.score !== undefined) changes.push(`score=${override.score}`);
			if (override.name) changes.push(`name="${override.name}"`);
			if (override.tags) changes.push(`tags=[${override.tags.join(", ")}]`);
			details.push(`  - ${cfId}: ${changes.join(", ")}`);
		}
	}

	// Warnings
	if (settings.overrides?.customFormats) {
		for (const [cfId, cfOverride] of Object.entries(
			settings.overrides.customFormats,
		)) {
			if (cfOverride.addTerms && cfOverride.addTerms.length > 0) {
				warnings.push(
					`⚠ CF "${cfId}" has addTerms (${cfOverride.addTerms.length} term(s)) - these must be manually converted to spec overrides`,
				);
			}
			if (cfOverride.removeTerms && cfOverride.removeTerms.length > 0) {
				warnings.push(
					`⚠ CF "${cfId}" has removeTerms (${cfOverride.removeTerms.length} term(s)) - these must be manually converted to spec overrides`,
				);
			}
		}
	}

	if (settings.overrides?.profiles && Object.keys(settings.overrides.profiles).length > 0) {
		warnings.push(
			`⚠ Quality profile overrides (${Object.keys(settings.overrides.profiles).length}) are not migrated - please reconfigure in Custom Formats → Scoring tab`,
		);
	}

	// If no changes, add note
	if (details.length === 0) {
		details.push("No settings to migrate (empty configuration)");
	}

	return {
		summary,
		details,
		warnings,
		converted,
	};
}

/**
 * Validate that a migration is safe to apply
 *
 * @param settings - Legacy ArrSyncSettings
 * @returns Validation result
 */
export function validateMigration(settings: ArrSyncSettings): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	// Check if settings are empty
	if (
		(!settings.presets || settings.presets.length === 0) &&
		(!settings.overrides?.customFormats ||
			Object.keys(settings.overrides.customFormats).length === 0) &&
		(!settings.overrides?.scores ||
			Object.keys(settings.overrides.scores).length === 0)
	) {
		errors.push("No settings to migrate (configuration is empty)");
	}

	// Check for unsupported features
	if (settings.overrides?.customFormats) {
		for (const [cfId, cfOverride] of Object.entries(
			settings.overrides.customFormats,
		)) {
			if (cfOverride.addTerms && cfOverride.addTerms.length > 0) {
				errors.push(
					`CF "${cfId}" uses addTerms which requires manual migration to spec overrides`,
				);
			}
			if (cfOverride.removeTerms && cfOverride.removeTerms.length > 0) {
				errors.push(
					`CF "${cfId}" uses removeTerms which requires manual migration to spec overrides`,
				);
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}
