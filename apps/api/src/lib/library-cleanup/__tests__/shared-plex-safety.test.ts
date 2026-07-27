import { NotFoundError } from "arr-sdk";
import { describe, expect, it, vi } from "vitest";
import {
	buildCleanupPreviewDetails,
	executeApprovedItems,
	executeDirectRemoval,
	selectInspectableCleanupPreviewItems,
} from "../cleanup-executor.js";
import {
	cleanupDeleteTargetKey,
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

function radarrSafetySnapshot(
	file: {
		movieFileId: number;
		fullPath: { value: string; windows: boolean };
		size: number;
	} | null = {
		movieFileId: 1001,
		fullPath: {
			value: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
			windows: false,
		},
		size: 2_000,
	},
) {
	return serializeExecutableSafetyPlan(
		file ? { kind: "verified_radarr", file } : { kind: "verified_radarr_empty" },
	);
}

function approvalRecord(overrides: Record<string, unknown> = {}) {
	return {
		id: "approval-1",
		instanceId: "radarr-4k",
		arrItemId: 101,
		itemType: "movie",
		title: "Example Movie",
		reason: "Matched 4K cleanup rule",
		action: "delete",
		safetySnapshot: radarrSafetySnapshot(),
		...overrides,
	};
}

const radarrCachedFileIdentity = {
	hasFile: true,
	data: JSON.stringify({
		path: "/movies-4k/Example Movie (2024)",
		movieFile: {
			id: 1001,
			path: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
			size: 2_000,
		},
	}),
};

interface TestOptions {
	action?: "delete" | "delete_files" | "unmonitor";
	includePlexNotification?: boolean;
	notificationKind?: "plex" | "mediabrowser" | "kodi" | "synology";
	onMovieDelete?: boolean;
	onMovieFileDelete?: boolean;
	initialMovieFileId?: number | null;
	movieTags?: number[];
	notificationTags?: number[];
	updateLibrary?: boolean;
	cleanLibrary?: boolean;
	mapFrom?: string;
	mapTo?: string;
	mediaPartCount?: number;
	plexItems?: Array<{
		ratingKey: string;
		parts: Array<{ file: string; size: number }>;
	}>;
	movieFile?: {
		id?: number;
		path?: string | null;
		relativePath?: string | null;
		size?: number;
	};
	targetFailure?: Error;
	notificationFailure?: Error;
	ownerFailure?: Error;
	plexFailure?: Error;
	includePlexInstance?: boolean;
}

function notificationFields(options: TestOptions) {
	const fields: Array<{ name: string; value: unknown }> = [
		{ name: "host", value: "plex.internal" },
		{ name: "port", value: 32400 },
		{ name: "useSsl", value: false },
		{ name: "urlBase", value: "" },
		// Radarr masks PrivacyLevel.ApiKey values in real API responses.
		{ name: "authToken", value: "********" },
		{ name: "updateLibrary", value: options.updateLibrary ?? true },
	];
	if (options.cleanLibrary !== undefined) {
		fields.push({ name: "cleanLibrary", value: options.cleanLibrary });
	}
	if (options.mapFrom !== undefined) fields.push({ name: "mapFrom", value: options.mapFrom });
	if (options.mapTo !== undefined) fields.push({ name: "mapTo", value: options.mapTo });
	return fields;
}

function makeDeps(options: TestOptions = {}) {
	const targetInstance = {
		id: "radarr-4k",
		userId: "user-1",
		service: "RADARR",
		label: "4K Radarr",
		enabled: true,
	};
	const plexInstance = {
		id: "plex-1",
		userId: "user-1",
		service: "PLEX",
		label: "Plex",
		baseUrl: "http://plex.internal:32400",
		enabled: false,
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
	};

	let liveMovieExists = true;
	const deleteMovie = vi.fn(async () => {
		liveMovieExists = false;
	});
	let liveMovieFileId: number | undefined =
		options.initialMovieFileId === null ? undefined : (options.initialMovieFileId ?? 1001);
	const deleteMovieFile = vi.fn(async (movieFileId: number) => {
		if (movieFileId === liveMovieFileId) liveMovieFileId = undefined;
	});
	const targetMovie = {
		id: 101,
		tmdbId: 42,
		title: "Example Movie",
		tags: options.movieTags ?? [],
		hasFile: true,
		movieFileId: 1001,
		path: "/movies-4k/Example Movie (2024)",
		rootFolderPath: "/movies-4k",
	};
	const targetMovieFile = {
		id: 1001,
		path: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
		relativePath: "Example.Movie.2160p.mkv",
		size: 2_000,
		...options.movieFile,
	};
	const notificationIdentity =
		options.notificationKind === "mediabrowser"
			? { implementation: "MediaBrowser", configContract: "MediaBrowserSettings" }
			: options.notificationKind === "kodi"
				? { implementation: "Xbmc", configContract: "XbmcSettings" }
				: options.notificationKind === "synology"
					? {
							implementation: "SynologyIndexer",
							configContract: "SynologyIndexerSettings",
						}
					: { implementation: "PlexServer", configContract: "PlexServerSettings" };
	const notification =
		options.action === "delete_files"
			? {
					...notificationIdentity,
					onMovieFileDelete: options.onMovieFileDelete ?? true,
					tags: options.notificationTags ?? [],
					fields: notificationFields(options),
				}
			: {
					...notificationIdentity,
					onMovieDelete: options.onMovieDelete ?? true,
					onMovieFileDelete: options.onMovieFileDelete ?? true,
					tags: options.notificationTags ?? [],
					fields: notificationFields(options),
				};
	const targetClient = {
		movie: {
			getById: options.targetFailure
				? vi.fn().mockRejectedValue(options.targetFailure)
				: vi.fn(async () => {
						if (!liveMovieExists) throw new NotFoundError("Movie not found");
						return {
							...targetMovie,
							hasFile: liveMovieFileId !== undefined,
							movieFileId: liveMovieFileId,
						};
					}),
			delete: deleteMovie,
		},
		movieFile: {
			getById: vi.fn().mockResolvedValue(targetMovieFile),
			delete: deleteMovieFile,
		},
		notification: {
			getAll: options.notificationFailure
				? vi.fn().mockRejectedValue(options.notificationFailure)
				: vi
						.fn()
						.mockResolvedValue(options.includePlexNotification === false ? [] : [notification]),
		},
	};
	const createArrClient = vi.fn(() => targetClient);
	const defaultParts = [
		{
			file: "/plex/movies-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
			size: 1_000,
		},
		{
			file: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
			size: 2_000,
		},
	].slice(-(options.mediaPartCount ?? 2));
	const getMovieMediaPartsByTmdbId = options.plexFailure
		? vi.fn().mockRejectedValue(options.plexFailure)
		: vi
				.fn()
				.mockResolvedValue(
					options.plexItems ?? [{ ratingKey: "plex-movie-42", parts: defaultParts }],
				);
	const getAccounts = options.ownerFailure
		? vi.fn().mockRejectedValue(options.ownerFailure)
		: vi.fn().mockResolvedValue([{ id: 1, name: "Owner" }]);
	const plexClientFactory = vi.fn(() => ({
		getAccounts,
		getMovieMediaPartsByTmdbId,
		getSeriesEpisodeMediaPartsByTvdbId: vi.fn(),
	}));
	const serviceInstanceFindMany = vi.fn(({ where }: { where: { service: string } }) =>
		where.service === "PLEX"
			? Promise.resolve(options.includePlexInstance === false ? [] : [plexInstance])
			: Promise.resolve([targetInstance]),
	);

	const deps: CleanupExecutorDeps = {
		prisma: {
			serviceInstance: {
				findMany: serviceInstanceFindMany,
				findFirst: vi.fn().mockResolvedValue(targetInstance),
			},
			libraryCleanupApproval: {
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
				findMany: vi.fn().mockResolvedValue([]),
				update: vi.fn().mockResolvedValue({}),
			},
			libraryCache: {
				deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			libraryCleanupLog: {
				create: vi.fn().mockResolvedValue({}),
			},
		} as unknown as CleanupExecutorDeps["prisma"],
		arrClientFactory: {
			create: createArrClient,
		} as unknown as CleanupExecutorDeps["arrClientFactory"],
		plexClientFactory,
		log: silentLog,
	};

	return {
		deps,
		deleteMovie,
		deleteMovieFile,
		targetClient,
		plexInstance,
		plexClientFactory,
		getAccounts,
		getMovieMediaPartsByTmdbId,
		setLiveMovieExists: (exists: boolean) => {
			liveMovieExists = exists;
		},
		setLiveMovieFileId: (movieFileId: number | undefined) => {
			liveMovieFileId = movieFileId;
		},
	};
}

describe("shared Plex deletion safety", () => {
	const target = {
		instanceId: "radarr-4k",
		arrItemId: 101,
		itemType: "movie",
		action: "delete",
	};

	it("renders only preview items that can receive live safety inspection", () => {
		const flagged = Array.from({ length: 201 }, (_, index) => ({
			cacheItem: { arrItemId: index + 1 },
		})) as never;

		expect(selectInspectableCleanupPreviewItems(flagged)).toHaveLength(200);
		expect(selectInspectableCleanupPreviewItems(flagged).at(-1)?.cacheItem.arrItemId).toBe(200);
	});

	it("blocks when the target Radarr refreshes a live multi-part Plex item", async () => {
		const { deps, plexInstance, plexClientFactory, getMovieMediaPartsByTmdbId } = makeDeps();
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain("Plex has multiple files merged");
		expect(plexClientFactory).toHaveBeenCalledWith(plexInstance);
		expect(getMovieMediaPartsByTmdbId).toHaveBeenCalledWith(42);
	});

	it("allows deletion when live Plex reports only one media part", async () => {
		const { deps, getAccounts } = makeDeps({ mediaPartCount: 1 });

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [target])).toEqual(new Map());
		expect(getAccounts).toHaveBeenCalledOnce();
	});

	it("allows deletion when the normalized full Radarr and Plex paths match exactly", async () => {
		const { deps } = makeDeps({
			plexItems: [
				{
					ratingKey: "plex-movie-42",
					parts: [
						{
							file: "/movies-4k/Example Movie (2024)/./Example.Movie.2160p.mkv",
							size: 2_000,
						},
					],
				},
			],
		});

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [target])).toEqual(new Map());
	});

	it("fails closed when Docker mount prefixes differ without an authoritative mapping", async () => {
		const { deps, targetClient } = makeDeps({
			plexItems: [
				{
					ratingKey: "plex-movie-42",
					parts: [
						{
							file: "/plex/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
							size: 2_000,
						},
					],
				},
			],
		});
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"could not match the exact Radarr movie file",
		);
		expect(targetClient.movieFile.getById).toHaveBeenCalledWith(1001);
	});

	it("uses Radarr's explicit Plex path mapping for different Docker mount prefixes", async () => {
		const { deps } = makeDeps({
			mapFrom: "/movies-4k",
			mapTo: "/plex/movies-4k",
			plexItems: [
				{
					ratingKey: "plex-movie-42",
					parts: [
						{
							file: "/plex/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
							size: 2_000,
						},
					],
				},
			],
		});

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [target])).toEqual(new Map());
	});

	it("fails closed when Radarr's Plex path mapping is incomplete", async () => {
		const { deps } = makeDeps({
			mapFrom: "/movies-4k",
			plexItems: [
				{
					ratingKey: "plex-movie-42",
					parts: [
						{
							file: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
							size: 2_000,
						},
					],
				},
			],
		});
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"could not match the exact Radarr movie file",
		);
	});

	it("fails closed when no Plex part has the exact target Radarr path", async () => {
		const { deps } = makeDeps({
			plexItems: [
				{
					ratingKey: "plex-movie-42",
					parts: [
						{
							file: "/plex/other/Example Movie (2024)/Different.Movie.2160p.mkv",
							size: 2_000,
						},
					],
				},
			],
		});
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"could not match the exact Radarr movie file",
		);
	});

	it("fails closed when the matching path has a different file size", async () => {
		const { deps } = makeDeps({
			plexItems: [
				{
					ratingKey: "plex-movie-42",
					parts: [
						{
							file: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
							size: 2_001,
						},
					],
				},
			],
		});
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"could not match the exact Radarr movie file",
		);
	});

	it("fails closed when multiple Plex parts match the exact target identity", async () => {
		const matchingPart = {
			file: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
			size: 2_000,
		};
		const { deps } = makeDeps({
			plexItems: [
				{ ratingKey: "plex-movie-a", parts: [matchingPart] },
				{ ratingKey: "plex-movie-b", parts: [{ ...matchingPart }] },
			],
		});
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"could not match the exact Radarr movie file",
		);
	});

	it("normalizes Windows separators and casing for an exact full-path match", async () => {
		const { deps } = makeDeps({
			movieFile: {
				path: "D:\\Movies\\Example Movie (2024)\\Example.Movie.2160p.mkv",
				size: 2_000,
			},
			plexItems: [
				{
					ratingKey: "plex-movie-42",
					parts: [
						{
							file: "d:/movies/example movie (2024)/example.movie.2160p.mkv",
							size: 2_000,
						},
					],
				},
			],
		});

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [target])).toEqual(new Map());
	});

	it("normalizes UNC paths without collapsing them into the POSIX namespace", async () => {
		const { deps } = makeDeps({
			movieFile: {
				path: "\\\\MEDIA-SERVER\\Movies\\Example Movie (2024)\\Example.Movie.2160p.mkv",
				size: 2_000,
			},
			plexItems: [
				{
					ratingKey: "plex-movie-42",
					parts: [
						{
							file: "/MEDIA-SERVER/Movies/Example Movie (2024)/Example.Movie.2160p.mkv",
							size: 2_000,
						},
					],
				},
			],
		});
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"could not match the exact Radarr movie file",
		);
	});

	it("matches equivalent UNC paths case-insensitively", async () => {
		const { deps } = makeDeps({
			movieFile: {
				path: "\\\\MEDIA-SERVER\\Movies\\Example Movie (2024)\\Example.Movie.2160p.mkv",
				size: 2_000,
			},
			plexItems: [
				{
					ratingKey: "plex-movie-42",
					parts: [
						{
							file: "//media-server/movies/example movie (2024)/example.movie.2160p.mkv",
							size: 2_000,
						},
					],
				},
			],
		});

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [target])).toEqual(new Map());
	});

	it("fails closed when Radarr cannot identify the movie file", async () => {
		const { deps } = makeDeps({
			movieFile: { path: null, relativePath: null, size: 2_000 },
		});
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"could not match the exact Radarr movie file",
		);
	});

	it("allows deletion when no applicable Radarr Plex notification exists", async () => {
		const { deps, plexClientFactory } = makeDeps({ includePlexNotification: false });
		const context = createSharedPlexSafetyContext();
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target], undefined, context);

		expect(blocks).toEqual(new Map());
		expect(plexClientFactory).not.toHaveBeenCalled();
		expect(context.plans.get(cleanupDeleteTargetKey(target))).toMatchObject({
			kind: "verified_radarr",
			file: { movieFileId: 1001 },
		});
	});

	it("still uses exact-file deletion when no media-server notification applies", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({
			includePlexNotification: false,
		});
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord() as never,
		]);

		await expect(executeApprovedItems(deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(deleteMovie).toHaveBeenCalledWith(101, {
			deleteFiles: false,
			addImportExclusion: false,
		});
	});

	it("allows deletion when the Radarr Plex connection has library updates disabled", async () => {
		const { deps, plexClientFactory } = makeDeps({ updateLibrary: false });
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks).toEqual(new Map());
		expect(plexClientFactory).not.toHaveBeenCalled();
	});

	it("respects Radarr notification tag restrictions", async () => {
		const { deps, plexClientFactory } = makeDeps({
			movieTags: [1],
			notificationTags: [2],
		});
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks).toEqual(new Map());
		expect(plexClientFactory).not.toHaveBeenCalled();
	});

	it.each([
		["Emby/Jellyfin", "mediabrowser" as const, {}],
		["Kodi", "kodi" as const, { updateLibrary: false, cleanLibrary: true }],
		["Synology Indexer", "synology" as const, {}],
	])(
		"blocks an unmodeled %s library mutation",
		async (destination, notificationKind, fieldOptions) => {
			const { deps, plexClientFactory } = makeDeps({
				notificationKind,
				...fieldOptions,
			});
			const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

			expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(destination);
			expect(plexClientFactory).not.toHaveBeenCalled();
		},
	);

	it.each([
		["target movie", { targetFailure: new Error("target unavailable") }],
		["target notifications", { notificationFailure: new Error("notifications unavailable") }],
		["Plex owner credential", { ownerFailure: new Error("owner access unavailable") }],
		["Plex movie", { plexFailure: new Error("Plex unavailable") }],
		["matching Plex instance", { includePlexInstance: false }],
	] as const)("fails closed when live %s state cannot be verified", async (_label, options) => {
		const { deps } = makeDeps(options);
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"could not verify the live Radarr and Plex",
		);
	});

	it("fails closed when owned Radarr instances cannot be loaded", async () => {
		const { deps } = makeDeps();
		vi.mocked(deps.prisma.serviceInstance.findMany).mockRejectedValue(
			new Error("database offline"),
		);

		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.has(cleanupDeleteTargetKey(target))).toBe(true);
	});

	it("blocks when any matching owner credential cannot verify media state", async () => {
		const { deps, plexInstance } = makeDeps({ mediaPartCount: 1 });
		const secondPlexInstance = { ...plexInstance, id: "plex-2" };
		vi.mocked(deps.prisma.serviceInstance.findMany).mockImplementation((args) => {
			const service = args?.where?.service;
			return (
				service === "PLEX"
					? Promise.resolve([plexInstance, secondPlexInstance])
					: Promise.resolve([
							{
								id: "radarr-4k",
								userId: "user-1",
								service: "RADARR",
								label: "4K Radarr",
								enabled: true,
							},
						])
			) as never;
		});
		vi.mocked(deps.plexClientFactory!).mockImplementation((instance) =>
			instance.id === "plex-2"
				? ({
						getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Owner" }]),
						getMovieMediaPartsByTmdbId: vi.fn().mockRejectedValue(new Error("Plex media timeout")),
					} as never)
				: ({
						getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Owner" }]),
						getMovieMediaPartsByTmdbId: vi.fn().mockResolvedValue([
							{
								ratingKey: "plex-movie-42",
								parts: [
									{
										file: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
										size: 2_000,
									},
								],
							},
						]),
					} as never),
		);

		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"could not verify the live Radarr and Plex",
		);
	});

	it("re-authenticates when a configured Plex connection changes during a run", async () => {
		const { deps, plexInstance, targetClient } = makeDeps({ mediaPartCount: 1 });
		const changedPlexInstance = {
			...plexInstance,
			baseUrl: "http://plex-new.internal:32400",
			encryptedApiKey: "new-encrypted-token",
			encryptionIv: "new-iv",
			updatedAt: new Date("2026-07-27T12:01:00.000Z"),
		};
		let plexLookup = 0;
		vi.mocked(deps.prisma.serviceInstance.findMany).mockImplementation((args) => {
			if (args?.where?.service === "PLEX") {
				plexLookup++;
				return Promise.resolve([plexLookup === 1 ? plexInstance : changedPlexInstance]) as never;
			}
			return Promise.resolve([
				{
					id: "radarr-4k",
					userId: "user-1",
					service: "RADARR",
					label: "4K Radarr",
					enabled: true,
				},
			]) as never;
		});
		targetClient.notification.getAll
			.mockResolvedValueOnce([
				{
					implementation: "PlexServer",
					onMovieDelete: true,
					onMovieFileDelete: true,
					fields: notificationFields({}),
				},
			])
			.mockResolvedValueOnce([
				{
					implementation: "PlexServer",
					onMovieDelete: true,
					onMovieFileDelete: true,
					fields: [
						...notificationFields({}).filter((field) => field.name !== "host"),
						{ name: "host", value: "plex-new.internal" },
					],
				},
			]);
		const safePlexItems = [
			{
				ratingKey: "plex-movie-42",
				parts: [
					{
						file: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
						size: 2_000,
					},
				],
			},
		];
		const firstMediaLookup = vi.fn().mockResolvedValue(safePlexItems);
		const secondMediaLookup = vi.fn().mockResolvedValue(safePlexItems);
		vi.mocked(deps.plexClientFactory!).mockImplementation((instance) => ({
			getAccounts: vi.fn().mockResolvedValue([{ id: 1, name: "Owner" }]),
			getMovieMediaPartsByTmdbId:
				instance.baseUrl === plexInstance.baseUrl ? firstMediaLookup : secondMediaLookup,
			getSeriesEpisodeMediaPartsByTvdbId: vi.fn(),
		}));
		const context = createSharedPlexSafetyContext();

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [target], undefined, context)).toEqual(
			new Map(),
		);
		expect(
			await findSharedPlexDeleteBlocks(
				deps,
				"user-1",
				[{ ...target, arrItemId: 102 }],
				undefined,
				context,
			),
		).toEqual(new Map());

		expect(deps.plexClientFactory).toHaveBeenCalledTimes(2);
		expect(firstMediaLookup).toHaveBeenCalledOnce();
		expect(secondMediaLookup).toHaveBeenCalledOnce();
	});

	it("uses the movie-file-delete notification for delete-files actions", async () => {
		const deleteFilesTarget = { ...target, action: "delete_files" as const };
		const { deps } = makeDeps({ action: "delete_files" });
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [deleteFilesTarget]);

		expect(blocks.has(cleanupDeleteTargetKey(deleteFilesTarget))).toBe(true);
	});

	it("also treats movie-file-delete notifications as relevant to full deletes", async () => {
		const { deps, targetClient } = makeDeps();
		targetClient.notification.getAll.mockResolvedValue([
			{
				implementation: "PlexServer",
				onMovieFileDelete: true,
				fields: notificationFields({}),
			},
		]);

		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.has(cleanupDeleteTargetKey(target))).toBe(true);
	});

	it("blocks full deletion when an entity-only Plex trigger could not be preserved", async () => {
		const { deps, getMovieMediaPartsByTmdbId } = makeDeps({
			mediaPartCount: 1,
			onMovieFileDelete: false,
		});

		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain("movie-file-delete");
		expect(getMovieMediaPartsByTmdbId).not.toHaveBeenCalled();
	});

	it("does not inspect non-destructive actions", async () => {
		const { deps, plexClientFactory } = makeDeps();
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [
			{ ...target, action: "unmonitor" },
		]);

		expect(blocks).toEqual(new Map());
		expect(deps.prisma.serviceInstance.findMany).not.toHaveBeenCalled();
		expect(plexClientFactory).not.toHaveBeenCalled();
	});

	it("prevents an approved deletion from reaching Radarr and returns it to pending", async () => {
		const { deps, deleteMovie } = makeDeps();
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			{
				id: "approval-1",
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				reason: "Matched 4K cleanup rule",
				action: "delete",
			} as never,
		]);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("Plex has multiple files merged");
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCleanupApproval.update).toHaveBeenCalledWith({
			where: { id: "approval-1" },
			data: {
				status: "pending",
				lastExecutionError: expect.stringContaining("Plex has multiple files merged"),
			},
		});
	});

	it.each([
		["unknown action", { action: "legacy_delete", itemType: "movie" }],
		["mismatched media type", { action: "delete", itemType: "series" }],
	])("fails an approved item closed for an %s", async (_label, shape) => {
		const { deps, deleteMovie, targetClient, plexClientFactory } = makeDeps({
			mediaPartCount: 1,
		});
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			{
				id: "approval-1",
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: shape.itemType,
				title: "Example Movie",
				reason: "Matched 4K cleanup rule",
				action: shape.action,
			} as never,
		]);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("stored action or media type is invalid");
		expect(targetClient.movie.getById).not.toHaveBeenCalled();
		expect(plexClientFactory).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCleanupApproval.update).toHaveBeenCalledWith({
			where: { id: "approval-1" },
			data: {
				status: "pending",
				lastExecutionError: expect.stringContaining("stored action or media type is invalid"),
			},
		});
	});

	it("rechecks at the direct mutation boundary and blocks the Radarr delete", async () => {
		const { deps, deleteMovie } = makeDeps();
		const flaggedItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				year: 2024,
				hasFile: true,
				sizeOnDisk: 1000n,
				data: JSON.stringify({
					path: "/movies-4k/Example Movie (2024)",
					movieFile: {
						id: 1001,
						path: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
						size: 2_000,
					},
				}),
			},
			match: {
				ruleId: "rule-1",
				ruleName: "4K cleanup",
				reason: "Matched 4K profile",
				action: "delete",
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", rules: [] } as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(deleteMovie).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: "partial",
			itemsRemoved: 0,
			itemsSkipped: 1,
			details: [expect.objectContaining({ action: "skipped" })],
		});
	});

	it("allows a direct delete only after the mutation-boundary Plex check is safe", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const flaggedItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				year: 2024,
				...radarrCachedFileIdentity,
				sizeOnDisk: 1000n,
			},
			match: {
				ruleId: "rule-1",
				ruleName: "4K cleanup",
				reason: "Matched 4K profile",
				action: "delete",
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", rules: [] } as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(deleteMovie).toHaveBeenCalledWith(101, {
			deleteFiles: false,
			addImportExclusion: false,
		});
		expect(result).toMatchObject({ status: "completed", itemsRemoved: 1, itemsSkipped: 0 });
	});

	it("removes an already-fileless Radarr record without enabling file deletion", async () => {
		const { deps, deleteMovie, deleteMovieFile, getMovieMediaPartsByTmdbId } = makeDeps({
			initialMovieFileId: null,
			mediaPartCount: 1,
		});
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			{
				id: "approval-1",
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				action: "delete",
				title: "Example Movie",
				safetySnapshot: radarrSafetySnapshot(null),
			} as never,
		]);

		await expect(executeApprovedItems(deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).toHaveBeenCalledWith(101, {
			deleteFiles: false,
			addImportExclusion: false,
		});
		expect(getMovieMediaPartsByTmdbId).not.toHaveBeenCalled();
	});

	it("does not delete a replacement imported after an empty Radarr preflight", async () => {
		const { deps, targetClient, deleteMovie, deleteMovieFile } = makeDeps({
			initialMovieFileId: null,
			mediaPartCount: 1,
		});
		const emptyMovie = {
			id: 101,
			tmdbId: 42,
			title: "Example Movie",
			tags: [],
			hasFile: false,
			movieFileId: undefined,
			path: "/movies-4k/Example Movie (2024)",
			rootFolderPath: "/movies-4k",
		};
		targetClient.movie.getById
			.mockResolvedValueOnce(emptyMovie)
			.mockResolvedValueOnce({ ...emptyMovie, hasFile: true, movieFileId: 1002 });
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			{
				id: "approval-1",
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				action: "delete",
				title: "Example Movie",
				safetySnapshot: radarrSafetySnapshot(null),
			} as never,
		]);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
	});

	it("requires a new approval when the queued Radarr file identity was replaced", async () => {
		const replacementPath = "/movies-4k/Example Movie (2024)/Example.Movie.Replacement.2160p.mkv";
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({
			initialMovieFileId: 1002,
			mediaPartCount: 1,
			movieFile: { id: 1002, path: replacementPath, size: 2_500 },
			plexItems: [
				{
					ratingKey: "plex-movie-42",
					parts: [{ file: replacementPath, size: 2_500 }],
				},
			],
		});
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord() as never,
		]);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("file identity changed after this cleanup item was queued");
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCleanupApproval.update).toHaveBeenCalledWith({
			where: { id: "approval-1" },
			data: {
				status: "expired",
				reviewedAt: expect.any(Date),
				lastExecutionError: expect.stringContaining("file identity changed"),
			},
		});
	});

	it("rechecks an empty Radarr delete-files plan instead of deleting a replacement", async () => {
		const { deps, targetClient, deleteMovieFile } = makeDeps({
			action: "delete_files",
			initialMovieFileId: null,
		});
		const emptyMovie = {
			id: 101,
			tmdbId: 42,
			title: "Example Movie",
			tags: [],
			hasFile: false,
			movieFileId: undefined,
			path: "/movies-4k/Example Movie (2024)",
			rootFolderPath: "/movies-4k",
		};
		targetClient.movie.getById
			.mockResolvedValueOnce(emptyMovie)
			.mockResolvedValueOnce({ ...emptyMovie, hasFile: true, movieFileId: 1002 });
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			{
				id: "approval-1",
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				action: "delete_files",
				title: "Example Movie",
				safetySnapshot: radarrSafetySnapshot(null),
			} as never,
		]);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(deleteMovieFile).not.toHaveBeenCalled();
	});

	it("retains the Radarr record when a replacement appears after exact file deletion", async () => {
		const { deps, deleteMovie, deleteMovieFile, setLiveMovieFileId } = makeDeps({
			mediaPartCount: 1,
		});
		deleteMovieFile.mockImplementationOnce(async () => {
			setLiveMovieFileId(1002);
		});
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			{
				id: "approval-1",
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				action: "delete",
				title: "Example Movie",
				safetySnapshot: radarrSafetySnapshot(),
			} as never,
		]);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("replacement file appeared");
		expect(deleteMovie).not.toHaveBeenCalled();
		const pendingUpdate = vi
			.mocked(deps.prisma.libraryCleanupApproval.update)
			.mock.calls.at(-1)?.[0];
		expect(pendingUpdate?.data).not.toHaveProperty("safetySnapshot");
	});

	it("accepts a lost Radarr file-delete response only after confirming absence", async () => {
		const { deps, deleteMovieFile, setLiveMovieFileId } = makeDeps({
			action: "delete_files",
			mediaPartCount: 1,
		});
		deleteMovieFile.mockImplementationOnce(async () => {
			setLiveMovieFileId(undefined);
			throw new Error("response lost");
		});
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			{
				id: "approval-1",
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				action: "delete_files",
				title: "Example Movie",
				safetySnapshot: radarrSafetySnapshot(),
			} as never,
		]);

		await expect(executeApprovedItems(deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
	});

	it("accepts a lost Radarr record-delete response after a not-found readback", async () => {
		const { deps, deleteMovie, setLiveMovieExists } = makeDeps({ mediaPartCount: 1 });
		deleteMovie.mockImplementationOnce(async () => {
			setLiveMovieExists(false);
			throw new Error("response lost");
		});
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			{
				id: "approval-1",
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				action: "delete",
				title: "Example Movie",
				safetySnapshot: radarrSafetySnapshot(),
			} as never,
		]);

		await expect(executeApprovedItems(deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(deleteMovie).toHaveBeenCalledOnce();
	});

	it("fails closed when Radarr replaces the verified file before a full delete", async () => {
		const { deps, deleteMovie, deleteMovieFile, targetClient } = makeDeps({
			mediaPartCount: 1,
		});
		targetClient.movie.getById
			.mockResolvedValueOnce({
				id: 101,
				tmdbId: 42,
				title: "Example Movie",
				tags: [],
				hasFile: true,
				movieFileId: 1001,
				path: "/movies-4k/Example Movie (2024)",
				rootFolderPath: "/movies-4k",
			})
			.mockResolvedValueOnce({
				id: 101,
				tmdbId: 42,
				title: "Example Movie",
				tags: [],
				hasFile: true,
				movieFileId: 1002,
				path: "/movies-4k/Example Movie (2024)",
				rootFolderPath: "/movies-4k",
			});
		const flaggedItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				year: 2024,
				...radarrCachedFileIdentity,
				sizeOnDisk: 1000n,
			},
			match: {
				ruleId: "rule-1",
				ruleName: "4K cleanup",
				reason: "Matched 4K profile",
				action: "delete",
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", rules: [] } as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(result.details[0]?.reason).toContain("Radarr movie file changed");
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
	});

	it("does not apply a cached rule match to a different live Radarr file", async () => {
		const replacementPath = "/movies-4k/Example Movie (2024)/Example.Movie.Replacement.2160p.mkv";
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({
			initialMovieFileId: 1002,
			mediaPartCount: 1,
			movieFile: { id: 1002, path: replacementPath, size: 2_500 },
			plexItems: [
				{
					ratingKey: "plex-movie-42",
					parts: [{ file: replacementPath, size: 2_500 }],
				},
			],
		});
		const flaggedItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				year: 2024,
				...radarrCachedFileIdentity,
				sizeOnDisk: 2_000n,
			},
			match: {
				ruleId: "rule-1",
				ruleName: "4K cleanup",
				reason: "Matched cached file",
				action: "delete",
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", rules: [] } as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(result.details[0]?.reason).toContain("differs from the cached item");
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
	});

	it("deletes the exact verified Radarr file ID for delete-files actions", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({
			action: "delete_files",
			mediaPartCount: 1,
		});
		const flaggedItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				year: 2024,
				...radarrCachedFileIdentity,
				sizeOnDisk: 1000n,
			},
			match: {
				ruleId: "rule-1",
				ruleName: "4K cleanup",
				reason: "Matched 4K profile",
				action: "delete_files",
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", rules: [] } as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(result).toMatchObject({ status: "completed", itemsFilesDeleted: 1 });
	});

	it("treats hasFile=false with a positive Radarr file ID as an unknown delete outcome", async () => {
		const { deps, targetClient, deleteMovieFile } = makeDeps({
			action: "delete_files",
			mediaPartCount: 1,
		});
		const movie = {
			id: 101,
			tmdbId: 42,
			title: "Example Movie",
			tags: [],
			hasFile: true,
			movieFileId: 1001,
			path: "/movies-4k/Example Movie (2024)",
			rootFolderPath: "/movies-4k",
		};
		targetClient.movie.getById
			.mockResolvedValueOnce(movie)
			.mockResolvedValueOnce(movie)
			.mockResolvedValueOnce({ ...movie, hasFile: false });
		deleteMovieFile.mockResolvedValueOnce(undefined);
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({ action: "delete_files" }) as never,
		]);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("outcome could not be verified");
		expect(deps.prisma.libraryCache.updateMany).toHaveBeenCalledWith({
			where: { instanceId: "radarr-4k", arrItemId: 101, itemType: "movie" },
			data: { hasFile: true, sizeOnDisk: 2_000 },
		});
	});

	it("records an honest partial result when the file delete succeeds but movie removal fails", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		deleteMovie.mockRejectedValue(new Error("Radarr movie delete unavailable"));
		const flaggedItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				year: 2024,
				...radarrCachedFileIdentity,
				sizeOnDisk: 1000n,
			},
			match: {
				ruleId: "rule-1",
				ruleName: "4K cleanup",
				reason: "Matched 4K profile",
				action: "delete",
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", rules: [] } as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({
			status: "partial",
			itemsRemoved: 0,
			itemsFilesDeleted: 1,
			details: [
				expect.objectContaining({
					action: "files_deleted",
					reason: expect.stringContaining("movie record could not be removed"),
				}),
			],
		});
		expect(deps.prisma.libraryCache.updateMany).toHaveBeenCalledWith({
			where: { instanceId: "radarr-4k", arrItemId: 101, itemType: "movie" },
			data: { hasFile: false, sizeOnDisk: 0 },
		});
	});

	it("returns a partially completed approval to pending with accurate file state", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		deleteMovie.mockRejectedValue(new Error("Radarr movie delete unavailable"));
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			{
				id: "approval-1",
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				reason: "Matched 4K cleanup rule",
				action: "delete",
				safetySnapshot: radarrSafetySnapshot(),
			} as never,
		]);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("movie record could not be removed");
		expect(deps.prisma.libraryCache.updateMany).toHaveBeenCalledWith({
			where: { instanceId: "radarr-4k", arrItemId: 101, itemType: "movie" },
			data: { hasFile: false, sizeOnDisk: 0 },
		});
		expect(deps.prisma.libraryCleanupApproval.update).toHaveBeenCalledWith({
			where: { id: "approval-1" },
			data: {
				status: "pending",
				lastExecutionError: expect.stringContaining("movie record could not be removed"),
				safetySnapshot: radarrSafetySnapshot(null),
			},
		});
	});

	it("retries a verified fileless Radarr approval without deleting files again", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const storedApproval = approvalRecord();
		const approvalFindMany = vi.mocked(deps.prisma.libraryCleanupApproval.findMany);
		const approvalUpdate = vi.mocked(deps.prisma.libraryCleanupApproval.update);
		approvalFindMany.mockImplementation((async () => [storedApproval]) as never);
		approvalUpdate.mockImplementation((async ({ data }: { data: Record<string, unknown> }) => {
			Object.assign(storedApproval, data);
			return {};
		}) as never);
		deleteMovie
			.mockRejectedValueOnce(new Error("Radarr movie delete unavailable"))
			.mockRejectedValueOnce(new Error("Radarr movie delete unavailable"));

		const firstResult = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(firstResult).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({
			status: "pending",
			safetySnapshot: radarrSafetySnapshot(null),
		});

		const retryResult = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(retryResult).toEqual({ removed: 1, failed: 0, errors: [] });
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledTimes(3);
		expect(storedApproval).toMatchObject({
			status: "executed",
			lastExecutionError: null,
		});
	});

	it("does not requeue a successful approved delete when its cache cleanup fails", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			{
				id: "approval-1",
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				reason: "Matched 4K cleanup rule",
				action: "delete",
				safetySnapshot: radarrSafetySnapshot(),
			} as never,
		]);
		vi.mocked(deps.prisma.libraryCache.deleteMany).mockRejectedValue(
			new Error("cache unavailable"),
		);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 1, failed: 0, errors: [] });
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledOnce();
		expect(deps.prisma.libraryCleanupApproval.update).toHaveBeenCalledWith({
			where: { id: "approval-1" },
			data: {
				status: "executed",
				executedAt: expect.any(Date),
				lastExecutionError: null,
			},
		});
	});

	it("retries only the executed-status write after an approved delete succeeds", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			{
				id: "approval-1",
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				reason: "Matched 4K cleanup rule",
				action: "delete",
				safetySnapshot: radarrSafetySnapshot(),
			} as never,
		]);
		vi.mocked(deps.prisma.libraryCleanupApproval.update)
			.mockRejectedValueOnce(new Error("database unavailable"))
			.mockResolvedValueOnce({} as never);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 1, failed: 0, errors: [] });
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledOnce();
		expect(deps.prisma.libraryCleanupApproval.update).toHaveBeenCalledTimes(2);
		expect(deps.prisma.libraryCleanupApproval.update).toHaveBeenLastCalledWith({
			where: { id: "approval-1" },
			data: {
				status: "executed",
				executedAt: expect.any(Date),
				lastExecutionError: null,
			},
		});
	});

	it("exclusively claims an approval across concurrent execution requests", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const approval = {
			id: "approval-1",
			instanceId: "radarr-4k",
			arrItemId: 101,
			itemType: "movie",
			title: "Example Movie",
			reason: "Matched 4K cleanup rule",
			action: "delete",
			safetySnapshot: radarrSafetySnapshot(),
		} as never;
		let state = "approved";
		vi.mocked(deps.prisma.libraryCleanupApproval.updateMany).mockImplementation((async () => {
			if (state !== "approved") return { count: 0 };
			state = "executing";
			return { count: 1 };
		}) as never);
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async () =>
			state === "executing" ? [approval] : []) as never);
		vi.mocked(deps.prisma.libraryCleanupApproval.update).mockImplementation((async (args: {
			data: { status: string };
		}) => {
			state = args.data.status;
			return {};
		}) as never);

		const [first, second] = await Promise.all([
			executeApprovedItems(deps, "user-1", ["approval-1"]),
			executeApprovedItems(deps, "user-1", ["approval-1"]),
		]);

		expect(first.removed + second.removed).toBe(1);
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledOnce();
		expect(state).toBe("executed");
	});

	it("cannot replay an approval when both executed-status writes fail", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const approval = {
			id: "approval-1",
			instanceId: "radarr-4k",
			arrItemId: 101,
			itemType: "movie",
			title: "Example Movie",
			reason: "Matched 4K cleanup rule",
			action: "delete",
			safetySnapshot: radarrSafetySnapshot(),
		} as never;
		let state = "approved";
		vi.mocked(deps.prisma.libraryCleanupApproval.updateMany).mockImplementation((async () => {
			if (state !== "approved") return { count: 0 };
			state = "executing";
			return { count: 1 };
		}) as never);
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async () =>
			state === "executing" ? [approval] : []) as never);
		vi.mocked(deps.prisma.libraryCleanupApproval.update).mockRejectedValue(
			new Error("database unavailable"),
		);

		const first = await executeApprovedItems(deps, "user-1", ["approval-1"]);
		const second = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(first).toMatchObject({ removed: 1, failed: 1 });
		expect(second).toEqual({ removed: 0, failed: 0, errors: [] });
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledOnce();
		expect(state).toBe("executing");
	});

	it("executes earlier claims when a later approval claim fails", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const approval = {
			id: "approval-1",
			instanceId: "radarr-4k",
			arrItemId: 101,
			itemType: "movie",
			title: "Example Movie",
			reason: "Matched 4K cleanup rule",
			action: "delete",
			safetySnapshot: radarrSafetySnapshot(),
		} as never;
		vi.mocked(deps.prisma.libraryCleanupApproval.updateMany).mockImplementation(((args: {
			where: { id: string };
		}) =>
			args.where.id === "approval-2"
				? Promise.reject(new Error("database unavailable"))
				: Promise.resolve({ count: 1 })) as never);
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([approval]);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1", "approval-2"]);

		expect(result).toMatchObject({ removed: 1, failed: 1 });
		expect(result.errors).toContain(
			"A cleanup approval could not be claimed and was not executed.",
		);
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledOnce();
	});

	it("fails a direct item closed when its stored action is unknown", async () => {
		const { deps, deleteMovie, targetClient, plexClientFactory } = makeDeps({
			mediaPartCount: 1,
		});
		const flaggedItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				year: 2024,
				sizeOnDisk: 1000n,
			},
			match: {
				ruleId: "rule-1",
				ruleName: "Legacy cleanup",
				reason: "Matched legacy rule",
				action: "legacy_delete",
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", rules: [] } as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(result).toMatchObject({ status: "partial", itemsRemoved: 0, itemsSkipped: 1 });
		expect(result.warnings).toContain(
			"1 item was skipped because the stored cleanup action or media type was invalid.",
		);
		expect(targetClient.movie.getById).not.toHaveBeenCalled();
		expect(plexClientFactory).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
	});

	it("short-circuits repeated Plex dependency failures within a direct run", async () => {
		const { deps, deleteMovie, getAccounts, getMovieMediaPartsByTmdbId } = makeDeps({
			plexFailure: new Error("Plex unavailable"),
		});
		const flaggedItems = [101, 102].map(
			(arrItemId) =>
				({
					cacheItem: {
						instanceId: "radarr-4k",
						arrItemId,
						itemType: "movie",
						title: `Example Movie ${arrItemId}`,
						year: 2024,
						sizeOnDisk: 1000n,
					},
					match: {
						ruleId: "rule-1",
						ruleName: "4K cleanup",
						reason: "Matched 4K profile",
						action: "delete",
					},
					rating: 8,
				}) as never,
		);

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", rules: [] } as never,
			"user-1",
			flaggedItems,
			2,
			2,
			Date.now(),
		);

		expect(result).toMatchObject({ status: "partial", itemsRemoved: 0, itemsSkipped: 2 });
		expect(getAccounts).toHaveBeenCalledOnce();
		expect(getMovieMediaPartsByTmdbId).toHaveBeenCalledOnce();
		expect(deleteMovie).not.toHaveBeenCalled();
	});

	it("fails an approved item closed when its instance lookup rejects", async () => {
		const { deps, deleteMovie } = makeDeps({ mediaPartCount: 1 });
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			{
				id: "approval-1",
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				reason: "Matched 4K cleanup rule",
				action: "delete",
			} as never,
		]);
		vi.mocked(deps.prisma.serviceInstance.findFirst).mockRejectedValue(
			new Error("database offline"),
		);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCleanupApproval.update).toHaveBeenCalledWith({
			where: { id: "approval-1" },
			data: {
				status: "pending",
				lastExecutionError: expect.stringContaining("ARR instance could not be loaded"),
			},
		});
	});

	it("skips a direct delete when its instance lookup rejects", async () => {
		const { deps, deleteMovie } = makeDeps({ mediaPartCount: 1 });
		vi.mocked(deps.prisma.serviceInstance.findFirst).mockRejectedValue(
			new Error("database offline"),
		);
		const flaggedItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				year: 2024,
				sizeOnDisk: 1000n,
			},
			match: {
				ruleId: "rule-1",
				ruleName: "4K cleanup",
				reason: "Matched 4K profile",
				action: "delete",
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", rules: [] } as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(deleteMovie).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: "partial",
			itemsRemoved: 0,
			itemsSkipped: 1,
		});
	});

	it("shows the same safety-blocked action and reason in previews", () => {
		const safetyReason = "Skipped for safety: shared Plex risk";
		const flaggedItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				year: 2024,
				sizeOnDisk: 1000n,
			},
			match: {
				ruleId: "rule-1",
				ruleName: "4K cleanup",
				reason: "Matched 4K profile",
				action: "delete",
			},
			rating: 8,
		} as never;
		const blocks = new Map([[cleanupDeleteTargetKey(target), safetyReason]]);

		expect(buildCleanupPreviewDetails([flaggedItem], blocks)).toEqual([
			expect.objectContaining({
				action: "skipped",
				reason: safetyReason,
			}),
		]);
	});
});
