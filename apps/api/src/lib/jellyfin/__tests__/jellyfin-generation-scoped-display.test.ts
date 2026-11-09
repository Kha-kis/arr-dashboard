import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import { evaluateProviderCoverageReceipt } from "../../provider-observation/coverage-receipt.js";
import { projectProviderObservationStatus } from "../../provider-observation/status-projection.js";
import { buildJellyfinEpisodeCatalogProvenance } from "../jellyfin-episode-catalog-provenance.js";
import * as parentDependencies from "../jellyfin-episode-parent-dependency.js";
import { fingerprintJellyfinEpisodeParentDependency } from "../jellyfin-episode-parent-dependency.js";
import type {
	JellyfinEpisodeRow,
	JellyfinLibraryObservation,
	JellyfinLibraryRow,
} from "../jellyfin-evidence-repository.js";
import {
	encodeJellyfinEpisodeGenerationMetadata,
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinEpisodeRows,
	fingerprintJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
	type JellyfinEpisodeGenerationMetadataV4,
	type JellyfinLibraryGenerationMetadataV1,
} from "../jellyfin-generation-metadata.js";
import { readOwnedGenerationScopedEpisodeDisplay } from "../jellyfin-generation-scoped-display.js";

const repository = vi.hoisted(() => ({ readParent: vi.fn() }));
// Only the parent database boundary is replaced. V4 decoding, coverage,
// provenance compatibility, row digests and status projection remain real.
vi.mock("../jellyfin-evidence-repository.js", async (original) => {
	const actual = await original<typeof import("../jellyfin-evidence-repository.js")>();
	return {
		...actual,
		materializeOwnedJellyfinLibraryDisplayInTransaction: repository.readParent,
		validateOwnedJellyfinLibraryDisplaySnapshot: (
			snapshot:
				| Parameters<typeof actual.validateOwnedJellyfinLibraryDisplaySnapshot>[0]
				| JellyfinLibraryObservation,
		) =>
			"snapshot" in snapshot
				? actual.validateOwnedJellyfinLibraryDisplaySnapshot(snapshot)
				: snapshot,
	};
});

const publishedAt = new Date("2026-09-02T12:01:00.000Z");
const now = new Date("2026-09-02T12:02:00.000Z");
const maxAgeMs = 10 * 60 * 1_000;

function fixture(service: "JELLYFIN" | "EMBY" = "JELLYFIN") {
	const provider = service === "EMBY" ? "emby" : "jellyfin";
	const instance = {
		id: "instance-1",
		service,
		enabled: true,
		expectedIdentity: "server-1",
		identityStatus: "VERIFIED",
		connectionGeneration: 7,
		identityGeneration: 3,
	};
	const libraryRow: JellyfinLibraryRow & { mediaType: "series" } = {
		id: "library-row",
		instanceId: instance.id,
		tmdbId: 42,
		mediaType: "series",
		libraryId: "library-1",
		libraryName: "Synthetic library",
		title: "Synthetic series",
		jellyfinId: "series-1",
		lastWatchedAt: publishedAt,
		watchCount: 1,
		watchedByUsers: '["user-1"]',
		onDeck: false,
		userRating: null,
		collections: "[]",
		addedAt: publishedAt,
		thumb: null,
		connectionGeneration: 7,
		identityGeneration: 3,
	};
	const unit = {
		scopeKey: "user:user-1/library:library-1/inventory",
		expectedRawCount: 1,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: 1,
		sourceBindings: 1,
		canonicalEntities: 1,
		acceptedSkips: [],
		fatalCount: 0,
	};
	const parentMetadata: JellyfinLibraryGenerationMetadataV1 = {
		version: 1,
		provider,
		cacheType: "jellyfin",
		publicationLevel: "positive-only",
		completeness: "partial",
		canonicalizationVersion: 1,
		itemCount: 1,
		connectionGeneration: 7,
		identityGeneration: 3,
		contentFingerprint: fingerprintJellyfinLibraryRows([libraryRow]),
		coverageReceipt: {
			version: 2,
			provider,
			attemptStartedAt: "2026-09-02T12:00:00.000Z",
			observedAt: publishedAt.toISOString(),
			evidence: "positive-only",
			units: [unit],
			publishedCanonicalEntities: 1,
			domains: [
				{
					domain: "library-inventory",
					evidence: "complete",
					valueSemantics: "exact",
					units: [unit],
				},
				{
					domain: "mapping",
					evidence: "complete",
					valueSemantics: "exact",
					units: [{ ...unit, scopeKey: "user:user-1/library:library-1/mapping" }],
					publishedCanonicalEntities: 1,
				},
				{
					domain: "watch-count",
					evidence: "positive-only",
					valueSemantics: "lower-bound",
					units: [unit],
					publishedCanonicalEntities: 1,
				},
				{ domain: "watch-attribution", evidence: "unknown", valueSemantics: "unknown", units: [] },
				{ domain: "on-deck", evidence: "unknown", valueSemantics: "unknown", units: [] },
			],
		},
	};
	const parent: JellyfinLibraryObservation = {
		available: true,
		instanceId: instance.id,
		service,
		cacheType: "jellyfin",
		generationId: "parent-generation",
		publishedAt,
		metadata: parentMetadata,
		rows: [libraryRow],
		providerStatus: projectProviderObservationStatus({
			identity: "current",
			publication: {
				observedAt: publishedAt,
				evaluation: evaluateProviderCoverageReceipt(parentMetadata.coverageReceipt),
			},
			latestAttempt: { state: "successful", attemptedAt: publishedAt },
			now,
			maxAgeMs,
		}),
		mutationAvailable: false,
		authority: null,
	};
	const watched: JellyfinEpisodeRow = {
		id: "episode-1",
		instanceId: instance.id,
		showTmdbId: 42,
		seasonNumber: 1,
		episodeNumber: 1,
		jellyfinId: "native-episode-1",
		title: "Synthetic episode",
		watched: true,
		watchedByUsers: '["user-1"]',
		lastWatchedAt: publishedAt,
		connectionGeneration: 7,
		identityGeneration: 3,
	};
	const unwatched: JellyfinEpisodeRow = {
		...watched,
		id: "episode-2",
		episodeNumber: 2,
		jellyfinId: "native-episode-2",
		watched: false,
		watchedByUsers: "[]",
		lastWatchedAt: null,
	};
	const rows = [watched, unwatched];
	const catalogProvenance = buildJellyfinEpisodeCatalogProvenance(
		[libraryRow],
		[{ userId: "user-1", libraryId: "library-1" }],
	);
	if (!catalogProvenance) throw new Error("Invalid synthetic catalog");
	const parentLibraryDependencyFingerprint = fingerprintJellyfinEpisodeParentDependency(
		instance.id,
		parentMetadata,
		[libraryRow],
	);
	if (!parentLibraryDependencyFingerprint) throw new Error("Invalid synthetic parent receipt");
	const episodeUnit = {
		...unit,
		expectedRawCount: 2,
		rawObserved: 2,
		sourceBindings: 2,
		canonicalEntities: 2,
	};
	const metadata: JellyfinEpisodeGenerationMetadataV4 = {
		version: 4,
		storage: "generation-scoped",
		sourceVersion: 3,
		provider,
		cacheType: "jellyfin_episode",
		publicationLevel: "positive-only",
		completeness: "partial",
		canonicalizationVersion: 1,
		itemCount: 2,
		connectionGeneration: 7,
		identityGeneration: 3,
		parentLibraryGenerationId: "parent-generation",
		parentLibraryMetadataFingerprint: fingerprintJellyfinLibraryGenerationMetadata(parentMetadata),
		parentLibraryDependencyFingerprint,
		contentFingerprint: fingerprintJellyfinEpisodeRows(rows),
		catalogProvenance,
		coverageReceipt: {
			version: 2,
			provider: service === "EMBY" ? "emby_episode" : "jellyfin_episode",
			attemptStartedAt: "2026-09-02T12:00:00.000Z",
			observedAt: publishedAt.toISOString(),
			evidence: "positive-only",
			units: [episodeUnit],
			publishedCanonicalEntities: 2,
			domains: [
				{
					domain: "episode-inventory",
					evidence: "positive-only",
					valueSemantics: "lower-bound",
					units: [episodeUnit],
					publishedCanonicalEntities: 2,
				},
			],
		},
	};
	const status = {
		generationId: "episode-generation",
		generationMetadata: encodeJellyfinEpisodeGenerationMetadata(metadata),
		lastResult: "success",
		lastRefreshedAt: publishedAt,
		itemCount: 2,
		connectionGeneration: 7,
		identityGeneration: 3,
		lastAttemptAt: publishedAt,
		lastAttemptResult: "success",
	};
	const preparation = {
		instanceId: instance.id,
		generationId: status.generationId,
		state: "published",
		expectedRowCount: 2,
		contentFingerprint: metadata.contentFingerprint,
		observedAt: publishedAt,
	};
	const pointer = {
		activeRunId: status.generationId,
		activeCacheGenerationId: status.generationId,
	};
	const showReceipt = { rowCount: 2, contentFingerprint: fingerprintJellyfinEpisodeRows(rows) };
	const tx = {
		serviceInstance: { findFirst: vi.fn(async () => instance) },
		cacheRefreshStatus: { findUnique: vi.fn(async () => status) },
		jellyfinEpisodePreparation: { findUnique: vi.fn(async () => preparation) },
		jellyfinNativeWatchPublication: { findUnique: vi.fn(async () => pointer) },
		jellyfinEpisodeGenerationShowReceipt: { findUnique: vi.fn(async () => showReceipt) },
		jellyfinEpisodeGenerationRow: { findMany: vi.fn(async () => rows) },
	};
	const prisma = {
		$transaction: async (read: (value: typeof tx) => unknown) => read(tx),
	} as unknown as PrismaClient;
	repository.readParent.mockResolvedValue(parent);
	return {
		prisma,
		instance,
		libraryRow,
		parent,
		status,
		preparation,
		pointer,
		showReceipt,
		rows,
		tx,
		read: (at = now) =>
			readOwnedGenerationScopedEpisodeDisplay({
				prisma,
				userId: "owner-1",
				instanceId: instance.id,
				showTmdbIds: [42],
				now: at,
				maxAgeMs,
			}),
	};
}

async function useRealParentSnapshot(f: ReturnType<typeof fixture>) {
	const actual = await vi.importActual<typeof import("../jellyfin-evidence-repository.js")>(
		"../jellyfin-evidence-repository.js",
	);
	repository.readParent.mockImplementation(
		actual.materializeOwnedJellyfinLibraryDisplayInTransaction,
	);
	const parentStatus = {
		...f.status,
		instanceId: f.instance.id,
		cacheType: "jellyfin",
		generationId: f.parent.generationId!,
		generationMetadata: encodeJellyfinLibraryGenerationMetadata(f.parent.metadata!),
		itemCount: 1,
		lastErrorMessage: null,
		lastAttemptErrorMessage: null,
	};
	f.tx.cacheRefreshStatus.findUnique.mockImplementation(async (...args: unknown[]) => {
		const query = args[0] as { where: { instanceId_cacheType: { cacheType: string } } };
		return query.where.instanceId_cacheType.cacheType === "jellyfin" ? parentStatus : f.status;
	});
	Object.assign(f.tx, { jellyfinCache: { findMany: async () => f.parent.rows } });
}

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

describe("generation-scoped episode display freshness", () => {
	it.each(["JELLYFIN", "EMBY"] as const)(
		"skips unused parent dependency hashing for a validated positive-only %s display",
		async (service) => {
			const f = fixture(service);
			await useRealParentSnapshot(f);
			const dependency = vi.spyOn(parentDependencies, "fingerprintJellyfinEpisodeParentDependency");
			const result = await f.read();
			expect(result).toMatchObject({
				available: true,
				mutationAvailable: false,
				authority: null,
				providerStatus: {
					availability: "partial",
					evidence: "positive-only",
					latestAttempt: "successful",
					reasonCodes: ["positive-only", "coverage-incomplete"],
				},
			});
			expect(result?.rows).toEqual([f.rows[0]]);
			expect(dependency).not.toHaveBeenCalled();
		},
	);

	it.each([false, true])(
		"retains legacy parent dependency matching (mismatch: %s)",
		async (mismatch) => {
			const f = fixture();
			const metadata = JSON.parse(f.status.generationMetadata);
			metadata.sourceVersion = 2;
			delete metadata.catalogProvenance;
			if (mismatch) metadata.parentLibraryDependencyFingerprint = "f".repeat(64);
			f.status.generationMetadata = encodeJellyfinEpisodeGenerationMetadata(metadata);
			await useRealParentSnapshot(f);
			const expectedDependency = fingerprintJellyfinEpisodeParentDependency(
				f.instance.id,
				f.parent.metadata,
				[f.libraryRow],
			);
			const dependency = vi.spyOn(parentDependencies, "fingerprintJellyfinEpisodeParentDependency");
			const result = await f.read();
			expect(result).toMatchObject({
				available: !mismatch,
				rows: mismatch ? [] : [f.rows[0]],
				mutationAvailable: false,
				authority: null,
				providerStatus: mismatch
					? { availability: "unavailable", reasonCodes: ["rows-inconsistent"] }
					: { availability: "partial", evidence: "positive-only" },
			});
			expect(dependency).toHaveBeenCalledTimes(1);
			expect(expectedDependency).not.toBeNull();
			expect(dependency.mock.results[0]?.value).toBe(expectedDependency);
		},
	);

	it.each(["catalog-incompatible", "parent-corrupted"] as const)(
		"refuses %s positive-only evidence without dependency hashing",
		async (failure) => {
			const f = fixture();
			if (failure === "catalog-incompatible") {
				const metadata = JSON.parse(f.status.generationMetadata);
				metadata.catalogProvenance = buildJellyfinEpisodeCatalogProvenance(
					[{ ...f.libraryRow, jellyfinId: "replacement-series" }],
					[{ userId: "user-1", libraryId: "library-1" }],
				);
				f.status.generationMetadata = encodeJellyfinEpisodeGenerationMetadata(metadata);
			} else {
				f.parent.rows[0]!.title = "Corrupted parent title";
			}
			await useRealParentSnapshot(f);
			const dependency = vi.spyOn(parentDependencies, "fingerprintJellyfinEpisodeParentDependency");
			expect(await f.read()).toMatchObject({
				available: false,
				rows: [],
				mutationAvailable: false,
				authority: null,
				providerStatus: { availability: "unavailable", reasonCodes: ["rows-inconsistent"] },
			});
			expect(dependency).not.toHaveBeenCalled();
		},
	);

	it.each(["malformed", "oversized"] as const)(
		"discards %s and later oversized scopes while retaining a later valid show",
		async (first) => {
			const f = fixture();
			const metadata = JSON.parse(f.status.generationMetadata);
			metadata.sourceVersion = 2;
			delete metadata.catalogProvenance;
			f.status.generationMetadata = encodeJellyfinEpisodeGenerationMetadata(metadata);
			const valid = f.rows.map((row) => ({ ...row, showTmdbId: 44 }));
			const oversized = new Array<JellyfinEpisodeRow>(100_001).fill(f.rows[0]!);
			const scopes = new Map([
				[42, first === "malformed" ? [{ ...f.rows[0]!, jellyfinId: "" }] : oversized],
				[43, oversized],
				[44, valid],
			]);
			f.tx.jellyfinEpisodeGenerationShowReceipt.findUnique.mockImplementation(
				async (...args: unknown[]) => {
					const query = args[0] as {
						where: { instanceId_generationId_showTmdbId: { showTmdbId: number } };
					};
					const id = query.where.instanceId_generationId_showTmdbId.showTmdbId;
					return {
						rowCount: scopes.get(id)!.length,
						contentFingerprint:
							id === 44 ? fingerprintJellyfinEpisodeRows(valid) : "invalid-digest",
					};
				},
			);
			f.tx.jellyfinEpisodeGenerationRow.findMany.mockImplementation(async (...args: unknown[]) => {
				const query = args[0] as { where: { showTmdbId: number }; take: number };
				expect(query.take).toBe(100_001);
				return scopes.get(query.where.showTmdbId)!;
			});
			const result = await readOwnedGenerationScopedEpisodeDisplay({
				prisma: f.prisma,
				userId: "owner-1",
				instanceId: f.instance.id,
				showTmdbIds: [42, 43, 44],
				now,
				maxAgeMs,
			});
			expect(result).toMatchObject({
				available: true,
				mutationAvailable: false,
				authority: null,
				providerStatus: {
					availability: "partial",
					evidence: "positive-only",
					reasonCodes: ["positive-only", "coverage-incomplete"],
				},
			});
			expect(result?.rows.map((row) => [row.showTmdbId, row.episodeNumber, row.watched])).toEqual([
				[44, 1, true],
			]);
		},
	);

	it.each([{ requested: [] }, { requested: [42] }])(
		"validates the complete parent display snapshot after outer transaction settlement for $requested",
		async ({ requested }) => {
			const f = fixture();
			await useRealParentSnapshot(f);
			let settled = false;
			const visits: boolean[] = [];
			const row = f.parent.rows[0]!;
			const value = row.watchedByUsers;
			Object.defineProperty(row, "watchedByUsers", {
				get() {
					visits.push(settled);
					return value;
				},
			});
			f.prisma.$transaction = (async (read: (tx: typeof f.tx) => Promise<unknown>) => {
				const result = await read(f.tx);
				settled = true;
				return result;
			}) as unknown as typeof f.prisma.$transaction;
			const result = await readOwnedGenerationScopedEpisodeDisplay({
				prisma: f.prisma,
				userId: "owner-1",
				instanceId: f.instance.id,
				showTmdbIds: requested,
				now,
				maxAgeMs,
			});
			expect(result).toMatchObject({ available: true, mutationAvailable: false, authority: null });
			expect(result?.rows).toHaveLength(requested.length);
			expect(visits.length).toBeGreaterThanOrEqual(2);
			expect(visits.every(Boolean)).toBe(true);
		},
	);

	it.each(["JELLYFIN", "EMBY"] as const)(
		"keeps fresh partial %s evidence partial, not superseded",
		async (service) => {
			const f = fixture(service);
			expect(f.parent.providerStatus.availability).toBe("partial");
			const result = await f.read();
			expect(result).toMatchObject({
				available: true,
				mutationAvailable: false,
				authority: null,
				providerStatus: {
					availability: "partial",
					evidence: "positive-only",
					latestAttempt: "successful",
				},
			});
			expect(result?.providerStatus.reasonCodes).not.toContain("publication-superseded");
			expect(result?.rows.map((row) => [row.episodeNumber, row.watched])).toEqual([[1, true]]);
			expect(f.tx.serviceInstance.findFirst).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { id: "instance-1", userId: "owner-1", service: { in: ["JELLYFIN", "EMBY"] } },
				}),
			);
		},
	);

	it("retains existing current-parent display behavior without promoting episode coverage", async () => {
		const f = fixture();
		f.parent.providerStatus = { ...f.parent.providerStatus, availability: "current" };
		expect(await f.read()).toMatchObject({
			available: true,
			mutationAvailable: false,
			authority: null,
			providerStatus: { availability: "partial", evidence: "positive-only" },
		});
	});

	it.each(["running", "failed"] as const)(
		"does not promote a parent with a newer %s attempt",
		async (state) => {
			const f = fixture();
			f.parent.providerStatus = projectProviderObservationStatus({
				identity: "current",
				publication: {
					observedAt: publishedAt,
					evaluation: evaluateProviderCoverageReceipt(f.parent.metadata!.coverageReceipt),
				},
				latestAttempt: { state, attemptedAt: new Date("2026-09-02T12:01:30.000Z") },
				now,
				maxAgeMs,
			});
			expect(await f.read()).toMatchObject({
				providerStatus: { availability: "last-known", evidence: "positive-only" },
				mutationAvailable: false,
				authority: null,
			});
		},
	);

	it("keeps an aged publication last-known", async () => {
		const f = fixture();
		expect(await f.read(new Date("2026-09-02T12:20:00.000Z"))).toMatchObject({
			providerStatus: { availability: "last-known" },
			mutationAvailable: false,
		});
	});

	it("keeps a catalog-compatible replacement parent last-known", async () => {
		const f = fixture();
		f.parent.generationId = "replacement-generation";
		const result = await f.read();
		expect(result).toMatchObject({
			available: true,
			providerStatus: { availability: "last-known" },
			mutationAvailable: false,
		});
		expect(result?.providerStatus.reasonCodes).toContain("publication-superseded");
	});

	it("refuses unverified identity", async () => {
		const f = fixture();
		f.instance.identityStatus = "UNVERIFIED";
		expect(await f.read()).toMatchObject({
			available: false,
			rows: [],
			providerStatus: { availability: "unavailable", reasonCodes: ["identity-unverified"] },
			mutationAvailable: false,
			authority: null,
		});
	});

	it("does not expose corrupted scoped rows", async () => {
		const f = fixture();
		f.rows[0]!.jellyfinId = "changed-native-id";
		const result = await f.read();
		expect(result).toMatchObject({
			rows: [],
			providerStatus: { evidence: "positive-only" },
			mutationAvailable: false,
			authority: null,
		});
		expect(result?.providerStatus.reasonCodes).toContain("coverage-incomplete");
	});

	it("refuses a mismatched active publication pointer", async () => {
		const f = fixture();
		f.pointer.activeRunId = "other-generation";
		expect(await f.read()).toMatchObject({
			available: false,
			rows: [],
			providerStatus: { availability: "unavailable", reasonCodes: ["rows-inconsistent"] },
			mutationAvailable: false,
		});
	});

	it("refuses receipt ownership-generation mismatch", async () => {
		const f = fixture();
		f.status.identityGeneration = 4;
		expect(await f.read()).toMatchObject({
			available: false,
			rows: [],
			providerStatus: { availability: "unavailable", reasonCodes: ["receipt-invalid"] },
			mutationAvailable: false,
		});
	});
});
