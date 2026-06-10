/**
 * Cache Health Helpers
 *
 * Pure functions for building cache health response items from
 * CacheRefreshStatus rows.
 */

import type { CacheHealthItem } from "@arr/shared";

const MAX_ERROR_MESSAGE_LENGTH = 200;

/** Strip internal file paths from error messages before returning to the client */
export function sanitizeErrorMessage(msg: string | null): string | null {
	if (!msg) return null;
	return msg.replace(/\/[\w./-]+\.(ts|js|mjs)/g, "[path]").slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/** Input row shape from CacheRefreshStatus query */
export interface CacheRefreshStatusRow {
	instanceId: string;
	cacheType: string;
	lastRefreshedAt: Date;
	lastResult: string;
	lastErrorMessage: string | null;
	itemCount: number;
}

const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Build CacheHealthItem array from DB status rows.
 * Computes staleness based on current time vs lastRefreshedAt.
 */
export function buildCacheHealthItems(
	statuses: CacheRefreshStatusRow[],
	instanceNameMap: Map<string, string>,
	nowMs?: number,
): CacheHealthItem[] {
	const now = nowMs ?? Date.now();
	return statuses.map((status) => ({
		instanceId: status.instanceId,
		instanceName: instanceNameMap.get(status.instanceId) ?? "Unknown",
		cacheType: status.cacheType as CacheHealthItem["cacheType"],
		lastRefreshedAt: status.lastRefreshedAt.toISOString(),
		lastResult: status.lastResult as CacheHealthItem["lastResult"],
		lastErrorMessage: sanitizeErrorMessage(status.lastErrorMessage),
		itemCount: status.itemCount,
		isStale: now - status.lastRefreshedAt.getTime() > STALE_THRESHOLD_MS,
	}));
}
