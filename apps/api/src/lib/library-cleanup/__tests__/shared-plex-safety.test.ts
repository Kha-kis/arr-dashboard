import { NotFoundError } from "arr-sdk";
import { describe, expect, it, vi } from "vitest";
import { buildMovieItem } from "../../library/movie-normalizer.js";
import { PlexMovieNotFoundError } from "../../plex/plex-client.js";
import {
	buildCleanupPreviewDetails,
	CleanupRunAlreadyInProgressError,
	CleanupRunLeaseLostError,
	executeApprovedItems,
	executeCleanupPreview,
	executeCleanupRun,
	executeDirectRemoval,
	executeRetryItems,
	INTERRUPTED_CLEANUP_RECOVERY_MESSAGE,
	selectInspectableCleanupPreviewItems,
} from "../cleanup-executor.js";
import {
	assertVerifiedRadarrPeerOwnershipRetained,
	buildRadarrCacheSafetyPlan,
	cleanupDeleteTargetKey,
	createArrServiceFingerprint,
	createSharedPlexSafetyContext,
	findSharedPlexDeleteBlocks,
	parseExecutableSafetyPlan,
	serializeExecutableSafetyPlan,
} from "../shared-plex-safety.js";
import type { CleanupExecutorDeps } from "../types.js";

const silentLog = {
	warn: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
} as unknown as CleanupExecutorDeps["log"];

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
) {
	return serializeExecutableSafetyPlan(
		file
			? {
					kind: "verified_radarr",
					target: radarrTargetIdentity,
					file,
					peers: [],
					peerInventoryComplete: true,
					ownership: [
						{
							plexServerUrl: "http://plex.internal:32400",
							target: {
								ratingKey: "plex-movie-42",
								fullPath: file.fullPath,
								size: file.size,
							},
							retained: [],
						},
					],
					targetDeleteNotifications: [],
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
		title: "Example Movie",
		reason: "Matched 4K cleanup rule",
		action: "delete",
		safetySnapshot: radarrSafetySnapshot(),
		...overrides,
	};
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
		mediaInfo?: {
			videoCodec?: string | null;
			audioCodec?: string | null;
			resolution?: string | null;
			videoDynamicRange?: string | null;
		};
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
		updatedAt: new Date("2026-07-27T12:00:00.000Z"),
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
					onMovieDelete: options.onMovieDelete ?? false,
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
							movieFile: liveMovieFileId !== undefined ? targetMovieFile : undefined,
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

	const deps: CleanupExecutorDeps = {
		prisma: {
			libraryCleanupConfig: {
				findUnique: vi.fn().mockResolvedValue({ id: "config-1" }),
				updateMany: cleanupConfigUpdateMany,
			},
			serviceInstance: {
				findMany: serviceInstanceFindMany,
				findFirst: vi.fn().mockResolvedValue(targetInstance),
			},
			cacheRefreshStatus: {
				findMany: vi.fn().mockResolvedValue([
					{
						instanceId: "plex-1",
						lastRefreshedAt: new Date(),
						lastResult: "success",
						lastErrorMessage: null,
						lastAttemptResult: "success",
						lastAttemptErrorMessage: null,
						itemCount: 1,
					},
				]),
			},
			crossDomainRule: {
				findMany: vi.fn().mockResolvedValue([]),
			},
			libraryCleanupApproval: {
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
				findMany: vi.fn().mockResolvedValue([]),
				findFirst: vi.fn().mockResolvedValue(null),
				count: vi.fn().mockResolvedValue(0),
				create: vi.fn().mockResolvedValue({}),
				update: vi.fn().mockResolvedValue({}),
			},
			libraryCache: {
				findFirst: vi.fn().mockResolvedValue({
					id: "cache-radarr-101",
					instanceId: "radarr-4k",
					arrItemId: 101,
					itemType: "movie",
					title: "Example Movie",
					year: 2024,
					monitored: true,
					hasFile: true,
					status: "released",
					qualityProfileId: 1,
					qualityProfileName: "4K",
					sizeOnDisk: 2_000n,
					arrAddedAt: new Date("2020-01-01T00:00:00.000Z"),
					cachedAt: new Date("2026-07-27T12:05:00.000Z"),
					data: radarrCachedFileIdentity.data,
				}),
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
	};
}

function configureVerifiedRadarrPeer(
	fixture: ReturnType<typeof makeDeps>,
	overrides: {
		id?: string;
		baseUrl?: string;
		filePath?: string;
		fileSize?: number;
		mapFrom?: string;
		mapTo?: string;
		movieTmdbId?: number;
		movieFileId?: number;
		movieTags?: number[];
		notificationTags?: number[];
		notificationEnable?: boolean;
		updateLibrary?: boolean;
	} = {},
) {
	const peerInstance = {
		...fixture.targetInstance,
		id: overrides.id ?? "radarr-hd",
		label: "HD Radarr",
		baseUrl: overrides.baseUrl ?? "http://radarr-hd.internal:7878",
		encryptedApiKey: "encrypted-radarr-hd-key",
		encryptionIv: "radarr-hd-iv",
	};
	const peerMovie = {
		id: 202,
		tmdbId: overrides.movieTmdbId ?? 42,
		title: "Example Movie",
		tags: overrides.movieTags ?? [],
		hasFile: true,
		movieFileId: overrides.movieFileId ?? 2002,
		path: "/downloads-hd/Example Movie (2024)",
		rootFolderPath: "/downloads-hd",
	};
	const peerMovieFile = {
		id: overrides.movieFileId ?? 2002,
		path: overrides.filePath ?? "/downloads-hd/Example Movie (2024)/Example.Movie.1080p.mkv",
		relativePath: "Example.Movie.1080p.mkv",
		size: overrides.fileSize ?? 1_000,
	};
	const peerClient = {
		movie: {
			getAll: vi.fn().mockResolvedValue([peerMovie]),
			getById: vi.fn().mockResolvedValue(peerMovie),
			delete: vi.fn(),
			update: vi.fn(),
		},
		movieFile: {
			getById: vi.fn().mockResolvedValue(peerMovieFile),
			delete: vi.fn(),
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
	return { peerInstance, peerMovie, peerMovieFile, peerClient };
}

function configureUntrackedRadarrPeerWithoutPlexCorrelation(
	fixture: ReturnType<typeof makeDeps>,
	movieTmdbId: number | undefined,
) {
	const peer = configureVerifiedRadarrPeer(fixture);
	(peer.peerMovie as { tmdbId?: number }).tmdbId = movieTmdbId;
	peer.peerClient.notification.getAll.mockResolvedValue([]);
	return peer;
}

function uncorrelatedRadarrPeerSafetySnapshot(
	peerInstance: ReturnType<typeof configureVerifiedRadarrPeer>["peerInstance"],
) {
	return serializeExecutableSafetyPlan({
		kind: "verified_radarr",
		target: radarrTargetIdentity,
		file: {
			movieFileId: 1001,
			fullPath: {
				value: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
				windows: false,
			},
			size: 2_000,
		},
		peers: [
			{
				instanceId: peerInstance.id,
				serviceFingerprint: createArrServiceFingerprint(peerInstance as never),
				externalId: 42,
				arrItemId: null,
				mediaPath: null,
				file: null,
			},
		],
		peerInventoryComplete: true,
		ownership: [
			{
				plexServerUrl: "http://plex.internal:32400",
				target: {
					ratingKey: "plex-movie-42",
					fullPath: {
						value: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
						windows: false,
					},
					size: 2_000,
				},
				retained: [],
			},
		],
		targetDeleteNotifications: [],
	});
}

function configureRetryStore(deps: CleanupExecutorDeps) {
	const retries: Array<Record<string, unknown>> = [];
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
				useGlobalRejectionMemory: true,
				rejectionMemoryDays: 0,
				createdAt: new Date("2026-07-27T12:00:00.000Z"),
				updatedAt: new Date("2026-07-27T12:00:00.000Z"),
			},
		],
	};
}

function plexPolicyCleanupConfig(options: {
	ruleType: "plex_last_watched" | "plex_watch_count";
	parameters: Record<string, unknown>;
	plexLibraryFilter?: string[];
}) {
	const config = dryRunConfig();
	return {
		...config,
		rules: [
			{
				...config.rules[0]!,
				name: "Plex policy",
				ruleType: options.ruleType,
				parameters: JSON.stringify(options.parameters),
				plexLibraryFilter: options.plexLibraryFilter
					? JSON.stringify(options.plexLibraryFilter)
					: null,
			},
		],
	};
}

function configurePublishedPlexEvidence(
	fixture: ReturnType<typeof makeDeps>,
	options: { itemCount: number; rowCount: number; sectionTitles?: string[] },
) {
	const completedAt = new Date();
	Object.assign(fixture.plexInstance, {
		enabled: true,
		updatedAt: new Date(0),
	});
	Object.assign(fixture.deps.prisma, {
		cacheRefreshStatus: {
			findMany: vi.fn().mockResolvedValue([
				{
					instanceId: fixture.plexInstance.id,
					lastRefreshedAt: completedAt,
					lastResult: "success",
					lastErrorMessage: null,
					lastAttemptResult: "success",
					lastAttemptErrorMessage: null,
					itemCount: options.itemCount,
					generationId: "plex-generation-1",
					generationMetadata: JSON.stringify({
						sections: (options.sectionTitles ?? ["Movies"]).map((title, index) => ({
							key: String(index + 1),
							title,
							type: "movie",
						})),
					}),
				},
			]),
		},
		plexCache: {
			count: vi.fn().mockResolvedValue(options.rowCount),
			findMany: vi.fn().mockResolvedValue([
				{
					id: "plex-cache-1",
					tmdbId: 42,
					mediaType: "movie",
					sectionId: "1",
					sectionTitle: "Movies",
					lastWatchedAt: null,
					watchCount: 0,
					watchedByUsers: "[]",
					onDeck: false,
					userRating: null,
					collections: "[]",
					labels: "[]",
					addedAt: new Date("2026-01-01T00:00:00.000Z"),
				},
			]),
		},
	});
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

function deployedCleanupExemption(
	document: unknown,
	scope: unknown = { serviceTypes: ["RADARR"], instanceIds: [] },
) {
	return {
		id: "cross-domain-exemption-1",
		deployedDocument: JSON.stringify(document),
		deployedScope: JSON.stringify(scope),
		deployedActions: JSON.stringify([{ type: "send_notification" }, { type: "exempt_cleanup" }]),
	};
}

describe("shared Plex deletion safety", () => {
	const target = {
		instanceId: "radarr-4k",
		arrItemId: 101,
		itemType: "movie",
		action: "delete",
	};

	it("rejects a retained Radarr plan that predates peer ownership witnesses", () => {
		expect(
			parseExecutableSafetyPlan(
				JSON.stringify({
					kind: "verified_radarr",
					target: radarrTargetIdentity,
					file: {
						movieFileId: 1001,
						fullPath: {
							value: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
						},
						size: 2_000,
					},
				}),
			),
		).toBeNull();
	});

	it("does not turn cached Radarr file metadata into a destructive executable plan", () => {
		expect(
			buildRadarrCacheSafetyPlan(
				{
					remoteIds: { tmdbId: 42 },
					path: "/movies-4k/Example Movie (2024)",
					movieFile: {
						id: 1001,
						path: "/movies-4k/Example Movie (2024)/Example.Movie.2160p.mkv",
						size: 2_000,
					},
				},
				true,
				radarrTargetIdentity,
			),
		).toBeNull();
	});

	it("does not acquire the mutation lease for a dry run", async () => {
		const { deps } = makeDeps();
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig() as never,
		);

		const result = await executeCleanupRun(deps, "user-1");

		expect(result).toMatchObject({
			isDryRun: true,
			status: "completed",
			itemsEvaluated: 0,
			itemsRemoved: 0,
		});
		expect(deps.prisma.libraryCleanupConfig.updateMany).not.toHaveBeenCalled();
		expect(deps.prisma.libraryCleanupLog.create).not.toHaveBeenCalled();
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
				itemsFlagged: 1,
				itemsSkipped: 1,
			});
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
				itemsFlagged: 1,
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
			itemsFlagged: 0,
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

	it("fails closed for malformed deployed cleanup exemptions in scope", async () => {
		const { deps, targetClient } = makeDeps();
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig() as never,
		);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			deployedCleanupExemption({ version: 1, root: { kind: "", params: {} } }),
		] as never);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem(),
		] as never);

		const result = await executeCleanupRun(deps, "user-1");

		expect(result).toMatchObject({
			isDryRun: true,
			status: "partial",
			itemsEvaluated: 1,
			itemsFlagged: 0,
		});
		expect(result.warnings).toContain(
			"Cleanup candidates covered by an invalid or unavailable deployed exemption were blocked.",
		);
		expect(targetClient.movie.getById).not.toHaveBeenCalled();
	});

	it("fails closed when an aggregate-invalid deployed action array cannot prove no exemption exists", async () => {
		const { deps, targetClient } = makeDeps();
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig() as never,
		);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			{
				...deployedCleanupExemption({
					version: 1,
					root: { kind: "year_range", params: { operator: "after", year: 2030 } },
				}),
				deployedActions: JSON.stringify([{ type: "send_notification" }]),
			},
		] as never);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem(),
		] as never);

		const result = await executeCleanupRun(deps, "user-1");

		expect(result).toMatchObject({
			isDryRun: true,
			status: "partial",
			itemsEvaluated: 1,
			itemsFlagged: 0,
		});
		expect(result.warnings).toContain(
			"Cleanup candidates covered by an invalid or unavailable deployed exemption were blocked.",
		);
		expect(targetClient.movie.getById).not.toHaveBeenCalled();
	});

	it("fails closed when a deployed snapshot is too incomplete to inspect for exemptions", async () => {
		const { deps, targetClient } = makeDeps();
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig() as never,
		);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			{
				id: "incomplete-deployment",
				deployedDocument: null,
				deployedScope: null,
				deployedActions: null,
			},
		] as never);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem(),
		] as never);

		const result = await executeCleanupRun(deps, "user-1");

		expect(deps.prisma.crossDomainRule.findMany).toHaveBeenCalledWith({
			where: { userId: "user-1", deployedAt: { not: null } },
			select: {
				id: true,
				deployedDocument: true,
				deployedScope: true,
				deployedActions: true,
			},
		});
		expect(result).toMatchObject({
			isDryRun: true,
			status: "partial",
			itemsEvaluated: 1,
			itemsFlagged: 0,
		});
		expect(result.warnings).toContain(
			"Cleanup blocked because a deployed cross-domain rule could not be checked for cleanup exemptions.",
		);
		expect(targetClient.movie.getById).not.toHaveBeenCalled();
	});

	it("fails closed when deployed cleanup exemption evidence is unavailable", async () => {
		const { deps, targetClient } = makeDeps();
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig() as never,
		);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			deployedCleanupExemption({
				version: 1,
				root: {
					kind: "plex_watched_by",
					params: { operator: "includes_any", userNames: ["Owner"] },
				},
			}),
		] as never);
		(deps.prisma as unknown as { plexCache: { findMany: ReturnType<typeof vi.fn> } }).plexCache = {
			findMany: vi.fn().mockRejectedValue(new Error("Plex cache unavailable")),
		};
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem(),
		] as never);

		const result = await executeCleanupRun(deps, "user-1");

		expect(result).toMatchObject({
			isDryRun: true,
			status: "partial",
			itemsEvaluated: 1,
			itemsFlagged: 0,
			prefetchHealth: expect.objectContaining({ plex: "skipped" }),
		});
		expect(result.warnings).toContain(
			"Cleanup candidates covered by an exemption with unavailable evidence were blocked.",
		);
		expect(targetClient.movie.getById).not.toHaveBeenCalled();
	});

	it("fails closed when a cache-backed exemption has no authoritative item evidence", async () => {
		const { deps, targetClient } = makeDeps();
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig() as never,
		);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			deployedCleanupExemption({
				version: 1,
				root: {
					kind: "plex_watched_by",
					params: { operator: "includes_any", userNames: ["Owner"] },
				},
			}),
		] as never);
		(deps.prisma as unknown as { plexCache: { findMany: ReturnType<typeof vi.fn> } }).plexCache = {
			findMany: vi.fn().mockResolvedValue([]),
		};
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem(),
		] as never);

		const result = await executeCleanupRun(deps, "user-1");

		expect(result).toMatchObject({
			isDryRun: true,
			status: "partial",
			itemsEvaluated: 1,
			itemsFlagged: 0,
			prefetchHealth: expect.objectContaining({ plex: "skipped" }),
		});
		expect(result.warnings).toContain(
			"Cleanup candidates covered by an exemption with unavailable evidence were blocked.",
		);
		expect(targetClient.movie.getById).not.toHaveBeenCalled();
	});

	it("fails closed for exemption-only TMDb list evidence that may never have been refreshed", async () => {
		const { deps, targetClient } = makeDeps();
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig() as never,
		);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			deployedCleanupExemption({
				version: 1,
				root: {
					kind: "tmdb_list_member",
					params: { operator: "is_in", listId: "1234" },
				},
			}),
		] as never);
		(
			deps.prisma as unknown as {
				tmdbListCache: { findMany: ReturnType<typeof vi.fn> };
			}
		).tmdbListCache = {
			findMany: vi.fn().mockResolvedValue([]),
		};
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem(),
		] as never);

		const result = await executeCleanupRun(deps, "user-1");

		expect(result).toMatchObject({
			isDryRun: true,
			status: "partial",
			itemsEvaluated: 1,
			itemsFlagged: 0,
		});
		expect(result.warnings).toContain(
			"Cleanup candidates covered by an exemption with unavailable evidence were blocked.",
		);
		expect(targetClient.movie.getById).not.toHaveBeenCalled();
	});

	it("fails closed when a successful Seerr scan cannot prove complete item evidence", async () => {
		const { deps, targetClient } = makeDeps();
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig() as never,
		);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			deployedCleanupExemption({
				version: 1,
				root: {
					kind: "seerr_requested_by",
					params: { userNames: ["Owner"] },
				},
			}),
		] as never);
		vi.mocked(deps.prisma.serviceInstance.findFirst).mockResolvedValue({
			id: "seerr-1",
			userId: "user-1",
			service: "SEERR",
			label: "Seerr",
			baseUrl: "http://seerr.internal:5055",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
		} as never);
		(
			deps.arrClientFactory as unknown as {
				rawRequest: ReturnType<typeof vi.fn>;
			}
		).rawRequest = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					pageInfo: { pages: 1, pageSize: 50, results: 0, page: 1 },
					results: [],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem(),
		] as never);

		const result = await executeCleanupRun(deps, "user-1");

		expect(result).toMatchObject({
			isDryRun: true,
			status: "partial",
			itemsEvaluated: 1,
			itemsFlagged: 0,
			prefetchHealth: expect.objectContaining({ seerr: "skipped" }),
		});
		expect(result.warnings).toContain(
			"Cleanup candidates covered by an exemption with unavailable evidence were blocked.",
		);
		expect(targetClient.movie.getById).not.toHaveBeenCalled();
	});

	it("fails closed for retired or unavailable cleanup exemption criteria", async () => {
		const { deps, targetClient } = makeDeps();
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig() as never,
		);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			deployedCleanupExemption({
				version: 1,
				root: {
					kind: "tautulli_last_watched",
					params: { operator: "older_than", days: 30 },
				},
			}),
		] as never);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem(),
		] as never);

		const result = await executeCleanupRun(deps, "user-1");

		expect(result).toMatchObject({
			isDryRun: true,
			status: "partial",
			itemsEvaluated: 1,
			itemsFlagged: 0,
		});
		expect(result.warnings).toContain(
			"Cleanup candidates covered by an invalid or unavailable deployed exemption were blocked.",
		);
		expect(targetClient.movie.getById).not.toHaveBeenCalled();
	});

	it("keeps valid non-matching cleanup exemptions from blocking unrelated candidates", async () => {
		const { deps } = makeDeps();
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig() as never,
		);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			deployedCleanupExemption({
				version: 1,
				root: {
					kind: "year_range",
					params: { operator: "after", year: 2030 },
				},
			}),
		] as never);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem(),
		] as never);

		const result = await executeCleanupRun(deps, "user-1");

		expect(result.itemsEvaluated).toBe(1);
		expect(result.itemsFlagged).toBe(1);
		expect(result.warnings).not.toContain(
			"Cleanup candidates covered by an exemption with unavailable evidence were blocked.",
		);
	});

	it("fails closed when local exemption evidence is missing", async () => {
		const { deps } = makeDeps();
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig() as never,
		);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			deployedCleanupExemption({
				version: 1,
				root: {
					kind: "year_range",
					params: { operator: "after", year: 2030 },
				},
			}),
		] as never);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem({ year: null }),
		] as never);

		const result = await executeCleanupRun(deps, "user-1");

		expect(result.itemsEvaluated).toBe(1);
		expect(result.itemsFlagged).toBe(0);
		expect(result.warnings).toContain(
			"Cleanup candidates covered by an exemption with unavailable evidence were blocked.",
		);
	});

	it("treats an audio codec without parseable channel evidence as unknown", async () => {
		const { deps } = makeDeps();
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig() as never,
		);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			deployedCleanupExemption({
				version: 1,
				root: {
					kind: "audio_channels",
					params: { operator: "is", channels: 2 },
				},
			}),
		] as never);
		vi.mocked(deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem({
				data: JSON.stringify({ movieFile: { audioCodec: "AAC" } }),
			}),
		] as never);

		const result = await executeCleanupRun(deps, "user-1");

		expect(result.itemsFlagged).toBe(0);
		expect(result.warnings).toContain(
			"Cleanup candidates covered by an exemption with unavailable evidence were blocked.",
		);
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
					reason: expect.stringContaining("Durable retry pending"),
				}),
			],
		});
		expect(result.details).toHaveLength(1);
		expect(deps.prisma.libraryCleanupApproval.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ take: 1 }),
		);
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
			select,
		}: {
			where: { status?: string };
			select?: Record<string, boolean>;
		}) => {
			if (where.status !== "retry_pending") return [];
			return select ? [selectedRetry, deferredRetry] : [selectedRetry];
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
			itemsSkipped: 0,
		});
		expect(result.details).toHaveLength(1);
		expect(result.details[0]?.arrItemId).toBe(101);
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
			itemsFlagged: 0,
			pendingRetryCount: 0,
			itemsSkipped: 1,
			details: [
				expect.objectContaining({
					arrItemId: 101,
					action: "skipped",
					reason: "Deferred: another cleanup run is already executing this durable retry.",
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

	it("allows a merged Plex movie only when a Radarr peer proves ownership of every retained part", async () => {
		const fixture = makeDeps();
		const { peerInstance, peerClient } = configureVerifiedRadarrPeer(fixture);
		const context = createSharedPlexSafetyContext();

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);

		expect(blocks).toEqual(new Map());
		expect(peerClient.movie.getAll).toHaveBeenCalledWith();
		expect(peerClient.movie.delete).not.toHaveBeenCalled();
		expect(peerClient.movieFile.delete).not.toHaveBeenCalled();
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
			targetDeleteNotifications: expect.any(Array),
		});
	});

	it("blocks a Radarr plan when a peer imports the movie during Plex verification", async () => {
		const fixture = makeDeps();
		const peer = configureVerifiedRadarrPeer(fixture);
		fixture.getMovieMediaPartsByTmdbId.mockImplementation(async () => {
			peer.peerClient.movie.getAll.mockResolvedValue([{ ...peer.peerMovie, movieFileId: 2999 }]);
			peer.peerClient.movieFile.getById.mockResolvedValue({
				...peer.peerMovieFile,
				id: 2999,
				path: "/downloads-hd/Example Movie (2024)/Example.Movie.Replacement.mkv",
			});
			return [
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
		});

		const context = createSharedPlexSafetyContext();
		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);

		expect(blocks.has(cleanupDeleteTargetKey(target))).toBe(true);
		expect(context.plans.get(cleanupDeleteTargetKey(target))).toMatchObject({ kind: "blocked" });
		expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
	});

	it("blocks a Radarr plan when its target file changes during Plex verification", async () => {
		const fixture = makeDeps({ mediaPartCount: 1 });
		fixture.getMovieMediaPartsByTmdbId.mockImplementation(async () => {
			fixture.targetClient.movieFile.getById.mockResolvedValue({
				id: 1002,
				path: "/movies-4k/Example Movie (2024)/Example.Movie.Replacement.2160p.mkv",
				relativePath: "Example.Movie.Replacement.2160p.mkv",
				size: 2_500,
			});
			return [
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
		});

		const context = createSharedPlexSafetyContext();
		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);

		expect(blocks.has(cleanupDeleteTargetKey(target))).toBe(true);
		expect(context.plans.get(cleanupDeleteTargetKey(target))).toMatchObject({ kind: "blocked" });
	});

	it("blocks a Radarr plan when target delete notifications change during Plex verification", async () => {
		const fixture = makeDeps({ onMovieDelete: true, onMovieFileDelete: true, mediaPartCount: 1 });
		const initialNotifications = await fixture.targetClient.notification.getAll();
		fixture.targetClient.notification.getAll.mockClear();
		fixture.targetClient.notification.getAll.mockResolvedValue(initialNotifications);
		fixture.getMovieMediaPartsByTmdbId.mockImplementation(async () => {
			fixture.targetClient.notification.getAll.mockResolvedValue(
				initialNotifications.map((notification: Record<string, unknown>) => ({
					...notification,
					fields: notificationFields({ mapFrom: "/movies-4k", mapTo: "/changed-root" }),
				})),
			);
			return [
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
		});

		const context = createSharedPlexSafetyContext();
		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context);

		expect(blocks.has(cleanupDeleteTargetKey(target))).toBe(true);
		expect(context.plans.get(cleanupDeleteTargetKey(target))).toMatchObject({ kind: "blocked" });
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
	});

	it("blocks when a Radarr peer resolves to the selected Plex part", async () => {
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
	});

	it("blocks duplicate Radarr peer claims for one retained Plex part", async () => {
		const fixture = makeDeps();
		const firstPeer = configureVerifiedRadarrPeer(fixture);
		const secondPeer = configureVerifiedRadarrPeer(fixture, {
			id: "radarr-hd-duplicate",
			baseUrl: "http://radarr-hd-duplicate.internal:7878",
		});
		vi.mocked(fixture.deps.prisma.serviceInstance.findMany).mockImplementation(
			(args) =>
				(args?.where?.service === "PLEX"
					? Promise.resolve([fixture.plexInstance])
					: Promise.resolve([
							fixture.targetInstance,
							firstPeer.peerInstance,
							secondPeer.peerInstance,
						])) as never,
		);
		vi.mocked(fixture.deps.arrClientFactory.create).mockImplementation(
			(instance) =>
				(instance.id === firstPeer.peerInstance.id
					? firstPeer.peerClient
					: instance.id === secondPeer.peerInstance.id
						? secondPeer.peerClient
						: fixture.targetClient) as never,
		);

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain("Plex has multiple files merged");
	});

	it.each([
		["a stale peer media identity", { movieTmdbId: 43 }, "Plex has multiple files merged"],
		[
			"a stale peer movie-file size",
			{ fileSize: 1_001 },
			"could not match the exact Radarr movie file",
		],
	])("blocks retained ownership proof with %s", async (_label, peer, reason) => {
		const fixture = makeDeps();
		configureVerifiedRadarrPeer(fixture, peer);

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(reason);
	});

	it("builds one complete peer inventory for a planning batch", async () => {
		const fixture = makeDeps();
		const { peerClient } = configureVerifiedRadarrPeer(fixture);

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [
			target,
			{ ...target, arrItemId: 102 },
		]);

		expect(blocks).toEqual(new Map());
		// One stable inventory is read for planning and one terminal inventory is
		// shared across the batch after every Plex lookup completes.
		expect(peerClient.movie.getAll).toHaveBeenCalledTimes(4);
		expect(peerClient.movie.getById).not.toHaveBeenCalled();
		expect(peerClient.movieFile.getById).toHaveBeenCalledTimes(4);
		expect(peerClient.movieFile.getById).toHaveBeenCalledWith(2002);
	});

	it.each([
		["alternate", 43],
		["missing", undefined],
	])(
		"blocks an %s-TMDb Radarr peer that owns the exact target Plex part",
		async (_label, peerTmdbId) => {
			const fixture = makeDeps({ mediaPartCount: 1 });
			const peer = configureVerifiedRadarrPeer(fixture, {
				filePath: "/downloads-hd/Example Movie (2024)/Example.Movie.2160p.mkv",
				fileSize: 2_000,
				mapTo: "/movies-4k",
			});
			(peer.peerMovie as { tmdbId?: number }).tmdbId = peerTmdbId;
			peer.peerClient.movie.getAll.mockImplementation((query?: { tmdbId?: number }) =>
				Promise.resolve(query ? [] : [peer.peerMovie]),
			);

			const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

			expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
				"another configured Radarr instance may access the same storage",
			);
			expect(peer.peerClient.movie.getAll).toHaveBeenCalledWith();
			expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
			expect(fixture.deleteMovie).not.toHaveBeenCalled();
			expect(peer.peerClient.movie.delete).not.toHaveBeenCalled();
			expect(peer.peerClient.movieFile.delete).not.toHaveBeenCalled();
		},
	);

	it.each([
		["alternate", 43],
		["missing", undefined],
	])(
		"blocks planning for an untracked Radarr peer with %s TMDb metadata and no Plex correlation",
		async (_label, peerTmdbId) => {
			const fixture = makeDeps({ mediaPartCount: 1 });
			const peer = configureUntrackedRadarrPeerWithoutPlexCorrelation(fixture, peerTmdbId);

			const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

			expect(blocks.get(cleanupDeleteTargetKey(target))).toEqual(
				expect.stringContaining("could not match the exact Radarr movie file"),
			);
			expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
			expect(fixture.deleteMovie).not.toHaveBeenCalled();
			expect(peer.peerClient.movieFile.delete).not.toHaveBeenCalled();
			expect(peer.peerClient.movie.delete).not.toHaveBeenCalled();
		},
	);

	it.each(["queued", "direct", "retry"] as const)(
		"blocks %s Radarr deletion for an untracked alternate-TMDb peer without Plex correlation",
		async (mode) => {
			const fixture = makeDeps({ mediaPartCount: 1 });
			const peer = configureUntrackedRadarrPeerWithoutPlexCorrelation(fixture, 43);
			const safetySnapshot = uncorrelatedRadarrPeerSafetySnapshot(peer.peerInstance);

			if (mode === "queued") {
				const storedApproval = approvalRecord({ safetySnapshot }) as Record<string, unknown>;
				configureApprovalStore(fixture.deps, storedApproval);
				const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);
				expect(result).toMatchObject({ removed: 0, failed: 1 });
			} else if (mode === "direct") {
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
			} else {
				const storedRetry = approvalRecord({
					status: "retry_pending",
					executionToken: null,
					safetySnapshot,
				}) as Record<string, unknown>;
				configureApprovalStore(fixture.deps, storedRetry);
				fixture.setLiveMovieFileId(undefined);
				const result = await executeRetryItems(fixture.deps, "user-1", ["approval-1"]);
				expect(result).toMatchObject({ removed: 0, failed: 1 });
				expect(storedRetry).toMatchObject({ status: "retry_pending" });
			}

			expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
			expect(fixture.deleteMovie).not.toHaveBeenCalled();
			expect(peer.peerClient.movieFile.delete).not.toHaveBeenCalled();
			expect(peer.peerClient.movie.delete).not.toHaveBeenCalled();
		},
	);

	it("fails closed when the complete Radarr peer inventory changes while it is read", async () => {
		const fixture = makeDeps({ mediaPartCount: 1 });
		const peer = configureVerifiedRadarrPeer(fixture);
		(peer.peerMovie as { hasFile?: boolean; movieFileId?: number }).hasFile = false;
		(peer.peerMovie as { movieFileId?: number }).movieFileId = undefined;
		peer.peerClient.movie.getAll
			.mockResolvedValueOnce([peer.peerMovie])
			.mockResolvedValueOnce([{ ...peer.peerMovie, id: 203 }]);

		const blocks = await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target]);

		expect(blocks.get(cleanupDeleteTargetKey(target))).toContain(
			"another configured Radarr instance may access the same storage",
		);
		expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
	});

	it("renders only preview items that can receive live safety inspection", () => {
		const flagged = Array.from({ length: 201 }, (_, index) => ({
			cacheItem: { arrItemId: index + 1 },
		})) as never;

		expect(selectInspectableCleanupPreviewItems(flagged)).toHaveLength(200);
		expect(selectInspectableCleanupPreviewItems(flagged).at(-1)?.cacheItem.arrItemId).toBe(200);
	});

	it("includes durable retries in a side-effect-free preview when no rules are enabled", async () => {
		const { deps, deleteMovie, deleteMovieFile, targetClient } = makeDeps({ mediaPartCount: 1 });
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			rules: [],
		} as never);
		const retry = {
			...approvalRecord({
				status: "retry_pending",
				lastExecutionError: "Radarr was unavailable",
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
			pendingRetryCount: 1,
			itemsRemoved: 0,
			details: [
				expect.objectContaining({
					arrItemId: 101,
					action: "delete",
					reason:
						"Durable retry pending resume from the Approval Queue or the next live direct cleanup run: Radarr was unavailable",
				}),
			],
			warnings: [expect.stringContaining("next live direct cleanup run")],
		});
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(targetClient.movie.update).not.toHaveBeenCalled();
	});

	it("does not preview a filtered Plex rule when the configured section is unavailable", async () => {
		const fixture = makeDeps();
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			plexPolicyCleanupConfig({
				ruleType: "plex_last_watched",
				parameters: { operator: "never" },
				plexLibraryFilter: ["Missing Library"],
			}) as never,
		);
		vi.mocked(fixture.deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem(),
		] as never);
		configurePublishedPlexEvidence(fixture, { itemCount: 1, rowCount: 1 });

		const result = await executeCleanupPreview(fixture.deps, "user-1");

		expect(result).toMatchObject({
			itemsEvaluated: 1,
			itemsFlagged: 0,
			prefetchHealth: { plex: "failed" },
		});
		expect(result.warnings).toContainEqual(expect.stringContaining("plex data unavailable"));
	});

	it("does not select a Plex cleanup candidate when the published row count mismatches", async () => {
		const fixture = makeDeps();
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			plexPolicyCleanupConfig({
				ruleType: "plex_watch_count",
				parameters: { operator: "less_than", count: 1 },
			}) as never,
		);
		vi.mocked(fixture.deps.prisma.libraryCache.findMany).mockResolvedValue([
			matchingDryRunCacheItem(),
		] as never);
		configurePublishedPlexEvidence(fixture, { itemCount: 2, rowCount: 1 });

		const result = await executeCleanupRun(fixture.deps, "user-1");

		expect(result).toMatchObject({
			isDryRun: true,
			itemsEvaluated: 1,
			itemsFlagged: 0,
			prefetchHealth: { plex: "failed" },
		});
		expect(fixture.targetClient.movie.update).not.toHaveBeenCalled();
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
	});

	it("reports Plex unavailable when episode-completion evidence fails", async () => {
		const fixture = makeDeps();
		Object.assign(fixture.plexInstance, {
			enabled: true,
			updatedAt: new Date(0),
		});
		const config = dryRunConfig();
		vi.mocked(fixture.deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			...config,
			rules: [
				{
					...config.rules[0]!,
					name: "Retain incomplete series",
					ruleType: "plex_episode_completion",
					parameters: JSON.stringify({ operator: "less_than", percentage: 100 }),
					retentionMode: true,
				},
			],
		} as never);
		const completedAt = new Date();
		const normalStatus = {
			instanceId: fixture.plexInstance.id,
			lastRefreshedAt: completedAt,
			lastResult: "success",
			lastErrorMessage: null,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			itemCount: 1,
			generationId: "plex-generation-1",
			generationMetadata: JSON.stringify({
				sections: [{ key: "1", title: "TV Shows", type: "show" }],
			}),
		};
		Object.assign(fixture.deps.prisma, {
			cacheRefreshStatus: {
				findMany: vi.fn(({ where }: { where: { cacheType: string } }) =>
					Promise.resolve(
						where.cacheType === "plex_episode"
							? [{ ...normalStatus, lastResult: "error", lastErrorMessage: "refresh failed" }]
							: [normalStatus],
					),
				),
			},
			plexCache: {
				count: vi.fn().mockResolvedValue(1),
				findMany: vi.fn().mockResolvedValue([
					{
						id: "plex-cache-1",
						tmdbId: 42,
						mediaType: "series",
						sectionId: "1",
						sectionTitle: "TV Shows",
						lastWatchedAt: null,
						watchCount: 0,
						watchedByUsers: "[]",
						onDeck: false,
						userRating: null,
						collections: "[]",
						labels: "[]",
						addedAt: null,
					},
				]),
			},
			plexEpisodeCache: {
				findMany: vi.fn().mockResolvedValue([]),
				groupBy: vi.fn().mockResolvedValue([]),
			},
		});

		const result = await executeCleanupRun(fixture.deps, "user-1");

		expect(result.prefetchHealth).toMatchObject({ plex: "failed" });
		expect(result.warnings).toContainEqual(expect.stringContaining("plex data unavailable"));
	});

	it("does not count a rule match twice when a durable retry already represents its target", async () => {
		const { deps } = makeDeps({ mediaPartCount: 1 });
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue(
			dryRunConfig() as never,
		);
		const retry = {
			...approvalRecord({
				status: "retry_pending",
				lastExecutionError: "Radarr was unavailable",
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
			itemsFlagged: 0,
			pendingRetryCount: 1,
		});
		expect(result.details).toHaveLength(1);
		expect(result.details[0]).toMatchObject({
			arrItemId: 101,
			reason: expect.stringContaining("Durable retry pending"),
		});
	});

	it("loads initial and terminal Radarr notifications once per instance across a planning batch", async () => {
		const { deps, targetClient } = makeDeps({ mediaPartCount: 1 });
		const context = createSharedPlexSafetyContext();

		await findSharedPlexDeleteBlocks(
			deps,
			"user-1",
			[target, { ...target, arrItemId: 102 }],
			context,
		);

		expect(targetClient.notification.getAll).toHaveBeenCalledTimes(2);
		expect(targetClient.movie.getById).toHaveBeenCalledTimes(6);
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

	it("rechecks deployed exemptions after persisting a direct mutation intent", async () => {
		const { deps, targetClient } = makeDeps({ action: "unmonitor" });
		const intents = configureRetryStore(deps);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			deployedCleanupExemption({
				version: 1,
				root: {
					kind: "year_range",
					params: { operator: "before", year: 2030 },
				},
			}),
		] as never);
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

		expect(result).toMatchObject({ itemsUnmonitored: 0, status: "partial" });
		expect(result.warnings).toContain(
			"1 cleanup mutation was blocked because current deployed exemption policy covers its ARR target.",
		);
		expect(result.details[0]?.reason).toContain("deployed cleanup exemption policy");
		expect(targetClient.movie.update).not.toHaveBeenCalled();
		expect(intents).toHaveLength(1);
		expect(intents[0]).toMatchObject({
			status: "expired",
			lastExecutionError:
				"Skipped for safety: current deployed cleanup exemption policy covers this ARR target.",
		});
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

	it("blocks a no-notification Radarr deletion when a sibling appears after planning", async () => {
		const fixture = makeDeps({ includePlexNotification: false, mediaPartCount: 1 });
		const sibling = {
			...fixture.targetInstance,
			id: "radarr-hd",
			label: "HD Radarr",
			baseUrl: "http://radarr-hd.internal:7878",
		};
		let topologyReads = 0;
		vi.mocked(fixture.deps.prisma.serviceInstance.findMany).mockImplementation((args) => {
			if (args?.where?.service === "PLEX") return Promise.resolve([]) as never;
			if (typeof args?.where?.service === "object" && "in" in args.where.service) {
				topologyReads++;
				return Promise.resolve(
					topologyReads === 1 ? [fixture.targetInstance] : [fixture.targetInstance, sibling],
				) as never;
			}
			return Promise.resolve([
				{ id: fixture.targetInstance.id, updatedAt: fixture.targetInstance.updatedAt },
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
				reason: "Matched 4K profile",
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

		expect(result).toMatchObject({ status: "partial", itemsRemoved: 0, itemsFilesDeleted: 0 });
		expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
	});

	it("retains a no-peer Radarr record when Plex gains an unowned part after exact file deletion", async () => {
		const fixture = makeDeps({ mediaPartCount: 1 });
		const deleteSelectedFile = fixture.deleteMovieFile.getMockImplementation();
		if (!deleteSelectedFile) throw new Error("Expected a target file delete implementation");
		fixture.deleteMovieFile.mockImplementation(async (movieFileId) => {
			await deleteSelectedFile(movieFileId);
			fixture.getMovieMediaPartsByTmdbId.mockResolvedValue([
				{
					ratingKey: "plex-movie-42",
					parts: [
						{
							file: "/movies-4k/Example Movie (2024)/Example.Movie.Remux.mkv",
							size: 3_000,
						},
					],
				},
			]);
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
				reason: "Matched 4K profile",
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

		expect(result).toMatchObject({ status: "partial", itemsRemoved: 0, itemsFilesDeleted: 1 });
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
	});

	it("removes the Radarr record when Plex drops the no-retained movie after exact file deletion", async () => {
		const fixture = makeDeps({ mediaPartCount: 1 });
		vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
			approvalRecord() as never,
		]);
		const deleteSelectedFile = fixture.deleteMovieFile.getMockImplementation();
		if (!deleteSelectedFile) throw new Error("Expected a target file delete implementation");
		fixture.deleteMovieFile.mockImplementation(async (movieFileId) => {
			await deleteSelectedFile(movieFileId);
			fixture.getMovieMediaPartsByTmdbId.mockRejectedValue(new PlexMovieNotFoundError(42));
		});

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 1, failed: 0, errors: [] });
		expect(fixture.deleteMovieFile).toHaveBeenCalledOnce();
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).toHaveBeenCalledWith(101, {
			deleteFiles: false,
			addImportExclusion: false,
		});
	});

	it("exposes a typed Plex movie-not-found error for Radarr safety", () => {
		expect(new PlexMovieNotFoundError(42)).toMatchObject({
			name: "PlexMovieNotFoundError",
			message: "Plex returned no movie item for TMDb 42",
		});
	});

	it("persists exact single-episode Sonarr authority and rejects shared-file membership", () => {
		const serialized = serializeExecutableSafetyPlan({
			kind: "verified_sonarr_episode",
			target: radarrTargetIdentity,
			episode: {
				arrEpisodeId: 9_001,
				seasonNumber: 1,
				episodeNumber: 2,
				episodeFileId: 7_001,
				episodeFileConsumerIds: [9_001],
				monitored: true,
			},
			selectedFile: {
				episodeFileId: 7_001,
				fullPath: { value: "/shows/Example/Example.S01E02.mkv", windows: false },
				size: 2_000,
			},
			retainedTargetFiles: [],
			watchProof: {
				plexInstanceId: "plex-1",
				sourceFingerprint: "source-fingerprint",
				plexServerUrl: "http://plex.internal:32400",
				ratingKey: "episode-9001",
				watchCount: 2,
				refreshedAt: "2026-08-12T12:00:00.000Z",
				fullPath: { value: "/plex/shows/Example/Example.S01E02.mkv", windows: false },
				size: 2_000,
				mapping: null,
			},
			quiIdentity: { enabled: false, infoHash: null, torrentState: null },
			peers: [],
			ownership: [],
			targetDeleteNotifications: [],
		});
		const plan = parseExecutableSafetyPlan(serialized);

		expect(plan).toMatchObject({
			kind: "verified_sonarr_episode",
			episode: { arrEpisodeId: 9_001, episodeFileConsumerIds: [9_001] },
		});
		expect(
			parseExecutableSafetyPlan(
				JSON.stringify({
					...plan,
					episode: {
						...(plan as never as { episode: object }).episode,
						episodeFileConsumerIds: [9_001, 9_002],
					},
				}),
			),
		).toBeNull();
	});

	it("accepts a persisted no-retained Radarr proof after Plex drops the deleted movie", async () => {
		const fixture = makeDeps({ mediaPartCount: 1 });
		const context = createSharedPlexSafetyContext();
		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		const planned = context.plans.get(cleanupDeleteTargetKey(target));
		if (planned?.kind !== "verified_radarr") {
			throw new Error("Expected a verified Radarr safety plan");
		}
		const plan = parseExecutableSafetyPlan(serializeExecutableSafetyPlan(planned));
		if (plan?.kind !== "verified_radarr") {
			throw new Error("Expected a persisted verified Radarr safety plan");
		}
		expect(plan.ownership).toEqual([expect.objectContaining({ retained: [] })]);
		fixture.setLiveMovieFileId(undefined);
		fixture.getMovieMediaPartsByTmdbId.mockRejectedValue(new PlexMovieNotFoundError(42));

		await expect(
			assertVerifiedRadarrPeerOwnershipRetained(fixture.deps, "user-1", 101, plan),
		).resolves.toBeUndefined();
		expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
	});

	it("resumes a no-retained Radarr retry after Plex drops the deleted movie", async () => {
		const fixture = makeDeps({ mediaPartCount: 1 });
		const storedRetry = approvalRecord({
			status: "retry_pending",
			executionToken: null,
		}) as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedRetry);
		fixture.setLiveMovieFileId(undefined);
		fixture.getMovieMediaPartsByTmdbId.mockRejectedValue(new PlexMovieNotFoundError(42));

		const result = await executeRetryItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 1, reconciled: 0, failed: 0, errors: [] });
		expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
		expect(fixture.deleteMovie).toHaveBeenCalledOnce();
		expect(fixture.deleteMovie).toHaveBeenCalledWith(101, {
			deleteFiles: false,
			addImportExclusion: false,
		});
		expect(storedRetry).toMatchObject({ status: "executed" });
	});

	it("keeps a retained-peer Radarr retry blocked when Plex drops the movie", async () => {
		const fixture = makeDeps();
		const peer = configureVerifiedRadarrPeer(fixture);
		const context = createSharedPlexSafetyContext();
		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_radarr") throw new Error("Expected a verified Radarr safety plan");
		expect(plan.ownership).toEqual([expect.objectContaining({ retained: [expect.any(Object)] })]);
		const storedRetry = approvalRecord({
			status: "retry_pending",
			executionToken: null,
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		}) as Record<string, unknown>;
		configureApprovalStore(fixture.deps, storedRetry);
		fixture.setLiveMovieFileId(undefined);
		fixture.getMovieMediaPartsByTmdbId.mockRejectedValue(new PlexMovieNotFoundError(42));

		const result = await executeRetryItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
		expect(storedRetry).toMatchObject({ status: "retry_pending" });
		expect(peer.peerClient.movieFile.delete).not.toHaveBeenCalled();
		expect(peer.peerClient.movie.delete).not.toHaveBeenCalled();
	});

	it.each(["queued", "direct"] as const)(
		"blocks %s fileless Radarr record deletion when a Plex notification appears after preflight",
		async (mode) => {
			const fixture = makeDeps({ initialMovieFileId: null, includePlexNotification: false });
			const appearingNotification = {
				implementation: "PlexServer",
				configContract: "PlexServerSettings",
				onMovieDelete: true,
				onMovieFileDelete: true,
				tags: [],
				fields: notificationFields({ mapFrom: "/movies-4k", mapTo: "/plex/movies-4k" }),
			};
			fixture.targetClient.notification.getAll
				.mockResolvedValueOnce([])
				.mockResolvedValue([appearingNotification]);

			if (mode === "queued") {
				vi.mocked(fixture.deps.prisma.libraryCleanupApproval.findMany).mockResolvedValue([
					approvalRecord({ safetySnapshot: radarrSafetySnapshot(null) }) as never,
				]);
				await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);
			} else {
				const flaggedItem = {
					cacheItem: {
						instanceId: "radarr-4k",
						arrItemId: 101,
						itemType: "movie",
						title: "Example Movie",
						year: 2024,
						hasFile: false,
						cachedAt: new Date("2026-07-27T12:05:00.000Z"),
						sizeOnDisk: 0n,
						data: JSON.stringify({
							_arrDashboardSource: {
								serviceFingerprint: radarrTargetIdentity.serviceFingerprint,
							},
							remoteIds: { tmdbId: 42 },
							path: "/movies-4k/Example Movie (2024)",
						}),
					},
					match: {
						ruleId: "rule-1",
						ruleName: "Fileless cleanup",
						reason: "Matched fileless cleanup rule",
						action: "delete",
					},
					rating: 8,
				} as never;
				await executeDirectRemoval(
					fixture.deps,
					{ id: "config-1", maxRemovalsPerRun: 10, rules: [] } as never,
					"user-1",
					[flaggedItem],
					1,
					1,
					Date.now(),
				);
			}

			expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
			expect(fixture.deleteMovie).not.toHaveBeenCalled();
		},
	);

	it("blocks queued execution when the retained Radarr peer file changes after planning", async () => {
		const fixture = makeDeps();
		const { peerClient, peerMovie } = configureVerifiedRadarrPeer(fixture);
		const context = createSharedPlexSafetyContext();
		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_radarr") throw new Error("Expected a verified Radarr safety plan");
		const storedApproval = approvalRecord({ safetySnapshot: serializeExecutableSafetyPlan(plan) });
		const updateApproval = configureApprovalStore(fixture.deps, storedApproval);
		const updateStoredApproval = updateApproval.getMockImplementation();
		if (!updateStoredApproval) throw new Error("Expected an approval store implementation");
		updateApproval.mockImplementation((async (args: {
			where: { status?: string };
			data: { reviewedAt?: Date };
		}) => {
			const result = await updateStoredApproval(args as never);
			if (args.data.reviewedAt && args.where.status === "executing") {
				peerClient.movieFile.getById.mockResolvedValue({
					...peerMovie,
					id: 2999,
					path: "/downloads-hd/Example Movie (2024)/Example.Movie.Replacement.mkv",
					size: 1_100,
				});
			}
			return result;
		}) as never);

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);
		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("ownership changed");
		expect(fixture.deleteMovieFile).not.toHaveBeenCalled();
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
		expect(peerClient.movie.delete).not.toHaveBeenCalled();
		expect(peerClient.movieFile.delete).not.toHaveBeenCalled();
	});

	it("retains the queued Radarr record when its Plex notification mapping changes after file deletion", async () => {
		const fixture = makeDeps({ onMovieDelete: true, onMovieFileDelete: true });
		const { peerClient } = configureVerifiedRadarrPeer(fixture);
		const originalNotifications = await fixture.targetClient.notification.getAll();
		const context = createSharedPlexSafetyContext();
		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_radarr") throw new Error("Expected a verified Radarr safety plan");
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
					fields: notificationFields({ mapFrom: "/movies-4k", mapTo: "/changed-plex-root" }),
				})),
			);
		});

		const result = await executeApprovedItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
		expect(result.errors[0]).toContain("Partial cleanup");
		expect(peerClient.movie.delete).not.toHaveBeenCalled();
		expect(peerClient.movieFile.delete).not.toHaveBeenCalled();
	});

	it("retains the direct Radarr record when a new unowned Plex part appears after file deletion", async () => {
		const fixture = makeDeps();
		const { peerClient } = configureVerifiedRadarrPeer(fixture);
		const deleteSelectedFile = fixture.deleteMovieFile.getMockImplementation();
		if (!deleteSelectedFile) throw new Error("Expected a target file delete implementation");
		fixture.deleteMovieFile.mockImplementation(async (movieFileId) => {
			await deleteSelectedFile(movieFileId);
			fixture.getMovieMediaPartsByTmdbId.mockResolvedValue([
				{
					ratingKey: "plex-movie-42",
					parts: [
						{ file: "/plex/movies-hd/Example Movie (2024)/Example.Movie.1080p.mkv", size: 1_000 },
						{
							file: "/plex/movies-remux/Example Movie (2024)/Example.Movie.Remux.mkv",
							size: 3_000,
						},
					],
				},
			]);
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
				reason: "Matched 4K profile",
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

		expect(result).toMatchObject({ status: "partial", itemsRemoved: 0, itemsFilesDeleted: 1 });
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
		expect(peerClient.movie.delete).not.toHaveBeenCalled();
		expect(peerClient.movieFile.delete).not.toHaveBeenCalled();
	});

	it("retains a retrying Radarr record when its retained peer disappears after file deletion", async () => {
		const fixture = makeDeps();
		const { peerClient } = configureVerifiedRadarrPeer(fixture);
		const context = createSharedPlexSafetyContext();
		expect(await findSharedPlexDeleteBlocks(fixture.deps, "user-1", [target], context)).toEqual(
			new Map(),
		);
		const plan = context.plans.get(cleanupDeleteTargetKey(target));
		if (plan?.kind !== "verified_radarr") throw new Error("Expected a verified Radarr safety plan");
		const storedApproval = approvalRecord({
			status: "retry_pending",
			safetySnapshot: serializeExecutableSafetyPlan(plan),
		});
		configureApprovalStore(fixture.deps, storedApproval);
		const deleteSelectedFile = fixture.deleteMovieFile.getMockImplementation();
		if (!deleteSelectedFile) throw new Error("Expected a target file delete implementation");
		fixture.deleteMovieFile.mockImplementation(async (movieFileId) => {
			await deleteSelectedFile(movieFileId);
			peerClient.movie.getAll.mockResolvedValue([]);
		});

		const result = await executeRetryItems(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
		expect(storedApproval).toMatchObject({ status: "retry_pending" });
		expect(peerClient.movie.delete).not.toHaveBeenCalled();
		expect(peerClient.movieFile.delete).not.toHaveBeenCalled();
	});

	it("retains a Radarr record when its peer changes during post-file Plex verification", async () => {
		const fixture = makeDeps();
		const peer = configureVerifiedRadarrPeer(fixture);
		let plexLookups = 0;
		fixture.getMovieMediaPartsByTmdbId.mockImplementation(async () => {
			plexLookups++;
			if (plexLookups === 3) peer.peerClient.movie.getAll.mockResolvedValue([]);
			return [
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
				reason: "Matched 4K profile",
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

		expect(plexLookups).toBe(3);
		expect(result).toMatchObject({ status: "partial", itemsRemoved: 0, itemsFilesDeleted: 1 });
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
	});

	it("retains a Radarr record when target notifications change during post-file Plex verification", async () => {
		const fixture = makeDeps({ onMovieDelete: true, onMovieFileDelete: true });
		configureVerifiedRadarrPeer(fixture);
		const initialNotifications = await fixture.targetClient.notification.getAll();
		fixture.targetClient.notification.getAll.mockClear();
		fixture.targetClient.notification.getAll.mockResolvedValue(initialNotifications);
		let plexLookups = 0;
		fixture.getMovieMediaPartsByTmdbId.mockImplementation(async () => {
			plexLookups++;
			if (plexLookups === 3) {
				fixture.targetClient.notification.getAll.mockResolvedValue(
					initialNotifications.map((notification: Record<string, unknown>) => ({
						...notification,
						fields: notificationFields({
							mapFrom: "/movies-4k",
							mapTo: "/changed-after-file-delete",
						}),
					})),
				);
			}
			return [
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
				reason: "Matched 4K profile",
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

		expect(plexLookups).toBe(3);
		expect(result).toMatchObject({ status: "partial", itemsRemoved: 0, itemsFilesDeleted: 1 });
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).not.toHaveBeenCalled();
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
		const { deps, deleteMovie, deleteMovieFile, targetClient, getMovieMediaPartsByTmdbId } =
			makeDeps({
				mediaPartCount: 1,
			});
		const originalMovie = {
			id: 101,
			tmdbId: 42,
			title: "Example Movie",
			tags: [],
			hasFile: true,
			movieFileId: 1001,
			path: "/movies-4k/Example Movie (2024)",
			rootFolderPath: "/movies-4k",
		};
		targetClient.movie.getById.mockResolvedValue(originalMovie);
		getMovieMediaPartsByTmdbId.mockImplementation(async () => {
			targetClient.movie.getById.mockResolvedValue({
				...originalMovie,
				movieFileId: 1002,
			});
			return [
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

	it("accepts the exact Radarr file identity serialized by the production movie normalizer", async () => {
		const fixture = makeDeps({ mediaPartCount: 1 });
		const normalized = buildMovieItem(fixture.targetInstance as never, "radarr", {
			id: 101,
			tmdbId: 42,
			title: "Example Movie",
			hasFile: true,
			movieFileId: 1001,
			path: "/movies-4k/Example Movie (2024)",
			movieFile: {
				id: 1001,
				relativePath: "Example.Movie.2160p.mkv",
				size: 2_000,
			},
		});
		const flaggedItem = {
			cacheItem: {
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				year: 2024,
				hasFile: true,
				cachedAt: new Date("2026-07-27T12:05:00.000Z"),
				data: JSON.stringify({
					...normalized,
					_arrDashboardSource: {
						serviceFingerprint: radarrTargetIdentity.serviceFingerprint,
					},
				}),
				sizeOnDisk: 2_000n,
			},
			match: {
				ruleId: "rule-1",
				ruleName: "4K cleanup",
				reason: "Matched normalized cache file",
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

		expect(result).toMatchObject({ status: "completed", itemsRemoved: 1 });
		expect(fixture.deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(fixture.deleteMovie).toHaveBeenCalledOnce();
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
		targetClient.movie.getById.mockImplementation(async () =>
			deleteMovieFile.mock.calls.length === 0
				? movie
				: { ...movie, hasFile: false, movieFileId: 1001 },
		);
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
			itemsSkipped: 1,
			details: [expect.objectContaining({ reason: expect.stringContaining("already executing") })],
		});
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledTimes(2);
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
			itemsSkipped: 1,
			details: [
				expect.objectContaining({ reason: expect.stringContaining("another cleanup run claimed") }),
			],
		});
		expect(deferredResult.warnings).toContainEqual(
			expect.stringContaining("another cleanup run claimed it first"),
		);
		expect(deferredResult.warnings).not.toContainEqual(expect.stringContaining("remains pending"));
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledTimes(2);
	});

	it("does not let a safety-blocked retry consume the fresh mutation budget", async () => {
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
			orderBy: [{ reviewedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
			take: 1,
		});
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(targetClient.movie.update).toHaveBeenCalledWith(
			102,
			expect.objectContaining({ monitored: false }),
		);
		expect(result).toMatchObject({
			status: "partial",
			itemsFlagged: 2,
			itemsUnmonitored: 1,
			itemsSkipped: 1,
		});
		expect(result.warnings).toContainEqual(expect.stringContaining("retry remains"));
	});

	it("fills a freed retry slot from candidates beyond the initial run limit", async () => {
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
		expect(targetClient.movie.update).toHaveBeenCalledWith(
			102,
			expect.objectContaining({ monitored: false }),
		);
		expect(result).toMatchObject({
			status: "partial",
			itemsFlagged: 2,
			itemsUnmonitored: 1,
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
		expect(targetClient.movie.update).toHaveBeenCalledTimes(1);
		expect(targetClient.movie.update).toHaveBeenCalledWith(
			103,
			expect.objectContaining({ monitored: false }),
		);
		expect(retries[1]).toMatchObject({ id: "approval-2", status: "retry_pending" });
		expect(result).toMatchObject({
			status: "partial",
			itemsUnmonitored: 1,
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
			safetySnapshot: radarrSafetySnapshot(),
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
			itemsFlagged: 2,
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
			itemsSkipped: 1,
			details: [expect.objectContaining({ reason: expect.stringContaining("after claiming it") })],
		});
		expect(deferredResult.warnings).toContainEqual(
			expect.stringContaining("post-claim read failure"),
		);
		expect(retries[0]).toMatchObject({ status: "retry_pending" });
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledTimes(2);
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
				status: "partial",
				itemsFlagged: 0,
				itemsRemoved: 0,
				itemsFilesDeleted: 0,
				itemsSkipped: 1,
				warnings: [expect.stringContaining("whole number from 1 through 100")],
			});
			expect(deleteMovieFile).not.toHaveBeenCalled();
			expect(deleteMovie).not.toHaveBeenCalled();
		},
	);

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
		expect(deps.prisma.libraryCleanupApproval.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ id: "approval-1", status: "executing" }),
			data: expect.objectContaining({
				status: "pending",
				lastExecutionError: expect.stringContaining("movie record could not be removed"),
				safetySnapshot: radarrSafetySnapshot(),
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
			safetySnapshot: radarrSafetySnapshot(),
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
			safetySnapshot: radarrSafetySnapshot(),
			lastExecutionError: null,
		});
		expect(
			approvalUpdate.mock.invocationCallOrder[
				approvalUpdate.mock.calls.findIndex((call) => call[0].data.safetySnapshot)
			],
		).toBeLessThan(deleteMovie.mock.invocationCallOrder[0]!);
	});

	it("explicitly resumes a durable retry while safer cleanup modes are enabled", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const storedRetry = approvalRecord({
			status: "retry_pending",
			executionToken: null,
		}) as Record<string, unknown>;
		configureApprovalStore(deps, storedRetry);
		vi.mocked(deps.prisma.libraryCleanupConfig.findUnique).mockResolvedValue({
			id: "config-1",
			dryRunMode: true,
			requireApproval: true,
		} as never);

		const result = await executeRetryItems(deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 1, reconciled: 0, failed: 0, errors: [] });
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).toHaveBeenCalledOnce();
		expect(storedRetry).toMatchObject({ status: "executed", executionToken: null });
	});

	it("rechecks deployed exemptions before executing an approved mutation", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const storedApproval = approvalRecord() as Record<string, unknown>;
		configureApprovalStore(deps, storedApproval);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			deployedCleanupExemption({
				version: 1,
				root: {
					kind: "year_range",
					params: { operator: "before", year: 2030 },
				},
			}),
		] as never);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toEqual({
			removed: 0,
			failed: 1,
			errors: [
				"Skipped for safety: current deployed cleanup exemption policy covers this ARR target.",
			],
		});
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(storedApproval).toMatchObject({
			status: "pending",
			executionToken: null,
			lastExecutionError:
				"Skipped for safety: current deployed cleanup exemption policy covers this ARR target.",
		});
	});

	it("evaluates execution-time exemptions from the live ARR resource", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({
			mediaPartCount: 1,
			movieTags: [99],
		});
		const storedApproval = approvalRecord() as Record<string, unknown>;
		configureApprovalStore(deps, storedApproval);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			deployedCleanupExemption({
				version: 1,
				root: {
					kind: "tag_match",
					params: { operator: "includes_any", tagIds: [99] },
				},
			}),
		] as never);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("deployed cleanup exemption policy");
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(storedApproval).toMatchObject({ status: "pending" });
	});

	it("normalizes live Radarr media info before evaluating an HDR exemption", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({
			mediaPartCount: 1,
			movieFile: {
				mediaInfo: {
					videoCodec: "x265",
					audioCodec: "EAC3",
					resolution: "3840x2160",
					videoDynamicRange: "HDR10",
				},
			},
		});
		const storedApproval = approvalRecord() as Record<string, unknown>;
		configureApprovalStore(deps, storedApproval);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			deployedCleanupExemption({
				version: 1,
				root: {
					kind: "hdr_type",
					params: { operator: "is", types: ["HDR10"] },
				},
			}),
		] as never);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("deployed cleanup exemption policy");
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(storedApproval).toMatchObject({ status: "pending" });
	});

	it("allows a Radarr mutation when normalized live HDR metadata does not match", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({
			mediaPartCount: 1,
			movieFile: {
				mediaInfo: {
					videoCodec: "x265",
					audioCodec: "EAC3",
					resolution: "3840x2160",
					videoDynamicRange: "HDR10",
				},
			},
		});
		const storedApproval = approvalRecord() as Record<string, unknown>;
		configureApprovalStore(deps, storedApproval);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			deployedCleanupExemption({
				version: 1,
				root: {
					kind: "hdr_type",
					params: { operator: "is", types: ["Dolby Vision"] },
				},
			}),
		] as never);

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toEqual({ removed: 1, failed: 0, errors: [] });
		expect(deleteMovieFile).toHaveBeenCalledWith(1001);
		expect(deleteMovie).toHaveBeenCalledWith(101, {
			deleteFiles: false,
			addImportExclusion: false,
		});
		expect(storedApproval).toMatchObject({ status: "executed" });
	});

	it("stops between file and record deletion when the cleanup mutation lease is lost", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const storedApproval = approvalRecord() as Record<string, unknown>;
		configureApprovalStore(deps, storedApproval);
		const originalDeleteMovieFile = deleteMovieFile.getMockImplementation()!;
		deleteMovieFile.mockImplementationOnce(async (...args) => {
			await originalDeleteMovieFile(...args);
			vi.mocked(deps.prisma.libraryCleanupConfig.updateMany).mockResolvedValue({ count: 0 });
		});

		const result = await executeApprovedItems(deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.errors[0]).toContain("execution authority was lost");
		expect(deleteMovieFile).toHaveBeenCalledOnce();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(storedApproval).toMatchObject({
			status: "pending",
			executionToken: null,
			safetySnapshot: radarrSafetySnapshot(),
			lastExecutionError: expect.stringContaining("execution authority was lost"),
		});
	});

	it("rechecks deployed exemptions before resuming a durable retry mutation", async () => {
		const { deps, deleteMovie, deleteMovieFile } = makeDeps({ mediaPartCount: 1 });
		const storedRetry = approvalRecord({
			status: "retry_pending",
			executionToken: null,
		}) as Record<string, unknown>;
		configureApprovalStore(deps, storedRetry);
		vi.mocked(deps.prisma.crossDomainRule.findMany).mockResolvedValue([
			deployedCleanupExemption({
				version: 1,
				root: {
					kind: "year_range",
					params: { operator: "before", year: 2030 },
				},
			}),
		] as never);

		const result = await executeRetryItems(deps, "user-1", ["approval-1"]);

		expect(result).toEqual({
			removed: 0,
			reconciled: 0,
			failed: 1,
			errors: [
				"Skipped for safety: current deployed cleanup exemption policy covers this ARR target.",
			],
		});
		expect(deleteMovieFile).not.toHaveBeenCalled();
		expect(deleteMovie).not.toHaveBeenCalled();
		expect(storedRetry).toMatchObject({
			status: "expired",
			executionToken: null,
			lastExecutionError:
				"Skipped for safety: current deployed cleanup exemption policy covers this ARR target.",
		});
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
			safetySnapshot: radarrSafetySnapshot(),
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
			itemsFlagged: 1,
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
});
