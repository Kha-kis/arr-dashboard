/**
 * Hunting Feature Constants (Frontend)
 *
 * These should match the backend constants in apps/api/src/lib/hunting/constants.ts
 */

// === INTERVAL MINIMUMS (in minutes) ===

/**
 * Minimum interval between missing content hunts (15 minutes)
 */
export const MIN_MISSING_INTERVAL_MINS = 15;

/**
 * Minimum interval between upgrade hunts (30 minutes)
 */
export const MIN_UPGRADE_INTERVAL_MINS = 30;

/**
 * Maximum interval between hunts (24 hours)
 */
export const MAX_INTERVAL_MINS = 1440;

// === BATCH SIZE LIMITS ===

/**
 * Minimum batch size (items per hunt)
 */
export const MIN_BATCH_SIZE = 1;

/**
 * Maximum batch size (items per hunt)
 */
export const MAX_BATCH_SIZE = 50;

// === RATE LIMITING ===

/**
 * Minimum hourly API cap
 */
export const MIN_HOURLY_API_CAP = 10;

/**
 * Maximum hourly API cap
 */
export const MAX_HOURLY_API_CAP = 500;

/**
 * Default hourly API cap
 */
export const DEFAULT_HOURLY_API_CAP = 100;

/**
 * Maximum queue threshold
 */
export const MAX_QUEUE_THRESHOLD = 100;

// === API MANAGEMENT ===

/**
 * API request timeout in seconds
 * All ARR API calls use this consistent timeout
 */
export const API_TIMEOUT_SECONDS = 120;

/**
 * API usage thresholds for visual indicators (percentage)
 */
export const API_USAGE_WARNING_THRESHOLD = 70;
export const API_USAGE_DANGER_THRESHOLD = 90;

// === SEARCH HISTORY / RE-SEARCH SETTINGS ===

/**
 * Default number of days before an item can be re-searched.
 */
export const DEFAULT_RESEARCH_AFTER_DAYS = 7;

/**
 * Minimum re-search interval (1 day)
 */
export const MIN_RESEARCH_AFTER_DAYS = 1;

/**
 * Maximum re-search interval (90 days)
 */
export const MAX_RESEARCH_AFTER_DAYS = 90;
