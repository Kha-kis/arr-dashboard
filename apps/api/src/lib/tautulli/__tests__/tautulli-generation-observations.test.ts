import { describe, expect, it } from "vitest";
import {
	createTautulliGenerationObservationRoot,
	normalizeTautulliGenerationObservations,
	verifyTautulliGenerationObservationIntegrity,
} from "../tautulli-generation-observations.js";

const scope = {
	instanceId: "tautulli-1",
	generationId: "generation-1",
	connectionGeneration: 4,
	identityGeneration: 2,
};
const first = {
	...scope,
	sectionId: "1",
	ratingKey: "100",
	providerGuidFingerprint: "a".repeat(64),
	mediaType: "movie" as const,
	tmdbId: 55,
	observedWatchCount: 0,
	lastWatchedAt: null,
};

describe("Tautulli exact generation observations", () => {
	it("preserves duplicate TMDB targets as distinct provider objects", () => {
		const rows = normalizeTautulliGenerationObservations(
			[
				first,
				{ ...first, sectionId: "2", ratingKey: "101", providerGuidFingerprint: "b".repeat(64) },
			],
			scope,
		);
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((row) => row.ratingKey))).toEqual(new Set(["100", "101"]));
	});

	it("rejects duplicate rating keys and mixed generations", () => {
		expect(() =>
			normalizeTautulliGenerationObservations([first, { ...first, sectionId: "2" }], scope),
		).toThrow("duplicate");
		expect(() =>
			normalizeTautulliGenerationObservations([{ ...first, generationId: "generation-2" }], scope),
		).toThrow("scope");
	});

	it("binds the digest to rating-key reuse and provider GUID identity", () => {
		const original = createTautulliGenerationObservationRoot({ ...scope, rows: [first] });
		const reused = createTautulliGenerationObservationRoot({
			...scope,
			rows: [{ ...first, providerGuidFingerprint: "b".repeat(64) }],
		});
		expect(reused.digest).not.toBe(original.digest);
	});

	it.each([
		["missing", []],
		["extra", [first, { ...first, ratingKey: "101", providerGuidFingerprint: "b".repeat(64) }]],
		["mixed", [{ ...first, generationId: "generation-2" }]],
	])("rejects %s persisted observations", (_name, rows) => {
		const expected = createTautulliGenerationObservationRoot({ ...scope, rows: [first] });
		expect(verifyTautulliGenerationObservationIntegrity({ ...scope, expected, rows })).toEqual({
			ok: false,
		});
	});
});
