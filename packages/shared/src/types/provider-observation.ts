import { z } from "zod";

export const providerObservationAvailabilitySchema = z.enum([
	"current",
	"partial",
	"last-known",
	"unavailable",
]);
export type ProviderObservationAvailability = z.infer<typeof providerObservationAvailabilitySchema>;

export const providerObservationEvidenceSchema = z.enum([
	"complete",
	"partial",
	"positive-only",
	"unknown",
]);
export type ProviderObservationEvidence = z.infer<typeof providerObservationEvidenceSchema>;

export const providerObservationAttemptStateSchema = z.enum([
	"idle",
	"running",
	"failed",
	"successful",
]);
export type ProviderObservationAttemptState = z.infer<typeof providerObservationAttemptStateSchema>;

/**
 * Stable, provider-agnostic UI state. This deliberately describes only the
 * operator-facing condition; provider-specific identity, scope, and error
 * details remain private to their owning surfaces.
 */
export const providerUiConditionSchema = z.enum([
	"current",
	"informational-gap",
	"collecting",
	"retryable-failure",
	"identity-action-required",
	"unavailable",
]);
export type ProviderUiCondition = z.infer<typeof providerUiConditionSchema>;

const safeProgressInteger = z.number().int().nonnegative().refine(Number.isSafeInteger);

/** Public durable-work progress; it contains counters only, never work identity. */
export const providerObservationProgressSchema = z
	.object({
		completedUnits: safeProgressInteger,
		totalUnits: safeProgressInteger,
		completedWork: safeProgressInteger,
		totalWork: safeProgressInteger,
	})
	.strict()
	.superRefine((progress, context) => {
		if (progress.totalUnits === 0 || progress.totalWork === 0) {
			context.addIssue({ code: "custom", message: "progress denominator must be positive" });
		}
		if (
			progress.completedUnits > progress.totalUnits ||
			progress.completedWork > progress.totalWork
		) {
			context.addIssue({ code: "custom", message: "progress exceeds total" });
		}
	});
export type ProviderObservationProgress = z.infer<typeof providerObservationProgressSchema>;

export const providerObservationWorkStateSchema = z.enum(["running", "failed"]);
export type ProviderObservationWorkState = z.infer<typeof providerObservationWorkStateSchema>;

export const providerObservationUiProjectionSchema = z
	.object({
		condition: providerUiConditionSchema,
		progress: providerObservationProgressSchema.optional(),
	})
	.strict();
export type ProviderObservationUiProjection = z.infer<typeof providerObservationUiProjectionSchema>;

export const providerObservationReasonCodeSchema = z.enum([
	"no-publication",
	"identity-unverified",
	"identity-changed",
	"refresh-running",
	"refresh-failed",
	"publication-superseded",
	"receipt-invalid",
	"coverage-incomplete",
	"accepted-skips",
	"provider-limit",
	"provider-unavailable",
	"publication-stale",
	"rows-inconsistent",
	"positive-only",
	"unknown-failure",
	"collection-deferred",
]);
export type ProviderObservationReasonCode = z.infer<typeof providerObservationReasonCodeSchema>;

export const providerObservationDomainSchema = z.enum([
	"library-inventory",
	"mapping",
	"watch-count",
	"watch-attribution",
	"on-deck",
	"episode-inventory",
]);
export type ProviderObservationDomain = z.infer<typeof providerObservationDomainSchema>;

export const providerObservationValueSemanticsSchema = z.enum(["exact", "lower-bound", "unknown"]);
export type ProviderObservationValueSemantics = z.infer<
	typeof providerObservationValueSemanticsSchema
>;

export const providerObservationAcceptedResponseSchema = z
	.object({
		status: z.literal("accepted"),
		cacheType: z.enum(["plex", "jellyfin", "tautulli"]),
	})
	.strict();
export type ProviderObservationAcceptedResponse = z.infer<
	typeof providerObservationAcceptedResponseSchema
>;

export type ProviderCoverageProvider =
	| "plex"
	| "plex_episode"
	| "jellyfin"
	| "jellyfin_episode"
	| "emby"
	| "emby_episode"
	| "tautulli"
	| "sonarr_history"
	| "radarr_history"
	| "prowlarr_history"
	| "lidarr_history"
	| "readarr_history";

export type ProviderObservationProvider = ProviderCoverageProvider;

export type ProviderSkipReasonCode =
	| "known-container"
	| "unsupported-provider-object"
	| "unsupported-personal-media"
	| "missing-stable-key"
	| "missing-supported-mapping"
	| "bounded-window-truncation";

export interface ProviderCoverageUnitV1 {
	scopeKey: string;
	expectedRawCount: number | null;
	pagesAttempted: number;
	pagesCompleted: number;
	rawObserved: number;
	sourceBindings: number;
	canonicalEntities: number;
	acceptedSkips: Array<{ reason: ProviderSkipReasonCode; count: number }>;
	fatalCount: number;
}

export interface ProviderCoverageReceiptV1 {
	version: 1;
	provider: ProviderObservationProvider;
	attemptStartedAt: string;
	observedAt: string;
	evidence: ProviderObservationEvidence;
	units: ProviderCoverageUnitV1[];
	publishedCanonicalEntities?: number;
}

const safeNonnegativeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger);

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

const providerSkipReasonSchema = z.enum([
	"known-container",
	"unsupported-provider-object",
	"unsupported-personal-media",
	"missing-stable-key",
	"missing-supported-mapping",
	"bounded-window-truncation",
]);

const acceptedSkipSchema = z
	.object({
		reason: providerSkipReasonSchema,
		count: safeNonnegativeInteger.refine((count) => count > 0),
	})
	.strict();

const scopeKeySchema = z.string().refine((scopeKey) => scopeKey.trim().length > 0);

const providerCoverageUnitSchema = z
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

type RefinementContext = z.RefinementCtx;

function rejectDuplicateValues<T>(
	values: readonly T[],
	getValue: (value: T) => string,
	message: string,
	context: RefinementContext,
): void {
	const seen = new Set<string>();
	for (const value of values) {
		const key = getValue(value);
		if (seen.has(key)) {
			context.addIssue({ code: "custom", message });
			return;
		}
		seen.add(key);
	}
}

export const providerCoverageUnitV1Schema = providerCoverageUnitSchema;

export const providerCoverageReceiptV1Schema = z
	.object({
		version: z.literal(1),
		provider: providerCoverageProviderSchema,
		attemptStartedAt: z.string().datetime(),
		observedAt: z.string().datetime(),
		evidence: providerObservationEvidenceSchema,
		units: z.array(providerCoverageUnitSchema),
		publishedCanonicalEntities: safeNonnegativeInteger.optional(),
	})
	.strict()
	.superRefine((receipt, context) => {
		rejectDuplicateValues(receipt.units, (unit) => unit.scopeKey, "duplicate scope key", context);
		if (Date.parse(receipt.attemptStartedAt) > Date.parse(receipt.observedAt)) {
			context.addIssue({
				code: "custom",
				message: "observation precedes attempt",
			});
		}
	});

export interface ProviderDomainCoverageV2 {
	domain: ProviderObservationDomain;
	evidence: ProviderObservationEvidence;
	valueSemantics: ProviderObservationValueSemantics;
	units: ProviderCoverageUnitV1[];
	publishedCanonicalEntities?: number;
}

export const providerDomainCoverageV2Schema = z
	.object({
		domain: providerObservationDomainSchema,
		evidence: providerObservationEvidenceSchema,
		valueSemantics: providerObservationValueSemanticsSchema,
		units: z.array(providerCoverageUnitSchema),
		publishedCanonicalEntities: safeNonnegativeInteger.optional(),
	})
	.strict()
	.superRefine((domain, context) => {
		rejectDuplicateValues(domain.units, (unit) => unit.scopeKey, "duplicate scope key", context);
	});

export interface ProviderCoverageReceiptV2 {
	version: 2;
	provider: ProviderObservationProvider;
	attemptStartedAt: string;
	observedAt: string;
	evidence: ProviderObservationEvidence;
	units: ProviderCoverageUnitV1[];
	publishedCanonicalEntities?: number;
	domains: ProviderDomainCoverageV2[];
}

export const providerCoverageReceiptV2Schema = z
	.object({
		version: z.literal(2),
		provider: providerCoverageProviderSchema,
		attemptStartedAt: z.string().datetime(),
		observedAt: z.string().datetime(),
		evidence: providerObservationEvidenceSchema,
		units: z.array(providerCoverageUnitSchema),
		publishedCanonicalEntities: safeNonnegativeInteger.optional(),
		domains: z.array(providerDomainCoverageV2Schema),
	})
	.strict()
	.superRefine((receipt, context) => {
		rejectDuplicateValues(receipt.domains, (domain) => domain.domain, "duplicate domain", context);
		if (Date.parse(receipt.attemptStartedAt) > Date.parse(receipt.observedAt)) {
			context.addIssue({
				code: "custom",
				message: "observation precedes attempt",
			});
		}
	});

export const providerCoverageReceiptSchema = z.discriminatedUnion("version", [
	providerCoverageReceiptV1Schema,
	providerCoverageReceiptV2Schema,
]);
export type ProviderCoverageReceipt = z.infer<typeof providerCoverageReceiptSchema>;

export const providerDomainObservationStatusSchema = z
	.object({
		domain: providerObservationDomainSchema,
		availability: providerObservationAvailabilitySchema,
		evidence: providerObservationEvidenceSchema,
		valueSemantics: providerObservationValueSemanticsSchema,
		observedAt: z.string().datetime().nullable(),
		reasonCodes: z.array(providerObservationReasonCodeSchema),
	})
	.strict();
export type ProviderDomainObservationStatus = z.infer<typeof providerDomainObservationStatusSchema>;

export const providerObservationStatusSchema = z.object({
	availability: providerObservationAvailabilitySchema,
	evidence: providerObservationEvidenceSchema,
	observedAt: z.string().datetime().nullable(),
	ageSeconds: z.number().int().nonnegative().nullable(),
	latestAttempt: providerObservationAttemptStateSchema,
	reasonCodes: z.array(providerObservationReasonCodeSchema),
	domains: z.array(providerDomainObservationStatusSchema).optional(),
});
export type ProviderObservationStatus = z.infer<typeof providerObservationStatusSchema>;

const identityReasonCodes = new Set<ProviderObservationReasonCode>([
	"identity-unverified",
	"identity-changed",
]);
const informationalReasonCodes = new Set<ProviderObservationReasonCode>([
	"accepted-skips",
	"provider-limit",
	"positive-only",
	"coverage-incomplete",
]);
const retryableReasonCodes = new Set<ProviderObservationReasonCode>([
	"refresh-failed",
	"provider-unavailable",
]);

function isCurrentUsableDomain(domain: ProviderDomainObservationStatus): boolean {
	return (
		domain.availability === "current" &&
		(domain.valueSemantics === "exact" || domain.valueSemantics === "lower-bound") &&
		domain.evidence !== "unknown"
	);
}

function hasCurrentUsableDomains(
	status: ProviderObservationStatus,
	requiredDomains: readonly ProviderObservationDomain[] | undefined,
): boolean {
	const domains = status.domains;
	if (!domains || domains.length === 0) return false;
	const requested =
		requiredDomains && requiredDomains.length > 0
			? requiredDomains
			: domains.map((domain) => domain.domain);
	return requested.every((requestedDomain) =>
		domains.some((domain) => domain.domain === requestedDomain && isCurrentUsableDomain(domain)),
	);
}

/**
 * Classifies a proven provider status once. Consumers share this projection
 * instead of independently treating benign coverage gaps as failures.
 */
export function projectProviderObservationUi(
	status: ProviderObservationStatus,
	work?: { state: ProviderObservationWorkState; progress?: unknown } & Record<string, unknown>,
	requiredDomains?: readonly ProviderObservationDomain[],
): ProviderObservationUiProjection {
	const parsedStatusResult = providerObservationStatusSchema.safeParse(status);
	if (!parsedStatusResult.success) {
		return providerObservationUiProjectionSchema.parse({ condition: "unavailable" });
	}
	const parsedStatus = parsedStatusResult.data;
	const rawProgress = (() => {
		if (work?.progress !== undefined) return work.progress;
		if (!work) return undefined;
		const { state: _state, progress: _progress, ...counters } = work;
		return counters;
	})();
	const progress = providerObservationProgressSchema.safeParse(rawProgress);
	const result = (condition: ProviderUiCondition): ProviderObservationUiProjection =>
		providerObservationUiProjectionSchema.parse({
			condition,
			...(progress.success ? { progress: progress.data } : {}),
		});

	if (parsedStatus.reasonCodes.some((code) => identityReasonCodes.has(code))) {
		return result("identity-action-required");
	}
	if (work?.state === "running" || parsedStatus.latestAttempt === "running") {
		return result("collecting");
	}
	if (
		work?.state === "failed" ||
		parsedStatus.latestAttempt === "failed" ||
		parsedStatus.reasonCodes.some((code) => retryableReasonCodes.has(code))
	) {
		return result("retryable-failure");
	}
	const informational = parsedStatus.reasonCodes.some((code) => informationalReasonCodes.has(code));
	const usable = parsedStatus.domains
		? hasCurrentUsableDomains(parsedStatus, requiredDomains)
		: (parsedStatus.availability === "current" && parsedStatus.evidence !== "unknown") ||
			(parsedStatus.evidence === "positive-only" && parsedStatus.availability === "partial");
	if (usable) return result(informational ? "informational-gap" : "current");
	return result("unavailable");
}

export type ProviderObservationUiInput = {
	status: ProviderObservationStatus;
	work?: { state: ProviderObservationWorkState; progress?: unknown } & Record<string, unknown>;
	requiredDomains?: readonly ProviderObservationDomain[];
};

/** Priority order for one deduplicated notice across independently fetched sources. */
export function aggregateProviderObservationUi(
	statuses: readonly (ProviderObservationStatus | ProviderObservationUiInput)[],
	isError = false,
): ProviderUiCondition | undefined {
	if (isError) return "unavailable";
	const conditions = statuses.map((input) => {
		if ("status" in input) {
			return projectProviderObservationUi(input.status, input.work, input.requiredDomains)
				.condition;
		}
		return projectProviderObservationUi(input).condition;
	});
	if (conditions.length === 0) return undefined;
	for (const condition of [
		"identity-action-required",
		"collecting",
		"retryable-failure",
		"unavailable",
		"informational-gap",
		"current",
	] as const) {
		if (conditions.includes(condition)) return condition;
	}
	return undefined;
}

export const providerObservationSourceServiceSchema = z.enum(["jellyfin", "emby"]);
export type ProviderObservationSourceService = z.infer<
	typeof providerObservationSourceServiceSchema
>;

export const providerObservationSourceCacheTypeSchema = z.enum(["jellyfin", "jellyfin_episode"]);
export type ProviderObservationSourceCacheType = z.infer<
	typeof providerObservationSourceCacheTypeSchema
>;

export const providerObservationSourceStatusSchema = z
	.object({
		instanceId: z.string().min(1),
		service: providerObservationSourceServiceSchema,
		cacheType: providerObservationSourceCacheTypeSchema,
		status: providerObservationStatusSchema,
	})
	.strict();
export type ProviderObservationSourceStatus = z.infer<typeof providerObservationSourceStatusSchema>;

export const providerObservationStatusEnvelopeSchema = z
	.object({
		availability: providerObservationAvailabilitySchema,
		sources: z.array(providerObservationSourceStatusSchema),
	})
	.strict();
export type ProviderObservationStatusEnvelope = z.infer<
	typeof providerObservationStatusEnvelopeSchema
>;

export function aggregateProviderObservationStatuses(
	sources: readonly ProviderObservationSourceStatus[],
): ProviderObservationStatusEnvelope | undefined {
	if (sources.length === 0) return undefined;

	const validatedSources = sources
		.map((source) => providerObservationSourceStatusSchema.parse(source))
		.sort((left, right) => {
			if (left.instanceId !== right.instanceId) {
				return left.instanceId < right.instanceId ? -1 : 1;
			}
			if (left.cacheType !== right.cacheType) {
				return left.cacheType < right.cacheType ? -1 : 1;
			}
			if (left.service !== right.service) {
				return left.service < right.service ? -1 : 1;
			}
			return 0;
		});

	const availability = validatedSources.every(({ status }) => status.availability === "current")
		? "current"
		: validatedSources.every(({ status }) => status.availability === "last-known")
			? "last-known"
			: validatedSources.every(({ status }) => status.availability === "unavailable")
				? "unavailable"
				: "partial";

	return providerObservationStatusEnvelopeSchema.parse({
		availability,
		sources: validatedSources,
	});
}
