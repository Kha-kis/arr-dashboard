/**
 * Schema Fingerprint & Drift Detection
 *
 * Tracks the set of field names seen in validated upstream data and detects
 * when the shape of that data changes (new fields added, existing fields removed).
 *
 * **Union strategy** — the baseline grows to include all fields ever observed.
 * This reduces false-positive drift from optional upstream fields:
 *
 * 1. On each validation run, collect top-level field names from validated items
 * 2. New fields are added to the baseline union immediately (reported as newFields)
 * 3. Missing fields increment a per-field miss counter
 * 4. A field is only reported as "missing" after 3+ consecutive absences
 * 5. When a field reappears, its miss counter resets to 0
 *
 * All state is in-memory — baselines reset on app restart, and the first
 * validation run after restart re-establishes them.
 */

import type { Logger } from "./validate-batch.js";

// ============================================================================
// Constants
// ============================================================================

/** Number of consecutive misses before a field is flagged as missing */
const MISSING_THRESHOLD = 3;

// ============================================================================
// Types
// ============================================================================

export interface SchemaFingerprint {
	/** Sorted set of field names seen across all items */
	fields: string[];
	/** ISO timestamp when this fingerprint was first recorded */
	recordedAt: string;
	/** Number of items sampled to build this fingerprint */
	sampleCount: number;
}

export interface DriftReport {
	/** Fields present in current data but not in the baseline */
	newFields: string[];
	/** Fields in baseline that have been missing for 3+ consecutive observations */
	missingFields: string[];
	/** Whether any drift was detected */
	hasDrift: boolean;
}

export interface CategoryFingerprint {
	baseline: SchemaFingerprint;
	latest: SchemaFingerprint;
	drift: DriftReport;
	/** Per-field consecutive miss counts (only for fields that have been absent) */
	fieldMissCounts: Record<string, number>;
}

// ============================================================================
// Registry
// ============================================================================

class SchemaFingerprintRegistry {
	/** Map<"integration:category", CategoryFingerprint> */
	private readonly data = new Map<string, CategoryFingerprint>();

	/**
	 * Record a fingerprint for validated items and detect drift.
	 *
	 * @param integration - e.g., "trash-guides", "seerr", "plex"
	 * @param category - e.g., "customFormats", "history", "sessions"
	 * @param items - validated items (plain objects) to fingerprint
	 * @param log - logger for drift alerts
	 */
	record(integration: string, category: string, items: unknown[], log: Logger): DriftReport {
		const key = `${integration}:${category}`;
		const currentFields = this.extractFields(items);
		const now = new Date().toISOString();
		const fingerprint: SchemaFingerprint = {
			fields: currentFields,
			recordedAt: now,
			sampleCount: items.length,
		};

		const existing = this.data.get(key);

		if (!existing) {
			// First observation — establish baseline
			const drift: DriftReport = { newFields: [], missingFields: [], hasDrift: false };
			this.data.set(key, {
				baseline: fingerprint,
				latest: fingerprint,
				drift,
				fieldMissCounts: {},
			});
			return drift;
		}

		const currentSet = new Set(currentFields);
		const baselineSet = new Set(existing.baseline.fields);

		// Detect new fields (in current but not in baseline union)
		const newFields = currentFields.filter((f) => !baselineSet.has(f));

		// Grow baseline union with new fields
		if (newFields.length > 0) {
			const mergedFields = new Set([...existing.baseline.fields, ...newFields]);
			existing.baseline = {
				...existing.baseline,
				fields: [...mergedFields].sort(),
			};
		}

		// Update miss counters for all baseline fields
		const missCounts = { ...existing.fieldMissCounts };
		for (const field of existing.baseline.fields) {
			if (currentSet.has(field)) {
				// Present — reset miss counter
				delete missCounts[field];
			} else {
				// Absent — increment miss counter
				missCounts[field] = (missCounts[field] ?? 0) + 1;
			}
		}
		existing.fieldMissCounts = missCounts;

		// Only flag as missing if miss count >= threshold
		const missingFields = Object.entries(missCounts)
			.filter(([, count]) => count >= MISSING_THRESHOLD)
			.map(([field]) => field)
			.sort();

		const drift: DriftReport = {
			newFields,
			missingFields,
			hasDrift: newFields.length > 0 || missingFields.length > 0,
		};

		// Update latest + drift
		existing.latest = fingerprint;
		existing.drift = drift;

		// Log drift
		if (drift.newFields.length > 0) {
			log.warn(
				`[schema-drift] ${key}: new fields detected: ${drift.newFields.join(", ")} — upstream may have added new data`,
			);
		}
		if (drift.missingFields.length > 0) {
			log.warn(
				`[schema-drift] ${key}: missing fields (${MISSING_THRESHOLD}+ consecutive absences): ${drift.missingFields.join(", ")} — potential breaking change upstream`,
			);
		}

		return drift;
	}

	/** Get fingerprint data for a specific integration+category */
	get(integration: string, category: string): CategoryFingerprint | undefined {
		return this.data.get(`${integration}:${category}`);
	}

	/** Get all fingerprints for an integration */
	getByIntegration(integration: string): Record<string, CategoryFingerprint> {
		const result: Record<string, CategoryFingerprint> = {};
		for (const [key, value] of this.data) {
			if (key.startsWith(`${integration}:`)) {
				const category = key.slice(integration.length + 1);
				result[category] = value;
			}
		}
		return result;
	}

	/** Get all fingerprint data */
	getAll(): Record<string, Record<string, CategoryFingerprint>> {
		const result: Record<string, Record<string, CategoryFingerprint>> = {};
		for (const [key, value] of this.data) {
			const colonIdx = key.indexOf(":");
			const integration = key.slice(0, colonIdx);
			const category = key.slice(colonIdx + 1);
			if (!result[integration]) result[integration] = {};
			result[integration][category] = value;
		}
		return result;
	}

	/** Reset fingerprints for a specific integration */
	resetIntegration(integration: string): void {
		for (const key of this.data.keys()) {
			if (key.startsWith(`${integration}:`)) {
				this.data.delete(key);
			}
		}
	}

	/** Reset all fingerprints */
	reset(): void {
		this.data.clear();
	}

	// ============================================================================
	// Private Helpers
	// ============================================================================

	/**
	 * Extract the union of top-level field names from an array of items.
	 * Returns a sorted, deduplicated array.
	 */
	private extractFields(items: unknown[]): string[] {
		const fieldSet = new Set<string>();
		for (const item of items) {
			if (item !== null && typeof item === "object" && !Array.isArray(item)) {
				for (const key of Object.keys(item)) {
					fieldSet.add(key);
				}
			}
		}
		return [...fieldSet].sort();
	}
}

/** Singleton schema fingerprint registry */
export const schemaFingerprints = new SchemaFingerprintRegistry();
