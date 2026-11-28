import { createHash } from "node:crypto";
import type { PrismaClientInstance } from "../../../prisma.js";
import {
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
	decodeJellyfinLibraryGenerationMetadata,
} from "../../../jellyfin/jellyfin-generation-metadata.js";
import { fingerprintJellyfinEpisodeParentDependency } from "../../../jellyfin/jellyfin-episode-parent-dependency.js";
import {
	buildJellyfinEpisodeCatalogProvenance,
	jellyfinEpisodeCatalogGenerationKey,
} from "../../../jellyfin/jellyfin-episode-catalog-provenance.js";
import { buildJellyfinEpisodeScopePlan } from "../../../jellyfin/jellyfin-episode-refresh-repository.js";
import { createOrLoadObservationRun } from "../../../provider-observation/observation-run-repository.js";

/** Complete, small real staging contract; caller supplies its native operation ticket. */
export async function seedRuntimeJellyfinFinalization(
	prisma: PrismaClientInstance,
	baseUrl: string,
	options: { episodeCount?: number; title?: string } = {},
) {
	const episodeCount = options.episodeCount ?? 1;
	const now = new Date();
	const user = await prisma.user.create({ data: { id: "fixture-user", username: "fixture-user" } });
	const instance = await prisma.serviceInstance.create({
		data: {
			id: "fixture-jellyfin",
			userId: user.id,
			service: "JELLYFIN",
			label: "Synthetic",
			baseUrl,
			encryptedApiKey: "synthetic",
			encryptionIv: "synthetic",
			enabled: true,
			expectedIdentity: "synthetic-server",
			identityStatus: "VERIFIED",
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
	const scopes = [
		{ userId: "fixture-player", userName: "Synthetic", libraryId: "fixture-library" },
	];
	const parentRow = {
		instanceId: instance.id,
		tmdbId: 42,
		mediaType: "series" as const,
		libraryId: "fixture-library",
		libraryName: "Synthetic",
		title: "Synthetic",
		jellyfinId: "fixture-series",
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
	const receipt = {
		scopeKey: "library:fixture-library",
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
			units: [receipt],
			publishedCanonicalEntities: 1,
			domains: ["library-inventory", "mapping", "watch-count", "watch-attribution", "on-deck"].map(
				(domain) => ({
					domain,
					evidence: "complete" as const,
					valueSemantics: "exact" as const,
					units: [
						{
							...receipt,
							scopeKey:
								domain === "library-inventory"
									? "user:fixture-player/library:fixture-library/inventory"
									: `${domain}:fixture-library`,
						},
					],
					publishedCanonicalEntities: 1,
				}),
			),
		},
	});
	const persistedParent = await prisma.jellyfinCache.create({ data: parentRow });
	const boundParent = { ...persistedParent, mediaType: "series" as const };
	const attempt = { attemptedAt: now, resultMarker: "in_progress:fixture-finalizer" };
	await prisma.cacheRefreshStatus.createMany({
		data: [
			{
				instanceId: instance.id,
				cacheType: "jellyfin",
				lastRefreshedAt: now,
				lastResult: "success",
				itemCount: 1,
				generationId: "fixture-parent",
				generationMetadata: metadata,
				lastAttemptAt: now,
				lastAttemptResult: "success",
				connectionGeneration: 1,
				identityGeneration: 1,
			},
			{
				instanceId: instance.id,
				cacheType: "jellyfin_episode",
				lastRefreshedAt: now,
				lastResult: "success",
				itemCount: 1,
				generationId: "fixture-old",
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
			instanceId: instance.id,
			showTmdbId: 99,
			seasonNumber: 1,
			episodeNumber: 1,
			jellyfinId: "fixture-old",
			title: "Synthetic",
			watched: false,
			watchedByUsers: "[]",
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
	const decoded = decodeJellyfinLibraryGenerationMetadata(metadata);
	if (!decoded.ok) throw new Error("Fixture metadata");
	const dependency = fingerprintJellyfinEpisodeParentDependency(instance.id, decoded.metadata, [
		boundParent,
	]);
	const catalog = buildJellyfinEpisodeCatalogProvenance([boundParent], scopes);
	if (!dependency || !catalog) throw new Error("Fixture provenance");
	const plan = buildJellyfinEpisodeScopePlan(scopes, {
		parentLibraryGenerationId: "fixture-parent",
		parentLibraryMetadataFingerprint: fingerprintJellyfinLibraryGenerationMetadata(
			decoded.metadata,
		),
		parentLibraryDependencyFingerprint: dependency,
		catalogProvenance: catalog,
	});
	const run = await createOrLoadObservationRun(prisma, {
		authority: {
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			instanceId: instance.id,
			parentGenerationId: jellyfinEpisodeCatalogGenerationKey(catalog)!,
			targetDigest: plan.targetDigest,
			connectionGeneration: 1,
			identityGeneration: 1,
		},
		units: plan.units,
	});
	const units = await prisma.providerObservationUnit.findMany({ where: { runId: run.id } });
	await prisma.providerObservationUnit.updateMany({
		where: { runId: run.id },
		data: {
			state: "complete",
			completedAt: now,
			cursor: episodeCount,
			expectedRawCount: episodeCount,
			observedRawCount: episodeCount,
			completedPages: 1,
		},
	});
	await prisma.providerObservationRun.update({
		where: { id: run.id },
		data: { completedUnits: 2, completedWork: 1 },
	});
	const digest = createHash("sha256")
		.update(JSON.stringify(["jellyfin-user", "fixture-player"]))
		.digest("hex");
	for (const unit of units)
		await prisma.jellyfinEpisodeObservationStage.createMany({
			data: Array.from({ length: episodeCount }, (_, index) => ({
				runId: run.id,
				unitId: unit.id,
				userKeyDigest: digest,
				pass: unit.phase,
				jellyfinId: episodeCount === 1 ? "fixture-episode" : `fixture-episode-${index + 1}`,
				seriesId: "fixture-series",
				seasonNumber: 1,
				episodeNumber: index + 1,
				title: options.title ?? "Synthetic",
				played: true,
				playCount: 1,
				lastPlayedAt: now,
				userName: "",
			})),
		});
	return {
		instance: { ...instance, service: "JELLYFIN" as const, apiKey: "synthetic" },
		userId: user.id,
		scopes,
		attempt,
		now,
		runId: run.id,
	};
}
