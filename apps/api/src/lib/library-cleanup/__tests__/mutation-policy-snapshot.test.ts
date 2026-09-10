import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprintJellyfinEpisodeParentDependency } from "../../jellyfin/jellyfin-episode-parent-dependency.js";
import { readOwnedJellyfinObservation } from "../../jellyfin/jellyfin-evidence-repository.js";
import {
	encodeJellyfinEpisodeGenerationMetadata,
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinEpisodeRows,
	fingerprintJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
} from "../../jellyfin/jellyfin-generation-metadata.js";
import { loadTargetScopedPlexWatchCountMutationEvidence } from "../../plex/plex-evidence-repository.js";
import { encodePositivePlexGenerationMetadata } from "../../plex/plex-generation-metadata.js";
import {
	createPlexTargetLedgerBinding,
	requirePlexTargetLedgerBinding,
	verifyPersistedPlexGenerationTargets,
} from "../../plex/plex-generation-target-ledger.js";
import {
	assertCurrentSeriesMutationAuthority,
	buildEvalContextWithHealth,
	createMutationPolicySnapshotGetter,
	executeCleanupPreview,
	executeCleanupRun,
	loadTargetScopedPlexWatchCountFacts,
	MUTATION_POLICY_SNAPSHOT_MAX_AGE_MS,
	providerFactGrantDigestsMatch,
} from "../cleanup-executor.js";
import { providerFactGrantDigest } from "../provider-cache-evidence.js";
import {
	parseProviderScanAuthority,
	serializeProviderScanAuthority,
} from "../shared-plex-safety.js";
import type { CleanupExecutorDeps } from "../types.js";

const refreshMocks = vi.hoisted(() => ({
	plex: vi.fn(),
	plexEpisodes: vi.fn(),
	tautulli: vi.fn(),
	jellyfin: vi.fn(),
	jellyfinEpisodes: vi.fn(),
	jellyfinSingleFlight: vi.fn(),
}));

vi.mock("../../plex/plex-cache-refresher.js", () => ({
	collectPlexCacheLiveEvidence: refreshMocks.plex,
}));
vi.mock("../../plex/plex-refresh-orchestration.js", () => ({
	refreshOwnedPlexCache: refreshMocks.plex,
	refreshOwnedPlexEpisodeCache: refreshMocks.plexEpisodes,
}));
vi.mock("../../tautulli/tautulli-cache-refresher.js", () => ({
	collectTautulliCacheLiveEvidence: refreshMocks.tautulli,
	createOwnedTautulliPublicationSnapshot: (
		_encryptor: unknown,
		instance: Record<string, unknown>,
	) => ({
		...instance,
		label: instance.name ?? "Tautulli",
		apiKey: "decrypted",
		httpAuthHeaders: {},
		expectedIdentity: "plex-a",
		identityStatus: "VERIFIED",
		connectionGeneration: 0,
		identityGeneration: 0,
	}),
	refreshTautulliCache: refreshMocks.tautulli,
}));
vi.mock("../../jellyfin/jellyfin-cache-refresher.js", () => ({
	collectJellyfinCacheLiveEvidence: refreshMocks.jellyfin,
	refreshOwnedJellyfinCache: refreshMocks.jellyfin,
}));
vi.mock("../../jellyfin/jellyfin-episode-cache-refresher.js", () => ({
	refreshOwnedJellyfinEpisodeCache: refreshMocks.jellyfinEpisodes,
}));
vi.mock("../../jellyfin/jellyfin-cache-singleflight.js", () => ({
	runJellyfinCacheRefreshSingleFlight: refreshMocks.jellyfinSingleFlight,
}));

vi.mock("../../plex/plex-authority-service.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../plex/plex-authority-service.js")>();
	const repository = await import("../../plex/plex-evidence-repository.js");
	return {
		...actual,
		PlexAuthorityService: class {
			private readonly prisma: {
				serviceInstance: { findMany: (input: unknown) => Promise<Array<Record<string, unknown>>> };
				plexGenerationTarget?: {
					findMany: (input: unknown) => Promise<Array<Record<string, unknown>>>;
				};
			};

			constructor(input: {
				prisma: {
					serviceInstance: {
						findMany: (input: unknown) => Promise<Array<Record<string, unknown>>>;
					};
					plexGenerationTarget?: {
						findMany: (input: unknown) => Promise<Array<Record<string, unknown>>>;
					};
				};
			}) {
				this.prisma = input.prisma;
			}

			async scanInstancePolicy(input: { userId: string; instanceId: string }) {
				const instances = await this.prisma.serviceInstance.findMany({
					where: { userId: input.userId, service: "PLEX", enabled: true },
				});
				const instance = instances.find((entry) => entry.id === input.instanceId);
				const result = await repository.scanInstancePolicyEvidence(
					{
						...this.prisma,
						serviceInstance: {
							...this.prisma.serviceInstance,
							findFirst: vi.fn().mockResolvedValue(instance ?? null),
						},
					} as never,
					input,
				);
				return result;
			}

			async scanInstanceExactPolicy(input: { userId: string; instanceId: string }) {
				await this.verifyExactTargets(input);
				return await this.scanInstancePolicy(input);
			}

			async scanInstanceExactPolicyPersisted(input: { userId: string; instanceId: string }) {
				await this.verifyExactTargets(input);
				return await this.scanInstancePolicy(input);
			}

			async readTargetScopedWatchCountMutationEvidence(
				input: Parameters<typeof repository.loadTargetScopedPlexWatchCountMutationEvidenceBatch>[1],
			) {
				return await repository.loadTargetScopedPlexWatchCountMutationEvidenceBatch(
					this.prisma as never,
					input,
				);
			}

			private async verifyExactTargets(input: { userId: string; instanceId: string }) {
				if (!this.prisma.plexGenerationTarget) return;
				const instances = await this.prisma.serviceInstance.findMany({
					where: { userId: input.userId, service: "PLEX", enabled: true },
				});
				const instance = instances.find((entry) => entry.id === input.instanceId);
				const evidence = await repository.loadInstanceEvidence(
					{
						...this.prisma,
						serviceInstance: {
							...this.prisma.serviceInstance,
							findFirst: vi.fn().mockResolvedValue(instance ?? null),
						},
					} as never,
					input,
				);
				if (!evidence.available) return;
				const binding = requirePlexTargetLedgerBinding(evidence.metadata);
				if (!binding.ok) throw new Error("Plex fixture omitted its target ledger binding");
				const verified = await verifyPersistedPlexGenerationTargets(this.prisma as never, {
					expected: {
						instanceId: evidence.instanceId,
						generationId: evidence.generationId,
						connectionGeneration: evidence.connectionGeneration,
						identityGeneration: evidence.identityGeneration,
						...binding.binding,
					},
					sections: evidence.sections as unknown as Array<{
						key: string;
						uuid: string;
						type: "movie" | "show";
					}>,
				});
				if (!verified.ok)
					throw new Error(`Plex fixture target ledger was not exact: ${verified.reason}`);
			}

			async readInstance(input: { userId: string; instanceId: string }) {
				const instances = await this.prisma.serviceInstance.findMany({
					where: { userId: input.userId, service: "PLEX", enabled: true },
				});
				const instance = instances.find((entry) => entry.id === input.instanceId);
				return repository.loadInstanceEvidence(
					{
						...this.prisma,
						serviceInstance: {
							...this.prisma.serviceInstance,
							findFirst: vi.fn().mockResolvedValue(instance ?? null),
						},
					} as never,
					input,
				);
			}
		},
	};
});

function plexV5Metadata(
	itemCount: number,
	instanceId: string,
	generationId: string,
	connectionGeneration: number,
	identityGeneration: number,
	completedAt: Date,
	targets: Parameters<typeof createPlexTargetLedgerBinding>[0]["targets"] = [],
) {
	if (itemCount > 0 && targets.length === 0)
		throw new Error("Nonempty Plex metadata fixtures require bound target rows");
	if (itemCount !== targets.length)
		throw new Error("Plex metadata itemCount must equal its bound target count");
	const targetLedger = createPlexTargetLedgerBinding({
		instanceId,
		generationId,
		connectionGeneration,
		identityGeneration,
		targets,
	});
	const observedAt = completedAt.toISOString();
	return JSON.stringify({
		version: 5,
		publicationLevel: "authoritative",
		completeness: "complete",
		itemCount,
		canonicalizationVersion: 1,
		sections: [
			{
				key: "movies",
				uuid: "movies-uuid",
				title: "Movies",
				type: targets.some((target) => target.mediaType === "series") ? "show" : "movie",
				refreshing: false,
				scannedAt: 1_777_000_000,
				updatedAt: 1_777_000_100,
			},
		],
		roots: [{ sectionKey: "movies", domain: "membership", digest: "a".repeat(64) }],
		...targetLedger,
		partialReasons: [],
		coverageReceipt: {
			version: 1,
			provider: "plex",
			attemptStartedAt: observedAt,
			observedAt,
			evidence: "complete",
			units: [
				{
					scopeKey: "section:movies",
					expectedRawCount: itemCount,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: itemCount,
					sourceBindings: itemCount,
					canonicalEntities: itemCount,
					acceptedSkips: [],
					fatalCount: 0,
				},
			],
		},
	});
}

function plexV6TargetScopedWatchCountMetadata(
	instanceId: string,
	generationId: string,
	completedAt: Date,
	targets: Parameters<typeof createPlexTargetLedgerBinding>[0]["targets"],
) {
	const targetLedger = createPlexTargetLedgerBinding({
		instanceId,
		generationId,
		connectionGeneration: 1,
		identityGeneration: 1,
		targets,
	});
	const unit = (scopeKey: string) => ({
		scopeKey,
		expectedRawCount: targets.length,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: targets.length,
		sourceBindings: targets.length,
		canonicalEntities: targets.length,
		acceptedSkips: [],
		fatalCount: 0,
	});
	return encodePositivePlexGenerationMetadata({
		sections: [
			{
				key: "shows",
				uuid: "shows-uuid",
				title: "Shows",
				type: "show",
				refreshing: false,
				scannedAt: 1_777_000_000,
				updatedAt: 1_777_000_100,
			},
		],
		itemCount: targets.length,
		canonicalizationVersion: 1,
		observedRoots: [{ sectionKey: "shows", domain: "episode-parents", digest: "a".repeat(64) }],
		targetLedger,
		partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
		coverageReceipt: {
			version: 2,
			provider: "plex",
			attemptStartedAt: completedAt.toISOString(),
			observedAt: completedAt.toISOString(),
			evidence: "positive-only",
			units: [unit("plex:aggregate")],
			publishedCanonicalEntities: targets.length,
			domains: (
				["library-inventory", "mapping", "watch-count", "watch-attribution", "on-deck"] as const
			).map((domain) => ({
				domain,
				evidence: "complete",
				valueSemantics: "exact",
				units: [unit(`plex:${domain}`)],
				...(domain === "mapping" || domain === "watch-count"
					? { publishedCanonicalEntities: targets.length }
					: {}),
			})),
		},
	});
}

function rule(ruleType: string) {
	return {
		id: `rule-${ruleType}`,
		configId: "config-1",
		name: ruleType,
		enabled: true,
		priority: 1,
		ruleType,
		parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
		operator: null,
		conditions: null,
		serviceFilter: null,
		instanceFilter: null,
		targetScope: "movie",
		action: "delete",
		retentionMode: false,
		useGlobalRejectionMemory: true,
		createdAt: new Date("2026-07-31T12:00:00.000Z"),
		updatedAt: new Date("2026-07-31T12:00:00.000Z"),
	};
}

function instance(service: "PLEX" | "TAUTULLI" | "JELLYFIN" | "EMBY") {
	return {
		id: `${service.toLowerCase()}-1`,
		userId: "user-1",
		name: service,
		service,
		baseUrl: `http://${service.toLowerCase()}.test`,
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		enabled: true,
		expectedIdentity: `${service.toLowerCase()}-identity`,
		identityKind: `${service}_IDENTITY`,
		identityStatus: "VERIFIED",
		identityVerifiedAt: new Date("2026-07-31T12:00:00.000Z"),
		connectionGeneration: 1,
		identityGeneration: 1,
		createdAt: new Date("2026-07-31T12:00:00.000Z"),
		updatedAt: new Date("2026-07-31T12:00:00.000Z"),
	};
}

function plexRefreshInstanceId(args: unknown[]): string {
	const [first, second, positionalInstanceId] = args;
	if (
		typeof first === "object" &&
		first !== null &&
		"instance" in first &&
		typeof (first as { instance?: { id?: unknown } }).instance?.id === "string"
	) {
		return (first as { instance: { id: string } }).instance.id;
	}
	if (typeof second === "string") return second;
	return String(positionalInstanceId);
}

function makeDeps(
	rules: Array<Record<string, unknown>>,
	instances = [] as Array<
		Record<string, unknown> & {
			id: string;
			service: string;
			connectionGeneration: number;
			identityGeneration: number;
		}
	>,
	options: {
		episodeStatus?: "missing" | "older";
		libraryStatus?: "missing" | "collecting";
		unavailableInstanceId?: string;
		jellyfinRows?: Array<Record<string, unknown>>;
	} = {},
) {
	const findConfig = vi.fn().mockResolvedValue({
		id: "config-1",
		userId: "user-1",
		enabled: true,
		dryRunMode: false,
		requireApproval: false,
		maxRemovalsPerRun: 100,
		rules,
	});
	const findInstances = vi.fn(
		async ({ where }: { where: { service: string | { in: string[] } } }) => {
			const services = typeof where.service === "string" ? [where.service] : where.service.in;
			return instances.filter((entry) => services.includes(entry.service));
		},
	);
	const publishedAt = new Date();
	const cacheStatusUpsert = vi.fn().mockResolvedValue({});
	const jellyfinRowsFindMany = vi.fn().mockResolvedValue(options.jellyfinRows ?? []);
	const findInstance = vi.fn(async ({ where }: { where: { id: string } }) => {
		const result = instances.find((entry) => entry.id === where.id);
		return result;
	});
	const jellyfinStatus = (
		cacheType: "jellyfin" | "jellyfin_episode",
		source: {
			id: string;
			service: string;
			connectionGeneration: number;
			identityGeneration: number;
		},
	) => {
		const libraryRows = options.jellyfinRows ?? [];
		const parentPublishedAt = publishedAt;
		const completedAt =
			options.episodeStatus === "older" && cacheType === "jellyfin_episode"
				? new Date(publishedAt.getTime() - 1000)
				: parentPublishedAt;
		const provider = source.service === "EMBY" ? "emby" : "jellyfin";
		const receiptProvider = cacheType === "jellyfin" ? provider : `${provider}_episode`;
		const coverageReceipt = {
			version: 1,
			provider: receiptProvider,
			attemptStartedAt: completedAt.toISOString(),
			observedAt: completedAt.toISOString(),
			evidence: "complete",
			units: [
				{
					scopeKey: "library",
					expectedRawCount: libraryRows.length,
					pagesAttempted: libraryRows.length > 0 ? 1 : 0,
					pagesCompleted: libraryRows.length > 0 ? 1 : 0,
					rawObserved: libraryRows.length,
					sourceBindings: libraryRows.length,
					canonicalEntities: libraryRows.length,
					acceptedSkips: [],
					fatalCount: 0,
				},
			],
			publishedCanonicalEntities: libraryRows.length,
		};
		const libraryMetadata = encodeJellyfinLibraryGenerationMetadata({
			version: 1,
			provider,
			cacheType: "jellyfin",
			publicationLevel: "authoritative",
			completeness: "complete",
			canonicalizationVersion: 1,
			itemCount: cacheType === "jellyfin" ? libraryRows.length : 0,
			connectionGeneration: source.connectionGeneration,
			identityGeneration: source.identityGeneration,
			contentFingerprint: fingerprintJellyfinLibraryRows(libraryRows as never),
			coverageReceipt: {
				...coverageReceipt,
				provider,
				attemptStartedAt: parentPublishedAt.toISOString(),
				observedAt: parentPublishedAt.toISOString(),
			},
		});
		const metadata =
			cacheType === "jellyfin"
				? libraryMetadata
				: encodeJellyfinEpisodeGenerationMetadata({
						version: 1,
						provider,
						cacheType,
						publicationLevel: "authoritative",
						completeness: "complete",
						canonicalizationVersion: 1,
						itemCount: 0,
						connectionGeneration: source.connectionGeneration,
						identityGeneration: source.identityGeneration,
						parentLibraryGenerationId: `generation-${source.id}-jellyfin`,
						parentLibraryMetadataFingerprint: fingerprintJellyfinLibraryGenerationMetadata(
							JSON.parse(libraryMetadata),
						),
						contentFingerprint: fingerprintJellyfinEpisodeRows([]),
						coverageReceipt: { ...coverageReceipt, provider: `${provider}_episode` },
					});
		return {
			instanceId: source.id,
			cacheType,
			lastRefreshedAt: completedAt,
			lastResult: options.libraryStatus === "collecting" ? "running" : "success",
			itemCount: cacheType === "jellyfin" ? libraryRows.length : 0,
			generationId: `generation-${source.id}-${cacheType}`,
			generationMetadata: metadata,
			lastErrorMessage: null,
			lastAttemptAt: completedAt,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			connectionGeneration: source.connectionGeneration,
			identityGeneration: source.identityGeneration,
		};
	};
	const cacheRefreshStatus = {
		upsert: cacheStatusUpsert,
		findUnique: vi.fn(
			async ({
				where,
			}: {
				where: { instanceId_cacheType: { instanceId: string; cacheType: string } };
			}) => {
				const source = instances.find(
					(entry) => entry.id === where.instanceId_cacheType.instanceId,
				);
				if (!source) return null;
				if (
					options.libraryStatus === "missing" &&
					where.instanceId_cacheType.cacheType === "jellyfin"
				) {
					return null;
				}
				if (options.unavailableInstanceId === source.id) return null;
				if (
					options.episodeStatus === "missing" &&
					where.instanceId_cacheType.cacheType === "jellyfin_episode"
				) {
					return null;
				}
				if (
					where.instanceId_cacheType.cacheType === "jellyfin" ||
					where.instanceId_cacheType.cacheType === "jellyfin_episode"
				) {
					return jellyfinStatus(where.instanceId_cacheType.cacheType, source);
				}
				return null;
			},
		),
		findMany: vi.fn(
			async ({ where }: { where: { instanceId: { in: string[] }; cacheType?: string } }) => {
				if (options.episodeStatus === "missing" && where.cacheType === "jellyfin_episode")
					return [];
				return where.instanceId.in.map((instanceId) => {
					const source = instances.find((entry) => entry.id === instanceId);
					const completedAt =
						options.episodeStatus === "older" && where.cacheType === "jellyfin_episode"
							? new Date(publishedAt.getTime() - 1000)
							: publishedAt;
					return {
						instanceId,
						lastRefreshedAt: completedAt,
						lastResult: "success",
						itemCount: 0,
						generationId: `generation-${instanceId}`,
						generationMetadata: plexV5Metadata(
							0,
							instanceId,
							`generation-${instanceId}`,
							1,
							1,
							completedAt,
						),
						lastErrorMessage: null,
						lastAttemptAt: completedAt,
						lastAttemptResult: "success",
						lastAttemptErrorMessage: null,
						connectionGeneration: source?.connectionGeneration ?? 1,
						identityGeneration: source?.identityGeneration ?? 1,
					};
				});
			},
		),
	};
	const refreshTransaction = {
		$queryRawUnsafe: vi.fn().mockResolvedValue([]),
		libraryCleanupConfig: {
			upsert: vi.fn().mockResolvedValue({ id: "config-1" }),
			findUnique: vi.fn().mockResolvedValue({ runClaimToken: null }),
		},
		serviceInstance: { findUnique: findInstance, findFirst: findInstance },
		cacheRefreshStatus,
		jellyfinCache: { findMany: jellyfinRowsFindMany },
		jellyfinEpisodeCache: { findMany: vi.fn().mockResolvedValue([]) },
	};
	const deps = {
		prisma: {
			$transaction: vi.fn(async (callback: (tx: typeof refreshTransaction) => Promise<unknown>) =>
				callback(refreshTransaction),
			),
			libraryCleanupConfig: { findUnique: findConfig },
			serviceInstance: { findMany: findInstances },
			plexCache: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
			tautulliCache: { findMany: vi.fn().mockResolvedValue([]) },
			jellyfinCache: { findMany: jellyfinRowsFindMany },
			cacheRefreshStatus,
			plexEpisodeCache: {
				findMany: vi.fn().mockResolvedValue([]),
				groupBy: vi.fn().mockResolvedValue([]),
			},
			jellyfinEpisodeCache: {
				findMany: vi.fn().mockResolvedValue([]),
				groupBy: vi.fn().mockResolvedValue([]),
			},
		},
		arrClientFactory: vi.fn(),
		encryptor: { decrypt: vi.fn().mockReturnValue("decrypted") },
		plexCacheClientFactory: vi.fn(() => ({}) as never),
		tautulliCacheClientFactory: vi.fn(() => ({}) as never),
		jellyfinCacheClientFactory: vi.fn(() => ({}) as never),
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as CleanupExecutorDeps;
	return { deps, findConfig, findInstances, cacheStatusUpsert, publishedAt };
}

describe("authoritative mutation policy snapshots", () => {
	it.each([
		[undefined, "current-grant", false],
		["expected-grant", undefined, false],
		["same-grant", "same-grant", true],
	] as const)(
		"compares expected and current provider fact digests symmetrically",
		(expected, current, matches) => {
			expect(providerFactGrantDigestsMatch(expected, current)).toBe(matches);
		},
	);
	it("does not construct nonempty authority without bound target rows", () => {
		expect(() => plexV5Metadata(1, "plex-1", "generation-1", 1, 1, new Date())).toThrow(
			"require bound target rows",
		);
	});

	beforeEach(() => {
		vi.clearAllMocks();
		refreshMocks.plex.mockImplementation(async (...args: unknown[]) => ({
			upserted: 0,
			errors: 0,
			errorMessages: [],
			complete: true,
			completedAt: new Date(),
			generationId: `generation-${plexRefreshInstanceId(args)}`,
			inventoryTargets: [],
			targetLedger: {
				targetLedgerVersion: 1,
				targetCount: 0,
				targetDigest: "a".repeat(64),
			},
		}));
		refreshMocks.plexEpisodes.mockResolvedValue({
			upserted: 0,
			errors: 0,
			errorMessages: [],
			eligibleShows: 0,
			refreshedShows: 0,
			coverageIncomplete: false,
			capacityDegraded: false,
			complete: true,
			completedAt: new Date(),
		});
		refreshMocks.tautulli.mockResolvedValue({
			upserted: 0,
			errors: 0,
			errorMessages: [],
			complete: true,
			completedAt: new Date(),
		});
		refreshMocks.jellyfin.mockResolvedValue({
			upserted: 0,
			errors: 0,
			errorMessages: [],
			complete: true,
			completedAt: new Date(),
		});
		refreshMocks.jellyfinEpisodes.mockResolvedValue({
			upserted: 0,
			errors: 0,
			complete: true,
			completedAt: new Date(),
		});
		refreshMocks.jellyfinSingleFlight.mockImplementation(
			async (
				_authority: unknown,
				_cacheType: unknown,
				refresh: () => Promise<unknown>,
				_cleanupRunClaimToken?: string,
			) => await refresh(),
		);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		["Plex", "plex_watch_count", "PLEX", refreshMocks.plex],
		["Jellyfin", "jellyfin_watch_count", "JELLYFIN", refreshMocks.jellyfin],
	] as const)(
		"does not synchronously refresh %s while capturing mutation policy evidence",
		async (_label, ruleType, service, refreshMock) => {
			const { deps } = makeDeps([rule(ruleType)], [instance(service)]);

			await createMutationPolicySnapshotGetter(deps, "user-1")();

			expect(refreshMock).not.toHaveBeenCalled();
		},
	);

	it("quarantines Tautulli mutation evidence without refreshing or reading cache rows", async () => {
		const { deps } = makeDeps([rule("tautulli_watch_count")], [instance("TAUTULLI")]);

		const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();

		expect(snapshot.failedSources).toEqual(new Set(["tautulli"]));
		expect(snapshot.ctx.tautulliMap).toBeUndefined();
		expect(refreshMocks.tautulli).not.toHaveBeenCalled();
		expect(deps.prisma.tautulliCache.findMany).not.toHaveBeenCalled();
	});

	it.each(["missing", "collecting"] as const)(
		"fails closed on a %s current Jellyfin generation without scheduling a refresh",
		async (libraryStatus) => {
			const { deps, cacheStatusUpsert } = makeDeps(
				[rule("jellyfin_watch_count")],
				[instance("JELLYFIN")],
				{ libraryStatus },
			);

			const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();

			expect(snapshot.failedSources).toEqual(new Set(["jellyfin"]));
			expect(cacheStatusUpsert).not.toHaveBeenCalled();
			expect(refreshMocks.jellyfin).not.toHaveBeenCalled();
			expect(refreshMocks.jellyfinSingleFlight).not.toHaveBeenCalled();
		},
	);

	it("requires explicit complete episode coverage before accepting Plex episode evidence", async () => {
		refreshMocks.plexEpisodes.mockResolvedValue({
			upserted: 0,
			errors: 0,
			errorMessages: [],
			eligibleShows: 1,
			refreshedShows: 1,
			coverageIncomplete: false,
			capacityDegraded: false,
		});
		const { deps } = makeDeps([rule("plex_episode_completion")], [instance("PLEX")]);

		const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();

		expect(snapshot.failedSources).toEqual(new Set(["plex"]));
		expect(refreshMocks.plex).not.toHaveBeenCalled();
		expect(refreshMocks.plexEpisodes).not.toHaveBeenCalled();
	});

	it.each([
		["Plex", "plex_watch_count", "PLEX", refreshMocks.plex],
		["Jellyfin", "jellyfin_watch_count", "JELLYFIN", refreshMocks.jellyfin],
	] as const)(
		"does not schedule cleanup-owned %s publication with the active run lease",
		async (_label, ruleType, service, refreshMock) => {
			const { deps } = makeDeps([rule(ruleType)], [instance(service)]);

			await createMutationPolicySnapshotGetter(deps, "user-1", undefined, "cleanup-run")();

			expect(refreshMock).not.toHaveBeenCalled();
		},
	);

	it("does not schedule library or episode refreshes for an active cleanup token", async () => {
		const { deps } = makeDeps([rule("jellyfin_episode_completion")], [instance("JELLYFIN")]);

		await createMutationPolicySnapshotGetter(deps, "user-1", undefined, "cleanup-run")();

		expect(refreshMocks.jellyfinSingleFlight).not.toHaveBeenCalled();
		expect(refreshMocks.jellyfin).not.toHaveBeenCalled();
		expect(refreshMocks.jellyfinEpisodes).not.toHaveBeenCalled();
	});

	it.each(["JELLYFIN", "EMBY"] as const)(
		"serializes the repository generation and row authority for %s cleanup evidence",
		async (service) => {
			const provider = instance(service);
			const { deps } = makeDeps([rule("jellyfin_watch_count")], [provider]);
			const evaluated = await buildEvalContextWithHealth(deps, "user-1", [
				rule("jellyfin_watch_count"),
			]);
			const observation = await readOwnedJellyfinObservation({
				prisma: deps.prisma as never,
				userId: "user-1",
				instanceId: provider.id,
				cacheType: "jellyfin",
				mode: "mutation",
				now: new Date(),
			});
			const authority = observation?.authority;
			expect(authority).not.toBeNull();
			expect(observation?.generationId).toBe(authority!.generationId);
			expect(observation?.publishedAt).toEqual(authority!.publishedAt);
			const source = evaluated.providerEvidence?.sources[0];
			expect(source).toMatchObject({
				service,
				cacheType: "jellyfin",
				generationId: authority!.generationId,
				statusFingerprint: authority!.statusFingerprint,
				rowFingerprint: authority!.rowFingerprint,
				itemCount: authority!.itemCount,
			});
			const serialized = serializeProviderScanAuthority(
				{ instanceId: provider.id, service, mediaType: "movie" },
				evaluated.providerEvidence!,
			);
			const parsed = parseProviderScanAuthority(serialized, {
				instanceId: provider.id,
				service,
				mediaType: "movie",
			});
			expect(parsed?.sources[0]).toMatchObject({
				generationId: authority!.generationId,
				statusFingerprint: authority!.statusFingerprint,
				rowFingerprint: authority!.rowFingerprint,
			});
		},
	);

	it("fails the whole Jellyfin cleanup source when one owned instance is unavailable", async () => {
		const jellyfin = instance("JELLYFIN");
		const emby = { ...instance("EMBY"), id: "emby-2" };
		const { deps } = makeDeps([rule("jellyfin_watch_count")], [jellyfin, emby], {
			unavailableInstanceId: emby.id,
		});

		const evaluated = await buildEvalContextWithHealth(deps, "user-1", [
			rule("jellyfin_watch_count"),
		]);

		expect(evaluated.failedSources).toEqual(new Set(["jellyfin"]));
		expect(evaluated.providerEvidence?.sources).toEqual([]);
	});

	it("uses both completion domains for episode evidence and preserves library-only behavior", async () => {
		const withEpisodes = makeDeps([rule("jellyfin_episode_completion")], [instance("JELLYFIN")], {
			episodeStatus: "older",
		});
		const withEpisodesSnapshot = await createMutationPolicySnapshotGetter(
			withEpisodes.deps,
			"user-1",
		)();

		expect(withEpisodesSnapshot.failedSources).toEqual(new Set());
		expect(withEpisodesSnapshot.jellyfinSnapshotsByCacheType?.has("jellyfin")).toBe(true);
		expect(withEpisodesSnapshot.jellyfinSnapshotsByCacheType?.has("jellyfin_episode")).toBe(true);
		expect(withEpisodesSnapshot.jellyfinTopologyFingerprint).toEqual(expect.any(String));
		expect(withEpisodesSnapshot.sourceCompletedAt.get("jellyfin")).toEqual(
			new Date(withEpisodes.publishedAt.getTime() - 1000),
		);

		const missingEpisodeStatus = makeDeps(
			[rule("jellyfin_episode_completion")],
			[instance("JELLYFIN")],
			{ episodeStatus: "missing" },
		);
		const missingSnapshot = await createMutationPolicySnapshotGetter(
			missingEpisodeStatus.deps,
			"user-1",
		)();
		expect(missingSnapshot.failedSources).toEqual(new Set(["jellyfin"]));

		const libraryOnly = makeDeps([rule("jellyfin_watch_count")], [instance("JELLYFIN")], {
			episodeStatus: "missing",
		});
		const libraryOnlySnapshot = await createMutationPolicySnapshotGetter(
			libraryOnly.deps,
			"user-1",
		)();
		expect(libraryOnlySnapshot.failedSources).toEqual(new Set());
	});

	it("uses the already-published Jellyfin topology without a refresh pass", async () => {
		const provider = instance("JELLYFIN");
		const { deps, findInstances } = makeDeps([rule("jellyfin_watch_count")], [provider]);
		let reads = 0;
		findInstances.mockImplementation(async ({ where }) => {
			reads += 1;
			const services = typeof where.service === "string" ? [where.service] : where.service.in;
			const current = [provider].filter((entry) => services.includes(entry.service));
			return reads === 2 ? [...current, instance("EMBY")] : current;
		});

		const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();

		expect(snapshot.failedSources).toEqual(new Set());
		expect(refreshMocks.jellyfin).not.toHaveBeenCalled();
	});

	it("does not settle Jellyfin evidence with a second refresh pass", async () => {
		const provider = instance("JELLYFIN");
		const { deps } = makeDeps([rule("jellyfin_watch_count")], [provider]);
		let reads = 0;
		const jellyfinFindMany = deps.prisma.jellyfinCache.findMany as unknown as ReturnType<
			typeof vi.fn
		>;
		jellyfinFindMany.mockImplementation(async () => {
			reads += 1;
			return reads <= 2
				? []
				: [
						{
							id: "jellyfin-row",
							instanceId: provider.id,
							tmdbId: 42,
							mediaType: "movie",
							libraryId: "library-1",
							libraryName: "Movies",
							title: "Movie",
							jellyfinId: "jellyfin-row",
							lastWatchedAt: null,
							watchCount: 1,
							watchedByUsers: "[]",
							onDeck: false,
							userRating: null,
							collections: "[]",
							addedAt: null,
							thumb: null,
							connectionGeneration: 1,
							identityGeneration: 1,
						},
					];
		});

		const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();

		expect(snapshot.failedSources).toEqual(new Set());
		expect(refreshMocks.jellyfin).not.toHaveBeenCalled();
	});

	it("does not grant the cleanup run lease to a Tautulli publication", async () => {
		const { deps } = makeDeps([rule("tautulli_watch_count")], [instance("TAUTULLI")]);

		const snapshot = await createMutationPolicySnapshotGetter(
			deps,
			"user-1",
			undefined,
			"cleanup-run",
		)();

		expect(snapshot.failedSources).toEqual(new Set(["tautulli"]));
		expect(refreshMocks.tautulli).not.toHaveBeenCalled();
	});

	it("does not accept an absent published Plex generation as refreshed evidence", async () => {
		const { deps } = makeDeps([rule("plex_watch_count")], [instance("PLEX")]);

		const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();

		expect(snapshot.failedSources).toEqual(new Set(["plex"]));
		expect(refreshMocks.plex).not.toHaveBeenCalled();
	});

	it("fails closed when an enabled Plex episode cache lacks parent-bound authority", async () => {
		const { deps, findInstances } = makeDeps([rule("plex_episode_completion")], [instance("PLEX")]);

		const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();

		expect(deps.log.warn).toHaveBeenCalled();
		expect(snapshot.failedSources).toEqual(new Set(["plex"]));
		for (const [query] of findInstances.mock.calls as Array<
			[{ where: { service: string | { in: string[] }; enabled?: boolean } }]
		>) {
			if (
				query.where.service === "PLEX" ||
				(typeof query.where.service === "object" && query.where.service.in.includes("PLEX"))
			) {
				expect(query.where.enabled).toBe(true);
			}
		}
	});

	it("captures fresh non-shared authority for every target and irreversible write", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-31T12:00:00.000Z"));
		const { deps, findConfig } = makeDeps([]);
		const getSnapshot = createMutationPolicySnapshotGetter(deps, "user-1");

		const first = await getSnapshot();
		vi.advanceTimersByTime(MUTATION_POLICY_SNAPSHOT_MAX_AGE_MS);
		const atBoundary = await getSnapshot();
		vi.advanceTimersByTime(1);
		const renewed = await getSnapshot();

		expect(atBoundary).not.toBe(first);
		expect(renewed).not.toBe(first);
		expect(renewed.capturedAt.getTime()).toBe(
			first.capturedAt.getTime() + MUTATION_POLICY_SNAPSHOT_MAX_AGE_MS + 1,
		);
		expect(findConfig).toHaveBeenCalledTimes(3);
	});

	it("orders tied-priority mutation rules by stable id", async () => {
		const later = { ...rule("age"), id: "z-unmonitor", action: "unmonitor" };
		const winner = { ...rule("age"), id: "a-delete", action: "delete" };
		const { deps } = makeDeps([later, winner]);

		const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();

		expect(snapshot.rules.map((entry) => [entry.id, entry.action])).toEqual([
			["a-delete", "delete"],
			["z-unmonitor", "unmonitor"],
		]);
	});

	it("fails immediately when cleanup has been disabled", async () => {
		const { deps, findConfig, findInstances } = makeDeps(
			[rule("plex_watch_count")],
			[instance("PLEX")],
		);
		findConfig.mockResolvedValueOnce({
			id: "config-1",
			userId: "user-1",
			enabled: false,
			rules: [rule("plex_watch_count")],
		});

		await expect(createMutationPolicySnapshotGetter(deps, "user-1")()).rejects.toThrow(
			/configuration is no longer enabled/i,
		);
		expect(findInstances).not.toHaveBeenCalled();
		expect(refreshMocks.plex).not.toHaveBeenCalled();
	});

	it.each([
		[
			"Radarr",
			"blocks an added target",
			"RADARR",
			"movie",
			[],
			["plex-b-84"],
			["plex-a-84"],
			["plex-b-84"],
			true,
			false,
			false,
		],
		[
			"Sonarr",
			"blocks an added target",
			"SONARR",
			"series",
			[],
			["plex-b-84"],
			["plex-a-84"],
			["plex-b-84"],
			true,
			false,
			false,
		],
		[
			"Radarr",
			"allows unchanged identity",
			"RADARR",
			"movie",
			[],
			["plex-b-84"],
			[],
			["plex-b-84"],
			false,
			false,
			false,
		],
		[
			"Radarr",
			"blocks a mutable policy change with unchanged identity",
			"RADARR",
			"movie",
			[],
			["plex-b-84"],
			[],
			["plex-b-84"],
			true,
			false,
			true,
		],
		[
			"Radarr",
			"blocks a live ARR policy change during the Plex refresh",
			"RADARR",
			"movie",
			[],
			["plex-b-84"],
			[],
			["plex-b-84"],
			true,
			false,
			false,
		],
		[
			"Radarr",
			"blocks a final ARR target repoint",
			"RADARR",
			"movie",
			[],
			["plex-b-84"],
			[],
			["plex-b-84"],
			true,
			false,
			false,
		],
		[
			"Sonarr",
			"allows unchanged identity",
			"SONARR",
			"series",
			[],
			["plex-b-84"],
			[],
			["plex-b-84"],
			false,
			false,
			false,
		],
		[
			"Sonarr",
			"allows unchanged identity without an optional TMDb ID",
			"SONARR",
			"series",
			[],
			["plex-b-84"],
			[],
			["plex-b-84"],
			false,
			true,
			false,
		],
		[
			"Radarr",
			"blocks a disappeared target",
			"RADARR",
			"movie",
			[],
			["plex-b-84"],
			[],
			[],
			true,
			false,
			false,
		],
		[
			"Sonarr",
			"blocks a disappeared target",
			"SONARR",
			"series",
			[],
			["plex-b-84"],
			[],
			[],
			true,
			false,
			false,
		],
		[
			"Radarr",
			"allows unchanged duplicate editions",
			"RADARR",
			"movie",
			[],
			["plex-b-84-a", "plex-b-84-b"],
			[],
			["plex-b-84-a", "plex-b-84-b"],
			false,
			false,
			false,
		],
		[
			"Sonarr",
			"allows unchanged duplicate editions",
			"SONARR",
			"series",
			[],
			["plex-b-84-a", "plex-b-84-b"],
			[],
			["plex-b-84-a", "plex-b-84-b"],
			false,
			false,
			false,
		],
	] as const)(
		"%s %s after final target revalidation",
		async (_label, _expectedBehavior, service, mediaType, plexATargetsAtSnapshot, plexBTargetsAtSnapshot, plexATargetsAtMutation, plexBTargetsAtMutation, expectedToBlock, omitSonarrTmdbId, policyChangesAfterSnapshot) => {
			const cleanupRunClaimToken = "cleanup-run";
			const arrPolicyChangesDuringRefresh =
				_expectedBehavior === "blocks a live ARR policy change during the Plex refresh";
			const repointsAtFinalArrFence = _expectedBehavior === "blocks a final ARR target repoint";
			const plexA = { ...instance("PLEX"), id: "plex-a", name: "Plex A" };
			const plexB = { ...instance("PLEX"), id: "plex-b", name: "Plex B" };
			const plexRule = {
				...rule(policyChangesAfterSnapshot ? "plex_on_deck" : "plex_last_watched"),
				parameters: JSON.stringify(
					policyChangesAfterSnapshot ? { isDeck: false } : { operator: "never" },
				),
				serviceFilter: JSON.stringify([service]),
				targetScope: "series",
				action: "delete",
				scanMediaServerAfterDelete: false,
			};
			const matchedRule = omitSonarrTmdbId
				? {
						...rule("age"),
						parameters: JSON.stringify({ operator: "older_than", days: 0 }),
						serviceFilter: JSON.stringify([service]),
						targetScope: "series",
						action: "delete",
						scanMediaServerAfterDelete: false,
					}
				: plexRule;
			const plexDependencyRule = omitSonarrTmdbId ? { ...plexRule, priority: 2 } : plexRule;
			const liveRetentionRule = {
				...rule("monitored"),
				id: "retain-monitored",
				priority: 0,
				parameters: "{}",
				serviceFilter: JSON.stringify([service]),
				targetScope: "series",
				retentionMode: true,
			};
			const snapshotRules = arrPolicyChangesDuringRefresh
				? [liveRetentionRule, plexRule]
				: omitSonarrTmdbId
					? [matchedRule, plexDependencyRule]
					: [plexRule];
			const { deps } = makeDeps(snapshotRules, [plexA, plexB]);
			let refreshCallCount = 0;
			let policyChangedDuringTargetLookup = false;
			const generationIds = new Map<string, string>();
			const targetRowsFor = (
				instanceId: string,
				generationId: string,
				ratingKeys: readonly string[],
			) =>
				ratingKeys.map((ratingKey, index) => ({
					id: `plex-target-${instanceId}-${index}`,
					instanceId,
					generationId,
					sectionId: "movies",
					sectionUuid: "movies-uuid",
					mediaType: mediaType as "movie" | "series",
					tmdbId: 84,
					tvdbId: mediaType === "series" ? 84 : null,
					ratingKey,
				}));
			const publishedRows = plexBTargetsAtSnapshot.map((ratingKey, index) => ({
				id: `plex-row-b-${index}`,
				instanceId: plexB.id,
				tmdbId: 84,
				mediaType,
				sectionId: "movies",
				sectionTitle: "Movies",
				ratingKey,
				lastWatchedAt: null,
				watchCount: 0,
				watchedByUsers: "[]",
				onDeck: false,
				userRating: null,
				collections: "[]",
				labels: "[]",
				addedAt: new Date("2025-01-01T00:00:00.000Z"),
				connectionGeneration: 1,
				identityGeneration: 1,
			}));
			vi.mocked(deps.prisma.plexCache.findMany).mockImplementation((async ({
				where,
			}: {
				where: { instanceId: string };
			}) =>
				where.instanceId === plexB.id
					? publishedRows.map((row) => ({
							...row,
							onDeck: policyChangesAfterSnapshot && policyChangedDuringTargetLookup,
						}))
					: []) as never);
			vi.mocked(deps.prisma.plexCache.count).mockImplementation((async ({
				where,
			}: {
				where: { instanceId: string };
			}) => (where.instanceId === plexB.id ? publishedRows.length : 0)) as never);
			const publishedAt = new Date();
			vi.mocked(deps.prisma.cacheRefreshStatus.findMany).mockImplementation((async ({
				where,
			}: {
				where: { instanceId: string | { in: string[] } };
			}) =>
				(typeof where.instanceId === "string" ? [where.instanceId] : where.instanceId.in).map(
					(instanceId) => ({
						instanceId,
						lastRefreshedAt: publishedAt,
						lastResult: "success",
						itemCount: instanceId === plexB.id ? publishedRows.length : 0,
						generationId: generationIds.get(instanceId) ?? `generation-${instanceId}`,
						generationMetadata: plexV5Metadata(
							instanceId === plexB.id ? publishedRows.length : 0,
							instanceId,
							generationIds.get(instanceId) ?? `generation-${instanceId}`,
							1,
							1,
							publishedAt,
							targetRowsFor(
								instanceId,
								generationIds.get(instanceId) ?? `generation-${instanceId}`,
								instanceId === plexA.id ? plexATargetsAtSnapshot : plexBTargetsAtSnapshot,
							),
						),
						lastErrorMessage: null,
						lastAttemptAt: publishedAt,
						lastAttemptResult: "success",
						lastAttemptErrorMessage: null,
						connectionGeneration: 1,
						identityGeneration: 1,
					}),
				)) as never);
			refreshMocks.plex.mockImplementation(async (...args: unknown[]) => {
				const instanceId = plexRefreshInstanceId(args);
				const pass = Math.floor(refreshCallCount / 2) + 1;
				refreshCallCount++;
				const generationId = `generation-${pass}-${instanceId}`;
				generationIds.set(instanceId, generationId);
				return {
					upserted: instanceId === plexB.id ? 1 : 0,
					errors: 0,
					errorMessages: [],
					complete: true,
					completedAt: publishedAt,
					generationId,
					inventoryTargets: (instanceId === plexA.id
						? plexATargetsAtSnapshot
						: plexBTargetsAtSnapshot
					).map((ratingKey) => ({
						mediaType,
						tmdbId: 84,
						...(mediaType === "series" ? { tvdbId: 84 } : {}),
						ratingKey,
					})),
					targetLedger: createPlexTargetLedgerBinding({
						instanceId,
						generationId,
						connectionGeneration: 1,
						identityGeneration: 1,
						targets: targetRowsFor(
							instanceId,
							generationId,
							instanceId === plexA.id ? plexATargetsAtSnapshot : plexBTargetsAtSnapshot,
						),
					}),
				};
			});
			const targetFindMany = vi.fn(async ({ where }: { where: { instanceId: string } }) => {
				const instanceId = where.instanceId;
				const ratingKeys =
					instanceId === plexA.id ? plexATargetsAtSnapshot : plexBTargetsAtSnapshot;
				return targetRowsFor(
					instanceId,
					generationIds.get(instanceId) ?? `generation-${instanceId}`,
					ratingKeys,
				);
			});
			Object.assign(deps.prisma, { plexGenerationTarget: { findMany: targetFindMany } });
			const cacheStatusFindUnique = deps.prisma.cacheRefreshStatus
				.findUnique as unknown as ReturnType<typeof vi.fn>;
			cacheStatusFindUnique.mockImplementation(async ({ where }) => {
				const { instanceId, cacheType } = where.instanceId_cacheType;
				if (cacheType !== "plex") return null;
				const targetRatingKeys =
					instanceId === plexA.id ? plexATargetsAtSnapshot : plexBTargetsAtSnapshot;
				const generationId = generationIds.get(instanceId) ?? `generation-${instanceId}`;
				return {
					instanceId,
					lastRefreshedAt: publishedAt,
					lastResult: "success",
					itemCount: targetRatingKeys.length,
					generationId,
					generationMetadata: plexV5Metadata(
						targetRatingKeys.length,
						instanceId,
						generationId,
						1,
						1,
						publishedAt,
						targetRowsFor(instanceId, generationId, targetRatingKeys),
					),
					lastErrorMessage: null,
					lastAttemptAt: publishedAt,
					lastAttemptResult: "success",
					lastAttemptErrorMessage: null,
					connectionGeneration: 1,
					identityGeneration: 1,
				};
			});

			const currentTargets = (plexInstanceId: string) =>
				(plexInstanceId === plexA.id ? plexATargetsAtMutation : plexBTargetsAtMutation).map(
					(ratingKey) => ({ ratingKey }),
				);
			deps.plexCacheClientFactory = vi.fn((plexInstance) => {
				const readCurrentTargets = async () => {
					if (policyChangesAfterSnapshot) policyChangedDuringTargetLookup = true;
					return currentTargets(plexInstance.id);
				};
				return {
					getMovieMediaPartsByTmdbId: vi.fn(readCurrentTargets),
					getSeriesEpisodeMediaPartsByTvdbId: vi.fn(readCurrentTargets),
				} as never;
			});
			const arrInstance = {
				id: `${service.toLowerCase()}-1`,
				userId: "user-1",
				name: _label,
				service,
				baseUrl: `http://${service.toLowerCase()}.test`,
				encryptedApiKey: "encrypted",
				encryptionIv: "iv",
				encryptedHttpAuthCredentials: null,
				httpAuthEncryptionIv: null,
				enabled: true,
				createdAt: new Date("2026-07-31T12:00:00.000Z"),
				updatedAt: new Date("2026-07-31T12:00:00.000Z"),
			};
			const rawItem = {
				id: 101,
				...(service === "RADARR"
					? { tmdbId: 84 }
					: { tvdbId: 84, ...(omitSonarrTmdbId ? {} : { tmdbId: 84 }) }),
				title: `Example ${_label} Item`,
				path: `/media/example-${service.toLowerCase()}`,
				monitored: !arrPolicyChangesDuringRefresh,
				status: "ended",
				qualityProfileId: 1,
				sizeOnDisk: 2_000,
				added: "2025-01-01T00:00:00.000Z",
				statistics:
					service === "RADARR"
						? { movieFileCount: 1, sizeOnDisk: 2_000 }
						: { episodeFileCount: 1, sizeOnDisk: 2_000 },
			};
			const revalidatedRawItem = {
				...rawItem,
				monitored: arrPolicyChangesDuringRefresh ? true : rawItem.monitored,
			};
			const getById = vi
				.fn()
				.mockResolvedValueOnce(rawItem)
				.mockResolvedValueOnce(revalidatedRawItem)
				.mockResolvedValue(
					repointsAtFinalArrFence ? { ...revalidatedRawItem, tmdbId: 85 } : revalidatedRawItem,
				);
			deps.arrClientFactory = {
				create: vi.fn(() =>
					service === "RADARR" ? { movie: { getById } } : { series: { getById } },
				),
			} as never;
			const snapshot = await createMutationPolicySnapshotGetter(
				deps,
				"user-1",
				undefined,
				cleanupRunClaimToken,
			)();
			expect(targetFindMany).toHaveBeenCalled();
			expect(snapshot.plexTargetLedgerBindingsByInstance?.get(plexB.id)).toMatchObject({
				generationId: generationIds.get(plexB.id) ?? `generation-${plexB.id}`,
				targetLedgerVersion: 1,
				targetCount: plexBTargetsAtSnapshot.length,
			});
			expect(
				snapshot.plexTargetRatingKeysByInstance?.get(plexB.id)?.get(`${mediaType}:tmdb:84`),
			).toEqual(new Set(plexBTargetsAtSnapshot));
			const upstreamMutation = vi.fn();

			const executeAuthorizedDelete = async () => {
				const authorized = await assertCurrentSeriesMutationAuthority(
					deps,
					"user-1",
					arrInstance as never,
					101,
					{
						matchedRuleId: matchedRule.id,
						action: "delete",
						scanMediaServerAfterDelete: false,
					},
					snapshot,
					cleanupRunClaimToken,
				);
				expect(authorized.providerFactGrantDigest).toBeUndefined();
				await upstreamMutation();
			};
			if (expectedToBlock) {
				await expect(executeAuthorizedDelete()).rejects.toThrow(
					/provider evidence could not re-authorize/i,
				);
				expect(upstreamMutation).not.toHaveBeenCalled();
			} else {
				await expect(executeAuthorizedDelete()).resolves.toBeUndefined();
				expect(upstreamMutation).toHaveBeenCalledOnce();
			}
			expect(refreshMocks.plex).not.toHaveBeenCalled();
		},
	);

	it("allows a non-Plex winner when only a lower-priority cleanup rule needs unavailable Plex evidence", async () => {
		const plex = instance("PLEX");
		const ageRule = {
			...rule("age"),
			priority: 1,
			parameters: JSON.stringify({ operator: "older_than", days: 0 }),
			serviceFilter: JSON.stringify(["RADARR"]),
			targetScope: "series",
			action: "delete",
			scanMediaServerAfterDelete: false,
		};
		const lowerPlexRule = {
			...rule("plex_last_watched"),
			priority: 2,
			parameters: JSON.stringify({ operator: "never" }),
			serviceFilter: JSON.stringify(["RADARR"]),
			targetScope: "series",
			action: "delete",
			scanMediaServerAfterDelete: false,
		};
		refreshMocks.plex.mockResolvedValue({
			upserted: 0,
			errors: 1,
			errorMessages: ["Plex unavailable"],
			complete: false,
			completedAt: new Date(),
		});
		const { deps } = makeDeps([ageRule, lowerPlexRule], [plex]);
		const rawItem = {
			id: 101,
			tmdbId: 84,
			title: "Example Radarr Item",
			path: "/media/example-radarr",
			monitored: true,
			status: "released",
			qualityProfileId: 1,
			sizeOnDisk: 2_000,
			added: "2025-01-01T00:00:00.000Z",
			statistics: { movieFileCount: 1, sizeOnDisk: 2_000 },
		};
		const getById = vi.fn().mockResolvedValue(rawItem);
		deps.arrClientFactory = {
			create: vi.fn(() => ({ movie: { getById } })),
		} as never;
		const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();
		const radarr = {
			...instance("PLEX"),
			id: "radarr-1",
			name: "Radarr",
			service: "RADARR",
			baseUrl: "http://radarr.test",
		};

		expect(snapshot.failedSources).toContain("plex");
		await expect(
			assertCurrentSeriesMutationAuthority(
				deps,
				"user-1",
				radarr as never,
				101,
				{
					matchedRuleId: ageRule.id,
					action: "delete",
					scanMediaServerAfterDelete: false,
				},
				snapshot,
			),
		).resolves.toMatchObject({ rawItem });
		expect(getById).toHaveBeenCalledTimes(2);
	});

	it("revalidates Jellyfin-only requester retention without reading Plex targets", async () => {
		const jellyfin = instance("JELLYFIN");
		const retentionRule = {
			...rule("seerr_requester_watched"),
			id: "requester-retention",
			priority: 1,
			retentionMode: true,
			targetScope: "series",
		};
		const ageRule = {
			...rule("age"),
			id: "age-cleanup",
			priority: 2,
			targetScope: "series",
			parameters: JSON.stringify({ operator: "older_than", days: 0 }),
		};
		const { deps } = makeDeps([retentionRule, ageRule], [jellyfin]);
		const rawItem = {
			id: 101,
			tvdbId: 84,
			tmdbId: 84,
			title: "Requester retention fixture",
			path: "/media/requester-retention",
			monitored: true,
			status: "ended",
			qualityProfileId: 1,
			sizeOnDisk: 2_000,
			added: "2025-01-01T00:00:00.000Z",
			statistics: { episodeFileCount: 1, sizeOnDisk: 2_000 },
		};
		const getById = vi.fn().mockImplementation(async () => {
			// Simulate a provider identity/generation race during the live ARR read,
			// after the initial Jellyfin authority fence has already passed.
			jellyfin.connectionGeneration = 2;
			return rawItem;
		});
		deps.arrClientFactory = {
			create: vi.fn(() => ({ series: { getById } })),
		} as never;
		const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();
		const arrInstance = {
			...instance("JELLYFIN"),
			id: "sonarr-1",
			service: "SONARR",
		};
		const upstreamMutation = vi.fn();

		await expect(
			(async () => {
				await assertCurrentSeriesMutationAuthority(
					deps,
					"user-1",
					arrInstance as never,
					101,
					{ matchedRuleId: ageRule.id, action: "delete", scanMediaServerAfterDelete: false },
					snapshot,
				);
				await upstreamMutation();
			})(),
		).rejects.toThrow(/provider evidence could not re-authorize/i);
		expect(upstreamMutation).not.toHaveBeenCalled();
		expect(refreshMocks.plex).not.toHaveBeenCalled();
		expect(snapshot.ctx.requesterWatchSourceFamilies).toEqual(new Set(["jellyfin"]));
	});

	it("revalidates a definitive false Jellyfin requester retention without Plex reads", async () => {
		const jellyfin = instance("JELLYFIN");
		const seerr = { ...instance("JELLYFIN"), id: "seerr-1", service: "SEERR" };
		const retentionRule = {
			...rule("seerr_requester_watched"),
			id: "requester-retention",
			priority: 1,
			retentionMode: true,
			targetScope: "movie",
		};
		const ageRule = {
			...rule("age"),
			id: "age-cleanup",
			priority: 2,
			targetScope: "movie",
			parameters: JSON.stringify({ operator: "older_than", days: 0 }),
		};
		const observedAt = new Date();
		const row = {
			id: "jellyfin-row-42",
			instanceId: jellyfin.id,
			tmdbId: 42,
			mediaType: "movie",
			libraryId: "movies",
			libraryName: "Movies",
			title: "Requester retention fixture",
			jellyfinId: "movie-42",
			lastWatchedAt: null,
			watchCount: 0,
			watchedByUsers: "[]",
			onDeck: false,
			userRating: null,
			collections: "[]",
			addedAt: observedAt,
			thumb: null,
			connectionGeneration: 1,
			identityGeneration: 1,
		};
		const { deps } = makeDeps([retentionRule, ageRule], [jellyfin, seerr], {
			jellyfinRows: [row],
		});
		const seerrClient = {
			getRequests: vi.fn().mockResolvedValue({
				pageInfo: { pages: 1, results: 1, page: 1 },
				results: [
					{
						id: 1,
						status: 5,
						type: "movie",
						media: { tmdbId: 42 },
						requestedBy: { id: 7, displayName: "Requester" },
						createdAt: observedAt.toISOString(),
						updatedAt: observedAt.toISOString(),
					},
				],
			}),
		};
		deps.seerrClientFactory = vi.fn(() => seerrClient) as never;
		const radarr = { ...instance("JELLYFIN"), id: "radarr-1", service: "RADARR" };
		const rawItem = {
			id: 101,
			tmdbId: 42,
			title: "Requester retention fixture",
			path: "/media/requester-retention",
			monitored: true,
			hasFile: true,
			movieFileId: 1001,
			sizeOnDisk: 2_000,
			added: "2025-01-01T00:00:00.000Z",
			statistics: { movieFileCount: 1, sizeOnDisk: 2_000 },
		};
		const getById = vi.fn().mockResolvedValue(rawItem);
		deps.arrClientFactory = { create: vi.fn(() => ({ movie: { getById } })) } as never;
		const plexReads = deps.plexCacheClientFactory as unknown as ReturnType<typeof vi.fn>;
		const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();

		await expect(
			assertCurrentSeriesMutationAuthority(
				deps,
				"user-1",
				radarr as never,
				101,
				{ matchedRuleId: ageRule.id, action: "delete", scanMediaServerAfterDelete: false },
				snapshot,
			),
		).resolves.toMatchObject({ rawItem });
		expect(snapshot.ctx.requesterWatchSourceFamilies).toEqual(new Set(["jellyfin"]));
		expect(plexReads).not.toHaveBeenCalled();
		expect(deps.seerrClientFactory).toHaveBeenCalled();
	});

	it.each([
		["unchanged completed fact", "unchanged", true],
		["changed completed fact", "fact", false],
		["changed completed generation", "generation", false],
	] as const)(
		"revalidates a generic Jellyfin authority with no provider fact digest when its %s",
		async (_label, drift, shouldAuthorize) => {
			const jellyfin = instance("JELLYFIN");
			const row = {
				id: "jellyfin-row-42",
				instanceId: jellyfin.id,
				tmdbId: 42,
				mediaType: "movie",
				libraryId: "movies",
				libraryName: "Movies",
				title: "Generic Jellyfin fixture",
				jellyfinId: "movie-42",
				lastWatchedAt: null,
				watchCount: 1,
				watchedByUsers: "[]",
				onDeck: false,
				userRating: null,
				collections: "[]",
				addedAt: new Date(),
				thumb: null,
				connectionGeneration: 1,
				identityGeneration: 1,
			};
			const jellyfinRule = {
				...rule("jellyfin_on_deck"),
				targetScope: "series",
				parameters: JSON.stringify({ isDeck: false }),
			};
			const { deps } = makeDeps([jellyfinRule], [jellyfin], { jellyfinRows: [row] });
			const rawItem = {
				id: 101,
				tmdbId: 42,
				title: "Generic Jellyfin fixture",
				path: "/media/generic-jellyfin",
				monitored: true,
				status: "released",
				qualityProfileId: 1,
				sizeOnDisk: 2_000,
				added: "2025-01-01T00:00:00.000Z",
				statistics: { movieFileCount: 1, sizeOnDisk: 2_000 },
			};
			const getById = vi.fn().mockResolvedValue(rawItem);
			deps.arrClientFactory = { create: vi.fn(() => ({ movie: { getById } })) } as never;
			const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();
			expect(snapshot.ctx.jellyfinMap?.get("movie:42")?.watchCount).toBe(1);
			if (drift === "fact") row.onDeck = true;
			if (drift === "generation") jellyfin.connectionGeneration = 2;
			const upstreamMutation = vi.fn();
			const authority = () =>
				assertCurrentSeriesMutationAuthority(
					deps,
					"user-1",
					{ ...instance("JELLYFIN"), id: "radarr-1", service: "RADARR" } as never,
					101,
					{
						matchedRuleId: jellyfinRule.id,
						action: "delete",
						scanMediaServerAfterDelete: false,
					},
					snapshot,
					undefined,
					undefined,
				);
			if (shouldAuthorize) {
				const authorized = await authority();
				expect(authorized.providerFactGrantDigest).toBeUndefined();
				await upstreamMutation();
				expect(upstreamMutation).toHaveBeenCalledOnce();
			} else {
				await expect(authority()).rejects.toThrow(/provider evidence could not re-authorize/i);
				expect(upstreamMutation).not.toHaveBeenCalled();
			}
		},
	);

	it.each(["approval", "direct", "retry"] as const)(
		"blocks %s execution when the durable selection depends on quarantined Tautulli evidence",
		async (_mode) => {
			const tautulliRule = {
				...rule("tautulli_watch_count"),
				targetScope: "series",
			};
			const { deps } = makeDeps([tautulliRule], [instance("TAUTULLI")]);
			const rawItem = {
				id: 101,
				tmdbId: 84,
				title: "Tautulli-dependent candidate",
				path: "/media/candidate",
				monitored: true,
				status: "released",
				qualityProfileId: 1,
				sizeOnDisk: 2_000,
				added: "2025-01-01T00:00:00.000Z",
				statistics: { movieFileCount: 1, sizeOnDisk: 2_000 },
			};
			const getById = vi.fn().mockResolvedValue(rawItem);
			deps.arrClientFactory = {
				create: vi.fn(() => ({ movie: { getById } })),
			} as never;
			const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();
			const upstreamMutation = vi.fn();
			const radarr = {
				...instance("PLEX"),
				id: "radarr-1",
				service: "RADARR",
			};

			await expect(
				(async () => {
					await assertCurrentSeriesMutationAuthority(
						deps,
						"user-1",
						radarr as never,
						101,
						{
							matchedRuleId: tautulliRule.id,
							action: "delete",
							scanMediaServerAfterDelete: false,
							providerDependencies: ["tautulli"],
						},
						snapshot,
					);
					await upstreamMutation();
				})(),
			).rejects.toThrow(/provider evidence could not re-authorize/i);
			expect(snapshot.failedSources).toContain("tautulli");
			expect(upstreamMutation).not.toHaveBeenCalled();
		},
	);

	it.each([
		["missing durable digest", "missing"],
		["same-shape digest with a different observed count", "value"],
		["same-shape digest with a different target coordinate", "coordinate"],
		["same-shape digest after the observed count drifts", "count-drift"],
	] as const)(
		"does not attempt an upstream mutation when target-scoped Plex evidence has a %s",
		async (_label, drift) => {
			const plex = instance("PLEX");
			const plexRule = {
				...rule("plex_watch_count"),
				targetScope: "series",
				serviceFilter: JSON.stringify(["SONARR"]),
			};
			const { deps } = makeDeps([plexRule], [plex]);
			const generationId = "plex-v6-generation";
			const publishedAt = new Date(Date.now() - 1_000);
			const target = {
				id: "plex-v6-target",
				instanceId: plex.id,
				generationId,
				sectionId: "shows",
				sectionUuid: "shows-uuid",
				mediaType: "series" as const,
				tmdbId: 456,
				tvdbId: 123,
				ratingKey: "show-456",
			};
			const status = {
				instanceId: plex.id,
				cacheType: "plex",
				lastRefreshedAt: publishedAt,
				lastResult: "success",
				itemCount: 1,
				generationId,
				generationMetadata: plexV6TargetScopedWatchCountMetadata(
					plex.id,
					generationId,
					publishedAt,
					[target],
				),
				lastErrorMessage: null,
				lastAttemptAt: publishedAt,
				lastAttemptResult: "success",
				lastAttemptErrorMessage: null,
				connectionGeneration: 1,
				identityGeneration: 1,
			};
			const row = {
				id: "plex-v6-row",
				instanceId: plex.id,
				tmdbId: 456,
				mediaType: "series",
				sectionId: "shows",
				sectionTitle: "Shows",
				ratingKey: "show-456",
				lastWatchedAt: null,
				watchCount: 3,
				watchedByUsers: "[]",
				onDeck: false,
				userRating: null,
				collections: "[]",
				labels: "[]",
				addedAt: null,
				thumb: null,
				connectionGeneration: 1,
				identityGeneration: 1,
			};
			const existingInstances = deps.prisma.serviceInstance.findMany;
			Object.assign(deps.prisma, {
				serviceInstance: {
					findMany: existingInstances,
					findFirst: vi.fn().mockResolvedValue(plex),
				},
				plexCache: {
					findMany: vi.fn().mockImplementation(async () => [{ ...row }]),
					count: vi.fn().mockResolvedValue(1),
				},
				plexGenerationTarget: {
					findMany: vi.fn().mockResolvedValue([target]),
				},
				cacheRefreshStatus: {
					...deps.prisma.cacheRefreshStatus,
					findUnique: vi.fn().mockResolvedValue(status),
					findMany: vi
						.fn()
						.mockImplementation(async ({ where }) =>
							where.cacheType === "plex" ? [{ ...status }] : [],
						),
				},
			});
			const rawSeries = {
				id: 201,
				tmdbId: 456,
				tvdbId: 123,
				title: "Target-scoped digest fixture",
				path: "/tv/Target-scoped digest fixture",
				monitored: true,
				statistics: { episodeFileCount: 1, sizeOnDisk: 1_000 },
			};
			const arrWrite = vi.fn();
			const providerWrite = vi.fn();
			const quiWrite = vi.fn();
			deps.arrClientFactory = {
				create: vi.fn(() => ({
					series: {
						getById: vi.fn().mockResolvedValue(rawSeries),
						update: arrWrite,
						delete: arrWrite,
					},
				})),
			} as never;
			deps.plexCacheClientFactory = vi.fn(() => ({ refresh: providerWrite })) as never;
			deps.quiClientFactory = vi.fn(() => ({ remove: quiWrite })) as never;

			const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();
			const scopedEvidence = await loadTargetScopedPlexWatchCountMutationEvidence(
				deps.prisma as never,
				{
					userId: "user-1",
					instanceId: plex.id,
					mediaType: "series",
					tmdbId: 456,
					operator: "greater_than",
					threshold: 0,
				},
			);
			expect(scopedEvidence).toMatchObject({ available: true });
			const scopedFacts = await loadTargetScopedPlexWatchCountFacts(deps, "user-1", [
				{
					instanceId: "sonarr-1",
					arrItemId: 201,
					itemType: "series",
					title: rawSeries.title,
					data: JSON.stringify({ remoteIds: { tmdbId: 456, tvdbId: 123 } }),
					monitored: true,
					hasFile: true,
				},
			] as never);
			expect(scopedFacts.get("series:456")).toMatchObject([
				{ observedValue: 3, coordinate: "shows:show-456", targetScoped: true },
			]);
			const exactDigest = providerFactGrantDigest([
				{
					userId: "user-1",
					provider: "PLEX",
					cacheType: "plex",
					instanceId: plex.id,
					generationId,
					targetKey: "series:456",
					coordinate: "shows:show-456",
					domain: "watch-count",
					field: "watch-count",
					operator: "greater_than",
					threshold: 0,
					observedValue: 3,
					basis: "exact",
				},
			]);
			const expectedDigest =
				drift === "missing"
					? undefined
					: drift === "value"
						? providerFactGrantDigest([
								{
									userId: "user-1",
									provider: "PLEX",
									cacheType: "plex",
									instanceId: plex.id,
									generationId,
									targetKey: "series:456",
									coordinate: "shows:show-456",
									domain: "watch-count",
									field: "watch-count",
									operator: "greater_than",
									threshold: 0,
									observedValue: 2,
									basis: "exact",
								},
							])
						: drift === "coordinate"
							? providerFactGrantDigest([
									{
										userId: "user-1",
										provider: "PLEX",
										cacheType: "plex",
										instanceId: plex.id,
										generationId,
										targetKey: "series:456",
										coordinate: "shows:other-rating-key",
										domain: "watch-count",
										field: "watch-count",
										operator: "greater_than",
										threshold: 0,
										observedValue: 3,
										basis: "exact",
									},
								])
							: exactDigest;
			if (drift === "count-drift") row.watchCount = 4;

			await expect(
				assertCurrentSeriesMutationAuthority(
					deps,
					"user-1",
					{ ...instance("PLEX"), id: "sonarr-1", service: "SONARR" } as never,
					201,
					{
						matchedRuleId: plexRule.id,
						action: "delete",
						scanMediaServerAfterDelete: false,
						providerDependencies: ["plex"],
					},
					snapshot,
					undefined,
					expectedDigest,
				),
			).rejects.toThrow(/provider evidence could not re-authorize/i);
			expect(deps.log.warn).toHaveBeenLastCalledWith(
				expect.objectContaining({
					err: expect.objectContaining({
						message: expect.stringContaining(
							drift === "missing"
								? "durable cleanup intent lacked its provider fact grant digest"
								: "Current provider fact grant did not match the durable cleanup intent",
						),
					}),
				}),
				expect.any(String),
			);
			expect(arrWrite).not.toHaveBeenCalled();
			expect(providerWrite).not.toHaveBeenCalled();
			expect(quiWrite).not.toHaveBeenCalled();
		},
	);
});

describe("interactive preview live watch authority", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		["Plex", "PLEX", "plex_last_watched", refreshMocks.plex, "plex"],
		["Tautulli", "TAUTULLI", "tautulli_last_watched", refreshMocks.tautulli, "tautulli"],
		["Jellyfin", "JELLYFIN", "jellyfin_last_watched", refreshMocks.jellyfin, "jellyfin"],
	] as const)(
		"rejects unpublished live %s authority for preview evaluation",
		async (_label, service, ruleType, refreshMock, source) => {
			const provider = { ...instance(service), connectionGeneration: 1 };
			const radarr = {
				...instance("PLEX"),
				id: "radarr-1",
				service: "RADARR",
				name: "Radarr",
				baseUrl: "http://radarr.test",
				connectionGeneration: 1,
			};
			const recentWatch = new Date("2026-08-09T12:00:00.000Z");
			const snapshot =
				service === "PLEX"
					? {
							rows: [
								{
									instanceId: provider.id,
									tmdbId: 42,
									mediaType: "movie",
									sectionId: "1",
									sectionTitle: "Movies",
									title: "Recent Movie",
									ratingKey: "plex-42",
									lastWatchedAt: recentWatch,
									watchCount: 1,
									watchedByUsers: '["alice"]',
									onDeck: false,
									userRating: null,
									collections: "[]",
									labels: "[]",
									addedAt: new Date("2025-01-01T00:00:00.000Z"),
									thumb: null,
								},
							],
							sections: [{ key: "1", title: "Movies", type: "movie" }],
						}
					: service === "TAUTULLI"
						? {
								rows: [
									{
										instanceId: provider.id,
										tmdbId: 42,
										mediaType: "movie",
										lastWatchedAt: recentWatch,
										watchCount: 1,
										watchedByUsers: '["alice"]',
									},
								],
							}
						: {
								rows: [
									{
										instanceId: provider.id,
										tmdbId: 42,
										mediaType: "movie",
										libraryId: "1",
										libraryName: "Movies",
										title: "Recent Movie",
										jellyfinId: "jf-42",
										lastWatchedAt: recentWatch,
										watchCount: 1,
										watchedByUsers: '["alice"]',
										onDeck: false,
										userRating: null,
										collections: "[]",
										addedAt: new Date("2025-01-01T00:00:00.000Z"),
										thumb: null,
									},
								],
								users: [{ id: "user-1", name: "Alice" }],
								libraries: [
									{
										userId: "user-1",
										libraryId: "1",
										libraryName: "Movies",
										collectionType: "movies",
									},
								],
							};
			refreshMock.mockResolvedValue({
				upserted: 0,
				errors: 0,
				errorMessages: [],
				complete: true,
				completedAt: new Date(),
				snapshot,
			});
			const transaction = vi.fn();
			const deleteMany = vi.fn();
			const createMany = vi.fn();
			const statusUpsert = vi.fn();
			const findInstances = vi.fn(async ({ where }: { where: { service?: unknown } }) => {
				const all = [radarr, provider];
				if (typeof where.service === "string") {
					return all.filter((entry) => entry.service === where.service);
				}
				if (where.service && typeof where.service === "object" && "in" in where.service) {
					const services = (where.service as { in: string[] }).in;
					return all.filter((entry) => services.includes(entry.service));
				}
				return all;
			});
			const configRule = {
				...rule(ruleType),
				parameters: JSON.stringify({ operator: "older_than", days: 30 }),
				action: "unmonitor",
				plexLibraryFilter: null,
				excludeTags: null,
				excludeTitles: null,
				scanMediaServerAfterDelete: false,
				rejectionMemoryDays: 0,
			};
			const candidate = {
				id: "cache-42",
				instanceId: "radarr-1",
				arrItemId: 42,
				itemType: "movie",
				title: "Recent Movie",
				year: 2024,
				monitored: true,
				hasFile: true,
				status: "released",
				qualityProfileId: 1,
				qualityProfileName: "HD",
				sizeOnDisk: 1_000n,
				arrAddedAt: new Date("2025-01-01T00:00:00.000Z"),
				cachedAt: new Date(),
				data: JSON.stringify({ tmdbId: 42, service: "radarr" }),
				torrentState: null,
				infoHash: null,
			};
			const libraryFindMany = vi.fn().mockResolvedValueOnce([candidate]).mockResolvedValue([]);
			const deps = {
				prisma: {
					$transaction: transaction,
					libraryCleanupConfig: {
						findUnique: vi.fn().mockResolvedValue({
							id: "config-1",
							userId: "user-1",
							enabled: true,
							dryRunMode: true,
							requireApproval: false,
							maxRemovalsPerRun: 10,
							respectQuiSeeding: false,
							rejectionMemoryDays: 0,
							rules: [configRule],
						}),
					},
					serviceInstance: { findMany: findInstances },
					libraryCache: { findMany: libraryFindMany },
					plexCache: { deleteMany, createMany },
					tautulliCache: { deleteMany, createMany },
					jellyfinCache: { deleteMany, createMany },
					cacheRefreshStatus: { upsert: statusUpsert },
					libraryCleanupApproval: { findMany: vi.fn().mockResolvedValue([]) },
					libraryCleanupLog: { findFirst: vi.fn().mockResolvedValue(null) },
				},
				arrClientFactory: { create: vi.fn() },
				plexCacheClientFactory: vi.fn(() => ({}) as never),
				tautulliCacheClientFactory: vi.fn(() => ({}) as never),
				jellyfinCacheClientFactory: vi.fn(() => ({}) as never),
				log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			} as unknown as CleanupExecutorDeps;

			const result = await executeCleanupPreview(deps, "user-1");

			expect(result.itemsEvaluated).toBe(1);
			expect(result.itemsFlagged).toBe(0);
			expect(result.previewItemCount).toBe(0);
			expect(result.details).toEqual([]);
			expect(result.prefetchHealth?.[source]).toBe("failed");
			expect(result.warnings).toContainEqual(expect.stringContaining("unavailable"));
			expect(refreshMock).not.toHaveBeenCalled();
			if (service === "JELLYFIN") expect(transaction).toHaveBeenCalledOnce();
			else expect(transaction).not.toHaveBeenCalled();
			expect(deleteMany).not.toHaveBeenCalled();
			expect(createMany).not.toHaveBeenCalled();
			expect(statusUpsert).not.toHaveBeenCalled();

			const changedSnapshot = structuredClone(snapshot);
			changedSnapshot.rows[0]!.watchCount += 1;
			refreshMock
				.mockReset()
				.mockResolvedValueOnce({
					upserted: 0,
					errors: 0,
					errorMessages: [],
					complete: true,
					completedAt: new Date(),
					snapshot,
				})
				.mockResolvedValueOnce({
					upserted: 0,
					errors: 0,
					errorMessages: [],
					complete: true,
					completedAt: new Date(),
					snapshot: changedSnapshot,
				});
			libraryFindMany.mockReset().mockResolvedValueOnce([candidate]).mockResolvedValue([]);

			const changedResult = await executeCleanupPreview(deps, "user-1");

			expect(changedResult.itemsEvaluated).toBe(1);
			expect(changedResult.itemsFlagged).toBe(0);
			expect(changedResult.previewItemCount).toBe(0);
			expect(changedResult.prefetchHealth?.[source]).toBe("failed");
			expect(changedResult.warnings).toContainEqual(expect.stringContaining("unavailable"));
			if (service === "JELLYFIN") expect(transaction).toHaveBeenCalledTimes(2);
			else expect(transaction).not.toHaveBeenCalled();
			expect(deleteMany).not.toHaveBeenCalled();
			expect(createMany).not.toHaveBeenCalled();
			expect(statusUpsert).not.toHaveBeenCalled();

			configRule.parameters = JSON.stringify({ operator: "never" });
			const unrelatedSnapshot = structuredClone(snapshot);
			unrelatedSnapshot.rows = [];
			refreshMock.mockReset().mockResolvedValue({
				upserted: 0,
				errors: 0,
				errorMessages: [],
				complete: true,
				completedAt: new Date(),
				snapshot: unrelatedSnapshot,
			});
			libraryFindMany.mockReset().mockResolvedValueOnce([candidate]).mockResolvedValue([]);

			const unrelatedResult = await executeCleanupPreview(deps, "user-1");

			expect(unrelatedResult.itemsEvaluated).toBe(1);
			expect(unrelatedResult.itemsFlagged).toBe(0);
			expect(unrelatedResult.previewItemCount).toBe(0);
			expect(unrelatedResult.prefetchHealth?.[source]).toBe("failed");
			expect(refreshMock).not.toHaveBeenCalled();
			if (service === "JELLYFIN") expect(transaction).toHaveBeenCalledTimes(3);
			else expect(transaction).not.toHaveBeenCalled();
			expect(deleteMany).not.toHaveBeenCalled();
			expect(createMany).not.toHaveBeenCalled();
			expect(statusUpsert).not.toHaveBeenCalled();
		},
	);
});

describe("Jellyfin V2 cleanup parent-watch isolation", () => {
	it("skips preview and execution after a structurally compatible parent watch update", async () => {
		const provider = instance("JELLYFIN");
		const sonarr = {
			...provider,
			id: "sonarr-1",
			name: "Sonarr",
			service: "SONARR",
			baseUrl: "http://sonarr.test",
		};
		const episodeRule = {
			...rule("jellyfin_episode_completion"),
			targetScope: "series",
			parameters: JSON.stringify({ operator: "less_than", percentage: 100 }),
			action: "delete",
		};
		const parentAt = new Date(Date.now() - 20_000);
		const updatedParentAt = new Date(Date.now() - 10_000);
		const episodeAt = new Date(Date.now() - 15_000);
		const parentRow = {
			id: "jellyfin-series-row",
			instanceId: provider.id,
			tmdbId: 42,
			mediaType: "series",
			libraryId: "shows",
			libraryName: "Shows",
			title: "Isolation Fixture",
			jellyfinId: "series-42",
			lastWatchedAt: null as Date | null,
			watchCount: 0,
			watchedByUsers: "[]",
			onDeck: false,
			userRating: null,
			collections: "[]",
			addedAt: parentAt,
			thumb: null,
			connectionGeneration: 1,
			identityGeneration: 1,
		};
		const updatedParentRow = {
			...parentRow,
			lastWatchedAt: updatedParentAt,
			watchCount: 1,
			watchedByUsers: '["user-1"]',
		};
		const episodeRow = {
			id: "jellyfin-episode-row",
			instanceId: provider.id,
			showTmdbId: 42,
			seasonNumber: 1,
			episodeNumber: 1,
			jellyfinId: "episode-42-1",
			title: "Pilot",
			watched: false,
			watchedByUsers: "[]",
			lastWatchedAt: null as Date | null,
			connectionGeneration: 1,
			identityGeneration: 1,
		};
		const unit = (scopeKey: string, count: number) => ({
			scopeKey,
			expectedRawCount: count,
			pagesAttempted: 1,
			pagesCompleted: 1,
			rawObserved: count,
			sourceBindings: count,
			canonicalEntities: count,
			acceptedSkips: [],
			fatalCount: 0,
		});
		const parentMetadata = (rows: (typeof parentRow)[], observedAt: Date) =>
			encodeJellyfinLibraryGenerationMetadata({
				version: 1,
				provider: "jellyfin",
				cacheType: "jellyfin",
				publicationLevel: "authoritative",
				completeness: "complete",
				canonicalizationVersion: 1,
				itemCount: rows.length,
				connectionGeneration: 1,
				identityGeneration: 1,
				contentFingerprint: fingerprintJellyfinLibraryRows(rows as never),
				coverageReceipt: {
					version: 2,
					provider: "jellyfin",
					attemptStartedAt: observedAt.toISOString(),
					observedAt: observedAt.toISOString(),
					evidence: "complete",
					units: [unit("library", rows.length)],
					publishedCanonicalEntities: rows.length,
					domains: [
						"library-inventory",
						"mapping",
						"watch-count",
						"watch-attribution",
						"on-deck",
					].map((domain) => ({
						domain,
						evidence: "complete",
						valueSemantics: "exact",
						units: [unit(`library:${domain}`, rows.length)],
						...(domain === "mapping" || domain === "watch-count"
							? { publishedCanonicalEntities: rows.length }
							: {}),
					})),
				},
			});
		const originalParentMetadata = parentMetadata([parentRow], parentAt);
		const originalParentDependency = fingerprintJellyfinEpisodeParentDependency(
			provider.id,
			originalParentMetadata,
			[parentRow] as never,
		);
		expect(originalParentDependency).toMatch(/^[a-f0-9]{64}$/);
		const episodeMetadata = encodeJellyfinEpisodeGenerationMetadata({
			version: 2,
			provider: "jellyfin",
			cacheType: "jellyfin_episode",
			publicationLevel: "authoritative",
			completeness: "complete",
			canonicalizationVersion: 1,
			itemCount: 1,
			connectionGeneration: 1,
			identityGeneration: 1,
			parentLibraryGenerationId: "parent-original",
			parentLibraryMetadataFingerprint: fingerprintJellyfinLibraryGenerationMetadata(
				JSON.parse(originalParentMetadata),
			),
			parentLibraryDependencyFingerprint: originalParentDependency!,
			contentFingerprint: fingerprintJellyfinEpisodeRows([episodeRow] as never),
			coverageReceipt: {
				version: 2,
				provider: "jellyfin_episode",
				attemptStartedAt: episodeAt.toISOString(),
				observedAt: episodeAt.toISOString(),
				evidence: "complete",
				units: [unit("episode-inventory:shows", 1)],
				publishedCanonicalEntities: 1,
				domains: [
					{
						domain: "episode-inventory",
						evidence: "complete",
						valueSemantics: "exact",
						units: [unit("episode-inventory:shows", 1)],
						publishedCanonicalEntities: 1,
					},
				],
			},
		});
		const makeStatus = (
			cacheType: "jellyfin" | "jellyfin_episode",
			metadata: string,
			generationId: string,
			observedAt: Date,
			itemCount: number,
		) => ({
			instanceId: provider.id,
			cacheType,
			lastRefreshedAt: observedAt,
			lastResult: "success",
			itemCount,
			generationId,
			generationMetadata: metadata,
			lastErrorMessage: null,
			lastAttemptAt: observedAt,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			connectionGeneration: 1,
			identityGeneration: 1,
		});
		const updatedParentMetadata = parentMetadata([updatedParentRow], updatedParentAt);
		expect(
			fingerprintJellyfinEpisodeParentDependency(provider.id, updatedParentMetadata, [
				updatedParentRow,
			] as never),
		).toBe(originalParentDependency);
		expect(fingerprintJellyfinLibraryRows([updatedParentRow] as never)).not.toBe(
			fingerprintJellyfinLibraryRows([parentRow] as never),
		);
		const updatedParentStatus = makeStatus(
			"jellyfin",
			updatedParentMetadata,
			"parent-updated",
			updatedParentAt,
			1,
		);
		const episodeStatus = makeStatus(
			"jellyfin_episode",
			episodeMetadata,
			"episode-original",
			episodeAt,
			1,
		);
		const { deps, findConfig } = makeDeps([episodeRule], [sonarr, provider], {
			jellyfinRows: [updatedParentRow],
		});
		const originalParentStatus = makeStatus(
			"jellyfin",
			originalParentMetadata,
			"parent-original",
			parentAt,
			1,
		);
		let parentStatus = originalParentStatus;
		let parentRows = [parentRow];
		const currentStatus = vi.fn(
			async ({ where }: { where: { instanceId_cacheType: { cacheType: string } } }) =>
				where.instanceId_cacheType.cacheType === "jellyfin" ? parentStatus : episodeStatus,
		);
		const parentRowsFindMany = vi.fn().mockImplementation(async () => parentRows);
		const episodeRowsFindMany = vi.fn().mockResolvedValue([episodeRow]);
		const auditCreate = vi.fn();
		const transaction = {
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(provider) },
			cacheRefreshStatus: { findUnique: currentStatus },
			jellyfinCache: { findMany: parentRowsFindMany },
			jellyfinEpisodeCache: { findMany: episodeRowsFindMany },
		};
		let libraryRead = 0;
		const libraryCandidate = {
			id: "sonarr-cache-42",
			instanceId: sonarr.id,
			arrItemId: 42,
			itemType: "series",
			title: "Isolation Fixture",
			year: 2024,
			monitored: true,
			hasFile: true,
			status: "ended",
			qualityProfileId: 1,
			qualityProfileName: "HD",
			sizeOnDisk: 1_000n,
			arrAddedAt: new Date("2025-01-01T00:00:00.000Z"),
			cachedAt: parentAt,
			data: JSON.stringify({ service: "sonarr", remoteIds: { tmdbId: 42 } }),
			torrentState: null,
			infoHash: null,
		};
		Object.assign(deps.prisma, {
			$transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) =>
				callback(transaction),
			),
			serviceInstance: {
				findMany: vi.fn(async ({ where }: { where?: { service?: string | { in: string[] } } }) => {
					if (!where?.service) return [sonarr, provider];
					const services = typeof where.service === "string" ? [where.service] : where.service.in;
					return [sonarr, provider].filter((entry) => services.includes(entry.service));
				}),
			},
			cacheRefreshStatus: { findUnique: currentStatus },
			jellyfinCache: { findMany: parentRowsFindMany },
			jellyfinEpisodeCache: { findMany: episodeRowsFindMany },
			libraryCache: {
				findMany: vi.fn(async () => (libraryRead++ % 2 === 0 ? [libraryCandidate] : [])),
			},
			libraryCleanupApproval: { findMany: vi.fn().mockResolvedValue([]) },
			libraryCleanupLog: {
				findFirst: vi.fn().mockResolvedValue(null),
				create: vi.fn().mockResolvedValue({}),
			},
			libraryCleanupAuditEvent: { create: auditCreate },
			libraryCleanupConfig: {
				...deps.prisma.libraryCleanupConfig,
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
		});
		Object.assign(deps, { skipPendingMediaServerRescanRetry: true });

		const original = await readOwnedJellyfinObservation({
			prisma: deps.prisma as never,
			userId: "user-1",
			instanceId: provider.id,
			cacheType: "jellyfin_episode",
			mode: "mutation",
			now: updatedParentAt,
		});
		expect(original).toMatchObject({
			available: true,
			mutationAvailable: true,
			rows: [episodeRow],
		});
		const baselinePreview = await executeCleanupPreview(deps, "user-1");
		expect(baselinePreview).toMatchObject({
			itemsEvaluated: 1,
			itemsFlagged: 1,
			previewItemCount: 1,
		});

		parentStatus = updatedParentStatus;
		parentRows = [updatedParentRow];
		// The fixture is populated and genuinely reaches the shared reader; the
		// updated parent is the only changed source before cleanup admission.
		const stale = await readOwnedJellyfinObservation({
			prisma: deps.prisma as never,
			userId: "user-1",
			instanceId: provider.id,
			cacheType: "jellyfin_episode",
			mode: "mutation",
			now: updatedParentAt,
		});
		expect(stale).toMatchObject({ available: false, mutationAvailable: false, rows: [] });

		libraryRead = 0;
		const preview = await executeCleanupPreview(deps, "user-1");
		expect(preview).toMatchObject({
			itemsEvaluated: 1,
			itemsFlagged: 0,
			previewItemCount: 0,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
		});
		expect(preview.prefetchHealth?.jellyfin).toBe("failed");
		expect(deps.prisma.libraryCleanupLog.create as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

		libraryRead = 0;
		findConfig.mockResolvedValue({
			id: "config-1",
			userId: "user-1",
			enabled: true,
			dryRunMode: false,
			requireApproval: false,
			maxRemovalsPerRun: 100,
			rules: [episodeRule],
		});
		const execution = await executeCleanupRun(deps, "user-1");
		expect(execution).toMatchObject({
			itemsEvaluated: 1,
			itemsFlagged: 0,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
		});
		expect(deps.prisma.libraryCleanupLog.create as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
		const arrFactory = deps.arrClientFactory as unknown as ReturnType<typeof vi.fn>;
		expect(arrFactory).not.toHaveBeenCalled();
		expect(parentRowsFindMany).toHaveBeenCalled();
		expect(episodeRowsFindMany).toHaveBeenCalled();
		expect(auditCreate).not.toHaveBeenCalled();
	});
});
