/**
 * Template Merge Engine
 * Deterministic and idempotent merging of custom format templates
 *
 * Pipeline:
 * 1. Start with baseCFs (current state from ARR instance)
 * 2. Merge includes[] templates (last-win semantics)
 * 3. Remove excludes[] (by trash_id or local CF ID)
 * 4. Apply overrides{} (deep patch per CF)
 * 5. Compute diff (added/removed/modified/unchanged)
 */

import type { CfOverride, CfChange, TemplateChangeType } from "@arr/shared";
import crypto from "node:crypto";

// ============================================================================
// Types
// ============================================================================

/**
 * Custom Format (simplified for merging)
 */
export interface CustomFormat {
	id?: number; // Local ARR ID (omit for new CFs)
	trash_id?: string; // TRaSH ID (if from TRaSH)
	name: string;
	includeCustomFormatWhenRenaming?: boolean;
	specifications?: Array<{
		name: string;
		implementation: string;
		negate?: boolean;
		required?: boolean;
		fields?: Record<string, any>;
	}>;
	[key: string]: any; // Allow additional fields
}

/**
 * Template Source
 */
export interface Template {
	id: string; // Template ID (e.g. "trash-anime", "trash-x265")
	name: string; // Display name
	customFormats: CustomFormat[];
}

/**
 * Merge Context
 */
export interface MergeContext {
	baseCFs: CustomFormat[]; // Current CFs from ARR instance
	templates: Template[]; // Available templates (fetched from TRaSH, etc.)
	includes: string[]; // Template IDs to merge
	excludes: string[]; // CF IDs to skip (trash_id or local id)
	overrides: Record<string, CfOverride>; // Per-CF overrides (keyed by trash_id or name)
}

/**
 * Merge Result
 */
export interface MergeResult {
	resolvedCFs: CustomFormat[]; // Final merged CF set
	changes: CfChange[]; // Structured diff
	warnings: string[];
	errors: string[];
}

// ============================================================================
// Deterministic Merge Engine
// ============================================================================

/**
 * Compute CF hash for change detection
 */
function computeCfHash(cf: CustomFormat): string {
	// Hash the CF content (excluding id and timestamps)
	const { id, ...content } = cf;
	const json = JSON.stringify(content, Object.keys(content).sort());
	return crypto.createHash("sha256").update(json).digest("hex").slice(0, 16);
}

/**
 * Get CF identifier (use id first for stability, then trash_id, then name)
 */
function getCfIdentifier(cf: CustomFormat): string {
	if (cf.id !== undefined) {
		return `id:${cf.id}`;
	}
	if (cf.trash_id) {
		return `trash:${cf.trash_id}`;
	}
	return `name:${cf.name}`;
}

/**
 * Deep merge two objects (for spec overrides)
 */
function deepMerge(target: any, source: any): any {
	if (
		typeof target !== "object" ||
		target === null ||
		typeof source !== "object" ||
		source === null
	) {
		return source;
	}

	const result = { ...target };
	for (const key in source) {
		if (Object.prototype.hasOwnProperty.call(source, key)) {
			if (
				typeof source[key] === "object" &&
				source[key] !== null &&
				!Array.isArray(source[key])
			) {
				result[key] = deepMerge(target[key], source[key]);
			} else {
				result[key] = source[key];
			}
		}
	}
	return result;
}

/**
 * Apply override to a custom format
 */
function applyOverride(cf: CustomFormat, override: CfOverride): CustomFormat {
	const result = { ...cf };

	// Apply simple field overrides
	if (override.name !== undefined) {
		result.name = override.name;
	}
	if (override.score !== undefined) {
		result.score = override.score;
	}
	if (override.tags !== undefined) {
		result.tags = override.tags;
	}

	// Apply spec deep patch
	if (override.spec !== undefined && result.specifications) {
		result.specifications = result.specifications.map((spec) => ({
			...spec,
			fields: deepMerge(spec.fields || {}, override.spec || {}),
		}));
	}

	// Apply quality profile links (not used in ARR API but tracked in overlay)
	if (override.qualityProfileLinks !== undefined) {
		result.qualityProfileLinks = override.qualityProfileLinks;
	}

	return result;
}

/**
 * Compare two CFs and generate human-readable change descriptions
 */
function computeChangeDescriptions(
	before: CustomFormat | undefined,
	after: CustomFormat | undefined,
): string[] {
	const changes: string[] = [];

	if (!before && after) {
		// Added
		changes.push(`Added custom format: ${after.name}`);
		if (after.trash_id) {
			changes.push(`TRaSH ID: ${after.trash_id}`);
		}
		if (after.specifications && after.specifications.length > 0) {
			changes.push(
				`Specifications: ${after.specifications.length} term(s)`,
			);
		}
		return changes;
	}

	if (before && !after) {
		// Removed
		changes.push(`Removed custom format: ${before.name}`);
		return changes;
	}

	if (before && after) {
		// Modified
		if (before.name !== after.name) {
			changes.push(`Renamed: "${before.name}" → "${after.name}"`);
		}

		if ((before.score || 0) !== (after.score || 0)) {
			changes.push(`Score: ${before.score || 0} → ${after.score || 0}`);
		}

		const beforeSpecs = before.specifications?.length || 0;
		const afterSpecs = after.specifications?.length || 0;
		if (beforeSpecs !== afterSpecs) {
			changes.push(`Specifications: ${beforeSpecs} → ${afterSpecs}`);
		}

		if (changes.length === 0) {
			changes.push("Specification details changed");
		}
	}

	return changes;
}

/**
 * Resolve templates by merging includes[] with deterministic ordering
 *
 * @param context - Merge context with base CFs and template selections
 * @returns Merged CF set
 */
export function resolveTemplates(context: MergeContext): MergeResult {
	const { baseCFs, templates, includes, excludes, overrides } = context;
	const warnings: string[] = [];
	const errors: string[] = [];

	// Phase 1: Start with base CFs
	let workingSet = new Map<string, CustomFormat>();
	for (const cf of baseCFs) {
		const id = getCfIdentifier(cf);
		workingSet.set(id, { ...cf });
	}

	// Phase 2: Merge includes[] templates (last-win semantics)
	for (const templateId of includes) {
		const template = templates.find((t) => t.id === templateId);
		if (!template) {
			warnings.push(`Template not found: ${templateId}`);
			continue;
		}

		for (const cf of template.customFormats) {
			const id = getCfIdentifier(cf);
			// Last-win: later templates override earlier ones
			workingSet.set(id, { ...cf });
		}
	}

	// Phase 3: Remove excludes[]
	const excludeSet = new Set(excludes);
	for (const [id, cf] of workingSet.entries()) {
		const shouldExclude =
			// Check by trash_id
			(cf.trash_id && excludeSet.has(cf.trash_id)) ||
			// Check by local ID
			(cf.id !== undefined && excludeSet.has(cf.id.toString())) ||
			// Check by name
			excludeSet.has(cf.name) ||
			// Check by full identifier (with prefix)
			excludeSet.has(id);

		if (shouldExclude) {
			workingSet.delete(id);
		}
	}

	// Phase 4: Apply overrides{}
	for (const [id, cf] of workingSet.entries()) {
		const cfId = getCfIdentifier(cf);
		const override =
			overrides[cfId] || overrides[cf.name] || overrides[cf.id?.toString() || ""];

		if (override) {
			const patched = applyOverride(cf, override);
			workingSet.set(id, patched);
		}
	}

	// Phase 5: Compute diff
	const resolvedCFs = Array.from(workingSet.values());
	const changes = computeDiff(baseCFs, resolvedCFs);

	return {
		resolvedCFs,
		changes,
		warnings,
		errors,
	};
}

/**
 * Compute structured diff between old and new CF sets
 */
export function computeDiff(
	oldCFs: CustomFormat[],
	newCFs: CustomFormat[],
): CfChange[] {
	const changes: CfChange[] = [];

	// Build maps for efficient lookup
	const oldMap = new Map<string, CustomFormat>();
	const newMap = new Map<string, CustomFormat>();

	for (const cf of oldCFs) {
		oldMap.set(getCfIdentifier(cf), cf);
	}

	for (const cf of newCFs) {
		newMap.set(getCfIdentifier(cf), cf);
	}

	// Find added and modified CFs
	for (const [id, newCf] of newMap.entries()) {
		const oldCf = oldMap.get(id);

		if (!oldCf) {
			// Added
			changes.push({
				cfId: id,
				name: newCf.name,
				changeType: "added" as TemplateChangeType,
				changes: computeChangeDescriptions(undefined, newCf),
				after: newCf,
			});
		} else {
			// Check if modified
			const oldHash = computeCfHash(oldCf);
			const newHash = computeCfHash(newCf);

			if (oldHash !== newHash) {
				changes.push({
					cfId: id,
					name: newCf.name,
					changeType: "modified" as TemplateChangeType,
					changes: computeChangeDescriptions(oldCf, newCf),
					before: oldCf,
					after: newCf,
				});
			} else {
				changes.push({
					cfId: id,
					name: newCf.name,
					changeType: "unchanged" as TemplateChangeType,
					changes: [],
					before: oldCf,
					after: newCf,
				});
			}
		}
	}

	// Find removed CFs
	for (const [id, oldCf] of oldMap.entries()) {
		if (!newMap.has(id)) {
			changes.push({
				cfId: id,
				name: oldCf.name,
				changeType: "removed" as TemplateChangeType,
				changes: computeChangeDescriptions(oldCf, undefined),
				before: oldCf,
			});
		}
	}

	// Sort for deterministic output (added, modified, removed, unchanged)
	const typeOrder: Record<TemplateChangeType, number> = {
		added: 0,
		modified: 1,
		removed: 2,
		unchanged: 3,
	};

	changes.sort((a, b) => {
		const typeCompare = typeOrder[a.changeType] - typeOrder[b.changeType];
		if (typeCompare !== 0) return typeCompare;
		return a.name.localeCompare(b.name);
	});

	return changes;
}

/**
 * Validate merge context
 */
export function validateMergeContext(context: MergeContext): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	if (!context.baseCFs || !Array.isArray(context.baseCFs)) {
		errors.push("baseCFs must be an array");
	}

	if (!context.templates || !Array.isArray(context.templates)) {
		errors.push("templates must be an array");
	}

	if (!context.includes || !Array.isArray(context.includes)) {
		errors.push("includes must be an array");
	}

	if (!context.excludes || !Array.isArray(context.excludes)) {
		errors.push("excludes must be an array");
	}

	if (!context.overrides || typeof context.overrides !== "object") {
		errors.push("overrides must be an object");
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}
