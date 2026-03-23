/**
 * Centralized polling intervals for React Query refetchInterval.
 * Changing these affects how often the UI polls for fresh data.
 */

/** Real-time activity (now playing, active streams) */
export const POLLING_REALTIME = 15_000; // 15s

/** Active operations (queue, hunt in progress, active cleanup) */
export const POLLING_ACTIVE = 30_000; // 30s

/** Standard refresh (history, calendar, channel status) */
export const POLLING_STANDARD = 60_000; // 60s

/** Dashboard statistics and aggregates */
export const POLLING_STATS = 120_000; // 2min

/** Background data (library list, seerr health, notification config) */
export const POLLING_BACKGROUND = 300_000; // 5min

/** Fast polling for active operations (hunting in progress, cleaner running) */
export const POLLING_FAST = 5_000; // 5s
