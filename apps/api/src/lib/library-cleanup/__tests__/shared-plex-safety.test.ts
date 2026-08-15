import { NotFoundError } from "arr-sdk";
import { describe, expect, it, vi } from "vitest";
import { withQuiObservationTopologyGuard } from "../../qui/observation-topology-guard.js";
import {
	buildCleanupPreviewDetails,
	CleanupRunAlreadyInProgressError,
	CleanupRunLeaseLostError,
	cleanupApprovalTargetKey,
	executeApprovedItems,
	executeCleanupPreview,
	executeCleanupRun,
	executeDirectRemoval,
	executeRetryItems,
	INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
	sortSonarrEpisodesByIdentity,
} from "../cleanup-executor.js";
import { planCleanupSelection } from "../selection-planner.js";
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const radarrTargetIdentity = {
	serviceFingerprint: createArrServiceFingerprint({
		id: "radarr-4k",
		service: "RADARR",
		baseUrl: "http://radarr.internal:7878",
		encryptedApiKey: "encrypted-radarr-key",
		encryptionIv: "radarr-iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
	} as never),
	externalId: 42,
	mediaPath: {
		value: "/movies-4k/Example Movie (2024)",
		windows: false,
	},
};

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
	targetDeleteNotifications = [
		{
			plexServerUrl: "http://plex.internal:32400",
			onMovieDelete: false,
			onMovieFileDelete: true,
			mapping: null,
		},
	],
) {
	return serializeExecutableSafetyPlan(
		file
			? {
					kind: "verified_radarr",
					target: radarrTargetIdentity,
					file,
					peers: [],
					ownership: [],
					targetDeleteNotifications,
				}
			: { kind: "verified_radarr_empty", target: radarrTargetIdentity },
	);
}

function radarrTargetOnlySnapshot() {
	return serializeExecutableSafetyPlan({
		kind: "verified_arr_target",
		target: radarrTargetIdentity,
	});
}

function approvalRecord(overrides: Record<string, unknown> = {}) {
	return {
		id: "approval-1",
		instanceId: "radarr-4k",
		arrItemId: 101,
		itemType: "movie",
		targetScope: "series",
		arrEpisodeId: null,
		seasonNumber: null,
		episodeNumber: null,
		episodeTitle: null,
		title: "Example Movie",
		reason: "Matched 4K cleanup rule",
		action: "delete",
		scanMediaServerAfterDelete: false,
		matchedRuleId: "rule-1",
		matchedRuleName: "Current cleanup rule",
		sizeOnDisk: 1_000n,
		year: 2024,
		rating: null,
		safetySnapshot: radarrSafetySnapshot(),
		status: "approved",
		executionToken: null,
		reviewedAt: null,
		createdAt: new Date("2026-07-31T00:00:00.000Z"),
		...overrides,
	};
}

function currentSeriesRule(
	id = "rule-1",
	action: "delete" | "delete_files" | "unmonitor" = "delete",
	pattern = ".",
) {
	return {
		id,
		configId: "config-1",
		name: "Current cleanup rule",
		enabled: true,
		priority: 1,
		ruleType: "file_path",
		parameters: JSON.stringify({ field: "path", operator: "matches", pattern }),
		serviceFilter: JSON.stringify(["RADARR"]),
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		targetScope: "series",
		action,
		scanMediaServerAfterDelete: false,
		operator: null,
		conditions: null,
		retentionMode: false,
		createdAt: new Date("2026-07-27T12:00:00.000Z"),
		updatedAt: new Date("2026-07-27T12:00:00.000Z"),
	};
}

function monitoredUnmonitorRule(id = "rule-1") {
	return {
		...currentSeriesRule(id, "unmonitor"),
		name: "Currently monitored",
		ruleType: "monitored",
		parameters: "{}",
	};
}

function setRadarrMutationRules(
	deps: CleanupExecutorDeps,
	rules: ReturnType<typeof currentSeriesRule>[],
) {
	(
		deps as CleanupExecutorDeps & {
			__setTestMutationRules?: (rules: ReturnType<typeof currentSeriesRule>[]) => void;
		}
	).__setTestMutationRules?.(rules);
}

const radarrCachedFileIdentity = {
	hasFile: true,
	cachedAt: new Date("2026-07-27T12:05:00.000Z"),
	data: JSON.stringify({
		_arrDashboardSource: {
			serviceFingerprint: radarrTargetIdentity.serviceFingerprint,
		},
		remoteIds: { tmdbId: 42 },
		path: "/movies-4k/Example Movie (2024)",
		movieFile: {
			id: 1001,
			path: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
			size: 2_000,
		},
	}),
};

function radarrUnmonitorFlaggedItem(ruleId = "rule-1") {
	return {
		cacheItem: {
			instanceId: "radarr-4k",
			arrItemId: 101,
			itemType: "movie",
			title: "Example Movie",
			year: 2024,
			monitored: true,
			...radarrCachedFileIdentity,
			sizeOnDisk: 2_000n,
		},
		match: {
			ruleId,
			ruleName: "Unmonitor monitored movies",
			reason: "Movie is monitored",
			action: "unmonitor",
		},
		rating: 8,
	} as never;
}

interface TestOptions {
	action?: "delete" | "delete_files" | "unmonitor";
	includePlexNotification?: boolean;
	notificationKind?: "plex" | "mediabrowser" | "kodi" | "synology";
	onMovieDelete?: boolean;
	onMovieFileDelete?: boolean;
	initialMovieFileId?: number | null;
	movieTags?: number[];
	notificationTags?: number[];
	notificationEnable?: boolean;
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
	afterMovieFileDelete?: () => void;
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
		baseUrl: "http://radarr.internal:7878",
		encryptedApiKey: "encrypted-radarr-key",
		encryptionIv: "radarr-iv",
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
		enabled: false,
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
	};

	let liveMovieExists = true;
	let liveMovieMonitored: boolean | undefined;
	const deleteMovie = vi.fn(async () => {
		liveMovieExists = false;
	});
	let liveMovieFileId: number | undefined =
		options.initialMovieFileId === null ? undefined : (options.initialMovieFileId ?? 1001);
	const deleteMovieFile = vi.fn(async (movieFileId: number) => {
		if (movieFileId === liveMovieFileId) liveMovieFileId = undefined;
		options.afterMovieFileDelete?.();
	});
	const targetMovie = {
		id: 101,
		tmdbId: 42,
		title: "Example Movie",
		tags: options.movieTags ?? [],
		hasFile: true,
		movieFileId: 1001,
		sizeOnDisk: 2_000,
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
					enable: options.notificationEnable,
					onMovieFileDelete: options.onMovieFileDelete ?? true,
					tags: options.notificationTags ?? [],
					fields: notificationFields(options),
				}
			: {
					...notificationIdentity,
					enable: options.notificationEnable,
					onMovieDelete: options.onMovieDelete ?? false,
					onMovieFileDelete: options.onMovieFileDelete ?? true,
					tags: options.notificationTags ?? [],
					fields: notificationFields(options),
				};
	const targetClient = {
		movie: {
			getById: options.targetFailure
				? vi.fn().mockRejectedValue(options.targetFailure)
				: vi.fn(async (movieId: number) => {
						if (!liveMovieExists) throw new NotFoundError("Movie not found");
						const isPrimaryMovie = movieId === targetMovie.id;
						return {
							...targetMovie,
							...(liveMovieMonitored === undefined ? {} : { monitored: liveMovieMonitored }),
							id: movieId,
							title: isPrimaryMovie ? targetMovie.title : "Fresh rule match",
							path: targetMovie.path,
							hasFile: liveMovieFileId !== undefined,
							movieFileId: liveMovieFileId,
							sizeOnDisk: liveMovieFileId === undefined ? 0 : targetMovie.sizeOnDisk,
							statistics: {
								movieFileCount: liveMovieFileId === undefined ? 0 : 1,
								sizeOnDisk: liveMovieFileId === undefined ? 0 : targetMovie.sizeOnDisk,
								releaseGroups: liveMovieFileId === undefined ? [] : ["ExampleGroup"],
							},
						};
					}),
			delete: deleteMovie,
			update: vi.fn().mockResolvedValue({}),
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

	let currentMutationRules = [
		{
			...currentSeriesRule("rule-1", options.action ?? "delete", "Example Movie"),
			excludeTitles: JSON.stringify(["^Fresh"]),
		},
		currentSeriesRule("rule-2", "unmonitor", "Example Movie"),
	];
	let createdApprovalCount = 0;
	const deps: CleanupExecutorDeps = {
		prisma: {
			libraryCleanupConfig: {
				findUnique: vi.fn(async () => ({
					id: "config-1",
					enabled: true,
					dryRunMode: false,
					requireApproval: true,
					maxRemovalsPerRun: 10,
					respectQuiSeeding: false,
					rules: currentMutationRules,
				})),
				updateMany: cleanupConfigUpdateMany,
			},
			serviceInstance: {
				findMany: serviceInstanceFindMany,
				findFirst: vi.fn().mockResolvedValue(targetInstance),
			},
			libraryCleanupApproval: {
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
				findMany: vi.fn().mockResolvedValue([]),
				findFirst: vi.fn().mockResolvedValue(null),
				count: vi.fn().mockResolvedValue(0),
				create: vi.fn(async () => ({ id: `approval-created-${++createdApprovalCount}` })),
				update: vi.fn().mockResolvedValue({}),
			},
			libraryCache: {
				findMany: vi.fn().mockResolvedValue([]),
				deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			libraryCleanupLog: {
				findFirst: vi.fn().mockResolvedValue(null),
				create: vi.fn().mockResolvedValue({}),
			},
		} as unknown as CleanupExecutorDeps["prisma"],
		arrClientFactory: {
			create: createArrClient,
		} as unknown as CleanupExecutorDeps["arrClientFactory"],
		plexClientFactory,
		log: silentLog,
	};
	Object.defineProperty(deps, "__setTestMutationRules", {
		value: (rules: ReturnType<typeof currentSeriesRule>[]) => {
			currentMutationRules = rules;
		},
	});

	return {
		deps,
		targetInstance,
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
		setLiveMovieIdentity: (tmdbId: number, path: string) => {
			targetMovie.tmdbId = tmdbId;
			targetMovie.path = path;
		},
		setLiveMovieMonitored: (monitored: boolean | undefined) => {
			liveMovieMonitored = monitored;
		},
		setLiveMovieTags: (tags: number[]) => {
			targetMovie.tags = tags;
		},
	};
}

function configureQuiSafety(fixture: ReturnType<typeof makeDeps>, initialState = "pausedUP") {
	const quiInstance = {
		id: "qui-1",
		userId: "user-1",
		service: "QUI",
		label: "qUI",
		baseUrl: "http://qui.internal:7476",
		encryptedApiKey: "encrypted-qui-key",
		encryptionIv: "qui-iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		enabled: true,
		hasLocalFilesystemAccess: true,
		pathPrefix: null,
	};
	let state = initialState;
	const getTorrentsByHash = vi.fn(async (hash: string) => [{ hash, state, instanceId: 7 }]);
	vi.mocked(fixture.deps.prisma.serviceInstance.findMany).mockImplementation(
		(args) =>
			(args?.where?.service === "PLEX"
				? Promise.resolve([fixture.plexInstance])
				: args?.where?.service === "QUI"
					? Promise.resolve([quiInstance])
					: Promise.resolve([fixture.targetInstance])) as never,
	);
	fixture.deps.quiClientFactory = vi.fn(() => ({ getTorrentsByHash })) as never;
	fixture.deps.quiFileHashIndexFactory = vi.fn().mockResolvedValue({
		resolve: vi.fn().mockResolvedValue({ hashes: ["movie-hash"], complete: true }),
	});
	return {
		getTorrentsByHash,
		setState: (nextState: string) => {
			state = nextState;
		},
	};
}

function configureVerifiedRadarrPeer(
	fixture: ReturnType<typeof makeDeps>,
	overrides: {
		filePath?: string;
		fileSize?: number;
		mapFrom?: string;
		mapTo?: string;
		movieTags?: number[];
		notificationTags?: number[];
		notificationEnable?: boolean;
		updateLibrary?: boolean;
	} = {},
) {
	const peerInstance = {
		...fixture.targetInstance,
		id: "radarr-hd",
		label: "HD Radarr",
		baseUrl: "http://radarr-hd.internal:7878",
		encryptedApiKey: "encrypted-radarr-hd-key",
		encryptionIv: "radarr-hd-iv",
	};
	const peerMovie = {
		id: 202,
		tmdbId: 42,
		title: "Example Movie",
		tags: overrides.movieTags ?? [],
		hasFile: true,
		movieFileId: 2002,
		path: "/downloads-hd/Example Movie (2024)",
		rootFolderPath: "/downloads-hd",
	};
	const peerMovieFile = {
		id: 2002,
		path: overrides.filePath ?? "/downloads-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
		relativePath: "Example.Movie.1080p.mkv",
		size: overrides.fileSize ?? 1_000,
	};
	const deletePeerMovie = vi.fn();
	const deletePeerMovieFile = vi.fn();
	const peerClient = {
		movie: {
			getAll: vi.fn().mockResolvedValue([peerMovie]),
			getById: vi.fn().mockResolvedValue(peerMovie),
			delete: deletePeerMovie,
			update: vi.fn(),
		},
		movieFile: {
			getById: vi.fn().mockResolvedValue(peerMovieFile),
			delete: deletePeerMovieFile,
		},
		notification: {
			getAll: vi.fn().mockResolvedValue([
				{
					enable: overrides.notificationEnable,
					implementation: "PlexServer",
					configContract: "PlexServerSettings",
					onMovieDelete: true,
					onMovieFileDelete: true,
					tags: overrides.notificationTags ?? [],
					fields: notificationFields({
						mapFrom: overrides.mapFrom ?? "/downloads-hd",
						mapTo: overrides.mapTo ?? "/plex/movies-hd",
						updateLibrary: overrides.updateLibrary,
					}),
				},
			]),
		},
	};
	vi.mocked(fixture.deps.prisma.serviceInstance.findMany).mockImplementation(
		(args) =>
			(args?.where?.service === "PLEX"
				? Promise.resolve([fixture.plexInstance])
				: Promise.resolve([fixture.targetInstance, peerInstance])) as never,
	);
	vi.mocked(fixture.deps.arrClientFactory.create).mockImplementation(
		(instance) => (instance.id === peerInstance.id ? peerClient : fixture.targetClient) as never,
	);
	return {
		peerInstance,
		peerMovie,
		peerMovieFile,
		peerClient,
		deletePeerMovie,
		deletePeerMovieFile,
	};
}

function makeOwnershipOnlyMappedRadarrFixture(options: TestOptions = {}) {
	const fixture = makeDeps({
		...options,
		onMovieDelete: false,
		onMovieFileDelete: false,
		mapFrom: "/movies-4k",
		mapTo: "/plex/movies-4k",
		plexItems: [
			{
				ratingKey: "plex-movie-42",
				parts: [
					{
						file: "/plex/movies-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
						size: 1_000,
					},
					{
						file: "/plex/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
						size: 2_000,
					},
				],
			},
		],
	});
	const peer = configureVerifiedRadarrPeer(fixture);
	return { fixture, peer };
}

function configureRetryStore(deps: CleanupExecutorDeps) {
	const retries: Array<Record<string, unknown>> = [];
	vi.mocked(deps.prisma.libraryCleanupApproval.findFirst).mockImplementation(
		(async ({ where }: { where: { id?: string; status?: string; executionToken?: string } }) =>
			retries.find(
				(retry) =>
					(where.id === undefined || retry.id === where.id) &&
					(where.status === undefined || retry.status === where.status) &&
					(where.executionToken === undefined || retry.executionToken === where.executionToken),
			) ?? null) as never,
	);
	vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
		where,
		select,
		take,
	}: {
		where: { status?: string | { in: string[] } };
		select?: Record<string, boolean>;
		take?: number;
	}) => {
		const statuses = typeof where.status === "string" ? [where.status] : (where.status?.in ?? []);
		const matching = retries.filter((retry) => statuses.includes(retry.status as string));
		const limited = take === undefined ? matching : matching.slice(0, take);
		if (!select) return limited;
		return limited.map((retry) =>
			Object.fromEntries(Object.keys(select).map((field) => [field, retry[field]])),
		);
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
	return retries;
}

function configureApprovalStore(
	deps: CleanupExecutorDeps,
	storedApproval: Record<string, unknown>,
) {
	storedApproval.status ??= "approved";
	storedApproval.executionToken ??= null;
	(
		deps as CleanupExecutorDeps & {
			__setTestMutationRules?: (rules: ReturnType<typeof currentSeriesRule>[]) => void;
		}
	).__setTestMutationRules?.([
		currentSeriesRule(
			(storedApproval.matchedRuleId as string | undefined) ?? "rule-1",
			storedApproval.action as "delete" | "delete_files" | "unmonitor",
		),
	]);
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
		where: { id?: string | { in: string[] }; status?: string; executionToken?: string };
		data: Record<string, unknown>;
	}) => {
		const matchesId =
			where.id === undefined ||
			where.id === storedApproval.id ||
			(typeof where.id === "object" && where.id.in.includes(storedApproval.id as string));
		if (!matchesId) return { count: 0 };
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

function configureApprovalStores(
	deps: CleanupExecutorDeps,
	storedApprovals: Array<Record<string, unknown>>,
) {
	for (const approval of storedApprovals) {
		approval.status ??= "approved";
		approval.executionToken ??= null;
	}
	const firstApproval = storedApprovals[0];
	if (firstApproval) {
		(
			deps as CleanupExecutorDeps & {
				__setTestMutationRules?: (rules: ReturnType<typeof currentSeriesRule>[]) => void;
			}
		).__setTestMutationRules?.([
			currentSeriesRule(
				(firstApproval.matchedRuleId as string | undefined) ?? "rule-1",
				firstApproval.action as "delete" | "delete_files" | "unmonitor",
			),
		]);
	}
	vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
		where,
	}: {
		where: { status?: string };
	}) => storedApprovals.filter((approval) => approval.status === where.status)) as never);
	vi.mocked(deps.prisma.libraryCleanupApproval.updateMany).mockImplementation((async ({
		where,
		data,
	}: {
		where: {
			id?: string | { in: string[] };
			status?: string;
			executionToken?: string;
		};
		data: Record<string, unknown>;
	}) => {
		const ids =
			typeof where.id === "string" ? [where.id] : where.id && "in" in where.id ? where.id.in : [];
		let count = 0;
		for (const approval of storedApprovals) {
			if (!ids.includes(approval.id as string)) continue;
			if (where.status && where.status !== approval.status) continue;
			if (where.executionToken !== undefined && where.executionToken !== approval.executionToken) {
				continue;
			}
			Object.assign(approval, data);
			count++;
		}
		return { count };
	}) as never);
}

function dryRunConfig(maxRemovalsPerRun = 10) {
	return {
		id: "config-1",
		userId: "user-1",
		enabled: true,
		dryRunMode: true,
		requireApproval: false,
		maxRemovalsPerRun,
		respectQuiSeeding: false,
		rejectionMemoryDays: 0,
		rules: [
			{
				id: "rule-1",
				name: "Old media",
				enabled: true,
				priority: 1,
				ruleType: "age",
				parameters: JSON.stringify({ operator: "older_than", days: 30 }),
				serviceFilter: null,
				instanceFilter: null,
				excludeTags: null,
				excludeTitles: null,
				plexLibraryFilter: null,
				action: "delete",
				operator: null,
				conditions: null,
				configId: "config-1",
				retentionMode: false,
				scanMediaServerAfterDelete: false,
				useGlobalRejectionMemory: true,
				rejectionMemoryDays: 0,
				createdAt: new Date("2026-07-27T12:00:00.000Z"),
				updatedAt: new Date("2026-07-27T12:00:00.000Z"),
			},
		],
	};
}

function matchingDryRunCacheItem(overrides: Record<string, unknown> = {}) {
	return {
		id: "cache-fresh",
		instanceId: "radarr-4k",
		arrItemId: 202,
		itemType: "movie",
		title: "Fresh rule match",
		year: 2020,
		monitored: true,
		hasFile: true,
		status: "released",
		qualityProfileId: 1,
		qualityProfileName: "4K",
		sizeOnDisk: 1_000n,
		arrAddedAt: new Date("2020-01-01T00:00:00.000Z"),
		cachedAt: new Date("2026-07-27T12:05:00.000Z"),
		data: radarrCachedFileIdentity.data,
		...overrides,
	};
}

function configurePlexApprovalAuthority(
	fixture: ReturnType<typeof makeDeps>,
	options: {
		items?: Array<{ id: string; arrItemId: number; title: string }>;
		driftBeforeApproval?: boolean;
		driftAfterFirstApproval?: "rows" | "rows_and_status";
	} = {},
) {
	const providerInstance = {
		...fixture.plexInstance,
		enabled: true,
		expectedIdentity: "private-plex-machine-id",
		identityKind: "PLEX_MACHINE_IDENTIFIER",
		identityStatus: "VERIFIED",
		identityVerifiedAt: new Date("2026-08-14T00:00:00.000Z"),
		connectionGeneration: 3,
		identityGeneration: 7,
		updatedAt: new Date("2026-08-14T00:00:00.000Z"),
	};
	const completedAt = new Date();
	let statusVersion = 1;
	let rows = [
		{
			id: "plex-cache-1",
			instanceId: providerInstance.id,
			tmdbId: 42,
			mediaType: "movie",
			sectionId: "movies",
			sectionTitle: "Movies",
			lastWatchedAt: completedAt,
			watchCount: 5,
			watchedByUsers: JSON.stringify(["owner"]),
			onDeck: false,
			userRating: null,
			collections: "[]",
			labels: "[]",
			addedAt: new Date("2026-01-01T00:00:00.000Z"),
			connectionGeneration: 3,
			identityGeneration: 7,
		},
	];
	const currentStatus = () => ({
		instanceId: providerInstance.id,
		lastRefreshedAt: completedAt,
		lastResult: "success",
		lastErrorMessage: null,
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
		itemCount: rows.length,
		connectionGeneration: 3,
		identityGeneration: 7,
		generationId: `plex-generation-${statusVersion}`,
		generationMetadata: JSON.stringify({ version: statusVersion }),
	});
	const items = options.items ?? [
		{ id: "cache-provider-1", arrItemId: 101, title: "Example Movie" },
		{ id: "cache-provider-2", arrItemId: 102, title: "Fresh rule match" },
	];

	vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
		...dryRunConfig(items.length),
		dryRunMode: false,
		requireApproval: true,
		rules: [
			{
				...dryRunConfig().rules[0]!,
				ruleType: "plex_watch_count",
				parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
			},
		],
	} as never);
	vi.mocked(fixture.deps.prisma.libraryCache.findMany)
		.mockResolvedValueOnce(
			items.map((item) =>
				matchingDryRunCacheItem({
					...item,
					data: radarrCachedFileIdentity.data,
					sizeOnDisk: 2_000n,
				}),
			) as never,
		)
		.mockResolvedValue([] as never);
	vi.mocked(fixture.deps.prisma.serviceInstance.findMany).mockImplementation((async ({
		where,
	}: {
		where: { service?: string | { in?: string[] } };
	}) => {
		const services =
			typeof where.service === "string" ? [where.service] : (where.service?.in ?? []);
		if (services.includes("PLEX")) return [providerInstance];
		return [fixture.targetInstance, providerInstance];
	}) as never);

	const plexFindMany = vi.fn(async () => rows.map((row) => ({ ...row })));
	Object.assign(fixture.deps.prisma, {
		cacheRefreshStatus: { findMany: vi.fn(async () => [currentStatus()]) },
		plexCache: { findMany: plexFindMany },
	});

	const rootCreate = vi.mocked(fixture.deps.prisma.libraryCleanupApproval.create);
	const transactionCreate = vi.fn(async () => {
		const ordinal = transactionCreate.mock.calls.length;
		if (ordinal === 1 && options.driftAfterFirstApproval) {
			rows = [{ ...rows[0]!, watchCount: rows[0]!.watchCount + 1 }];
			if (options.driftAfterFirstApproval === "rows_and_status") statusVersion++;
		}
		return { id: `approval-transaction-${ordinal}` };
	});
	const rowLock = vi.fn().mockResolvedValue([]);
	const transactionClient = {
		...fixture.deps.prisma,
		libraryCleanupApproval: {
			...fixture.deps.prisma.libraryCleanupApproval,
			create: transactionCreate,
		},
		$queryRawUnsafe: rowLock,
	};
	const transaction = vi.fn(
		async (callback: (tx: typeof transactionClient) => Promise<unknown>, _options?: unknown) =>
			callback(transactionClient),
	);
	Object.assign(fixture.deps.prisma, { $transaction: transaction });

	if (options.driftBeforeApproval) {
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async () => {
			rows = [{ ...rows[0]!, watchCount: rows[0]!.watchCount + 1 }];
			return [];
		}) as never);
	}

	return { plexFindMany, rootCreate, rowLock, transactionCreate, transaction };
}

function tiedPriorityConfig(options: { dryRunMode: boolean; requireApproval: boolean }) {
	return {
		...dryRunConfig(10),
		...options,
		rules: [
			currentSeriesRule("z-unmonitor", "unmonitor", "Example Movie"),
			currentSeriesRule("a-delete", "delete", "Example Movie"),
		].map((rule) => ({ ...rule, priority: 1 })),
	};
}

describe("shared Plex deletion safety", () => {
	it("records and triggers a queued post-delete media-server scan without reopening deletion", async () => {
		const fixture = makeDeps({ action: "delete", mediaPartCount: 1 });
		const auditEvents: Array<Record<string, unknown>> = [];
		Object.assign(fixture.deps.prisma, {
			libraryCleanupAuditEvent: {
				create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
					auditEvents.push(data);
					return data;
				}),
			},
		});
		const storedApproval = approvalRecord({
			scanMediaServerAfterDelete: true,
			status: "approved",
		});
		configureApprovalStore(fixture.deps, storedApproval);
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
			where,
		}: {
			where: { status?: string };
		}) =>
			!where.status || storedApproval.status === where.status ? [storedApproval] : []) as never);
		setRadarrMutationRules(fixture.deps, [
			{
				...currentSeriesRule("rule-1", "delete", "Example Movie"),
				scanMediaServerAfterDelete: true,
			},
		]);
		const enabledPlex = { ...fixture.plexInstance, enabled: true };
		vi.mocked(fixture.deps.prisma.serviceInstance.findMany).mockImplementation((async ({
			where,
		}: {
			where: { service?: string | { in?: string[] } };
		}) => {
			if (
				where.service === "PLEX" ||
				(typeof where.service === "object" && where.service.in?.includes("PLEX"))
			) {
				return [enabledPlex];
			}
			return [fixture.targetInstance];
		}) as never);
		vi.mocked(fixture.deps.prisma.serviceInstance.findFirst).mockImplementation((async ({
			where,
		}: {
			where: { id: string };
		}) => (where.id === enabledPlex.id ? enabledPlex : fixture.targetInstance)) as never);
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findFirst).mockImplementation((async () =>
			storedApproval.status === "executed" ? storedApproval : null) as never);
		const refreshSection = vi.fn().mockResolvedValue(undefined);
		fixture.deps.plexCacheClientFactory = vi.fn(
			() =>
				({
					getIdentity: vi.fn().mockResolvedValue({ machineIdentifier: "plex-machine" }),
					getLibrarySections: vi
						.fn()
						.mockResolvedValue([{ key: "movies", title: "Movies", type: "movie" }]),
					refreshSection,
				}) as never,
		);
		const scanRow = {
			id: "scan-1",
			approvalId: "approval-1",
			instanceId: enabledPlex.id,
			service: "PLEX",
			serverIdentity: "PLEX:plex-machine",
			mediaType: "movie",
			plannedSectionIds: '["movies"]',
			targetKey: `PLEX:${enabledPlex.id}:movie`,
			status: "pending",
			executionToken: null as string | null,
			attemptCount: 0,
			completedSectionIds: "[]",
			lastError: null as string | null,
			nextAttemptAt: null as Date | null,
			requestStartedAt: null as Date | null,
			triggeredAt: null as Date | null,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		(fixture.deps.prisma as never as Record<string, unknown>).libraryCleanupMediaServerScan = {
			create: vi.fn().mockResolvedValue(scanRow),
			count: vi.fn().mockResolvedValue(1),
			findFirst: vi.fn().mockResolvedValue(null),
			findMany: vi.fn().mockImplementation(async ({ where, select }) => {
				const approvalFilter = where?.approvalId as { in?: string[] } | string | undefined;
				if (typeof approvalFilter === "object" && approvalFilter.in?.length === 0) return [];
				if (select?.status) return [scanRow];
				return scanRow.status === "triggered" ? [] : [scanRow];
			}),
			updateMany: vi
				.fn()
				.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
					const { attemptCount, ...persistedData } = data;
					if (typeof attemptCount === "object") scanRow.attemptCount++;
					Object.assign(scanRow, persistedData, { updatedAt: new Date() });
					return { count: 1 };
				}),
			deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
		};

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 1, failed: 0 });
		expect(fixture.deleteMovieFile).toHaveBeenCalledOnce();
		expect(fixture.deleteMovie).toHaveBeenCalledOnce();
		expect(refreshSection).toHaveBeenCalledWith("movies");
		expect(scanRow.status).toBe("triggered");
		expect(storedApproval.status).toBe("executed");
		const terminalIndex = auditEvents.findIndex(
			(event) => event.eventType === "terminal_succeeded",
		);
		const scanIndex = auditEvents.findIndex(
			(event) => event.eventType === "media_rescan_triggered",
		);
		expect(terminalIndex).toBeGreaterThanOrEqual(0);
		expect(scanIndex).toBeGreaterThan(terminalIndex);
	});

	it("records and triggers a direct post-delete media-server scan", async () => {
		const fixture = makeDeps({ action: "delete", mediaPartCount: 1 });
		const auditEvents: Array<Record<string, unknown>> = [];
		Object.assign(fixture.deps.prisma, {
			libraryCleanupAuditEvent: {
				create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
					auditEvents.push(data);
					return data;
				}),
			},
		});
		const retries = configureRetryStore(fixture.deps);
		const enabledPlex = { ...fixture.plexInstance, enabled: true };
		vi.mocked(fixture.deps.prisma.serviceInstance.findMany).mockImplementation((async ({
			where,
		}: {
			where: { service?: string | { in?: string[] } };
		}) => {
			if (
				where.service === "PLEX" ||
				(typeof where.service === "object" && where.service.in?.includes("PLEX"))
			) {
				return [enabledPlex];
			}
			return [fixture.targetInstance];
		}) as never);
		vi.mocked(fixture.deps.prisma.serviceInstance.findFirst).mockImplementation((async ({
			where,
		}: {
			where: { id: string };
		}) => (where.id === enabledPlex.id ? enabledPlex : fixture.targetInstance)) as never);
		const refreshSection = vi.fn().mockResolvedValue(undefined);
		fixture.deps.plexCacheClientFactory = vi.fn(
			() =>
				({
					getIdentity: vi.fn().mockResolvedValue({ machineIdentifier: "plex-machine" }),
					getLibrarySections: vi
						.fn()
						.mockResolvedValue([{ key: "movies", title: "Movies", type: "movie" }]),
					refreshSection,
				}) as never,
		);
		const scanRow = {
			id: "scan-direct",
			approvalId: "",
			instanceId: enabledPlex.id,
			service: "PLEX",
			serverIdentity: "PLEX:plex-machine",
			mediaType: "movie",
			plannedSectionIds: '["movies"]',
			targetKey: `PLEX:${enabledPlex.id}:movie`,
			status: "pending",
			executionToken: null as string | null,
			attemptCount: 0,
			completedSectionIds: "[]",
			lastError: null as string | null,
			nextAttemptAt: null as Date | null,
			requestStartedAt: null as Date | null,
			triggeredAt: null as Date | null,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		(fixture.deps.prisma as never as Record<string, unknown>).libraryCleanupMediaServerScan = {
			create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
				Object.assign(scanRow, data);
				return scanRow;
			}),
			count: vi.fn().mockResolvedValue(1),
			findFirst: vi.fn().mockResolvedValue(null),
			findMany: vi.fn().mockImplementation(async ({ where, select }) => {
				const approvalFilter = where?.approvalId as { in?: string[] } | string | undefined;
				if (typeof approvalFilter === "object" && approvalFilter.in?.length === 0) return [];
				if (select?.status) return [scanRow];
				return scanRow.status === "triggered" ? [] : [scanRow];
			}),
			updateMany: vi
				.fn()
				.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
					const { attemptCount, ...persistedData } = data;
					if (typeof attemptCount === "object") scanRow.attemptCount++;
					Object.assign(scanRow, persistedData, { updatedAt: new Date() });
					return { count: 1 };
				}),
			deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
		};
		const rule = {
			...currentSeriesRule("rule-1", "delete", "Example Movie"),
			scanMediaServerAfterDelete: true,
		};
		setRadarrMutationRules(fixture.deps, [rule]);
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
				ruleName: "Current cleanup rule",
				reason: "Matched cleanup rule",
				action: "delete",
				scanMediaServerAfterDelete: true,
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			fixture.deps,
			{
				id: "config-1",
				enabled: true,
				dryRunMode: false,
				requireApproval: true,
				maxRemovalsPerRun: 10,
				respectQuiSeeding: false,
				rules: [rule],
			} as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(result).toMatchObject({ itemsRemoved: 1, status: "completed" });
		expect(refreshSection).toHaveBeenCalledWith("movies");
		expect(scanRow.status).toBe("triggered");
		expect(retries).toContainEqual(expect.objectContaining({ status: "executed" }));
		const terminalIndex = auditEvents.findIndex(
			(event) => event.eventType === "terminal_succeeded",
		);
		const scanIndex = auditEvents.findIndex(
			(event) => event.eventType === "media_rescan_triggered",
		);
		expect(terminalIndex).toBeGreaterThanOrEqual(0);
		expect(scanIndex).toBeGreaterThan(terminalIndex);
	});

	it.each(["delete", "delete_files"] as const)(
		"blocks direct Radarr %s when qUI becomes active at the final mutation boundary",
		async (action) => {
			const fixture = makeDeps({ action, mediaPartCount: 1 });
			const qui = configureQuiSafety(fixture);
			qui.getTorrentsByHash
				.mockResolvedValueOnce([{ hash: "movie-hash", state: "pausedUP", instanceId: 7 }])
				.mockResolvedValue([{ hash: "movie-hash", state: "stalledUP", instanceId: 7 }]);
			configureRetryStore(fixture.deps);
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
					ruleName: "Remove old movie",
					reason: "Matched cleanup rule",
					action,
				},
				rating: 8,
				respectQuiSeeding: true,
			} as never;

			const result = await executeDirectRemoval(
				fixture.deps,
				{
					id: "config-1",
					maxRemovalsPerRun: 10,
					respectQuiSeeding: true,
					rules: [],
				} as never,
				"user-1",
				[flaggedItem],
				1,
				1,
				Date.now(),
			);

			expect(result).toMatchObject({ itemsRemoved: 0, itemsFilesDeleted: 0 });
			expect(result.details).toEqual([
				expect.objectContaining({
					action: "skipped",
					reason: expect.stringContaining("qUI physical-file evidence changed"),
				}),
			]);
			expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
			expect(fixture.deleteMovie).not.toHaveBeenCalled();
		},
	);

	it.each(["delete", "delete_files"] as const)(
		"blocks queued Radarr %s when fresh qUI evidence becomes active",
		async (action) => {
			const fixture = makeDeps({ action, mediaPartCount: 1 });
			const qui = configureQuiSafety(fixture);
			const target = {
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				action,
				respectQuiSeeding: true,
			};
			const context = createSharedPlexSafetyContext();
			await expect(
				findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context),
			).resolves.toEqual(new Map());
			const plan = context.plans.get(cleanupDeleteTargetKey(target));
			if (plan?.kind !== "verified_radarr") throw new Error("Expected Radarr safety plan");
			qui.setState("stalledUP");
			vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
				...dryRunConfig(10),
				dryRunMode: false,
				requireApproval: true,
				respectQuiSeeding: true,
				rules: [currentSeriesRule("rule-1", action, "Example Movie")],
			} as never);
			const storedApproval = approvalRecord({
				action,
				safetySnapshot: serializeExecutableSafetyPlan(plan),
			});
			configureApprovalStore(fixture.deps, storedApproval);

			const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

			expect(result).toMatchObject({ removed: 0, failed: 1 });
			expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
			expect(fixture.deleteMovie).not.toHaveBeenCalled();
		},
	);

	it.each(["delete", "delete_files"] as const)(
		"holds qUI topology stable from final proof through direct Radarr %s mutation",
		async (action) => {
			const fixture = makeDeps({ action, mediaPartCount: 1 });
			const qui = configureQuiSafety(fixture);
			configureRetryStore(fixture.deps);
			const finalProofStarted = deferred();
			const releaseFinalProof = deferred();
			const fileMutationStarted = deferred();
			const releaseFileMutation = deferred();
			const events: string[] = [];
			qui.getTorrentsByHash
				.mockResolvedValueOnce([{ hash: "movie-hash", state: "pausedUP", instanceId: 7 }])
				.mockImplementationOnce(async (hash: string) => {
					events.push("proof");
					finalProofStarted.resolve();
					await releaseFinalProof.promise;
					return [{ hash, state: "pausedUP", instanceId: 7 }];
				});
			fixture.deleteMovieFile.mockImplementationOnce(async () => {
				events.push("file-start");
				fileMutationStarted.resolve();
				await releaseFileMutation.promise;
				events.push("file-end");
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
					ruleName: "Remove old movie",
					reason: "Matched cleanup rule",
					action,
				},
				rating: 8,
				respectQuiSeeding: true,
			} as never;

			const execution = executeDirectRemoval(
				fixture.deps,
				{
					id: "config-1",
					maxRemovalsPerRun: 10,
					respectQuiSeeding: true,
					rules: [],
				} as never,
				"user-1",
				[flaggedItem],
				1,
				1,
				Date.now(),
			);
			await finalProofStarted.promise;
			const topologyMutation = withQuiObservationTopologyGuard("user-1", async () => {
				events.push("topology");
			});
			await Promise.resolve();
			expect(events).toEqual(["proof"]);

			releaseFinalProof.resolve();
			await fileMutationStarted.promise;
			await Promise.resolve();
			expect(events).toEqual(["proof", "file-start"]);

			releaseFileMutation.resolve();
			await execution;
			await topologyMutation;
			expect(events).toEqual(["proof", "file-start", "file-end", "topology"]);
		},
	);

	it.each(["delete", "delete_files"] as const)(
		"holds qUI topology stable from final proof through queued Radarr %s mutation",
		async (action) => {
			const fixture = makeDeps({ action, mediaPartCount: 1 });
			const qui = configureQuiSafety(fixture);
			const target = {
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				action,
				respectQuiSeeding: true,
			};
			const context = createSharedPlexSafetyContext();
			await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);
			const plan = context.plans.get(cleanupDeleteTargetKey(target));
			if (plan?.kind !== "verified_radarr") throw new Error("Expected Radarr safety plan");
			vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
				...dryRunConfig(10),
				dryRunMode: false,
				requireApproval: true,
				respectQuiSeeding: true,
				rules: [currentSeriesRule("rule-1", action, "Example Movie")],
			} as never);
			configureApprovalStore(
				fixture.deps,
				approvalRecord({
					action,
					safetySnapshot: serializeExecutableSafetyPlan(plan),
				}),
			);
			const finalProofStarted = deferred();
			const releaseFinalProof = deferred();
			const fileMutationStarted = deferred();
			const releaseFileMutation = deferred();
			const events: string[] = [];
			qui.getTorrentsByHash
				.mockResolvedValueOnce([{ hash: "movie-hash", state: "pausedUP", instanceId: 7 }])
				.mockImplementationOnce(async (hash: string) => {
					events.push("proof");
					finalProofStarted.resolve();
					await releaseFinalProof.promise;
					return [{ hash, state: "pausedUP", instanceId: 7 }];
				});
			fixture.deleteMovieFile.mockImplementationOnce(async () => {
				events.push("file-start");
				fileMutationStarted.resolve();
				await releaseFileMutation.promise;
				events.push("file-end");
			});

			const execution = executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);
			await finalProofStarted.promise;
			const topologyMutation = withQuiObservationTopologyGuard("user-1", async () => {
				events.push("topology");
			});
			await Promise.resolve();
			expect(events).toEqual(["proof"]);

			releaseFinalProof.resolve();
			await fileMutationStarted.promise;
			await Promise.resolve();
			expect(events).toEqual(["proof", "file-start"]);

			releaseFileMutation.resolve();
			await execution;
			await topologyMutation;
			expect(events).toEqual(["proof", "file-start", "file-end", "topology"]);
		},
	);

	it("does not require qUI evidence for non-destructive Radarr unmonitor", async () => {
		const fixture = makeDeps({ action: "unmonitor", mediaPartCount: 1 });
		configureQuiSafety(fixture);
		fixture.deps.quiFileHashIndexFactory = vi.fn().mockRejectedValue(new Error("offline"));
		configureRetryStore(fixture.deps);
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
				ruleName: "Unmonitor old movie",
				reason: "Matched cleanup rule",
				action: "unmonitor",
			},
			rating: 8,
			respectQuiSeeding: true,
		} as never;

		const result = await executeDirectRemoval(
			fixture.deps,
			{
				id: "config-1",
				maxRemovalsPerRun: 10,
				respectQuiSeeding: true,
				rules: [],
			} as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(result).toMatchObject({ itemsUnmonitored: 1, itemsSkipped: 0 });
		expect(fixture.deps.quiFileHashIndexFactory).not.toHaveBeenCalled();
		expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
	});

	const target = {
		instanceId: "radarr-4k",
		arrItemId: 101,
		itemType: "movie",
		action: "delete",
	};

	it("plans configured dry runs with zero database writes", async () => {
		const { deps } = makeDeps();
		const auditCreate = vi.fn().mockResolvedValue({});
		const scanCreate = vi.fn().mockResolvedValue({});
		const scanFindMany = vi.fn().mockResolvedValue([]);
		const scanUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
		Object.assign(deps.prisma, {
			libraryCleanupAuditEvent: {
				create: auditCreate,
				findMany: vi.fn().mockResolvedValue([]),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
			libraryCleanupMediaServerScan: {
				create: scanCreate,
				findMany: scanFindMany,
				updateMany: scanUpdateMany,
			},
		});
		const config = dryRunConfig();
		config.rules[0]!.scanMediaServerAfterDelete = true;
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(config as never);

		const result = await executeCleanupRun(deps, "user-1");

		expect(result).toMatchObject({
			isDryRun: true,
			status: "completed",
			itemsEvaluated: 0,
			itemsRemoved: 0,
		});
		expect(deps.prisma.libraryCleanupConfig.updateMany).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCleanupApproval.create).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCleanupApproval.updateMany).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCache.deleteMany).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCache.updateMany).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCleanupLog.create).not.toHaveBeenCalled();
		expect(auditCreate).not.toHaveBeenCalled();
		expect(scanCreate).not.toHaveBeenCalled();
		expect(scanFindMany).not.toHaveBeenCalled();
		expect(scanUpdateMany).not.toHaveBeenCalled();
	});

	it("continues to log normal configured runs", async () => {
		const { deps } = makeDeps();

		const result = await executeCleanupRun(deps, "user-1");

		expect(result).toMatchObject({ isDryRun: false, status: "completed" });
		expect(deps.prisma.libraryCleanupLog.create).toHaveBeenCalledOnce();
		expect(deps.prisma.libraryCleanupLog.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ configId: "config-1", isDryRun: false }),
		});
	});

	it("uses the created approval ID for the queued action timeline", async () => {
		const { deps } = makeDeps({ mediaPartCount: 1 });
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			...dryRunConfig(),
			dryRunMode: false,
			requireApproval: true,
		} as never);
		vi.mocked(deps.prisma.libraryCache.findMany)
			.mockResolvedValueOnce([
				matchingDryRunCacheItem({
					id: "cache-approval-timeline",
					arrItemId: 101,
					title: "Approval timeline candidate",
				}),
			] as never)
			.mockResolvedValue([] as never);
		vi.mocked(deps.prisma.libraryCleanupApproval.create).mockResolvedValue({
			id: "approval-timeline-1",
		} as never);
		const auditCreate = vi.fn().mockResolvedValue({});
		Object.assign(deps.prisma, {
			libraryCleanupAuditEvent: {
				create: auditCreate,
				findMany: vi.fn().mockResolvedValue([]),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
		});

		const result = await executeCleanupRun(deps, "user-1");

		expect(result.details).toEqual([
			expect.objectContaining({
				action: "queued_for_approval",
				actionId: "approval-timeline-1",
				approvalId: "approval-timeline-1",
			}),
		]);
		const auditEvents = auditCreate.mock.calls.map(([call]) => call.data);
		expect(auditEvents.map((event) => event.actionId)).toEqual([
			"approval-timeline-1",
			"approval-timeline-1",
		]);
		expect(auditEvents.map((event) => event.eventType)).toEqual([
			"candidate_selected",
			"approval_pending",
		]);
	});

	it("rejects row drift even while the accepted provider status token is lagging", async () => {
		const fixture = makeDeps({ mediaPartCount: 1 });
		const authority = configurePlexApprovalAuthority(fixture, {
			items: [{ id: "cache-provider-1", arrItemId: 101, title: "Example Movie" }],
			driftBeforeApproval: true,
		});

		const result = await executeCleanupRun(fixture.deps, "user-1");

		expect(result.itemsFlagged).toBe(1);
		expect(authority.transaction).toHaveBeenCalledOnce();
		expect(authority.transactionCreate).not.toHaveBeenCalled();
		expect(authority.rootCreate).not.toHaveBeenCalled();
		expect(result).toMatchObject({ itemsSkipped: 1, itemsRemoved: 0, status: "partial" });
	});

	it("stops before a later approval when provider rows and status drift between targets", async () => {
		const fixture = makeDeps({ mediaPartCount: 1 });
		const authority = configurePlexApprovalAuthority(fixture, {
			driftAfterFirstApproval: "rows_and_status",
		});

		const result = await executeCleanupRun(fixture.deps, "user-1");

		expect(authority.transaction).toHaveBeenCalledTimes(2);
		expect(authority.transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
			isolationLevel: "Serializable",
		});
		expect(authority.transaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
			isolationLevel: "Serializable",
		});
		expect(authority.transactionCreate).toHaveBeenCalledOnce();
		expect(authority.rootCreate).not.toHaveBeenCalled();
		expect(result.details).toEqual([
			expect.objectContaining({ arrItemId: 101, action: "queued_for_approval" }),
			expect.objectContaining({ arrItemId: 102, action: "skipped" }),
		]);
	});

	it("revalidates unchanged provider rows inside each approval write transaction", async () => {
		const fixture = makeDeps({ mediaPartCount: 1 });
		const authority = configurePlexApprovalAuthority(fixture);

		const result = await executeCleanupRun(fixture.deps, "user-1");

		expect(authority.transaction).toHaveBeenCalledTimes(2);
		expect(authority.transactionCreate).toHaveBeenCalledTimes(2);
		expect(authority.rootCreate).not.toHaveBeenCalled();
		expect(result.details).toEqual([
			expect.objectContaining({ arrItemId: 101, action: "queued_for_approval" }),
			expect.objectContaining({ arrItemId: 102, action: "queued_for_approval" }),
		]);
	});

	it("locks provider publication authority before row validation and approval creation", async () => {
		vi.stubEnv("DATABASE_URL", "postgresql://localhost/arr_test");
		try {
			const fixture = makeDeps({ mediaPartCount: 1 });
			const authority = configurePlexApprovalAuthority(fixture, {
				items: [{ id: "cache-provider-1", arrItemId: 101, title: "Example Movie" }],
			});

			await executeCleanupRun(fixture.deps, "user-1");

			expect(authority.rowLock).toHaveBeenCalledWith(
				'SELECT "id" FROM "ServiceInstance" WHERE "id" = $1 FOR UPDATE',
				"plex-1",
			);
			expect(authority.rowLock.mock.invocationCallOrder[0]).toBeLessThan(
				authority.plexFindMany.mock.invocationCallOrder.at(-1)!,
			);
			expect(authority.plexFindMany.mock.invocationCallOrder.at(-1)).toBeLessThan(
				authority.transactionCreate.mock.invocationCallOrder[0]!,
			);
			expect(authority.rootCreate).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it.each([
		["interactive preview", { dryRunMode: false, requireApproval: false }],
		["configured dry run", { dryRunMode: true, requireApproval: false }],
		["approval run", { dryRunMode: false, requireApproval: true }],
		["direct run", { dryRunMode: false, requireApproval: false }],
	] as const)("uses the stable tied-priority winner in %s", async (flow, options) => {
		const { deps, targetClient } = makeDeps({ mediaPartCount: 1 });
		const config = tiedPriorityConfig(options);
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(config as never);
		vi.mocked(deps.prisma.libraryCache.findMany)
			.mockResolvedValueOnce([matchingDryRunCacheItem({ title: "Example Movie" })] as never)
			.mockResolvedValue([] as never);

		const result =
			flow === "interactive preview"
				? await executeCleanupPreview(deps, "user-1")
				: await executeCleanupRun(deps, "user-1");

		expect(result.itemsFlagged).toBe(1);
		if (flow === "approval run") {
			expect(deps.prisma.libraryCleanupApproval.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ matchedRuleId: "a-delete", action: "delete" }),
				}),
			);
		} else if (flow === "direct run") {
			expect(targetClient.movie.delete).toHaveBeenCalledOnce();
			expect(targetClient.movie.update).not.toHaveBeenCalled();
		} else {
			expect(result.details[0]).toMatchObject({ ruleId: "a-delete", plannedAction: "delete" });
		}
	});

	it.each(["retry_pending", "retry_executing"])(
		"filters %s targets before applying the approval run limit",
		async (retryStatus) => {
			const { deps, targetClient } = makeDeps({ mediaPartCount: 1 });
			vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
				...dryRunConfig(1),
				dryRunMode: false,
				requireApproval: true,
			} as never);
			vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
				matchingDryRunCacheItem({
					id: "cache-retry",
					arrItemId: 101,
					title: "Existing durable retry",
				}),
				matchingDryRunCacheItem({
					id: "cache-fresh",
					arrItemId: 202,
					title: "Fresh approval candidate",
				}),
			] as never);
			const retryTarget = approvalRecord({ status: retryStatus }) as Record<string, unknown>;
			vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
				where,
				select,
			}: {
				where: { status?: string | { in: string[] } };
				select?: Record<string, boolean>;
			}) => {
				const statuses =
					typeof where.status === "string" ? [where.status] : (where.status?.in ?? []);
				if (!statuses.includes(retryStatus)) return [];
				if (!select) return [retryTarget];
				return [
					Object.fromEntries(Object.keys(select).map((field) => [field, retryTarget[field]])),
				];
			}) as never);
			vi.mocked(targetClient.movie.getById).mockResolvedValue({
				id: 202,
				tmdbId: 42,
				title: "Fresh approval candidate",
				tags: [],
				hasFile: true,
				movieFileId: 1001,
				path: "/movies-4k/Example Movie (2024)",
				rootFolderPath: "/movies-4k",
				movieFile: {
					id: 1001,
					path: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
					relativePath: "Example.Movie.2160p.mkv",
					size: 2_000,
				},
			} as never);

			const result = await executeCleanupRun(deps, "user-1");

			expect(deps.prisma.libraryCleanupApproval.create).toHaveBeenCalledOnce();
			expect(deps.prisma.libraryCleanupApproval.create).toHaveBeenCalledWith({
				data: expect.objectContaining({
					arrItemId: 202,
					status: "pending",
				}),
			});
			expect(result).toMatchObject({
				itemsFlagged: 2,
				itemsSkipped: 1,
			});
		},
	);

	it.each([
		["interactive preview", "nonterminal retry", "preview"],
		["interactive preview", "approval dedup", "preview"],
		["configured dry run", "nonterminal retry", "dry_run"],
		["configured dry run", "approval dedup", "dry_run"],
		["live approval run", "nonterminal retry", "live"],
		["live approval run", "approval dedup", "live"],
	] as const)(
		"fails closed across the %s when the %s read fails",
		async (_label, failingRead, flow) => {
			const { deps, targetClient, deleteMovie, deleteMovieFile } = makeDeps({
				mediaPartCount: 1,
			});
			vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
				...dryRunConfig(2),
				requireApproval: true,
				dryRunMode: flow === "dry_run",
			} as never);
			vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
				matchingDryRunCacheItem({ id: "cache-first", arrItemId: 101, title: "First" }),
				matchingDryRunCacheItem({ id: "cache-second", arrItemId: 102, title: "Second" }),
			] as never);
			vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
				where,
			}: {
				where: {
					status?: { in?: string[] };
					OR?: Array<{ status: string }>;
				};
			}) => {
				if (where.status?.in) {
					if (failingRead === "nonterminal retry") {
						throw new Error("nonterminal retry storage unavailable");
					}
					return [];
				}
				if (where.OR) {
					if (failingRead === "approval dedup") {
						throw new Error("approval dedup storage unavailable");
					}
					return [];
				}
				return [];
			}) as never);

			const result =
				flow === "preview"
					? await executeCleanupPreview(deps, "user-1")
					: await executeCleanupRun(deps, "user-1");

			expect(result).toMatchObject({
				status: "partial",
				pendingRetryCount: null,
				previewItemCount: 2,
				previewSelection: {
					selectedFresh: 0,
					selectedRetries: 0,
					inFlight: 0,
					retryStateUnavailable: 2,
					retryState: "unavailable",
					total: 2,
				},
				itemsSkipped: 2,
			});
			expect(result.details).toHaveLength(2);
			expect(result.details).toEqual([
				expect.objectContaining({
					arrItemId: 101,
					action: "skipped",
					previewDisposition: "deferred",
					reason: expect.stringContaining("retry state could not be loaded safely"),
				}),
				expect.objectContaining({
					arrItemId: 102,
					action: "skipped",
					previewDisposition: "deferred",
					reason: expect.stringContaining("retry state could not be loaded safely"),
				}),
			]);
			expect(result.warnings).toContainEqual(
				expect.stringContaining("Fresh cleanup targets were deferred for safety"),
			);
			expect(deps.prisma.libraryCleanupApproval.create).not.toHaveBeenCalled();
			expect(targetClient.movie.getById).not.toHaveBeenCalled();
			expect(deleteMovieFile).not.toHaveBeenCalled();
			expect(deleteMovie).not.toHaveBeenCalled();
			if (flow !== "live") {
				expect(deps.prisma.libraryCleanupLog.create).not.toHaveBeenCalled();
			} else {
				expect(deps.prisma.libraryCleanupLog.create).toHaveBeenCalledWith({
					data: expect.objectContaining({
						status: "partial",
						itemsSkipped: 2,
						warnings: expect.stringContaining("Fresh cleanup targets were deferred for safety"),
					}),
				});
			}
		},
	);

	it.each([
		["interactive preview", "preview"],
		["configured dry run", "dry_run"],
		["live approval run", "live"],
	] as const)(
		"reports pending and in-flight retries without double counting in a healthy %s",
		async (_label, flow) => {
			const { deps } = makeDeps({ mediaPartCount: 1 });
			vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
				...dryRunConfig(2),
				requireApproval: true,
				dryRunMode: flow === "dry_run",
			} as never);
			vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
				matchingDryRunCacheItem({ id: "cache-fresh", arrItemId: 101, title: "Fresh" }),
			] as never);
			const pendingRetry = approvalRecord({
				id: "retry-pending",
				arrItemId: 201,
				title: "Pending retry",
				status: "retry_pending",
				reviewedAt: new Date("2026-07-30T00:00:00.000Z"),
			});
			const inFlightRetry = approvalRecord({
				id: "retry-executing",
				arrItemId: 202,
				title: "Executing retry",
				status: "retry_executing",
				reviewedAt: new Date("2026-07-31T00:00:00.000Z"),
			});
			vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
				where,
			}: {
				where: {
					status?: { in?: string[] };
					OR?: Array<{ status: string }>;
				};
			}) => (where.status?.in ? [pendingRetry, inFlightRetry] : [])) as never);

			const result =
				flow === "preview"
					? await executeCleanupPreview(deps, "user-1")
					: await executeCleanupRun(deps, "user-1");

			expect(result).toMatchObject({
				pendingRetryCount: 1,
				previewItemCount: 2,
				previewSelection: {
					selectedFresh: 1,
					selectedRetries: 0,
					inFlight: 1,
					retryStateUnavailable: 0,
					retryState: "complete",
					total: 2,
				},
			});
			expect(result.details).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ arrItemId: 101 }),
					expect.objectContaining({
						arrItemId: 202,
						previewDisposition: "in_flight",
						isRetryAttempt: true,
					}),
				]),
			);
			expect(result.details).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ arrItemId: 201 })]),
			);
			if (flow === "live") {
				expect(deps.prisma.libraryCleanupApproval.create).toHaveBeenCalledOnce();
			} else {
				expect(deps.prisma.libraryCleanupApproval.create).not.toHaveBeenCalled();
			}
		},
	);

	it.each([
		{ status: "pending", rejectionMemoryDays: 0 },
		{ status: "rejected", rejectionMemoryDays: 30 },
	])(
		"filters an existing $status approval before applying the approval run limit",
		async ({ status, rejectionMemoryDays }) => {
			const { deps, targetClient } = makeDeps({ mediaPartCount: 1 });
			vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
				...dryRunConfig(1),
				dryRunMode: false,
				requireApproval: true,
				rejectionMemoryDays,
			} as never);
			vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
				matchingDryRunCacheItem({
					id: "cache-existing",
					arrItemId: 101,
					title: "Existing approval",
				}),
				matchingDryRunCacheItem({
					id: "cache-fresh",
					arrItemId: 202,
					title: "Fresh approval candidate",
				}),
			] as never);
			vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
				where,
			}: {
				where: {
					status?: string | { in: string[] };
					OR?: Array<{ status: string }>;
				};
			}) => {
				if (where.status) return [];
				return [
					{
						instanceId: "radarr-4k",
						arrItemId: 101,
						itemType: "movie",
						status,
						reviewedAt: new Date(),
					},
				];
			}) as never);
			vi.mocked(deps.prisma.libraryCleanupApproval.findFirst).mockImplementation((async ({
				where,
			}: {
				where: { arrItemId: number };
			}) =>
				where.arrItemId === 101
					? {
							...approvalRecord(),
							status,
							reviewedAt: new Date(),
						}
					: null) as never);
			vi.mocked(targetClient.movie.getById).mockResolvedValue({
				id: 202,
				tmdbId: 42,
				title: "Fresh approval candidate",
				tags: [],
				hasFile: true,
				movieFileId: 1001,
				path: "/movies-4k/Example Movie (2024)",
				rootFolderPath: "/movies-4k",
				movieFile: {
					id: 1001,
					path: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
					relativePath: "Example.Movie.2160p.mkv",
					size: 2_000,
				},
			} as never);

			const result = await executeCleanupRun(deps, "user-1");

			expect(deps.prisma.libraryCleanupApproval.create).toHaveBeenCalledOnce();
			expect(deps.prisma.libraryCleanupApproval.create).toHaveBeenCalledWith({
				data: expect.objectContaining({
					arrItemId: 202,
					status: "pending",
				}),
			});
			expect(result).toMatchObject({
				status: "completed",
				itemsFlagged: 2,
				itemsSkipped: 1,
			});
		},
	);

	it("reports an approval queue write failure as partial and skipped", async () => {
		const { deps } = makeDeps({ mediaPartCount: 1 });
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			...dryRunConfig(1),
			dryRunMode: false,
			requireApproval: true,
		} as never);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem({
				id: "cache-approval",
				arrItemId: 101,
				title: "Approval candidate",
			}),
		] as never);
		vi.mocked(deps.prisma.libraryCleanupApproval.create).mockRejectedValue(
			new Error("database unavailable"),
		);

		const result = await executeCleanupRun(deps, "user-1");

		expect(result).toMatchObject({
			status: "partial",
			itemsFlagged: 1,
			itemsSkipped: 1,
		});
		expect(result.details).toEqual([
			expect.objectContaining({
				title: "Approval candidate",
				action: "skipped",
				reason: "Failed to queue: database unavailable",
			}),
		]);
	});

	it("budgets durable retries before fresh matches in a configured dry run", async () => {
		const { deps, targetClient } = makeDeps();
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig(1) as never,
		);
		const retry = approvalRecord({
			id: "retry-1",
			configId: "config-1",
			status: "retry_pending",
			matchedRuleId: "rule-1",
			matchedRuleName: "Old media",
			sizeOnDisk: 2_000n,
			year: 2024,
			rating: 8,
			createdAt: new Date("2026-07-27T12:00:00.000Z"),
			lastExecutionError: "Prior cleanup was interrupted",
		});
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
			where,
		}: {
			where: { status?: string };
		}) => (where.status === "retry_pending" ? [retry] : [])) as never);
		vi.mocked(deps.prisma.libraryCleanupApproval.count).mockResolvedValue(1);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			{
				id: "cache-fresh",
				instanceId: "radarr-4k",
				arrItemId: 202,
				itemType: "movie",
				title: "Fresh rule match",
				year: 2020,
				monitored: true,
				hasFile: true,
				status: "released",
				qualityProfileId: 1,
				qualityProfileName: "4K",
				sizeOnDisk: 1_000n,
				arrAddedAt: new Date("2020-01-01T00:00:00.000Z"),
				cachedAt: new Date("2026-07-27T12:05:00.000Z"),
				data: "{}",
			},
		] as never);

		const result = await executeCleanupRun(deps, "user-1");

		expect(result).toMatchObject({
			isDryRun: true,
			status: "partial",
			itemsEvaluated: 1,
			itemsFlagged: 1,
			pendingRetryCount: 1,
			itemsSkipped: 1,
			details: [
				expect.objectContaining({
					arrItemId: 101,
					action: "delete",
					plannedAction: "delete",
					isRetryAttempt: true,
					previewDisposition: "selected",
					reason: expect.stringContaining("outcome depends on live ARR authority"),
				}),
				expect.objectContaining({
					arrItemId: 202,
					action: "skipped",
					previewDisposition: "deferred",
					reason: expect.stringContaining("run budget is full"),
				}),
			],
		});
		expect(result.details).toHaveLength(2);
		expect(targetClient.movie.getById).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCleanupConfig.updateMany).not.toHaveBeenCalled();
	});

	it("does not recount a pending retry beyond the configured dry-run detail budget", async () => {
		const { deps } = makeDeps({ mediaPartCount: 1 });
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig(1) as never,
		);
		const selectedRetry = approvalRecord({
			id: "retry-selected",
			status: "retry_pending",
			matchedRuleId: "rule-1",
			matchedRuleName: "Old media",
			sizeOnDisk: 2_000n,
			year: 2024,
			createdAt: new Date("2026-07-27T12:00:00.000Z"),
		});
		const deferredRetry = approvalRecord({
			id: "retry-deferred",
			arrItemId: 202,
			status: "retry_pending",
			matchedRuleId: "rule-1",
			matchedRuleName: "Old media",
			sizeOnDisk: 1_000n,
			year: 2020,
			createdAt: new Date("2026-07-27T12:01:00.000Z"),
		});
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
			where,
		}: {
			where: { status?: string };
		}) => {
			if (where.status !== "retry_pending") return [];
			return [selectedRetry, deferredRetry];
		}) as never);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem({
				id: "cache-retry-deferred",
				arrItemId: 202,
				title: "Deferred retry target",
			}),
		] as never);

		const result = await executeCleanupRun(deps, "user-1");

		expect(result).toMatchObject({
			itemsEvaluated: 1,
			itemsFlagged: 1,
			pendingRetryCount: 2,
			previewSelection: {
				selectedRetries: 1,
				selectedFresh: 0,
				deferredBudget: 1,
				deferredDuplicateTarget: 1,
				total: 3,
			},
			itemsSkipped: 2,
		});
		expect(result.details).toHaveLength(3);
		expect(result.details[0]?.arrItemId).toBe(101);
		expect(result.details.slice(1)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					arrItemId: 202,
					action: "skipped",
					reason: expect.stringContaining("already owns this cleanup target"),
				}),
				expect.objectContaining({
					arrItemId: 202,
					action: "skipped",
					reason: expect.stringContaining("run budget is full"),
				}),
			]),
		);
	});

	it("defers an in-flight retry target in a configured dry run", async () => {
		const { deps, targetClient } = makeDeps();
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig(1) as never,
		);
		const inFlightRetry = approvalRecord({
			id: "retry-running",
			configId: "config-1",
			status: "retry_executing",
			matchedRuleId: "rule-1",
			matchedRuleName: "Old media",
			sizeOnDisk: 2_000n,
			year: 2024,
			rating: 8,
			createdAt: new Date("2026-07-27T12:00:00.000Z"),
		});
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
			where,
		}: {
			where: { status?: string };
		}) => (where.status === "retry_executing" ? [inFlightRetry] : [])) as never);
		vi.mocked(deps.prisma.libraryCleanupApproval.count).mockResolvedValue(0);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			{
				id: "cache-in-flight",
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "In-flight retry target",
				year: 2020,
				monitored: true,
				hasFile: true,
				status: "released",
				qualityProfileId: 1,
				qualityProfileName: "4K",
				sizeOnDisk: 1_000n,
				arrAddedAt: new Date("2020-01-01T00:00:00.000Z"),
				cachedAt: new Date("2026-07-27T12:05:00.000Z"),
				data: "{}",
			},
		] as never);

		const result = await executeCleanupRun(deps, "user-1");

		expect(result).toMatchObject({
			isDryRun: true,
			status: "partial",
			itemsEvaluated: 1,
			itemsFlagged: 1,
			pendingRetryCount: 0,
			itemsSkipped: 2,
			details: [
				expect.objectContaining({
					arrItemId: 101,
					action: "skipped",
					reason: "Deferred: another cleanup run is already executing this durable retry.",
				}),
				expect.objectContaining({
					arrItemId: 101,
					action: "skipped",
					reason: expect.stringContaining("already owns this cleanup target"),
				}),
			],
		});
		expect(targetClient.movie.getById).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCleanupConfig.updateMany).not.toHaveBeenCalled();
	});

	it("blocks when another Radarr instance may mount the same storage under a different path", async () => {
		const { deps, targetInstance, targetClient } = makeDeps({
			includePlexNotification: false,
			mediaPartCount: 1,
		});
		const otherInstance = {
			...targetInstance,
			id: "radarr-hd",
			label: "HD Radarr",
			baseUrl: "http://radarr-hd.internal:7878",
		};
		vi.mocked(deps.prisma.serviceInstance.findMany).mockImplementation(
			(args) =>
				(args?.where?.service === "PLEX"
					? Promise.resolve([])
					: Promise.resolve([targetInstance, otherInstance])) as never,
		);

		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"another configured Radarr instance may access the same storage under a different path",
		);
		expect(deps.prisma.serviceInstance.findMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				service: { in: ["RADARR", "SONARR"] },
			},
		});
		expect(targetClient.notification.getAll).toHaveBeenCalledOnce();
	});

	it("allows a merged Plex movie when another Radarr instance verifies the retained part", async () => {
		const fixture = makeDeps();
		const { peerInstance, peerClient } = configureVerifiedRadarrPeer(fixture);
		const context = createSharedPlexSafetyContext();

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);

		expect(blocks).toEqual(new Map());
		expect(peerClient.movie.getAll).toHaveBeenCalledWith({ tmdbId: 42 });
		expect(context.plans.get(cleanupDeleteTargetKey(target))).toMatchObject({
			kind: "verified_radarr",
			file: { movieFileId: 1001 },
			peers: [
				{
					instanceId: peerInstance.id,
					arrItemId: 202,
					file: {
						movieFileId: 2002,
						fullPath: {
							value: "/downloads-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
						},
						size: 1_000,
					},
				},
			],
			ownership: [
				{
					plexServerUrl: "http://plex.internal:32400",
					target: {
						ratingKey: "plex-movie-42",
						fullPath: {
							value: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
						},
						size: 2_000,
					},
					retained: [
						{
							instanceId: peerInstance.id,
							ratingKey: "plex-movie-42",
							fullPath: {
								value: "/plex/movies-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
							},
							size: 1_000,
							mapping: {
								from: { value: "/downloads-hd" },
								to: { value: "/plex/movies-hd" },
							},
						},
					],
				},
			],
		});
	});

	it("uses an ownership-only target Plex mapping when delete triggers are disabled", async () => {
		const fixture = makeDeps({
			onMovieDelete: false,
			onMovieFileDelete: false,
			mapFrom: "/movies-4k",
			mapTo: "/plex/movies-4k",
			plexItems: [
				{
					ratingKey: "plex-movie-42",
					parts: [
						{
							file: "/plex/movies-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
							size: 1_000,
						},
						{
							file: "/plex/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
							size: 2_000,
						},
					],
				},
			],
		});
		const { peerInstance } = configureVerifiedRadarrPeer(fixture);
		const context = createSharedPlexSafetyContext();

		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		expect(context.plans.get(cleanupDeleteTargetKey(target))).toMatchObject({
			kind: "verified_radarr",
			targetDeleteNotifications: [],
			ownership: [
				{
					plexServerUrl: "http://plex.internal:32400",
					target: {
						fullPath: {
							value: "/plex/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
						},
						size: 2_000,
					},
					retained: [expect.objectContaining({ instanceId: peerInstance.id, size: 1_000 })],
				},
			],
		});
	});

	it("accepts an ownership-only exact match when no Radarr peer exists", async () => {
		const fixture = makeDeps({
			onMovieDelete: false,
			onMovieFileDelete: false,
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
		const context = createSharedPlexSafetyContext();

		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		expect(context.plans.get(cleanupDeleteTargetKey(target))).toMatchObject({
			kind: "verified_radarr",
			peers: [],
			ownership: [],
			targetDeleteNotifications: [],
		});
	});

	it("uses ownership-only mappings when deleting HD and retaining 4K", async () => {
		const fixture = makeDeps({
			onMovieDelete: false,
			onMovieFileDelete: false,
			movieFile: {
				path: "/downloads-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
				relativePath: "Example.Movie.1080p.mkv",
				size: 1_000,
			},
			mapFrom: "/downloads-hd",
			mapTo: "/plex/movies-hd",
			plexItems: [
				{
					ratingKey: "plex-movie-42",
					parts: [
						{
							file: "/plex/movies-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
							size: 1_000,
						},
						{
							file: "/plex/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
							size: 2_000,
						},
					],
				},
			],
		});
		const { peerInstance, deletePeerMovie, deletePeerMovieFile } = configureVerifiedRadarrPeer(
			fixture,
			{
				filePath: "/downloads-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
				fileSize: 2_000,
				mapFrom: "/downloads-4k",
				mapTo: "/plex/movies-4k",
			},
		);
		const context = createSharedPlexSafetyContext();

		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		expect(context.plans.get(cleanupDeleteTargetKey(target))).toMatchObject({
			kind: "verified_radarr",
			file: { movieFileId: 1001, size: 1_000 },
			targetDeleteNotifications: [],
			ownership: [
				{
					target: { size: 1_000 },
					retained: [expect.objectContaining({ instanceId: peerInstance.id, size: 2_000 })],
				},
			],
		});
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_radarr") {
			throw new Error("Expected a verified Radarr safety plan");
		}
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({ safetySnapshot: serializeExecutableSafetyPlan(plan) }) as never,
		]);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).toHaveBeenCalledWith(101, {
			deleteFiles: false,
			addImportExclusion: false,
		});
		expect(deletePeerMovieFile).not.toHaveBeenCalled();
		expect(deletePeerMovie).not.toHaveBeenCalled();
	});

	it("ignores a stale optional ownership mapping when another mapping proves ownership", async () => {
		const { fixture } = makeOwnershipOnlyMappedRadarrFixture();
		const validNotification = (await fixture.targetClient.notification.getAll())[0]!;
		fixture.targetClient.notification.getAll.mockResolvedValue([
			{
				...validNotification,
				fields: notificationFields({
					mapFrom: "/movies-4k",
					mapTo: "/stale/movies-4k",
				}),
			},
			validNotification,
		]);
		const context = createSharedPlexSafetyContext();

		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		expect(context.plans.get(cleanupDeleteTargetKey(target))).toMatchObject({
			kind: "verified_radarr",
			targetDeleteNotifications: [],
			ownership: [
				{
					target: {
						fullPath: {
							value: "/plex/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
						},
					},
				},
			],
		});
	});

	it("blocks when an alternate ownership mapping matches multiple Plex parts", async () => {
		const { fixture } = makeOwnershipOnlyMappedRadarrFixture();
		const validNotification = (await fixture.targetClient.notification.getAll())[0]!;
		fixture.targetClient.notification.getAll.mockResolvedValue([
			validNotification,
			{
				...validNotification,
				fields: notificationFields({
					mapFrom: "/movies-4k",
					mapTo: "/plex/ambiguous-4k",
				}),
			},
		]);
		fixture.getMovieMediaPartsByTmdbId.mockResolvedValue([
			{
				ratingKey: "plex-movie-42",
				parts: [
					{
						file: "/plex/movies-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
						size: 1_000,
					},
					{
						file: "/plex/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
						size: 2_000,
					},
				],
			},
			...(["ambiguous-a", "ambiguous-b"] as const).map((ratingKey) => ({
				ratingKey,
				parts: [
					{
						file: "/plex/ambiguous-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
						size: 2_000,
					},
				],
			})),
		]);

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(blocks.has(cleanupDeleteTargetKey(target))).toBe(true);
		expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
	});

	it.each<[string, TestOptions]>([
		["disabled", { notificationEnable: false }],
		["tag-excluded", { movieTags: [], notificationTags: [77] }],
		["library-update-disabled", { updateLibrary: false }],
	])("does not use a %s Plex connection as ownership fallback", async (_label, options) => {
		const fixture = makeDeps({
			...options,
			onMovieDelete: false,
			onMovieFileDelete: false,
			mapFrom: "/movies-4k",
			mapTo: "/plex/movies-4k",
		});
		configureVerifiedRadarrPeer(fixture);

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"another configured Radarr instance may access the same storage under a different path",
		);
		expect(fixture.plexClientFactory).not.toHaveBeenCalled();
	});

	it("deletes only the selected Radarr file after rechecking the retained peer", async () => {
		const fixture = makeDeps();
		const { peerClient, deletePeerMovie, deletePeerMovieFile } =
			configureVerifiedRadarrPeer(fixture);
		const context = createSharedPlexSafetyContext();
		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (
			!plan ||
			(plan.kind !== "verified_radarr" &&
				plan.kind !== "verified_radarr_empty" &&
				plan.kind !== "verified_arr_target" &&
				plan.kind !== "verified_sonarr")
		) {
			throw new Error("Expected an executable safety plan");
		}
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({ safetySnapshot: serializeExecutableSafetyPlan(plan) }) as never,
		]);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});

		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).toHaveBeenCalledWith(101, {
			deleteFiles: false,
			addImportExclusion: false,
		});
		expect(peerClient.movie.getById).toHaveBeenCalledWith(202);
		expect(deletePeerMovieFile).not.toHaveBeenCalled();
		expect(deletePeerMovie).not.toHaveBeenCalled();
	});

	it("executes an approved cleanup using ownership-only Plex mappings", async () => {
		const { fixture, peer } = makeOwnershipOnlyMappedRadarrFixture();
		const { deletePeerMovie, deletePeerMovieFile } = peer;
		const context = createSharedPlexSafetyContext();
		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_radarr") {
			throw new Error("Expected a verified Radarr safety plan");
		}
		expect(plan.targetDeleteNotifications).toEqual([]);
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({ safetySnapshot: serializeExecutableSafetyPlan(plan) }) as never,
		]);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});

		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).toHaveBeenCalledWith(101, {
			deleteFiles: false,
			addImportExclusion: false,
		});
		expect(deletePeerMovieFile).not.toHaveBeenCalled();
		expect(deletePeerMovie).not.toHaveBeenCalled();
	});

	it.each(["delete", "delete_files"] as const)(
		"rejects an ownership-only %s approval when the Plex connection gains a file-delete trigger",
		async (action) => {
			const actionTarget = { ...target, action };
			const { fixture } = makeOwnershipOnlyMappedRadarrFixture({ action });
			const context = createSharedPlexSafetyContext();
			expect(
				await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [actionTarget], context),
			).toEqual(new Map());
			const plan = context.plans.get(cleanupDeleteTargetKey(actionTarget));
			if (plan?.kind !== "verified_radarr") {
				throw new Error("Expected a verified Radarr safety plan");
			}
			const originalNotification = (await fixture.targetClient.notification.getAll())[0]!;
			fixture.targetClient.notification.getAll.mockResolvedValue([
				{
					...originalNotification,
					onMovieDelete: false,
					onMovieFileDelete: true,
				},
			]);
			vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
				approvalRecord({ action, safetySnapshot: serializeExecutableSafetyPlan(plan) }) as never,
			]);

			const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

			expect(result).toMatchObject({ removed: 0, failed: 1 });
			expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
			expect(fixture.deleteMovie).not.toHaveBeenCalled();
		},
	);

	it("supports delete-files approvals using ownership-only Plex mappings", async () => {
		const deleteFilesTarget = { ...target, action: "delete_files" as const };
		const { fixture, peer } = makeOwnershipOnlyMappedRadarrFixture({
			action: "delete_files",
		});
		const { deletePeerMovie, deletePeerMovieFile } = peer;
		const context = createSharedPlexSafetyContext();
		expect(
			await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [deleteFilesTarget], context),
		).toEqual(new Map());
		const plan = context.plans.get(cleanupDeleteTargetKey(deleteFilesTarget));
		if (plan?.kind !== "verified_radarr") {
			throw new Error("Expected a verified Radarr safety plan");
		}
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({
				action: "delete_files",
				safetySnapshot: serializeExecutableSafetyPlan(plan),
			}) as never,
		]);

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});

		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
		expect(deletePeerMovieFile).not.toHaveBeenCalled();
		expect(deletePeerMovie).not.toHaveBeenCalled();
	});

	it("keeps the live peer witness while comparing a direct cleanup to cached target data", async () => {
		const { fixture, peer } = makeOwnershipOnlyMappedRadarrFixture();
		const { deletePeerMovie, deletePeerMovieFile } = peer;
		configureRetryStore(fixture.deps);
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
				ruleName: "Remove 4K duplicate",
				reason: "Matched 4K cleanup rule",
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

		expect(result).toMatchObject({ itemsRemoved: 1, itemsSkipped: 0 });
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(deletePeerMovieFile).not.toHaveBeenCalled();
		expect(deletePeerMovie).not.toHaveBeenCalled();
	});

	it("previews a cross-path ownership-only cleanup without mutating either Radarr", async () => {
		const { fixture, peer } = makeOwnershipOnlyMappedRadarrFixture();
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig() as never,
		);
		vi.mocked(fixture.deps.prisma.libraryCache.findMany)
			.mockResolvedValueOnce([
				matchingDryRunCacheItem({
					arrItemId: 101,
					title: "Example Movie",
					sizeOnDisk: 2_000n,
				}),
			] as never)
			.mockResolvedValue([] as never);

		const result = await executeCleanupPreview(fixture.deps, "user-1");

		expect(result).toMatchObject({
			isDryRun: true,
			itemsFlagged: 1,
			itemsRemoved: 0,
			details: [expect.objectContaining({ arrItemId: 101, plannedAction: "delete" })],
		});
		expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
		expect(peer.deletePeerMovieFile).not.toHaveBeenCalled();
		expect(peer.deletePeerMovie).not.toHaveBeenCalled();
	});

	it("blocks a merged Plex movie when an extra part has no verified Radarr owner", async () => {
		const fixture = makeDeps({
			plexItems: [
				{
					ratingKey: "plex-movie-42",
					parts: [
						{
							file: "/plex/movies-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
							size: 1_000,
						},
						{
							file: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
							size: 2_000,
						},
						{
							file: "/plex/movies-remux/Example Movie (2024)/Example.Movie.Remux.mkv",
							size: 3_000,
						},
					],
				},
			],
		});
		configureVerifiedRadarrPeer(fixture);

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain("Plex has multiple files merged");
		expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
	});

	it("blocks when the peer Radarr resolves to the selected Plex part", async () => {
		const fixture = makeDeps();
		configureVerifiedRadarrPeer(fixture, {
			filePath: "/downloads-hd/Example Movie (2024)/Example.Movie.2160p.mkv",
			fileSize: 2_000,
			mapTo: "/movies-4k",
		});

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"another configured Radarr instance may access the same storage",
		);
		expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
	});

	it.each([
		["disabled", { notificationEnable: false }],
		["tag-inapplicable", { movieTags: [], notificationTags: [9] }],
	])(
		"does not authorize a raw peer path through a %s mapped notification",
		async (_label, peer) => {
			const fixture = makeDeps();
			configureVerifiedRadarrPeer(fixture, {
				...peer,
				filePath: "/plex/movies-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
				mapFrom: "/stale-peer-root",
				mapTo: "/stale-plex-root",
			});

			const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

			expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
				"could not match the exact Radarr movie file",
			);
			expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
		},
	);

	it("snapshots an unrelated Radarr peer as absent without blocking the retained variant", async () => {
		const fixture = makeDeps();
		const { peerInstance, peerClient } = configureVerifiedRadarrPeer(fixture);
		const unrelatedInstance = {
			...fixture.targetInstance,
			id: "radarr-anime",
			label: "Anime Radarr",
			baseUrl: "http://radarr-anime.internal:7878",
			encryptedApiKey: "encrypted-radarr-anime-key",
			encryptionIv: "radarr-anime-iv",
		};
		const unrelatedClient = {
			movie: {
				getAll: vi.fn().mockResolvedValue([]),
				getById: vi.fn(),
				delete: vi.fn(),
				update: vi.fn(),
			},
			movieFile: {
				getById: vi.fn(),
				delete: vi.fn(),
			},
			notification: {
				getAll: vi.fn(),
			},
		};
		vi.mocked(fixture.deps.prisma.serviceInstance.findMany).mockImplementation(
			(args) =>
				(args?.where?.service === "PLEX"
					? Promise.resolve([fixture.plexInstance])
					: Promise.resolve([fixture.targetInstance, peerInstance, unrelatedInstance])) as never,
		);
		vi.mocked(fixture.deps.arrClientFactory.create).mockImplementation(
			(instance) =>
				(instance.id === peerInstance.id
					? peerClient
					: instance.id === unrelatedInstance.id
						? unrelatedClient
						: fixture.targetClient) as never,
		);
		const context = createSharedPlexSafetyContext();

		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_radarr") {
			throw new Error("Expected a verified Radarr safety plan");
		}
		expect(plan.peers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					instanceId: unrelatedInstance.id,
					externalId: 42,
					arrItemId: null,
					mediaPath: null,
					file: null,
				}),
			]),
		);
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({ safetySnapshot: serializeExecutableSafetyPlan(plan) }) as never,
		]);

		await expect(
			executeApprovedItems(fixture.deps, "user-1", ["approval-1"]),
		).resolves.toMatchObject({ removed: 1, failed: 0 });
		expect(unrelatedClient.movie.getAll.mock.calls.length).toBeGreaterThanOrEqual(4);
		expect(unrelatedClient.movie.getById).not.toHaveBeenCalled();
	});

	it("blocks at the mutation boundary when the retained Radarr peer changes", async () => {
		const fixture = makeDeps();
		const { peerClient, peerMovie } = configureVerifiedRadarrPeer(fixture);
		const context = createSharedPlexSafetyContext();
		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_radarr") {
			throw new Error("Expected a verified Radarr safety plan");
		}
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({ safetySnapshot: serializeExecutableSafetyPlan(plan) }) as never,
		]);
		peerClient.movie.getById.mockResolvedValue({
			...peerMovie,
			movieFileId: 2999,
		});

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("Radarr movie file changed");
		expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
	});

	it("reports an unpersisted mutation boundary honestly when later outcome audit succeeds", async () => {
		const fixture = makeDeps();
		const persistedAuditEvents: Array<{ eventType: string; evidence?: string }> = [];
		const auditCreate = vi.fn(
			async ({ data }: { data: { eventType: string; evidence?: string } }) => {
				if (data.eventType === "mutation_prepared") {
					throw new Error("transient audit boundary failure");
				}
				persistedAuditEvents.push(data);
				return {};
			},
		);
		Object.assign(fixture.deps.prisma, {
			libraryCleanupAuditEvent: {
				create: auditCreate,
				findMany: vi.fn().mockResolvedValue([]),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
		});
		configureVerifiedRadarrPeer(fixture);
		const context = createSharedPlexSafetyContext();
		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_radarr") {
			throw new Error("Expected a verified Radarr safety plan");
		}
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({ safetySnapshot: serializeExecutableSafetyPlan(plan) }) as never,
		]);
		const safeItems = [
			{
				ratingKey: "plex-movie-42",
				parts: [
					{
						file: "/plex/movies-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
						size: 1_000,
					},
					{
						file: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
						size: 2_000,
					},
				],
			},
		];
		fixture.getMovieMediaPartsByTmdbId.mockResolvedValueOnce(safeItems).mockResolvedValueOnce([
			{
				ratingKey: "plex-movie-42",
				parts: [
					{
						file: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
						size: 2_000,
					},
				],
			},
		]);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("ownership changed at the mutation boundary");
		expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
		const auditEvents = auditCreate.mock.calls.map(([call]) => call.data);
		const preparedIndex = auditEvents.findIndex((event) => event.eventType === "mutation_prepared");
		expect(preparedIndex).toBeGreaterThanOrEqual(0);
		expect(auditCreate.mock.invocationCallOrder[preparedIndex]).toBeLessThan(
			fixture.getMovieMediaPartsByTmdbId.mock.invocationCallOrder.at(-1)!,
		);
		expect(persistedAuditEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "safety_blocked",
					evidence: expect.stringContaining('"auditPrepared":false'),
				}),
			]),
		);
		expect(persistedAuditEvents.some((event) => event.eventType === "mutation_prepared")).toBe(
			false,
		);
		expect(
			persistedAuditEvents.some(
				(event) =>
					event.eventType === "terminal_succeeded" ||
					event.evidence?.includes('"mutationAttempted":true'),
			),
		).toBe(false);
	});

	it("retains the target record when the peer disappears after exact file deletion", async () => {
		const fixture = makeDeps();
		const { peerClient } = configureVerifiedRadarrPeer(fixture);
		const context = createSharedPlexSafetyContext();
		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_radarr") {
			throw new Error("Expected a verified Radarr safety plan");
		}
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({ safetySnapshot: serializeExecutableSafetyPlan(plan) }) as never,
		]);
		const deleteSelectedFile = fixture.deleteMovieFile.getMockImplementation();
		if (!deleteSelectedFile) throw new Error("Expected a target file delete implementation");
		fixture.deleteMovieFile.mockImplementation(async (movieFileId) => {
			await deleteSelectedFile(movieFileId);
			peerClient.movie.getAll.mockResolvedValue([]);
		});

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
		expect(result.errors[0]).toContain("Partial cleanup");
	});

	it("retains the target record when its Plex notification changes after exact file deletion", async () => {
		const fixture = makeDeps({ onMovieDelete: true, onMovieFileDelete: true });
		configureVerifiedRadarrPeer(fixture);
		const originalNotifications = await fixture.targetClient.notification.getAll();
		const context = createSharedPlexSafetyContext();
		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_radarr") {
			throw new Error("Expected a verified Radarr safety plan");
		}
		expect(plan.targetDeleteNotifications).toHaveLength(1);
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({ safetySnapshot: serializeExecutableSafetyPlan(plan) }) as never,
		]);
		const deleteSelectedFile = fixture.deleteMovieFile.getMockImplementation();
		if (!deleteSelectedFile) throw new Error("Expected a target file delete implementation");
		fixture.deleteMovieFile.mockImplementation(async (movieFileId) => {
			await deleteSelectedFile(movieFileId);
			fixture.targetClient.notification.getAll.mockResolvedValue(
				originalNotifications.map((notification: Record<string, unknown>) => ({
					...notification,
					fields: notificationFields({
						mapFrom: "/movies-4k",
						mapTo: "/changed-plex-root",
					}),
				})),
			);
		});

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
		expect(result.errors[0]).toContain("Partial cleanup");
	});

	it("retains the target record when a replacement file appears during the final Plex proof", async () => {
		const fixture = makeDeps();
		configureVerifiedRadarrPeer(fixture);
		const context = createSharedPlexSafetyContext();
		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_radarr") {
			throw new Error("Expected a verified Radarr safety plan");
		}
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({ safetySnapshot: serializeExecutableSafetyPlan(plan) }) as never,
		]);
		const deleteSelectedFile = fixture.deleteMovieFile.getMockImplementation();
		if (!deleteSelectedFile) throw new Error("Expected a target file delete implementation");
		fixture.deleteMovieFile.mockImplementation(async (movieFileId) => {
			await deleteSelectedFile(movieFileId);
			fixture.getMovieMediaPartsByTmdbId.mockImplementation(async () => {
				fixture.setLiveMovieFileId(3003);
				return [
					{
						ratingKey: "plex-movie-42",
						parts: [
							{
								file: "/plex/movies-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
								size: 1_000,
							},
						],
					},
				];
			});
		});

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
		expect(result.errors[0]).toContain("Partial cleanup");
	});

	it("retains the target record when a new unowned Plex part appears after exact file deletion", async () => {
		const fixture = makeDeps();
		configureVerifiedRadarrPeer(fixture);
		const context = createSharedPlexSafetyContext();
		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_radarr") {
			throw new Error("Expected a verified Radarr safety plan");
		}
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({ safetySnapshot: serializeExecutableSafetyPlan(plan) }) as never,
		]);
		const deleteSelectedFile = fixture.deleteMovieFile.getMockImplementation();
		if (!deleteSelectedFile) throw new Error("Expected a target file delete implementation");
		fixture.deleteMovieFile.mockImplementation(async (movieFileId) => {
			await deleteSelectedFile(movieFileId);
			fixture.getMovieMediaPartsByTmdbId.mockResolvedValue([
				{
					ratingKey: "plex-movie-42",
					parts: [
						{
							file: "/plex/movies-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
							size: 1_000,
						},
						{
							file: "/plex/movies-remux/Example Movie (2024)/Example.Movie.Remux.mkv",
							size: 3_000,
						},
					],
				},
			]);
		});

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
		expect(result.errors[0]).toContain("Partial cleanup");
	});

	it("allows the deleted target Plex item to disappear when the retained peer has its own item", async () => {
		const fixture = makeDeps({
			plexItems: [
				{
					ratingKey: "plex-movie-4k",
					parts: [
						{
							file: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
							size: 2_000,
						},
					],
				},
				{
					ratingKey: "plex-movie-hd",
					parts: [
						{
							file: "/plex/movies-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
							size: 1_000,
						},
					],
				},
			],
		});
		configureVerifiedRadarrPeer(fixture);
		const context = createSharedPlexSafetyContext();
		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_radarr") {
			throw new Error("Expected a verified Radarr safety plan");
		}
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({ safetySnapshot: serializeExecutableSafetyPlan(plan) }) as never,
		]);
		const deleteSelectedFile = fixture.deleteMovieFile.getMockImplementation();
		if (!deleteSelectedFile) throw new Error("Expected a target file delete implementation");
		fixture.deleteMovieFile.mockImplementation(async (movieFileId) => {
			await deleteSelectedFile(movieFileId);
			fixture.getMovieMediaPartsByTmdbId.mockResolvedValue([
				{
					ratingKey: "plex-movie-hd",
					parts: [
						{
							file: "/plex/movies-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
							size: 1_000,
						},
					],
				},
			]);
		});

		await expect(executeApprovedItems(fixture.deps, "user-1", ["approval-1"])).resolves.toEqual({
			removed: 1,
			failed: 0,
			errors: [],
		});
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).toHaveBeenCalledWith(101, {
			deleteFiles: false,
			addImportExclusion: false,
		});
	});

	it("does not claim retries will run when cleanup has no enabled rules", async () => {
		const { deps, deleteMovie, deleteMovieFile, targetClient } = makeDeps({ mediaPartCount: 1 });
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			rules: [],
		} as never);
		const retry = {
			...approvalRecord({
				status: "retry_pending",
				lastExecutionError: "Radarr was unavailable",
				action: null,
			}),
			matchedRuleId: "rule-1",
			matchedRuleName: "Cleanup",
			sizeOnDisk: 2_000n,
			year: 2024,
		};
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
			where,
		}: {
			where: { status?: string };
		}) => (where.status === "retry_pending" ? [retry] : [])) as never);
		vi.mocked(deps.prisma.libraryCleanupApproval.count).mockResolvedValue(1);

		const result = await executeCleanupPreview(deps, "user-1");

		expect(result).toMatchObject({
			isDryRun: true,
			itemsEvaluated: 0,
			itemsFlagged: 0,
			pendingRetryCount: 0,
			itemsRemoved: 0,
			details: [],
		});
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(targetClient.movie.update).not.toHaveBeenCalled();
	});

	it.each(["delete", "unmonitor", "delete_files"] as const)(
		"reports a duplicate rule match without selecting its durable %s retry target twice",
		async (action) => {
			const { deps } = makeDeps({ mediaPartCount: 1 });
			vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
				dryRunConfig() as never,
			);
			const retry = {
				...approvalRecord({
					status: "retry_pending",
					lastExecutionError: "Radarr was unavailable",
					action,
				}),
				matchedRuleId: "rule-1",
				matchedRuleName: "Cleanup",
				sizeOnDisk: 2_000n,
				year: 2024,
			};
			vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
				where,
			}: {
				where: { status?: string };
			}) => (where.status === "retry_pending" ? [retry] : [])) as never);
			vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
				matchingDryRunCacheItem({
					id: "cache-retry",
					arrItemId: 101,
					title: "Example Movie",
				}),
			] as never);

			const result = await executeCleanupPreview(deps, "user-1");

			expect(result).toMatchObject({
				itemsEvaluated: 1,
				itemsFlagged: 1,
				pendingRetryCount: 1,
			});
			expect(result.details).toHaveLength(2);
			expect(result.details[0]).toMatchObject({
				arrItemId: 101,
				// Legacy clients only understand action, so it must remain the
				// configured mutation even though this preview predicts no outcome.
				action,
				plannedAction: action,
				isRetryAttempt: true,
				previewDisposition: "selected",
				reason: expect.stringContaining("outcome depends on live ARR authority"),
			});
			expect(result.details[1]).toMatchObject({
				arrItemId: 101,
				action: "skipped",
				previewDisposition: "deferred",
				reason: expect.stringContaining("already owns this cleanup target"),
			});
		},
	);

	it("plans a populated preview without leases, durable writes, logs, or ARR mutations", async () => {
		const { deps, targetClient, deleteMovie, deleteMovieFile } = makeDeps({
			mediaPartCount: 1,
		});
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig(1) as never,
		);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem({
				id: "cache-selected",
				arrItemId: 101,
				title: "Selected",
			}),
			matchingDryRunCacheItem({
				id: "cache-deferred",
				arrItemId: 102,
				title: "Deferred",
			}),
		] as never);

		const result = await executeCleanupPreview(deps, "user-1");

		expect(result.previewSelection).toMatchObject({
			selectedFresh: 1,
			selectedRetries: 0,
			deferredBudget: 1,
			total: 2,
		});
		expect(result.details).toEqual([
			expect.objectContaining({ arrItemId: 101, previewDisposition: "selected" }),
			expect.objectContaining({
				arrItemId: 102,
				previewDisposition: "deferred",
				reason: expect.stringContaining("run budget is full"),
			}),
		]);
		expect(deps.prisma.libraryCleanupLog.create).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCleanupConfig.updateMany).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCleanupApproval.create).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCleanupApproval.updateMany).not.toHaveBeenCalled();
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(targetClient.movie.update).not.toHaveBeenCalled();
	});

	it.each(["retry_pending", "retry_executing"] as const)(
		"defers every fresh preview target when the %s query fails",
		async (failingStatus) => {
			const { deps, targetClient, deleteMovie, deleteMovieFile } = makeDeps({
				mediaPartCount: 1,
			});
			vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
				dryRunConfig(2) as never,
			);
			vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
				where,
			}: {
				where: { status?: string };
			}) => {
				if (where.status === failingStatus) throw new Error("database unavailable");
				return [];
			}) as never);
			vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
				matchingDryRunCacheItem({ id: "cache-first", arrItemId: 101, title: "First" }),
				matchingDryRunCacheItem({ id: "cache-second", arrItemId: 102, title: "Second" }),
			] as never);

			const result = await executeCleanupPreview(deps, "user-1");

			expect(result).toMatchObject({
				status: "partial",
				pendingRetryCount: null,
				previewSelection: {
					selectedFresh: 0,
					selectedRetries: 0,
					retryStateUnavailable: 2,
					retryState: "unavailable",
					total: 2,
				},
				itemsSkipped: 2,
			});
			expect(result.details).toHaveLength(2);
			expect(result.details).toEqual([
				expect.objectContaining({
					arrItemId: 101,
					action: "skipped",
					reason: expect.stringContaining("retry state could not be loaded safely"),
				}),
				expect.objectContaining({
					arrItemId: 102,
					action: "skipped",
					reason: expect.stringContaining("retry state could not be loaded safely"),
				}),
			]);
			expect(targetClient.movie.getById).not.toHaveBeenCalled();
			expect(deleteMovieFile).not.toHaveBeenCalled();
			expect(deleteMovie).not.toHaveBeenCalled();
			expect(targetClient.movie.update).not.toHaveBeenCalled();
		},
	);

	it("accounts honestly for live fresh targets deferred by unavailable retry state", async () => {
		const { deps, targetClient, deleteMovie, deleteMovieFile } = makeDeps({
			mediaPartCount: 1,
		});
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockRejectedValue(
			new Error("database unavailable"),
		);
		const flagged = [101, 102].map((arrItemId) => ({
			cacheItem: matchingDryRunCacheItem({
				id: `cache-${arrItemId}`,
				arrItemId,
				title: `Movie ${arrItemId}`,
			}),
			match: {
				ruleId: "rule-1",
				ruleName: "Old media",
				reason: "Matched",
				action: "delete",
			},
			rating: 8,
		}));

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 2, rules: [] } as never,
			"user-1",
			flagged as never,
			2,
			2,
			Date.now(),
		);

		expect(result).toMatchObject({
			status: "partial",
			itemsFlagged: 2,
			itemsSkipped: 2,
		});
		expect(result.details).toHaveLength(2);
		expect(result.warnings).toContainEqual(
			expect.stringContaining("fresh cleanup targets were deferred"),
		);
		expect(deps.prisma.libraryCleanupLog.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ itemsFlagged: 2, itemsSkipped: 2 }),
		});
		expect(targetClient.movie.getById).not.toHaveBeenCalled();
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
	});

	it("excludes approval memory before selecting the next preview target", async () => {
		const { deps, targetClient } = makeDeps({ mediaPartCount: 1 });
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			...dryRunConfig(1),
			requireApproval: true,
		} as never);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem({
				id: "cache-pending",
				arrItemId: 101,
				title: "Already pending",
			}),
			matchingDryRunCacheItem({
				id: "cache-selected",
				arrItemId: 202,
				title: "Selected after dedup",
			}),
		] as never);
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
			where,
		}: {
			where: {
				status?: string | { in: string[] };
				OR?: Array<{ status: string }>;
			};
		}) => {
			if (where.OR) {
				return [
					{
						instanceId: "radarr-4k",
						arrItemId: 101,
						itemType: "movie",
						targetScope: "series",
						arrEpisodeId: null,
						status: "pending",
						reviewedAt: null,
					},
				];
			}
			return [];
		}) as never);
		vi.mocked(targetClient.movie.getById).mockResolvedValue({
			id: 202,
			tmdbId: 42,
			title: "Selected after dedup",
			tags: [],
			hasFile: true,
			movieFileId: 1001,
			path: "/movies-4k/Example Movie (2024)",
			rootFolderPath: "/movies-4k",
			movieFile: {
				id: 1001,
				path: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
				relativePath: "Example.Movie.2160p.mkv",
				size: 2_000,
			},
		} as never);

		const result = await executeCleanupPreview(deps, "user-1");

		expect(result.previewSelection).toMatchObject({
			selectedFresh: 1,
			deferredApproval: 1,
			deferredBudget: 0,
		});
		expect(result.details).toEqual([
			expect.objectContaining({ arrItemId: 202, previewDisposition: "selected" }),
			expect.objectContaining({
				arrItemId: 101,
				previewDisposition: "deferred",
				reason: "Already pending in the approval queue",
			}),
		]);
		expect(deps.prisma.libraryCleanupApproval.create).not.toHaveBeenCalled();
	});

	it("bounds preview and configured dry-run details while keeping complete counts", async () => {
		const { deps } = makeDeps({ mediaPartCount: 1 });
		const config = {
			...dryRunConfig(100),
			rules: [{ ...dryRunConfig(100).rules[0]!, action: "unmonitor" }],
		};
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(config as never);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue(
			Array.from({ length: 250 }, (_, index) =>
				matchingDryRunCacheItem({
					id: `cache-${String(index + 1).padStart(3, "0")}`,
					arrItemId: index + 1,
					title: `Movie ${index + 1}`,
				}),
			) as never,
		);

		const preview = await executeCleanupPreview(deps, "user-1");
		const configuredDryRun = await executeCleanupRun(deps, "user-1");

		for (const result of [preview, configuredDryRun]) {
			expect(result.itemsFlagged).toBe(250);
			expect(result.selectionCountsComplete).toBe(true);
			expect(result.previewSelection).toMatchObject({
				selectedFresh: 100,
				deferredBudget: 150,
				total: 250,
			});
			expect(result.previewItemCount).toBe(250);
			expect(result.details).toHaveLength(200);
			expect(
				result.details.slice(0, 100).every((detail) => detail.previewDisposition === "selected"),
			).toBe(true);
			expect(result.details[199]).toMatchObject({ previewDisposition: "deferred" });
		}
		expect(deps.prisma.libraryCleanupLog.create).not.toHaveBeenCalled();
	});

	it("caps outage details without presenting unknown retry counts as complete", async () => {
		const { deps } = makeDeps({ mediaPartCount: 1 });
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig(100) as never,
		);
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockRejectedValue(
			new Error("retry store unavailable"),
		);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue(
			Array.from({ length: 250 }, (_, index) =>
				matchingDryRunCacheItem({
					id: `cache-${String(index + 1).padStart(3, "0")}`,
					arrItemId: index + 1,
					title: `Movie ${index + 1}`,
				}),
			) as never,
		);

		const result = await executeCleanupPreview(deps, "user-1");

		expect(result).toMatchObject({
			pendingRetryCount: null,
			selectionCountsComplete: false,
			previewItemCount: 250,
			previewSelection: {
				selectedFresh: 0,
				selectedRetries: 0,
				retryStateUnavailable: 250,
				retryState: "unavailable",
				total: 250,
			},
			itemsFlagged: 250,
			itemsSkipped: 250,
		});
		expect(result.details).toHaveLength(200);
		expect(result.details.every((detail) => detail.previewDisposition === "deferred")).toBe(true);
	});

	it("canonicalizes Sonarr episode inventory order by stable identity", () => {
		const first = { id: 301, seasonNumber: 2, episodeNumber: 1, episodeFileId: 901 };
		const second = { id: 201, seasonNumber: 1, episodeNumber: 2, episodeFileId: 801 };
		const third = { id: 101, seasonNumber: 1, episodeNumber: 1, episodeFileId: 701 };

		expect(
			sortSonarrEpisodesByIdentity([first, second, third]).map((episode) => episode.id),
		).toEqual([101, 201, 301]);
		expect(
			sortSonarrEpisodesByIdentity([third, first, second]).map((episode) => episode.id),
		).toEqual([101, 201, 301]);
	});

	it("deduplicates file-changing episode work by physical file before budgeting and retries", () => {
		const fileTarget = (arrEpisodeId: number, episodeFileId: number, action = "delete") => ({
			instanceId: "sonarr-1",
			arrItemId: 42,
			itemType: "series",
			targetScope: "episode",
			arrEpisodeId,
			episodeFileId,
			action,
		});
		const firstFileKey = cleanupDeleteTargetKey(fileTarget(101, 7001));
		const sameFileKey = cleanupDeleteTargetKey(fileTarget(102, 7001, "delete_files"));
		const secondFileKey = cleanupDeleteTargetKey(fileTarget(103, 7002));
		const durableRetryKey = cleanupApprovalTargetKey({
			...approvalRecord(),
			instanceId: "sonarr-1",
			arrItemId: 42,
			itemType: "series",
			targetScope: "episode",
			arrEpisodeId: 102,
			episodeFileId: 7001,
			action: "delete_files",
			safetySnapshot: null,
		} as never);

		expect(sameFileKey).toBe(firstFileKey);
		expect(durableRetryKey).toBe(firstFileKey);
		expect(cleanupDeleteTargetKey(fileTarget(101, 7001, "unmonitor"))).not.toBe(
			cleanupDeleteTargetKey(fileTarget(102, 7001, "unmonitor")),
		);
		expect(() => cleanupDeleteTargetKey(fileTarget(101, Number.NaN))).toThrow("episode file ID");

		const freshPlan = planCleanupSelection({
			mode: "direct",
			limit: 2,
			fresh: [
				{ key: firstFileKey, value: "episode-101" },
				{ key: sameFileKey, value: "episode-102" },
				{ key: secondFileKey, value: "episode-103" },
			],
			pendingRetries: [],
			inFlightRetries: [],
			retryStateLoaded: true,
		});
		expect(freshPlan.selectedFresh.map((candidate) => candidate.value)).toEqual([
			"episode-101",
			"episode-103",
		]);
		expect(freshPlan.counts).toMatchObject({
			selectedFresh: 2,
			deferredDuplicateTarget: 1,
			deferredBudget: 0,
		});

		const retryPlan = planCleanupSelection({
			mode: "direct",
			limit: 1,
			fresh: [
				{ key: firstFileKey, value: "episode-101" },
				{ key: sameFileKey, value: "episode-102" },
				{ key: secondFileKey, value: "episode-103" },
			],
			pendingRetries: [
				{
					id: "retry-file-7001",
					key: firstFileKey,
					value: "retry-file-7001",
					reviewedAt: null,
					createdAt: new Date("2026-08-01T00:00:00.000Z"),
				},
			],
			inFlightRetries: [],
			retryStateLoaded: true,
		});
		expect(retryPlan.selectedRetries).toHaveLength(1);
		expect(retryPlan.selectedFresh).toHaveLength(0);
		expect(retryPlan.counts).toMatchObject({
			deferredDuplicateTarget: 2,
			deferredBudget: 1,
		});
	});

	it("loads Radarr notifications once per instance across multiple safety targets", async () => {
		const { deps, targetClient } = makeDeps({ mediaPartCount: 1 });
		const context = createSharedPlexSafetyContext();

		await findSharedPlexDeleteBlocks(
			deps,
			"user-1",
			[target, { ...target, arrItemId: 102 }],
			context,
		);

		expect(targetClient.notification.getAll).toHaveBeenCalledOnce();
		expect(targetClient.movie.getById).toHaveBeenCalledTimes(2);
	});

	it("refetches Radarr notifications across separate safety checks", async () => {
		const { deps, targetClient } = makeDeps({ mediaPartCount: 1 });
		const context = createSharedPlexSafetyContext();
		targetClient.notification.getAll.mockResolvedValueOnce([]).mockResolvedValue([
			{
				implementation: "MediaBrowser",
				configContract: "MediaBrowserSettings",
				onMovieDelete: true,
				onMovieFileDelete: true,
				tags: [],
				fields: [{ name: "updateLibrary", value: true }],
			},
		]);

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [target], context)).toEqual(new Map());
		const changedBlocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target], context);

		expect(changedBlocks.get(cleanupDeleteTargetKey(target))).toContain("Emby/Jellyfin");
		expect(targetClient.notification.getAll).toHaveBeenCalledTimes(2);
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
		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target], context);

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
			approvalRecord({ safetySnapshot: radarrSafetySnapshot(undefined, []) }) as never,
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

	it("blocks the Radarr record delete when an excluding tag appears after file deletion", async () => {
		let applyRace = () => {};
		const fixture = makeDeps({
			includePlexNotification: false,
			afterMovieFileDelete: () => applyRace(),
		});
		applyRace = () => fixture.setLiveMovieTags([99]);
		(
			fixture.deps as CleanupExecutorDeps & {
				__setTestMutationRules?: (rules: ReturnType<typeof currentSeriesRule>[]) => void;
			}
		).__setTestMutationRules?.([
			{
				...currentSeriesRule(),
				excludeTags: JSON.stringify([99]) as never,
			},
		]);
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({ safetySnapshot: radarrSafetySnapshot(undefined, []) }) as never,
		]);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
		expect(result).toMatchObject({ removed: 0, failed: 1 });
	});

	it("refreshes list evidence and blocks the Radarr record delete when membership flips", async () => {
		let listContainsMovie = true;
		const fixture = makeDeps({
			includePlexNotification: false,
			afterMovieFileDelete: () => {
				listContainsMovie = false;
			},
		});
		(
			fixture.deps as CleanupExecutorDeps & {
				__setTestMutationRules?: (rules: ReturnType<typeof currentSeriesRule>[]) => void;
			}
		).__setTestMutationRules?.([
			{
				...currentSeriesRule(),
				ruleType: "tmdb_list_member",
				parameters: JSON.stringify({ listId: "42", operator: "is_in" }),
			},
		]);
		Object.assign(fixture.deps.prisma, {
			user: {
				findUnique: vi.fn().mockResolvedValue({
					encryptedTmdbApiKey: "encrypted",
					tmdbEncryptionIv: "iv",
					encryptedTraktAccessToken: null,
					traktTokenIv: null,
				}),
			},
		});
		fixture.deps.encryptor = { decrypt: vi.fn().mockReturnValue("decrypted") } as never;
		fixture.deps.tmdbListClientFactory = vi.fn().mockReturnValue({
			getListItems: vi.fn(async () =>
				listContainsMovie ? [{ tmdbId: 42, mediaType: "movie", title: "Example Movie" }] : [],
			),
		});
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({ safetySnapshot: radarrSafetySnapshot(undefined, []) }) as never,
		]);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
		expect(result).toMatchObject({ removed: 0, failed: 1 });
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

	it("rechecks Plex owner authority across separate safety checks", async () => {
		const { deps, getAccounts } = makeDeps({ mediaPartCount: 1 });
		getAccounts
			.mockResolvedValueOnce([{ id: 1, name: "Owner" }])
			.mockRejectedValueOnce(new Error("owner authority revoked"));
		const context = createSharedPlexSafetyContext();

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [target], context)).toEqual(new Map());
		const changedBlocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target], context);

		expect(changedBlocks.get(cleanupDeleteTargetKey(target))).toContain(
			"could not verify the live Radarr and Plex",
		);
		expect(getAccounts).toHaveBeenCalledTimes(2);
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
								baseUrl: "http://radarr.internal:7878",
								encryptedApiKey: "encrypted-radarr-key",
								encryptionIv: "radarr-iv",
								encryptedHttpAuthCredentials: null,
								httpAuthEncryptionIv: null,
								enabled: true,
								updatedAt: new Date("2026-07-27T12:00:00.000Z"),
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
					baseUrl: "http://radarr.internal:7878",
					encryptedApiKey: "encrypted-radarr-key",
					encryptionIv: "radarr-iv",
					encryptedHttpAuthCredentials: null,
					httpAuthEncryptionIv: null,
					enabled: true,
					updatedAt: new Date("2026-07-27T12:00:00.000Z"),
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

		expect(await findSharedPlexDeleteBlocks(deps, "user-1", [target], context)).toEqual(new Map());
		expect(
			await findSharedPlexDeleteBlocks(deps, "user-1", [{ ...target, arrItemId: 102 }], context),
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
			onMovieDelete: true,
			onMovieFileDelete: false,
		});

		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain("movie-file-delete");
		expect(getMovieMediaPartsByTmdbId).not.toHaveBeenCalled();
	});

	it("blocks a fileless movie when full deletion still triggers a Plex refresh", async () => {
		const { deps, getMovieMediaPartsByTmdbId } = makeDeps({
			initialMovieFileId: null,
			onMovieDelete: true,
			onMovieFileDelete: true,
		});

		const blocks = await findSharedPlexDeleteBlocks(deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"fileless Radarr movie still triggers a Plex refresh",
		);
		expect(getMovieMediaPartsByTmdbId).not.toHaveBeenCalled();
	});

	it("binds non-destructive actions to the live ARR target without inspecting Plex", async () => {
		const { deps, plexClientFactory } = makeDeps();
		const context = createSharedPlexSafetyContext();
		const blocks = await findSharedPlexDeleteBlocks(
			deps,
			"user-1",
			[{ ...target, action: "unmonitor" }],
			context,
		);

		expect(blocks).toEqual(new Map());
		expect(context.plans.get(cleanupDeleteTargetKey(target))).toEqual({
			kind: "verified_arr_target",
			target: radarrTargetIdentity,
		});
		expect(deps.prisma.serviceInstance.findMany).toHaveBeenCalled();
		expect(plexClientFactory).not.toHaveBeenCalled();
	});

	it("does not unmonitor a replacement movie that appears after live target verification", async () => {
		const { deps, targetClient } = makeDeps({ action: "unmonitor" });
		const liveMovie = await targetClient.movie.getById(101);
		targetClient.movie.getById.mockResolvedValueOnce(liveMovie).mockResolvedValueOnce({
			...liveMovie,
			tmdbId: 99,
			path: "/movies-4k/Different Movie (2024)",
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
				ruleName: "Unmonitor watched movies",
				reason: "Matched watched rule",
				action: "unmonitor",
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(result.details[0]?.reason).toContain("ARR target changed");
		expect(targetClient.movie.update).not.toHaveBeenCalled();
	});

	it("persists a durable intent before a direct unmonitor mutation", async () => {
		const { deps, targetClient } = makeDeps({ action: "unmonitor" });
		const intents = configureRetryStore(deps);
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
				ruleName: "Unmonitor watched movies",
				reason: "Matched watched rule",
				action: "unmonitor",
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(result).toMatchObject({ itemsUnmonitored: 1 });
		expect(intents).toHaveLength(1);
		expect(intents[0]).toMatchObject({ action: "unmonitor", status: "executed" });
		expect(
			vi.mocked(deps.prisma.libraryCleanupApproval.create).mock.invocationCallOrder[0],
		).toBeLessThan(targetClient.movie.update.mock.invocationCallOrder[0]!);
	});

	it("reconciles a queued Radarr unmonitor when the successful PUT response is lost", async () => {
		const fixture = makeDeps({ action: "unmonitor" });
		fixture.setLiveMovieMonitored(true);
		const storedApproval = approvalRecord({
			action: "unmonitor",
			safetySnapshot: radarrTargetOnlySnapshot(),
		});
		configureApprovalStore(fixture.deps, storedApproval);
		setRadarrMutationRules(fixture.deps, [monitoredUnmonitorRule()]);
		fixture.targetClient.movie.update.mockImplementationOnce(async () => {
			fixture.setLiveMovieMonitored(false);
			throw new Error("response lost");
		});

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ failed: 0 });
		expect(fixture.targetClient.movie.update).toHaveBeenCalledOnce();
		expect(fixture.deps.prisma.libraryCache.updateMany).toHaveBeenCalledWith({
			where: { instanceId: "radarr-4k", arrItemId: 101, itemType: "movie" },
			data: { monitored: false },
		});
		expect(storedApproval).toMatchObject({ status: "executed", executionToken: null });
	});

	it("reconciles a direct Radarr unmonitor intent when the successful PUT response is lost", async () => {
		const fixture = makeDeps({ action: "unmonitor" });
		fixture.setLiveMovieMonitored(true);
		const intents = configureRetryStore(fixture.deps);
		setRadarrMutationRules(fixture.deps, [monitoredUnmonitorRule()]);
		fixture.targetClient.movie.update.mockImplementationOnce(async () => {
			fixture.setLiveMovieMonitored(false);
			throw new Error("response lost");
		});

		const result = await executeDirectRemoval(
			fixture.deps,
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
			"user-1",
			[radarrUnmonitorFlaggedItem()],
			1,
			1,
			Date.now(),
		);

		expect(result).toMatchObject({ itemsUnmonitored: 1, itemsSkipped: 0 });
		expect(intents[0]).toMatchObject({ action: "unmonitor", status: "executed" });
		expect(fixture.targetClient.movie.update).toHaveBeenCalledOnce();
	});

	it("reconciles an interrupted Radarr unmonitor only for the unchanged verified target", async () => {
		const fixture = makeDeps({ action: "unmonitor" });
		fixture.setLiveMovieMonitored(false);
		const storedRetry = approvalRecord({
			action: "unmonitor",
			safetySnapshot: radarrTargetOnlySnapshot(),
			status: "retry_pending",
			lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
		});
		configureApprovalStore(fixture.deps, storedRetry);
		setRadarrMutationRules(fixture.deps, [monitoredUnmonitorRule()]);

		const result = await executeRetryItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 0, reconciled: 1, failed: 0, errors: [] });
		expect(fixture.targetClient.movie.update).not.toHaveBeenCalled();
		expect(fixture.deps.prisma.libraryCache.updateMany).toHaveBeenCalledWith({
			where: { instanceId: "radarr-4k", arrItemId: 101, itemType: "movie" },
			data: { monitored: false },
		});
		expect(fixture.deps.prisma.libraryCache.deleteMany).not.toHaveBeenCalled();
		expect(storedRetry).toMatchObject({ status: "executed", executionToken: null });
	});

	it("does not reconcile a lost Radarr unmonitor response against a replacement movie", async () => {
		const fixture = makeDeps({ action: "unmonitor" });
		fixture.setLiveMovieMonitored(true);
		const storedApproval = approvalRecord({
			action: "unmonitor",
			safetySnapshot: radarrTargetOnlySnapshot(),
		});
		configureApprovalStore(fixture.deps, storedApproval);
		setRadarrMutationRules(fixture.deps, [monitoredUnmonitorRule()]);
		fixture.targetClient.movie.update.mockImplementationOnce(async () => {
			fixture.setLiveMovieMonitored(false);
			fixture.setLiveMovieIdentity(999, "/movies-4k/Replacement Movie (2024)");
			throw new Error("response lost");
		});

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("ARR target changed");
		expect(fixture.deps.prisma.libraryCache.updateMany).not.toHaveBeenCalled();
	});

	it("expires an approved unmonitor when its ARR service is repointed", async () => {
		const { deps, targetInstance, targetClient, setLiveMovieExists } = makeDeps({
			action: "unmonitor",
		});
		setLiveMovieExists(false);
		targetInstance.baseUrl = "http://different-radarr.internal:7878";
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({
				action: "unmonitor",
				safetySnapshot: radarrTargetOnlySnapshot(),
			}) as never,
		]);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("ARR target identity changed");
		expect(targetClient.movie.getById).not.toHaveBeenCalled();
		expect(targetClient.movie.update).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCleanupApproval.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ id: "approval-1", status: "executing" }),
			data: expect.objectContaining({ status: "expired" }),
		});
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
				safetySnapshot: radarrSafetySnapshot(),
			} as never,
		]);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("Plex has multiple files merged");
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCleanupApproval.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ id: "approval-1", status: "executing" }),
			data: expect.objectContaining({
				status: "pending",
				lastExecutionError: expect.stringContaining("Plex has multiple files merged"),
			}),
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
		expect(deps.prisma.libraryCleanupApproval.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ id: "approval-1", status: "executing" }),
			data: expect.objectContaining({
				status: "pending",
				lastExecutionError: expect.stringContaining("stored action or media type is invalid"),
			}),
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
		};

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
			"user-1",
			[flaggedItem] as never,
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
		};

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
			"user-1",
			[flaggedItem] as never,
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
				matchedRuleId: "rule-1",
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
				matchedRuleId: "rule-1",
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
		expect(deps.prisma.libraryCleanupApproval.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ id: "approval-1", status: "executing" }),
			data: expect.objectContaining({
				status: "expired",
				reviewedAt: expect.any(Date),
				lastExecutionError: expect.stringContaining("file identity changed"),
			}),
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
				matchedRuleId: "rule-1",
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
				matchedRuleId: "rule-1",
				title: "Example Movie",
				safetySnapshot: radarrSafetySnapshot(),
			} as never,
		]);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("replacement file appeared");
		expect(deleteMovie).not.toHaveBeenCalled();
		const pendingUpdate = vi
			.mocked(deps.prisma.libraryCleanupApproval.updateMany)
			.mock.calls.slice()
			.reverse()
			.find((call) => call[0].data.status === "pending")?.[0];
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
				matchedRuleId: "rule-1",
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
				matchedRuleId: "rule-1",
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
		};

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
			"user-1",
			[flaggedItem] as never,
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
		};

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
			"user-1",
			[flaggedItem] as never,
			1,
			1,
			Date.now(),
		);

		expect(result.details[0]?.reason).toContain("differs from the cached item");
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
	});

	it("does not use cache rows that predate a service configuration change", async () => {
		const { deps, targetInstance, deleteMovie, deleteMovieFile } = makeDeps({
			mediaPartCount: 1,
		});
		targetInstance.updatedAt = new Date("2026-07-27T12:10:00.000Z");
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
				reason: "Matched stale cache",
				action: "delete",
			},
			rating: 8,
		};

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
			"user-1",
			[flaggedItem] as never,
			1,
			1,
			Date.now(),
		);

		expect(result.details[0]?.reason).toContain("differs from the cached item");
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
	});

	it("expires a direct mutation when Radarr is repointed after live preflight", async () => {
		const { deps, targetInstance, plexInstance, deleteMovie, deleteMovieFile } = makeDeps({
			mediaPartCount: 1,
		});
		const retries = configureRetryStore(deps);
		const repointedInstance = {
			...targetInstance,
			baseUrl: "http://replacement-radarr.internal:7878",
			updatedAt: new Date("2026-07-27T13:00:00.000Z"),
		};
		let arrInstanceReads = 0;
		vi.mocked(deps.prisma.serviceInstance.findMany).mockImplementation((args) => {
			if (args?.where?.service === "PLEX") return Promise.resolve([plexInstance]) as never;
			if (typeof args?.where?.service === "object" && "in" in args.where.service) {
				return Promise.resolve([
					++arrInstanceReads === 1 ? targetInstance : repointedInstance,
				]) as never;
			}
			return Promise.resolve([
				{ id: targetInstance.id, updatedAt: targetInstance.updatedAt },
			]) as never;
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
		};

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
			"user-1",
			[flaggedItem] as never,
			1,
			1,
			Date.now(),
		);

		expect(result.details[0]?.reason).toContain("ARR target changed during live verification");
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(retries).toHaveLength(1);
		expect(retries[0]).toMatchObject({ status: "expired", executionToken: null });
	});

	it("does not trust cache data sourced from a different ARR service fingerprint", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const cachedData = JSON.parse(radarrCachedFileIdentity.data) as Record<string, unknown>;
		cachedData._arrDashboardSource = {
			serviceFingerprint: "a".repeat(64),
		};
		const flaggedItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				year: 2024,
				...radarrCachedFileIdentity,
				data: JSON.stringify(cachedData),
				sizeOnDisk: 2_000n,
			},
			match: {
				ruleId: "rule-1",
				ruleName: "4K cleanup",
				reason: "Matched stale service cache",
				action: "delete",
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
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

	it("does not borrow the live external media identity for cached rule evaluation", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const flaggedItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Different Cached Movie",
				year: 2024,
				...radarrCachedFileIdentity,
				data: JSON.stringify({
					_arrDashboardSource: {
						serviceFingerprint: radarrTargetIdentity.serviceFingerprint,
					},
					remoteIds: { tmdbId: 99 },
					path: "/movies-4k/Example Movie (2024)",
					movieFile: {
						id: 1001,
						path: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
						size: 2_000,
					},
				}),
				sizeOnDisk: 2_000n,
			},
			match: {
				ruleId: "rule-1",
				ruleName: "4K cleanup",
				reason: "Matched different cached identity",
				action: "delete",
			},
			rating: 8,
		};

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
			"user-1",
			[flaggedItem] as never,
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
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
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
		const auditCreate = vi.fn().mockResolvedValue({});
		Object.assign(deps.prisma, {
			libraryCleanupAuditEvent: {
				create: auditCreate,
				findMany: vi.fn().mockResolvedValue([]),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
		});
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
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
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
		const auditEvents = auditCreate.mock.calls.map(([call]) => call.data);
		expect(auditEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "candidate_selected",
					reason: "Matched 4K profile",
				}),
			]),
		);
		expect(
			auditEvents
				.filter((event) => event.eventType === "mutation_prepared")
				.map((event) => JSON.parse(event.evidence).step),
		).toEqual([
			"radarr_movie_file_delete",
			"radarr_movie_record_delete",
			"radarr_movie_record_delete",
		]);
		expect(auditEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "retry_pending",
					outcome: "failed",
					evidence: expect.stringContaining('"mutationAttempted":true'),
				}),
			]),
		);
	});

	it("does not audit terminal success when direct ARR success cannot finalize durable intent", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		configureRetryStore(deps);
		const updateMany = vi.mocked(deps.prisma.libraryCleanupApproval.updateMany);
		const updateStore = updateMany.getMockImplementation();
		if (!updateStore) throw new Error("Expected a durable intent store");
		updateMany.mockImplementation((async (args: { data: { status?: string } }) => {
			if (args.data.status === "executed") throw new Error("durable finalization unavailable");
			return await updateStore(args as never);
		}) as never);
		const auditCreate = vi.fn().mockResolvedValue({});
		Object.assign(deps.prisma, {
			libraryCleanupAuditEvent: {
				create: auditCreate,
				findMany: vi.fn().mockResolvedValue([]),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
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
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledOnce();
		expect(result.details).toEqual([
			expect.objectContaining({
				action: "removed",
				mutationAttempted: true,
				durableStateRecordingFailed: true,
			}),
		]);
		const auditEvents = auditCreate.mock.calls.map(([call]) => call.data);
		expect(auditEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ eventType: "execution_incomplete", outcome: "failed" }),
			]),
		);
		expect(auditEvents.some((event) => event.eventType === "terminal_succeeded")).toBe(false);
	});

	it("does not delete verified files before a direct mutation intent is durable", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		deleteMovie.mockRejectedValue(new Error("Radarr movie delete unavailable"));
		vi.mocked(deps.prisma.libraryCleanupApproval.create).mockRejectedValue(
			new Error("database unavailable"),
		);
		const flaggedItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				year: 2024,
				...radarrCachedFileIdentity,
				sizeOnDisk: 2000n,
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
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCache.updateMany).not.toHaveBeenCalled();
		expect(result).toMatchObject({ status: "partial", itemsFilesDeleted: 0, itemsSkipped: 1 });
		expect(result.warnings).toContainEqual(expect.stringContaining("not persisted"));
	});

	it("does not reset a concurrently claimed direct retry to pending", async () => {
		const { deps, deleteMovie } = makeDeps({ mediaPartCount: 1 });
		deleteMovie.mockRejectedValue(new Error("Radarr movie delete unavailable"));
		let concurrentRetry: Record<string, unknown> | undefined;
		vi.mocked(deps.prisma.libraryCleanupApproval.create).mockImplementation((async ({
			data,
		}: {
			data: Record<string, unknown>;
		}) => {
			concurrentRetry = { ...data, status: "retry_executing" };
			const error = new Error("retry already exists") as Error & { code: string };
			error.code = "P2002";
			throw error;
		}) as never);
		vi.mocked(deps.prisma.libraryCleanupApproval.updateMany).mockResolvedValue({ count: 0 });
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
				reason: "Matched 4K profile",
				action: "delete",
			},
			rating: 8,
		} as never;

		await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(concurrentRetry).toMatchObject({ status: "retry_executing" });
		expect(deps.prisma.libraryCleanupApproval.updateMany).toHaveBeenCalledOnce();
		expect(deleteMovie).not.toHaveBeenCalled();
	});

	it("reports a fresh match deferred behind an in-flight direct retry", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const retries = configureRetryStore(deps);
		deleteMovie
			.mockRejectedValueOnce(new Error("Radarr movie delete unavailable"))
			.mockRejectedValueOnce(new Error("Radarr movie delete unavailable"));
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
				reason: "Matched 4K profile",
				action: "delete",
			},
			rating: 8,
		} as never;
		const config = { id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never;

		await executeDirectRemoval(deps, config, "user-1", [flaggedItem], 1, 1, Date.now());
		retries[0]!.status = "retry_executing";

		const deferredResult = await executeDirectRemoval(
			deps,
			config,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(deferredResult).toMatchObject({
			status: "partial",
			itemsFlagged: 1,
			itemsSkipped: 2,
			details: [
				expect.objectContaining({ reason: expect.stringContaining("already executing") }),
				expect.objectContaining({
					reason: expect.stringContaining("already owns this cleanup target"),
				}),
			],
		});
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledTimes(2);
	});

	it("does not select a pending retry when an in-flight record owns the same target", async () => {
		const { deps, targetClient, deleteMovie, deleteMovieFile } = makeDeps({
			mediaPartCount: 1,
		});
		const retries = configureRetryStore(deps);
		retries.push(
			{
				...approvalRecord({ id: "retry-executing" }),
				configId: "config-1",
				status: "retry_executing",
				executionToken: "other-run",
				matchedRuleId: "rule-1",
				matchedRuleName: "Cleanup",
				sizeOnDisk: 2_000n,
				year: 2024,
				createdAt: new Date("2026-07-27T12:00:00.000Z"),
			},
			{
				...approvalRecord({ id: "retry-pending" }),
				configId: "config-1",
				status: "retry_pending",
				executionToken: null,
				matchedRuleId: "rule-1",
				matchedRuleName: "Cleanup",
				sizeOnDisk: 2_000n,
				year: 2024,
				createdAt: new Date("2026-07-27T12:01:00.000Z"),
			},
		);

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 2, rules: [] } as never,
			"user-1",
			[],
			0,
			0,
			Date.now(),
		);

		expect(retries).toEqual([
			expect.objectContaining({ id: "retry-executing", status: "retry_executing" }),
			expect.objectContaining({ id: "retry-pending", status: "retry_pending" }),
		]);
		expect(result).toMatchObject({
			status: "partial",
			itemsFlagged: 0,
			itemsSkipped: 2,
		});
		expect(result.details).toEqual([
			expect.objectContaining({
				reason: expect.stringContaining("already executing"),
			}),
			expect.objectContaining({
				reason: expect.stringContaining("already executing"),
			}),
		]);
		expect(result.warnings).toContainEqual(
			expect.stringContaining("in-flight retry already owns the same target"),
		);
		expect(targetClient.movie.getById).not.toHaveBeenCalled();
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
	});

	it("reports a retry claim lost to another run as concurrently deferred", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const retries = configureRetryStore(deps);
		deleteMovie
			.mockRejectedValueOnce(new Error("Radarr movie delete unavailable"))
			.mockRejectedValueOnce(new Error("Radarr movie delete unavailable"));
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
				reason: "Matched 4K profile",
				action: "delete",
			},
			rating: 8,
		} as never;
		const config = { id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never;

		await executeDirectRemoval(deps, config, "user-1", [flaggedItem], 1, 1, Date.now());
		vi.mocked(deps.prisma.libraryCleanupApproval.updateMany).mockImplementation((async () => {
			retries[0]!.status = "retry_executing";
			return { count: 0 };
		}) as never);

		const deferredResult = await executeDirectRemoval(
			deps,
			config,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(deferredResult).toMatchObject({
			status: "partial",
			itemsFlagged: 1,
			itemsSkipped: 2,
			details: [
				expect.objectContaining({ reason: expect.stringContaining("another cleanup run claimed") }),
				expect.objectContaining({
					reason: expect.stringContaining("already owns this cleanup target"),
				}),
			],
		});
		expect(deferredResult.warnings).toContainEqual(
			expect.stringContaining("another cleanup run claimed it first"),
		);
		expect(deferredResult.warnings).not.toContainEqual(expect.stringContaining("remains pending"));
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledTimes(2);
	});

	it("does not backfill fresh work when a selected retry is safety-blocked", async () => {
		const { deps, targetClient, deleteMovie, deleteMovieFile } = makeDeps();
		const retries = configureRetryStore(deps);
		retries.push({
			...approvalRecord(),
			configId: "config-1",
			status: "retry_pending",
			executionToken: null,
			matchedRuleId: "rule-1",
			matchedRuleName: "Prior delete",
			sizeOnDisk: 2_000n,
			year: 2024,
			createdAt: new Date("2026-07-27T12:00:00.000Z"),
		});
		const freshItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 102,
				itemType: "movie",
				title: "Fresh Movie",
				year: 2024,
				monitored: true,
				...radarrCachedFileIdentity,
				sizeOnDisk: 2_000n,
			},
			match: {
				ruleId: "rule-2",
				ruleName: "Fresh unmonitor",
				reason: "Matched fresh rule",
				action: "unmonitor",
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 1, rules: [] } as never,
			"user-1",
			[freshItem],
			1,
			1,
			Date.now(),
		);

		expect(retries[0]).toMatchObject({ status: "retry_pending" });
		expect(deps.prisma.libraryCleanupApproval.findMany).toHaveBeenCalledWith({
			where: {
				configId: "config-1",
				config: { userId: "user-1" },
				status: "retry_pending",
			},
			orderBy: [
				{ reviewedAt: { sort: "asc", nulls: "first" } },
				{ createdAt: "asc" },
				{ id: "asc" },
			],
		});
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(targetClient.movie.update).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: "partial",
			itemsFlagged: 1,
			itemsUnmonitored: 0,
			itemsSkipped: 2,
		});
		expect(result.warnings).toContainEqual(expect.stringContaining("retry remains"));
	});

	it("does not fill a selected retry slot after that retry fails closed", async () => {
		const { deps, targetClient, deleteMovie, deleteMovieFile } = makeDeps();
		const config = {
			...dryRunConfig(1),
			dryRunMode: false,
			rules: [{ ...dryRunConfig(1).rules[0]!, action: "unmonitor" }],
		};
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(config as never);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem({
				id: "cache-retry-target",
				arrItemId: 101,
				title: "Retry target",
			}),
			matchingDryRunCacheItem({
				id: "cache-fresh-target",
				arrItemId: 102,
				title: "Fresh target",
			}),
		] as never);
		const retries = configureRetryStore(deps);
		retries.push({
			...approvalRecord(),
			configId: "config-1",
			status: "retry_pending",
			executionToken: null,
			matchedRuleId: "rule-previous",
			matchedRuleName: "Prior delete",
			sizeOnDisk: 2_000n,
			year: 2024,
			createdAt: new Date("2026-07-27T12:00:00.000Z"),
		});

		const result = await executeCleanupRun(deps, "user-1");

		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(targetClient.movie.update).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: "partial",
			itemsFlagged: 2,
			itemsUnmonitored: 0,
		});
		expect(result.warnings).toContainEqual(expect.stringContaining("retry remains"));
	});

	it("does not execute a fresh duplicate of a pending retry outside the run limit", async () => {
		const { deps, targetClient, deleteMovie, deleteMovieFile } = makeDeps();
		const retries = configureRetryStore(deps);
		retries.push(
			{
				...approvalRecord(),
				configId: "config-1",
				status: "retry_pending",
				executionToken: null,
				matchedRuleId: "rule-1",
				matchedRuleName: "Selected retry",
				sizeOnDisk: 2_000n,
				year: 2024,
				createdAt: new Date("2026-07-27T12:00:00.000Z"),
			},
			{
				...approvalRecord({
					id: "approval-2",
					arrItemId: 102,
					title: "Older pending target",
				}),
				configId: "config-1",
				status: "retry_pending",
				executionToken: null,
				matchedRuleId: "rule-2",
				matchedRuleName: "Unselected retry",
				sizeOnDisk: 2_000n,
				year: 2024,
				createdAt: new Date("2026-07-27T12:01:00.000Z"),
			},
		);
		const pendingTarget = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 102,
				itemType: "movie",
				title: "Older pending target",
				year: 2024,
				monitored: true,
				...radarrCachedFileIdentity,
				sizeOnDisk: 2_000n,
			},
			match: {
				ruleId: "rule-2",
				ruleName: "Fresh unmonitor",
				reason: "Matched fresh rule",
				action: "unmonitor",
			},
			rating: 8,
		};
		const distinctFreshTarget = {
			...pendingTarget,
			cacheItem: {
				...pendingTarget.cacheItem,
				arrItemId: 103,
				title: "Distinct fresh target",
			},
		};

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 1, rules: [] } as never,
			"user-1",
			[pendingTarget, distinctFreshTarget] as never,
			2,
			2,
			Date.now(),
		);

		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(targetClient.movie.update).not.toHaveBeenCalled();
		expect(retries[1]).toMatchObject({ id: "approval-2", status: "retry_pending" });
		expect(result).toMatchObject({
			status: "partial",
			itemsUnmonitored: 0,
		});
	});

	it("counts a partially completed retry against the fresh mutation budget", async () => {
		const { deps, targetClient, deleteMovie, deleteMovieFile } = makeDeps({
			mediaPartCount: 1,
		});
		const retries = configureRetryStore(deps);
		retries.push({
			...approvalRecord(),
			configId: "config-1",
			status: "retry_pending",
			executionToken: null,
			matchedRuleId: "rule-1",
			matchedRuleName: "Prior delete",
			sizeOnDisk: 2_000n,
			year: 2024,
			createdAt: new Date("2026-07-27T12:00:00.000Z"),
		});
		deleteMovie.mockRejectedValue(new Error("Radarr movie delete unavailable"));
		const freshItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 102,
				itemType: "movie",
				title: "Fresh Movie",
				year: 2024,
				monitored: true,
				...radarrCachedFileIdentity,
				sizeOnDisk: 2_000n,
			},
			match: {
				ruleId: "rule-2",
				ruleName: "Fresh unmonitor",
				reason: "Matched fresh rule",
				action: "unmonitor",
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 1, rules: [] } as never,
			"user-1",
			[freshItem],
			1,
			1,
			Date.now(),
		);

		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledTimes(2);
		expect(targetClient.movie.update).not.toHaveBeenCalled();
		expect(retries[0]).toMatchObject({
			status: "retry_pending",
			safetySnapshot: radarrSafetySnapshot(null),
		});
		expect(result).toMatchObject({
			status: "partial",
			itemsFlagged: 1,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 1,
			itemsSkipped: 2,
		});
		expect(result.warnings).toContainEqual(expect.stringContaining("retry remains"));
	});

	it("defers a dispatched failed retry for one run so fresh work can make progress safely", async () => {
		const { deps, targetClient, deleteMovie, deleteMovieFile } = makeDeps({
			mediaPartCount: 1,
		});
		const retries = configureRetryStore(deps);
		retries.push({
			...approvalRecord(),
			configId: "config-1",
			status: "retry_pending",
			executionToken: null,
			matchedRuleId: "rule-1",
			matchedRuleName: "Prior delete",
			sizeOnDisk: 2_000n,
			year: 2024,
			createdAt: new Date("2026-07-27T12:00:00.000Z"),
		});
		deleteMovieFile.mockRejectedValue(new Error("Radarr movie-file delete unavailable"));
		const freshItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 102,
				itemType: "movie",
				title: "Fresh Movie",
				year: 2024,
				monitored: true,
				...radarrCachedFileIdentity,
				sizeOnDisk: 2_000n,
			},
			match: {
				ruleId: "rule-2",
				ruleName: "Fresh unmonitor",
				reason: "Matched fresh rule",
				action: "unmonitor",
			},
			rating: 8,
		} as never;

		const firstResult = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 1, rules: [] } as never,
			"user-1",
			[freshItem],
			1,
			1,
			Date.now(),
		);

		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(targetClient.movie.update).not.toHaveBeenCalled();
		expect(firstResult).toMatchObject({
			status: "partial",
			itemsFlagged: 1,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 2,
		});
		expect(firstResult.warnings).toContainEqual(expect.stringContaining("retry remains"));

		const reviewedAt = retries[0]!.reviewedAt as Date;
		vi.mocked(deps.prisma.libraryCleanupLog.findFirst).mockResolvedValue({
			startedAt: new Date(reviewedAt.getTime() - 1),
		} as never);
		const secondResult = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 1, rules: [] } as never,
			"user-1",
			[freshItem],
			1,
			1,
			Date.now(),
		);

		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(targetClient.movie.update).toHaveBeenCalledWith(
			102,
			expect.objectContaining({ monitored: false }),
		);
		expect(retries[0]).toMatchObject({ status: "retry_pending" });
		expect(secondResult).toMatchObject({
			status: "partial",
			itemsFlagged: 1,
			itemsUnmonitored: 1,
			itemsFilesDeleted: 0,
			itemsSkipped: 1,
		});
		expect(secondResult.warnings).toContainEqual(expect.stringContaining("deferred for one run"));
	});

	it("accounts for a durable retry whose post-claim read fails", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const retries = configureRetryStore(deps);
		deleteMovie
			.mockRejectedValueOnce(new Error("Radarr movie delete unavailable"))
			.mockRejectedValueOnce(new Error("Radarr movie delete unavailable"));
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
				reason: "Matched 4K profile",
				action: "delete",
			},
			rating: 8,
		} as never;
		const config = { id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never;

		await executeDirectRemoval(deps, config, "user-1", [flaggedItem], 1, 1, Date.now());
		let executingReads = 0;
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async ({
			where,
		}: {
			where: { status?: string };
		}) => {
			if (where.status === "retry_pending") {
				return retries.filter((retry) => retry.status === "retry_pending");
			}
			if (where.status === "retry_executing") {
				executingReads++;
				if (executingReads === 1) return [];
				throw new Error("database read unavailable");
			}
			return [];
		}) as never);

		const deferredResult = await executeDirectRemoval(
			deps,
			config,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(deferredResult).toMatchObject({
			status: "partial",
			itemsFlagged: 1,
			itemsSkipped: 2,
			details: [
				expect.objectContaining({ reason: expect.stringContaining("after claiming it") }),
				expect.objectContaining({
					reason: expect.stringContaining("already owns this cleanup target"),
				}),
			],
		});
		expect(deferredResult.warnings).toContainEqual(
			expect.stringContaining("post-claim read failure"),
		);
		expect(retries[0]).toMatchObject({ status: "retry_pending" });
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledTimes(2);
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
				matchedRuleId: "rule-1",
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
		expect(deps.prisma.libraryCleanupApproval.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ id: "approval-1", status: "executing" }),
			data: expect.objectContaining({
				status: "pending",
				lastExecutionError: expect.stringContaining("movie record could not be removed"),
				safetySnapshot: radarrSafetySnapshot(null),
			}),
		});
	});

	it("does not rewrite cache state before an approved partial retry is durable", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		deleteMovie.mockRejectedValue(new Error("Radarr movie delete unavailable"));
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord() as never,
		]);
		vi.mocked(deps.prisma.libraryCleanupApproval.updateMany).mockImplementation((async ({
			data,
		}: {
			data: Record<string, unknown>;
		}) => {
			if (data.status === "pending" && data.safetySnapshot) {
				throw new Error("database unavailable");
			}
			return { count: 1 };
		}) as never);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deps.prisma.libraryCache.updateMany).not.toHaveBeenCalled();
	});

	it("retries a verified fileless Radarr approval without deleting files again", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const storedApproval = approvalRecord() as Record<string, unknown>;
		configureApprovalStore(deps, storedApproval);
		deleteMovie
			.mockRejectedValueOnce(new Error("Radarr movie delete unavailable"))
			.mockRejectedValueOnce(new Error("Radarr movie delete unavailable"));

		const firstResult = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(firstResult).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({
			status: "pending",
			safetySnapshot: radarrSafetySnapshot(null),
		});

		storedApproval.status = "approved";
		const retryResult = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(retryResult).toEqual({ removed: 1, failed: 0, errors: [] });
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledTimes(3);
		expect(storedApproval).toMatchObject({
			status: "executed",
			lastExecutionError: null,
		});
	});

	it("reconciles an interrupted approved Radarr mutation from its persisted full snapshot", async () => {
		const { deps, deleteMovie, deleteMovieFile, setLiveMovieFileId } = makeDeps({
			mediaPartCount: 1,
		});
		const storedApproval = approvalRecord() as Record<string, unknown>;
		Object.assign(storedApproval, {
			lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
		});
		const approvalUpdate = configureApprovalStore(deps, storedApproval);
		setLiveMovieFileId(undefined);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 1, failed: 0, errors: [] });
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).toHaveBeenCalledOnce();
		expect(storedApproval).toMatchObject({
			status: "executed",
			safetySnapshot: radarrSafetySnapshot(null),
			lastExecutionError: null,
		});
		expect(
			approvalUpdate.mock.invocationCallOrder[
				approvalUpdate.mock.calls.findIndex((call) => call[0].data.safetySnapshot)
			],
		).toBeLessThan(deleteMovie.mock.invocationCallOrder[0]!);
	});

	it("fails a durable retry closed when cleanup changes to dry-run mode", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const storedRetry = approvalRecord({
			status: "retry_pending",
			executionToken: null,
		}) as Record<string, unknown>;
		configureApprovalStore(deps, storedRetry);
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			enabled: true,
			dryRunMode: true,
			requireApproval: true,
			rules: [currentSeriesRule()],
		} as never);

		const result = await executeRetryItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, reconciled: 0, failed: 1 });
		expect(result.errors[0]).toContain("could not be executed");
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(storedRetry).toMatchObject({ status: "retry_pending", executionToken: null });
	});

	it("records an already-absent durable retry as reconciliation without mutation credit", async () => {
		const { deps, deleteMovie, deleteMovieFile, setLiveMovieExists } = makeDeps({
			mediaPartCount: 1,
		});
		const storedRetry = approvalRecord({
			status: "retry_pending",
			executionToken: null,
			lastExecutionError: "Prior execution outcome is unknown",
		}) as Record<string, unknown>;
		configureApprovalStore(deps, storedRetry);
		setLiveMovieExists(false);

		const result = await executeRetryItems(deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 0, reconciled: 1, failed: 0, errors: [] });
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(storedRetry).toMatchObject({ status: "executed", executionToken: null });
	});

	it("reconciles an already-completed deletion without rediscovering an offline scan target", async () => {
		const { deps, deleteMovie, deleteMovieFile, setLiveMovieExists } = makeDeps({
			mediaPartCount: 1,
		});
		const storedRetry = approvalRecord({
			status: "retry_pending",
			executionToken: null,
			lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
			scanMediaServerAfterDelete: true,
		}) as Record<string, unknown>;
		configureApprovalStore(deps, storedRetry);
		setRadarrMutationRules(deps, [
			{
				...currentSeriesRule("rule-1", "delete", "Example Movie"),
				scanMediaServerAfterDelete: true,
			},
		]);
		setLiveMovieExists(false);
		const scanCreate = vi.fn().mockRejectedValue(new Error("media server offline"));
		Object.assign(deps.prisma, {
			libraryCleanupMediaServerScan: {
				create: scanCreate,
				findMany: vi.fn().mockResolvedValue([]),
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
		});

		const result = await executeRetryItems(deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 0, reconciled: 1, failed: 0, errors: [] });
		expect(scanCreate).not.toHaveBeenCalled();
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(storedRetry).toMatchObject({ status: "executed", executionToken: null });
	});

	it("does not treat a missing target as success for a normal unexecuted approval", async () => {
		const { deps, deleteMovie, setLiveMovieExists } = makeDeps({ mediaPartCount: 1 });
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord() as never,
		]);
		setLiveMovieExists(false);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCleanupApproval.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ id: "approval-1", status: "executing" }),
			data: expect.objectContaining({ status: "pending" }),
		});
	});

	it("reconciles an interrupted delete-files retry when the live file set is already empty", async () => {
		const { deps, deleteMovieFile } = makeDeps({
			action: "delete_files",
			initialMovieFileId: null,
			mediaPartCount: 1,
		});
		const storedRetry = approvalRecord({
			action: "delete_files",
			status: "retry_pending",
			lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
		}) as Record<string, unknown>;
		configureApprovalStore(deps, storedRetry);

		const result = await executeRetryItems(deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 0, reconciled: 1, failed: 0, errors: [] });
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCache.updateMany).toHaveBeenCalledWith({
			where: { instanceId: "radarr-4k", arrItemId: 101, itemType: "movie" },
			data: { hasFile: false, sizeOnDisk: 0 },
		});
		expect(storedRetry).toMatchObject({ status: "executed", executionToken: null });
	});

	it("completes an interrupted delete-files intent when its verified target is already absent", async () => {
		const { deps, deleteMovieFile, setLiveMovieExists } = makeDeps({
			action: "delete_files",
			mediaPartCount: 1,
		});
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({
				action: "delete_files",
				lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
			}) as never,
		]);
		setLiveMovieExists(false);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 0, failed: 0, errors: [] });
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCache.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: "radarr-4k", arrItemId: 101, itemType: "movie" },
		});
	});

	it("expires record-absent reconciliation when Radarr is repointed after the absence check", async () => {
		const { deps, targetInstance, deleteMovieFile, setLiveMovieExists } = makeDeps({
			action: "delete_files",
			mediaPartCount: 1,
		});
		const storedApproval = approvalRecord({
			action: "delete_files",
			lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
		}) as Record<string, unknown>;
		configureApprovalStore(deps, storedApproval);
		setLiveMovieExists(false);
		const repointedInstance = {
			...targetInstance,
			baseUrl: "http://replacement-radarr.internal:7878",
			updatedAt: new Date("2026-07-27T13:00:00.000Z"),
		};
		vi.mocked(deps.prisma.serviceInstance.findMany).mockResolvedValue([repointedInstance] as never);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("ARR target changed during live verification");
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCache.deleteMany).not.toHaveBeenCalled();
		expect(storedApproval).toMatchObject({ status: "expired", executionToken: null });
	});

	it("completes an interrupted unmonitor intent when its verified target is already absent", async () => {
		const { deps, targetClient, setLiveMovieExists } = makeDeps({
			action: "unmonitor",
			mediaPartCount: 1,
		});
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord({
				action: "unmonitor",
				safetySnapshot: radarrTargetOnlySnapshot(),
				lastExecutionError: INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
			}) as never,
		]);
		setLiveMovieExists(false);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 0, failed: 0, errors: [] });
		expect(targetClient.movie.update).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCache.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: "radarr-4k", arrItemId: 101, itemType: "movie" },
		});
	});

	it("expires a record-only Radarr retry when the service is repointed", async () => {
		const { deps, targetInstance, deleteMovie, deleteMovieFile } = makeDeps({
			mediaPartCount: 1,
		});
		const storedApproval = approvalRecord() as Record<string, unknown>;
		configureApprovalStore(deps, storedApproval);
		deleteMovie
			.mockRejectedValueOnce(new Error("Radarr movie delete unavailable"))
			.mockRejectedValueOnce(new Error("Radarr movie delete unavailable"));

		await executeApprovedItems(deps, "user-1", ["approval-1"]);
		Object.assign(targetInstance, {
			encryptedHttpAuthCredentials: "different-proxy-credentials",
			httpAuthEncryptionIv: "different-proxy-iv",
		});

		storedApproval.status = "approved";
		const retryResult = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(retryResult).toMatchObject({ removed: 0, failed: 1 });
		expect(retryResult.errors[0]).toContain("ARR target identity changed");
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledTimes(2);
		expect(storedApproval).toMatchObject({ status: "expired" });
	});

	it("expires an approved Radarr mutation when the service is repointed after preflight", async () => {
		const { deps, targetInstance, plexInstance, deleteMovie, deleteMovieFile } = makeDeps({
			mediaPartCount: 1,
		});
		const storedApproval = approvalRecord() as Record<string, unknown>;
		configureApprovalStore(deps, storedApproval);
		const repointedInstance = {
			...targetInstance,
			baseUrl: "http://replacement-radarr.internal:7878",
			updatedAt: new Date("2026-07-27T13:00:00.000Z"),
		};
		let arrInstanceReads = 0;
		vi.mocked(deps.prisma.serviceInstance.findMany).mockImplementation(
			(args) =>
				(args?.where?.service === "PLEX"
					? Promise.resolve([plexInstance])
					: Promise.resolve([
							++arrInstanceReads === 1 ? targetInstance : repointedInstance,
						])) as never,
		);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("ARR target changed during live verification");
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(storedApproval).toMatchObject({ status: "expired", executionToken: null });
	});

	it("expires an approved Radarr mutation when the target is disabled after preflight", async () => {
		const { deps, targetInstance, plexInstance, deleteMovie, deleteMovieFile } = makeDeps({
			mediaPartCount: 1,
		});
		const storedApproval = approvalRecord() as Record<string, unknown>;
		configureApprovalStore(deps, storedApproval);
		const disabledInstance = { ...targetInstance, enabled: false };
		let arrInstanceReads = 0;
		vi.mocked(deps.prisma.serviceInstance.findMany).mockImplementation(
			(args) =>
				(args?.where?.service === "PLEX"
					? Promise.resolve([plexInstance])
					: Promise.resolve([
							++arrInstanceReads === 1 ? targetInstance : disabledInstance,
						])) as never,
		);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("ARR target changed during live verification");
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(storedApproval).toMatchObject({ status: "expired", executionToken: null });
	});

	it("rechecks the run lease immediately before a fresh direct ARR mutation", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const retries = configureRetryStore(deps);
		const assertRunLease = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new CleanupRunLeaseLostError());
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
				ruleName: "Large movie cleanup",
				reason: "Matched size rule",
				action: "delete",
			},
			rating: 8,
		} as never;

		await expect(
			executeDirectRemoval(
				deps,
				{ id: "config-1", maxRemovalsPerRun: 1, rules: [] } as never,
				"user-1",
				[flaggedItem],
				1,
				1,
				Date.now(),
				undefined,
				undefined,
				new Map(),
				assertRunLease,
			),
		).rejects.toBeInstanceOf(CleanupRunLeaseLostError);

		expect(assertRunLease).toHaveBeenCalledTimes(2);
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(retries[0]).toMatchObject({
			status: "retry_pending",
			lastExecutionError: expect.stringContaining("run lease was lost"),
		});
	});

	it.each([0, 101])(
		"fails closed when the persisted direct cleanup cap is invalid (%i)",
		async (maxRemovalsPerRun) => {
			const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
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
					ruleName: "Large movie cleanup",
					reason: "Matched size rule",
					action: "delete",
				},
				rating: 8,
			} as never;

			const result = await executeDirectRemoval(
				deps,
				{ id: "config-1", maxRemovalsPerRun, rules: [] } as never,
				"user-1",
				[flaggedItem],
				1,
				1,
				Date.now(),
			);

			expect(result).toMatchObject({
				itemsFlagged: 1,
				itemsRemoved: 0,
				itemsFilesDeleted: 0,
				itemsSkipped: 1,
			});
			expect(deleteMovieFile).not.toHaveBeenCalled();
			expect(deleteMovie).not.toHaveBeenCalled();
		},
	);

	it("uses a persisted Radarr repoint instead of the instance loaded by the caller", async () => {
		const { deps, targetInstance, plexInstance, deleteMovie, deleteMovieFile } = makeDeps({
			mediaPartCount: 1,
		});
		const storedApproval = approvalRecord() as Record<string, unknown>;
		configureApprovalStore(deps, storedApproval);
		const repointedInstance = {
			...targetInstance,
			baseUrl: "http://replacement-radarr.internal:7878",
			updatedAt: new Date("2026-07-27T13:00:00.000Z"),
		};
		vi.mocked(deps.prisma.serviceInstance.findMany).mockImplementation(
			(args) =>
				(args?.where?.service === "PLEX"
					? Promise.resolve([plexInstance])
					: Promise.resolve([repointedInstance])) as never,
		);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("ARR target or file identity changed");
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(storedApproval).toMatchObject({ status: "expired", executionToken: null });
	});

	it("durably retries a direct record deletion after exact file removal", async () => {
		const { deps, targetClient, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const retries = configureRetryStore(deps);
		deleteMovie
			.mockRejectedValueOnce(new Error("Radarr movie delete unavailable"))
			.mockRejectedValueOnce(new Error("Radarr movie delete unavailable"));
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
				ruleName: "Large movie cleanup",
				reason: "Matched size rule",
				action: "delete",
			},
			rating: 8,
		};
		const freshItem = {
			...flaggedItem,
			cacheItem: {
				...flaggedItem.cacheItem,
				arrItemId: 102,
				title: "Fresh Movie",
			},
			match: {
				...flaggedItem.match,
				action: "unmonitor",
			},
		};
		const config = { id: "config-1", maxRemovalsPerRun: 1, rules: [] } as never;

		const firstResult = await executeDirectRemoval(
			deps,
			config,
			"user-1",
			[flaggedItem] as never,
			1,
			1,
			Date.now(),
		);
		const retryStoreUpdate = vi.mocked(deps.prisma.libraryCleanupApproval.updateMany);
		const retryStoreImplementation = retryStoreUpdate.getMockImplementation()!;
		retryStoreUpdate.mockImplementation((async (args: { data: { status?: string } }) => {
			if (args.data.status === "executed") throw new Error("database unavailable");
			return retryStoreImplementation(args as never);
		}) as never);
		const retryResult = await executeDirectRemoval(
			deps,
			config,
			"user-1",
			[freshItem] as never,
			1,
			1,
			Date.now(),
		);

		expect(firstResult).toMatchObject({
			status: "partial",
			itemsRemoved: 0,
			itemsFilesDeleted: 1,
		});
		expect(
			vi.mocked(deps.prisma.libraryCleanupApproval.create).mock.invocationCallOrder[0],
		).toBeLessThan(deleteMovieFile.mock.invocationCallOrder[0]!);
		expect(
			vi.mocked(deps.prisma.libraryCleanupApproval.updateMany).mock.invocationCallOrder[0],
		).toBeLessThan(deleteMovieFile.mock.invocationCallOrder[0]!);
		expect(retries).toHaveLength(1);
		expect(retries[0]).toMatchObject({
			status: "retry_executing",
			safetySnapshot: radarrSafetySnapshot(null),
		});
		expect(retryResult).toMatchObject({
			status: "partial",
			itemsRemoved: 1,
			itemsFlagged: 1,
			itemsSkipped: 1,
		});
		expect(retryResult.warnings).toContainEqual(
			expect.stringContaining("could not record durable completion state"),
		);
		retryStoreUpdate.mockImplementation(retryStoreImplementation as never);
		retries[0]!.status = "retry_pending";

		const reconciliationResult = await executeDirectRemoval(
			deps,
			config,
			"user-1",
			[],
			0,
			0,
			Date.now(),
		);

		expect(reconciliationResult).toMatchObject({
			status: "completed",
			itemsRemoved: 0,
			itemsFlagged: 0,
			itemsSkipped: 1,
		});
		expect(retries[0]).toMatchObject({ status: "executed" });
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledTimes(3);
		expect(targetClient.movie.update).not.toHaveBeenCalled();
	});

	it("expires a direct retry before reading a missing target from a repointed service", async () => {
		const { deps, targetInstance, deleteMovie, deleteMovieFile, setLiveMovieExists } = makeDeps({
			mediaPartCount: 1,
		});
		const retries = configureRetryStore(deps);
		deleteMovie
			.mockRejectedValueOnce(new Error("Radarr movie delete unavailable"))
			.mockRejectedValueOnce(new Error("Radarr movie delete unavailable"));
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
				ruleName: "Large movie cleanup",
				reason: "Matched size rule",
				action: "delete",
			},
			rating: 8,
		} as never;
		const config = { id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never;

		await executeDirectRemoval(deps, config, "user-1", [flaggedItem], 1, 1, Date.now());
		targetInstance.baseUrl = "http://different-radarr.internal:7878";
		setLiveMovieExists(false);

		const retryResult = await executeDirectRemoval(deps, config, "user-1", [], 0, 0, Date.now());

		expect(retryResult).toMatchObject({ status: "partial", itemsRemoved: 0 });
		expect(retryResult.warnings).toContainEqual(expect.stringContaining("retry expired"));
		expect(retries[0]).toMatchObject({ status: "expired" });
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledTimes(2);
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
				matchedRuleId: "rule-1",
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
		expect(deps.prisma.libraryCleanupApproval.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ id: "approval-1", status: "executing" }),
			data: expect.objectContaining({
				status: "executed",
				executedAt: expect.any(Date),
				lastExecutionError: null,
			}),
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
				matchedRuleId: "rule-1",
				safetySnapshot: radarrSafetySnapshot(),
			} as never,
		]);
		let terminalWriteAttempts = 0;
		vi.mocked(deps.prisma.libraryCleanupApproval.updateMany).mockImplementation((async ({
			data,
		}: {
			data: { status?: string };
		}) => {
			if (data.status === "executed" && terminalWriteAttempts++ === 0) {
				throw new Error("database unavailable");
			}
			return { count: 1 };
		}) as never);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 1, failed: 0, errors: [] });
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledOnce();
		expect(terminalWriteAttempts).toBe(2);
		expect(deps.prisma.libraryCleanupApproval.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ id: "approval-1", status: "executing" }),
			data: expect.objectContaining({
				status: "executed",
				executedAt: expect.any(Date),
				lastExecutionError: null,
			}),
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
			matchedRuleId: "rule-1",
			safetySnapshot: radarrSafetySnapshot(),
			status: "approved",
			executionToken: null,
		} as unknown as Record<string, unknown>;
		configureApprovalStore(deps, approval);
		let releaseFileDelete!: () => void;
		const originalFileDelete = deleteMovieFile.getMockImplementation()!;
		deleteMovieFile.mockImplementationOnce(async (...args) => {
			await new Promise<void>((resolve) => {
				releaseFileDelete = resolve;
			});
			return originalFileDelete(...args);
		});

		const first = executeApprovedItems(deps, "user-1", ["approval-1"]);
		await vi.waitFor(() => expect(approval.status).toBe("executing"));
		const second = executeApprovedItems(deps, "user-1", ["approval-1"]);
		releaseFileDelete();
		const results = await Promise.allSettled([first, second]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(results.find((result) => result.status === "fulfilled")?.value).toMatchObject({
			removed: 1,
		});
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledOnce();
		expect(approval.status).toBe("executed");
	});

	it("releases only approved rows owned by the lease-losing request token", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const approval = approvalRecord({
			status: "approved",
			executionToken: "request-a",
		}) as Record<string, unknown>;
		configureApprovalStore(deps, approval);
		vi.mocked(deps.prisma.libraryCleanupConfig.updateMany).mockResolvedValue({ count: 0 });

		await expect(
			executeApprovedItems(deps, "user-1", ["approval-1"], "request-b"),
		).rejects.toBeInstanceOf(CleanupRunAlreadyInProgressError);
		expect(approval).toMatchObject({
			status: "approved",
			executionToken: "request-a",
		});

		await expect(
			executeApprovedItems(deps, "user-1", ["approval-1"], "request-a"),
		).rejects.toBeInstanceOf(CleanupRunAlreadyInProgressError);
		expect(approval).toMatchObject({
			status: "pending",
			executionToken: null,
			lastExecutionError: "Cleanup execution did not claim this approved item; retry approval.",
		});
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
	});

	it("reports a bulk-selected approval that expired before transition as failed", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const approval = approvalRecord({
			status: "pending",
			executionToken: null,
			expiresAt: new Date("2026-07-27T11:00:00.000Z"),
		}) as Record<string, unknown>;
		configureApprovalStore(deps, approval);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"], "bulk-request");

		expect(result).toEqual({
			removed: 0,
			failed: 1,
			errors: [
				"Cleanup approval was not found, expired, no longer approved, or changed ownership.",
			],
		});
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(approval).toMatchObject({ status: "pending", executionToken: null });
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
			matchedRuleId: "rule-1",
			safetySnapshot: radarrSafetySnapshot(),
		} as never;
		let state = "approved";
		let executionToken: string | null = null;
		vi.mocked(deps.prisma.libraryCleanupApproval.updateMany).mockImplementation((async ({
			where,
			data,
		}: {
			where: { status?: string; executionToken?: string };
			data: { status?: string; executionToken?: string | null };
		}) => {
			if (where.status && where.status !== state) return { count: 0 };
			if (where.executionToken !== undefined && where.executionToken !== executionToken) {
				return { count: 0 };
			}
			if (data.status === "executed") throw new Error("database unavailable");
			if (data.status) state = data.status;
			if (data.executionToken !== undefined) executionToken = data.executionToken;
			return { count: 1 };
		}) as never);
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockImplementation((async () =>
			state === "executing" ? [approval] : []) as never);

		const first = await executeApprovedItems(deps, "user-1", ["approval-1"]);
		const second = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(first).toMatchObject({ removed: 1, failed: 1 });
		expect(second).toEqual({
			removed: 0,
			failed: 1,
			errors: [
				"Cleanup approval was not found, expired, no longer approved, or changed ownership.",
			],
		});
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
			matchedRuleId: "rule-1",
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

	it("leaves deterministic excess approvals pending under the current post-lease cap", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const approvals = [approvalRecord({ id: "approval-b" }), approvalRecord({ id: "approval-a" })];
		configureApprovalStores(deps, approvals);
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			enabled: true,
			dryRunMode: false,
			requireApproval: true,
			maxRemovalsPerRun: 1,
			respectQuiSeeding: false,
			rules: [currentSeriesRule("rule-1", "delete", "Example Movie")],
		} as never);

		const result = await executeApprovedItems(deps, "user-1", ["approval-b", "approval-a"]);

		expect(result).toMatchObject({ removed: 1, failed: 1 });
		expect(approvals).toEqual([
			expect.objectContaining({ id: "approval-b", status: "pending" }),
			expect.objectContaining({ id: "approval-a", status: "executed" }),
		]);
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledOnce();
	});

	it("returns every untouched bulk claim to pending when the approval read fails", async () => {
		const { deps } = makeDeps({ mediaPartCount: 1 });
		const approvals = [
			approvalRecord({ id: "approval-1" }),
			approvalRecord({ id: "approval-2", arrItemId: 102 }),
		];
		configureApprovalStores(deps, approvals);
		vi.mocked(deps.prisma.libraryCleanupApproval.findMany).mockRejectedValue(
			new Error("database unavailable"),
		);

		await expect(
			executeApprovedItems(deps, "user-1", ["approval-1", "approval-2"]),
		).rejects.toThrow("database unavailable");

		expect(approvals).toEqual([
			expect.objectContaining({ id: "approval-1", status: "pending", executionToken: null }),
			expect.objectContaining({ id: "approval-2", status: "pending", executionToken: null }),
		]);
	});

	it("returns current and later bulk claims to pending when the run lease is lost", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const approvals = [
			approvalRecord({ id: "approval-1" }),
			approvalRecord({ id: "approval-2", arrItemId: 102 }),
		];
		configureApprovalStores(deps, approvals);
		vi.mocked(deps.prisma.libraryCleanupConfig.updateMany).mockImplementation((async ({
			where,
		}: {
			where: { OR?: unknown[] };
		}) => ({ count: where.OR ? 1 : 0 })) as never);

		await expect(
			executeApprovedItems(deps, "user-1", ["approval-1", "approval-2"]),
		).rejects.toBeInstanceOf(CleanupRunLeaseLostError);

		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(approvals).toEqual([
			expect.objectContaining({ id: "approval-1", status: "pending", executionToken: null }),
			expect.objectContaining({ id: "approval-2", status: "pending", executionToken: null }),
		]);
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
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
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
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
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
		expect(deps.prisma.libraryCleanupApproval.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ id: "approval-1", status: "executing" }),
			data: expect.objectContaining({
				status: "pending",
				lastExecutionError: expect.stringContaining("ARR instance could not be loaded"),
			}),
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
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
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

	it("uses structured exact episode identity in dry-run preview details", () => {
		const flaggedItem = {
			cacheItem: {
				instanceId: "sonarr-1",
				arrItemId: 201,
				itemType: "series",
				title: "Private Series Title",
				year: 2024,
				sizeOnDisk: 2_001n,
			},
			match: {
				ruleId: "rule-episode",
				ruleName: "Episode cleanup",
				reason: "Plex watch count 2 > 1",
				action: "delete",
			},
			rating: 8.5,
			episodeTarget: {
				targetScope: "episode",
				arrEpisodeId: 9_001,
				seasonNumber: 1,
				episodeNumber: 2,
				episodeFileId: 3_001,
				episodeFileConsumerIds: [9_001],
				seriesTitle: "Private Series Title",
				episodeTitle: "Private Episode Title",
				plexWatchEvidence: [],
				fileInfoHash: "hash",
				fileTorrentState: "paused",
				respectQuiSeeding: true,
			},
		} as never;

		expect(buildCleanupPreviewDetails([flaggedItem], new Map())).toEqual([
			expect.objectContaining({
				title: "Private Series Title",
				seriesTitle: "Private Series Title",
				episodeTitle: "Private Episode Title",
				targetScope: "episode",
				arrEpisodeId: 9_001,
				seasonNumber: 1,
				episodeNumber: 2,
				episodeFileId: 3_001,
				sizeOnDisk: "2001",
				rating: 8.5,
			}),
		]);
	});

	it("keeps episode warnings incognito, ignores disabled shapes, and emits no-Plex once", async () => {
		const { deps } = makeDeps();
		const sensitiveRuleName = "Delete Private Family Show";
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			userId: "user-1",
			enabled: true,
			dryRunMode: true,
			maxRemovalsPerRun: 10,
			requireApproval: false,
			respectQuiSeeding: true,
			rules: [
				{
					id: "episode-valid",
					name: sensitiveRuleName,
					enabled: true,
					priority: 1,
					targetScope: "episode",
					retentionMode: false,
					action: "delete",
					ruleType: "plex_watch_count",
					operator: null,
					parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
					conditions: null,
					plexLibraryFilter: null,
				},
				{
					id: "episode-disabled",
					name: "Disabled Private Rule",
					enabled: false,
					priority: 2,
					targetScope: "episode",
					retentionMode: false,
					action: null,
					ruleType: "unsupported_private_shape",
					operator: null,
					parameters: "{}",
					conditions: null,
					plexLibraryFilter: null,
				},
			],
		} as never);

		const result = await executeCleanupPreview(deps, "user-1");
		const warningText = (result.warnings ?? []).join("\n");

		expect(warningText).not.toContain(sensitiveRuleName);
		expect(warningText).not.toContain("Disabled Private Rule");
		expect(warningText).not.toContain("unsupported_private_shape");
		expect(
			(result.warnings ?? []).filter((warning) => warning.includes("No enabled Plex instance")),
		).toHaveLength(1);
	});

	it("expires a queued Radarr mutation when its matched action changes", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const storedApproval = approvalRecord();
		configureApprovalStore(deps, storedApproval);
		(
			deps as CleanupExecutorDeps & {
				__setTestMutationRules?: (rules: ReturnType<typeof currentSeriesRule>[]) => void;
			}
		).__setTestMutationRules?.([currentSeriesRule("rule-1", "unmonitor")]);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(storedApproval).toMatchObject({ status: "expired", executionToken: null });
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
	});

	it("stops a queued Radarr record deletion when policy changes after exact file deletion", async () => {
		const fixture = makeDeps({ mediaPartCount: 1 });
		const storedApproval = approvalRecord();
		configureApprovalStore(fixture.deps, storedApproval);
		fixture.deleteMovieFile.mockImplementationOnce(async () => {
			fixture.setLiveMovieFileId(undefined);
			(
				fixture.deps as CleanupExecutorDeps & {
					__setTestMutationRules?: (rules: ReturnType<typeof currentSeriesRule>[]) => void;
				}
			).__setTestMutationRules?.([currentSeriesRule("rule-1", "unmonitor")]);
		});

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
		expect(storedApproval).toMatchObject({ status: "pending", executionToken: null });
	});

	it("continues an exact file-to-record delete after its authorized size rule becomes false", async () => {
		const fixture = makeDeps({ mediaPartCount: 1 });
		const storedApproval = approvalRecord();
		configureApprovalStore(fixture.deps, storedApproval);
		(
			fixture.deps as CleanupExecutorDeps & {
				__setTestMutationRules?: (rules: ReturnType<typeof currentSeriesRule>[]) => void;
			}
		).__setTestMutationRules?.([
			{
				...currentSeriesRule("rule-1", "delete", "Example Movie"),
				ruleType: "size",
				parameters: JSON.stringify({ operator: "greater_than", sizeGb: 0.000001 }),
			},
		]);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 1, failed: 0 });
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).toHaveBeenCalledWith(101, {
			deleteFiles: false,
			addImportExclusion: false,
		});
	});

	it("blocks a direct Radarr mutation when a current retention rule wins", async () => {
		const { deps, targetClient, deleteMovie, deleteMovieFile } = makeDeps({
			action: "unmonitor",
			mediaPartCount: 1,
		});
		(
			deps as CleanupExecutorDeps & {
				__setTestMutationRules?: (rules: ReturnType<typeof currentSeriesRule>[]) => void;
			}
		).__setTestMutationRules?.([
			{
				...currentSeriesRule("retain-rule", "delete", "Example Movie"),
				priority: 0,
				retentionMode: true,
			},
			currentSeriesRule("rule-1", "unmonitor", "Example Movie"),
		]);
		const flaggedItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				year: 2024,
				monitored: true,
				...radarrCachedFileIdentity,
				sizeOnDisk: 2_000n,
			},
			match: {
				ruleId: "rule-1",
				ruleName: "Unmonitor old movie",
				reason: "Matched cleanup policy",
				action: "unmonitor",
			},
			rating: 8,
		} as never;

		const result = await executeDirectRemoval(
			deps,
			{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
			"user-1",
			[flaggedItem],
			1,
			1,
			Date.now(),
		);

		expect(result).toMatchObject({ itemsUnmonitored: 0, itemsSkipped: 1 });
		expect(targetClient.movie.update).not.toHaveBeenCalled();
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
	});

	describe("Radarr rating and monitoring mutation authority", () => {
		const imdbRule = () => ({
			...currentSeriesRule("rule-imdb", "unmonitor"),
			name: "Low IMDb",
			ruleType: "imdb_rating",
			parameters: JSON.stringify({ operator: "less_than", score: 5 }),
		});
		const monitoredRule = () => ({
			...currentSeriesRule("rule-monitored", "unmonitor"),
			name: "Currently monitored",
			ruleType: "monitored",
			parameters: "{}",
		});
		const flaggedItem = (rule: ReturnType<typeof imdbRule>) =>
			({
				cacheItem: {
					instanceId: "radarr-4k",
					arrItemId: 101,
					itemType: "movie",
					title: "Example Movie",
					year: 2024,
					monitored: true,
					...radarrCachedFileIdentity,
					sizeOnDisk: 2_000n,
				},
				match: {
					ruleId: rule.id,
					ruleName: rule.name,
					reason: "Matched current ARR evidence",
					action: "unmonitor",
				},
				rating: 4.9,
			}) as never;

		it("expires approval when the live IMDb rating no longer matches", async () => {
			const fixture = makeDeps({ action: "unmonitor" });
			const rule = imdbRule();
			const liveMovie = await fixture.targetClient.movie.getById(101);
			fixture.targetClient.movie.getById.mockResolvedValue({
				...liveMovie,
				monitored: true,
				ratings: {
					imdb: { value: 8, votes: 100 },
					tmdb: { value: 7.5, votes: 50 },
				},
			});
			const storedApproval = approvalRecord({
				action: "unmonitor",
				safetySnapshot: radarrTargetOnlySnapshot(),
				matchedRuleId: rule.id,
				matchedRuleName: rule.name,
			});
			configureApprovalStore(fixture.deps, storedApproval);
			(
				fixture.deps as CleanupExecutorDeps & {
					__setTestMutationRules?: (rules: ReturnType<typeof currentSeriesRule>[]) => void;
				}
			).__setTestMutationRules?.([rule]);

			const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

			expect(result).toMatchObject({ removed: 0, failed: 1 });
			expect(storedApproval).toMatchObject({ status: "expired", executionToken: null });
			expect(fixture.targetClient.movie.update).not.toHaveBeenCalled();
		});

		it("expires direct authority when the live IMDb rating no longer matches", async () => {
			const fixture = makeDeps({ action: "unmonitor" });
			const rule = imdbRule();
			const liveMovie = await fixture.targetClient.movie.getById(101);
			fixture.targetClient.movie.getById.mockResolvedValue({
				...liveMovie,
				monitored: true,
				ratings: { imdb: { value: 8 }, tmdb: { value: 7.5 } },
			});
			const retries = configureRetryStore(fixture.deps);
			(
				fixture.deps as CleanupExecutorDeps & {
					__setTestMutationRules?: (rules: ReturnType<typeof currentSeriesRule>[]) => void;
				}
			).__setTestMutationRules?.([rule]);

			const result = await executeDirectRemoval(
				fixture.deps,
				{ id: "config-1", maxRemovalsPerRun: 10, rules: [rule] } as never,
				"user-1",
				[flaggedItem(rule)],
				1,
				1,
				Date.now(),
			);

			expect(result).toMatchObject({ itemsUnmonitored: 0, itemsSkipped: 1 });
			expect(retries[0]).toMatchObject({ status: "expired" });
			expect(fixture.targetClient.movie.update).not.toHaveBeenCalled();
		});

		it("expires approval when a monitored movie is now unmonitored", async () => {
			const fixture = makeDeps({ action: "unmonitor" });
			const rule = monitoredRule();
			const liveMovie = await fixture.targetClient.movie.getById(101);
			fixture.targetClient.movie.getById.mockResolvedValue({ ...liveMovie, monitored: false });
			const storedApproval = approvalRecord({
				action: "unmonitor",
				safetySnapshot: radarrTargetOnlySnapshot(),
				matchedRuleId: rule.id,
				matchedRuleName: rule.name,
			});
			configureApprovalStore(fixture.deps, storedApproval);
			(
				fixture.deps as CleanupExecutorDeps & {
					__setTestMutationRules?: (rules: ReturnType<typeof currentSeriesRule>[]) => void;
				}
			).__setTestMutationRules?.([rule]);

			const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

			expect(result).toMatchObject({ removed: 0, failed: 1 });
			expect(storedApproval).toMatchObject({ status: "expired", executionToken: null });
			expect(fixture.targetClient.movie.update).not.toHaveBeenCalled();
		});

		it("expires missing monitoring evidence in direct and retry execution", async () => {
			const fixture = makeDeps({ action: "unmonitor" });
			const rule = monitoredRule();
			const retries = configureRetryStore(fixture.deps);
			(
				fixture.deps as CleanupExecutorDeps & {
					__setTestMutationRules?: (rules: ReturnType<typeof currentSeriesRule>[]) => void;
				}
			).__setTestMutationRules?.([rule]);

			const direct = await executeDirectRemoval(
				fixture.deps,
				{ id: "config-1", maxRemovalsPerRun: 10, rules: [rule] } as never,
				"user-1",
				[flaggedItem(rule)],
				1,
				1,
				Date.now(),
			);
			const retry = await executeRetryItems(fixture.deps, "user-1", [retries[0]!.id as string]);

			expect(direct).toMatchObject({ itemsUnmonitored: 0, itemsSkipped: 1 });
			expect(retry).toMatchObject({ removed: 0, failed: 1 });
			expect(retries[0]).toMatchObject({ status: "expired" });
			expect(fixture.targetClient.movie.update).not.toHaveBeenCalled();
		});
	});
});
