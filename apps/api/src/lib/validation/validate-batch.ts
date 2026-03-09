/**
 * Batch Validation Utilities
 *
 * Generic Zod-based batch validation for upstream data (APIs, caches, external JSON).
 * Validates arrays of items, logging and skipping invalid entries so one bad item
 * doesn't break the entire batch.
 *
 * Extracted from github-schemas.ts — no TRaSH-specific logic here.
 */

import type { z } from "zod";
import { schemaFingerprints } from "./schema-fingerprint.js";

// ============================================================================
// Types
// ============================================================================

export interface Logger {
	warn: (msg: string | object, ...args: unknown[]) => void;
	error: (msg: string | object, ...args: unknown[]) => void;
}

/** Validation stats returned alongside validated items */
export interface ValidationStats {
	total: number;
	validated: number;
	rejected: number;
}

/** Result of validateAndCollect — items array + validation stats */
export interface ValidationResult<T> {
	items: T[];
	stats: ValidationStats;
}

/**
 * Validation mode controls how strictly validation is enforced.
 *
 * - strict: Invalid items throw (fail the entire batch)
 * - tolerant: Invalid items are skipped with logging (default)
 * - log-only: All items pass through, but validation issues are logged
 * - disabled: No validation at all — raw data returned as-is
 */
export type ValidationMode = "strict" | "tolerant" | "log-only" | "disabled";

/** Optional configuration for validateAndCollect */
export interface ValidateOptions {
	/** Integration name for fingerprinting (e.g., "trash-guides", "plex") */
	integration?: string;
	/** Category name for fingerprinting (e.g., "customFormats", "sessions") */
	category?: string;
	/** Validation mode override. Defaults to "tolerant". */
	mode?: ValidationMode;
}

// ============================================================================
// Core Validation Function
// ============================================================================

/**
 * Validate raw data against a Zod schema, collecting valid items and skipping invalid ones.
 *
 * Handles both single-item and array responses (flattens to array).
 * Invalid items are logged and skipped — one bad item doesn't break the batch.
 * Escalates to error-level when all items fail or rejection rate exceeds 50%.
 *
 * When `options.integration` and `options.category` are provided, schema
 * fingerprinting is enabled — field names are tracked and drift is detected.
 */
export function validateAndCollect<T>(
	rawData: unknown,
	schema: z.ZodType<T>,
	fileName: string,
	log: Logger,
	options?: ValidateOptions,
): ValidationResult<T> {
	const mode = options?.mode ?? getValidationMode(options?.integration);
	const items = Array.isArray(rawData) ? rawData : [rawData];

	// Disabled mode: skip validation entirely (stats reflect no validation occurred)
	if (mode === "disabled") {
		return {
			items: items as T[],
			stats: { total: items.length, validated: 0, rejected: 0 },
		};
	}

	const results: T[] = [];
	const issues: string[] = [];

	for (let i = 0; i < items.length; i++) {
		const result = schema.safeParse(items[i]);
		if (result.success) {
			results.push(result.data);
		} else {
			const detail = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ");

			if (mode === "strict") {
				throw new ValidationError(
					`Validation failed for item ${i} in ${fileName}: ${detail}`,
				);
			}

			if (mode === "log-only") {
				// Log but still include the raw item
				log.warn(`Validation issue in item ${i} of ${fileName} (log-only mode): ${detail}`);
				results.push(items[i] as T);
			} else {
				// tolerant: skip invalid items
				log.warn(`Skipping invalid item ${i} in ${fileName}: ${detail}`);
				issues.push(detail);
			}
		}
	}

	const rejected = mode === "log-only" ? 0 : items.length - results.length;

	if (mode === "tolerant") {
		if (items.length > 0 && results.length === 0) {
			log.error(
				`All ${items.length} items failed validation in ${fileName} — upstream schema may have changed`,
			);
		} else if (items.length > 1 && rejected > items.length / 2) {
			log.warn(
				`High rejection rate in ${fileName}: ${rejected}/${items.length} items failed validation`,
			);
		}
	}

	// Schema fingerprinting (when integration + category are specified and items exist)
	if (options?.integration && options?.category && results.length > 0) {
		schemaFingerprints.record(options.integration, options.category, results, log);
	}

	return { items: results, stats: { total: items.length, validated: results.length, rejected } };
}

// ============================================================================
// Validation Mode Registry
// ============================================================================

/** Per-integration validation mode overrides (in-memory config) */
const modeOverrides = new Map<string, ValidationMode>();

/** Default mode used when no override is set */
const DEFAULT_MODE: ValidationMode = "tolerant";

/** Set the validation mode for a specific integration */
export function setValidationMode(integration: string, mode: ValidationMode): void {
	if (mode === "tolerant") {
		modeOverrides.delete(integration); // Remove override to use default
	} else {
		modeOverrides.set(integration, mode);
	}
}

/** Get the validation mode for a specific integration */
export function getValidationMode(integration?: string): ValidationMode {
	if (!integration) return DEFAULT_MODE;
	return modeOverrides.get(integration) ?? DEFAULT_MODE;
}

/** Get all validation mode overrides */
export function getAllValidationModes(): Record<string, ValidationMode> {
	const result: Record<string, ValidationMode> = {};
	for (const [k, v] of modeOverrides) {
		result[k] = v;
	}
	return result;
}

/** Reset all validation mode overrides to default */
export function resetValidationModes(): void {
	modeOverrides.clear();
}

// ============================================================================
// Error Class
// ============================================================================

/** Thrown in strict mode when validation fails */
export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}
