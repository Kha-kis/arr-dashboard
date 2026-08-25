import type {
	PlexAttemptState,
	PlexCoverageReasonCode,
	PlexEvidenceSummary,
	PlexGenerationDomainRoot,
	PlexGenerationMetadataV3,
	PlexGenerationSection,
	PlexGenerationSectionV3,
	PlexPartialReason,
	PlexPartialReasonCode,
	PlexPositiveGenerationMetadataV4,
	PlexPublicationLevel,
} from "@arr/shared";
import {
	decodePlexTargetLedgerBinding,
	type PlexTargetLedgerBinding,
} from "./plex-generation-target-ledger.js";

export type DecodedPlexGenerationMetadata =
	| {
			version: 1 | 2;
			publicationLevel: PlexPublicationLevel;
			completeness: "complete" | "partial";
			itemCount: number | null;
			sections: PlexGenerationSection[];
	  }
	| PlexGenerationMetadataV3
	| PlexPositiveGenerationMetadataV4;

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

function normalizeV3Sections(value: unknown): PlexGenerationSectionV3[] | PlexCoverageReasonCode {
	const base = normalizeSections(value);
	if (typeof base === "string") return base;
	const entries = value as Record<string, unknown>[];
	const sections: PlexGenerationSectionV3[] = [];
	for (let index = 0; index < base.length; index++) {
		const entry = entries[index]!;
		if (
			typeof entry.uuid !== "string" ||
			entry.uuid.trim() === "" ||
			entry.refreshing !== false ||
			!Number.isSafeInteger(entry.scannedAt) ||
			(entry.scannedAt as number) < 0 ||
			!Number.isSafeInteger(entry.updatedAt) ||
			(entry.updatedAt as number) < 0
		) {
			return "invalid_sections";
		}
		sections.push({
			...base[index]!,
			uuid: entry.uuid,
			refreshing: false,
			scannedAt: entry.scannedAt as number,
			updatedAt: entry.updatedAt as number,
		});
	}
	return sections;
}

const canonicalDomains = new Set([
	"membership",
	"display",
	"labels",
	"collections",
	"watch",
	"on-deck",
	"episode-parents",
	"episodes",
]);

function normalizeV3Roots(
	value: unknown,
	sectionKeys: ReadonlySet<string>,
): PlexGenerationDomainRoot[] | PlexCoverageReasonCode {
	if (!Array.isArray(value)) return "metadata_invalid";
	const roots: PlexGenerationDomainRoot[] = [];
	const identities = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			return "metadata_invalid";
		}
		const root = entry as Record<string, unknown>;
		if (
			typeof root.sectionKey !== "string" ||
			!sectionKeys.has(root.sectionKey) ||
			typeof root.domain !== "string" ||
			!canonicalDomains.has(root.domain) ||
			typeof root.digest !== "string" ||
			!/^[a-f0-9]{64}$/.test(root.digest)
		) {
			return "metadata_invalid";
		}
		const identity = `${root.sectionKey}\u0000${root.domain}`;
		if (identities.has(identity)) return "metadata_invalid";
		identities.add(identity);
		roots.push(root as unknown as PlexGenerationDomainRoot);
	}
	return roots;
}
const partialCodes = new Set<PlexPartialReasonCode>([
	"currentItemsWithoutTmdbMetadata",
	"currentLibraryItemsWithoutRatingKeys",
	"historyItemsWithoutUsableMediaKey",
	"currentHistoryItemsWithoutMappedMetadata",
	"historyItemsWithUnknownAccounts",
	"onDeckItemsWithoutMappedMetadata",
	"onDeckFetchFailures",
]);

function hasExactObjectKeys(value: Record<string, unknown>, expectedKeys: readonly string[]) {
	const actual = Object.keys(value).sort();
	const expected = [...expectedKeys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function decodeV4(e: Record<string, unknown>): PlexGenerationMetadataDecodeResult {
	if (
		!hasExactObjectKeys(e, [
			"version",
			"publicationLevel",
			"completeness",
			"itemCount",
			"canonicalizationVersion",
			"sections",
			"observedRoots",
			"capabilities",
			"targetLedgerVersion",
			"targetCount",
			"targetDigest",
			"partialReasons",
		]) ||
		e.publicationLevel !== "positive-only" ||
		e.completeness !== "partial" ||
		e.canonicalizationVersion !== 1 ||
		!Number.isSafeInteger(e.itemCount) ||
		(e.itemCount as number) < 0
	)
		return { ok: false, reasonCode: "metadata_invalid" };
	const sections = normalizeV3Sections(e.sections);
	if (typeof sections === "string") return { ok: false, reasonCode: "metadata_invalid" };
	if (
		!(e.sections as unknown[]).every(
			(section) =>
				typeof section === "object" &&
				section !== null &&
				!Array.isArray(section) &&
				hasExactObjectKeys(section as Record<string, unknown>, [
					"key",
					"uuid",
					"title",
					"type",
					"refreshing",
					"scannedAt",
					"updatedAt",
				]),
		)
	) {
		return { ok: false, reasonCode: "metadata_invalid" };
	}
	if (sections.some((s) => s.refreshing)) return { ok: false, reasonCode: "metadata_invalid" };
	const roots = normalizeV3Roots(e.observedRoots, new Set(sections.map((s) => s.key)));
	const showSectionKeys = new Set(
		sections.filter((section) => section.type === "show").map((s) => s.key),
	);
	if (
		typeof roots === "string" ||
		roots.some(
			(root) =>
				root.domain !== "episode-parents" ||
				!showSectionKeys.has(root.sectionKey) ||
				!hasExactObjectKeys(root as unknown as Record<string, unknown>, [
					"sectionKey",
					"domain",
					"digest",
				]),
		) ||
		roots.length !== showSectionKeys.size
	)
		return { ok: false, reasonCode: "metadata_invalid" };
	const c = e.capabilities;
	if (!Array.isArray(c) || c.length !== 1 || typeof c[0] !== "object" || c[0] === null)
		return { ok: false, reasonCode: "metadata_invalid" };
	const cap = c[0] as Record<string, unknown>;
	if (
		!hasExactObjectKeys(cap, ["domain", "field", "semantics", "operators"]) ||
		cap.domain !== "episode-parents" ||
		cap.field !== "membership" ||
		cap.semantics !== "observed-targets-only" ||
		!Array.isArray(cap.operators) ||
		cap.operators.length
	)
		return { ok: false, reasonCode: "metadata_invalid" };
	const b = decodePlexTargetLedgerBinding(e);
	if (!b.ok || !b.binding) return { ok: false, reasonCode: "metadata_invalid" };
	if (
		!Array.isArray(e.partialReasons) ||
		e.partialReasons.length < 1 ||
		e.partialReasons.length > 7
	)
		return { ok: false, reasonCode: "metadata_invalid" };
	let prev = "";
	const reasons: PlexPartialReason[] = [];
	for (const x of e.partialReasons) {
		if (
			typeof x !== "object" ||
			x === null ||
			Array.isArray(x) ||
			!hasExactObjectKeys(x as Record<string, unknown>, ["code", "count"])
		)
			return { ok: false, reasonCode: "metadata_invalid" };
		const r = x as Record<string, unknown>;
		if (
			typeof r.code !== "string" ||
			!partialCodes.has(r.code as PlexPartialReasonCode) ||
			!Number.isSafeInteger(r.count) ||
			(r.count as number) < 1 ||
			r.code <= prev
		)
			return { ok: false, reasonCode: "metadata_invalid" };
		prev = r.code;
		reasons.push({ code: r.code as PlexPartialReasonCode, count: r.count as number });
	}
	return {
		ok: true,
		metadata: {
			version: 4,
			publicationLevel: "positive-only",
			completeness: "partial",
			itemCount: e.itemCount as number,
			canonicalizationVersion: 1,
			sections,
			observedRoots: roots,
			capabilities: [
				{
					domain: "episode-parents",
					field: "membership",
					semantics: "observed-targets-only",
					operators: [],
				},
			],
			...b.binding,
			partialReasons: reasons,
		},
	};
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
	if (envelope.version === 4) return decodeV4(envelope);
	const normalizedSections =
		envelope.version === 3
			? normalizeV3Sections(envelope.sections)
			: normalizeSections(envelope.sections);
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
	if (envelope.version !== 2 && envelope.version !== 3) {
		return { ok: false, reasonCode: "unknown_metadata_version" };
	}
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
	if (envelope.version === 3) {
		if (
			envelope.publicationLevel !== "authoritative" ||
			envelope.completeness !== "complete" ||
			envelope.canonicalizationVersion !== 1
		) {
			return { ok: false, reasonCode: "metadata_invalid" };
		}
		const roots = normalizeV3Roots(
			envelope.roots,
			new Set(normalizedSections.map((section) => section.key)),
		);
		if (typeof roots === "string") return { ok: false, reasonCode: roots };
		const targetLedger = decodePlexTargetLedgerBinding(envelope);
		if (!targetLedger.ok) return { ok: false, reasonCode: "metadata_invalid" };
		return {
			ok: true,
			metadata: {
				version: 3,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: envelope.itemCount as number,
				canonicalizationVersion: 1,
				sections: normalizedSections as PlexGenerationSectionV3[],
				roots,
				...(targetLedger.binding ?? {}),
			},
		};
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
	sections: PlexGenerationSectionV3[];
	itemCount: number;
	canonicalizationVersion: 1;
	roots: PlexGenerationDomainRoot[];
	targetLedger?: PlexTargetLedgerBinding;
}): string {
	const metadata: PlexGenerationMetadataV3 = {
		version: 3,
		publicationLevel: "authoritative",
		completeness: "complete",
		itemCount: input.itemCount,
		canonicalizationVersion: input.canonicalizationVersion,
		sections: input.sections,
		roots: input.roots,
		...(input.targetLedger ?? {}),
	};
	const decoded = decodePlexGenerationMetadata(JSON.stringify(metadata));
	if (!decoded.ok || decoded.metadata.publicationLevel !== "authoritative") {
		throw new Error("Invalid authoritative Plex generation metadata");
	}
	return JSON.stringify(metadata);
}

export function encodePositivePlexGenerationMetadata(input: {
	sections: PlexGenerationSectionV3[];
	itemCount: number;
	canonicalizationVersion: 1;
	observedRoots: PlexGenerationDomainRoot[];
	targetLedger: PlexTargetLedgerBinding;
	partialReasons: readonly PlexPartialReason[];
}): string {
	const metadata: PlexPositiveGenerationMetadataV4 = {
		version: 4,
		publicationLevel: "positive-only",
		completeness: "partial",
		itemCount: input.itemCount,
		canonicalizationVersion: input.canonicalizationVersion,
		sections: input.sections,
		observedRoots: input.observedRoots,
		capabilities: [
			{
				domain: "episode-parents",
				field: "membership",
				semantics: "observed-targets-only",
				operators: [],
			},
		],
		...input.targetLedger,
		partialReasons: input.partialReasons,
	};
	const decoded = decodePlexGenerationMetadata(JSON.stringify(metadata));
	if (!decoded.ok || decoded.metadata.publicationLevel !== "positive-only") {
		throw new Error("Invalid positive-only Plex generation metadata");
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
	const settlementMetadataMissing =
		decoded.metadata.version < 3 && decoded.metadata.publicationLevel === "authoritative";
	const authoritativeCurrent =
		decoded.metadata.version === 3 &&
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
			reasonCodes: attempt.reasonCode
				? [attempt.reasonCode]
				: settlementMetadataMissing
					? ["plex_settlement_metadata_missing"]
					: [],
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
