/**
 * Cache Health Helpers
 *
 * Pure functions for building cache health response items from
 * CacheRefreshStatus rows.
 */

import {
	type CacheHealthItem,
	type PlexEvidenceSummary,
	type ProviderObservationStatus,
	projectProviderObservationUi,
	providerObservationProgressSchema,
} from "@arr/shared";
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

export type SanitizedEpisodeProgress = NonNullable<CacheHealthItem["progress"]>;

/** Public progress is counters only, and only when internally coherent. */
export function isSafeSanitizedEpisodeProgress(value: {
	completedUnits?: unknown;
	totalUnits?: unknown;
	completedWork?: unknown;
	totalWork?: unknown;
}): boolean {
	return providerObservationProgressSchema.safeParse({
		completedUnits: value.completedUnits,
		totalUnits: value.totalUnits,
		completedWork: value.completedWork,
		totalWork: value.totalWork,
	}).success;
}

function cacheStatusForUi(
	status: CacheRefreshStatusRow,
	evidence: PlexEvidenceSummary | undefined,
): ProviderObservationStatus {
	const attemptState = evidence?.attemptState;
	const failed =
		attemptState === "error" ||
		status.lastAttemptResult === "error" ||
		status.lastResult === "error";
	const running =
		attemptState === "in_progress" ||
		(normalizePlexAttemptState(status.lastAttemptResult) === "in_progress" &&
			(status.lastAttemptAt != null
				? status.lastAttemptAt.getTime() >= status.lastRefreshedAt.getTime()
				: status.lastAttemptResult === "in_progress"));
	const positiveOnly = evidence?.publicationLevel === "positive-only";
	const boundedCoverage = positiveOnly || evidence?.completeness === "partial";
	return {
		availability:
			running || failed || evidence?.publicationLevel === "unavailable"
				? "unavailable"
				: boundedCoverage
					? "partial"
					: "current",
		evidence: boundedCoverage
			? "positive-only"
			: evidence?.publicationLevel === "unavailable"
				? "unknown"
				: "complete",
		observedAt: status.lastRefreshedAt.toISOString(),
		ageSeconds: 0,
		latestAttempt: running ? "running" : failed ? "failed" : "successful",
		reasonCodes: running
			? ["refresh-running"]
			: failed
				? ["refresh-failed"]
				: positiveOnly
					? ["positive-only"]
					: boundedCoverage
						? ["coverage-incomplete"]
						: [],
	};
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
	progressByStatus?: Map<string, SanitizedEpisodeProgress>,
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
		const progress =
			status.cacheType === "plex_episode"
				? (progressByStatus?.get(`${status.instanceId}:${status.cacheType}`) ?? null)
				: null;
		const work =
			progress?.state === "running" || progress?.state === "failed"
				? {
						state: progress.state,
						completedUnits: progress.completedUnits,
						totalUnits: progress.totalUnits,
						completedWork: progress.completedWork,
						totalWork: progress.totalWork,
					}
				: undefined;
		const ui = projectProviderObservationUi(cacheStatusForUi(status, evidence), work);
		const collecting = ui.condition === "collecting";
		const failedWork = work?.state === "failed";
		const failedOrUnavailable =
			ui.condition === "retryable-failure" || ui.condition === "unavailable";
		return {
			instanceId: status.instanceId,
			instanceName: instanceNameMap.get(status.instanceId) ?? "Unknown",
			cacheType: status.cacheType as CacheHealthItem["cacheType"],
			lastRefreshedAt: status.lastRefreshedAt.toISOString(),
			lastResult: (collecting || inProgress
				? "in_progress"
				: failedOrUnavailable || unavailable
					? "error"
					: positiveOnly
						? "partial"
						: degradedNonPlexGeneration
							? "partial"
							: status.lastResult) as CacheHealthItem["lastResult"],
			lastErrorMessage: sanitizeErrorMessage(
				collecting || inProgress
					? "Plex cache refresh is in progress; current values are unavailable"
					: failedWork
						? "Plex cache refresh failed"
						: (status.lastAttemptErrorMessage ??
							status.lastErrorMessage ??
							(unavailable ? "Published Plex cache evidence is unavailable" : null)),
			),
			itemCount:
				unavailable || positiveOnly || collecting || failedOrUnavailable ? null : status.itemCount,
			...(positiveOnly ? { observedItemCount: status.itemCount } : {}),
			isStale: now - status.lastRefreshedAt.getTime() > STALE_THRESHOLD_MS,
			...(evidence ? { evidence } : {}),
			...(status.cacheType === "plex_episode" ? { progress } : {}),
			...(ui.condition === "current" ? {} : { uiCondition: ui.condition }),
		};
	});
}
