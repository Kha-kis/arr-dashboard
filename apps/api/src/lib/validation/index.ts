/**
 * Validation Module — Public API
 *
 * This barrel export exposes the complete validation toolkit for upstream data.
 * When adding a new integration, import from this module:
 *
 * @example
 * ```ts
 * import {
 *   parseUpstream,
 *   parseUpstreamOrThrow,
 *   validateAndCollect,
 *   integrationHealth,
 *   KNOWN_INTEGRATIONS,
 * } from "../validation/index.js";
 * ```
 *
 * ## Adding a New Integration
 *
 * 1. Define Zod schemas using `z.looseObject()` (tolerates extra fields)
 * 2. Use `parseUpstreamOrThrow()` for single-item validation (e.g., API responses)
 * 3. Use `validateAndCollect()` for batch validation (e.g., JSON file arrays)
 * 4. Pass `{ integration: "your-name", category: "endpoint" }` for health tracking
 * 5. Add your integration name to `KNOWN_INTEGRATIONS` below
 * 6. Add fixture tests in `__tests__/upstream-fixtures.test.ts`
 */

// --- Single-item upstream validation (trust boundaries) ---
export {
	parseUpstream,
	parseUpstreamOrThrow,
	UpstreamValidationError,
	type UpstreamParseResult,
	type UpstreamParseSuccess,
	type UpstreamParseFailure,
	type UpstreamSource,
} from "./parse-upstream.js";

// --- Batch validation (arrays of items) ---
export {
	validateAndCollect,
	ValidationError,
	setValidationMode,
	getValidationMode,
	getAllValidationModes,
	resetValidationModes,
	type ValidationMode,
	type ValidateOptions,
	type ValidationResult,
	type ValidationStats,
	type Logger,
} from "./validate-batch.js";

// --- Health observability ---
export { integrationHealth, type IntegrationHealth, type AllIntegrationHealth } from "./integration-health.js";
export { schemaFingerprints } from "./schema-fingerprint.js";

// --- Known integrations ---

/**
 * Registry of known integration names for validation health tracking.
 *
 * When adding a new integration:
 * 1. Add its name here
 * 2. Use this name consistently in `parseUpstream`/`validateAndCollect` calls
 * 3. The validation health UI will automatically pick it up
 */
export const KNOWN_INTEGRATIONS = [
	"plex",
	"tautulli",
	"seerr",
	"trash-guides",
	"queue-cleaner",
] as const;

export type KnownIntegration = (typeof KNOWN_INTEGRATIONS)[number];
