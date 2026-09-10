import type {
	PlexAttemptState,
	PlexCoverageReasonCode,
	PlexEvidenceSummary,
	PlexGenerationDomainRoot,
	PlexGenerationMetadataV3,
	PlexGenerationMetadataV5,
	PlexGenerationSection,
	PlexGenerationSectionV3,
	PlexPartialReason,
	PlexPartialReasonCode,
	PlexPositiveGenerationMetadataV4,
	PlexPublicationLevel,
	ProviderCoverageReceiptV1,
	ProviderCoverageReceiptV2,
	ProviderObservationStatus,
} from "@arr/shared";
import {
	evaluateProviderCoverageReceipt,
	evaluateProviderDomainCoverageMap,
} from "../provider-observation/coverage-receipt.js";
import {
	type ProviderIdentityState,
	projectProviderObservationStatus,
} from "../provider-observation/status-projection.js";
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
	| PlexPositiveGenerationMetadataV4
	| PlexGenerationMetadataV5
	| PlexGenerationMetadataV6;

type PlexGenerationMetadataV6Base = {
	version: 6;
	publicationLevel: PlexPublicationLevel;
	completeness: "complete" | "partial";
	itemCount: number;
	canonicalizationVersion: 1;
	sections: PlexGenerationSectionV3[];
	targetLedgerVersion: 1;
	targetCount: number;
	targetDigest: string;
	partialReasons: PlexPartialReason[];
	coverageReceipt: ProviderCoverageReceiptV2;
};

export type PlexGenerationMetadataV6 =
	| (PlexGenerationMetadataV6Base & {
			publicationLevel: "authoritative";
			completeness: "complete";
			roots: PlexGenerationDomainRoot[];
			observedRoots?: never;
			capabilities?: never;
			partialReasons: [];
	  })
	| (PlexGenerationMetadataV6Base & {
			publicationLevel: "positive-only";
			completeness: "partial";
			observedRoots: PlexGenerationDomainRoot[];
			capabilities: PlexPositiveGenerationMetadataV4["capabilities"];
			roots?: never;
			partialReasons: PlexPartialReason[];
	  });

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
			providerStatus: ProviderObservationStatus;
	  }
	| { available: false; evidence: PlexEvidenceSummary; providerStatus: ProviderObservationStatus };

function providerAttempt(status: PublishedPlexStatus | null | undefined) {
	if (!status?.lastAttemptAt || !(status.lastAttemptAt instanceof Date)) return null;
	const attemptState = normalizePlexAttemptState(status.lastAttemptResult);
	if (attemptState === "success")
		return { state: "successful" as const, attemptedAt: status.lastAttemptAt };
	if (attemptState === "partial")
		return { state: "successful" as const, attemptedAt: status.lastAttemptAt };
	if (attemptState === "in_progress")
		return { state: "running" as const, attemptedAt: status.lastAttemptAt };
	if (attemptState === "error")
		return { state: "failed" as const, attemptedAt: status.lastAttemptAt };
	return null;
}

function unavailableProviderStatus(reasonCode: ProviderObservationStatus["reasonCodes"][number]) {
	return {
		availability: "unavailable" as const,
		evidence: "unknown" as const,
		observedAt: null,
		ageSeconds: null,
		latestAttempt: "idle" as const,
		reasonCodes: [reasonCode],
	};
}

/** Plex adapter for the shared display projection. It never authorizes mutation. */
export function projectPlexProviderObservationStatus(input: {
	status: PublishedPlexStatus | null | undefined;
	metadata?: DecodedPlexGenerationMetadata;
	identity?: ProviderIdentityState;
	now?: Date;
	maxAgeMs?: number;
}): ProviderObservationStatus {
	const identity = input.identity ?? "current";
	const now = input.now ?? new Date();
	const maxAgeMs = input.maxAgeMs ?? Number.MAX_SAFE_INTEGER;
	if (identity !== "current") {
		return projectProviderObservationStatus({
			identity,
			publication: null,
			latestAttempt: null,
			now,
			maxAgeMs,
		});
	}
	if (!input.status) return unavailableProviderStatus("no-publication");
	const trust = evaluatePlexLatestAttemptTrust(input.status, now);
	if (!input.metadata) {
		let invalidReceiptMetadata = false;
		try {
			const version = JSON.parse(input.status.generationMetadata ?? "").version;
			invalidReceiptMetadata = version === 5 || version === 6;
		} catch {
			// Malformed metadata has no receipt-backed publication.
		}
		return projectProviderObservationStatus({
			identity,
			publication: invalidReceiptMetadata
				? {
						observedAt: input.status.lastRefreshedAt,
						evaluation: evaluateProviderCoverageReceipt(undefined),
					}
				: null,
			latestAttempt: providerAttempt(input.status),
			now,
			maxAgeMs,
		});
	}
	if (input.metadata.version === 5 || input.metadata.version === 6) {
		const projected = projectProviderObservationStatus({
			identity,
			publication: {
				observedAt: input.status.lastRefreshedAt,
				evaluation: evaluateProviderCoverageReceipt(input.metadata.coverageReceipt),
			},
			latestAttempt: providerAttempt(input.status),
			now,
			maxAgeMs,
		});
		if (projected.availability !== "current" || trust.reasonCode === null) return projected;
		return {
			...projected,
			availability: "last-known",
			reasonCodes: ["unknown-failure"],
		};
	}
	const baseline = projectProviderObservationStatus({
		identity,
		publication: null,
		latestAttempt: providerAttempt(input.status),
		now,
		maxAgeMs,
	});
	if (baseline.availability === "unavailable" && baseline.reasonCodes[0] !== "no-publication") {
		return baseline;
	}
	const observedAt = input.status.lastRefreshedAt;
	const ageMs = now.getTime() - observedAt.getTime();
	if (!Number.isFinite(observedAt.getTime()) || ageMs < 0)
		return unavailableProviderStatus("unknown-failure");
	return {
		availability: "last-known",
		evidence: "unknown",
		observedAt: observedAt.toISOString(),
		ageSeconds: Math.floor(ageMs / 1000),
		latestAttempt: baseline.latestAttempt,
		reasonCodes: [
			"coverage-incomplete",
			...baseline.reasonCodes.filter(
				(reason): reason is "refresh-running" | "refresh-failed" =>
					reason === "refresh-running" || reason === "refresh-failed",
			),
		],
	};
}

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
		providerStatus: unavailableProviderStatus("no-publication"),
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
	result.providerStatus = projectPlexProviderObservationStatus({ status });
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

function parsePartialReasons(value: unknown, allowEmpty = false): PlexPartialReason[] | null {
	if (
		!Array.isArray(value) ||
		(!allowEmpty && value.length < 1) ||
		value.length > partialCodes.size
	)
		return null;
	let previous = "";
	const reasons: PlexPartialReason[] = [];
	for (const entry of value) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			Array.isArray(entry) ||
			!hasExactObjectKeys(entry as Record<string, unknown>, ["code", "count"])
		)
			return null;
		const reason = entry as Record<string, unknown>;
		if (
			typeof reason.code !== "string" ||
			!partialCodes.has(reason.code as PlexPartialReasonCode) ||
			!Number.isSafeInteger(reason.count) ||
			(reason.count as number) < 1 ||
			reason.code <= previous
		)
			return null;
		previous = reason.code;
		reasons.push({ code: reason.code as PlexPartialReasonCode, count: reason.count as number });
	}
	return reasons;
}

function decodeV4(
	e: Record<string, unknown>,
	options: { allowEmptyPartialReasons?: boolean } = {},
): PlexGenerationMetadataDecodeResult {
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
	const reasons = parsePartialReasons(e.partialReasons, options.allowEmptyPartialReasons);
	if (!reasons) return { ok: false, reasonCode: "metadata_invalid" };
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

function exactV3Sections(sections: PlexGenerationSectionV3[], raw: unknown): boolean {
	return (
		Array.isArray(raw) &&
		raw.length === sections.length &&
		raw.every(
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
	);
}

function exactRoots(roots: PlexGenerationDomainRoot[], raw: unknown): boolean {
	return (
		Array.isArray(raw) &&
		raw.length === roots.length &&
		raw.every(
			(root) =>
				typeof root === "object" &&
				root !== null &&
				!Array.isArray(root) &&
				hasExactObjectKeys(root as Record<string, unknown>, ["sectionKey", "domain", "digest"]),
		)
	);
}

function hasCompletePlexReceipt(
	receipt: unknown,
	publicationLevel: PlexPublicationLevel,
	itemCount: number,
): receipt is ProviderCoverageReceiptV1 {
	const evaluated = evaluateProviderCoverageReceipt(receipt);
	if (
		!evaluated.valid ||
		evaluated.provider !== "plex" ||
		evaluated.canonicalEntities !== itemCount ||
		!receipt ||
		typeof receipt !== "object" ||
		Array.isArray(receipt)
	)
		return false;
	const parsed = receipt as ProviderCoverageReceiptV1;
	if (publicationLevel === "authoritative") {
		return parsed.evidence === "complete" && evaluated.complete;
	}
	if (parsed.evidence !== "positive-only") return false;
	return evaluateProviderCoverageReceipt({ ...parsed, evidence: "complete" }).complete;
}

function hasValidV2PlexReceipt(
	value: unknown,
	publicationLevel: "authoritative" | "positive-only",
	itemCount: number,
): value is ProviderCoverageReceiptV2 {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		(value as Record<string, unknown>).version !== 2
	)
		return false;
	const { domains: _domains, version: _version, ...coreFields } = value as Record<string, unknown>;
	const evaluation = evaluateProviderCoverageReceipt({ ...coreFields, version: 1 });
	if (
		!evaluation.valid ||
		evaluation.provider !== "plex" ||
		evaluation.publishedCanonicalEntities !== itemCount
	)
		return false;
	const domains = evaluateProviderDomainCoverageMap(value);
	const expectedDomains = [
		"library-inventory",
		"mapping",
		"watch-count",
		"watch-attribution",
		"on-deck",
	] as const;
	if (
		domains.size !== expectedDomains.length ||
		!expectedDomains.every((domain) => domains.has(domain))
	)
		return false;
	const rawDomains = (value as Record<string, unknown>).domains;
	if (!Array.isArray(rawDomains)) return false;
	for (const domain of rawDomains) {
		if (typeof domain !== "object" || domain === null || Array.isArray(domain)) continue;
		const rawDomain = domain as Record<string, unknown>;
		if (rawDomain.domain === "mapping" || rawDomain.domain === "watch-count") {
			if (rawDomain.publishedCanonicalEntities !== itemCount) return false;
		}
	}
	const aggregateEvaluation = evaluateProviderCoverageReceipt(value);
	if (publicationLevel === "authoritative") {
		return aggregateEvaluation.complete && aggregateEvaluation.evidence === "complete";
	}
	return aggregateEvaluation.evidence === "positive-only" && !aggregateEvaluation.complete;
}

function decodeV6(e: Record<string, unknown>): PlexGenerationMetadataDecodeResult {
	const common = [
		"version",
		"publicationLevel",
		"completeness",
		"itemCount",
		"canonicalizationVersion",
		"sections",
		"targetLedgerVersion",
		"targetCount",
		"targetDigest",
		"partialReasons",
		"coverageReceipt",
	] as const;
	if (
		e.canonicalizationVersion !== 1 ||
		!Number.isSafeInteger(e.itemCount) ||
		(e.itemCount as number) < 0 ||
		!hasValidV2PlexReceipt(
			e.coverageReceipt,
			e.publicationLevel as "authoritative" | "positive-only",
			e.itemCount as number,
		)
	)
		return { ok: false, reasonCode: "metadata_invalid" };
	const sections = normalizeV3Sections(e.sections);
	if (typeof sections === "string" || !exactV3Sections(sections, e.sections)) {
		return { ok: false, reasonCode: "metadata_invalid" };
	}
	const ledger = decodePlexTargetLedgerBinding(e);
	if (!ledger.ok || !ledger.binding) return { ok: false, reasonCode: "metadata_invalid" };
	if (e.publicationLevel === "authoritative") {
		if (
			!hasExactObjectKeys(e, [...common, "roots"]) ||
			e.completeness !== "complete" ||
			!Array.isArray(e.partialReasons) ||
			e.partialReasons.length !== 0
		)
			return { ok: false, reasonCode: "metadata_invalid" };
		const roots = normalizeV3Roots(e.roots, new Set(sections.map((section) => section.key)));
		if (typeof roots === "string" || !exactRoots(roots, e.roots))
			return { ok: false, reasonCode: "metadata_invalid" };
		return {
			ok: true,
			metadata: {
				version: 6,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: e.itemCount as number,
				canonicalizationVersion: 1,
				sections,
				roots,
				...ledger.binding,
				partialReasons: [],
				coverageReceipt: e.coverageReceipt,
			},
		};
	}
	if (
		e.publicationLevel !== "positive-only" ||
		e.completeness !== "partial" ||
		!hasExactObjectKeys(e, [...common, "observedRoots", "capabilities"])
	)
		return { ok: false, reasonCode: "metadata_invalid" };
	const decodedV4 = decodeV4(
		{
			version: 4,
			publicationLevel: e.publicationLevel,
			completeness: e.completeness,
			itemCount: e.itemCount,
			canonicalizationVersion: e.canonicalizationVersion,
			sections: e.sections,
			observedRoots: e.observedRoots,
			capabilities: e.capabilities,
			targetLedgerVersion: e.targetLedgerVersion,
			targetCount: e.targetCount,
			targetDigest: e.targetDigest,
			partialReasons: e.partialReasons,
		},
		{ allowEmptyPartialReasons: true },
	);
	if (!decodedV4.ok) return { ok: false, reasonCode: "metadata_invalid" };
	return {
		ok: true,
		metadata: {
			version: 6,
			publicationLevel: "positive-only",
			completeness: "partial",
			itemCount: e.itemCount as number,
			canonicalizationVersion: 1,
			sections,
			observedRoots: (decodedV4.metadata as PlexPositiveGenerationMetadataV4).observedRoots,
			capabilities: (decodedV4.metadata as PlexPositiveGenerationMetadataV4).capabilities,
			...ledger.binding,
			partialReasons: [...(decodedV4.metadata as PlexPositiveGenerationMetadataV4).partialReasons],
			coverageReceipt: e.coverageReceipt,
		},
	};
}

function decodeV5(e: Record<string, unknown>): PlexGenerationMetadataDecodeResult {
	const common = [
		"version",
		"publicationLevel",
		"completeness",
		"itemCount",
		"canonicalizationVersion",
		"sections",
		"targetLedgerVersion",
		"targetCount",
		"targetDigest",
		"partialReasons",
		"coverageReceipt",
	] as const;
	if (
		e.canonicalizationVersion !== 1 ||
		typeof e.itemCount !== "number" ||
		!Number.isSafeInteger(e.itemCount) ||
		e.itemCount < 0
	) {
		return { ok: false, reasonCode: "metadata_invalid" };
	}
	const sections = normalizeV3Sections(e.sections);
	if (typeof sections === "string" || !exactV3Sections(sections, e.sections)) {
		return { ok: false, reasonCode: "metadata_invalid" };
	}
	const ledger = decodePlexTargetLedgerBinding(e);
	if (!ledger.ok || !ledger.binding) return { ok: false, reasonCode: "metadata_invalid" };

	if (e.publicationLevel === "authoritative") {
		if (
			!hasExactObjectKeys(e, [...common, "roots"]) ||
			e.completeness !== "complete" ||
			!Array.isArray(e.partialReasons) ||
			e.partialReasons.length !== 0
		)
			return { ok: false, reasonCode: "metadata_invalid" };
		const roots = normalizeV3Roots(e.roots, new Set(sections.map((section) => section.key)));
		if (
			typeof roots === "string" ||
			!exactRoots(roots, e.roots) ||
			!hasCompletePlexReceipt(e.coverageReceipt, "authoritative", e.itemCount)
		)
			return { ok: false, reasonCode: "metadata_invalid" };
		return {
			ok: true,
			metadata: {
				version: 5,
				publicationLevel: "authoritative",
				completeness: "complete",
				itemCount: e.itemCount,
				canonicalizationVersion: 1,
				sections,
				roots,
				...ledger.binding,
				partialReasons: [],
				coverageReceipt: e.coverageReceipt,
			},
		};
	}

	if (
		e.publicationLevel !== "positive-only" ||
		!hasExactObjectKeys(e, [...common, "observedRoots", "capabilities"])
	)
		return { ok: false, reasonCode: "metadata_invalid" };
	const decodedV4 = decodeV4({
		version: 4,
		publicationLevel: e.publicationLevel,
		completeness: e.completeness,
		itemCount: e.itemCount,
		canonicalizationVersion: e.canonicalizationVersion,
		sections: e.sections,
		observedRoots: e.observedRoots,
		capabilities: e.capabilities,
		targetLedgerVersion: e.targetLedgerVersion,
		targetCount: e.targetCount,
		targetDigest: e.targetDigest,
		partialReasons: e.partialReasons,
	});
	if (!decodedV4.ok || !hasCompletePlexReceipt(e.coverageReceipt, "positive-only", e.itemCount))
		return { ok: false, reasonCode: "metadata_invalid" };
	const v4 = decodedV4.metadata as PlexPositiveGenerationMetadataV4;
	return {
		ok: true,
		metadata: {
			version: 5,
			publicationLevel: "positive-only",
			completeness: "partial",
			itemCount: v4.itemCount,
			canonicalizationVersion: 1,
			sections: v4.sections,
			observedRoots: v4.observedRoots,
			capabilities: v4.capabilities,
			targetLedgerVersion: v4.targetLedgerVersion,
			targetCount: v4.targetCount,
			targetDigest: v4.targetDigest,
			partialReasons: v4.partialReasons as [PlexPartialReason, ...PlexPartialReason[]],
			coverageReceipt: e.coverageReceipt as ProviderCoverageReceiptV1,
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
	if (envelope.version === 6) return decodeV6(envelope);
	if (envelope.version === 5) return decodeV5(envelope);
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
	targetLedger: PlexTargetLedgerBinding;
	partialReasons: readonly [];
	coverageReceipt: ProviderCoverageReceiptV1 | ProviderCoverageReceiptV2;
}): string {
	if (input.coverageReceipt.version === 1) {
		const metadata: Extract<PlexGenerationMetadataV5, { publicationLevel: "authoritative" }> = {
			version: 5,
			publicationLevel: "authoritative",
			completeness: "complete",
			itemCount: input.itemCount,
			canonicalizationVersion: input.canonicalizationVersion,
			sections: input.sections,
			roots: input.roots,
			...input.targetLedger,
			partialReasons: [],
			coverageReceipt: input.coverageReceipt,
		};
		const decoded = decodePlexGenerationMetadata(JSON.stringify(metadata));
		if (!decoded.ok || decoded.metadata.publicationLevel !== "authoritative") {
			throw new Error("Invalid authoritative Plex generation metadata");
		}
		return JSON.stringify(metadata);
	}
	const coverageReceipt = input.coverageReceipt;
	const metadata: Extract<PlexGenerationMetadataV6, { publicationLevel: "authoritative" }> = {
		version: 6,
		publicationLevel: "authoritative",
		completeness: "complete",
		itemCount: input.itemCount,
		canonicalizationVersion: input.canonicalizationVersion,
		sections: input.sections,
		roots: input.roots,
		...input.targetLedger,
		partialReasons: [],
		coverageReceipt,
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
	coverageReceipt: ProviderCoverageReceiptV1 | ProviderCoverageReceiptV2;
}): string {
	if (input.coverageReceipt.version === 1) {
		const metadata: Extract<PlexGenerationMetadataV5, { publicationLevel: "positive-only" }> = {
			version: 5,
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
			partialReasons: input.partialReasons as [PlexPartialReason, ...PlexPartialReason[]],
			coverageReceipt: input.coverageReceipt,
		};
		const decoded = decodePlexGenerationMetadata(JSON.stringify(metadata));
		if (!decoded.ok || decoded.metadata.publicationLevel !== "positive-only") {
			throw new Error("Invalid positive-only Plex generation metadata");
		}
		return JSON.stringify(metadata);
	}
	const coverageReceipt = input.coverageReceipt;
	const metadata: Extract<PlexGenerationMetadataV6, { publicationLevel: "positive-only" }> = {
		version: 6,
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
		partialReasons: [...input.partialReasons],
		coverageReceipt,
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
	const stale = options.maxAgeMs !== undefined && now.getTime() - publishedAt > options.maxAgeMs;
	const publishedGeneration = publishedGenerationSummary({
		generationId: status.generationId,
		publicationLevel: decoded.metadata.publicationLevel,
		publishedAt: status.lastRefreshedAt,
		itemCount: status.itemCount,
	});
	const currentPositiveOnly =
		!stale &&
		decoded.metadata.version === 5 &&
		decoded.metadata.publicationLevel === "positive-only" &&
		decoded.metadata.completeness === "partial" &&
		(attempt.attemptState === "partial" || attempt.attemptState === "success") &&
		(attempt.reasonCode === null || attempt.reasonCode === "latest_attempt_partial");
	const currentV6PositiveOnly =
		!stale &&
		decoded.metadata.version === 6 &&
		decoded.metadata.publicationLevel === "positive-only" &&
		decoded.metadata.completeness === "partial" &&
		(attempt.attemptState === "partial" || attempt.attemptState === "success") &&
		(attempt.reasonCode === null || attempt.reasonCode === "latest_attempt_partial");
	const settlementMetadataMissing =
		decoded.metadata.version < 3 && decoded.metadata.publicationLevel === "authoritative";
	const receiptMetadataMissing = decoded.metadata.version >= 3 && decoded.metadata.version < 5;
	const currentV6Authoritative =
		!stale &&
		decoded.metadata.version === 6 &&
		decoded.metadata.publicationLevel === "authoritative" &&
		decoded.metadata.completeness === "complete" &&
		attempt.attemptState === "success" &&
		attempt.reasonCode === null;
	const authoritativeCurrent =
		!stale &&
		(decoded.metadata.version === 5 || decoded.metadata.version === 6) &&
		decoded.metadata.publicationLevel === "authoritative" &&
		decoded.metadata.completeness === "complete" &&
		attempt.attemptState === "success" &&
		attempt.reasonCode === null;
	if (
		(decoded.metadata.version === 5 || decoded.metadata.version === 6) &&
		Date.parse(decoded.metadata.coverageReceipt.observedAt) !== publishedAt
	) {
		const result = unavailableForStatus("metadata_invalid", status);
		result.evidence.attemptState = attempt.attemptState;
		return result;
	}
	return {
		available: true,
		generationId: status.generationId,
		publishedAt: status.lastRefreshedAt,
		itemCount: status.itemCount,
		metadata: decoded.metadata,
		providerStatus: projectPlexProviderObservationStatus({
			status,
			metadata: decoded.metadata,
			now: options.now,
			maxAgeMs: options.maxAgeMs,
		}),
		evidence: {
			availability:
				authoritativeCurrent || currentPositiveOnly || currentV6PositiveOnly
					? "current"
					: "last-known",
			authority: authoritativeCurrent
				? "authoritative"
				: currentPositiveOnly || currentV6PositiveOnly
					? "positive-only"
					: "unavailable",
			attemptState: attempt.attemptState,
			publicationLevel: authoritativeCurrent
				? "authoritative"
				: currentPositiveOnly || currentV6PositiveOnly
					? "positive-only"
					: "unavailable",
			completeness:
				authoritativeCurrent || currentV6Authoritative
					? "complete"
					: currentPositiveOnly || currentV6PositiveOnly
						? "partial"
						: "unknown",
			reasonCodes: attempt.reasonCode
				? [attempt.reasonCode]
				: stale
					? ["published_generation_stale"]
					: settlementMetadataMissing
						? ["plex_settlement_metadata_missing"]
						: receiptMetadataMissing
							? ["receipt_missing"]
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
		published.metadata.completeness !== "complete" ||
		published.metadata.version !== 5
	) {
		const reasonCode = published.evidence.reasonCodes[0] ?? "mutation_authority_unavailable";
		const result = unavailable(reasonCode);
		result.evidence.attemptState = published.evidence.attemptState;
		result.evidence.publishedGeneration = published.evidence.publishedGeneration;
		result.providerStatus = published.providerStatus;
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
