import { describe, expect, it } from "vitest";
import {
	decodeTautulliGenerationMetadata,
	encodeTautulliGenerationMetadata,
	evaluateTautulliExactPublication,
	evaluateTautulliPositivePublication,
} from "../tautulli-generation-metadata.js";

const root = { version: 1 as const, count: 2, digest: "a".repeat(64) };
const metadata = {
	version: 1 as const,
	provider: "tautulli" as const,
	generationId: "generation-1",
	publicationLevel: "authoritative" as const,
	completeness: {
		targetCatalog: root,
		observations: { ...root, digest: "b".repeat(64) },
		aggregate: { ...root, count: 1, digest: "c".repeat(64) },
	},
	connectionGeneration: 4,
	identityGeneration: 2,
	capabilities: ["exact-target-observations" as const],
	partialReasons: [],
};

describe("Tautulli generation metadata", () => {
	it("round-trips only the exact V1 all-or-none envelope", () => {
		const encoded = encodeTautulliGenerationMetadata(metadata);
		expect(decodeTautulliGenerationMetadata(encoded)).toEqual({ ok: true, metadata });
	});

	it("serializes legitimate zero counts stably and rejects negative zero before serialization", () => {
		const zeroMetadata = {
			...metadata,
			completeness: {
				targetCatalog: { ...metadata.completeness.targetCatalog, count: 0 },
				observations: { ...metadata.completeness.observations, count: 0 },
				aggregate: { ...metadata.completeness.aggregate, count: 0 },
			},
		};
		const encoded = encodeTautulliGenerationMetadata(zeroMetadata);

		expect(encodeTautulliGenerationMetadata(zeroMetadata)).toBe(encoded);
		expect(decodeTautulliGenerationMetadata(encoded)).toEqual({ ok: true, metadata: zeroMetadata });
		expect(() =>
			encodeTautulliGenerationMetadata({
				...zeroMetadata,
				completeness: {
					...zeroMetadata.completeness,
					targetCatalog: { ...zeroMetadata.completeness.targetCatalog, count: -0 },
				},
			}),
		).toThrow("Invalid Tautulli generation metadata");
	});

	it.each([
		["unknown version", { ...metadata, version: 2 }],
		["partial roots", { ...metadata, completeness: { targetCatalog: root } }],
		[
			"malformed digest",
			{
				...metadata,
				completeness: { ...metadata.completeness, observations: { ...root, digest: "raw-guid" } },
			},
		],
		["unknown capability", { ...metadata, capabilities: ["delete-authority"] }],
		[
			"unknown reason",
			{
				...metadata,
				publicationLevel: "positive-only",
				partialReasons: [{ code: "raw error", count: 1 }],
			},
		],
		[
			"duplicate reasons",
			{
				...metadata,
				publicationLevel: "positive-only",
				partialReasons: [
					{ code: "metadata_tmdb_unmapped", count: 1 },
					{ code: "metadata_tmdb_unmapped", count: 2 },
				],
			},
		],
	])("rejects %s", (_name, value) => {
		expect(decodeTautulliGenerationMetadata(JSON.stringify(value))).toEqual({
			ok: false,
			reasonCode: "metadata_invalid",
		});
	});

	it.each([
		[
			"target catalog root",
			JSON.stringify(metadata).replace(
				`"count":2,"digest":"${"a".repeat(64)}"`,
				`"count":-0,"digest":"${"a".repeat(64)}"`,
			),
		],
		[
			"observation root",
			JSON.stringify(metadata).replace(
				`"count":2,"digest":"${"b".repeat(64)}"`,
				`"count":-0,"digest":"${"b".repeat(64)}"`,
			),
		],
		[
			"aggregate root",
			JSON.stringify(metadata).replace(
				`"count":1,"digest":"${"c".repeat(64)}"`,
				`"count":-0,"digest":"${"c".repeat(64)}"`,
			),
		],
		[
			"connection generation",
			JSON.stringify(metadata).replace('"connectionGeneration":4', '"connectionGeneration":-0'),
		],
		[
			"identity generation",
			JSON.stringify(metadata).replace('"identityGeneration":2', '"identityGeneration":-0'),
		],
	] as const)("rejects negative zero in the %s", (_label, raw) => {
		expect(decodeTautulliGenerationMetadata(raw)).toEqual({
			ok: false,
			reasonCode: "metadata_invalid",
		});
	});

	it("rejects negative zero in a bounded partial-reason count", () => {
		const positive = {
			...metadata,
			publicationLevel: "positive-only" as const,
			capabilities: ["positive-watch-count" as const],
			partialReasons: [{ code: "history_partial" as const, count: 1 }],
		};
		const raw = JSON.stringify(positive).replace(
			'"code":"history_partial","count":1',
			'"code":"history_partial","count":-0',
		);

		expect(decodeTautulliGenerationMetadata(raw)).toEqual({
			ok: false,
			reasonCode: "metadata_invalid",
		});
	});

	it("rejects generation and provider-authority mismatches", () => {
		const status = {
			lastResult: "success",
			lastRefreshedAt: new Date("2026-08-27T12:00:00Z"),
			lastAttemptAt: new Date("2026-08-27T12:00:00Z"),
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			generationId: "generation-2",
			generationMetadata: JSON.stringify(metadata),
			itemCount: 1,
			connectionGeneration: 4,
			identityGeneration: 2,
		};
		expect(
			evaluateTautulliExactPublication(status, {
				connectionGeneration: 4,
				identityGeneration: 2,
			}),
		).toEqual({ available: false, reasonCode: "metadata_invalid" });
	});

	it.each([
		["status item count", { status: { itemCount: -0 }, authority: {} }],
		["status connection generation", { status: { connectionGeneration: -0 }, authority: {} }],
		["status identity generation", { status: { identityGeneration: -0 }, authority: {} }],
		["authority connection generation", { status: {}, authority: { connectionGeneration: -0 } }],
		["authority identity generation", { status: {}, authority: { identityGeneration: -0 } }],
	] as const)("withholds publication for negative-zero %s", (_label, override) => {
		const refreshedAt = new Date("2026-08-27T12:00:00Z");
		const status = {
			lastResult: "success",
			lastRefreshedAt: refreshedAt,
			lastAttemptAt: refreshedAt,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			generationId: "generation-1",
			generationMetadata: JSON.stringify(metadata),
			itemCount: 1,
			connectionGeneration: 4,
			identityGeneration: 2,
			...override.status,
		};
		const authority = {
			connectionGeneration: 4,
			identityGeneration: 2,
			...override.authority,
		};

		expect(evaluateTautulliExactPublication(status, authority)).toEqual({
			available: false,
			reasonCode: "metadata_invalid",
		});
	});

	it("withholds exact authority from positive-only and failed attempts", () => {
		const positive = {
			...metadata,
			publicationLevel: "positive-only" as const,
			capabilities: ["positive-watch-count" as const],
			partialReasons: [{ code: "history_partial" as const, count: 1 }],
		};
		const base = {
			lastResult: "success",
			lastRefreshedAt: new Date("2026-08-27T12:00:00Z"),
			lastAttemptAt: new Date("2026-08-27T12:00:00Z"),
			lastAttemptResult: "partial",
			lastAttemptErrorMessage: "history_partial",
			generationId: "generation-1",
			generationMetadata: JSON.stringify(positive),
			itemCount: 1,
			connectionGeneration: 4,
			identityGeneration: 2,
		};
		expect(
			evaluateTautulliExactPublication(base, { connectionGeneration: 4, identityGeneration: 2 }),
		).toEqual({ available: false, reasonCode: "publication_not_authoritative" });
		expect(
			evaluateTautulliPositivePublication(base, {
				connectionGeneration: 4,
				identityGeneration: 2,
			}),
		).toMatchObject({ available: true });
		expect(
			evaluateTautulliExactPublication(
				{ ...base, lastAttemptResult: "error" },
				{ connectionGeneration: 4, identityGeneration: 2 },
			),
		).toEqual({ available: false, reasonCode: "latest_attempt_failed" });
		expect(
			evaluateTautulliPositivePublication(
				{ ...base, lastAttemptResult: "error", lastAttemptErrorMessage: "credential_unavailable" },
				{ connectionGeneration: 4, identityGeneration: 2 },
			),
		).toEqual({ available: false, reasonCode: "latest_attempt_failed" });
	});
});
