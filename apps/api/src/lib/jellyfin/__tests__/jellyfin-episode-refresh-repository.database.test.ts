import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const identityModuleMocks = vi.hoisted(() => ({
	readProviderIdentity: vi.fn(),
}));

vi.mock("../../services/service-identity.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../services/service-identity.js")>()),
	readProviderIdentity: identityModuleMocks.readProviderIdentity,
}));

import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { evaluateProviderCoverageReceipt } from "../../provider-observation/coverage-receipt.js";
import {
	claimObservationUnit,
	createOrLoadObservationRun,
	recoverAbandonedObservationRuns,
} from "../../provider-observation/observation-run-repository.js";
import {
	buildObservationActiveSlotKey,
	buildObservationAuthorityKey,
} from "../../provider-observation/observation-run-types.js";
import { reconcileInterruptedProviderCacheRefreshAttempts } from "../../services/provider-cache-status.js";
import type { JellyfinEpisodeItemsPage } from "../jellyfin-client.js";
import { createJellyfinEpisodeWorkItemRunner } from "../jellyfin-episode-cache-refresher.js";
import {
	buildJellyfinEpisodeCatalogProvenance,
	jellyfinEpisodeCatalogGenerationKey,
} from "../jellyfin-episode-catalog-provenance.js";
import {
	fingerprintJellyfinEpisodeParentDependency,
	jellyfinEpisodeParentGenerationKey,
} from "../jellyfin-episode-parent-dependency.js";
import { JELLYFIN_EPISODE_SUCCESSFUL_PROGRESS_CONTINUATION_DELAY_MS } from "../jellyfin-episode-refresh-policy.js";
import {
	buildJellyfinEpisodeScopePlan,
	finalizeJellyfinEpisodeRun,
	invalidateJellyfinEpisodeRun,
	stageJellyfinEpisodePage,
	validateJellyfinEpisodeSavedV2Plan,
	validateJellyfinEpisodeSavedV3Plan,
} from "../jellyfin-episode-refresh-repository.js";
import { readOwnedJellyfinObservation } from "../jellyfin-evidence-repository.js";
import {
	decodeJellyfinEpisodeGenerationMetadata,
	decodeJellyfinLibraryGenerationMetadata,
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
	hasAuthoritativeJellyfinLibraryReceipt,
} from "../jellyfin-generation-metadata.js";

const databases: Array<{ directory: string; prisma: ReturnType<typeof createTestPrismaClient> }> =
	[];

describe("saved V2 scope plan validation", () => {
	function fixture() {
		const parentGenerationId = jellyfinEpisodeParentGenerationKey("a".repeat(64));
		const plan = buildJellyfinEpisodeScopePlan(
			[
				{ userId: "user-1", userName: "Not persisted", libraryId: "library-1" },
				{ userId: "user-2", userName: "Not persisted", libraryId: "library-2" },
			],
			{
				parentLibraryGenerationId: "original-parent",
				parentLibraryMetadataFingerprint: "b".repeat(64),
			},
		);
		const authority = {
			provider: "jellyfin_episode" as const,
			cacheType: "jellyfin_episode" as const,
			instanceId: "jellyfin-1",
			parentGenerationId,
			targetDigest: plan.targetDigest,
			connectionGeneration: 1,
			identityGeneration: 1,
		};
		return {
			run: {
				...authority,
				authorityKey: buildObservationAuthorityKey(authority),
				activeSlotKey: buildObservationActiveSlotKey(authority),
				state: "running",
				targetCount: plan.targetCount,
				totalUnits: plan.units.length,
			},
			units: plan.units.map((unit) => ({
				...unit,
				scopePayload: unit.scopePayload ?? null,
				state: "pending",
			})),
			instanceId: authority.instanceId,
			parentGenerationId,
			connectionGeneration: 1,
			identityGeneration: 1,
		};
	}
	it("accepts an exact saved plan without returning stored display names", () => {
		const result = validateJellyfinEpisodeSavedV2Plan(fixture());
		expect(result?.scopes).toHaveLength(2);
		expect(result?.scopes.every((scope) => scope.userName === "")).toBe(true);
	});
	it.each([
		"duplicate-verify",
		"missing-unit",
		"total-units",
		"legacy-parent",
		"authority-key",
		"slot-key",
		"provenance",
		"target-digest",
		"failed-run",
	])("rejects %s", (corruption) => {
		const input = fixture();
		if (corruption === "duplicate-verify") input.units[3] = { ...input.units[2]! };
		if (corruption === "missing-unit") input.units.pop();
		if (corruption === "total-units") input.run.totalUnits++;
		if (corruption === "legacy-parent")
			input.parentGenerationId = input.run.parentGenerationId = "legacy-parent";
		if (corruption === "authority-key") input.run.authorityKey = "c".repeat(64);
		if (corruption === "slot-key") input.run.activeSlotKey = "c".repeat(64);
		if (corruption === "provenance")
			input.units[0]!.scopePayload = input.units[0]!.scopePayload!.replace(
				"original-parent",
				"another-parent",
			);
		if (corruption === "target-digest") input.run.targetDigest = "c".repeat(64);
		if (corruption === "failed-run") input.run.state = "failed";
		expect(validateJellyfinEpisodeSavedV2Plan(input)).toBeNull();
	});
});

describe("saved V3 scope plan validation", () => {
	function fixture() {
		const catalogProvenance = buildJellyfinEpisodeCatalogProvenance(
			[
				{
					tmdbId: 42,
					mediaType: "series",
					libraryId: "library-1",
					libraryName: "Shows",
					title: "Series",
					jellyfinId: "series-1",
					lastWatchedAt: null,
					watchCount: 0,
					watchedByUsers: "[]",
					onDeck: false,
					userRating: null,
					collections: "[]",
					addedAt: null,
					thumb: null,
				},
			],
			[{ userId: "user-1", libraryId: "library-1" }],
		);
		if (!catalogProvenance) throw new Error("fixture catalog provenance is invalid");
		const parentLibraryDependencyFingerprint = "a".repeat(64);
		const plan = buildJellyfinEpisodeScopePlan(
			[{ userId: "user-1", userName: "not persisted", libraryId: "library-1" }],
			{
				parentLibraryGenerationId: "parent-generation",
				parentLibraryMetadataFingerprint: "b".repeat(64),
				parentLibraryDependencyFingerprint,
				catalogProvenance,
			},
		);
		const parentGenerationId = jellyfinEpisodeCatalogGenerationKey(catalogProvenance)!;
		const authority = {
			provider: "jellyfin_episode" as const,
			cacheType: "jellyfin_episode" as const,
			instanceId: "jellyfin-1",
			parentGenerationId,
			targetDigest: plan.targetDigest,
			connectionGeneration: 1,
			identityGeneration: 1,
		};
		return {
			run: {
				...authority,
				authorityKey: buildObservationAuthorityKey(authority),
				activeSlotKey: buildObservationActiveSlotKey(authority),
				state: "running",
				targetCount: plan.targetCount,
				totalUnits: plan.units.length,
			},
			units: plan.units.map((unit) => ({
				...unit,
				scopePayload: unit.scopePayload ?? null,
				state: "pending",
			})),
			instanceId: authority.instanceId,
			parentGenerationId,
			connectionGeneration: 1,
			identityGeneration: 1,
		};
	}

	it("accepts an exact immutable V3 plan and rejects catalog provenance drift", () => {
		const input = fixture();
		expect(validateJellyfinEpisodeSavedV3Plan(input)?.scopes).toEqual([
			{ userId: "user-1", userName: "", libraryId: "library-1" },
		]);
		input.units[0]!.scopePayload = input.units[0]!.scopePayload!.replace(
			'"tmdbId":42',
			'"tmdbId":84',
		);
		expect(validateJellyfinEpisodeSavedV3Plan(input)).toBeNull();
	});
	it("accepts only claim-free failed V3 plans with a recorded failed unit", () => {
		const input = fixture();
		input.run.state = "failed";
		expect(validateJellyfinEpisodeSavedV3Plan(input)).toBeNull();
		input.units[0]!.state = "failed";
		expect(validateJellyfinEpisodeSavedV3Plan(input)).not.toBeNull();
		input.units[1]!.state = "running";
		expect(validateJellyfinEpisodeSavedV3Plan(input)).toBeNull();
		input.units[1]!.state = "pending";
		input.units[0]!.scopePayload = input.units[0]!.scopePayload!.replace(
			'"tmdbId":42',
			'"tmdbId":84',
		);
		expect(validateJellyfinEpisodeSavedV3Plan(input)).toBeNull();
	});

	it("stores one bounded catalog and small immutable references across sixteen units", () => {
		const input = fixture();
		const payload = JSON.parse(input.units[0]!.scopePayload!);
		const scopes = Array.from({ length: 8 }, (_, index) => ({
			userId: `user-${index}`,
			libraryId: "library-1",
		}));
		const catalog = {
			version: 3 as const,
			bindings: Array.from({ length: 4165 }, (_, index) => ({
				libraryId: "library-1",
				seriesId: `series-${String(index).padStart(32, "0")}`,
				tmdbId: index + 1,
			})),
			scopes,
		};
		const plan = buildJellyfinEpisodeScopePlan(
			scopes.map((scope) => ({ ...scope, userName: "" })),
			{ ...payload, catalogProvenance: catalog },
		);
		expect(plan.units).toHaveLength(16);
		expect(
			plan.units.filter((unit) => "catalogProvenance" in JSON.parse(unit.scopePayload!)),
		).toHaveLength(1);
		expect(Buffer.byteLength(plan.units[0]!.scopePayload!)).toBeLessThanOrEqual(1048576);
		for (const unit of plan.units.slice(1))
			expect(Buffer.byteLength(unit.scopePayload!)).toBeLessThanOrEqual(4096);
	});

	it("rejects a replaced non-root catalog reference without modifying its root", () => {
		const input = fixture();
		const payload = JSON.parse(input.units[1]!.scopePayload!);
		input.units[1]!.scopePayload = JSON.stringify({
			...payload,
			catalogGenerationKey: `jellyfin-episode-parent-v3:${"f".repeat(64)}`,
		});
		expect(validateJellyfinEpisodeSavedV3Plan(input)).toBeNull();
	});
});

async function database() {
	const directory = mkdtempSync(join(tmpdir(), "jellyfin-episode-stage-"));
	const dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(dbPath);
	databases.push({ directory, prisma });
	await prisma.user.create({
		data: { id: "user-1", username: `episode-${Date.now()}-${Math.random()}` },
	});
	await prisma.serviceInstance.create({
		data: {
			id: "jellyfin-1",
			userId: "user-1",
			service: "JELLYFIN",
			label: "Jellyfin",
			baseUrl: "http://jellyfin.invalid",
			encryptedApiKey: "cipher",
			encryptionIv: "iv",
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
	return prisma;
}

afterEach(async () => {
	for (const entry of databases.splice(0)) {
		await entry.prisma.$disconnect();
		rmSync(entry.directory, { recursive: true, force: true });
	}
	vi.clearAllMocks();
});

function hash(value: unknown) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function completeFinalizerFixture(prisma: Awaited<ReturnType<typeof database>>) {
	const now = new Date("2026-09-07T00:00:00.000Z");
	const attempt = { attemptedAt: now, resultMarker: "in_progress:episode-attempt" };
	const scopes = [{ userId: "user-1", userName: "Current User", libraryId: "library-1" }];
	const plan = buildJellyfinEpisodeScopePlan(scopes);
	const parentRow = {
		instanceId: "jellyfin-1",
		tmdbId: 42,
		mediaType: "series" as const,
		libraryId: "library-1",
		libraryName: "Library",
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
		connectionGeneration: 1,
		identityGeneration: 1,
	};
	const receiptUnit = {
		scopeKey: "library:library-1",
		expectedRawCount: 1,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: 1,
		sourceBindings: 1,
		canonicalEntities: 1,
		acceptedSkips: [],
		fatalCount: 0,
	};
	const metadata = encodeJellyfinLibraryGenerationMetadata({
		version: 1,
		provider: "jellyfin",
		cacheType: "jellyfin",
		publicationLevel: "authoritative",
		completeness: "complete",
		canonicalizationVersion: 1,
		itemCount: 1,
		connectionGeneration: 1,
		identityGeneration: 1,
		contentFingerprint: fingerprintJellyfinLibraryRows([parentRow]),
		coverageReceipt: {
			version: 2,
			provider: "jellyfin",
			attemptStartedAt: now.toISOString(),
			observedAt: now.toISOString(),
			evidence: "complete",
			units: [receiptUnit],
			publishedCanonicalEntities: 1,
			domains: ["library-inventory", "mapping", "watch-count", "watch-attribution", "on-deck"].map(
				(domain) => ({
					domain,
					evidence: "complete" as const,
					valueSemantics: "exact" as const,
					units: [{ ...receiptUnit, scopeKey: `${domain}:library-1` }],
					publishedCanonicalEntities: 1,
				}),
			),
		},
	});
	await prisma.jellyfinCache.create({ data: parentRow });
	await prisma.cacheRefreshStatus.createMany({
		data: [
			{
				instanceId: "jellyfin-1",
				cacheType: "jellyfin",
				lastRefreshedAt: now,
				lastResult: "success",
				itemCount: 1,
				generationId: "parent-1",
				generationMetadata: metadata,
				lastAttemptAt: now,
				lastAttemptResult: "success",
				connectionGeneration: 1,
				identityGeneration: 1,
			},
			{
				instanceId: "jellyfin-1",
				cacheType: "jellyfin_episode",
				lastRefreshedAt: now,
				lastResult: "success",
				itemCount: 1,
				generationId: "old",
				generationMetadata: "old",
				lastAttemptAt: now,
				lastAttemptResult: attempt.resultMarker,
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		],
	});
	await prisma.jellyfinEpisodeCache.create({
		data: {
			instanceId: "jellyfin-1",
			showTmdbId: 99,
			seasonNumber: 1,
			episodeNumber: 1,
			jellyfinId: "old",
			title: "Old",
			watched: false,
			watchedByUsers: "[]",
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
	const run = await createOrLoadObservationRun(prisma, {
		authority: {
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			instanceId: "jellyfin-1",
			parentGenerationId: "parent-1",
			targetDigest: plan.targetDigest,
			connectionGeneration: 1,
			identityGeneration: 1,
		},
		units: plan.units,
	});
	const units = await prisma.providerObservationUnit.findMany({
		where: { runId: run.id },
		orderBy: { ordinal: "asc" },
	});
	await prisma.providerObservationUnit.updateMany({
		where: { runId: run.id },
		data: {
			state: "complete",
			completedAt: now,
			cursor: 1,
			expectedRawCount: 1,
			observedRawCount: 1,
		},
	});
	await prisma.providerObservationRun.update({
		where: { id: run.id },
		data: { completedUnits: 2, completedWork: 1 },
	});
	const digest = hash(["jellyfin-user", "user-1"]);
	for (const unit of units) {
		await prisma.jellyfinEpisodeObservationStage.create({
			data: {
				runId: run.id,
				unitId: unit.id,
				userKeyDigest: digest,
				pass: unit.phase,
				jellyfinId: "episode-1",
				seriesId: "series-1",
				seasonNumber: 1,
				episodeNumber: 1,
				title: "Pilot",
				played: true,
				playCount: 1,
				lastPlayedAt: now,
				userName: "",
			},
		});
	}
	return { attempt, plan, run, scopes };
}

async function expectInvalidatedWithPublishedCachePreserved(
	prisma: Awaited<ReturnType<typeof database>>,
	runId: string,
) {
	expect(
		await prisma.jellyfinEpisodeCache.findMany({ where: { instanceId: "jellyfin-1" } }),
	).toEqual([expect.objectContaining({ showTmdbId: 99, jellyfinId: "old" })]);
	expect(await prisma.jellyfinEpisodeObservationStage.count({ where: { runId } })).toBe(0);
	expect(await prisma.providerObservationRun.findUnique({ where: { id: runId } })).toMatchObject({
		state: "invalidated",
		activeSlotKey: null,
	});
	expect(
		await prisma.cacheRefreshStatus.findUnique({
			where: {
				instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" },
			},
		}),
	).toMatchObject({ generationId: "old", lastResult: "success" });
}

async function bindV2Fixture(
	prisma: Awaited<ReturnType<typeof database>>,
	runId: string,
	scopes: Parameters<typeof buildJellyfinEpisodeScopePlan>[0],
) {
	const parent = await prisma.cacheRefreshStatus.findUniqueOrThrow({
		where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
	});
	const rows = await prisma.jellyfinCache.findMany({ where: { instanceId: "jellyfin-1" } });
	const decoded = decodeJellyfinLibraryGenerationMetadata(parent.generationMetadata);
	if (!decoded.ok) throw new Error("fixture parent metadata is invalid");
	if (decoded.metadata.coverageReceipt.version !== 2) throw new Error("fixture receipt must be V2");
	const inventory = decoded.metadata.coverageReceipt.domains.find(
		(domain) => domain.domain === "library-inventory",
	);
	if (!inventory) throw new Error("fixture inventory domain is missing");
	const normalizedParentMetadata = encodeJellyfinLibraryGenerationMetadata({
		...decoded.metadata,
		coverageReceipt: {
			...decoded.metadata.coverageReceipt,
			domains: decoded.metadata.coverageReceipt.domains.map((domain) =>
				domain.domain === "library-inventory"
					? {
							...domain,
							units: domain.units.map((unit) => ({
								...unit,
								scopeKey: "user:user-1/library:library-1/inventory",
							})),
						}
					: domain,
			),
		},
	});
	await prisma.cacheRefreshStatus.update({
		where: { id: parent.id },
		data: { generationMetadata: normalizedParentMetadata },
	});
	const persistedDecoded = decodeJellyfinLibraryGenerationMetadata(normalizedParentMetadata);
	if (!persistedDecoded.ok) throw new Error("normalized parent metadata is invalid");
	const provenance = {
		parentLibraryGenerationId: parent.generationId!,
		parentLibraryMetadataFingerprint: fingerprintJellyfinLibraryGenerationMetadata(
			persistedDecoded.metadata,
		),
	};
	const dependency = fingerprintJellyfinEpisodeParentDependency(
		"jellyfin-1",
		persistedDecoded.metadata,
		rows.map((row) => ({ ...row, mediaType: row.mediaType as "movie" | "series" })),
	);
	if (!dependency) throw new Error("fixture parent dependency is invalid");
	const plan = buildJellyfinEpisodeScopePlan(scopes, provenance);
	const authority = {
		provider: "jellyfin_episode" as const,
		cacheType: "jellyfin_episode" as const,
		instanceId: "jellyfin-1",
		parentGenerationId: jellyfinEpisodeParentGenerationKey(dependency),
		targetDigest: plan.targetDigest,
		connectionGeneration: 1,
		identityGeneration: 1,
	};
	await prisma.providerObservationRun.update({
		where: { id: runId },
		data: {
			parentGenerationId: authority.parentGenerationId,
			targetDigest: plan.targetDigest,
			targetCount: plan.targetCount,
			authorityKey: buildObservationAuthorityKey(authority),
		},
	});
	for (const unit of plan.units) {
		await prisma.providerObservationUnit.updateMany({
			where: { runId, ordinal: unit.ordinal },
			data: { scopePayload: unit.scopePayload },
		});
	}
	return provenance;
}

async function bindV3Fixture(
	prisma: Awaited<ReturnType<typeof database>>,
	runId: string,
	options: { extraVerify?: boolean; watchDrift?: boolean } = {},
) {
	await bindV2Fixture(prisma, runId, [
		{ userId: "user-1", userName: "Current User", libraryId: "library-1" },
	]);
	const parent = await prisma.cacheRefreshStatus.findUniqueOrThrow({
		where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
	});
	const decoded = decodeJellyfinLibraryGenerationMetadata(parent.generationMetadata);
	if (!decoded.ok) throw new Error("fixture parent metadata is invalid");
	const parentRows = await prisma.jellyfinCache.findMany({ where: { instanceId: "jellyfin-1" } });
	const dependency = fingerprintJellyfinEpisodeParentDependency(
		"jellyfin-1",
		decoded.metadata,
		parentRows.map((row) => ({ ...row, mediaType: row.mediaType as "movie" | "series" })),
	);
	if (!dependency) throw new Error("fixture parent dependency is invalid");
	const catalog = buildJellyfinEpisodeCatalogProvenance(
		parentRows.map((row) => ({ ...row, mediaType: row.mediaType as "movie" | "series" })),
		[{ userId: "user-1", libraryId: "library-1" }],
	);
	if (!catalog) throw new Error("fixture catalog provenance is invalid");
	const scopes = [{ userId: "user-1", userName: "Current User", libraryId: "library-1" }];
	const plan = buildJellyfinEpisodeScopePlan(scopes, {
		parentLibraryGenerationId: parent.generationId!,
		parentLibraryMetadataFingerprint: fingerprintJellyfinLibraryGenerationMetadata(
			decoded.metadata,
		),
		parentLibraryDependencyFingerprint: dependency,
		catalogProvenance: catalog,
	});
	const parentGenerationId = jellyfinEpisodeCatalogGenerationKey(catalog)!;
	const authority = {
		provider: "jellyfin_episode" as const,
		cacheType: "jellyfin_episode" as const,
		instanceId: "jellyfin-1",
		parentGenerationId,
		targetDigest: plan.targetDigest,
		connectionGeneration: 1,
		identityGeneration: 1,
	};
	await prisma.providerObservationRun.update({
		where: { id: runId },
		data: {
			parentGenerationId,
			targetDigest: plan.targetDigest,
			targetCount: plan.targetCount,
			authorityKey: buildObservationAuthorityKey(authority),
		},
	});
	for (const unit of plan.units) {
		await prisma.providerObservationUnit.updateMany({
			where: { runId, ordinal: unit.ordinal },
			data: { scopePayload: unit.scopePayload },
		});
	}
	const verify = plan.units.find((unit) => unit.phase === "verify");
	if (!verify) throw new Error("fixture verify unit is missing");
	if (options.watchDrift) {
		await prisma.jellyfinEpisodeObservationStage.updateMany({
			where: { runId, pass: "verify" },
			data: { played: false, playCount: 0, lastPlayedAt: null },
		});
	}
	if (options.extraVerify) {
		await prisma.providerObservationUnit.update({
			where: {
				id: (
					await prisma.providerObservationUnit.findFirstOrThrow({
						where: { runId, phase: "verify" },
					})
				).id,
			},
			data: { expectedRawCount: 2, observedRawCount: 2, cursor: 2 },
		});
		await prisma.jellyfinEpisodeObservationStage.create({
			data: {
				runId,
				unitId: (
					await prisma.providerObservationUnit.findFirstOrThrow({
						where: { runId, phase: "verify" },
					})
				).id,
				userKeyDigest: hash(["jellyfin-user", "user-1"]),
				pass: "verify",
				jellyfinId: "episode-2",
				seriesId: "unmapped-series",
				seasonNumber: 1,
				episodeNumber: 2,
				title: "Added",
				played: true,
				playCount: 1,
				lastPlayedAt: null,
				userName: "",
			},
		});
	}
}

async function finalizerState(prisma: Awaited<ReturnType<typeof database>>, runId: string) {
	return {
		rows: await prisma.jellyfinEpisodeCache.findMany({
			where: { instanceId: "jellyfin-1" },
			orderBy: { id: "asc" },
		}),
		status: await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: {
				instanceId_cacheType: {
					instanceId: "jellyfin-1",
					cacheType: "jellyfin_episode",
				},
			},
		}),
		run: await prisma.providerObservationRun.findUniqueOrThrow({ where: { id: runId } }),
		stages: await prisma.jellyfinEpisodeObservationStage.findMany({
			where: { runId },
			orderBy: { id: "asc" },
		}),
	};
}

async function rewriteAuthoritativeParent(prisma: Awaited<ReturnType<typeof database>>) {
	const status = await prisma.cacheRefreshStatus.findUniqueOrThrow({
		where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
	});
	const rows = await prisma.jellyfinCache.findMany({ where: { instanceId: "jellyfin-1" } });
	const metadata = JSON.parse(status.generationMetadata!) as Record<string, unknown> & {
		coverageReceipt: {
			publishedCanonicalEntities?: number;
			units: Array<Record<string, unknown>>;
			domains: Array<{
				publishedCanonicalEntities?: number;
				units: Array<Record<string, unknown>>;
			}>;
		};
	};
	const updateUnit = (unit: Record<string, unknown>) => ({
		...unit,
		expectedRawCount: rows.length,
		rawObserved: rows.length,
		sourceBindings: rows.length,
		canonicalEntities: rows.length,
	});
	metadata.itemCount = rows.length;
	metadata.contentFingerprint = fingerprintJellyfinLibraryRows(
		rows.map((row) => ({
			...row,
			mediaType: row.mediaType as "movie" | "series",
		})),
	);
	metadata.coverageReceipt.publishedCanonicalEntities = rows.length;
	metadata.coverageReceipt.units = metadata.coverageReceipt.units.map(updateUnit);
	metadata.coverageReceipt.domains = metadata.coverageReceipt.domains.map((domain) => ({
		...domain,
		publishedCanonicalEntities: rows.length,
		units: domain.units.map(updateUnit),
	}));
	await prisma.cacheRefreshStatus.update({
		where: { id: status.id },
		data: {
			itemCount: rows.length,
			generationMetadata: encodeJellyfinLibraryGenerationMetadata(metadata),
		},
	});
}

function positiveOnlyParentMetadata(generationMetadata: string): string {
	const metadata = JSON.parse(generationMetadata) as Record<string, unknown> & {
		itemCount: number;
		coverageReceipt: {
			provider: "jellyfin" | "emby";
			attemptStartedAt: string;
			observedAt: string;
			units: Array<Record<string, unknown>>;
		};
	};
	metadata.publicationLevel = "positive-only";
	metadata.completeness = "partial";
	metadata.coverageReceipt = {
		version: 1,
		provider: metadata.coverageReceipt.provider,
		attemptStartedAt: metadata.coverageReceipt.attemptStartedAt,
		observedAt: metadata.coverageReceipt.observedAt,
		evidence: "positive-only",
		units: metadata.coverageReceipt.units,
		publishedCanonicalEntities: metadata.itemCount,
	} as typeof metadata.coverageReceipt;
	return encodeJellyfinLibraryGenerationMetadata(metadata);
}

function mixedDomainParentMetadata(generationMetadata: string): string {
	const metadata = JSON.parse(generationMetadata) as Record<string, unknown> & {
		coverageReceipt: {
			domains: Array<Record<string, unknown>>;
		};
	};
	metadata.coverageReceipt.domains = metadata.coverageReceipt.domains.map((domain) =>
		domain.domain === "watch-count"
			? { ...domain, evidence: "positive-only", valueSemantics: "lower-bound" }
			: domain,
	);
	return encodeJellyfinLibraryGenerationMetadata(metadata);
}

function lowerBoundMappingParentMetadata(generationMetadata: string): string {
	const metadata = JSON.parse(generationMetadata) as Record<string, unknown> & {
		coverageReceipt: { evidence: string; domains: Array<Record<string, unknown>> };
	};
	metadata.publicationLevel = "positive-only";
	metadata.completeness = "partial";
	metadata.coverageReceipt.evidence = "positive-only";
	metadata.coverageReceipt.domains = metadata.coverageReceipt.domains.map((domain) =>
		domain.domain === "mapping"
			? { ...domain, evidence: "positive-only", valueSemantics: "lower-bound" }
			: domain,
	);
	return encodeJellyfinLibraryGenerationMetadata(metadata);
}

async function addStagePair(
	prisma: Awaited<ReturnType<typeof database>>,
	runId: string,
	row: {
		jellyfinId: string;
		seriesId: string;
		seasonNumber?: number;
		episodeNumber?: number;
		played?: boolean;
	},
) {
	const units = await prisma.providerObservationUnit.findMany({
		where: { runId },
		orderBy: { ordinal: "asc" },
	});
	const userKeyDigest = hash(["jellyfin-user", "user-1"]);
	for (const unit of units) {
		await prisma.jellyfinEpisodeObservationStage.create({
			data: {
				runId,
				unitId: unit.id,
				userKeyDigest,
				pass: unit.phase,
				jellyfinId: row.jellyfinId,
				seriesId: row.seriesId,
				seasonNumber: row.seasonNumber ?? 1,
				episodeNumber: row.episodeNumber ?? 1,
				title: "Second copy",
				played: row.played ?? true,
				playCount: row.played === false ? 0 : 1,
				lastPlayedAt: row.played === false ? null : new Date("2026-09-07T00:00:00.000Z"),
				userName: "",
			},
		});
	}
	await prisma.providerObservationUnit.updateMany({
		where: { runId },
		data: { cursor: 2, expectedRawCount: 2, observedRawCount: 2 },
	});
}

async function replaceRunWithScopes(
	prisma: Awaited<ReturnType<typeof database>>,
	attempt: { attemptedAt: Date; resultMarker: string },
	scopes: Array<{ userId: string; userName: string; libraryId: string }>,
	itemsByScope: Record<
		string,
		Array<{
			jellyfinId: string;
			seriesId: string;
			seasonNumber: number;
			episodeNumber: number;
			played: boolean;
			lastPlayedAt: Date | null;
		}>
	>,
) {
	await prisma.providerObservationRun.deleteMany({
		where: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" },
	});
	const plan = buildJellyfinEpisodeScopePlan(scopes);
	const run = await createOrLoadObservationRun(prisma, {
		authority: {
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			instanceId: "jellyfin-1",
			parentGenerationId: "parent-1",
			targetDigest: plan.targetDigest,
			connectionGeneration: 1,
			identityGeneration: 1,
		},
		units: plan.units,
	});
	const units = await prisma.providerObservationUnit.findMany({
		where: { runId: run.id },
		orderBy: { ordinal: "asc" },
	});
	for (const unit of units) {
		const scope = JSON.parse(unit.scopePayload!) as { userId: string; libraryId: string };
		const items = itemsByScope[`${scope.userId}:${scope.libraryId}`] ?? [];
		await prisma.providerObservationUnit.update({
			where: { id: unit.id },
			data: {
				state: "complete",
				completedAt: attempt.attemptedAt,
				cursor: items.length,
				expectedRawCount: items.length,
				observedRawCount: items.length,
			},
		});
		for (const item of items) {
			await prisma.jellyfinEpisodeObservationStage.create({
				data: {
					runId: run.id,
					unitId: unit.id,
					userKeyDigest: hash(["jellyfin-user", scope.userId]),
					pass: unit.phase,
					jellyfinId: item.jellyfinId,
					seriesId: item.seriesId,
					seasonNumber: item.seasonNumber,
					episodeNumber: item.episodeNumber,
					title: "Episode",
					played: item.played,
					playCount: item.played ? 1 : 0,
					lastPlayedAt: item.lastPlayedAt,
					userName: "",
				},
			});
		}
	}
	await prisma.providerObservationRun.update({
		where: { id: run.id },
		data: { completedUnits: units.length, completedWork: plan.targetCount },
	});
	return { plan, run };
}

describe("Jellyfin durable episode refresh repository", { timeout: 30_000 }, () => {
	it.each(["unchanged", "automatic", "explicit"])(
		"admits a production V3 run with 4165 catalog bindings and resumes failed references: %s",
		async (resumeMode) => {
			const failReferencePage = resumeMode !== "unchanged";
			const prisma = await database();
			const seed = await completeFinalizerFixture(prisma);
			await bindV2Fixture(prisma, seed.run.id, seed.scopes);
			await invalidateJellyfinEpisodeRun(prisma, seed.run.id, seed.attempt.attemptedAt);
			const instance = await prisma.serviceInstance.update({
				where: { id: "jellyfin-1" },
				data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
			});
			const original = await prisma.jellyfinCache.findFirstOrThrow({
				where: { instanceId: instance.id },
			});
			await prisma.jellyfinCache.createMany({
				data: Array.from({ length: 4164 }, (_, index) => ({
					...original,
					id: `synthetic-row-${index}`,
					jellyfinId: `synthetic-series-${String(index).padStart(32, "0")}`,
					tmdbId: index + 100,
				})),
			});
			await rewriteAuthoritativeParent(prisma);
			const parent = await prisma.cacheRefreshStatus.findUniqueOrThrow({
				where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "jellyfin" } },
			});
			const decoded = decodeJellyfinLibraryGenerationMetadata(parent.generationMetadata);
			if (!decoded.ok || decoded.metadata.coverageReceipt.version !== 2)
				throw new Error("fixture receipt");
			const users = Array.from({ length: 8 }, (_, index) => ({
				id: `user-${index + 1}`,
				name: "User",
			}));
			await prisma.cacheRefreshStatus.update({
				where: { id: parent.id },
				data: {
					generationMetadata: encodeJellyfinLibraryGenerationMetadata({
						...decoded.metadata,
						coverageReceipt: {
							...decoded.metadata.coverageReceipt,
							domains: decoded.metadata.coverageReceipt.domains.map((domain) =>
								domain.domain === "library-inventory"
									? {
											...domain,
											units: users.map((user) => ({
												...domain.units[0]!,
												scopeKey: `user:${user.id}/library:library-1/inventory`,
											})),
										}
									: domain,
							),
						},
					}),
				},
			});
			identityModuleMocks.readProviderIdentity.mockResolvedValue({
				service: "JELLYFIN",
				identityKind: "jellyfin-server-id",
				rawIdentity: "verified-provider",
				confirmationDigest: "a".repeat(64),
				fingerprint: "a".repeat(12),
			});
			let discoveryAllowed = true;
			let discoveryCalls = 0;
			let pageCalls = 0;
			const runner = createJellyfinEpisodeWorkItemRunner({
				createClient: () =>
					({
						getUsers: async () => {
							discoveryCalls++;
							if (!discoveryAllowed) throw new Error("discovery intentionally unavailable");
							return users;
						},
						getLibraries: async () => [{ id: "library-1" }],
						getEpisodeItemsPageWithCoverage: async () => {
							pageCalls++;
							if (failReferencePage && pageCalls === 2)
								throw new Error("temporary provider failure");
							return {
								startIndex: 0,
								totalRecordCount: 1,
								items: [
									{
										type: "Episode",
										id: "episode-1",
										seriesId: "series-1",
										seasonNumber: 1,
										episodeNumber: 1,
										name: "Episode",
										played: true,
										playCount: 1,
										lastPlayedDate: null,
									},
								],
							};
						},
					}) as never,
			});
			const context = {
				prisma,
				instance,
				encryptor: { decrypt: () => "plaintext" },
				log: { warn: () => undefined, error: () => undefined } as never,
				now: seed.attempt.attemptedAt,
				resumeFailed: false,
			};
			expect(await runner(context)).toMatchObject({
				state: "running",
				progressed: true,
				completedUnits: 1,
			});
			const run = await prisma.providerObservationRun.findFirstOrThrow({
				where: { instanceId: instance.id, activeSlotKey: { not: null } },
				include: { units: { orderBy: { ordinal: "asc" } } },
			});
			expect(run.units).toHaveLength(16);
			expect(Buffer.byteLength(run.units[0]!.scopePayload!, "utf8")).toBeGreaterThan(4096);
			expect(Buffer.byteLength(run.units[0]!.scopePayload!, "utf8")).toBeLessThanOrEqual(1048576);
			for (const unit of run.units.slice(1)) {
				expect(Buffer.byteLength(unit.scopePayload!, "utf8")).toBeLessThanOrEqual(4096);
				expect(JSON.parse(unit.scopePayload!)).toMatchObject({
					catalogGenerationKey: run.parentGenerationId,
				});
				expect(JSON.parse(unit.scopePayload!)).not.toHaveProperty("catalogProvenance");
			}
			if (failReferencePage) {
				expect(await runner(context)).toMatchObject({
					state: "failed",
					progressed: false,
					completedUnits: 1,
				});
				await prisma.jellyfinCache.create({
					data: {
						...original,
						id: "retry-added-row",
						jellyfinId: "retry-added-series",
						tmdbId: 999999,
					},
				});
				await rewriteAuthoritativeParent(prisma);
				discoveryAllowed = false;
				context.now = new Date(context.now.getTime() + 10_000);
				expect(await runner(context)).toMatchObject({
					state: "failed",
					progressed: false,
					completedUnits: 1,
				});
				expect(pageCalls).toBe(2);
				expect(discoveryCalls).toBe(1);
				if (resumeMode === "explicit") {
					await prisma.providerObservationUnit.updateMany({
						where: { runId: run.id, state: "failed" },
						data: { attemptCount: 4, nextAttemptAt: null },
					});
					await prisma.providerObservationRun.update({
						where: { id: run.id },
						data: { nextAttemptAt: null },
					});
					context.resumeFailed = true;
				}
				context.now = new Date(context.now.getTime() + 21_000);
			}
			expect(await runner(context)).toMatchObject({
				state: "running",
				progressed: true,
				completedUnits: 2,
			});
			if (failReferencePage) {
				expect(discoveryCalls).toBe(1);
				const resumed = await prisma.providerObservationRun.findFirstOrThrow({
					where: { instanceId: instance.id, activeSlotKey: { not: null } },
				});
				expect(resumed.id).toBe(run.id);
				expect(resumed.parentGenerationId).toBe(run.parentGenerationId);
				expect(
					await prisma.providerObservationUnit.findFirstOrThrow({
						where: { runId: run.id, ordinal: 1 },
					}),
				).toMatchObject({ attemptCount: resumeMode === "explicit" ? 0 : 1, state: "complete" });
				discoveryAllowed = true;
			}

			for (let completedUnits = 3; completedUnits <= 16; completedUnits++) {
				expect(await runner(context)).toMatchObject({
					state: "running",
					progressed: true,
					completedUnits,
				});
			}
			expect(await runner(context)).toMatchObject({ state: "complete", publishedItemCount: 1 });
			// A later run must reject a corrupted non-root reference and preserve publication.
			expect(await runner(context)).toMatchObject({ state: "running", progressed: true });
			const replacement = await prisma.providerObservationRun.findFirstOrThrow({
				where: { instanceId: instance.id, activeSlotKey: { not: null } },
			});
			const reference = await prisma.providerObservationUnit.findFirstOrThrow({
				where: { runId: replacement.id, ordinal: 1 },
			});
			await prisma.providerObservationUnit.update({
				where: { id: reference.id },
				data: {
					scopePayload: JSON.stringify({
						...JSON.parse(reference.scopePayload!),
						catalogGenerationKey: `jellyfin-episode-parent-v3:${"f".repeat(64)}`,
					}),
				},
			});
			expect(await runner(context)).toMatchObject({ state: "failed", replanRequired: true });
			expect(await prisma.jellyfinEpisodeCache.count({ where: { instanceId: instance.id } })).toBe(
				1,
			);
		},
	);

	it("publishes a V3 collected subset when verify sees a newly added series", async () => {
		const prisma = await database();
		const seed = await completeFinalizerFixture(prisma);
		await bindV3Fixture(prisma, seed.run.id, { extraVerify: true });
		const result = await finalizeJellyfinEpisodeRun({
			prisma,
			userId: "user-1",
			instance: { id: "jellyfin-1" },
			runId: seed.run.id,
			scopes: seed.scopes,
			attempt: seed.attempt,
			now: seed.attempt.attemptedAt,
		});
		expect(result).toEqual({ published: true, itemCount: 1 });
		expect(await prisma.jellyfinEpisodeCache.count({ where: { instanceId: "jellyfin-1" } })).toBe(
			1,
		);
		const status = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" } },
		});
		expect(decodeJellyfinEpisodeGenerationMetadata(status.generationMetadata)).toMatchObject({
			ok: true,
			metadata: { version: 3, publicationLevel: "positive-only", completeness: "partial" },
		});
		const decoded = decodeJellyfinEpisodeGenerationMetadata(status.generationMetadata);
		if (!decoded.ok) throw new Error("expected V3 episode metadata");
		expect(decoded.metadata.coverageReceipt.units).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					scopeKey: expect.stringContaining("collect:"),
					rawObserved: 1,
					sourceBindings: 1,
					canonicalEntities: 1,
				}),
				expect.objectContaining({
					scopeKey: expect.stringContaining("verify:"),
					rawObserved: 2,
					sourceBindings: 1,
					canonicalEntities: 1,
				}),
			]),
		);
	});

	it("publishes V3 coverage using unique staged rows when raw positions overlap", async () => {
		const prisma = await database();
		const seed = await completeFinalizerFixture(prisma);
		await bindV3Fixture(prisma, seed.run.id);
		await prisma.providerObservationUnit.updateMany({
			where: { runId: seed.run.id },
			data: { cursor: 2, expectedRawCount: 2, observedRawCount: 2 },
		});
		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: seed.run.id,
				scopes: seed.scopes,
				attempt: seed.attempt,
				now: seed.attempt.attemptedAt,
			}),
		).resolves.toEqual({ published: true, itemCount: 1 });
		const status = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" } },
		});
		const decoded = decodeJellyfinEpisodeGenerationMetadata(status.generationMetadata);
		if (!decoded.ok) throw new Error("expected V3 episode metadata");
		expect(decoded.metadata.coverageReceipt.units).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					scopeKey: expect.stringContaining("collect:"),
					rawObserved: 2,
					sourceBindings: 1,
					canonicalEntities: 1,
				}),
				expect.objectContaining({
					scopeKey: expect.stringContaining("verify:"),
					rawObserved: 2,
					sourceBindings: 1,
					canonicalEntities: 1,
				}),
			]),
		);
	});

	it.each([1, 0])(
		"publishes consistent positive-only V3 counts with %i watched episodes",
		async (positiveCount) => {
			const prisma = await database();
			const seed = await completeFinalizerFixture(prisma);
			await bindV3Fixture(prisma, seed.run.id);
			await prisma.serviceInstance.update({
				where: { id: "jellyfin-1" },
				data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
			});
			if (positiveCount === 0)
				await prisma.jellyfinEpisodeObservationStage.updateMany({
					where: { runId: seed.run.id },
					data: { played: false, playCount: 0, lastPlayedAt: null },
				});
			const stages = await prisma.jellyfinEpisodeObservationStage.findMany({
				where: { runId: seed.run.id },
			});
			for (const stage of stages) {
				const { id: _id, ...row } = stage;
				await prisma.jellyfinEpisodeObservationStage.create({
					data: {
						...row,
						jellyfinId: "unwatched-episode",
						episodeNumber: 2,
						played: false,
						playCount: 0,
						lastPlayedAt: null,
					},
				});
			}
			await prisma.providerObservationUnit.updateMany({
				where: { runId: seed.run.id },
				data: { cursor: 2, expectedRawCount: 2, observedRawCount: 2 },
			});
			expect(
				await finalizeJellyfinEpisodeRun({
					prisma,
					userId: "user-1",
					instance: { id: "jellyfin-1" },
					runId: seed.run.id,
					scopes: seed.scopes,
					attempt: seed.attempt,
					now: seed.attempt.attemptedAt,
				}),
			).toEqual({ published: true, itemCount: positiveCount });
			const state = await finalizerState(prisma, seed.run.id);
			expect(state.rows).toHaveLength(positiveCount);
			if (positiveCount) expect(state.rows[0]).toMatchObject({ watched: true, episodeNumber: 1 });
			expect(state.status.itemCount).toBe(positiveCount);
			expect(JSON.parse(state.status.generationMetadata!)).toMatchObject({
				version: 3,
				itemCount: positiveCount,
				publicationLevel: "positive-only",
			});
			const display = await readOwnedJellyfinObservation({
				prisma,
				userId: "user-1",
				instanceId: "jellyfin-1",
				cacheType: "jellyfin_episode",
				mode: "display",
				now: seed.attempt.attemptedAt,
			});
			expect(display).toMatchObject({
				available: true,
				mutationAvailable: false,
				authority: null,
				providerStatus: { availability: "partial" },
			});
			expect(display?.rows).toHaveLength(positiveCount);
		},
	);

	it.each(
		[2, 3].flatMap((version) =>
			(["missing", "duplicate", "same-positive-coordinate", "changed-coordinate"] as const).map(
				(drift) => ({ version, drift }),
			),
		),
	)("positive projection V$version isolates $drift", async ({ version, drift }) => {
		const prisma = await database();
		const seed = await completeFinalizerFixture(prisma);
		if (version === 3) await bindV3Fixture(prisma, seed.run.id);
		else await bindV2Fixture(prisma, seed.run.id, seed.scopes);
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-1" },
			data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
		});
		const original = await prisma.jellyfinEpisodeObservationStage.findMany({
			where: { runId: seed.run.id },
		});
		for (const stage of original) {
			if (drift === "missing" && stage.pass === "verify") continue;
			const { id: _id, ...row } = stage;
			const copies = drift === "duplicate" ? 2 : 1;
			for (let copy = 0; copy < copies; copy++)
				await prisma.jellyfinEpisodeObservationStage.create({
					data: {
						...row,
						jellyfinId: `0-unwatched-copy-${copy}`,
						episodeNumber:
							drift === "same-positive-coordinate"
								? 1
								: drift === "changed-coordinate" && stage.pass === "verify"
									? 3
									: 2,
						played: false,
						playCount: 0,
						lastPlayedAt: null,
					},
				});
		}
		const units = await prisma.providerObservationUnit.findMany({ where: { runId: seed.run.id } });
		for (const unit of units) {
			const count = await prisma.jellyfinEpisodeObservationStage.count({
				where: { unitId: unit.id },
			});
			await prisma.providerObservationUnit.update({
				where: { id: unit.id },
				data: { cursor: count, observedRawCount: count, expectedRawCount: count },
			});
		}
		const result = await finalizeJellyfinEpisodeRun({
			prisma,
			userId: "user-1",
			instance: { id: "jellyfin-1" },
			runId: seed.run.id,
			scopes: seed.scopes,
			attempt: seed.attempt,
			now: seed.attempt.attemptedAt,
		});
		expect(result, drift).toEqual({ published: version === 3, itemCount: version === 3 ? 1 : 0 });
		if (version === 2) {
			await expectInvalidatedWithPublishedCachePreserved(prisma, seed.run.id);
			return;
		}
		const state = await finalizerState(prisma, seed.run.id);
		expect(state.rows).toEqual([
			expect.objectContaining({ jellyfinId: "episode-1", episodeNumber: 1, watched: true }),
		]);
		const decoded = decodeJellyfinEpisodeGenerationMetadata(state.status.generationMetadata);
		expect(decoded).toMatchObject({
			ok: true,
			metadata: {
				version: 3,
				itemCount: 1,
				publicationLevel: "positive-only",
				completeness: "partial",
			},
		});
		const display = await readOwnedJellyfinObservation({
			prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin_episode",
			mode: "display",
			now: seed.attempt.attemptedAt,
		});
		expect(display).toMatchObject({ available: true, mutationAvailable: false, authority: null });
		expect(display?.rows).toHaveLength(1);
	});

	it.each([
		"missing-played",
		"changed-played",
		"duplicate-played",
		"cross-user-source-conflict",
	] as const)(
		"positive projection V3 rejects %s and preserves published rows",
		async (conflict) => {
			const prisma = await database();
			const seed = await completeFinalizerFixture(prisma);
			await bindV3Fixture(prisma, seed.run.id);
			if (conflict === "missing-played") {
				await prisma.jellyfinEpisodeObservationStage.deleteMany({
					where: { runId: seed.run.id, pass: "verify" },
				});
				await prisma.providerObservationUnit.updateMany({
					where: { runId: seed.run.id, phase: "verify" },
					data: { cursor: 0, observedRawCount: 0, expectedRawCount: 0 },
				});
			} else if (conflict === "changed-played") {
				await prisma.jellyfinEpisodeObservationStage.updateMany({
					where: { runId: seed.run.id, pass: "verify" },
					data: { episodeNumber: 2 },
				});
			} else {
				const stages = await prisma.jellyfinEpisodeObservationStage.findMany({
					where: { runId: seed.run.id },
				});
				for (const stage of stages) {
					const { id: _id, ...row } = stage;
					await prisma.jellyfinEpisodeObservationStage.create({
						data: {
							...row,
							...(conflict === "duplicate-played"
								? { jellyfinId: "duplicate-played" }
								: {
										userKeyDigest: hash(["jellyfin-user", "other-user"]),
										episodeNumber: 2,
										played: false,
										playCount: 0,
										lastPlayedAt: null,
									}),
						},
					});
				}
				await prisma.providerObservationUnit.updateMany({
					where: { runId: seed.run.id },
					data: { cursor: 2, observedRawCount: 2, expectedRawCount: 2 },
				});
			}
			await expect(
				finalizeJellyfinEpisodeRun({
					prisma,
					userId: "user-1",
					instance: { id: "jellyfin-1" },
					runId: seed.run.id,
					scopes: seed.scopes,
					attempt: seed.attempt,
					now: seed.attempt.attemptedAt,
				}),
			).resolves.toEqual({ published: false, itemCount: 0 });
			await expectInvalidatedWithPublishedCachePreserved(prisma, seed.run.id);
		},
	);

	it("rejects V3 publication when the current parent receipt changes user scope after discovery", async () => {
		const prisma = await database();
		const seed = await completeFinalizerFixture(prisma);
		await bindV3Fixture(prisma, seed.run.id);
		const status = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
		});
		const metadata = status.generationMetadata!.replaceAll(
			"user:user-1/library:library-1/inventory",
			"user:replacement-user/library:library-1/inventory",
		);
		await prisma.cacheRefreshStatus.update({
			where: { id: status.id },
			data: { generationMetadata: metadata },
		});
		expect(
			await finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: seed.run.id,
				scopes: seed.scopes,
				attempt: seed.attempt,
				now: seed.attempt.attemptedAt,
			}),
		).toEqual({ published: false, itemCount: 0 });
		await expectInvalidatedWithPublishedCachePreserved(prisma, seed.run.id);
	});

	it("ignores volatile watch drift between V3 collect and verify", async () => {
		const prisma = await database();
		const seed = await completeFinalizerFixture(prisma);
		await bindV3Fixture(prisma, seed.run.id, { watchDrift: true });
		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: seed.run.id,
				scopes: seed.scopes,
				attempt: seed.attempt,
				now: seed.attempt.attemptedAt,
			}),
		).resolves.toEqual({ published: true, itemCount: 1 });
	});

	it("uses the ten-second successful-progress continuation delay", () => {
		expect(JELLYFIN_EPISODE_SUCCESSFUL_PROGRESS_CONTINUATION_DELAY_MS).toBe(10_000);
	});

	it("finalizes a V2 run after a volatile parent refresh without losing its staged work", async () => {
		const prisma = await database();
		const { attempt, run, scopes } = await completeFinalizerFixture(prisma);
		const originalParent = await bindV2Fixture(prisma, run.id, scopes);
		// A resumed finalization has a fresh outer attempt, but already verified
		// pages still belong to the original parent observation.
		attempt.attemptedAt = new Date("2026-09-07T00:02:00.000Z");
		await prisma.cacheRefreshStatus.update({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" } },
			data: { lastAttemptAt: attempt.attemptedAt },
		});
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-1" },
			data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
		});
		const refreshedAt = new Date("2026-09-07T00:01:00.000Z");
		await prisma.jellyfinCache.updateMany({
			where: { instanceId: "jellyfin-1" },
			data: {
				title: "Show (refreshed)",
				thumb: "thumb-refreshed",
				watchCount: 3,
				lastWatchedAt: refreshedAt,
			},
		});
		const parentStatus = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
		});
		const parentRows = await prisma.jellyfinCache.findMany({ where: { instanceId: "jellyfin-1" } });
		const parentMetadata = JSON.parse(parentStatus.generationMetadata!) as Record<
			string,
			unknown
		> & {
			contentFingerprint: string;
			coverageReceipt: Record<string, unknown>;
		};
		parentMetadata.contentFingerprint = fingerprintJellyfinLibraryRows(
			parentRows.map((row) => ({ ...row, mediaType: row.mediaType as "movie" | "series" })),
		);
		parentMetadata.coverageReceipt.observedAt = refreshedAt.toISOString();
		const parentMetadataEncoded = encodeJellyfinLibraryGenerationMetadata(parentMetadata);
		const parentDependencyFingerprint = fingerprintJellyfinEpisodeParentDependency(
			"jellyfin-1",
			parentMetadataEncoded,
			parentRows.map((row) => ({
				...row,
				mediaType: row.mediaType as "movie" | "series",
			})),
		);
		expect(parentDependencyFingerprint).toMatch(/^[a-f0-9]{64}$/);
		await prisma.cacheRefreshStatus.update({
			where: { id: parentStatus.id },
			data: {
				generationId: "parent-2",
				generationMetadata: parentMetadataEncoded,
				lastRefreshedAt: refreshedAt,
				lastAttemptAt: refreshedAt,
			},
		});
		await prisma.providerObservationRun.update({
			where: { id: run.id },
			data: {
				parentGenerationId: jellyfinEpisodeParentGenerationKey(parentDependencyFingerprint!),
			},
		});

		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				scopes,
				attempt,
				now: new Date("2026-09-07T00:02:00.000Z"),
			}),
		).resolves.toEqual({ published: true, itemCount: 1 });
		const observationInput = {
			prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin_episode" as const,
			now: new Date("2026-09-07T00:02:00.000Z"),
		};
		expect(
			await readOwnedJellyfinObservation({ ...observationInput, mode: "display" }),
		).toMatchObject({ available: true });
		expect(
			await readOwnedJellyfinObservation({ ...observationInput, mode: "mutation" }),
		).toMatchObject({ available: false, mutationAvailable: false, rows: [], authority: null });
		const episodeStatus = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: {
				instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" },
			},
		});
		const decoded = decodeJellyfinEpisodeGenerationMetadata(episodeStatus.generationMetadata);
		expect(decoded.ok).toBe(true);
		if (decoded.ok && decoded.metadata.version === 2) {
			expect(decoded.metadata.version).toBe(2);
			expect(decoded.metadata).toMatchObject(originalParent);
			expect(decoded.metadata.parentLibraryDependencyFingerprint).toBe(parentDependencyFingerprint);
		}
	});

	it("retains mutation eligibility for a fresh V2 run with unchanged parent provenance", async () => {
		const prisma = await database();
		const { attempt, run, scopes } = await completeFinalizerFixture(prisma);
		await bindV2Fixture(prisma, run.id, scopes);
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-1" },
			data: {
				expectedIdentity: "verified-provider",
				identityStatus: "VERIFIED",
			},
		});
		expect(
			await finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				scopes,
				attempt,
				now: attempt.attemptedAt,
			}),
		).toEqual({ published: true, itemCount: 1 });
		expect(
			await readOwnedJellyfinObservation({
				prisma,
				userId: "user-1",
				instanceId: "jellyfin-1",
				cacheType: "jellyfin_episode",
				mode: "mutation",
				now: attempt.attemptedAt,
			}),
		).toMatchObject({ available: true, mutationAvailable: true });
	});

	it.each(["missing", "malformed", "mixed-generation", "mixed-fingerprint"])(
		"rejects %s original parent provenance before V2 publication",
		async (kind) => {
			const prisma = await database();
			const { attempt, run, scopes } = await completeFinalizerFixture(prisma);
			const provenance = await bindV2Fixture(prisma, run.id, scopes);
			const scope = { userId: "user-1", libraryId: "library-1" };
			const payload =
				kind === "missing"
					? scope
					: {
							...scope,
							...provenance,
							...(kind === "malformed" ? { parentLibraryMetadataFingerprint: "invalid" } : {}),
							...(kind === "mixed-generation"
								? { parentLibraryGenerationId: "different-parent" }
								: {}),
							...(kind === "mixed-fingerprint"
								? { parentLibraryMetadataFingerprint: "b".repeat(64) }
								: {}),
						};
			await prisma.providerObservationUnit.updateMany({
				where: { runId: run.id, ordinal: 1 },
				data: { scopePayload: JSON.stringify(payload) },
			});
			expect(
				await finalizeJellyfinEpisodeRun({
					prisma,
					userId: "user-1",
					instance: { id: "jellyfin-1" },
					runId: run.id,
					scopes,
					attempt,
					now: attempt.attemptedAt,
				}),
			).toEqual({ published: false, itemCount: 0 });
			await expectInvalidatedWithPublishedCachePreserved(prisma, run.id);
		},
	);

	it("terminally publishes 4,163 provider-cursor episodes through the production runner factory", async () => {
		const prisma = await database();
		const seed = await completeFinalizerFixture(prisma);
		const parent = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
		});
		await prisma.cacheRefreshStatus.update({
			where: { id: parent.id },
			data: { generationMetadata: lowerBoundMappingParentMetadata(parent.generationMetadata!) },
		});
		await prisma.providerObservationRun.delete({ where: { id: seed.run.id } });
		await prisma.cacheRefreshStatus.update({
			where: {
				instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" },
			},
			data: { lastAttemptResult: "success", lastAttemptErrorMessage: null },
		});
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-1" },
			data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
		});
		const instance = await prisma.serviceInstance.findUniqueOrThrow({
			where: { id: "jellyfin-1" },
		});
		const cursors: number[] = [];
		const client = {
			getUsers: async () => [{ id: "user-1", name: "Current User" }],
			getLibraries: async () => [{ id: "library-1" }],
			getEpisodeItemsPageWithCoverage: async (
				_userId: string,
				_libraryId: string,
				cursor: number,
			) => {
				cursors.push(cursor);
				const count = Math.min(1_000, 4_163 - cursor);
				return {
					startIndex: cursor,
					totalRecordCount: 4_163,
					items: Array.from({ length: count }, (_, offset) => {
						const ordinal = cursor + offset + 1;
						return {
							type: "Episode" as const,
							id: `episode-${ordinal}`,
							seriesId: ordinal === 4_163 ? "unmapped-series" : "series-1",
							name: "Episode",
							seasonNumber: 1,
							episodeNumber: ordinal,
							played: true,
							playCount: 1,
							lastPlayedDate: null,
						};
					}),
				};
			},
		};
		const runner = createJellyfinEpisodeWorkItemRunner({
			createClient: () => client as never,
		});
		identityModuleMocks.readProviderIdentity.mockResolvedValue({
			service: "JELLYFIN",
			identityKind: "jellyfin-server-id",
			rawIdentity: "verified-provider",
			confirmationDigest: "a".repeat(64),
			fingerprint: "a".repeat(12),
		});
		const startedAt = new Date("2026-09-07T12:00:00.000Z").getTime();
		for (let invocation = 0; invocation < 10; invocation += 1) {
			await runner({
				prisma,
				encryptor: { decrypt: () => "plaintext" },
				instance,
				log: { error: () => undefined } as never,
				now: new Date(startedAt + invocation * 31_000),
			});
		}
		const run = await prisma.providerObservationRun.findFirstOrThrow({
			where: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" },
			include: { units: { orderBy: { ordinal: "asc" } } },
		});
		expect(run).toMatchObject({
			state: "running",
			completedUnits: 2,
			completedWork: 1,
			totalUnits: 2,
			totalWork: 1,
		});
		expect(
			run.units.map((unit) => ({
				phase: unit.phase,
				state: unit.state,
				cursor: unit.cursor,
				expectedRawCount: unit.expectedRawCount,
				observedRawCount: unit.observedRawCount,
			})),
		).toEqual([
			{
				phase: "collect",
				state: "complete",
				cursor: 4_163,
				expectedRawCount: 4_163,
				observedRawCount: 4_163,
			},
			{
				phase: "verify",
				state: "complete",
				cursor: 4_163,
				expectedRawCount: 4_163,
				observedRawCount: 4_163,
			},
		]);
		for (const unit of run.units) {
			expect(
				await prisma.jellyfinEpisodeObservationStage.count({ where: { unitId: unit.id } }),
			).toBe(4_163);
		}
		expect(cursors).toEqual([0, 1_000, 2_000, 3_000, 4_000, 0, 1_000, 2_000, 3_000, 4_000]);
		expect((client as { getEpisodes?: unknown }).getEpisodes).toBeUndefined();

		const terminal = await runner({
			prisma,
			encryptor: { decrypt: () => "plaintext" },
			instance,
			log: { error: () => undefined } as never,
			now: new Date(startedAt + 10 * 31_000),
		});
		expect(terminal).toMatchObject({
			state: "complete",
			completedUnits: 2,
			totalUnits: 2,
			completedWork: 1,
			totalWork: 1,
			publishedItemCount: 4_162,
		});
		expect(await prisma.jellyfinEpisodeCache.count({ where: { instanceId: "jellyfin-1" } })).toBe(
			4_162,
		);
		expect(
			await prisma.jellyfinEpisodeCache.findFirst({
				where: { instanceId: "jellyfin-1", jellyfinId: "episode-4163" },
			}),
		).toBeNull();
		const observedAt = new Date(startedAt + 10 * 31_000);
		const display = await readOwnedJellyfinObservation({
			prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin_episode",
			mode: "display",
			now: observedAt,
		});
		const mutation = await readOwnedJellyfinObservation({
			prisma,
			userId: "user-1",
			instanceId: "jellyfin-1",
			cacheType: "jellyfin_episode",
			mode: "mutation",
			now: observedAt,
		});
		expect(display).toMatchObject({
			available: true,
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
		if (!display) throw new Error("expected a displayable lower-bound observation");
		expect(display.rows).toHaveLength(4_162);
		expect(mutation).toMatchObject({
			available: false,
			rows: [],
			mutationAvailable: false,
			authority: null,
		});
	});

	it("resumes a recovered future lease through the production runner factory without replacing staged pages", async () => {
		const prisma = await database();
		const seed = await completeFinalizerFixture(prisma);
		await prisma.providerObservationRun.delete({ where: { id: seed.run.id } });
		await prisma.cacheRefreshStatus.update({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" } },
			data: { lastAttemptResult: "success", lastAttemptErrorMessage: null },
		});
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-1" },
			data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
		});
		const instance = await prisma.serviceInstance.findUniqueOrThrow({
			where: { id: "jellyfin-1" },
		});
		const pageCalls: Array<{ userId: string; libraryId: string; cursor: number }> = [];
		const runner = createJellyfinEpisodeWorkItemRunner({
			createClient: () =>
				({
					getUsers: async () => [{ id: "user-1", name: "Current User" }],
					getLibraries: async () => [{ id: "library-1" }],
					getEpisodeItemsPageWithCoverage: async (
						userId: string,
						libraryId: string,
						cursor: number,
					) => {
						pageCalls.push({ userId, libraryId, cursor });
						return {
							startIndex: 0,
							totalRecordCount: 1,
							items: [
								{
									type: "Episode" as const,
									id: "episode-1",
									seriesId: "series-1",
									name: "Episode",
									seasonNumber: 1,
									episodeNumber: 1,
									played: true,
									playCount: 1,
									lastPlayedDate: "2026-09-07T00:00:00.000Z",
								},
							],
						};
					},
				}) as never,
		});
		const context = {
			prisma,
			encryptor: { decrypt: () => "plaintext" },
			instance,
			log: { error: () => undefined } as never,
			now: new Date("2026-09-07T12:00:00.000Z"),
		};
		identityModuleMocks.readProviderIdentity.mockResolvedValue({
			service: "JELLYFIN",
			identityKind: "jellyfin-server-id",
			rawIdentity: "verified-provider",
			confirmationDigest: "a".repeat(64),
			fingerprint: "a".repeat(12),
		});
		expect(
			await readOwnedJellyfinObservation({
				prisma,
				userId: "user-1",
				instanceId: "jellyfin-1",
				cacheType: "jellyfin",
				mode: "mutation",
				now: context.now,
			}),
		).toMatchObject({ available: true, mutationAvailable: true });
		const authoritativeParentStatus = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
		});
		const authoritativeParent = decodeJellyfinLibraryGenerationMetadata(
			authoritativeParentStatus.generationMetadata,
		);
		expect(authoritativeParent).toMatchObject({ ok: true });
		expect(authoritativeParentStatus.lastAttemptAt).toEqual(
			authoritativeParentStatus.lastRefreshedAt,
		);
		const authoritativeRows = await prisma.jellyfinCache.findMany({
			where: { instanceId: "jellyfin-1" },
		});
		const authoritativeFingerprintRows = authoritativeRows.map((row) => ({
			...row,
			mediaType: row.mediaType === "movie" ? ("movie" as const) : ("series" as const),
			connectionGeneration: row.connectionGeneration!,
			identityGeneration: row.identityGeneration!,
		}));
		expect(authoritativeParent).toMatchObject({
			metadata: {
				provider: "jellyfin",
				connectionGeneration: 1,
				identityGeneration: 1,
				itemCount: 1,
				contentFingerprint: fingerprintJellyfinLibraryRows(authoritativeFingerprintRows),
			},
		});
		if (!authoritativeParent.ok) throw new Error("expected decoded parent metadata");
		expect(
			evaluateProviderCoverageReceipt(authoritativeParent.metadata.coverageReceipt),
		).toMatchObject({
			valid: true,
			complete: true,
			evidence: "complete",
			provider: "jellyfin",
			publishedCanonicalEntities: 1,
		});

		const firstProgress = await runner(context);
		expect(firstProgress).toMatchObject({
			state: "running",
			completedUnits: 1,
			completedWork: 1,
		});
		expect(firstProgress).not.toHaveProperty("reasonCode");
		const firstRun = await prisma.providerObservationRun.findFirstOrThrow({
			where: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" },
		});
		expect(firstRun).toMatchObject({
			id: expect.any(String),
			targetDigest: buildJellyfinEpisodeScopePlan(seed.scopes).targetDigest,
			completedUnits: 1,
			completedWork: 1,
		});
		expect(
			await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: firstRun.id } }),
		).toBe(1);
		expect(pageCalls).toEqual([{ userId: "user-1", libraryId: "library-1", cursor: 0 }]);
		const firstOuterAttempt = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: {
				instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" },
			},
		});
		expect(firstOuterAttempt.lastAttemptResult).toMatch(/^in_progress:/);

		const inherited = await claimObservationUnit(prisma, {
			runId: firstRun.id,
			now: context.now,
			claimToken: "inherited-future-lease",
		});
		expect(inherited).not.toBeNull();
		const beforeRecoveryStages = await prisma.jellyfinEpisodeObservationStage.count({
			where: { runId: firstRun.id },
		});
		expect(
			await reconcileInterruptedProviderCacheRefreshAttempts(prisma, {
				now: () => context.now,
			}),
		).toBe(1);
		expect(await recoverAbandonedObservationRuns(prisma)).toBe(0);
		expect(
			await stageJellyfinEpisodePage(
				prisma,
				inherited!,
				seed.scopes[0]!,
				{
					startIndex: 0,
					totalRecordCount: 1,
					items: [],
				},
				context.now,
			),
		).toBe(false);

		await runner(context);
		const recovered = await prisma.providerObservationRun.findUniqueOrThrow({
			where: { id: firstRun.id },
		});
		expect(recovered).toMatchObject({
			id: firstRun.id,
			targetDigest: firstRun.targetDigest,
			completedUnits: 2,
			completedWork: 1,
			state: "running",
		});
		expect(
			await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: firstRun.id } }),
		).toBe(beforeRecoveryStages + 1);
		expect(pageCalls).toEqual([
			{ userId: "user-1", libraryId: "library-1", cursor: 0 },
			{ userId: "user-1", libraryId: "library-1", cursor: 0 },
		]);
		const resumedOuterAttempt = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: {
				instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" },
			},
		});
		expect(resumedOuterAttempt.lastAttemptResult).toMatch(/^in_progress:/);
		expect(resumedOuterAttempt.lastAttemptResult).not.toBe(firstOuterAttempt.lastAttemptResult);
		// Validated V2 continuation skips the repeated users/libraries discovery,
		// reducing identity reads while retaining the page/finalization guards.
		expect(identityModuleMocks.readProviderIdentity).toHaveBeenCalledTimes(6);
		const beforeStaleFinalize = await prisma.jellyfinEpisodeObservationStage.count({
			where: { runId: firstRun.id },
		});
		expect(
			await finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance,
				runId: firstRun.id,
				scopes: seed.scopes,
				attempt: {
					attemptedAt: new Date("2026-09-06T00:00:00.000Z"),
					resultMarker: "in_progress:11111111-1111-4111-8111-111111111111",
				},
				now: context.now,
			}),
		).toEqual({ published: false, itemCount: 0 });
		expect(
			await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: firstRun.id } }),
		).toBe(beforeStaleFinalize);
	});

	it("keeps the same production run and cursor across a volatile parent republish", async () => {
		const prisma = await database();
		const seed = await completeFinalizerFixture(prisma);
		await prisma.providerObservationRun.delete({ where: { id: seed.run.id } });
		await prisma.cacheRefreshStatus.update({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" } },
			data: { lastAttemptResult: "success", lastAttemptErrorMessage: null },
		});
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-1" },
			data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
		});
		const instance = await prisma.serviceInstance.findUniqueOrThrow({
			where: { id: "jellyfin-1" },
		});
		const pageCalls: number[] = [];
		const runner = createJellyfinEpisodeWorkItemRunner({
			createClient: () =>
				({
					getUsers: async () => [{ id: "user-1", name: "Current User" }],
					getLibraries: async () => [{ id: "library-1" }],
					getEpisodeItemsPageWithCoverage: async (
						_userId: string,
						_libraryId: string,
						cursor: number,
					) => {
						pageCalls.push(cursor);
						return {
							startIndex: cursor,
							totalRecordCount: 2,
							items: [
								{
									type: "Episode" as const,
									id: `episode-${cursor + 1}`,
									seriesId: "series-1",
									name: "Episode",
									seasonNumber: 1,
									episodeNumber: cursor + 1,
									played: true,
									playCount: 1,
									lastPlayedDate: null,
								},
							],
						};
					},
				}) as never,
		});
		identityModuleMocks.readProviderIdentity.mockResolvedValue({
			service: "JELLYFIN",
			identityKind: "jellyfin-server-id",
			rawIdentity: "verified-provider",
			confirmationDigest: "a".repeat(64),
			fingerprint: "a".repeat(12),
		});
		const firstNow = new Date("2026-09-07T12:00:00.000Z");
		const context = {
			prisma,
			encryptor: { decrypt: () => "plaintext" },
			instance,
			log: { error: () => undefined } as never,
			now: firstNow,
		};
		const first = await runner(context);
		expect(first).toMatchObject({ state: "running", completedUnits: 0, completedWork: 0 });
		const firstRun = await prisma.providerObservationRun.findFirstOrThrow({
			where: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" },
			include: { units: { orderBy: { ordinal: "asc" } } },
		});
		expect(firstRun.units[0]).toMatchObject({ state: "pending", cursor: 1 });
		const parentStatus = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
		});
		const refreshedAt = new Date("2026-09-07T12:00:30.000Z");
		await prisma.jellyfinCache.updateMany({
			where: { instanceId: "jellyfin-1" },
			data: { title: "Show (refreshed)", watchCount: 2, lastWatchedAt: refreshedAt },
		});
		const refreshedRows = await prisma.jellyfinCache.findMany({
			where: { instanceId: "jellyfin-1" },
		});
		const refreshedMetadata = JSON.parse(parentStatus.generationMetadata!) as Record<
			string,
			unknown
		> & {
			contentFingerprint: string;
			coverageReceipt: { observedAt: string };
		};
		refreshedMetadata.contentFingerprint = fingerprintJellyfinLibraryRows(
			refreshedRows.map((row) => ({ ...row, mediaType: row.mediaType as "movie" | "series" })),
		);
		refreshedMetadata.coverageReceipt.observedAt = refreshedAt.toISOString();
		await prisma.cacheRefreshStatus.update({
			where: { id: parentStatus.id },
			data: {
				generationId: "parent-refreshed",
				generationMetadata: encodeJellyfinLibraryGenerationMetadata(refreshedMetadata),
				lastRefreshedAt: refreshedAt,
				lastAttemptAt: refreshedAt,
			},
		});

		const second = await runner({ ...context, now: new Date("2026-09-07T12:01:00.000Z") });
		const secondRuns = await prisma.providerObservationRun.findMany({
			where: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" },
			include: { units: { orderBy: { ordinal: "asc" } } },
		});
		expect(second).toMatchObject({ state: "running", completedUnits: 1, completedWork: 1 });
		expect(secondRuns).toHaveLength(1);
		expect(secondRuns[0]?.id).toBe(firstRun.id);
		expect(secondRuns[0]?.units[0]).toMatchObject({ state: "complete", cursor: 2 });
		expect(secondRuns[0]?.units.map((unit) => unit.scopePayload)).toEqual(
			firstRun.units.map((unit) => unit.scopePayload),
		);
		expect(pageCalls).toEqual([0, 1]);
	});

	it("reuses a validated V2 page plan without rediscovering scopes", async () => {
		const prisma = await database();
		const seed = await completeFinalizerFixture(prisma);
		await bindV2Fixture(prisma, seed.run.id, seed.scopes);
		await prisma.providerObservationUnit.updateMany({
			where: { runId: seed.run.id },
			data: {
				state: "pending",
				completedAt: null,
				cursor: 0,
				expectedRawCount: null,
				observedRawCount: 0,
				nextAttemptAt: null,
				claimToken: null,
			},
		});
		await prisma.jellyfinEpisodeObservationStage.deleteMany({ where: { runId: seed.run.id } });
		await prisma.providerObservationRun.update({
			where: { id: seed.run.id },
			data: { completedUnits: 0, completedWork: 0, state: "running", completedAt: null },
		});
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-1" },
			data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
		});
		await prisma.cacheRefreshStatus.update({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" } },
			data: { lastAttemptResult: "success", lastAttemptErrorMessage: null },
		});
		await prisma.cacheRefreshStatus.update({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
			data: {
				lastAttemptAt: new Date("2026-09-07T11:59:00.000Z"),
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "provider-unavailable",
			},
		});
		const instance = await prisma.serviceInstance.findUniqueOrThrow({
			where: { id: "jellyfin-1" },
		});
		identityModuleMocks.readProviderIdentity.mockResolvedValue({
			service: "JELLYFIN",
			identityKind: "jellyfin-server-id",
			rawIdentity: "verified-provider",
			confirmationDigest: "a".repeat(64),
			fingerprint: "a".repeat(12),
		});
		const pageCalls: number[] = [];
		const runner = createJellyfinEpisodeWorkItemRunner({
			createClient: () =>
				({
					getUsers: async () => {
						throw new Error("scope discovery must not run for a validated V2 continuation");
					},
					getLibraries: async () => {
						throw new Error("scope discovery must not run for a validated V2 continuation");
					},
					getEpisodeItemsPageWithCoverage: async (
						_userId: string,
						_libraryId: string,
						cursor: number,
					) => {
						pageCalls.push(cursor);
						return {
							startIndex: cursor,
							totalRecordCount: 1,
							items: [
								{
									type: "Episode" as const,
									id: "episode-1",
									seriesId: "series-1",
									name: "Episode",
									seasonNumber: 1,
									episodeNumber: 1,
									played: true,
									playCount: 1,
									lastPlayedDate: null,
								},
							],
						};
					},
				}) as never,
		});

		const result = await runner({
			prisma,
			encryptor: { decrypt: () => "plaintext" },
			instance,
			log: { error: () => undefined } as never,
			now: new Date("2026-09-07T12:00:00.000Z"),
		});
		expect(result).toMatchObject({ state: "running", completedUnits: 1, completedWork: 1 });
		expect(pageCalls).toEqual([0]);
	});

	it("preserves completed V2 staging while a compatible parent attempt is unavailable", async () => {
		const prisma = await database();
		const seed = await completeFinalizerFixture(prisma);
		await bindV2Fixture(prisma, seed.run.id, seed.scopes);
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-1" },
			data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
		});
		await prisma.cacheRefreshStatus.update({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
			data: {
				lastAttemptAt: new Date("2026-09-07T11:59:00.000Z"),
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "provider-unavailable",
			},
		});
		const instance = await prisma.serviceInstance.findUniqueOrThrow({
			where: { id: "jellyfin-1" },
		});
		identityModuleMocks.readProviderIdentity.mockResolvedValue({
			service: "JELLYFIN",
			identityKind: "jellyfin-server-id",
			rawIdentity: "verified-provider",
			confirmationDigest: "a".repeat(64),
			fingerprint: "a".repeat(12),
		});
		const beforeStages = await prisma.jellyfinEpisodeObservationStage.findMany({
			where: { runId: seed.run.id },
			orderBy: { id: "asc" },
		});
		const beforeEpisodeCache = await prisma.jellyfinEpisodeCache.findMany({
			where: { instanceId: "jellyfin-1" },
			orderBy: { id: "asc" },
		});
		const runner = createJellyfinEpisodeWorkItemRunner({
			createClient: () =>
				({
					getUsers: async () => {
						throw new Error("fresh discovery must wait for parent recovery");
					},
					getLibraries: async () => {
						throw new Error("fresh discovery must wait for parent recovery");
					},
				}) as never,
		});
		const result = await runner({
			prisma,
			encryptor: { decrypt: () => "plaintext" },
			instance,
			log: { error: () => undefined } as never,
			now: new Date("2026-09-07T12:00:00.000Z"),
		});
		expect(result).toMatchObject({ state: "running", completedUnits: 2, completedWork: 1 });
		expect(result).toHaveProperty("retryableDependencyFailure", true);
		expect(
			await prisma.jellyfinEpisodeObservationStage.findMany({
				where: { runId: seed.run.id },
				orderBy: { id: "asc" },
			}),
		).toEqual(beforeStages);
		expect(
			await prisma.jellyfinEpisodeCache.findMany({
				where: { instanceId: "jellyfin-1" },
				orderBy: { id: "asc" },
			}),
		).toEqual(beforeEpisodeCache);
	});

	it.each([
		"new-run",
		"failed-run",
		"legacy-run",
		"expired-parent",
		"changed-rows",
		"changed-count",
		"changed-identity",
		"changed-parent-key",
		"wrong-error",
		"in-progress",
		"future-attempt",
		"old-attempt",
	])("rejects last-good parent continuation for %s", async (scenario) => {
		const prisma = await database();
		const seed = await completeFinalizerFixture(prisma);
		if (scenario !== "legacy-run") await bindV2Fixture(prisma, seed.run.id, seed.scopes);
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-1" },
			data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
		});
		await prisma.cacheRefreshStatus.update({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
			data: {
				lastAttemptAt: new Date("2026-09-07T11:59:00.000Z"),
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "provider-unavailable",
			},
		});
		if (scenario === "new-run")
			await prisma.providerObservationRun.delete({ where: { id: seed.run.id } });
		if (scenario === "failed-run")
			await prisma.providerObservationRun.update({
				where: { id: seed.run.id },
				data: { state: "failed" },
			});
		if (scenario === "changed-parent-key")
			await prisma.providerObservationRun.update({
				where: { id: seed.run.id },
				data: { parentGenerationId: jellyfinEpisodeParentGenerationKey("c".repeat(64)) },
			});
		if (scenario === "changed-rows")
			await prisma.jellyfinCache.updateMany({
				where: { instanceId: "jellyfin-1" },
				data: { title: "Changed after receipt" },
			});
		if (scenario === "changed-identity")
			await prisma.serviceInstance.update({
				where: { id: "jellyfin-1" },
				data: { identityGeneration: 2 },
			});
		if (
			["changed-count", "wrong-error", "in-progress", "future-attempt", "old-attempt"].includes(
				scenario,
			)
		)
			await prisma.cacheRefreshStatus.update({
				where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
				data: {
					...(scenario === "changed-count" ? { itemCount: 2 } : {}),
					...(scenario === "wrong-error" ? { lastAttemptErrorMessage: "coverage-incomplete" } : {}),
					...(scenario === "in-progress"
						? { lastAttemptResult: "in_progress:another-attempt" }
						: {}),
					...(scenario === "future-attempt"
						? { lastAttemptAt: new Date("2026-09-08T00:00:00Z") }
						: {}),
					...(scenario === "old-attempt"
						? { lastAttemptAt: new Date("2026-09-06T00:00:00Z") }
						: {}),
				},
			});
		const instance = await prisma.serviceInstance.findUniqueOrThrow({
			where: { id: "jellyfin-1" },
		});
		const read = vi.fn(async () => {
			throw new Error("provider must not be read");
		});
		const runner = createJellyfinEpisodeWorkItemRunner({
			createClient: () =>
				({ getUsers: read, getLibraries: read, getEpisodeItemsPageWithCoverage: read }) as never,
		});
		const before = await prisma.jellyfinEpisodeCache.findMany({
			where: { instanceId: "jellyfin-1" },
			orderBy: { id: "asc" },
		});
		const result = await runner({
			prisma,
			encryptor: { decrypt: () => "plaintext" },
			instance,
			log: { error: () => undefined } as never,
			now: new Date(
				scenario === "expired-parent" ? "2026-09-08T12:00:00Z" : "2026-09-07T12:00:00Z",
			),
		});
		expect(result.state).toBe("failed");
		expect(read).not.toHaveBeenCalled();
		expect(
			await prisma.jellyfinEpisodeCache.findMany({
				where: { instanceId: "jellyfin-1" },
				orderBy: { id: "asc" },
			}),
		).toEqual(before);
		if (scenario === "new-run") expect(await prisma.providerObservationRun.count()).toBe(0);
	});

	it.each(["discovery-timeout", "parent-failure-during-discovery"])(
		"preserves completed stage after %s and publishes only after recovery",
		async (failure) => {
			const prisma = await database();
			const seed = await completeFinalizerFixture(prisma);
			await bindV2Fixture(prisma, seed.run.id, seed.scopes);
			await prisma.serviceInstance.update({
				where: { id: "jellyfin-1" },
				data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
			});
			const instance = await prisma.serviceInstance.findUniqueOrThrow({
				where: { id: "jellyfin-1" },
			});
			identityModuleMocks.readProviderIdentity.mockResolvedValue({
				service: "JELLYFIN",
				identityKind: "jellyfin-server-id",
				rawIdentity: "verified-provider",
				confirmationDigest: "a".repeat(64),
				fingerprint: "a".repeat(12),
			});
			const libraries = vi
				.fn()
				.mockImplementationOnce(async () => {
					if (failure === "discovery-timeout") throw new Error("synthetic Views timeout");
					await prisma.cacheRefreshStatus.update({
						where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
						data: {
							lastAttemptAt: new Date("2026-09-07T11:59:00Z"),
							lastAttemptResult: "error",
							lastAttemptErrorMessage: "provider-unavailable",
						},
					});
					return [{ id: "library-1" }];
				})
				.mockResolvedValue([{ id: "library-1" }]);
			const runner = createJellyfinEpisodeWorkItemRunner({
				createClient: () =>
					({
						getUsers: async () => [{ id: "user-1", name: "Fresh Name" }],
						getLibraries: libraries,
					}) as never,
			});
			const context = {
				prisma,
				encryptor: { decrypt: () => "plaintext" },
				instance,
				log: { error: () => undefined } as never,
				now: new Date("2026-09-07T12:00:00Z"),
			};
			const before = await finalizerState(prisma, seed.run.id);
			expect(await runner(context)).toMatchObject({
				state: "running",
				completedUnits: 2,
				retryableDependencyFailure: true,
			});
			const after = await finalizerState(prisma, seed.run.id);
			expect(after.stages).toEqual(before.stages);
			expect(after.rows).toEqual(before.rows);
			if (failure === "parent-failure-during-discovery") {
				const parent = await prisma.cacheRefreshStatus.findUniqueOrThrow({
					where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
				});
				await prisma.cacheRefreshStatus.update({
					where: { id: parent.id },
					data: {
						lastAttemptAt: parent.lastRefreshedAt,
						lastAttemptResult: "success",
						lastAttemptErrorMessage: null,
					},
				});
			}
			expect(await runner({ ...context, now: new Date("2026-09-07T12:01:00Z") })).toMatchObject({
				state: "complete",
				publishedItemCount: 1,
			});
			expect(libraries).toHaveBeenCalledTimes(2);
		},
	);

	it.each([false, true])(
		"resumes immutable V3 staged progress with overlap=%s and completes the next refresh",
		async (overlap) => {
			const prisma = await database();
			const seed = await completeFinalizerFixture(prisma);
			await bindV2Fixture(prisma, seed.run.id, seed.scopes);
			await bindV3Fixture(prisma, seed.run.id);
			const instance = await prisma.serviceInstance.update({
				where: { id: "jellyfin-1" },
				data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
			});
			await prisma.cacheRefreshStatus.update({
				where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "jellyfin_episode" } },
				data: { lastAttemptResult: "in_progress:11111111-1111-4111-8111-111111111111" },
			});
			await prisma.providerObservationUnit.updateMany({
				where: { runId: seed.run.id, phase: "verify" },
				data: { state: "pending", completedAt: null, expectedRawCount: 2 },
			});
			await prisma.providerObservationRun.update({
				where: { id: seed.run.id },
				data: { completedUnits: 1 },
			});
			const before = await finalizerState(prisma, seed.run.id);
			const originalRow = await prisma.jellyfinCache.findFirstOrThrow({
				where: { instanceId: instance.id },
			});
			await prisma.jellyfinCache.create({
				data: { ...originalRow, id: "added-series-row", jellyfinId: "added-series", tmdbId: 43 },
			});
			await rewriteAuthoritativeParent(prisma);
			identityModuleMocks.readProviderIdentity.mockResolvedValue({
				service: "JELLYFIN",
				identityKind: "jellyfin-server-id",
				rawIdentity: "verified-provider",
				confirmationDigest: "a".repeat(64),
				fingerprint: "a".repeat(12),
			});
			const items = ["series-1", "added-series"].map((seriesId, index) => ({
				type: "Episode" as const,
				id: `episode-${index + 1}`,
				seriesId,
				name: "Episode",
				seasonNumber: 1,
				episodeNumber: 1,
				played: true,
				playCount: 1,
				lastPlayedDate: null,
			}));
			const page = vi.fn(async (_user: string, _library: string, cursor: number) => ({
				startIndex: cursor,
				totalRecordCount: overlap ? (cursor === 0 ? 2 : 3) : 2,
				items: overlap ? (cursor === 0 ? [items[0]!] : items) : items.slice(cursor),
			}));
			const users = vi.fn(async () => [{ id: "user-1", name: "Current User" }]);
			const runner = createJellyfinEpisodeWorkItemRunner({
				createClient: () =>
					({
						getUsers: users,
						getLibraries: async () => [{ id: "library-1" }],
						getEpisodeItemsPageWithCoverage: page,
					}) as never,
			});
			const context = {
				prisma,
				instance,
				encryptor: { decrypt: () => "plaintext" },
				log: { warn: () => undefined, error: () => undefined } as never,
				now: new Date("2026-09-07T12:00:00Z"),
			};
			expect(await runner(context)).toMatchObject({
				state: "running",
				progressed: true,
				completedUnits: 2,
			});
			expect(page.mock.calls[0]?.[2]).toBe(1);
			expect(users).not.toHaveBeenCalled();
			const resumed = await finalizerState(prisma, seed.run.id);
			expect(resumed.run.parentGenerationId).toBe(before.run.parentGenerationId);
			expect(resumed.run.targetDigest).toBe(before.run.targetDigest);
			for (const original of before.stages) expect(resumed.stages).toContainEqual(original);
			expect(await runner(context)).toMatchObject({ state: "complete", publishedItemCount: 1 });
			const first = await finalizerState(prisma, seed.run.id);
			expect(JSON.parse(first.status.generationMetadata!)).toMatchObject({ version: 3 });
			expect(first.rows.map((row) => row.showTmdbId)).toEqual([42]);
			for (let index = 0; index < (overlap ? 5 : 3); index++)
				await runner({
					...context,
					now: new Date(Date.parse("2026-09-07T12:01:00Z") + index * 11_000),
				});
			const second = await prisma.cacheRefreshStatus.findUniqueOrThrow({
				where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "jellyfin_episode" } },
			});
			expect(second.generationId).not.toBe(first.status.generationId);
			expect(second.itemCount).toBe(2);
			expect(second.lastAttemptResult).toBe("success");
			const decoded = decodeJellyfinEpisodeGenerationMetadata(second.generationMetadata);
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) throw new Error("expected usable positive metadata");
			for (const unit of decoded.metadata.coverageReceipt.units) {
				expect(unit).toMatchObject({
					rawObserved: overlap ? 3 : 2,
					sourceBindings: 2,
					canonicalEntities: 2,
				});
			}
			const readInput = {
				prisma,
				userId: "user-1",
				instanceId: instance.id,
				cacheType: "jellyfin_episode" as const,
				now: new Date("2026-09-07T12:02:00Z"),
			};
			const display = await readOwnedJellyfinObservation({ ...readInput, mode: "display" });
			if (!display) throw new Error("expected display observation");
			expect(display).toMatchObject({ available: true, mutationAvailable: false });
			expect(display.rows).toHaveLength(2);
			expect(await readOwnedJellyfinObservation({ ...readInput, mode: "mutation" })).toMatchObject({
				available: false,
				mutationAvailable: false,
			});
			expect(JSON.parse(second.generationMetadata!)).toMatchObject({
				version: 3,
				publicationLevel: "positive-only",
				completeness: "partial",
			});
		},
	);

	it("settles an inherited V2 attempt after an added series and admits a fresh plan without restart", async () => {
		const prisma = await database();
		const seed = await completeFinalizerFixture(prisma);
		await bindV2Fixture(prisma, seed.run.id, seed.scopes);
		const instance = await prisma.serviceInstance.update({
			where: { id: "jellyfin-1" },
			data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
		});
		const marker = "in_progress:11111111-1111-4111-8111-111111111111";
		await prisma.cacheRefreshStatus.update({
			where: { instanceId_cacheType: { instanceId: instance.id, cacheType: "jellyfin_episode" } },
			data: { lastAttemptResult: marker },
		});
		const originalRow = await prisma.jellyfinCache.findFirstOrThrow({
			where: { instanceId: instance.id },
		});
		await prisma.jellyfinCache.create({
			data: { ...originalRow, id: "added-series-row", jellyfinId: "added-series", tmdbId: 43 },
		});
		await rewriteAuthoritativeParent(prisma);
		const before = await finalizerState(prisma, seed.run.id);
		expect(before.stages).toHaveLength(2);
		identityModuleMocks.readProviderIdentity.mockResolvedValue({
			service: "JELLYFIN",
			identityKind: "jellyfin-server-id",
			rawIdentity: "verified-provider",
			confirmationDigest: "a".repeat(64),
			fingerprint: "a".repeat(12),
		});
		const users = vi.fn(async () => [{ id: "user-1", name: "Current User" }]);
		const libraries = vi.fn(async () => [{ id: "library-1" }]);
		const page = vi.fn(async () => ({ startIndex: 0, totalRecordCount: 0, items: [] }));
		const runner = createJellyfinEpisodeWorkItemRunner({
			createClient: () =>
				({
					getUsers: users,
					getLibraries: libraries,
					getEpisodeItemsPageWithCoverage: page,
				}) as never,
		});
		const context = {
			prisma,
			instance,
			encryptor: { decrypt: () => "plaintext" },
			log: { warn: () => undefined, error: () => undefined } as never,
			now: new Date("2026-09-07T12:00:00Z"),
		};

		expect(await runner(context)).toMatchObject({ state: "failed", replanRequired: true });
		const after = await finalizerState(prisma, seed.run.id);
		expect(after.rows).toEqual(before.rows);
		expect(after.stages).toHaveLength(0);
		expect(after.run).toMatchObject({ state: "invalidated", activeSlotKey: null });
		expect(after.status).toMatchObject({
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "coverage-incomplete",
			generationId: before.status?.generationId,
			generationMetadata: before.status?.generationMetadata,
		});
		expect(users).not.toHaveBeenCalled();
		expect(page).not.toHaveBeenCalled();

		expect(await runner({ ...context, now: new Date("2026-09-07T12:00:30Z") })).toMatchObject({
			state: "running",
			completedUnits: 1,
			progressed: true,
		});
		const replacement = await prisma.providerObservationRun.findFirstOrThrow({
			where: { instanceId: instance.id, activeSlotKey: { not: null } },
		});
		expect(replacement.id).not.toBe(seed.run.id);
		expect(users).toHaveBeenCalledOnce();
		expect(libraries).toHaveBeenCalledOnce();
		expect(page).toHaveBeenCalledOnce();
		expect(await prisma.jellyfinEpisodeCache.findMany()).toEqual(before.rows);
	});

	it("requires fresh scope discovery before publishing a completed V2 run", async () => {
		const prisma = await database();
		const seed = await completeFinalizerFixture(prisma);
		await bindV2Fixture(prisma, seed.run.id, seed.scopes);
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-1" },
			data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
		});
		const instance = await prisma.serviceInstance.findUniqueOrThrow({
			where: { id: "jellyfin-1" },
		});
		identityModuleMocks.readProviderIdentity.mockResolvedValue({
			service: "JELLYFIN",
			identityKind: "jellyfin-server-id",
			rawIdentity: "verified-provider",
			confirmationDigest: "a".repeat(64),
			fingerprint: "a".repeat(12),
		});
		const users = vi.fn(async () => [{ id: "user-1", name: "Fresh User Name" }]);
		const libraries = vi.fn(async () => [{ id: "library-1" }]);
		const runner = createJellyfinEpisodeWorkItemRunner({
			createClient: () =>
				({
					getUsers: users,
					getLibraries: libraries,
				}) as never,
		});
		const result = await runner({
			prisma,
			encryptor: { decrypt: () => "plaintext" },
			instance,
			log: { error: () => undefined } as never,
			now: new Date("2026-09-07T12:00:00.000Z"),
		});
		expect(result).toMatchObject({ state: "complete", completedUnits: 2, publishedItemCount: 1 });
		expect(users).toHaveBeenCalledOnce();
		expect(libraries).toHaveBeenCalledOnce();
	});

	it("does not invalidate completed staged work when a newer outer attempt supersedes runner finalization", async () => {
		const prisma = await database();
		const seed = await completeFinalizerFixture(prisma);
		const parent = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
		});
		await prisma.cacheRefreshStatus.update({
			where: { id: parent.id },
			data: { generationMetadata: lowerBoundMappingParentMetadata(parent.generationMetadata!) },
		});
		const currentParent = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
		});
		const currentParentRows = await prisma.jellyfinCache.findMany({
			where: { instanceId: "jellyfin-1" },
		});
		const currentParentDependency = fingerprintJellyfinEpisodeParentDependency(
			"jellyfin-1",
			currentParent.generationMetadata,
			currentParentRows.map((row) => ({
				...row,
				mediaType: row.mediaType as "movie" | "series",
			})),
		);
		expect(currentParentDependency).toMatch(/^[a-f0-9]{64}$/);
		await prisma.providerObservationRun.update({
			where: { id: seed.run.id },
			data: {
				parentGenerationId: jellyfinEpisodeParentGenerationKey(currentParentDependency!),
				authorityKey: buildObservationAuthorityKey({
					provider: "jellyfin_episode",
					cacheType: "jellyfin_episode",
					instanceId: "jellyfin-1",
					parentGenerationId: jellyfinEpisodeParentGenerationKey(currentParentDependency!),
					targetDigest: seed.run.targetDigest,
					connectionGeneration: 1,
					identityGeneration: 1,
				}),
			},
		});
		await prisma.cacheRefreshStatus.update({
			where: {
				instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" },
			},
			data: {
				lastAttemptAt: new Date("2026-09-07T12:00:00.000Z"),
				lastAttemptResult: "in_progress:11111111-1111-4111-8111-111111111111",
				lastAttemptErrorMessage: null,
			},
		});
		await prisma.serviceInstance.update({
			where: { id: "jellyfin-1" },
			data: { expectedIdentity: "verified-provider", identityStatus: "VERIFIED" },
		});
		const instance = await prisma.serviceInstance.findUniqueOrThrow({
			where: { id: "jellyfin-1" },
		});
		await bindV2Fixture(prisma, seed.run.id, seed.scopes);
		const before = await finalizerState(prisma, seed.run.id);
		const attemptA = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: {
				instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" },
			},
		});
		const markerB = "in_progress:22222222-2222-4222-8222-222222222222";
		let identityReads = 0;
		identityModuleMocks.readProviderIdentity.mockImplementation(async () => {
			identityReads += 1;
			if (identityReads === 4) {
				await prisma.cacheRefreshStatus.update({
					where: {
						instanceId_cacheType: {
							instanceId: "jellyfin-1",
							cacheType: "jellyfin_episode",
						},
					},
					data: {
						lastAttemptAt: new Date("2026-09-07T12:00:01.000Z"),
						lastAttemptResult: markerB,
						lastAttemptErrorMessage: null,
					},
				});
			}
			return {
				service: "JELLYFIN" as const,
				identityKind: "jellyfin-server-id" as const,
				rawIdentity: "verified-provider",
				confirmationDigest: "a".repeat(64),
				fingerprint: "a".repeat(12),
			};
		});
		const runner = createJellyfinEpisodeWorkItemRunner({
			createClient: () =>
				({
					getUsers: async () => [{ id: "user-1", name: "Current User" }],
					getLibraries: async () => [{ id: "library-1" }],
				}) as never,
		});

		await runner({
			prisma,
			encryptor: { decrypt: () => "plaintext" },
			instance,
			log: { error: () => undefined } as never,
			now: new Date("2026-09-07T12:00:00.000Z"),
		});

		expect(identityReads).toBe(4);
		const after = await finalizerState(prisma, seed.run.id);
		expect(after.stages).toEqual(before.stages);
		expect(after.run).toMatchObject({
			id: seed.run.id,
			state: "running",
			activeSlotKey: expect.any(String),
			completedUnits: before.run.completedUnits,
			completedWork: before.run.completedWork,
		});
		expect(after.status.lastAttemptResult).toBe(markerB);
		expect(after.status.lastAttemptResult).not.toBe(attemptA.lastAttemptResult);
		expect(after.rows).toEqual(before.rows);
	});

	it("refuses a future-lease Jellyfin claim without a matching outer marker", async () => {
		const prisma = await database();
		const scope = { userId: "user-1", userName: "Current User", libraryId: "library-1" };
		const plan = buildJellyfinEpisodeScopePlan([scope]);
		const run = await createOrLoadObservationRun(prisma, {
			authority: {
				provider: "jellyfin_episode",
				cacheType: "jellyfin_episode",
				instanceId: "jellyfin-1",
				parentGenerationId: "parent-1",
				targetDigest: plan.targetDigest,
				connectionGeneration: 1,
				identityGeneration: 1,
			},
			units: plan.units,
		});
		const claim = await claimObservationUnit(prisma, {
			runId: run.id,
			now: new Date("2026-09-07T00:00:00.000Z"),
			claimToken: "inherited",
		});
		expect(claim).not.toBeNull();
		await prisma.jellyfinEpisodeObservationStage.create({
			data: {
				runId: run.id,
				unitId: claim!.unitId,
				userKeyDigest: hash(["jellyfin-user", scope.userId]),
				pass: "collect",
				jellyfinId: "episode-1",
				seriesId: "series-1",
				seasonNumber: 1,
				episodeNumber: 1,
				title: "Episode",
				played: true,
				playCount: 1,
				lastPlayedAt: null,
				userName: "",
			},
		});

		await expect(reconcileInterruptedProviderCacheRefreshAttempts(prisma)).rejects.toThrow(
			"unmatched inherited claim",
		);
		expect(await prisma.providerObservationRun.findUnique({ where: { id: run.id } })).toMatchObject(
			{
				id: run.id,
				targetDigest: plan.targetDigest,
				state: "running",
			},
		);
		expect(await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(
			1,
		);
		expect(
			await claimObservationUnit(prisma, {
				runId: run.id,
				now: new Date("2026-09-07T00:00:00.000Z"),
				claimToken: "resumed",
			}),
		).toBeNull();
	});

	it("atomically replaces the populated cache, status, stages, and active run after equal passes", async () => {
		const prisma = await database();
		const { attempt, run, scopes } = await completeFinalizerFixture(prisma);

		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				scopes,
				attempt,
				now: new Date("2026-09-07T00:01:00.000Z"),
			}),
		).resolves.toEqual({ published: true, itemCount: 1 });

		expect(
			await prisma.jellyfinEpisodeCache.findMany({ where: { instanceId: "jellyfin-1" } }),
		).toEqual([
			expect.objectContaining({
				showTmdbId: 42,
				jellyfinId: "episode-1",
				watchedByUsers: '["Current User"]',
			}),
		]);
		expect(await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(
			0,
		);
		expect(await prisma.providerObservationRun.findUnique({ where: { id: run.id } })).toMatchObject(
			{
				state: "complete",
				activeSlotKey: null,
			},
		);
		expect(
			await prisma.cacheRefreshStatus.findUnique({
				where: {
					instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" },
				},
			}),
		).toMatchObject({ lastResult: "success", itemCount: 1, lastAttemptResult: "success" });
	});

	it("uses a caller-provided authority transaction for the final replacement", async () => {
		const prisma = await database();
		const { attempt, run, scopes } = await completeFinalizerFixture(prisma);

		await expect(
			prisma.$transaction(async (tx) => {
				return await finalizeJellyfinEpisodeRun({
					prisma,
					transaction: tx,
					userId: "user-1",
					instance: { id: "jellyfin-1" },
					runId: run.id,
					scopes,
					attempt,
					now: new Date("2026-09-07T00:01:00.000Z"),
					testHooks: {
						beforePublish: (publicationTx) => {
							expect(publicationTx).toBe(tx);
						},
					},
				});
			}),
		).resolves.toEqual({ published: true, itemCount: 1 });
	});

	it("preserves the active run and staged rows when a newer exact outer attempt supersedes finalization", async () => {
		const prisma = await database();
		const { attempt, run, scopes } = await completeFinalizerFixture(prisma);
		await prisma.cacheRefreshStatus.update({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" } },
			data: { lastAttemptResult: "in_progress:replacement" },
		});

		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				scopes,
				attempt,
				now: new Date("2026-09-07T00:02:00.000Z"),
			}),
		).resolves.toEqual({ published: false, itemCount: 0 });

		expect(await prisma.jellyfinEpisodeCache.findMany()).toEqual([
			expect.objectContaining({ showTmdbId: 99, jellyfinId: "old" }),
		]);
		expect(await prisma.providerObservationRun.findUnique({ where: { id: run.id } })).toMatchObject(
			{
				state: "running",
				activeSlotKey: expect.any(String),
			},
		);
		expect(await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: run.id } })).toBe(
			2,
		);
	});

	it("invalidates a run with missing finalization authority and permits a replacement run", async () => {
		const prisma = await database();
		const { attempt, plan, run } = await completeFinalizerFixture(prisma);

		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				attempt,
			}),
		).resolves.toEqual({ published: false, itemCount: 0 });

		await expectInvalidatedWithPublishedCachePreserved(prisma, run.id);
		const replacement = await createOrLoadObservationRun(prisma, {
			authority: {
				provider: "jellyfin_episode",
				cacheType: "jellyfin_episode",
				instanceId: "jellyfin-1",
				parentGenerationId: "parent-1",
				targetDigest: plan.targetDigest,
				connectionGeneration: 1,
				identityGeneration: 1,
			},
			units: plan.units,
		});
		expect(replacement.id).not.toBe(run.id);
		expect(replacement).toMatchObject({ state: "running", activeSlotKey: expect.any(String) });
	});

	it("rolls back rows, status, run, and stages when terminalization throws after publication", async () => {
		const prisma = await database();
		const { attempt, run, scopes } = await completeFinalizerFixture(prisma);
		const before = await finalizerState(prisma, run.id);

		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				scopes,
				attempt,
				now: new Date("2026-09-07T00:02:00.000Z"),
				testHooks: {
					afterPublish: () => {
						throw new Error("injected Jellyfin terminalization failure");
					},
				},
			}),
		).rejects.toThrow("injected Jellyfin terminalization failure");

		expect(await finalizerState(prisma, run.id)).toEqual(before);
	});

	it("rolls back an exact status-attempt CAS loss without consuming staged work", async () => {
		const prisma = await database();
		const { attempt, run, scopes } = await completeFinalizerFixture(prisma);
		const before = await finalizerState(prisma, run.id);

		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				scopes,
				attempt,
				now: new Date("2026-09-07T00:02:00.000Z"),
				testHooks: {
					beforePublish: async (tx) => {
						await tx.cacheRefreshStatus.update({
							where: {
								instanceId_cacheType: {
									instanceId: "jellyfin-1",
									cacheType: "jellyfin_episode",
								},
							},
							data: { lastAttemptResult: "in_progress:replacement" },
						});
					},
				},
			}),
		).rejects.toThrow("Jellyfin episode publication was superseded");

		expect(await finalizerState(prisma, run.id)).toEqual(before);
	});

	it.each([
		["item identity", { jellyfinId: "episode-replaced" }],
		["Played", { played: false }],
		["PlayCount", { playCount: 2 }],
		["LastPlayedDate", { lastPlayedAt: new Date("2026-09-07T00:00:01.000Z") }],
	])("invalidates changed %s facts between collect and verify", async (_field, drift) => {
		const prisma = await database();
		const { attempt, run, scopes } = await completeFinalizerFixture(prisma);
		const verifyUnit = await prisma.providerObservationUnit.findFirstOrThrow({
			where: { runId: run.id, phase: "verify" },
		});
		await prisma.jellyfinEpisodeObservationStage.updateMany({
			where: { runId: run.id, unitId: verifyUnit.id },
			data: drift,
		});

		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				scopes,
				attempt,
				now: new Date("2026-09-07T00:02:00.000Z"),
			}),
		).resolves.toEqual({ published: false, itemCount: 0 });

		await expectInvalidatedWithPublishedCachePreserved(prisma, run.id);
	});

	it("does not invalidate another owner's run when finalization ownership is absent", async () => {
		const prisma = await database();
		const { attempt, run, scopes } = await completeFinalizerFixture(prisma);
		const before = await finalizerState(prisma, run.id);

		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "different-user",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				scopes,
				attempt,
			}),
		).resolves.toEqual({ published: false, itemCount: 0 });

		expect(await finalizerState(prisma, run.id)).toEqual(before);
	});

	it("merges distinct provider-series copies mapped to one TMDB episode coordinate", async () => {
		const prisma = await database();
		const { attempt, run, scopes } = await completeFinalizerFixture(prisma);
		await prisma.jellyfinCache.create({
			data: {
				instanceId: "jellyfin-1",
				tmdbId: 42,
				mediaType: "series",
				libraryId: "library-2",
				libraryName: "Second Library",
				title: "Second Show Copy",
				jellyfinId: "series-2",
				lastWatchedAt: null,
				watchCount: 0,
				watchedByUsers: "[]",
				onDeck: false,
				userRating: null,
				collections: "[]",
				addedAt: null,
				thumb: null,
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		await rewriteAuthoritativeParent(prisma);
		await addStagePair(prisma, run.id, {
			jellyfinId: "episode-2",
			seriesId: "series-2",
			played: true,
		});

		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				scopes,
				attempt,
				now: new Date("2026-09-07T00:02:00.000Z"),
			}),
		).resolves.toEqual({ published: true, itemCount: 1 });

		expect(await prisma.jellyfinEpisodeCache.findMany()).toEqual([
			expect.objectContaining({ showTmdbId: 42, jellyfinId: "episode-1", watched: true }),
		]);
	});

	it("publishes known mapped episodes while retaining unrelated ambiguous mappings as unknown", async () => {
		const prisma = await database();
		const { attempt, run, scopes } = await completeFinalizerFixture(prisma);
		await prisma.jellyfinCache.create({
			data: {
				instanceId: "jellyfin-1",
				tmdbId: 44,
				mediaType: "series",
				libraryId: "library-2",
				libraryName: "Mapped Library",
				title: "Known Mapping",
				jellyfinId: "series-2",
				lastWatchedAt: null,
				watchCount: 0,
				watchedByUsers: "[]",
				onDeck: false,
				userRating: null,
				collections: "[]",
				addedAt: null,
				thumb: null,
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		await prisma.jellyfinCache.create({
			data: {
				instanceId: "jellyfin-1",
				tmdbId: 43,
				mediaType: "series",
				libraryId: "library-2",
				libraryName: "Second Library",
				title: "Conflicting Mapping",
				jellyfinId: "series-1",
				lastWatchedAt: null,
				watchCount: 0,
				watchedByUsers: "[]",
				onDeck: false,
				userRating: null,
				collections: "[]",
				addedAt: null,
				thumb: null,
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		await rewriteAuthoritativeParent(prisma);
		await addStagePair(prisma, run.id, {
			jellyfinId: "episode-2",
			seriesId: "series-2",
			episodeNumber: 2,
		});
		await prisma.providerObservationUnit.updateMany({
			where: { runId: run.id },
			data: { cursor: 2, expectedRawCount: 2, observedRawCount: 2 },
		});

		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				scopes,
				attempt,
				now: new Date("2026-09-07T00:02:00.000Z"),
			}),
		).resolves.toEqual({ published: true, itemCount: 1 });
		expect(await prisma.jellyfinEpisodeCache.findMany()).toEqual([
			expect.objectContaining({ showTmdbId: 44, jellyfinId: "episode-2" }),
		]);
		const status = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin_episode" } },
		});
		const decoded = decodeJellyfinEpisodeGenerationMetadata(status.generationMetadata);
		expect(decoded.ok).toBe(true);
		if (decoded.ok) {
			expect(decoded.metadata).toMatchObject({
				publicationLevel: "positive-only",
				completeness: "partial",
				coverageReceipt: {
					version: 2,
					evidence: "positive-only",
					domains: [
						expect.objectContaining({
							domain: "episode-inventory",
							valueSemantics: "lower-bound",
						}),
					],
				},
			});
			expect(decoded.metadata.coverageReceipt.units).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						acceptedSkips: [{ reason: "missing-supported-mapping", count: 1 }],
					}),
				]),
			);
		}
	});

	it("publishes no false row for an unmapped provider series and records the accepted skip", async () => {
		const prisma = await database();
		const { attempt, run, scopes } = await completeFinalizerFixture(prisma);
		await prisma.jellyfinEpisodeObservationStage.updateMany({
			where: { runId: run.id },
			data: { seriesId: "unmapped-series" },
		});

		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				scopes,
				attempt,
				now: new Date("2026-09-07T00:02:00.000Z"),
			}),
		).resolves.toEqual({ published: true, itemCount: 0 });

		expect(await prisma.jellyfinEpisodeCache.findMany()).toEqual([]);
		const status = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: {
				instanceId_cacheType: {
					instanceId: "jellyfin-1",
					cacheType: "jellyfin_episode",
				},
			},
		});
		const decoded = decodeJellyfinEpisodeGenerationMetadata(status.generationMetadata);
		expect(decoded.ok).toBe(true);
		if (decoded.ok) {
			expect(decoded.metadata.coverageReceipt.units).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sourceBindings: 0,
						canonicalEntities: 0,
						acceptedSkips: [{ reason: "missing-supported-mapping", count: 1 }],
					}),
				]),
			);
		}
	});

	it("accepts a mixed-domain parent when inventory and mapping remain exact", async () => {
		const prisma = await database();
		const { attempt, run, scopes } = await completeFinalizerFixture(prisma);
		const parentStatus = await prisma.cacheRefreshStatus.findUniqueOrThrow({
			where: { instanceId_cacheType: { instanceId: "jellyfin-1", cacheType: "jellyfin" } },
		});
		const mixedMetadata = mixedDomainParentMetadata(parentStatus.generationMetadata!);
		const decodedParent = decodeJellyfinLibraryGenerationMetadata(mixedMetadata);
		expect(decodedParent.ok).toBe(true);
		if (decodedParent.ok) {
			expect(hasAuthoritativeJellyfinLibraryReceipt(decodedParent.metadata.coverageReceipt)).toBe(
				true,
			);
		}
		await prisma.cacheRefreshStatus.update({
			where: { id: parentStatus.id },
			data: {
				generationMetadata: mixedMetadata,
			},
		});

		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				scopes,
				attempt,
				now: new Date("2026-09-07T00:02:00.000Z"),
			}),
		).resolves.toEqual({ published: true, itemCount: 1 });
	});

	it("publishes an exact empty episode inventory and evicts only stale episode rows", async () => {
		const prisma = await database();
		const { attempt, run, scopes } = await completeFinalizerFixture(prisma);
		await prisma.jellyfinCache.deleteMany({ where: { instanceId: "jellyfin-1" } });
		await rewriteAuthoritativeParent(prisma);
		await prisma.jellyfinEpisodeObservationStage.deleteMany({ where: { runId: run.id } });
		await prisma.providerObservationUnit.updateMany({
			where: { runId: run.id },
			data: { cursor: 0, expectedRawCount: 0, observedRawCount: 0 },
		});

		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				scopes,
				attempt,
				now: new Date("2026-09-07T00:02:00.000Z"),
			}),
		).resolves.toEqual({ published: true, itemCount: 0 });

		expect(await prisma.jellyfinEpisodeCache.findMany()).toEqual([]);
		expect(
			await prisma.cacheRefreshStatus.findUniqueOrThrow({
				where: {
					instanceId_cacheType: {
						instanceId: "jellyfin-1",
						cacheType: "jellyfin_episode",
					},
				},
			}),
		).toMatchObject({ lastResult: "success", itemCount: 0 });
	});

	it("merges current multi-user overlap with deterministic attribution and latest time", async () => {
		const prisma = await database();
		const base = await completeFinalizerFixture(prisma);
		const scopes = [
			{ userId: "provider-user-a", userName: "Alice", libraryId: "library-1" },
			{ userId: "provider-user-b", userName: "Bob", libraryId: "library-1" },
		];
		const { run } = await replaceRunWithScopes(prisma, base.attempt, scopes, {
			"provider-user-a:library-1": [
				{
					jellyfinId: "episode-1",
					seriesId: "series-1",
					seasonNumber: 1,
					episodeNumber: 1,
					played: true,
					lastPlayedAt: new Date("2026-09-06T10:00:00.000Z"),
				},
			],
			"provider-user-b:library-1": [
				{
					jellyfinId: "episode-1",
					seriesId: "series-1",
					seasonNumber: 1,
					episodeNumber: 1,
					played: true,
					lastPlayedAt: new Date("2026-09-07T00:00:00.000Z"),
				},
			],
		});

		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				scopes,
				attempt: base.attempt,
				now: new Date("2026-09-07T00:02:00.000Z"),
			}),
		).resolves.toEqual({ published: true, itemCount: 1 });

		expect(await prisma.jellyfinEpisodeCache.findMany()).toEqual([
			expect.objectContaining({
				watched: true,
				watchedByUsers: '["Alice","Bob"]',
				lastWatchedAt: new Date("2026-09-07T00:00:00.000Z"),
			}),
		]);
	});

	it("invalidates one provider item identity that changes coordinate across users", async () => {
		const prisma = await database();
		const base = await completeFinalizerFixture(prisma);
		const scopes = [
			{ userId: "provider-user-a", userName: "Alice", libraryId: "library-1" },
			{ userId: "provider-user-b", userName: "Bob", libraryId: "library-1" },
		];
		const { run } = await replaceRunWithScopes(prisma, base.attempt, scopes, {
			"provider-user-a:library-1": [
				{
					jellyfinId: "episode-1",
					seriesId: "series-1",
					seasonNumber: 1,
					episodeNumber: 1,
					played: true,
					lastPlayedAt: null,
				},
			],
			"provider-user-b:library-1": [
				{
					jellyfinId: "episode-1",
					seriesId: "series-1",
					seasonNumber: 1,
					episodeNumber: 2,
					played: true,
					lastPlayedAt: null,
				},
			],
		});

		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				scopes,
				attempt: base.attempt,
				now: new Date("2026-09-07T00:02:00.000Z"),
			}),
		).resolves.toEqual({ published: false, itemCount: 0 });
		await expectInvalidatedWithPublishedCachePreserved(prisma, run.id);
	});

	it.each([
		[
			"an incomplete unit",
			async (prisma: Awaited<ReturnType<typeof database>>, runId: string) => {
				const unit = await prisma.providerObservationUnit.findFirstOrThrow({ where: { runId } });
				await prisma.providerObservationUnit.update({
					where: { id: unit.id },
					data: { state: "pending", completedAt: null },
				});
			},
		],
		[
			"a changed service generation",
			async (prisma: Awaited<ReturnType<typeof database>>) => {
				await prisma.serviceInstance.update({
					where: { id: "jellyfin-1" },
					data: { connectionGeneration: 2 },
				});
			},
		],
		[
			"a changed unit scope digest",
			async (prisma: Awaited<ReturnType<typeof database>>, runId: string) => {
				const unit = await prisma.providerObservationUnit.findFirstOrThrow({ where: { runId } });
				await prisma.providerObservationUnit.update({
					where: { id: unit.id },
					data: { scopeDigest: "0".repeat(64) },
				});
			},
		],
		[
			"invalid parent metadata",
			async (prisma: Awaited<ReturnType<typeof database>>) => {
				await prisma.cacheRefreshStatus.update({
					where: {
						instanceId_cacheType: {
							instanceId: "jellyfin-1",
							cacheType: "jellyfin",
						},
					},
					data: { generationMetadata: "{}" },
				});
			},
		],
		[
			"a parent item-count mismatch",
			async (prisma: Awaited<ReturnType<typeof database>>) => {
				await prisma.cacheRefreshStatus.update({
					where: {
						instanceId_cacheType: {
							instanceId: "jellyfin-1",
							cacheType: "jellyfin",
						},
					},
					data: { itemCount: 2 },
				});
			},
		],
		[
			"parent row fingerprint drift",
			async (prisma: Awaited<ReturnType<typeof database>>) => {
				await prisma.jellyfinCache.updateMany({
					where: { instanceId: "jellyfin-1" },
					data: { title: "Drifted title" },
				});
			},
		],
		[
			"a failed latest parent attempt",
			async (prisma: Awaited<ReturnType<typeof database>>) => {
				await prisma.cacheRefreshStatus.update({
					where: {
						instanceId_cacheType: {
							instanceId: "jellyfin-1",
							cacheType: "jellyfin",
						},
					},
					data: {
						lastAttemptAt: new Date("2026-09-07T00:01:00.000Z"),
						lastAttemptResult: "error",
					},
				});
			},
		],
		[
			"a running latest parent attempt",
			async (prisma: Awaited<ReturnType<typeof database>>) => {
				await prisma.cacheRefreshStatus.update({
					where: {
						instanceId_cacheType: {
							instanceId: "jellyfin-1",
							cacheType: "jellyfin",
						},
					},
					data: {
						lastAttemptAt: new Date("2026-09-07T00:01:00.000Z"),
						lastAttemptResult: "in_progress:parent-replacement",
					},
				});
			},
		],
		[
			"a stale parent publication",
			async (prisma: Awaited<ReturnType<typeof database>>) => {
				await prisma.cacheRefreshStatus.update({
					where: {
						instanceId_cacheType: {
							instanceId: "jellyfin-1",
							cacheType: "jellyfin",
						},
					},
					data: {
						lastRefreshedAt: new Date("2026-09-01T00:00:00.000Z"),
						lastAttemptAt: new Date("2026-09-01T00:00:00.000Z"),
					},
				});
			},
		],
		[
			"a changed parent generation",
			async (prisma: Awaited<ReturnType<typeof database>>) => {
				await prisma.cacheRefreshStatus.update({
					where: {
						instanceId_cacheType: {
							instanceId: "jellyfin-1",
							cacheType: "jellyfin",
						},
					},
					data: { generationId: "parent-replacement" },
				});
			},
		],
		[
			"a positive-only parent without exact mapping authority",
			async (prisma: Awaited<ReturnType<typeof database>>) => {
				const status = await prisma.cacheRefreshStatus.findUniqueOrThrow({
					where: {
						instanceId_cacheType: {
							instanceId: "jellyfin-1",
							cacheType: "jellyfin",
						},
					},
				});
				await prisma.cacheRefreshStatus.update({
					where: { id: status.id },
					data: {
						generationMetadata: positiveOnlyParentMetadata(status.generationMetadata!),
					},
				});
			},
		],
	])("invalidates %s while retaining the last published episode cache", async (_name, drift) => {
		const prisma = await database();
		const { attempt, run, scopes } = await completeFinalizerFixture(prisma);
		await drift(prisma, run.id);

		await expect(
			finalizeJellyfinEpisodeRun({
				prisma,
				userId: "user-1",
				instance: { id: "jellyfin-1" },
				runId: run.id,
				scopes,
				attempt,
				now: new Date("2026-09-07T00:02:00.000Z"),
			}),
		).resolves.toEqual({ published: false, itemCount: 0 });
		await expectInvalidatedWithPublishedCachePreserved(prisma, run.id);
	});

	it("plans collect and verify units from opaque user and library identifiers", () => {
		const plan = buildJellyfinEpisodeScopePlan([
			{ userId: "user-b", userName: "Private B", libraryId: "library-2" },
			{ userId: "user-a", userName: "Private A", libraryId: "library-1" },
		]);

		expect(plan.targetCount).toBe(2);
		expect(plan.units).toHaveLength(4);
		expect(plan.units.map((unit) => unit.phase)).toEqual([
			"collect",
			"collect",
			"verify",
			"verify",
		]);
		expect(JSON.stringify(plan.units)).not.toContain("Private");
	});

	it.each([
		["an early empty page", { startIndex: 0, totalRecordCount: 1, items: [] }],
		["a changed frozen total", { startIndex: 1, totalRecordCount: 3, items: [] }],
		[
			"a blank item identity",
			{
				startIndex: 1,
				totalRecordCount: 2,
				items: [
					{
						id: "",
						name: "Episode",
						type: "Episode",
						seriesId: "series-1",
						seasonNumber: 1,
						episodeNumber: 1,
						played: true,
						playCount: 1,
						lastPlayedDate: null,
					},
				],
			},
		],
		[
			"a duplicate item identity",
			{
				startIndex: 0,
				totalRecordCount: 2,
				items: [1, 2].map((episodeNumber) => ({
					id: "episode-1",
					name: "Episode",
					type: "Episode" as const,
					seriesId: "series-1",
					seasonNumber: 1,
					episodeNumber,
					played: true,
					playCount: 1,
					lastPlayedDate: null,
				})),
			},
		],
		[
			"an invalid episode coordinate",
			{
				startIndex: 0,
				totalRecordCount: 1,
				items: [
					{
						id: "episode-1",
						name: "Episode",
						type: "Episode",
						seriesId: "series-1",
						seasonNumber: -1,
						episodeNumber: 1,
						played: true,
						playCount: 1,
						lastPlayedDate: null,
					},
				],
			},
		],
	] satisfies Array<[string, JellyfinEpisodeItemsPage]>)(
		"rejects %s before opening a staging transaction",
		async (_name, page) => {
			const transaction = vi.fn();
			const scope = { userId: "user-1", userName: "private", libraryId: "library-1" };
			const unit = buildJellyfinEpisodeScopePlan([scope]).units[0]!;
			const claim = {
				runId: "run-1",
				unitId: "unit-1",
				claimToken: "claim-1",
				authorityKey: "authority-1",
				scopeKey: unit.scopeKey,
				scopePayload: unit.scopePayload ?? null,
				phase: "collect" as const,
				cursor: page.startIndex,
				expectedRawCount: page.startIndex === 1 ? 2 : null,
				observedRawCount: page.startIndex,
			};

			await expect(
				stageJellyfinEpisodePage({ $transaction: transaction } as never, claim, scope, page),
			).resolves.toBe(false);
			expect(transaction).not.toHaveBeenCalled();
		},
	);

	it("makes a stale page claim a no-op without staging or advancing progress", async () => {
		const scope = { userId: "user-1", userName: "private", libraryId: "library-1" };
		const planned = buildJellyfinEpisodeScopePlan([scope]).units[0]!;
		const createMany = vi.fn();
		const unitUpdate = vi.fn();
		const tx = {
			providerObservationRun: {
				findFirst: vi.fn().mockResolvedValue({
					id: "run-1",
					authorityKey: "authority-1",
					connectionGeneration: 1,
					identityGeneration: 1,
					instance: {
						enabled: true,
						service: "JELLYFIN",
						connectionGeneration: 1,
						identityGeneration: 1,
					},
				}),
				updateMany: vi.fn(),
			},
			providerObservationUnit: {
				findFirst: vi.fn().mockResolvedValue(null),
				updateMany: unitUpdate,
			},
			jellyfinEpisodeObservationStage: { createMany, findMany: vi.fn().mockResolvedValue([]) },
		};
		const prisma = {
			$transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
		};
		const claim = {
			runId: "run-1",
			unitId: "unit-1",
			claimToken: "stale-claim",
			authorityKey: "authority-1",
			scopeKey: planned.scopeKey,
			scopePayload: planned.scopePayload ?? null,
			phase: "collect" as const,
			cursor: 0,
			expectedRawCount: null,
			observedRawCount: 0,
		};

		await expect(
			stageJellyfinEpisodePage(prisma as never, claim, scope, {
				startIndex: 0,
				totalRecordCount: 1,
				items: [
					{
						id: "episode-1",
						name: "Episode",
						type: "Episode",
						seriesId: "series-1",
						seasonNumber: 1,
						episodeNumber: 1,
						played: true,
						playCount: 1,
						lastPlayedDate: null,
					},
				],
			}),
		).resolves.toBe(false);
		expect(createMany).not.toHaveBeenCalled();
		expect(unitUpdate).not.toHaveBeenCalled();
	});

	it("stages one page and releases its claim for the next cursor without terminalizing the run", async () => {
		const scope = { userId: "user-1", userName: "private", libraryId: "library-1" };
		const plannedUnit = buildJellyfinEpisodeScopePlan([scope]).units[0]!;
		const unitUpdate = vi.fn().mockResolvedValue({ count: 1 });
		const runUpdate = vi.fn().mockResolvedValue({ count: 1 });
		const tx = {
			providerObservationRun: {
				findFirst: vi.fn().mockResolvedValue({
					id: "run-1",
					authorityKey: "authority-1",
					instanceId: "instance-1",
					connectionGeneration: 1,
					identityGeneration: 1,
					instance: {
						service: "JELLYFIN",
						enabled: true,
						connectionGeneration: 1,
						identityGeneration: 1,
					},
				}),
				updateMany: runUpdate,
			},
			providerObservationUnit: {
				findFirst: vi.fn().mockResolvedValue({
					id: "unit-1",
					ordinal: 0,
					scopeKey: "collect:user-1:library-1",
					scopeDigest: plannedUnit.scopeDigest,
					expectedTargets: 1,
					cursor: 0,
					expectedRawCount: null,
					observedRawCount: 0,
					phase: "collect",
				}),
				updateMany: unitUpdate,
			},
			jellyfinEpisodeObservationStage: {
				createMany: vi.fn().mockResolvedValue({ count: 1 }),
				findMany: vi.fn().mockResolvedValue([]),
			},
		};
		const prisma = {
			$transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
		};
		const claim = {
			runId: "run-1",
			unitId: "unit-1",
			claimToken: "claim-1",
			authorityKey: "authority-1",
			scopeKey: "collect:user-1:library-1",
			scopePayload: JSON.stringify({ userId: "user-1", libraryId: "library-1" }),
			phase: "collect" as const,
			cursor: 0,
			expectedRawCount: null,
			observedRawCount: 0,
		};

		const now = new Date("2026-09-08T00:00:00.000Z");
		await expect(
			stageJellyfinEpisodePage(
				prisma as never,
				claim,
				scope,
				{
					startIndex: 0,
					totalRecordCount: 2,
					items: [
						{
							id: "episode-1",
							name: "private",
							type: "Episode",
							seriesId: "series-1",
							seasonNumber: 1,
							episodeNumber: 1,
							played: true,
							playCount: 1,
							lastPlayedDate: null,
						},
					],
				},
				now,
			),
		).resolves.toBe(true);
		expect(unitUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					cursor: 1,
					expectedRawCount: 2,
					observedRawCount: 1,
					state: "pending",
					claimToken: null,
					nextAttemptAt: new Date(
						now.getTime() + JELLYFIN_EPISODE_SUCCESSFUL_PROGRESS_CONTINUATION_DELAY_MS,
					),
				}),
			}),
		);
		expect(runUpdate).not.toHaveBeenCalled();
	});

	it.each([2, 3])(
		"keeps version %i overlap staging within its evidence contract",
		async (version) => {
			const prisma = await database();
			const seed = await completeFinalizerFixture(prisma);
			if (version === 3) await bindV3Fixture(prisma, seed.run.id);
			else await bindV2Fixture(prisma, seed.run.id, seed.scopes);
			await prisma.jellyfinEpisodeObservationStage.deleteMany({ where: { runId: seed.run.id } });
			await prisma.providerObservationUnit.updateMany({
				where: { runId: seed.run.id },
				data: {
					state: "pending",
					claimToken: null,
					nextAttemptAt: null,
					completedAt: null,
					cursor: 0,
					expectedRawCount: null,
					observedRawCount: 0,
				},
			});
			await prisma.providerObservationRun.update({
				where: { id: seed.run.id },
				data: { state: "running", completedUnits: 0, completedWork: 0 },
			});
			const scope = seed.scopes[0]!;
			const firstNow = new Date("2026-09-07T00:00:00.000Z");
			const firstClaim = await claimObservationUnit(prisma, {
				runId: seed.run.id,
				now: firstNow,
				claimToken: "overlap-first",
			});
			expect(firstClaim?.phase).toBe("collect");
			const item = (id: string, episodeNumber: number, name: string, played = true) => ({
				id,
				name,
				type: "Episode" as const,
				seriesId: "series-1",
				seasonNumber: 1,
				episodeNumber,
				played,
				playCount: played ? 1 : 0,
				lastPlayedDate: null,
			});
			await expect(
				stageJellyfinEpisodePage(
					prisma,
					firstClaim!,
					scope,
					{
						startIndex: 0,
						totalRecordCount: version === 3 ? 3 : 4,
						items: [item("episode-1", 1, "Pilot"), item("episode-2", 2, "Second")],
					},
					firstNow,
				),
			).resolves.toBe(true);
			const secondClaim = await claimObservationUnit(prisma, {
				runId: seed.run.id,
				now: new Date(firstNow.getTime() + 11_000),
				claimToken: "overlap-second",
			});
			expect(secondClaim).toMatchObject({
				unitId: firstClaim!.unitId,
				cursor: 2,
				expectedRawCount: version === 3 ? 3 : 4,
				observedRawCount: 2,
			});
			const result = stageJellyfinEpisodePage(
				prisma,
				secondClaim!,
				scope,
				{
					startIndex: 2,
					totalRecordCount: 4,
					items: [item("episode-2", 2, "Changed duplicate", false), item("episode-3", 3, "Third")],
				},
				new Date(firstNow.getTime() + 12_000),
			);
			if (version === 2) {
				await expect(result).rejects.toMatchObject({ code: "P2002" });
				expect(
					await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: seed.run.id } }),
				).toBe(2);
				expect(
					await prisma.providerObservationUnit.findUniqueOrThrow({
						where: { id: secondClaim!.unitId },
					}),
				).toMatchObject({ state: "running", cursor: 2, observedRawCount: 2 });
				return;
			}
			await expect(result).resolves.toBe(true);
			const staged = await prisma.jellyfinEpisodeObservationStage.findMany({
				where: { runId: seed.run.id, unitId: firstClaim!.unitId, pass: "collect" },
				orderBy: { jellyfinId: "asc" },
			});
			expect(staged.map((row) => row.jellyfinId)).toEqual(["episode-1", "episode-2", "episode-3"]);
			expect(staged.find((row) => row.jellyfinId === "episode-2")).toMatchObject({
				title: "Second",
				played: true,
			});
			expect(
				await prisma.providerObservationUnit.findUniqueOrThrow({
					where: { id: firstClaim!.unitId },
				}),
			).toMatchObject({ state: "complete", cursor: 4, expectedRawCount: 4, observedRawCount: 4 });
		},
	);

	it.each([
		["a cross-unit identity", "cross-unit"],
		["a same-unit coordinate conflict", "coordinate-conflict"],
	])("rejects %s during V3 overlap admission", async (_name, corruption) => {
		const prisma = await database();
		const seed = await completeFinalizerFixture(prisma);
		await bindV3Fixture(prisma, seed.run.id);
		await prisma.jellyfinEpisodeObservationStage.deleteMany({ where: { runId: seed.run.id } });
		await prisma.providerObservationUnit.updateMany({
			where: { runId: seed.run.id },
			data: {
				state: "pending",
				claimToken: null,
				nextAttemptAt: null,
				completedAt: null,
				cursor: 0,
				expectedRawCount: null,
				observedRawCount: 0,
			},
		});
		await prisma.providerObservationRun.update({
			where: { id: seed.run.id },
			data: { state: "running", completedUnits: 0, completedWork: 0 },
		});
		const claim = await claimObservationUnit(prisma, {
			runId: seed.run.id,
			now: new Date("2026-09-07T00:00:00.000Z"),
			claimToken: "overlap-conflict",
		});
		expect(claim).not.toBeNull();
		const units = await prisma.providerObservationUnit.findMany({
			where: { runId: seed.run.id },
			orderBy: { ordinal: "asc" },
		});
		const otherUnit = units.find((unit) => unit.id !== claim!.unitId)!;
		await prisma.jellyfinEpisodeObservationStage.create({
			data: {
				runId: seed.run.id,
				unitId: corruption === "cross-unit" ? otherUnit.id : claim!.unitId,
				userKeyDigest: hash(["jellyfin-user", "user-1"]),
				pass: "collect",
				jellyfinId: "episode-conflict",
				seriesId: "series-1",
				seasonNumber: 1,
				episodeNumber: 1,
				title: "Original",
				played: true,
				playCount: 1,
				lastPlayedAt: null,
				userName: "",
			},
		});
		const result = await stageJellyfinEpisodePage(prisma, claim!, seed.scopes[0]!, {
			startIndex: 0,
			totalRecordCount: 1,
			items: [
				{
					id: "episode-conflict",
					name: "Incoming",
					type: "Episode",
					seriesId: "series-1",
					seasonNumber: 1,
					episodeNumber: corruption === "coordinate-conflict" ? 2 : 1,
					played: true,
					playCount: 1,
					lastPlayedDate: null,
				},
			],
		});
		expect(result).toBe(false);
		expect(
			await prisma.jellyfinEpisodeObservationStage.count({ where: { runId: seed.run.id } }),
		).toBe(1);
		expect(
			await prisma.providerObservationUnit.findUniqueOrThrow({ where: { id: claim!.unitId } }),
		).toMatchObject({
			state: "running",
			cursor: 0,
			observedRawCount: 0,
		});
	});
});
