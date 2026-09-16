import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

const mocks = vi.hoisted(() => ({
	loadUserEvidence: vi.fn(),
	scanUserPolicyEvidence: vi.fn(),
	readSelectedDisplay: vi.fn(),
	readInsightWatchEvidence: vi.fn(),
	seerrConstructed: vi.fn(),
	seerrGetRequests: vi.fn(),
	legacyJellyfinFindMany: vi.fn(),
}));

vi.mock("../../lib/plex/plex-evidence-repository.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/plex/plex-evidence-repository.js")>()),
	loadUserEvidence: mocks.loadUserEvidence,
	scanUserPolicyEvidence: mocks.scanUserPolicyEvidence,
}));

vi.mock("../../lib/plex/plex-authority-service.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/plex/plex-authority-service.js")>()),
	PlexAuthorityService: class {
		async readUserSelectedDisplay(input: unknown) {
			return await mocks.readSelectedDisplay(input);
		}
		async scanUserPolicy(input: unknown) {
			return await mocks.scanUserPolicyEvidence(undefined, input);
		}
	},
}));
vi.mock("../../lib/library-insights/watch-evidence.js", () => ({
	readOwnedJellyfinInsightWatchEvidence: mocks.readInsightWatchEvidence,
}));
vi.mock("../../lib/jellyfin/jellyfin-display-evidence.js", async (original) => ({
	...(await original<typeof import("../../lib/jellyfin/jellyfin-display-evidence.js")>()),
	readOwnedJellyfinLibraryDisplaySources: async (input: unknown) => {
		const result = await mocks.readInsightWatchEvidence(input);
		return {
			sources: (result.providerStatus?.sources ?? []).map((source: { instanceId: string }) => ({
				instanceId: source.instanceId,
				rows: result.rows,
			})),
			providerStatus: result.providerStatus,
		};
	},
}));
vi.mock("../../lib/seerr/seerr-client.js", () => ({
	SeerrClient: class {
		constructor(...args: unknown[]) {
			mocks.seerrConstructed(...args);
		}

		async getRequests(...args: unknown[]) {
			return await mocks.seerrGetRequests(...args);
		}
	},
}));

import { registerInsightsRoutes } from "../library/insights-routes.js";

const unavailableEvidence = {
	availability: "last-known",
	authority: "unavailable",
	attemptState: "in_progress",
	publicationLevel: "unavailable",
	completeness: "unknown",
	reasonCodes: ["latest_attempt_in_progress"],
	publishedGeneration: {
		generationId: "generation-1",
		publicationLevel: "authoritative",
		publishedAt: "2026-08-20T12:00:00.000Z",
		itemCount: 1,
	},
} as const;

function exactWatchStatus() {
	return {
		availability: "current",
		evidence: "complete",
		observedAt: "2026-09-15T00:00:00.000Z",
		ageSeconds: 0,
		latestAttempt: "successful",
		reasonCodes: [],
		domains: [
			{
				domain: "watch-count",
				availability: "current",
				evidence: "complete",
				valueSemantics: "exact",
				reasonCodes: [],
			},
		],
	};
}

const authoritativePlexEvidence = [
	{
		available: true,
		instanceId: "plex-1",
		rows: [],
		providerStatus: exactWatchStatus(),
		evidence: {
			availability: "current",
			authority: "authoritative",
			attemptState: "idle",
			publicationLevel: "authoritative",
			completeness: "complete",
			reasonCodes: [],
		},
	},
];

const jellyfinInstances = [
	{ id: "jellyfin-1", label: "Jellyfin One", service: "JELLYFIN" },
	{ id: "emby-1", label: "Emby One", service: "EMBY" },
] as const;

const currentStatus = {
	domains: exactWatchStatus().domains,
	availability: "current",
	evidence: "complete",
	observedAt: "2026-09-03T00:00:00.000Z",
	ageSeconds: 0,
	latestAttempt: "successful",
	reasonCodes: [],
} as const;

function sourceStatus(instanceId: string, status: Record<string, unknown>) {
	return {
		instanceId,
		service: instanceId.startsWith("emby") ? "emby" : "jellyfin",
		cacheType: "jellyfin",
		status,
	};
}

function watchEvidence({
	statuses,
	rows = [],
	configured = true,
	positive = true,
	negative = false,
	availability = "partial",
}: {
	statuses: ReadonlyArray<{ instanceId: string; status: Record<string, unknown> }>;
	rows?: ReadonlyArray<Record<string, unknown>>;
	configured?: boolean;
	positive?: boolean;
	negative?: boolean;
	availability?: string;
}) {
	return {
		configured,
		rows,
		providerStatus: configured
			? {
					availability,
					sources: statuses.map(({ instanceId, status }) => sourceStatus(instanceId, status)),
				}
			: undefined,
		hasPositiveEvidence: positive,
		negativeClaimsAuthoritative: negative,
	};
}

const privateWatchRow = {
	tmdbId: 42,
	mediaType: "movie",
	watchCount: 2,
	lastWatchedAt: new Date("2026-09-02T00:00:00.000Z"),
	rowId: "private-row-id",
	providerItemId: "private-provider-item",
	title: "Private helper title",
	userList: ["private-user"],
	libraryName: "Private library",
	url: "https://private.invalid/item",
};

const zeroWatchRow = { ...privateWatchRow, watchCount: 0 };

function candidateItem(overrides: Record<string, unknown> = {}) {
	return {
		instanceId: "sonarr-1",
		arrItemId: 42,
		itemType: "movie",
		title: "Public candidate",
		year: 2024,
		sizeOnDisk: BigInt(2 * 1024 * 1024 * 1024),
		arrAddedAt: new Date("2026-01-01T00:00:00.000Z"),
		monitored: true,
		qualityProfileName: "HD",
		hasFile: true,
		status: "ended",
		data: JSON.stringify({ remoteIds: { tmdbId: 42 } }),
		...overrides,
	};
}

const statusWith = (availability: string, evidence: string) => ({
	domains: [
		{
			domain: "watch-count",
			availability: availability === "partial" ? "current" : availability,
			evidence,
			valueSemantics:
				evidence === "complete" ? "exact" : evidence === "unknown" ? "unknown" : "lower-bound",
			reasonCodes: [],
		},
	],
	availability,
	evidence,
	observedAt: availability === "unavailable" ? null : "2026-09-01T00:00:00.000Z",
	ageSeconds: availability === "unavailable" ? null : 3600,
	latestAttempt: "successful",
	reasonCodes: availability === "unavailable" ? ["unknown-failure"] : [],
});

const degradedTopologies = [
	[
		"complete last-known",
		[{ instanceId: "jellyfin-1", status: statusWith("last-known", "complete") }],
		true,
		"partial",
	],
	[
		"mixed",
		[
			{ instanceId: "jellyfin-1", status: statusWith("current", "complete") },
			{ instanceId: "emby-1", status: statusWith("unavailable", "unknown") },
		],
		true,
		"partial",
	],
	[
		"partial",
		[{ instanceId: "jellyfin-1", status: statusWith("partial", "partial") }],
		true,
		"partial",
	],
	[
		"positive-only",
		[{ instanceId: "jellyfin-1", status: statusWith("current", "positive-only") }],
		true,
		"current",
	],
	[
		"unknown",
		[{ instanceId: "jellyfin-1", status: statusWith("current", "unknown") }],
		true,
		"current",
	],
	[
		"unavailable",
		[{ instanceId: "jellyfin-1", status: statusWith("unavailable", "unknown") }],
		false,
		"unavailable",
	],
] as const;

describe("library insight Plex authority contracts", () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		vi.resetAllMocks();
		const evidence = [
			{
				available: true,
				instanceId: "plex-1",
				rows: [],
				evidence: unavailableEvidence,
			},
		];
		mocks.loadUserEvidence.mockResolvedValue(evidence);
		mocks.scanUserPolicyEvidence.mockResolvedValue(evidence);
		mocks.readSelectedDisplay.mockImplementation((input) =>
			mocks.scanUserPolicyEvidence(undefined, input),
		);
		mocks.readInsightWatchEvidence.mockResolvedValue({
			configured: false,
			rows: [],
			providerStatus: undefined,
			hasPositiveEvidence: false,
			negativeClaimsAuthoritative: false,
		});
		mocks.seerrGetRequests.mockResolvedValue({ results: [] });
		mocks.legacyJellyfinFindMany.mockReset();
		mocks.legacyJellyfinFindMany.mockImplementation(() => {
			throw new Error("direct jellyfin cache access is forbidden");
		});

		app = Fastify({ logger: false });
		setupAuthInjection(app);
		app.decorate("prisma", {
			serviceInstance: {
				findMany: vi.fn(async ({ where }: { where?: { service?: { in?: string[] } } }) =>
					where?.service?.in?.includes("SONARR")
						? [{ id: "sonarr-1", label: "Sonarr", service: "SONARR" }]
						: [],
				),
				findFirst: vi.fn(async () => ({
					id: "seerr-1",
					baseUrl: "http://seerr.invalid",
					encryptedApiKey: "encrypted",
					encryptionIv: "iv",
					encryptedHttpAuthCredentials: null,
					httpAuthEncryptionIv: null,
					service: "SEERR",
					label: "Seerr",
				})),
			},
			libraryCache: { findMany: vi.fn(async () => []) },
			jellyfinCache: { findMany: mocks.legacyJellyfinFindMany },
		} as never);
		await app.register(registerInsightsRoutes, { prefix: "/api" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		vi.clearAllMocks();
	});

	it.each([
		["disk-waste", "/api/library/insights/disk-waste", "totalWastedBytes"],
		["requested-unwatched", "/api/library/insights/requested-unwatched", "hasWatchData"],
	] as const)(
		"withholds %s conclusions while a refresh is in progress",
		async (_name, url, field) => {
			const response = await createInjectAuthenticated(app)("GET", url);
			const body = response.json();

			expect(response.statusCode).toBe(200);
			expect(body).toMatchObject({
				success: true,
				data: { items: [], unknownItems: [], hasWatchData: false },
				evidence: unavailableEvidence,
			});
			if (field === "totalWastedBytes") expect(body.data.totalWastedBytes).toBeNull();
			expect(JSON.stringify(body)).not.toContain("in_progress:");
		},
	);

	it("shows current positive Plex watch observations without global exact authority", async () => {
		const status = {
			availability: "partial",
			evidence: "positive-only",
			observedAt: "2026-09-14T00:00:00.000Z",
			ageSeconds: 0,
			latestAttempt: "successful",
			reasonCodes: ["coverage-incomplete"],
			domains: [
				{
					domain: "watch-count",
					availability: "current",
					evidence: "positive-only",
					valueSemantics: "lower-bound",
					observedAt: "2026-09-14T00:00:00.000Z",
					reasonCodes: [],
				},
				{
					domain: "watch-attribution",
					availability: "current",
					evidence: "positive-only",
					valueSemantics: "lower-bound",
					observedAt: "2026-09-14T00:00:00.000Z",
					reasonCodes: [],
				},
			],
		};
		mocks.readSelectedDisplay.mockResolvedValue([
			{
				available: true,
				instanceId: "plex-1",
				providerStatus: status,
				evidence: {
					availability: "current",
					authority: "positive-only",
					attemptState: "partial",
					publicationLevel: "positive-only",
					completeness: "partial",
					reasonCodes: ["latest_attempt_partial"],
				},
				rows: [{ ...privateWatchRow, watchCount: 3, watchedByUsers: '["private-user"]' }],
			},
		]);
		(app.prisma.libraryCache.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
			candidateItem(),
		]);
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/library/insights/watched-monitored",
		);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			data: {
				hasPlexData: true,
				hasWatchData: true,
				items: [{ watchCount: 3, watchCountSemantics: "lower-bound", lastWatchedAt: null }],
			},
			evidence: { completeness: "partial" },
		});
		expect(mocks.readSelectedDisplay).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				selection: { kind: "targets", targets: [{ tmdbId: 42, mediaType: "movie" }] },
			}),
		);
		expect(mocks.scanUserPolicyEvidence).not.toHaveBeenCalled();
		expect(response.body).not.toContain("private-user");
	});

	it.each([0, -1, Number.NaN])(
		"does not turn an unproven Plex count %s into a watched result",
		async (watchCount) => {
			mocks.readSelectedDisplay.mockResolvedValue([
				{
					available: true,
					instanceId: "plex-1",
					evidence: {
						...unavailableEvidence,
						publicationLevel: "positive-only",
						completeness: "partial",
					},
					providerStatus: {
						...currentStatus,
						evidence: "positive-only",
						domains: [
							{
								domain: "watch-count",
								availability: "current",
								evidence: "positive-only",
								valueSemantics: "lower-bound",
								observedAt: currentStatus.observedAt,
								reasonCodes: [],
							},
						],
					},
					rows: [{ ...privateWatchRow, watchCount, watchedByUsers: "[]" }],
				},
			]);
			(app.prisma.libraryCache.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
				candidateItem(),
			]);
			const response = await createInjectAuthenticated(app)(
				"GET",
				"/api/library/insights/watched-monitored",
			);
			expect(response.statusCode).toBe(200);
			expect(response.json().data).toMatchObject({
				items: [],
				hasPlexData: false,
				hasWatchData: false,
			});
		},
	);

	it("does not sum potentially overlapping watch observations from multiple servers", async () => {
		const source = {
			available: true,
			instanceId: "plex-1",
			evidence: {
				...unavailableEvidence,
				publicationLevel: "positive-only",
				completeness: "partial",
			},
			providerStatus: {
				...currentStatus,
				evidence: "positive-only",
				domains: [
					{
						domain: "watch-count",
						availability: "current",
						evidence: "positive-only",
						valueSemantics: "lower-bound",
						observedAt: currentStatus.observedAt,
						reasonCodes: [],
					},
				],
			},
			rows: [{ ...privateWatchRow, watchCount: 3, watchedByUsers: "[]" }],
		};
		mocks.readSelectedDisplay.mockResolvedValue([source, { ...source, instanceId: "plex-2" }]);
		mocks.readInsightWatchEvidence.mockResolvedValue(
			watchEvidence({
				statuses: [{ instanceId: "jellyfin-1", status: currentStatus }],
				rows: [privateWatchRow],
			}),
		);
		(app.prisma.libraryCache.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
			candidateItem(),
		]);
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/library/insights/watched-monitored",
		);
		expect(response.json().data.items).toMatchObject([
			{ watchCount: 3, watchCountSemantics: "lower-bound", lastWatchedAt: null },
		]);
	});

	it("retains Jellyfin watched results when Plex is unavailable", async () => {
		mocks.readInsightWatchEvidence.mockResolvedValue(
			watchEvidence({
				statuses: [{ instanceId: "jellyfin-1", status: currentStatus }],
				rows: [privateWatchRow],
				negative: true,
				availability: "current",
			}),
		);
		(app.prisma.libraryCache.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
			candidateItem(),
		]);
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/library/insights/watched-monitored",
		);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			data: { hasPlexData: false, hasWatchData: true, items: [{ watchCount: 2 }] },
			evidence: { authority: "unavailable" },
		});
	});

	it("returns unavailable Plex coverage without claiming an empty watched inventory", async () => {
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/library/insights/watched-monitored",
		);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			data: { items: [], hasPlexData: false, hasWatchData: false },
			evidence: unavailableEvidence,
		});
	});

	it("withholds disk-waste conclusions for a degraded owned Jellyfin topology while reading candidates", async () => {
		mocks.scanUserPolicyEvidence.mockResolvedValue([]);
		mocks.readInsightWatchEvidence.mockResolvedValueOnce({
			configured: true,
			rows: [],
			providerStatus: {
				availability: "partial",
				sources: [
					{
						instanceId: "jellyfin-1",
						service: "jellyfin",
						cacheType: "jellyfin",
						status: {
							availability: "last-known",
							evidence: "complete",
							observedAt: "2026-09-01T00:00:00.000Z",
							ageSeconds: 3600,
							latestAttempt: "successful",
							reasonCodes: [],
							domains: [
								{
									domain: "watch-count",
									availability: "last-known",
									evidence: "complete",
									valueSemantics: "exact",
									reasonCodes: [],
								},
							],
						},
					},
				],
			},
			hasPositiveEvidence: true,
			negativeClaimsAuthoritative: false,
		});
		const serviceInstanceFindMany = app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>;
		serviceInstanceFindMany.mockImplementation(
			async ({ where }: { where: { service?: { in?: string[] } } }) =>
				where.service?.in?.includes("SONARR")
					? [{ id: "sonarr-1", label: "Sonarr", service: "SONARR" }]
					: [{ id: "jellyfin-1", label: "Jellyfin", service: "JELLYFIN" }],
		);
		const libraryFindMany = app.prisma.libraryCache.findMany as ReturnType<typeof vi.fn>;

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/library/insights/disk-waste",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: true,
			data: { items: [], totalWastedBytes: null, hasPlexData: false, hasWatchData: true },
			providerStatus: { availability: "partial" },
		});
		expect(mocks.readInsightWatchEvidence).toHaveBeenCalledTimes(1);
		expect(libraryFindMany).toHaveBeenCalled();
		expect(serviceInstanceFindMany).toHaveBeenCalledWith({
			where: { userId: expect.any(String), enabled: true, service: { in: ["JELLYFIN", "EMBY"] } },
			select: { id: true, label: true, service: true },
		});
	});

	it.each([
		["disk-waste", "/api/library/insights/disk-waste"],
		["watched-monitored", "/api/library/insights/watched-monitored"],
		["requested-unwatched", "/api/library/insights/requested-unwatched"],
	] as const)("binds the exact owned topology and one helper call for %s", async (_name, url) => {
		const serviceInstanceFindMany = app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>;
		serviceInstanceFindMany.mockImplementation(
			async ({ where }: { where: { service?: { in?: string[] } } }) => {
				if (where.service?.in?.includes("SONARR")) {
					return [{ id: "sonarr-1", label: "Sonarr", service: "SONARR" }];
				}
				if (where.service?.in?.includes("JELLYFIN")) return [...jellyfinInstances];
				return [];
			},
		);
		mocks.scanUserPolicyEvidence.mockResolvedValueOnce([]);
		mocks.readInsightWatchEvidence.mockResolvedValueOnce(
			watchEvidence({
				statuses: jellyfinInstances.map(({ id }) => ({ instanceId: id, status: currentStatus })),
				negative: true,
			}),
		);

		const response = await createInjectAuthenticated(app)("GET", url);

		expect(response.statusCode).toBe(200);
		expect(mocks.readInsightWatchEvidence).toHaveBeenCalledTimes(1);
		expect(mocks.readInsightWatchEvidence).toHaveBeenCalledWith({
			prisma: app.prisma,
			userId: "user-1",
			instances: [...jellyfinInstances],
		});
		expect(
			serviceInstanceFindMany.mock.calls.filter(([args]) =>
				args.where?.service?.in?.includes("JELLYFIN"),
			),
		).toHaveLength(1);
		expect(serviceInstanceFindMany).toHaveBeenCalledWith({
			where: { userId: "user-1", enabled: true, service: { in: ["JELLYFIN", "EMBY"] } },
			select: { id: true, label: true, service: true },
		});
		expect(mocks.legacyJellyfinFindMany).not.toHaveBeenCalled();
	});

	it.each(degradedTopologies)(
		"blocks degraded %s disk-waste conclusions while retaining candidate access, even with Plex authority",
		async (_name, statuses, positive, availability) => {
			const serviceInstanceFindMany = app.prisma.serviceInstance.findMany as ReturnType<
				typeof vi.fn
			>;
			serviceInstanceFindMany.mockImplementation(
				async ({ where }: { where: { service?: { in?: string[] } } }) =>
					where.service?.in?.includes("JELLYFIN")
						? [...jellyfinInstances]
						: [{ id: "sonarr-1", label: "Sonarr", service: "SONARR" }],
			);
			mocks.scanUserPolicyEvidence.mockResolvedValueOnce(authoritativePlexEvidence);
			mocks.readInsightWatchEvidence.mockResolvedValueOnce(
				watchEvidence({ statuses, positive, availability, negative: false }),
			);

			const response = await createInjectAuthenticated(app)(
				"GET",
				"/api/library/insights/disk-waste",
			);
			const body = response.json();

			expect(response.statusCode).toBe(200);
			expect(body).toMatchObject({
				success: true,
				data: { items: [], totalWastedBytes: null, hasPlexData: true, hasWatchData: true },
				providerStatus: { availability },
			});
			expect(body).not.toHaveProperty("data.items[0]");
			expect(app.prisma.libraryCache.findMany).toHaveBeenCalled();
		},
	);

	it.each(degradedTopologies)(
		"blocks degraded %s requested-unwatched while retaining Seerr request access",
		async (_name, statuses, positive, availability) => {
			const serviceInstanceFindMany = app.prisma.serviceInstance.findMany as ReturnType<
				typeof vi.fn
			>;
			serviceInstanceFindMany.mockImplementation(
				async ({ where }: { where: { service?: { in?: string[] } } }) =>
					where.service?.in?.includes("JELLYFIN")
						? [...jellyfinInstances]
						: [{ id: "sonarr-1", label: "Sonarr", service: "SONARR" }],
			);
			mocks.scanUserPolicyEvidence.mockResolvedValueOnce(authoritativePlexEvidence);
			mocks.readInsightWatchEvidence.mockResolvedValueOnce(
				watchEvidence({ statuses, positive, availability, negative: false }),
			);

			const response = await createInjectAuthenticated(app)(
				"GET",
				"/api/library/insights/requested-unwatched",
			);
			const body = response.json();

			expect(response.statusCode).toBe(200);
			expect(body).toMatchObject({
				success: true,
				data: { items: [], hasSeerrData: true, hasPlexData: true, hasWatchData: true },
				providerStatus: { availability },
			});
			expect(mocks.seerrConstructed).toHaveBeenCalledTimes(1);
			expect(mocks.seerrGetRequests).toHaveBeenCalledTimes(1);
			expect(app.prisma.libraryCache.findMany).not.toHaveBeenCalled();
		},
	);

	it("preserves the no-provider disk-waste data flags and omits status", async () => {
		mocks.scanUserPolicyEvidence.mockResolvedValueOnce([]);
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/library/insights/disk-waste",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: true,
			data: { items: [], totalWastedBytes: null, hasPlexData: false, hasWatchData: false },
		});
		expect(response.json()).not.toHaveProperty("providerStatus");
	});

	it.each([
		["watched-monitored", "/api/library/insights/watched-monitored"],
		["requested-unwatched", "/api/library/insights/requested-unwatched"],
	] as const)("keeps the %s no-provider response empty without status", async (_name, url) => {
		mocks.scanUserPolicyEvidence.mockResolvedValue([]);
		const response = await createInjectAuthenticated(app)("GET", url);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: true,
			data: { items: [], hasPlexData: false, hasWatchData: false },
		});
		expect(response.json()).not.toHaveProperty("providerStatus");
		expect(mocks.readInsightWatchEvidence).toHaveBeenCalledTimes(1);
	});

	it.each([
		["positive watch row", [privateWatchRow], 0],
		["verified zero watch row", [zeroWatchRow], 1],
		["missing watch row", [], 0],
	] as const)(
		"evaluates disk-waste candidates with current-complete evidence: %s",
		async (_name, rows, expectedItems) => {
			const serviceInstanceFindMany = app.prisma.serviceInstance.findMany as ReturnType<
				typeof vi.fn
			>;
			serviceInstanceFindMany.mockImplementation(
				async ({ where }: { where: { service?: { in?: string[] } } }) =>
					where.service?.in?.includes("JELLYFIN")
						? [{ ...jellyfinInstances[0] }]
						: [{ id: "sonarr-1", label: "Sonarr", service: "SONARR" }],
			);
			mocks.scanUserPolicyEvidence.mockResolvedValueOnce([]);
			mocks.readInsightWatchEvidence.mockResolvedValueOnce(
				watchEvidence({
					statuses: [{ instanceId: "jellyfin-1", status: currentStatus }],
					rows,
					negative: true,
					availability: "current",
				}),
			);
			const libraryFindMany = app.prisma.libraryCache.findMany as ReturnType<typeof vi.fn>;
			libraryFindMany.mockResolvedValueOnce([candidateItem()]);

			const response = await createInjectAuthenticated(app)(
				"GET",
				"/api/library/insights/disk-waste",
			);

			expect(response.statusCode).toBe(200);
			expect(response.json().data.items).toHaveLength(expectedItems);
			expect(response.json().data.unknownItems).toHaveLength(_name === "missing watch row" ? 1 : 0);
			expect(libraryFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 151 }));
		},
	);

	it.each([
		["positive watch row", [privateWatchRow], 0],
		["verified zero watch row", [zeroWatchRow], 1],
		["missing watch row", [], 0],
	] as const)(
		"evaluates requested-unwatched candidates with current-complete evidence: %s",
		async (_name, rows, expectedItems) => {
			const serviceInstanceFindMany = app.prisma.serviceInstance.findMany as ReturnType<
				typeof vi.fn
			>;
			serviceInstanceFindMany.mockImplementation(
				async ({ where }: { where: { service?: { in?: string[] } } }) =>
					where.service?.in?.includes("JELLYFIN")
						? [{ ...jellyfinInstances[0] }]
						: [{ id: "sonarr-1", label: "Sonarr", service: "SONARR" }],
			);
			mocks.scanUserPolicyEvidence.mockResolvedValueOnce([]);
			mocks.readInsightWatchEvidence.mockResolvedValueOnce(
				watchEvidence({
					statuses: [{ instanceId: "jellyfin-1", status: currentStatus }],
					rows,
					negative: true,
					availability: "current",
				}),
			);
			mocks.seerrGetRequests.mockResolvedValueOnce({
				results: [
					{
						media: { tmdbId: 42 },
						type: "movie",
						requestedBy: { displayName: "Requester" },
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				],
			});
			const libraryFindMany = app.prisma.libraryCache.findMany as ReturnType<typeof vi.fn>;
			libraryFindMany.mockResolvedValueOnce([candidateItem()]);

			const response = await createInjectAuthenticated(app)(
				"GET",
				"/api/library/insights/requested-unwatched",
			);

			expect(response.statusCode).toBe(200);
			expect(response.json().data.items).toHaveLength(expectedItems);
			expect(response.json().data.unknownItems).toHaveLength(_name === "missing watch row" ? 1 : 0);
			expect(libraryFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 126 }));
			expect(mocks.seerrGetRequests).toHaveBeenCalledWith({
				take: 50,
				skip: 0,
				filter: "available",
			});
		},
	);

	it.each([
		[
			"complete last-known",
			[{ instanceId: "jellyfin-1", status: statusWith("last-known", "complete") }],
		],
		[
			"aggregate-partial usable subset",
			[
				{ instanceId: "jellyfin-1", status: statusWith("current", "complete") },
				{ instanceId: "emby-1", status: statusWith("unavailable", "unknown") },
			],
		],
	] as const)("retains positive watched-monitored evidence from %s", async (_name, statuses) => {
		const serviceInstanceFindMany = app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>;
		serviceInstanceFindMany.mockImplementation(
			async ({ where }: { where: { service?: { in?: string[] } } }) =>
				where.service?.in?.includes("JELLYFIN")
					? [...jellyfinInstances]
					: [{ id: "sonarr-1", label: "Sonarr", service: "SONARR" }],
		);
		mocks.scanUserPolicyEvidence.mockResolvedValueOnce([]);
		mocks.readInsightWatchEvidence.mockResolvedValueOnce(
			watchEvidence({
				statuses,
				rows: [privateWatchRow],
				positive: true,
				availability: "partial",
			}),
		);
		const libraryFindMany = app.prisma.libraryCache.findMany as ReturnType<typeof vi.fn>;
		libraryFindMany.mockResolvedValueOnce([candidateItem()]);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/library/insights/watched-monitored",
		);
		const body = response.json();

		expect(response.statusCode).toBe(200);
		expect(body.data.items).toMatchObject([{ watchCount: 2, lastWatchedAt: expect.any(String) }]);
		expect(body.data.hasWatchData).toBe(true);
		expect(body.providerStatus).toBeDefined();
		for (const privateMarker of [
			"private-row-id",
			"private-provider-item",
			"Private helper title",
			"private-user",
			"Private library",
			"https://private.invalid/item",
		]) {
			expect(JSON.stringify(body)).not.toContain(privateMarker);
		}
		expect(libraryFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 250 }));
	});

	it("withholds watched-monitored items when every configured source is unavailable", async () => {
		const serviceInstanceFindMany = app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>;
		serviceInstanceFindMany.mockImplementation(
			async ({ where }: { where: { service?: { in?: string[] } } }) =>
				where.service?.in?.includes("JELLYFIN")
					? [{ ...jellyfinInstances[0] }]
					: [{ id: "sonarr-1", label: "Sonarr", service: "SONARR" }],
		);
		mocks.scanUserPolicyEvidence.mockResolvedValueOnce([]);
		mocks.readInsightWatchEvidence.mockResolvedValueOnce(
			watchEvidence({
				statuses: [{ instanceId: "jellyfin-1", status: statusWith("unavailable", "unknown") }],
				rows: [zeroWatchRow],
				positive: false,
				availability: "unavailable",
			}),
		);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/library/insights/watched-monitored",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: true,
			data: { items: [], hasPlexData: false, hasWatchData: false },
			providerStatus: { availability: "unavailable" },
		});
		expect(app.prisma.libraryCache.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ instance: { userId: "user-1" } }),
				take: 250,
			}),
		);
	});

	it("preserves requested empty and fail-soft status after current-complete observation", async () => {
		const serviceInstanceFindMany = app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>;
		serviceInstanceFindMany.mockImplementation(
			async ({ where }: { where: { service?: { in?: string[] } } }) =>
				where.service?.in?.includes("JELLYFIN")
					? [{ ...jellyfinInstances[0] }]
					: [{ id: "sonarr-1", label: "Sonarr", service: "SONARR" }],
		);
		mocks.scanUserPolicyEvidence.mockResolvedValue([]);
		mocks.readInsightWatchEvidence.mockResolvedValue(
			watchEvidence({
				statuses: [{ instanceId: "jellyfin-1", status: currentStatus }],
				rows: [],
				positive: true,
				negative: true,
				availability: "current",
			}),
		);
		mocks.seerrGetRequests.mockResolvedValueOnce({ results: [] });

		const emptyResponse = await createInjectAuthenticated(app)(
			"GET",
			"/api/library/insights/requested-unwatched",
		);
		expect(emptyResponse.json()).toMatchObject({
			data: { items: [], hasSeerrData: true, hasPlexData: false, hasWatchData: true },
			providerStatus: { availability: "current" },
		});

		mocks.seerrGetRequests.mockRejectedValueOnce(new Error("synthetic Seerr outage"));
		const failSoftResponse = await createInjectAuthenticated(app)(
			"GET",
			"/api/library/insights/requested-unwatched",
		);
		expect(failSoftResponse.json()).toMatchObject({
			data: { items: [], hasSeerrData: false, hasPlexData: false, hasWatchData: true },
			providerStatus: { availability: "current" },
		});
	});

	it("preserves requested status after current-complete observation with no ARR library", async () => {
		const serviceInstanceFindMany = app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>;
		serviceInstanceFindMany.mockImplementation(
			async ({ where }: { where: { service?: { in?: string[] } } }) =>
				where.service?.in?.includes("JELLYFIN") ? [{ ...jellyfinInstances[0] }] : [],
		);
		mocks.scanUserPolicyEvidence.mockResolvedValue([]);
		mocks.readInsightWatchEvidence.mockResolvedValue(
			watchEvidence({
				statuses: [{ instanceId: "jellyfin-1", status: currentStatus }],
				rows: [],
				positive: true,
				negative: true,
				availability: "current",
			}),
		);
		mocks.seerrGetRequests.mockResolvedValueOnce({
			results: [
				{
					media: { tmdbId: 42 },
					type: "movie",
					requestedBy: { displayName: "Requester" },
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/library/insights/requested-unwatched",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: true,
			data: { items: [], hasSeerrData: true, hasPlexData: false, hasWatchData: true },
			providerStatus: { availability: "current" },
		});
		expect(app.prisma.libraryCache.findMany).not.toHaveBeenCalled();
	});

	it("preserves the Seerr page size and twenty-page bound after watch authority", async () => {
		const serviceInstanceFindMany = app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>;
		serviceInstanceFindMany.mockImplementation(
			async ({ where }: { where: { service?: { in?: string[] } } }) =>
				where.service?.in?.includes("JELLYFIN")
					? [{ ...jellyfinInstances[0] }]
					: [{ id: "sonarr-1", label: "Sonarr", service: "SONARR" }],
		);
		mocks.scanUserPolicyEvidence.mockResolvedValue([]);
		mocks.readInsightWatchEvidence.mockResolvedValue(
			watchEvidence({
				statuses: [{ instanceId: "jellyfin-1", status: currentStatus }],
				rows: [],
				positive: true,
				negative: true,
				availability: "current",
			}),
		);
		mocks.seerrGetRequests.mockResolvedValue({
			results: Array.from({ length: 50 }, () => ({
				media: { tmdbId: 42 },
				type: "movie",
				requestedBy: { displayName: "Requester" },
				createdAt: "2026-01-01T00:00:00.000Z",
			})),
		});

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/library/insights/requested-unwatched",
		);

		expect(response.statusCode).toBe(200);
		expect(mocks.seerrGetRequests).toHaveBeenCalledTimes(20);
		expect(response.json().data).toMatchObject({ requestStatus: "partial", limited: true });
		expect(mocks.seerrGetRequests).toHaveBeenNthCalledWith(1, {
			take: 50,
			skip: 0,
			filter: "available",
		});
		expect(mocks.seerrGetRequests).toHaveBeenLastCalledWith({
			take: 50,
			skip: 950,
			filter: "available",
		});
	});
});
