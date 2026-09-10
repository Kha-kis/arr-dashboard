import { createHash } from "node:crypto";
import type { ProviderObservationReasonCode } from "@arr/shared";
import { providerObservationReasonCodeSchema } from "@arr/shared";
import { z } from "zod";

export type ObservationRunProvider = "plex_episode" | "jellyfin_episode";
export type ObservationRunState = "running" | "complete" | "failed" | "invalidated";
export type ObservationUnitState = ObservationRunState | "pending";
export type ObservationRunPhase = "collect" | "verify";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "Expected lowercase SHA-256 hex");
const safeCountSchema = z.number().int().nonnegative().refine(Number.isSafeInteger);
const providerSchema = z.enum(["plex_episode", "jellyfin_episode"]);
const phaseSchema = z.enum(["collect", "verify"]);

export const providerObservationReasonCodes = providerObservationReasonCodeSchema.options;
export const observationRunProviderSchema = providerSchema;
export const observationRunStateSchema = z.enum(["running", "complete", "failed", "invalidated"]);
export const observationUnitStateSchema = z.enum([
	"pending",
	"running",
	"complete",
	"failed",
	"invalidated",
]);
export const observationRunPhaseSchema = phaseSchema;
export const observationSha256Schema = sha256Schema;
export const observationCountSchema = safeCountSchema;

export const OBSERVATION_SCOPE_PAYLOAD_MAX_BYTES = 4096;
export const OBSERVATION_CATALOG_ROOT_MAX_BYTES = 1024 * 1024;

function scopePayloadSchema(maxBytes: number) {
	return z.string().superRefine((value, ctx) => {
		if (Buffer.byteLength(value, "utf8") > maxBytes) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `scopePayload exceeds ${maxBytes} UTF-8 bytes`,
			});
			return;
		}
		try {
			JSON.parse(value);
		} catch {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scopePayload must be valid JSON" });
		}
	});
}

export const observationScopePayloadSchema = scopePayloadSchema(
	OBSERVATION_SCOPE_PAYLOAD_MAX_BYTES,
);

export const observationRunAuthoritySchema = z
	.object({
		provider: providerSchema,
		cacheType: providerSchema,
		instanceId: z.string().min(1),
		parentGenerationId: z.string().nullable().optional(),
		targetDigest: sha256Schema,
		connectionGeneration: safeCountSchema,
		identityGeneration: safeCountSchema,
	})
	.strict();

export const observationRunUnitSeedSchema = z
	.object({
		ordinal: safeCountSchema,
		scopeKey: z.string().min(1).max(256),
		scopeDigest: sha256Schema,
		scopePayload: observationScopePayloadSchema.optional(),
		phase: phaseSchema,
		expectedTargets: safeCountSchema,
	})
	.strict();

const catalogRootUnitSeedSchema = observationRunUnitSeedSchema.extend({
	scopePayload: scopePayloadSchema(OBSERVATION_CATALOG_ROOT_MAX_BYTES),
});

/** A single bounded V3 catalog root; every other provider/unit retains the 4 KiB limit. */
export function parseObservationRunUnitSeed(
	unit: ObservationRunUnitSeed,
	authority: ObservationRunAuthority,
): ObservationRunUnitSeed {
	const catalogRoot =
		authority.provider === "jellyfin_episode" &&
		authority.cacheType === "jellyfin_episode" &&
		/^jellyfin-episode-parent-v3:[a-f0-9]{64}$/.test(authority.parentGenerationId ?? "") &&
		unit.ordinal === 0 &&
		unit.phase === "collect";
	return (catalogRoot ? catalogRootUnitSeedSchema : observationRunUnitSeedSchema).parse(unit);
}

export function decodeObservationRunState(value: unknown): ObservationRunState {
	return observationRunStateSchema.parse(value);
}

export function decodeObservationUnitState(value: unknown): ObservationUnitState {
	return observationUnitStateSchema.parse(value);
}

export function decodeObservationRunProvider(value: unknown): ObservationRunProvider {
	return observationRunProviderSchema.parse(value);
}

export function decodeProviderObservationReasonCode(value: unknown): ProviderObservationReasonCode {
	return providerObservationReasonCodeSchema.parse(value);
}

export interface ObservationRunAuthority {
	provider: ObservationRunProvider;
	cacheType: ObservationRunProvider;
	instanceId: string;
	parentGenerationId: string | null;
	targetDigest: string;
	connectionGeneration: number;
	identityGeneration: number;
}

export interface ObservationRunUnitSeed {
	ordinal: number;
	scopeKey: string;
	scopeDigest: string;
	scopePayload?: string;
	phase: ObservationRunPhase;
	expectedTargets: number;
}

export interface ObservationUnitClaim {
	runId: string;
	unitId: string;
	claimToken: string;
	authorityKey: string;
	scopeKey: string;
	scopePayload: string | null;
	phase: ObservationRunPhase;
	cursor: number;
	expectedRawCount: number | null;
	observedRawCount: number;
}

export interface ObservationRunProgress {
	state: ObservationRunState;
	completedUnits: number;
	totalUnits: number;
	completedWork: number;
	totalWork: number;
	reasonCode?: ProviderObservationReasonCode;
}

export function buildObservationAuthorityKey(input: ObservationRunAuthority): string {
	const parsed = observationRunAuthoritySchema.parse(input);
	return createHash("sha256")
		.update(
			JSON.stringify([
				parsed.provider,
				parsed.cacheType,
				parsed.instanceId,
				parsed.parentGenerationId ?? null,
				parsed.targetDigest,
				parsed.connectionGeneration,
				parsed.identityGeneration,
			]),
		)
		.digest("hex");
}

export function buildObservationActiveSlotKey(input: {
	instanceId: string;
	cacheType: ObservationRunProvider;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				z.string().min(1).parse(input.instanceId),
				providerSchema.parse(input.cacheType),
			]),
		)
		.digest("hex");
}
