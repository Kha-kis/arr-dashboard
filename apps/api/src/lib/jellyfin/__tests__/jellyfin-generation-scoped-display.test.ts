import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import { evaluateProviderCoverageReceipt } from "../../provider-observation/coverage-receipt.js";
import { projectProviderObservationStatus } from "../../provider-observation/status-projection.js";
import { buildJellyfinEpisodeCatalogProvenance } from "../jellyfin-episode-catalog-provenance.js";
import { fingerprintJellyfinEpisodeParentDependency } from "../jellyfin-episode-parent-dependency.js";
import type {
	JellyfinEpisodeRow,
	JellyfinLibraryObservation,
	JellyfinLibraryRow,
} from "../jellyfin-evidence-repository.js";
import {
	encodeJellyfinEpisodeGenerationMetadata,
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
vi.mock("../jellyfin-evidence-repository.js", async (original) => ({
	...(await original<typeof import("../jellyfin-evidence-repository.js")>()),
	readOwnedJellyfinObservationInTransaction: repository.readParent,
}));

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
		instance,
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

afterEach(() => vi.clearAllMocks());

describe("generation-scoped episode display freshness", () => {
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
