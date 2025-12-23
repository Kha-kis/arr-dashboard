/**
 * Hunting Feature Constants
 *
 * Hardcoded minimum times and limits to prevent abuse and
 * overwhelming Sonarr/Radarr instances with too many requests.
 */

// === INTERVAL MINIMUMS (in minutes) ===
// These are the absolute minimum times between searches

/**
 * Minimum interval between missing content hunts (15 minutes)
 * This prevents excessive API calls when searching for new content.
 */
export const MIN_MISSING_INTERVAL_MINS = 15;

/**
 * Minimum interval between upgrade hunts (30 minutes)
 * Upgrade searches are less urgent, so we enforce a longer minimum.
 */
export const MIN_UPGRADE_INTERVAL_MINS = 30;

/**
 * Minimum cooldown between manual hunts of the same type (5 minutes)
 * Prevents users from spam-clicking "Run Now" buttons.
 */
export const MIN_MANUAL_HUNT_COOLDOWN_MINS = 5;

/**
 * Global minimum time between any hunts on the same instance (2 minutes)
 * Ensures we never hammer an instance with back-to-back requests.
 */
export const MIN_INSTANCE_COOLDOWN_MINS = 2;

// === INTERVAL MAXIMUMS (in minutes) ===

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
 * Higher values mean more API calls per hunt.
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
 * Default hourly API cap for new configs
 */
export const DEFAULT_HOURLY_API_CAP = 100;

/**
 * Delay between individual search commands within a hunt (30 seconds)
 * Prevents overwhelming indexers with simultaneous requests.
 * Each search command will wait this long before the next one fires.
 */
export const SEARCH_DELAY_MS = 30_000;

// === QUEUE THRESHOLDS ===

/**
 * Maximum queue threshold (skip hunting if queue exceeds this)
 */
export const MAX_QUEUE_THRESHOLD = 100;

/**
 * Default queue threshold for new configs
 */
export const DEFAULT_QUEUE_THRESHOLD = 25;

// === DEFAULT INTERVALS ===

/**
 * Default interval for missing hunts (60 minutes / 1 hour)
 */
export const DEFAULT_MISSING_INTERVAL_MINS = 60;

/**
 * Default interval for upgrade hunts (120 minutes / 2 hours)
 */
export const DEFAULT_UPGRADE_INTERVAL_MINS = 120;

/**
 * Default batch size for missing hunts
 */
export const DEFAULT_MISSING_BATCH_SIZE = 5;

/**
 * Default batch size for upgrade hunts
 */
export const DEFAULT_UPGRADE_BATCH_SIZE = 3;

// === SONARR SEARCH OPTIMIZATION ===

/**
 * Minimum episodes missing from a season to trigger a season search instead of episode search.
 * When 3+ episodes from the same season are missing, it's more efficient to search for
 * the entire season (catches season packs) rather than individual episodes.
 */
export const SEASON_SEARCH_THRESHOLD = 3;

// === SEARCH HISTORY / RE-SEARCH SETTINGS ===

/**
 * Default number of days before an item can be re-searched.
 * This prevents repeatedly searching for content that may not be available.
 */
export const DEFAULT_RESEARCH_AFTER_DAYS = 7;

/**
 * Minimum re-search interval (1 day)
 * Setting this too low defeats the purpose of tracking.
 */
export const MIN_RESEARCH_AFTER_DAYS = 1;

/**
 * Maximum re-search interval (90 days)
 * Beyond this, content availability is likely to have changed.
 */
export const MAX_RESEARCH_AFTER_DAYS = 90;

// === GRAB DETECTION ===

/**
 * Delay in milliseconds after triggering searches before checking for grabs in history.
 * This gives time for:
 * - Indexers to respond with results
 * - Sonarr/Radarr to evaluate and grab releases
 * - History event to be recorded
 *
 * We use history-based detection (checking /api/v3/history?eventType=grabbed)
 * rather than queue checking, which is more reliable because history persists
 * even after downloads complete, while queue items can disappear quickly.
 *
 * Default: 10 seconds
 */
export const GRAB_CHECK_DELAY_MS = 10_000;

// === HUNT SAFETY LIMITS ===

/**
 * Maximum duration for a single hunt execution in milliseconds.
 * If a hunt exceeds this duration, it will be automatically cancelled.
 * This prevents hunts from running indefinitely due to hung API calls or other issues.
 *
 * Default: 10 minutes (should be plenty for even large batch sizes with delays)
 */
export const MAX_HUNT_DURATION_MS = 10 * 60 * 1000;

/**
 * Interval for updating hunt progress in the database during execution.
 * This allows monitoring long-running hunts and detecting stuck ones.
 *
 * Default: 30 seconds
 */
export const HUNT_PROGRESS_UPDATE_INTERVAL_MS = 30_000;
