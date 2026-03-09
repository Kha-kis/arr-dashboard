/**
 * Shared Upstream Validation Helper
 *
 * Single-item validation for data arriving from upstream APIs (Plex, Tautulli,
 * Seerr, GitHub, etc.) at trust boundaries.
 *
 * Uses safeParse — never throws raw ZodError. Returns a discriminated union
 * result with structured error details. Automatically records to the
 * IntegrationHealthRegistry for observability.
 *
 * For batch validation of arrays (e.g., TRaSH JSON files), use
 * `validateAndCollect` from `./validate-batch.js` instead.
 *
 * @example
 * ```ts
 * const result = parseUpstream(raw, mySchema, { integration: "plex", category: "/library/sections" });
 * if (!result.success) {
 *   log.warn({ err: result.error }, "Upstream validation failed");
 *   return fallback;
 * }
 * return result.data; // fully typed T
 * ```
 */

import type { z } from "zod";
import { integrationHealth } from "./integration-health.js";

// ============================================================================
// Types
// ============================================================================

export interface UpstreamSource {
	/** Integration name (e.g., "plex", "seerr", "tautulli", "trash-guides") */
	integration: string;
	/** Category within the integration (e.g., "/library/sections", "getStatus") */
	category: string;
}

export interface UpstreamParseSuccess<T> {
	success: true;
	data: T;
}

export interface UpstreamParseFailure {
	success: false;
	error: UpstreamValidationError;
}

export type UpstreamParseResult<T> = UpstreamParseSuccess<T> | UpstreamParseFailure;

// ============================================================================
// Error Class
// ============================================================================

/**
 * Structured error for upstream validation failures.
 *
 * Unlike raw ZodError, this carries integration/category metadata and
 * a pre-formatted array of human-readable issue strings. Designed to be
 * caught by generic error handlers without leaking Zod internals.
 */
export class UpstreamValidationError extends Error {
	override readonly name = "UpstreamValidationError";

	constructor(
		message: string,
		/** Which integration produced the invalid data */
		readonly integration: string,
		/** Which endpoint/category within the integration */
		readonly category: string,
		/** Human-readable validation issues (e.g., "status: Expected number, received string") */
		readonly issues: string[],
	) {
		super(message);
	}
}

// ============================================================================
// Core Helper
// ============================================================================

/**
 * Validate a single upstream payload against a Zod schema using safeParse.
 *
 * - Never throws — returns a discriminated union result
 * - Records success/failure to IntegrationHealthRegistry
 * - On failure, returns a structured UpstreamValidationError with issue details
 *
 * @param raw - The raw upstream data to validate
 * @param schema - Zod schema to validate against
 * @param source - Integration + category metadata for health tracking
 * @returns Discriminated union: `{ success: true, data: T }` or `{ success: false, error }`
 */
export function parseUpstream<T>(
	raw: unknown,
	schema: z.ZodType<T>,
	source: UpstreamSource,
): UpstreamParseResult<T> {
	const result = schema.safeParse(raw);

	if (result.success) {
		integrationHealth.record(source.integration, source.category, {
			total: 1,
			validated: 1,
			rejected: 0,
		});
		return { success: true, data: result.data };
	}

	const issues = result.error.issues.map(
		(issue) => `${issue.path.join(".")}: ${issue.message}`,
	);

	integrationHealth.record(source.integration, source.category, {
		total: 1,
		validated: 0,
		rejected: 1,
	});

	return {
		success: false,
		error: new UpstreamValidationError(
			`Upstream validation failed [${source.integration}/${source.category}]: ${issues.join("; ")}`,
			source.integration,
			source.category,
			issues,
		),
	};
}

/**
 * Validate a single upstream payload and throw on failure.
 *
 * Convenience wrapper for code paths that want to throw on validation failure
 * but still want structured errors (UpstreamValidationError) instead of raw ZodError.
 *
 * - Records to IntegrationHealthRegistry (success or failure)
 * - Throws UpstreamValidationError on failure (never raw ZodError)
 *
 * @param raw - The raw upstream data to validate
 * @param schema - Zod schema to validate against
 * @param source - Integration + category metadata for health tracking
 * @returns The validated data (type T)
 * @throws UpstreamValidationError on validation failure
 */
export function parseUpstreamOrThrow<T>(
	raw: unknown,
	schema: z.ZodType<T>,
	source: UpstreamSource,
): T {
	const result = parseUpstream(raw, schema, source);
	if (!result.success) throw result.error;
	return result.data;
}
