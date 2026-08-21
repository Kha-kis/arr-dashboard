/**
 * Cache Health Helpers
 *
 * Pure functions for building cache health response items from
 * CacheRefreshStatus rows.
 */

import type { CacheHealthItem, PlexEvidenceSummary } from "@arr/shared";
import { normalizePlexAttemptState } from "../../../lib/plex/plex-generation-metadata.js";

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
	lastAttemptAt?: Date | null;
	lastAttemptResult?: string | null;
	lastAttemptErrorMessage?: string | null;
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
	plexEvidenceByStatus?: Map<string, PlexEvidenceSummary>,
): CacheHealthItem[] {
	const now = nowMs ?? Date.now();
	return statuses.map((status) => {
		const requiresPlexEvidence = status.cacheType === "plex" || status.cacheType === "plex_episode";
		const newerFailedAttempt =
			status.lastAttemptResult === "error" &&
			status.lastAttemptAt != null &&
			status.lastAttemptAt.getTime() > status.lastRefreshedAt.getTime();
		const degradedNonPlexGeneration =
			!requiresPlexEvidence &&
			status.lastResult === "success" &&
			(newerFailedAttempt || status.lastErrorMessage !== null);
		const evidence =
			plexEvidenceByStatus?.get(`${status.instanceId}:${status.cacheType}`) ??
			(requiresPlexEvidence && plexEvidenceByStatus !== undefined
				? {
						availability: "unavailable" as const,
						authority: "unavailable" as const,
						attemptState: "unknown" as const,
						publicationLevel: "unavailable" as const,
						completeness: "unknown" as const,
						reasonCodes: ["query_failed" as const],
					}
				: undefined);
		const derivedAttemptState = normalizePlexAttemptState(status.lastAttemptResult);
		const derivedUnavailable =
			requiresPlexEvidence &&
			(status.lastErrorMessage !== null ||
				status.lastAttemptErrorMessage != null ||
				(status.lastAttemptResult !== undefined && derivedAttemptState !== "success"));
		const unavailable = evidence ? evidence.publicationLevel === "unavailable" : derivedUnavailable;
		const inProgress = evidence
			? evidence.attemptState === "in_progress"
			: requiresPlexEvidence && derivedAttemptState === "in_progress";
		const positiveOnly =
			evidence?.publicationLevel === "positive-only" || evidence?.completeness === "partial";
		return {
			instanceId: status.instanceId,
			instanceName: instanceNameMap.get(status.instanceId) ?? "Unknown",
			cacheType: status.cacheType as CacheHealthItem["cacheType"],
			lastRefreshedAt: status.lastRefreshedAt.toISOString(),
			lastResult: (inProgress
				? "in_progress"
				: unavailable
					? "error"
					: positiveOnly
						? "partial"
						: degradedNonPlexGeneration
							? "partial"
							: status.lastResult) as CacheHealthItem["lastResult"],
			lastErrorMessage: sanitizeErrorMessage(
				inProgress
					? "Plex cache refresh is in progress; current values are unavailable"
					: (status.lastAttemptErrorMessage ??
							status.lastErrorMessage ??
							(unavailable ? "Published Plex cache evidence is unavailable" : null)),
			),
			itemCount: unavailable || positiveOnly ? null : status.itemCount,
			isStale: now - status.lastRefreshedAt.getTime() > STALE_THRESHOLD_MS,
			...(evidence ? { evidence } : {}),
		};
	});
}
