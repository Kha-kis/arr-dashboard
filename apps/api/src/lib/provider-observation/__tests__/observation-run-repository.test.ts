import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createOrLoadObservationRun } from "../observation-run-repository.js";
import {
	buildObservationActiveSlotKey,
	buildObservationAuthorityKey,
	decodeObservationRunState,
	decodeProviderObservationReasonCode,
	observationRunUnitSeedSchema,
	parseObservationRunUnitSeed,
	providerObservationReasonCodes,
} from "../observation-run-types.js";

const authority = {
	provider: "plex_episode" as const,
	cacheType: "plex_episode" as const,
	instanceId: "instance-1",
	parentGenerationId: "parent-1",
	targetDigest: "a".repeat(64),
	connectionGeneration: 2,
	identityGeneration: 3,
};

describe("provider observation runtime codecs", () => {
	it("allows the bounded catalog payload only in the exact V3 root collect unit", () => {
		const native = {
			...authority,
			provider: "jellyfin_episode" as const,
			cacheType: "jellyfin_episode" as const,
			parentGenerationId: `jellyfin-episode-parent-v3:${"a".repeat(64)}`,
		};
		const unit = {
			ordinal: 0,
			phase: "collect" as const,
			scopeKey: "root",
			scopeDigest: "b".repeat(64),
			expectedTargets: 1,
			scopePayload: JSON.stringify({
				catalogProvenance: { version: 3 },
				padding: "x".repeat(5000),
			}),
		};
		expect(() => observationRunUnitSeedSchema.parse(unit)).toThrow();
		expect(parseObservationRunUnitSeed(unit, native)).toEqual(unit);
		for (const invalidAuthority of [
			authority,
			{ ...native, cacheType: "plex_episode" as const },
			{ ...native, parentGenerationId: `jellyfin-episode-parent-v2:${"a".repeat(64)}` },
			{ ...native, parentGenerationId: "jellyfin-episode-parent-v3:invalid" },
		]) {
			expect(() => parseObservationRunUnitSeed(unit, invalidAuthority)).toThrow();
		}
		expect(() => parseObservationRunUnitSeed({ ...unit, ordinal: 1 }, native)).toThrow();
		expect(() => parseObservationRunUnitSeed({ ...unit, phase: "verify" }, native)).toThrow();
		expect(() =>
			parseObservationRunUnitSeed(
				{
					...unit,
					scopePayload: JSON.stringify({
						catalogProvenance: { version: 3 },
						padding: "é".repeat(524288),
					}),
				},
				native,
			),
		).toThrow();
	});

	it("builds deterministic ordered-tuple authority and active-slot SHA-256 keys", () => {
		const expected = createHash("sha256")
			.update(
				JSON.stringify([
					"plex_episode",
					"plex_episode",
					"instance-1",
					"parent-1",
					"a".repeat(64),
					2,
					3,
				]),
			)
			.digest("hex");
		expect(buildObservationAuthorityKey({ ...authority })).toBe(expected);
		expect(buildObservationAuthorityKey({ ...authority, identityGeneration: 4 })).not.toBe(
			expected,
		);
		expect(buildObservationAuthorityKey({ ...authority, connectionGeneration: 4 })).not.toBe(
			expected,
		);
		expect(buildObservationAuthorityKey({ ...authority, targetDigest: "b".repeat(64) })).not.toBe(
			expected,
		);
		expect(buildObservationAuthorityKey({ ...authority, parentGenerationId: "parent-2" })).not.toBe(
			expected,
		);
		const slot = buildObservationActiveSlotKey({
			instanceId: "instance-1",
			cacheType: "plex_episode",
		});
		expect(slot).toMatch(/^[0-9a-f]{64}$/);
		expect(
			buildObservationActiveSlotKey({ instanceId: "instance-1", cacheType: "plex_episode" }),
		).toBe(slot);
		expect(
			buildObservationActiveSlotKey({ instanceId: "instance-1", cacheType: "jellyfin_episode" }),
		).not.toBe(slot);
	});

	it("strictly decodes bounded states, reason codes, digests, counts, and JSON payloads", () => {
		expect(decodeObservationRunState("running")).toBe("running");
		expect(decodeProviderObservationReasonCode("provider-unavailable")).toBe(
			"provider-unavailable",
		);
		expect(providerObservationReasonCodes).toContain("unknown-failure");
		expect(() => decodeObservationRunState("RUNNING")).toThrow();
		expect(() => decodeProviderObservationReasonCode("raw-provider-error")).toThrow();
		expect(
			observationRunUnitSeedSchema.parse({
				ordinal: 0,
				scopeKey: "library:one",
				scopeDigest: "d".repeat(64),
				scopePayload: JSON.stringify({ libraryId: "library-1" }),
				phase: "collect",
				expectedTargets: 4,
			}),
		).toMatchObject({ ordinal: 0, phase: "collect" });
		expect(() =>
			observationRunUnitSeedSchema.parse({
				ordinal: 0,
				scopeKey: "library:one",
				scopeDigest: "D".repeat(64),
				phase: "collect",
				expectedTargets: 4,
			}),
		).toThrow();
		expect(() =>
			observationRunUnitSeedSchema.parse({
				ordinal: 0,
				scopeKey: "library:one",
				scopeDigest: "d".repeat(64),
				scopePayload: "not-json",
				phase: "collect",
				expectedTargets: 4,
			}),
		).toThrow();
		expect(() =>
			observationRunUnitSeedSchema.parse({
				ordinal: 0,
				scopeKey: "library:one",
				scopeDigest: "d".repeat(64),
				scopePayload: JSON.stringify({ value: "x".repeat(4097) }),
				phase: "collect",
				expectedTargets: 4,
			}),
		).toThrow();
	});

	it("rejects malformed phase plans, duplicate seeds, and unsafe aggregate work before a transaction", async () => {
		const authority = {
			provider: "plex_episode" as const,
			cacheType: "plex_episode" as const,
			instanceId: "instance-1",
			parentGenerationId: "parent-1",
			targetDigest: "a".repeat(64),
			connectionGeneration: 2,
			identityGeneration: 3,
		};
		const prisma = {
			$transaction: () => {
				throw new Error("transaction must not start");
			},
		} as never;
		await expect(createOrLoadObservationRun(prisma, { authority, units: [] })).rejects.toThrow();
		await expect(
			createOrLoadObservationRun(prisma, {
				authority: { ...authority, provider: "jellyfin_episode", cacheType: "jellyfin_episode" },
				units: [
					{
						ordinal: 0,
						scopeKey: "verify",
						scopeDigest: "b".repeat(64),
						phase: "verify",
						expectedTargets: 1,
					},
				],
			}),
		).rejects.toThrow();
		await expect(
			createOrLoadObservationRun(prisma, {
				authority,
				units: [
					{
						ordinal: 0,
						scopeKey: "a",
						scopeDigest: "b".repeat(64),
						phase: "collect",
						expectedTargets: 1,
					},
					{
						ordinal: 0,
						scopeKey: "b",
						scopeDigest: "c".repeat(64),
						phase: "collect",
						expectedTargets: 1,
					},
				],
			}),
		).rejects.toThrow();
		await expect(
			createOrLoadObservationRun(prisma, {
				authority,
				units: [
					{
						ordinal: 0,
						scopeKey: "a",
						scopeDigest: "b".repeat(64),
						phase: "collect",
						expectedTargets: Number.MAX_SAFE_INTEGER,
					},
					{
						ordinal: 1,
						scopeKey: "b",
						scopeDigest: "c".repeat(64),
						phase: "collect",
						expectedTargets: 1,
					},
				],
			}),
		).rejects.toThrow();
	});

	it("locks the generation before active-run mutation and fails closed on zero affected rows", async () => {
		const events: string[] = [];
		const prisma = {
			$transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
				callback({
					$executeRaw: async () => {
						events.push("generation-lock");
						return 0;
					},
					providerObservationRun: {
						findFirst: async () => {
							events.push("active-run-read");
							return null;
						},
					},
				}),
		} as never;
		await expect(
			createOrLoadObservationRun(prisma, {
				authority,
				units: [
					{
						ordinal: 0,
						scopeKey: "library:one",
						scopeDigest: "d".repeat(64),
						phase: "collect",
						expectedTargets: 1,
					},
				],
			}),
		).rejects.toThrow("authority is stale");
		expect(events).toEqual(["generation-lock"]);
	});
});
