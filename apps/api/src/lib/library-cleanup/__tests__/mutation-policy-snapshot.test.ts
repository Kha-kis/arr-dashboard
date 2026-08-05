import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMutationPolicySnapshotGetter,
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
	rules: ReturnType<typeof rule>[],
	instances = [] as ReturnType<typeof instance>[],
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
	const deps = {
		prisma: {
			libraryCleanupConfig: { findUnique: findConfig },
			serviceInstance: { findMany: findInstances },
			plexCache: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
			tautulliCache: { findMany: vi.fn().mockResolvedValue([]) },
			jellyfinCache: { findMany: vi.fn().mockResolvedValue([]) },
			cacheRefreshStatus: {
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
			},
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
	return { deps, findConfig, findInstances };
}

describe("authoritative mutation policy snapshots", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		refreshMocks.plex.mockResolvedValue({
			upserted: 0,
			errors: 0,
			errorMessages: [],
			complete: true,
			completedAt: new Date(),
		});
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
});
