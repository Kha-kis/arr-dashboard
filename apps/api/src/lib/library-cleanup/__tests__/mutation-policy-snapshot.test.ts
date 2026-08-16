import { describe, expect, it, vi } from "vitest";
import {
	evaluateItemMutationPolicyStateViaEngine,
	evaluateRuleViaEngine,
} from "../../rules/cleanup-adapter.js";
import { deriveArrPolicyEvidence } from "../arr-policy-evidence.js";
import { executeDirectRemoval } from "../cleanup-executor.js";
import { createArrServiceFingerprint } from "../shared-plex-safety.js";
import type { CleanupExecutorDeps } from "../types.js";

vi.mock("../cleanup-audit.js", () => ({
	appendCleanupAuditEvent: vi.fn().mockResolvedValue({}),
	appendCleanupTerminalAuditEvent: vi.fn().mockResolvedValue({}),
	createCleanupTerminalAuditState: vi.fn(
		(input: {
			actorId?: string | null;
			actorType: string;
			correlationId: string;
			eventType: string;
			outcome: string;
			summary?: { reason?: string };
			trigger: string;
		}) => ({
			terminalAuditCorrelationId: input.correlationId,
			terminalAuditEventType: input.eventType,
			terminalAuditOutcome: input.outcome,
			terminalAuditActorType: input.actorType,
			terminalAuditActorId: input.actorId ?? null,
			terminalAuditTrigger: input.trigger,
			terminalAuditReason: input.summary?.reason ?? null,
			terminalAuditRecordedAt: null,
		}),
	),
	createCleanupAuditEventKey: vi.fn(
		(input: { actionId: string; correlationId: string; eventType: string }) =>
			`${input.eventType}:${input.actionId}:${input.correlationId}`,
	),
}));

type Service = "RADARR" | "SONARR";

function cleanupRule(overrides: Record<string, unknown> = {}) {
	return {
		id: "rule-age",
		configId: "config-1",
		name: "Old items",
		enabled: true,
		priority: 10,
		ruleType: "age",
		parameters: JSON.stringify({ field: "arrAddedAt", operator: "older_than", days: 30 }),
		operator: null,
		conditions: null,
		serviceFilter: null,
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		action: "unmonitor",
		retentionMode: false,
		useGlobalRejectionMemory: true,
		rejectionMemoryDays: 0,
		createdAt: new Date("2026-08-01T00:00:00.000Z"),
		updatedAt: new Date("2026-08-01T00:00:00.000Z"),
		...overrides,
	};
}

function cleanupConfig(rules = [cleanupRule()], overrides: Record<string, unknown> = {}) {
	return {
		id: "config-1",
		userId: "user-1",
		enabled: true,
		intervalHours: 24,
		lastRunAt: new Date("2026-08-01T00:00:00.000Z"),
		nextRunAt: new Date("2026-08-02T00:00:00.000Z"),
		dryRunMode: false,
		maxRemovalsPerRun: 10,
		requireApproval: false,
		runClaimToken: "run-1",
		runClaimedAt: new Date("2026-08-01T00:00:00.000Z"),
		respectQuiSeeding: false,
		rejectionMemoryDays: 0,
		createdAt: new Date("2026-08-01T00:00:00.000Z"),
		updatedAt: new Date("2026-08-01T00:00:00.000Z"),
		rules,
		...overrides,
	};
}

function makeFixture(
	service: Service,
	action: "delete" | "unmonitor" = "unmonitor",
	ruleOverrides: Record<string, unknown> = {},
) {
	const instance = {
		id: `${service.toLowerCase()}-1`,
		userId: "user-1",
		service,
		label: service === "RADARR" ? "Radarr" : "Sonarr",
		baseUrl: `http://${service.toLowerCase()}.test`,
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		enabled: true,
		createdAt: new Date("2026-08-01T00:00:00.000Z"),
		updatedAt: new Date("2026-08-01T00:00:00.000Z"),
	};
	const rule = cleanupRule({ action, ...ruleOverrides });
	const config = cleanupConfig([rule]);
	let liveConfig = config;
	let currentInstance = instance;
	let hasFile = action === "delete";
	let recordExists = true;
	const movie = {
		id: 101,
		tmdbId: 42,
		title: "Example Movie",
		path: "/movies/Example Movie",
		monitored: true,
		qualityProfileId: 1,
		hasFile,
		sizeOnDisk: 2_000,
		movieFileId: 1001 as number | undefined,
		movieFile: { id: 1001, path: "/movies/Example Movie/example.mkv", size: 2_000 } as
			| { id: number; path: string; size: number }
			| undefined,
		added: "2020-01-01T00:00:00.000Z",
		statistics: { movieFileCount: 1, sizeOnDisk: 2_000 },
	};
	const series = {
		id: 101,
		tvdbId: 42,
		title: "Example Series",
		path: "/series/Example Series",
		monitored: true,
		qualityProfileId: 1,
		added: "2020-01-01T00:00:00.000Z",
	};
	const markMovieFileDeleted = () => {
		hasFile = false;
		movie.hasFile = false;
		movie.sizeOnDisk = 0;
		movie.movieFileId = undefined;
		movie.movieFile = undefined;
		movie.statistics = { movieFileCount: 0, sizeOnDisk: 0 };
	};
	const deleteMovieFile = vi.fn(async () => {
		markMovieFileDeleted();
	});
	const deleteMovie = vi.fn(async () => {
		recordExists = false;
	});
	const updateMovie = vi.fn();
	const updateSeries = vi.fn();
	const radarrClient = {
		movie: {
			getById: vi.fn(async () => {
				if (!recordExists) throw new Error("not found");
				return movie;
			}),
			delete: deleteMovie,
			update: updateMovie,
		},
		movieFile: { getById: vi.fn(async () => movie.movieFile), delete: deleteMovieFile },
		qualityProfile: { getById: vi.fn(async () => ({ id: 1, name: "Default" })) },
		notification: { getAll: vi.fn().mockResolvedValue([]) },
	};
	const sonarrClient = {
		series: {
			getById: vi.fn(async () => series),
			getAll: vi.fn(async () => [series]),
			update: updateSeries,
			delete: vi.fn(),
		},
		episode: { getAll: vi.fn(), setMonitored: vi.fn() },
		episodeFile: { getBySeries: vi.fn(), bulkDelete: vi.fn() },
		qualityProfile: { getById: vi.fn(async () => ({ id: 1, name: "Default" })) },
		notification: { getAll: vi.fn().mockResolvedValue([]) },
	};
	const sourceFingerprint = createArrServiceFingerprint(instance as never);
	const cacheItem = {
		id: "cache-1",
		instanceId: instance.id,
		arrItemId: 101,
		itemType: service === "RADARR" ? "movie" : "series",
		title: service === "RADARR" ? movie.title : series.title,
		year: 2020,
		monitored: true,
		hasFile: action === "delete",
		status: "released",
		qualityProfileId: 1,
		qualityProfileName: "Default",
		sizeOnDisk: 2_000n,
		arrAddedAt: new Date("2020-01-01T00:00:00.000Z"),
		cachedAt: new Date("2026-08-02T00:00:00.000Z"),
		data: JSON.stringify({
			_arrDashboardSource: { serviceFingerprint: sourceFingerprint },
			path: service === "RADARR" ? movie.path : series.path,
			remoteIds: service === "RADARR" ? { tmdbId: 42 } : { tvdbId: 42 },
			...(service === "RADARR" ? { movieFile: movie.movieFile, hasFile: action === "delete" } : {}),
		}),
	};
	const deps = {
		prisma: {
			libraryCleanupConfig: { findUnique: vi.fn(async () => liveConfig) },
			serviceInstance: {
				findFirst: vi.fn(async () => currentInstance),
				findMany: vi.fn(async () => [instance]),
			},
			libraryCleanupLog: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
			libraryCleanupApproval: {
				findMany: vi.fn().mockResolvedValue([]),
				create: vi.fn().mockResolvedValue({}),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			libraryCache: {
				findFirst: vi.fn().mockResolvedValue(cacheItem),
				deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			crossDomainRule: { findMany: vi.fn().mockResolvedValue([]) },
		} as unknown as CleanupExecutorDeps["prisma"],
		arrClientFactory: {
			create: vi.fn(() => (service === "RADARR" ? radarrClient : sonarrClient)),
		} as unknown as CleanupExecutorDeps["arrClientFactory"],
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as CleanupExecutorDeps["log"],
	} satisfies CleanupExecutorDeps;
	deps.prisma.$transaction = vi.fn(
		async (callback) => await callback(deps.prisma as never),
	) as never;
	const flagged = {
		cacheItem,
		match: { ruleId: rule.id, ruleName: rule.name, reason: "Matched", action },
		rating: null,
	};

	return {
		deps,
		instance,
		config,
		flagged,
		movie,
		series,
		deleteMovieFile,
		deleteMovie,
		updateMovie,
		updateSeries,
		radarrQualityProfileGetById: radarrClient.qualityProfile.getById,
		sonarrQualityProfileGetById: sonarrClient.qualityProfile.getById,
		radarrGetById: radarrClient.movie.getById,
		sonarrGetById: sonarrClient.series.getById,
		markMovieFileDeleted,
		setCurrentInstance: (next: typeof instance) => {
			currentInstance = next;
		},
		setLiveConfig: (next: typeof config) => {
			liveConfig = next;
		},
	};
}

async function runDirect(fixture: ReturnType<typeof makeFixture>) {
	return await executeDirectRemoval(
		fixture.deps,
		fixture.config as never,
		"user-1",
		[fixture.flagged] as never,
		1,
		1,
		Date.now(),
	);
}

describe("execution-time cleanup policy authority", () => {
	it.each([
		["configuration", "RADARR", cleanupConfig([cleanupRule()], { enabled: false })],
		["configuration", "SONARR", cleanupConfig([cleanupRule()], { enabled: false })],
		["rule", "RADARR", cleanupConfig([cleanupRule({ action: "delete" })])],
		["rule", "SONARR", cleanupConfig([cleanupRule({ action: "delete" })])],
	] as const)(
		"blocks a changed cleanup %s fingerprint before %s unmonitoring",
		async (_change, service, changedConfig) => {
			const fixture = makeFixture(service);
			fixture.setLiveConfig(changedConfig);

			const result = await runDirect(fixture);

			expect(result.itemsUnmonitored).toBe(0);
			expect(
				service === "RADARR" ? fixture.updateMovie : fixture.updateSeries,
			).not.toHaveBeenCalled();
		},
	);

	it.each(["RADARR", "SONARR"] as const)(
		"rechecks the %s instance fingerprint after the final live policy read",
		async (service) => {
			const fixture = makeFixture(service);
			const repoint = () =>
				fixture.setCurrentInstance({
					...fixture.instance,
					baseUrl: `http://replacement-${service.toLowerCase()}.test`,
					updatedAt: new Date("2026-08-14T00:00:00.000Z"),
				});
			if (service === "RADARR") {
				const originalGetById = fixture.radarrGetById.getMockImplementation();
				if (!originalGetById) throw new Error("Expected a live Radarr lookup implementation");
				fixture.radarrGetById.mockImplementation(async () => {
					const result = await originalGetById();
					if (fixture.radarrGetById.mock.calls.length >= 2) repoint();
					return result;
				});
			} else {
				const originalGetById = fixture.sonarrGetById.getMockImplementation();
				if (!originalGetById) throw new Error("Expected a live Sonarr lookup implementation");
				fixture.sonarrGetById.mockImplementation(async () => {
					const result = await originalGetById();
					if (fixture.sonarrGetById.mock.calls.length >= 2) repoint();
					return result;
				});
			}

			const result = await runDirect(fixture);

			expect(result.itemsUnmonitored).toBe(0);
			expect(
				service === "RADARR" ? fixture.updateMovie : fixture.updateSeries,
			).not.toHaveBeenCalled();
		},
	);

	it.each(["RADARR", "SONARR"] as const)(
		"re-evaluates live ARR state against the matched rule before %s unmonitoring",
		async (service) => {
			const fixture = makeFixture(service);
			if (service === "RADARR") fixture.movie.added = "2026-08-14T00:00:00.000Z";
			else fixture.series.added = "2026-08-14T00:00:00.000Z";

			const result = await runDirect(fixture);

			expect(result.itemsUnmonitored).toBe(0);
			expect(
				service === "RADARR" ? fixture.updateMovie : fixture.updateSeries,
			).not.toHaveBeenCalled();
		},
	);

	it.each(["RADARR", "SONARR"] as const)(
		"updates %s from the exact full resource accepted by final policy authorization",
		async (service) => {
			const fixture = makeFixture(service);
			let latestPolicyRevision = 0;
			let updateUsedLatestPolicyRevision = false;
			const getById = service === "RADARR" ? fixture.radarrGetById : fixture.sonarrGetById;
			const source = service === "RADARR" ? fixture.movie : fixture.series;
			getById.mockImplementation(async () => {
				latestPolicyRevision += 1;
				return { ...source, policyRevision: latestPolicyRevision } as never;
			});
			const update = service === "RADARR" ? fixture.updateMovie : fixture.updateSeries;
			update.mockImplementation(async (_id, payload) => {
				updateUsedLatestPolicyRevision =
					(payload as { policyRevision?: number }).policyRevision === latestPolicyRevision;
			});

			const result = await runDirect(fixture);

			expect(result.itemsUnmonitored).toBe(1);
			expect(update).toHaveBeenCalledOnce();
			expect(updateUsedLatestPolicyRevision).toBe(true);
		},
	);

	it.each(["RADARR", "SONARR"] as const)(
		"resolves the live %s quality profile before applying a quality-profile policy",
		async (service) => {
			const fixture = makeFixture(service, "unmonitor", {
				id: "rule-quality-profile",
				name: "Default profile",
				ruleType: "quality_profile",
				parameters: JSON.stringify({ operator: "is", profileNames: ["Default"] }),
			});

			const result = await runDirect(fixture);

			expect(result.itemsUnmonitored).toBe(1);
			expect(
				service === "RADARR"
					? fixture.radarrQualityProfileGetById
					: fixture.sonarrQualityProfileGetById,
			).toHaveBeenCalledWith(1);
			expect(
				service === "RADARR" ? fixture.updateMovie : fixture.updateSeries,
			).toHaveBeenCalledOnce();
		},
	);

	it.each([
		["bookkeeping", false],
		["policy", true],
	] as const)(
		"permits only unrelated state changes between Radarr file and record writes (%s)",
		async (_kind, shouldBlockRecordDelete) => {
			const fixture = makeFixture("RADARR", "delete");
			fixture.deleteMovieFile.mockImplementationOnce(async () => {
				fixture.markMovieFileDeleted();
				fixture.setLiveConfig(
					shouldBlockRecordDelete
						? cleanupConfig([cleanupRule({ action: "delete" })], { maxRemovalsPerRun: 1 })
						: cleanupConfig([cleanupRule({ action: "delete" })], {
								lastRunAt: new Date("2026-08-03T00:00:00.000Z"),
								nextRunAt: new Date("2026-08-04T00:00:00.000Z"),
								runClaimToken: null,
								runClaimedAt: null,
							}),
				);
			});

			const result = await runDirect(fixture);

			expect(fixture.deleteMovieFile).toHaveBeenCalledOnce();
			if (shouldBlockRecordDelete) {
				expect(result.itemsRemoved).toBe(0);
				expect(fixture.deleteMovie).not.toHaveBeenCalled();
			} else {
				expect(result.itemsRemoved).toBe(1);
				expect(fixture.deleteMovie).toHaveBeenCalledOnce();
			}
		},
	);
});

function mutationEvidenceRule(
	ruleType: string,
	parameters: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
) {
	return cleanupRule({
		id: `rule-${ruleType}`,
		ruleType,
		parameters: JSON.stringify(parameters),
		action: "delete",
		...overrides,
	});
}

function mutationEvidenceItem(data: Record<string, unknown>) {
	return {
		id: "live:radarr-1:movie:101",
		instanceId: "radarr-1",
		arrItemId: 101,
		itemType: "movie",
		title: "Example Movie",
		year: 2020,
		monitored: true,
		hasFile: true,
		status: "released",
		qualityProfileId: 1,
		qualityProfileName: "Default",
		sizeOnDisk: 2_000n,
		arrAddedAt: new Date("2020-01-01T00:00:00.000Z"),
		cachedAt: new Date(),
		data: JSON.stringify({ remoteIds: { tmdbId: 42 }, ...data }),
		infoHash: null,
		torrentState: null,
	} as const;
}

describe("mutation policy evidence authority", () => {
	it("uses the same nested positive expression for preview and mutation authorization", () => {
		const expression = {
			version: 1,
			root: {
				all: [
					{ kind: "year_range", params: { operator: "before", year: 2030 } },
					{
						any: [
							{ kind: "year_range", params: { operator: "after", year: 2010 } },
							{ kind: "year_range", params: { operator: "before", year: 2000 } },
						],
					},
				],
			},
		};
		const rule = mutationEvidenceRule(
			"composite",
			{},
			{
				id: "rule-recursive",
				operator: null,
				conditions: JSON.stringify(expression),
			},
		);
		const item = mutationEvidenceItem({ _arrDashboardEvidence: {} });
		const context = { now: new Date() };

		expect(evaluateRuleViaEngine(item as never, rule as never, "RADARR", context)).toMatchObject({
			ruleId: "rule-recursive",
		});
		expect(
			evaluateItemMutationPolicyStateViaEngine(item as never, [rule] as never, "RADARR", context),
		).toMatchObject({ kind: "cleanup", match: { ruleId: "rule-recursive" } });
	});

	it("fails closed when a nested expression depends on a failed provider", () => {
		const rule = mutationEvidenceRule(
			"composite",
			{},
			{
				id: "rule-recursive-plex",
				operator: null,
				conditions: JSON.stringify({
					version: 1,
					root: {
						all: [
							{ kind: "year_range", params: { operator: "before", year: 2030 } },
							{ kind: "plex_watch_count", params: { operator: "less_than", count: 1 } },
						],
					},
				}),
			},
		);
		const context = {
			now: new Date(),
			plexMap: new Map([
				[
					"movie:42",
					{
						lastWatchedAt: null,
						watchCount: 0,
						watchedByUsers: [],
						onDeck: false,
						userRating: null,
						collections: [],
						labels: [],
						addedAt: null,
						sections: [],
					},
				],
			]),
		};

		expect(
			evaluateItemMutationPolicyStateViaEngine(
				mutationEvidenceItem({ _arrDashboardEvidence: {} }) as never,
				[rule] as never,
				"RADARR",
				context,
				new Set(["plex"]),
			),
		).toEqual({ kind: "unknown", ruleId: "rule-recursive-plex" });
	});

	it.each([
		["missing source", { ratings: {} }],
		["zero sentinel", { ratings: { tmdb: { value: 0 }, imdb: { value: 0 } } }],
	] as const)("does not treat Radarr %s ratings as authoritative", (_label, raw) => {
		const evidence = deriveArrPolicyEvidence("radarr", raw as Record<string, unknown>);

		expect(evidence.rating).toBe(false);
		expect(evidence.imdbRating).toBe(false);
	});

	it("accepts explicit positive Radarr ratings", () => {
		const evidence = deriveArrPolicyEvidence("radarr", {
			ratings: { tmdb: { value: 7.5 }, imdb: { value: 8.1 } },
		});

		expect(evidence.rating).toBe(true);
		expect(evidence.imdbRating).toBe(true);
	});

	it.each(["tmdb_list_member", "trakt_list_member"])(
		"fails closed for %s without a complete fresh list snapshot",
		(ruleType) => {
			const identifierKey = ruleType === "tmdb_list_member" ? "listId" : "listSlug";
			const context =
				ruleType === "tmdb_list_member"
					? { now: new Date(), tmdbListMemberships: new Map<string, Set<number>>() }
					: { now: new Date(), traktListMemberships: new Map<string, Set<number>>() };
			const result = evaluateItemMutationPolicyStateViaEngine(
				mutationEvidenceItem({ _arrDashboardEvidence: {} }) as never,
				[
					mutationEvidenceRule(ruleType, {
						operator: "not_in",
						[identifierKey]: "example-list",
					}),
				] as never,
				"RADARR",
				context,
			);

			expect(result).toEqual({ kind: "unknown", ruleId: `rule-${ruleType}` });
		},
	);

	it("preserves a matching v0 retention rule with 64 conditions", () => {
		const conditions = Array.from({ length: 64 }, () => ({
			ruleType: "year_range",
			parameters: { operator: "before", year: 2030 },
		}));
		const retentionRule = mutationEvidenceRule(
			"composite",
			{},
			{
				id: "rule-retain-64",
				priority: 1,
				retentionMode: true,
				operator: "AND",
				conditions: JSON.stringify(conditions),
			},
		);
		const deleteRule = mutationEvidenceRule("year_range", {
			operator: "before",
			year: 2030,
		});

		const result = evaluateItemMutationPolicyStateViaEngine(
			mutationEvidenceItem({ _arrDashboardEvidence: {} }) as never,
			[deleteRule, retentionRule] as never,
			"RADARR",
			{ now: new Date() },
		);

		expect(result).toEqual({
			kind: "retained",
			ruleId: "rule-retain-64",
			evidence: "true",
		});
	});

	it("authorizes hdr_type only when the dynamic-range field was explicit", () => {
		const rule = mutationEvidenceRule("hdr_type", { operator: "is", types: ["HDR10"] });
		const explicit = evaluateItemMutationPolicyStateViaEngine(
			mutationEvidenceItem({
				movieFile: { videoDynamicRange: "HDR10" },
				_arrDashboardEvidence: { hasFile: true, hdrType: true },
			}) as never,
			[rule] as never,
			"RADARR",
			{ now: new Date() },
		);
		const omitted = evaluateItemMutationPolicyStateViaEngine(
			mutationEvidenceItem({
				movieFile: { videoDynamicRange: "HDR10" },
				_arrDashboardEvidence: { hasFile: true, hdrType: false },
			}) as never,
			[rule] as never,
			"RADARR",
			{ now: new Date() },
		);

		expect(explicit).toMatchObject({ kind: "cleanup" });
		expect(omitted).toEqual({ kind: "unknown", ruleId: "rule-hdr_type" });
	});

	it.each([
		["video_codec", { operator: "is", codecs: ["x265"] }],
		["audio_codec", { operator: "is", codecs: ["AAC"] }],
		["audio_channels", { operator: "is", channels: 2 }],
		["resolution", { operator: "is", resolutions: ["R1080p"] }],
		["custom_format_score", { operator: "less_than", score: 0 }],
		["release_group", { operator: "is", groups: ["Example"] }],
	] as const)("requires predicate-specific %s file evidence", (ruleType, parameters) => {
		const result = evaluateItemMutationPolicyStateViaEngine(
			mutationEvidenceItem({
				movieFile: { id: 1001, path: "/movies/example.mkv" },
				_arrDashboardEvidence: { hasFile: true },
			}) as never,
			[mutationEvidenceRule(ruleType, parameters)] as never,
			"RADARR",
			{ now: new Date() },
		);

		expect(result).toEqual({ kind: "unknown", ruleId: `rule-${ruleType}` });
	});

	it("requires a parseable channel count for audio_channels evidence", () => {
		const result = evaluateItemMutationPolicyStateViaEngine(
			mutationEvidenceItem({
				movieFile: { audioCodec: "AAC" },
				_arrDashboardEvidence: { hasFile: true },
			}) as never,
			[mutationEvidenceRule("audio_channels", { operator: "is", channels: 2 })] as never,
			"RADARR",
			{ now: new Date() },
		);

		expect(result).toEqual({ kind: "unknown", ruleId: "rule-audio_channels" });
	});

	it.each([
		{ originalLanguage: { name: "" } },
		{ languages: [] },
		{ languages: ["   "] },
		{ languages: [{ name: "" }] },
	])("rejects blank language evidence: %j", (languageData) => {
		const result = evaluateItemMutationPolicyStateViaEngine(
			mutationEvidenceItem(languageData) as never,
			[
				mutationEvidenceRule("language", {
					operator: "excludes_all",
					languages: ["English"],
				}),
			] as never,
			"RADARR",
			{ now: new Date() },
		);

		expect(result).toEqual({ kind: "unknown", ruleId: "rule-language" });
	});
});
