import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import {
	claimObservationUnit,
	createOrLoadObservationRun,
} from "../../provider-observation/observation-run-repository.js";
import type { OwnedProviderPublicationSnapshot } from "../../services/provider-identity-guard.js";
import { createProviderPublicationAuthority } from "../../services/provider-identity-guard.js";
import { PlexAuthorityService } from "../plex-authority-service.js";
import { refreshPlexCache } from "../plex-cache-refresher.js";
import type { PlexClient, PlexLibraryItem } from "../plex-client.js";
import { createPositivePlexEpisodeDigest } from "../plex-episode-live-collector.js";
import { planPlexEpisodeRefresh } from "../plex-episode-refresh-plan.js";
import {
	type FinalizePlexEpisodeRunInput,
	finalizePlexEpisodeRun,
	stagePlexEpisodeUnit,
} from "../plex-episode-refresh-repository.js";
import { loadPositiveEpisodeDisplayEvidence } from "../plex-evidence-repository.js";
import { readPlexGenerationTargetsForSelection } from "../plex-generation-target-ledger.js";
import { projectPlexNativeEpisodeWatchPage } from "../plex-native-episode-watch-projection.js";
import { encodePlexPositiveEpisodeGenerationMetadata } from "../plex-positive-episode-generation-metadata.js";
import { plexConnectionFingerprint } from "../service-instance-fingerprint.js";

const transport = vi.hoisted(() => ({ client: undefined as PlexClient | undefined }));
vi.mock("../plex-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../plex-client.js")>()),
	PlexClient: class {
		constructor() {
			if (!transport.client) throw new Error("Unconfigured test transport");
			Object.assign(this, transport.client);
		}
	},
}));
vi.mock("../../services/service-identity.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../services/service-identity.js")>()),
	readProviderIdentity: async () => ({ service: "PLEX", rawIdentity: "test-plex" }),
}));

const log = pino({ enabled: false });
let directory: string;
let prisma: ReturnType<typeof createTestPrismaClient>;

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "plex-parent-reuse-"));
	const path = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${path}` },
		stdio: "ignore",
	});
	prisma = createTestPrismaClient(path);
}, 30_000);

afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

async function fixture(positiveOnly = false, itemCount = 1) {
	const userId = randomUUID();
	await prisma.user.create({ data: { id: userId, username: userId } });
	const row = await prisma.serviceInstance.create({
		data: {
			userId,
			service: "PLEX",
			label: "Test Plex",
			baseUrl: "https://plex.invalid",
			encryptedApiKey: "test-cipher",
			encryptionIv: "test-iv",
			expectedIdentity: "test-plex",
			identityStatus: "VERIFIED",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityVerifiedAt: new Date(),
			connectionGeneration: 2,
			identityGeneration: 3,
		},
	});
	const instance: OwnedProviderPublicationSnapshot = {
		...createProviderPublicationAuthority(row),
		label: row.label,
		apiKey: "test-token",
	};
	const items: PlexLibraryItem[] = [
		...Array.from({ length: itemCount }, (_, index) => ({
			ratingKey: `show-${index + 1}`,
			title: `Test show ${index + 1}`,
			type: "show",
			viewCount: 2,
			Guid: [{ id: `tmdb://${index + 42}` }, { id: `tvdb://${index + 99}` }],
		})),
		...(positiveOnly ? [{ ratingKey: "unmapped", title: "Unmapped", type: "show", Guid: [] }] : []),
	];
	const client = {
		getActivities: vi.fn(async () => []),
		getLibrarySettlementSections: vi.fn(async () => [
			{
				key: "shows",
				uuid: "shows-uuid",
				title: "Shows",
				type: "show",
				refreshing: false,
				scannedAt: 1,
				updatedAt: 2,
			},
		]),
		getAccounts: vi.fn(async () => [{ id: 1, name: "Test account" }]),
		getLibrarySections: vi.fn(async () => [{ key: "shows", title: "Shows", type: "show" }]),
		getLibraryItemsWithCoverage: vi.fn(async () => ({
			items,
			expectedRawCount: items.length,
			pagesAttempted: 1,
			pagesCompleted: 1,
			rawObserved: items.length,
			reason: null,
		})),
		getHistory: vi.fn(async () => []),
		verifyHistorySnapshot: vi.fn(async () => undefined),
		getOnDeck: vi.fn(async () => []),
	} as unknown as PlexClient;
	transport.client = client;
	const refresh = () => {
		transport.client = client;
		return refreshPlexCache({ prisma, instance, log });
	};
	const status = () =>
		prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "plex" } },
		});
	return { instance, refresh, status, client, items };
}

async function publishChild(f: Awaited<ReturnType<typeof fixture>>) {
	const parent = await f.status();
	const metadata = JSON.parse(parent.generationMetadata!);
	const observedAt = new Date();
	const unit = {
		scopeKey: "plex-episode-unit:0",
		expectedRawCount: null,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: 1,
		sourceBindings: 1,
		canonicalEntities: 1,
		acceptedSkips: [],
		fatalCount: 0,
	};
	const episode = {
		instanceId: f.instance.id,
		showTmdbId: 42,
		seasonNumber: 1,
		episodeNumber: 1,
		ratingKey: "episode-1",
		title: "Test episode",
		watched: true,
		watchCount: 2,
		watchedByUsers: "[]",
		lastWatchedAt: null,
		refreshedAt: observedAt,
		sourceFingerprint: plexConnectionFingerprint(f.instance),
		connectionGeneration: 2,
		identityGeneration: 3,
	};
	await prisma.plexEpisodeCache.create({ data: episode });
	await prisma.cacheRefreshStatus.create({
		data: {
			instanceId: f.instance.id,
			cacheType: "plex_episode",
			generationId: "child-generation",
			lastRefreshedAt: observedAt,
			lastResult: "success",
			itemCount: 1,
			lastAttemptAt: observedAt,
			lastAttemptResult: "partial",
			connectionGeneration: 2,
			identityGeneration: 3,
			generationMetadata: encodePlexPositiveEpisodeGenerationMetadata({
				version: 5,
				publicationLevel: "positive-only",
				completeness: "partial",
				itemCount: 1,
				canonicalizationVersion: 1,
				capability: {
					domain: "episodes",
					field: "watchCount",
					semantics: "lower-bound",
					operator: "greater_than",
				},
				parentPlexGenerationId: parent.generationId!,
				parentMetadataVersion: 6,
				parentPublicationLevel: metadata.publicationLevel,
				parentTargetDigest: metadata.targetDigest,
				episodeDigest: createPositivePlexEpisodeDigest(
					[
						{
							instanceId: f.instance.id,
							generationId: parent.generationId!,
							showTmdbId: 42,
							sectionId: "shows",
							sectionUuid: "shows-uuid",
							mediaType: "series",
							tvdbId: 99,
							ratingKey: "show-1",
						},
					],
					[episode],
				),
				partialReasons: [],
				connectionGeneration: 2,
				identityGeneration: 3,
				coverageReceipt: {
					version: 2,
					provider: "plex_episode",
					attemptStartedAt: observedAt.toISOString(),
					observedAt: observedAt.toISOString(),
					evidence: "positive-only",
					units: [unit],
					publishedCanonicalEntities: 1,
					domains: (["episode-inventory", "watch-count"] as const).map((domain) => ({
						domain,
						evidence: "positive-only" as const,
						valueSemantics: "lower-bound" as const,
						units: [unit],
						publishedCanonicalEntities: 1,
					})),
				},
			}),
		},
	});
	return () =>
		loadPositiveEpisodeDisplayEvidence(prisma, {
			userId: f.instance.userId,
			instanceId: f.instance.id,
		});
}

async function publishDurableChild(
	f: Awaited<ReturnType<typeof fixture>>,
	testHooks?: FinalizePlexEpisodeRunInput["testHooks"],
) {
	const parent = await f.status();
	const targets = await readPlexGenerationTargetsForSelection(prisma, {
		instanceId: f.instance.id,
		generationId: parent.generationId!,
	});
	const plan = planPlexEpisodeRefresh(
		targets
			.filter((t) => t.mediaType === "series")
			.map(({ tmdbId, ...t }) => ({ ...t, mediaType: "series" as const, showTmdbId: tmdbId })),
	);
	const attemptedAt = new Date();
	const attempt = { attemptedAt, resultMarker: `in_progress:${randomUUID()}` };
	const status = {
		lastAttemptAt: attemptedAt,
		lastAttemptResult: attempt.resultMarker,
		connectionGeneration: 2,
		identityGeneration: 3,
	};
	await prisma.cacheRefreshStatus.upsert({
		where: { instanceId_cacheType: { instanceId: f.instance.id, cacheType: "plex_episode" } },
		create: {
			instanceId: f.instance.id,
			cacheType: "plex_episode",
			lastRefreshedAt: attemptedAt,
			lastResult: "error",
			itemCount: 0,
			...status,
		},
		update: status,
	});
	const run = await createOrLoadObservationRun(prisma, {
		authority: {
			provider: "plex_episode",
			cacheType: "plex_episode",
			instanceId: f.instance.id,
			parentGenerationId: parent.generationId!,
			targetDigest: plan.targetDigest,
			connectionGeneration: 2,
			identityGeneration: 3,
		},
		units: plan.units.map((unit) => ({
			ordinal: unit.ordinal,
			scopeKey: unit.scopeKey,
			scopeDigest: unit.scopeDigest,
			phase: "collect" as const,
			expectedTargets: unit.targets.length,
		})),
	});
	for (const unit of plan.units) {
		const claim = await claimObservationUnit(prisma, { runId: run.id, now: attemptedAt });
		if (!claim) throw new Error("Missing unit claim");
		const target = unit.targets.find((t) => t.showTmdbId === 42);
		const rows = target
			? [
					{
						instanceId: f.instance.id,
						showTmdbId: 42,
						parentRatingKey: target.ratingKey,
						seasonNumber: 1,
						episodeNumber: 1,
						ratingKey: "episode-1",
						title: "Test episode",
						watched: true,
						watchedByUsers: "[]",
						lastWatchedAt: null,
						watchCount: 2,
						refreshedAt: attemptedAt,
						sourceFingerprint: plexConnectionFingerprint(f.instance),
					},
				]
			: [];
		expect(
			await stagePlexEpisodeUnit(prisma, claim, unit, {
				complete: true,
				rows,
				refreshedTargets: unit.targets.length,
			}),
		).toBe(true);
	}
	const result = await finalizePlexEpisodeRun({
		prisma,
		userId: f.instance.userId,
		instance: await prisma.serviceInstance.findUniqueOrThrow({ where: { id: f.instance.id } }),
		runId: run.id,
		plexAuthority: null,
		attempt,
		now: new Date(),
		testHooks,
	});
	expect(result).toEqual({ published: true, itemCount: 1 });
	expect(await prisma.plexEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(0);
	return prisma.cacheRefreshStatus.findUniqueOrThrow({
		where: { instanceId_cacheType: { instanceId: f.instance.id, cacheType: "plex_episode" } },
	});
}

async function retainedFixture(positive = false) {
	const f = await fixture(positive);
	await f.refresh();
	const child = await publishDurableChild(f);
	f.items[0]!.title = "Changed title";
	await f.refresh();
	const input = { userId: f.instance.userId, instanceId: f.instance.id };
	const authority = new PlexAuthorityService({ prisma, log });
	return {
		...f,
		child,
		authority,
		input,
		read: () => authority.readPositiveEpisodeDisplayEvidence(input),
	};
}

describe("Plex identical parent publication on disposable SQLite", () => {
	it("retains a real positive publication for display after a changed parent replaces the ledger", async () => {
		// Removing durable parent proof or using the current generation for the old digest must fail this boundary.
		const f = await fixture(false, 201);
		await f.refresh();
		const parent = await f.status();
		const child = await publishDurableChild(f);
		const authority = new PlexAuthorityService({ prisma, log });
		const input = { userId: f.instance.userId, instanceId: f.instance.id };
		expect(await authority.readPositiveEpisodeEvidence(input)).toMatchObject({
			available: true,
			rows: [{ ratingKey: "episode-1", lowerBound: 2 }],
		});
		f.items[0]!.title = "Renamed current show";
		await f.refresh();
		expect((await f.status()).generationId).not.toBe(parent.generationId);
		expect(
			await prisma.plexGenerationTarget.count({
				where: { instanceId: f.instance.id, generationId: parent.generationId! },
			}),
		).toBe(0);
		const ledgerReads = vi.spyOn(prisma.plexGenerationTarget, "findMany");
		const display = await authority.readPositiveEpisodeDisplayEvidence(input).finally(() => {
			const queries = [...ledgerReads.mock.calls];
			ledgerReads.mockRestore();
			expect(queries).toHaveLength(1);
			expect(queries[0]?.[0]?.where).toEqual({ instanceId: f.instance.id });
		});
		expect(display).toMatchObject({
			available: true,
			provenance: {
				parentPlexGenerationId: parent.generationId,
				publishedAt: child.lastRefreshedAt.toISOString(),
			},
			rows: [{ ratingKey: "episode-1", watched: true }],
			evidence: { availability: "last-known", authority: "unavailable" },
		});
		expect(await authority.readPositiveEpisodeEvidence(input)).toMatchObject({ available: false });
		const projected = projectPlexNativeEpisodeWatchPage({
			rows: [
				{
					nativeId: "episode-1",
					mediaType: "episode",
					libraryIds: ["shows"],
					parentNativeId: "show-1",
					seasonNumber: 1,
					episodeNumber: 1,
					title: "Test episode",
				},
				{
					nativeId: "absent",
					mediaType: "episode",
					libraryIds: ["shows"],
					parentNativeId: "show-1",
					seasonNumber: 1,
					episodeNumber: 2,
					title: "Absent",
				},
			],
			parents: [
				{
					nativeId: "show-1",
					mediaType: "series",
					libraryIds: ["shows"],
					parentNativeId: null,
					seasonNumber: null,
					episodeNumber: null,
					title: "Renamed current show",
					externalIds: { tmdb: [42] },
				},
			],
			evidence: display,
			inventoryFreshness: "current",
			parentFreshness: "current",
			inventoryObservedAt: new Date(),
			parentObservedAt: new Date(),
		});
		expect(projected.get("episode-1")).toEqual({
			state: "watched",
			freshness: "last-known",
			valueSemantics: "lower-bound",
			observedAt: child.lastRefreshedAt.toISOString(),
		});
		expect(projected.get("absent")?.state).toBe("unknown");
	});

	it.each([false, true])(
		"retains display under active and failed attempts without renewing age (positive parent: %s)",
		async (positive) => {
			const f = await retainedFixture(positive);
			for (const cacheType of ["plex", "plex_episode"]) {
				const before = await prisma.cacheRefreshStatus.findUniqueOrThrow({
					where: { instanceId_cacheType: { instanceId: f.instance.id, cacheType } },
				});
				for (const lastAttemptResult of ["in_progress:new-attempt", "error"]) {
					await prisma.cacheRefreshStatus.update({
						where: { id: before.id },
						data: { lastAttemptAt: new Date(), lastAttemptResult },
					});
					expect(await f.read()).toMatchObject({
						available: true,
						provenance: { publishedAt: f.child.lastRefreshedAt.toISOString() },
						evidence: { availability: "last-known", authority: "unavailable" },
						rows: [{ ratingKey: "episode-1" }],
					});
				}
				await prisma.cacheRefreshStatus.update({
					where: { id: before.id },
					data: {
						lastAttemptAt: before.lastAttemptAt,
						lastAttemptResult: before.lastAttemptResult,
					},
				});
			}
			expect(
				await f.authority.readPositiveEpisodeDisplayEvidence({
					...f.input,
					maxAgeMs: 0,
					now: new Date(f.child.lastRefreshedAt.getTime() + 1_000),
				}),
			).toMatchObject({ available: false });
		},
	);

	it.each([
		"removed",
		"native parent reassigned",
		"TVDB changed",
		"section UUID changed",
		"ambiguous duplicate",
	])("withholds retained rows when the current target is %s", async (change) => {
		const f = await retainedFixture();
		if (change === "removed") f.items.splice(0, 1);
		if (change === "native parent reassigned") f.items[0]!.ratingKey = "replacement-show";
		if (change === "TVDB changed") f.items[0]!.Guid = [{ id: "tmdb://42" }, { id: "tvdb://100" }];
		if (change === "section UUID changed")
			vi.mocked(f.client.getLibrarySettlementSections).mockResolvedValue([
				{
					key: "shows",
					uuid: "replacement-uuid",
					title: "Shows",
					type: "show",
					refreshing: false,
					scannedAt: 1,
					updatedAt: 2,
				},
			]);
		if (change === "ambiguous duplicate")
			f.items.push({ ...f.items[0]!, ratingKey: "duplicate-copy" });
		await f.refresh();
		const display = await f.read();
		expect(display).toMatchObject({
			available: true,
			rows: [],
			evidence: { availability: "last-known", authority: "unavailable" },
		});
		expect(await f.authority.readPositiveEpisodeEvidence(f.input)).toMatchObject({
			available: false,
		});
	});

	it("rejects malformed or unbound retained proof and independently checks episode rows", async () => {
		const f = await retainedFixture();
		const raw = f.child.generationMetadata!;
		const changes = [
			[
				"missing proof",
				(m: ReturnType<typeof JSON.parse>) => {
					delete m.parentProof;
				},
			],
			[
				"extra proof field",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.extra = true;
				},
			],
			[
				"malformed parent",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.metadata.roots[0].digest = "invalid";
				},
			],
			[
				"wrong instance",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.instanceId = "other-instance";
				},
			],
			[
				"cross-instance target",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.targets[0].instanceId = "other-instance";
				},
			],
			[
				"cross-generation target",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.targets[0].generationId = "other-generation";
				},
			],
			[
				"wrong section",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.targets[0].sectionUuid = "other-section";
				},
			],
			[
				"missing target",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.targets = [];
				},
			],
			[
				"surplus target",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.targets.push({ ...m.parentProof.targets[0], ratingKey: "surplus" });
				},
			],
			[
				"duplicate target",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.targets.push(m.parentProof.targets[0]);
				},
			],
			[
				"wrong count",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.metadata.targetCount++;
				},
			],
			[
				"wrong target digest",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.metadata.targetDigest = "0".repeat(64);
				},
			],
			[
				"wrong episode digest",
				(m: ReturnType<typeof JSON.parse>) => {
					m.episodeDigest = "0".repeat(64);
				},
			],
			[
				"wrong fingerprint",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.sourceFingerprint = "0".repeat(64);
				},
			],
			[
				"wrong provider identity",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.providerIdentity = "other-server";
				},
			],
			[
				"wrong identity generation",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.identityGeneration++;
				},
			],
			[
				"wrong connection",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.connectionGeneration++;
				},
			],
			[
				"future parent",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.publishedAt = m.parentProof.attemptedAt = new Date(
						Date.now() + 86_400_000,
					).toISOString();
				},
			],
			[
				"unbound attempt",
				(m: ReturnType<typeof JSON.parse>) => {
					m.parentProof.attemptedAt = new Date(
						Date.parse(m.parentProof.publishedAt) - 1,
					).toISOString();
				},
			],
			[
				"wrong receipt time",
				(m: ReturnType<typeof JSON.parse>) => {
					m.coverageReceipt.observedAt = new Date(
						Date.parse(m.coverageReceipt.observedAt) + 1,
					).toISOString();
				},
			],
		] as const;
		for (const [label, change] of changes) {
			const metadata = JSON.parse(raw);
			change(metadata);
			await prisma.cacheRefreshStatus.update({
				where: { id: f.child.id },
				data: { generationMetadata: JSON.stringify(metadata) },
			});
			expect((await f.read()).available, label).toBe(false);
		}
		await prisma.cacheRefreshStatus.update({
			where: { id: f.child.id },
			data: { generationMetadata: raw },
		});
		const row = await prisma.plexEpisodeCache.findFirstOrThrow({
			where: { instanceId: f.instance.id },
		});
		for (const data of [
			{ watchCount: 0 },
			{ watchCount: 3 },
			{ ratingKey: "changed-episode" },
			{ sourceFingerprint: "0".repeat(64) },
			{ connectionGeneration: 9 },
			{ identityGeneration: 9 },
			{ refreshedAt: new Date(Date.now() + 86_400_000) },
		]) {
			await prisma.plexEpisodeCache.update({ where: { id: row.id }, data });
			expect((await f.read()).available, JSON.stringify(data)).toBe(false);
			await prisma.plexEpisodeCache.update({
				where: { id: row.id },
				data: {
					watchCount: row.watchCount,
					ratingKey: row.ratingKey,
					sourceFingerprint: row.sourceFingerprint,
					connectionGeneration: row.connectionGeneration,
					identityGeneration: row.identityGeneration,
					refreshedAt: row.refreshedAt,
				},
			});
		}
		await prisma.cacheRefreshStatus.update({ where: { id: f.child.id }, data: { itemCount: 2 } });
		expect((await f.read()).available).toBe(false);
		await prisma.cacheRefreshStatus.update({ where: { id: f.child.id }, data: { itemCount: 1 } });
		expect((await f.read()).available).toBe(true);
	});

	it("expires the original parent proof even when the episode and current parent are fresh", async () => {
		const f = await retainedFixture();
		const metadata = JSON.parse(f.child.generationMetadata!);
		const episodeTime = f.child.lastRefreshedAt.getTime();
		const original = new Date(episodeTime - 120_000).toISOString();
		metadata.parentProof.publishedAt = original;
		metadata.parentProof.attemptedAt = original;
		metadata.parentProof.metadata.coverageReceipt.observedAt = original;
		metadata.parentProof.metadata.coverageReceipt.attemptStartedAt = new Date(
			episodeTime - 120_001,
		).toISOString();
		await prisma.cacheRefreshStatus.update({
			where: { id: f.child.id },
			data: { generationMetadata: JSON.stringify(metadata) },
		});
		expect(
			await f.authority.readPositiveEpisodeDisplayEvidence({
				...f.input,
				now: new Date(episodeTime + 1_000),
				maxAgeMs: 60_000,
			}),
		).toMatchObject({ available: false });
	});

	it.each([
		"missing ledger",
		"target digest drift",
		"new ledger generation",
		"reconnection",
		"provider identity changed",
		"invalidated parent",
		"missing parent",
	])("requires a valid current owned parent: %s", async (change) => {
		const f = await retainedFixture();
		if (change === "missing ledger")
			await prisma.plexGenerationTarget.deleteMany({ where: { instanceId: f.instance.id } });
		if (change === "target digest drift")
			await prisma.plexGenerationTarget.updateMany({
				where: { instanceId: f.instance.id },
				data: { ratingKey: "drift" },
			});
		if (change === "new ledger generation")
			await prisma.plexGenerationTarget.updateMany({
				where: { instanceId: f.instance.id },
				data: { generationId: "drift" },
			});
		if (change === "reconnection")
			await prisma.serviceInstance.update({
				where: { id: f.instance.id },
				data: { connectionGeneration: 4 },
			});
		if (change === "provider identity changed")
			await prisma.serviceInstance.update({
				where: { id: f.instance.id },
				data: { expectedIdentity: "other-provider" },
			});
		if (change === "invalidated parent")
			await prisma.cacheRefreshStatus.update({
				where: { instanceId_cacheType: { instanceId: f.instance.id, cacheType: "plex" } },
				data: { lastResult: "error" },
			});
		if (change === "missing parent")
			await prisma.cacheRefreshStatus.delete({
				where: { instanceId_cacheType: { instanceId: f.instance.id, cacheType: "plex" } },
			});
		expect((await f.read()).available).toBe(false);
	});

	it.each(["plex", "plex_episode", "connection"])(
		"rejects %s replacement during the ledger read",
		async (target) => {
			const f = await retainedFixture();
			const original = prisma.plexGenerationTarget.findMany.bind(prisma.plexGenerationTarget);
			const spy = vi
				.spyOn(prisma.plexGenerationTarget, "findMany")
				.mockImplementationOnce((args) => {
					const result = original(args);
					// The injected continuation changes only timing, not the Prisma read's rows.
					return result.then(async (rows) => {
						if (target === "connection")
							await prisma.serviceInstance.update({
								where: { id: f.instance.id },
								data: { encryptedApiKey: "changed-key" },
							});
						else
							await prisma.cacheRefreshStatus.update({
								where: { instanceId_cacheType: { instanceId: f.instance.id, cacheType: target } },
								data: { generationId: "replacement-head" },
							});
						return rows;
					}) as typeof result;
				});
			try {
				expect((await f.read()).available).toBe(false);
			} finally {
				spy.mockRestore();
			}
		},
	);

	it("keeps legacy V5 on its current parent but never retrofits changed-parent proof", async () => {
		const f = await fixture();
		await f.refresh();
		await publishChild(f);
		const authority = new PlexAuthorityService({ prisma, log });
		const input = { userId: f.instance.userId, instanceId: f.instance.id };
		expect((await authority.readPositiveEpisodeDisplayEvidence(input)).available).toBe(true);
		f.items[0]!.title = "New title";
		await f.refresh();
		expect((await authority.readPositiveEpisodeDisplayEvidence(input)).available).toBe(false);
	});

	it("replaces one proof on successful publication and rolls back a failed next publication", async () => {
		const f = await retainedFixture();
		const oldProof = JSON.parse(f.child.generationMetadata!).parentProof;
		const next = await publishDurableChild(f);
		const proof = JSON.parse(next.generationMetadata!).parentProof;
		expect(proof.generationId).toBe((await f.status()).generationId);
		expect(proof.generationId).not.toBe(oldProof.generationId);
		expect(proof.targets).toHaveLength(1);
		expect((await f.read()).available).toBe(true);
		f.items[0]!.title = "Another title";
		await f.refresh();
		await expect(
			publishDurableChild(f, {
				afterPublish: () => {
					throw new Error("synthetic rollback");
				},
			}),
		).rejects.toThrow("synthetic rollback");
		const after = await prisma.cacheRefreshStatus.findUniqueOrThrow({ where: { id: next.id } });
		expect(after.generationMetadata).toBe(next.generationMetadata);
		expect(after.generationId).toBe(next.generationId);
		expect(after.lastRefreshedAt).toEqual(next.lastRefreshedAt);
		expect(await f.read()).toMatchObject({
			available: true,
			provenance: { publishedAt: next.lastRefreshedAt.toISOString() },
			evidence: { availability: "last-known", authority: "unavailable" },
		});
		expect(
			await prisma.plexEpisodeObservationStage.count({
				where: { unit: { run: { instanceId: f.instance.id } } },
			}),
		).toBe(1);
	});
	it.each([false, true])(
		"keeps the bound positive child readable after unchanged settled refresh (positive parent: %s)",
		async (positive) => {
			const f = await fixture(positive);
			expect(await f.refresh()).toMatchObject({
				kind: positive ? "positive-observation" : "authoritative-snapshot",
			});
			const before = await f.status();
			const readChild = await publishChild(f);
			const initialChild = await readChild();
			expect(initialChild.available, JSON.stringify(initialChild)).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 5));
			const result = await f.refresh();
			expect(result.kind).toBe(positive ? "positive-observation" : "authoritative-snapshot");
			const after = await f.status();
			const child = await readChild();
			expect.soft(after.generationId).toBe(before.generationId);
			expect(child).toMatchObject({
				available: true,
				parentGenerationId: before.generationId,
				rows: [{ watchCount: 2 }],
				evidence: { availability: "current", authority: "positive-only" },
			});
			expect(after.lastRefreshedAt.getTime()).toBeGreaterThan(before.lastRefreshedAt.getTime());
			const fresh = JSON.parse(after.generationMetadata!);
			expect(fresh.coverageReceipt.attemptStartedAt).not.toBe(
				JSON.parse(before.generationMetadata!).coverageReceipt.attemptStartedAt,
			);
			expect(fresh.coverageReceipt.observedAt).toBe(after.lastRefreshedAt.toISOString());
			if (!initialChild.available || !child.available) throw new Error("Child unavailable");
			expect(child.publishedAt).toEqual(initialChild.publishedAt);
			expect(child.metadata.capability.semantics).toBe("lower-bound");
			// A fresh parent must not refresh the child's independent observation age.
			expect(
				await loadPositiveEpisodeDisplayEvidence(prisma, {
					userId: f.instance.userId,
					instanceId: f.instance.id,
					now: after.lastRefreshedAt,
					maxAgeMs: 0,
				}),
			).toMatchObject({
				available: false,
				evidence: { reasonCodes: ["published_generation_stale"] },
			});
		},
	);

	it.each([
		["title", "Renamed show"],
		["viewCount", 3],
		["ratingKey", "show-renamed"],
		["userRating", 8],
		["thumb", "/new-thumb"],
		["addedAt", 1_777_000_000],
		["Label", [{ tag: "New label" }]],
		["Collection", [{ tag: "New collection" }]],
		["Guid", [{ id: "tmdb://42" }, { id: "tvdb://100" }]],
	] as const)("publishes a new generation for a changed provider %s", async (field, value) => {
		const f = await fixture();
		await f.refresh();
		const before = await f.status();
		Object.assign(f.items[0]!, { [field]: value });
		expect(await f.refresh()).toMatchObject({ kind: "authoritative-snapshot" });
		expect((await f.status()).generationId).not.toBe(before.generationId);
	});

	it("retains equivalence across reordered rows and detects a persisted difference beyond row 500", async () => {
		const f = await fixture(false, 502);
		await f.refresh();
		const first = await f.status();
		f.items.reverse();
		expect(await f.refresh()).toMatchObject({
			kind: "authoritative-snapshot",
			generationId: first.generationId,
			upserted: 502,
		});
		const last = await prisma.plexCache.findFirstOrThrow({
			where: { instanceId: f.instance.id },
			orderBy: { id: "desc" },
		});
		await prisma.plexCache.update({
			where: { id: last.id },
			data: { title: "Changed after page 500" },
		});
		expect(await f.refresh()).toMatchObject({ kind: "authoritative-snapshot", upserted: 502 });
		expect((await f.status()).generationId).not.toBe(first.generationId);
		const second = await f.status();
		const lastTarget = await prisma.plexGenerationTarget.findFirstOrThrow({
			where: { instanceId: f.instance.id },
			orderBy: { id: "desc" },
		});
		await prisma.plexGenerationTarget.update({
			where: { id: lastTarget.id },
			data: { tvdbId: 9999 },
		});
		expect(await f.refresh()).toMatchObject({ kind: "authoritative-snapshot", upserted: 502 });
		expect((await f.status()).generationId).not.toBe(second.generationId);
	});

	it.each(["section uuid", "section revision", "coverage pagination", "publication level"])(
		"uses a new generation for changed %s even with identical persisted cache values",
		async (change) => {
			const f = await fixture(change === "publication level");
			await f.refresh();
			const before = await f.status();
			if (change.startsWith("section"))
				vi.mocked(f.client.getLibrarySettlementSections).mockResolvedValue([
					{
						key: "shows",
						uuid: change === "section uuid" ? "new-uuid" : "shows-uuid",
						title: "Shows",
						type: "show",
						refreshing: false,
						scannedAt: 1,
						updatedAt: change === "section revision" ? 3 : 2,
					},
				]);
			if (change === "coverage pagination")
				vi.mocked(f.client.getLibraryItemsWithCoverage).mockResolvedValue({
					items: f.items,
					expectedRawCount: 1,
					pagesAttempted: 2,
					pagesCompleted: 2,
					rawObserved: 1,
					reason: null,
				});
			if (change === "publication level") f.items.pop();
			expect(await f.refresh()).toMatchObject({ kind: "authoritative-snapshot", upserted: 1 });
			expect((await f.status()).generationId).not.toBe(before.generationId);
		},
	);

	it("reuses a verified empty universe, but repairs an extra stored row with a new generation", async () => {
		const f = await fixture(false, 0);
		expect(await f.refresh()).toMatchObject({ kind: "authoritative-snapshot", upserted: 0 });
		const first = await f.status();
		expect(await f.refresh()).toMatchObject({ generationId: first.generationId, upserted: 0 });
		await prisma.plexCache.create({
			data: {
				instanceId: f.instance.id,
				tmdbId: 42,
				mediaType: "series",
				sectionId: "shows",
				sectionTitle: "Shows",
				watchedByUsers: "[]",
				collections: "[]",
				labels: "[]",
				connectionGeneration: 2,
				identityGeneration: 3,
			},
		});
		expect(await f.refresh()).toMatchObject({ kind: "authoritative-snapshot", upserted: 0 });
		expect((await f.status()).generationId).not.toBe(first.generationId);
		expect(await prisma.plexCache.count({ where: { instanceId: f.instance.id } })).toBe(0);
	});

	it.each([
		"corrupt metadata",
		"missing metadata",
		"legacy metadata",
		"missing ledger",
		"corrupt ledger",
		"count mismatch",
		"old row binding",
	])("repairs %s through the ordinary new-generation publication", async (problem) => {
		const f = await fixture();
		await f.refresh();
		const before = await f.status();
		if (
			problem === "corrupt metadata" ||
			problem === "missing metadata" ||
			problem === "legacy metadata"
		) {
			await prisma.cacheRefreshStatus.update({
				where: { id: before.id },
				data: {
					generationMetadata:
						problem === "corrupt metadata"
							? "{"
							: problem === "missing metadata"
								? null
								: '{"sections":[]}',
				},
			});
		}
		if (problem === "missing ledger")
			await prisma.plexGenerationTarget.deleteMany({ where: { instanceId: f.instance.id } });
		if (problem === "corrupt ledger")
			await prisma.plexGenerationTarget.updateMany({
				where: { instanceId: f.instance.id },
				data: { tvdbId: 100 },
			});
		if (problem === "count mismatch")
			await prisma.cacheRefreshStatus.update({ where: { id: before.id }, data: { itemCount: 2 } });
		if (problem === "old row binding")
			await prisma.plexCache.updateMany({
				where: { instanceId: f.instance.id },
				data: { identityGeneration: 2 },
			});
		expect(await f.refresh()).toMatchObject({ kind: "authoritative-snapshot", upserted: 1 });
		const after = await f.status();
		expect(after.generationId).not.toBe(before.generationId);
		expect(after).toMatchObject({
			itemCount: 1,
			lastResult: "success",
			lastAttemptResult: "success",
		});
		expect(JSON.parse(after.generationMetadata!).version).toBe(6);
	});

	it("keeps distinct owners and instances isolated and rejects a crossed owner snapshot", async () => {
		const a = await fixture();
		const b = await fixture();
		await a.refresh();
		await b.refresh();
		const firstA = await a.status();
		const firstB = await b.status();
		expect(firstA.generationId).not.toBe(firstB.generationId);
		expect(await a.refresh()).toMatchObject({ generationId: firstA.generationId });
		expect(await b.refresh()).toMatchObject({ generationId: firstB.generationId });
		expect(
			await refreshPlexCache({
				prisma,
				instance: { ...a.instance, userId: b.instance.userId },
				log,
			}),
		).toMatchObject({ kind: "unpublished", superseded: true });
		expect((await a.status()).generationId).toBe(firstA.generationId);
		expect((await b.status()).generationId).toBe(firstB.generationId);
	});

	it("does not let a superseded attempt publish or replace the old rows", async () => {
		const f = await fixture();
		await f.refresh();
		const before = await f.status();
		vi.mocked(f.client.getAccounts).mockImplementation(async () => {
			await prisma.cacheRefreshStatus.update({
				where: { id: before.id },
				data: { lastAttemptResult: "in_progress:another-owner" },
			});
			return [{ id: 1, name: "Test account" }];
		});
		expect(await f.refresh()).toMatchObject({ kind: "unpublished", superseded: true });
		const after = await f.status();
		expect(after).toMatchObject({
			generationId: before.generationId,
			generationMetadata: before.generationMetadata,
			lastRefreshedAt: before.lastRefreshedAt,
			lastAttemptResult: "in_progress:another-owner",
		});
	});

	it("allows only the owned concurrent attempt to publish an identical generation", async () => {
		const f = await fixture();
		await f.refresh();
		const before = await f.status();
		let entered!: () => void;
		let release!: () => void;
		const collecting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(f.client.getAccounts).mockImplementation(async () => {
			entered();
			await held;
			return [{ id: 1, name: "Test account" }];
		});
		const owner = f.refresh();
		await collecting;
		try {
			expect(await f.refresh()).toMatchObject({ kind: "unpublished", superseded: true });
		} finally {
			release();
		}
		expect(await owner).toMatchObject({
			kind: "authoritative-snapshot",
			generationId: before.generationId,
		});
	});

	it("preserves the published head when fresh provider collection fails", async () => {
		const f = await fixture();
		await f.refresh();
		const before = await f.status();
		vi.mocked(f.client.getActivities).mockRejectedValue(new Error("provider unavailable"));
		expect(await f.refresh()).toMatchObject({ kind: "unpublished" });
		expect(await f.status()).toMatchObject({
			generationId: before.generationId,
			generationMetadata: before.generationMetadata,
			lastRefreshedAt: before.lastRefreshedAt,
			lastAttemptResult: "error",
		});
	});
});
