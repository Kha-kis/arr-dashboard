import {
	type ProviderCoverageUnitV1,
	type ProviderObservationAvailability,
	type ProviderObservationDomain,
	type ProviderObservationEvidence,
	type ProviderObservationProvider,
	type ProviderObservationReasonCode,
	type ProviderObservationValueSemantics,
	providerDomainCoverageV2Schema,
	providerObservationEvidenceSchema,
	type ProviderCoverageReceipt as SharedProviderCoverageReceipt,
} from "@arr/shared";
import { z } from "zod";

export type {
	ProviderCoverageProvider,
	ProviderCoverageReceiptV1,
	ProviderCoverageReceiptV2,
	ProviderCoverageUnitV1,
	ProviderDomainCoverageV2,
	ProviderObservationProvider,
	ProviderSkipReasonCode,
} from "@arr/shared";

export type ProviderCoverageReceipt = SharedProviderCoverageReceipt;

const providerCoverageProviderSchema = z.enum([
	"plex",
	"plex_episode",
	"jellyfin",
	"jellyfin_episode",
	"emby",
	"emby_episode",
	"tautulli",
	"sonarr_history",
	"radarr_history",
	"prowlarr_history",
	"lidarr_history",
	"readarr_history",
]);

const safeNonnegativeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger);

const providerSkipReasonSchema = z.enum([
	"known-container",
	"unsupported-provider-object",
	"unsupported-personal-media",
	"missing-stable-key",
	"missing-supported-mapping",
	"duplicate-source-observation",
	"bounded-window-truncation",
]);

const acceptedSkipSchema = z
	.object({
		reason: providerSkipReasonSchema,
		count: safeNonnegativeInteger.refine((count) => count > 0),
	})
	.strict();

const scopeKeySchema = z.string().refine((scopeKey) => scopeKey.trim().length > 0);

const providerCoverageUnitV1Schema = z
	.object({
		scopeKey: scopeKeySchema,
		expectedRawCount: safeNonnegativeInteger.nullable(),
		pagesAttempted: safeNonnegativeInteger,
		pagesCompleted: safeNonnegativeInteger,
		rawObserved: safeNonnegativeInteger,
		sourceBindings: safeNonnegativeInteger,
		canonicalEntities: safeNonnegativeInteger,
		acceptedSkips: z.array(acceptedSkipSchema),
		fatalCount: safeNonnegativeInteger,
	})
	.strict()
	.superRefine((unit, context) => {
		const reasons = new Set<string>();
		for (const acceptedSkip of unit.acceptedSkips) {
			if (reasons.has(acceptedSkip.reason)) {
				context.addIssue({
					code: "custom",
					message: "duplicate accepted skip reason",
				});
				return;
			}
			reasons.add(acceptedSkip.reason);
		}
	});

const providerCoverageReceiptV1Schema = z
	.object({
		version: z.literal(1),
		provider: providerCoverageProviderSchema,
		attemptStartedAt: z.string().datetime(),
		observedAt: z.string().datetime(),
		evidence: providerObservationEvidenceSchema,
		units: z.array(providerCoverageUnitV1Schema),
		publishedCanonicalEntities: safeNonnegativeInteger.optional(),
	})
	.strict()
	.superRefine((receipt, context) => {
		const scopeKeys = new Set<string>();
		for (const unit of receipt.units) {
			if (scopeKeys.has(unit.scopeKey)) {
				context.addIssue({
					code: "custom",
					message: "duplicate scope key",
				});
				return;
			}
			scopeKeys.add(unit.scopeKey);
		}

		if (Date.parse(receipt.attemptStartedAt) > Date.parse(receipt.observedAt)) {
			context.addIssue({
				code: "custom",
				message: "observation precedes attempt",
			});
		}
	});

export interface ProviderCoverageEvaluation {
	valid: boolean;
	complete: boolean;
	evidence: ProviderObservationEvidence;
	provider?: ProviderObservationProvider;
	rawObserved: number;
	sourceBindings: number;
	canonicalEntities: number;
	publishedCanonicalEntities: number | null;
	acceptedSkipCount: number;
	fatalCount: number;
	pagesAttempted: number;
	pagesCompleted: number;
	reasonCodes: ProviderObservationReasonCode[];
	domains?: ReadonlyMap<ProviderObservationDomain, ProviderCoverageDomainEvaluation>;
}

export interface ProviderCoverageDomainEvaluation {
	domain: ProviderObservationDomain;
	availability: ProviderObservationAvailability;
	evidence: ProviderObservationEvidence;
	valueSemantics: ProviderObservationValueSemantics;
	observedAt: string | null;
	reasonCodes: ProviderObservationReasonCode[];
}

const invalidReceipt = (): ProviderCoverageEvaluation => ({
	valid: false,
	complete: false,
	evidence: "unknown",
	rawObserved: 0,
	sourceBindings: 0,
	canonicalEntities: 0,
	publishedCanonicalEntities: null,
	acceptedSkipCount: 0,
	fatalCount: 0,
	pagesAttempted: 0,
	pagesCompleted: 0,
	reasonCodes: ["receipt-invalid"],
});

function addSafe(left: number, right: number): number | null {
	const result = left + right;
	return Number.isSafeInteger(result) ? result : null;
}

function sumAcceptedSkips(unit: ProviderCoverageUnitV1): number | null {
	let total = 0;
	for (const acceptedSkip of unit.acceptedSkips) {
		total = addSafe(total, acceptedSkip.count) ?? -1;
		if (total < 0) return null;
	}
	return total;
}

interface ProviderCoverageEvaluationDiagnostics {
	evaluation: ProviderCoverageEvaluation;
	conserved: boolean;
	expectedTotalsMatch: boolean;
}

function invalidDiagnostics(): ProviderCoverageEvaluationDiagnostics {
	return {
		evaluation: invalidReceipt(),
		conserved: false,
		expectedTotalsMatch: false,
	};
}

function evaluateParsedReceiptWithDiagnostics(parsed: {
	provider?: ProviderObservationProvider;
	evidence: ProviderObservationEvidence;
	units: ProviderCoverageUnitV1[];
	publishedCanonicalEntities?: number;
}): ProviderCoverageEvaluationDiagnostics {
	const totals = {
		rawObserved: 0,
		sourceBindings: 0,
		canonicalEntities: 0,
		acceptedSkipCount: 0,
		fatalCount: 0,
		pagesAttempted: 0,
		pagesCompleted: 0,
	};
	let conserved = true;
	let expectedTotalsMatch = true;
	let hasBoundedWindowTruncation = false;

	for (const unit of parsed.units) {
		const acceptedSkipCount = sumAcceptedSkips(unit);
		if (acceptedSkipCount === null) return invalidDiagnostics();

		const sourceTotal = addSafe(unit.sourceBindings, acceptedSkipCount);
		if (sourceTotal === null || sourceTotal !== unit.rawObserved) conserved = false;
		if (unit.expectedRawCount !== null && unit.expectedRawCount !== unit.rawObserved) {
			expectedTotalsMatch = false;
		}
		if (unit.acceptedSkips.some((skip) => skip.reason === "bounded-window-truncation")) {
			hasBoundedWindowTruncation = true;
		}

		const aggregateFields = [
			["rawObserved", unit.rawObserved],
			["sourceBindings", unit.sourceBindings],
			["canonicalEntities", unit.canonicalEntities],
			["fatalCount", unit.fatalCount],
			["pagesAttempted", unit.pagesAttempted],
			["pagesCompleted", unit.pagesCompleted],
		] as const;
		for (const [field, value] of aggregateFields) {
			const total = addSafe(totals[field], value);
			if (total === null) return invalidDiagnostics();
			totals[field] = total;
		}
		const skipTotal = addSafe(totals.acceptedSkipCount, acceptedSkipCount);
		if (skipTotal === null) return invalidDiagnostics();
		totals.acceptedSkipCount = skipTotal;
	}

	const publishedCanonicalEntities = parsed.publishedCanonicalEntities ?? null;
	if (publishedCanonicalEntities !== null) {
		const largestUnitCanonicalEntities = parsed.units.reduce(
			(largest, unit) => Math.max(largest, unit.canonicalEntities),
			0,
		);
		if (
			publishedCanonicalEntities < largestUnitCanonicalEntities ||
			publishedCanonicalEntities > totals.canonicalEntities
		) {
			return invalidDiagnostics();
		}
	}

	const complete =
		parsed.evidence === "complete" &&
		parsed.units.length > 0 &&
		parsed.units.every(
			(unit) => unit.pagesAttempted === unit.pagesCompleted && unit.fatalCount === 0,
		) &&
		!hasBoundedWindowTruncation &&
		conserved &&
		expectedTotalsMatch;

	const reasonCodes: ProviderObservationReasonCode[] = [];
	if (parsed.evidence === "positive-only") reasonCodes.push("positive-only");
	if (hasBoundedWindowTruncation) reasonCodes.push("provider-limit");
	if (totals.acceptedSkipCount > 0) reasonCodes.push("accepted-skips");
	if (!complete) reasonCodes.push("coverage-incomplete");

	return {
		evaluation: {
			valid: true,
			complete,
			evidence: parsed.evidence,
			provider: parsed.provider,
			...totals,
			publishedCanonicalEntities,
			reasonCodes,
		},
		conserved,
		expectedTotalsMatch,
	};
}

function evaluateParsedReceipt(parsed: {
	provider?: ProviderObservationProvider;
	evidence: ProviderObservationEvidence;
	units: ProviderCoverageUnitV1[];
	publishedCanonicalEntities?: number;
}): ProviderCoverageEvaluation {
	return evaluateParsedReceiptWithDiagnostics(parsed).evaluation;
}

const V2_RECEIPT_KEYS = new Set([
	"version",
	"provider",
	"attemptStartedAt",
	"observedAt",
	"evidence",
	"units",
	"publishedCanonicalEntities",
	"domains",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseV2Envelope(value: unknown): {
	core: ProviderCoverageEvaluation;
	provider: ProviderObservationProvider;
	observedAt: string;
	domains: unknown[];
} | null {
	if (!isRecord(value) || value.version !== 2) return null;
	if (Object.keys(value).some((key) => !V2_RECEIPT_KEYS.has(key))) return null;
	if (!Array.isArray(value.domains)) return null;
	const core = providerCoverageReceiptV1Schema.safeParse({
		version: 1,
		provider: value.provider,
		attemptStartedAt: value.attemptStartedAt,
		observedAt: value.observedAt,
		evidence: value.evidence,
		units: value.units,
		...(value.publishedCanonicalEntities === undefined
			? {}
			: { publishedCanonicalEntities: value.publishedCanonicalEntities }),
	});
	if (!core.success) return null;
	return {
		core: evaluateParsedReceipt(core.data),
		provider: core.data.provider,
		observedAt: core.data.observedAt,
		domains: value.domains,
	};
}

const DOMAIN_ORDER: readonly ProviderObservationDomain[] = [
	"library-inventory",
	"mapping",
	"watch-count",
	"watch-attribution",
	"on-deck",
	"episode-inventory",
];

const DOMAIN_SET = new Set<ProviderObservationDomain>(DOMAIN_ORDER);

function uniqueReasonCodes(
	reasons: readonly ProviderObservationReasonCode[],
): ProviderObservationReasonCode[] {
	return [...new Set(reasons)];
}

function hasAffectingSkip(units: readonly ProviderCoverageUnitV1[]): boolean {
	return units.some((unit) =>
		unit.acceptedSkips.some(
			(skip) => skip.reason !== "known-container" && skip.reason !== "unsupported-provider-object",
		),
	);
}

function unknownDomain(
	domain: ProviderObservationDomain,
	reason: ProviderObservationReasonCode,
): ProviderCoverageDomainEvaluation {
	return {
		domain,
		availability: "unavailable",
		evidence: "unknown",
		valueSemantics: "unknown",
		observedAt: null,
		reasonCodes: [reason],
	};
}

function evaluateDomain(
	value: unknown,
	provider: ProviderObservationProvider,
	observedAt: string,
): ProviderCoverageDomainEvaluation | null {
	if (
		!isRecord(value) ||
		typeof value.domain !== "string" ||
		!DOMAIN_SET.has(value.domain as ProviderObservationDomain)
	) {
		return null;
	}
	const domain = value.domain as ProviderObservationDomain;
	const parsed = providerDomainCoverageV2Schema.safeParse(value);
	if (!parsed.success) return unknownDomain(domain, "receipt-invalid");
	const diagnostics = evaluateParsedReceiptWithDiagnostics({
		provider,
		evidence: parsed.data.evidence,
		units: parsed.data.units,
		...(parsed.data.publishedCanonicalEntities === undefined
			? {}
			: { publishedCanonicalEntities: parsed.data.publishedCanonicalEntities }),
	});
	const evaluation = diagnostics.evaluation;
	const reasons = uniqueReasonCodes(evaluation.reasonCodes);
	if (!evaluation.valid || evaluation.fatalCount > 0)
		return unknownDomain(domain, "receipt-invalid");
	if (!diagnostics.conserved || !diagnostics.expectedTotalsMatch) {
		return unknownDomain(domain, "receipt-invalid");
	}
	if (parsed.data.valueSemantics === "unknown" || evaluation.evidence === "unknown") {
		return unknownDomain(domain, "coverage-incomplete");
	}
	if (
		parsed.data.valueSemantics === "lower-bound" &&
		(evaluation.rawObserved === 0 || evaluation.sourceBindings === 0)
	) {
		return unknownDomain(domain, "coverage-incomplete");
	}
	if (
		parsed.data.valueSemantics === "exact" &&
		(!evaluation.complete ||
			evaluation.evidence !== "complete" ||
			hasAffectingSkip(parsed.data.units))
	) {
		return unknownDomain(domain, "receipt-invalid");
	}
	return {
		domain,
		availability: "current",
		evidence: parsed.data.evidence,
		valueSemantics: parsed.data.valueSemantics,
		observedAt,
		reasonCodes: reasons,
	};
}

/** Internal implementation shared by the receipt and status projections. */
export function evaluateProviderDomainCoverageMap(
	receipt: unknown,
): ReadonlyMap<ProviderObservationDomain, ProviderCoverageDomainEvaluation> {
	const envelope = parseV2Envelope(receipt);
	if (!envelope) return new Map();
	const result = new Map<ProviderObservationDomain, ProviderCoverageDomainEvaluation>();
	for (const rawDomain of envelope.domains) {
		const evaluated = evaluateDomain(rawDomain, envelope.provider, envelope.observedAt);
		if (!evaluated) continue;
		if (result.has(evaluated.domain)) {
			result.set(evaluated.domain, unknownDomain(evaluated.domain, "receipt-invalid"));
			continue;
		}
		result.set(evaluated.domain, evaluated);
	}
	return result;
}

export function evaluateProviderCoverageReceipt(value: unknown): ProviderCoverageEvaluation {
	const parsed = providerCoverageReceiptV1Schema.safeParse(value);
	if (parsed.success) return evaluateParsedReceipt(parsed.data);

	const envelope = parseV2Envelope(value);
	if (!envelope) return invalidReceipt();
	const domains = evaluateProviderDomainCoverageMap(value);
	const allDomainsAreExact =
		envelope.domains.length > 0 &&
		envelope.domains.length === domains.size &&
		envelope.domains.every((raw) => {
			if (!isRecord(raw) || typeof raw.domain !== "string") return false;
			const evaluated = domains.get(raw.domain as ProviderObservationDomain);
			return evaluated?.availability === "current" && evaluated.valueSemantics === "exact";
		});
	const aggregate =
		envelope.core.evidence === "complete" && !allDomainsAreExact
			? {
					...envelope.core,
					complete: false,
					evidence: "partial" as const,
					reasonCodes: uniqueReasonCodes([...envelope.core.reasonCodes, "coverage-incomplete"]),
				}
			: envelope.core;
	return { ...aggregate, domains };
}
