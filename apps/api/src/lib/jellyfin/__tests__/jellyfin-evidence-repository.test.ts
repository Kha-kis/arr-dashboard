import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceInstance } from "../../prisma.js";
import { fingerprintJellyfinEpisodeParentDependency } from "../jellyfin-episode-parent-dependency.js";
import type {
	CacheStatus,
	JellyfinEpisodeRow,
	JellyfinEvidencePrisma,
	JellyfinLibraryRow,
	TransactionReader,
} from "../jellyfin-evidence-repository.js";
import {
	readOwnedJellyfinObservation,
	readOwnedJellyfinObservationInTransaction,
} from "../jellyfin-evidence-repository.js";
import {
	encodeJellyfinEpisodeGenerationMetadata,
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinEpisodeRows,
	fingerprintJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
} from "../jellyfin-generation-metadata.js";

const observedAt = new Date("2026-08-20T12:00:00.000Z");
const now = new Date("2026-08-20T13:00:00.000Z");

function receipt(
	provider: "jellyfin" | "emby" | "jellyfin_episode" | "emby_episode",
	count: number,
	at = observedAt,
) {
	return {
		version: 1 as const,
		provider,
		attemptStartedAt: at.toISOString(),
		observedAt: at.toISOString(),
		evidence: "complete" as const,
		units: [
			{
				scopeKey: "library",
				expectedRawCount: count,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: count,
				sourceBindings: count,
				canonicalEntities: count,
				acceptedSkips: [],
				fatalCount: 0,
			},
		],
		publishedCanonicalEntities: count,
	};
}

type FixtureLibraryRow = JellyfinLibraryRow & { mediaType: "movie" | "series" };

function libraryRow(overrides: Partial<FixtureLibraryRow> = {}): FixtureLibraryRow {
	return {
		id: "library-row-1",
		instanceId: "jellyfin-1",
		tmdbId: 42,
		mediaType: "movie",
		libraryId: "library-1",
		libraryName: "Movies",
		title: "Movie",
		jellyfinId: "item-1",
		lastWatchedAt: observedAt,
		watchCount: 1,
		watchedByUsers: '["user-1"]',
		onDeck: false,
		userRating: null,
		collections: "[]",
		addedAt: observedAt,
		thumb: null,
		connectionGeneration: 1,
		identityGeneration: 1,
		...overrides,
	};
}

function episodeRow(overrides: Partial<JellyfinEpisodeRow> = {}): JellyfinEpisodeRow {
	return {
		id: "episode-row-1",
		instanceId: "jellyfin-1",
		showTmdbId: 42,
		seasonNumber: 1,
		episodeNumber: 1,
		jellyfinId: "episode-1",
		title: "Episode",
		watched: true,
		watchedByUsers: '["user-1"]',
		lastWatchedAt: observedAt,
		connectionGeneration: 1,
		identityGeneration: 1,
		...overrides,
	};
}

function makeInstance(
	service: "JELLYFIN" | "EMBY" = "JELLYFIN",
): Pick<
	ServiceInstance,
	| "id"
	| "userId"
	| "service"
	| "enabled"
	| "expectedIdentity"
	| "identityStatus"
	| "connectionGeneration"
	| "identityGeneration"
> & { updatedAt: Date } {
	return {
		id: "jellyfin-1",
		userId: "user-1",
		service,
		enabled: true,
		expectedIdentity: "server-1",
		identityStatus: "VERIFIED",
		connectionGeneration: 1,
		identityGeneration: 1,
		updatedAt: new Date("2026-08-01T00:00:00.000Z"),
	};
}

function libraryMetadata(instance = makeInstance(), rows = [libraryRow()], at = observedAt) {
	const provider = instance.service === "EMBY" ? "emby" : "jellyfin";
	return encodeJellyfinLibraryGenerationMetadata({
		version: 1,
		provider,
		cacheType: "jellyfin",
		publicationLevel: "authoritative",
		completeness: "complete",
		canonicalizationVersion: 1,
		itemCount: rows.length,
		connectionGeneration: 1,
		identityGeneration: 1,
		contentFingerprint: fingerprintJellyfinLibraryRows(rows),
		coverageReceipt: receipt(provider, rows.length, at),
	});
}

function positiveOnlyLibraryMetadata(
	instance = makeInstance(),
	rows = [libraryRow()],
	at = observedAt,
) {
	const provider = instance.service === "EMBY" ? "emby" : "jellyfin";
	return encodeJellyfinLibraryGenerationMetadata({
		version: 1,
		provider,
		cacheType: "jellyfin",
		publicationLevel: "positive-only",
		completeness: "partial",
		canonicalizationVersion: 1,
		itemCount: rows.length,
		connectionGeneration: 1,
		identityGeneration: 1,
		contentFingerprint: fingerprintJellyfinLibraryRows(rows),
		coverageReceipt: {
			...receipt(provider, rows.length, at),
			evidence: "positive-only",
			units: [
				{
					scopeKey: "library",
					expectedRawCount: null,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: rows.length + 1,
					sourceBindings: rows.length,
					canonicalEntities: rows.length,
					acceptedSkips: [{ reason: "unsupported-provider-object", count: 1 }],
					fatalCount: 0,
				},
			],
			publishedCanonicalEntities: rows.length,
		},
	});
}

function v2PositiveOnlyLibraryMetadata(
	instance = makeInstance(),
	rows = [libraryRow()],
	at = observedAt,
) {
	const provider = instance.service === "EMBY" ? "emby" : "jellyfin";
	const inventoryUnit = {
		scopeKey: "library:inventory",
		expectedRawCount: rows.length + 1,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: rows.length + 1,
		sourceBindings: rows.length + 1,
		canonicalEntities: rows.length,
		acceptedSkips: [],
		fatalCount: 0,
	};
	const mappingUnit = {
		...inventoryUnit,
		scopeKey: "library:mapping",
		sourceBindings: rows.length,
		acceptedSkips: [{ reason: "missing-supported-mapping" as const, count: 1 }],
	};
	return encodeJellyfinLibraryGenerationMetadata({
		version: 1,
		provider,
		cacheType: "jellyfin",
		publicationLevel: "positive-only",
		completeness: "partial",
		canonicalizationVersion: 1,
		itemCount: rows.length,
		connectionGeneration: 1,
		identityGeneration: 1,
		contentFingerprint: fingerprintJellyfinLibraryRows(rows),
		coverageReceipt: {
			version: 2,
			provider,
			attemptStartedAt: at.toISOString(),
			observedAt: at.toISOString(),
			evidence: "positive-only",
			units: [inventoryUnit],
			publishedCanonicalEntities: rows.length,
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
					publishedCanonicalEntities: rows.length,
				},
				{
					domain: "watch-count",
					evidence: "positive-only",
					valueSemantics: "lower-bound",
					units: [
						{
							...inventoryUnit,
							scopeKey: "library:watch-count",
							expectedRawCount: rows.length,
							rawObserved: rows.length,
							sourceBindings: rows.length,
							canonicalEntities: rows.length,
						},
					],
					publishedCanonicalEntities: rows.length,
				},
				{
					domain: "watch-attribution",
					evidence: "complete",
					valueSemantics: "exact",
					units: [
						{
							...inventoryUnit,
							scopeKey: "library:watch-attribution",
							expectedRawCount: rows.length,
							rawObserved: rows.length,
							sourceBindings: rows.length,
							canonicalEntities: rows.length,
						},
					],
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
	});
}

function episodeMetadata(
	instance = makeInstance(),
	rows: JellyfinEpisodeRow[] = [episodeRow()],
	parentLibraryGenerationId = "jellyfin-generation-1",
	parentLibraryMetadataFingerprint = fingerprintJellyfinLibraryGenerationMetadata(
		JSON.parse(libraryMetadata(instance)),
	),
) {
	const provider = instance.service === "EMBY" ? "emby_episode" : "jellyfin_episode";
	return encodeJellyfinEpisodeGenerationMetadata({
		version: 1,
		provider: provider === "emby_episode" ? "emby" : "jellyfin",
		cacheType: "jellyfin_episode",
		publicationLevel: "authoritative",
		completeness: "complete",
		canonicalizationVersion: 1,
		itemCount: rows.length,
		connectionGeneration: 1,
		identityGeneration: 1,
		parentLibraryGenerationId,
		parentLibraryMetadataFingerprint,
		contentFingerprint: fingerprintJellyfinEpisodeRows(rows),
		coverageReceipt: receipt(provider, rows.length),
	});
}

function v2PositiveOnlyEpisodeMetadata(
	instance = makeInstance(),
	rows: JellyfinEpisodeRow[] = [episodeRow()],
	parentLibraryGenerationId = "jellyfin-generation-1",
	parentLibraryMetadataFingerprint = fingerprintJellyfinLibraryGenerationMetadata(
		JSON.parse(libraryMetadata(instance)),
	),
) {
	const provider = instance.service === "EMBY" ? "emby_episode" : "jellyfin_episode";
	const unit = {
		scopeKey: "episode-inventory:library-1",
		expectedRawCount: rows.length + 1,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: rows.length + 1,
		sourceBindings: rows.length,
		canonicalEntities: rows.length,
		acceptedSkips: [{ reason: "missing-supported-mapping" as const, count: 1 }],
		fatalCount: 0,
	};
	return encodeJellyfinEpisodeGenerationMetadata({
		version: 1,
		provider: provider === "emby_episode" ? "emby" : "jellyfin",
		cacheType: "jellyfin_episode",
		publicationLevel: "positive-only",
		completeness: "partial",
		canonicalizationVersion: 1,
		itemCount: rows.length,
		connectionGeneration: 1,
		identityGeneration: 1,
		parentLibraryGenerationId,
		parentLibraryMetadataFingerprint,
		contentFingerprint: fingerprintJellyfinEpisodeRows(rows),
		coverageReceipt: {
			version: 2,
			provider,
			attemptStartedAt: observedAt.toISOString(),
			observedAt: observedAt.toISOString(),
			evidence: "positive-only",
			units: [unit],
			publishedCanonicalEntities: rows.length,
			domains: [
				{
					domain: "episode-inventory",
					evidence: "positive-only",
					valueSemantics: "lower-bound",
					units: [unit],
					publishedCanonicalEntities: rows.length,
				},
			],
		},
	});
}

function status(
	cacheType: "jellyfin" | "jellyfin_episode",
	metadata: string,
	count: number,
): CacheStatus {
	return {
		instanceId: "jellyfin-1",
		cacheType,
		lastRefreshedAt: observedAt,
		lastResult: "success",
		lastErrorMessage: null,
		itemCount: count,
		generationId: `${cacheType}-generation-1`,
		generationMetadata: metadata,
		lastAttemptAt: observedAt,
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
		connectionGeneration: 1,
		identityGeneration: 1,
	};
}

function makePrisma(options: {
	instance?: ReturnType<typeof makeInstance> | null;
	statuses?: Record<string, CacheStatus | undefined>;
	rows?: JellyfinLibraryRow[];
	episodeRows?: JellyfinEpisodeRow[];
	libraryPages?: JellyfinLibraryRow[][];
	episodePages?: JellyfinEpisodeRow[][];
	secondStatus?: CacheStatus;
	statusSequences?: Partial<Record<"jellyfin" | "jellyfin_episode", CacheStatus[]>>;
}) {
	const instance = options.instance === undefined ? makeInstance() : options.instance;
	const statuses = options.statuses ?? {};
	const statusReads = new Map<string, number>();
	const findUnique = vi.fn(
		async ({
			where,
		}: {
			where: { instanceId_cacheType: { cacheType: string }; instance: { userId: string } };
		}) => {
			const cacheType = where.instanceId_cacheType.cacheType;
			const count = (statusReads.get(cacheType) ?? 0) + 1;
			statusReads.set(cacheType, count);
			const sequence = options.statusSequences?.[cacheType as "jellyfin" | "jellyfin_episode"];
			if (sequence) return sequence[count - 1] ?? sequence.at(-1) ?? null;
			return count > 1 && options.secondStatus
				? options.secondStatus
				: (statuses[cacheType] ?? null);
		},
	);
	const rows: JellyfinLibraryRow[] = options.rows ?? [];
	const episodeRows = options.episodeRows ?? [];
	let libraryPage = 0;
	let episodePage = 0;
	const tx: TransactionReader = {
		serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
		cacheRefreshStatus: { findUnique },
		jellyfinCache: {
			findMany: vi
				.fn()
				.mockImplementation(async () => options.libraryPages?.[libraryPage++] ?? rows),
		},
		jellyfinEpisodeCache: {
			findMany: vi
				.fn()
				.mockImplementation(async () => options.episodePages?.[episodePage++] ?? episodeRows),
		},
	};
	const transaction = vi.fn((callback: (value: TransactionReader) => Promise<unknown>) =>
		callback(tx),
	);
	const prisma: JellyfinEvidencePrisma = {
		$transaction: transaction,
		serviceInstance: tx.serviceInstance,
		cacheRefreshStatus: tx.cacheRefreshStatus,
		jellyfinCache: tx.jellyfinCache,
		jellyfinEpisodeCache: tx.jellyfinEpisodeCache,
	};
	return {
		prisma,
		findUnique,
		statusReads,
		tx,
		serviceInstance: tx.serviceInstance,
		jellyfinCache: tx.jellyfinCache,
		jellyfinEpisodeCache: tx.jellyfinEpisodeCache,
	};
}

afterEach(() => vi.restoreAllMocks());

describe("readOwnedJellyfinObservation", () => {
	it("admits current V2 lower-bound episode rows for display but never for cleanup mutation", async () => {
		const instance = makeInstance();
		const libraryRows = [libraryRow({ mediaType: "series" })];
		const parentMetadata = libraryMetadata(instance, libraryRows);
		const episodes = [episodeRow()];
		const metadata = v2PositiveOnlyEpisodeMetadata(
			instance,
			episodes,
			"jellyfin-generation-1",
			fingerprintJellyfinLibraryGenerationMetadata(JSON.parse(parentMetadata)),
		);
		const options = {
			instance,
			statuses: {
				jellyfin: {
					...status("jellyfin", parentMetadata, 1),
					generationId: "jellyfin-generation-1",
				},
				jellyfin_episode: status("jellyfin_episode", metadata, episodes.length),
			},
			rows: libraryRows,
			episodeRows: episodes,
		};
		const display = await readOwnedJellyfinObservation({
			prisma: makePrisma(options).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin_episode",
			mode: "display",
			now,
		});
		const mutation = await readOwnedJellyfinObservation({
			prisma: makePrisma(options).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin_episode",
			mode: "mutation",
			now,
		});

		expect(display).toMatchObject({
			available: true,
			rows: episodes,
			mutationAvailable: false,
			authority: null,
			providerStatus: {
				availability: "partial",
				domains: [
					expect.objectContaining({
						domain: "episode-inventory",
						availability: "current",
						valueSemantics: "lower-bound",
					}),
				],
			},
		});
		expect(mutation).toMatchObject({
			available: false,
			rows: [],
			mutationAvailable: false,
			authority: null,
		});

		const exactMetadata = episodeMetadata(
			instance,
			episodes,
			"jellyfin-generation-1",
			fingerprintJellyfinLibraryGenerationMetadata(JSON.parse(parentMetadata)),
		);
		const exactMutation = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				...options,
				statuses: {
					...options.statuses,
					jellyfin_episode: status("jellyfin_episode", exactMetadata, episodes.length),
				},
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin_episode",
			mode: "mutation",
			now,
		});
		expect(exactMutation).toMatchObject({
			available: true,
			rows: episodes,
			mutationAvailable: true,
		});
	});

	it("projects V2 library domains without making on-deck failure global", async () => {
		const instance = makeInstance();
		const rows = [libraryRow()];
		const result = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				instance,
				statuses: {
					jellyfin: {
						...status("jellyfin", v2PositiveOnlyLibraryMetadata(instance, rows), rows.length),
					},
				},
				rows,
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
		});

		expect(result).toMatchObject({
			available: true,
			rows,
			providerStatus: {
				availability: "partial",
				evidence: "positive-only",
				domains: expect.arrayContaining([
					expect.objectContaining({ domain: "library-inventory", valueSemantics: "exact" }),
					expect.objectContaining({ domain: "mapping", valueSemantics: "lower-bound" }),
					expect.objectContaining({ domain: "on-deck", valueSemantics: "unknown" }),
				]),
			},
		});
	});

	it.each(["JELLYFIN", "EMBY"] as const)(
		"admits a valid positive-only library for display but not mutation (%s)",
		async (service) => {
			const instance = makeInstance(service);
			const rows = [libraryRow()];
			const metadata = positiveOnlyLibraryMetadata(instance, rows);
			const harness = makePrisma({
				instance,
				statuses: { jellyfin: status("jellyfin", metadata, rows.length) },
				rows,
			});

			const display = await readOwnedJellyfinObservation({
				prisma: harness.prisma,
				userId: "user-1",
				instanceId: "jellyfin-1",
				cacheType: "jellyfin",
				mode: "display",
				now,
			});
			const mutation = await readOwnedJellyfinObservation({
				prisma: harness.prisma,
				userId: "user-1",
				instanceId: "jellyfin-1",
				cacheType: "jellyfin",
				mode: "mutation",
				now,
			});

			expect(display).toMatchObject({
				available: true,
				rows,
				mutationAvailable: false,
				authority: null,
				providerStatus: { availability: "partial", evidence: "positive-only" },
			});
			expect(mutation).toMatchObject({
				available: false,
				rows: [],
				mutationAvailable: false,
				authority: null,
			});
		},
	);

	it("keeps a stale positive-only library displayable as last-known without mutation authority", async () => {
		const instance = makeInstance();
		const staleAt = new Date("2026-08-18T12:00:00.000Z");
		const rows = [libraryRow()];
		const metadata = positiveOnlyLibraryMetadata(instance, rows, staleAt);
		const result = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				instance,
				statuses: {
					jellyfin: {
						...status("jellyfin", metadata, rows.length),
						lastRefreshedAt: staleAt,
						lastAttemptAt: staleAt,
					},
				},
				rows,
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
			maxAgeMs: 60 * 60 * 1000,
		});

		expect(result).toMatchObject({
			available: true,
			rows,
			mutationAvailable: false,
			authority: null,
			providerStatus: { availability: "last-known", evidence: "positive-only" },
		});
	});

	it("keeps a newer failed positive-only library displayable as last-known without mutation authority", async () => {
		const instance = makeInstance();
		const rows = [libraryRow()];
		const metadata = positiveOnlyLibraryMetadata(instance, rows);
		const result = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				instance,
				statuses: {
					jellyfin: {
						...status("jellyfin", metadata, rows.length),
						lastAttemptAt: now,
						lastAttemptResult: "error",
					},
				},
				rows,
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
		});

		expect(result).toMatchObject({
			available: true,
			rows,
			mutationAvailable: false,
			authority: null,
			providerStatus: {
				availability: "last-known",
				evidence: "positive-only",
				latestAttempt: "failed",
			},
		});
	});

	it.each(["JELLYFIN", "EMBY"] as const)(
		"reads an authoritative empty %s library",
		async (service) => {
			const instance = makeInstance(service);
			const metadata = libraryMetadata(instance, []);
			const harness = makePrisma({
				instance,
				statuses: { jellyfin: status("jellyfin", metadata, 0) },
			});

			const result = await readOwnedJellyfinObservation({
				prisma: harness.prisma,
				userId: "user-1",
				instanceId: "jellyfin-1",
				cacheType: "jellyfin",
				mode: "mutation",
				now,
			});

			expect(result).toMatchObject({
				available: true,
				service,
				cacheType: "jellyfin",
				rows: [],
				mutationAvailable: true,
				providerStatus: { availability: "current" },
			});
			expect(harness.prisma.serviceInstance.findFirst).toHaveBeenCalledWith({
				where: { id: "jellyfin-1", userId: "user-1" },
				select: {
					id: true,
					service: true,
					enabled: true,
					expectedIdentity: true,
					identityStatus: true,
					connectionGeneration: true,
					identityGeneration: true,
				},
			});
		},
	);

	it("shares current mutation authority with the in-transaction entrypoint", async () => {
		const instance = makeInstance();
		const metadata = libraryMetadata(instance, []);
		const harness = makePrisma({
			instance,
			statuses: { jellyfin: status("jellyfin", metadata, 0) },
		});
		const input = {
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin" as const,
			mode: "mutation" as const,
			now,
		};
		const publicResult = await readOwnedJellyfinObservation({ ...input, prisma: harness.prisma });
		const inTransactionResult = await readOwnedJellyfinObservationInTransaction(harness.tx, input);

		expect(publicResult?.authority).toEqual(inTransactionResult?.authority);
		expect(publicResult?.authority).toMatchObject({
			generationId: "jellyfin-generation-1",
			itemCount: 0,
			connectionGeneration: 1,
			identityGeneration: 1,
		});
		expect(publicResult?.authority).not.toBeNull();
		expect(JSON.stringify(publicResult?.authority)).not.toMatch(
			/scopeKey|title|username|https?:|credential|in_progress|error/i,
		);
		expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
	});

	it("changes hashed authority for status, receipt, and semantic row changes", async () => {
		const instance = makeInstance();
		const baselineMetadata = libraryMetadata(instance, []);
		const baseline = await readOwnedJellyfinObservation({
			prisma: makePrisma({ statuses: { jellyfin: status("jellyfin", baselineMetadata, 0) } })
				.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
			now,
		});
		const changedRows = [libraryRow({ title: "Changed" })];
		const changedRowsResult = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				statuses: { jellyfin: status("jellyfin", libraryMetadata(instance, changedRows), 1) },
				rows: changedRows,
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
			now,
		});
		const changedAt = new Date("2026-08-20T12:30:00.000Z");
		const changedStatusResult = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				statuses: {
					jellyfin: {
						...status("jellyfin", libraryMetadata(instance, [], changedAt), 0),
						lastRefreshedAt: changedAt,
						lastAttemptAt: changedAt,
					},
				},
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
			now,
		});
		const baselineAuthority = baseline?.authority;
		const changedRowsAuthority = changedRowsResult?.authority;
		const changedStatusAuthority = changedStatusResult?.authority;

		expect(baselineAuthority).not.toBeNull();
		expect(changedRowsAuthority).not.toBeNull();
		expect(changedStatusAuthority).not.toBeNull();
		expect(changedRowsAuthority?.rowFingerprint).not.toBe(baselineAuthority?.rowFingerprint);
		expect(changedStatusAuthority?.statusFingerprint).not.toBe(
			baselineAuthority?.statusFingerprint,
		);
		expect(changedStatusAuthority?.rowFingerprint).toBe(baselineAuthority?.rowFingerprint);

		const display = await readOwnedJellyfinObservation({
			prisma: makePrisma({ statuses: { jellyfin: status("jellyfin", baselineMetadata, 0) } })
				.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
		});
		expect(display?.authority).toBeNull();
	});

	it("scopes every status and row page read to the authenticated owner", async () => {
		const instance = makeInstance();
		const metadata = libraryMetadata(instance, []);
		const harness = makePrisma({
			instance,
			statuses: { jellyfin: status("jellyfin", metadata, 0) },
		});
		await readOwnedJellyfinObservation({
			prisma: harness.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
		});
		expect(harness.findUnique).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" },
					instance: { userId: "user-1" },
				},
			}),
		);
		expect(harness.jellyfinCache.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { instanceId: "jellyfin-1", instance: { userId: "user-1" } },
			}),
		);
	});

	it("projects the durable in-progress marker without exposing its token", async () => {
		const attemptToken = "11111111-1111-4111-8111-111111111111";
		const instance = makeInstance();
		const publicationAt = new Date("2026-08-20T12:00:00.000Z");
		const metadata = libraryMetadata(instance, [libraryRow()], publicationAt);
		const publication = {
			...status("jellyfin", metadata, 1),
			lastAttemptAt: new Date("2026-08-20T12:30:00.000Z"),
			lastAttemptResult: `in_progress:${attemptToken}`,
		};
		const display = await readOwnedJellyfinObservation({
			prisma: makePrisma({ instance, statuses: { jellyfin: publication }, rows: [libraryRow()] })
				.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
		});
		const mutation = await readOwnedJellyfinObservation({
			prisma: makePrisma({ instance, statuses: { jellyfin: publication }, rows: [libraryRow()] })
				.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
			now,
		});
		expect(display).toMatchObject({
			available: true,
			rows: [libraryRow()],
			mutationAvailable: false,
			providerStatus: { availability: "last-known", latestAttempt: "running" },
		});
		expect(mutation).toMatchObject({ available: false, rows: [], mutationAvailable: false });
		expect(JSON.stringify({ display, mutation })).not.toContain(attemptToken);
		const malformed = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				instance,
				statuses: { jellyfin: { ...publication, lastAttemptResult: "in_progress:not-a-uuid" } },
				rows: [libraryRow()],
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
			now,
		});
		expect(malformed).toMatchObject({
			available: false,
			metadata: null,
			rows: [],
			mutationAvailable: false,
		});
	});

	it("returns null for missing, unowned, or wrong-service instances", async () => {
		const missing = makePrisma({ instance: null });
		await expect(
			readOwnedJellyfinObservation({
				prisma: missing.prisma,
				userId: "user-1",
				instanceId: "jellyfin-1",
				cacheType: "jellyfin",
				mode: "display",
			}),
		).resolves.toBeNull();

		const wrong = makePrisma({ instance: { ...makeInstance(), service: "PLEX" } });
		await expect(
			readOwnedJellyfinObservation({
				prisma: wrong.prisma,
				userId: "user-1",
				instanceId: "jellyfin-1",
				cacheType: "jellyfin",
				mode: "display",
			}),
		).resolves.toBeNull();
	});

	it.each([
		["disabled", { enabled: false }],
		["unverified", { identityStatus: "UNVERIFIED" }],
		["changed", { identityStatus: "MISMATCH" }],
		["rotated connection", { connectionGeneration: 2 }],
		["rotated identity", { identityGeneration: 2 }],
	] as const)("hides %s identity evidence", async (_label, changes) => {
		const instance = { ...makeInstance(), ...changes };
		const metadata = libraryMetadata(makeInstance());
		const result = await readOwnedJellyfinObservation({
			prisma: makePrisma({ instance, statuses: { jellyfin: status("jellyfin", metadata, 0) } })
				.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
			now,
		});
		expect(result).toMatchObject({ available: false, rows: [], mutationAvailable: false });
	});

	it.each(["running", "failed"] as const)(
		"keeps a first %s attempt unavailable",
		async (attempt) => {
			const instance = makeInstance();
			const metadata = libraryMetadata(instance);
			const publication = status("jellyfin", metadata, 1);
			const result = await readOwnedJellyfinObservation({
				prisma: makePrisma({
					instance,
					statuses: {
						jellyfin: {
							...publication,
							lastResult: "error",
							generationId: null,
							generationMetadata: null,
							itemCount: 0,
							lastAttemptAt: now,
							lastAttemptResult:
								attempt === "running"
									? "in_progress:22222222-2222-4222-8222-222222222222"
									: "error",
						},
					},
				}).prisma,
				userId: "user-1",
				instanceId: "jellyfin-1",
				cacheType: "jellyfin",
				mode: "mutation",
				now,
			});
			expect(result).toMatchObject({ available: false, rows: [], mutationAvailable: false });
		},
	);

	it("keeps stale display evidence last-known but removes mutation rows", async () => {
		const instance = makeInstance();
		const staleAt = new Date("2026-08-18T12:00:00.000Z");
		const metadata = libraryMetadata(instance, [libraryRow()], staleAt);
		const staleStatus = {
			...status("jellyfin", metadata, 1),
			lastRefreshedAt: staleAt,
			lastAttemptAt: staleAt,
		};
		const harness = makePrisma({
			instance,
			statuses: { jellyfin: staleStatus },
			rows: [libraryRow()],
		});

		const display = await readOwnedJellyfinObservation({
			prisma: harness.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
			maxAgeMs: 60 * 60 * 1000,
		});
		const mutation = await readOwnedJellyfinObservation({
			prisma: harness.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
			now,
			maxAgeMs: 60 * 60 * 1000,
		});

		expect(display).toMatchObject({
			available: true,
			mutationAvailable: false,
			rows: [libraryRow()],
		});
		expect(mutation).toMatchObject({ available: false, mutationAvailable: false, rows: [] });
	});

	it("does not downgrade malformed modern metadata, while true legacy display remains last-known", async () => {
		const instance = makeInstance();
		const rows = [libraryRow()];
		const malformed = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				instance,
				statuses: { jellyfin: { ...status("jellyfin", "not-v1", 1) } },
				rows,
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
		});
		expect(malformed).toMatchObject({ available: false, rows: [], mutationAvailable: false });

		const legacyRows = [libraryRow({ connectionGeneration: null, identityGeneration: null })];
		const legacy = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				instance,
				statuses: {
					jellyfin: {
						...status("jellyfin", "", 1),
						generationId: null,
						generationMetadata: null,
						connectionGeneration: null,
						identityGeneration: null,
						lastAttemptAt: null,
						lastAttemptResult: null,
						lastAttemptErrorMessage: null,
					},
				},
				rows: legacyRows,
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
		});
		expect(legacy).toMatchObject({
			available: true,
			rows: legacyRows,
			mutationAvailable: false,
			providerStatus: { availability: "last-known" },
		});
	});

	it.each(["jellyfin", "jellyfin_episode"] as const)(
		"accepts the exact-current pre-receipt %s shape for display only",
		async (cacheType) => {
			const instance = makeInstance();
			const rows = cacheType === "jellyfin" ? [libraryRow()] : [];
			const episodeRows = cacheType === "jellyfin_episode" ? [episodeRow()] : [];
			const legacy = {
				...status(cacheType, "", 1),
				generationId: null,
				generationMetadata: null,
			};
			const display = await readOwnedJellyfinObservation({
				prisma: makePrisma({ instance, statuses: { [cacheType]: legacy }, rows, episodeRows })
					.prisma,
				userId: "user-1",
				instanceId: "jellyfin-1",
				cacheType,
				mode: "display",
				now,
			});
			const mutation = await readOwnedJellyfinObservation({
				prisma: makePrisma({ instance, statuses: { [cacheType]: legacy }, rows, episodeRows })
					.prisma,
				userId: "user-1",
				instanceId: "jellyfin-1",
				cacheType,
				mode: "mutation",
				now,
			});

			expect(display).toMatchObject({
				available: true,
				rows: cacheType === "jellyfin" ? rows : episodeRows,
				mutationAvailable: false,
				providerStatus: { availability: "last-known" },
			});
			expect(mutation).toMatchObject({
				available: false,
				metadata: null,
				rows: [],
				mutationAvailable: false,
			});
		},
	);

	it("rejects a pre-receipt display whose status count or row shape is inconsistent", async () => {
		const instance = makeInstance();
		const legacy = {
			...status("jellyfin", "", 2),
			generationId: null,
			generationMetadata: null,
		};
		const countMismatch = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				instance,
				statuses: { jellyfin: legacy },
				rows: [libraryRow()],
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
		});
		const malformedRow = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				instance,
				statuses: { jellyfin: { ...legacy, itemCount: 1 } },
				rows: [libraryRow({ watchedByUsers: "not-json" })],
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
		});

		for (const result of [countMismatch, malformedRow]) {
			expect(result).toMatchObject({
				available: false,
				metadata: null,
				rows: [],
				mutationAvailable: false,
			});
		}
	});

	it("redacts receipt metadata when display evidence is inconsistent", async () => {
		const instance = makeInstance();
		const metadata = libraryMetadata(instance, [libraryRow()]);
		const result = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				instance,
				statuses: { jellyfin: status("jellyfin", metadata, 1) },
				rows: [libraryRow({ tmdbId: 999 })],
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
		});

		expect(result).toMatchObject({ available: false, metadata: null, rows: [] });
		expect(JSON.stringify(result)).not.toContain('"scopeKey":"library"');
	});

	it("rejects episode parent binding in mutation mode", async () => {
		const instance = makeInstance();
		const parentMetadata = libraryMetadata(instance, []);
		const episodes = [episodeRow()];
		const episodeProvider = "jellyfin_episode" as const;
		const episodeMetadata = encodeJellyfinEpisodeGenerationMetadata({
			version: 1,
			provider: "jellyfin",
			cacheType: episodeProvider,
			publicationLevel: "authoritative",
			completeness: "complete",
			canonicalizationVersion: 1,
			itemCount: 1,
			connectionGeneration: 1,
			identityGeneration: 1,
			parentLibraryGenerationId: "wrong-parent",
			parentLibraryMetadataFingerprint: fingerprintJellyfinLibraryGenerationMetadata(
				JSON.parse(parentMetadata),
			),
			contentFingerprint: fingerprintJellyfinEpisodeRows(episodes),
			coverageReceipt: receipt(episodeProvider, 1),
		});
		const harness = makePrisma({
			instance,
			statuses: {
				jellyfin: status("jellyfin", parentMetadata, 0),
				jellyfin_episode: status("jellyfin_episode", episodeMetadata, 1),
			},
			episodeRows: episodes,
		});

		const result = await readOwnedJellyfinObservation({
			prisma: harness.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin_episode",
			mode: "mutation",
			now,
		});

		expect(result).toMatchObject({ available: false, mutationAvailable: false, rows: [] });
	});

	it("requires a current episode parent for mutation but labels moved-parent display last-known", async () => {
		const instance = makeInstance();
		const parentRows = [libraryRow()];
		const parentMetadata = libraryMetadata(instance, parentRows);
		const episodes = [episodeRow()];
		const metadata = episodeMetadata(
			instance,
			episodes,
			"old-parent",
			fingerprintJellyfinLibraryGenerationMetadata(JSON.parse(parentMetadata)),
		);
		const failedEpisode = {
			...status("jellyfin_episode", metadata, 1),
			lastAttemptAt: now,
			lastAttemptResult: "error",
		};
		const statuses = {
			jellyfin: { ...status("jellyfin", parentMetadata, 1), generationId: "new-parent" },
			jellyfin_episode: failedEpisode,
		};
		const display = await readOwnedJellyfinObservation({
			prisma: makePrisma({ instance, statuses, rows: parentRows, episodeRows: episodes }).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin_episode",
			mode: "display",
			now,
		});
		const mutation = await readOwnedJellyfinObservation({
			prisma: makePrisma({ instance, statuses, rows: parentRows, episodeRows: episodes }).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin_episode",
			mode: "mutation",
			now,
		});
		expect(display).toMatchObject({
			available: true,
			rows: episodes,
			mutationAvailable: false,
			providerStatus: { availability: "last-known" },
		});
		expect(display?.providerStatus.reasonCodes).toEqual(
			expect.arrayContaining(["refresh-failed", "publication-superseded"]),
		);
		expect(mutation).toMatchObject({ available: false, rows: [], mutationAvailable: false });
	});

	it("rejects episode drift on the final parent-validation read in both modes", async () => {
		const instance = makeInstance();
		const parentRows = [libraryRow()];
		const parentMetadata = libraryMetadata(instance, parentRows);
		const episodes = [episodeRow()];
		const metadata = episodeMetadata(
			instance,
			episodes,
			"jellyfin-generation-1",
			fingerprintJellyfinLibraryGenerationMetadata(JSON.parse(parentMetadata)),
		);
		const initialEpisodeStatus = status("jellyfin_episode", metadata, 1);
		const driftedEpisodeStatus = {
			...initialEpisodeStatus,
			lastAttemptAt: now,
			lastAttemptResult: "error",
		};
		const parentStatus = status("jellyfin", parentMetadata, 1);

		for (const mode of ["display", "mutation"] as const) {
			const result = await readOwnedJellyfinObservation({
				prisma: makePrisma({
					instance,
					statuses: { jellyfin: parentStatus, jellyfin_episode: initialEpisodeStatus },
					statusSequences: {
						jellyfin_episode: [initialEpisodeStatus, initialEpisodeStatus, driftedEpisodeStatus],
					},
					rows: parentRows,
					episodeRows: episodes,
				}).prisma,
				userId: "user-1",
				instanceId: "jellyfin-1",
				cacheType: "jellyfin_episode",
				mode,
				now,
			});

			expect(result).toMatchObject({
				available: false,
				metadata: null,
				rows: [],
				mutationAvailable: false,
				providerStatus: { reasonCodes: ["rows-inconsistent"] },
			});
		}
	});

	it("keeps receipt-valid newer failed attempts last-known for display only", async () => {
		const instance = makeInstance();
		const rows = [libraryRow()];
		const metadata = libraryMetadata(instance, rows);
		const publication = status("jellyfin", metadata, 1);
		const failed = { ...publication, lastAttemptAt: now, lastAttemptResult: "error" };
		const display = await readOwnedJellyfinObservation({
			prisma: makePrisma({ instance, statuses: { jellyfin: failed }, rows }).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
		});
		const mutation = await readOwnedJellyfinObservation({
			prisma: makePrisma({ instance, statuses: { jellyfin: failed }, rows }).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
			now,
		});
		expect(display).toMatchObject({
			available: true,
			rows,
			mutationAvailable: false,
			providerStatus: { availability: "last-known", latestAttempt: "failed" },
		});
		expect(mutation).toMatchObject({ available: false, rows: [], mutationAvailable: false });
	});

	it("rejects count, fingerprint, generation, and second-status drift", async () => {
		const instance = makeInstance();
		const metadata = libraryMetadata(instance);
		const mismatched = makePrisma({
			instance,
			statuses: { jellyfin: status("jellyfin", metadata, 1) },
			rows: [libraryRow({ tmdbId: 999 })],
		});
		const result = await readOwnedJellyfinObservation({
			prisma: mismatched.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
			now,
		});
		expect(result).toMatchObject({ available: false, rows: [], mutationAvailable: false });

		const changed = makePrisma({
			instance,
			statuses: { jellyfin: status("jellyfin", metadata, 1) },
			rows: [libraryRow()],
			secondStatus: { ...status("jellyfin", metadata, 1), generationId: "new-generation" },
		});
		const changedResult = await readOwnedJellyfinObservation({
			prisma: changed.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
		});
		expect(changedResult).toMatchObject({ available: false, rows: [], mutationAvailable: false });
	});

	it.each(["JELLYFIN", "EMBY"] as const)("validates %s episode parent parity", async (service) => {
		const instance = makeInstance(service);
		const libraryRows = [libraryRow()];
		const parentMetadata = libraryMetadata(instance, libraryRows);
		const parentGenerationId = "jellyfin-generation-1";
		const episodes = [episodeRow()];
		const metadata = episodeMetadata(
			instance,
			episodes,
			parentGenerationId,
			fingerprintJellyfinLibraryGenerationMetadata(JSON.parse(parentMetadata)),
		);
		const result = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				instance,
				statuses: {
					jellyfin: { ...status("jellyfin", parentMetadata, 1), generationId: parentGenerationId },
					jellyfin_episode: {
						...status("jellyfin_episode", metadata, 1),
						generationId: "episode-generation-1",
					},
				},
				rows: libraryRows,
				episodeRows: episodes,
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin_episode",
			mode: "mutation",
			now,
		});
		expect(result).toMatchObject({
			available: true,
			service,
			rows: episodes,
			mutationAvailable: true,
		});
	});

	it("keeps V2 display across parent refreshes without retaining mutation authority", async () => {
		const instance = makeInstance();
		const parentRows = [libraryRow()];
		const parentMetadata = libraryMetadata(instance, parentRows);
		const parentDependency = fingerprintJellyfinEpisodeParentDependency(
			instance.id,
			parentMetadata,
			parentRows,
		);
		expect(parentDependency).toMatch(/^[a-f0-9]{64}$/);
		const episodes = [episodeRow()];
		const v2Metadata = encodeJellyfinEpisodeGenerationMetadata({
			...JSON.parse(
				episodeMetadata(
					instance,
					episodes,
					"old-parent",
					fingerprintJellyfinLibraryGenerationMetadata(JSON.parse(parentMetadata)),
				),
			),
			version: 2,
			parentLibraryDependencyFingerprint: parentDependency,
		});
		const statuses = {
			jellyfin: { ...status("jellyfin", parentMetadata, 1), generationId: "new-parent" },
			jellyfin_episode: status("jellyfin_episode", v2Metadata, 1),
		};
		for (const mode of ["display", "mutation"] as const) {
			const result = await readOwnedJellyfinObservation({
				prisma: makePrisma({ instance, statuses, rows: parentRows, episodeRows: episodes }).prisma,
				userId: "user-1",
				instanceId: "jellyfin-1",
				cacheType: "jellyfin_episode",
				mode,
				now,
			});
			expect(result).toMatchObject(
				mode === "display"
					? { available: true, rows: episodes, mutationAvailable: false }
					: { available: false, rows: [], mutationAvailable: false, authority: null },
			);
		}

		const changedParentRows = [
			libraryRow({ mediaType: "series", libraryId: "library-2", jellyfinId: "series-1" }),
		];
		const changedParentMetadata = libraryMetadata(instance, changedParentRows);
		for (const mode of ["display", "mutation"] as const) {
			const result = await readOwnedJellyfinObservation({
				prisma: makePrisma({
					instance,
					statuses: {
						jellyfin: {
							...status("jellyfin", changedParentMetadata, 1),
							generationId: "newer-parent",
						},
						jellyfin_episode: status("jellyfin_episode", v2Metadata, 1),
					},
					rows: changedParentRows,
					episodeRows: episodes,
				}).prisma,
				userId: "user-1",
				instanceId: "jellyfin-1",
				cacheType: "jellyfin_episode",
				mode,
				now,
			});
			expect(result).toMatchObject(
				mode === "display"
					? { available: true, rows: episodes, mutationAvailable: false }
					: { available: false, rows: [], mutationAvailable: false },
			);
		}
	});

	it.each(
		(["JELLYFIN", "EMBY"] as const).flatMap((service) =>
			(["standalone", "transaction"] as const).flatMap((entrypoint) =>
				(["watch", "receipt-only", "same-generation-watch"] as const).map((change) => ({
					service,
					entrypoint,
					change,
				})),
			),
		),
	)(
		"fences V2 $service mutation after $change via $entrypoint until episode republication",
		async ({ service, entrypoint, change }) => {
			const instance = makeInstance(service);
			const originalRows = [libraryRow({ mediaType: "series", jellyfinId: "series-1" })];
			const originalParent = libraryMetadata(instance, originalRows);
			const originalEpisodes = [
				episodeRow({ watched: false, watchedByUsers: "[]", lastWatchedAt: null }),
			];
			const episodeProvider = service === "EMBY" ? "emby_episode" : "jellyfin_episode";
			const encodeV2 = (
				parent: string,
				parentId: string,
				parentRows: FixtureLibraryRow[],
				episodes: JellyfinEpisodeRow[],
				at: Date,
			) =>
				encodeJellyfinEpisodeGenerationMetadata({
					...JSON.parse(
						episodeMetadata(
							instance,
							episodes,
							parentId,
							fingerprintJellyfinLibraryGenerationMetadata(JSON.parse(parent)),
						),
					),
					version: 2,
					parentLibraryDependencyFingerprint: fingerprintJellyfinEpisodeParentDependency(
						instance.id,
						parent,
						parentRows,
					),
					coverageReceipt: receipt(episodeProvider, episodes.length, at),
				});
			const originalMetadata = encodeV2(
				originalParent,
				"parent-original",
				originalRows,
				originalEpisodes,
				observedAt,
			);
			const read = async (
				parent: string,
				parentId: string,
				parentRows: FixtureLibraryRow[],
				parentAt: Date,
				metadata = originalMetadata,
				episodes = originalEpisodes,
				episodeAt = observedAt,
				mode: "display" | "mutation" = "mutation",
			) => {
				const harness = makePrisma({
					instance,
					statuses: {
						jellyfin: {
							...status("jellyfin", parent, parentRows.length),
							generationId: parentId,
							lastRefreshedAt: parentAt,
							lastAttemptAt: parentAt,
						},
						jellyfin_episode: {
							...status("jellyfin_episode", metadata, episodes.length),
							lastRefreshedAt: episodeAt,
							lastAttemptAt: episodeAt,
						},
					},
					rows: parentRows,
					episodeRows: episodes,
				});
				const input = {
					userId: instance.userId,
					instanceId: instance.id,
					cacheType: "jellyfin_episode" as const,
					mode,
					now,
				};
				return entrypoint === "transaction"
					? readOwnedJellyfinObservationInTransaction(harness.tx, input)
					: readOwnedJellyfinObservation({ ...input, prisma: harness.prisma });
			};
			expect(await read(originalParent, "parent-original", originalRows, observedAt)).toMatchObject(
				{
					available: true,
					mutationAvailable: true,
					rows: originalEpisodes,
				},
			);
			const parentAt = new Date("2026-08-20T12:15:00.000Z");
			const watchChanged = change !== "receipt-only";
			const parentId = change === "same-generation-watch" ? "parent-original" : "parent-new";
			const newerRows = originalRows.map((row) => ({
				...row,
				...(watchChanged ? { watchCount: 2, lastWatchedAt: parentAt } : {}),
			}));
			const newerParent = libraryMetadata(instance, newerRows, parentAt);
			expect(fingerprintJellyfinEpisodeParentDependency(instance.id, newerParent, newerRows)).toBe(
				fingerprintJellyfinEpisodeParentDependency(instance.id, originalParent, originalRows),
			);
			expect(await read(newerParent, parentId, newerRows, parentAt)).toMatchObject({
				available: false,
				mutationAvailable: false,
				rows: [],
				authority: null,
			});
			expect(
				await read(
					newerParent,
					parentId,
					newerRows,
					parentAt,
					originalMetadata,
					originalEpisodes,
					observedAt,
					"display",
				),
			).toMatchObject({
				available: true,
				rows: originalEpisodes,
				mutationAvailable: false,
				providerStatus: { availability: "current" },
			});
			const episodeAt = new Date("2026-08-20T12:20:00.000Z");
			const freshEpisodes = [
				episodeRow({
					watched: watchChanged,
					watchedByUsers: watchChanged ? '["user-1"]' : "[]",
					lastWatchedAt: watchChanged ? parentAt : null,
				}),
			];
			const freshMetadata = encodeV2(newerParent, parentId, newerRows, freshEpisodes, episodeAt);
			expect(
				await read(
					newerParent,
					parentId,
					newerRows,
					parentAt,
					freshMetadata,
					freshEpisodes,
					episodeAt,
				),
			).toMatchObject({
				available: true,
				mutationAvailable: true,
				rows: freshEpisodes,
			});
		},
	);

	it("keeps a valid episode publication displayable after the parent moves", async () => {
		const instance = makeInstance();
		const oldParent = libraryMetadata(instance);
		const episodes = [episodeRow()];
		const metadata = episodeMetadata(
			instance,
			episodes,
			"old-parent",
			fingerprintJellyfinLibraryGenerationMetadata(JSON.parse(oldParent)),
		);
		const result = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				instance,
				statuses: {
					jellyfin: { ...status("jellyfin", oldParent, 1), generationId: "new-parent" },
					jellyfin_episode: status("jellyfin_episode", metadata, 1),
				},
				episodeRows: episodes,
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin_episode",
			mode: "display",
			now,
		});
		expect(result).toMatchObject({ available: true, rows: episodes, mutationAvailable: false });
	});

	it.each([
		["blank ID", { jellyfinId: "" }],
		["negative coordinate", { seasonNumber: -1 }],
		["null generation", { connectionGeneration: null }],
	] as const)("rejects episode %s before mutation", async (_label, changes) => {
		const instance = makeInstance();
		const rows = [episodeRow(changes)];
		const parentMetadata = libraryMetadata(instance);
		const metadata = episodeMetadata(
			instance,
			rows,
			"parent-1",
			fingerprintJellyfinLibraryGenerationMetadata(JSON.parse(parentMetadata)),
		);
		const result = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				instance,
				statuses: {
					jellyfin: { ...status("jellyfin", parentMetadata, 1), generationId: "parent-1" },
					jellyfin_episode: status("jellyfin_episode", metadata, 1),
				},
				episodeRows: rows,
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin_episode",
			mode: "mutation",
			now,
		});
		expect(result).toMatchObject({ available: false, rows: [], mutationAvailable: false });
	});

	it.each([
		["missing", (): string => ""],
		["extra key", (): string => `${libraryMetadata()}x`],
		[
			"wrong provider",
			(): string => libraryMetadata().replace('"provider":"jellyfin"', '"provider":"emby"'),
		],
		[
			"wrong cache type",
			(): string =>
				libraryMetadata().replace('"cacheType":"jellyfin"', '"cacheType":"jellyfin_episode"'),
		],
		[
			"receipt time",
			(): string => libraryMetadata().replace(observedAt.toISOString(), "2026-08-20T12:01:00.000Z"),
		],
		[
			"receipt count",
			(): string =>
				libraryMetadata().replace(
					'"publishedCanonicalEntities":1',
					'"publishedCanonicalEntities":2',
				),
		],
	] as const)("rejects %s metadata in mutation mode", async (_label, raw) => {
		const metadata = raw();
		const result = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				statuses: { jellyfin: status("jellyfin", metadata, 1) },
				rows: [libraryRow()],
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
			now,
		});
		expect(result).toMatchObject({ available: false, rows: [], mutationAvailable: false });
	});

	it.each([
		["malformed watchedByUsers", { watchedByUsers: "not-json" }],
		["non-finite user rating NaN", { userRating: Number.NaN }],
		["non-finite user rating positive infinity", { userRating: Number.POSITIVE_INFINITY }],
		["non-finite user rating negative infinity", { userRating: Number.NEGATIVE_INFINITY }],
		["null connection generation", { connectionGeneration: null }],
		["mixed identity generation", { identityGeneration: null }],
		["invalid last watched", { lastWatchedAt: new Date(Number.NaN) }],
	] as const)("rejects %s strict rows", async (_label, changes) => {
		const rows = [libraryRow(changes)];
		const metadata = libraryMetadata(makeInstance(), [libraryRow()]);
		const result = await readOwnedJellyfinObservation({
			prisma: makePrisma({ statuses: { jellyfin: status("jellyfin", metadata, 1) }, rows }).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
			now,
		});
		expect(result).toMatchObject({ available: false, rows: [], mutationAvailable: false });
	});

	it("returns safe legacy rows only for display and hides ambiguous provenance", async () => {
		const legacy = libraryRow({ connectionGeneration: null, identityGeneration: null });
		const display = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				statuses: {
					jellyfin: {
						...status("jellyfin", "", 1),
						generationId: null,
						generationMetadata: null,
						connectionGeneration: null,
						identityGeneration: null,
						lastAttemptAt: null,
						lastAttemptResult: null,
						lastAttemptErrorMessage: null,
					},
				},
				rows: [legacy],
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
		});
		expect(display).toMatchObject({
			available: true,
			rows: [legacy],
			mutationAvailable: false,
			providerStatus: { availability: "last-known" },
		});

		const mixed = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				statuses: { jellyfin: status("jellyfin", "invalid", 2) },
				rows: [legacy, libraryRow({ id: "library-row-2" })],
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
			now,
		});
		expect(mixed).toMatchObject({ rows: [], mutationAvailable: false });
	});

	it("retries recognized serialization conflicts and returns bounded fallback", async () => {
		const instance = makeInstance();
		const metadata = libraryMetadata(instance, []);
		const tx = makePrisma({ instance, statuses: { jellyfin: status("jellyfin", metadata, 0) } });
		const transaction = tx.prisma.$transaction as ReturnType<typeof vi.fn>;
		transaction
			.mockRejectedValueOnce(Object.assign(new Error("serialization failure"), { code: "P2034" }))
			.mockRejectedValueOnce(Object.assign(new Error("serialization failure"), { code: "P2034" }))
			.mockRejectedValueOnce(Object.assign(new Error("serialization failure"), { code: "P2034" }));

		const result = await readOwnedJellyfinObservation({
			prisma: tx.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
		});

		expect(transaction).toHaveBeenCalledTimes(3);
		expect(result).toMatchObject({ available: false, rows: [], mutationAvailable: false });
	});

	it("recognizes nested originalCode serialization conflicts and succeeds after retry", async () => {
		const instance = makeInstance();
		const metadata = libraryMetadata(instance, []);
		const harness = makePrisma({
			instance,
			statuses: { jellyfin: status("jellyfin", metadata, 0) },
		});
		const transaction = harness.prisma.$transaction as ReturnType<typeof vi.fn>;
		transaction
			.mockRejectedValueOnce({ meta: { driverAdapterError: { originalCode: "40001" } } })
			.mockImplementationOnce((callback: (tx: TransactionReader) => Promise<unknown>) =>
				callback(harness.tx),
			);
		const result = await readOwnedJellyfinObservation({
			prisma: harness.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
			now,
		});
		expect(transaction).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({ available: true, mutationAvailable: true });
	});

	it("traverses deterministic library pages and rejects a repeated cursor", async () => {
		const firstPage = Array.from({ length: 500 }, (_, index) =>
			libraryRow({ id: `library-row-${String(index).padStart(4, "0")}` }),
		);
		const finalRow = libraryRow({ id: "library-row-0500" });
		const allRows = [...firstPage, finalRow];
		const metadata = libraryMetadata(makeInstance(), allRows);
		const multiPage = makePrisma({
			statuses: { jellyfin: status("jellyfin", metadata, allRows.length) },
			libraryPages: [firstPage, [finalRow]],
		});
		const result = await readOwnedJellyfinObservation({
			prisma: multiPage.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
			now,
		});
		expect(result).toMatchObject({ available: true, mutationAvailable: true });

		const repeated = makePrisma({
			statuses: { jellyfin: status("jellyfin", metadata, allRows.length) },
			libraryPages: [firstPage, firstPage],
		});
		const repeatedResult = await readOwnedJellyfinObservation({
			prisma: repeated.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
			now,
		});
		expect(repeatedResult).toMatchObject({ available: false, rows: [], mutationAvailable: false });

		const nonIncreasing = makePrisma({
			statuses: { jellyfin: status("jellyfin", metadata, 2) },
			libraryPages: [[libraryRow({ id: "z" }), libraryRow({ id: "a" })]],
		});
		const nonIncreasingResult = await readOwnedJellyfinObservation({
			prisma: nonIncreasing.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
			now,
		});
		expect(nonIncreasingResult).toMatchObject({
			available: false,
			rows: [],
			mutationAvailable: false,
			providerStatus: { reasonCodes: ["rows-inconsistent"] },
		});
	});

	it("rejects a bounded row-cap overflow and non-retryable transaction failure", async () => {
		const tooManyRows = Array.from({ length: 100_001 }, (_, index) =>
			libraryRow({ id: `row-${index}` }),
		);
		const overflow = makePrisma({ libraryPages: [tooManyRows] });
		const overflowResult = await readOwnedJellyfinObservation({
			prisma: overflow.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
		});
		expect(overflowResult).toMatchObject({ available: false, rows: [], mutationAvailable: false });

		const failure = makePrisma({});
		(failure.prisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error("private upstream detail"),
		);
		const failedResult = await readOwnedJellyfinObservation({
			prisma: failure.prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "display",
		});
		expect(failedResult).toMatchObject({ available: false, rows: [], mutationAvailable: false });
		expect(JSON.stringify(failedResult)).not.toContain("private upstream detail");
	});

	it("rejects status identity/cache mismatches without decoded metadata", async () => {
		const instance = makeInstance();
		const metadata = libraryMetadata(instance, []);
		const result = await readOwnedJellyfinObservation({
			prisma: makePrisma({
				instance,
				statuses: {
					jellyfin: { ...status("jellyfin", metadata, 0), instanceId: "other", cacheType: "other" },
				},
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin",
			mode: "mutation",
			now,
		});
		expect(result).toMatchObject({
			available: false,
			metadata: null,
			rows: [],
			mutationAvailable: false,
		});
	});
});

describe("V3 catalog-compatible episode reader", () => {
	const originalRows = [libraryRow({ mediaType: "series", jellyfinId: "series-1" })];
	const episodes = [episodeRow()];
	function parentMetadata(rows: FixtureLibraryRow[], scopeUser = "user-1") {
		const metadata = JSON.parse(v2PositiveOnlyLibraryMetadata(makeInstance(), rows));
		for (const domain of metadata.coverageReceipt.domains) {
			for (const unit of domain.units)
				unit.scopeKey = `user:${scopeUser}/library:library-1/${domain.domain === "library-inventory" ? "inventory" : domain.domain}`;
		}
		return encodeJellyfinLibraryGenerationMetadata(metadata);
	}
	function v3Metadata() {
		const original = parentMetadata(originalRows);
		return JSON.stringify({
			...JSON.parse(
				v2PositiveOnlyEpisodeMetadata(
					makeInstance(),
					episodes,
					"original-parent",
					fingerprintJellyfinLibraryGenerationMetadata(JSON.parse(original)),
				),
			),
			version: 3,
			parentLibraryDependencyFingerprint: fingerprintJellyfinEpisodeParentDependency(
				"jellyfin-1",
				original,
				originalRows,
			),
			catalogProvenance: {
				version: 3,
				scopes: [{ userId: "user-1", libraryId: "library-1" }],
				bindings: [{ libraryId: "library-1", seriesId: "series-1", tmdbId: 42 }],
			},
		});
	}
	async function read(
		rows: FixtureLibraryRow[],
		mode: "display" | "mutation" = "display",
		scopeUser = "user-1",
		stale = false,
	) {
		rows = [...rows].sort((a, b) => a.id.localeCompare(b.id));
		const parent = status("jellyfin", parentMetadata(rows, scopeUser), rows.length);
		parent.generationId = "current-parent";
		if (stale) {
			parent.lastAttemptAt = now;
			parent.lastAttemptResult = "error";
			parent.lastAttemptErrorMessage = "provider-unavailable";
		}
		return readOwnedJellyfinObservation({
			prisma: makePrisma({
				rows,
				episodeRows: episodes,
				statuses: {
					jellyfin: parent,
					jellyfin_episode: status("jellyfin_episode", v3Metadata(), episodes.length),
				},
			}).prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin_episode",
			mode,
			now,
		});
	}
	it("retains original positive observations across an unrelated catalog addition", async () => {
		const rows = [
			...originalRows,
			libraryRow({ id: "added", mediaType: "series", jellyfinId: "series-2", tmdbId: 84 }),
		];
		const result = await read(rows);
		expect(result).toMatchObject({
			available: true,
			rows: episodes,
			mutationAvailable: false,
			authority: null,
			providerStatus: { evidence: "positive-only", availability: "partial" },
		});
		expect(result?.metadata).toMatchObject({
			version: 3,
			parentLibraryGenerationId: "original-parent",
			catalogProvenance: {
				bindings: [{ libraryId: "library-1", seriesId: "series-1", tmdbId: 42 }],
			},
		});
	});
	it("keeps compatible failed-parent observations labelled last-known", async () => {
		expect(await read(originalRows, "display", "user-1", true)).toMatchObject({
			available: true,
			rows: episodes,
			mutationAvailable: false,
			providerStatus: { availability: "last-known", evidence: "positive-only" },
		});
	});
	it.each([
		["remap", [libraryRow({ mediaType: "series", jellyfinId: "series-1", tmdbId: 84 })]],
		["removal", [libraryRow({ mediaType: "series", jellyfinId: "series-2", tmdbId: 84 })]],
		[
			"library move",
			[libraryRow({ mediaType: "series", jellyfinId: "series-1", libraryId: "library-2" })],
		],
		[
			"conflicting source",
			[
				...originalRows,
				libraryRow({ id: "conflict", mediaType: "series", jellyfinId: "series-1", tmdbId: 84 }),
			],
		],
		[
			"canonical collision",
			[
				...originalRows,
				libraryRow({ id: "collision", mediaType: "series", jellyfinId: "series-2", tmdbId: 42 }),
			],
		],
	] as const)(
		"withholds V3 display after %s rather than returning reinterpreted last-known rows",
		async (_change, rows) => {
			expect(await read([...rows])).toMatchObject({
				available: false,
				rows: [],
				mutationAvailable: false,
				authority: null,
			});
		},
	);
	it("withholds V3 display after user scope changes", async () => {
		expect(await read(originalRows, "display", "replacement-user")).toMatchObject({
			available: false,
			rows: [],
			mutationAvailable: false,
		});
	});
	it("never admits V3 publication to mutation even under the unchanged parent mapping", async () => {
		expect(await read(originalRows, "mutation")).toMatchObject({
			available: false,
			rows: [],
			mutationAvailable: false,
			authority: null,
		});
	});
});
