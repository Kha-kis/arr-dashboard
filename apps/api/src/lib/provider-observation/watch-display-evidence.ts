import type { ProviderObservationStatus } from "@arr/shared";
import { authorizeProviderEvidenceUse } from "./evidence-capabilities.js";

export type WatchDisplayRow = {
	watchCount: unknown;
	lastWatchedAt: unknown;
	watchedByUsers: unknown;
};

export type WatchDisplayEvidence = {
	watchCount: number | null;
	watchCountSemantics: "exact" | "lower-bound" | "unknown";
	lastWatchedAt: string | null;
	watchedByUsers: string[];
};

const MAX_WATCH_COUNT = 2_147_483_647;
const MAX_USERNAMES = 100;
const MAX_USERNAME_LENGTH = 500;
const MAX_USERNAMES_JSON_LENGTH = 100_000;

function safeWatchCount(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= MAX_WATCH_COUNT
	);
}

function safeDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function safeUsers(value: unknown): string[] | null {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_USERNAMES_JSON_LENGTH) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed) || parsed.length > MAX_USERNAMES) return null;
		if (
			parsed.some(
				(entry) =>
					typeof entry !== "string" ||
					entry.length === 0 ||
					entry.length > MAX_USERNAME_LENGTH ||
					entry.trim() !== entry,
			)
		)
			return null;
		return [...parsed];
	} catch {
		return null;
	}
}

function displayDecision(
	status: ProviderObservationStatus,
	domain: "watch-count" | "watch-attribution",
) {
	return authorizeProviderEvidenceUse(status, {
		domain,
		use: "display",
		field: domain === "watch-count" ? "watch-count" : "watched-by",
		targetObserved: true,
	});
}

/**
 * Projects a stored observation row into the public, read-only watch-display contract.
 * It is deliberately independent of provenance: authority comes only from the status domain.
 */
export function projectWatchDisplayEvidence(input: {
	status: ProviderObservationStatus | undefined;
	row: WatchDisplayRow;
}): WatchDisplayEvidence {
	if (!input.status || !safeWatchCount(input.row.watchCount)) {
		return {
			watchCount: null,
			watchCountSemantics: "unknown",
			lastWatchedAt: null,
			watchedByUsers: [],
		};
	}
	const countDecision = displayDecision(input.status, "watch-count");
	if (!countDecision.authorized) {
		return {
			watchCount: null,
			watchCountSemantics: "unknown",
			lastWatchedAt: null,
			watchedByUsers: [],
		};
	}
	if (countDecision.basis === "observed-lower-bound" && input.row.watchCount === 0) {
		return {
			watchCount: null,
			watchCountSemantics: "unknown",
			lastWatchedAt: null,
			watchedByUsers: [],
		};
	}

	const attributionDecision = displayDecision(input.status, "watch-attribution");
	const attributionExact = attributionDecision.authorized && attributionDecision.basis === "exact";
	const users = attributionExact ? safeUsers(input.row.watchedByUsers) : null;
	return {
		watchCount: input.row.watchCount,
		watchCountSemantics: countDecision.basis === "exact" ? "exact" : "lower-bound",
		lastWatchedAt:
			attributionExact && safeDate(input.row.lastWatchedAt)
				? input.row.lastWatchedAt.toISOString()
				: null,
		watchedByUsers: users ?? [],
	};
}
