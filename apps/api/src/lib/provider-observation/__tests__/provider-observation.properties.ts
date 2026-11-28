// Replay a failing property with its seed, path, and Vitest test-name filter.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateProviderCoverageReceipt } from "../coverage-receipt.js";
import {
	buildObservationActiveSlotKey,
	buildObservationAuthorityKey,
	type ObservationRunAuthority,
	type ObservationRunUnitSeed,
	parseObservationRunUnitSeed,
} from "../observation-run-types.js";

const seed = Number(process.env.FC_SEED ?? 20261127);
const path = process.env.FC_PATH ?? "";
const options = { seed, path, numRuns: 300 };
const digest = "a".repeat(64);
const authority: ObservationRunAuthority = {
	provider: "jellyfin_episode",
	cacheType: "jellyfin_episode",
	instanceId: "instance-property-test",
	parentGenerationId: `jellyfin-episode-parent-v3:${digest}`,
	targetDigest: digest,
	connectionGeneration: 4,
	identityGeneration: 7,
};
const rootUnit = (overrides: Partial<ObservationRunUnitSeed> = {}): ObservationRunUnitSeed => ({
	ordinal: 0,
	scopeKey: "root",
	scopeDigest: digest,
	phase: "collect",
	expectedTargets: 1,
	scopePayload: JSON.stringify({ catalogProvenance: { version: 3 }, padding: "x".repeat(5000) }),
	...overrides,
});

describe("provider observation generated invariants (opt-in seed 20261127)", () => {
	it("admits expanded payload only for the exact Jellyfin V3 catalog root", () => {
		fc.assert(
			fc.property(
				fc.record({
					provider: fc.constantFrom("plex_episode" as const, "jellyfin_episode" as const),
					cacheType: fc.constantFrom("plex_episode" as const, "jellyfin_episode" as const),
					parentV3: fc.boolean(),
					ordinalZero: fc.boolean(),
					collect: fc.boolean(),
				}),
				(boundary) => {
					const currentAuthority = {
						...authority,
						provider: boundary.provider,
						cacheType: boundary.cacheType,
						parentGenerationId: boundary.parentV3
							? authority.parentGenerationId
							: `jellyfin-episode-parent-v2:${digest}`,
					};
					const unit = rootUnit({
						ordinal: boundary.ordinalZero ? 0 : 1,
						phase: boundary.collect ? "collect" : "verify",
					});
					const exact =
						boundary.provider === "jellyfin_episode" &&
						boundary.cacheType === "jellyfin_episode" &&
						boundary.parentV3 &&
						boundary.ordinalZero &&
						boundary.collect;
					if (exact) expect(parseObservationRunUnitSeed(unit, currentAuthority)).toEqual(unit);
					else expect(() => parseObservationRunUnitSeed(unit, currentAuthority)).toThrow();
				},
			),
			options,
		);
	});

	it("binds authority and duplicate active-slot identity to ownership coordinates", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1000 }),
				fc.integer({ min: 0, max: 1000 }),
				fc.string({ minLength: 1, maxLength: 24 }),
				(connectionGeneration, identityGeneration, instanceId) => {
					const current = { ...authority, connectionGeneration, identityGeneration, instanceId };
					const key = buildObservationAuthorityKey(current);
					expect(buildObservationAuthorityKey({ ...current })).toBe(key);
					expect(
						buildObservationAuthorityKey({
							...current,
							identityGeneration: identityGeneration + 1,
						}),
					).not.toBe(key);
					expect(
						buildObservationAuthorityKey({
							...current,
							connectionGeneration: connectionGeneration + 1,
						}),
					).not.toBe(key);
					const slot = buildObservationActiveSlotKey({ instanceId, cacheType: current.cacheType });
					expect(buildObservationActiveSlotKey({ instanceId, cacheType: current.cacheType })).toBe(
						slot,
					);
					expect(
						buildObservationActiveSlotKey({
							instanceId: `${instanceId}-other`,
							cacheType: current.cacheType,
						}),
					).not.toBe(slot);
				},
			),
			options,
		);
	});

	it("marks conserved complete coverage complete and generated gaps incomplete", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 500 }),
				fc.integer({ min: 0, max: 500 }),
				fc.integer({ min: 0, max: 500 }),
				(rawObserved, acceptedSkipCount, canonicalEntities) => {
					fc.pre(
						acceptedSkipCount <= rawObserved &&
							canonicalEntities <= rawObserved - acceptedSkipCount,
					);
					const unit = {
						scopeKey: "root",
						expectedRawCount: rawObserved,
						pagesAttempted: 1,
						pagesCompleted: 1,
						rawObserved,
						sourceBindings: rawObserved - acceptedSkipCount,
						canonicalEntities,
						acceptedSkips: acceptedSkipCount
							? [{ reason: "known-container", count: acceptedSkipCount }]
							: [],
						fatalCount: 0,
					};
					const receipt = {
						version: 1,
						provider: "jellyfin_episode",
						attemptStartedAt: "2026-01-01T00:00:00.000Z",
						observedAt: "2026-01-01T00:01:00.000Z",
						evidence: "complete",
						units: [unit],
						publishedCanonicalEntities: canonicalEntities,
					};
					expect(evaluateProviderCoverageReceipt(receipt)).toMatchObject({
						valid: true,
						complete: true,
					});
					expect(
						evaluateProviderCoverageReceipt({
							...receipt,
							units: [{ ...unit, sourceBindings: unit.sourceBindings + 1 }],
						}),
					).toMatchObject({ valid: true, complete: false });
					expect(
						evaluateProviderCoverageReceipt({
							...receipt,
							units: [{ ...unit, pagesCompleted: 0 }],
						}),
					).toMatchObject({ valid: true, complete: false });
				},
			),
			options,
		);
	});
});
