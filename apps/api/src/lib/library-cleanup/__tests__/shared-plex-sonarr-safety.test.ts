import { NotFoundError } from "arr-sdk";
import { describe, expect, it, vi } from "vitest";
import { PlexSeriesNotFoundError } from "../../plex/plex-client.js";
import { plexConnectionFingerprint } from "../../plex/service-instance-fingerprint.js";
import {
	CleanupRunLeaseLostError,
	executeApprovedItems,
	executeCleanupPreview,
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
				findMany: vi.fn(({ where }: { where: { service: string } }) =>
					where.service === "PLEX"
						? Promise.resolve([plexInstance])
						: where.service === "QUI"
							? Promise.resolve([quiInstance])
							: Promise.resolve([targetInstance]),
				),
				findFirst: vi.fn().mockResolvedValue(targetInstance),
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
				findFirst: vi.fn().mockResolvedValue({ infoHash: "episode-hash", torrentState: "paused" }),
				deleteMany: episodeFileCacheDeleteMany,
			},
			plexEpisodeCache: {
				findMany: vi.fn().mockImplementation(
					(({ where }: { where: { episodeNumber: number } }) =>
						Promise.resolve([
							{
								instanceId: plexInstance.id,
								ratingKey: `episode-${where.episodeNumber}`,
								watchCount: 1,
								refreshedAt: new Date(),
								sourceFingerprint: plexConnectionFingerprint(plexInstance),
							},
						])) as never,
				),
				findFirst: vi.fn().mockResolvedValue({
					watchCount: 1,
					refreshedAt: new Date(),
					sourceFingerprint: plexConnectionFingerprint(plexInstance),
				}),
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
		});
	});

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

	it("blocks when the live Plex episode count dropped after cache refresh", async () => {
		const fixture = makeSonarrDeps({ livePlexWatchCount: 0 });
		const episodeTarget = exactEpisodeTarget();

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget]);

		expect(blocks.get(cleanupDeleteTargetKey(episodeTarget))).toContain(
			"watched Plex episode could not be mapped",
		);
		expect(fixture.getEpisodeWatchCount).toHaveBeenCalledWith("episode-1");
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
	});

	it("accepts the configured account count when it still proves the evidence", async () => {
		const fixture = makeSonarrDeps();

		await expect(
			findSharedPlexDeleteBlocks(fixture.deps, "user-1", [exactEpisodeTarget()]),
		).resolves.toEqual(new Map());

		expect(fixture.getEpisodeWatchCount).toHaveBeenCalledWith("episode-1");
	});

	it.each([
		["disabled", { enable: false, onSeriesDelete: false, onEpisodeFileDelete: true }],
		["series-only", { enable: true, onSeriesDelete: true, onEpisodeFileDelete: false }],
	])(
		"does not let a %s Plex notification mapping authorize episode file deletion",
		async (_label, notificationState) => {
			const fixture = makeSonarrDeps();
			Object.assign(fixture.notification, notificationState);
			const episodeTarget = exactEpisodeTarget();

			const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget]);

			expect(blocks.get(cleanupDeleteTargetKey(episodeTarget))).toContain(
				"watched Plex episode could not be mapped",
			);
			expect(fixture.bulkDelete).not.toHaveBeenCalled();
		},
	);

	it("blocks when the watched Plex rating key belongs to a different physical copy", async () => {
		const fixture = makeSonarrDeps({
			plexSeries: [
				{
					ratingKey: "show-123",
					episodes: [
						{
							ratingKey: "episode-1",
							parts: [
								{
									file: "/other-copy/Example.S01E01.mkv",
									size: 2_001,
								},
							],
						},
						{
							ratingKey: "episode-2",
							parts: [
								{
									file: "/tv-4k/Example Series/Season 01/Example.S01E01.2160p.mkv",
									size: 2_001,
								},
							],
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
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
	});

	it("rejects unchanged episode evidence after its Plex service is repointed", async () => {
		const fixture = makeSonarrDeps();
		fixture.plexInstance.baseUrl = "http://replacement-plex.internal:32400";
		fixture.plexInstance.updatedAt = new Date(Date.now() - 30 * 60 * 1000);

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [exactEpisodeTarget()]);

		expect([...blocks.values()][0]).toContain("watched Plex episode could not be mapped");
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("blocks an exact episode target whose file is now seeding in qUI", async () => {
		const fixture = makeSonarrDeps();
		vi.mocked(fixture.deps.prisma.episodeFileCache.findFirst).mockResolvedValue({
			infoHash: "abc",
			torrentState: "seeding",
		} as never);
		const episodeTarget = exactEpisodeTarget();

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget]);
		expect(blocks.get(cleanupDeleteTargetKey(episodeTarget))).toContain(
			"exact Sonarr episode files",
		);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
	});

	it("allows an exact episode with no qUI torrent ownership", async () => {
		const fixture = makeSonarrDeps();
		vi.mocked(fixture.deps.prisma.episodeFileCache.findFirst).mockResolvedValue({
			infoHash: null,
			torrentState: null,
		} as never);
		vi.mocked(fixture.deps.quiFileHashIndexFactory!).mockResolvedValue({
			resolve: vi.fn().mockResolvedValue({ hashes: [], complete: true }),
		});
		const episodeTarget = {
			...exactEpisodeTarget(),
			episodeFileInfoHash: null,
			episodeFileTorrentState: null,
		};

		await expect(
			findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget]),
		).resolves.toEqual(new Map());
		expect(fixture.deps.quiClientFactory).not.toHaveBeenCalled();
	});

	it("treats respect-qUI as a no-op when no qUI instance exists", async () => {
		const fixture = makeSonarrDeps();
		vi.mocked(fixture.deps.prisma.episodeFileCache.findFirst).mockResolvedValue({
			infoHash: "episode-hash",
			torrentState: "seeding",
		} as never);
		vi.mocked(fixture.deps.prisma.serviceInstance.findMany).mockImplementation(
			(args) =>
				(args?.where?.service === "PLEX"
					? Promise.resolve([fixture.plexInstance])
					: args?.where?.service === "QUI"
						? Promise.resolve([])
						: Promise.resolve([fixture.targetInstance])) as never,
		);

		await expect(
			findSharedPlexDeleteBlocks(fixture.deps, "user-1", [
				{ ...exactEpisodeTarget(), episodeFileTorrentState: "seeding" },
			]),
		).resolves.toEqual(new Map());
		expect(fixture.deps.quiFileHashIndexFactory).not.toHaveBeenCalled();
		expect(fixture.deps.quiClientFactory).not.toHaveBeenCalled();
	});

	it("does not let stale cached qUI state suppress episode discovery after the last instance is removed", async () => {
		const fixture = makeSonarrDeps();
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			userId: "user-1",
			enabled: true,
			dryRunMode: true,
			requireApproval: false,
			maxRemovalsPerRun: 10,
			respectQuiSeeding: true,
			rules: [episodeCleanupRule()],
		} as never);
		vi.mocked(fixture.deps.prisma.serviceInstance.findMany).mockImplementation(
			(args) =>
				(args?.where?.service === "PLEX"
					? Promise.resolve([fixture.plexInstance])
					: args?.where?.service === "QUI"
						? Promise.resolve([])
						: args?.where?.service
							? Promise.resolve([fixture.targetInstance])
							: Promise.resolve([fixture.targetInstance, fixture.plexInstance])) as never,
		);
		vi.mocked(fixture.deps.prisma.plexEpisodeCache.findMany).mockResolvedValue([
			{
				instanceId: "plex-1",
				showTmdbId: 456,
				seasonNumber: 1,
				episodeNumber: 1,
				watchCount: 1,
				lastWatchedAt: new Date(),
				watchedByUsers: JSON.stringify(["Owner"]),
				ratingKey: "episode-1",
				refreshedAt: new Date(),
				sourceFingerprint: PLEX_SOURCE_FINGERPRINT,
			},
		] as never);
		vi.mocked(fixture.deps.prisma.episodeFileCache.findMany).mockResolvedValue(
			fixture.episodeFiles.map((file, index) => ({
				arrEpisodeFileId: file.id,
				path: file.path,
				size: BigInt(file.size!),
				infoHash: index === 0 ? "stale-episode-hash" : null,
				torrentState: index === 0 ? "seeding" : null,
			})) as never,
		);
		vi.mocked(fixture.deps.prisma.episodeFileCache.findFirst).mockResolvedValue({
			infoHash: "stale-episode-hash",
			torrentState: "seeding",
		} as never);
		vi.mocked(fixture.deps.prisma.libraryCache.findMany)
			.mockResolvedValueOnce([
				{
					id: "series-cache-1",
					instanceId: "sonarr-4k",
					arrItemId: 201,
					itemType: "series",
					title: "Example Series",
					year: 2024,
					monitored: true,
					hasFile: true,
					status: "continuing",
					qualityProfileId: 1,
					qualityProfileName: "4K",
					sizeOnDisk: 4_003n,
					arrAddedAt: new Date("2025-01-01T00:00:00.000Z"),
					cachedAt: new Date(),
					data: JSON.stringify({
						remoteIds: { tvdbId: 123, tmdbId: 456 },
						path: "/tv-4k/Example Series",
						_arrDashboardSource: {
							serviceFingerprint: sonarrServiceFingerprint,
						},
					}),
					torrentState: "seeding",
					infoHash: "stale-series-hash",
				},
			] as never)
			.mockResolvedValueOnce([]);

		const result = await executeCleanupPreview(fixture.deps, "user-1");

		expect(result).toMatchObject({ itemsEvaluated: 2, itemsFlagged: 1 });
		expect(result.details).toEqual([
			expect.objectContaining({
				targetScope: "episode",
				arrEpisodeId: 9_001,
				action: "delete",
			}),
		]);
		expect(fixture.deps.quiFileHashIndexFactory).not.toHaveBeenCalled();
		expect(fixture.deps.quiClientFactory).not.toHaveBeenCalled();
	});

	it("reuses one complete qUI inode snapshot across episode paths in a safety operation", async () => {
		const fixture = makeSonarrDeps();
		const first = exactEpisodeTarget();
		const second = {
			...exactEpisodeTarget(),
			arrEpisodeId: 9_002,
			episodeNumber: 2,
			episodeFileId: 3_002,
			episodeFileConsumerIds: [9_002],
			plexWatchEvidence: [
				{
					...exactEpisodeTarget().plexWatchEvidence[0]!,
					ratingKey: "episode-2",
				},
			],
		};

		await expect(
			findSharedPlexDeleteBlocks(fixture.deps, "user-1", [first, second]),
		).resolves.toEqual(new Map());

		expect(fixture.deps.quiFileHashIndexFactory).toHaveBeenCalledTimes(1);
		const index = await vi.mocked(fixture.deps.quiFileHashIndexFactory!).mock.results[0]!.value;
		expect(index.resolve).toHaveBeenCalledTimes(2);
	});

	it.each(["active", "error"] as const)(
		"fails closed when the fresh exact-hash qUI view is %s",
		async (mode) => {
			const fixture = makeSonarrDeps();
			vi.mocked(fixture.deps.quiClientFactory!).mockReturnValue({
				getTorrentsByHash:
					mode === "active"
						? vi.fn().mockResolvedValue([{ hash: "episode-hash", state: "stalledUP" }])
						: vi.fn().mockRejectedValue(new Error("qUI unavailable")),
			} as never);
			const episodeTarget = exactEpisodeTarget();

			const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget]);

			expect(blocks.get(cleanupDeleteTargetKey(episodeTarget))).toContain(
				"exact Sonarr episode files",
			);
			expect(fixture.bulkDelete).not.toHaveBeenCalled();
			expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		},
	);

	it("blocks when any duplicate exact-hash torrent is active", async () => {
		const fixture = makeSonarrDeps();
		vi.mocked(fixture.deps.quiClientFactory!).mockReturnValue({
			getTorrentsByHash: vi.fn().mockResolvedValue([
				{ hash: "episode-hash", state: "pausedUP" },
				{ hash: "episode-hash", state: "stalledUP" },
			]),
		} as never);

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [exactEpisodeTarget()]);

		expect([...blocks.values()][0]).toContain("exact Sonarr episode files");
	});

	it("blocks when a different-hash physical-file sibling is active", async () => {
		const fixture = makeSonarrDeps();
		vi.mocked(fixture.deps.quiFileHashIndexFactory!).mockResolvedValue({
			resolve: vi.fn().mockResolvedValue({
				hashes: ["episode-hash", "cross-seed-hash"],
				complete: true,
			}),
		});
		vi.mocked(fixture.deps.quiClientFactory!).mockReturnValue({
			getTorrentsByHash: vi.fn(async (hash: string) => [
				{
					hash,
					state: hash === "cross-seed-hash" ? "stalledUP" : "pausedUP",
				},
			]),
		} as never);

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [exactEpisodeTarget()]);

		expect([...blocks.values()][0]).toContain("exact Sonarr episode files");
	});

	it("suppresses episode candidates when the parent series already matches", async () => {
		const fixture = makeSonarrDeps();
		const seriesRule = {
			...episodeCleanupRule("unmonitor"),
			id: "series-rule",
			name: "Unmonitor old series",
			priority: 1,
			targetScope: "series",
			ruleType: "age",
			parameters: JSON.stringify({ operator: "older_than", days: 1 }),
		};
		const episodeRule = { ...episodeCleanupRule(), priority: 2 };
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			userId: "user-1",
			enabled: true,
			dryRunMode: true,
			requireApproval: false,
			maxRemovalsPerRun: 10,
			respectQuiSeeding: true,
			rules: [seriesRule, episodeRule],
		} as never);
		vi.mocked(fixture.deps.prisma.serviceInstance.findMany).mockImplementation(
			(args) =>
				(args?.where?.service === "PLEX"
					? Promise.resolve([fixture.plexInstance])
					: args?.where?.service === "QUI"
						? Promise.resolve([fixture.quiInstance])
						: args?.where?.service
							? Promise.resolve([fixture.targetInstance])
							: Promise.resolve([
									fixture.targetInstance,
									fixture.plexInstance,
									fixture.quiInstance,
								])) as never,
		);
		vi.mocked(fixture.deps.prisma.plexEpisodeCache.findMany).mockResolvedValue([
			{
				instanceId: "plex-1",
				showTmdbId: 456,
				seasonNumber: 1,
				episodeNumber: 1,
				watchCount: 1,
				lastWatchedAt: new Date(),
				watchedByUsers: JSON.stringify(["Owner"]),
				ratingKey: "episode-1",
				refreshedAt: new Date(),
				sourceFingerprint: PLEX_SOURCE_FINGERPRINT,
			},
		] as never);
		vi.mocked(fixture.deps.prisma.libraryCache.findMany)
			.mockResolvedValueOnce([
				{
					id: "series-cache-1",
					instanceId: "sonarr-4k",
					arrItemId: 201,
					itemType: "series",
					title: "Example Series",
					year: 2024,
					monitored: true,
					hasFile: true,
					status: "continuing",
					qualityProfileId: 1,
					qualityProfileName: "4K",
					sizeOnDisk: 4_003n,
					arrAddedAt: new Date("2025-01-01T00:00:00.000Z"),
					cachedAt: new Date(),
					data: JSON.stringify({
						remoteIds: { tvdbId: 123, tmdbId: 456 },
						path: "/tv-4k/Example Series",
						_arrDashboardSource: {
							serviceFingerprint: sonarrServiceFingerprint,
						},
					}),
					torrentState: null,
					infoHash: null,
				},
			] as never)
			.mockResolvedValueOnce([]);
		fixture.targetClient.episode.getAll.mockClear();

		const result = await executeCleanupPreview(fixture.deps, "user-1");

		expect(result).toMatchObject({ itemsEvaluated: 1, itemsFlagged: 1 });
		expect(result.details).toHaveLength(1);
		expect(fixture.targetClient.episode.getAll).not.toHaveBeenCalled();
	});

	it("fails closed when a Sonarr file is consumed by multiple episodes", async () => {
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
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
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
		action: "delete" | "delete_files" | "unmonitor" = "delete",
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
			matchedRuleId: action === "delete" ? "episode-rule" : `episode-rule-${action}`,
			matchedRuleName: "Remove watched episodes",
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
				ownership: [],
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

	function addSecondPlexPolicySource(
		fixture: ReturnType<typeof makeSonarrDeps>,
		options: {
			enabled?: boolean;
			liveWatchCount?: number;
			mediaPath?: string;
			staleCache?: boolean;
			includeNotification?: boolean;
		} = {},
	) {
		const secondPlexInstance = {
			...fixture.plexInstance,
			id: "plex-2",
			label: "Second Plex",
			baseUrl: "http://plex-2.internal:32400",
			encryptedApiKey: "encrypted-2",
			enabled: options.enabled ?? true,
		};
		const secondGetSeriesEpisodeMediaPartsByTvdbId = vi.fn().mockResolvedValue([
			{
				ratingKey: "second-show-123",
				episodes: [
					{
						ratingKey: "second-episode-1",
						parts: [
							{
								file:
									options.mediaPath ??
									"/tv-4k/Example Series/Season 01/Example.S01E01.2160p.mkv",
								size: 2_001,
							},
						],
					},
					{
						ratingKey: "second-episode-2",
						parts: [
							{
								file:
									"/tv-4k/Example Series/Season 01/Example.S01E02.2160p.mkv",
								size: 2_002,
							},
						],
					},
				],
			},
		]);
		const secondGetEpisodeWatchCount = vi
			.fn()
			.mockResolvedValue(options.liveWatchCount ?? 10);
		const plexFactory = vi.mocked(fixture.deps.plexClientFactory!);
		const primaryClient = plexFactory(fixture.plexInstance as never);
		plexFactory.mockClear();
		plexFactory.mockImplementation((instance) =>
			instance.id === secondPlexInstance.id
				? {
						getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Owner" }]),
						getMovieMediaPartsByTmdbId: vi.fn(),
						getSeriesEpisodeMediaPartsByTvdbId:
							secondGetSeriesEpisodeMediaPartsByTvdbId,
						getEpisodeWatchCount: secondGetEpisodeWatchCount,
					}
				: primaryClient,
		);
		vi.mocked(fixture.deps.prisma.serviceInstance.findMany).mockImplementation(
			((args: { where: { service: string } }) =>
				args.where.service === "PLEX"
					? Promise.resolve([fixture.plexInstance, secondPlexInstance])
					: args.where.service === "QUI"
						? Promise.resolve([fixture.quiInstance])
						: Promise.resolve([fixture.targetInstance])) as never,
		);
		vi.mocked(fixture.deps.prisma.plexEpisodeCache.findMany).mockImplementation(
			(({ where }: { where: { instanceId: { in: string[] } } }) =>
				Promise.resolve([
					{
						instanceId: fixture.plexInstance.id,
						ratingKey: "episode-1",
						watchCount: 1,
						refreshedAt: new Date(),
						sourceFingerprint: plexConnectionFingerprint(fixture.plexInstance),
					},
					...(where.instanceId.in.includes(secondPlexInstance.id)
						? [
								{
									instanceId: secondPlexInstance.id,
									ratingKey: "second-episode-1",
									watchCount: 1,
									refreshedAt: options.staleCache
										? new Date("2020-01-01T00:00:00.000Z")
										: new Date(),
									sourceFingerprint: plexConnectionFingerprint(secondPlexInstance),
								},
							]
						: []),
				])) as never,
		);
		const secondNotification = {
			...fixture.notification,
			fields: fixture.notification.fields.map((field) =>
				field.name === "host" ? { ...field, value: "plex-2.internal" } : field,
			),
		};
		fixture.targetClient.notification.getAll.mockResolvedValue(
			options.includeNotification === false
				? [fixture.notification]
				: [fixture.notification, secondNotification],
		);
		return {
			secondPlexInstance,
			secondGetEpisodeWatchCount,
			secondGetSeriesEpisodeMediaPartsByTvdbId,
		};
	}

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

	it("uses the Sonarr-to-Plex path mapping when revalidating an episode unmonitor", async () => {
		const fixture = makeSonarrDeps({
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
		const episodeTarget = { ...exactEpisodeTarget(), action: "unmonitor" as const };
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [episodeCleanupRule("unmonitor")],
		} as never);
		const storedApproval = {
			...approval("unmonitor"),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledWith([9_001], false);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.episodeFileCacheDeleteMany).not.toHaveBeenCalled();
	});

	it("reconciles an episode unmonitor whose successful Sonarr response was lost", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = { ...exactEpisodeTarget(), action: "unmonitor" as const };
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		fixture.setEpisodeMonitored.mockImplementation(async (episodeIds, monitored) => {
			for (const episodeId of episodeIds) {
				fixture.setLiveEpisodeMonitored(episodeId, monitored);
			}
			throw new Error("Sonarr response timed out");
		});
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [episodeCleanupRule("unmonitor")],
		} as never);
		const storedApproval = {
			...approval("unmonitor"),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(storedApproval).toMatchObject({ status: "executed" });
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledWith([9_001], false);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("keeps an unconfirmed episode unmonitor retryable until Sonarr can be read back", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = { ...exactEpisodeTarget(), action: "unmonitor" as const };
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		const liveEpisodes = await fixture.targetClient.episode.getAll();
		let unmonitorAttempted = false;
		fixture.setEpisodeMonitored.mockImplementation(async () => {
			unmonitorAttempted = true;
			throw new Error("Sonarr response timed out");
		});
		fixture.targetClient.episode.getAll.mockImplementation(async () => {
			if (unmonitorAttempted) throw new Error("Sonarr readback unavailable");
			return liveEpisodes;
		});
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [episodeCleanupRule("unmonitor")],
		} as never);
		const storedApproval = {
			...approval("unmonitor"),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const firstAttempt = await executeApprovedItems(
			fixture.deps,
			"user-1",
			["approval-1"],
		);

		expect(firstAttempt).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({
			status: "retry_pending",
			lastExecutionError: expect.stringContaining("could not confirm"),
		});
		expect(fixture.bulkDelete).not.toHaveBeenCalled();

		unmonitorAttempted = false;
		fixture.targetClient.episode.getAll.mockResolvedValue(liveEpisodes);
		fixture.setEpisodeMonitored.mockImplementation(async (episodeIds, monitored) => {
			for (const episodeId of episodeIds) {
				fixture.setLiveEpisodeMonitored(episodeId, monitored);
			}
		});
		const retry = await executeRetryItems(fixture.deps, "user-1", ["approval-1"]);

		expect(retry).toMatchObject({ removed: 1, failed: 0 });
		expect(storedApproval).toMatchObject({ status: "executed" });
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("treats an omitted Sonarr monitored readback as an unknown unmonitor outcome", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = { ...exactEpisodeTarget(), action: "unmonitor" as const };
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		const liveEpisodes = await fixture.targetClient.episode.getAll();
		fixture.setEpisodeMonitored.mockImplementation(async () => {
			const selected = liveEpisodes.find((episode) => episode.id === 9_001);
			if (selected) delete (selected as Record<string, unknown>).monitored;
			throw new Error("Sonarr response timed out");
		});
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [episodeCleanupRule("unmonitor")],
		} as never);
		const storedApproval = {
			...approval("unmonitor"),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({
			status: "retry_pending",
			lastExecutionError: expect.stringContaining("could not confirm"),
		});
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("keeps an already-unmonitored episode retry durable across a new verified Plex mapping", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		const liveEpisodes = await fixture.targetClient.episode.getAll();
		let unmonitorAttempted = false;
		fixture.setEpisodeMonitored.mockImplementation(async (episodeIds, monitored) => {
			for (const episodeId of episodeIds) {
				fixture.setLiveEpisodeMonitored(episodeId, monitored);
			}
			unmonitorAttempted = true;
			throw new Error("Sonarr response timed out");
		});
		fixture.targetClient.episode.getAll.mockImplementation(async () => {
			if (unmonitorAttempted) throw new Error("Sonarr readback unavailable");
			return liveEpisodes;
		});
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [episodeCleanupRule()],
		} as never);
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const firstAttempt = await executeApprovedItems(
			fixture.deps,
			"user-1",
			["approval-1"],
		);

		expect(firstAttempt).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({ status: "retry_pending" });
		expect(fixture.bulkDelete).not.toHaveBeenCalled();

		fixture.notification.fields.push(
			{ name: "mapFrom", value: "/tv-4k" },
			{ name: "mapTo", value: "/plex/tv-4k" },
		);
		fixture.getSeriesEpisodeMediaPartsByTvdbId.mockResolvedValue([
			{
				ratingKey: "show-123",
				episodes: fixture.episodeFiles.map((file, index) => ({
					ratingKey: `episode-${index + 1}`,
					parts: [
						{
							file: file.path!.replace("/tv-4k", "/plex/tv-4k"),
							size: file.size!,
						},
					],
				})),
			},
		]);
		fixture.targetClient.episode.getAll.mockResolvedValue(liveEpisodes);
		fixture.setEpisodeMonitored.mockResolvedValue(undefined);

		const retry = await executeRetryItems(fixture.deps, "user-1", ["approval-1"]);

		expect(retry).toMatchObject({ removed: 1, failed: 0, errors: [] });
		expect(storedApproval).toMatchObject({ status: "executed" });
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3_001]);
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it.each([
		["unmonitor", false],
		["delete", true],
		["delete_files", true],
	] as const)(
		"uses a non-file-delete Plex mapping for episode %s only when no file is removed",
		async (action, shouldBlock) => {
			const fixture = makeSonarrDeps({
				onSeriesDelete: true,
				onEpisodeFileDelete: false,
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
			const episodeTarget = { ...exactEpisodeTarget(), action };
			const context = createSharedPlexSafetyContext();

			const blocks = await findSharedPlexDeleteBlocks(
				fixture.deps,
				"user-1",
				[episodeTarget],
				context,
			);

			if (shouldBlock) {
				expect(blocks.get(cleanupDeleteTargetKey(episodeTarget))).toContain(
					"watched Plex episode could not be mapped",
				);
				expect(context.plans.get(cleanupDeleteTargetKey(episodeTarget))).toMatchObject({
					kind: "blocked",
				});
			} else {
				expect(blocks).toEqual(new Map());
				expect(context.plans.get(cleanupDeleteTargetKey(episodeTarget))).toMatchObject({
					kind: "verified_sonarr_episode",
					targetDeleteNotifications: [],
				});
			}
		},
	);

	it.each([
		["deleted", null],
		["disabled", { enabled: false }],
		["action changed", { action: "delete_files" }],
		["threshold raised", { parameters: JSON.stringify({ operator: "greater_than", count: 1 }) }],
		["instance excluded", { instanceFilter: JSON.stringify(["another-sonarr"]) }],
	] as const)(
		"expires an approved episode when its matched rule is %s",
		async (_scenario, override) => {
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
				rules: override ? [{ ...episodeCleanupRule(), ...override }] : [],
			} as never);
			const storedApproval = {
				...approval(),
				targetScope: "episode",
				arrEpisodeId: 9_001,
				seasonNumber: 1,
				episodeNumber: 1,
				episodeTitle: "Episode 1",
				safetySnapshot: serializeExecutableSafetyPlan(plan),
			};
			configureApprovalStore(fixture.deps, storedApproval);

			const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

			expect(result).toMatchObject({ removed: 0, failed: 1 });
			expect(storedApproval).toMatchObject({ status: "expired" });
			expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
			expect(fixture.bulkDelete).not.toHaveBeenCalled();
			expect(fixture.deleteSeries).not.toHaveBeenCalled();
		},
	);

	it("evaluates the current episode rule against the live Plex count", async () => {
		const fixture = makeSonarrDeps({ livePlexWatchCount: 3 });
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
					parameters: JSON.stringify({ operator: "greater_than", count: 2 }),
				},
			],
		} as never);
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(plan.watchProof.watchCount).toBe(1);
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledWith([9_001], false);
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3_001]);
	});

	it("expires an approval when a higher-priority episode rule becomes the current match", async () => {
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
					...episodeCleanupRule("unmonitor"),
					id: "higher-priority-unmonitor",
					priority: 0,
				},
				{ ...episodeCleanupRule(), priority: 10 },
			],
		} as never);
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({ status: "expired" });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("revalidates rule priority against live counts from every Plex source", async () => {
		const fixture = makeSonarrDeps();
		addSecondPlexPolicySource(fixture);
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
					...episodeCleanupRule("unmonitor"),
					id: "higher-priority-unmonitor",
					priority: 0,
					parameters: JSON.stringify({ operator: "greater_than", count: 5 }),
				},
				{ ...episodeCleanupRule(), priority: 10 },
			],
		} as never);
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({ status: "expired" });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("does not authorize an edited rule from another Plex source with a different file", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		addSecondPlexPolicySource(fixture, {
			mediaPath: "/different-copy/Example.S01E01.2160p.mkv",
			includeNotification: false,
		});
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [
				{
					...episodeCleanupRule(),
					parameters: JSON.stringify({ operator: "greater_than", count: 5 }),
				},
			],
		} as never);
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({ status: "expired" });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("allows a mapped Plex source to satisfy an edited rule for the same exact file", async () => {
		const fixture = makeSonarrDeps();
		addSecondPlexPolicySource(fixture);
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
					parameters: JSON.stringify({ operator: "greater_than", count: 5 }),
				},
			],
		} as never);
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(storedApproval).toMatchObject({ status: "executed" });
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledWith([9_001], false);
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3_001]);
	});

	it("ignores stale policy evidence from a disabled Plex source", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		const second = addSecondPlexPolicySource(fixture, {
			enabled: false,
			staleCache: true,
			includeNotification: false,
		});
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(second.secondGetEpisodeWatchCount).not.toHaveBeenCalled();
		expect(second.secondGetSeriesEpisodeMediaPartsByTvdbId).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3_001]);
	});

	it("ignores stale policy evidence from an unrelated enabled Plex source", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		const second = addSecondPlexPolicySource(fixture, {
			staleCache: true,
			includeNotification: false,
		});
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(second.secondGetEpisodeWatchCount).not.toHaveBeenCalled();
		expect(second.secondGetSeriesEpisodeMediaPartsByTvdbId).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3_001]);
	});

	it("blocks direct cleanup when only a different Plex copy satisfies the edited rule", async () => {
		const fixture = makeSonarrDeps();
		addSecondPlexPolicySource(fixture, {
			mediaPath: "/different-copy/Example.S01E01.2160p.mkv",
			includeNotification: false,
		});
		const currentRule = {
			...episodeCleanupRule(),
			parameters: JSON.stringify({ operator: "greater_than", count: 5 }),
		};
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [currentRule],
		} as never);
		const intents = configureRetryStore(fixture.deps);
		const config = {
			id: "config-1",
			maxRemovalsPerRun: 10,
			respectQuiSeeding: true,
			rules: [episodeCleanupRule()],
		} as never;

		const result = await executeDirectRemoval(
			fixture.deps,
			config,
			"user-1",
			[directEpisodeFlaggedItem(fixture)],
			1,
			1,
			Date.now(),
		);

		expect(result).toMatchObject({ itemsRemoved: 0, itemsFilesDeleted: 0 });
		expect(result.details).toEqual([
			expect.objectContaining({
				action: "skipped",
				reason: expect.stringContaining("current episode cleanup"),
			}),
		]);
		expect(intents).toEqual([expect.objectContaining({ status: "expired" })]);
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("expires an episode retry when its matched rule is disabled", async () => {
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
			rules: [{ ...episodeCleanupRule(), enabled: false }],
		} as never);
		const storedRetry = {
			...approval(),
			status: "retry_pending",
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedRetry);

		const result = await executeRetryItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(storedRetry).toMatchObject({ status: "expired" });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("expires an approved episode when its current rule needs malformed live tags", async () => {
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
			rules: [{ ...episodeCleanupRule(), excludeTags: JSON.stringify([123]) }],
		} as never);
		(fixture.series as Record<string, unknown>).tags = ["   "];
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({ status: "expired" });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("revalidates the matched rule again between episode unmonitor and file deletion", async () => {
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
		let interruptAfterUnmonitor = true;
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockImplementation(
			(async () => currentConfig) as never,
		);
		fixture.setEpisodeMonitored.mockImplementation(async (episodeIds, monitored) => {
			for (const episodeId of episodeIds) {
				fixture.setLiveEpisodeMonitored(episodeId, monitored);
			}
			if (monitored === false && interruptAfterUnmonitor) currentConfig = disabledConfig;
		});
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("accepted the episode unmonitor");
		expect(storedApproval).toMatchObject({
			status: "retry_pending",
			lastExecutionError: expect.stringContaining("accepted the episode unmonitor"),
		});
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledWith([9_001], false);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deps.prisma.episodeFileCache.deleteMany).not.toHaveBeenCalled();

		const blockedRetry = await executeRetryItems(
			fixture.deps,
			"user-1",
			["approval-1"],
		);

		expect(blockedRetry).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({
			status: "retry_pending",
			lastExecutionError: expect.stringContaining("accepted the episode unmonitor"),
		});
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledTimes(1);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();

		interruptAfterUnmonitor = false;
		currentConfig = matchingConfig;
		const completedRetry = await executeRetryItems(
			fixture.deps,
			"user-1",
			["approval-1"],
		);

		expect(completedRetry).toMatchObject({ removed: 1, failed: 0 });
		expect(storedApproval).toMatchObject({ status: "executed" });
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3_001]);
	});

	it("persists and retries a direct episode deletion after its unmonitor step", async () => {
		const fixture = makeSonarrDeps();
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
		let interruptAfterUnmonitor = true;
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockImplementation(
			(async () => currentConfig) as never,
		);
		fixture.setEpisodeMonitored.mockImplementation(async (episodeIds, monitored) => {
			for (const episodeId of episodeIds) {
				fixture.setLiveEpisodeMonitored(episodeId, monitored);
			}
			if (monitored === false && interruptAfterUnmonitor) currentConfig = disabledConfig;
		});
		const intents = configureRetryStore(fixture.deps);
		const config = {
			id: "config-1",
			maxRemovalsPerRun: 10,
			respectQuiSeeding: true,
			rules: [episodeCleanupRule()],
		} as never;

		const result = await executeDirectRemoval(
			fixture.deps,
			config,
			"user-1",
			[directEpisodeFlaggedItem(fixture)],
			1,
			1,
			Date.now(),
		);

		expect(result).toMatchObject({
			status: "partial",
			itemsRemoved: 0,
			itemsFilesDeleted: 0,
		});
		expect(result.details).toEqual([
			expect.objectContaining({
				action: "skipped",
				reason: expect.stringContaining("accepted the episode unmonitor"),
			}),
		]);
		expect(intents).toEqual([
			expect.objectContaining({
				status: "retry_pending",
				lastExecutionError: expect.stringContaining("accepted the episode unmonitor"),
			}),
		]);
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledWith([9_001], false);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deps.prisma.episodeFileCache.deleteMany).not.toHaveBeenCalled();

		let loseRetryLease = true;
		const assertRetryLease = vi.fn(async () => {
			if (loseRetryLease) throw new CleanupRunLeaseLostError();
		});
		await expect(
			executeDirectRemoval(
				fixture.deps,
				config,
				"user-1",
				[],
				0,
				0,
				Date.now(),
				undefined,
				undefined,
				new Map(),
				assertRetryLease,
			),
		).rejects.toBeInstanceOf(CleanupRunLeaseLostError);
		expect(intents).toEqual([
			expect.objectContaining({
				status: "retry_pending",
				lastExecutionError: expect.stringContaining("database run lease"),
			}),
		]);

		loseRetryLease = false;
		const blockedRetry = await executeDirectRemoval(
			fixture.deps,
			config,
			"user-1",
			[],
			0,
			0,
			Date.now(),
			undefined,
			undefined,
			new Map(),
			assertRetryLease,
		);

		expect(blockedRetry).toMatchObject({ itemsRemoved: 0 });
		expect(intents).toEqual([
			expect.objectContaining({
				status: "retry_pending",
				lastExecutionError: expect.stringContaining("accepted the episode unmonitor"),
			}),
		]);
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledTimes(1);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();

		interruptAfterUnmonitor = false;
		currentConfig = matchingConfig;
		const retryResult = await executeDirectRemoval(
			fixture.deps,
			config,
			"user-1",
			[],
			0,
			0,
			Date.now(),
		);

		expect(retryResult).toMatchObject({
			status: "completed",
			itemsRemoved: 1,
			itemsFlagged: 1,
		});
		expect(intents).toEqual([expect.objectContaining({ status: "executed" })]);
		expect(fixture.bulkDelete).toHaveBeenCalledOnce();
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3_001]);
	});

	it("refreshes expired Plex proof before completing a partial episode retry", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		const stalePlan = {
			...plan,
			watchProof: {
				...plan.watchProof,
				refreshedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
			},
		};
		fixture.setLiveEpisodeMonitored(9_001, false);
		const storedRetry = {
			...approval(),
			status: "retry_pending",
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			lastExecutionError:
				"Partial cleanup: Sonarr accepted the episode unmonitor, but its file was not deleted. The upstream change was recorded and the mutation will remain retryable.",
			safetySnapshot: serializeExecutableSafetyPlan(stalePlan),
		};
		configureApprovalStore(fixture.deps, storedRetry);

		const result = await executeRetryItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 1, failed: 0 });
		expect(storedRetry).toMatchObject({ status: "executed" });
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledWith([9_001], false);
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3_001]);
	});

	it("aborts queued episode cleanup after persisting an unmonitor interrupted by lease loss", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		fixture.setEpisodeMonitored.mockImplementation(async (episodeIds, monitored) => {
			for (const episodeId of episodeIds) {
				fixture.setLiveEpisodeMonitored(episodeId, monitored);
			}
			vi.mocked(fixture.deps.prisma.libraryCleanupConfig.updateMany).mockResolvedValue({
				count: 0,
			});
		});
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		await expect(
			executeApprovedItems(fixture.deps, "user-1", ["approval-1"]),
		).rejects.toBeInstanceOf(CleanupRunLeaseLostError);

		expect(storedApproval).toMatchObject({
			status: "retry_pending",
			executionToken: null,
			lastExecutionError: expect.stringContaining("accepted the episode unmonitor"),
		});
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledWith([9_001], false);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("aborts direct episode cleanup after persisting an unmonitor interrupted by lease loss", async () => {
		const fixture = makeSonarrDeps();
		const intents = configureRetryStore(fixture.deps);
		let leaseLost = false;
		fixture.setEpisodeMonitored.mockImplementation(async (episodeIds, monitored) => {
			for (const episodeId of episodeIds) {
				fixture.setLiveEpisodeMonitored(episodeId, monitored);
			}
			leaseLost = true;
		});
		const assertRunLease = vi.fn(async () => {
			if (leaseLost) throw new CleanupRunLeaseLostError();
		});
		const config = {
			id: "config-1",
			maxRemovalsPerRun: 10,
			respectQuiSeeding: true,
			rules: [episodeCleanupRule()],
		} as never;

		await expect(
			executeDirectRemoval(
				fixture.deps,
				config,
				"user-1",
				[directEpisodeFlaggedItem(fixture)],
				1,
				1,
				Date.now(),
				undefined,
				undefined,
				new Map(),
				assertRunLease,
			),
		).rejects.toBeInstanceOf(CleanupRunLeaseLostError);

		expect(intents).toEqual([
			expect.objectContaining({
				status: "retry_pending",
				executionToken: null,
				lastExecutionError: expect.stringContaining("accepted the episode unmonitor"),
			}),
		]);
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledWith([9_001], false);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("blocks an approved episode when its parent series becomes retained", async () => {
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
				episodeCleanupRule(),
				{
					id: "retain-unmonitored-series",
					configId: "config-1",
					name: "Keep unmonitored series",
					enabled: true,
					priority: 0,
					ruleType: "unmonitored",
					parameters: JSON.stringify({}),
					serviceFilter: null,
					instanceFilter: null,
					excludeTags: null,
					excludeTitles: null,
					plexLibraryFilter: null,
					targetScope: "series",
					action: "delete",
					operator: null,
					conditions: null,
					retentionMode: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			],
		} as never);
		vi.mocked(fixture.deps.prisma.libraryCache.findFirst).mockResolvedValue({
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
			sizeOnDisk: 4_003n,
			arrAddedAt: new Date(),
			data: JSON.stringify({ ratings: { tmdb: { value: 8.2 } } }),
		} as never);
		fixture.series.monitored = false;
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("parent series is protected");
		expect(storedApproval).toMatchObject({ status: "expired" });
		expect(fixture.deps.prisma.libraryCache.findFirst).not.toHaveBeenCalled();
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("blocks an approved episode when live Sonarr omits retention evidence", async () => {
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
				episodeCleanupRule(),
				{
					id: "retain-unmonitored-series",
					configId: "config-1",
					name: "Keep unmonitored series",
					enabled: true,
					priority: 0,
					ruleType: "unmonitored",
					parameters: JSON.stringify({}),
					serviceFilter: null,
					instanceFilter: null,
					excludeTags: null,
					excludeTitles: null,
					plexLibraryFilter: null,
					targetScope: "series",
					action: "delete",
					operator: null,
					conditions: null,
					retentionMode: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			],
		} as never);
		delete (fixture.series as Record<string, unknown>).monitored;
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("live Sonarr series state could not be revalidated");
		expect(storedApproval).toMatchObject({ status: "expired" });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("blocks an approved episode when live Sonarr returns malformed exclusion tags", async () => {
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
				episodeCleanupRule(),
				{
					id: "retain-unmonitored-series-with-tag-exclusion",
					configId: "config-1",
					name: "Keep unmonitored series except excluded tags",
					enabled: true,
					priority: 0,
					ruleType: "unmonitored",
					parameters: JSON.stringify({}),
					serviceFilter: null,
					instanceFilter: null,
					excludeTags: JSON.stringify([123]),
					excludeTitles: null,
					plexLibraryFilter: null,
					targetScope: "series",
					action: "delete",
					operator: null,
					conditions: null,
					retentionMode: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			],
		} as never);
		(fixture.series as Record<string, unknown>).tags = ["   "];
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("live Sonarr series state could not be revalidated");
		expect(storedApproval).toMatchObject({ status: "expired" });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("evaluates rating retention against the live Sonarr response", async () => {
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
				episodeCleanupRule(),
				{
					id: "retain-high-rated-series",
					configId: "config-1",
					name: "Keep high-rated series",
					enabled: true,
					priority: 0,
					ruleType: "rating",
					parameters: JSON.stringify({ operator: "greater_than", score: 8 }),
					serviceFilter: null,
					instanceFilter: null,
					excludeTags: null,
					excludeTitles: null,
					plexLibraryFilter: null,
					targetScope: "series",
					action: "delete",
					operator: null,
					conditions: null,
					retentionMode: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			],
		} as never);
		(fixture.series as Record<string, unknown>).ratings = { value: 8.2, votes: 100 };
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("parent series is protected");
		expect(storedApproval).toMatchObject({ status: "expired" });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("evaluates statistics runtime retention against the live Sonarr response", async () => {
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
				episodeCleanupRule(),
				{
					id: "retain-long-series",
					configId: "config-1",
					name: "Keep long series",
					enabled: true,
					priority: 0,
					ruleType: "runtime",
					parameters: JSON.stringify({ operator: "greater_than", minutes: 30 }),
					serviceFilter: null,
					instanceFilter: null,
					excludeTags: null,
					excludeTitles: null,
					plexLibraryFilter: null,
					targetScope: "series",
					action: "delete",
					operator: null,
					conditions: null,
					retentionMode: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			],
		} as never);
		delete (fixture.series as Record<string, unknown>).runtime;
		(fixture.series as Record<string, unknown>).statistics = {
			episodeFileCount: 2,
			sizeOnDisk: 4_003,
			runtime: 60,
		};
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("parent series is protected");
		expect(storedApproval).toMatchObject({ status: "expired" });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("blocks an approved episode instead of trusting cached provider retention evidence", async () => {
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
				episodeCleanupRule(),
				{
					id: "retain-plex-collection",
					configId: "config-1",
					name: "Keep Plex collection",
					enabled: true,
					priority: 0,
					ruleType: "plex_collection",
					parameters: JSON.stringify({
						operator: "includes_any",
						collections: ["Keep"],
					}),
					serviceFilter: null,
					instanceFilter: null,
					excludeTags: null,
					excludeTitles: null,
					plexLibraryFilter: null,
					targetScope: "series",
					action: "delete",
					operator: null,
					conditions: null,
					retentionMode: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			],
		} as never);
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("live Sonarr series state could not be revalidated");
		expect(storedApproval).toMatchObject({ status: "expired" });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("ignores provider retention rules that do not apply to the Sonarr target", async () => {
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
				episodeCleanupRule(),
				{
					id: "retain-radarr-plex-collection",
					configId: "config-1",
					name: "Keep Radarr Plex collection",
					enabled: true,
					priority: 0,
					ruleType: "plex_collection",
					parameters: JSON.stringify({
						operator: "includes_any",
						collections: ["Keep"],
					}),
					serviceFilter: JSON.stringify(["RADARR"]),
					instanceFilter: null,
					excludeTags: JSON.stringify([123]),
					excludeTitles: null,
					plexLibraryFilter: null,
					targetScope: "series",
					action: "delete",
					operator: null,
					conditions: null,
					retentionMode: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			],
		} as never);
		delete (fixture.series as Record<string, unknown>).tags;
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledWith([9_001], false);
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3_001]);
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("blocks direct episode execution when its parent series becomes retained", async () => {
		const fixture = makeSonarrDeps();
		const intents = configureRetryStore(fixture.deps);
		const retentionRule = {
			id: "retain-unmonitored-series",
			configId: "config-1",
			name: "Keep unmonitored series",
			enabled: true,
			priority: 0,
			ruleType: "unmonitored",
			parameters: JSON.stringify({}),
			serviceFilter: null,
			instanceFilter: null,
			excludeTags: null,
			excludeTitles: null,
			plexLibraryFilter: null,
			targetScope: "series",
			action: "delete",
			operator: null,
			conditions: null,
			retentionMode: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [episodeCleanupRule(), retentionRule],
		} as never);
		vi.mocked(fixture.deps.prisma.libraryCache.findFirst).mockResolvedValue({
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
			sizeOnDisk: 4_003n,
			arrAddedAt: new Date(),
			data: JSON.stringify({
				_arrDashboardSource: { serviceFingerprint: sonarrServiceFingerprint },
				path: fixture.series.path,
				remoteIds: { tvdbId: fixture.series.tvdbId, tmdbId: fixture.series.tmdbId },
				ratings: { tmdb: { value: 8.2 } },
			}),
		} as never);
		fixture.series.monitored = false;
		const flaggedItem = directEpisodeFlaggedItem(fixture);
		const config = {
			id: "config-1",
			maxRemovalsPerRun: 10,
			respectQuiSeeding: true,
			rules: [],
		} as never;

		const result = await executeDirectRemoval(
			fixture.deps,
			config,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(result).toMatchObject({ itemsRemoved: 0 });
		expect(result.details).toEqual([
			expect.objectContaining({
				action: "skipped",
				reason: expect.stringContaining("parent series is protected"),
			}),
		]);
		expect(intents).toEqual([
			expect.objectContaining({
				status: "expired",
				lastExecutionError: expect.stringContaining("parent series is protected"),
			}),
		]);
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("revalidates the exact episode file qUI state at the mutation boundary", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		vi.mocked(fixture.deps.prisma.episodeFileCache.findFirst).mockResolvedValue({
			infoHash: "abc123",
			torrentState: "seeding",
		} as never);
		configureApprovalStore(fixture.deps, {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		});

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("preserves the live retained size and durable retry when inventory changes after deletion", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		const concurrentFile = {
			id: 3_003,
			path: "/tv-4k/Example Series/Season 01/Example.S01E03.2160p.mkv",
			relativePath: "Season 01/Example.S01E03.2160p.mkv",
			size: 2_003,
		};
		fixture.targetClient.episodeFile.getBySeries.mockImplementation(async () =>
			fixture.bulkDelete.mock.calls.length === 0
				? fixture.episodeFiles
				: [fixture.episodeFiles[1]!, concurrentFile],
		);
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("retained series inventory changed");
		expect(fixture.bulkDelete).toHaveBeenCalledWith([3_001]);
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
		expect(fixture.deps.prisma.libraryCache.updateMany).toHaveBeenCalledWith({
			where: { instanceId: "sonarr-4k", arrItemId: 201, itemType: "series" },
			data: { hasFile: true, sizeOnDisk: 4_005 },
		});
		expect(storedApproval).toMatchObject({ status: "retry_pending" });
	});

	it("preserves the live retained size for direct episode cleanup partials", async () => {
		const fixture = makeSonarrDeps();
		const intents = configureRetryStore(fixture.deps);
		const concurrentFile = {
			id: 3_003,
			path: "/tv-4k/Example Series/Season 01/Example.S01E03.2160p.mkv",
			relativePath: "Season 01/Example.S01E03.2160p.mkv",
			size: 2_003,
		};
		fixture.targetClient.episodeFile.getBySeries.mockImplementation(async () =>
			fixture.bulkDelete.mock.calls.length === 0
				? fixture.episodeFiles
				: [fixture.episodeFiles[1]!, concurrentFile],
		);
		const config = {
			id: "config-1",
			maxRemovalsPerRun: 10,
			respectQuiSeeding: true,
			rules: [episodeCleanupRule()],
		} as never;

		const result = await executeDirectRemoval(
			fixture.deps,
			config,
			"user-1",
			[directEpisodeFlaggedItem(fixture)],
			1,
			1,
			Date.now(),
		);

		expect(result).toMatchObject({ itemsRemoved: 0, itemsFilesDeleted: 1 });
		expect(result.details).toEqual([
			expect.objectContaining({
				action: "files_deleted",
				reason: expect.stringContaining("retained series inventory changed"),
			}),
		]);
		expect(intents).toEqual([
			expect.objectContaining({
				status: "retry_pending",
				lastExecutionError: expect.stringContaining("retained series inventory changed"),
			}),
		]);
		expect(fixture.deps.prisma.libraryCache.updateMany).toHaveBeenCalledWith({
			where: { instanceId: "sonarr-4k", arrItemId: 201, itemType: "series" },
			data: { hasFile: true, sizeOnDisk: 4_005 },
		});
	});

	it("records a confirmed episode deletion when Sonarr loses the response", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		const applyDelete = fixture.bulkDelete.getMockImplementation();
		if (!applyDelete) throw new Error("Expected Sonarr delete implementation");
		fixture.bulkDelete.mockImplementation(async (episodeFileIds) => {
			await applyDelete(episodeFileIds);
			throw new Error("response lost");
		});
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("response was lost");
		expect(storedApproval).toMatchObject({
			status: "retry_pending",
			lastExecutionError: expect.stringContaining("response was lost"),
		});
		expect(fixture.deps.prisma.episodeFileCache.deleteMany).toHaveBeenCalledWith({
			where: {
				instanceId: "sonarr-4k",
				arrSeriesId: 201,
				arrEpisodeFileId: { in: [3_001] },
			},
		});
		expect(fixture.deps.prisma.libraryCache.updateMany).toHaveBeenCalledWith({
			where: { instanceId: "sonarr-4k", arrItemId: 201, itemType: "series" },
			data: { hasFile: true, sizeOnDisk: 2_002 },
		});
	});

	it("keeps an unverifiable direct episode deletion retryable without claiming a deletion", async () => {
		const fixture = makeSonarrDeps();
		const intents = configureRetryStore(fixture.deps);
		fixture.targetClient.episodeFile.getBySeries.mockImplementation(async () => {
			if (fixture.bulkDelete.mock.calls.length > 0) {
				throw new Error("readback unavailable");
			}
			return fixture.episodeFiles;
		});
		const config = {
			id: "config-1",
			maxRemovalsPerRun: 10,
			respectQuiSeeding: true,
			rules: [episodeCleanupRule()],
		} as never;

		const result = await executeDirectRemoval(
			fixture.deps,
			config,
			"user-1",
			[directEpisodeFlaggedItem(fixture)],
			1,
			1,
			Date.now(),
		);

		expect(result).toMatchObject({ itemsRemoved: 0, itemsFilesDeleted: 0 });
		expect(result.details).toEqual([
			expect.objectContaining({
				action: "skipped",
				reason: expect.stringContaining("outcome could not be verified"),
			}),
		]);
		expect(intents).toEqual([
			expect.objectContaining({
				status: "retry_pending",
				lastExecutionError: expect.stringContaining("outcome could not be verified"),
			}),
		]);
		expect(fixture.deps.prisma.episodeFileCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.deps.prisma.libraryCache.updateMany).toHaveBeenCalledWith({
			where: { instanceId: "sonarr-4k", arrItemId: 201, itemType: "series" },
			data: { hasFile: true, sizeOnDisk: 4_003 },
		});
	});

	it("keeps an unverifiable delete_files result action-neutral and retryable", async () => {
		const fixture = makeSonarrDeps();
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [episodeCleanupRule("delete_files")],
		} as never);
		const episodeTarget = { ...exactEpisodeTarget(), action: "delete_files" as const };
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		fixture.targetClient.episodeFile.getBySeries.mockImplementation(async () => {
			if (fixture.bulkDelete.mock.calls.length > 0) {
				throw new Error("readback unavailable");
			}
			return fixture.episodeFiles;
		});
		const storedApproval = {
			...approval("delete_files"),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("outcome could not be verified");
		expect(result.errors[0]).not.toContain("unmonitored");
		expect(storedApproval).toMatchObject({
			status: "pending",
			lastExecutionError: expect.stringContaining("selected file may already be deleted"),
		});
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.deps.prisma.episodeFileCache.deleteMany).not.toHaveBeenCalled();
	});

	it("expires direct episode cleanup when the live count no longer matches its rule", async () => {
		const fixture = makeSonarrDeps();
		const intents = configureRetryStore(fixture.deps);
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [
				{
					...episodeCleanupRule(),
					parameters: JSON.stringify({ operator: "greater_than", count: 1 }),
				},
			],
		} as never);
		const config = {
			id: "config-1",
			maxRemovalsPerRun: 10,
			respectQuiSeeding: true,
			rules: [episodeCleanupRule()],
		} as never;

		const result = await executeDirectRemoval(
			fixture.deps,
			config,
			"user-1",
			[directEpisodeFlaggedItem(fixture)],
			1,
			1,
			Date.now(),
		);

		expect(result).toMatchObject({ itemsRemoved: 0, itemsFilesDeleted: 0 });
		expect(result.details).toEqual([
			expect.objectContaining({
				action: "skipped",
				reason: expect.stringContaining("current episode cleanup and retention rules"),
			}),
		]);
		expect(intents).toEqual([
			expect.objectContaining({
				status: "expired",
				lastExecutionError: expect.stringContaining(
					"current episode cleanup and retention rules",
				),
			}),
		]);
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("enforces a newly enabled qUI policy against an older approval snapshot", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = { ...exactEpisodeTarget(), respectQuiSeeding: false };
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			respectQuiSeeding: true,
			rules: [episodeCleanupRule()],
		} as never);
		vi.mocked(fixture.deps.quiClientFactory!).mockReturnValue({
			getTorrentsByHash: vi.fn().mockResolvedValue([{ hash: "episode-hash", state: "stalledUP" }]),
		} as never);
		const storedApproval = {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({ status: "pending" });
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("does not require live qUI proof while respectQuiSeeding remains false", async () => {
		const fixture = makeSonarrDeps();
		vi.mocked(fixture.deps.quiFileHashIndexFactory!).mockRejectedValue(new Error("offline"));
		const episodeTarget = { ...exactEpisodeTarget(), respectQuiSeeding: false };

		await expect(
			findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget]),
		).resolves.toEqual(new Map());
	});

	it.each(["missing", "reset", "stale", "approved-seven-days-old"] as const)(
		"blocks approved episode deletion when current Plex proof is %s",
		async (mode) => {
			const fixture = makeSonarrDeps();
			const episodeTarget = exactEpisodeTarget();
			const context = createSharedPlexSafetyContext();
			await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
			const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
			if (plan?.kind !== "verified_sonarr_episode") {
				throw new Error("Expected verified Sonarr episode plan");
			}
			const approvedPlan =
				mode === "approved-seven-days-old"
					? {
							...plan,
							watchProof: {
								...plan.watchProof,
								refreshedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
							},
						}
					: plan;
			if (mode === "missing") {
				vi.mocked(fixture.deps.prisma.plexEpisodeCache.findFirst).mockResolvedValue(null);
			} else if (mode === "reset") {
				vi.mocked(fixture.deps.prisma.plexEpisodeCache.findFirst).mockResolvedValue({
					watchCount: 0,
					refreshedAt: new Date(),
				} as never);
			} else if (mode === "stale") {
				vi.mocked(fixture.deps.prisma.plexEpisodeCache.findFirst).mockResolvedValue({
					watchCount: 1,
					refreshedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
				} as never);
			}
			const storedApproval = {
				...approval(),
				targetScope: "episode",
				arrEpisodeId: 9_001,
				seasonNumber: 1,
				episodeNumber: 1,
				episodeTitle: "Episode 1",
				safetySnapshot: serializeExecutableSafetyPlan(approvedPlan),
			};
			configureApprovalStore(fixture.deps, storedApproval);

			const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

			expect(result).toMatchObject({ removed: 0, failed: 1 });
			expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
			expect(fixture.bulkDelete).not.toHaveBeenCalled();
			expect(fixture.deleteSeries).not.toHaveBeenCalled();
			if (mode === "approved-seven-days-old") {
				expect(storedApproval).toMatchObject({
					status: "expired",
					lastExecutionError: expect.stringContaining("evidence expired"),
				});
				expect(result.errors[0]).toContain("evidence expired");
			}
		},
	);

	it("blocks an approved episode after Plex is repointed and freshly recached", async () => {
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
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		fixture.plexInstance.encryptedApiKey = "replacement-encrypted-token";
		fixture.plexInstance.updatedAt = new Date(Date.now() - 5 * 60 * 1000);
		vi.mocked(fixture.deps.prisma.plexEpisodeCache.findFirst).mockResolvedValue({
			watchCount: 1,
			refreshedAt: new Date(),
			sourceFingerprint: plexConnectionFingerprint(fixture.plexInstance),
		} as never);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(storedApproval).toMatchObject({ status: "pending" });
	});

	it("requires the approved monitored state for delete_files episode actions", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = { ...exactEpisodeTarget(), action: "delete_files" as const };
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		fixture.setLiveEpisodeMonitored(9_001, false);
		configureApprovalStore(fixture.deps, {
			...approval("delete_files"),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		});

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("fails closed when Sonarr omits the selected episode monitored state", async () => {
		const episodes = [
			{
				id: 9_001,
				seasonNumber: 1,
				episodeNumber: 1,
				episodeFileId: 3_001,
				monitored: false,
			},
			{
				id: 9_002,
				seasonNumber: 1,
				episodeNumber: 2,
				episodeFileId: 3_002,
				monitored: true,
			},
		];
		const fixture = makeSonarrDeps({ episodes });
		const episodeTarget = { ...exactEpisodeTarget(), action: "delete_files" as const };
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		(episodes[0] as unknown as Record<string, unknown>).monitored = undefined;
		configureApprovalStore(fixture.deps, {
			...approval("delete_files"),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		});

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it("blocks an episode file write if the user re-monitors after cleanup unmonitors it", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = exactEpisodeTarget();
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		fixture.setEpisodeMonitored.mockImplementation(async () => {
			fixture.setLiveEpisodeMonitored(9_001, true);
		});
		configureApprovalStore(fixture.deps, {
			...approval(),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		});

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.setEpisodeMonitored).toHaveBeenCalledWith([9_001], false);
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
	});

	it.each([
		["delete", true, true, true],
		["delete", true, false, true],
		["delete", false, false, true],
		["delete", false, true, false],
		["delete_files", true, true, true],
		["delete_files", false, false, true],
		["delete_files", true, false, false],
		["delete_files", false, true, false],
		["unmonitor", true, true, true],
		["unmonitor", true, false, true],
		["unmonitor", false, false, true],
		["unmonitor", false, true, false],
	] as const)(
		"interrupted %s retry compares monitored %s -> %s directionally",
		async (action, approvedMonitored, liveMonitored, allowed) => {
			const fixture = makeSonarrDeps();
			fixture.setLiveEpisodeMonitored(9_001, approvedMonitored);
			const episodeTarget = { ...exactEpisodeTarget(), action };
			const context = createSharedPlexSafetyContext();
			await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
			const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
			if (plan?.kind !== "verified_sonarr_episode") {
				throw new Error("Expected verified Sonarr episode plan");
			}
			fixture.setLiveEpisodeMonitored(9_001, liveMonitored);
			vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
				id: "config-1",
				respectQuiSeeding: true,
				rules: [episodeCleanupRule(action)],
			} as never);
			configureApprovalStore(fixture.deps, {
				...approval(action),
				targetScope: "episode",
				arrEpisodeId: 9_001,
				seasonNumber: 1,
				episodeNumber: 1,
				episodeTitle: "Episode 1",
				lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
				safetySnapshot: serializeExecutableSafetyPlan(plan),
			});

			const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

			expect(result.failed).toBe(allowed ? 0 : 1);
			if (allowed && action !== "unmonitor") {
				expect(fixture.bulkDelete).toHaveBeenCalledWith([3_001]);
			} else if (allowed && liveMonitored) {
				expect(fixture.setEpisodeMonitored).toHaveBeenCalledWith([9_001], false);
			} else if (allowed) {
				expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
			} else {
				expect(fixture.bulkDelete).not.toHaveBeenCalled();
			}
		},
	);

	it("does not reconcile an unmonitor retry from file absence while the episode is monitored", async () => {
		const episodes = [
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
				episodeFileId: 3_002,
				monitored: true,
			},
		];
		const fixture = makeSonarrDeps({ episodes });
		const episodeTarget = { ...exactEpisodeTarget(), action: "unmonitor" as const };
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		episodes[0]!.episodeFileId = 0;
		fixture.targetClient.episodeFile.getBySeries.mockResolvedValue([
			fixture.episodeFiles[1]!,
		]);
		const storedApproval = {
			...approval("unmonitor"),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).not.toMatchObject({ status: "executed" });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
	});

	it("reconciles an unmonitor retry only when the exact episode is already unmonitored", async () => {
		const episodes = [
			{
				id: 9_001,
				seasonNumber: 1,
				episodeNumber: 1,
				episodeFileId: 0,
				monitored: false,
			},
			{
				id: 9_002,
				seasonNumber: 1,
				episodeNumber: 2,
				episodeFileId: 3_002,
				monitored: true,
			},
		];
		const fixture = makeSonarrDeps({ episodes });
		episodes[0]!.episodeFileId = 3_001;
		episodes[0]!.monitored = true;
		const episodeTarget = { ...exactEpisodeTarget(), action: "unmonitor" as const };
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		episodes[0]!.episodeFileId = 0;
		episodes[0]!.monitored = false;
		fixture.targetClient.episodeFile.getBySeries.mockResolvedValue([
			fixture.episodeFiles[1]!,
		]);
		const storedApproval = {
			...approval("unmonitor"),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 0,
			failed: 0,
			errors: [],
		});
		expect(storedApproval).toMatchObject({ status: "executed" });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deps.prisma.episodeFileCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.deps.prisma.libraryCache.updateMany).not.toHaveBeenCalled();
	});

	it("reconciles an already-unmonitored episode without hiding its retained file", async () => {
		const episodes = [
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
				episodeFileId: 3_002,
				monitored: true,
			},
		];
		const fixture = makeSonarrDeps({ episodes });
		const episodeTarget = { ...exactEpisodeTarget(), action: "unmonitor" as const };
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		episodes[0]!.monitored = false;
		const storedApproval = {
			...approval("unmonitor"),
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 0,
			failed: 0,
			errors: [],
		});
		expect(storedApproval).toMatchObject({ status: "executed" });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deps.prisma.episodeFileCache.deleteMany).not.toHaveBeenCalled();
		expect(fixture.deps.prisma.libraryCache.updateMany).not.toHaveBeenCalled();
	});

	it("reconciles a deleted episode despite unrelated retained-file changes", async () => {
		const episodes = [
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
				episodeFileId: 3_002,
				monitored: true,
			},
		];
		const fixture = makeSonarrDeps({ episodes });
		const context = createSharedPlexSafetyContext();
		const episodeTarget = exactEpisodeTarget();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		episodes[0]!.episodeFileId = 0;
		episodes[0]!.monitored = false;
		episodes[1]!.episodeFileId = 3_003;
		fixture.targetClient.episodeFile.getBySeries.mockResolvedValue([
			{
				id: 3_003,
				path: "/tv-4k/Example Series/Season 01/Example.S01E02.replaced.mkv",
				relativePath: "Season 01/Example.S01E02.replaced.mkv",
				size: 2_003,
			},
		]);
		const storedRetry = {
			...approval(),
			status: "retry_pending",
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedRetry);

		const result = await executeRetryItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 0, reconciled: 1, failed: 0, errors: [] });
		expect(storedRetry).toMatchObject({ status: "executed", executionToken: null });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deps.prisma.episodeFileCache.deleteMany).toHaveBeenCalledWith({
			where: {
				instanceId: "sonarr-4k",
				arrSeriesId: 201,
				arrEpisodeFileId: 3_001,
			},
		});
	});

	it("purges both caches when an episode-unmonitor retry finds its parent series absent", async () => {
		const fixture = makeSonarrDeps();
		const episodeTarget = { ...exactEpisodeTarget(), action: "unmonitor" as const };
		const context = createSharedPlexSafetyContext();
		await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
		const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
		if (plan?.kind !== "verified_sonarr_episode") {
			throw new Error("Expected verified Sonarr episode plan");
		}
		await fixture.deleteSeries();
		fixture.deleteSeries.mockClear();
		const storedApproval = {
			...approval("unmonitor"),
			status: "retry_pending",
			targetScope: "episode",
			arrEpisodeId: 9_001,
			seasonNumber: 1,
			episodeNumber: 1,
			episodeTitle: "Episode 1",
			lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		};
		configureApprovalStore(fixture.deps, storedApproval);

		const result = await executeRetryItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 0, reconciled: 1, failed: 0, errors: [] });
		expect(storedApproval).toMatchObject({ status: "executed", executionToken: null });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.bulkDelete).not.toHaveBeenCalled();
		expect(fixture.deps.prisma.episodeFileCache.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: "sonarr-4k", arrSeriesId: 201 },
		});
		expect(fixture.deps.prisma.libraryCache.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: "sonarr-4k", arrItemId: 201, itemType: "series" },
		});
	});

	it.each([
		[
			"episode",
			"unmonitor",
			(fixture: ReturnType<typeof makeSonarrDeps>) =>
				fixture.targetClient.episode.getAll.mockRejectedValue(
					new NotFoundError("Episodes unavailable"),
				),
		],
		[
			"episode-file",
			"delete_files",
			(fixture: ReturnType<typeof makeSonarrDeps>) =>
				fixture.targetClient.episodeFile.getBySeries.mockRejectedValue(
					new NotFoundError("Episode files unavailable"),
				),
		],
	] as const)(
		"does not treat a downstream %s 404 as an absent parent series",
		async (_endpoint, action, rejectDownstreamRead) => {
			const fixture = makeSonarrDeps();
			const episodeTarget = { ...exactEpisodeTarget(), action };
			const context = createSharedPlexSafetyContext();
			await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [episodeTarget], context);
			const plan = context.plans.get(cleanupDeleteTargetKey(episodeTarget));
			if (plan?.kind !== "verified_sonarr_episode") {
				throw new Error("Expected verified Sonarr episode plan");
			}
			rejectDownstreamRead(fixture);
			const storedApproval = {
				...approval(action),
				status: "retry_pending",
				targetScope: "episode",
				arrEpisodeId: 9_001,
				seasonNumber: 1,
				episodeNumber: 1,
				episodeTitle: "Episode 1",
				lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
				safetySnapshot: serializeExecutableSafetyPlan(plan),
			};
			configureApprovalStore(fixture.deps, storedApproval);

			const result = await executeRetryItems(fixture.deps, "user-1", ["approval-1"]);

			expect(result).toMatchObject({ removed: 0, reconciled: 0, failed: 1 });
			expect(storedApproval).not.toMatchObject({ status: "executed" });
			expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
			expect(fixture.bulkDelete).not.toHaveBeenCalled();
			expect(fixture.deps.prisma.episodeFileCache.deleteMany).not.toHaveBeenCalled();
			expect(fixture.deps.prisma.libraryCache.deleteMany).not.toHaveBeenCalled();
		},
	);

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
		targetClient.episodeFile.getBySeries.mockResolvedValueOnce(episodeFiles).mockResolvedValueOnce([
			...episodeFiles,
			{
				id: 3003,
				path: "/tv-4k/Example Series/Season 01/Example.S01E03.2160p.mkv",
				size: 2_003,
			},
		]);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("Sonarr episode files changed");
		expect(bulkDelete).not.toHaveBeenCalled();
		expect(deleteSeries).not.toHaveBeenCalled();
		expect(approvalUpdate).toHaveBeenCalledWith({
			where: expect.objectContaining({ id: "approval-1", status: "executing" }),
			data: expect.objectContaining({ status: "pending" }),
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
			safetySnapshot: approval("delete", []).safetySnapshot,
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

	it("cleans both caches when an interrupted series unmonitor target is already absent", async () => {
		const fixture = makeSonarrDeps();
		await fixture.deleteSeries();
		fixture.deleteSeries.mockClear();
		const storedRetry = {
			...approval("unmonitor"),
			status: "retry_pending",
			lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
		} as unknown as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedRetry);

		const result = await executeRetryItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 0, reconciled: 1, failed: 0, errors: [] });
		expect(fixture.setEpisodeMonitored).not.toHaveBeenCalled();
		expect(fixture.deleteSeries).not.toHaveBeenCalled();
		expect(fixture.deps.prisma.episodeFileCache.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: "sonarr-4k", arrSeriesId: 201 },
		});
		expect(fixture.deps.prisma.libraryCache.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: "sonarr-4k", arrItemId: 201, itemType: "series" },
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

	it.each(["delete", "delete_files"] as const)(
		"allows %s for a fileless no-notification series when a sibling Sonarr exists",
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

			await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
				removed: action === "delete" ? 1 : 0,
				failed: 0,
				errors: [],
			});
			expect(fixture.bulkDelete).not.toHaveBeenCalled();
			expect(fixture.deleteSeries).toHaveBeenCalledTimes(action === "delete" ? 1 : 0);
			expect(peer.peerClient.series.getAll).not.toHaveBeenCalled();
		},
	);

	it("accepts a lost Sonarr record-delete response after a not-found readback", async () => {
		const { deps, targetClient, episodeFiles, deleteSeries, setLiveSeriesExists } =
			makeSonarrDeps();
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([approval()] as never);
		targetClient.episodeFile.getBySeries
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
