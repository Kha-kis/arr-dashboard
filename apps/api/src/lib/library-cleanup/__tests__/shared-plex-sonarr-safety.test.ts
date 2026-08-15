import { NotFoundError } from "arr-sdk";
import { describe, expect, it, vi } from "vitest";
import { PlexSeriesNotFoundError } from "../../plex/plex-client.js";
import { plexConnectionFingerprint } from "../../plex/service-instance-fingerprint.js";
import {
	executeApprovedItems,
	executeDirectRemoval,
	executeRetryItems,
	INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
} from "../cleanup-executor.js";
import {
	assertVerifiedSonarrPeerOwnershipRetained,
	cleanupDeleteTargetKey,
	createArrServiceFingerprint,
	createSharedPlexSafetyContext,
	findSharedPlexDeleteBlocks,
	serializeExecutableSafetyPlan,
	type VerifiedSonarrTargetDeleteNotification,
} from "../shared-plex-safety.js";
import type { CleanupExecutorDeps } from "../types.js";

const silentLog = {
	warn: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
} as unknown as CleanupExecutorDeps["log"];

const PLEX_SOURCE_FINGERPRINT = plexConnectionFingerprint({
	baseUrl: "http://plex.internal:32400",
	encryptedApiKey: "encrypted",
	encryptionIv: "iv",
});

const sonarrServiceFingerprint = createArrServiceFingerprint({
	id: "sonarr-4k",
	service: "SONARR",
	baseUrl: "http://sonarr.internal:8989",
	encryptedApiKey: "encrypted-sonarr-key",
	encryptionIv: "sonarr-iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
} as never);

function episodeCleanupRule(action: "delete" | "delete_files" | "unmonitor" = "delete") {
	return {
		id: action === "delete" ? "episode-rule" : `episode-rule-${action}`,
		configId: "config-1",
		name: "Remove watched episodes",
		enabled: true,
		priority: 10,
		ruleType: "plex_watch_count",
		parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
		serviceFilter: JSON.stringify(["SONARR"]),
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		targetScope: "episode",
		action,
		operator: null,
		conditions: null,
		retentionMode: false,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

interface SonarrTestOptions {
	action?: "delete" | "delete_files";
	livePlexWatchCount?: number;
	notificationKind?: "plex" | "mediabrowser" | "kodi" | "synology" | "none";
	onSeriesDelete?: boolean;
	onEpisodeFileDelete?: boolean;
	updateLibrary?: boolean;
	cleanLibrary?: boolean;
	mapFrom?: string;
	mapTo?: string;
	seriesTags?: number[];
	notificationTags?: number[];
	episodeFiles?: Array<{
		id?: number;
		path?: string | null;
		relativePath?: string | null;
		size?: number;
	}>;
	episodes?: Array<{
		id: number;
		seasonNumber: number;
		episodeNumber: number;
		episodeFileId: number;
		monitored: boolean;
	}>;
	plexSeries?: Array<{
		ratingKey: string;
		episodes: Array<{
			ratingKey: string;
			seasonNumber?: number;
			episodeNumber?: number;
			parts: Array<{ file: string; size: number }>;
		}>;
	}>;
}

function notificationFields(options: SonarrTestOptions) {
	const fields: Array<{ name: string; value: unknown }> = [
		{ name: "host", value: "plex.internal" },
		{ name: "port", value: 32400 },
		{ name: "useSsl", value: false },
		{ name: "urlBase", value: "" },
		{ name: "updateLibrary", value: options.updateLibrary ?? true },
	];
	if (options.cleanLibrary !== undefined) {
		fields.push({ name: "cleanLibrary", value: options.cleanLibrary });
	}
	if (options.mapFrom !== undefined) fields.push({ name: "mapFrom", value: options.mapFrom });
	if (options.mapTo !== undefined) fields.push({ name: "mapTo", value: options.mapTo });
	return fields;
}

function makeSonarrDeps(options: SonarrTestOptions = {}) {
	const targetInstance = {
		id: "sonarr-4k",
		userId: "user-1",
		service: "SONARR",
		label: "4K Sonarr",
		baseUrl: "http://sonarr.internal:8989",
		encryptedApiKey: "encrypted-sonarr-key",
		encryptionIv: "sonarr-iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		enabled: true,
		updatedAt: new Date("2026-07-27T12:00:00.000Z"),
	};
	const plexInstance = {
		id: "plex-1",
		userId: "user-1",
		service: "PLEX",
		label: "Plex",
		baseUrl: "http://plex.internal:32400",
		enabled: true,
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
		updatedAt: new Date("2026-07-27T12:00:00.000Z"),
	};
	const quiInstance = {
		id: "qui-1",
		userId: "user-1",
		service: "QUI",
		label: "qUI",
		baseUrl: "http://qui.internal",
		enabled: true,
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
		hasLocalFilesystemAccess: true,
		pathPrefix: null,
	};
	const series = {
		id: 201,
		tvdbId: 123,
		tmdbId: 456,
		title: "Example Series",
		path: "/tv-4k/Example Series",
		tags: options.seriesTags ?? [],
		monitored: true,
	};
	const episodeFiles = options.episodeFiles ?? [
		{
			id: 3001,
			path: "/tv-4k/Example Series/Season 01/Example.S01E01.2160p.mkv",
			relativePath: "Season 01/Example.S01E01.2160p.mkv",
			size: 2_001,
		},
		{
			id: 3002,
			path: "/tv-4k/Example Series/Season 01/Example.S01E02.2160p.mkv",
			relativePath: "Season 01/Example.S01E02.2160p.mkv",
			size: 2_002,
		},
	];
	const notificationKind = options.notificationKind ?? "plex";
	const notificationIdentity =
		notificationKind === "mediabrowser"
			? { implementation: "MediaBrowser", configContract: "MediaBrowserSettings" }
			: notificationKind === "kodi"
				? { implementation: "Xbmc", configContract: "XbmcSettings" }
				: notificationKind === "synology"
					? {
							implementation: "SynologyIndexer",
							configContract: "SynologyIndexerSettings",
						}
					: { implementation: "PlexServer", configContract: "PlexServerSettings" };
	const notification = {
		...notificationIdentity,
		onSeriesDelete: options.onSeriesDelete ?? false,
		onEpisodeFileDelete: options.onEpisodeFileDelete ?? true,
		tags: options.notificationTags ?? [],
		fields: notificationFields(options),
	};

	let liveEpisodeFiles = [...episodeFiles];
	const liveEpisodes =
		options.episodes ??
		episodeFiles.map((file, index) => ({
			id: 9_001 + index,
			seasonNumber: 1,
			episodeNumber: index + 1,
			episodeFileId: file.id!,
			monitored: true,
		}));
	const setEpisodeMonitored = vi.fn(async (ids: number[], monitored: boolean) => {
		for (const episode of liveEpisodes) {
			if (ids.includes(episode.id)) episode.monitored = monitored;
		}
	});
	const bulkDelete = vi.fn(async (episodeFileIds: number[]) => {
		const ids = new Set(episodeFileIds);
		liveEpisodeFiles = liveEpisodeFiles.filter(
			(file) => file.id === undefined || !ids.has(file.id),
		);
	});
	let liveSeriesExists = true;
	const deleteSeries = vi.fn(async () => {
		liveSeriesExists = false;
	});
	const targetClient = {
		series: {
			getById: vi.fn(async () => {
				if (!liveSeriesExists) throw new NotFoundError("Series not found");
				return series;
			}),
			delete: deleteSeries,
		},
		episodeFile: {
			getBySeries: vi.fn(async () => liveEpisodeFiles),
			bulkDelete,
		},
		episode: {
			getAll: vi.fn(async () => liveEpisodes),
			setMonitored: setEpisodeMonitored,
		},
		notification: {
			getAll: vi.fn().mockResolvedValue(notificationKind === "none" ? [] : [notification]),
		},
	};
	const defaultPlexSeries = [
		{
			ratingKey: "show-123",
			episodes: episodeFiles.map((file, index) => ({
				ratingKey: `episode-${index + 1}`,
				seasonNumber: 1,
				episodeNumber: index + 1,
				parts: [{ file: file.path!, size: file.size! }],
			})),
		},
	];
	const getSeriesEpisodeMediaPartsByTvdbId = vi
		.fn()
		.mockResolvedValue(options.plexSeries ?? defaultPlexSeries);
	const getEpisodeWatchCount = vi.fn().mockResolvedValue(options.livePlexWatchCount ?? 1);
	const plexClientFactory = vi.fn(() => ({
		getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Owner" }]),
		getMovieMediaPartsByTmdbId: vi.fn(),
		getSeriesEpisodeMediaPartsByTvdbId,
		getEpisodeWatchCount,
	}));
	const approvalUpdate = vi.fn().mockResolvedValue({ count: 1 });
	const episodeFileCacheDeleteMany = vi.fn().mockResolvedValue({ count: episodeFiles.length });
	let cleanupRunLeaseToken: string | null = null;
	const cleanupConfigUpdateMany = vi.fn(
		async ({
			where,
			data,
		}: {
			where: { runClaimToken?: string };
			data: { runClaimToken?: string | null };
		}) => {
			if (data.runClaimToken === null) {
				if (where.runClaimToken !== cleanupRunLeaseToken) return { count: 0 };
				cleanupRunLeaseToken = null;
				return { count: 1 };
			}
			if (where.runClaimToken !== undefined) {
				return { count: where.runClaimToken === cleanupRunLeaseToken ? 1 : 0 };
			}
			if (cleanupRunLeaseToken !== null) return { count: 0 };
			cleanupRunLeaseToken = data.runClaimToken ?? null;
			return { count: 1 };
		},
	);

	const deps: CleanupExecutorDeps = {
		prisma: {
			libraryCleanupConfig: {
				findUnique: vi.fn().mockResolvedValue({
					id: "config-1",
					respectQuiSeeding: false,
					rules: [
						episodeCleanupRule(),
						episodeCleanupRule("delete_files"),
						episodeCleanupRule("unmonitor"),
					],
				}),
				updateMany: cleanupConfigUpdateMany,
			},
			serviceInstance: {
				findMany: vi.fn(({ where }: { where: { service?: string | { in?: string[] } } }) => {
					const services =
						typeof where.service === "string" ? [where.service] : (where.service?.in ?? []);
					if (services.includes("PLEX")) return Promise.resolve([plexInstance]);
					if (services.includes("QUI")) return Promise.resolve([quiInstance]);
					if (services.includes("SEERR")) return Promise.resolve([]);
					if (services.includes("JELLYFIN") || services.includes("EMBY"))
						return Promise.resolve([]);
					return Promise.resolve([targetInstance]);
				}),
				findFirst: vi.fn().mockResolvedValue(targetInstance),
			},
			crossDomainRule: {
				findMany: vi.fn().mockResolvedValue([]),
			},
			libraryCleanupApproval: {
				updateMany: approvalUpdate,
				findMany: vi.fn().mockResolvedValue([]),
				create: vi.fn().mockResolvedValue({}),
				update: vi.fn().mockResolvedValue({}),
			},
			libraryCache: {
				findFirst: vi.fn().mockResolvedValue(null),
				findMany: vi.fn().mockResolvedValue([]),
				deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			episodeFileCache: {
				findMany: vi.fn().mockResolvedValue(
					episodeFiles.map((file) => ({
						arrEpisodeFileId: file.id,
						path: file.path,
						size: BigInt(file.size!),
						infoHash: null,
						torrentState: null,
					})),
				),
				findFirst: vi.fn().mockResolvedValue({
					infoHash: "episode-hash",
					torrentState: "paused",
				}),
				deleteMany: episodeFileCacheDeleteMany,
			},
			plexEpisodeCache: {
				groupBy: vi
					.fn()
					.mockImplementation(({ where }: { where: { watched?: boolean } }) =>
						Promise.resolve(
							where.watched
								? [{ showTmdbId: 456, seasonNumber: 1, _count: { id: 1 } }]
								: [{ showTmdbId: 456, seasonNumber: 1, _count: { id: 2 } }],
						),
					),
				findMany: vi.fn().mockImplementation((({ where }: { where: { episodeNumber: number } }) =>
					Promise.resolve([
						{
							instanceId: plexInstance.id,
							ratingKey: `episode-${where.episodeNumber}`,
							watchCount: 1,
							refreshedAt: new Date(),
							sourceFingerprint: plexConnectionFingerprint(plexInstance),
						},
					])) as never),
				findFirst: vi.fn().mockResolvedValue({
					watchCount: 1,
					refreshedAt: new Date(),
					sourceFingerprint: plexConnectionFingerprint(plexInstance),
				}),
			},
			plexCache: {
				count: vi.fn().mockResolvedValue(1),
				findMany: vi.fn().mockResolvedValue([]),
			},
			cacheRefreshStatus: {
				findMany: vi.fn().mockResolvedValue([
					{
						instanceId: plexInstance.id,
						lastRefreshedAt: new Date(),
						lastResult: "success",
						lastErrorMessage: null,
						lastAttemptResult: "success",
						lastAttemptErrorMessage: null,
						itemCount: 1,
						generationId: "plex-generation-1",
						generationMetadata: JSON.stringify({
							sections: [{ key: "tv", title: "TV", type: "show" }],
						}),
					},
				]),
			},
			tmdbListCache: {
				findMany: vi.fn().mockResolvedValue([]),
			},
			traktListCache: {
				findMany: vi.fn().mockResolvedValue([]),
			},
			libraryCleanupLog: {
				create: vi.fn().mockResolvedValue({}),
			},
		} as unknown as CleanupExecutorDeps["prisma"],
		arrClientFactory: {
			create: vi.fn(() => targetClient),
		} as unknown as CleanupExecutorDeps["arrClientFactory"],
		plexClientFactory,
		quiClientFactory: vi.fn(() => ({
			getTorrentsByHash: vi.fn().mockResolvedValue([{ hash: "episode-hash", state: "pausedUP" }]),
		})),
		quiFileHashIndexFactory: vi.fn().mockResolvedValue({
			resolve: vi.fn().mockResolvedValue({ hashes: ["episode-hash"], complete: true }),
		}),
		externalRuleCacheRefresher: vi.fn().mockResolvedValue(undefined),
		log: silentLog,
	};

	return {
		deps,
		targetInstance,
		plexInstance,
		quiInstance,
		targetClient,
		series,
		notification,
		episodeFiles,
		bulkDelete,
		deleteSeries,
		getSeriesEpisodeMediaPartsByTvdbId,
		getEpisodeWatchCount,
		approvalUpdate,
		episodeFileCacheDeleteMany,
		setEpisodeMonitored,
		setLiveEpisodeMonitored: (episodeId: number, monitored: boolean) => {
			const episode = liveEpisodes.find((candidate) => candidate.id === episodeId);
			if (episode) episode.monitored = monitored;
		},
		addLiveEpisode: (episode: (typeof liveEpisodes)[number]) => {
			liveEpisodes.push(episode);
		},
		setLiveSeriesExists: (exists: boolean) => {
			liveSeriesExists = exists;
		},
	};
}

const target = {
	instanceId: "sonarr-4k",
	arrItemId: 201,
	itemType: "series",
	action: "delete",
};

function exactEpisodeTarget() {
	return {
		...target,
		targetScope: "episode",
		arrEpisodeId: 9_001,
		seasonNumber: 1,
		episodeNumber: 1,
		episodeFileId: 3_001,
		episodeFileConsumerIds: [9_001],
		plexWatchEvidence: [
			{
				plexInstanceId: "plex-1",
				sourceFingerprint: PLEX_SOURCE_FINGERPRINT,
				ratingKey: "episode-1",
				watchCount: 1,
				refreshedAt: new Date(Date.now() - 60 * 60 * 1000),
			},
		],
		respectQuiSeeding: true,
		episodeFileInfoHash: "episode-hash",
		episodeFileTorrentState: "paused",
	};
}

function addSonarrPeer(
	fixture: ReturnType<typeof makeSonarrDeps>,
	options: {
		episodeFiles?: Array<{ id: number; path: string; relativePath?: string; size: number }>;
		seriesPath?: string;
		tvdbId?: number | null;
		notification?: Record<string, unknown>;
	} = {},
) {
	const seriesPath = options.seriesPath ?? "/tv-hd/Example Series";
	const episodeFiles = options.episodeFiles ?? [
		{
			id: 4003,
			path: `${seriesPath}/Season 01/Example.S01E03.1080p.mkv`,
			relativePath: "Season 01/Example.S01E03.1080p.mkv",
			size: 1_003,
		},
	];
	const peerInstance = {
		...fixture.targetInstance,
		id: "sonarr-hd",
		label: "HD Sonarr",
		baseUrl: "http://sonarr-hd.internal:8989",
		encryptedApiKey: "encrypted-sonarr-hd-key",
		encryptionIv: "sonarr-hd-iv",
	};
	const peerSeries = {
		...fixture.series,
		id: 202,
		path: seriesPath,
		...(options.tvdbId === null ? { tvdbId: undefined } : { tvdbId: options.tvdbId ?? 123 }),
	};
	const peerNotification = options.notification ?? fixture.notification;
	const peerClient = {
		series: {
			getAll: vi.fn().mockResolvedValue([peerSeries]),
			getById: vi.fn().mockResolvedValue(peerSeries),
		},
		episodeFile: {
			getBySeries: vi.fn().mockResolvedValue(episodeFiles),
		},
		notification: {
			getAll: vi.fn().mockResolvedValue([peerNotification]),
		},
	};
	vi.mocked(fixture.deps.prisma.serviceInstance.findMany).mockImplementation(
		(args) =>
			(args?.where?.service === "PLEX"
				? Promise.resolve([fixture.plexInstance])
				: args?.where?.service === "QUI"
					? Promise.resolve([fixture.quiInstance])
					: Promise.resolve([fixture.targetInstance, peerInstance])) as never,
	);
	vi.mocked(fixture.deps.arrClientFactory.create).mockImplementation(
		(instance) => (instance.id === peerInstance.id ? peerClient : fixture.targetClient) as never,
	);
	return { peerInstance, peerSeries, peerClient, episodeFiles };
}

describe("shared Plex deletion safety for Sonarr", () => {
	it("snapshots one exact Sonarr episode while retaining sibling files", async () => {
		const { deps } = makeSonarrDeps();
		const context = createSharedPlexSafetyContext();
		const episodeTarget = exactEpisodeTarget();

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [episodeTarget], context)).toEqual(
			new Map(),
		);
		expect(context.plans.get(cleanupDeleteTargetKey(episodeTarget))).toMatchObject({
			kind: "verified_sonarr_episode",
			episode: {
				arrEpisodeId: 9_001,
				episodeFileId: 3_001,
				episodeFileConsumerIds: [9_001],
			},
			selectedFile: { episodeFileId: 3_001 },
			retainedTargetFiles: [{ episodeFileId: 3_002 }],
		});
	});

	it("blocks when the selected file gains another episode consumer during Plex verification", async () => {
		const fixture = makeSonarrDeps();
		const plexSeries = await fixture.getSeriesEpisodeMediaPartsByTvdbId(123);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockImplementation(async () => {
			fixture.addLiveEpisode({
				id: 9_003,
				seasonNumber: 1,
				episodeNumber: 3,
				episodeFileId: 3_001,
				monitored: true,
			});
			return plexSeries;
		});
		const episodeTarget = exactEpisodeTarget();

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget]);

		expect(blocks.get(cleanupDeleteTargetKey(episodeTarget))).toContain(
			"could not verify the live Sonarr series",
		);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("blocks when qUI becomes active during Plex verification", async () => {
		const fixture = makeSonarrDeps();
		const plexSeries = await fixture.getSeriesEpisodeMediaPartsByTvdbId(123);
		let torrentState = "pausedUP";
		vi.mocked(fixture.deps.quiClientFactory!).mockImplementation(
			() =>
				({
					getTorrentsByHash: vi.fn(async () => [{ hash: "episode-hash", state: torrentState }]),
				}) as never,
		);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockImplementation(async () => {
			torrentState = "stalledUP";
			return plexSeries;
		});
		const episodeTarget = exactEpisodeTarget();

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget]);

		expect(blocks.get(cleanupDeleteTargetKey(episodeTarget))).toContain(
			"exact Sonarr episode files",
		);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("blocks an episode when its source-bound live Plex count no longer proves the candidate", async () => {
		const fixture = makeSonarrDeps({ livePlexWatchCount: 0 });
		const episodeTarget = exactEpisodeTarget();

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget]);

		expect(blocks.get(cleanupDeleteTargetKey(episodeTarget))).toContain(
			"watched Plex episode could not be mapped",
		);
		expect(fixture.getEpisodeWatchCount).toHaveBeenCalledWith("episode-1");
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("blocks episode evidence whose Plex rating key resolves to another physical copy", async () => {
		const fixture = makeSonarrDeps({
			plexSeries: [
				{
					ratingKey: "show-123",
					episodes: [
						{
							ratingKey: "episode-1",
							parts: [{ file: "/other-copy/Example.S01E01.mkv", size: 2_001 }],
						},
					],
				},
			],
		});
		const episodeTarget = exactEpisodeTarget();

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget]);

		expect(blocks.get(cleanupDeleteTargetKey(episodeTarget))).toContain(
			"watched Plex episode could not be mapped",
		);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it.each(["incomplete", "active", "missing"] as const)(
		"fails closed when exact episode qUI authority is %s",
		async (mode) => {
			const fixture = makeSonarrDeps();
			if (mode === "incomplete") {
				vi.mocked(fixture.deps.quiFileHashIndexFactory!).mockResolvedValue({
					resolve: vi.fn().mockResolvedValue({ hashes: ["episode-hash"], complete: false }),
				} as never);
			} else if (mode === "active") {
				vi.mocked(fixture.deps.quiClientFactory!).mockReturnValue({
					getTorrentsByHash: vi
						.fn()
						.mockResolvedValue([{ hash: "episode-hash", state: "stalledUP" }]),
				} as never);
			} else {
				fixture.deps.quiFileHashIndexFactory = undefined;
			}
			const episodeTarget = exactEpisodeTarget();

			const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget]);

			expect(blocks.get(cleanupDeleteTargetKey(episodeTarget))).toContain(
				"exact Sonarr episode files",
			);
			expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
			expect(fixture.bulkDelete).not.toHaveBeenCalled();
		},
	);

	it("rejects a multi-episode physical file before exact episode mutation", async () => {
		const fixture = makeSonarrDeps({
			episodes: [
				{
					id: 9_001,
					seasonNumber: 1,
					episodeNumber: 1,
					episodeFileId: 3_001,
					monitored: true,
				},
				{
					id: 9_002,
					seasonNumber: 1,
					episodeNumber: 2,
					episodeFileId: 3_001,
					monitored: true,
				},
			],
		});
		const episodeTarget = {
			...exactEpisodeTarget(),
			episodeFileConsumerIds: [9_001, 9_002],
		};

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget]);

		expect(blocks.get(cleanupDeleteTargetKey(episodeTarget))).toContain(
			"exact Sonarr episode files",
		);
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("rejects an episode when a new Sonarr peer makes ownership incomplete", async () => {
		const fixture = makeSonarrDeps();
		addSonarrPeer(fixture);
		const episodeTarget = exactEpisodeTarget();

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget]);

		expect(blocks.get(cleanupDeleteTargetKey(episodeTarget))).toBeTruthy();
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("blocks at scale when another Sonarr may mount the same storage under a different path", async () => {
		const targetEpisodeFiles = Array.from({ length: 1_000 }, (_, index) => ({
			id: 3_001 + index,
			path: `/tv-4k/Example Series/Season 01/Example.S01E${String(index + 1).padStart(4, "0")}.2160p.mkv`,
			relativePath: `Season 01/Example.S01E${String(index + 1).padStart(4, "0")}.2160p.mkv`,
			size: 2_001 + index,
		}));
		const { deps, targetInstance, targetClient } = makeSonarrDeps({
			notificationKind: "none",
			episodeFiles: targetEpisodeFiles,
		});
		const otherInstance = {
			...targetInstance,
			id: "sonarr-hd",
			label: "HD Sonarr",
			baseUrl: "http://sonarr-hd.internal:8989",
		};
		vi.mocked(deps.prisma.serviceInstance.findMany).mockImplementation(
			(args) =>
				(args?.where?.service === "PLEX"
					? Promise.resolve([])
					: Promise.resolve([targetInstance, otherInstance])) as never,
		);

		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"another configured Sonarr instance may access the same storage under a different path",
		);
		expect(deps.prisma.serviceInstance.findMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				service: { in: ["RADARR", "SONARR"] },
			},
		});
		expect(targetClient.notification.getAll).toHaveBeenCalledOnce();
	});

	it("verifies the complete exact episode-file set for a single-source Plex show", async () => {
		const { deps, getSeriesEpisodeMediaPartsByTvdbId } = makeSonarrDeps();
		const context = createSharedPlexSafetyContext();

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [target], context)).toEqual(new Map());
		expect(getSeriesEpisodeMediaPartsByTvdbId).toHaveBeenCalledWith(123);
		expect(context.plans.get(cleanupDeleteTargetKey(target))).toMatchObject({
			kind: "verified_sonarr",
			files: { episodeFiles: [{ episodeFileId: 3001 }, { episodeFileId: 3002 }] },
			ownership: [
				expect.objectContaining({
					retained: [],
					target: expect.arrayContaining([
						expect.objectContaining({ ratingKey: "show-123", size: 2_001 }),
					]),
				}),
			],
		});
	});

	it("allows a shared Plex show when every retained part has an exact peer Sonarr file", async () => {
		const fixture = makeSonarrDeps();
		const { episodeFiles: peerFiles } = addSonarrPeer(fixture);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
			{
				ratingKey: "show-123",
				episodes: [...fixture.episodeFiles, ...peerFiles].map((file, index) => ({
					ratingKey: `episode-${index + 1}`,
					parts: [{ file: file.path!, size: file.size! }],
				})),
			},
		]);
		const context = createSharedPlexSafetyContext();

		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		expect(context.plans.get(cleanupDeleteTargetKey(target))).toMatchObject({
			kind: "verified_sonarr",
			peers: [
				{
					instanceId: "sonarr-hd",
					arrItemId: 202,
					files: { episodeFiles: [{ episodeFileId: 4003 }] },
				},
			],
			ownership: [
				{
					target: expect.arrayContaining([
						expect.objectContaining({ ratingKey: "show-123", size: 2_001 }),
						expect.objectContaining({ ratingKey: "show-123", size: 2_002 }),
					]),
					retained: [
						expect.objectContaining({
							instanceId: "sonarr-hd",
							ratingKey: "show-123",
							size: 1_003,
						}),
					],
				},
			],
		});
	});

	it("allows separate Plex show items when each one maps completely to a Sonarr instance", async () => {
		const fixture = makeSonarrDeps();
		const { episodeFiles: peerFiles } = addSonarrPeer(fixture);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
			{
				ratingKey: "show-4k",
				episodes: fixture.episodeFiles.map((file, index) => ({
					ratingKey: `target-${index + 1}`,
					parts: [{ file: file.path!, size: file.size! }],
				})),
			},
			{
				ratingKey: "show-hd",
				episodes: peerFiles.map((file, index) => ({
					ratingKey: `peer-${index + 1}`,
					parts: [{ file: file.path, size: file.size }],
				})),
			},
		]);

		await expect(findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target])).resolves.toEqual(
			new Map(),
		);
	});

	it("snapshots a configured Sonarr peer that does not contain the TVDB series", async () => {
		const fixture = makeSonarrDeps();
		const peer = addSonarrPeer(fixture);
		peer.peerClient.series.getAll.mockResolvedValue([]);
		const context = createSharedPlexSafetyContext();

		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		expect(context.plans.get(cleanupDeleteTargetKey(target))).toMatchObject({
			kind: "verified_sonarr",
			peers: [
				{
					instanceId: "sonarr-hd",
					arrItemId: null,
					mediaPath: null,
					files: null,
				},
			],
		});
		expect(peer.peerClient.episodeFile.getBySeries).not.toHaveBeenCalled();
		expect(peer.peerClient.series.getAll).toHaveBeenCalledTimes(3);
	});

	it("applies the retained Sonarr peer's own Plex path mapping", async () => {
		const fixture = makeSonarrDeps();
		const peer = addSonarrPeer(fixture, {
			notification: {
				...fixture.notification,
				fields: notificationFields({
					mapFrom: "/tv-hd",
					mapTo: "/media/tv-hd",
				}),
			},
		});
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
			{
				ratingKey: "show-123",
				episodes: [
					...fixture.episodeFiles.map((file, index) => ({
						ratingKey: `target-${index + 1}`,
						parts: [{ file: file.path!, size: file.size! }],
					})),
					{
						ratingKey: "peer-1",
						parts: [
							{
								file: peer.episodeFiles[0]!.path.replace("/tv-hd", "/media/tv-hd"),
								size: peer.episodeFiles[0]!.size,
							},
						],
					},
				],
			},
		]);
		const context = createSharedPlexSafetyContext();

		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		expect(context.plans.get(cleanupDeleteTargetKey(target))).toMatchObject({
			kind: "verified_sonarr",
			ownership: [
				{
					retained: [
						expect.objectContaining({
							mapping: {
								from: expect.objectContaining({ value: "/tv-hd" }),
								to: expect.objectContaining({ value: "/media/tv-hd" }),
							},
						}),
					],
				},
			],
		});
	});

	it("blocks a shared Plex show when any retained part lacks a peer Sonarr file", async () => {
		const fixture = makeSonarrDeps();
		const { episodeFiles: peerFiles } = addSonarrPeer(fixture);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
			{
				ratingKey: "show-123",
				episodes: [
					...fixture.episodeFiles.map((file, index) => ({
						ratingKey: `target-${index + 1}`,
						parts: [{ file: file.path!, size: file.size! }],
					})),
					{
						ratingKey: "peer-1",
						parts: [{ file: peerFiles[0]!.path, size: peerFiles[0]!.size }],
					},
					{
						ratingKey: "unowned-1",
						parts: [{ file: "/tv-other/Example.S01E04.mkv", size: 1_004 }],
					},
				],
			},
		]);

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain("Plex has multiple files merged");
	});

	it("blocks when target and peer Sonarr instances claim the same Plex part", async () => {
		const fixture = makeSonarrDeps();
		addSonarrPeer(fixture, {
			episodeFiles: [
				{
					id: 4001,
					path: fixture.episodeFiles[0]!.path!,
					relativePath: fixture.episodeFiles[0]!.relativePath!,
					size: fixture.episodeFiles[0]!.size!,
				},
			],
		});

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"another configured Sonarr instance may access the same storage",
		);
	});

	it.each([
		["a different TVDB ID", 999],
		["no TVDB ID", null],
	])("blocks a peer that tracks the target file under %s", async (_label, tvdbId) => {
		const fixture = makeSonarrDeps();
		addSonarrPeer(fixture, {
			tvdbId,
			seriesPath: fixture.series.path,
			episodeFiles: [
				{
					id: 4001,
					path: fixture.episodeFiles[0]!.path!,
					relativePath: fixture.episodeFiles[0]!.relativePath!,
					size: fixture.episodeFiles[0]!.size!,
				},
			],
		});

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"another configured Sonarr instance may access the same storage",
		);
	});

	it("allows an alternate-TVDB peer whose physical series path is unrelated", async () => {
		const fixture = makeSonarrDeps();
		addSonarrPeer(fixture, { tvdbId: 999 });

		await expect(findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target])).resolves.toEqual(
			new Map(),
		);
	});

	it("bounds concurrent episode-file reads while checking every untracked peer series", async () => {
		const fixture = makeSonarrDeps();
		const peer = addSonarrPeer(fixture, { tvdbId: 998 });
		const allSeries = Array.from({ length: 12 }, (_, index) => ({
			...peer.peerSeries,
			id: 202 + index,
			tvdbId: 998 + index,
			path: `/tv-alt/Series ${index + 1}`,
		}));
		peer.peerClient.series.getAll.mockResolvedValue(allSeries);
		let activeReads = 0;
		let maximumActiveReads = 0;
		peer.peerClient.episodeFile.getBySeries.mockImplementation(async (seriesId) => {
			activeReads += 1;
			maximumActiveReads = Math.max(maximumActiveReads, activeReads);
			await new Promise((resolve) => setTimeout(resolve, 1));
			activeReads -= 1;
			return [
				{
					id: 4_000 + seriesId,
					seriesId,
					path: `/tv-alt/Series ${seriesId - 201}/Season 01/Episode.mkv`,
					relativePath: "Season 01/Episode.mkv",
					size: 1_000 + seriesId,
				},
			];
		});

		await expect(findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target])).resolves.toEqual(
			new Map(),
		);
		expect(peer.peerClient.episodeFile.getBySeries).toHaveBeenCalledTimes(allSeries.length * 2);
		expect(maximumActiveReads).toBeGreaterThan(1);
		expect(maximumActiveReads).toBeLessThanOrEqual(8);
	});

	it("reuses one stable peer inventory across a batch of target series", async () => {
		const fixture = makeSonarrDeps();
		const peer = addSonarrPeer(fixture, { tvdbId: 998 });
		const secondTarget = { ...target, arrItemId: 202 };

		await expect(
			findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target, secondTarget]),
		).resolves.toEqual(new Map());

		expect(peer.peerClient.episodeFile.getBySeries).toHaveBeenCalledTimes(2);
		expect(peer.peerClient.series.getAll).toHaveBeenCalledTimes(3);
	});

	it("blocks an alternate-TVDB peer through its own Plex path mapping", async () => {
		const fixture = makeSonarrDeps();
		addSonarrPeer(fixture, {
			tvdbId: 999,
			seriesPath: "/tv-alt/Example Series",
			episodeFiles: [
				{
					id: 4001,
					path: "/tv-alt/Example Series/Season 01/Example.S01E01.2160p.mkv",
					relativePath: "Season 01/Example.S01E01.2160p.mkv",
					size: fixture.episodeFiles[0]!.size!,
				},
			],
			notification: {
				...fixture.notification,
				fields: notificationFields({
					mapFrom: "/tv-alt",
					mapTo: "/tv-4k",
				}),
			},
		});

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"another configured Sonarr instance may access the same storage",
		);
	});

	it("fails closed when an alternate-TVDB peer has files but no target-Plex correlation", async () => {
		const fixture = makeSonarrDeps();
		addSonarrPeer(fixture, {
			tvdbId: 999,
			notification: {
				...fixture.notification,
				fields: [
					{ name: "host", value: "different-plex.internal" },
					{ name: "port", value: 32400 },
					{ name: "useSsl", value: false },
					{ name: "urlBase", value: "" },
					{ name: "updateLibrary", value: true },
				],
			},
		});

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"another configured Sonarr instance may access the same storage",
		);
	});

	it("blocks an alternate-TVDB peer that claims the target path with a stale size", async () => {
		const fixture = makeSonarrDeps();
		addSonarrPeer(fixture, {
			tvdbId: 999,
			seriesPath: fixture.series.path,
			episodeFiles: [
				{
					id: 4001,
					path: fixture.episodeFiles[0]!.path!,
					relativePath: fixture.episodeFiles[0]!.relativePath!,
					size: fixture.episodeFiles[0]!.size! + 1,
				},
			],
		});

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"another configured Sonarr instance may access the same storage",
		);
	});

	it("checks alternate-TVDB episode files even when the current series root is unrelated", async () => {
		const fixture = makeSonarrDeps();
		addSonarrPeer(fixture, {
			tvdbId: 999,
			seriesPath: "/tv-new/Example Series",
			episodeFiles: [
				{
					id: 4001,
					path: fixture.episodeFiles[0]!.path!,
					relativePath: fixture.episodeFiles[0]!.relativePath!,
					size: fixture.episodeFiles[0]!.size!,
				},
			],
		});

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"another configured Sonarr instance may access the same storage",
		);
	});

	it("refetches the peer catalog after Plex verification", async () => {
		const fixture = makeSonarrDeps();
		const peer = addSonarrPeer(fixture);
		peer.peerClient.series.getAll
			.mockResolvedValueOnce([])
			.mockResolvedValue([{ ...peer.peerSeries, tvdbId: 999, path: fixture.series.path }]);
		peer.peerClient.episodeFile.getBySeries.mockResolvedValue([
			{
				id: 4001,
				seriesId: peer.peerSeries.id,
				path: fixture.episodeFiles[0]!.path!,
				relativePath: fixture.episodeFiles[0]!.relativePath!,
				size: fixture.episodeFiles[0]!.size!,
			},
		]);

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(fixture.getSeriesEpisodeMediaPartsByTvdbId).toHaveBeenCalledWith(123);
		expect(peer.peerClient.series.getAll).toHaveBeenCalledTimes(3);
		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"another configured Sonarr instance may access the same storage",
		);
	});

	it("revalidates a tracked peer's path mapping after Plex verification", async () => {
		const fixture = makeSonarrDeps();
		const peer = addSonarrPeer(fixture, {
			episodeFiles: [
				{
					id: 4001,
					path: fixture.episodeFiles[0]!.path!.replace("/tv-4k", "/tv-hd"),
					relativePath: fixture.episodeFiles[0]!.relativePath!,
					size: 1_001,
				},
			],
		});
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
			{
				ratingKey: "show-123",
				episodes: [...fixture.episodeFiles, ...peer.episodeFiles].map((file, index) => ({
					ratingKey: `episode-${index + 1}`,
					parts: [{ file: file.path!, size: file.size! }],
				})),
			},
		]);
		peer.peerClient.notification.getAll
			.mockResolvedValueOnce([fixture.notification])
			.mockResolvedValue([
				{
					...fixture.notification,
					fields: notificationFields({
						mapFrom: "/tv-hd",
						mapTo: "/tv-4k",
					}),
				},
			]);

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"another configured Sonarr instance may access the same storage",
		);
	});

	it("revalidates the target delete notification after Plex verification", async () => {
		const fixture = makeSonarrDeps();
		fixture.targetClient.notification.getAll
			.mockResolvedValueOnce([fixture.notification])
			.mockResolvedValue([
				{
					...fixture.notification,
					onEpisodeFileDelete: false,
				},
			]);

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(fixture.getSeriesEpisodeMediaPartsByTvdbId).toHaveBeenCalledWith(123);
		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"could not verify the live Sonarr series and Plex media state",
		);
	});

	it("revalidates the target delete notification after the terminal peer scan", async () => {
		const fixture = makeSonarrDeps();
		const peer = addSonarrPeer(fixture);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
			{
				ratingKey: "show-123",
				episodes: [...fixture.episodeFiles, ...peer.episodeFiles].map((file, index) => ({
					ratingKey: `episode-${index + 1}`,
					parts: [{ file: file.path!, size: file.size! }],
				})),
			},
		]);
		peer.peerClient.series.getAll
			.mockResolvedValueOnce([peer.peerSeries])
			.mockImplementation(async () => {
				fixture.targetClient.notification.getAll.mockResolvedValue([
					{
						...fixture.notification,
						onEpisodeFileDelete: false,
					},
				]);
				return [peer.peerSeries];
			});

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(peer.peerClient.series.getAll).toHaveBeenCalledTimes(3);
		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"could not verify the live Sonarr series and Plex media state",
		);
	});

	it("revalidates retained peer files after the target episode files are gone", async () => {
		const fixture = makeSonarrDeps();
		const { episodeFiles: peerFiles } = addSonarrPeer(fixture);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
			{
				ratingKey: "show-123",
				episodes: [...fixture.episodeFiles, ...peerFiles].map((file, index) => ({
					ratingKey: `episode-${index + 1}`,
					parts: [{ file: file.path!, size: file.size! }],
				})),
			},
		]);
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_sonarr") throw new Error("Expected verified Sonarr plan");
		await fixture.targetClient.episodeFile.bulkDelete([3001, 3002]);

		await expect(
			assertVerifiedSonarrPeerOwnershipRetained(fixture.deps, "user-1", target.arrItemId, plan),
		).resolves.toBeUndefined();
	});

	it("accepts a vanished Plex show after deletion when no peer parts were retained", async () => {
		const fixture = makeSonarrDeps();
		const peer = addSonarrPeer(fixture);
		peer.peerClient.series.getAll.mockResolvedValue([]);
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_sonarr") throw new Error("Expected verified Sonarr plan");
		expect(plan.ownership).toEqual([expect.objectContaining({ retained: [] })]);
		await fixture.targetClient.episodeFile.bulkDelete([3001, 3002]);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockRejectedValue(new PlexSeriesNotFoundError(123));

		await expect(
			assertVerifiedSonarrPeerOwnershipRetained(fixture.deps, "user-1", target.arrItemId, plan),
		).resolves.toBeUndefined();
	});

	it("accepts a legacy series-only notification snapshot after target files are gone", async () => {
		const fixture = makeSonarrDeps();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_sonarr") throw new Error("Expected verified Sonarr plan");
		expect(plan.targetDeleteNotifications).toEqual([
			expect.objectContaining({
				onSeriesDelete: false,
				onEpisodeFileDelete: true,
			}),
		]);
		await fixture.targetClient.episodeFile.bulkDelete([3001, 3002]);

		await expect(
			assertVerifiedSonarrPeerOwnershipRetained(fixture.deps, "user-1", target.arrItemId, {
				...plan,
				targetDeleteNotifications: [],
			}),
		).resolves.toBeUndefined();
	});

	it("blocks a new alternate-TVDB peer claim after target files are gone", async () => {
		const fixture = makeSonarrDeps();
		const peer = addSonarrPeer(fixture);
		peer.peerClient.series.getAll.mockResolvedValue([]);
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_sonarr") throw new Error("Expected verified Sonarr plan");
		await fixture.targetClient.episodeFile.bulkDelete([3001, 3002]);
		peer.peerClient.series.getAll.mockResolvedValue([
			{ ...peer.peerSeries, tvdbId: 999, path: fixture.series.path },
		]);
		peer.peerClient.episodeFile.getBySeries.mockResolvedValue([
			{
				id: 4001,
				seriesId: peer.peerSeries.id,
				path: fixture.episodeFiles[0]!.path!,
				relativePath: fixture.episodeFiles[0]!.relativePath!,
				size: fixture.episodeFiles[0]!.size!,
			},
		]);

		await expect(
			assertVerifiedSonarrPeerOwnershipRetained(fixture.deps, "user-1", target.arrItemId, plan),
		).rejects.toThrow("another configured Sonarr instance");
	});

	it("rejects a vanished Plex show when peer parts were retained", async () => {
		const fixture = makeSonarrDeps();
		const peer = addSonarrPeer(fixture);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
			{
				ratingKey: "show-123",
				episodes: [...fixture.episodeFiles, ...peer.episodeFiles].map((file, index) => ({
					ratingKey: `episode-${index + 1}`,
					parts: [{ file: file.path!, size: file.size! }],
				})),
			},
		]);
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_sonarr") throw new Error("Expected verified Sonarr plan");
		await fixture.targetClient.episodeFile.bulkDelete([3001, 3002]);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockRejectedValue(new PlexSeriesNotFoundError(123));

		await expect(
			assertVerifiedSonarrPeerOwnershipRetained(fixture.deps, "user-1", target.arrItemId, plan),
		).rejects.toThrow("no series item for TVDB 123");
	});

	it("blocks record deletion when a retained peer episode file changes", async () => {
		const fixture = makeSonarrDeps();
		const peer = addSonarrPeer(fixture);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
			{
				ratingKey: "show-123",
				episodes: [...fixture.episodeFiles, ...peer.episodeFiles].map((file, index) => ({
					ratingKey: `episode-${index + 1}`,
					parts: [{ file: file.path!, size: file.size! }],
				})),
			},
		]);
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_sonarr") throw new Error("Expected verified Sonarr plan");
		await fixture.targetClient.episodeFile.bulkDelete([3001, 3002]);
		peer.peerClient.episodeFile.getBySeries.mockResolvedValue([
			{
				...peer.episodeFiles[0]!,
				size: peer.episodeFiles[0]!.size + 1,
			},
		]);

		await expect(
			assertVerifiedSonarrPeerOwnershipRetained(fixture.deps, "user-1", target.arrItemId, plan),
		).rejects.toThrow("another configured Sonarr instance");
	});

	it("blocks record deletion when Plex gains an unowned part after file deletion", async () => {
		const fixture = makeSonarrDeps();
		const peer = addSonarrPeer(fixture);
		const initialPlexSeries = [
			{
				ratingKey: "show-123",
				episodes: [...fixture.episodeFiles, ...peer.episodeFiles].map((file, index) => ({
					ratingKey: `episode-${index + 1}`,
					parts: [{ file: file.path!, size: file.size! }],
				})),
			},
		];
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue(initialPlexSeries);
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_sonarr") throw new Error("Expected verified Sonarr plan");
		await fixture.targetClient.episodeFile.bulkDelete([3001, 3002]);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
			{
				...initialPlexSeries[0]!,
				episodes: [
					...initialPlexSeries[0]!.episodes,
					{
						ratingKey: "episode-new",
						parts: [{ file: "/tv-other/Example.S01E04.mkv", size: 1_004 }],
					},
				],
			},
		]);

		await expect(
			assertVerifiedSonarrPeerOwnershipRetained(fixture.deps, "user-1", target.arrItemId, plan),
		).rejects.toThrow("another configured Sonarr instance");
	});

	it("caches initial Sonarr notifications and revalidates each target after Plex", async () => {
		const { deps, targetClient } = makeSonarrDeps();
		const context = createSharedPlexSafetyContext();

		await findSharedPlexDeleteBlocks(
			deps,
			"user-1",
			[target, { ...target, arrItemId: 202 }],
			context,
		);

		expect(targetClient.notification.getAll).toHaveBeenCalledTimes(3);
		expect(targetClient.series.getById).toHaveBeenCalledTimes(4);
	});

	it("refetches Sonarr notifications across separate safety checks", async () => {
		const { deps, targetClient } = makeSonarrDeps();
		const context = createSharedPlexSafetyContext();
		targetClient.notification.getAll.mockResolvedValueOnce([]).mockResolvedValue([
			{
				implementation: "MediaBrowser",
				configContract: "MediaBrowserSettings",
				onSeriesDelete: true,
				onEpisodeFileDelete: true,
				tags: [],
				fields: [{ name: "updateLibrary", value: true }],
			},
		]);

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [target], context)).toEqual(new Map());
		const changedBlocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target], context);

		expect(changedBlocks.get(cleanupDeleteTargetKey(target))).toContain("Emby/Jellyfin");
		expect(targetClient.notification.getAll).toHaveBeenCalledTimes(2);
	});

	it("blocks a Plex show that also contains files from another ARR root", async () => {
		const { deps } = makeSonarrDeps({
			plexSeries: [
				{
					ratingKey: "show-123",
					episodes: [
						{
							ratingKey: "episode-1",
							parts: [
								{
									file: "/tv-4k/Example Series/Season 01/Example.S01E01.2160p.mkv",
									size: 2_001,
								},
								{
									file: "/tv-hd/Example Series/Season 01/Example.S01E01.1080p.mkv",
									size: 1_001,
								},
							],
						},
						{
							ratingKey: "episode-2",
							parts: [
								{
									file: "/tv-4k/Example Series/Season 01/Example.S01E02.2160p.mkv",
									size: 2_002,
								},
							],
						},
					],
				},
			],
		});

		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);
		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain("Plex has multiple files merged");
	});

	it("blocks disjoint episodes from another root merged into the same Plex show", async () => {
		const { deps } = makeSonarrDeps({
			episodeFiles: [
				{
					id: 3001,
					path: "/tv-4k/Example Series/Season 01/Example.S01E01.2160p.mkv",
					size: 2_001,
				},
			],
			plexSeries: [
				{
					ratingKey: "show-123",
					episodes: [
						{
							ratingKey: "episode-1",
							parts: [
								{
									file: "/tv-4k/Example Series/Season 01/Example.S01E01.2160p.mkv",
									size: 2_001,
								},
							],
						},
						{
							ratingKey: "episode-2",
							parts: [
								{
									file: "/tv-hd/Example Series/Season 02/Example.S02E01.1080p.mkv",
									size: 1_001,
								},
							],
						},
					],
				},
			],
		});

		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);
		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain("Plex has multiple files merged");
	});

	it("deduplicates one multi-episode physical file referenced by multiple Plex episodes", async () => {
		const sharedPart = {
			file: "/tv-4k/Example Series/Season 01/Example.S01E01-E02.2160p.mkv",
			size: 4_000,
		};
		const { deps } = makeSonarrDeps({
			episodeFiles: [{ id: 3001, path: sharedPart.file, size: sharedPart.size }],
			plexSeries: [
				{
					ratingKey: "show-123",
					episodes: [
						{ ratingKey: "episode-1", parts: [sharedPart] },
						{ ratingKey: "episode-2", parts: [{ ...sharedPart }] },
					],
				},
			],
		});

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [target])).toEqual(new Map());
	});

	it("applies Sonarr's explicit Plex path mapping to every episode file", async () => {
		const { deps } = makeSonarrDeps({
			mapFrom: "/tv-4k",
			mapTo: "/plex/tv-4k",
			plexSeries: [
				{
					ratingKey: "show-123",
					episodes: [
						{
							ratingKey: "episode-1",
							parts: [
								{
									file: "/plex/tv-4k/Example Series/Season 01/Example.S01E01.2160p.mkv",
									size: 2_001,
								},
							],
						},
						{
							ratingKey: "episode-2",
							parts: [
								{
									file: "/plex/tv-4k/Example Series/Season 01/Example.S01E02.2160p.mkv",
									size: 2_002,
								},
							],
						},
					],
				},
			],
		});

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [target])).toEqual(new Map());
	});

	it("fails closed when any exact Sonarr path or size cannot be matched", async () => {
		const { deps } = makeSonarrDeps({
			plexSeries: [
				{
					ratingKey: "show-123",
					episodes: [
						{
							ratingKey: "episode-1",
							parts: [
								{
									file: "/tv-4k/Example Series/Season 01/Example.S01E01.2160p.mkv",
									size: 2_999,
								},
							],
						},
					],
				},
			],
		});

		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);
		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"could not match the exact Sonarr episode files",
		);
	});

	it("does not inspect Plex when no library-mutating notification applies", async () => {
		const { deps, getSeriesEpisodeMediaPartsByTvdbId } = makeSonarrDeps({
			notificationKind: "none",
		});
		const context = createSharedPlexSafetyContext();

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [target], context)).toEqual(new Map());
		expect(getSeriesEpisodeMediaPartsByTvdbId).not.toHaveBeenCalled();
		expect(context.plans.get(cleanupDeleteTargetKey(target))).toMatchObject({
			kind: "verified_sonarr",
			files: { episodeFiles: [{ episodeFileId: 3001 }, { episodeFileId: 3002 }] },
		});
	});

	it("does not inspect Plex when the connection has library updates disabled", async () => {
		const { deps, getSeriesEpisodeMediaPartsByTvdbId } = makeSonarrDeps({
			updateLibrary: false,
		});
		const context = createSharedPlexSafetyContext();

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [target], context)).toEqual(new Map());
		expect(getSeriesEpisodeMediaPartsByTvdbId).not.toHaveBeenCalled();
		expect(context.plans.get(cleanupDeleteTargetKey(target))).toMatchObject({
			kind: "verified_sonarr",
			files: { episodeFiles: [{ episodeFileId: 3001 }, { episodeFileId: 3002 }] },
		});
	});

	it("uses episode-file notification semantics for delete_files", async () => {
		const { deps, getSeriesEpisodeMediaPartsByTvdbId } = makeSonarrDeps({
			action: "delete_files",
			onSeriesDelete: true,
			onEpisodeFileDelete: false,
		});
		const deleteFilesTarget = { ...target, action: "delete_files" };

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [deleteFilesTarget])).toEqual(
			new Map(),
		);
		expect(getSeriesEpisodeMediaPartsByTvdbId).not.toHaveBeenCalled();
	});

	it("blocks full deletion when an entity-only Plex trigger could not be preserved", async () => {
		const { deps, getSeriesEpisodeMediaPartsByTvdbId } = makeSonarrDeps({
			onSeriesDelete: true,
			onEpisodeFileDelete: false,
		});

		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain("episode-file-delete");
		expect(getSeriesEpisodeMediaPartsByTvdbId).not.toHaveBeenCalled();
	});

	it("blocks a fileless series when full deletion still triggers a Plex refresh", async () => {
		const { deps, getSeriesEpisodeMediaPartsByTvdbId } = makeSonarrDeps({
			episodeFiles: [],
			onSeriesDelete: true,
			onEpisodeFileDelete: true,
		});

		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"fileless Sonarr series still triggers a Plex refresh",
		);
		expect(getSeriesEpisodeMediaPartsByTvdbId).not.toHaveBeenCalled();
	});

	it("blocks fileless Sonarr planning when a sibling instance is already configured", async () => {
		const fixture = makeSonarrDeps({ notificationKind: "none", episodeFiles: [] });
		const peer = addSonarrPeer(fixture);

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"another configured Sonarr instance may access the same storage",
		);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
		expect(peer.peerClient.episodeFile.getBySeries).not.toHaveBeenCalled();
	});

	it("respects notification tags", async () => {
		const { deps, getSeriesEpisodeMediaPartsByTvdbId } = makeSonarrDeps({
			seriesTags: [1],
			notificationTags: [2],
		});

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [target])).toEqual(new Map());
		expect(getSeriesEpisodeMediaPartsByTvdbId).not.toHaveBeenCalled();
	});

	it.each([
		["Emby/Jellyfin", "mediabrowser" as const],
		["Kodi", "kodi" as const],
		["Synology Indexer", "synology" as const],
	])("blocks an unmodeled %s library mutation", async (destination, notificationKind) => {
		const { deps, getSeriesEpisodeMediaPartsByTvdbId } = makeSonarrDeps({
			notificationKind,
		});
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(destination);
		expect(getSeriesEpisodeMediaPartsByTvdbId).not.toHaveBeenCalled();
	});

	it("treats Kodi clean-library as mutating even when update-library is disabled", async () => {
		const { deps, getSeriesEpisodeMediaPartsByTvdbId } = makeSonarrDeps({
			notificationKind: "kodi",
			updateLibrary: false,
			cleanLibrary: true,
		});
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain("Kodi");
		expect(getSeriesEpisodeMediaPartsByTvdbId).not.toHaveBeenCalled();
	});

	it("fails closed when an episode file has no stable live identity", async () => {
		const { deps } = makeSonarrDeps({
			episodeFiles: [
				{
					id: undefined,
					path: "/tv-4k/Example Series/Season 01/Example.S01E01.2160p.mkv",
					size: 2_001,
				},
			],
		});

		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);
		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"could not match the exact Sonarr episode files",
		);
	});
});

describe("verified Sonarr mutation handoff", () => {
	function approval(
		action: "delete" | "delete_files" = "delete",
		episodeFiles: Array<{
			id?: number;
			path?: string | null;
			size?: number;
		}> = [
			{
				id: 3001,
				path: "/tv-4k/Example Series/Season 01/Example.S01E01.2160p.mkv",
				size: 2_001,
			},
			{
				id: 3002,
				path: "/tv-4k/Example Series/Season 01/Example.S01E02.2160p.mkv",
				size: 2_002,
			},
		],
		targetDeleteNotifications: VerifiedSonarrTargetDeleteNotification[] = [
			{
				plexServerUrl: "http://plex.internal:32400",
				onSeriesDelete: false,
				onEpisodeFileDelete: true,
				mapping: null,
			},
		],
	) {
		return {
			id: "approval-1",
			instanceId: "sonarr-4k",
			arrItemId: 201,
			itemType: "series",
			action,
			title: "Example Series",
			safetySnapshot: serializeExecutableSafetyPlan({
				kind: "verified_sonarr",
				target: {
					serviceFingerprint: createArrServiceFingerprint({
						id: "sonarr-4k",
						service: "SONARR",
						baseUrl: "http://sonarr.internal:8989",
						encryptedApiKey: "encrypted-sonarr-key",
						encryptionIv: "sonarr-iv",
						encryptedHttpAuthCredentials: null,
						httpAuthEncryptionIv: null,
					} as never),
					externalId: 123,
					mediaPath: { value: "/tv-4k/Example Series", windows: false },
				},
				files: {
					seriesPath: { value: "/tv-4k/Example Series", windows: false },
					episodeFiles: episodeFiles.map((file) => ({
						episodeFileId: file.id!,
						fullPath: { value: file.path!, windows: false },
						size: file.size!,
					})),
				},
				peers: [],
				peerInventoryComplete: true,
				ownership:
					targetDeleteNotifications.length === 0
						? []
						: [
								{
									plexServerUrl: "http://plex.internal:32400",
									target: episodeFiles.map((file) => ({
										ratingKey: `show-123`,
										fullPath: { value: file.path!, windows: false },
										size: file.size!,
									})),
									retained: [],
								},
							],
				targetDeleteNotifications,
			}),
		};
	}

	function configureRetryStore(deps: CleanupExecutorDeps) {
		const retries: Array<Record<string, unknown>> = [];
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
			where,
		}: {
			where: { status?: string };
		}) => {
			if (where.status === "retry_pending") {
				return retries.filter((retry) => retry.status === "retry_pending");
			}
			if (where.status === "retry_executing") {
				return retries.filter((retry) => retry.status === "retry_executing");
			}
			return [];
		}) as never);
		vi.mocked(deps.prisma.libraryCleanupApproval.updateMany).mockImplementation((async ({
			where,
			data,
		}: {
			where: { id: string; status: string };
			data: { status: string };
		}) => {
			const retry = retries.find(
				(candidate) => candidate.id === where.id && candidate.status === where.status,
			);
			if (!retry) return { count: 0 };
			Object.assign(retry, data);
			return { count: 1 };
		}) as never);
		vi.mocked(deps.prisma.libraryCleanupApproval.create).mockImplementation((async ({
			data,
		}: {
			data: Record<string, unknown>;
		}) => {
			const existing = retries.find((retry) => retry.id === data.id);
			if (existing) {
				const error = new Error("retry already exists") as Error & { code: string };
				error.code = "P2002";
				throw error;
			}
			const retry = { createdAt: new Date(), ...data };
			retries.push(retry);
			return retry;
		}) as never);
		vi.mocked(deps.prisma.libraryCleanupApproval.update).mockImplementation((async ({
			where,
			data,
		}: {
			where: { id: string };
			data: Record<string, unknown>;
		}) => {
			const retry = retries.find((candidate) => candidate.id === where.id);
			if (retry) Object.assign(retry, data);
			return retry ?? {};
		}) as never);
		return retries;
	}

	function configureApprovalStore(
		deps: CleanupExecutorDeps,
		storedApproval: Record<string, unknown>,
	) {
		storedApproval.status ??= "approved";
		storedApproval.executionToken ??= null;
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
			where,
		}: {
			where: { status?: string };
		}) => (storedApproval.status === where.status ? [storedApproval] : [])) as never);
		const updateMany = vi.mocked(deps.prisma.libraryCleanupApproval.updateMany);
		updateMany.mockImplementation((async ({
			where,
			data,
		}: {
			where: { id?: string; status?: string; executionToken?: string };
			data: Record<string, unknown>;
		}) => {
			if (where.id && where.id !== storedApproval.id) return { count: 0 };
			if (where.status && where.status !== storedApproval.status) return { count: 0 };
			if (
				where.executionToken !== undefined &&
				where.executionToken !== storedApproval.executionToken
			) {
				return { count: 0 };
			}
			Object.assign(storedApproval, data);
			return { count: 1 };
		}) as never);
		return updateMany;
	}

	function directEpisodeFlaggedItem(fixture: ReturnType<typeof makeSonarrDeps>) {
		return {
			cacheItem: {
				id: "series-cache",
				instanceId: fixture.targetInstance.id,
				arrItemId: fixture.series.id,
				itemType: "series",
				title: fixture.series.title,
				year: 2024,
				monitored: true,
				hasFile: true,
				status: "continuing",
				qualityProfileId: 1,
				qualityProfileName: "HD",
				sizeOnDisk: 2_001n,
				arrAddedAt: new Date(),
				cachedAt: new Date(),
				data: JSON.stringify({
					_arrDashboardSource: { serviceFingerprint: sonarrServiceFingerprint },
					path: fixture.series.path,
					remoteIds: { tvdbId: fixture.series.tvdbId, tmdbId: fixture.series.tmdbId },
				}),
			},
			match: {
				ruleId: "episode-rule",
				ruleName: "Remove watched episodes",
				reason: "Plex watch count 1 > 0",
				action: "delete",
			},
			rating: 8.2,
			episodeTarget: {
				targetScope: "episode",
				arrEpisodeId: 9_001,
				seasonNumber: 1,
				episodeNumber: 1,
				episodeFileId: 3_001,
				episodeFileConsumerIds: [9_001],
				seriesTitle: fixture.series.title,
				episodeTitle: "Episode 1",
				plexWatchEvidence: [
					{
						plexInstanceId: fixture.plexInstance.id,
						sourceFingerprint: PLEX_SOURCE_FINGERPRINT,
						ratingKey: "episode-1",
						watchCount: 1,
						lastWatchedAt: new Date(),
						watchedByUsers: [],
						refreshedAt: new Date(),
					},
				],
				fileInfoHash: "episode-hash",
				fileTorrentState: "paused",
				respectQuiSeeding: true,
			},
		} as never;
	}

	it("unmonitors and deletes only the approved episode without removing its series", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			matchedRuleId: "episode-rule",
			matchedRuleName: "Remove watched episodes",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledWith([9_001], false);
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3_001]);
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
		expect(fixture.episodeFileCacheDeleteMany).toHaveBeenCalledWith({
			where: {
				instanceId: "sonarr-4k",
				arrSeriesId: 201,
				arrEpisodeFileId: 3_001,
			},
		});
	});

	it.each(["unmonitor", "delete_files"] as const)(
		"executes exact episode %s without mutating its series or sibling",
		async (action) => {
			const fixture = makeSonarrDeps();
			const episodeTarget = { ...exactEpisodeTarget(), action };
			const context = createSharedPlexSafetyContext();
			await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
			const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
			if (plan?.kind !== "verified_sonarr_episode") {
				throw new Error("Expected verified Sonarr episode plan");
			}
			vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
				id: "config-1",
				respectQuiSeeding: true,
				rules: [episodeCleanupRule(action)],
			} as never);
			const storedApproval = {
				...approval(action === "unmonitor" ? "delete" : action),
				action,
				targetScope: "episode",
				arrEpisodeId: 9_001,
				seasonNumber: 1,
				episodeNumber: 1,
				episodeTitle: "Episode 1",
				matchedRuleId: episodeCleanupRule(action).id,
				matchedRuleName: "Remove watched episodes",
				safetySnapshot: serializeExecutableSafetyPlan(plan),
			} as unknown as Record<string, unknown>;
			configureApprovalStore(fixture.deps, storedApproval);

			await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
				removed: 1,
				failed: 0,
				errors: [],
			});
			expect(fixture.setEpisodeMonitored).toHaveBeenCalledTimes(action === "unmonitor" ? 1 : 0);
			expect(fixture.bulkDelete).toHaveBeenCalledTimes(action === "delete_files" ? 1 : 0);
			if (action === "delete_files") {
				expect(fixture.bulkDelete).toHaveBeenCalledWith([3_001]);
				expect(fixture.episodeFileCacheDeleteMany).toHaveBeenCalledWith({
					where: {
						instanceId: "sonarr-4k",
						arrSeriesId: 201,
						arrEpisodeFileId: 3_001,
					},
				});
			} else {
				expect(fixture.episodeFileCacheDeleteMany).not.toHaveBeenCalled();
			}
			expect(fixture.deleteSeries).not.toHaveBeenCalled();
		},
	);

	it("executes a direct episode delete through the same exact durable boundary", async () => {
		const fixture = makeSonarrDeps();
		const intents = configureRetryStore(fixture.deps);
		const result = await executeDirectRemoval(
			fixture.deps,
			{
				id: "config-1",
				maxRemovalsPerRun: 10,
				respectQuiSeeding: true,
				rules: [episodeCleanupRule()],
			} as never,
			"user-1",
			[directEpisodeFlaggedItem(fixture)],
			1,
			1,
			Date.now(),
		);

		expect(result.details).toEqual([expect.objectContaining({ action: "removed" })]);
		expect(result).toMatchObject({ status: "completed", itemsRemoved: 1 });
		expect(intents).toEqual([
			expect.objectContaining({ targetScope: "episode", arrEpisodeId: 9_001, status: "executed" }),
		]);
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledWith([9_001], false);
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3_001]);
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
		expect(fixture.episodeFileCacheDeleteMany).toHaveBeenCalledWith({
			where: {
				instanceId: "sonarr-4k",
				arrSeriesId: 201,
				arrEpisodeFileId: 3_001,
			},
		});
	});

	it("records a lost Sonarr response only after exact episode unmonitor readback", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = { ...exactEpisodeTarget(), action: "unmonitor" as const };
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		fixture.setEpisodeMonitored.mockImplementation(async (episodeIds, monitored) => {
			for (const episodeId of episodeIds) fixture.setLiveEpisodeMonitored(episodeId, monitored);
			throw new Error("Sonarr response timed out");
		});
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [episodeCleanupRule("unmonitor")],
		} as never);
		const storedApproval = {
			...approval(),
			action: "unmonitor",
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			matchedRuleId: "episode-rule-unmonitor",
			matchedRuleName: "Remove watched episodes",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(storedApproval).toMatchObject({ status: "executed" });
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("keeps an unverifiable episode unmonitor retryable without deleting its file", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = { ...exactEpisodeTarget(), action: "unmonitor" as const };
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		const liveEpisodes = await fixture.targetClient.episode.getAll();
		let attempted = false;
		fixture.setEpisodeMonitored.mockImplementation(async () => {
			attempted = true;
			throw new Error("Sonarr response timed out");
		});
		fixture.targetClient.episode.getAll.mockImplementation(async () => {
			if (attempted) throw new Error("Sonarr readback unavailable");
			return liveEpisodes;
		});
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [episodeCleanupRule("unmonitor")],
		} as never);
		const storedApproval = {
			...approval(),
			action: "unmonitor",
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			matchedRuleId: "episode-rule-unmonitor",
			matchedRuleName: "Remove watched episodes",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({
			status: "retry_pending",
			lastExecutionError: expect.stringContaining("could not confirm"),
		});
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("reconciles a lost exact-file delete response without repeating the mutation", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = { ...exactEpisodeTarget(), action: "delete_files" as const };
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		const deleteImplementation = fixture.bulkDelete.getMockImplementation();
		fixture.bulkDelete.mockImplementation(async (fileIds) => {
			await deleteImplementation?.(fileIds);
			const episodes = await fixture.targetClient.episode.getAll();
			const selected = episodes.find((episode) => episode.id === 9_001);
			if (selected) selected.episodeFileId = 0;
			throw new Error("Sonarr response timed out");
		});
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [episodeCleanupRule("delete_files")],
		} as never);
		const storedApproval = {
			...approval("delete_files"),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			matchedRuleId: "episode-rule-delete_files",
			matchedRuleName: "Remove watched episodes",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);

		const first = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);
		expect(first).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({ status: "retry_pending" });
		expect(fixture.episodeFileCacheDeleteMany).toHaveBeenCalledWith({
			where: {
				instanceId: "sonarr-4k",
				arrSeriesId: 201,
				arrEpisodeFileId: { in: [3_001] },
			},
		});

		const retry = await executeRetryItems(fixture.deps, "user-1", ["approval-1"]);
		expect(retry).toEqual({ removed: 0, reconciled: 1, failed: 0, errors: [] });
		expect(fixture.bulkDelete).toHaveBeenCalledTimes(1);
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
		expect(storedApproval).toMatchObject({ status: "executed" });
	});

	it("keeps a completed episode unmonitor durable when file authority changes", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		const matchingConfig = {
			id: "config-1",
			respectQuiSeeding: true,
			rules: [episodeCleanupRule()],
		};
		const disabledConfig = {
			...matchingConfig,
			rules: [{ ...episodeCleanupRule(), enabled: false }],
		};
		let currentConfig = matchingConfig;
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockImplementation(
			(async () => currentConfig) as never,
		);
		fixture.setEpisodeMonitored.mockImplementation(async (episodeIds, monitored) => {
			for (const episodeId of episodeIds) fixture.setLiveEpisodeMonitored(episodeId, monitored);
			currentConfig = disabledConfig;
		});
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			matchedRuleId: "episode-rule",
			matchedRuleName: "Remove watched episodes",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("accepted the episode unmonitor");
		expect(storedApproval).toMatchObject({
			status: "retry_pending",
			lastExecutionError: expect.stringContaining("accepted the episode unmonitor"),
		});
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledTimes(1);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();

		const blockedRetry = await executeRetryItems(fixture.deps, "user-1", ["approval-1"]);
		expect(blockedRetry).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({ status: "retry_pending" });
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledTimes(1);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();

		currentConfig = matchingConfig;
		const completedRetry = await executeRetryItems(fixture.deps, "user-1", ["approval-1"]);
		expect(completedRetry).toMatchObject({ removed: 1, failed: 0 });
		expect(storedApproval).toMatchObject({ status: "executed" });
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledTimes(1);
		expect(fixture.bulkDelete).toHaveBeenCalledOnce();
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3_001]);
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("persists a direct episode delete after its exact unmonitor step", async () => {
		const fixture = makeSonarrDeps();
		const intents = configureRetryStore(fixture.deps);
		const matchingConfig = {
			id: "config-1",
			respectQuiSeeding: true,
			rules: [episodeCleanupRule()],
		};
		let currentConfig = matchingConfig;
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockImplementation(
			(async () => currentConfig) as never,
		);
		fixture.setEpisodeMonitored.mockImplementation(async (episodeIds, monitored) => {
			for (const episodeId of episodeIds) fixture.setLiveEpisodeMonitored(episodeId, monitored);
			currentConfig = {
				...matchingConfig,
				rules: [{ ...episodeCleanupRule(), enabled: false }],
			};
		});

		const result = await executeDirectRemoval(
			fixture.deps,
			{ ...matchingConfig, maxRemovalsPerRun: 10 } as never,
			"user-1",
			[directEpisodeFlaggedItem(fixture)],
			1,
			1,
			Date.now(),
		);

		expect(result).toMatchObject({ status: "partial", itemsRemoved: 0 });
		expect(intents).toEqual([
			expect.objectContaining({
				status: "retry_pending",
				lastExecutionError: expect.stringContaining("accepted the episode unmonitor"),
			}),
		]);
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledTimes(1);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it.each([
		["disabled", { enabled: false }],
		["threshold raised", { parameters: JSON.stringify({ operator: "greater_than", count: 1 }) }],
	] as const)("expires an episode approval when its live rule is %s", async (_label, override) => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [{ ...episodeCleanupRule(), ...override }],
		} as never);
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			matchedRuleId: "episode-rule",
			matchedRuleName: "Remove watched episodes",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({ status: "expired" });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		"blocks an episode when the live parent %s rule takes precedence",
		async (retentionMode) => {
			const fixture = makeSonarrDeps();
			const episodeTarget = exactEpisodeTarget();
			const context = createSharedPlexSafetyContext();
			await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
			const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
			if (plan?.kind !== "verified_sonarr_episode") {
				throw new Error("Expected verified Sonarr episode plan");
			}
			fixture.series.monitored = false;
			vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
				id: "config-1",
				respectQuiSeeding: true,
				rules: [
					{
						...episodeCleanupRule(),
						id: "parent-rule",
						priority: 0,
						targetScope: "series",
						ruleType: "unmonitored",
						parameters: JSON.stringify({}),
						retentionMode,
					},
					episodeCleanupRule(),
				],
			} as never);
			const storedApproval = {
				...approval(),
				targetScope: "episode",
				arrEpisodeId: 9_001,
				seasonNumber: 1,
				episodeNumber: 1,
				episodeTitle: "Episode 1",
				matchedRuleId: "episode-rule",
				matchedRuleName: "Remove watched episodes",
				safetySnapshot: serializeExecutableSafetyPlan(plan),
			} as unknown as Record<string, unknown>;
			configureApprovalStore(fixture.deps, storedApproval);

			const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

			expect(result).toMatchObject({ removed: 0, failed: 1 });
			expect(storedApproval).toMatchObject({ status: "expired" });
			expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
			expect(fixture.bulkDelete).not.toHaveBeenCalled();
		},
	);

	it("executes an episode when a current parent Plex rule is proven not to match", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [
				{
					...episodeCleanupRule(),
					id: "parent-plex-rule",
					priority: 0,
					targetScope: "series",
					ruleType: "plex_watch_count",
					parameters: JSON.stringify({ operator: "greater_than", count: 10 }),
				},
				episodeCleanupRule(),
			],
		} as never);
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			matchedRuleId: "episode-rule",
			matchedRuleName: "Remove watched episodes",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		const evidenceRefresher = vi.mocked(fixture.deps.externalRuleCacheRefresher!);
		const plexFindMany = vi.mocked(fixture.deps.prisma.plexCache.findMany);
		expect(evidenceRefresher).toHaveBeenCalledWith("plex", fixture.plexInstance);
		expect(evidenceRefresher.mock.invocationCallOrder[0]).toBeLessThan(
			plexFindMany.mock.invocationCallOrder[0]!,
		);
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3_001]);
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("rechecks parent Plex evidence after unmonitoring and before file deletion", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		let parentMatches = false;
		let refreshCount = 0;
		vi.mocked(fixture.deps.externalRuleCacheRefresher!).mockImplementation(async () => {
			refreshCount++;
			if (refreshCount >= 3) parentMatches = true;
		});
		vi.mocked(fixture.deps.prisma.plexCache.findMany).mockImplementation(
			(args) =>
				Promise.resolve(
					args?.cursor
						? []
						: [
								{
									id: "plex-series-456",
									tmdbId: 456,
									mediaType: "series",
									sectionId: "tv",
									sectionTitle: "TV",
									lastWatchedAt: new Date(),
									watchCount: parentMatches ? 20 : 0,
									watchedByUsers: "[]",
									onDeck: false,
									userRating: null,
									collections: "[]",
									labels: "[]",
									addedAt: null,
								},
							],
				) as never,
		);
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [
				{
					...episodeCleanupRule(),
					id: "parent-plex-rule",
					priority: 0,
					targetScope: "series",
					ruleType: "plex_watch_count",
					parameters: JSON.stringify({ operator: "greater_than", count: 10 }),
				},
				episodeCleanupRule(),
			],
		} as never);
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			matchedRuleId: "episode-rule",
			matchedRuleName: "Remove watched episodes",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledWith([9_001], false);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(refreshCount).toBeGreaterThanOrEqual(3);
	});

	it.each(["matches", "unavailable"] as const)(
		"blocks an episode when current parent Plex evidence %s",
		async (mode) => {
			const fixture = makeSonarrDeps();
			const episodeTarget = exactEpisodeTarget();
			const context = createSharedPlexSafetyContext();
			await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
			const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
			if (plan?.kind !== "verified_sonarr_episode") {
				throw new Error("Expected verified Sonarr episode plan");
			}
			const plexFindMany = vi.mocked(fixture.deps.prisma.plexCache.findMany);
			if (mode === "matches") {
				plexFindMany.mockImplementation(
					(args) =>
						Promise.resolve(
							args?.cursor
								? []
								: [
										{
											id: "plex-series-456",
											tmdbId: 456,
											mediaType: "series",
											sectionId: "tv",
											sectionTitle: "TV",
											lastWatchedAt: new Date(),
											watchCount: 20,
											watchedByUsers: "[]",
											onDeck: false,
											userRating: null,
											collections: "[]",
											labels: "[]",
											addedAt: null,
										},
									],
						) as never,
				);
			} else {
				plexFindMany.mockRejectedValue(new Error("Plex evidence unavailable"));
			}
			vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
				id: "config-1",
				respectQuiSeeding: true,
				rules: [
					{
						...episodeCleanupRule(),
						id: "parent-plex-rule",
						priority: 0,
						targetScope: "series",
						ruleType: "plex_watch_count",
						parameters: JSON.stringify({ operator: "greater_than", count: 10 }),
					},
					episodeCleanupRule(),
				],
			} as never);
			const storedApproval = {
				...approval(),
				targetScope: "episode",
				arrEpisodeId: 9_001,
				seasonNumber: 1,
				episodeNumber: 1,
				episodeTitle: "Episode 1",
				matchedRuleId: "episode-rule",
				matchedRuleName: "Remove watched episodes",
				safetySnapshot: serializeExecutableSafetyPlan(plan),
			} as unknown as Record<string, unknown>;
			configureApprovalStore(fixture.deps, storedApproval);

			const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

			expect(result).toMatchObject({ removed: 0, failed: 1 });
			expect(storedApproval).toMatchObject({ status: "expired" });
			expect(fixture.bulkDelete).not.toHaveBeenCalled();
			expect(fixture.deleteSeries).not.toHaveBeenCalled();
		},
	);

	it("blocks an episode when a parent episode-completion rule cannot be proven live", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [
				{
					...episodeCleanupRule(),
					id: "parent-completion-rule",
					priority: 0,
					targetScope: "series",
					ruleType: "plex_episode_completion",
					parameters: JSON.stringify({ operator: "less_than", percentage: 100 }),
				},
				episodeCleanupRule(),
			],
		} as never);
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			matchedRuleId: "episode-rule",
			matchedRuleName: "Remove watched episodes",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("blocks an episode when a parent list rule has only cached non-match evidence", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		vi.mocked(fixture.deps.prisma.tmdbListCache.findMany).mockResolvedValue([
			{ listId: "8068", tmdbId: 999 },
		] as never);
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [
				{
					...episodeCleanupRule(),
					id: "parent-list-rule",
					priority: 0,
					targetScope: "series",
					ruleType: "tmdb_list_member",
					parameters: JSON.stringify({ listId: "8068", operator: "is_in" }),
				},
				episodeCleanupRule(),
			],
		} as never);
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			matchedRuleId: "episode-rule",
			matchedRuleName: "Remove watched episodes",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({ status: "expired" });
		expect(fixture.deps.prisma.tmdbListCache.findMany).toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("still uses exact-file deletion when no media-server notification applies", async () => {
		const { deps, targetClient, episodeFiles, bulkDelete, deleteSeries } = makeSonarrDeps({
			notificationKind: "none",
		});
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approval("delete", undefined, []),
		] as never);
		targetClient.episodeFile.getBySeries
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce([]);

		await expect(executeApprovedItems(deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(bulkDelete).toHaveBeenCalledWith([3001, 3002]);
		expect(deleteSeries).toHaveBeenCalledWith(201, {
			deleteFiles: false,
			addImportListExclusion: false,
		});
	});

	it("deletes only the verified IDs, rechecks empty state, then removes the record without files", async () => {
		const {
			deps,
			targetClient,
			episodeFiles,
			bulkDelete,
			deleteSeries,
			episodeFileCacheDeleteMany,
		} = makeSonarrDeps();
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([approval()] as never);
		targetClient.episodeFile.getBySeries
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce([]);

		await expect(executeApprovedItems(deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(bulkDelete).toHaveBeenCalledWith([3001, 3002]);
		expect(deleteSeries).toHaveBeenCalledWith(201, {
			deleteFiles: false,
			addImportListExclusion: false,
		});
		expect(episodeFileCacheDeleteMany).toHaveBeenCalledWith({
			where: { instanceId: "sonarr-4k", arrSeriesId: 201 },
		});
	});

	it("retains a no-peer Sonarr record when Plex gains an unowned part after exact file deletion", async () => {
		const fixture = makeSonarrDeps();
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approval(),
		] as never);
		const deleteVerifiedFiles = fixture.bulkDelete.getMockImplementation();
		if (!deleteVerifiedFiles) throw new Error("Expected a Sonarr bulk-delete implementation");
		fixture.bulkDelete.mockImplementation(async (episodeFileIds) => {
			await deleteVerifiedFiles(episodeFileIds);
			fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
				{
					ratingKey: "show-123",
					episodes: [
						{
							ratingKey: "episode-new",
							parts: [
								{
									file: "/tv-4k/Example Series/Season 01/Example.S01E03.2160p.mkv",
									size: 2_003,
								},
							],
						},
					],
				},
			]);
		});

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3001, 3002]);
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("deletes only the target Sonarr files after revalidating shared Plex ownership", async () => {
		const fixture = makeSonarrDeps();
		const peer = addSonarrPeer(fixture);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
			{
				ratingKey: "show-123",
				episodes: [...fixture.episodeFiles, ...peer.episodeFiles].map((file, index) => ({
					ratingKey: `episode-${index + 1}`,
					parts: [{ file: file.path!, size: file.size! }],
				})),
			},
		]);
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_sonarr") throw new Error("Expected verified Sonarr plan");
		const storedApproval = {
			...approval(),
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3001, 3002]);
		expect(peer.peerClient.episodeFile.getBySeries).toHaveBeenCalled();
		expect(fixture.deleteSeries).toHaveBeenCalledWith(201, {
			deleteFiles: false,
			addImportListExclusion: false,
		});
	});

	it("blocks queued deletion when a Sonarr peer appears at the mutation boundary", async () => {
		const fixture = makeSonarrDeps();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_sonarr") throw new Error("Expected verified Sonarr plan");
		expect(plan.peers).toEqual([]);
		const storedApproval = {
			...approval(),
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);
		let peerAdded = false;
		vi.mocked(fixture.deps.prisma.crossDomainRule.findMany).mockImplementation((async () => {
			if (!peerAdded) {
				peerAdded = true;
				addSonarrPeer(fixture, {
					seriesPath: fixture.series.path,
					episodeFiles: [
						{
							id: 4001,
							path: fixture.episodeFiles[0]!.path!,
							relativePath: fixture.episodeFiles[0]!.relativePath!,
							size: fixture.episodeFiles[0]!.size!,
						},
					],
				});
			}
			return [];
		}) as never);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(peerAdded).toBe(true);
		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("retains the series when peer ownership changes after target file deletion", async () => {
		const fixture = makeSonarrDeps();
		const peer = addSonarrPeer(fixture);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
			{
				ratingKey: "show-123",
				episodes: [...fixture.episodeFiles, ...peer.episodeFiles].map((file, index) => ({
					ratingKey: `episode-${index + 1}`,
					parts: [{ file: file.path!, size: file.size! }],
				})),
			},
		]);
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_sonarr") throw new Error("Expected verified Sonarr plan");
		const storedApproval = {
			...approval(),
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);
		peer.peerClient.episodeFile.getBySeries.mockImplementation(async () => {
			return fixture.bulkDelete.mock.calls.length === 0
				? peer.episodeFiles
				: [{ ...peer.episodeFiles[0]!, size: peer.episodeFiles[0]!.size + 1 }];
		});

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3001, 3002]);
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
		expect(storedApproval).toMatchObject({ status: "pending" });
	});

	it("blocks when the Sonarr file set changes after Plex verification", async () => {
		const { deps, targetClient, episodeFiles, bulkDelete, deleteSeries, approvalUpdate } =
			makeSonarrDeps();
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([approval()] as never);
		targetClient.episodeFile.getBySeries
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce([
				...episodeFiles,
				{
					id: 3003,
					path: "/tv-4k/Example Series/Season 01/Example.S01E03.2160p.mkv",
					size: 2_003,
				},
			]);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("verified Sonarr ownership changed");
		expect(bulkDelete).not.toHaveBeenCalled();
		expect(deleteSeries).not.toHaveBeenCalled();
		expect(approvalUpdate).toHaveBeenCalledWith({
			where: expect.objectContaining({ id: "approval-1", status: "executing" }),
			data: expect.objectContaining({ status: "expired" }),
		});
	});

	it("records exact partial progress when Sonarr bulk deletion removes only some files", async () => {
		const {
			deps,
			targetClient,
			episodeFiles,
			bulkDelete,
			deleteSeries,
			episodeFileCacheDeleteMany,
		} = makeSonarrDeps();
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([approval()] as never);
		targetClient.episodeFile.getBySeries
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce([episodeFiles[1]!]);
		bulkDelete.mockRejectedValueOnce(new Error("bulk delete interrupted"));

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("only part of the verified episode-file set");
		expect(deleteSeries).not.toHaveBeenCalled();
		expect(episodeFileCacheDeleteMany).toHaveBeenCalledWith({
			where: {
				instanceId: "sonarr-4k",
				arrSeriesId: 201,
				arrEpisodeFileId: { in: [3001] },
			},
		});
		expect(deps.prisma.libraryCache.updateMany).toHaveBeenCalledWith({
			where: { instanceId: "sonarr-4k", arrItemId: 201, itemType: "series" },
			data: { hasFile: true, sizeOnDisk: 2_002 },
		});
		const pendingUpdate = vi
			.mocked(deps.prisma.libraryCleanupApproval.updateMany)
			.mock.calls.slice()
			.reverse()
			.find((call) => call[0].data.status === "pending")?.[0];
		expect(pendingUpdate?.data).not.toHaveProperty("safetySnapshot");
	});

	it("retains the series and deletes only verified IDs for delete_files", async () => {
		const { deps, targetClient, episodeFiles, bulkDelete, deleteSeries } = makeSonarrDeps({
			action: "delete_files",
		});
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approval("delete_files"),
		] as never);
		targetClient.episodeFile.getBySeries
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce([]);

		await expect(executeApprovedItems(deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(bulkDelete).toHaveBeenCalledWith([3001, 3002]);
		expect(deleteSeries).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCache.updateMany).toHaveBeenCalledWith({
			where: { instanceId: "sonarr-4k", arrItemId: 201, itemType: "series" },
			data: { hasFile: false, sizeOnDisk: 0 },
		});
	});

	it("retains the series when a new file appears after verified files are removed", async () => {
		const {
			deps,
			targetClient,
			episodeFiles,
			bulkDelete,
			deleteSeries,
			episodeFileCacheDeleteMany,
		} = makeSonarrDeps();
		const replacement = {
			id: 3003,
			path: "/tv-4k/Example Series/Season 01/Example.S01E03.2160p.mkv",
			size: undefined,
		};
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([approval()] as never);
		targetClient.episodeFile.getBySeries
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce([replacement]);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("another file appeared");
		expect(bulkDelete).toHaveBeenCalledWith([3001, 3002]);
		expect(deleteSeries).not.toHaveBeenCalled();
		expect(episodeFileCacheDeleteMany).toHaveBeenCalledWith({
			where: {
				instanceId: "sonarr-4k",
				arrSeriesId: 201,
				arrEpisodeFileId: { in: [3001, 3002] },
			},
		});
		expect(deps.prisma.libraryCache.updateMany).toHaveBeenCalledWith({
			where: { instanceId: "sonarr-4k", arrItemId: 201, itemType: "series" },
			data: { hasFile: true, sizeOnDisk: 0 },
		});
	});

	it("keeps the cache conservative when a changed Sonarr file set cannot be read back", async () => {
		const { deps, targetClient, episodeFiles } = makeSonarrDeps();
		const replacement = {
			id: 3003,
			path: "/tv-4k/Example Series/Season 01/Example.S01E03.2160p.mkv",
			size: 2_003,
		};
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([approval()] as never);
		targetClient.episodeFile.getBySeries
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([replacement])
			.mockRejectedValueOnce(new Error("Sonarr read unavailable"));

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(deps.prisma.libraryCache.updateMany).toHaveBeenCalledWith({
			where: { instanceId: "sonarr-4k", arrItemId: 201, itemType: "series" },
			data: { hasFile: true, sizeOnDisk: 0 },
		});
	});

	it("records removed files but keeps the approval pending when series removal fails", async () => {
		const {
			deps,
			targetClient,
			episodeFiles,
			deleteSeries,
			episodeFileCacheDeleteMany,
			approvalUpdate,
		} = makeSonarrDeps();
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([approval()] as never);
		targetClient.episodeFile.getBySeries
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce([]);
		deleteSeries.mockRejectedValue(new Error("series delete unavailable"));

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("episode files were deleted");
		expect(deleteSeries).toHaveBeenCalledTimes(2);
		expect(episodeFileCacheDeleteMany).toHaveBeenCalledWith({
			where: {
				instanceId: "sonarr-4k",
				arrSeriesId: 201,
				arrEpisodeFileId: { in: [3001, 3002] },
			},
		});
		expect(approvalUpdate).toHaveBeenCalledWith({
			where: expect.objectContaining({ id: "approval-1", status: "executing" }),
			data: expect.objectContaining({
				status: "pending",
				lastExecutionError: expect.stringContaining("episode files were deleted"),
			}),
		});
	});

	it("retries a verified fileless Sonarr approval without deleting files again", async () => {
		const { deps, bulkDelete, deleteSeries } = makeSonarrDeps();
		const storedApproval = approval() as unknown as Record<string, unknown>;
		configureApprovalStore(deps, storedApproval);
		deleteSeries
			.mockRejectedValueOnce(new Error("series delete unavailable"))
			.mockRejectedValueOnce(new Error("series delete unavailable"));

		const firstResult = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(firstResult).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({
			status: "pending",
		});
		expect(JSON.parse(storedApproval.safetySnapshot as string)).toMatchObject({
			kind: "verified_sonarr",
			files: { episodeFiles: [] },
			peerInventoryComplete: true,
			ownership: [expect.objectContaining({ retained: [] })],
		});

		storedApproval.status = "approved";
		const retryResult = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(retryResult).toEqual({ removed: 1, failed: 0, errors: [] });
		expect(bulkDelete).toHaveBeenCalledOnce();
		expect(deleteSeries).toHaveBeenCalledTimes(3);
		expect(storedApproval).toMatchObject({
			status: "executed",
			lastExecutionError: null,
		});
	});

	it("retries a shared Sonarr series-delete notification after target files were removed", async () => {
		const fixture = makeSonarrDeps({
			onSeriesDelete: true,
			onEpisodeFileDelete: true,
		});
		const peer = addSonarrPeer(fixture);
		peer.peerClient.series.getAll.mockResolvedValue([]);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
			{
				ratingKey: "show-123",
				episodes: fixture.episodeFiles.map((file, index) => ({
					ratingKey: `episode-${index + 1}`,
					parts: [{ file: file.path!, size: file.size! }],
				})),
			},
		]);
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_sonarr") throw new Error("Expected verified Sonarr plan");
		const storedApproval = {
			...approval(),
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);
		fixture.deleteSeries
			.mockRejectedValueOnce(new Error("series delete unavailable"))
			.mockRejectedValueOnce(new Error("series delete unavailable"));

		const firstResult = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(firstResult).toMatchObject({ removed: 0, failed: 1 });
		expect(JSON.parse(storedApproval.safetySnapshot as string)).toMatchObject({
			kind: "verified_sonarr",
			files: { episodeFiles: [] },
			peers: [expect.objectContaining({ instanceId: "sonarr-hd", arrItemId: null })],
			ownership: [expect.objectContaining({ retained: [] })],
		});

		storedApproval.status = "approved";
		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(fixture.bulkDelete).toHaveBeenCalledOnce();
		expect(fixture.deleteSeries).toHaveBeenCalledTimes(3);
	});

	it("retries a no-peer Sonarr series-delete notification after target files were removed", async () => {
		const fixture = makeSonarrDeps({ onSeriesDelete: true, onEpisodeFileDelete: true });
		const context = createSharedPlexSafetyContext();
		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_sonarr") throw new Error("Expected verified Sonarr plan");
		expect(plan).toMatchObject({
			peers: [],
			peerInventoryComplete: true,
			ownership: [expect.objectContaining({ retained: [] })],
		});
		const storedApproval = {
			...approval(),
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);
		fixture.deleteSeries
			.mockRejectedValueOnce(new Error("series delete unavailable"))
			.mockRejectedValueOnce(new Error("series delete unavailable"));

		const firstResult = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);
		storedApproval.status = "approved";
		const retryResult = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(firstResult).toMatchObject({ removed: 0, failed: 1 });
		expect(retryResult).toEqual({ removed: 1, failed: 0, errors: [] });
		expect(fixture.bulkDelete).toHaveBeenCalledOnce();
		expect(fixture.deleteSeries).toHaveBeenCalledTimes(3);
	});

	it("reconciles an interrupted approved Sonarr mutation to the unchanged file remainder", async () => {
		const remainingFile = {
			id: 3002,
			path: "/tv-4k/Example Series/Season 01/Example.S01E02.2160p.mkv",
			relativePath: "Season 01/Example.S01E02.2160p.mkv",
			size: 2_002,
		};
		const { deps, bulkDelete, deleteSeries } = makeSonarrDeps({
			episodeFiles: [remainingFile],
		});
		const storedApproval = approval() as unknown as Record<string, unknown>;
		Object.assign(storedApproval, {
			lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
		});
		const approvalUpdate = configureApprovalStore(deps, storedApproval);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 1, failed: 0, errors: [] });
		expect(bulkDelete).toHaveBeenCalledOnce();
		expect(bulkDelete).toHaveBeenCalledWith([3002]);
		expect(deleteSeries).toHaveBeenCalledOnce();
		expect(storedApproval).toMatchObject({
			status: "executed",
			safetySnapshot: approval("delete", [remainingFile]).safetySnapshot,
			lastExecutionError: null,
		});
		expect(approvalUpdate.mock.invocationCallOrder[0]).toBeLessThan(
			bulkDelete.mock.invocationCallOrder[0]!,
		);
	});

	it("recovers a shared Sonarr crash after files were deleted but before the snapshot changed", async () => {
		const fixture = makeSonarrDeps({
			onSeriesDelete: true,
			onEpisodeFileDelete: true,
		});
		const peer = addSonarrPeer(fixture);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
			{
				ratingKey: "show-123",
				episodes: [...fixture.episodeFiles, ...peer.episodeFiles].map((file, index) => ({
					ratingKey: `episode-${index + 1}`,
					parts: [{ file: file.path!, size: file.size! }],
				})),
			},
		]);
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_sonarr") throw new Error("Expected verified Sonarr plan");
		await fixture.targetClient.episodeFile.bulkDelete([3001, 3002]);
		fixture.bulkDelete.mockClear();
		const storedApproval = {
			...approval(),
			safetySnapshot: serializeExecutableSafetyPlan(plan),
			lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).toHaveBeenCalledOnce();
		expect(JSON.parse(storedApproval.safetySnapshot as string)).toMatchObject({
			kind: "verified_sonarr",
			files: { episodeFiles: [] },
			ownership: [
				expect.objectContaining({
					retained: [expect.objectContaining({ instanceId: "sonarr-hd" })],
				}),
			],
		});
	});

	it("recovers an interrupted no-peer Sonarr record deletion from a complete empty inventory", async () => {
		const fixture = makeSonarrDeps({ onSeriesDelete: true, onEpisodeFileDelete: true });
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_sonarr") throw new Error("Expected verified Sonarr plan");
		await fixture.targetClient.episodeFile.bulkDelete([3001, 3002]);
		fixture.bulkDelete.mockClear();
		const storedApproval = {
			...approval(),
			safetySnapshot: serializeExecutableSafetyPlan(plan),
			lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedApproval);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).toHaveBeenCalledWith(201, {
			deleteFiles: false,
			addImportListExclusion: false,
		});
		expect(JSON.parse(storedApproval.safetySnapshot as string)).toMatchObject({
			kind: "verified_sonarr",
			files: { episodeFiles: [] },
			peers: [],
			peerInventoryComplete: true,
		});
	});

	it("reconciles an interrupted Sonarr file-delete retry when no episode files remain", async () => {
		const { deps, bulkDelete } = makeSonarrDeps({
			action: "delete_files",
			episodeFiles: [],
		});
		const storedRetry = {
			...approval("delete_files"),
			status: "retry_pending",
			lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
		} as unknown as Record<string, unknown>;
		configureApprovalStore(deps, storedRetry);

		const result = await executeRetryItems(deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 0, reconciled: 1, failed: 0, errors: [] });
		expect(bulkDelete).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCache.updateMany).toHaveBeenCalledWith({
			where: { instanceId: "sonarr-4k", arrItemId: 201, itemType: "series" },
			data: { hasFile: false, sizeOnDisk: 0 },
		});
		expect(storedRetry).toMatchObject({ status: "executed", executionToken: null });
	});

	it("expires a record-only Sonarr retry when the service is repointed", async () => {
		const { deps, targetInstance, bulkDelete, deleteSeries } = makeSonarrDeps();
		const storedApproval = approval() as unknown as Record<string, unknown>;
		configureApprovalStore(deps, storedApproval);
		deleteSeries
			.mockRejectedValueOnce(new Error("series delete unavailable"))
			.mockRejectedValueOnce(new Error("series delete unavailable"));

		await executeApprovedItems(deps, "user-1", ["approval-1"]);
		targetInstance.baseUrl = "http://different-sonarr.internal:8989";

		storedApproval.status = "approved";
		const retryResult = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(retryResult).toMatchObject({ removed: 0, failed: 1 });
		expect(retryResult.errors[0]).toContain("ARR target identity changed");
		expect(bulkDelete).toHaveBeenCalledOnce();
		expect(deleteSeries).toHaveBeenCalledTimes(2);
		expect(storedApproval).toMatchObject({ status: "expired" });
	});

	it("expires an approved Sonarr mutation when the service is repointed after preflight", async () => {
		const { deps, targetInstance, bulkDelete, deleteSeries } = makeSonarrDeps();
		const storedApproval = approval() as unknown as Record<string, unknown>;
		configureApprovalStore(deps, storedApproval);
		const repointedInstance = {
			...targetInstance,
			baseUrl: "http://replacement-sonarr.internal:8989",
			updatedAt: new Date("2026-07-27T13:00:00.000Z"),
		};
		let arrInstanceReads = 0;
		vi.mocked(deps.prisma.serviceInstance.findMany).mockImplementation(
			(args) =>
				(args?.where?.service === "PLEX"
					? Promise.resolve([
							{
								id: "plex-1",
								userId: "user-1",
								service: "PLEX",
								label: "Plex",
								baseUrl: "http://plex.internal:32400",
								enabled: true,
								encryptedApiKey: "encrypted",
								encryptionIv: "iv",
							},
						])
					: Promise.resolve([
							++arrInstanceReads === 1 ? targetInstance : repointedInstance,
						])) as never,
		);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("ARR target changed during live verification");
		expect(bulkDelete).not.toHaveBeenCalled();
		expect(deleteSeries).not.toHaveBeenCalled();
		expect(storedApproval).toMatchObject({ status: "expired", executionToken: null });
	});

	it("expires an approved Sonarr mutation when a sibling instance appears after preflight", async () => {
		const { deps, targetInstance, bulkDelete, deleteSeries } = makeSonarrDeps();
		const storedApproval = approval() as unknown as Record<string, unknown>;
		configureApprovalStore(deps, storedApproval);
		const siblingInstance = {
			...targetInstance,
			id: "sonarr-hd",
			label: "HD Sonarr",
			baseUrl: "http://sonarr-hd.internal:8989",
		};
		let arrInstanceReads = 0;
		vi.mocked(deps.prisma.serviceInstance.findMany).mockImplementation(
			(args) =>
				(args?.where?.service === "PLEX"
					? Promise.resolve([
							{
								id: "plex-1",
								userId: "user-1",
								service: "PLEX",
								label: "Plex",
								baseUrl: "http://plex.internal:32400",
								enabled: true,
								encryptedApiKey: "encrypted",
								encryptionIv: "iv",
							},
						])
					: Promise.resolve(
							++arrInstanceReads === 1 ? [targetInstance] : [targetInstance, siblingInstance],
						)) as never,
		);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain(
			"another configured Sonarr instance may access the same storage",
		);
		expect(bulkDelete).not.toHaveBeenCalled();
		expect(deleteSeries).not.toHaveBeenCalled();
		expect(storedApproval).toMatchObject({ status: "expired", executionToken: null });
	});

	it("durably retries direct shared-Sonarr record deletion after exact file removal", async () => {
		const fixture = makeSonarrDeps({
			onSeriesDelete: true,
			onEpisodeFileDelete: true,
		});
		const peer = addSonarrPeer(fixture);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
			{
				ratingKey: "show-123",
				episodes: [...fixture.episodeFiles, ...peer.episodeFiles].map((file, index) => ({
					ratingKey: `episode-${index + 1}`,
					parts: [{ file: file.path!, size: file.size! }],
				})),
			},
		]);
		const { deps, episodeFiles, bulkDelete, deleteSeries } = fixture;
		const retries = configureRetryStore(deps);
		deleteSeries
			.mockRejectedValueOnce(new Error("series delete unavailable"))
			.mockRejectedValueOnce(new Error("series delete unavailable"));
		const flaggedItem = {
			cacheItem: {
				instanceId: "sonarr-4k",
				arrItemId: 201,
				itemType: "series",
				title: "Example Series",
				year: 2024,
				hasFile: true,
				cachedAt: new Date("2026-07-27T12:05:00.000Z"),
				sizeOnDisk: 4_003n,
				data: JSON.stringify({
					_arrDashboardSource: {
						serviceFingerprint: sonarrServiceFingerprint,
					},
					path: "/tv-4k/Example Series",
					remoteIds: { tvdbId: 123 },
				}),
			},
			match: {
				ruleId: "rule-1",
				ruleName: "Large series cleanup",
				reason: "Matched size rule",
				action: "delete",
			},
			rating: 8,
		} as never;
		const config = { id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never;

		const firstResult = await executeDirectRemoval(
			deps,
			config,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);
		const retryResult = await executeDirectRemoval(deps, config, "user-1", [], 0, 0, Date.now());

		expect(firstResult).toMatchObject({
			status: "partial",
			itemsRemoved: 0,
			itemsFilesDeleted: 1,
		});
		expect(retries).toHaveLength(1);
		expect(retries[0]).toMatchObject({
			status: "executed",
			safetySnapshot: expect.any(String),
		});
		expect(JSON.parse(retries[0]!.safetySnapshot as string)).toMatchObject({
			kind: "verified_sonarr",
			files: { episodeFiles: [] },
			peers: [expect.objectContaining({ instanceId: "sonarr-hd" })],
			ownership: [
				expect.objectContaining({
					retained: [expect.objectContaining({ instanceId: "sonarr-hd" })],
				}),
			],
		});
		expect(retryResult).toMatchObject({
			status: "completed",
			itemsRemoved: 1,
			itemsFlagged: 1,
		});
		expect(bulkDelete).toHaveBeenCalledOnce();
		expect(bulkDelete).toHaveBeenCalledWith(episodeFiles.map((file) => file.id));
		expect(deleteSeries).toHaveBeenCalledTimes(3);
	});

	it("durably retries direct no-peer Sonarr record deletion after exact file removal", async () => {
		const fixture = makeSonarrDeps({ onSeriesDelete: true, onEpisodeFileDelete: true });
		const retries = configureRetryStore(fixture.deps);
		fixture.deleteSeries
			.mockRejectedValueOnce(new Error("series delete unavailable"))
			.mockRejectedValueOnce(new Error("series delete unavailable"));
		const flaggedItem = {
			cacheItem: {
				instanceId: "sonarr-4k",
				arrItemId: 201,
				itemType: "series",
				title: "Example Series",
				year: 2024,
				hasFile: true,
				cachedAt: new Date("2026-07-27T12:05:00.000Z"),
				sizeOnDisk: 4_003n,
				data: JSON.stringify({
					_arrDashboardSource: { serviceFingerprint: sonarrServiceFingerprint },
					path: "/tv-4k/Example Series",
					remoteIds: { tvdbId: 123 },
				}),
			},
			match: {
				ruleId: "rule-1",
				ruleName: "Large series cleanup",
				reason: "Matched size rule",
				action: "delete",
			},
			rating: 8,
		} as never;
		const config = { id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never;

		const firstResult = await executeDirectRemoval(
			fixture.deps,
			config,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);
		const retryResult = await executeDirectRemoval(
			fixture.deps,
			config,
			"user-1",
			[],
			0,
			0,
			Date.now(),
		);

		expect(firstResult).toMatchObject({ status: "partial", itemsFilesDeleted: 1 });
		expect(retries).toHaveLength(1);
		expect(JSON.parse(retries[0]!.safetySnapshot as string)).toMatchObject({
			kind: "verified_sonarr",
			files: { episodeFiles: [] },
			peers: [],
			peerInventoryComplete: true,
			ownership: [expect.objectContaining({ retained: [] })],
		});
		expect(retryResult).toMatchObject({ status: "completed", itemsRemoved: 1 });
		expect(fixture.bulkDelete).toHaveBeenCalledOnce();
		expect(fixture.deleteSeries).toHaveBeenCalledTimes(3);
	});

	it("blocks direct deletion when a Sonarr peer appears at the mutation boundary", async () => {
		const fixture = makeSonarrDeps();
		const retries = configureRetryStore(fixture.deps);
		let peerAdded = false;
		vi.mocked(fixture.deps.prisma.crossDomainRule.findMany).mockImplementation((async () => {
			if (!peerAdded) {
				peerAdded = true;
				addSonarrPeer(fixture, {
					seriesPath: fixture.series.path,
					episodeFiles: [
						{
							id: 4001,
							path: fixture.episodeFiles[0]!.path!,
							relativePath: fixture.episodeFiles[0]!.relativePath!,
							size: fixture.episodeFiles[0]!.size!,
						},
					],
				});
			}
			return [];
		}) as never);
		const flaggedItem = {
			cacheItem: {
				instanceId: "sonarr-4k",
				arrItemId: 201,
				itemType: "series",
				title: "Example Series",
				year: 2024,
				hasFile: true,
				cachedAt: new Date("2026-07-27T12:05:00.000Z"),
				sizeOnDisk: 4_003n,
				data: JSON.stringify({
					_arrDashboardSource: { serviceFingerprint: sonarrServiceFingerprint },
					path: "/tv-4k/Example Series",
					remoteIds: { tvdbId: 123 },
				}),
			},
			match: {
				ruleId: "rule-1",
				ruleName: "Large series cleanup",
				reason: "Matched size rule",
				action: "delete",
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			fixture.deps,
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(peerAdded).toBe(true);
		expect(retries).toHaveLength(1);
		expect(result).toMatchObject({ itemsFilesDeleted: 0, itemsRemoved: 0 });
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("removes an empty verified series without issuing a bulk file deletion", async () => {
		const { deps, targetClient, bulkDelete, deleteSeries } = makeSonarrDeps({
			episodeFiles: [],
			plexSeries: [],
		});
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approval("delete", []),
		] as never);
		targetClient.episodeFile.getBySeries.mockResolvedValue([]);

		await expect(executeApprovedItems(deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(bulkDelete).not.toHaveBeenCalled();
		expect(deleteSeries).toHaveBeenCalledWith(201, {
			deleteFiles: false,
			addImportListExclusion: false,
		});
	});

	it("blocks queued fileless record deletion when a Plex series-delete notification appears", async () => {
		const fixture = makeSonarrDeps({
			notificationKind: "none",
			episodeFiles: [],
			plexSeries: [],
		});
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approval("delete", [], []),
		] as never);
		fixture.targetClient.notification.getAll.mockResolvedValueOnce([]).mockResolvedValue([
			{
				implementation: "PlexServer",
				configContract: "PlexServerSettings",
				onSeriesDelete: true,
				onEpisodeFileDelete: true,
				tags: [],
				fields: notificationFields({
					mapFrom: "/tv-4k",
					mapTo: "/plex/tv-4k",
				}),
			},
		]);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("blocks queued record deletion when a Plex series-delete notification appears after file removal", async () => {
		const fixture = makeSonarrDeps({ notificationKind: "none" });
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approval("delete", undefined, []),
		] as never);
		fixture.targetClient.notification.getAll
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValue([
				{
					implementation: "PlexServer",
					configContract: "PlexServerSettings",
					onSeriesDelete: true,
					onEpisodeFileDelete: true,
					tags: [],
					fields: notificationFields({
						mapFrom: "/tv-4k",
						mapTo: "/plex/tv-4k",
					}),
				},
			]);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.bulkDelete).toHaveBeenCalledOnce();
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3001, 3002]);
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("blocks direct fileless record deletion when a Plex series-delete notification appears", async () => {
		const fixture = makeSonarrDeps({
			notificationKind: "none",
			episodeFiles: [],
			plexSeries: [],
		});
		fixture.targetClient.notification.getAll.mockResolvedValueOnce([]).mockResolvedValue([
			{
				implementation: "PlexServer",
				configContract: "PlexServerSettings",
				onSeriesDelete: true,
				onEpisodeFileDelete: true,
				tags: [],
				fields: notificationFields({
					mapFrom: "/tv-4k",
					mapTo: "/plex/tv-4k",
				}),
			},
		]);
		const flaggedItem = {
			cacheItem: {
				instanceId: "sonarr-4k",
				arrItemId: 201,
				itemType: "series",
				title: "Example Series",
				year: 2024,
				hasFile: false,
				cachedAt: new Date("2026-07-27T12:05:00.000Z"),
				sizeOnDisk: 0n,
				data: JSON.stringify({
					_arrDashboardSource: { serviceFingerprint: sonarrServiceFingerprint },
					path: "/tv-4k/Example Series",
					remoteIds: { tvdbId: 123 },
				}),
			},
			match: {
				ruleId: "rule-1",
				ruleName: "Large series cleanup",
				reason: "Matched size rule",
				action: "delete",
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			fixture.deps,
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(result).toMatchObject({ itemsFilesDeleted: 0, itemsRemoved: 0 });
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it.each(["delete", "delete_files"] as const)(
		"does not mutate %s for a stored fileless plan that omits a live sibling Sonarr",
		async (action) => {
			const fixture = makeSonarrDeps({
				action,
				notificationKind: "none",
				episodeFiles: [],
			});
			const peer = addSonarrPeer(fixture);
			vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
				approval(action, [], []),
			] as never);

			await expect(
				executeApprovedItems(fixture.deps, "user-1", ["approval-1"]),
			).resolves.toMatchObject({
				removed: 0,
				failed: action === "delete" ? 1 : 0,
			});
			expect(fixture.bulkDelete).not.toHaveBeenCalled();
			expect(fixture.deleteSeries).toHaveBeenCalledTimes(0);
			expect(peer.peerClient.series.getAll).toHaveBeenCalledTimes(0);
		},
	);

	it("accepts a lost Sonarr record-delete response after a not-found readback", async () => {
		const { deps, targetClient, episodeFiles, deleteSeries, setLiveSeriesExists } =
			makeSonarrDeps();
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([approval()] as never);
		targetClient.episodeFile.getBySeries
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce(episodeFiles)
			.mockResolvedValueOnce([]);
		deleteSeries.mockImplementationOnce(async () => {
			setLiveSeriesExists(false);
			throw new Error("response lost");
		});

		await expect(executeApprovedItems(deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(deleteSeries).toHaveBeenCalledOnce();
	});
});
