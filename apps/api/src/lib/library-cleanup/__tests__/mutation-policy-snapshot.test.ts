import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertCurrentSeriesMutationAuthority,
	createMutationPolicySnapshotGetter,
	executeCleanupPreview,
	MUTATION_POLICY_SNAPSHOT_MAX_AGE_MS,
} from "../cleanup-executor.js";
import type { CleanupExecutorDeps } from "../types.js";

const refreshMocks = vi.hoisted(() => ({
	plex: vi.fn(),
	plexEpisodes: vi.fn(),
	tautulli: vi.fn(),
	jellyfin: vi.fn(),
	jellyfinEpisodes: vi.fn(),
}));

vi.mock("../../plex/plex-cache-refresher.js", () => ({
	refreshPlexCache: refreshMocks.plex,
}));
vi.mock("../../plex/plex-episode-cache-refresher.js", () => ({
	refreshPlexEpisodeCache: refreshMocks.plexEpisodes,
}));
vi.mock("../../tautulli/tautulli-cache-refresher.js", () => ({
	refreshTautulliCache: refreshMocks.tautulli,
}));
vi.mock("../../jellyfin/jellyfin-cache-refresher.js", () => ({
	refreshJellyfinCache: refreshMocks.jellyfin,
}));
vi.mock("../../jellyfin/jellyfin-episode-cache-refresher.js", () => ({
	refreshJellyfinEpisodeCache: refreshMocks.jellyfinEpisodes,
}));

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

function instance(service: "PLEX" | "TAUTULLI" | "JELLYFIN") {
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
		createdAt: new Date("2026-07-31T12:00:00.000Z"),
		updatedAt: new Date("2026-07-31T12:00:00.000Z"),
	};
}

function makeDeps(
	rules: Array<Record<string, unknown>>,
	instances = [] as Array<Record<string, unknown> & { id: string; service: string }>,
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
	const findInstance = vi.fn(async ({ where }: { where: { id: string } }) =>
		instances.find((entry) => entry.id === where.id),
	);
	const cacheRefreshStatus = {
		upsert: cacheStatusUpsert,
		findMany: vi.fn(async ({ where }: { where: { instanceId: { in: string[] } } }) =>
			where.instanceId.in.map((instanceId) => ({
				instanceId,
				lastRefreshedAt: publishedAt,
				lastResult: "success",
				itemCount: 0,
				generationId: `generation-${instanceId}`,
				generationMetadata: JSON.stringify({
					sections: [{ key: "1", title: "Movies", type: "movie" }],
				}),
				lastErrorMessage: null,
				lastAttemptResult: "success",
				lastAttemptErrorMessage: null,
			})),
		),
	};
	const refreshTransaction = {
		$queryRawUnsafe: vi.fn().mockResolvedValue([]),
		serviceInstance: { findUnique: findInstance },
		cacheRefreshStatus,
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
			jellyfinCache: { findMany: vi.fn().mockResolvedValue([]) },
			cacheRefreshStatus,
			plexEpisodeCache: {
				findMany: vi.fn().mockResolvedValue([]),
				groupBy: vi.fn().mockResolvedValue([]),
			},
			jellyfinEpisodeCache: { findMany: vi.fn(), groupBy: vi.fn().mockResolvedValue([]) },
		},
		arrClientFactory: vi.fn(),
		plexCacheClientFactory: vi.fn(() => ({}) as never),
		tautulliCacheClientFactory: vi.fn(() => ({}) as never),
		jellyfinCacheClientFactory: vi.fn(() => ({}) as never),
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as CleanupExecutorDeps;
	return { deps, findConfig, findInstances, cacheStatusUpsert };
}

describe("authoritative mutation policy snapshots", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		refreshMocks.plex.mockImplementation(async (_client, _prisma, instanceId: string) => ({
			upserted: 0,
			errors: 0,
			errorMessages: [],
			complete: true,
			completedAt: new Date(),
			generationId: `generation-${instanceId}`,
			inventoryTargets: [],
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
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		["Plex", "plex_watch_count", "PLEX", refreshMocks.plex, { complete: false }, "plex"],
		["Tautulli", "tautulli_watch_count", "TAUTULLI", refreshMocks.tautulli, {}, "tautulli"],
		[
			"Jellyfin",
			"jellyfin_watch_count",
			"JELLYFIN",
			refreshMocks.jellyfin,
			{ complete: false },
			"jellyfin",
		],
	] as const)(
		"rejects identical %s refresh evidence unless completeness is explicitly true",
		async (_label, ruleType, service, refreshMock, completeness, failedSource) => {
			refreshMock.mockResolvedValue({
				upserted: 1,
				errors: 0,
				errorMessages: [],
				...completeness,
			});
			const { deps } = makeDeps([rule(ruleType)], [instance(service)]);

			const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();

			expect(snapshot.failedSources).toEqual(new Set([failedSource]));
			expect(refreshMock).toHaveBeenCalledOnce();
		},
	);

	it("records an incomplete cleanup-triggered Jellyfin refresh without advancing freshness", async () => {
		refreshMocks.jellyfin.mockResolvedValue({
			upserted: 0,
			errors: 1,
			errorMessages: ["Jellyfin request timed out"],
			complete: false,
		});
		const { deps, cacheStatusUpsert } = makeDeps(
			[rule("jellyfin_watch_count")],
			[instance("JELLYFIN")],
		);

		const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();

		expect(snapshot.failedSources).toEqual(new Set(["jellyfin"]));
		expect(cacheStatusUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.objectContaining({
					lastAttemptResult: "error",
					lastAttemptErrorMessage: "Jellyfin request timed out",
				}),
			}),
		);
		expect(cacheStatusUpsert.mock.calls[0]?.[0].update).not.toHaveProperty("lastRefreshedAt");
	});

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
		expect(refreshMocks.plex).toHaveBeenCalledOnce();
		expect(refreshMocks.plexEpisodes).toHaveBeenCalledOnce();
	});

	it("rejects inventory identities that do not belong to the published Plex generation", async () => {
		refreshMocks.plex.mockResolvedValue({
			upserted: 0,
			errors: 0,
			errorMessages: [],
			complete: true,
			completedAt: new Date(),
			generationId: "different-generation",
			inventoryTargets: [],
		});
		const { deps } = makeDeps([rule("plex_watch_count")], [instance("PLEX")]);

		const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();

		expect(snapshot.failedSources).toEqual(new Set(["plex"]));
	});

	it("excludes disabled Plex episode caches from refreshed authority", async () => {
		const { deps, findInstances } = makeDeps([rule("plex_episode_completion")], [instance("PLEX")]);

		const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();

		expect(deps.log.warn).not.toHaveBeenCalled();
		expect(snapshot.failedSources).toEqual(new Set());
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
			const { deps } = makeDeps(omitSonarrTmdbId ? [matchedRule, plexDependencyRule] : [plexRule], [
				plexA,
				plexB,
			]);
			let refreshCallCount = 0;
			let policyChangedDuringTargetLookup = false;
			const publishedRow = {
				id: "plex-row-b",
				instanceId: plexB.id,
				tmdbId: 84,
				mediaType,
				sectionId: "movies",
				sectionTitle: "Movies",
				ratingKey: plexBTargetsAtSnapshot[0] ?? null,
				lastWatchedAt: null,
				watchCount: 0,
				watchedByUsers: "[]",
				onDeck: false,
				userRating: null,
				collections: "[]",
				labels: "[]",
				addedAt: new Date("2025-01-01T00:00:00.000Z"),
			};
			vi.mocked(deps.prisma.plexCache.findMany).mockImplementation((async () => [
				{
					...publishedRow,
					onDeck: policyChangesAfterSnapshot && policyChangedDuringTargetLookup,
				},
			]) as never);
			vi.mocked(deps.prisma.plexCache.count).mockImplementation((async ({
				where,
			}: {
				where: { instanceId: string };
			}) => (where.instanceId === plexB.id ? 1 : 0)) as never);
			const publishedAt = new Date();
			const generationIds = new Map<string, string>();
			vi.mocked(deps.prisma.cacheRefreshStatus.findMany).mockImplementation((async ({
				where,
			}: {
				where: { instanceId: { in: string[] } };
			}) =>
				where.instanceId.in.map((instanceId) => ({
					instanceId,
					lastRefreshedAt: publishedAt,
					lastResult: "success",
					itemCount: instanceId === plexB.id ? 1 : 0,
					generationId: generationIds.get(instanceId),
					generationMetadata: JSON.stringify({
						sections: [{ key: "movies", title: "Movies", type: "movie" }],
					}),
					lastErrorMessage: null,
					lastAttemptResult: "success",
					lastAttemptErrorMessage: null,
				}))) as never);
			refreshMocks.plex.mockImplementation(async (_client, _prisma, instanceId: string) => {
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
				monitored: true,
				status: "ended",
				qualityProfileId: 1,
				sizeOnDisk: 2_000,
				added: "2025-01-01T00:00:00.000Z",
				statistics:
					service === "RADARR"
						? { movieFileCount: 1, sizeOnDisk: 2_000 }
						: { episodeFileCount: 1, sizeOnDisk: 2_000 },
			};
			deps.arrClientFactory = {
				create: vi.fn(() =>
					service === "RADARR"
						? { movie: { getById: vi.fn().mockResolvedValue(rawItem) } }
						: { series: { getById: vi.fn().mockResolvedValue(rawItem) } },
				),
			} as never;
			const snapshot = await createMutationPolicySnapshotGetter(deps, "user-1")();
			const deleteMovieFile = vi.fn();

			const executeAuthorizedDelete = async () => {
				await assertCurrentSeriesMutationAuthority(
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
				);
				await deleteMovieFile();
			};
			if (expectedToBlock) {
				await expect(executeAuthorizedDelete()).rejects.toThrow(
					/provider evidence could not re-authorize/i,
				);
				expect(deleteMovieFile).not.toHaveBeenCalled();
			} else {
				await expect(executeAuthorizedDelete()).resolves.toBeUndefined();
				expect(deleteMovieFile).toHaveBeenCalledOnce();
			}
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
		"uses live %s authority without publishing provider cache state",
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
			expect(result.prefetchHealth?.[source]).toBe("ok");
			expect(refreshMock).toHaveBeenCalledTimes(2);
			expect(transaction).not.toHaveBeenCalled();
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
			expect(transaction).not.toHaveBeenCalled();
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
			expect(unrelatedResult.prefetchHealth?.[source]).toBe("ok");
			expect(refreshMock).toHaveBeenCalledTimes(2);
			expect(transaction).not.toHaveBeenCalled();
			expect(deleteMany).not.toHaveBeenCalled();
			expect(createMany).not.toHaveBeenCalled();
			expect(statusUpsert).not.toHaveBeenCalled();
		},
	);
});
