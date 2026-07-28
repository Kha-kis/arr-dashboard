import { NotFoundError } from "arr-sdk";
import { describe, expect, it, vi } from "vitest";
import {
	executeApprovedItems,
	executeDirectRemoval,
	executeRetryItems,
	INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
} from "../cleanup-executor.js";
import {
	cleanupDeleteTargetKey,
	createArrServiceFingerprint,
	createSharedPlexSafetyContext,
	findSharedPlexDeleteBlocks,
	serializeExecutableSafetyPlan,
} from "../shared-plex-safety.js";
import type { CleanupExecutorDeps } from "../types.js";

const silentLog = {
	warn: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
} as unknown as CleanupExecutorDeps["log"];

const sonarrServiceFingerprint = createArrServiceFingerprint({
	id: "sonarr-4k",
	service: "SONARR",
	baseUrl: "http://sonarr.internal:8989",
	encryptedApiKey: "encrypted-sonarr-key",
	encryptionIv: "sonarr-iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
} as never);

interface SonarrTestOptions {
	action?: "delete" | "delete_files";
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
	};
	const series = {
		id: 201,
		tvdbId: 123,
		tmdbId: 456,
		title: "Example Series",
		path: "/tv-4k/Example Series",
		tags: options.seriesTags ?? [],
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
	const plexClientFactory = vi.fn(() => ({
		getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Owner" }]),
		getMovieMediaPartsByTmdbId: vi.fn(),
		getSeriesEpisodeMediaPartsByTvdbId,
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
				findUnique: vi.fn().mockResolvedValue({ id: "config-1" }),
				updateMany: cleanupConfigUpdateMany,
			},
			serviceInstance: {
				findMany: vi.fn(({ where }: { where: { service: string } }) =>
					where.service === "PLEX"
						? Promise.resolve([plexInstance])
						: Promise.resolve([targetInstance]),
				),
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
				findFirst: vi.fn().mockResolvedValue({
					id: "cache-sonarr-201",
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
					arrAddedAt: new Date("2020-01-01T00:00:00.000Z"),
					cachedAt: new Date("2026-07-27T12:05:00.000Z"),
					data: JSON.stringify({
						remoteIds: { tvdbId: 123, tmdbId: 456 },
						path: "/tv-4k/Example Series",
						episodeFile: {
							videoCodec: "x265",
							audioCodec: "5.1",
							resolution: "R2160p",
						},
					}),
				}),
				deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			episodeFileCache: {
				findMany: vi.fn().mockResolvedValue(
					episodeFiles.map((file) => ({
						arrEpisodeFileId: file.id,
						path: file.path,
						size: BigInt(file.size!),
					})),
				),
				deleteMany: episodeFileCacheDeleteMany,
			},
			libraryCleanupLog: {
				create: vi.fn().mockResolvedValue({}),
			},
		} as unknown as CleanupExecutorDeps["prisma"],
		arrClientFactory: {
			create: vi.fn(() => targetClient),
		} as unknown as CleanupExecutorDeps["arrClientFactory"],
		plexClientFactory,
		log: silentLog,
	};

	return {
		deps,
		targetInstance,
		targetClient,
		series,
		episodeFiles,
		bulkDelete,
		deleteSeries,
		getSeriesEpisodeMediaPartsByTvdbId,
		approvalUpdate,
		episodeFileCacheDeleteMany,
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
		expect(targetClient.notification.getAll).not.toHaveBeenCalled();
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

	it("loads Sonarr notifications once per instance across multiple safety targets", async () => {
		const { deps, targetClient } = makeSonarrDeps();
		const context = createSharedPlexSafetyContext();

		await findSharedPlexDeleteBlocks(
			deps,
			"user-1",
			[target, { ...target, arrItemId: 202 }],
			context,
		);

		expect(targetClient.notification.getAll).toHaveBeenCalledOnce();
		expect(targetClient.series.getById).toHaveBeenCalledTimes(2);
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

	it("still uses exact-file deletion when no media-server notification applies", async () => {
		const { deps, targetClient, episodeFiles, bulkDelete, deleteSeries } = makeSonarrDeps({
			notificationKind: "none",
		});
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

	it("fails closed for Sonarr file exemptions until multi-file semantics are defined", async () => {
		const { deps, bulkDelete, deleteSeries } = makeSonarrDeps();
		const storedApproval = approval() as unknown as Record<string, unknown>;
		configureApprovalStore(deps, storedApproval);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			{
				id: "sonarr-file-exemption",
				deployedDocument: JSON.stringify({
					version: 1,
					root: {
						kind: "video_codec",
						params: { operator: "is", codecs: ["x265"] },
					},
				}),
				deployedScope: JSON.stringify({ serviceTypes: ["SONARR"], instanceIds: [] }),
				deployedActions: JSON.stringify([
					{ type: "send_notification" },
					{ type: "exempt_cleanup" },
				]),
			},
		] as never);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("deployed cleanup exemption policy");
		expect(bulkDelete).not.toHaveBeenCalled();
		expect(deleteSeries).not.toHaveBeenCalled();
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

	it("durably retries a direct Sonarr record deletion after exact file removal", async () => {
		const { deps, episodeFiles, bulkDelete, deleteSeries } = makeSonarrDeps();
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
			safetySnapshot: approval("delete", []).safetySnapshot,
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
