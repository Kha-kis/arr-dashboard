/**
 * Diff Engine - Computes differences between remote and desired state
 * Generates a deterministic sync plan
 */

import type {
	CustomFormat,
	QualityProfile,
	ArrSyncOverrides,
} from "@arr/shared";
import type {
	SyncPlan,
	DiffItem,
	RemoteState,
	TrashCustomFormat,
} from "../types.js";

export interface DiffOptions {
	instanceId: string;
	instanceLabel: string;
	remoteState: RemoteState;
	desiredCustomFormats: TrashCustomFormat[];
	overrides: ArrSyncOverrides;
	allowDeletes: boolean;
}

/**
 * Compute a sync plan by diffing remote and desired state
 */
export function computeSyncPlan(options: DiffOptions): SyncPlan {
	const {
		instanceId,
		instanceLabel,
		remoteState,
		desiredCustomFormats,
		overrides,
		allowDeletes,
	} = options;

	const warnings: string[] = [];
	const errors: string[] = [];

	// Diff custom formats
	const customFormats = diffCustomFormats(
		remoteState.customFormats,
		desiredCustomFormats,
		overrides,
		allowDeletes,
	);

	// Diff quality profiles (simplified for now)
	const qualityProfiles = diffQualityProfiles(
		remoteState.qualityProfiles,
		desiredCustomFormats,
		overrides,
	);

	// Add warnings for ambiguous matches
	if (customFormats.updates.some((u) => u.changes.includes("ambiguous"))) {
		warnings.push(
			"Some custom formats have ambiguous matches and require manual review",
		);
	}

	return {
		instanceId,
		instanceLabel,
		customFormats,
		qualityProfiles,
		warnings,
		errors,
	};
}

/**
 * Diff custom formats
 */
function diffCustomFormats(
	remote: CustomFormat[],
	desired: TrashCustomFormat[],
	overrides: ArrSyncOverrides,
	allowDeletes: boolean,
): {
	creates: DiffItem<CustomFormat>[];
	updates: DiffItem<CustomFormat>[];
	deletes: DiffItem<CustomFormat>[];
} {
	const creates: DiffItem<CustomFormat>[] = [];
	const updates: DiffItem<CustomFormat>[] = [];
	const deletes: DiffItem<CustomFormat>[] = [];

	// Normalize names for comparison (case-insensitive, trimmed)
	const remoteByName = new Map(
		remote.map((cf) => [normalizeName(cf.name), cf]),
	);
	const desiredByName = new Map(
		desired.map((cf) => [normalizeName(cf.name), cf]),
	);

	// Find creates and updates
	for (const desiredCf of desired) {
		const normalizedName = normalizeName(desiredCf.name);
		const remoteCf = remoteByName.get(normalizedName);

		// Apply overrides
		const override = overrides.customFormats[desiredCf.name];
		if (override?.enabled === false) {
			continue; // Skip disabled formats
		}

		// Convert TRaSH format to ARR format
		const desiredArrFormat: CustomFormat = {
			name: desiredCf.name,
			includeCustomFormatWhenRenaming:
				desiredCf.includeCustomFormatWhenRenaming ?? false,
			specifications: applyTermOverrides(
				desiredCf.specifications,
				override,
			),
		};

		if (!remoteCf) {
			// Create
			creates.push({
				name: desiredCf.name,
				action: "create",
				changes: ["New custom format"],
				desired: desiredArrFormat,
			});
		} else {
			// Update if different
			const changes = detectCustomFormatChanges(
				remoteCf,
				desiredArrFormat,
			);
			if (changes.length > 0) {
				updates.push({
					name: desiredCf.name,
					existingId: remoteCf.id,
					action: "update",
					changes,
					current: remoteCf,
					desired: desiredArrFormat,
				});
			}
		}
	}

	// Find deletes (only if explicitly allowed)
	if (allowDeletes) {
		for (const remoteCf of remote) {
			const normalizedName = normalizeName(remoteCf.name);
			if (!desiredByName.has(normalizedName)) {
				deletes.push({
					name: remoteCf.name,
					existingId: remoteCf.id,
					action: "delete",
					changes: ["No longer in TRaSH guides"],
					current: remoteCf,
				});
			}
		}
	}

	return { creates, updates, deletes };
}

/**
 * Diff quality profiles (simplified - just update scores)
 */
function diffQualityProfiles(
	remote: QualityProfile[],
	desiredCustomFormats: TrashCustomFormat[],
	overrides: ArrSyncOverrides,
): {
	creates: DiffItem<QualityProfile>[];
	updates: DiffItem<QualityProfile>[];
} {
	const updates: DiffItem<QualityProfile>[] = [];

	// For each remote profile, check if custom format scores need updating
	for (const profile of remote) {
		const changes: string[] = [];
		const updatedFormatItems = [...(profile.formatItems || [])];

		// Check each desired custom format
		for (const cf of desiredCustomFormats) {
			const desiredScore =
				overrides.scores[cf.name] ||
				cf.trash_scores?.default ||
				0;

			const existingItem = updatedFormatItems.find(
				(item) => normalizeName(item.name) === normalizeName(cf.name),
			);

			if (existingItem && existingItem.score !== desiredScore) {
				existingItem.score = desiredScore;
				changes.push(
					`Update ${cf.name} score: ${existingItem.score} → ${desiredScore}`,
				);
			}
		}

		if (changes.length > 0) {
			updates.push({
				name: profile.name,
				existingId: profile.id,
				action: "update",
				changes,
				current: profile,
				desired: {
					...profile,
					formatItems: updatedFormatItems,
				},
			});
		}
	}

	return { creates: [], updates };
}

/**
 * Detect changes between two custom formats
 */
function detectCustomFormatChanges(
	current: CustomFormat,
	desired: CustomFormat,
): string[] {
	const changes: string[] = [];

	// Check rename flag
	if (
		current.includeCustomFormatWhenRenaming !==
		desired.includeCustomFormatWhenRenaming
	) {
		changes.push("Include in rename flag changed");
	}

	// Check specifications count
	if (
		current.specifications.length !== desired.specifications.length
	) {
		changes.push(
			`Specification count: ${current.specifications.length} → ${desired.specifications.length}`,
		);
	}

	// Deep spec comparison (simplified)
	const currentSpecs = JSON.stringify(
		sortSpecifications(current.specifications),
	);
	const desiredSpecs = JSON.stringify(
		sortSpecifications(desired.specifications),
	);

	if (currentSpecs !== desiredSpecs) {
		changes.push("Specifications modified");
	}

	return changes;
}

/**
 * Apply term overrides from settings
 */
function applyTermOverrides(specifications: any[], override: any): any[] {
	if (!override) {
		return specifications;
	}

	let result = [...specifications];

	// Add terms
	if (override.addTerms && override.addTerms.length > 0) {
		for (const term of override.addTerms) {
			result.push({
				implementation: "ReleaseTitleSpecification",
				name: term,
				negate: false,
				required: false,
				fields: { value: term },
			});
		}
	}

	// Remove terms (simplified)
	if (override.removeTerms && override.removeTerms.length > 0) {
		result = result.filter(
			(spec) => !override.removeTerms.includes(spec.name),
		);
	}

	return result;
}

/**
 * Normalize name for comparison
 */
function normalizeName(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * Sort specifications for deterministic comparison
 */
function sortSpecifications(specs: any[]): any[] {
	return [...specs].sort((a, b) => {
		const aKey = `${a.implementation}-${a.name}`;
		const bKey = `${b.implementation}-${b.name}`;
		return aKey.localeCompare(bKey);
	});
}

/**
 * Verify plan idempotency by checking if applying it would result in no further changes
 */
export function verifyIdempotency(
	plan: SyncPlan,
	remoteState: RemoteState,
): boolean {
	// After applying the plan, the remote state should match desired state
	// For now, a simple check: if plan has no creates/updates/deletes, it's idempotent
	const hasChanges =
		plan.customFormats.creates.length > 0 ||
		plan.customFormats.updates.length > 0 ||
		plan.customFormats.deletes.length > 0 ||
		plan.qualityProfiles.creates.length > 0 ||
		plan.qualityProfiles.updates.length > 0;

	return !hasChanges;
}
