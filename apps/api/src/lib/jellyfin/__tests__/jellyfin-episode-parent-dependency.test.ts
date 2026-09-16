import { describe, expect, it } from "vitest";
import { fingerprintJellyfinEpisodeParentDependency } from "../jellyfin-episode-parent-dependency.js";
import {
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
	type JellyfinLibraryGenerationMetadataV1,
	type JellyfinLibraryRowFingerprintInput,
} from "../jellyfin-generation-metadata.js";

const INSTANCE_ID = "jellyfin-1";
const OBSERVED_AT = "2026-09-08T12:00:00.000Z";

function row(overrides: Partial<JellyfinLibraryRowFingerprintInput> = {}) {
	return {
		id: "row-1",
		instanceId: INSTANCE_ID,
		connectionGeneration: 7,
		identityGeneration: 3,
		tmdbId: 42,
		mediaType: "series" as const,
		libraryId: "library-1",
		libraryName: "Shows",
		title: "Show",
		jellyfinId: "series-1",
		lastWatchedAt: null,
		watchCount: 0,
		watchedByUsers: "[]",
		onDeck: false,
		userRating: null,
		collections: "[]",
		addedAt: null,
		thumb: null,
		...overrides,
	};
}

function receipt(overrides: Record<string, unknown> = {}) {
	return {
		version: 1 as const,
		provider: "jellyfin" as const,
		attemptStartedAt: "2026-09-08T11:59:00.000Z",
		observedAt: OBSERVED_AT,
		evidence: "complete" as const,
		units: [
			{
				scopeKey: "user:user-1/library:library-1",
				expectedRawCount: 1,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: 1,
				sourceBindings: 1,
				canonicalEntities: 1,
				acceptedSkips: [],
				fatalCount: 0,
			},
		],
		publishedCanonicalEntities: 1,
		...overrides,
	};
}

function metadata(
	rows: readonly JellyfinLibraryRowFingerprintInput[],
	overrides: Record<string, unknown> = {},
): JellyfinLibraryGenerationMetadataV1 {
	return {
		version: 1,
		provider: "jellyfin",
		cacheType: "jellyfin",
		publicationLevel: "authoritative",
		completeness: "complete",
		canonicalizationVersion: 1,
		itemCount: rows.length,
		connectionGeneration: 7,
		identityGeneration: 3,
		contentFingerprint: fingerprintJellyfinLibraryRows(rows),
		coverageReceipt: receipt(),
		...overrides,
	} as JellyfinLibraryGenerationMetadataV1;
}

function encodeMetadata(
	rows: readonly JellyfinLibraryRowFingerprintInput[],
	overrides: Record<string, unknown> = {},
) {
	return encodeJellyfinLibraryGenerationMetadata(metadata(rows, overrides));
}

describe("fingerprintJellyfinEpisodeParentDependency", () => {
	it("ignores refreshed watch/display fields and receipt timestamps", () => {
		const original = [row()];
		const refreshed = [
			row({
				title: "Renamed display title",
				thumb: "/new-thumb",
				watchCount: 12,
				watchedByUsers: '["viewer"]',
				lastWatchedAt: "2026-09-08T12:05:00.000Z",
				onDeck: true,
				userRating: 9,
				collections: '["New"]',
				addedAt: "2026-09-01T00:00:00.000Z",
			}),
		];
		const originalMetadata = encodeMetadata(original);
		const refreshedMetadata = encodeMetadata(refreshed, {
			coverageReceipt: receipt({
				attemptStartedAt: "2026-09-08T12:04:00.000Z",
				observedAt: "2026-09-08T12:05:00.000Z",
			}),
		});

		expect(
			fingerprintJellyfinEpisodeParentDependency(INSTANCE_ID, originalMetadata, original),
		).toBe(fingerprintJellyfinEpisodeParentDependency(INSTANCE_ID, refreshedMetadata, refreshed));
	});

	it("ignores successful page-count changes after strict V1 receipt validation", () => {
		const rows = [row()];
		const baseline = encodeMetadata(rows);
		const refreshed = encodeMetadata(rows, {
			coverageReceipt: receipt({
				units: [{ ...receipt().units[0], pagesAttempted: 2, pagesCompleted: 2 }],
			}),
		});

		expect(fingerprintJellyfinEpisodeParentDependency(INSTANCE_ID, baseline, rows)).toBe(
			fingerprintJellyfinEpisodeParentDependency(INSTANCE_ID, refreshed, rows),
		);
	});

	it("rejects watch/display corruption when the full parent fingerprint was not refreshed", () => {
		const rows = [row()];
		const metadataWithStaleFingerprint = encodeMetadata(rows);
		const changedRows = [row({ watchCount: 1 })];

		expect(
			fingerprintJellyfinEpisodeParentDependency(
				INSTANCE_ID,
				metadataWithStaleFingerprint,
				changedRows,
			),
		).toBeNull();
	});

	it.each([
		["library ID", { libraryId: "library-2" }],
		["provider item ID", { jellyfinId: "series-2" }],
		["series mapping", { tmdbId: 84 }],
		["provider", { provider: "emby" }],
	])("changes or rejects a changed %s", (_label, changed) => {
		const rows = [row()];
		const changedRows = [row(changed as Partial<JellyfinLibraryRowFingerprintInput>)];
		const changedProvider = "provider" in changed ? changed.provider : "jellyfin";
		const changedMetadata = encodeMetadata(changedRows, {
			provider: changedProvider,
			coverageReceipt: receipt({ provider: changedProvider }),
		});

		const baseline = fingerprintJellyfinEpisodeParentDependency(
			INSTANCE_ID,
			encodeMetadata(rows),
			rows,
		);
		const changedDigest = fingerprintJellyfinEpisodeParentDependency(
			INSTANCE_ID,
			changedMetadata,
			changedRows,
		);

		expect(baseline).not.toBeNull();
		expect(changedDigest).not.toBe(baseline);
	});

	it("preserves duplicate/conflicting bindings and is order independent", () => {
		const rows = [row(), row({ id: "row-2", jellyfinId: "series-1", tmdbId: 84 })];
		const encoded = encodeMetadata(rows, {
			itemCount: 2,
			coverageReceipt: receipt({
				units: [
					{
						...receipt().units[0],
						expectedRawCount: 2,
						rawObserved: 2,
						sourceBindings: 2,
						canonicalEntities: 2,
					},
				],
				publishedCanonicalEntities: 2,
			}),
		});

		const first = fingerprintJellyfinEpisodeParentDependency(INSTANCE_ID, encoded, rows);
		const second = fingerprintJellyfinEpisodeParentDependency(INSTANCE_ID, encoded, [
			rows[1]!,
			rows[0]!,
		]);

		expect(first).not.toBeNull();
		expect(second).toBe(first);
	});

	it.each([
		["malformed metadata", "not-json", [row()]],
		["wrong instance", encodeMetadata([row()]), [row({ instanceId: "other" })]],
		["malformed row", encodeMetadata([row()]), [row({ watchedByUsers: "broken" })]],
		[
			"invalid coverage",
			JSON.stringify(metadata([row()], { coverageReceipt: receipt({ units: [] }) })),
			[row()],
		],
	])("fails closed for %s", (_label, encoded, rows) => {
		expect(fingerprintJellyfinEpisodeParentDependency(INSTANCE_ID, encoded, rows)).toBeNull();
	});
});
