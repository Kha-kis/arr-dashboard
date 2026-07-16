import type {
	SeerrIs4kParams,
	SeerrIsRequestedParams,
	SeerrModifiedByParams,
	SeerrRequestAgeParams,
	SeerrRequestCountParams,
	SeerrRequestedByParams,
	SeerrRequestModifiedAgeParams,
	SeerrRequestStatusParams,
} from "@arr/shared";
import { safeJsonParse } from "../../utils/json.js";
import type { CacheItemForEval, SeerrRequestInfo, SeerrRequestMap } from "../types.js";

// Seerr Rule Evaluators
// ============================================================================

/** Seerr request status code → label mapping */
const SEERR_STATUS_LABELS: Record<number, string> = {
	1: "pending",
	2: "approved",
	3: "declined",
	4: "failed",
	5: "completed",
};

/**
 * Look up Seerr requests for a cache item via its tmdbId from the data blob.
 */
export function lookupSeerrRequests(
	item: CacheItemForEval,
	seerrMap: SeerrRequestMap | undefined,
): SeerrRequestInfo[] | null {
	if (!seerrMap || seerrMap.size === 0) return null;

	const parsed = safeJsonParse(item.data);
	if (!parsed) return null;
	const data = parsed as Record<string, unknown>;

	// Extract tmdbId from the data blob (LibraryItem.remoteIds.tmdbId)
	const remoteIds = data.remoteIds as Record<string, unknown> | undefined;
	const tmdbId = remoteIds?.tmdbId;
	if (!tmdbId) return null;

	// Build the lookup key: "movie:12345" or "tv:12345"
	const mediaType = item.itemType === "movie" ? "movie" : "tv";
	const key = `${mediaType}:${tmdbId}`;

	return seerrMap.get(key) ?? null;
}

/**
 * Seerr Requested By: flag items requested by specific Seerr users.
 */
export function evaluateSeerrRequestedBy(
	item: CacheItemForEval,
	params: SeerrRequestedByParams,
	seerrMap: SeerrRequestMap | undefined,
): string | null {
	const requests = lookupSeerrRequests(item, seerrMap);
	if (!requests || requests.length === 0) return null;

	const targetNames = params.userNames.map((n) => n.toLowerCase());

	for (const req of requests) {
		if (targetNames.includes(req.requestedBy.toLowerCase())) {
			return `Requested by "${req.requestedBy}" (match: [${params.userNames.join(", ")}])`;
		}
	}

	return null;
}

/**
 * Seerr Request Age: flag items whose Seerr request is older/newer than N days.
 */
export function evaluateSeerrRequestAge(
	item: CacheItemForEval,
	params: SeerrRequestAgeParams,
	seerrMap: SeerrRequestMap | undefined,
	now: Date,
): string | null {
	const requests = lookupSeerrRequests(item, seerrMap);
	if (!requests || requests.length === 0) return null;

	// Use the oldest request's createdAt
	let oldest = requests[0]!;
	for (const req of requests) {
		if (req.createdAt < oldest.createdAt) oldest = req;
	}

	const requestDate = new Date(oldest.createdAt);
	const ageDays = (now.getTime() - requestDate.getTime()) / (1000 * 60 * 60 * 24);

	if (params.operator === "older_than" && ageDays >= params.days) {
		return `Seerr request ${Math.floor(ageDays)} days old (threshold: > ${params.days} days, requested by ${oldest.requestedBy})`;
	}
	if (params.operator === "newer_than" && ageDays < params.days) {
		return `Seerr request ${Math.floor(ageDays)} days old (threshold: < ${params.days} days, requested by ${oldest.requestedBy})`;
	}

	return null;
}

/**
 * Seerr Request Status: flag items whose Seerr request has a specific status.
 */
export function evaluateSeerrRequestStatus(
	item: CacheItemForEval,
	params: SeerrRequestStatusParams,
	seerrMap: SeerrRequestMap | undefined,
): string | null {
	const requests = lookupSeerrRequests(item, seerrMap);
	if (!requests || requests.length === 0) return null;

	for (const req of requests) {
		const statusLabel = SEERR_STATUS_LABELS[req.status];
		if (statusLabel && params.statuses.includes(statusLabel as (typeof params.statuses)[number])) {
			return `Seerr request status is "${statusLabel}" (requested by ${req.requestedBy})`;
		}
	}

	return null;
}

/**
 * Seerr Is 4K: flag items based on whether the Seerr request is for 4K.
 */
export function evaluateSeerrIs4k(
	item: CacheItemForEval,
	params: SeerrIs4kParams,
	seerrMap: SeerrRequestMap | undefined,
): string | null {
	const requests = lookupSeerrRequests(item, seerrMap);
	if (!requests || requests.length === 0) return null;

	for (const req of requests) {
		if (req.is4k === params.is4k) {
			return params.is4k
				? `Seerr request is 4K (requested by ${req.requestedBy})`
				: `Seerr request is not 4K (requested by ${req.requestedBy})`;
		}
	}
	return null;
}

/**
 * Seerr Request Modified Age: flag items by how recently the Seerr request was modified.
 */
export function evaluateSeerrRequestModifiedAge(
	item: CacheItemForEval,
	params: SeerrRequestModifiedAgeParams,
	seerrMap: SeerrRequestMap | undefined,
	now: Date,
): string | null {
	const requests = lookupSeerrRequests(item, seerrMap);
	if (!requests || requests.length === 0) return null;

	// Use the most recently modified request
	let latest = requests[0]!;
	for (const req of requests) {
		if (req.updatedAt && req.updatedAt > (latest.updatedAt ?? "")) latest = req;
	}

	if (!latest.updatedAt) return null;
	const modifiedDate = new Date(latest.updatedAt);
	const ageDays = (now.getTime() - modifiedDate.getTime()) / (1000 * 60 * 60 * 24);

	if (params.operator === "older_than" && ageDays >= params.days) {
		return `Seerr request last modified ${Math.floor(ageDays)} days ago (threshold: > ${params.days} days)`;
	}
	if (params.operator === "newer_than" && ageDays < params.days) {
		return `Seerr request last modified ${Math.floor(ageDays)} days ago (threshold: < ${params.days} days)`;
	}
	return null;
}

/**
 * Seerr Modified By: flag items whose Seerr request was last modified by specific users.
 */
export function evaluateSeerrModifiedBy(
	item: CacheItemForEval,
	params: SeerrModifiedByParams,
	seerrMap: SeerrRequestMap | undefined,
): string | null {
	const requests = lookupSeerrRequests(item, seerrMap);
	if (!requests || requests.length === 0) return null;

	const targetNames = params.userNames.map((n) => n.toLowerCase());

	for (const req of requests) {
		if (req.modifiedBy && targetNames.includes(req.modifiedBy.toLowerCase())) {
			return `Seerr request modified by "${req.modifiedBy}" (match: [${params.userNames.join(", ")}])`;
		}
	}
	return null;
}

/**
 * Seerr Is Requested: flag items based on whether they have any Seerr request.
 */
export function evaluateSeerrIsRequested(
	item: CacheItemForEval,
	params: SeerrIsRequestedParams,
	seerrMap: SeerrRequestMap | undefined,
): string | null {
	// If Seerr data is unavailable, skip evaluation to avoid false "not requested" matches
	if (!seerrMap) return null;
	const requests = lookupSeerrRequests(item, seerrMap);
	const hasRequest = requests !== null && requests.length > 0;

	if (params.isRequested && hasRequest) {
		return `Has Seerr request (${requests!.length} request(s))`;
	}
	if (!params.isRequested && !hasRequest) {
		return "No Seerr request found";
	}
	return null;
}

/**
 * Seerr Request Count: flag items based on number of Seerr requests.
 */
export function evaluateSeerrRequestCount(
	item: CacheItemForEval,
	params: SeerrRequestCountParams,
	seerrMap: SeerrRequestMap | undefined,
): string | null {
	if (!seerrMap) return null;
	const requests = lookupSeerrRequests(item, seerrMap);
	// If lookup returns null (no tmdbId), skip to avoid false "0 requests" matches
	if (requests === null) return null;
	const count = requests.length;

	if (params.operator === "less_than" && count < params.count) {
		return `Seerr request count: ${count} (threshold: < ${params.count})`;
	}
	if (params.operator === "greater_than" && count > params.count) {
		return `Seerr request count: ${count} (threshold: > ${params.count})`;
	}
	if (params.operator === "equals" && count === params.count) {
		return `Seerr request count: ${count} (threshold: = ${params.count})`;
	}
	return null;
}
