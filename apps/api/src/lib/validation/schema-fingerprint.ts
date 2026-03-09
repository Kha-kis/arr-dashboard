/**
 * Schema Fingerprint & Drift Detection
 *
 * Tracks the set of field names seen in validated upstream data and detects
 * when the shape of that data changes (new fields added, existing fields removed).
 *
 * How it works:
 * 1. On each validation run, collect top-level field names from validated items
 * 2. First run for a category → store as "baseline"
 * 3. Subsequent runs → compare against baseline, log drift
 * 4. New fields = info (forward-compatible, expected from z.looseObject)
 * 5. Missing fields = warn (potential breaking change upstream)
 *
 * All state is in-memory — baselines reset on app restart, and the first
 * validation run after restart re-establishes them.
 */

import type { Logger } from "./validate-batch.js";

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
	/** Fields present in baseline but missing from current data */
	missingFields: string[];
	/** Whether any drift was detected */
	hasDrift: boolean;
}

export interface CategoryFingerprint {
	baseline: SchemaFingerprint;
	latest: SchemaFingerprint;
	drift: DriftReport;
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
		const fields = this.extractFields(items);
		const now = new Date().toISOString();
		const fingerprint: SchemaFingerprint = {
			fields,
			recordedAt: now,
			sampleCount: items.length,
		};

		const existing = this.data.get(key);

		if (!existing) {
			// First observation — establish baseline
			const drift: DriftReport = { newFields: [], missingFields: [], hasDrift: false };
			this.data.set(key, { baseline: fingerprint, latest: fingerprint, drift });
			return drift;
		}

		// Compare against baseline
		const drift = this.computeDrift(existing.baseline, fingerprint);

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
				`[schema-drift] ${key}: missing fields: ${drift.missingFields.join(", ")} — potential breaking change upstream`,
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

	/** Compare current fingerprint against baseline to find drift */
	private computeDrift(baseline: SchemaFingerprint, current: SchemaFingerprint): DriftReport {
		const baselineSet = new Set(baseline.fields);
		const currentSet = new Set(current.fields);

		const newFields = current.fields.filter((f) => !baselineSet.has(f));
		const missingFields = baseline.fields.filter((f) => !currentSet.has(f));

		return {
			newFields,
			missingFields,
			hasDrift: newFields.length > 0 || missingFields.length > 0,
		};
	}
}

/** Singleton schema fingerprint registry */
export const schemaFingerprints = new SchemaFingerprintRegistry();
