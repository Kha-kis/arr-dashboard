/**
 * TRaSH Guides Shared Utilities
 *
 * Common utility functions used across trash-guides modules.
 */

import type { FastifyBaseLogger } from "fastify";
import { loggers } from "../logger.js";
import { getErrorMessage } from "../utils/error-message.js";

const log = loggers.trashGuides;

/** Strip newlines to prevent log injection (forged log entries) */
function sanitizeForLog(value: string): string {
	return value.replace(/[\r\n]/g, "");
}

// ============================================================================
// JSON Parsing
// ============================================================================

/**
 * Context for JSON parsing error logging
 */
export interface JsonParseContext {
	source: string; // e.g., "TrashCacheManager", "TemplateService"
	identifier: string; // e.g., templateId, "RADARR/CUSTOM_FORMATS"
	field?: string; // Optional field name
}

/**
 * Safely parse JSON string with error handling and logging.
 * Consolidates duplicate safeJsonParse implementations across the codebase.
 *
 * @param value - The JSON string to parse (handles null/undefined)
 * @param context - Context for error logging
 * @param logger - Optional Fastify logger (falls back to console if not provided)
 * @returns Parsed data or undefined if parsing fails
 */
export function safeJsonParse<T>(
	value: string | null | undefined,
	context: JsonParseContext,
	logger?: FastifyBaseLogger,
): T | undefined {
	if (value === null || value === undefined) {
		return undefined;
	}

	try {
		return JSON.parse(value) as T;
	} catch (error) {
		const safeId = sanitizeForLog(context.identifier);
		const safeSource = sanitizeForLog(context.source);
		const message = `[${safeSource}] Failed to parse JSON for ${safeId}${context.field ? `, field: ${sanitizeForLog(context.field)}` : ""}`;
		const details = {
			dataSize: value.length,
			error: getErrorMessage(error),
		};

		if (logger) {
			logger.warn(details, message);
		} else {
			log.warn(details, message);
		}

		return undefined;
	}
}

// ============================================================================
// Instance Override Parsing
// ============================================================================

/**
 * Parse instance overrides JSON from template.
 * Returns empty object on null/undefined input or parse failure.
 *
 * @param instanceOverrides - Raw JSON string from database
 * @param context - Context for error logging
 * @param logger - Optional Fastify logger
 * @returns Parsed overrides or empty object
 */
export function parseInstanceOverrides(
	instanceOverrides: string | null | undefined,
	context: { templateId: string; operation: string },
	logger?: FastifyBaseLogger,
): Record<string, unknown> {
	if (!instanceOverrides) {
		return {};
	}

	try {
		return JSON.parse(instanceOverrides);
	} catch (error) {
		const safeTemplateId = sanitizeForLog(context.templateId);
		const message = `Malformed instanceOverrides JSON for template ${safeTemplateId} during ${sanitizeForLog(context.operation)}`;
		if (logger) {
			logger.warn({ templateId: safeTemplateId, error }, message);
		} else {
			log.warn({ templateId: safeTemplateId, err: error }, message);
		}
		return {};
	}
}

// ============================================================================
// Field Transformation
// ============================================================================

/**
 * Field entry type for specification fields.
 * Represents a single field with name and value.
 */
export interface FieldEntry {
	name: string;
	value: unknown;
}

/**
 * Transform specification fields from object format to array format.
 * This matches the format expected by Radarr/Sonarr API.
 *
 * TRaSH format: { value: 5 }
 * Radarr format: [{ name: "value", value: 5 }]
 *
 * @param fields - Fields in object or array format
 * @returns Fields in array format
 */
export function transformFieldsToArray(
	fields: Record<string, unknown> | FieldEntry[] | null | undefined,
): FieldEntry[] {
	// If fields is already an array, return it as-is
	if (Array.isArray(fields)) {
		return fields;
	}

	// If fields is undefined or null, return empty array
	if (!fields) {
		return [];
	}

	// Convert object format to array format
	return Object.entries(fields).map(([name, value]) => ({
		name,
		value,
	}));
}
