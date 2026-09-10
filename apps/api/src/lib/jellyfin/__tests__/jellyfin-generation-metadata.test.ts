import { describe, expect, it } from "vitest";
import type {
	JellyfinEpisodeGenerationMetadataV1,
	JellyfinEpisodeGenerationMetadataV3,
	JellyfinLibraryGenerationMetadataV1,
} from "../jellyfin-generation-metadata.js";
import {
	decodeJellyfinEpisodeGenerationMetadata,
	decodeJellyfinLibraryGenerationMetadata,
	encodeJellyfinEpisodeGenerationMetadata,
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinEpisodeRows,
	fingerprintJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
} from "../jellyfin-generation-metadata.js";

const FINGERPRINT = "a".repeat(64);
const OTHER_FINGERPRINT = "b".repeat(64);

function receipt(
	provider: "jellyfin" | "jellyfin_episode" | "emby" | "emby_episode" = "jellyfin",
	options: {
		overlap?: boolean;
		acceptedSkip?: boolean;
		published?: number;
		incomplete?: boolean;
		evidence?: "complete" | "positive-only";
	} = {},
) {
	const canonicalEntities = options.acceptedSkip ? 1 : 2;
	const baseUnit = {
		scopeKey: "user:user-1/library:library-1",
		expectedRawCount: options.acceptedSkip ? 2 : 2,
		pagesAttempted: 1,
		pagesCompleted: options.incomplete ? 0 : 1,
		rawObserved: options.acceptedSkip ? 2 : 2,
		sourceBindings: options.acceptedSkip ? 1 : 2,
		canonicalEntities,
		acceptedSkips: options.acceptedSkip ? [{ reason: "known-container" as const, count: 1 }] : [],
		fatalCount: 0,
	};
	return {
		version: 1 as const,
		provider,
		attemptStartedAt: "2026-09-02T12:00:00.000Z",
		observedAt: "2026-09-02T12:01:00.000Z",
		evidence: options.evidence ?? ("complete" as const),
		units: options.overlap
			? [
					baseUnit,
					{
						...baseUnit,
						scopeKey: "user:user-2/library:library-1",
					},
				]
			: [baseUnit],
		publishedCanonicalEntities: options.published ?? (options.overlap ? 2 : canonicalEntities),
	};
}

function libraryMetadata(
	provider: "jellyfin" | "emby" = "jellyfin",
	overrides: Record<string, unknown> = {},
): JellyfinLibraryGenerationMetadataV1 {
	return {
		version: 1,
		provider,
		cacheType: "jellyfin",
		publicationLevel: "authoritative",
		completeness: "complete",
		canonicalizationVersion: 1,
		itemCount: 2,
		connectionGeneration: 7,
		identityGeneration: 3,
		contentFingerprint: FINGERPRINT,
		coverageReceipt: receipt(provider),
		...overrides,
	} as JellyfinLibraryGenerationMetadataV1;
}

function positiveLibraryMetadata(
	provider: "jellyfin" | "emby" = "jellyfin",
	overrides: Record<string, unknown> = {},
): JellyfinLibraryGenerationMetadataV1 {
	return libraryMetadata(provider, {
		publicationLevel: "positive-only",
		completeness: "partial",
		coverageReceipt: receipt(provider, { evidence: "positive-only" }),
		...overrides,
	}) as JellyfinLibraryGenerationMetadataV1;
}

function v2PositiveLibraryMetadata(): JellyfinLibraryGenerationMetadataV1 {
	const inventoryUnit = {
		scopeKey: "user:user-1/library:library-1/inventory",
		expectedRawCount: 3,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: 3,
		sourceBindings: 3,
		canonicalEntities: 2,
		acceptedSkips: [],
		fatalCount: 0,
	};
	const mappingUnit = {
		...inventoryUnit,
		scopeKey: "user:user-1/library:library-1/mapping",
		sourceBindings: 2,
		acceptedSkips: [{ reason: "missing-supported-mapping" as const, count: 1 }],
	};
	return positiveLibraryMetadata("jellyfin", {
		coverageReceipt: {
			version: 2,
			provider: "jellyfin",
			attemptStartedAt: "2026-09-02T12:00:00.000Z",
			observedAt: "2026-09-02T12:01:00.000Z",
			evidence: "positive-only",
			units: [inventoryUnit],
			publishedCanonicalEntities: 2,
			domains: [
				{
					domain: "library-inventory",
					evidence: "complete",
					valueSemantics: "exact",
					units: [inventoryUnit],
				},
				{
					domain: "mapping",
					evidence: "positive-only",
					valueSemantics: "lower-bound",
					units: [mappingUnit],
					publishedCanonicalEntities: 2,
				},
				{
					domain: "watch-count",
					evidence: "positive-only",
					valueSemantics: "lower-bound",
					units: [inventoryUnit],
					publishedCanonicalEntities: 2,
				},
				{
					domain: "watch-attribution",
					evidence: "unknown",
					valueSemantics: "unknown",
					units: [],
				},
				{
					domain: "on-deck",
					evidence: "unknown",
					valueSemantics: "unknown",
					units: [
						{
							scopeKey: "user:user-1/on-deck",
							expectedRawCount: null,
							pagesAttempted: 1,
							pagesCompleted: 0,
							rawObserved: 0,
							sourceBindings: 0,
							canonicalEntities: 0,
							acceptedSkips: [],
							fatalCount: 1,
						},
					],
				},
			],
		},
	}) as JellyfinLibraryGenerationMetadataV1;
}

function episodeMetadata(
	provider: "jellyfin" | "emby" = "jellyfin",
	overrides: Record<string, unknown> = {},
): JellyfinEpisodeGenerationMetadataV1 {
	return {
		version: 1,
		provider,
		cacheType: "jellyfin_episode",
		publicationLevel: "authoritative",
		completeness: "complete",
		canonicalizationVersion: 1,
		itemCount: 2,
		connectionGeneration: 7,
		identityGeneration: 3,
		parentLibraryGenerationId: "library-generation-1",
		parentLibraryMetadataFingerprint: FINGERPRINT,
		contentFingerprint: OTHER_FINGERPRINT,
		coverageReceipt: receipt(provider === "emby" ? "emby_episode" : "jellyfin_episode"),
		...overrides,
	} as JellyfinEpisodeGenerationMetadataV1;
}

function episodeMetadataV2(
	provider: "jellyfin" | "emby" = "jellyfin",
	overrides: Record<string, unknown> = {},
) {
	const episodeProvider = provider === "emby" ? "emby_episode" : "jellyfin_episode";
	const baseReceipt = receipt(episodeProvider);
	return {
		version: 2,
		provider,
		cacheType: "jellyfin_episode",
		publicationLevel: "authoritative",
		completeness: "complete",
		canonicalizationVersion: 1,
		itemCount: 2,
		connectionGeneration: 7,
		identityGeneration: 3,
		parentLibraryGenerationId: "library-generation-2",
		parentLibraryMetadataFingerprint: FINGERPRINT,
		parentLibraryDependencyFingerprint: OTHER_FINGERPRINT,
		contentFingerprint: OTHER_FINGERPRINT,
		coverageReceipt: {
			...baseReceipt,
			version: 2,
			domains: [
				{
					domain: "episode-inventory",
					evidence: "complete",
					valueSemantics: "exact",
					units: baseReceipt.units,
					publishedCanonicalEntities: 2,
				},
			],
		},
		...overrides,
	};
}

function episodeMetadataV3(
	provider: "jellyfin" | "emby" = "jellyfin",
	overrides: Record<string, unknown> = {},
): JellyfinEpisodeGenerationMetadataV3 {
	const base = episodeMetadataV2(provider);
	return {
		...base,
		version: 3,
		publicationLevel: "positive-only",
		completeness: "partial",
		parentLibraryDependencyFingerprint: OTHER_FINGERPRINT,
		catalogProvenance: {
			version: 3,
			bindings: [{ libraryId: "library-1", seriesId: "series-1", tmdbId: 42 }],
			scopes: [{ userId: "user-1", libraryId: "library-1" }],
		},
		coverageReceipt: {
			...base.coverageReceipt,
			evidence: "positive-only",
		},
		...overrides,
	} as JellyfinEpisodeGenerationMetadataV3;
}

describe("Jellyfin and Emby generation metadata", () => {
	function episodeRow(overrides: Record<string, unknown> = {}) {
		return {
			id: "row-a",
			instanceId: "instance-a",
			connectionGeneration: 4,
			identityGeneration: 9,
			showTmdbId: 42,
			seasonNumber: 1,
			episodeNumber: 2,
			jellyfinId: "episode-a",
			title: "Episode A",
			watched: true,
			watchedByUsers: '["Bob","Alice"]',
			lastWatchedAt: new Date("2026-01-01T00:00:00.000Z"),
			...overrides,
		};
	}

	it("fingerprints episode rows canonically across order, dates, users, and storage fields", () => {
		const first = episodeRow();
		const second = episodeRow({
			id: "row-b",
			episodeNumber: 3,
			jellyfinId: "episode-b",
		});
		const canonicalFirst = episodeRow({
			watchedByUsers: '["Alice","Bob"]',
			lastWatchedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(fingerprintJellyfinEpisodeRows([first, second])).toBe(
			fingerprintJellyfinEpisodeRows([second, first]),
		);
		expect(fingerprintJellyfinEpisodeRows([first])).toBe(
			fingerprintJellyfinEpisodeRows([canonicalFirst]),
		);
		expect(fingerprintJellyfinEpisodeRows([first])).toBe(
			fingerprintJellyfinEpisodeRows([
				{
					...first,
					id: "row-other",
					instanceId: "instance-other",
					connectionGeneration: 8,
					identityGeneration: 10,
				},
			]),
		);
	});

	it.each([
		"showTmdbId",
		"seasonNumber",
		"episodeNumber",
		"jellyfinId",
		"title",
		"watched",
		"watchedByUsers",
		"lastWatchedAt",
	] as const)("changes the episode fingerprint when %s changes", (field) => {
		const changed = {
			...episodeRow(),
			[field]:
				field === "watched"
					? false
					: field === "lastWatchedAt"
						? new Date("2026-02-02T00:00:00.000Z")
						: field === "watchedByUsers"
							? '["Alice"]'
							: typeof episodeRow()[field] === "number"
								? (episodeRow()[field] as number) + 1
								: `${String(episodeRow()[field])}-changed`,
		};

		expect(fingerprintJellyfinEpisodeRows([changed])).not.toBe(
			fingerprintJellyfinEpisodeRows([episodeRow()]),
		);
	});

	function row(overrides: Record<string, unknown> = {}) {
		return {
			instanceId: "instance-a",
			tmdbId: 42,
			mediaType: "movie" as const,
			libraryId: "library-a",
			libraryName: "Movies",
			title: "Movie A",
			jellyfinId: "item-a",
			lastWatchedAt: new Date("2026-01-01T00:00:00.000Z"),
			watchCount: 1,
			watchedByUsers: '["Alice"]',
			onDeck: false,
			userRating: 8,
			collections: '["Favorites"]',
			addedAt: new Date("2025-01-01T00:00:00.000Z"),
			thumb: "/Items/item-a/Images/Primary",
			...overrides,
		};
	}

	it("fingerprints canonical rows independently of row order and instance ownership", () => {
		const first = row();
		const second = row({ tmdbId: 84, libraryId: "library-b", title: "Movie B" });

		expect(fingerprintJellyfinLibraryRows([first, second])).toBe(
			fingerprintJellyfinLibraryRows([second, first]),
		);
		expect(fingerprintJellyfinLibraryRows([first])).toBe(
			fingerprintJellyfinLibraryRows([{ ...first, instanceId: "instance-b" }]),
		);
	});

	it.each([
		"tmdbId",
		"mediaType",
		"libraryId",
		"libraryName",
		"title",
		"jellyfinId",
		"lastWatchedAt",
		"watchCount",
		"watchedByUsers",
		"onDeck",
		"userRating",
		"collections",
		"addedAt",
		"thumb",
	] as const)("changes the row fingerprint when %s changes", (field) => {
		const changed = {
			...row(),
			[field]:
				field === "mediaType"
					? "series"
					: field === "lastWatchedAt" || field === "addedAt"
						? new Date("2026-02-02T00:00:00.000Z")
						: field === "userRating"
							? 9
							: field === "watchCount"
								? 2
								: field === "onDeck"
									? true
									: `${String(row()[field])}-changed`,
		};

		expect(fingerprintJellyfinLibraryRows([changed])).not.toBe(
			fingerprintJellyfinLibraryRows([row()]),
		);
	});

	it.each([
		["Jellyfin", "jellyfin"],
		["Emby", "emby"],
	] as const)("round-trips an authoritative %s library envelope", (_label, provider) => {
		const input = libraryMetadata(provider);
		const encoded = encodeJellyfinLibraryGenerationMetadata(input);

		expect(decodeJellyfinLibraryGenerationMetadata(encoded)).toEqual({ ok: true, metadata: input });
	});

	it.each([
		["Jellyfin", "jellyfin"],
		["Emby", "emby"],
	] as const)("round-trips a positive-only partial %s library envelope", (_label, provider) => {
		const input = positiveLibraryMetadata(provider);
		const encoded = encodeJellyfinLibraryGenerationMetadata(input);

		expect(decodeJellyfinLibraryGenerationMetadata(encoded)).toEqual({ ok: true, metadata: input });
	});

	it("round-trips V2 independent Jellyfin library domains", () => {
		const input = v2PositiveLibraryMetadata();
		const encoded = encodeJellyfinLibraryGenerationMetadata(input);

		expect(decodeJellyfinLibraryGenerationMetadata(encoded)).toEqual({ ok: true, metadata: input });
	});

	it("rejects duplicate raw V2 domains instead of collapsing them", () => {
		const input = v2PositiveLibraryMetadata();
		const domains = input.coverageReceipt.version === 2 ? input.coverageReceipt.domains : [];
		const duplicate = {
			...input,
			coverageReceipt: {
				...input.coverageReceipt,
				version: 2 as const,
				domains: [...domains, domains[0]!],
			},
		};

		expect(decodeJellyfinLibraryGenerationMetadata(JSON.stringify(duplicate))).toEqual({
			ok: false,
		});
	});

	it("rejects duplicate raw V2 unit scopes within a domain", () => {
		const input = v2PositiveLibraryMetadata();
		const receipt = input.coverageReceipt;
		if (receipt.version !== 2) throw new Error("test fixture must be V2");
		const inventory = receipt.domains.find((domain) => domain.domain === "library-inventory");
		if (!inventory) throw new Error("test fixture must include inventory");
		const duplicateInventory = {
			...inventory,
			units: [...inventory.units, inventory.units[0]!],
		};
		const duplicate = {
			...input,
			coverageReceipt: {
				...receipt,
				domains: receipt.domains.map((domain) =>
					domain.domain === "library-inventory" ? duplicateInventory : domain,
				),
			},
		};

		expect(decodeJellyfinLibraryGenerationMetadata(JSON.stringify(duplicate))).toEqual({
			ok: false,
		});
	});

	it.each([
		[
			"authoritative metadata with a positive-only receipt",
			libraryMetadata("jellyfin", {
				coverageReceipt: receipt("jellyfin", { evidence: "positive-only" }),
			}),
		],
		[
			"positive-only metadata with a complete receipt",
			positiveLibraryMetadata("jellyfin", { coverageReceipt: receipt("jellyfin") }),
		],
		[
			"positive-only metadata with a zero item count",
			positiveLibraryMetadata("jellyfin", {
				itemCount: 0,
				coverageReceipt: {
					...receipt("jellyfin", { evidence: "positive-only", published: 0 }),
					units: [
						{
							...receipt("jellyfin", { evidence: "positive-only" }).units[0]!,
							expectedRawCount: 0,
							rawObserved: 0,
							sourceBindings: 0,
							canonicalEntities: 0,
						},
					],
				},
			}),
		],
		[
			"positive-only metadata with a count mismatch",
			positiveLibraryMetadata("jellyfin", { itemCount: 1 }),
		],
		[
			"positive-only metadata with a conservation mismatch",
			positiveLibraryMetadata("jellyfin", {
				coverageReceipt: {
					...receipt("jellyfin", { evidence: "positive-only" }),
					units: [
						{
							...receipt("jellyfin", { evidence: "positive-only" }).units[0]!,
							sourceBindings: 1,
						},
					],
				},
			}),
		],
		[
			"positive-only metadata with incomplete paging",
			positiveLibraryMetadata("jellyfin", {
				coverageReceipt: {
					...receipt("jellyfin", { evidence: "positive-only" }),
					units: [
						{
							...receipt("jellyfin", { evidence: "positive-only" }).units[0]!,
							pagesCompleted: 0,
						},
					],
				},
			}),
		],
		[
			"positive-only metadata with a fatal collection unit",
			positiveLibraryMetadata("jellyfin", {
				coverageReceipt: {
					...receipt("jellyfin", { evidence: "positive-only" }),
					units: [
						{
							...receipt("jellyfin", { evidence: "positive-only" }).units[0]!,
							fatalCount: 1,
						},
					],
				},
			}),
		],
		[
			"positive-only metadata with an expected/raw total mismatch",
			positiveLibraryMetadata("jellyfin", {
				coverageReceipt: {
					...receipt("jellyfin", { evidence: "positive-only" }),
					units: [
						{
							...receipt("jellyfin", { evidence: "positive-only" }).units[0]!,
							expectedRawCount: 3,
						},
					],
				},
			}),
		],
	] as const)("rejects %s", (_label, input) => {
		expect(decodeJellyfinLibraryGenerationMetadata(JSON.stringify(input))).toEqual({ ok: false });
	});

	it.each([
		["Jellyfin", "jellyfin"],
		["Emby", "emby"],
	] as const)("round-trips an authoritative %s episode envelope", (_label, provider) => {
		const input = episodeMetadata(provider);
		const encoded = encodeJellyfinEpisodeGenerationMetadata(input);

		expect(decodeJellyfinEpisodeGenerationMetadata(encoded)).toEqual({ ok: true, metadata: input });
	});

	it.each([
		["Jellyfin", "jellyfin"],
		["Emby", "emby"],
	] as const)("round-trips a strict V2 %s episode envelope", (_label, provider) => {
		const input = episodeMetadataV2(provider);
		const encoded = encodeJellyfinEpisodeGenerationMetadata(input);

		expect(decodeJellyfinEpisodeGenerationMetadata(encoded)).toEqual({ ok: true, metadata: input });
	});

	it.each([
		["Jellyfin", "jellyfin"],
		["Emby", "emby"],
	] as const)("round-trips a positive-only V3 %s episode envelope", (_label, provider) => {
		const input = episodeMetadataV3(provider);
		const encoded = encodeJellyfinEpisodeGenerationMetadata(input);

		expect(decodeJellyfinEpisodeGenerationMetadata(encoded)).toEqual({ ok: true, metadata: input });
	});

	it.each([
		["missing catalog provenance", { catalogProvenance: undefined }],
		["authoritative publication", { publicationLevel: "authoritative", completeness: "complete" }],
		[
			"unknown catalog field",
			{ catalogProvenance: { version: 3, bindings: [], scopes: [], extra: true } },
		],
	] as const)("rejects V3 episode metadata with %s", (_label, override) => {
		const input = episodeMetadataV3();
		if ("catalogProvenance" in override && override.catalogProvenance === undefined) {
			delete (input as unknown as Record<string, unknown>).catalogProvenance;
		} else {
			Object.assign(input, override);
		}
		expect(decodeJellyfinEpisodeGenerationMetadata(JSON.stringify(input))).toEqual({ ok: false });
	});

	it.each([
		["missing dependency fingerprint", { parentLibraryDependencyFingerprint: undefined }],
		["unknown metadata field", { unexpected: true }],
		["invalid dependency fingerprint", { parentLibraryDependencyFingerprint: "bad" }],
	])("rejects V2 episode metadata with %s", (_label, override) => {
		const input = episodeMetadataV2();
		if (
			"parentLibraryDependencyFingerprint" in override &&
			override.parentLibraryDependencyFingerprint === undefined
		) {
			delete (input as Record<string, unknown>).parentLibraryDependencyFingerprint;
		} else {
			Object.assign(input, override);
		}

		expect(decodeJellyfinEpisodeGenerationMetadata(JSON.stringify(input))).toEqual({ ok: false });
	});

	it("round-trips a positive-only episode envelope as an episode receipt", () => {
		const input = episodeMetadata("jellyfin", {
			publicationLevel: "positive-only",
			completeness: "partial",
			coverageReceipt: receipt("jellyfin_episode", { evidence: "positive-only" }),
		});

		expect(decodeJellyfinEpisodeGenerationMetadata(JSON.stringify(input))).toEqual({
			ok: true,
			metadata: input,
		});
	});

	it("fingerprints validated library metadata deterministically", () => {
		const input = libraryMetadata();
		const reordered = JSON.parse(
			JSON.stringify({
				coverageReceipt: input.coverageReceipt,
				contentFingerprint: input.contentFingerprint,
				identityGeneration: input.identityGeneration,
				connectionGeneration: input.connectionGeneration,
				itemCount: input.itemCount,
				canonicalizationVersion: input.canonicalizationVersion,
				completeness: input.completeness,
				publicationLevel: input.publicationLevel,
				cacheType: input.cacheType,
				provider: input.provider,
				version: input.version,
			}),
		);

		expect(fingerprintJellyfinLibraryGenerationMetadata(input)).toBe(
			fingerprintJellyfinLibraryGenerationMetadata(reordered),
		);
	});

	it("accepts overlapping units when the explicit global count is smaller than the aggregate", () => {
		const input = libraryMetadata("jellyfin", {
			coverageReceipt: receipt("jellyfin", { overlap: true }),
		});

		expect(decodeJellyfinLibraryGenerationMetadata(JSON.stringify(input))).toMatchObject({
			ok: true,
			metadata: { itemCount: 2 },
		});
	});

	it("accepts a complete receipt with a recognized BoxSet skip", () => {
		const input = libraryMetadata("emby", {
			itemCount: 1,
			coverageReceipt: receipt("emby", { acceptedSkip: true }),
		});

		expect(decodeJellyfinLibraryGenerationMetadata(JSON.stringify(input))).toMatchObject({
			ok: true,
		});
	});

	it.each([
		[
			"missing exact key",
			Object.fromEntries(
				Object.entries(libraryMetadata()).filter(([key]) => key !== "contentFingerprint"),
			),
		],
		["unknown provider", libraryMetadata("jellyfin", { provider: "plex" })],
		["wrong library cache type", libraryMetadata("jellyfin", { cacheType: "jellyfin_episode" })],
		["wrong canonicalization version", libraryMetadata("jellyfin", { canonicalizationVersion: 2 })],
	])("rejects %s", (_label, input) => {
		expect(decodeJellyfinLibraryGenerationMetadata(JSON.stringify(input))).toEqual({ ok: false });
	});

	it.each([undefined, null, 123, "", "   ", "not-json", "null", "[]", "1"])(
		"rejects malformed or non-object library input without details: %p",
		(raw) => {
			expect(decodeJellyfinLibraryGenerationMetadata(raw)).toEqual({ ok: false });
		},
	);

	it.each([
		["extra key", { extra: true }],
		["unknown provider", { provider: "plex" }],
		["wrong version", { version: 2 }],
		["wrong cache type", { cacheType: "jellyfin" }],
		["wrong canonicalization version", { canonicalizationVersion: 2 }],
		["wrong publication level", { publicationLevel: "partial" }],
		["wrong completeness", { completeness: "partial" }],
		["negative item count", { itemCount: -1 }],
		["fractional item count", { itemCount: 1.5 }],
		["unsafe item count", { itemCount: Number.MAX_SAFE_INTEGER + 1 }],
		["negative connection generation", { connectionGeneration: -1 }],
		["fractional connection generation", { connectionGeneration: 1.5 }],
		["unsafe connection generation", { connectionGeneration: Number.MAX_SAFE_INTEGER + 1 }],
		["negative identity generation", { identityGeneration: -1 }],
		["fractional identity generation", { identityGeneration: 1.5 }],
		["unsafe identity generation", { identityGeneration: Number.MAX_SAFE_INTEGER + 1 }],
		["uppercase content fingerprint", { contentFingerprint: FINGERPRINT.toUpperCase() }],
		["short content fingerprint", { contentFingerprint: "abc" }],
		["invalid parent metadata fingerprint", { parentLibraryMetadataFingerprint: "abc" }],
		["blank parent generation ID", { parentLibraryGenerationId: " " }],
		["NUL parent generation ID", { parentLibraryGenerationId: "library\0generation" }],
		["overlong parent generation ID", { parentLibraryGenerationId: "x".repeat(501) }],
	])("rejects %s", (_label, override) => {
		const input = episodeMetadata("jellyfin", override);

		expect(decodeJellyfinEpisodeGenerationMetadata(JSON.stringify(input))).toEqual({ ok: false });
	});

	it("rejects an episode envelope with a missing exact key", () => {
		const input = Object.fromEntries(
			Object.entries(episodeMetadata()).filter(([key]) => key !== "contentFingerprint"),
		);

		expect(decodeJellyfinEpisodeGenerationMetadata(JSON.stringify(input))).toEqual({ ok: false });
	});

	it.each([
		[
			"missing explicit global count",
			libraryMetadata("jellyfin", {
				coverageReceipt: (() => {
					const value = receipt("jellyfin");
					delete (value as Record<string, unknown>).publishedCanonicalEntities;
					return value;
				})(),
			}),
		],
		[
			"incomplete receipt",
			libraryMetadata("jellyfin", {
				coverageReceipt: receipt("jellyfin", { published: 2, incomplete: true }),
			}),
		],
		[
			"global count mismatch",
			libraryMetadata("jellyfin", {
				itemCount: 1,
				coverageReceipt: receipt("jellyfin", { published: 2 }),
			}),
		],
		["provider mismatch", libraryMetadata("emby", { coverageReceipt: receipt("jellyfin") })],
	] as const)("rejects %s", (_label, input) => {
		expect(decodeJellyfinLibraryGenerationMetadata(JSON.stringify(input))).toEqual({ ok: false });
	});

	it.each([
		[
			"missing explicit episode global count",
			(() => {
				const coverageReceipt = Object.fromEntries(
					Object.entries(receipt("jellyfin_episode")).filter(
						([key]) => key !== "publishedCanonicalEntities",
					),
				);
				return episodeMetadata("jellyfin", { coverageReceipt });
			})(),
		],
		[
			"episode global count mismatch",
			episodeMetadata("jellyfin", {
				itemCount: 1,
				coverageReceipt: receipt("jellyfin_episode", { published: 2 }),
			}),
		],
		[
			"episode provider/receipt mismatch",
			episodeMetadata("emby", { coverageReceipt: receipt("jellyfin_episode") }),
		],
		["wrong episode cache type", episodeMetadata("jellyfin", { cacheType: "jellyfin" })],
	] as const)("rejects %s", (_label, input) => {
		expect(decodeJellyfinEpisodeGenerationMetadata(JSON.stringify(input))).toEqual({ ok: false });
	});

	it.each([
		[
			"library",
			encodeJellyfinLibraryGenerationMetadata,
			libraryMetadata("jellyfin", { itemCount: 1 }),
		],
		[
			"episode",
			encodeJellyfinEpisodeGenerationMetadata,
			episodeMetadata("jellyfin", { itemCount: 1 }),
		],
	] as const)("keeps %s encoder failures generic", (_label, encode, input) => {
		const invalid = { ...input, coverageReceipt: receipt("jellyfin", { published: 1 }) };

		let caught: unknown;
		try {
			encode(invalid);
		} catch (error) {
			caught = error;
		}
		expect(caught).toEqual(new Error("Invalid Jellyfin generation metadata"));
		expect(String(caught)).not.toContain("user-");
		expect(String(caught)).not.toContain("library-");
		expect(String(caught)).not.toContain("Zod");
	});

	it("keeps decoder failures bounded to the ok flag", () => {
		const invalid = libraryMetadata("jellyfin", { coverageReceipt: receipt("emby") });

		expect(decodeJellyfinLibraryGenerationMetadata(JSON.stringify(invalid))).toEqual({ ok: false });
	});
});
