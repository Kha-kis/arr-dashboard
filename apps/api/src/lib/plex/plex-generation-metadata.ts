import type {
	PlexAttemptState,
	PlexCoverageReasonCode,
	PlexEvidenceSummary,
	PlexGenerationMetadataV2,
	PlexGenerationSection,
	PlexPublicationLevel,
} from "@arr/shared";

export type DecodedPlexGenerationMetadata = {
	version: 1 | 2;
	publicationLevel: PlexPublicationLevel;
	completeness: "complete" | "partial";
	itemCount: number | null;
	sections: PlexGenerationSection[];
};

export type PlexGenerationMetadataDecodeResult =
	| { ok: true; metadata: DecodedPlexGenerationMetadata }
	| { ok: false; reasonCode: PlexCoverageReasonCode };

export type PublishedPlexStatus = {
	lastResult: string;
	lastErrorMessage?: string | null;
	lastRefreshedAt: Date;
	lastAttemptAt?: Date | null;
	lastAttemptResult?: string | null;
	lastAttemptErrorMessage?: string | null;
	generationId?: string | null;
	generationMetadata?: string | null;
	itemCount: number;
};

export type PublishedPlexGenerationResult =
	| {
			available: true;
			generationId: string;
			publishedAt: Date;
			itemCount: number;
			metadata: DecodedPlexGenerationMetadata;
			evidence: PlexEvidenceSummary;
	  }
	| { available: false; evidence: PlexEvidenceSummary };

function unavailable(reasonCode: PlexCoverageReasonCode): PublishedPlexGenerationResult {
	return {
		available: false,
		evidence: {
			availability: "unavailable",
			authority: "unavailable",
			attemptState: "unknown",
			publicationLevel: "unavailable",
			completeness: "unknown",
			reasonCodes: [reasonCode],
		},
	};
}

export function normalizePlexAttemptState(result: string | null | undefined): PlexAttemptState {
	if (result === "success") return "success";
	if (result === "error") return "error";
	if (result === "partial") return "partial";
	if (typeof result === "string" && /^in_progress:[^:]+$/.test(result)) return "in_progress";
	return "unknown";
}

function unavailableForStatus(
	reasonCode: PlexCoverageReasonCode,
	status: PublishedPlexStatus,
): PublishedPlexGenerationResult {
	const result = unavailable(reasonCode);
	result.evidence.attemptState = normalizePlexAttemptState(status.lastAttemptResult);
	return result;
}

export function evaluatePlexLatestAttemptTrust(
	status: PublishedPlexStatus,
	now: Date,
): { attemptState: PlexAttemptState; reasonCode: PlexCoverageReasonCode | null } {
	const attemptState = normalizePlexAttemptState(status.lastAttemptResult);
	if (
		!(status.lastAttemptAt instanceof Date) ||
		!Number.isFinite(status.lastAttemptAt.getTime()) ||
		status.lastAttemptAt.getTime() < status.lastRefreshedAt.getTime()
	) {
		return { attemptState, reasonCode: "latest_attempt_missing" };
	}
	if (status.lastAttemptAt.getTime() > now.getTime()) {
		return { attemptState, reasonCode: "latest_attempt_future_dated" };
	}
	if (status.lastAttemptErrorMessage != null) {
		return { attemptState, reasonCode: "latest_attempt_failed" };
	}
	if (status.lastErrorMessage != null) {
		return { attemptState, reasonCode: "metadata_invalid" };
	}
	if (status.lastAttemptResult == null || status.lastAttemptResult.trim() === "") {
		return { attemptState, reasonCode: "latest_attempt_missing" };
	}
	switch (attemptState) {
		case "success":
			return { attemptState, reasonCode: null };
		case "in_progress":
			return { attemptState, reasonCode: "latest_attempt_in_progress" };
		case "error":
			return { attemptState, reasonCode: "latest_attempt_failed" };
		case "partial":
			return { attemptState, reasonCode: "latest_attempt_partial" };
		case "unknown":
			return { attemptState, reasonCode: "latest_attempt_unknown" };
	}
}

function publishedGenerationSummary(input: {
	generationId: string;
	publicationLevel: PlexPublicationLevel;
	publishedAt: Date;
	itemCount: number;
}) {
	return {
		generationId: input.generationId,
		publicationLevel: input.publicationLevel,
		publishedAt: input.publishedAt.toISOString(),
		itemCount: input.itemCount,
	};
}

function normalizeSections(value: unknown): PlexGenerationSection[] | PlexCoverageReasonCode {
	if (!Array.isArray(value)) return "invalid_sections";
	const sections: PlexGenerationSection[] = [];
	const keys = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			return "invalid_sections";
		}
		const section = entry as Record<string, unknown>;
		if (
			typeof section.key !== "string" ||
			section.key.trim() === "" ||
			typeof section.title !== "string" ||
			section.title.trim() === "" ||
			(section.type !== "movie" && section.type !== "show")
		) {
			return "invalid_sections";
		}
		if (keys.has(section.key)) return "duplicate_sections";
		keys.add(section.key);
		sections.push({ key: section.key, title: section.title, type: section.type });
	}
	return sections;
}

export function decodePlexGenerationMetadata(
	raw: string | null | undefined,
): PlexGenerationMetadataDecodeResult {
	if (raw == null || raw.trim() === "") return { ok: false, reasonCode: "missing_metadata" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reasonCode: "malformed_metadata" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, reasonCode: "malformed_metadata" };
	}
	const envelope = parsed as Record<string, unknown>;
	const normalizedSections = normalizeSections(envelope.sections);
	if (typeof normalizedSections === "string") {
		return { ok: false, reasonCode: normalizedSections };
	}

	if (envelope.version === undefined) {
		return {
			ok: true,
			metadata: {
				version: 1,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: null,
				sections: normalizedSections,
			},
		};
	}
	if (envelope.version !== 2) return { ok: false, reasonCode: "unknown_metadata_version" };
	if (
		envelope.publicationLevel !== "authoritative" &&
		envelope.publicationLevel !== "positive-only"
	) {
		return { ok: false, reasonCode: "invalid_publication_level" };
	}
	if (envelope.completeness !== "complete" && envelope.completeness !== "partial") {
		return { ok: false, reasonCode: "invalid_completeness" };
	}
	if (
		(envelope.publicationLevel === "authoritative" && envelope.completeness !== "complete") ||
		(envelope.publicationLevel === "positive-only" && envelope.completeness !== "partial")
	) {
		return { ok: false, reasonCode: "invalid_completeness" };
	}
	if (!Number.isSafeInteger(envelope.itemCount) || (envelope.itemCount as number) < 0) {
		return { ok: false, reasonCode: "invalid_item_count" };
	}
	return {
		ok: true,
		metadata: {
			version: 2,
			publicationLevel: envelope.publicationLevel,
			completeness: envelope.completeness,
			itemCount: envelope.itemCount as number,
			sections: normalizedSections,
		},
	};
}

export function encodeAuthoritativePlexGenerationMetadata(input: {
	sections: PlexGenerationSection[];
	itemCount: number;
}): string {
	const metadata: PlexGenerationMetadataV2 = {
		version: 2,
		publicationLevel: "authoritative",
		completeness: "complete",
		itemCount: input.itemCount,
		sections: input.sections,
	};
	const decoded = decodePlexGenerationMetadata(JSON.stringify(metadata));
	if (!decoded.ok || decoded.metadata.publicationLevel !== "authoritative") {
		throw new Error("Invalid authoritative Plex generation metadata");
	}
	return JSON.stringify(metadata);
}

export function evaluatePublishedPlexGeneration(
	status: PublishedPlexStatus | null | undefined,
	options: { now?: Date; maxAgeMs?: number } = {},
): PublishedPlexGenerationResult {
	if (!status) return unavailable("missing_status");
	if (status.lastResult !== "success")
		return unavailableForStatus("unpublished_generation", status);
	if (typeof status.generationId !== "string" || status.generationId.trim() === "") {
		return unavailableForStatus("missing_generation_id", status);
	}
	if (!Number.isSafeInteger(status.itemCount) || status.itemCount < 0) {
		return unavailableForStatus("invalid_item_count", status);
	}
	const decoded = decodePlexGenerationMetadata(status.generationMetadata);
	if (!decoded.ok) return unavailableForStatus(decoded.reasonCode, status);
	if (decoded.metadata.itemCount !== null && decoded.metadata.itemCount !== status.itemCount) {
		return unavailableForStatus("row_count_mismatch", status);
	}
	const now = options.now ?? new Date();
	const attempt = evaluatePlexLatestAttemptTrust(status, now);
	const publishedAt = status.lastRefreshedAt.getTime();
	if (!Number.isFinite(publishedAt) || publishedAt > now.getTime()) {
		const result = unavailable("published_timestamp_changed");
		result.evidence.attemptState = attempt.attemptState;
		return result;
	}
	if (options.maxAgeMs !== undefined && now.getTime() - publishedAt > options.maxAgeMs) {
		const result = unavailable("published_generation_stale");
		result.evidence.attemptState = attempt.attemptState;
		return result;
	}
	const publishedGeneration = publishedGenerationSummary({
		generationId: status.generationId,
		publicationLevel: decoded.metadata.publicationLevel,
		publishedAt: status.lastRefreshedAt,
		itemCount: status.itemCount,
	});
	const currentPositiveOnly =
		decoded.metadata.publicationLevel === "positive-only" &&
		decoded.metadata.completeness === "partial" &&
		(attempt.attemptState === "partial" || attempt.attemptState === "success") &&
		(attempt.reasonCode === null || attempt.reasonCode === "latest_attempt_partial");
	const authoritativeCurrent =
		decoded.metadata.publicationLevel === "authoritative" &&
		decoded.metadata.completeness === "complete" &&
		attempt.attemptState === "success" &&
		attempt.reasonCode === null;
	return {
		available: true,
		generationId: status.generationId,
		publishedAt: status.lastRefreshedAt,
		itemCount: status.itemCount,
		metadata: decoded.metadata,
		evidence: {
			availability: authoritativeCurrent || currentPositiveOnly ? "current" : "last-known",
			authority: authoritativeCurrent
				? "authoritative"
				: currentPositiveOnly
					? "positive-only"
					: "unavailable",
			attemptState: attempt.attemptState,
			publicationLevel: authoritativeCurrent
				? "authoritative"
				: currentPositiveOnly
					? "positive-only"
					: "unavailable",
			completeness: authoritativeCurrent ? "complete" : currentPositiveOnly ? "partial" : "unknown",
			reasonCodes: attempt.reasonCode ? [attempt.reasonCode] : [],
			publishedGeneration,
		},
	};
}

export function evaluatePlexMutationAuthority(
	status: PublishedPlexStatus | null | undefined,
	options: { now?: Date; maxAgeMs?: number } = {},
): PublishedPlexGenerationResult {
	const published = evaluatePublishedPlexGeneration(status, options);
	if (!published.available) return published;
	if (
		published.evidence.availability !== "current" ||
		published.evidence.authority !== "authoritative" ||
		published.metadata.publicationLevel !== "authoritative" ||
		published.metadata.completeness !== "complete"
	) {
		const reasonCode = published.evidence.reasonCodes[0] ?? "mutation_authority_unavailable";
		const result = unavailable(reasonCode);
		result.evidence.attemptState = published.evidence.attemptState;
		result.evidence.publishedGeneration = published.evidence.publishedGeneration;
		return result;
	}
	return {
		...published,
		evidence: {
			availability: "current",
			authority: "authoritative",
			attemptState: "success",
			publicationLevel: "authoritative",
			completeness: "complete",
			reasonCodes: [],
			publishedGeneration: published.evidence.publishedGeneration,
		},
	};
}
