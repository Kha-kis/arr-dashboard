/** Plex cache collection and guarded publication tests. */

import type { FastifyBaseLogger } from "fastify";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import { evaluateProviderCoverageReceipt } from "../../provider-observation/coverage-receipt.js";
import {
	canPublishPositivePlexObservation,
	collectPlexCacheLiveEvidence,
	collectSettledPlexCacheLiveEvidence,
	isPersonalMediaSection,
} from "../plex-cache-refresher.js";
import type { PlexClient } from "../plex-client.js";

type ReceiptTestSection = {
	key: string;
	title: string;
	type: "movie" | "show";
	agent?: string;
};

type ReceiptTestItem = {
	ratingKey: string;
	title: string;
	type: string;
	Guid?: Array<{ id: string }>;
	viewCount?: number;
	Collection?: Array<{ tag: string }>;
};

type ReceiptPageResult = {
	items: ReceiptTestItem[];
	expectedRawCount: number | null;
	pagesAttempted: number;
	pagesCompleted: number;
	rawObserved: number;
	reason: "page-failure" | null;
};

function completeCoverage<T extends { ratingKey: string; title: string; type: string }>(
	items: T[],
): {
	items: T[];
	expectedRawCount: number;
	pagesAttempted: number;
	pagesCompleted: number;
	rawObserved: number;
	reason: null;
} {
	return {
		items: items.map((item) => ({
			...item,
			viewCount: (item as T & { viewCount?: number }).viewCount ?? 0,
		})) as T[],
		expectedRawCount: items.length,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: items.length,
		reason: null,
	};
}

type ReceiptCollectionClient = PlexClient & {
	getLibraryItemsWithCoverage: (sectionId: string) => Promise<ReceiptPageResult>;
};

function receiptFrom(result: unknown): unknown {
	return (result as { receipt?: unknown }).receipt;
}

function receiptCollectionClient(input: {
	sections: ReceiptTestSection[];
	itemsBySection: Record<string, ReceiptTestItem[]>;
	failingSection?: string;
	settlementSections?: unknown[];
	coverageResults?: Record<string, ReceiptPageResult>;
	onCoverage?: () => void;
	history?: unknown[];
	onDeck?: unknown[];
}): ReceiptCollectionClient {
	const settlementSections =
		input.settlementSections ??
		input.sections.map((section) => ({
			...section,
			uuid: `${section.key}-uuid`,
			refreshing: false,
			scannedAt: 1,
			updatedAt: 1,
		}));
	const withDefaultViewCount = (items: ReceiptTestItem[]) =>
		items.map((item) => ({ ...item, viewCount: item.viewCount ?? 0 }));
	return {
		getActivities: vi.fn().mockResolvedValue([]),
		getLibrarySettlementSections: vi.fn().mockResolvedValue(settlementSections),
		getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
		getLibrarySections: vi.fn().mockResolvedValue(input.sections),
		getLibraryItems: vi.fn().mockImplementation(async (sectionId: string) => {
			if (sectionId === input.failingSection) throw new Error("section unavailable");
			return withDefaultViewCount(input.itemsBySection[sectionId] ?? []);
		}),
		getLibraryItemsWithCoverage: vi.fn().mockImplementation(async (sectionId: string) => {
			input.onCoverage?.();
			return (
				input.coverageResults?.[sectionId] ?? {
					items: withDefaultViewCount(input.itemsBySection[sectionId] ?? []),
					expectedRawCount: (input.itemsBySection[sectionId] ?? []).length,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: (input.itemsBySection[sectionId] ?? []).length,
					reason: null,
				}
			);
		}),
		getHistory: vi.fn().mockResolvedValue(input.history ?? []),
		verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
		getOnDeck: vi.fn().mockResolvedValue(input.onDeck ?? []),
	} as unknown as ReceiptCollectionClient;
}

const silentLogInfo = vi.fn();
const silentLog = {
	warn: vi.fn(),
	info: silentLogInfo,
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: vi.fn(),
} as unknown as FastifyBaseLogger;

function pinoCapture(): { log: FastifyBaseLogger; serialized: () => string } {
	const lines: string[] = [];
	return {
		log: pino(
			{ level: "trace", base: null, timestamp: false },
			{ write: (line: string) => lines.push(line) },
		) as unknown as FastifyBaseLogger,
		serialized: () => lines.join(""),
	};
}

async function refreshPlexCache(
	client: PlexClient,
	prisma: PrismaClient,
	instanceId: string,
	log: FastifyBaseLogger,
	_expectedConnection?: unknown,
	_options?: unknown,
) {
	void prisma;
	return await collectPlexCacheLiveEvidence(client, instanceId, log);
}

describe("collectPlexCacheLiveEvidence", () => {
	function positiveObservationClient(input: {
		accounts?: Array<{ id: number; name: string }>;
		librarySections?: Array<{ key: string; title: string; type: "movie" | "show" }>;
		libraryItems?: Array<{
			ratingKey: string;
			title: string;
			type: "movie" | "show";
			Guid: Array<{ id: string }>;
			viewCount?: number;
		}>;
		libraryItemsBySection?: Record<
			string,
			Array<{
				ratingKey: string;
				title: string;
				type: "movie" | "show";
				Guid: Array<{ id: string }>;
				viewCount?: number;
			}>
		>;
		history?: unknown[];
		onDeck?: unknown[] | Error;
		activities?: Array<{ type: string }>;
		settlementSections?: Array<{
			key: string;
			uuid: string;
			title: string;
			type: "movie" | "show";
			refreshing: boolean;
			scannedAt: number | null;
			updatedAt: number;
		}>;
	}) {
		const librarySections = input.librarySections ?? [
			{ key: "shows", title: "Shows", type: "show" },
		];
		const settlementSections = input.settlementSections ?? [
			{
				key: "shows",
				uuid: "shows-uuid",
				title: "Shows",
				type: "show" as const,
				refreshing: false,
				scannedAt: 1,
				updatedAt: 1,
			},
		];
		const withDefaultViewCount = <T extends { viewCount?: number }>(items: T[]) =>
			items.map((item) => ({ ...item, viewCount: item.viewCount ?? 0 }));
		return {
			getActivities: vi.fn().mockResolvedValue(input.activities ?? []),
			getLibrarySettlementSections: vi.fn().mockResolvedValue(settlementSections),
			getAccounts: vi.fn().mockResolvedValue(input.accounts ?? [{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue(librarySections),
			getLibraryItems: vi.fn().mockImplementation((sectionId: string) =>
				Promise.resolve(
					withDefaultViewCount(
						input.libraryItemsBySection?.[sectionId] ??
							input.libraryItems ?? [
								{
									ratingKey: "show-1",
									title: "Mapped Show",
									type: "show" as const,
									Guid: [{ id: "tmdb://42" }, { id: "tvdb://42" }],
								},
								{
									ratingKey: "legacy-movie",
									title: "Legacy Movie",
									type: "movie" as const,
									Guid: [],
								},
							],
					),
				),
			),
			getLibraryItemsWithCoverage: vi.fn().mockImplementation(async (sectionId: string) => {
				const sectionItems = withDefaultViewCount(
					input.libraryItemsBySection?.[sectionId] ??
						input.libraryItems ?? [
							{
								ratingKey: "show-1",
								title: "Mapped Show",
								type: "show" as const,
								Guid: [{ id: "tmdb://42" }, { id: "tvdb://42" }],
							},
							{
								ratingKey: "legacy-movie",
								title: "Legacy Movie",
								type: "movie" as const,
								Guid: [],
							},
						],
				);
				return {
					items: sectionItems,
					expectedRawCount: sectionItems.length,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: sectionItems.length,
					reason: null,
				};
			}),
			getHistory: vi.fn().mockResolvedValue(input.history ?? []),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck:
				input.onDeck instanceof Error
					? vi.fn().mockRejectedValue(input.onDeck)
					: vi.fn().mockResolvedValue(input.onDeck ?? []),
		} as unknown as PlexClient;
	}

	it("returns a settled positive observation without a snapshot for mapped rows beside an unmappable item", async () => {
		// Removing the positive-only branch, returning the rows under `snapshot`, or
		// omitting its bound target/root must make this fail.
		const result = await collectSettledPlexCacheLiveEvidence(
			positiveObservationClient({}),
			"inst-1",
			silentLog,
		);

		expect(result).toMatchObject({
			kind: "positive-observation",
			complete: false,
			observation: {
				rows: [expect.objectContaining({ tmdbId: 42, ratingKey: "show-1" })],
				observedTargets: [
					expect.objectContaining({
						tmdbId: 42,
						tvdbId: 42,
						ratingKey: "show-1",
						sectionUuid: "shows-uuid",
					}),
				],
				capabilities: [
					{
						domain: "episode-parents",
						field: "membership",
						semantics: "observed-targets-only",
						operators: [],
					},
				],
				observedRoots: [
					expect.objectContaining({ sectionKey: "shows", domain: "episode-parents" }),
				],
				partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
				settlement: { sections: [expect.objectContaining({ key: "shows", uuid: "shows-uuid" })] },
			},
		});
		expect("snapshot" in result).toBe(false);
		expect(result.kind).toBe("positive-observation");
		const positiveReceipt = receiptFrom(result) as {
			units: Array<{ canonicalEntities: number }>;
		};
		expect(positiveReceipt.units.reduce((total, unit) => total + unit.canonicalEntities, 0)).toBe(
			result.kind === "positive-observation" ? result.observation.rows.length : -1,
		);
	});

	it("reproves inventory when on-deck fetch fails and degrades only that domain", async () => {
		const client = positiveObservationClient({ onDeck: new Error("on-deck unavailable") });
		const result = await collectSettledPlexCacheLiveEvidence(client, "inst-1", silentLog);

		expect(result.kind).toBe("positive-observation");
		expect(client.getLibraryItemsWithCoverage).toHaveBeenCalledTimes(4);
		expect(client.verifyHistorySnapshot).toHaveBeenCalledTimes(4);
		const receipt = receiptFrom(result) as { domains: Array<Record<string, unknown>> };
		expect(receipt.domains).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					domain: "on-deck",
					evidence: "unknown",
					valueSemantics: "unknown",
				}),
			]),
		);
	});

	it("serializes an on-deck provider failure without provider bindings", async () => {
		const canary = "https://private.invalid/Title?token=secret";
		const client = positiveObservationClient({ onDeck: new Error(canary) });
		const captured = pinoCapture();

		await collectSettledPlexCacheLiveEvidence(client, "private-instance", captured.log);

		const serialized = captured.serialized();
		expect(serialized).toContain("plex-cache-on-deck-unavailable");
		expect(serialized).not.toContain(canary);
		expect(serialized).not.toContain("private-instance");
	});

	it.each([
		{
			category: "plex-cache-accounts-unavailable",
			configure: (client: PlexClient, error: Error) =>
				vi.mocked(client.getAccounts).mockRejectedValue(error),
		},
		{
			category: "plex-cache-no-user-accounts",
			configure: (client: PlexClient) => vi.mocked(client.getAccounts).mockResolvedValue([]),
		},
		{
			category: "plex-cache-no-media-libraries",
			configure: (client: PlexClient) => vi.mocked(client.getLibrarySections).mockResolvedValue([]),
		},
		{
			category: "plex-cache-library-section-unobserved",
			configure: (client: PlexClient, error: Error) =>
				vi.mocked(client.getLibraryItemsWithCoverage).mockRejectedValue(error),
		},
		{
			category: "plex-cache-history-unavailable",
			configure: (client: PlexClient, error: Error) =>
				vi.mocked(client.getHistory).mockRejectedValue(error),
		},
		{
			category: "plex-cache-refresh-failed",
			configure: (client: PlexClient, error: Error) =>
				vi.mocked(client.getLibrarySections).mockRejectedValue(error),
		},
	])("serializes $category without provider canaries", async ({ category, configure }) => {
		const canaries = [
			"https://private.invalid/Private-Title?token=secret",
			"Private Instance Label",
			"private-instance-id",
			"private-section-id",
		];
		const client = positiveObservationClient({
			librarySections: [{ key: canaries[3]!, title: canaries[1]!, type: "show" }],
			libraryItems: [
				{
					ratingKey: canaries[2]!,
					title: canaries[0]!,
					type: "show",
					Guid: [{ id: "tmdb://42" }, { id: "tvdb://42" }],
				},
			],
		});
		const captured = pinoCapture();
		configure(client, new Error(canaries.join(" ")));

		await collectPlexCacheLiveEvidence(client, canaries[2]!, captured.log);

		const serialized = captured.serialized();
		expect(serialized).toContain(category);
		for (const canary of canaries) expect(serialized).not.toContain(canary);
	});

	it("serializes incomplete section and eviction boundaries without provider identifiers", async () => {
		const canaries = [
			"private-instance-id",
			"private-section-id",
			"Private Section Title",
			"https://private.invalid/Private-Title?token=secret",
		];
		const captured = pinoCapture();
		const client = receiptCollectionClient({
			sections: [{ key: canaries[1]!, title: canaries[2]!, type: "show" }],
			itemsBySection: {
				[canaries[1]!]: [
					{
						ratingKey: "private-rating-key",
						title: canaries[3]!,
						type: "show",
					},
				],
			},
			coverageResults: {
				[canaries[1]!]: {
					items: [],
					expectedRawCount: 1,
					pagesAttempted: 1,
					pagesCompleted: 0,
					rawObserved: 0,
					reason: "page-failure",
				},
			},
		});

		await collectPlexCacheLiveEvidence(client, canaries[0]!, captured.log);

		const serialized = captured.serialized();
		expect(serialized).toContain("library section coverage incomplete");
		expect(serialized).toContain("skipping eviction");
		for (const canary of canaries) expect(serialized).not.toContain(canary);
	});

	it("serializes completion aggregates without provider canaries", async () => {
		const canaries = [
			"https://private.invalid/Private-Title?token=secret",
			"Private Instance Label",
			"private-instance-id",
			"private-section-id",
		];
		const captured = pinoCapture();
		await collectPlexCacheLiveEvidence(
			positiveObservationClient({
				librarySections: [{ key: canaries[3]!, title: canaries[1]!, type: "show" }],
				libraryItems: [
					{
						ratingKey: canaries[2]!,
						title: canaries[0]!,
						type: "show",
						Guid: [{ id: "tmdb://42" }, { id: "tvdb://42" }],
					},
				],
			}),
			canaries[2]!,
			captured.log,
		);

		const serialized = captured.serialized();
		expect(serialized).toContain("Plex cache refresh complete");
		for (const canary of canaries) expect(serialized).not.toContain(canary);
	});

	it("publishes mapped movies and series with independent domain evidence", async () => {
		const result = await collectPlexCacheLiveEvidence(
			receiptCollectionClient({
				sections: [
					{ key: "movies", title: "Movies", type: "movie" },
					{ key: "shows", title: "Shows", type: "show" },
				],
				itemsBySection: {
					movies: [
						{
							ratingKey: "movie-1",
							title: "Mapped Movie",
							type: "movie",
							Guid: [{ id: "tmdb://10" }],
							viewCount: 2,
						},
						{
							ratingKey: "collection-1",
							title: "Known Collection",
							type: "collection",
							Guid: [],
						},
						{
							ratingKey: "movie-unmapped",
							title: "Missing Mapping",
							type: "movie",
							Guid: [],
						},
					],
					shows: [
						{
							ratingKey: "show-1",
							title: "Mapped Series",
							type: "show",
							Guid: [{ id: "tmdb://20" }],
							viewCount: 1,
						},
					],
				},
				history: [{ type: "movie", ratingKey: "", accountID: 1, viewedAt: 1_700_000_000 }],
				onDeck: [
					{ type: "movie", ratingKey: "movie-1" },
					{ type: "clip", ratingKey: "clip-1" },
				],
			}),
			"inst-1",
			silentLog,
		);

		expect(result.kind).toBe("positive-observation");
		if (result.kind !== "positive-observation") throw new Error("Expected positive observation");
		expect(result.observation.rows.map((row) => row.ratingKey).sort()).toEqual([
			"movie-1",
			"show-1",
		]);
		expect(result.receipt).toMatchObject({ version: 2, provider: "plex" });
		expect(result.receipt.domains).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ domain: "library-inventory", valueSemantics: "exact" }),
				expect.objectContaining({ domain: "mapping", valueSemantics: "lower-bound" }),
				expect.objectContaining({ domain: "watch-count", valueSemantics: "exact" }),
				expect.objectContaining({ domain: "watch-attribution", valueSemantics: "unknown" }),
				expect.objectContaining({ domain: "on-deck", valueSemantics: "exact" }),
			]),
		);
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"normalizes an invalid provider view count (%s) and leaves watch-count unknown",
		async (viewCount) => {
			const result = await collectPlexCacheLiveEvidence(
				receiptCollectionClient({
					sections: [{ key: "movies", title: "Movies", type: "movie" }],
					itemsBySection: {
						movies: [
							{
								ratingKey: "movie-invalid-count",
								title: "Invalid Count",
								type: "movie",
								Guid: [{ id: "tmdb://99" }],
								viewCount,
							},
						],
					},
				}),
				"inst-1",
				silentLog,
			);

			expect(result.kind).toBe("positive-observation");
			if (result.kind !== "positive-observation") throw new Error("Expected positive observation");
			expect(result.observation.rows).toEqual([
				expect.objectContaining({ ratingKey: "movie-invalid-count", watchCount: 0 }),
			]);
			expect(result.receipt.domains).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						domain: "watch-count",
						evidence: "unknown",
						valueSemantics: "unknown",
					}),
				]),
			);
		},
	);

	it.each([
		["missing to zero", undefined, 0],
		["zero to missing", 0, undefined],
	] as const)(
		"rejects terminal view-count drift (%s)",
		async (_label, initialCount, terminalCount) => {
			const initial = {
				ratingKey: "movie-drift",
				title: "Drift",
				type: "movie" as const,
				Guid: [{ id: "tmdb://99" }],
				...(initialCount === undefined ? {} : { viewCount: initialCount }),
			};
			const terminal = {
				...initial,
				...(terminalCount === undefined ? { viewCount: undefined } : { viewCount: terminalCount }),
			};
			const client = receiptCollectionClient({
				sections: [{ key: "movies", title: "Movies", type: "movie" }],
				itemsBySection: { movies: [initial] },
			});
			client.getLibraryItemsWithCoverage = vi
				.fn()
				.mockResolvedValueOnce({
					items: [initial],
					expectedRawCount: 1,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: 1,
					reason: null,
				})
				.mockResolvedValueOnce({
					items: [terminal],
					expectedRawCount: 1,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: 1,
					reason: null,
				});

			const capture = pinoCapture();
			const result = await collectPlexCacheLiveEvidence(client, "inst-1", capture.log);
			expect(result.kind).toBe("unpublished");
			expect(result.errors).toBeGreaterThan(0);
			const drift = capture
				.serialized()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.find((entry) => entry.category === "plex-inventory-drift");
			expect(drift).toEqual({
				level: 40,
				category: "plex-inventory-drift",
				domains: ["watch"],
				msg: "Plex inventory changed during observation",
			});
		},
	);

	it("isolates account lookup failure to watch attribution", async () => {
		const client = positiveObservationClient({});
		client.getAccounts = vi.fn().mockRejectedValue(new Error("accounts unavailable"));
		const result = await collectPlexCacheLiveEvidence(client, "inst-1", silentLog);

		expect(result.kind).toBe("positive-observation");
		const evaluation = evaluateProviderCoverageReceipt(receiptFrom(result));
		expect(evaluation.domains?.get("library-inventory")).toMatchObject({
			availability: "current",
			valueSemantics: "exact",
		});
		expect(evaluation.domains?.get("watch-count")).toMatchObject({
			availability: "current",
			valueSemantics: "exact",
		});
		expect(evaluation.domains?.get("watch-attribution")).toMatchObject({
			availability: "unavailable",
			valueSemantics: "unknown",
		});
	});

	it("isolates history lookup failure and does not verify unavailable history", async () => {
		const client = positiveObservationClient({});
		client.getHistory = vi.fn().mockRejectedValue(new Error("history unavailable"));
		const result = await collectPlexCacheLiveEvidence(client, "inst-1", silentLog);

		expect(result.kind).toBe("positive-observation");
		expect(client.verifyHistorySnapshot).not.toHaveBeenCalled();
		const evaluation = evaluateProviderCoverageReceipt(receiptFrom(result));
		expect(evaluation.domains?.get("library-inventory")).toMatchObject({
			availability: "current",
			valueSemantics: "exact",
		});
		expect(evaluation.domains?.get("on-deck")).toMatchObject({
			availability: "current",
			valueSemantics: "exact",
		});
		expect(evaluation.domains?.get("watch-attribution")).toMatchObject({
			availability: "unavailable",
			valueSemantics: "unknown",
		});
	});

	it("keeps mixed resolved and unresolved history as a lower-bound attribution", async () => {
		const result = await collectPlexCacheLiveEvidence(
			receiptCollectionClient({
				sections: [{ key: "movies", title: "Movies", type: "movie" }],
				itemsBySection: {
					movies: [
						{
							ratingKey: "movie-1",
							title: "Mapped Movie",
							type: "movie",
							Guid: [{ id: "tmdb://1" }],
							viewCount: 1,
						},
					],
				},
				history: [
					{ type: "movie", ratingKey: "movie-1", accountID: 1, viewedAt: 1_700_000_000 },
					{ type: "movie", ratingKey: "movie-1", accountID: 999, viewedAt: 1_700_000_001 },
				],
			}),
			"inst-1",
			silentLog,
		);

		expect(result.kind).toBe("positive-observation");
		expect(
			evaluateProviderCoverageReceipt(receiptFrom(result)).domains?.get("watch-attribution"),
		).toMatchObject({ evidence: "positive-only", valueSemantics: "lower-bound" });
	});

	it("accounts for duplicate source bindings separately from canonical entities", async () => {
		const result = await collectPlexCacheLiveEvidence(
			receiptCollectionClient({
				sections: [{ key: "1", title: "Movies", type: "movie" }],
				itemsBySection: {
					1: [
						{ ratingKey: "edition-a", title: "A", type: "movie", Guid: [{ id: "tmdb://42" }] },
						{ ratingKey: "edition-b", title: "B", type: "movie", Guid: [{ id: "tmdb://42" }] },
						{ ratingKey: "movie-43", title: "C", type: "movie", Guid: [{ id: "tmdb://43" }] },
						{ ratingKey: "unmapped", title: "D", type: "movie", Guid: [] },
					],
				},
			}),
			"inst-1",
			silentLog,
		);

		const receipt = receiptFrom(result) as { units?: unknown[] } | undefined;
		expect(receipt).toBeDefined();
		expect(receipt?.units).toEqual([
			expect.objectContaining({
				scopeKey: "section:1",
				expectedRawCount: 4,
				rawObserved: 4,
				sourceBindings: 3,
				canonicalEntities: 2,
				acceptedSkips: [{ reason: "missing-supported-mapping", count: 1 }],
				fatalCount: 0,
			}),
		]);
		expect(evaluateProviderCoverageReceipt(receipt)).toMatchObject({
			evidence: "positive-only",
			complete: false,
		});
	});

	it("treats an exact Plex collection row as a conserved known container", async () => {
		const result = await collectPlexCacheLiveEvidence(
			receiptCollectionClient({
				sections: [{ key: "1", title: "Movies", type: "movie" }],
				itemsBySection: {
					1: [
						{
							ratingKey: "movie-42",
							title: "Mapped Movie",
							type: "movie",
							Guid: [{ id: "tmdb://42" }],
						},
						{
							ratingKey: "collection-1",
							title: "Mapped Movie Collection",
							type: "collection",
							Guid: [{ id: "plex://collection/collection-1" }],
						},
					],
				},
			}),
			"inst-1",
			silentLog,
		);

		expect(result).toMatchObject({ kind: "authoritative-snapshot", complete: true, errors: 0 });
		if (result.kind !== "authoritative-snapshot")
			throw new Error("Expected authoritative snapshot");
		expect(result.snapshot.rows).toEqual([
			expect.objectContaining({ ratingKey: "movie-42", tmdbId: 42, mediaType: "movie" }),
		]);
		expect(result.inventoryTargets).toEqual([
			{ sectionId: "1", mediaType: "movie", tmdbId: 42, ratingKey: "movie-42" },
		]);

		const receipt = receiptFrom(result) as { units?: unknown[] } | undefined;
		expect(receipt?.units).toEqual([
			expect.objectContaining({
				scopeKey: "section:1",
				expectedRawCount: 2,
				rawObserved: 2,
				sourceBindings: 1,
				canonicalEntities: 1,
				acceptedSkips: [{ reason: "known-container", count: 1 }],
				fatalCount: 0,
			}),
		]);
		expect(evaluateProviderCoverageReceipt(receipt)).toMatchObject({
			evidence: "complete",
			complete: true,
		});
	});

	it("keeps unmapped Movies and unknown items incomplete even with a valid GUID", async () => {
		const result = await collectPlexCacheLiveEvidence(
			receiptCollectionClient({
				sections: [{ key: "1", title: "Movies", type: "movie" }],
				itemsBySection: {
					1: [
						{
							ratingKey: "movie-42",
							title: "Mapped Movie",
							type: "movie",
							Guid: [{ id: "tmdb://42" }],
						},
						{ ratingKey: "movie-unmapped", title: "Unmapped Movie", type: "movie", Guid: [] },
						{
							ratingKey: "unknown-1",
							title: "Unknown Item",
							type: "mystery",
							Guid: [{ id: "tmdb://84" }],
						},
					],
				},
			}),
			"inst-1",
			silentLog,
		);

		expect(result).toMatchObject({ kind: "positive-observation", complete: false });
		expect(result.errorMessages).toContain(
			"Plex cache incomplete: 1 current library item(s) without TMDB metadata",
		);
		if (result.kind !== "positive-observation") throw new Error("Expected positive observation");
		expect(result.observation.rows).toEqual([
			expect.objectContaining({ ratingKey: "movie-42", mediaType: "movie" }),
		]);
		const receipt = receiptFrom(result) as { units?: unknown[] } | undefined;
		expect(receipt?.units).toEqual([
			expect.objectContaining({
				scopeKey: "section:1",
				expectedRawCount: 3,
				rawObserved: 3,
				sourceBindings: 1,
				canonicalEntities: 1,
				acceptedSkips: [
					{ reason: "missing-supported-mapping", count: 1 },
					{ reason: "unsupported-provider-object", count: 1 },
				],
				fatalCount: 0,
			}),
		]);
		expect(evaluateProviderCoverageReceipt(receipt)).toMatchObject({
			evidence: "positive-only",
			complete: false,
		});
	});

	it("keeps repeated entities in distinct section source units", async () => {
		const result = await collectPlexCacheLiveEvidence(
			receiptCollectionClient({
				sections: [
					{ key: "movies", title: "Movies", type: "movie" },
					{ key: "shows", title: "Shows", type: "show" },
				],
				itemsBySection: {
					movies: [
						{ ratingKey: "movie-42", title: "Movie", type: "movie", Guid: [{ id: "tmdb://42" }] },
					],
					shows: [
						{ ratingKey: "show-42", title: "Show", type: "show", Guid: [{ id: "tmdb://42" }] },
					],
				},
			}),
			"inst-1",
			silentLog,
		);

		const receipt = receiptFrom(result) as { units?: unknown[] } | undefined;
		expect(receipt?.units).toEqual([
			expect.objectContaining({
				scopeKey: "section:movies",
				expectedRawCount: 1,
				rawObserved: 1,
				sourceBindings: 1,
				canonicalEntities: 1,
				acceptedSkips: [],
				fatalCount: 0,
			}),
			expect.objectContaining({
				scopeKey: "section:shows",
				expectedRawCount: 1,
				rawObserved: 1,
				sourceBindings: 1,
				canonicalEntities: 1,
				acceptedSkips: [],
				fatalCount: 0,
			}),
		]);
	});

	it("accounts for supported rows with missing rating keys", async () => {
		const result = await collectPlexCacheLiveEvidence(
			receiptCollectionClient({
				sections: [{ key: "1", title: "Movies", type: "movie" }],
				itemsBySection: {
					1: [
						{ ratingKey: "", title: "Keyless", type: "movie", Guid: [{ id: "tmdb://42" }] },
						{ ratingKey: "movie-43", title: "Mapped", type: "movie", Guid: [{ id: "tmdb://43" }] },
					],
				},
			}),
			"inst-1",
			silentLog,
		);

		const receipt = receiptFrom(result) as { units?: unknown[] } | undefined;
		expect(receipt?.units).toEqual([
			expect.objectContaining({
				scopeKey: "section:1",
				expectedRawCount: 2,
				rawObserved: 2,
				sourceBindings: 1,
				canonicalEntities: 1,
				acceptedSkips: [{ reason: "missing-stable-key", count: 1 }],
				fatalCount: 0,
			}),
		]);
	});

	it("accounts for supported rows with missing GUID mappings", async () => {
		const result = await collectPlexCacheLiveEvidence(
			receiptCollectionClient({
				sections: [{ key: "1", title: "Movies", type: "movie" }],
				itemsBySection: {
					1: [
						{ ratingKey: "unmapped", title: "Unmapped", type: "movie", Guid: [] },
						{ ratingKey: "movie-42", title: "Mapped", type: "movie", Guid: [{ id: "tmdb://42" }] },
					],
				},
			}),
			"inst-1",
			silentLog,
		);

		const receipt = receiptFrom(result) as { units?: unknown[] } | undefined;
		expect(receipt?.units).toEqual([
			expect.objectContaining({
				scopeKey: "section:1",
				expectedRawCount: 2,
				rawObserved: 2,
				sourceBindings: 1,
				canonicalEntities: 1,
				acceptedSkips: [{ reason: "missing-supported-mapping", count: 1 }],
				fatalCount: 0,
			}),
		]);
	});

	it("records Personal Media inventory as an explicit excluded source unit", async () => {
		const result = await collectPlexCacheLiveEvidence(
			receiptCollectionClient({
				sections: [
					{ key: "movies", title: "Movies", type: "movie" },
					{ key: "personal", title: "Personal", type: "movie", agent: "com.plexapp.agents.none" },
				],
				itemsBySection: {
					movies: [
						{ ratingKey: "movie-42", title: "Movie", type: "movie", Guid: [{ id: "tmdb://42" }] },
					],
					personal: [{ ratingKey: "personal-1", title: "Personal", type: "movie", Guid: [] }],
				},
			}),
			"inst-1",
			silentLog,
		);

		const receipt = receiptFrom(result) as { units?: unknown[] } | undefined;
		expect(receipt?.units).toEqual([
			expect.objectContaining({ scopeKey: "section:movies", rawObserved: 1, sourceBindings: 1 }),
			expect.objectContaining({
				scopeKey: "section:personal",
				expectedRawCount: 1,
				rawObserved: 1,
				sourceBindings: 0,
				canonicalEntities: 0,
				acceptedSkips: [{ reason: "unsupported-personal-media", count: 1 }],
				fatalCount: 0,
			}),
		]);
	});

	it("marks a failed section page as fatal and incomplete", async () => {
		const client = receiptCollectionClient({
			sections: [{ key: "1", title: "Movies", type: "movie" }],
			itemsBySection: { 1: [] },
			coverageResults: {
				1: {
					items: [],
					expectedRawCount: 4,
					pagesAttempted: 2,
					pagesCompleted: 1,
					rawObserved: 2,
					reason: "page-failure",
				},
			},
		});
		const result = await collectPlexCacheLiveEvidence(client, "inst-1", silentLog);

		const receipt = receiptFrom(result) as { units?: unknown[] } | undefined;
		expect(client.getLibraryItemsWithCoverage).toHaveBeenCalledWith("1");
		expect(result.kind).toBe("unpublished");
		expect(result.block?.reasons).toContain("coverage-incomplete");
		expect(result).not.toHaveProperty("snapshot");
		expect(result).not.toHaveProperty("observation");
		expect(result).not.toHaveProperty("items");
		expect(result).not.toHaveProperty("title");
		expect(result).not.toHaveProperty("url");
		expect(result.errorMessages).toEqual([]);
		expect(receipt).toBeDefined();
		expect(receipt?.units).toEqual([
			expect.objectContaining({
				scopeKey: "section:1",
				expectedRawCount: 4,
				pagesAttempted: 2,
				pagesCompleted: 1,
				rawObserved: 2,
				sourceBindings: 0,
				acceptedSkips: [],
				canonicalEntities: 0,
				fatalCount: 1,
			}),
		]);
		expect(evaluateProviderCoverageReceipt(receipt)).toMatchObject({
			valid: true,
			complete: false,
			rawObserved: 2,
			sourceBindings: 0,
			canonicalEntities: 0,
			fatalCount: 1,
		});
	});

	it("withholds a receipt-backed result when section identity changes", async () => {
		const sections = [{ key: "1", title: "Movies", type: "movie" as const }];
		const settledSections = [
			{
				key: "1",
				uuid: "section-uuid",
				title: "Movies",
				type: "movie" as const,
				refreshing: false,
				scannedAt: 1,
				updatedAt: 1,
			},
		];
		const changedSections = settledSections.map((section) => ({
			...section,
			uuid: "changed-uuid",
		}));
		const client = receiptCollectionClient({
			sections,
			itemsBySection: {
				1: [{ ratingKey: "movie-42", title: "Movie", type: "movie", Guid: [{ id: "tmdb://42" }] }],
			},
			settlementSections: settledSections,
		});
		vi.mocked(client.getLibrarySettlementSections)
			.mockReset()
			.mockResolvedValueOnce(settledSections)
			.mockResolvedValueOnce(changedSections);

		const result = await collectSettledPlexCacheLiveEvidence(client, "inst-1", silentLog);

		expect(result).toMatchObject({ kind: "unpublished", complete: false });
		expect(result.block?.reasons).toContain("settlement-unavailable");
		const receipt = receiptFrom(result);
		expect(receipt).toBeDefined();
		expect(evaluateProviderCoverageReceipt(receipt)).toMatchObject({ complete: false });
	});

	it("fails closed when the post-collection section observation drifts", async () => {
		const sections = [{ key: "1", title: "Movies", type: "movie" as const }];
		const settledSections = [
			{
				key: "1",
				uuid: "section-uuid",
				title: "Movies",
				type: "movie" as const,
				refreshing: false,
				scannedAt: 1,
				updatedAt: 1,
			},
		];
		const driftedSections = settledSections.map((section) => ({
			...section,
			uuid: "rotated-uuid",
			scannedAt: 2,
		}));
		let rowCollectionCount = 0;
		const client = receiptCollectionClient({
			sections,
			itemsBySection: {
				1: [{ ratingKey: "movie-42", title: "Movie", type: "movie", Guid: [{ id: "tmdb://42" }] }],
			},
			settlementSections: settledSections,
			onCoverage: () => rowCollectionCount++,
		});
		vi.mocked(client.getLibrarySettlementSections)
			.mockReset()
			.mockImplementation(async () =>
				rowCollectionCount >= 3 ? driftedSections : settledSections,
			);

		const result = await collectSettledPlexCacheLiveEvidence(client, "inst-1", silentLog);

		expect(rowCollectionCount).toBeGreaterThanOrEqual(2);
		expect(result).toMatchObject({ kind: "unpublished", complete: false });
		expect(result.block?.reasons).toContain("settlement-unavailable");
		expect(result.receipt).toMatchObject({ evidence: "unknown", units: [] });
		expect(result).not.toHaveProperty("targetLedger");
		expect(result).not.toHaveProperty("snapshot");
	});

	it("fails closed for positive observations when the post-collection section revision drifts", async () => {
		const sections = [{ key: "1", title: "Shows", type: "show" as const }];
		const settledSections = [
			{
				key: "1",
				uuid: "section-uuid",
				title: "Shows",
				type: "show" as const,
				refreshing: false,
				scannedAt: 1,
				updatedAt: 1,
			},
		];
		const driftedSections = settledSections.map((section) => ({
			...section,
			updatedAt: 2,
		}));
		let rowCollectionCount = 0;
		const client = receiptCollectionClient({
			sections,
			itemsBySection: {
				1: [
					{ ratingKey: "show-42", title: "Show", type: "show", Guid: [{ id: "tmdb://42" }] },
					{ ratingKey: "show-unmapped", title: "Unmapped", type: "show", Guid: [] },
				],
			},
			settlementSections: settledSections,
			onCoverage: () => rowCollectionCount++,
		});
		vi.mocked(client.getLibrarySettlementSections)
			.mockReset()
			.mockImplementation(async () =>
				rowCollectionCount >= 2 ? driftedSections : settledSections,
			);

		const result = await collectSettledPlexCacheLiveEvidence(client, "inst-1", silentLog);

		expect(rowCollectionCount).toBeGreaterThanOrEqual(2);
		expect(result).toMatchObject({ kind: "unpublished", complete: false });
		expect(result.block?.reasons).toContain("settlement-unavailable");
		expect(result.receipt).toMatchObject({ evidence: "unknown", units: [] });
		expect(result).not.toHaveProperty("observation");
		expect(result).not.toHaveProperty("targetLedger");
	});

	it("binds a settled receipt to the attempt start and settled completion", async () => {
		const attemptStartedAt = new Date("2026-09-02T12:00:00.000Z");
		const result = await collectSettledPlexCacheLiveEvidence(
			positiveObservationClient({
				libraryItems: [
					{
						ratingKey: "show-1",
						title: "Mapped Show",
						type: "show",
						Guid: [{ id: "tmdb://42" }, { id: "tvdb://42" }],
					},
				],
			}),
			"inst-1",
			silentLog,
			{ attemptStartedAt },
		);

		expect(result.completedAt).toBeInstanceOf(Date);
		expect(result.receipt).toMatchObject({
			attemptStartedAt: attemptStartedAt.toISOString(),
			observedAt: result.completedAt?.toISOString(),
		});
	});

	it("preserves the bound attempt start when positive verification fails", async () => {
		const attemptStartedAt = new Date("2026-09-02T12:00:00.000Z");
		const client = positiveObservationClient({});
		client.verifyHistorySnapshot = vi.fn().mockRejectedValue(new Error("verification failed"));
		silentLogInfo.mockClear();

		const result = await collectPlexCacheLiveEvidence(client, "inst-1", silentLog, {
			attemptStartedAt,
		});

		expect(result).toMatchObject({ kind: "unpublished", complete: false });
		expect(result.receipt).toMatchObject({
			attemptStartedAt: attemptStartedAt.toISOString(),
			evidence: "unknown",
		});
		expect(silentLogInfo).not.toHaveBeenCalledWith(
			expect.anything(),
			"Plex cache refresh complete",
		);
	});

	it("scopes settled positive evidence to Show parents and assigns its completion time only after settlement", async () => {
		const librarySections = [
			{ key: "movies", title: "Movies", type: "movie" as const },
			{ key: "shows", title: "Shows", type: "show" as const },
		];
		const settlementSections = [
			{
				key: "movies",
				uuid: "movies-uuid",
				title: "Movies",
				type: "movie" as const,
				refreshing: false,
				scannedAt: 1,
				updatedAt: 1,
			},
			{
				key: "shows",
				uuid: "shows-uuid",
				title: "Shows",
				type: "show" as const,
				refreshing: false,
				scannedAt: 1,
				updatedAt: 1,
			},
		];
		const libraryItemsBySection = {
			movies: [
				{
					ratingKey: "movie-1",
					title: "Mapped Movie",
					type: "movie" as const,
					Guid: [{ id: "tmdb://1" }],
				},
				{ ratingKey: "legacy-1", title: "Legacy Movie", type: "movie" as const, Guid: [] },
			],
			shows: [
				{
					ratingKey: "show-1",
					title: "Mapped Show",
					type: "show" as const,
					Guid: [{ id: "tmdb://42" }, { id: "tvdb://42" }],
				},
			],
		};
		const input = { librarySections, settlementSections, libraryItemsBySection };

		const unsettled = await collectPlexCacheLiveEvidence(
			positiveObservationClient(input),
			"inst-1",
			silentLog,
		);
		expect(unsettled.kind).toBe("positive-observation");
		expect(unsettled.completedAt).toBeUndefined();

		const settled = await collectSettledPlexCacheLiveEvidence(
			positiveObservationClient(input),
			"inst-1",
			silentLog,
		);

		expect(settled).toMatchObject({ kind: "positive-observation", completedAt: expect.any(Date) });
		if (settled.kind !== "positive-observation") throw new Error("Expected positive observation");
		expect(settled.observation.rows.map((row) => row.ratingKey)).toEqual(["movie-1", "show-1"]);
		expect(settled.observation.observedTargets.map((target) => target.ratingKey)).toEqual([
			"movie-1",
			"show-1",
		]);
		expect(settled.observation.observedRoots.map((root) => root.sectionKey)).toEqual(["shows"]);
		expect(settled.observation.settlement?.sections.map((section) => section.key)).toEqual([
			"movies",
			"shows",
		]);
	});

	it.each([
		"currentItemsWithoutTmdbMetadata",
		"currentLibraryItemsWithoutRatingKeys",
		"historyItemsWithoutUsableMediaKey",
		"currentHistoryItemsWithoutMappedMetadata",
		"historyItemsWithUnknownAccounts",
		"onDeckItemsWithoutMappedMetadata",
		"onDeckFetchFailures",
	] as const)("allows only the declared positive-only reason %s", (reason) => {
		expect(canPublishPositivePlexObservation({ [reason]: 1 })).toBe(true);
	});

	it("blocks unknown partial reasons by default", () => {
		// Extending collection with a new incomplete reason must not silently grant
		// observed-target authority before its policy is explicitly reviewed.
		expect(canPublishPositivePlexObservation({ futureReason: 1 })).toBe(false);
	});

	it.each([
		["no user accounts", positiveObservationClient({ accounts: [] })],
		["no media libraries", positiveObservationClient({ librarySections: [] })],
		[
			"a library snapshot failure",
			(() => {
				const client = positiveObservationClient({});
				vi.mocked(client.getLibraryItemsWithCoverage).mockRejectedValue(
					new Error("section unavailable"),
				);
				return client;
			})(),
		],
	] as const)("keeps partial evidence unpublished for %s", async (_caseName, client) => {
		const result = await collectPlexCacheLiveEvidence(client, "inst-1", silentLog);

		expect(result.kind).toBe("unpublished");
	});

	it.each([
		[
			"an active scan",
			positiveObservationClient({
				settlementSections: [
					{
						key: "shows",
						uuid: "shows-uuid",
						title: "Shows",
						type: "show",
						refreshing: true,
						scannedAt: 1,
						updatedAt: 1,
					},
				],
			}),
		],
		[
			"metadata activity",
			positiveObservationClient({ activities: [{ type: "library.update.item.metadata" }] }),
		],
	] as const)("keeps a positive observation unpublished during %s", async (_caseName, client) => {
		const result = await collectSettledPlexCacheLiveEvidence(client, "inst-1", silentLog);

		expect(result.kind).toBe("unpublished");
	});
	it("collects a complete large-library snapshot without publishing", async () => {
		// Stands in for "manual smoke on a Docker + SQLite deployment with a large
		// Plex library" — runs the full refreshPlexCache path with >1,000 items
		// and 1,500 pre-existing stale rows, then asserts:
		//   1. the refresh returns errors: 0 (i.e. no P2029 leaked through)
		//   2. every DELETE stays under the SQLite 999-parameter ceiling
		//   3. upserts are actually issued (we didn't silently short-circuit)
		const LIBRARY_SIZE = 1_200;

		const libraryItems = Array.from({ length: LIBRARY_SIZE }, (_, i) => ({
			ratingKey: `rk-${i}`,
			title: `Movie ${i}`,
			type: "movie",
			Guid: [{ id: `tmdb://${10_000 + i}` }],
			userRating: null,
			addedAt: 1_700_000_000,
			thumb: null,
			Collection: [],
			Label: [],
		}));

		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue(libraryItems),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(completeCoverage(libraryItems)),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;

		const transaction = vi.fn();
		const mockPrisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, mockPrisma, "inst-1", silentLog, undefined);

		expect(result.errors).toBe(0);
		expect(result.errorMessages).toEqual([]);
		expect(result.upserted).toBe(0);
		expect(result.snapshot?.rows).toHaveLength(LIBRARY_SIZE);
		expect(transaction).not.toHaveBeenCalled();
	});

	it("collects an authoritatively empty library without publishing", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([]),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(completeCoverage([])),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
		const tx = {
			plexCache: { deleteMany, createMany: vi.fn() },
			cacheRefreshStatus: { upsert: vi.fn().mockResolvedValue({}) },
		};
		const prisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ errors: 0, complete: true, upserted: 0 });
		expect(result.snapshot?.rows).toEqual([]);
		expect(deleteMany).not.toHaveBeenCalled();
		expect(tx.plexCache.createMany).not.toHaveBeenCalled();
	});

	it("collects a verified live snapshot without publishing cache state", async () => {
		const watchedAt = 1_723_000_000;
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "rk-1",
					title: "Recent Movie",
					type: "movie",
					viewCount: 1,
					Guid: [{ id: "tmdb://12345" }],
				},
			]),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(
				completeCoverage([
					{
						ratingKey: "rk-1",
						title: "Recent Movie",
						type: "movie",
						viewCount: 1,
						Guid: [{ id: "tmdb://12345" }],
					},
				]),
			),
			getHistory: vi
				.fn()
				.mockResolvedValue([
					{ type: "movie", ratingKey: "rk-1", accountID: 1, viewedAt: watchedAt },
				]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const transaction = vi.fn();
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined, {
			publish: false,
		});

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(result.snapshot?.rows).toEqual([
			expect.objectContaining({
				instanceId: "inst-1",
				tmdbId: 12345,
				lastWatchedAt: new Date(watchedAt * 1000),
				watchCount: 1,
			}),
		]);
		expect(result.snapshot?.sections).toEqual([{ key: "1", title: "Movies", type: "movie" }]);
		const authoritativeReceipt = receiptFrom(result) as {
			units: Array<{ canonicalEntities: number }>;
		};
		expect(
			authoritativeReceipt.units.reduce((total, unit) => total + unit.canonicalEntities, 0),
		).toBe(result.snapshot?.rows.length);
		expect(transaction).not.toHaveBeenCalled();
	});

	it("preserves item-level watch state when PMS has not emitted a history row", async () => {
		const lastViewedAt = 1_723_000_123;
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "rk-1",
					title: "Watched Movie",
					type: "movie",
					Guid: [{ id: "tmdb://12345" }],
					viewCount: 3,
					lastViewedAt,
				},
			]),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(
				completeCoverage([
					{
						ratingKey: "rk-1",
						title: "Watched Movie",
						type: "movie",
						Guid: [{ id: "tmdb://12345" }],
						viewCount: 3,
						lastViewedAt,
					},
				]),
			),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;

		const result = await collectPlexCacheLiveEvidence(mockClient, "inst-1", silentLog);

		expect(result.snapshot?.rows).toEqual([
			expect.objectContaining({
				tmdbId: 12345,
				watchCount: 3,
				lastWatchedAt: new Date(lastViewedAt * 1000),
			}),
		]);
	});

	it("preserves duplicate provider identities in a fresh authority observation", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "rk-1",
					title: "First copy",
					type: "movie",
					Guid: [{ id: "tmdb://12345" }],
				},
				{
					ratingKey: "rk-2",
					title: "Second copy",
					type: "movie",
					Guid: [{ id: "tmdb://12345" }],
				},
			]),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(
				completeCoverage([
					{
						ratingKey: "rk-1",
						title: "First copy",
						type: "movie",
						Guid: [{ id: "tmdb://12345" }],
					},
					{
						ratingKey: "rk-2",
						title: "Second copy",
						type: "movie",
						Guid: [{ id: "tmdb://12345" }],
					},
				]),
			),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;

		const result = await collectPlexCacheLiveEvidence(mockClient, "inst-1", silentLog, {
			preserveProviderDuplicates: true,
		});

		expect(result.complete).toBe(true);
		expect(result.snapshot?.rows.map((row) => row.ratingKey).sort()).toEqual(["rk-1", "rk-2"]);
	});

	it("keeps the previous generation when history changes after enrichment", async () => {
		const verifyHistorySnapshot = vi.fn().mockRejectedValue(new Error("history changed"));
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([]),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(completeCoverage([])),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot,
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/history changed/i);
		expect(verifyHistorySnapshot).toHaveBeenCalledOnce();
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it.each([
		["bounded history", "Plex history exceeded the safe 100000-row limit"],
		["repeated page", "Plex history returned a duplicate row while paging"],
	] as const)(
		"rejects incomplete %s history before publishing a cache generation",
		async (_caseName, message) => {
			const getHistory = vi.fn().mockRejectedValue(new Error(message));
			const cacheDelete = vi.fn();
			const statusUpsert = vi.fn();
			const tx = {
				plexCache: { deleteMany: cacheDelete, createMany: vi.fn() },
				cacheRefreshStatus: { upsert: statusUpsert },
			};
			const prisma = {
				$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
					callback(tx),
				),
			} as unknown as PrismaClient;
			const client = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi
					.fn()
					.mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
				getLibraryItems: vi.fn().mockResolvedValue([]),
				getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(completeCoverage([])),
				getHistory,
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;

			const result = await refreshPlexCache(client, prisma, "inst-1", silentLog, undefined);

			expect(getHistory).toHaveBeenCalledWith({ maxResults: 100_000, requireComplete: true });
			expect(result.complete).toBe(false);
			expect(prisma.$transaction).not.toHaveBeenCalled();
			expect(cacheDelete).not.toHaveBeenCalled();
			expect(statusUpsert).not.toHaveBeenCalled();
		},
	);

	it("keeps the previous generation when playback starts during history verification", async () => {
		const getOnDeck = vi
			.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ ratingKey: "rk-1", type: "movie" }]);
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([]),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(completeCoverage([])),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck,
		} as unknown as PlexClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages.join(" ")).toMatch(/on-deck state changed/i);
		expect(getOnDeck).toHaveBeenCalledTimes(2);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it("marks an on-deck failure incomplete and never evicts from that snapshot", async () => {
		const getLibraryItemsWithCoverage = vi.fn().mockResolvedValue(
			completeCoverage([
				{
					ratingKey: "rk-1",
					title: "Movie",
					type: "movie",
					Guid: [{ id: "tmdb://42" }],
					Collection: [],
					Label: [],
				},
			]),
		);
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "rk-1",
					title: "Movie",
					type: "movie",
					Guid: [{ id: "tmdb://42" }],
					Collection: [],
					Label: [],
				},
			]),
			getLibraryItemsWithCoverage,
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockRejectedValue(new Error("on-deck unavailable")),
		} as unknown as PlexClient;
		const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
		const mockPrisma = {
			plexCache: {
				upsert: vi.fn().mockResolvedValue({ id: "fresh-1" }),
				findMany: vi.fn().mockResolvedValue([{ id: "stale-1" }]),
				deleteMany,
			},
			$transaction: vi.fn(async (ops: Promise<unknown>[]) => await Promise.all(ops)),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, mockPrisma, "inst-1", silentLog, undefined);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(getLibraryItemsWithCoverage).toHaveBeenCalledWith("1");
		expect(await getLibraryItemsWithCoverage.mock.results[0]?.value).toMatchObject({
			items: [expect.objectContaining({ ratingKey: "rk-1", type: "movie" })],
			expectedRawCount: 1,
			rawObserved: 1,
		});
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("fails closed without evicting when account discovery is empty", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([]),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(completeCoverage([])),
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const deleteMany = vi.fn();
		const prisma = {
			plexCache: { findMany: vi.fn(), deleteMany },
			$transaction: vi.fn(),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false });
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("fails closed without evicting when no media library is discovered", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([]),
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const deleteMany = vi.fn();
		const prisma = {
			plexCache: { findMany: vi.fn(), deleteMany },
			$transaction: vi.fn(),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false });
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
	});

	it("collects a complete current library while ignoring history for a stale library key", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "current",
					title: "Current Movie",
					type: "movie",
					Guid: [{ id: "tmdb://42" }],
				},
			]),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(
				completeCoverage([
					{
						ratingKey: "current",
						title: "Current Movie",
						type: "movie",
						Guid: [{ id: "tmdb://42" }],
					},
				]),
			),
			getHistory: vi.fn().mockResolvedValue([
				{
					ratingKey: "stale",
					title: "Stale Movie",
					type: "movie",
					viewedAt: 1_700_000_000,
					accountID: 1,
				},
			]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
		const createMany = vi.fn().mockResolvedValue({ count: 1 });
		const tx = {
			plexCache: { deleteMany, createMany },
			cacheRefreshStatus: { upsert: vi.fn().mockResolvedValue({}) },
		};
		const prisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as PrismaClient;
		vi.mocked(silentLog.info).mockClear();

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(result.snapshot?.rows).toEqual([
			expect.objectContaining({ ratingKey: "current", tmdbId: 42 }),
		]);
		expect(deleteMany).not.toHaveBeenCalled();
		expect(createMany).not.toHaveBeenCalled();
	});

	it("collects a complete current show library while ignoring stale episode history", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "2", title: "Shows", type: "show" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "current-show",
					title: "Current Show",
					type: "show",
					Guid: [{ id: "tmdb://84" }],
				},
			]),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(
				completeCoverage([
					{
						ratingKey: "current-show",
						title: "Current Show",
						type: "show",
						Guid: [{ id: "tmdb://84" }],
					},
				]),
			),
			getHistory: vi.fn().mockResolvedValue([
				{
					ratingKey: "stale-episode",
					grandparentRatingKey: "stale-show",
					title: "Stale Episode",
					type: "episode",
					viewedAt: 1_700_000_000,
					accountID: 1,
				},
			]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const tx = {
			plexCache: { deleteMany: vi.fn(), createMany: vi.fn() },
			cacheRefreshStatus: { upsert: vi.fn() },
		};
		const prisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		} as unknown as PrismaClient;
		vi.mocked(silentLog.info).mockClear();

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 0 });
		expect(result.snapshot?.rows).toEqual([
			expect.objectContaining({ ratingKey: "current-show", tmdbId: 84 }),
		]);
	});

	it("fails closed when a stale history key becomes current before publication", async () => {
		const currentMovie = {
			ratingKey: "current",
			title: "Current Movie",
			type: "movie",
			Guid: [{ id: "tmdb://42" }],
		};
		const importedMovie = {
			ratingKey: "imported",
			title: "Imported Movie",
			type: "movie",
			Guid: [{ id: "tmdb://84" }],
		};
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi
				.fn()
				.mockResolvedValueOnce([currentMovie])
				.mockResolvedValueOnce([currentMovie, importedMovie]),
			getLibraryItemsWithCoverage: vi
				.fn()
				.mockResolvedValueOnce(completeCoverage([currentMovie]))
				.mockResolvedValueOnce(completeCoverage([currentMovie, importedMovie])),
			getHistory: vi.fn().mockResolvedValue([
				{
					ratingKey: "imported",
					title: "Imported Movie",
					type: "movie",
					viewedAt: 1_700_000_000,
					accountID: 1,
				},
			]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const tx = {
			plexCache: { deleteMany: vi.fn(), createMany: vi.fn() },
			cacheRefreshStatus: { upsert: vi.fn() },
		};
		const transaction = vi.fn(
			async (callback: (transactionClient: typeof tx) => Promise<unknown>) => callback(tx),
		);
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages).toContain(
			"Plex cache refresh failed: Plex library inventory changed before cache publication",
		);
		expect(transaction).not.toHaveBeenCalled();
	});

	it("fails closed when cleanup-relevant library metadata changes before publication", async () => {
		const initialMovie = {
			ratingKey: "current",
			title: "Current Movie",
			type: "movie",
			Guid: [{ id: "tmdb://42" }],
			Label: [{ tag: "eligible-for-cleanup" }],
		};
		const changedMovie = { ...initialMovie, Label: [] };
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi
				.fn()
				.mockResolvedValueOnce([initialMovie])
				.mockResolvedValueOnce([changedMovie]),
			getLibraryItemsWithCoverage: vi
				.fn()
				.mockResolvedValueOnce(completeCoverage([initialMovie]))
				.mockResolvedValueOnce(completeCoverage([changedMovie])),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const tx = {
			plexCache: { deleteMany: vi.fn(), createMany: vi.fn() },
			cacheRefreshStatus: { upsert: vi.fn() },
		};
		const transaction = vi.fn(
			async (callback: (transactionClient: typeof tx) => Promise<unknown>) => callback(tx),
		);
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages).toContain(
			"Plex cache refresh failed: Plex library inventory changed before cache publication",
		);
		expect(transaction).not.toHaveBeenCalled();
	});

	it.each(["history", "on-deck"] as const)(
		"fails closed when Plex %s changes during final library verification",
		async (activity) => {
			let inventoryVerificationFinished = false;
			const currentMovie = {
				ratingKey: "current",
				title: "Current Movie",
				type: "movie",
				Guid: [{ id: "tmdb://42" }],
			};
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi
					.fn()
					.mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
				getLibraryItems: vi
					.fn()
					.mockResolvedValueOnce([currentMovie])
					.mockImplementationOnce(async () => {
						inventoryVerificationFinished = true;
						return [currentMovie];
					}),
				getLibraryItemsWithCoverage: vi
					.fn()
					.mockResolvedValueOnce(completeCoverage([currentMovie]))
					.mockImplementationOnce(async () => {
						inventoryVerificationFinished = true;
						return completeCoverage([currentMovie]);
					}),
				getHistory: vi.fn().mockResolvedValue([]),
				verifyHistorySnapshot: vi.fn(async () => {
					if (activity === "history" && inventoryVerificationFinished) {
						throw new Error("Plex history changed during inventory verification");
					}
				}),
				getOnDeck: vi.fn(async () =>
					activity === "on-deck" && inventoryVerificationFinished
						? [{ ratingKey: "current", type: "movie" }]
						: [],
				),
			} as unknown as PlexClient;
			const tx = {
				plexCache: { deleteMany: vi.fn(), createMany: vi.fn() },
				cacheRefreshStatus: { upsert: vi.fn() },
			};
			const transaction = vi.fn(
				async (callback: (transactionClient: typeof tx) => Promise<unknown>) => callback(tx),
			);
			const prisma = { $transaction: transaction } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false, upserted: 0 });
			expect(transaction).not.toHaveBeenCalled();
		},
	);

	it("keeps the complete edition set only in live inventory targets when persistence collapses rows", async () => {
		const editions = [
			{
				ratingKey: "edition-a",
				title: "Example Movie",
				type: "movie",
				Guid: [{ id: "tmdb://42" }],
			},
			{
				ratingKey: "edition-b",
				title: "Example Movie",
				type: "movie",
				Guid: [{ id: "tmdb://42" }],
			},
		];
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue(editions),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(completeCoverage(editions)),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined, {
			publish: false,
		});

		expect(result.snapshot?.rows).toHaveLength(1);
		expect(result.snapshot?.rows[0]?.ratingKey).toBe("edition-a");
		expect(result.inventoryTargets).toEqual([
			{ sectionId: "1", mediaType: "movie", tmdbId: 42, ratingKey: "edition-a" },
			{ sectionId: "1", mediaType: "movie", tmdbId: 42, ratingKey: "edition-b" },
		]);
	});

	it("uses TVDb identity for current Sonarr series targets", async () => {
		const series = {
			ratingKey: "show-123",
			title: "Example Series",
			type: "show",
			Guid: [{ id: "tmdb://42" }, { id: "tvdb://123" }],
		};
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "2", title: "Shows", type: "show" }]),
			getLibraryItems: vi.fn().mockResolvedValue([series]),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(completeCoverage([series])),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined, {
			publish: false,
		});

		expect(result.snapshot?.rows).toHaveLength(1);
		expect(result.inventoryTargets).toEqual([
			{ sectionId: "2", mediaType: "series", tmdbId: 42, tvdbId: 123, ratingKey: "show-123" },
		]);
	});

	it("fails closed when stale relevant history belongs to an unknown account", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "current",
					title: "Current Movie",
					type: "movie",
					Guid: [{ id: "tmdb://42" }],
				},
			]),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(
				completeCoverage([
					{
						ratingKey: "current",
						title: "Current Movie",
						type: "movie",
						Guid: [{ id: "tmdb://42" }],
					},
				]),
			),
			getHistory: vi.fn().mockResolvedValue([
				{
					ratingKey: "stale",
					title: "Stale Movie",
					type: "movie",
					viewedAt: 1_700_000_000,
					accountID: 999,
				},
			]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const transaction = vi.fn();
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: true, upserted: 0 });
		expect(result.errorMessages).not.toContain(
			"Plex cache incomplete: 1 history item(s) with unknown accounts",
		);
		expect(transaction).not.toHaveBeenCalled();
	});

	it.each([
		[
			"movie history has an empty rating key",
			{ type: "movie", ratingKey: "", title: "Movie", viewedAt: 1_700_000_000, accountID: 1 },
			"Plex cache incomplete: 1 history item(s) without a usable media key",
		],
		[
			"episode history has no grandparent rating key",
			{
				type: "episode",
				ratingKey: "episode-1",
				title: "Episode",
				viewedAt: 1_700_000_000,
				accountID: 1,
			},
			"Plex cache incomplete: 1 history item(s) without a usable media key",
		],
	] as const)(
		"fails closed without publication when %s",
		async (_caseName, historyEntry, message) => {
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi
					.fn()
					.mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
				getLibraryItems: vi.fn().mockResolvedValue([
					{
						ratingKey: "current",
						title: "Current Movie",
						type: "movie",
						Guid: [{ id: "tmdb://42" }],
					},
				]),
				getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(
					completeCoverage([
						{
							ratingKey: "current",
							title: "Current Movie",
							type: "movie",
							Guid: [{ id: "tmdb://42" }],
						},
					]),
				),
				getHistory: vi.fn().mockResolvedValue([historyEntry]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const transaction = vi.fn();
			const prisma = { $transaction: transaction } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false, upserted: 0 });
			expect(result.errorMessages).toContain(message);
			expect(transaction).not.toHaveBeenCalled();
		},
	);

	it("fails closed without publication when a current library item has an empty rating key", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi
				.fn()
				.mockResolvedValue([
					{ ratingKey: "", title: "Current Movie", type: "movie", Guid: [{ id: "tmdb://42" }] },
				]),
			getLibraryItemsWithCoverage: vi
				.fn()
				.mockResolvedValue(
					completeCoverage([
						{ ratingKey: "", title: "Current Movie", type: "movie", Guid: [{ id: "tmdb://42" }] },
					]),
				),
			getHistory: vi.fn().mockResolvedValue([]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const transaction = vi.fn();
		const prisma = { $transaction: transaction } as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages).toContain(
			"Plex cache incomplete: 1 current library item(s) without a usable rating key",
		);
		expect(transaction).not.toHaveBeenCalled();
	});

	it("fails closed when a current historical item has no TMDB metadata", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockResolvedValue([
				{
					ratingKey: "current-without-tmdb",
					title: "Current Movie Without TMDB",
					type: "movie",
					Guid: [],
				},
			]),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(
				completeCoverage([
					{
						ratingKey: "current-without-tmdb",
						title: "Current Movie Without TMDB",
						type: "movie",
						Guid: [],
					},
				]),
			),
			getHistory: vi.fn().mockResolvedValue([
				{
					ratingKey: "current-without-tmdb",
					title: "Current Movie Without TMDB",
					type: "movie",
					viewedAt: 1_700_000_000,
					accountID: 1,
				},
			]),
			verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const transaction = vi.fn();
		const prisma = { $transaction: transaction } as unknown as PrismaClient;
		vi.mocked(silentLog.warn).mockClear();

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result).toMatchObject({ complete: false, upserted: 0 });
		expect(result.errorMessages).toContain(
			"Plex cache incomplete: 1 current library item(s) without TMDB metadata",
		);
		expect(transaction).not.toHaveBeenCalled();
		expect(silentLog.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				incompleteReasons: expect.objectContaining({ currentItemsWithoutTmdbMetadata: 1 }),
			}),
			"Plex cache: skipping eviction because the refreshed inventory was incomplete",
		);
	});

	it("fails closed when one discovered library returns only a partial snapshot", async () => {
		const mockClient = {
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
			getLibrarySections: vi.fn().mockResolvedValue([{ key: "1", title: "Movies", type: "movie" }]),
			getLibraryItems: vi.fn().mockRejectedValue(new Error("pagination stopped early")),
			getLibraryItemsWithCoverage: vi.fn().mockResolvedValue({
				items: [],
				expectedRawCount: 1,
				pagesAttempted: 1,
				pagesCompleted: 0,
				rawObserved: 0,
				reason: "page-failure",
			}),
			getHistory: vi.fn().mockResolvedValue([]),
			getOnDeck: vi.fn().mockResolvedValue([]),
		} as unknown as PlexClient;
		const deleteMany = vi.fn();
		const prisma = {
			plexCache: { findMany: vi.fn(), deleteMany },
			$transaction: vi.fn(),
		} as unknown as PrismaClient;

		const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

		expect(result.complete).toBe(false);
		expect(result.errors).toBeGreaterThan(0);
		expect(deleteMany).not.toHaveBeenCalled();
	});

	describe("Personal Media / Other Videos libraries (#769)", () => {
		const supportedMovie = {
			ratingKey: "movie-1",
			title: "Supported Movie",
			type: "movie",
			Guid: [{ id: "tmdb://42" }],
		};
		const personalMediaItem = {
			ratingKey: "personal-1",
			title: "Home Video",
			type: "movie",
			Guid: [],
		};
		const mixedSections = [
			{ key: "1", title: "Movies", type: "movie", agent: "tv.plex.agents.movie" },
			{ key: "2", title: "Other Videos", type: "movie", agent: "com.plexapp.agents.none" },
		];

		it.each([
			["com.plexapp.agents.none", true],
			["tv.plex.agents.none", true],
			["tv.plex.agents.movie", false],
			["tv.plex.agents.series", false],
			["example.plex.agents.none", false],
			["tv.plex.agents.none.custom", false],
			["tv.plex.agent.none", false],
			["agents.none", false],
			[undefined, false],
		] as const)("classifies only the exact Personal Media agent %s", (agent, expected) => {
			expect(isPersonalMediaSection({ type: "movie", agent })).toBe(expected);
		});

		it("excludes a Show-type section using the modern Personal Media agent", async () => {
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi.fn().mockResolvedValue([
					{ key: "1", title: "Movies", type: "movie", agent: "tv.plex.agents.movie" },
					{ key: "2", title: "Personal", type: "show", agent: "tv.plex.agents.none" },
				]),
				getLibraryItems: vi
					.fn()
					.mockImplementation((key: string) =>
						key === "1"
							? [supportedMovie]
							: [{ ratingKey: "", title: "Personal", type: "show", Guid: [] }],
					),
				getLibraryItemsWithCoverage: vi
					.fn()
					.mockImplementation((key: string) =>
						completeCoverage(
							key === "1"
								? [supportedMovie]
								: [{ ratingKey: "", title: "Personal", type: "show", Guid: [] }],
						),
					),
				getHistory: vi.fn().mockResolvedValue([]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog);

			expect(result).toMatchObject({ kind: "authoritative-snapshot", complete: true });
			expect(result.snapshot?.rows.map((row) => row.ratingKey)).toEqual(["movie-1"]);
			expect(result.inventoryTargets).toEqual([
				{ sectionId: "1", mediaType: "movie", tmdbId: 42, ratingKey: "movie-1" },
			]);
		});

		it("publishes only fully mapped Movie/Show evidence for the reporter topology", async () => {
			const sections = [
				{ key: "movies", title: "Movies", type: "movie", agent: "tv.plex.agents.movie" },
				{ key: "shows", title: "Shows", type: "show", agent: "tv.plex.agents.series" },
				{ key: "personal", title: "Other", type: "movie", agent: "tv.plex.agents.none" },
				{ key: "music", title: "Music", type: "artist", agent: "tv.plex.agents.music" },
			];
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi.fn().mockResolvedValue(sections),
				getLibraryItems: vi.fn().mockImplementation((key: string) => {
					if (key === "movies") {
						return [
							{
								ratingKey: "movie-1",
								title: "Movie",
								type: "movie",
								Guid: [{ id: "tmdb://10" }],
							},
						];
					}
					if (key === "shows") {
						return [
							{
								ratingKey: "show-1",
								title: "Show",
								type: "show",
								Guid: [{ id: "tmdb://20" }, { id: "tvdb://30" }],
							},
						];
					}
					if (key === "personal") {
						return [
							{ ratingKey: "personal-1", title: "Personal", type: "movie", Guid: [] },
							{ ratingKey: "", title: "Keyless Personal", type: "movie", Guid: [] },
						];
					}
					throw new Error("Unsupported section type entered Movie/Show collection");
				}),
				getLibraryItemsWithCoverage: vi.fn().mockImplementation((key: string) => {
					if (key === "movies") {
						return completeCoverage([
							{ ratingKey: "movie-1", title: "Movie", type: "movie", Guid: [{ id: "tmdb://10" }] },
						]);
					}
					if (key === "shows") {
						return completeCoverage([
							{
								ratingKey: "show-1",
								title: "Show",
								type: "show",
								Guid: [{ id: "tmdb://20" }, { id: "tvdb://30" }],
							},
						]);
					}
					return completeCoverage([
						{ ratingKey: "personal-1", title: "Personal", type: "movie", Guid: [] },
						{ ratingKey: "", title: "Keyless Personal", type: "movie", Guid: [] },
					]);
				}),
				getHistory: vi.fn().mockResolvedValue([
					{
						historyKey: "history-personal-movie",
						type: "movie",
						ratingKey: "",
						librarySectionID: "personal",
						accountID: 1,
						viewedAt: 1_700_000_000,
					},
					{
						historyKey: "history-personal-episode",
						type: "episode",
						ratingKey: "personal-episode",
						librarySectionID: "personal",
						accountID: 1,
						viewedAt: 1_700_000_001,
					},
					{
						historyKey: "history-stale-supported",
						type: "movie",
						ratingKey: "stale-supported",
						librarySectionID: "movies",
						accountID: 1,
						viewedAt: 1_700_000_002,
					},
				]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog);

			expect(result).toMatchObject({
				kind: "authoritative-snapshot",
				complete: true,
				errors: 0,
				errorMessages: [],
			});
			expect(result.snapshot?.sections).toEqual([
				{ key: "movies", title: "Movies", type: "movie" },
				{ key: "shows", title: "Shows", type: "show" },
			]);
			expect(result.snapshot?.rows.map((row) => row.ratingKey).sort()).toEqual([
				"movie-1",
				"show-1",
			]);
			expect(result.inventoryTargets).toEqual([
				{ sectionId: "movies", mediaType: "movie", tmdbId: 10, ratingKey: "movie-1" },
				{
					sectionId: "shows",
					mediaType: "series",
					tmdbId: 20,
					tvdbId: 30,
					ratingKey: "show-1",
				},
			]);
		});

		it("ignores deleted history while excluding containers and Personal Media from Movie/Show authority", async () => {
			const sections = [
				{ key: "movies", title: "Movies", type: "movie", agent: "tv.plex.agents.movie" },
				{ key: "shows", title: "Shows", type: "show", agent: "tv.plex.agents.series" },
				{ key: "personal", title: "Other", type: "movie", agent: "tv.plex.agents.none" },
			];
			const itemsBySection = {
				movies: [
					{
						ratingKey: "movie-current",
						title: "Current Movie",
						type: "movie",
						viewCount: 0,
						Guid: [{ id: "tmdb://10" }],
					},
					{
						ratingKey: "movie-collection",
						title: "Movie Collection",
						type: "collection",
						Guid: [{ id: "plex://collection/movie-collection" }],
					},
				],
				shows: [
					{
						ratingKey: "show-current",
						title: "Current Show",
						type: "show",
						viewCount: 0,
						Guid: [{ id: "tmdb://20" }, { id: "tvdb://30" }],
					},
				],
				personal: [
					{
						ratingKey: "personal-current",
						title: "Personal Video",
						type: "movie",
						Guid: [],
					},
				],
			};
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi.fn().mockResolvedValue(sections),
				getLibraryItems: vi
					.fn()
					.mockImplementation((key: keyof typeof itemsBySection) => itemsBySection[key]),
				getLibraryItemsWithCoverage: vi
					.fn()
					.mockImplementation((key: keyof typeof itemsBySection) =>
						completeCoverage(itemsBySection[key]),
					),
				getHistory: vi.fn().mockResolvedValue([
					{
						historyKey: "retained-deleted-movie",
						type: "movie",
						ratingKey: "movie-deleted",
						librarySectionID: "movies",
						accountID: 1,
						viewedAt: 1_700_000_000,
					},
					{
						historyKey: "excluded-personal-video",
						type: "movie",
						ratingKey: "",
						librarySectionID: "personal",
						accountID: 1,
						viewedAt: 1_700_000_001,
					},
				]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			silentLogInfo.mockClear();
			const result = await refreshPlexCache(
				mockClient,
				{ $transaction: vi.fn() } as never,
				"inst-1",
				silentLog,
			);

			expect(result).toMatchObject({
				kind: "authoritative-snapshot",
				complete: true,
				errors: 0,
				errorMessages: [],
			});
			expect(result.snapshot?.rows.map((row) => row.ratingKey).sort()).toEqual([
				"movie-current",
				"show-current",
			]);
			expect(result.inventoryTargets).toEqual([
				{ sectionId: "movies", mediaType: "movie", tmdbId: 10, ratingKey: "movie-current" },
				{
					sectionId: "shows",
					mediaType: "series",
					tmdbId: 20,
					tvdbId: 30,
					ratingKey: "show-current",
				},
			]);
			expect(result.snapshot?.rows.map((row) => row.ratingKey)).not.toContain("movie-deleted");
			expect(result.inventoryTargets?.map((target) => target.ratingKey)).not.toContain(
				"personal-current",
			);
			const receipt = receiptFrom(result) as { units?: unknown[] } | undefined;
			expect(receipt?.units).toEqual([
				expect.objectContaining({
					scopeKey: "section:movies",
					expectedRawCount: 2,
					rawObserved: 2,
					sourceBindings: 1,
					canonicalEntities: 1,
					acceptedSkips: [{ reason: "known-container", count: 1 }],
				}),
				expect.objectContaining({
					scopeKey: "section:shows",
					expectedRawCount: 1,
					rawObserved: 1,
					sourceBindings: 1,
					canonicalEntities: 1,
					acceptedSkips: [],
				}),
				expect.objectContaining({
					scopeKey: "section:personal",
					expectedRawCount: 1,
					rawObserved: 1,
					sourceBindings: 0,
					canonicalEntities: 0,
					acceptedSkips: [{ reason: "unsupported-personal-media", count: 1 }],
				}),
			]);
			expect(evaluateProviderCoverageReceipt(receipt)).toMatchObject({
				evidence: "complete",
				complete: true,
			});
			expect(silentLogInfo).toHaveBeenCalledWith(
				expect.objectContaining({ totalHistory: 2, ignoredHistoricalItems: 1 }),
				"Plex cache refresh complete",
			);
		});

		it("excludes a Personal Media section from the supported-media authority domain", async () => {
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi.fn().mockResolvedValue(mixedSections),
				getLibraryItems: vi
					.fn()
					.mockImplementation((key: string) =>
						key === "1" ? [supportedMovie] : [personalMediaItem],
					),
				getLibraryItemsWithCoverage: vi
					.fn()
					.mockImplementation((key: string) =>
						completeCoverage(key === "1" ? [supportedMovie] : [personalMediaItem]),
					),
				getHistory: vi.fn().mockResolvedValue([]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: true, errors: 0 });
			expect(result.snapshot?.rows).toHaveLength(1);
			expect(result.snapshot?.rows[0]).toEqual(expect.objectContaining({ tmdbId: 42 }));
			expect(result.snapshot?.sections).toEqual([{ key: "1", title: "Movies", type: "movie" }]);
			expect(result.inventoryTargets).toEqual([
				{ sectionId: "1", mediaType: "movie", tmdbId: 42, ratingKey: "movie-1" },
			]);
		});

		it("does not poison completeness when Personal Media history cannot map", async () => {
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi.fn().mockResolvedValue(mixedSections),
				getLibraryItems: vi
					.fn()
					.mockImplementation((key: string) =>
						key === "1" ? [supportedMovie] : [personalMediaItem],
					),
				getLibraryItemsWithCoverage: vi
					.fn()
					.mockImplementation((key: string) =>
						completeCoverage(key === "1" ? [supportedMovie] : [personalMediaItem]),
					),
				getHistory: vi
					.fn()
					.mockResolvedValue([
						{ type: "movie", ratingKey: "personal-1", accountID: 1, viewedAt: 1_700_000_000 },
					]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: true, errors: 0 });
			expect(result.snapshot?.rows).toHaveLength(1);
			expect(result.snapshot?.rows[0]).toEqual(expect.objectContaining({ tmdbId: 42 }));
		});

		it("still fails closed when a supported movie lacks TMDB metadata", async () => {
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi
					.fn()
					.mockResolvedValue([
						{ key: "1", title: "Movies", type: "movie", agent: "tv.plex.agents.movie" },
					]),
				getLibraryItems: vi
					.fn()
					.mockResolvedValue([
						{ ratingKey: "broken-1", title: "Broken Movie", type: "movie", Guid: [] },
					]),
				getLibraryItemsWithCoverage: vi
					.fn()
					.mockResolvedValue(
						completeCoverage([
							{ ratingKey: "broken-1", title: "Broken Movie", type: "movie", Guid: [] },
						]),
					),
				getHistory: vi.fn().mockResolvedValue([]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false });
			expect(result.errorMessages).toContain(
				"Plex cache incomplete: 1 current library item(s) without TMDB metadata",
			);
		});

		it("still fails closed when supported history cannot map to TMDB metadata", async () => {
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi
					.fn()
					.mockResolvedValue([
						{ key: "1", title: "Movies", type: "movie", agent: "tv.plex.agents.movie" },
					]),
				getLibraryItems: vi
					.fn()
					.mockResolvedValue([
						{ ratingKey: "broken-1", title: "Broken Movie", type: "movie", Guid: [] },
					]),
				getLibraryItemsWithCoverage: vi
					.fn()
					.mockResolvedValue(
						completeCoverage([
							{ ratingKey: "broken-1", title: "Broken Movie", type: "movie", Guid: [] },
						]),
					),
				getHistory: vi
					.fn()
					.mockResolvedValue([
						{ type: "movie", ratingKey: "broken-1", accountID: 1, viewedAt: 1_700_000_000 },
					]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false });
			expect(result.errorMessages).toContain(
				"Plex cache incomplete: 1 current history item(s) without mapped TMDB metadata",
			);
		});

		it("does not exclude a section with an unknown agent merely for lacking TMDB", async () => {
			const mockClient = {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi.fn().mockResolvedValue([
					{ key: "1", title: "Movies", type: "movie", agent: "tv.plex.agents.movie" },
					{ key: "3", title: "Custom", type: "movie", agent: "com.example.agents.custom" },
				]),
				getLibraryItems: vi
					.fn()
					.mockImplementation((key: string) =>
						key === "1"
							? [supportedMovie]
							: [{ ratingKey: "custom-1", title: "Custom", type: "movie", Guid: [] }],
					),
				getLibraryItemsWithCoverage: vi
					.fn()
					.mockImplementation((key: string) =>
						completeCoverage(
							key === "1"
								? [supportedMovie]
								: [{ ratingKey: "custom-1", title: "Custom", type: "movie", Guid: [] }],
						),
					),
				getHistory: vi.fn().mockResolvedValue([]),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false });
			expect(result.errorMessages).toContain(
				"Plex cache incomplete: 1 current library item(s) without TMDB metadata",
			);
		});
	});

	describe("Personal Media history with missing media keys (#769)", () => {
		const supportedMovie = {
			ratingKey: "movie-1",
			title: "Supported Movie",
			type: "movie",
			Guid: [{ id: "tmdb://42" }],
		};
		const sections = [
			{ key: "1", title: "Movies", type: "movie", agent: "tv.plex.agents.movie" },
			{ key: "2", title: "Other Videos", type: "movie", agent: "com.plexapp.agents.none" },
		];

		function clientWith(history: unknown[]) {
			return {
				getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
				getLibrarySections: vi.fn().mockResolvedValue(sections),
				getLibraryItems: vi.fn().mockResolvedValue([supportedMovie]),
				getLibraryItemsWithCoverage: vi.fn().mockResolvedValue(completeCoverage([supportedMovie])),
				getHistory: vi.fn().mockResolvedValue(history),
				verifyHistorySnapshot: vi.fn().mockResolvedValue(undefined),
				getOnDeck: vi.fn().mockResolvedValue([]),
			} as unknown as PlexClient;
		}

		it("ignores Personal Media movie history with a missing rating key", async () => {
			const mockClient = clientWith([
				{
					type: "movie",
					ratingKey: "",
					librarySectionID: "2",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
			]);
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: true, errors: 0 });
		});

		it("ignores Personal Media episode history with a missing grandparent key", async () => {
			const mockClient = clientWith([
				{
					type: "episode",
					ratingKey: "episode-1",
					librarySectionID: "2",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
			]);
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: true, errors: 0 });
		});

		it("fails closed for supported movie history with a missing rating key", async () => {
			const mockClient = clientWith([
				{
					type: "movie",
					ratingKey: "",
					librarySectionID: "1",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
			]);
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false });
			expect(result.errorMessages).toContain(
				"Plex cache incomplete: 1 history item(s) without a usable media key",
			);
		});

		it("fails closed for supported episode history with a missing grandparent key", async () => {
			const mockClient = clientWith([
				{
					type: "episode",
					ratingKey: "episode-1",
					librarySectionID: "1",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
			]);
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false });
			expect(result.errorMessages).toContain(
				"Plex cache incomplete: 1 history item(s) without a usable media key",
			);
		});

		it("fails closed for history with a missing librarySectionID and missing key", async () => {
			const mockClient = clientWith([
				{ type: "movie", ratingKey: "", accountID: 1, viewedAt: 1_700_000_000 },
			]);
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false });
			expect(result.errorMessages).toContain(
				"Plex cache incomplete: 1 history item(s) without a usable media key",
			);
		});

		it("fails closed for history with an unknown librarySectionID and missing key", async () => {
			const mockClient = clientWith([
				{
					type: "movie",
					ratingKey: "",
					librarySectionID: "999",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
			]);
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: false });
			expect(result.errorMessages).toContain(
				"Plex cache incomplete: 1 history item(s) without a usable media key",
			);
		});

		it("preserves stale-history protection for a usable key outside current inventory", async () => {
			const mockClient = clientWith([
				{
					type: "movie",
					ratingKey: "stale",
					librarySectionID: "1",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
			]);
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: true, errors: 0 });
			expect(result.snapshot?.rows).toHaveLength(1);
			expect(result.snapshot?.rows[0]).toEqual(expect.objectContaining({ tmdbId: 42 }));
		});

		it("completes a mixed production topology with Personal Media history missing keys", async () => {
			const mockClient = clientWith([
				{
					type: "movie",
					ratingKey: "",
					librarySectionID: "2",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
				{
					type: "episode",
					ratingKey: "episode-1",
					librarySectionID: "2",
					accountID: 1,
					viewedAt: 1_700_000_000,
				},
			]);
			const prisma = { $transaction: vi.fn() } as unknown as PrismaClient;

			const result = await refreshPlexCache(mockClient, prisma, "inst-1", silentLog, undefined);

			expect(result).toMatchObject({ complete: true, errors: 0 });
			expect(result.snapshot?.rows).toHaveLength(1);
			expect(result.snapshot?.rows[0]).toEqual(expect.objectContaining({ tmdbId: 42 }));
		});
	});
});
