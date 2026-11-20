import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	type PlexCanonicalDomain,
	type ProviderCoverageReceiptV2,
	seerrPageResultSchema,
	seerrRequestSchema,
} from "@arr/shared";
import fastifyCookie from "@fastify/cookie";
import Database from "better-sqlite3";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../../../config/env.js";
import { registerOnDeckRoutes as registerJellyfinOnDeck } from "../../../routes/jellyfin/on-deck-routes.js";
import { registerRecentlyAddedRoutes as registerJellyfinRecent } from "../../../routes/jellyfin/recently-added-routes.js";
import { registerSeriesProgressRoutes as registerJellyfinProgress } from "../../../routes/jellyfin/series-progress-routes.js";
import { registerWatchEnrichmentRoutes as registerJellyfinWatch } from "../../../routes/jellyfin/watch-enrichment-routes.js";
import { registerFetchRoutes } from "../../../routes/library/fetch-routes.js";
import { registerImageProxyRoutes } from "../../../routes/library/image-proxy-routes.js";
import { registerInsightsRoutes } from "../../../routes/library/insights-routes.js";
import { registerProviderInventoryRoutes } from "../../../routes/library/provider-inventory-routes.js";
import { registerOnDeckRoutes as registerPlexOnDeck } from "../../../routes/plex/on-deck-routes.js";
import { registerRecentlyAddedRoutes as registerPlexRecent } from "../../../routes/plex/recently-added-routes.js";
import { registerSectionRoutes } from "../../../routes/plex/section-routes.js";
import { registerSeriesProgressRoutes as registerPlexProgress } from "../../../routes/plex/series-progress-routes.js";
import { registerWatchEnrichmentRoutes as registerPlexWatch } from "../../../routes/plex/watch-enrichment-routes.js";
import { registerSessionValidationHook } from "../../../server.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	type ScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { SessionService } from "../../auth/session.js";
import {
	decodeJellyfinLibraryGenerationMetadata,
	encodeJellyfinEpisodeGenerationMetadata,
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinEpisodeRows,
	fingerprintJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
} from "../../jellyfin/jellyfin-generation-metadata.js";
import { publishPreparedNativeWatchGeneration } from "../../jellyfin/jellyfin-native-watch-repository.js";
import { publishJellyfinPositiveWatchGeneration } from "../../jellyfin/jellyfin-positive-watch-repository.js";
import { createPlexSelectionProjection } from "../../plex/plex-canonical-projection.js";
import { createPositivePlexEpisodeDigest } from "../../plex/plex-episode-live-collector.js";
import {
	decodePlexGenerationMetadata,
	encodeAuthoritativePlexGenerationMetadata,
} from "../../plex/plex-generation-metadata.js";
import { createPlexTargetLedgerBinding } from "../../plex/plex-generation-target-ledger.js";
import { encodePlexPositiveEpisodeGenerationMetadata } from "../../plex/plex-positive-episode-generation-metadata.js";
import { plexConnectionFingerprint } from "../../plex/service-instance-fingerprint.js";
import type {
	NativeInventoryDomain,
	NativeInventoryRow,
} from "../../provider-observation/native-inventory.js";
import {
	admitNativeInventoryRun,
	beginNativeInventoryPass,
	claimDueNativeInventoryRun,
	commitNativeInventoryPage,
	completeNativeInventoryPass,
	type NativeInventoryRunClaim,
	type NativeInventoryWorkKey,
	publishNativeInventoryRun,
	renewNativeInventoryRunLease,
} from "../../provider-observation/native-inventory-job-repository.js";
import { beginProviderCacheRefreshAttempt } from "../../services/provider-cache-status.js";
import { createProviderPublicationAuthority } from "../../services/provider-identity-guard.js";
import { type RuntimeReadTiming, withRuntimeReadTiming } from "../restore-runtime-read-timing.js";

const OWNER = "synthetic-user";
const JELLYFIN = "synthetic-jellyfin";
const PLEX = "synthetic-plex";
const RADARR = "synthetic-mixed-radarr";
const SONARR = "synthetic-mixed-sonarr";
const SEERR = "synthetic-mixed-seerr";
const LIBRARY_DOMAINS = [
	"library-inventory",
	"mapping",
	"watch-count",
	"watch-attribution",
	"on-deck",
] as const;
const PLEX_DOMAINS: PlexCanonicalDomain[] = [
	"membership",
	"display",
	"labels",
	"collections",
	"watch",
	"on-deck",
];
const POSTER_JPEG =
	"/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAABQcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCOAL+Lf//Z";
const scope = new AsyncLocalStorage<Trace>();
const handles = new Set<Database.Database>();
let fixture: ScopedWriteFixture | undefined;

type SqlCounts = {
	calls: number;
	elapsedMs: number;
	rows: number;
	countCalls: number;
	changedRows: number;
};
type Trace = {
	category: string;
	index: number;
	startedAtMs: number;
	wallMs?: number;
	status?: number;
	runtime?: RuntimeReadTiming;
	nativeRuntime?: RuntimeReadTiming;
	nativeSubphases: { stage: string; outcome: string; elapsedMs: number }[];
	nativeTiming?: Record<string, unknown>;
	sql: Record<string, SqlCounts>;
	ownedEnabledPosterRows: number;
};

function emit(value: unknown) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

afterEach(async () => {
	await closeScopedWriteFixtures();
	if (fixture) {
		const closure = {
			category: "synthetic-mixed-provider-closure",
			nativeHandles: handles.size,
			nativeHandlesClosed: [...handles].every((db) => !db.open),
			writerClosed: !fixture.writer.open,
			fixtureRemoved: !existsSync(fixture.directory),
		};
		emit(closure);
		expect(closure).toMatchObject({
			nativeHandlesClosed: true,
			writerClosed: true,
			fixtureRemoved: true,
		});
	}
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	fixture = undefined;
	handles.clear();
});

function receipt(
	provider: ProviderCoverageReceiptV2["provider"],
	count: number,
	observedAt: Date,
	domains: readonly ProviderCoverageReceiptV2["domains"][number]["domain"][],
	positive = false,
	sections?: { key: string; count: number }[],
): ProviderCoverageReceiptV2 {
	const unit = (scopeKey: string, size: number) => ({
		scopeKey,
		expectedRawCount: positive ? null : size,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: size,
		sourceBindings: size,
		canonicalEntities: size,
		acceptedSkips: [],
		fatalCount: 0,
	});
	const evidence = positive ? ("positive-only" as const) : ("complete" as const);
	return {
		version: 2,
		provider,
		attemptStartedAt: observedAt.toISOString(),
		observedAt: observedAt.toISOString(),
		evidence,
		units: sections?.map((section) => unit(`section:${section.key}`, section.count)) ?? [
			unit("synthetic-observations", count),
		],
		publishedCanonicalEntities: count,
		domains: domains.map((domain) => ({
			domain,
			evidence,
			valueSemantics: positive ? "lower-bound" : "exact",
			units: sections?.map((section) =>
				unit(
					`section:${section.key}:${domain === "library-inventory" ? "inventory" : domain}`,
					section.count,
				),
			) ?? [unit(positive ? "synthetic-observations" : `synthetic-${domain}`, count)],
			publishedCanonicalEntities: count,
		})),
	};
}

async function seedCanonical(f: ScopedWriteFixture) {
	const observedAt = new Date(Date.now() - 1_000);
	await f.plain.serviceInstance.updateMany({
		where: { id: { in: [PLEX, JELLYFIN] }, userId: OWNER },
		data: { identityVerifiedAt: observedAt },
	});
	await f.plain.serviceInstance.update({
		where: { id: PLEX },
		data: { identityKind: "PLEX_MACHINE_IDENTIFIER" },
	});
	await f.plain.serviceInstance.createMany({
		data: [
			{ id: RADARR, service: "RADARR" as const },
			{ id: SONARR, service: "SONARR" as const },
			{ id: SEERR, service: "SEERR" as const },
		].map((instance) => ({
			...instance,
			userId: OWNER,
			enabled: true,
			label: "Synthetic ARR",
			baseUrl: "http://synthetic.invalid",
			encryptedApiKey: "synthetic-cipher",
			encryptionIv: "synthetic-iv",
		})),
	});
	for (const [instanceId, itemType] of [
		[RADARR, "movie"],
		[SONARR, "series"],
	] as const) {
		for (let start = 0; start < 1_000; start += 500) {
			await f.plain.libraryCache.createMany({
				data: Array.from({ length: 500 }, (_, offset) => {
					const id = start + offset + 1;
					return {
						id: `synthetic-arr-${itemType}-${id}`,
						instanceId,
						arrItemId: id,
						itemType,
						title: "Synthetic ARR item",
						hasFile: itemType === "movie" && id <= 20,
						sizeOnDisk: itemType === "movie" && id <= 20 ? BigInt(21 - id) * 1024n ** 3n : 0n,
						arrAddedAt: new Date(observedAt.getTime() - 90 * 86400000),
						data: JSON.stringify({
							id,
							instanceId,
							instanceName: "Synthetic ARR",
							service: itemType === "movie" ? "radarr" : "sonarr",
							type: itemType,
							title: "Synthetic ARR item",
							poster: "http://synthetic.invalid/poster.jpg",
							remoteIds: itemType === "movie" ? { tmdbId: id } : { tmdbId: id, tvdbId: id },
						}),
					};
				}),
			});
		}
	}
	const jellyfinRows = Array.from({ length: 10_000 }, (_, index) => {
		const series = index < 1_000;
		const id = series ? index + 1 : index - 999;
		return {
			id: `synthetic-jf-${index}`,
			instanceId: JELLYFIN,
			tmdbId: id,
			mediaType: series ? ("series" as const) : ("movie" as const),
			libraryId: series ? "shows" : "movies",
			libraryName: "Synthetic library",
			title: "Synthetic item",
			jellyfinId: `${series ? "series" : "movie"}-${String(id).padStart(6, "0")}`,
			lastWatchedAt: !series && id <= 20 && id % 2 === 1 ? null : observedAt,
			watchCount: !series && id <= 20 && id % 2 === 1 ? 0 : 2,
			watchedByUsers: !series && id <= 20 && id % 2 === 1 ? "[]" : '["synthetic-viewer"]',
			onDeck: id <= 50,
			userRating: null,
			collections: "[]",
			addedAt: observedAt,
			thumb: null,
			connectionGeneration: 1,
			identityGeneration: 1,
		};
	});
	for (let start = 0; start < jellyfinRows.length; start += 500)
		await f.plain.jellyfinCache.createMany({ data: jellyfinRows.slice(start, start + 500) });
	const jfMetadata = encodeJellyfinLibraryGenerationMetadata({
		version: 1,
		provider: "jellyfin",
		cacheType: "jellyfin",
		publicationLevel: "authoritative",
		completeness: "complete",
		canonicalizationVersion: 1,
		itemCount: 10_000,
		connectionGeneration: 1,
		identityGeneration: 1,
		contentFingerprint: fingerprintJellyfinLibraryRows(jellyfinRows),
		coverageReceipt: receipt("jellyfin", 10_000, observedAt, LIBRARY_DOMAINS),
	});
	const statusData = {
		lastRefreshedAt: observedAt,
		lastResult: "success",
		lastAttemptAt: observedAt,
		lastAttemptResult: "success",
		connectionGeneration: 1,
		identityGeneration: 1,
	};
	await f.plain.cacheRefreshStatus.create({
		data: {
			...statusData,
			instanceId: JELLYFIN,
			cacheType: "jellyfin",
			generationId: "synthetic-jf-parent",
			generationMetadata: jfMetadata,
			itemCount: 10_000,
		},
	});
	const jfEpisodes = Array.from({ length: 57 }, (_, index) => ({
		instanceId: JELLYFIN,
		showTmdbId: index < 29 ? 42 : 43,
		seasonNumber: 1,
		episodeNumber: index < 29 ? index + 1 : index - 28,
		jellyfinId: `positive-jf-${index}`,
		title: "Synthetic positive episode",
		watched: true,
		watchedByUsers: '["synthetic-viewer"]',
		lastWatchedAt: observedAt,
		connectionGeneration: 1,
		identityGeneration: 1,
	}));
	await f.plain.jellyfinEpisodeCache.createMany({ data: jfEpisodes });
	const decodedJf = decodeJellyfinLibraryGenerationMetadata(jfMetadata);
	if (!decodedJf.ok) throw new Error("fixture-seed: invalid encoded Jellyfin parent");
	await f.plain.cacheRefreshStatus.create({
		data: {
			...statusData,
			instanceId: JELLYFIN,
			cacheType: "jellyfin_episode",
			generationId: "synthetic-jf-child",
			itemCount: 57,
			lastAttemptResult: "success",
			generationMetadata: encodeJellyfinEpisodeGenerationMetadata({
				version: 1,
				provider: "jellyfin",
				cacheType: "jellyfin_episode",
				publicationLevel: "positive-only",
				completeness: "partial",
				canonicalizationVersion: 1,
				itemCount: 57,
				connectionGeneration: 1,
				identityGeneration: 1,
				parentLibraryGenerationId: "synthetic-jf-parent",
				parentLibraryMetadataFingerprint: fingerprintJellyfinLibraryGenerationMetadata(
					decodedJf.metadata,
				),
				contentFingerprint: fingerprintJellyfinEpisodeRows(jfEpisodes),
				coverageReceipt: receipt("jellyfin_episode", 57, observedAt, ["episode-inventory"], true),
			}),
		},
	});
	// Reuse the fixture's one row so the advertised 2,500 is the physical count.
	const plexRows = Array.from({ length: 2_500 }, (_, index) => {
		const series = index < 1_000;
		const id = series ? index + 1 : index - 999;
		return {
			id: index === 0 ? "synthetic-cache" : `synthetic-plex-${index}`,
			instanceId: PLEX,
			tmdbId: id,
			mediaType: series ? ("series" as const) : ("movie" as const),
			sectionId: series ? "shows" : "movies",
			sectionTitle: "Synthetic library",
			title: "Synthetic item",
			ratingKey: `${series ? "series" : "movie"}-${String(id).padStart(6, "0")}`,
			lastWatchedAt: !series && id <= 20 && id % 2 === 1 ? null : observedAt,
			watchCount: !series && id <= 20 && id % 2 === 1 ? 0 : 2,
			watchedByUsers: !series && id <= 20 && id % 2 === 1 ? "[]" : '["synthetic-viewer"]',
			onDeck: id <= 50,
			userRating: null,
			collections: "[]",
			labels: "[]",
			addedAt: observedAt,
			thumb: null,
			connectionGeneration: 1,
			identityGeneration: 1,
		};
	});
	await f.plain.plexCache.update({ where: { id: "synthetic-cache" }, data: plexRows[0]! });
	for (let start = 1; start < plexRows.length; start += 500)
		await f.plain.plexCache.createMany({ data: plexRows.slice(start, start + 500) });
	const targets = plexRows.map((row) => ({
		instanceId: PLEX,
		generationId: "synthetic-plex-parent",
		sectionId: row.sectionId,
		sectionUuid: `${row.sectionId}-uuid`,
		mediaType: row.mediaType,
		tmdbId: row.tmdbId,
		tvdbId: row.mediaType === "series" ? row.tmdbId : null,
		ratingKey: row.ratingKey,
	}));
	for (let start = 0; start < targets.length; start += 500)
		await f.plain.plexGenerationTarget.createMany({ data: targets.slice(start, start + 500) });
	const roots = ["shows", "movies"].flatMap((sectionKey) => {
		const projection = createPlexSelectionProjection({
			rows: plexRows.filter((row) => row.sectionId === sectionKey),
			selection: { kind: "all" },
			domains: PLEX_DOMAINS,
		});
		return Object.entries(projection.domains).map(([domain, digest]) => ({
			sectionKey,
			domain: domain as PlexCanonicalDomain,
			digest,
		}));
	});
	const plexMetadata = encodeAuthoritativePlexGenerationMetadata({
		sections: ["shows", "movies"].map((key) => ({
			key,
			uuid: `${key}-uuid`,
			title: "Synthetic library",
			type: key === "shows" ? ("show" as const) : ("movie" as const),
			refreshing: false,
			scannedAt: 1,
			updatedAt: 1,
		})),
		itemCount: 2_500,
		canonicalizationVersion: 1,
		roots,
		targetLedger: createPlexTargetLedgerBinding({
			instanceId: PLEX,
			generationId: "synthetic-plex-parent",
			connectionGeneration: 1,
			identityGeneration: 1,
			targets,
		}),
		partialReasons: [],
		coverageReceipt: receipt("plex", 2_500, observedAt, LIBRARY_DOMAINS, false, [
			{ key: "shows", count: 1_000 },
			{ key: "movies", count: 1_500 },
		]),
	});
	await f.plain.cacheRefreshStatus.create({
		data: {
			...statusData,
			instanceId: PLEX,
			cacheType: "plex",
			generationId: "synthetic-plex-parent",
			generationMetadata: plexMetadata,
			itemCount: 2_500,
		},
	});
	const plexInstance = await f.plain.serviceInstance.findUniqueOrThrow({ where: { id: PLEX } });
	const plexEpisodes = Array.from({ length: 3_251 }, (_, index) => ({
		instanceId: PLEX,
		showTmdbId: (index % 1_000) + 1,
		seasonNumber: 1,
		episodeNumber: Math.floor(index / 1_000) + 1,
		ratingKey: `positive-plex-${index}`,
		title: "Synthetic positive episode",
		watched: true,
		watchCount: 2,
		watchedByUsers: "[]",
		lastWatchedAt: observedAt,
		refreshedAt: observedAt,
		sourceFingerprint: plexConnectionFingerprint(plexInstance),
		connectionGeneration: 1,
		identityGeneration: 1,
	}));
	for (let start = 0; start < plexEpisodes.length; start += 500)
		await f.plain.plexEpisodeCache.createMany({ data: plexEpisodes.slice(start, start + 500) });
	const decodedPlex = decodePlexGenerationMetadata(plexMetadata);
	if (!decodedPlex.ok || decodedPlex.metadata.version !== 6)
		throw new Error("fixture-seed: expected V6 Plex parent");
	await f.plain.cacheRefreshStatus.create({
		data: {
			...statusData,
			instanceId: PLEX,
			cacheType: "plex_episode",
			generationId: "synthetic-plex-child",
			itemCount: 3_251,
			lastAttemptResult: "partial",
			generationMetadata: encodePlexPositiveEpisodeGenerationMetadata({
				version: 5,
				publicationLevel: "positive-only",
				completeness: "partial",
				itemCount: 3_251,
				canonicalizationVersion: 1,
				capability: {
					domain: "episodes",
					field: "watchCount",
					semantics: "lower-bound",
					operator: "greater_than",
				},
				parentPlexGenerationId: "synthetic-plex-parent",
				parentMetadataVersion: 6,
				parentPublicationLevel: "authoritative",
				parentTargetDigest: decodedPlex.metadata.targetDigest,
				episodeDigest: createPositivePlexEpisodeDigest(
					targets
						.filter((target) => target.mediaType === "series")
						.map(({ tmdbId, ...target }) => ({
							...target,
							mediaType: "series" as const,
							showTmdbId: tmdbId,
						})),
					plexEpisodes,
				),
				partialReasons: [],
				connectionGeneration: 1,
				identityGeneration: 1,
				coverageReceipt: receipt(
					"plex_episode",
					3_251,
					observedAt,
					["episode-inventory", "watch-count"],
					true,
				),
			}),
		},
	});
	return {
		arr: await f.plain.libraryCache.count(),
		jellyfin: await f.plain.jellyfinCache.count(),
		plex: await f.plain.plexCache.count(),
		jellyfinEpisodes: await f.plain.jellyfinEpisodeCache.count(),
		plexEpisodes: await f.plain.plexEpisodeCache.count(),
	};
}

function nativeRow(
	domain: NativeInventoryDomain,
	index: number,
	episodesPerSeries: number,
): NativeInventoryRow {
	if (domain === "episode") {
		const parent = Math.floor(index / episodesPerSeries) + 1;
		return {
			nativeId: `episode-${String(index).padStart(6, "0")}`,
			mediaType: "episode",
			libraryIds: ["catalog"],
			parentNativeId: `series-${String(parent).padStart(6, "0")}`,
			seasonNumber: 1,
			episodeNumber: (index % episodesPerSeries) + 1,
			title: "Synthetic native episode",
			externalIds: { tmdb: [parent], tvdb: [parent] },
		};
	}
	const series = index < 2_000 && index % 2 === 1;
	const id = index < 2_000 ? Math.floor(index / 2) + 1 : index - 999;
	return {
		nativeId: `${series ? "series" : "movie"}-${String(id).padStart(6, "0")}`,
		mediaType: series ? "series" : "movie",
		libraryIds: ["catalog"],
		parentNativeId: null,
		seasonNumber: null,
		episodeNumber: null,
		title: "Synthetic native item",
		externalIds: series ? { tmdb: [id], tvdb: [id] } : { tmdb: [id] },
	};
}

async function seedNative(f: ScopedWriteFixture, resourceCheck: () => unknown) {
	let pageCommits = 0;
	let stageInputs = 0;
	let maxSerializedPageBytes = 0;
	for (const [instanceId, workKey, domains] of [
		[JELLYFIN, "library", [["library", 10_000]]],
		[JELLYFIN, "episode", [["episode", 125_000]]],
		[
			PLEX,
			"paired",
			[
				["library", 2_500],
				["episode", 25_000],
			],
		],
	] as const) {
		const instance = await f.plain.serviceInstance.findUniqueOrThrow({ where: { id: instanceId } });
		expect(
			(
				await admitNativeInventoryRun(
					f.plain,
					createProviderPublicationAuthority(instance),
					workKey,
					new Date(),
				)
			).status,
		).toBe("acquired");
		const run = await f.plain.providerNativeInventoryRun.findFirstOrThrow({
			where: {
				instanceId,
				workKey: workKey as NativeInventoryWorkKey,
				activeSlotKey: { not: null },
			},
		});
		let claim: NativeInventoryRunClaim | undefined;
		const pageSize = instanceId === JELLYFIN ? 2_000 : 500;
		for (let ordinal = 1; ordinal <= 2; ordinal++) {
			resourceCheck();
			const startedAt = performance.now();
			const claimed = await claimDueNativeInventoryRun(f.plain, run.id, new Date());
			if (claimed.status !== "acquired")
				throw new Error(`fixture-seed: native claim ${claimed.status}`);
			claim = claimed.claim;
			expect(
				(
					await beginNativeInventoryPass(
						f.plain,
						claim,
						{
							catalogIdentity: "synthetic-stable-catalog",
							domains: domains.map(([domain]) => ({ domain, scopeKeys: ["catalog"] })),
						},
						new Date(),
					)
				).status,
			).toBe("recorded");
			for (const [domain, total] of domains) {
				for (let start = 0; start < total; start += pageSize) {
					resourceCheck();
					if (claim.leaseUntil.getTime() - Date.now() < 30_000) {
						const renewed = await renewNativeInventoryRunLease(f.plain, claim, new Date());
						if (renewed.status !== "renewed")
							throw new Error(`fixture-seed: renewal ${renewed.status}`);
						claim = renewed.claim;
					}
					const rows = Array.from({ length: Math.min(pageSize, total - start) }, (_, offset) =>
						nativeRow(domain, start + offset, instanceId === JELLYFIN ? 125 : 25),
					);
					const next = start + rows.length;
					const rawNativeIds = rows.map((row) => row.nativeId);
					const comparisonKeys = rows.map((row) => `${row.mediaType}:${row.nativeId}`);
					// Serialized input size is independently bounded; it is not a V8
					// retained-heap measurement. Only this page's inputs exist here.
					const serializedPageBytes = Buffer.byteLength(
						JSON.stringify({ rows, rawNativeIds, comparisonKeys }),
					);
					maxSerializedPageBytes = Math.max(maxSerializedPageBytes, serializedPageBytes);
					if (serializedPageBytes > 4 * 1024 ** 2)
						throw new Error("fixture-resource-bound: serialized native page exceeds 4 MiB");
					const result = await commitNativeInventoryPage(
						f.plain,
						claim,
						{
							domain,
							scopeKey: "catalog",
							pageKey: String(start),
							nextCursor: next === total ? null : String(next),
							isLast: next === total,
							expectedRawCount: total,
							rawNativeIds,
							comparisonKeys,
						},
						rows,
						new Date(),
					);
					if (result.status !== "recorded") throw new Error(`fixture-seed: page ${result.status}`);
					pageCommits++;
					stageInputs += rows.length;
				}
			}
			expect(
				(await completeNativeInventoryPass(f.plain, claim, "synthetic-stable-catalog", new Date()))
					.status,
			).toBe("completed");
			emit({
				category: "synthetic-mixed-native-seed-pass",
				provider: instance.service,
				workKey,
				ordinal,
				pageCommits,
				stageInputs,
				maxSerializedPageBytes,
				elapsedMs: performance.now() - startedAt,
				resources: resourceCheck(),
			});
		}
		if (!claim) throw new Error("fixture-seed: missing final claim");
		expect((await publishNativeInventoryRun(f.plain, claim, new Date())).status).toBe("published");
	}
	const heads = await f.plain.providerNativeInventorySnapshot.findMany({
		orderBy: [{ instanceId: "asc" }, { domain: "asc" }],
		include: { publishedPass: true },
	});
	const physical = await Promise.all(
		heads.map(async (head) => ({
			instanceId: head.instanceId,
			domain: head.domain,
			advertised: head.itemCount,
			passOrdinal: head.publishedPass?.ordinal,
			passBacked: Boolean(head.publishedPassId),
			physical: await f.plain.providerNativeInventoryStageItem.count({
				where: { passId: head.publishedPassId!, domain: head.domain },
			}),
		})),
	);
	const counts = {
		pageCommits,
		stageInputs,
		maxSerializedPageBytes,
		physical,
		stageRows: await f.plain.providerNativeInventoryStageItem.count(),
		receipts: await f.plain.providerNativeInventoryPageReceipt.count(),
		legacyRows: await f.plain.providerNativeInventoryItem.count(),
	};
	emit({ category: "synthetic-mixed-native-publication", ...counts });
	expect(pageCommits).toBe(246);
	expect(stageInputs).toBe(325_000);
	expect(counts).toMatchObject({ stageRows: 325_000, receipts: 246, legacyRows: 0 });
	expect(physical).toEqual([
		{
			instanceId: JELLYFIN,
			domain: "episode",
			advertised: 125_000,
			passOrdinal: 2,
			passBacked: true,
			physical: 125_000,
		},
		{
			instanceId: JELLYFIN,
			domain: "library",
			advertised: 10_000,
			passOrdinal: 2,
			passBacked: true,
			physical: 10_000,
		},
		{
			instanceId: PLEX,
			domain: "episode",
			advertised: 25_000,
			passOrdinal: 2,
			passBacked: true,
			physical: 25_000,
		},
		{
			instanceId: PLEX,
			domain: "library",
			advertised: 2_500,
			passOrdinal: 2,
			passBacked: true,
			physical: 2_500,
		},
	]);
	return counts;
}

async function seedNativeWatch(f: ScopedWriteFixture, resourceCheck: () => unknown) {
	const startedAt = performance.now();
	const head = await f.plain.providerNativeInventorySnapshot.findUniqueOrThrow({
		where: { instanceId_domain: { instanceId: JELLYFIN, domain: "episode" } },
	});
	if (!head.publishedPassId) throw new Error("fixture-watch-seed: missing native episode pass");
	const status = await f.plain.cacheRefreshStatus.findUniqueOrThrow({
		where: { instanceId_cacheType: { instanceId: JELLYFIN, cacheType: "jellyfin_episode" } },
	});
	if (!status.generationId) throw new Error("fixture-watch-seed: missing canonical generation");
	const users = ["synthetic-viewer-a", "synthetic-viewer-b"].map((user) =>
		createHash("sha256")
			.update(JSON.stringify(["jellyfin-user", user]))
			.digest("hex"),
	);
	const hashes = users.map(() => createHash("sha256"));
	const libraries = new Set<string>();
	const run = await f.plain.providerObservationRun.create({
		// Accepted repository-fixture boundary: a completed synthetic collection.
		// The production publisher, not direct pointer insertion, grants visibility.
		data: {
			instanceId: JELLYFIN,
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			authorityKey: "synthetic-native-watch-authority",
			targetDigest: head.contentDigest!,
			targetCount: head.itemCount,
			connectionGeneration: 1,
			identityGeneration: 1,
			state: "complete",
			totalUnits: users.length * head.scopeCount * 2,
			completedUnits: users.length * head.scopeCount * 2,
			totalWork: head.itemCount * users.length * 2,
			completedWork: head.itemCount * users.length * 2,
			completedAt: status.lastRefreshedAt,
		},
	});
	let catalogueRows = 0;
	let cursor: string | undefined;
	for (;;) {
		resourceCheck();
		const page = await f.plain.providerNativeInventoryStageItem.findMany({
			where: {
				passId: head.publishedPassId,
				domain: "episode",
				...(cursor ? { nativeId: { gt: cursor } } : {}),
			},
			orderBy: { nativeId: "asc" },
			take: 500,
		});
		if (page.length === 0) break;
		for (const row of page) {
			const ids: string[] = JSON.parse(row.libraryIds);
			expect(ids).toEqual(["catalog"]);
			libraries.add(ids[0]!);
		}
		for (const [userIndex, userKeyDigest] of users.entries()) {
			const data = page.map((row, offset) => {
				const played = (catalogueRows + offset) % 4 === userIndex;
				const candidate = {
					instanceId: JELLYFIN,
					runId: run.id,
					userKeyDigest,
					libraryId: "catalog",
					jellyfinId: row.nativeId,
					seriesId: row.parentNativeId!,
					seasonNumber: row.seasonNumber!,
					episodeNumber: row.episodeNumber!,
					played,
					playCount: played ? 1 : 0,
					lastPlayedAt: played ? status.lastRefreshedAt : null,
					observedAt: status.lastRefreshedAt,
					connectionGeneration: 1,
					identityGeneration: 1,
				};
				hashes[userIndex]!.update(`${JSON.stringify(candidate)}\n`);
				return candidate;
			});
			await f.plain.jellyfinNativeWatchRow.createMany({ data });
		}
		catalogueRows += page.length;
		cursor = page.at(-1)!.nativeId;
	}
	expect(catalogueRows).toBe(125_000);
	expect(catalogueRows).toBe(head.itemCount);
	expect(libraries.size).toBe(head.scopeCount);
	const expectedScopeCount = users.length * libraries.size;
	await f.plain.jellyfinNativeWatchScopeReceipt.createMany({
		data: users.map((userKeyDigest, index) => ({
			instanceId: JELLYFIN,
			runId: run.id,
			userKeyDigest,
			libraryId: "catalog",
			expectedRawCount: catalogueRows,
			observedRawCount: catalogueRows,
			exact: true,
			contentFingerprint: hashes[index]!.digest("hex"),
			observedAt: status.lastRefreshedAt,
			connectionGeneration: 1,
			identityGeneration: 1,
		})),
	});
	const groups = await f.plain.jellyfinNativeWatchRow.groupBy({
		by: ["userKeyDigest", "played"],
		where: { instanceId: JELLYFIN, runId: run.id },
		_count: { _all: true },
	});
	for (const user of users) {
		expect(groups.find((group) => group.userKeyDigest === user && group.played)?._count._all).toBe(
			31_250,
		);
		expect(groups.find((group) => group.userKeyDigest === user && !group.played)?._count._all).toBe(
			93_750,
		);
	}
	await f.plain.$transaction((tx) =>
		publishPreparedNativeWatchGeneration(tx, {
			userId: OWNER,
			instanceId: JELLYFIN,
			runId: run.id,
			cacheGenerationId: status.generationId!,
			connectionGeneration: 1,
			identityGeneration: 1,
			observedAt: status.lastRefreshedAt,
			expectedScopeCount,
			candidateCount: catalogueRows * users.length,
			receiptCount: expectedScopeCount,
		}),
	);
	const instance = await f.plain.serviceInstance.findUniqueOrThrow({ where: { id: JELLYFIN } });
	const attempt = await beginProviderCacheRefreshAttempt(
		f.plain,
		"jellyfin_episode_positive",
		createProviderPublicationAuthority(instance),
	);
	if (!attempt) throw new Error("fixture-watch-seed: positive attempt refused");
	const positiveObservedAt = new Date();
	await f.plain.$transaction((tx) =>
		publishJellyfinPositiveWatchGeneration(tx, {
			instance,
			attempt,
			generationId: "synthetic-native-positive-overlay",
			observedAt: positiveObservedAt,
			candidates: [
				{
					userKeyDigest: users[0]!,
					libraryId: "catalog",
					jellyfinId: "episode-000002",
					seriesId: "series-000001",
					seasonNumber: 1,
					episodeNumber: 3,
					played: true,
					playCount: 1,
					lastPlayedAt: positiveObservedAt,
				},
			],
		}),
	);
	const counts = {
		catalogueRows,
		users: users.length,
		libraries: libraries.size,
		expectedScopeCount,
		watchRows: await f.plain.jellyfinNativeWatchRow.count(),
		scopeRows: await f.plain.jellyfinNativeWatchScopeReceipt.count(),
		overlayRows: await f.plain.jellyfinPositiveWatchRow.count(),
		observedAt: status.lastRefreshedAt.toISOString(),
		positiveObservedAt: positiveObservedAt.toISOString(),
	};
	emit({
		category: "synthetic-mixed-native-watch-publication",
		...counts,
		elapsedMs: performance.now() - startedAt,
		resources: resourceCheck(),
	});
	expect(counts).toMatchObject({
		watchRows: 250_000,
		scopeRows: 2,
		overlayRows: 1,
		expectedScopeCount: 2,
	});
	return counts;
}

function observeSql(f: ScopedWriteFixture) {
	let sessionMetadataWrites = 0;
	let maxBulkTransactions = 0;
	const bulk = new Set<Database.Database>();
	const prepare = Database.prototype.prepare;
	vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
		this: Database.Database,
		sql,
	) {
		const statement = prepare.call(this, sql);
		if (this.name !== f.path) return statement;
		handles.add(this);
		const db = this;
		let bindings: unknown[] = [];
		const bind = statement.bind;
		Reflect.set(statement, "bind", function (this: typeof statement, ...args: unknown[]) {
			const result = Reflect.apply(bind, this, args);
			bindings = args.flat();
			return result;
		});
		for (const method of ["all", "run"] as const) {
			const invoke = statement[method];
			Reflect.set(statement, method, function (this: typeof statement, ...args: unknown[]) {
				const start = performance.now();
				const result = Reflect.apply(invoke, this, args);
				const elapsedMs = performance.now() - start;
				const unquoted = sql.replace(/["`]/g, "");
				if (/^\s*UPDATE\s+(?:main\.)?sessions\s/i.test(unquoted)) sessionMetadataWrites++;
				const trace = scope.getStore();
				if (trace) {
					const table =
						/\b(?:FROM|UPDATE|INTO)\s+(?:main\.)?([a-zA-Z_][a-zA-Z_0-9]*)/i.exec(unquoted)?.[1] ??
						"transaction-or-other";
					trace.sql[table] ??= {
						calls: 0,
						elapsedMs: 0,
						rows: 0,
						countCalls: 0,
						changedRows: 0,
					};
					const stats = trace.sql[table]!;
					stats.calls++;
					stats.elapsedMs += elapsedMs;
					const countOnly = /^\s*SELECT\s+COUNT\s*\(/i.test(unquoted);
					if (countOnly) stats.countCalls++;
					else if (Array.isArray(result)) stats.rows += result.length;
					if (method === "run") stats.changedRows += result.changes;
					if (
						/\b(?:plex_cache|jellyfin_cache|plex_episode_cache|jellyfin_episode_cache)\b/.test(
							unquoted,
						) &&
						Array.isArray(result) &&
						result.length > 0 &&
						!countOnly &&
						db.inTransaction
					) {
						bulk.add(db);
						maxBulkTransactions = Math.max(maxBulkTransactions, bulk.size);
					}
					if (
						trace.category === "poster" &&
						table === "library_cache" &&
						/\bServiceInstance\b/.test(unquoted) &&
						["userId", "enabled", "service"].every((column) =>
							new RegExp(`\\b${column}\\s*=\\s*\\?`).test(unquoted),
						) &&
						[OWNER, RADARR, "RADARR", 1].every((value) => bindings.includes(value)) &&
						Array.isArray(result)
					)
						trace.ownedEnabledPosterRows += result.length;
				}
				if (/^\s*(?:COMMIT|ROLLBACK)\s*;?\s*$/i.test(sql)) bulk.delete(db);
				return result;
			});
		}
		return statement;
	});
	return {
		get sessionMetadataWrites() {
			return sessionMetadataWrites;
		},
		get maxBulkTransactions() {
			return maxBulkTransactions;
		},
		get activeBulkTransactions() {
			return bulk.size;
		},
	};
}

describe("real mixed-provider cached-read scale composition", { timeout: 300_000 }, () => {
	// Catches blank/invalid positive progress, wrong native backing/counts/ARR
	// links, lost native watch/supersession, empty Insights, failed cached
	// responses, or bypassed owned/enabled poster lookup.
	it("admits native watch, canonical positives and populated Insights in a Library-dependent poster-first 121-GET cohort", async () => {
		const startedAt = performance.now();
		const f = await createScopedWriteFixture();
		fixture = f;
		let maxDatabaseBytes = 0;
		let maxProcessMemoryBytes = 0;
		let maxRssBytes = 0;
		let lastProcessMemory: ReturnType<typeof process.memoryUsage> | undefined;
		const resourceCheck = (seeding = true) => {
			const databaseBytes = readdirSync(f.directory).reduce(
				(total, name) => total + statSync(join(f.directory, name)).size,
				0,
			);
			const memory = process.memoryUsage();
			lastProcessMemory = memory;
			const processMemoryBytes = memory.heapUsed + memory.external;
			maxDatabaseBytes = Math.max(maxDatabaseBytes, databaseBytes);
			maxProcessMemoryBytes = Math.max(maxProcessMemoryBytes, processMemoryBytes);
			maxRssBytes = Math.max(maxRssBytes, memory.rss);
			if (databaseBytes > 5 * 1024 ** 3 || memory.rss > 4 * 1024 ** 3)
				throw new Error(
					"fixture-resource-bound: disposable database exceeds 5 GiB or process RSS exceeds 4 GiB",
				);
			if (seeding && performance.now() - startedAt > 240_000)
				throw new Error("fixture-seed-budget: 240-second seed budget exhausted");
			return {
				databaseBytes,
				heapUsed: memory.heapUsed,
				external: memory.external,
				rss: memory.rss,
				processMemoryBytes,
				maxDatabaseBytes,
				maxProcessMemoryBytes,
				maxRssBytes,
				retainedFixtureInputHeap: "UNKNOWN",
			};
		};
		const observer = observeSql(f);
		let canonical: Awaited<ReturnType<typeof seedCanonical>> | undefined;
		let native: Awaited<ReturnType<typeof seedNative>> | undefined;
		let nativeWatch: Awaited<ReturnType<typeof seedNativeWatch>> | undefined;
		try {
			canonical = await seedCanonical(f);
			emit({
				category: "synthetic-mixed-canonical-seed",
				...canonical,
				elapsedMs: performance.now() - startedAt,
				resources: resourceCheck(),
			});
			native = await seedNative(f, resourceCheck);
			nativeWatch = await seedNativeWatch(f, resourceCheck);
		} catch (error) {
			emit({
				category: "synthetic-mixed-seed-failure",
				error: error instanceof Error ? error.message : "unknown",
				canonical,
				native,
				nativeWatch,
				elapsedMs: performance.now() - startedAt,
				maxDatabaseBytes,
				maxProcessMemoryBytes,
				maxRssBytes,
				lastProcessMemory,
			});
			throw error;
		}
		const token = "synthetic-mixed-session";
		await f.plain.session.create({
			data: {
				id: createHash("sha256").update(token).digest("hex"),
				userId: OWNER,
				expiresAt: new Date(Date.now() + 3_600_000),
			},
		});
		const log: FastifyBaseLogger = pino(
			{ level: "info" },
			{
				write(line) {
					const record = JSON.parse(line);
					const trace = scope.getStore();
					if (!trace) return;
					if (record.category === "provider-inventory-read-subphase")
						trace.nativeSubphases.push({
							stage: record.stage,
							outcome: record.outcome,
							elapsedMs: record.elapsedMs,
						});
					if (record.category === "provider-inventory-read-timing") {
						const { readAdmissionMs, repositoryMs, releaseMs, postReadMs, totalMs, outcome } =
							record;
						trace.nativeTiming = {
							readAdmissionMs,
							repositoryMs,
							releaseMs,
							postReadMs,
							totalMs,
							outcome,
						};
					}
					if (record.category === "provider-inventory-runtime-timing")
						trace.nativeRuntime = record.stages;
				},
			},
		);
		const app = Fastify({ loggerInstance: log });
		const sessions = new SessionService(
			f.client.prisma,
			{ SESSION_COOKIE_NAME: "fixture_session" } as ApiEnv,
			app.log,
		);
		let providerIo = 0;
		let syntheticSeerrReads = 0;
		const posterIds = new Set<number>();
		const selectedPosterIds = new Set<number>();
		vi.stubGlobal("fetch", () => {
			providerIo++;
			throw new Error("Unexpected upstream socket in cache-only composition");
		});
		const inflight: Promise<unknown>[] = [];
		try {
			app.decorate("prisma", f.client.prisma);
			app.decorate("dbProvider", "sqlite");
			app.decorate("restoreRuntime", f.runtime);
			app.decorate("sessionService", sessions);
			app.decorate(
				"arrClientFactory",
				new Proxy({} as FastifyInstance["arrClientFactory"], {
					get(target, property, receiver) {
						if (property === "rawRequest")
							return async (
								instance: { id: string; userId: string; service: string; enabled: boolean },
								path: string,
								options: unknown,
							) => {
								if (instance.id === SEERR) {
									expect(instance).toMatchObject({
										id: SEERR,
										service: "SEERR",
									});
									// ROOT-approved external boundary. Real SeerrClient parses
									// this response; no provider sockets or cached route output.
									expect(path).toBe("/api/v1/request?take=50&skip=0&filter=available");
									expect(options).toEqual({
										method: "GET",
										body: undefined,
										timeout: 10000,
										headers: undefined,
									});
									syntheticSeerrReads++;
									const timestamp = new Date(Date.now() - 90 * 86400000).toISOString();
									const result = seerrPageResultSchema(seerrRequestSchema).parse({
										pageInfo: { pages: 1, pageSize: 50, results: 20, page: 1 },
										results: Array.from({ length: 20 }, (_, index) => ({
											id: index + 1,
											status: 2,
											createdAt: timestamp,
											updatedAt: timestamp,
											type: "movie",
											is4k: false,
											serverId: 1,
											profileId: 1,
											rootFolder: "/synthetic-movies",
											media: {
												id: index + 1,
												tmdbId: index + 1,
												status: 5,
												createdAt: timestamp,
												updatedAt: timestamp,
											},
											requestedBy: {
												id: 1,
												displayName: "Synthetic requester",
												createdAt: timestamp,
												updatedAt: timestamp,
												permissions: 0,
												requestCount: 20,
												userType: 1,
											},
											seasons: [],
										})),
									});
									return Response.json(result);
								}
								expect(instance).toMatchObject({
									id: RADARR,
									userId: OWNER,
									service: "RADARR",
									enabled: true,
								});
								expect(options).toEqual({ method: "GET", timeout: 5000, redirect: "error" });
								const match = /^\/MediaCover\/([1-9]\d*)\/poster\.jpg$/.exec(path);
								if (!match) throw new Error("Unexpected synthetic poster path");
								const id = Number(match[1]);
								expect(selectedPosterIds.has(id)).toBe(true);
								expect(posterIds.has(id)).toBe(false);
								posterIds.add(id);
								return new Response(Buffer.from(POSTER_JPEG, "base64"), {
									headers: { "content-type": "image/jpeg" },
								});
							};
						if (typeof property === "string" && property.startsWith("create"))
							return () => {
								providerIo++;
								throw new Error("Unexpected provider client in cache-only composition");
							};
						return Reflect.get(target, property, receiver);
					},
				}),
			);
			app.decorateRequest("currentUser", null);
			app.decorateRequest("sessionToken", null);
			await app.register(fastifyCookie, {
				secret: "synthetic-only-mixed-signing-secret",
				hook: "onRequest",
			});
			registerSessionValidationHook(app);
			app.addHook("preHandler", async (request, reply) => {
				if (!request.currentUser) return reply.status(401).send({ error: "Unauthenticated" });
			});
			app.addHook("preClose", async () => sessions.closeValidationAdmission());
			app.addHook("onClose", async () => sessions.drainValidations());
			await app.register(registerProviderInventoryRoutes);
			await app.register(registerFetchRoutes);
			await app.register(registerImageProxyRoutes);
			await app.register(registerInsightsRoutes);
			for (const [register, prefix] of [
				[registerJellyfinOnDeck, "/jellyfin/on-deck"],
				[registerJellyfinRecent, "/jellyfin/recently-added"],
				[registerJellyfinWatch, "/jellyfin/watch-enrichment"],
				[registerJellyfinProgress, "/jellyfin/series-progress"],
				[registerPlexOnDeck, "/plex/on-deck"],
				[registerPlexRecent, "/plex/recently-added"],
				[registerPlexWatch, "/plex/watch-enrichment"],
				[registerPlexProgress, "/plex/series-progress"],
				[registerSectionRoutes, "/plex/sections"],
			] as const)
				await app.register(register, { prefix });
			await app.ready();
			const cookie = `fixture_session=${encodeURIComponent(app.signCookie(token))}`;
			const traces: Trace[] = [];
			const measured = (category: string, url: string) => {
				const trace: Trace = {
					category,
					index: traces.length,
					startedAtMs: performance.now(),
					nativeSubphases: [],
					sql: {},
					ownedEnabledPosterRows: 0,
				};
				traces.push(trace);
				const request = scope
					.run(trace, () =>
						withRuntimeReadTiming(
							() =>
								f.runtime.runOperation(() =>
									app.inject({ method: "GET", url, headers: { cookie } }),
								),
							(runtime) => {
								trace.runtime = runtime;
							},
						),
					)
					.then((response) => {
						trace.wallMs = performance.now() - trace.startedAtMs;
						trace.status = response.statusCode;
						return { trace, response };
					});
				inflight.push(request);
				return request;
			};
			const burstStartedAt = performance.now();
			const cpu = process.cpuUsage();
			// Browser cards can launch only after the real Library page arrives.
			// Then posters precede ancillary work, unlike the old ancillary-first
			// cohort. No held callback, warm-up, retry, sleep, fake auth or fake SQL.
			const dashboardRequests = [
				measured("jellyfin-on-deck", "/jellyfin/on-deck"),
				measured("jellyfin-recent", "/jellyfin/recently-added?limit=20"),
				measured("plex-on-deck", "/plex/on-deck"),
				measured("plex-recent", "/plex/recently-added?limit=20"),
			];
			const libraryRequest = measured("ordinary-library", "/library?limit=100");
			const library = await libraryRequest;
			const page = library.response.json();
			emit({
				category: "synthetic-ordinary-library-dependency",
				status: library.response.statusCode,
				items: page.items?.length,
				pagination: page.pagination,
				quiObservationStatus: page.quiObservationStatus,
			});
			expect(library.response.statusCode).toBe(200);
			expect(page.items).toHaveLength(100);
			expect(page.pagination).toMatchObject({ totalItems: 2_000, limit: 100 });
			expect(page.quiObservationStatus).toMatchObject({ status: "not_configured" });
			for (const item of page.items) {
				expect(item).toMatchObject({ instanceId: RADARR, service: "radarr", type: "movie" });
				expect(item.poster).toMatch(/^\/api\/library\/poster\//);
				selectedPosterIds.add(item.id);
			}
			expect(selectedPosterIds.size).toBe(100);
			const requests = [
				...dashboardRequests,
				libraryRequest,
				// Mirror Next's /api/* rewrite without changing the returned URL's
				// route parameters or cache-version query.
				...page.items.map((item: { poster: string }) =>
					measured("poster", item.poster.slice("/api".length)),
				),
				...[42, 43].flatMap((id) => [
					measured(`jellyfin-watch-${id}`, `/jellyfin/watch-enrichment?tmdbIds=${id}&types=movie`),
					measured(`plex-watch-${id}`, `/plex/watch-enrichment?tmdbIds=${id}&types=movie`),
					measured(`jellyfin-progress-${id}`, `/jellyfin/series-progress?tmdbIds=${id}`),
					measured(`plex-progress-${id}`, `/plex/series-progress?tmdbIds=${id}`),
					measured("plex-sections", "/plex/sections"),
				]),
				measured(
					"jellyfin-library",
					`/library/provider-inventory?instanceId=${JELLYFIN}&domain=library&limit=100`,
				),
				measured(
					"plex-library",
					`/library/provider-inventory?instanceId=${PLEX}&domain=library&limit=100`,
				),
				measured(
					"jellyfin-episode",
					`/library/provider-inventory?instanceId=${JELLYFIN}&domain=episode&limit=100`,
				),
				measured("insights-disk-waste", "/library/insights/disk-waste"),
				measured("insights-watched-monitored", "/library/insights/watched-monitored"),
				measured("insights-requested-unwatched", "/library/insights/requested-unwatched"),
			];
			const results = await Promise.all(requests);
			const cpuMicroseconds = process.cpuUsage(cpu);
			const summary = {
				category: "synthetic-mixed-provider-composition",
				canonical,
				native,
				nativeWatch,
				requestCount: results.length,
				arrivalPattern: "ordinary-page-dependent; posters before ancillary/native reads",
				wallMs: performance.now() - burstStartedAt,
				cpuMicroseconds,
				resources: resourceCheck(false),
				statusCounts: results.reduce<Record<string, number>>((counts, { response }) => {
					counts[response.statusCode] = (counts[response.statusCode] ?? 0) + 1;
					return counts;
				}, {}),
				requests: results.map(({ trace, response }) => {
					if (trace.category === "poster")
						return {
							...trace,
							proof: {
								bytes: response.rawPayload.length,
								contentType: response.headers["content-type"],
							},
						};
					const body = response.json();
					return {
						...trace,
						proof: {
							status: body.status,
							freshness: body.freshness,
							complete: body.complete,
							itemCount: body.itemCount,
							selectedRows: body.rows?.length,
							matchedRows: body.rows?.filter(
								(row: { connection: { status: string } }) => row.connection.status === "matched",
							).length,
							items: Array.isArray(body.items) ? { count: body.items.length } : body.items,
							progress: body.progress,
							sections: body.sections?.length,
							catalog: body.catalog,
							evidence: body.evidence,
							providerStatus: body.providerStatus,
							insights: body.data,
							nativeWatchStates:
								trace.category === "jellyfin-episode"
									? body.rows?.map((row: { nativeId: string; watch?: unknown }) => ({
											nativeId: row.nativeId,
											watch: row.watch,
										}))
									: undefined,
						},
					};
				}),
				sessionMetadataWrites: observer.sessionMetadataWrites,
				maxBulkTransactions: observer.maxBulkTransactions,
				posterDeliveries: posterIds.size,
				providerIo,
				syntheticSeerrReads,
				realSeerrNetworkLatency: "UNKNOWN: synthetic external response boundary",
				inclusiveRuntimeSpansOverlap: true,
				nativeWatchEvidence:
					"2 users / 1 native catalogue library; 250000 rows / 2 scopes / 1 newer positive",
				expected: {
					nativePage: { watched: 51, unwatched: 49, currentLowerBound: 1, lastKnownExact: 99 },
					insights: {
						diskWasteItems: 10,
						diskWasteGiB: 110,
						watchedMonitoredItems: 10,
						requestedUnwatchedItems: 10,
					},
					canonicalProgress: {
						jellyfin42: 29,
						jellyfin43: 28,
						plex42: 4,
						plex43: 4,
						total: null,
						watchedSemantics: "lower-bound",
					},
				},
				qaOutcome: "UNKNOWN: synthetic selected cohort; prior ordinary QA failure remains valid",
				omitted: [
					"other Dashboard requests",
					"statistics",
					"streams",
					"background writers/jobs",
					"exact QA arrival timings and other peer requests",
					"configured qUI publication/counts",
					"QA host capacity",
					"browser delivery",
				],
			};
			// Preserve statuses/observations before genuine route or seed assertions.
			const { requests: requestRecords, ...aggregate } = summary;
			for (const request of requestRecords) emit({ category: "synthetic-mixed-request", request });
			emit(aggregate);
			expect(canonical).toEqual({
				arr: 2_000,
				jellyfin: 10_000,
				plex: 2_500,
				jellyfinEpisodes: 57,
				plexEpisodes: 3_251,
			});
			expect(results).toHaveLength(121);
			for (const { trace, response } of results) {
				expect(response.statusCode, trace.category).toBe(200);
				expect(trace.runtime?.["lane-wait"].count, trace.category).toBeGreaterThan(0);
				if (trace.category === "poster") {
					expect(response.headers["content-type"]).toContain("image/jpeg");
					expect(response.rawPayload.length).toBeGreaterThan(0);
					expect(response.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
					expect(trace.ownedEnabledPosterRows).toBe(1);
					continue;
				}
				const body = response.json();
				if (trace.category === "ordinary-library") {
					expect(body.items).toHaveLength(100);
					expect(body.pagination.totalItems).toBe(2_000);
				} else if (trace.category.startsWith("insights-")) {
					expect(body.success).toBe(true);
					expect(body.data).toMatchObject({ hasPlexData: true, hasWatchData: true });
					expect(body.data.items).toHaveLength(10);
					const watched = trace.category === "insights-watched-monitored";
					expect(
						body.data.items
							.map((item: { arrItemId: number }) => item.arrItemId)
							.sort((a: number, b: number) => a - b),
					).toEqual(
						watched ? [2, 4, 6, 8, 10, 12, 14, 16, 18, 20] : [1, 3, 5, 7, 9, 11, 13, 15, 17, 19],
					);
					for (const item of body.data.items) {
						expect(item).toMatchObject({ instanceId: RADARR, service: "radarr" });
						if (watched)
							expect(item).toMatchObject({
								watchCount: 2,
								watchCountSemantics: "lower-bound",
								lastWatchedAt: null,
							});
						else expect(item.watchState).toBe("unwatched");
						if (trace.category === "insights-requested-unwatched")
							expect(item.requestedBy).toBe("Synthetic requester");
					}
					if (!watched) {
						expect(body.data.unknownItems).toEqual([]);
						expect(body.data.watchStatus).toBe("complete");
						expect(body.data.limited).toBe(false);
					}
					if (trace.category === "insights-disk-waste")
						expect(body.data.totalWastedBytes).toBe(110 * 1024 ** 3);
					if (trace.category === "insights-requested-unwatched")
						expect(body.data).toMatchObject({ hasSeerrData: true, requestStatus: "complete" });
					expect(trace.sql.plex_cache?.rows).toBeGreaterThan(0);
					expect(trace.sql.jellyfin_cache?.rows).toBeGreaterThan(0);
				} else if (trace.category.endsWith("on-deck") || trace.category.endsWith("recent")) {
					expect(body.items.length).toBeGreaterThan(0);
					if (trace.category.endsWith("recent")) expect(body.items).toHaveLength(20);
				} else if (trace.category.includes("-watch-")) {
					const id = trace.category.endsWith("42") ? 42 : 43;
					expect(body.items[`movie:${id}`]).toMatchObject({
						watchCount: 2,
						watchCountSemantics: "exact",
						instanceId: trace.category.startsWith("plex") ? PLEX : JELLYFIN,
					});
				} else if (trace.category.includes("-progress-")) {
					const id = trace.category.endsWith("42") ? 42 : 43;
					const watched = trace.category.startsWith("plex") ? 4 : id === 42 ? 29 : 28;
					expect(body.progress[id]).toEqual({
						status: "partial",
						total: null,
						watched,
						percent: null,
						watchedSemantics: "lower-bound",
					});
				} else if (trace.category === "plex-sections") {
					expect(body.sections).toHaveLength(2);
					expect(body.catalog.availability).toBe("current");
				} else {
					const episode = trace.category === "jellyfin-episode";
					const itemCount = episode
						? 125_000
						: trace.category === "jellyfin-library"
							? 10_000
							: 2_500;
					expect(body).toMatchObject({
						status: "available",
						freshness: "current",
						complete: true,
						itemCount,
					});
					expect(body.rows).toHaveLength(100);
					expect(trace.nativeTiming).toMatchObject({ outcome: "available" });
					expect(trace.sql.provider_native_inventory_stage_items?.rows).toBeGreaterThanOrEqual(100);
					if (episode) {
						expect(trace.sql.jellyfin_native_watch_rows?.rows).toBe(200);
						expect(trace.sql.jellyfin_native_watch_scope_receipts?.rows).toBeGreaterThanOrEqual(2);
						expect(trace.sql.jellyfin_positive_watch_rows?.rows).toBe(1);
					}
					for (const row of body.rows) {
						expect(row.connection.status).toBe("matched");
						expect(row.connection.arrItems.length).toBeGreaterThan(0);
						const arr = row.connection.arrItems[0];
						expect(arr.instanceId).toBe(episode || row.mediaType === "series" ? SONARR : RADARR);
						if (episode) {
							expect(row.parentNativeId).toBe("series-000001");
							expect(row.seasonNumber).toBe(1);
							expect(row.episodeNumber).toBeGreaterThanOrEqual(1);
							expect(row.episodeNumber).toBeLessThanOrEqual(100);
							expect(arr.arrItemId).toBe(1);
							const index = row.episodeNumber - 1;
							expect(row.watch).toEqual(
								index === 2
									? {
											state: "watched",
											freshness: "current",
											valueSemantics: "lower-bound",
											observedAt: nativeWatch!.positiveObservedAt,
										}
									: {
											state: index % 4 < 2 ? "watched" : "unwatched",
											freshness: "last-known",
											valueSemantics: "exact",
											observedAt: nativeWatch!.observedAt,
										},
							);
						} else
							expect(row.nativeId).toBe(
								`${row.mediaType}-${String(arr.arrItemId).padStart(6, "0")}`,
							);
					}
				}
			}
			expect(posterIds.size).toBe(100);
			expect(providerIo).toBe(0);
			expect(syntheticSeerrReads).toBe(1);
			expect(observer.maxBulkTransactions).toBeGreaterThan(0);
			expect(observer.maxBulkTransactions).toBeLessThanOrEqual(2);
			expect(observer.activeBulkTransactions).toBe(0);
			expect(f.losses).toEqual([]);
		} finally {
			await Promise.allSettled(inflight);
			await app.close();
			await sessions.drainValidations();
			emit({
				category: "synthetic-mixed-session-drain",
				sessionMetadataWrites: observer.sessionMetadataWrites,
				joinedRequests: inflight.length,
				appClosed: true,
				maxDatabaseBytes,
				maxProcessMemoryBytes,
				maxRssBytes,
			});
		}
	});
});
