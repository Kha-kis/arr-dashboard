import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withCurrentProviderPublicationAuthority } from "../../services/provider-identity-guard.js";
import { providerInstanceAuthorityFingerprint } from "../../services/service-identity.js";
import {
	prepareMediaServerRescans,
	retryAllPendingMediaServerRescans,
	triggerCoalescedMediaServerRescans,
	triggerMediaServerRescansForApproval,
} from "../media-server-rescan.js";
import {
	createSanitizedProviderEvidence,
	ProviderExecutionAuthorityChangedError,
	renewCurrentProviderRetryAuthority,
	serializeExecutableSafetyPlan,
	serializeProviderScanAuthority,
} from "../shared-plex-safety.js";

vi.mock("../../plex/plex-authority-service.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../plex/plex-authority-service.js")>();
	const repository = await import("../../plex/plex-evidence-repository.js");
	return {
		...actual,
		PlexAuthorityService: class {
			private readonly prisma: never;

			constructor(input: { prisma: never }) {
				this.prisma = input.prisma;
			}

			readInstance(input: never) {
				return repository.loadInstanceEvidence(this.prisma, input);
			}

			scanInstancePolicy(input: never) {
				return repository.scanInstancePolicyEvidence(this.prisma, input);
			}

			scanInstanceExactPolicy(input: never) {
				return repository.scanInstancePolicyEvidence(this.prisma, input);
			}

			scanInstanceExactPolicyPersisted(input: never) {
				return repository.scanInstancePolicyEvidence(this.prisma, input);
			}
		},
	};
});

function plexV3Metadata(itemCount: number) {
	return JSON.stringify({
		version: 3,
		publicationLevel: "authoritative",
		completeness: "complete",
		itemCount,
		canonicalizationVersion: 1,
		sections: [
			{
				key: "movies",
				uuid: "movies-uuid",
				title: "Movies",
				type: "movie",
				refreshing: false,
				scannedAt: 1_777_000_000,
				updatedAt: 1_777_000_100,
			},
		],
		roots: [{ sectionKey: "movies", domain: "membership", digest: "a".repeat(64) }],
		targetLedgerVersion: 1,
		targetCount: itemCount,
		targetDigest: "c".repeat(64),
	});
}

function authorityFingerprint(value: unknown): string {
	const canonicalize = (input: unknown): unknown => {
		if (input instanceof Date) return input.toISOString();
		if (Array.isArray(input)) return input.map(canonicalize);
		if (typeof input === "object" && input !== null) {
			return Object.fromEntries(
				Object.entries(input as Record<string, unknown>)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, entry]) => [key, canonicalize(entry)]),
			);
		}
		return input;
	};
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

const providerIndependentSafetySnapshot = serializeExecutableSafetyPlan({
	kind: "verified_arr_target",
	target: {
		serviceFingerprint: "a".repeat(64),
		externalId: 42,
		mediaPath: { value: "/movies/Movie", windows: false },
	},
});

const testPlexEvidence = createSanitizedProviderEvidence(
	["plex"],
	[
		{
			service: "PLEX",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityFingerprint: "1".repeat(64),
			connectionGeneration: 3,
			identityGeneration: 7,
			cacheType: "plex",
			completedAt: "2026-08-15T00:00:00.000Z",
			itemCount: 1,
			verifiedAt: "2026-08-14T23:00:00.000Z",
			statusFingerprint: "2".repeat(64),
			rowFingerprint: "3".repeat(64),
		},
	],
);

const testTautulliEvidence = createSanitizedProviderEvidence(
	["tautulli"],
	[
		{
			service: "TAUTULLI",
			identityKind: "TAUTULLI_PMS_IDENTIFIER",
			identityFingerprint: "4".repeat(64),
			connectionGeneration: 3,
			identityGeneration: 7,
			cacheType: "tautulli",
			completedAt: "2026-08-15T00:00:00.000Z",
			itemCount: 1,
			verifiedAt: "2026-08-14T23:00:00.000Z",
			statusFingerprint: "5".repeat(64),
			rowFingerprint: "6".repeat(64),
		},
	],
);

const testMediaEvidence = createSanitizedProviderEvidence(
	["jellyfin", "plex"],
	[
		...testPlexEvidence.sources.map(({ fingerprint: _fingerprint, ...source }) => source),
		...(["JELLYFIN", "EMBY"] as const).map((service, index) => ({
			service,
			identityKind: service === "JELLYFIN" ? "JELLYFIN_SERVER_ID" : "EMBY_SERVER_ID",
			identityFingerprint: ["7", "8"][index]!.repeat(64),
			connectionGeneration: 3,
			identityGeneration: 7,
			cacheType: "jellyfin",
			completedAt: "2026-08-15T00:00:00.000Z",
			itemCount: 1,
			verifiedAt: "2026-08-14T23:00:00.000Z",
			statusFingerprint: ["8", "9"][index]!.repeat(64),
			rowFingerprint: ["9", "a"][index]!.repeat(64),
		})),
	],
);

function providerSafetySnapshot(evidence = testMediaEvidence) {
	return serializeExecutableSafetyPlan(
		{
			kind: "verified_arr_target",
			target: {
				serviceFingerprint: "a".repeat(64),
				externalId: 42,
				mediaPath: { value: "/movies/Movie", windows: false },
			},
		},
		evidence,
	);
}

function approval(overrides: Record<string, unknown> = {}) {
	return {
		id: "approval-1",
		configId: "config-1",
		instanceId: "radarr-1",
		arrItemId: 42,
		itemType: "movie",
		targetScope: "series",
		arrEpisodeId: null,
		episodeFileId: null,
		seasonNumber: null,
		episodeNumber: null,
		episodeTitle: null,
		title: "Movie",
		matchedRuleId: "rule-1",
		matchedRuleName: "Old media",
		reason: "Matched",
		action: "delete",
		scanMediaServerAfterDelete: true,
		sizeOnDisk: 1n,
		year: 2020,
		rating: null,
		status: "executed",
		executionToken: null,
		safetySnapshot: providerSafetySnapshot(),
		lastExecutionError: null,
		reviewedAt: null,
		executedAt: new Date(),
		executionAuditCorrelationId: "execution-1",
		reconciledWithoutMutation: false,
		terminalAuditRecordedAt: new Date(),
		expiresAt: new Date(Date.now() + 60_000),
		createdAt: new Date(),
		...overrides,
	};
}

function instance(id: string, service: "PLEX" | "JELLYFIN" | "EMBY", enabled = true) {
	const identityKind =
		service === "PLEX"
			? "PLEX_MACHINE_IDENTIFIER"
			: service === "JELLYFIN"
				? "JELLYFIN_SERVER_ID"
				: "EMBY_SERVER_ID";
	return {
		id,
		userId: "user-1",
		service,
		label: id,
		baseUrl: `http://${id}`,
		externalUrl: null,
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		isDefault: false,
		enabled,
		expectedIdentity: service === "PLEX" ? "plex-machine" : "media-server-id",
		identityKind,
		identityStatus: "VERIFIED",
		identityVerifiedAt: new Date(Date.now() - 60_000),
		identityGeneration: 7,
		connectionGeneration: 3,
		storageGroupId: null,
		hasLocalFilesystemAccess: false,
		pathPrefix: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

function scan(
	id: string,
	instanceId: string,
	service: "PLEX" | "JELLYFIN" | "EMBY",
	overrides: Record<string, unknown> = {},
) {
	const mediaType = (overrides.mediaType as "movie" | "show" | undefined) ?? "movie";
	const matchingSources = testMediaEvidence.sources.filter((source) => source.service === service);
	const targetEvidence = createSanitizedProviderEvidence(
		matchingSources.map((source) => source.cacheType),
		matchingSources.map(({ fingerprint: _fingerprint, ...source }) => source),
	);
	return {
		id,
		approvalId: "approval-1",
		instanceId,
		service,
		serverIdentity: serializeProviderScanAuthority(
			{ instanceId, service, mediaType },
			targetEvidence,
		),
		mediaType,
		plannedSectionIds: service === "PLEX" ? '["movies"]' : null,
		targetKey: `${service}:${instanceId}:movie`,
		status: "pending",
		executionToken: null,
		attemptCount: 0,
		completedSectionIds: "[]",
		lastError: null,
		nextAttemptAt: null,
		requestStartedAt: null,
		triggeredAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

function deps(
	options: {
		instances?: ReturnType<typeof instance>[];
		scans?: ReturnType<typeof scan>[];
		approval?: ReturnType<typeof approval>;
	} = {},
) {
	const instances = options.instances ?? [];
	const scans = options.scans ?? [];
	const plexClient = {
		getIdentity: vi.fn().mockResolvedValue({
			machineIdentifier: "plex-machine",
			version: "1.0",
			friendlyName: "Plex",
			platform: "Linux",
		}),
		getLibrarySections: vi.fn().mockResolvedValue([
			{ key: "movies", title: "Movies", type: "movie" },
			{ key: "shows", title: "Shows", type: "show" },
		]),
		refreshSection: vi.fn().mockResolvedValue(undefined),
	};
	const jellyfinClient = {
		getPublicInfo: vi.fn().mockResolvedValue({
			id: "media-server-id",
			serverName: "Media Server",
			version: "1.0",
			operatingSystem: "Linux",
		}),
		refreshLibrary: vi.fn().mockResolvedValue(undefined),
	};
	const prisma = {
		serviceInstance: {
			findMany: vi.fn().mockResolvedValue(instances),
			findFirst: vi.fn(({ where }: { where: { id: string } }) =>
				Promise.resolve(instances.find((candidate) => candidate.id === where.id) ?? null),
			),
		},
		libraryCleanupApproval: {
			findFirst: vi.fn().mockResolvedValue(options.approval ?? approval()),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		libraryCleanupMediaServerScan: {
			create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
				const row = scan(
					`created-${scans.length + 1}`,
					data.instanceId as string,
					data.service as "PLEX" | "JELLYFIN" | "EMBY",
					data,
				);
				scans.push(row);
				return row;
			}),
			count: vi.fn().mockImplementation(async () => scans.length),
			findMany: vi.fn().mockResolvedValue(scans),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
		},
	};
	const fixture = {
		deps: {
			prisma,
			arrClientFactory: {},
			plexCacheClientFactory: vi.fn(() => plexClient),
			jellyfinCacheClientFactory: vi.fn(() => jellyfinClient),
			providerEvidenceAuthorityChecker: vi.fn().mockResolvedValue(undefined),
			providerScanAuthorityCapturer: vi.fn(
				async (target: Parameters<typeof serializeProviderScanAuthority>[0]) => {
					const sources = testMediaEvidence.sources.filter(
						(source) => source.service === target.service,
					);
					return serializeProviderScanAuthority(
						target,
						createSanitizedProviderEvidence(
							sources.map((source) => source.cacheType),
							sources.map(({ fingerprint: _fingerprint, ...source }) => source),
						),
					);
				},
			),
			log: {
				warn: vi.fn(),
				error: vi.fn(),
				info: vi.fn(),
				debug: vi.fn(),
				trace: vi.fn(),
				fatal: vi.fn(),
				child: vi.fn(),
				silent: vi.fn(),
				level: "info",
			},
		} as never,
		prisma,
		plexClient,
		jellyfinClient,
	};
	installStatefulScanStore(fixture, scans, [options.approval ?? approval()]);
	return fixture;
}

function installStatefulScanStore(
	fixture: ReturnType<typeof deps>,
	rows: ReturnType<typeof scan>[],
	approvals: ReturnType<typeof approval>[],
) {
	fixture.prisma.libraryCleanupApproval.findFirst.mockImplementation(
		async ({ where }: { where: { id: string } }) =>
			approvals.find((candidate) => candidate.id === where.id) ?? null,
	);
	Object.assign(fixture.prisma.libraryCleanupApproval, {
		findMany: vi
			.fn()
			.mockImplementation(async ({ where }: { where: { id?: { in: string[] } } }) =>
				approvals.filter((candidate) => !where.id || where.id.in.includes(candidate.id)),
			),
	});
	fixture.prisma.libraryCleanupMediaServerScan.findMany.mockImplementation(
		async ({ where }: { where: Record<string, unknown> }) => {
			const approvalId = where.approvalId as string | { in: string[] } | undefined;
			let matches = rows.filter((row) =>
				typeof approvalId === "string"
					? row.approvalId === approvalId
					: !approvalId || approvalId.in.includes(row.approvalId),
			);
			const id = where.id as string | { in: string[] } | undefined;
			if (typeof id === "string") matches = matches.filter((row) => row.id === id);
			else if (id?.in) matches = matches.filter((row) => id.in.includes(row.id));
			for (const field of [
				"service",
				"serverIdentity",
				"mediaType",
				"plannedSectionIds",
				"executionToken",
			] as const) {
				if (field in where) matches = matches.filter((row) => row[field] === where[field]);
			}
			const status = where.status as string | { in?: string[] } | undefined;
			if (typeof status === "string") matches = matches.filter((row) => row.status === status);
			else if (status?.in) matches = matches.filter((row) => status.in?.includes(row.status));
			const covered = (where.AND as Array<{ OR?: Array<Record<string, string>> }> | undefined)?.[0]
				?.OR;
			if (covered) {
				matches = matches.filter((row) =>
					covered.some(
						(operation) =>
							operation.service === row.service &&
							operation.serverIdentity === row.serverIdentity &&
							(operation.mediaType === undefined || operation.mediaType === row.mediaType) &&
							(operation.plannedSectionIds === undefined ||
								operation.plannedSectionIds === row.plannedSectionIds),
					),
				);
			}
			if (where.OR || where.AND) {
				matches = matches.filter((row) => {
					if (row.status === "pending") return true;
					if (row.status === "failed") {
						const nextAttemptAt = row.nextAttemptAt as Date | null;
						return nextAttemptAt === null || nextAttemptAt <= new Date();
					}
					return (
						row.status === "triggering" && row.updatedAt < new Date(Date.now() - 10 * 60 * 1000)
					);
				});
			}
			return matches;
		},
	);
	fixture.prisma.libraryCleanupMediaServerScan.updateMany.mockImplementation(
		async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
			const id = where.id as string | { in: string[] } | undefined;
			let matches = rows.filter((row) =>
				typeof id === "string" ? row.id === id : !id || id.in.includes(row.id),
			);
			if (typeof where.status === "string") {
				matches = matches.filter((row) => row.status === where.status);
			}
			if ("executionToken" in where) {
				matches = matches.filter((row) => row.executionToken === where.executionToken);
			}
			if (where.OR) {
				matches = matches.filter((row) => ["pending", "failed", "triggering"].includes(row.status));
			}
			for (const row of matches) {
				const { attemptCount, ...persistedData } = data;
				if (typeof attemptCount === "object") row.attemptCount++;
				Object.assign(row, persistedData, { updatedAt: new Date() });
			}
			return { count: matches.length };
		},
	);
	Object.assign(fixture.prisma.libraryCleanupMediaServerScan, {
		findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
			where.id ? (rows.find((row) => row.id === where.id) ?? null) : null,
		),
		findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
			const matches = rows.filter(
				(row) =>
					row.service === where.service &&
					row.serverIdentity === where.serverIdentity &&
					(!("mediaType" in where) || row.mediaType === where.mediaType) &&
					(!("plannedSectionIds" in where) || row.plannedSectionIds === where.plannedSectionIds) &&
					(row.status === "triggered" || row.status === "skipped") &&
					row.requestStartedAt !== null,
			);
			return (
				matches.sort(
					(left, right) =>
						(right.requestStartedAt as unknown as Date).getTime() -
						(left.requestStartedAt as unknown as Date).getTime(),
				)[0] ?? null
			);
		}),
		deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
	});
}

function installRecoveryRunClaimStore(
	fixture: ReturnType<typeof deps>,
	configs: Array<{
		id: string;
		userId: string;
		runClaimToken: string | null;
		runClaimedAt: Date | null;
	}>,
) {
	const updateMany = vi.fn(
		async ({
			where,
			data,
		}: {
			where: { id: string; userId: string; runClaimToken?: string; OR?: unknown[] };
			data: { runClaimToken?: string | null; runClaimedAt: Date | null };
		}) => {
			const config = configs.find(
				(candidate) => candidate.id === where.id && candidate.userId === where.userId,
			);
			if (!config) return { count: 0 };
			if (data.runClaimToken === null) {
				if (where.runClaimToken !== config.runClaimToken) return { count: 0 };
				config.runClaimToken = null;
				config.runClaimedAt = null;
				return { count: 1 };
			}
			if (where.OR) {
				if (config.runClaimToken !== null) return { count: 0 };
				config.runClaimToken = data.runClaimToken ?? null;
				config.runClaimedAt = data.runClaimedAt;
				return { count: 1 };
			}
			if (where.runClaimToken !== config.runClaimToken) return { count: 0 };
			config.runClaimedAt = data.runClaimedAt;
			return { count: 1 };
		},
	);
	const transactionState = { depth: 0 };
	Object.assign(fixture.prisma, {
		libraryCleanupConfig: {
			upsert: vi.fn(async ({ where }: { where: { userId: string } }) => ({
				id: configs.find((config) => config.userId === where.userId)?.id,
			})),
			findUnique: vi.fn(async ({ where }: { where: { id?: string; userId?: string } }) =>
				configs.find((config) => config.id === where.id || config.userId === where.userId),
			),
			updateMany,
		},
		$transaction: vi.fn(async (callback: (tx: typeof fixture.prisma) => Promise<unknown>) => {
			transactionState.depth++;
			try {
				return await callback(fixture.prisma);
			} finally {
				transactionState.depth--;
			}
		}),
	});
	return { configs, transactionState, updateMany };
}

function installRecoveryCandidateProjection(
	fixture: ReturnType<typeof deps>,
	rows: ReturnType<typeof scan>[],
	configByApprovalId: Record<string, { id: string; userId: string }>,
) {
	const statefulFind =
		fixture.prisma.libraryCleanupMediaServerScan.findMany.getMockImplementation()!;
	fixture.prisma.libraryCleanupMediaServerScan.findMany.mockImplementation(
		async (args: {
			where: { approval?: { config?: { userId?: string } } };
			select?: { approval?: unknown };
		}) => {
			if (args.select?.approval) {
				return rows.map((row) => ({
					id: row.id,
					status: row.status,
					nextAttemptAt: row.nextAttemptAt,
					approval: { config: configByApprovalId[row.approvalId] },
				}));
			}
			const matches = (await statefulFind(args as never)) as ReturnType<typeof scan>[];
			const userId = args.where.approval?.config?.userId;
			return userId
				? matches.filter((row) => configByApprovalId[row.approvalId]?.userId === userId)
				: matches;
		},
	);
}

describe("durable media-server rescans", () => {
	beforeEach(() => vi.clearAllMocks());

	it("persists one owned enabled media-server target before deletion", async () => {
		const targets = [
			instance("plex-1", "PLEX"),
			instance("jellyfin-1", "JELLYFIN"),
			instance("emby-1", "EMBY"),
		];
		const fixture = deps({ instances: targets });

		await expect(
			prepareMediaServerRescans(fixture.deps, "user-1", approval() as never, "movie"),
		).resolves.toBe(3);
		expect(fixture.prisma.serviceInstance.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ userId: "user-1", enabled: true }),
			}),
		);
		expect(fixture.prisma.libraryCleanupMediaServerScan.create).toHaveBeenCalledTimes(3);
		expect(fixture.prisma.libraryCleanupMediaServerScan.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				instanceId: "plex-1",
				serverIdentity: expect.stringContaining('"providerEvidence"'),
				plannedSectionIds: '["movies"]',
			}),
		});
	});

	it("captures scan authority when cleanup recorded no provider dependency", async () => {
		const plex = instance("plex-1", "PLEX");
		const refreshedAt = new Date();
		plex.identityVerifiedAt = new Date(refreshedAt.getTime() - 120_000);
		plex.updatedAt = new Date(refreshedAt.getTime() - 60_000);
		const fixture = deps({ instances: [plex] });
		delete (fixture.deps as { providerScanAuthorityCapturer?: unknown })
			.providerScanAuthorityCapturer;
		Object.assign(fixture.prisma, {
			cacheRefreshStatus: {
				findMany: vi.fn().mockResolvedValue([
					{
						instanceId: "plex-1",
						cacheType: "plex",
						lastRefreshedAt: refreshedAt,
						lastResult: "success",
						lastErrorMessage: null,
						lastAttemptAt: refreshedAt,
						lastAttemptResult: "success",
						lastAttemptErrorMessage: null,
						itemCount: 0,
						connectionGeneration: 3,
						identityGeneration: 7,
						generationId: "plex-generation-1",
						generationMetadata: plexV3Metadata(0),
					},
				]),
			},
			plexCache: {
				findMany: vi.fn().mockResolvedValue([]),
				count: vi.fn().mockResolvedValue(0),
			},
		});
		const storedApproval = approval({ safetySnapshot: providerIndependentSafetySnapshot });

		await expect(
			prepareMediaServerRescans(fixture.deps, "user-1", storedApproval as never, "movie"),
		).resolves.toBe(1);
		expect(fixture.prisma.libraryCleanupMediaServerScan.create).toHaveBeenCalledOnce();
		const persisted = fixture.prisma.libraryCleanupMediaServerScan.create.mock.calls[0]?.[0].data
			.serverIdentity as string;
		expect(persisted).toContain('"cacheType":"plex"');
		expect(persisted).not.toContain("plex-machine");
	});

	it("captures Plex scan authority independently of Tautulli-only cleanup evidence", async () => {
		const fixture = deps({ instances: [instance("plex-1", "PLEX")] });
		const storedApproval = approval({
			safetySnapshot: providerSafetySnapshot(testTautulliEvidence),
		});

		await expect(
			prepareMediaServerRescans(fixture.deps, "user-1", storedApproval as never, "movie"),
		).resolves.toBe(1);
		expect(
			(fixture.deps as unknown as { providerScanAuthorityCapturer: ReturnType<typeof vi.fn> })
				.providerScanAuthorityCapturer,
		).toHaveBeenCalledWith({
			instanceId: "plex-1",
			service: "PLEX",
			mediaType: "movie",
		});
		expect(fixture.prisma.libraryCleanupMediaServerScan.create).toHaveBeenCalledOnce();
	});

	it("stores canonical target-bound scan authority without a raw identity", async () => {
		const plex = instance("plex-1", "PLEX");
		Object.assign(plex, {
			expectedIdentity: "plex-machine",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityStatus: "VERIFIED",
			identityVerifiedAt: new Date("2026-08-14T23:00:00.000Z"),
			connectionGeneration: 3,
			identityGeneration: 7,
		});
		const fixture = deps({ instances: [plex] });
		const storedApproval = approval({ safetySnapshot: providerSafetySnapshot() });

		await prepareMediaServerRescans(fixture.deps, "user-1", storedApproval as never, "movie");

		const createCall = fixture.prisma.libraryCleanupMediaServerScan.create.mock.calls[0]?.[0];
		const persisted = createCall?.data.serverIdentity as string;
		expect(() => JSON.parse(persisted)).not.toThrow();
		expect(persisted).not.toContain("plex-machine");
		expect(persisted).not.toContain("http://");
	});

	it("does not persist scan work when the rule snapshot disabled it", async () => {
		const fixture = deps({ instances: [instance("plex-1", "PLEX")] });
		await expect(
			prepareMediaServerRescans(
				fixture.deps,
				"user-1",
				approval({ scanMediaServerAfterDelete: false }) as never,
				"movie",
			),
		).resolves.toBe(0);
		expect(fixture.prisma.serviceInstance.findMany).not.toHaveBeenCalled();
	});

	it("blocks deletion preparation when the requested scan has no media-server target", async () => {
		const fixture = deps();

		await expect(
			prepareMediaServerRescans(fixture.deps, "user-1", approval() as never, "movie"),
		).rejects.toThrow("no enabled Plex, Jellyfin, or Emby");
		expect(fixture.prisma.libraryCleanupMediaServerScan.create).not.toHaveBeenCalled();
	});

	it("blocks deletion when Plex returns an empty section inventory", async () => {
		const fixture = deps({ instances: [instance("plex-1", "PLEX")] });
		fixture.plexClient.getLibrarySections.mockResolvedValue([]);

		await expect(
			prepareMediaServerRescans(fixture.deps, "user-1", approval() as never, "movie"),
		).rejects.toThrow("could not be verified");
		expect(fixture.prisma.libraryCleanupMediaServerScan.create).not.toHaveBeenCalled();
	});

	it("persists an explicit Plex no-op when only another library type exists", async () => {
		const fixture = deps({ instances: [instance("plex-1", "PLEX")] });
		fixture.plexClient.getLibrarySections.mockResolvedValue([
			{ key: "shows", title: "Shows", type: "show" },
		]);

		await prepareMediaServerRescans(fixture.deps, "user-1", approval() as never, "movie");

		expect(fixture.prisma.libraryCleanupMediaServerScan.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ plannedSectionIds: "[]" }),
		});
	});

	it("blocks a pre-deletion retry when its Plex section plan changed", async () => {
		const fixture = deps({ instances: [instance("plex-1", "PLEX")] });
		await prepareMediaServerRescans(fixture.deps, "user-1", approval() as never, "movie");
		const storedAuthority =
			fixture.prisma.libraryCleanupMediaServerScan.create.mock.calls[0]![0].data.serverIdentity;
		fixture.plexClient.getLibrarySections.mockResolvedValue([
			{ key: "movies", title: "Movies", type: "movie" },
			{ key: "anime", title: "Anime", type: "movie" },
		]);
		fixture.prisma.libraryCleanupMediaServerScan.create.mockRejectedValue(
			Object.assign(new Error("duplicate"), { code: "P2002" }),
		);
		Object.assign(fixture.prisma.libraryCleanupMediaServerScan, {
			findUnique: vi.fn().mockResolvedValue({
				serverIdentity: storedAuthority,
				plannedSectionIds: '["movies"]',
			}),
		});

		await expect(
			prepareMediaServerRescans(fixture.deps, "user-1", approval() as never, "movie"),
		).rejects.toThrow("section plan changed");
	});

	it("renews volatile scan authority when a pre-deletion retry keeps the same target plan", async () => {
		const fixture = deps({ instances: [instance("plex-1", "PLEX")] });
		await prepareMediaServerRescans(fixture.deps, "user-1", approval() as never, "movie");
		const storedAuthority =
			fixture.prisma.libraryCleanupMediaServerScan.create.mock.calls[0]![0].data.serverIdentity;
		const refreshedEvidence = createSanitizedProviderEvidence(
			["plex"],
			testPlexEvidence.sources.map(({ fingerprint: _fingerprint, ...source }) => ({
				...source,
				completedAt: "2026-08-15T00:05:00.000Z",
				statusFingerprint: "d".repeat(64),
				rowFingerprint: "e".repeat(64),
			})),
		);
		const refreshedAuthority = serializeProviderScanAuthority(
			{ instanceId: "plex-1", service: "PLEX", mediaType: "movie" },
			refreshedEvidence,
		);
		(
			fixture.deps as unknown as {
				providerScanAuthorityCapturer: ReturnType<typeof vi.fn>;
			}
		).providerScanAuthorityCapturer.mockResolvedValue(refreshedAuthority);
		fixture.prisma.libraryCleanupMediaServerScan.create.mockRejectedValue(
			Object.assign(new Error("duplicate"), { code: "P2002" }),
		);
		Object.assign(fixture.prisma.libraryCleanupMediaServerScan, {
			findUnique: vi.fn().mockResolvedValue({
				serverIdentity: storedAuthority,
				plannedSectionIds: '["movies"]',
			}),
		});

		await expect(
			prepareMediaServerRescans(fixture.deps, "user-1", approval() as never, "movie"),
		).resolves.toBe(1);
		expect(fixture.prisma.libraryCleanupMediaServerScan.updateMany).toHaveBeenCalledWith({
			where: {
				approvalId: "approval-1",
				targetKey: "PLEX:plex-1:movie",
				serverIdentity: storedAuthority,
				plannedSectionIds: '["movies"]',
			},
			data: { serverIdentity: refreshedAuthority },
		});
	});

	it("blocks a pre-deletion retry when an earlier media-server target was removed", async () => {
		const plex = instance("plex-1", "PLEX");
		const jellyfin = instance("jellyfin-1", "JELLYFIN");
		const fixture = deps({ instances: [plex, jellyfin] });
		await prepareMediaServerRescans(fixture.deps, "user-1", approval() as never, "movie");
		const storedAuthority =
			fixture.prisma.libraryCleanupMediaServerScan.create.mock.calls[0]![0].data.serverIdentity;
		fixture.prisma.serviceInstance.findMany.mockResolvedValue([plex]);
		fixture.prisma.libraryCleanupMediaServerScan.create.mockRejectedValue(
			Object.assign(new Error("duplicate"), { code: "P2002" }),
		);
		Object.assign(fixture.prisma.libraryCleanupMediaServerScan, {
			findUnique: vi.fn().mockResolvedValue({
				serverIdentity: storedAuthority,
				plannedSectionIds: '["movies"]',
			}),
		});

		await expect(
			prepareMediaServerRescans(fixture.deps, "user-1", approval() as never, "movie"),
		).rejects.toThrow("target set changed");
	});

	it("triggers matching Plex sections and one global Jellyfin/Emby refresh", async () => {
		const targets = [
			instance("plex-1", "PLEX"),
			instance("jellyfin-1", "JELLYFIN"),
			instance("emby-1", "EMBY"),
		];
		const fixture = deps({
			instances: targets,
			scans: [
				scan("scan-plex", "plex-1", "PLEX"),
				scan("scan-jellyfin", "jellyfin-1", "JELLYFIN"),
				scan("scan-emby", "emby-1", "EMBY"),
			],
		});

		const result = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");
		expect(result).toMatchObject({ targets: 3, triggered: 3, failed: 0, warnings: [] });
		expect(fixture.plexClient.refreshSection).toHaveBeenCalledOnce();
		expect(fixture.plexClient.refreshSection).toHaveBeenCalledWith("movies");
		expect(fixture.jellyfinClient.refreshLibrary).toHaveBeenCalledTimes(2);
	});

	it("binds post-delete scan retries to stable identity rather than cache generations", async () => {
		const now = new Date();
		const plexInstance = {
			...instance("plex-1", "PLEX"),
			expectedIdentity: "plex-machine-a",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityStatus: "VERIFIED",
			identityVerifiedAt: new Date(now.getTime() - 5_000),
			connectionGeneration: 3,
			identityGeneration: 7,
			updatedAt: new Date(now.getTime() - 10_000),
		};
		const status = {
			instanceId: plexInstance.id,
			cacheType: "plex",
			lastRefreshedAt: now,
			lastResult: "success",
			lastErrorMessage: null,
			lastAttemptAt: now,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			itemCount: 1,
			connectionGeneration: 3,
			identityGeneration: 7,
			generationId: "generation-a",
			generationMetadata: "{}",
		};
		const row = {
			id: "plex-row-1",
			instanceId: plexInstance.id,
			tmdbId: 42,
			mediaType: "movie",
			sectionId: "movies",
			sectionTitle: "Movies",
			lastWatchedAt: now,
			watchCount: 2,
			watchedByUsers: "[]",
			onDeck: false,
			userRating: null,
			collections: "[]",
			labels: "[]",
			addedAt: null,
			connectionGeneration: 3,
			identityGeneration: 7,
		};
		const statusPayload = {
			instanceId: status.instanceId,
			lastRefreshedAt: status.lastRefreshedAt,
			lastResult: status.lastResult,
			lastErrorMessage: status.lastErrorMessage,
			lastAttemptResult: status.lastAttemptResult,
			lastAttemptErrorMessage: status.lastAttemptErrorMessage,
			itemCount: status.itemCount,
			connectionGeneration: status.connectionGeneration,
			identityGeneration: status.identityGeneration,
			generationId: status.generationId,
			generationMetadata: status.generationMetadata,
		};
		const evidence = createSanitizedProviderEvidence(
			["plex"],
			[
				{
					service: "PLEX",
					identityKind: plexInstance.identityKind,
					identityFingerprint: authorityFingerprint({
						service: plexInstance.service,
						identityKind: plexInstance.identityKind,
						expectedIdentity: plexInstance.expectedIdentity,
					}),
					connectionGeneration: 3,
					identityGeneration: 7,
					cacheType: "plex",
					completedAt: now.toISOString(),
					itemCount: 1,
					verifiedAt: plexInstance.identityVerifiedAt.toISOString(),
					statusFingerprint: authorityFingerprint({
						instance: {
							id: plexInstance.id,
							expectedIdentity: plexInstance.expectedIdentity,
							identityKind: plexInstance.identityKind,
							identityVerifiedAt: plexInstance.identityVerifiedAt,
							connectionGeneration: 3,
							identityGeneration: 7,
							updatedAt: plexInstance.updatedAt,
						},
						status: statusPayload,
					}),
					rowFingerprint: authorityFingerprint([row]),
				},
			],
		);
		const storedApproval = approval({
			safetySnapshot: serializeExecutableSafetyPlan(
				{
					kind: "verified_arr_target",
					target: {
						serviceFingerprint: "a".repeat(64),
						externalId: 42,
						mediaPath: { value: "/movies/Movie", windows: false },
					},
				},
				evidence,
			),
		});
		const rows = [
			scan("scan-1", plexInstance.id, "PLEX", {
				serverIdentity: serializeProviderScanAuthority(
					{ instanceId: plexInstance.id, service: "PLEX", mediaType: "movie" },
					evidence,
				),
			}),
		];
		const fixture = deps({ instances: [plexInstance], scans: rows, approval: storedApproval });
		Object.assign(fixture.deps, {
			encryptor: { decrypt: vi.fn(() => "decrypted") },
			providerEvidenceAuthorityChecker: undefined,
			providerIdentityReader: vi.fn(async () => ({
				service: "PLEX",
				identityKind: "plex-machine-identifier",
				rawIdentity: "plex-machine-b",
				confirmationDigest: "safe",
				fingerprint: "safe",
			})),
		});
		Object.assign(fixture.prisma, {
			cacheRefreshStatus: { findMany: vi.fn(async () => [status]) },
			plexCache: { findMany: vi.fn(async () => [row]) },
			$transaction: vi.fn(),
		});

		const result = await triggerMediaServerRescansForApproval(
			fixture.deps,
			"user-1",
			storedApproval.id,
		);

		expect(result).toMatchObject({ targets: 1, triggered: 0, failed: 1 });
		expect(fixture.plexClient.refreshSection).not.toHaveBeenCalled();
		expect(rows[0]).toMatchObject({ status: "failed", executionToken: null });

		const retryRows = [
			scan("scan-2", plexInstance.id, "PLEX", {
				serverIdentity: serializeProviderScanAuthority(
					{ instanceId: plexInstance.id, service: "PLEX", mediaType: "movie" },
					evidence,
				),
			}),
		];
		const retryFixture = deps({
			instances: [plexInstance],
			scans: retryRows,
			approval: storedApproval,
		});
		Object.assign(retryFixture.deps, {
			encryptor: { decrypt: vi.fn(() => "decrypted") },
			providerEvidenceAuthorityChecker: undefined,
			providerIdentityReader: vi.fn(async () => ({
				service: "PLEX",
				identityKind: "plex-machine-identifier",
				rawIdentity: plexInstance.expectedIdentity,
				confirmationDigest: "safe",
				fingerprint: "safe",
			})),
		});
		Object.assign(retryFixture.prisma, {
			cacheRefreshStatus: {
				findMany: vi.fn(async () => [
					{
						...status,
						lastRefreshedAt: new Date(status.lastRefreshedAt.getTime() + 60_000),
						lastAttemptAt: new Date(status.lastRefreshedAt.getTime() + 60_000),
						generationId: "generation-b",
					},
				]),
			},
			plexCache: { findMany: vi.fn(async () => [{ ...row, watchCount: row.watchCount + 1 }]) },
			$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
				callback(retryFixture.prisma),
			),
		});

		const retryResult = await triggerMediaServerRescansForApproval(
			retryFixture.deps,
			"user-1",
			storedApproval.id,
		);

		expect(retryResult).toMatchObject({ targets: 1, triggered: 1, failed: 0 });
		expect(retryFixture.plexClient.refreshSection).toHaveBeenCalledWith("movies");
		expect(retryRows[0]).toMatchObject({ status: "triggered", executionToken: null });
	});

	it("renews record-only retry evidence from current cache data under stable provider identity", async () => {
		const refreshedAt = new Date(Date.now() - 60_000);
		const capturedAt = new Date(refreshedAt.getTime() - 5 * 60_000);
		const identityVerifiedAt = new Date(refreshedAt.getTime() - 60 * 60_000);
		const instanceUpdatedAt = new Date(refreshedAt.getTime() - 30 * 60_000);
		const plexInstance = {
			...instance("plex-1", "PLEX"),
			expectedIdentity: "plex-machine",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityStatus: "VERIFIED",
			identityVerifiedAt,
			connectionGeneration: 3,
			identityGeneration: 7,
			updatedAt: instanceUpdatedAt,
		};
		const accepted = createSanitizedProviderEvidence(
			["plex"],
			[
				{
					service: "PLEX",
					instanceFingerprint: providerInstanceAuthorityFingerprint(plexInstance.id),
					identityKind: plexInstance.identityKind,
					identityFingerprint: authorityFingerprint({
						service: plexInstance.service,
						identityKind: plexInstance.identityKind,
						expectedIdentity: plexInstance.expectedIdentity,
					}),
					connectionGeneration: 3,
					identityGeneration: 7,
					cacheType: "plex",
					completedAt: capturedAt.toISOString(),
					itemCount: 1,
					verifiedAt: plexInstance.identityVerifiedAt.toISOString(),
					statusFingerprint: "a".repeat(64),
					rowFingerprint: "b".repeat(64),
					generationId: "generation-b",
					targetLedgerVersion: 1,
					targetCount: 1,
					targetDigest: "c".repeat(64),
				},
			],
		);
		const row = {
			id: "plex-row-1",
			instanceId: plexInstance.id,
			tmdbId: 42,
			mediaType: "movie",
			sectionId: "movies",
			sectionTitle: "Movies",
			lastWatchedAt: refreshedAt,
			watchCount: 3,
			watchedByUsers: "[]",
			onDeck: false,
			userRating: null,
			collections: "[]",
			labels: "[]",
			addedAt: null,
			connectionGeneration: 3,
			identityGeneration: 7,
		};
		const fixture = deps({ instances: [plexInstance] });
		Object.assign(fixture.deps, {
			encryptor: { decrypt: vi.fn(() => "decrypted") },
			providerEvidenceAuthorityChecker: undefined,
			providerIdentityReader: vi.fn(async () => ({
				service: "PLEX",
				identityKind: "plex-machine-identifier",
				rawIdentity: plexInstance.expectedIdentity,
				confirmationDigest: "safe",
				fingerprint: "safe",
			})),
		});
		Object.assign(fixture.prisma, {
			cacheRefreshStatus: {
				findMany: vi.fn(async () => [
					{
						instanceId: plexInstance.id,
						cacheType: "plex",
						lastRefreshedAt: refreshedAt,
						lastResult: "success",
						lastErrorMessage: null,
						lastAttemptAt: refreshedAt,
						lastAttemptResult: "success",
						lastAttemptErrorMessage: null,
						itemCount: 1,
						connectionGeneration: 3,
						identityGeneration: 7,
						generationId: "generation-b",
						generationMetadata: plexV3Metadata(1),
					},
				]),
			},
			plexCache: { findMany: vi.fn(async () => [row]) },
			$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
				callback(fixture.prisma),
			),
		});

		const renewed = await renewCurrentProviderRetryAuthority(fixture.deps, "user-1", accepted);

		expect(renewed.fingerprint).not.toBe(accepted.fingerprint);
		expect(renewed.sources[0]).toMatchObject({
			instanceFingerprint: providerInstanceAuthorityFingerprint(plexInstance.id),
			completedAt: refreshedAt.toISOString(),
			itemCount: 1,
		});
	});

	it("reissues the full Plex plan after a partial attempt", async () => {
		const fixture = deps({
			instances: [instance("plex-1", "PLEX")],
			scans: [
				scan("scan-plex", "plex-1", "PLEX", {
					plannedSectionIds: '["movies","movies-2"]',
					completedSectionIds: '["movies"]',
				}),
			],
		});
		fixture.plexClient.getLibrarySections.mockResolvedValue([
			{ key: "movies", title: "Movies", type: "movie" },
			{ key: "movies-2", title: "More Movies", type: "movie" },
		]);

		await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");
		expect(fixture.plexClient.refreshSection).toHaveBeenCalledTimes(2);
		expect(fixture.plexClient.refreshSection).toHaveBeenCalledWith("movies");
		expect(fixture.plexClient.refreshSection).toHaveBeenCalledWith("movies-2");
	});

	it("records an explicit no-op when no matching Plex section existed before deletion", async () => {
		const noSectionScan = scan("scan-plex", "plex-1", "PLEX", {
			plannedSectionIds: "[]",
		});
		const fixture = deps({
			instances: [instance("plex-1", "PLEX")],
			scans: [noSectionScan],
		});

		const result = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");

		expect(result).toMatchObject({ targets: 1, triggered: 0, skipped: 1, failed: 0 });
		expect(fixture.plexClient.refreshSection).not.toHaveBeenCalled();
		expect(fixture.prisma.libraryCleanupMediaServerScan.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "skipped" }) }),
		);
	});

	it("audits mixed triggered and skipped targets without losing either count", async () => {
		const rows = [
			scan("scan-plex", "plex-1", "PLEX", { plannedSectionIds: "[]" }),
			scan("scan-jellyfin", "jellyfin-1", "JELLYFIN"),
		];
		const storedApproval = approval();
		const fixture = deps({
			instances: [instance("plex-1", "PLEX"), instance("jellyfin-1", "JELLYFIN")],
		});
		installStatefulScanStore(fixture, rows, [storedApproval]);
		const auditCreate = vi.fn().mockResolvedValue({});
		Object.assign(fixture.prisma, {
			libraryCleanupAuditEvent: { create: auditCreate },
		});

		const result = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");

		expect(result).toMatchObject({ targets: 2, triggered: 1, skipped: 1, failed: 0 });
		const completed = auditCreate.mock.calls
			.map(([call]) => call.data)
			.find((event) => event.eventType === "media_rescan_completed");
		expect(completed).toBeDefined();
		expect(JSON.parse(completed.evidence)).toMatchObject({
			targetCount: 2,
			triggeredCount: 1,
			skippedCount: 1,
			failedCount: 0,
		});
	});

	it("keeps a planned Plex scan retryable when its section disappears", async () => {
		const fixture = deps({
			instances: [instance("plex-1", "PLEX")],
			scans: [scan("scan-plex", "plex-1", "PLEX")],
		});
		fixture.plexClient.getLibrarySections.mockResolvedValue([]);

		const result = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");

		expect(result).toMatchObject({ targets: 1, triggered: 0, skipped: 0, failed: 1 });
		expect(fixture.plexClient.refreshSection).not.toHaveBeenCalled();
	});

	it("keeps scan failure independent from the executed cleanup approval", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-04T12:00:00.000Z"));
		const fixture = deps({
			instances: [instance("plex-1", "PLEX")],
			scans: [scan("scan-plex", "plex-1", "PLEX")],
		});
		fixture.plexClient.refreshSection.mockRejectedValue(new Error("offline"));

		const result = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");
		expect(result).toMatchObject({ targets: 1, triggered: 0, failed: 1 });
		expect(result.warnings[0]).toContain("retry it without repeating the cleanup deletion");
		expect(fixture.prisma.libraryCleanupApproval.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ status: "executed" }) }),
		);
		expect(fixture.prisma.libraryCleanupMediaServerScan.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "failed",
					nextAttemptAt: new Date("2026-08-04T12:01:00.000Z"),
				}),
			}),
		);
		vi.useRealTimers();
	});

	it("only selects failed scan jobs whose retry backoff is due", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-04T12:00:00.000Z"));
		try {
			const future = deps({
				instances: [instance("plex-1", "PLEX")],
				scans: [
					scan("scan-future", "plex-1", "PLEX", {
						status: "failed",
						nextAttemptAt: new Date("2026-08-04T12:01:00.000Z"),
					}),
				],
			});
			const futureResult = await triggerMediaServerRescansForApproval(
				future.deps,
				"user-1",
				"approval-1",
			);
			expect(futureResult).toMatchObject({ targets: 0, triggered: 0, failed: 0 });
			expect(future.plexClient.refreshSection).not.toHaveBeenCalled();

			const due = deps({
				instances: [instance("plex-1", "PLEX")],
				scans: [
					scan("scan-due", "plex-1", "PLEX", {
						status: "failed",
						nextAttemptAt: new Date("2026-08-04T11:59:00.000Z"),
					}),
				],
			});
			const dueResult = await triggerMediaServerRescansForApproval(
				due.deps,
				"user-1",
				"approval-1",
			);
			expect(dueResult).toMatchObject({ targets: 1, triggered: 1, failed: 0 });
			expect(due.plexClient.refreshSection).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("prunes successful scan jobs only after their audit is durable", async () => {
		const pendingScan = scan("scan-plex", "plex-1", "PLEX");
		const fixture = deps({
			instances: [instance("plex-1", "PLEX")],
			scans: [pendingScan],
		});
		const auditCreate = vi.fn().mockResolvedValue({});
		Object.assign(fixture.prisma, {
			libraryCleanupAuditEvent: { create: auditCreate },
		});

		await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");

		expect(auditCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ eventType: "media_rescan_triggered" }),
			}),
		);
		expect(fixture.prisma.libraryCleanupMediaServerScan.deleteMany).toHaveBeenCalledWith({
			where: { approvalId: "approval-1", status: { in: ["triggered", "skipped"] } },
		});
	});

	it("restart-reconciles a terminal scan row that was not yet audited or pruned", async () => {
		const terminalScan = scan("scan-jellyfin", "jellyfin-1", "JELLYFIN", {
			status: "triggered",
			attemptCount: 1,
		});
		const fixture = deps({ instances: [instance("jellyfin-1", "JELLYFIN")] });
		installStatefulScanStore(fixture, [terminalScan], [approval()]);
		const auditCreate = vi.fn().mockResolvedValue({});
		Object.assign(fixture.prisma, {
			libraryCleanupAuditEvent: { create: auditCreate },
		});

		await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");

		expect(fixture.jellyfinClient.refreshLibrary).not.toHaveBeenCalled();
		expect(auditCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ eventType: "media_rescan_triggered" }),
			}),
		);
		expect(fixture.prisma.libraryCleanupMediaServerScan.deleteMany).toHaveBeenCalledOnce();
	});

	it("retries pruning after a terminal scan audit survives a process interruption", async () => {
		const terminalScan = scan("scan-jellyfin", "jellyfin-1", "JELLYFIN", {
			status: "triggered",
			attemptCount: 1,
		});
		const fixture = deps({ instances: [instance("jellyfin-1", "JELLYFIN")] });
		installStatefulScanStore(fixture, [terminalScan], [approval()]);
		Object.assign(fixture.prisma, {
			libraryCleanupAuditEvent: { create: vi.fn().mockResolvedValue({}) },
		});
		fixture.prisma.libraryCleanupMediaServerScan.deleteMany
			.mockRejectedValueOnce(new Error("process interrupted"))
			.mockResolvedValueOnce({ count: 1 });

		await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");
		await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");

		expect(fixture.jellyfinClient.refreshLibrary).not.toHaveBeenCalled();
		expect(fixture.prisma.libraryCleanupMediaServerScan.deleteMany).toHaveBeenCalledTimes(2);
	});

	it("retains failed scan jobs after recording their failure audit", async () => {
		const pendingScan = scan("scan-plex", "plex-1", "PLEX");
		const fixture = deps({
			instances: [instance("plex-1", "PLEX")],
			scans: [pendingScan],
		});
		fixture.plexClient.refreshSection.mockRejectedValue(new Error("offline"));
		fixture.prisma.libraryCleanupMediaServerScan.findMany
			.mockResolvedValueOnce([pendingScan])
			.mockResolvedValueOnce([{ status: "failed", attemptCount: 1 }]);
		Object.assign(fixture.prisma, {
			libraryCleanupAuditEvent: { create: vi.fn().mockResolvedValue({}) },
		});

		await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");

		expect(fixture.prisma.libraryCleanupMediaServerScan.deleteMany).not.toHaveBeenCalled();
	});

	it("does not record scan success when another worker wins every claim", async () => {
		const fixture = deps({
			instances: [instance("plex-1", "PLEX")],
			scans: [scan("scan-plex", "plex-1", "PLEX")],
		});
		fixture.prisma.libraryCleanupMediaServerScan.updateMany.mockResolvedValue({ count: 0 });
		const auditCreate = vi.fn().mockResolvedValue({});
		Object.assign(fixture.prisma, {
			libraryCleanupAuditEvent: { create: auditCreate },
		});

		const result = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");

		expect(result).toMatchObject({ targets: 1, triggered: 0, failed: 0 });
		expect(fixture.plexClient.refreshSection).not.toHaveBeenCalled();
		expect(auditCreate).not.toHaveBeenCalled();
	});

	it("does not start an operation while another worker holds its physical lease", async () => {
		const fixture = deps({
			instances: [instance("jellyfin-1", "JELLYFIN")],
			scans: [scan("scan-jellyfin", "jellyfin-1", "JELLYFIN")],
		});
		Object.assign(fixture.prisma, {
			libraryCleanupMediaServerScanLease: {
				create: vi.fn().mockRejectedValue(Object.assign(new Error("leased"), { code: "P2002" })),
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
		});

		const result = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");

		expect(result).toMatchObject({ targets: 1, triggered: 0, failed: 0, warnings: [] });
		expect(fixture.jellyfinClient.refreshLibrary).not.toHaveBeenCalled();
	});

	it("repairs a missing terminal deletion audit before triggering a scan", async () => {
		const storedApproval = approval({ terminalAuditRecordedAt: null });
		const rows = [scan("scan-jellyfin", "jellyfin-1", "JELLYFIN")];
		const fixture = deps({ instances: [instance("jellyfin-1", "JELLYFIN")] });
		installStatefulScanStore(fixture, rows, [storedApproval]);
		const auditEvents: Array<Record<string, unknown>> = [];
		Object.assign(fixture.prisma, {
			libraryCleanupAuditEvent: {
				create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
					auditEvents.push(data);
					return data;
				}),
			},
		});

		await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");

		const terminalIndex = auditEvents.findIndex(
			(event) => event.eventType === "terminal_succeeded",
		);
		const scanIndex = auditEvents.findIndex(
			(event) => event.eventType === "media_rescan_triggered",
		);
		expect(terminalIndex).toBeGreaterThanOrEqual(0);
		expect(scanIndex).toBeGreaterThan(terminalIndex);
		expect(fixture.jellyfinClient.refreshLibrary).toHaveBeenCalledOnce();
	});

	it("keeps a scan pending while terminal audit recovery is unavailable", async () => {
		const storedApproval = approval({ terminalAuditRecordedAt: null });
		const rows = [scan("scan-jellyfin", "jellyfin-1", "JELLYFIN")];
		const fixture = deps({ instances: [instance("jellyfin-1", "JELLYFIN")] });
		installStatefulScanStore(fixture, rows, [storedApproval]);
		const auditCreate = vi
			.fn()
			.mockRejectedValueOnce(new Error("audit unavailable"))
			.mockResolvedValue({});
		Object.assign(fixture.prisma, {
			libraryCleanupAuditEvent: { create: auditCreate },
		});

		const first = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");
		expect(first.warnings).toContainEqual(expect.stringContaining("terminal cleanup audit"));
		expect(rows[0]?.status).toBe("pending");
		expect(fixture.jellyfinClient.refreshLibrary).not.toHaveBeenCalled();

		await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");
		expect(fixture.jellyfinClient.refreshLibrary).toHaveBeenCalledOnce();
	});

	it("fails a retry closed when its physical media-server identity changed", async () => {
		const fixture = deps({
			instances: [instance("plex-1", "PLEX")],
			scans: [scan("scan-plex", "plex-1", "PLEX")],
		});
		fixture.plexClient.getIdentity.mockResolvedValue({
			machineIdentifier: "different-machine",
			version: "1.0",
			friendlyName: "Different Plex",
			platform: "Linux",
		});
		Object.assign(fixture.deps, {
			providerEvidenceAuthorityChecker: vi
				.fn()
				.mockRejectedValue(new ProviderExecutionAuthorityChangedError()),
		});

		const result = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");

		expect(result).toMatchObject({ targets: 1, triggered: 0, failed: 1 });
		expect(fixture.plexClient.refreshSection).not.toHaveBeenCalled();
	});

	it("coalesces movie and show cleanup into one Jellyfin-compatible global refresh", async () => {
		const rows = [
			scan("scan-movie", "jellyfin-1", "JELLYFIN"),
			scan("scan-show", "jellyfin-1", "JELLYFIN", {
				approvalId: "approval-2",
				mediaType: "show",
				targetKey: "JELLYFIN:jellyfin-1:show",
			}),
		];
		const approvals = [approval(), approval({ id: "approval-2", itemType: "series" })];
		const fixture = deps({ instances: [instance("jellyfin-1", "JELLYFIN")] });
		fixture.prisma.libraryCleanupApproval.findFirst.mockImplementation(
			async ({ where }: { where: { id: string } }) =>
				approvals.find((candidate) => candidate.id === where.id) ?? null,
		);
		Object.assign(fixture.prisma.libraryCleanupApproval, {
			findMany: vi.fn().mockResolvedValue(approvals),
		});
		fixture.prisma.libraryCleanupMediaServerScan.findMany.mockImplementation(
			async ({ where }: { where: Record<string, unknown> }) => {
				const approvalId = where.approvalId as string | { in: string[] } | undefined;
				let matches = rows.filter((row) =>
					typeof approvalId === "string"
						? row.approvalId === approvalId
						: !approvalId || approvalId.in.includes(row.approvalId),
				);
				if (where.OR || where.AND) {
					matches = matches.filter(
						(row) =>
							row.status === "pending" || row.status === "failed" || row.status === "triggering",
					);
				}
				return matches;
			},
		);
		fixture.prisma.libraryCleanupMediaServerScan.updateMany.mockImplementation(
			async ({
				where,
				data,
			}: {
				where: { id?: string | { in: string[] } };
				data: Record<string, unknown>;
			}) => {
				const ids =
					typeof where.id === "string"
						? [where.id]
						: where.id && typeof where.id === "object"
							? where.id.in
							: [];
				for (const row of rows.filter((candidate) => ids.includes(candidate.id))) {
					if (typeof data.attemptCount === "object") row.attemptCount++;
					Object.assign(row, data, { updatedAt: new Date() });
				}
				return { count: ids.length };
			},
		);

		const result = await triggerCoalescedMediaServerRescans(fixture.deps, "user-1", [
			"approval-1",
			"approval-2",
		]);

		expect(result).toMatchObject({ targets: 2, triggered: 2, failed: 0 });
		expect(fixture.jellyfinClient.refreshLibrary).toHaveBeenCalledOnce();
		expect(rows.map((row) => row.status)).toEqual(["triggered", "triggered"]);
	});

	it("deduplicates duplicate instance records for one physical server within an approval", async () => {
		const rows = [
			scan("scan-primary", "jellyfin-1", "JELLYFIN"),
			scan("scan-duplicate", "jellyfin-2", "JELLYFIN", {
				targetKey: "JELLYFIN:jellyfin-2:movie",
			}),
		];
		const fixture = deps({
			instances: [instance("jellyfin-1", "JELLYFIN"), instance("jellyfin-2", "JELLYFIN")],
		});
		installStatefulScanStore(fixture, rows, [approval()]);

		const result = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");

		expect(result).toMatchObject({ targets: 2, triggered: 2, failed: 0 });
		expect(fixture.jellyfinClient.refreshLibrary).toHaveBeenCalledOnce();
		expect(rows.map((row) => row.status)).toEqual(["triggered", "triggered"]);
	});

	it("uses a healthy equivalent instance when the first physical-server record is broken", async () => {
		const rows = [
			scan("scan-broken", "jellyfin-1", "JELLYFIN"),
			scan("scan-healthy", "jellyfin-2", "JELLYFIN", {
				targetKey: "JELLYFIN:jellyfin-2:movie",
			}),
		];
		const fixture = deps({
			instances: [instance("jellyfin-1", "JELLYFIN"), instance("jellyfin-2", "JELLYFIN")],
		});
		installStatefulScanStore(fixture, rows, [approval()]);
		const brokenClient = {
			getPublicInfo: vi.fn().mockRejectedValue(new Error("instance unavailable")),
			refreshLibrary: vi.fn().mockRejectedValue(new Error("instance unavailable")),
		};
		(
			fixture.deps as unknown as {
				jellyfinCacheClientFactory: (serviceInstance: ReturnType<typeof instance>) => unknown;
			}
		).jellyfinCacheClientFactory = vi.fn((serviceInstance) =>
			serviceInstance.id === "jellyfin-1" ? brokenClient : fixture.jellyfinClient,
		);

		const result = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");

		expect(result).toMatchObject({ targets: 2, triggered: 2, failed: 0 });
		expect(brokenClient.refreshLibrary).toHaveBeenCalledOnce();
		expect(fixture.jellyfinClient.refreshLibrary).toHaveBeenCalledOnce();
		expect(rows.map((row) => row.status)).toEqual(["triggered", "triggered"]);
	});

	it("fail-stops later scan operations after provider authority changes", async () => {
		const rows = [
			scan("scan-movies", "plex-1", "PLEX"),
			scan("scan-shows", "plex-1", "PLEX", {
				mediaType: "show",
				plannedSectionIds: '["shows"]',
				targetKey: "PLEX:plex-1:show",
			}),
		];
		const storedApproval = approval({ safetySnapshot: providerSafetySnapshot() });
		const fixture = deps({ instances: [instance("plex-1", "PLEX")], approval: storedApproval });
		installStatefulScanStore(fixture, rows, [storedApproval]);
		Object.assign(fixture.deps, {
			providerEvidenceAuthorityChecker: vi
				.fn()
				.mockRejectedValue(new ProviderExecutionAuthorityChangedError()),
		});

		const result = await triggerMediaServerRescansForApproval(
			fixture.deps,
			"user-1",
			storedApproval.id,
		);

		expect(result).toMatchObject({ triggered: 0, failed: 1, providerAuthorityFailed: true });
		expect(rows.map((row) => row.status)).toEqual(["failed", "pending"]);
		expect(fixture.plexClient.refreshSection).not.toHaveBeenCalled();
	});

	it("fail-stops later operations when Plex authority changes after a partial section dispatch", async () => {
		const rows = [
			scan("scan-movies", "plex-1", "PLEX", {
				plannedSectionIds: '["movies","movies-2"]',
			}),
			scan("scan-shows", "plex-1", "PLEX", {
				mediaType: "show",
				plannedSectionIds: '["shows"]',
				targetKey: "PLEX:plex-1:show",
			}),
		];
		const storedApproval = approval({ safetySnapshot: providerSafetySnapshot() });
		const fixture = deps({ instances: [instance("plex-1", "PLEX")], approval: storedApproval });
		installStatefulScanStore(fixture, rows, [storedApproval]);
		fixture.plexClient.getLibrarySections.mockResolvedValue([
			{ key: "movies", title: "Movies", type: "movie" },
			{ key: "movies-2", title: "More Movies", type: "movie" },
			{ key: "shows", title: "Shows", type: "show" },
		]);
		const authorityChecker = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new ProviderExecutionAuthorityChangedError())
			.mockResolvedValue(undefined);
		Object.assign(fixture.deps, { providerEvidenceAuthorityChecker: authorityChecker });
		const releaseLease = vi.fn().mockResolvedValue({ count: 1 });
		Object.assign(fixture.prisma, {
			libraryCleanupMediaServerScanLease: {
				create: vi.fn().mockResolvedValue({}),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
				deleteMany: releaseLease,
			},
		});

		const result = await triggerMediaServerRescansForApproval(
			fixture.deps,
			"user-1",
			storedApproval.id,
		);

		expect(result).toMatchObject({
			targets: 2,
			triggered: 0,
			failed: 0,
			providerAuthorityFailed: true,
		});
		expect(result.warnings).toContainEqual(expect.stringContaining("may have completed"));
		expect(fixture.plexClient.refreshSection.mock.calls).toEqual([["movies"]]);
		expect(rows[0]).toMatchObject({
			status: "triggering",
			executionToken: expect.any(String),
			requestStartedAt: expect.any(Date),
			lastError: null,
		});
		expect(rows[1]?.status).toBe("pending");
		expect(authorityChecker).toHaveBeenCalledTimes(3);
		expect(releaseLease).not.toHaveBeenCalled();
	});

	it("atomically claims equivalent rows so concurrent callers issue one physical refresh", async () => {
		const rows = [
			scan("scan-1", "jellyfin-1", "JELLYFIN"),
			scan("scan-2", "jellyfin-2", "JELLYFIN", {
				approvalId: "approval-2",
				targetKey: "JELLYFIN:jellyfin-2:movie",
			}),
		];
		const approvals = [approval(), approval({ id: "approval-2" })];
		const fixture = deps({
			instances: [instance("jellyfin-1", "JELLYFIN"), instance("jellyfin-2", "JELLYFIN")],
		});
		installStatefulScanStore(fixture, rows, approvals);
		let heldToken: string | null = null;
		Object.assign(fixture.prisma, {
			libraryCleanupMediaServerScanLease: {
				create: vi.fn(async ({ data }: { data: { executionToken: string } }) => {
					if (heldToken) throw Object.assign(new Error("leased"), { code: "P2002" });
					heldToken = data.executionToken;
				}),
				updateMany: vi.fn(async ({ where }: { where: { executionToken?: string } }) => ({
					count: where.executionToken === heldToken ? 1 : 0,
				})),
				deleteMany: vi.fn(async ({ where }: { where: { executionToken: string } }) => {
					if (where.executionToken === heldToken) heldToken = null;
					return { count: 1 };
				}),
			},
		});
		let releaseRefresh!: () => void;
		let refreshStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			refreshStarted = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		fixture.jellyfinClient.refreshLibrary.mockImplementationOnce(async () => {
			refreshStarted();
			await release;
		});

		const first = triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");
		await started;
		const second = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-2");
		releaseRefresh();
		const firstResult = await first;

		expect(second).toMatchObject({ triggered: 0, failed: 0 });
		expect(firstResult).toMatchObject({ triggered: 2, failed: 0 });
		expect(fixture.jellyfinClient.refreshLibrary).toHaveBeenCalledOnce();
		expect(rows.map((row) => row.status)).toEqual(["triggered", "triggered"]);
	});

	it("defers aggregate audit while another physical operation is still in flight", async () => {
		const rows = [
			scan("scan-jellyfin", "jellyfin-1", "JELLYFIN"),
			scan("scan-plex", "plex-1", "PLEX"),
		];
		const fixture = deps({
			instances: [instance("jellyfin-1", "JELLYFIN"), instance("plex-1", "PLEX")],
		});
		installStatefulScanStore(fixture, rows, [approval()]);
		const leases = new Map<string, string>();
		Object.assign(fixture.prisma, {
			libraryCleanupMediaServerScanLease: {
				create: vi.fn(
					async ({ data }: { data: { operationKey: string; executionToken: string } }) => {
						if (leases.has(data.operationKey)) {
							throw Object.assign(new Error("leased"), { code: "P2002" });
						}
						leases.set(data.operationKey, data.executionToken);
					},
				),
				updateMany: vi.fn(
					async ({ where }: { where: { operationKey: string; executionToken?: string } }) => ({
						count: leases.get(where.operationKey) === where.executionToken ? 1 : 0,
					}),
				),
				deleteMany: vi.fn(
					async ({ where }: { where: { operationKey: string; executionToken: string } }) => {
						if (leases.get(where.operationKey) === where.executionToken) {
							leases.delete(where.operationKey);
						}
						return { count: 1 };
					},
				),
			},
		});
		const auditCreate = vi.fn().mockResolvedValue({});
		Object.assign(fixture.prisma, {
			libraryCleanupAuditEvent: { create: auditCreate },
		});
		let releaseRefresh!: () => void;
		let refreshStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			refreshStarted = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		fixture.jellyfinClient.refreshLibrary.mockImplementationOnce(async () => {
			refreshStarted();
			await release;
		});

		const first = triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");
		await started;
		const second = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");
		expect(second).toMatchObject({ triggered: 1, failed: 0 });
		expect(
			auditCreate.mock.calls.some(([call]) => call.data.eventType === "media_rescan_failed"),
		).toBe(false);
		releaseRefresh();
		await first;

		expect(
			auditCreate.mock.calls.some(([call]) => call.data.eventType === "media_rescan_failed"),
		).toBe(false);
		expect(auditCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ eventType: "media_rescan_triggered" }),
			}),
		);
	});

	it("reissues a refresh after restart instead of trusting worker-local scan ordering", async () => {
		const deletionTime = new Date("2026-08-04T12:00:00.000Z");
		const scanTime = new Date("2026-08-04T12:01:00.000Z");
		const rows = [
			scan("scan-terminal", "jellyfin-1", "JELLYFIN", {
				status: "triggered",
				requestStartedAt: scanTime,
				triggeredAt: scanTime,
			}),
			scan("scan-pending", "jellyfin-2", "JELLYFIN", {
				approvalId: "approval-2",
				targetKey: "JELLYFIN:jellyfin-2:movie",
			}),
		];
		const approvals = [
			approval({ executedAt: deletionTime }),
			approval({ id: "approval-2", executedAt: deletionTime }),
		];
		const fixture = deps({
			instances: [instance("jellyfin-1", "JELLYFIN"), instance("jellyfin-2", "JELLYFIN")],
		});
		installStatefulScanStore(fixture, rows, approvals);

		const result = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-2");

		expect(result).toMatchObject({ triggered: 1, failed: 0 });
		expect(fixture.jellyfinClient.refreshLibrary).toHaveBeenCalledOnce();
		expect(rows[1]?.status).toBe("triggered");
		expect(rows[1]?.triggeredAt).not.toEqual(scanTime);
	});

	it("reissues a refresh when the pending sibling deletion followed the prior terminal scan", async () => {
		const scanTime = new Date("2026-08-04T12:00:00.000Z");
		const laterDeletion = new Date("2026-08-04T12:01:00.000Z");
		const rows = [
			scan("scan-terminal", "jellyfin-1", "JELLYFIN", {
				status: "triggered",
				requestStartedAt: scanTime,
				triggeredAt: scanTime,
			}),
			scan("scan-pending", "jellyfin-2", "JELLYFIN", {
				approvalId: "approval-2",
				targetKey: "JELLYFIN:jellyfin-2:movie",
			}),
		];
		const approvals = [
			approval({ executedAt: new Date("2026-08-04T11:59:00.000Z") }),
			approval({ id: "approval-2", executedAt: laterDeletion }),
		];
		const fixture = deps({
			instances: [instance("jellyfin-1", "JELLYFIN"), instance("jellyfin-2", "JELLYFIN")],
		});
		installStatefulScanStore(fixture, rows, approvals);

		await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-2");

		expect(fixture.jellyfinClient.refreshLibrary).toHaveBeenCalledOnce();
		expect(rows[1]?.status).toBe("triggered");
		expect(rows[1]?.triggeredAt).not.toEqual(scanTime);
	});

	it("coalesces an empty Plex section plan as one explicit no-op", async () => {
		const rows = [
			scan("scan-empty-1", "plex-1", "PLEX", { plannedSectionIds: "[]" }),
			scan("scan-empty-2", "plex-1", "PLEX", {
				approvalId: "approval-2",
				plannedSectionIds: "[]",
			}),
		];
		const approvals = [approval(), approval({ id: "approval-2" })];
		const fixture = deps({ instances: [instance("plex-1", "PLEX")] });
		installStatefulScanStore(fixture, rows, approvals);

		const result = await triggerCoalescedMediaServerRescans(fixture.deps, "user-1", [
			"approval-1",
			"approval-2",
		]);

		expect(result).toMatchObject({ targets: 2, triggered: 0, skipped: 2, failed: 0 });
		expect(fixture.plexClient.refreshSection).not.toHaveBeenCalled();
		expect(rows.map((row) => row.status)).toEqual(["skipped", "skipped"]);
	});

	it("never coalesces pending work across different physical server identities", async () => {
		const { fingerprint: _fingerprint, ...jellyfinSource } = testMediaEvidence.sources.find(
			(source) => source.service === "JELLYFIN",
		)!;
		const alternateSource = {
			...jellyfinSource,
			identityFingerprint: "b".repeat(64),
		};
		const alternateEvidence = createSanitizedProviderEvidence(
			[alternateSource.cacheType],
			[alternateSource],
		);
		const rows = [
			scan("scan-old", "jellyfin-1", "JELLYFIN", {
				approvalId: "approval-old",
			}),
			scan("scan-new", "jellyfin-2", "JELLYFIN", {
				approvalId: "approval-new",
				targetKey: "JELLYFIN:jellyfin-2:movie",
				serverIdentity: serializeProviderScanAuthority(
					{ instanceId: "jellyfin-2", service: "JELLYFIN", mediaType: "movie" },
					alternateEvidence,
				),
			}),
		];
		const approvals = [approval({ id: "approval-old" }), approval({ id: "approval-new" })];
		const fixture = deps({
			instances: [instance("jellyfin-1", "JELLYFIN"), instance("jellyfin-2", "JELLYFIN")],
		});
		installStatefulScanStore(fixture, rows, approvals);

		const result = await triggerCoalescedMediaServerRescans(fixture.deps, "user-1", [
			"approval-old",
			"approval-new",
		]);

		expect(result).toMatchObject({ targets: 2, triggered: 2, failed: 0 });
		expect(fixture.jellyfinClient.refreshLibrary).toHaveBeenCalledTimes(2);
		expect(rows.find((row) => row.id === "scan-old")?.status).toBe("triggered");
		expect(rows.find((row) => row.id === "scan-new")?.status).toBe("triggered");
	});

	it("does not let a narrower Plex section plan cover a broader plan", async () => {
		const rows = [
			scan("scan-movies", "plex-1", "PLEX"),
			scan("scan-movies-anime", "plex-1", "PLEX", {
				approvalId: "approval-2",
				plannedSectionIds: '["anime","movies"]',
			}),
		];
		const approvals = [approval(), approval({ id: "approval-2" })];
		const fixture = deps({ instances: [instance("plex-1", "PLEX")] });
		fixture.plexClient.getLibrarySections.mockResolvedValue([
			{ key: "movies", title: "Movies", type: "movie" },
			{ key: "anime", title: "Anime", type: "movie" },
		]);
		installStatefulScanStore(fixture, rows, approvals);

		const result = await triggerCoalescedMediaServerRescans(fixture.deps, "user-1", [
			"approval-1",
			"approval-2",
		]);

		expect(result).toMatchObject({ targets: 2, triggered: 2, failed: 0 });
		expect(fixture.plexClient.refreshSection).toHaveBeenCalledWith("anime");
		expect(rows.map((row) => row.status)).toEqual(["triggered", "triggered"]);
	});

	it("does not coalesce over a physical operation leased by another worker", async () => {
		const rows = [
			scan("scan-representative", "jellyfin-1", "JELLYFIN"),
			scan("scan-sibling", "jellyfin-1", "JELLYFIN", { approvalId: "approval-2" }),
		];
		const approvals = [approval(), approval({ id: "approval-2" })];
		const fixture = deps({ instances: [instance("jellyfin-1", "JELLYFIN")] });
		installStatefulScanStore(fixture, rows, approvals);
		Object.assign(fixture.prisma, {
			libraryCleanupMediaServerScanLease: {
				create: vi.fn().mockRejectedValue(Object.assign(new Error("leased"), { code: "P2002" })),
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
		});

		const result = await triggerCoalescedMediaServerRescans(fixture.deps, "user-1", [
			"approval-1",
			"approval-2",
		]);

		expect(result).toMatchObject({ targets: 2, triggered: 0, failed: 0 });
		expect(rows.map((row) => row.status)).toEqual(["pending", "pending"]);
	});

	it("never lets an old successful scan cover a newer deletion", async () => {
		const rows = [
			scan("scan-old-plex", "plex-1", "PLEX", {
				approvalId: "approval-old",
				status: "triggered",
			}),
			scan("scan-old-jellyfin", "jellyfin-1", "JELLYFIN", {
				approvalId: "approval-old",
				status: "failed",
			}),
			scan("scan-new-plex", "plex-1", "PLEX", { approvalId: "approval-new" }),
		];
		const approvals = [approval({ id: "approval-old" }), approval({ id: "approval-new" })];
		const fixture = deps({
			instances: [instance("plex-1", "PLEX"), instance("jellyfin-1", "JELLYFIN")],
		});
		fixture.jellyfinClient.refreshLibrary.mockRejectedValue(new Error("offline"));
		installStatefulScanStore(fixture, rows, approvals);

		await triggerCoalescedMediaServerRescans(fixture.deps, "user-1", [
			"approval-old",
			"approval-new",
		]);

		expect(fixture.plexClient.refreshSection).toHaveBeenCalledOnce();
		expect(rows.find((row) => row.id === "scan-new-plex")?.status).toBe("triggered");
		expect(rows.find((row) => row.id === "scan-old-jellyfin")?.status).toBe("failed");
	});

	it("attempts each failed target only once in a coalesced batch", async () => {
		const rows = [
			scan("scan-plex", "plex-1", "PLEX"),
			scan("scan-jellyfin", "jellyfin-1", "JELLYFIN"),
		];
		const fixture = deps({
			instances: [instance("plex-1", "PLEX"), instance("jellyfin-1", "JELLYFIN")],
		});
		fixture.jellyfinClient.refreshLibrary.mockRejectedValue(new Error("offline"));
		installStatefulScanStore(fixture, rows, [approval()]);

		const result = await triggerCoalescedMediaServerRescans(fixture.deps, "user-1", ["approval-1"]);

		expect(result).toMatchObject({ targets: 2, triggered: 1, failed: 1 });
		expect(fixture.plexClient.refreshSection).toHaveBeenCalledOnce();
		expect(fixture.jellyfinClient.refreshLibrary).toHaveBeenCalledOnce();
	});

	it("reclaims a stale triggering scan without repeating the ARR deletion", async () => {
		const staleScan = scan("scan-stale", "plex-1", "PLEX", {
			status: "triggering",
			executionToken: "abandoned",
			updatedAt: new Date(Date.now() - 11 * 60 * 1000),
		});
		const fixture = deps({
			instances: [instance("plex-1", "PLEX")],
			scans: [staleScan],
		});

		const result = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");

		expect(result).toMatchObject({ targets: 1, triggered: 1, failed: 0 });
		expect(fixture.plexClient.refreshSection).toHaveBeenCalledWith("movies");
	});

	it("holds the cleanup run claim across scheduled scan validation and dispatch", async () => {
		const plex = instance("plex-1", "PLEX");
		const rows = [scan("scan-plex", plex.id, "PLEX")];
		const storedApproval = approval();
		const fixture = deps({ instances: [plex], scans: rows, approval: storedApproval });
		const claimStore = installRecoveryRunClaimStore(fixture, [
			{
				id: "config-1",
				userId: "user-1",
				runClaimToken: null,
				runClaimedAt: null,
			},
		]);
		installRecoveryCandidateProjection(fixture, rows, {
			[storedApproval.id]: { id: "config-1", userId: "user-1" },
		});
		const publicationWrites: string[] = [];
		const publish = async (label: string) =>
			await withCurrentProviderPublicationAuthority(
				fixture.prisma as never,
				plex as never,
				async () => {
					publicationWrites.push(label);
					return label;
				},
			);
		await expect(publish("before-recovery")).resolves.toMatchObject({ matched: true });
		const observedClaimTokens: Array<string | null> = [];
		const duringPublicationResults: boolean[] = [];
		Object.assign(fixture.deps, {
			providerEvidenceAuthorityChecker: vi.fn(
				async (_userId: string, _evidence: unknown, assertLease?: () => Promise<void>) => {
					await assertLease?.();
					observedClaimTokens.push(claimStore.configs[0]!.runClaimToken);
					duringPublicationResults.push((await publish("during-recovery")).matched);
				},
			),
		});
		const networkTransactionDepth: number[] = [];
		fixture.plexClient.refreshSection.mockImplementation(async () => {
			networkTransactionDepth.push(claimStore.transactionState.depth);
		});

		const result = await retryAllPendingMediaServerRescans(fixture.deps);

		expect(result).toMatchObject({ targets: 1, triggered: 1, failed: 0 });
		expect(observedClaimTokens).toEqual([expect.any(String), expect.any(String)]);
		expect(duringPublicationResults).toEqual([false, false]);
		expect(publicationWrites).toEqual(["before-recovery"]);
		expect(networkTransactionDepth).toEqual([0]);
		expect(claimStore.configs[0]?.runClaimToken).toBeNull();
		await expect(publish("after-recovery")).resolves.toMatchObject({ matched: true });
		expect(publicationWrites).toEqual(["before-recovery", "after-recovery"]);
	});

	it("defers an actively claimed recovery owner without blocking another user", async () => {
		const userOnePlex = instance("plex-user-1", "PLEX");
		const userTwoPlex = { ...instance("plex-user-2", "PLEX"), userId: "user-2" };
		const approvals = [
			approval({ id: "approval-user-1", configId: "config-user-1" }),
			approval({ id: "approval-user-2", configId: "config-user-2" }),
		];
		const rows = [
			scan("scan-user-1", userOnePlex.id, "PLEX", { approvalId: approvals[0]!.id }),
			scan("scan-user-2", userTwoPlex.id, "PLEX", { approvalId: approvals[1]!.id }),
		];
		const fixture = deps({ instances: [userOnePlex, userTwoPlex] });
		installStatefulScanStore(fixture, rows, approvals);
		const claimStore = installRecoveryRunClaimStore(fixture, [
			{
				id: "config-user-1",
				userId: "user-1",
				runClaimToken: "normal-cleanup-owner",
				runClaimedAt: new Date(),
			},
			{
				id: "config-user-2",
				userId: "user-2",
				runClaimToken: null,
				runClaimedAt: null,
			},
		]);
		installRecoveryCandidateProjection(fixture, rows, {
			[approvals[0]!.id]: { id: "config-user-1", userId: "user-1" },
			[approvals[1]!.id]: { id: "config-user-2", userId: "user-2" },
		});
		const validatedUsers: string[] = [];
		Object.assign(fixture.deps, {
			providerEvidenceAuthorityChecker: vi.fn(
				async (userId: string, _evidence: unknown, assertLease?: () => Promise<void>) => {
					await assertLease?.();
					validatedUsers.push(userId);
				},
			),
		});

		const result = await retryAllPendingMediaServerRescans(fixture.deps);

		expect(result).toMatchObject({ targets: 1, triggered: 1, failed: 0 });
		expect(validatedUsers).toEqual(["user-2", "user-2"]);
		expect(rows[0]?.status).toBe("pending");
		expect(rows[1]?.status).toBe("triggered");
		expect(claimStore.configs[0]?.runClaimToken).toBe("normal-cleanup-owner");
		expect(claimStore.configs[1]?.runClaimToken).toBeNull();
		expect(fixture.plexClient.refreshSection).toHaveBeenCalledOnce();
	});

	it("stops scheduled recovery before dispatch when its cleanup claim is lost", async () => {
		const plex = instance("plex-1", "PLEX");
		const rows = [scan("scan-plex", plex.id, "PLEX")];
		const storedApproval = approval();
		const fixture = deps({ instances: [plex], scans: rows, approval: storedApproval });
		const claimStore = installRecoveryRunClaimStore(fixture, [
			{
				id: "config-1",
				userId: "user-1",
				runClaimToken: null,
				runClaimedAt: null,
			},
		]);
		installRecoveryCandidateProjection(fixture, rows, {
			[storedApproval.id]: { id: "config-1", userId: "user-1" },
		});
		const updateClaim = claimStore.updateMany.getMockImplementation()!;
		claimStore.updateMany.mockImplementation(async (args) => {
			if (!args.where.OR && args.where.runClaimToken && args.data.runClaimToken === undefined) {
				claimStore.configs[0]!.runClaimToken = "replacement-owner";
				return { count: 0 };
			}
			return await updateClaim(args);
		});
		Object.assign(fixture.deps, {
			providerEvidenceAuthorityChecker: vi.fn(
				async (_userId: string, _evidence: unknown, assertLease?: () => Promise<void>) => {
					await assertLease?.();
				},
			),
		});

		const result = await retryAllPendingMediaServerRescans(fixture.deps);

		expect(result).toMatchObject({ targets: 0, triggered: 0, failed: 0 });
		expect(fixture.plexClient.refreshSection).not.toHaveBeenCalled();
		expect(rows[0]).toMatchObject({ status: "pending", executionToken: null });
		expect(claimStore.configs[0]?.runClaimToken).toBe("replacement-owner");
	});

	it("reclaims a fast-worker crash using only database eligibility and lease clocks", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		try {
			const abandoned = scan("scan-jellyfin", "jellyfin-1", "JELLYFIN", {
				status: "triggering",
				executionToken: "fast-worker",
				requestStartedAt: new Date("2099-01-01T00:00:00.000Z"),
				updatedAt: new Date("2099-01-01T00:00:00.000Z"),
			});
			const fixture = deps({
				instances: [instance("jellyfin-1", "JELLYFIN")],
				scans: [abandoned],
			});
			const executeRaw = vi.fn(async (query: string) => {
				if (query.startsWith("INSERT")) return 0;
				return 1;
			});
			Object.assign(fixture.prisma, {
				$executeRawUnsafe: executeRaw,
				$queryRawUnsafe: vi.fn().mockResolvedValue([{ id: abandoned.id }]),
				libraryCleanupMediaServerScanLease: {
					create: vi.fn(),
					updateMany: vi.fn(),
					deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
				},
			});

			const result = await triggerMediaServerRescansForApproval(
				fixture.deps,
				"user-1",
				"approval-1",
			);

			expect(result).toMatchObject({ triggered: 1, failed: 0 });
			expect(fixture.jellyfinClient.refreshLibrary).toHaveBeenCalledOnce();
			const reclaimCall = executeRaw.mock.calls.find(
				([query]) => String(query).startsWith("UPDATE") && String(query).includes("-10 minutes"),
			);
			expect(reclaimCall?.[0]).toContain("julianday('now', '-10 minutes')");
			expect(reclaimCall?.slice(1).some((value) => (value as unknown) instanceof Date)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retains the lease without an ownership read after upstream-success persistence failure", async () => {
		const rows = [scan("scan-jellyfin", "jellyfin-1", "JELLYFIN")];
		const fixture = deps({ instances: [instance("jellyfin-1", "JELLYFIN")] });
		installStatefulScanStore(fixture, rows, [approval()]);
		const statefulUpdate =
			fixture.prisma.libraryCleanupMediaServerScan.updateMany.getMockImplementation();
		fixture.prisma.libraryCleanupMediaServerScan.updateMany.mockImplementation(
			async (args: { data: Record<string, unknown> }) => {
				if (args.data.status === "triggered") {
					throw new Error("terminal persistence unavailable");
				}
				return await statefulUpdate!(args as never);
			},
		);
		const statefulFind =
			fixture.prisma.libraryCleanupMediaServerScan.findMany.getMockImplementation();
		const ambiguousOwnershipRead = vi
			.fn()
			.mockRejectedValue(new Error("ownership read unavailable"));
		fixture.prisma.libraryCleanupMediaServerScan.findMany.mockImplementation(
			async (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
				if (
					args.where.status === "triggering" &&
					args.where.executionToken &&
					args.select?.attemptCount === true
				) {
					return await ambiguousOwnershipRead();
				}
				return await statefulFind!(args as never);
			},
		);
		const releaseLease = vi.fn().mockResolvedValue({ count: 1 });
		Object.assign(fixture.prisma, {
			libraryCleanupMediaServerScanLease: {
				create: vi.fn().mockResolvedValue({}),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
				deleteMany: releaseLease,
			},
		});

		const result = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");

		expect(fixture.jellyfinClient.refreshLibrary).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ triggered: 0, failed: 0 });
		expect(result.warnings).toEqual([expect.stringContaining("may have completed")]);
		expect(rows[0]).toMatchObject({ status: "triggering", lastError: null });
		expect(ambiguousOwnershipRead).not.toHaveBeenCalled();
		expect(releaseLease).not.toHaveBeenCalled();
	});

	it("keeps a verified no-op persistence failure out of scan-failure state", async () => {
		const rows = [
			scan("scan-empty-plex", "plex-1", "PLEX", {
				plannedSectionIds: "[]",
			}),
		];
		const fixture = deps({ instances: [instance("plex-1", "PLEX")] });
		installStatefulScanStore(fixture, rows, [approval()]);
		const statefulUpdate =
			fixture.prisma.libraryCleanupMediaServerScan.updateMany.getMockImplementation();
		fixture.prisma.libraryCleanupMediaServerScan.updateMany.mockImplementation(
			async (args: { data: Record<string, unknown> }) => {
				if (args.data.status === "skipped") {
					throw new Error("terminal persistence unavailable");
				}
				return await statefulUpdate!(args as never);
			},
		);
		const releaseLease = vi.fn().mockResolvedValue({ count: 1 });
		Object.assign(fixture.prisma, {
			libraryCleanupMediaServerScanLease: {
				create: vi.fn().mockResolvedValue({}),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
				deleteMany: releaseLease,
			},
		});

		const result = await triggerMediaServerRescansForApproval(fixture.deps, "user-1", "approval-1");

		expect(fixture.plexClient.refreshSection).not.toHaveBeenCalled();
		expect(result).toMatchObject({ triggered: 0, skipped: 0, failed: 0 });
		expect(result.warnings).toEqual([expect.stringContaining("verified as unnecessary")]);
		expect(rows[0]).toMatchObject({ status: "triggering", lastError: null });
		expect(releaseLease).not.toHaveBeenCalled();
	});
});
