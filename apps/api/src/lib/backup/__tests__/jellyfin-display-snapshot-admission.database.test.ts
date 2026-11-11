import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	recordScopedWriteEvidence,
	type ScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import {
	readOwnedJellyfinEpisodeDisplaySources,
	readOwnedJellyfinLibraryAndEpisodeDisplaySources,
	readOwnedJellyfinLibraryDisplaySources,
} from "../../jellyfin/jellyfin-display-evidence.js";
import * as displayWork from "../../jellyfin/jellyfin-display-work.js";
import { fingerprintJellyfinEpisodeParentDependency } from "../../jellyfin/jellyfin-episode-parent-dependency.js";
import {
	type JellyfinEvidencePrisma,
	type JellyfinLibraryRow,
	readOwnedJellyfinObservation,
} from "../../jellyfin/jellyfin-evidence-repository.js";
import {
	encodeJellyfinEpisodeGenerationMetadata,
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinEpisodeRows,
	fingerprintJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
	type JellyfinLibraryGenerationMetadataV1,
} from "../../jellyfin/jellyfin-generation-metadata.js";
import { readOwnedGenerationScopedEpisodeDisplay } from "../../jellyfin/jellyfin-generation-scoped-display.js";
import { withIsolatedRuntimePrismaBulkReadClient } from "../restore-runtime-client.js";

afterEach(closeScopedWriteFixtures);

function signal() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function seed(f: ScopedWriteFixture) {
	const observedAt = new Date("2026-09-02T12:00:00.000Z");
	const rows: (JellyfinLibraryRow & { mediaType: "series" })[] = [
		{
			id: "synthetic-display-row",
			instanceId: "synthetic-jellyfin",
			tmdbId: 42,
			mediaType: "series",
			libraryId: "synthetic-library",
			libraryName: "Synthetic",
			title: "Synthetic",
			jellyfinId: "synthetic-series",
			lastWatchedAt: observedAt,
			watchCount: 1,
			watchedByUsers: '["synthetic-viewer"]',
			onDeck: false,
			userRating: null,
			collections: "[]",
			addedAt: observedAt,
			thumb: null,
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	];
	const receipt = (provider: "jellyfin" | "jellyfin_episode", count: number) => ({
		version: 1 as const,
		provider,
		attemptStartedAt: observedAt.toISOString(),
		observedAt: observedAt.toISOString(),
		evidence: "complete" as const,
		units: [
			{
				scopeKey: "synthetic-scope",
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
	});
	const metadata: JellyfinLibraryGenerationMetadataV1 = {
		version: 1,
		provider: "jellyfin",
		cacheType: "jellyfin",
		publicationLevel: "authoritative",
		completeness: "complete",
		canonicalizationVersion: 1,
		itemCount: 1,
		connectionGeneration: 1,
		identityGeneration: 1,
		contentFingerprint: fingerprintJellyfinLibraryRows(rows),
		coverageReceipt: receipt("jellyfin", 1),
	};
	await f.plain.jellyfinCache.createMany({ data: rows });
	const common = {
		instanceId: "synthetic-jellyfin",
		lastRefreshedAt: observedAt,
		lastResult: "success",
		lastAttemptAt: observedAt,
		lastAttemptResult: "success",
		connectionGeneration: 1,
		identityGeneration: 1,
	};
	await f.plain.cacheRefreshStatus.create({
		data: {
			...common,
			cacheType: "jellyfin",
			generationId: "synthetic-parent",
			itemCount: 1,
			generationMetadata: encodeJellyfinLibraryGenerationMetadata(metadata),
		},
	});
	const episodeMetadata = encodeJellyfinEpisodeGenerationMetadata({
		version: 4,
		storage: "generation-scoped",
		sourceVersion: 2,
		provider: "jellyfin",
		cacheType: "jellyfin_episode",
		publicationLevel: "authoritative",
		completeness: "complete",
		canonicalizationVersion: 1,
		itemCount: 0,
		connectionGeneration: 1,
		identityGeneration: 1,
		parentLibraryGenerationId: "synthetic-parent",
		parentLibraryMetadataFingerprint: fingerprintJellyfinLibraryGenerationMetadata(metadata),
		parentLibraryDependencyFingerprint: fingerprintJellyfinEpisodeParentDependency(
			"synthetic-jellyfin",
			metadata,
			rows,
		)!,
		contentFingerprint: fingerprintJellyfinEpisodeRows([]),
		coverageReceipt: receipt("jellyfin_episode", 0),
	});
	await f.plain.cacheRefreshStatus.create({
		data: {
			...common,
			cacheType: "jellyfin_episode",
			generationId: "synthetic-episodes",
			itemCount: 0,
			generationMetadata: episodeMetadata,
		},
	});
	await f.plain.providerObservationRun.create({
		data: {
			id: "synthetic-episodes",
			instanceId: "synthetic-jellyfin",
			provider: "jellyfin",
			cacheType: "jellyfin_episode",
			authorityKey: "synthetic",
			targetDigest: "synthetic",
			targetCount: 0,
			connectionGeneration: 1,
			identityGeneration: 1,
			state: "published",
			totalUnits: 0,
			totalWork: 0,
		},
	});
	await f.plain.jellyfinEpisodePreparation.create({
		data: {
			runId: "synthetic-episodes",
			instanceId: "synthetic-jellyfin",
			generationId: "synthetic-episodes",
			token: "synthetic",
			leaseExpiresAt: observedAt,
			state: "published",
			expectedRowCount: 0,
			contentFingerprint: fingerprintJellyfinEpisodeRows([]),
			observedAt,
		},
	});
	return observedAt;
}

describe("Jellyfin display snapshot admission", { timeout: 20_000 }, () => {
	it("returns both standalone results with one guarded parent-library read", async () => {
		const f = await createScopedWriteFixture();
		const now = await seed(f);
		const input = {
			userId: "synthetic-user",
			instances: [{ id: "synthetic-jellyfin", label: "Synthetic", service: "JELLYFIN" as const }],
			showTmdbIds: [42],
			now,
		};
		let parentSelects = 0;
		const prepare = Database.prototype.prepare;
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			if (this.name === f.path && /^\s*SELECT\b/i.test(sql) && /\bjellyfin_cache\b/i.test(sql)) {
				parentSelects++;
			}
			return prepare.call(this, sql);
		});
		const standalone = await f.runtime.runOperation(() =>
			withIsolatedRuntimePrismaBulkReadClient(
				f.client.prisma,
				async (prisma) => ({
					library: await readOwnedJellyfinLibraryDisplaySources({ ...input, prisma }),
					episodes: await readOwnedJellyfinEpisodeDisplaySources({ ...input, prisma }),
				}),
				{ lease: "phase" },
			),
		);
		expect(parentSelects).toBe(2);
		parentSelects = 0;
		const paired = await f.runtime.runOperation(() =>
			withIsolatedRuntimePrismaBulkReadClient(
				f.client.prisma,
				(prisma) => readOwnedJellyfinLibraryAndEpisodeDisplaySources({ ...input, prisma }),
				{ lease: "phase" },
			),
		);
		expect(parentSelects).toBe(1);
		expect(paired).toEqual(standalone);
		expect(paired.library.sources[0]?.rows).toHaveLength(1);
		expect(paired.episodes.providerStatus?.availability).toBe("partial");
		expect(f.losses).toEqual([]);
	});

	it("batches 200 missing show receipts through the guarded SQLite reader", async () => {
		const f = await createScopedWriteFixture();
		const now = await seed(f);
		let receiptSelects = 0;
		const prepare = Database.prototype.prepare;
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			if (
				this.name === f.path &&
				/^\s*SELECT\b/i.test(sql) &&
				sql.includes("jellyfin_episode_generation_show_receipts")
			)
				receiptSelects++;
			return prepare.call(this, sql);
		});
		const result = await f.runtime.runOperation(() =>
			withIsolatedRuntimePrismaBulkReadClient(
				f.client.prisma,
				(prisma) =>
					readOwnedGenerationScopedEpisodeDisplay({
						prisma,
						userId: "synthetic-user",
						instanceId: "synthetic-jellyfin",
						showTmdbIds: Array.from({ length: 200 }, (_, index) => index + 1),
						now,
					}),
				{ lease: "phase" },
			),
		);
		expect(result).toMatchObject({
			available: true,
			rows: [],
			mutationAvailable: false,
			authority: null,
			providerStatus: { availability: "partial", evidence: "positive-only" },
		});
		expect(result?.providerStatus.reasonCodes).toContain("coverage-incomplete");
		expect(receiptSelects).toBe(1);
		expect(f.losses).toEqual([]);
	});

	it.each(["library", "v4-health"] as const)(
		"releases both bulk lanes while %s display validation is pending",
		async (mode) => {
			const f = await createScopedWriteFixture();
			const now = await seed(f);
			const entered = signal(),
				release = signal();
			let pending = 0;
			const native = new Set<Database.Database>();
			const prepare = Database.prototype.prepare;
			vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
				this: Database.Database,
				sql,
			) {
				if (this.name === f.path && this !== f.writer) native.add(this);
				return prepare.call(this, sql);
			});
			const checkpoint = displayWork.createJellyfinDisplayCheckpoint;
			// Pause only display scheduling. Native transactions, admission and ownership guards stay real.
			vi.spyOn(displayWork, "createJellyfinDisplayCheckpoint").mockImplementation(() => {
				const next = checkpoint();
				let first = true;
				return () => {
					if (!first) return next();
					first = false;
					if (++pending === 2) entered.resolve();
					return release.promise;
				};
			});
			const reads = [0, 1].map(() =>
				f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaBulkReadClient(
						f.client.prisma,
						(reader) =>
							mode === "library"
								? readOwnedJellyfinObservation({
										prisma: reader as unknown as JellyfinEvidencePrisma,
										userId: "synthetic-user",
										instanceId: "synthetic-jellyfin",
										cacheType: "jellyfin",
										mode: "display",
										now,
									})
								: readOwnedGenerationScopedEpisodeDisplay({
										prisma: reader,
										userId: "synthetic-user",
										instanceId: "synthetic-jellyfin",
										showTmdbIds: [],
										now,
									}),
						{ lease: "phase" },
					),
				),
			);
			try {
				await entered.promise;
				expect(native.size).toBeGreaterThanOrEqual(2);
				expect([...native].every((db) => !db.inTransaction)).toBe(true);
				const progressed = await f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaBulkReadClient(
						f.client.prisma,
						(reader) => reader.serviceInstance.count({ where: { userId: "synthetic-user" } }),
						{ lease: "phase" },
					),
				);
				expect(progressed).toBe(2);
				release.resolve();
				for (const result of await Promise.all(reads)) {
					expect(result).toMatchObject({
						available: true,
						mutationAvailable: false,
						authority: null,
					});
					expect(result?.rows).toHaveLength(mode === "library" ? 1 : 0);
				}
				recordScopedWriteEvidence(`display-snapshot-${mode}`, {
					pendingDisplays: 2,
					nativeTransactionsWhileValidationPending: 0,
					bulkReadProgressBeforeRelease: true,
					providerIo: 0,
				});
			} finally {
				release.resolve();
				await Promise.allSettled(reads);
				await f.client.close();
				expect([...native].every((db) => !db.open)).toBe(true);
				recordScopedWriteEvidence(`display-snapshot-${mode}-closure`, {
					nativeHandles: native.size,
					nativeHandlesClosedBeforeRemoval: [...native].every((db) => !db.open),
					losses: f.losses,
				});
			}
			expect(f.losses).toEqual([]);
		},
	);
});
