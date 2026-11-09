import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import jellyfinEpisodeCacheSchedulerPlugin from "../../plugins/jellyfin-episode-cache-scheduler.js";
import { RestoreRuntimeAdmissionError } from "../backup/restore-runtime-admission.js";
import { Prisma, type PrismaClient, type ServiceInstance } from "../prisma.js";
import {
	buildObservationActiveSlotKey,
	buildObservationAuthorityKey,
	type ObservationRunAuthority,
} from "../provider-observation/observation-run-types.js";
import { KNOWN_JOBS } from "../scheduler-registry/job-definitions.js";
import { SchedulerRegistry } from "../scheduler-registry/scheduler-registry.js";
import type { FastifyWithEpisodeRefreshScheduler } from "../services/episode-refresh-scheduler-bridge.js";
import { ProviderIdentityGuardError } from "../services/provider-identity-guard.js";
import { UpstreamValidationError } from "../validation/parse-upstream.js";
import type { JellyfinClient } from "./jellyfin-client.js";
import {
	classifyJellyfinEpisodeScopeFailure,
	createJellyfinEpisodeWorkItemRunner,
	logJellyfinEpisodePrePageFailure,
	refreshOwnedJellyfinEpisodeCache,
} from "./jellyfin-episode-cache-refresher.js";
import * as generationMetadata from "./jellyfin-generation-metadata.js";
import {
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
} from "./jellyfin-generation-metadata.js";

const publication = vi.hoisted(() => ({
	client: undefined as JellyfinClient | undefined,
	snapshotError: false,
}));

const durable = vi.hoisted(() => ({
	outer: undefined as unknown,
	run: undefined as
		| undefined
		| {
				state: string;
				completedUnits: number;
				completedWork: number;
				[id: string]: unknown;
		  },
	units: [] as Array<Record<string, unknown> & { expectedTargets?: number }>,
	stage: vi.fn(),
	finalize: vi.fn(),
	readCompleted: vi.fn(),
	invalidate: vi.fn(),
	invalidateAttempt: vi.fn(),
	claimUnit: vi.fn(),
	failUnit: vi.fn(),
	releaseUnit: vi.fn(),
	exhausted: vi.fn(),
	renew: vi.fn(),
	deadline: vi.fn(),
	guard: vi.fn(),
	collectionGuard: vi.fn(),
	finishFailure: vi.fn(),
	recordedFailureCount: 0,
	activePreparationCount: 0,
}));

const finalizerWorker = vi.hoisted(() => ({ run: vi.fn() }));
const pageWorker = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("./jellyfin-episode-page-worker-transport.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./jellyfin-episode-page-worker-transport.js")>()),
	runJellyfinEpisodePageWorker: pageWorker.run,
}));

vi.mock("./jellyfin-episode-finalizer-worker-transport.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./jellyfin-episode-finalizer-worker-transport.js")>()),
	runJellyfinEpisodeFinalizerWorker: finalizerWorker.run,
}));

vi.mock("../services/provider-identity-guard.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../services/provider-identity-guard.js")>();
	return {
		...actual,
		withGuardedProviderPublication: durable.guard,
		withGuardedProviderCollection: durable.collectionGuard,
	};
});

vi.mock("../services/provider-cache-status.js", () => ({
	claimProviderCacheRefreshAttempt: vi.fn(async () => durable.outer),
	finishProviderCacheRefreshAttemptFailure: durable.finishFailure,
}));

vi.mock("./jellyfin-episode-attempt-recovery.js", () => ({
	invalidateJellyfinEpisodeAttempt: durable.invalidateAttempt,
}));

vi.mock("../provider-observation/observation-run-repository.js", () => ({
	createOrLoadObservationRun: vi.fn(
		async (_prisma: unknown, input: { authority: ObservationRunAuthority; units: unknown[] }) => {
			if (durable.run) return durable.run;
			durable.units = input.units.map((unit, ordinal) => ({
				...(unit as Record<string, unknown>),
				id: `unit-${ordinal}`,
				state: "pending",
				cursor: 0,
				expectedRawCount: null,
				observedRawCount: 0,
				claimToken: null,
			}));
			durable.run = {
				id: "run-1",
				...input.authority,
				authorityKey: buildObservationAuthorityKey(input.authority),
				activeSlotKey: buildObservationActiveSlotKey(input.authority),
				targetCount: durable.units.filter((unit) => unit.expectedTargets === 1).length,
				state: "running",
				completedUnits: 0,
				totalUnits: durable.units.length,
				completedWork: 0,
				totalWork: durable.units.filter((unit) => unit.expectedTargets === 1).length,
			};
			return durable.run;
		},
	),
	claimObservationUnit: durable.claimUnit,
	failObservationUnit: durable.failUnit,
	releaseJoinedObservationUnitClaim: durable.releaseUnit,
	getAutomaticObservationRenewalDeadline: durable.deadline,
	hasExhaustedObservationRunRetries: durable.exhausted,
	renewExhaustedObservationRun: durable.renew,
}));

vi.mock("./jellyfin-episode-refresh-repository.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./jellyfin-episode-refresh-repository.js")>();
	return {
		...actual,
		stageJellyfinEpisodePage: durable.stage,
		finalizeJellyfinEpisodeRun: durable.finalize,
		readCompletedJellyfinEpisodePublication: durable.readCompleted,
		invalidateJellyfinEpisodeRun: durable.invalidate,
	};
});

vi.mock("./jellyfin-cache-refresher.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./jellyfin-cache-refresher.js")>();
	return {
		...actual,
		createOwnedJellyfinPublicationSnapshot: vi.fn((_encryptor, instance: ServiceInstance) => {
			if (publication.snapshotError) throw new Error("credential unavailable");
			return {
				id: instance.id,
				userId: instance.userId,
				service: instance.service,
				expectedIdentity: instance.expectedIdentity,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
				baseUrl: "https://provider.invalid",
				apiKey: "plain-api-key",
				httpAuthHeaders: {},
			};
		}),
	};
});

vi.mock("./jellyfin-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./jellyfin-client.js")>();
	return {
		...actual,
		JellyfinClient: class {
			constructor() {
				if (!publication.client) throw new Error("Episode test client was not configured");
				Object.assign(this, publication.client);
			}
		},
	};
});

const log = {
	warn: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
} as unknown as FastifyBaseLogger;

function ownedFixture(
	service: "JELLYFIN" | "EMBY",
	options: { parentMediaType?: "movie" | "series"; v3?: boolean } = {},
) {
	const parentRow = {
		id: "library-row-1",
		instanceId: "jellyfin-1",
		tmdbId: 42,
		mediaType: options.parentMediaType ?? "series",
		libraryId: "library-1",
		libraryName: "Library",
		title: "Show",
		jellyfinId: "series-1",
		lastWatchedAt: new Date("2026-01-02T00:00:00.000Z"),
		watchCount: 1,
		watchedByUsers: JSON.stringify(["Alice"]),
		onDeck: false,
		userRating: null,
		collections: JSON.stringify([]),
		addedAt: new Date("2025-01-01T00:00:00.000Z"),
		thumb: null,
		connectionGeneration: 7,
		identityGeneration: 2,
	};
	const receiptUnit = {
		scopeKey: "library:library-1",
		expectedRawCount: 1,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: 1,
		sourceBindings: 1,
		canonicalEntities: 1,
		acceptedSkips: [],
		fatalCount: 0,
	};
	const parentReceipt = options.v3
		? {
				version: 2 as const,
				provider: service === "EMBY" ? ("emby" as const) : ("jellyfin" as const),
				attemptStartedAt: "2026-01-01T00:00:00.000Z",
				observedAt: "2026-01-02T00:00:00.000Z",
				evidence: "complete" as const,
				units: [receiptUnit],
				publishedCanonicalEntities: 1,
				domains: [
					"library-inventory",
					"mapping",
					"watch-count",
					"watch-attribution",
					"on-deck",
				].map((domain) => ({
					domain: domain as
						| "library-inventory"
						| "mapping"
						| "watch-count"
						| "watch-attribution"
						| "on-deck",
					evidence: "complete" as const,
					valueSemantics: "exact" as const,
					units: [
						{
							...receiptUnit,
							scopeKey:
								domain === "library-inventory"
									? "user:user-1/library:library-1/inventory"
									: `${domain}:library-1`,
						},
					],
					publishedCanonicalEntities: 1,
				})),
			}
		: {
				version: 1 as const,
				provider: service === "EMBY" ? ("emby" as const) : ("jellyfin" as const),
				attemptStartedAt: "2026-01-01T00:00:00.000Z",
				observedAt: "2026-01-02T00:00:00.000Z",
				evidence: "complete" as const,
				units: [receiptUnit],
				publishedCanonicalEntities: 1,
			};
	const parentPublishedAt = new Date(Date.now() - 1_000);
	const parentStatus = {
		lastResult: "success",
		itemCount: 1,
		generationId: "library-generation-1",
		generationMetadata: encodeJellyfinLibraryGenerationMetadata({
			version: 1,
			provider: parentReceipt.provider,
			cacheType: "jellyfin",
			publicationLevel: "authoritative",
			completeness: "complete",
			canonicalizationVersion: 1,
			itemCount: 1,
			connectionGeneration: 7,
			identityGeneration: 2,
			contentFingerprint: fingerprintJellyfinLibraryRows([parentRow]),
			coverageReceipt: parentReceipt,
		}),
		lastRefreshedAt: parentPublishedAt,
		lastAttemptAt: parentPublishedAt,
		lastAttemptResult: "success",
		connectionGeneration: 7,
		identityGeneration: 2,
	};
	const instance: ServiceInstance = {
		id: "jellyfin-1",
		userId: "user-owner",
		service,
		label: "Provider",
		baseUrl: "https://provider.invalid",
		externalUrl: null,
		encryptedApiKey: "api-cipher",
		encryptionIv: "api-iv",
		encryptedHttpAuthCredentials: "http-cipher",
		httpAuthEncryptionIv: "http-iv",
		isDefault: false,
		enabled: true,
		storageGroupId: null,
		hasLocalFilesystemAccess: false,
		pathPrefix: null,
		expectedIdentity: "jellyfin-a",
		identityKind: "JELLYFIN_SERVER_ID",
		identityStatus: "VERIFIED",
		connectionGeneration: 7,
		identityGeneration: 2,
		identityVerifiedAt: null,
		identityLastCheckedAt: null,
		createdAt: new Date("2025-01-01T00:00:00.000Z"),
		updatedAt: new Date("2025-01-01T00:00:00.000Z"),
	};
	const prisma = {
		serviceInstance: { findFirst: vi.fn().mockResolvedValue(instance) },
		cacheRefreshStatus: { findUnique: vi.fn().mockResolvedValue(parentStatus) },
		jellyfinCache: { findMany: vi.fn().mockResolvedValue([parentRow]) },
	} as unknown as PrismaClient;
	return { prisma, instance, parentStatus, parentRow };
}

describe("refreshOwnedJellyfinEpisodeCache durable page runner", () => {
	it.each([
		["JELLYFIN", false],
		["JELLYFIN", true],
		["EMBY", false],
		["EMBY", true],
	] as const)(
		"validates parent content once for a successful %s page (v3: %s)",
		async (service, v3) => {
			const state = ownedFixture(service, { v3 });
			configureDurableRun(state);
			const fingerprint = vi.spyOn(generationMetadata, "fingerprintJellyfinLibraryRows");
			try {
				const result = await refreshOwnedJellyfinEpisodeCache({
					prisma: state.prisma,
					encryptor: { decrypt: vi.fn() },
					instance: state.instance,
					log,
				});
				expect(result).toMatchObject({ errors: 0, progressed: true, complete: false });
				expect(durable.run).toMatchObject({ state: "running", completedUnits: 1 });
				expect(fingerprint).toHaveBeenCalledTimes(1);
			} finally {
				fingerprint.mockRestore();
			}
		},
	);

	it.each(["content", "users", "collections", "rating", "generation"] as const)(
		"refuses invalid parent %s before collecting or staging a page",
		async (invalid) => {
			const state = ownedFixture("JELLYFIN", { v3: true });
			const client = configureDurableRun(state);
			if (invalid === "content") state.parentRow.title = "Corrupted parent";
			if (invalid === "users") state.parentRow.watchedByUsers = "{}";
			if (invalid === "collections") state.parentRow.collections = "{}";
			if (invalid === "rating")
				Object.assign(state.parentRow, { userRating: Number.POSITIVE_INFINITY });
			if (invalid === "generation") state.parentRow.connectionGeneration += 1;
			if (invalid === "users" || invalid === "collections") {
				state.parentStatus.generationMetadata = encodeJellyfinLibraryGenerationMetadata({
					...(JSON.parse(state.parentStatus.generationMetadata) as Record<string, unknown>),
					contentFingerprint: fingerprintJellyfinLibraryRows([state.parentRow]),
				} as Parameters<typeof encodeJellyfinLibraryGenerationMetadata>[0]);
			}
			const result = await refreshOwnedJellyfinEpisodeCache({
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log,
			});
			expect(result.progressed).toBe(false);
			expect(client.getEpisodeItemsPageWithCoverage).not.toHaveBeenCalled();
			expect(durable.stage).not.toHaveBeenCalled();
		},
	);

	it("logs ordered bounded work stages without private values for a successful page", async () => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state);
		const lines: string[] = [];
		const logger = pino(
			{ level: "info", base: null, timestamp: false },
			{ write: (line: string) => lines.push(line) },
		);
		const result = await refreshOwnedJellyfinEpisodeCache({
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log: logger,
		});
		expect(result).toMatchObject({ errors: 0, progressed: true, complete: false });
		expect(durable.run).toMatchObject({ state: "running", completedUnits: 1 });
		const stages = lines
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((line) => line.category === "jellyfin-episode-work-stage");
		expect(stages.map((line) => [line.stage, line.state])).toEqual([
			["unit-claim", "entered"],
			["unit-claim", "succeeded"],
			["guarded-read", "entered"],
			["provider-read", "entered"],
			["provider-read", "succeeded"],
			["collection-fence", "entered"],
			["collection-fence", "succeeded"],
			["guarded-read", "succeeded"],
			["page-stage", "entered"],
			["page-stage", "succeeded"],
			["run-progress", "entered"],
			["run-progress", "succeeded"],
		]);
		for (const stage of stages) {
			expect(Object.keys(stage).sort()).toEqual(
				["category", "elapsedMs", "level", "msg", "stage", "state"].sort(),
			);
			expect(stage.elapsedMs).toEqual(expect.any(Number));
			expect(Number.isFinite(stage.elapsedMs)).toBe(true);
			expect(stage.elapsedMs).toBeGreaterThanOrEqual(0);
		}
		for (const value of [
			"user-1",
			"library-1",
			"series-1",
			"plain-api-key",
			"jellyfin-1",
			"claim-unit-0",
		])
			expect(JSON.stringify(stages)).not.toContain(value);
	});

	it.each([
		["runtime", "runtime-admission", null, null],
		["P1008", "prisma-known", "P1008", "SQLITE_BUSY_SNAPSHOT"],
		["P2028", "prisma-known", "P2028", null],
		["unknown", "other", null, null],
		["throwing-metadata", "other", null, null],
	])(
		"logs a bounded failed unit claim for %s and preserves the original rejection",
		async (kind, errorCategory, databaseCode, sqliteCode) => {
			const state = ownedFixture("JELLYFIN");
			configureDurableRun(state);
			const failure =
				kind === "runtime"
					? new RestoreRuntimeAdmissionError()
					: kind === "unknown"
						? new Error("PRIVATE_ERROR_DETAIL")
						: new Prisma.PrismaClientKnownRequestError("PRIVATE_DATABASE_DETAIL", {
								code: kind === "throwing-metadata" ? "P1008" : kind!,
								clientVersion: "test",
								meta: {
									target: "PRIVATE_COLUMN",
									driverAdapterError: {
										cause: { originalCode: kind === "P1008" ? "SQLITE_BUSY_SNAPSHOT" : null },
									},
								},
							});
			if (kind === "throwing-metadata") {
				Object.defineProperty(failure, "meta", {
					get: () => {
						throw new Error("PRIVATE_METADATA_DETAIL");
					},
				});
			}
			durable.claimUnit.mockRejectedValueOnce(failure);
			const lines: string[] = [];
			const logger = pino(
				{ level: "info", base: null, timestamp: false },
				{ write: (line: string) => lines.push(line) },
			);
			await expect(
				refreshOwnedJellyfinEpisodeCache({
					prisma: state.prisma,
					encryptor: { decrypt: vi.fn() },
					instance: state.instance,
					log: logger,
				}),
			).rejects.toBe(failure);
			const stages = lines
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter((line) => line.category === "jellyfin-episode-work-stage");
			expect(stages.map((line) => [line.stage, line.state])).toEqual([
				["unit-claim", "entered"],
				["unit-claim", "failed"],
			]);
			expect(stages[1]).toEqual({
				level: 30,
				msg: "Jellyfin episode work stage",
				category: "jellyfin-episode-work-stage",
				stage: "unit-claim",
				state: "failed",
				elapsedMs: expect.any(Number),
				errorCategory,
				databaseCode,
				sqliteCode,
			});
			expect(JSON.stringify(stages)).not.toContain("PRIVATE");
			expect(durable.claimUnit).toHaveBeenCalledOnce();
			expect(pageWorker.run).not.toHaveBeenCalled();
			expect(durable.failUnit).not.toHaveBeenCalled();
			expect(durable.releaseUnit).not.toHaveBeenCalled();
			expect(durable.units[0]).toMatchObject({ state: "pending", claimToken: null });
		},
	);

	it("preserves a failed claim rejection when diagnostic logging throws", async () => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state);
		const failure = new Error("PRIVATE_CLAIM_DETAIL");
		durable.claimUnit.mockRejectedValueOnce(failure);
		const logger = {
			...log,
			info: () => {
				throw new Error("diagnostic sink unavailable");
			},
		} as unknown as FastifyBaseLogger;
		await expect(
			refreshOwnedJellyfinEpisodeCache({
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log: logger,
			}),
		).rejects.toBe(failure);
		expect(durable.claimUnit).toHaveBeenCalledOnce();
		expect(pageWorker.run).not.toHaveBeenCalled();
		expect(durable.releaseUnit).not.toHaveBeenCalled();
	});

	it.each(["unit-claim", "provider-read", "page-stage"] as const)(
		"logs an entry before a held %s settles without releasing its operation",
		async (heldStage) => {
			const state = ownedFixture("JELLYFIN");
			const client = configureDurableRun(state);
			const boundary =
				heldStage === "unit-claim"
					? durable.claimUnit
					: heldStage === "provider-read"
						? client.getEpisodeItemsPageWithCoverage
						: durable.stage;
			const original = boundary.getMockImplementation()!;
			let release!: () => void;
			let entered!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const reached = new Promise<void>((resolve) => {
				entered = resolve;
			});
			boundary.mockImplementationOnce(async (...args: unknown[]) => {
				entered();
				await held;
				return await original(...args);
			});
			const lines: string[] = [];
			const logger = pino(
				{ level: "info", base: null, timestamp: false },
				{ write: (line: string) => lines.push(line) },
			);
			let settled = false;
			const task = refreshOwnedJellyfinEpisodeCache({
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log: logger,
			}).finally(() => {
				settled = true;
			});
			try {
				await reached;
				expect(settled).toBe(false);
				const markers = lines
					.map((line) => JSON.parse(line) as Record<string, unknown>)
					.filter(
						(line) => line.category === "jellyfin-episode-work-stage" && line.stage === heldStage,
					);
				expect(markers.map((line) => line.state)).toEqual(["entered"]);
				expect(durable.run).toMatchObject({ state: "running", completedUnits: 0 });
			} finally {
				release();
				await task;
			}
			expect(settled).toBe(true);
			expect(durable.run).toMatchObject({ completedUnits: 1 });
			const markers = lines
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter(
					(line) => line.category === "jellyfin-episode-work-stage" && line.stage === heldStage,
				);
			expect(markers.map((line) => line.state)).toEqual(["entered", "succeeded"]);
		},
	);

	it("logs a rejected provider stage without its error body and preserves durable retry", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		client.getEpisodeItemsPageWithCoverage.mockRejectedValueOnce(
			new Error("private provider response account and endpoint"),
		);
		const lines: string[] = [];
		const logger = pino(
			{ level: "info", base: null, timestamp: false },
			{ write: (line: string) => lines.push(line) },
		);
		const result = await refreshOwnedJellyfinEpisodeCache({
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log: logger,
		});
		expect(result).toMatchObject({ errors: 1, complete: false, progressed: false });
		expect(durable.run).toMatchObject({
			state: "failed",
			lastReasonCode: "provider-unavailable",
			completedUnits: 0,
		});
		expect(durable.units[0]).toMatchObject({ state: "failed", claimToken: null, attemptCount: 1 });
		const stages = lines
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((line) => line.category === "jellyfin-episode-work-stage");
		expect(
			stages.filter((line) => line.stage === "provider-read").map((line) => line.state),
		).toEqual(["entered", "failed"]);
		expect(
			stages.filter((line) => line.stage === "guarded-read").map((line) => line.state),
		).toEqual(["entered", "failed"]);
		expect(stages.some((line) => line.stage === "page-stage")).toBe(false);
		expect(JSON.stringify(stages)).not.toContain("private");
	});

	for (const service of ["JELLYFIN", "EMBY"] as const) {
		it.each([false, true])(
			`preserves claimed ${service} provider failure settlement when its warning throws (database failure=%s)`,
			async (databaseFailure) => {
				const state = ownedFixture(service);
				const client = configureDurableRun(state);
				state.parentStatus.lastRefreshedAt = new Date("2026-09-06T23:59:59.000Z");
				state.parentStatus.lastAttemptAt = new Date("2026-09-06T23:59:59.000Z");
				client.getEpisodeItemsPageWithCoverage.mockImplementationOnce(async () => {
					expect(durable.units[0]).toMatchObject({
						state: "running",
						claimToken: "claim-unit-0",
					});
					throw Object.assign(new Error("private provider response"), { name: "TimeoutError" });
				});
				const databaseError = new Error("database settlement unavailable");
				if (databaseFailure) durable.failUnit.mockRejectedValueOnce(databaseError);
				const warnings: unknown[][] = [];
				const context = {
					prisma: state.prisma,
					encryptor: { decrypt: vi.fn() },
					instance: state.instance,
					log: {
						...log,
						warn: (...args: unknown[]) => {
							warnings.push(args);
							throw new Error("diagnostic warning unavailable");
						},
					} as FastifyBaseLogger,
					now: new Date("2026-09-07T00:00:00.000Z"),
				};
				const operation = refreshOwnedJellyfinEpisodeCache(context);
				if (databaseFailure) {
					await expect(operation).rejects.toBe(databaseError);
					expect(durable.units[0]).toMatchObject({
						state: "running",
						claimToken: "claim-unit-0",
					});
					expect(durable.run).toMatchObject({ state: "running", completedUnits: 0 });
				} else {
					await expect(operation).resolves.toMatchObject({
						errors: 1,
						complete: false,
						progressed: false,
					});
					expect(durable.units[0]).toMatchObject({
						state: "failed",
						claimToken: null,
						attemptCount: 1,
						nextAttemptAt: new Date("2026-09-07T00:00:30.000Z"),
					});
					expect(durable.run).toMatchObject({
						state: "failed",
						lastReasonCode: "provider-unavailable",
					});
				}
				expect(warnings).toEqual([
					[{ category: "provider-timeout" }, "Jellyfin episode page unavailable"],
				]);
			},
		);
	}

	it("keeps a staged result when diagnostic logging throws", async () => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state);
		const logger = {
			...log,
			info: () => {
				throw new Error("diagnostic sink unavailable");
			},
		} as unknown as FastifyBaseLogger;
		await expect(
			refreshOwnedJellyfinEpisodeCache({
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log: logger,
			}),
		).resolves.toMatchObject({ errors: 0, complete: false, progressed: true });
		expect(durable.run).toMatchObject({ state: "running", completedUnits: 1 });
	});

	it("logs bounded phase timings for a staged page without provider identifiers", async () => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state);
		const lines: string[] = [];
		const logger = pino(
			{ level: "info", base: null, timestamp: false },
			{ write: (line: string) => lines.push(line) },
		);
		const result = await refreshOwnedJellyfinEpisodeCache({
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log: logger,
		});

		expect(result).toMatchObject({ errors: 0, progressed: true });
		const timings = lines
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((line) => line.category === "jellyfin-episode-page-timing");
		expect(timings).toHaveLength(1);
		const timing = timings[0]!;
		expect(Object.keys(timing).sort()).toEqual(
			[
				"category",
				"guardMs",
				"itemCount",
				"level",
				"msg",
				"outcome",
				"phase",
				"postStageMs",
				"prePageMs",
				"providerReadMs",
				"stageMs",
				"totalMs",
			].sort(),
		);
		expect(timing).toMatchObject({
			phase: "collect",
			outcome: "progressed",
			itemCount: 1,
		});
		for (const key of [
			"prePageMs",
			"guardMs",
			"providerReadMs",
			"stageMs",
			"postStageMs",
			"totalMs",
		]) {
			expect(timing[key]).toEqual(expect.any(Number));
			expect(Number.isFinite(timing[key])).toBe(true);
			expect(timing[key]).toBeGreaterThanOrEqual(0);
		}
		for (const privateValue of ["user-1", "library-1", "series-1", "plain-api-key"])
			expect(JSON.stringify(timing)).not.toContain(privateValue);
	});

	it("preserves staged-page progress when the timing log sink throws", async () => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state);
		const throwingLog = {
			warn: vi.fn(),
			info: () => {
				throw new Error("timing sink unavailable");
			},
		} as unknown as FastifyBaseLogger;

		await expect(
			refreshOwnedJellyfinEpisodeCache({
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log: throwingLog,
			}),
		).resolves.toMatchObject({ errors: 0, progressed: true });
	});

	it("preserves handled provider failure when the timing log sink throws", async () => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state);
		durable.collectionGuard.mockRejectedValueOnce(new Error("provider unavailable"));
		const throwingLog = {
			warn: vi.fn(),
			info: () => {
				throw new Error("timing sink unavailable");
			},
		} as unknown as FastifyBaseLogger;

		await expect(
			refreshOwnedJellyfinEpisodeCache({
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log: throwingLog,
			}),
		).resolves.toMatchObject({ errors: 1, progressed: false });
	});

	it("serializes only closed pre-page failure categories", () => {
		const canaries = [
			"https://private.invalid/Secret-Show?token=secret",
			"Private Instance Label",
			"private-user-id",
		];
		const lines: string[] = [];
		const logger = pino(
			{ level: "trace", base: null, timestamp: false },
			{ write: (line: string) => lines.push(line) },
		);
		const categories = [
			"parent-admission-failed",
			"current-authority-failed",
			"client-preparation-failed",
			"scope-discovery-failed",
			"scope-plan-failed",
			"run-admission-failed",
		] as const;
		for (const category of categories) logJellyfinEpisodePrePageFailure(logger, category);
		const serialized = lines.join("");
		for (const category of categories) expect(serialized).toContain(category);
		for (const canary of canaries) expect(serialized).not.toContain(canary);
	});

	function configureDurableRun(state: ReturnType<typeof ownedFixture>, totalRecordCount = 1) {
		(state.parentRow as unknown as { lastWatchedAt: Date | null }).lastWatchedAt = null;
		state.parentStatus.generationMetadata = encodeJellyfinLibraryGenerationMetadata({
			...(JSON.parse(state.parentStatus.generationMetadata) as Record<string, unknown>),
			contentFingerprint: fingerprintJellyfinLibraryRows([state.parentRow]),
		} as Parameters<typeof encodeJellyfinLibraryGenerationMetadata>[0]);
		(state.prisma.serviceInstance.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
			state.instance,
		);
		(state.prisma as unknown as { providerObservationRun: unknown }).providerObservationRun = {
			findUnique: vi.fn(async () => durable.run),
			count: vi.fn(async (query: { where: Record<string, unknown> }) => {
				if (!durable.run) return 0;
				return Object.entries(query.where).every(([key, expected]) => {
					const actual = durable.run?.[key];
					if (key === "nextAttemptAt") {
						const deadline = (expected as { gt: Date }).gt;
						return actual instanceof Date && actual > deadline;
					}
					if (key === "activeSlotKey") return actual !== null && actual !== undefined;
					return actual === expected;
				})
					? 1
					: 0;
			}),
			findFirst: vi.fn(async (query: { where?: Record<string, unknown>; include?: unknown }) => {
				const matches = (where: Record<string, unknown>): boolean =>
					Object.entries(where).every(([key, expected]) => {
						if (key === "OR") return (expected as Record<string, unknown>[]).some(matches);
						const actual = durable.run?.[key];
						if (expected && typeof expected === "object") {
							const filter = expected as Record<string, unknown>;
							if (Array.isArray(filter.in)) return filter.in.includes(actual);
							if (typeof filter.startsWith === "string")
								return typeof actual === "string" && actual.startsWith(filter.startsWith);
							if ("not" in filter) return actual !== filter.not;
						}
						return actual === expected;
					});
				if (!durable.run || !matches(query.where ?? {})) return null;
				return { ...durable.run, ...(query.include ? { units: durable.units } : {}) };
			}),
		};
		durable.outer = {
			status: "acquired",
			attempt: {
				attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
				resultMarker: "in_progress:test",
			},
		};
		durable.units = [];
		durable.run = undefined;
		durable.stage.mockImplementation(async (_prisma, claim, _scope, page) => {
			const unit = durable.units.find((candidate) => candidate.id === claim.unitId);
			if (!unit || !durable.run) return false;
			const cursor = page.startIndex + page.items.length;
			unit.cursor = cursor;
			unit.expectedRawCount = page.totalRecordCount;
			unit.observedRawCount = cursor;
			if (cursor === page.totalRecordCount) {
				unit.state = "complete";
				durable.run.completedUnits += 1;
				durable.run.completedWork += unit.expectedTargets ?? 0;
			} else unit.state = "pending";
			return true;
		});
		durable.finalize.mockImplementation(async () => {
			if (durable.run) durable.run.state = "complete";
			return { published: true, itemCount: totalRecordCount === 0 ? 0 : 1 };
		});
		durable.readCompleted.mockReset();
		durable.readCompleted.mockResolvedValue(null);
		durable.invalidate.mockImplementation(async () => {
			if (durable.run) durable.run.state = "invalidated";
			return true;
		});
		durable.invalidateAttempt.mockReset();
		durable.invalidateAttempt.mockResolvedValue("recorded");
		durable.finishFailure.mockReset();
		durable.recordedFailureCount = 0;
		durable.activePreparationCount = 0;
		durable.exhausted.mockReset();
		durable.exhausted.mockResolvedValue(false);
		durable.deadline.mockReset();
		durable.deadline.mockResolvedValue(null);
		durable.renew.mockReset();
		durable.renew.mockResolvedValue("deferred");
		durable.finishFailure.mockImplementation(async (...args: unknown[]) => {
			const precondition = args[7];
			if (
				typeof precondition === "function" &&
				!(await precondition({
					transaction: true,
					providerObservationRun: (state.prisma as unknown as { providerObservationRun: unknown })
						.providerObservationRun,
					jellyfinEpisodePreparation: {
						count: async () => durable.activePreparationCount,
					},
				}))
			) {
				return "superseded";
			}
			durable.recordedFailureCount += 1;
			return "recorded";
		});
		durable.claimUnit.mockReset();
		durable.claimUnit.mockImplementation(async () => {
			const unit = durable.units.find((candidate) => candidate.state === "pending");
			if (!unit || !durable.run) return null;
			durable.run.state = "running";
			unit.state = "running";
			unit.claimToken = `claim-${unit.id}`;
			return {
				runId: "run-1",
				unitId: unit.id,
				claimToken: unit.claimToken,
				authorityKey: "authority",
				phase: unit.phase,
				scopeKey: unit.scopeKey,
				scopePayload: unit.scopePayload,
				cursor: unit.cursor,
				expectedRawCount: unit.expectedRawCount,
				observedRawCount: unit.observedRawCount,
			};
		});
		durable.failUnit.mockReset();
		durable.releaseUnit.mockReset();
		durable.releaseUnit.mockImplementation(async (_prisma, input) => {
			const unit = durable.units.find(
				(candidate) =>
					candidate.id === input.claim.unitId &&
					candidate.state === "running" &&
					candidate.claimToken === input.claim.claimToken,
			);
			if (!unit) return false;
			unit.state = "pending";
			unit.claimToken = null;
			return true;
		});
		durable.failUnit.mockImplementation(async (_prisma, input) => {
			const unit = durable.units.find((candidate) => candidate.id === input.claim.unitId);
			if (!unit || !durable.run) return false;
			const attemptCount = Number(unit.attemptCount ?? 0) + 1;
			const delay = [30_000, 120_000, 600_000][attemptCount - 1] ?? null;
			const nextAttemptAt = delay === null ? null : new Date(input.now.getTime() + delay);
			unit.state = "failed";
			unit.claimToken = null;
			unit.attemptCount = attemptCount;
			unit.nextAttemptAt = nextAttemptAt;
			durable.run.state = "failed";
			durable.run.nextAttemptAt = nextAttemptAt;
			durable.run.lastReasonCode = input.reasonCode;
			return true;
		});
		durable.guard.mockReset();
		durable.guard.mockImplementation(
			async (_prisma, _snapshot, _log, collect, publish) =>
				await publish({ transaction: true }, await collect()),
		);
		durable.collectionGuard.mockReset();
		// The unit fixture has no real guarded database. Model the collection-only
		// contract explicitly; write-style scope/finalizer guards stay separate.
		durable.collectionGuard.mockImplementation(
			async (_prisma, _snapshot, _log, collect) => await collect(),
		);
		durable.stage.mockClear();
		durable.finalize.mockClear();
		durable.invalidate.mockClear();
		publication.snapshotError = false;
		const client = {
			getUsers: vi.fn().mockResolvedValue([{ id: "user-1", name: "Alice" }]),
			getLibraries: vi.fn().mockResolvedValue([{ id: "library-1" }]),
			getEpisodeItemsPageWithCoverage: vi.fn(
				async (_userId, _libraryId, cursor, _limit?: number) => ({
					items: Array.from({ length: Math.min(1_000, totalRecordCount - cursor) }, (_, index) => ({
						type: "Episode",
						id: `episode-${cursor + index}`,
						seriesId: "series-1",
						name: `Episode ${cursor + index}`,
						seasonNumber: 1,
						episodeNumber: cursor + index,
						played: true,
						playCount: 1,
						lastPlayedDate: "2026-09-01T00:00:00Z",
					})),
					startIndex: cursor,
					totalRecordCount,
				}),
			),
		};
		publication.client = client as unknown as JellyfinClient;
		pageWorker.run.mockReset();
		pageWorker.run.mockImplementation(
			async (input) =>
				await publication.client!.getEpisodeItemsPageWithCoverage(
					input.userId,
					input.libraryId,
					input.startIndex,
					input.limit,
				),
		);
		return client;
	}

	it.each([
		["JELLYFIN", 2_000],
		["EMBY", 1_000],
	] as const)(
		"routes the default %s page through the worker with the owned connection and saved coordinates",
		async (service, limit) => {
			const state = ownedFixture(service);
			const client = configureDurableRun(state, 2_001);
			pageWorker.run.mockResolvedValue({
				startIndex: 0,
				totalRecordCount: 2_001,
				items: [{ id: "native-1", type: "Episode", excludedReason: "missing-episode-metadata" }],
			});
			client.getEpisodeItemsPageWithCoverage.mockRejectedValue(
				new Error("Parent direct page read forbidden"),
			);
			const context = {
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log,
			};
			expect(await refreshOwnedJellyfinEpisodeCache(context)).toMatchObject({
				progressed: true,
				complete: false,
			});
			expect(client.getEpisodeItemsPageWithCoverage).not.toHaveBeenCalled();
			expect(pageWorker.run).toHaveBeenLastCalledWith(
				{
					baseUrl: "https://provider.invalid",
					apiKey: "plain-api-key",
					httpAuthHeaders: {},
					userId: "user-1",
					libraryId: "library-1",
					startIndex: 0,
					limit,
				},
				{ signal: undefined },
			);
			pageWorker.run.mockResolvedValue({ startIndex: 1, totalRecordCount: 2_001, items: [] });
			await refreshOwnedJellyfinEpisodeCache(context);
			expect(pageWorker.run).toHaveBeenLastCalledWith(
				{
					baseUrl: "https://provider.invalid",
					apiKey: "plain-api-key",
					httpAuthHeaders: {},
					userId: "user-1",
					libraryId: "library-1",
					startIndex: 1,
					limit,
				},
				{ signal: undefined },
			);
		},
	);

	it("stages the episode page through collection admission without a no-op write publication", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		durable.guard.mockRejectedValue(new RestoreRuntimeAdmissionError());

		const result = await refreshOwnedJellyfinEpisodeCache({
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		});

		expect(result).toMatchObject({ errors: 0, progressed: true, complete: false });
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledOnce();
		expect(durable.stage).toHaveBeenCalledOnce();
		expect(durable.finalize).not.toHaveBeenCalled();
		expect(durable.collectionGuard).toHaveBeenCalledTimes(2);
		expect(durable.guard).not.toHaveBeenCalled();
	});

	it("fetches and stages exactly one page per invocation, then finalizes only after collect and verify", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		const first = await refreshOwnedJellyfinEpisodeCache(context);
		expect(first).toMatchObject({ complete: false, errors: 0, progressed: true });
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(1);
		expect(client.getEpisodeItemsPageWithCoverage.mock.calls[0]?.[3]).toBe(2_000);
		expect(durable.finalize).not.toHaveBeenCalled();

		const second = await refreshOwnedJellyfinEpisodeCache(context);
		expect(second).toMatchObject({ complete: false, errors: 0, progressed: true });
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(2);
		expect(durable.finalize).not.toHaveBeenCalled();

		const finished = await refreshOwnedJellyfinEpisodeCache(context);
		expect(finished).toMatchObject({ complete: true, errors: 0, upserted: 1, progressed: false });
		expect(durable.finalize).toHaveBeenCalledOnce();
		expect((client as { getEpisodes?: unknown }).getEpisodes).toBeUndefined();
	});

	it.each(["valid", "malformed", "accessor"])(
		"offloads the guarded SQLite finalizer and logs only sanitized %s native timing",
		async (mode) => {
			(log.info as ReturnType<typeof vi.fn>).mockClear();
			const zero = {
				requested: 0,
				callbackEntered: 0,
				succeeded: 0,
				failed: 0,
				refusedStart: 0,
				callbackFailed: 0,
				admissionTotalMs: 0,
				admissionMaxMs: 0,
				callbackToSuccessTotalMs: 0,
				callbackToSuccessMaxMs: 0,
				refusedStartTotalMs: 0,
				refusedStartMaxMs: 0,
				callbackToFailureTotalMs: 0,
				callbackToFailureMaxMs: 0,
			};
			const metric = {
				version: 1,
				transactions: {
					"row-chunk": {
						...zero,
						requested: 1,
						callbackEntered: 1,
						succeeded: 1,
						admissionTotalMs: 10,
						admissionMaxMs: 10,
						callbackToSuccessTotalMs: 40,
						callbackToSuccessMaxMs: 40,
					},
					"receipt-chunk": { ...zero },
					"lease-checkpoint": { ...zero },
				},
			};
			const expectedMetric = structuredClone(metric);
			Object.assign(metric, { privateValue: "must-not-cross" });
			Object.assign(metric.transactions["row-chunk"], { privateValue: "must-not-cross" });
			const getter = vi.fn(() => {
				throw Error("must-not-cross");
			});
			const state = ownedFixture("JELLYFIN");
			configureDurableRun(state);
			const context = {
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log,
			};
			await refreshOwnedJellyfinEpisodeCache(context);
			await refreshOwnedJellyfinEpisodeCache(context);
			finalizerWorker.run.mockImplementationOnce(async () => {
				if (durable.run) durable.run.state = "complete";
				const workerResult = {
					status: "published",
					itemCount: 17,
					timing: {
						authorityMs: 10,
						stageLoadMs: 20,
						computeMs: 30,
						episodeWriteMs: 40,
						nativeProjectionMs: 50,
						nativeWatchWriteMs: 60,
						totalMs: 210,
						stageRows: 4,
						nativeCandidates: 2,
					},
					finalizationCallMs: 250,
					outerOverheadMs: 40,
					cleanupMs: 80,
					cleanupFailed: false,
				};
				if (mode === "accessor")
					Object.defineProperty(workerResult, "nativeWatchPreparationTiming", { get: getter });
				else
					Object.assign(workerResult, {
						nativeWatchPreparationTiming: mode === "valid" ? metric : { ...metric, version: 2 },
					});
				return workerResult;
			});

			const result = await refreshOwnedJellyfinEpisodeCache({
				...context,
				databaseUrl: "file:/config/prod.db",
			});

			expect(result).toMatchObject({ complete: true, upserted: 17 });
			expect(finalizerWorker.run).toHaveBeenCalledWith(
				expect.objectContaining({
					databaseUrl: "file:/config/prod.db",
					runId: "run-1",
					userId: state.instance.userId,
				}),
				{ signal: undefined },
			);
			expect(log.info).toHaveBeenCalledWith(
				expect.objectContaining({
					category: "jellyfin-episode-finalizer-admission-timing",
					outcome: "admitted",
					durationMs: expect.any(Number),
				}),
				"Jellyfin episode finalizer admission timing",
			);
			expect(log.info).toHaveBeenCalledWith(
				expect.objectContaining({
					category: "jellyfin-episode-finalization-timing",
					workerWaitMs: expect.any(Number),
				}),
				"Jellyfin episode finalization timing",
			);
			expect(durable.finalize).not.toHaveBeenCalled();
			const timingLogs = (log.info as ReturnType<typeof vi.fn>).mock.calls.filter(
				([value]) => value.category === "jellyfin-episode-finalization-timing",
			);
			expect(timingLogs).toHaveLength(1);
			if (mode === "valid")
				expect(timingLogs[0]?.[0].nativeWatchPreparationTiming).toEqual(expectedMetric);
			else expect(timingLogs[0]?.[0]).not.toHaveProperty("nativeWatchPreparationTiming");
			expect(JSON.stringify(timingLogs)).not.toContain("must-not-cross");
			expect(getter).not.toHaveBeenCalled();
		},
	);

	it("reconciles an exact committed run when the worker publication acknowledgement is lost", async () => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
			databaseUrl: "file:/config/prod.db",
		};
		await refreshOwnedJellyfinEpisodeCache(context);
		await refreshOwnedJellyfinEpisodeCache(context);
		const attemptedAt = (durable.outer as { attempt: { attemptedAt: Date } }).attempt.attemptedAt;
		durable.readCompleted.mockResolvedValueOnce(17);
		finalizerWorker.run.mockImplementationOnce(async ({ now }: { now: Date }) => {
			expect(now.getTime()).toBeGreaterThan(attemptedAt.getTime());
			if (durable.run) {
				durable.run.state = "complete";
				durable.run.completedAt = now;
			}
			(state.prisma.cacheRefreshStatus.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
				async (query: { where?: { instanceId_cacheType?: { cacheType?: string } } }) =>
					query.where?.instanceId_cacheType?.cacheType === "jellyfin_episode"
						? {
								lastResult: "success",
								itemCount: 17,
								lastRefreshedAt: now,
								lastAttemptAt: attemptedAt,
								lastAttemptResult: "success",
								connectionGeneration: state.instance.connectionGeneration,
								identityGeneration: state.instance.identityGeneration,
							}
						: state.parentStatus,
			);
			throw new Error("simulated worker acknowledgement loss");
		});

		const result = await refreshOwnedJellyfinEpisodeCache(context);

		expect(result).toMatchObject({ complete: true, errors: 0, upserted: 17, progressed: false });
		expect(durable.invalidate).not.toHaveBeenCalled();
		expect(durable.finishFailure).not.toHaveBeenCalled();
		expect(durable.readCompleted).toHaveBeenCalledWith(state.prisma, {
			userId: state.instance.userId,
			instanceId: state.instance.id,
			runId: "run-1",
			attempt: expect.objectContaining({ attemptedAt }),
		});
	});

	it("does not acknowledge a stale generation after worker transport failure", async () => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
			databaseUrl: "file:/config/prod.db",
		};
		await refreshOwnedJellyfinEpisodeCache(context);
		await refreshOwnedJellyfinEpisodeCache(context);
		const attemptedAt = (durable.outer as { attempt: { attemptedAt: Date } }).attempt.attemptedAt;
		durable.readCompleted.mockResolvedValueOnce(null);
		finalizerWorker.run.mockImplementationOnce(async ({ now }: { now: Date }) => {
			if (durable.run) {
				durable.run.state = "complete";
				durable.run.completedAt = now;
			}
			(state.prisma.cacheRefreshStatus.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
				lastResult: "success",
				itemCount: 17,
				lastRefreshedAt: now,
				lastAttemptAt: attemptedAt,
				lastAttemptResult: "success",
				connectionGeneration: state.instance.connectionGeneration,
				identityGeneration: state.instance.identityGeneration,
				generationId: "different-run",
			});
			throw new Error("simulated worker acknowledgement loss");
		});

		const result = await refreshOwnedJellyfinEpisodeCache(context);
		expect(result).toMatchObject({ complete: false, errors: 1, progressed: false });
		expect(durable.readCompleted).toHaveBeenCalledOnce();
		expect(durable.invalidate).not.toHaveBeenCalled();
	});

	it.each(["lease-busy", "lease-lost"] as const)(
		"retains staged work and the active attempt when the finalizer reports %s",
		async (reason) => {
			const state = ownedFixture("JELLYFIN");
			configureDurableRun(state);
			const context = {
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log,
				databaseUrl: "file:/config/prod.db",
			};
			await refreshOwnedJellyfinEpisodeCache(context);
			await refreshOwnedJellyfinEpisodeCache(context);
			finalizerWorker.run.mockResolvedValueOnce({ status: "not-published", reason });

			const result = await refreshOwnedJellyfinEpisodeCache(context);

			expect(result).toMatchObject({ complete: false, errors: 1, progressed: false });
			expect(durable.finishFailure).not.toHaveBeenCalled();
			expect(durable.invalidate).not.toHaveBeenCalled();
			expect(log.warn).toHaveBeenCalledWith(
				expect.objectContaining({
					category: "jellyfin-episode-finalizer-not-published",
					reason,
				}),
				"Jellyfin episode finalizer did not publish",
			);
		},
	);

	it.each(["transport", "worker", "snapshot-worker", "throwing-log", "settlement-error"] as const)(
		"retains staged work when the finalizer %s fails before publication",
		async (failure) => {
			const failureCode = failure === "snapshot-worker" ? "SQLITE_BUSY_SNAPSHOT" : "P1008";
			const state = ownedFixture("JELLYFIN");
			configureDurableRun(state);
			const context = {
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log,
				databaseUrl: "file:/config/prod.db",
			};
			await refreshOwnedJellyfinEpisodeCache(context);
			await refreshOwnedJellyfinEpisodeCache(context);
			if (failure === "throwing-log") {
				context.log = {
					...log,
					warn: vi.fn((fields: { category?: string }) => {
						if (fields.category === "jellyfin-episode-finalizer-worker-unavailable")
							throw new Error("private logger detail");
					}),
				} as FastifyBaseLogger;
			}
			if (failure === "settlement-error")
				durable.finishFailure.mockRejectedValueOnce(new Error("private settlement detail"));
			if (failure !== "worker" && failure !== "snapshot-worker")
				finalizerWorker.run.mockRejectedValueOnce(new Error("private worker launch detail"));
			else
				finalizerWorker.run.mockResolvedValueOnce({
					status: "failed",
					failurePhase: "publication",
					failureCategory: "database-contention",
					failureStage: "native-watch-stage",
					failureCode,
					failureElapsedMs: 1_234,
					nativeWatchStage: "row-chunk-write",
					nativeWatchStageElapsedMs: 42,
					nativeWatchStageCount: 500,
					nativeWatchPreviousStage: "lease-checkpoint",
					nativeWatchPreviousStageElapsedMs: 5_000,
					nativeWatchTransactionKind: "row-chunk",
					nativeWatchTransactionElapsedMs: 5_042,
					nativeWatchTransactionCallbackEntered: true,
					nativeWatchTransactionWaitMs: 20,
					nativeWatchTransactionCallbackElapsedMs: 5_022,
				});

			const result = await refreshOwnedJellyfinEpisodeCache(context);

			expect(result).toMatchObject({ complete: false, errors: 1, progressed: false });
			expect(durable.invalidate).not.toHaveBeenCalled();
			expect(durable.finishFailure).toHaveBeenCalled();
			if (failure === "worker" || failure === "snapshot-worker")
				expect(log.warn).toHaveBeenCalledWith(
					expect.objectContaining({
						category: "jellyfin-episode-finalizer-worker-unavailable",
						reasonCode: "database-contention",
						stage: "native-watch-stage",
						code: failureCode,
						nativeWatchStage: "row-chunk-write",
						nativeWatchStageElapsedMs: 42,
						nativeWatchStageCount: 500,
						nativeWatchPreviousStage: "lease-checkpoint",
						nativeWatchPreviousStageElapsedMs: 5_000,
						nativeWatchTransactionKind: "row-chunk",
						nativeWatchTransactionElapsedMs: 5_042,
						nativeWatchTransactionCallbackEntered: true,
						nativeWatchTransactionWaitMs: 20,
						nativeWatchTransactionCallbackElapsedMs: 5_022,
					}),
					"Jellyfin episode finalizer worker unavailable",
				);
		},
	);
	it.each(["transport", "returned"] as const)(
		"projects closed loop observations in the existing %s failure warning without changing retry state",
		async (path) => {
			for (const scenario of ["valid", "malformed", "accessor", "private-extra"] as const) {
				const state = ownedFixture("JELLYFIN");
				configureDurableRun(state);
				const warn = vi.fn();
				const context = {
					prisma: state.prisma,
					encryptor: { decrypt: vi.fn() },
					instance: state.instance,
					log: { ...log, warn } as FastifyBaseLogger,
					databaseUrl: "file:/config/prod.db",
				};
				await refreshOwnedJellyfinEpisodeCache(context);
				await refreshOwnedJellyfinEpisodeCache(context);
				const pair = {
					parent: {
						state: "sampled",
						sampleCount: 4,
						sampleSpanMs: 1000,
						maxCompletedGapMs: 250,
						currentGapMs: 20,
					},
					worker: {
						state: "warming",
						sampleCount: 0,
						sampleSpanMs: 0,
						maxCompletedGapMs: 0,
						currentGapMs: 7,
					},
				};
				const carrier =
					path === "transport" ? new Error("private worker launch detail") : { status: "failed" };
				const getter = vi.fn(() => "private sentinel");
				for (const [name, value] of [
					["transportFailure", "runtime-bridge-unavailable"],
					["runtimeLossReason", "worker-proof-timeout"],
				] as const) {
					Object.defineProperty(
						carrier,
						name,
						scenario === "accessor"
							? { get: getter }
							: {
									value: scenario === "malformed" ? "private sentinel" : value,
								},
					);
				}
				if (scenario === "accessor")
					Object.defineProperty(carrier, "loopObservation", { get: getter });
				else
					Object.defineProperty(carrier, "loopObservation", {
						value:
							scenario === "valid"
								? pair
								: scenario === "private-extra"
									? { ...pair, private: "private sentinel" }
									: {
											parent: { ...pair.parent, currentGapMs: Number.NaN },
											worker: { state: "private sentinel" },
										},
					});
				if (path === "transport") finalizerWorker.run.mockRejectedValueOnce(carrier);
				else finalizerWorker.run.mockResolvedValueOnce(carrier);
				const result = await refreshOwnedJellyfinEpisodeCache(context);
				expect(result).toMatchObject({ complete: false, errors: 1, progressed: false });
				expect(durable.invalidate).not.toHaveBeenCalled();
				expect(durable.finishFailure).toHaveBeenCalled();
				const fields = warn.mock.calls.find(
					([fields]) => fields.category === "jellyfin-episode-finalizer-worker-unavailable",
				)?.[0];
				expect(fields.loopObservation).toEqual(
					scenario === "valid"
						? pair
						: { parent: { state: "unavailable" }, worker: { state: "unavailable" } },
				);
				if (path === "transport" && (scenario === "valid" || scenario === "private-extra")) {
					expect(fields).toMatchObject({
						transportFailure: "runtime-bridge-unavailable",
						runtimeLossReason: "worker-proof-timeout",
					});
				} else {
					expect(fields).not.toHaveProperty("transportFailure");
					expect(fields).not.toHaveProperty("runtimeLossReason");
				}
				expect(JSON.stringify(fields)).not.toContain("private");
				expect(getter).not.toHaveBeenCalled();
			}
		},
	);

	it.each(["valid", "malformed", "out-of-context"] as const)(
		"sanitizes native timing warning fields from %s worker results and preserves retry lifecycle",
		async (scenario) => {
			const state = ownedFixture("JELLYFIN");
			configureDurableRun(state);
			const warn = vi.fn();
			const context = {
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log: { ...log, warn } as FastifyBaseLogger,
				databaseUrl: "file:/config/prod.db",
			};
			await refreshOwnedJellyfinEpisodeCache(context);
			await refreshOwnedJellyfinEpisodeCache(context);
			finalizerWorker.run.mockResolvedValueOnce({
				status: "failed",
				failurePhase: "publication",
				failureCategory: "transaction-expired",
				failureCode: "P2028",
				failureElapsedMs: 10,
				failureStage: scenario === "out-of-context" ? "commit" : "native-watch-stage",
				nativeWatchStage: "authority-check",
				nativeWatchStageElapsedMs: 2,
				nativeWatchPreviousStage: scenario === "malformed" ? "private" : "row-chunk-write",
				nativeWatchPreviousStageElapsedMs: scenario === "malformed" ? -1 : 5_000,
				nativeWatchPreviousStageCount: scenario === "malformed" ? 501 : 500,
				nativeWatchTransactionKind: scenario === "malformed" ? "private" : "row-chunk",
				nativeWatchTransactionElapsedMs: scenario === "malformed" ? 1.5 : 2,
				nativeWatchTransactionCallbackEntered: false,
				nativeWatchTransactionWaitMs: 1,
				nativeWatchTransactionCallbackElapsedMs: 1,
				nativeWatchTransactionError: { message: "private" },
				title: "private",
				sql: "private",
			});
			const result = await refreshOwnedJellyfinEpisodeCache(context);
			expect(result).toMatchObject({ complete: false, errors: 1, progressed: false });
			expect(durable.finishFailure).toHaveBeenCalledTimes(1);
			expect(durable.invalidate).not.toHaveBeenCalled();
			const warning = warn.mock.calls.find(
				([fields]) => fields.category === "jellyfin-episode-finalizer-worker-unavailable",
			)?.[0];
			expect(warning).toBeDefined();
			const diagnostics = Object.fromEntries(
				Object.entries(warning ?? {}).filter(([key]) => key.startsWith("nativeWatch")),
			);
			expect(diagnostics).toEqual(
				scenario === "out-of-context"
					? {}
					: {
							nativeWatchStage: "authority-check",
							nativeWatchStageElapsedMs: 2,
							...(scenario === "valid"
								? {
										nativeWatchPreviousStage: "row-chunk-write",
										nativeWatchPreviousStageElapsedMs: 5_000,
										nativeWatchPreviousStageCount: 500,
										nativeWatchTransactionKind: "row-chunk",
										nativeWatchTransactionElapsedMs: 2,
										nativeWatchTransactionCallbackEntered: false,
									}
								: {}),
						},
			);
			expect(JSON.stringify(warning)).not.toContain("private");
		},
	);

	it("does not settle a worker failure while a replacement preparation lease is active", async () => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
			databaseUrl: "file:/config/prod.db",
		};
		await refreshOwnedJellyfinEpisodeCache(context);
		await refreshOwnedJellyfinEpisodeCache(context);
		durable.activePreparationCount = 1;
		finalizerWorker.run.mockResolvedValueOnce({ status: "failed" });

		const result = await refreshOwnedJellyfinEpisodeCache(context);

		expect(result).toMatchObject({ complete: false, errors: 1, progressed: false });
		expect(durable.finishFailure).toHaveBeenCalledOnce();
		expect(durable.recordedFailureCount).toBe(0);
		expect(durable.invalidate).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		"classifies a transient current-authority read before renewal only in automatic mode: %s",
		async (automatic) => {
			const state = ownedFixture("JELLYFIN", { v3: true });
			const client = configureDurableRun(state, 2);
			vi.mocked(state.prisma.serviceInstance.findFirst).mockRejectedValueOnce(
				new Prisma.PrismaClientKnownRequestError("private database detail", {
					code: "P2028",
					clientVersion: "test",
				}),
			);
			const pending = refreshOwnedJellyfinEpisodeCache({
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log,
				...(automatic ? { automaticRenewal: "provider-unavailable-cooldown" as const } : {}),
			});
			if (automatic)
				expect(await pending).toMatchObject({
					errors: 1,
					retryablePreRenewalFailure: true,
					progressed: false,
				});
			else await expect(pending).rejects.toThrow();
			if (automatic)
				expect(durable.finishFailure).toHaveBeenCalledWith(
					state.prisma,
					"jellyfin_episode",
					"collection-deferred",
					expect.any(Object),
					expect.any(Object),
					log,
					expect.any(Object),
				);
			expect(durable.renew).not.toHaveBeenCalled();
			expect(client.getEpisodeItemsPageWithCoverage).not.toHaveBeenCalled();
		},
	);

	it.each(["status", "rows"])(
		"retains recovery through a transient initial parent %s read",
		async (kind) => {
			const state = ownedFixture("JELLYFIN", { v3: true });
			const client = configureDurableRun(state, 2);
			const error = new Prisma.PrismaClientKnownRequestError("private detail", {
				code: "P2028",
				clientVersion: "test",
			});
			if (kind === "status")
				vi.mocked(state.prisma.cacheRefreshStatus.findUnique)
					.mockRejectedValueOnce(error)
					.mockRejectedValueOnce(error);
			else vi.mocked(state.prisma.jellyfinCache.findMany).mockRejectedValueOnce(error);
			const result = await refreshOwnedJellyfinEpisodeCache({
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log,
				automaticRenewal: "provider-unavailable-cooldown",
			});
			expect(result).toMatchObject({
				errors: 1,
				progressed: false,
				retryablePreRenewalFailure: true,
			});
			expect(durable.finishFailure).toHaveBeenCalledWith(
				state.prisma,
				"jellyfin_episode",
				"collection-deferred",
				expect.any(Object),
				expect.any(Object),
				log,
				expect.any(Object),
			);
			expect(durable.renew).not.toHaveBeenCalled();
			expect(client.getEpisodeItemsPageWithCoverage).not.toHaveBeenCalled();
		},
	);

	it.each(["superseded", "failed"])(
		"does not retry pre-renewal work when marker settlement is %s",
		async (settlement) => {
			const state = ownedFixture("JELLYFIN", { v3: true });
			const client = configureDurableRun(state, 2);
			durable.finishFailure.mockResolvedValue(settlement);
			vi.mocked(state.prisma.serviceInstance.findFirst).mockRejectedValueOnce(
				new Prisma.PrismaClientKnownRequestError("private detail", {
					code: "P2028",
					clientVersion: "test",
				}),
			);
			const result = await refreshOwnedJellyfinEpisodeCache({
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log,
				automaticRenewal: "provider-unavailable-cooldown",
			});
			expect(result.retryablePreRenewalFailure).toBeUndefined();
			expect(durable.renew).not.toHaveBeenCalled();
			expect(client.getEpisodeItemsPageWithCoverage).not.toHaveBeenCalled();
		},
	);

	it("does not settle a foreign outer marker when automatic renewal is deferred", async () => {
		const state = ownedFixture("JELLYFIN", { v3: true });
		const client = configureDurableRun(state, 2);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
			automaticRenewal: "provider-unavailable-cooldown" as const,
			now: new Date(),
		};

		await refreshOwnedJellyfinEpisodeCache({
			...context,
			automaticRenewal: undefined,
		});
		if (
			typeof durable.run?.parentGenerationId !== "string" ||
			!durable.run.parentGenerationId.startsWith("jellyfin-episode-parent-v3:")
		)
			throw new Error("expected the durable fixture to create a V3 run");
		const failedUnit = durable.units[0]!;
		failedUnit.state = "failed";
		failedUnit.attemptCount = 4;
		failedUnit.nextAttemptAt = null;
		failedUnit.claimToken = null;
		durable.run.state = "failed";
		durable.run.nextAttemptAt = null;
		durable.run.lastReasonCode = "provider-unavailable";
		durable.exhausted.mockResolvedValue(true);
		durable.outer = {
			status: "already-running",
			attempt: {
				attemptedAt: new Date("2026-09-10T12:00:00.000Z"),
				resultMarker: "in_progress:foreign",
			},
		};
		durable.renew.mockResolvedValue("deferred");
		const pageCalls = client.getEpisodeItemsPageWithCoverage.mock.calls.length;

		const result = await refreshOwnedJellyfinEpisodeCache(context);

		expect(result).toMatchObject({ errors: 1, complete: false, renewalDeferred: true });
		expect(durable.finishFailure).not.toHaveBeenCalled();
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(pageCalls);
	});

	it.each(["recorded", "superseded", "failed"])(
		"schedules owned deferred renewal only after recorded settlement: %s",
		async (settlement) => {
			const state = ownedFixture("JELLYFIN", { v3: true });
			const client = configureDurableRun(state, 2);
			const context = {
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log,
				automaticRenewal: "provider-unavailable-cooldown" as const,
				now: new Date(),
			};
			await refreshOwnedJellyfinEpisodeCache({ ...context, automaticRenewal: undefined });
			if (
				typeof durable.run?.parentGenerationId !== "string" ||
				!durable.run.parentGenerationId.startsWith("jellyfin-episode-parent-v3:")
			)
				throw new Error("expected the durable fixture to create a V3 run");
			const failedUnit = durable.units[0]!;
			failedUnit.state = "failed";
			failedUnit.attemptCount = 4;
			failedUnit.nextAttemptAt = null;
			failedUnit.claimToken = null;
			durable.run.state = "failed";
			durable.run.nextAttemptAt = null;
			durable.run.lastReasonCode = "provider-unavailable";
			durable.exhausted.mockResolvedValue(true);
			durable.outer = {
				status: "acquired",
				attempt: {
					attemptedAt: new Date("2026-09-10T12:00:00.000Z"),
					resultMarker: "in_progress:owned",
				},
			};
			durable.renew.mockResolvedValue("deferred");
			durable.finishFailure.mockResolvedValue(settlement);
			const deadline = new Date(Date.now() + 30 * 60_000);
			durable.deadline.mockResolvedValue(deadline);
			const pageCalls = client.getEpisodeItemsPageWithCoverage.mock.calls.length;

			const result = await refreshOwnedJellyfinEpisodeCache(context);

			expect(result).toMatchObject({ errors: 1, complete: false, renewalDeferred: true });
			expect(result.renewalDeadline).toEqual(settlement === "recorded" ? deadline : undefined);
			expect(durable.finishFailure).toHaveBeenCalledWith(
				state.prisma,
				"jellyfin_episode",
				"collection-deferred",
				expect.anything(),
				expect.anything(),
				log,
				expect.anything(),
				expect.any(Function),
			);
			expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(pageCalls);
		},
	);

	it("uses current libraries even when the authoritative parent contains no series", async () => {
		const state = ownedFixture("JELLYFIN", { parentMediaType: "movie" });
		const client = configureDurableRun(state, 0);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 0,
		});
		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 0,
		});
		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: true,
			errors: 0,
		});
		expect(client.getLibraries).toHaveBeenCalled();
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(2);
		expect(durable.finalize).toHaveBeenCalledOnce();
	});

	it("defers admission while the current parent library refresh is in progress", async () => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state);
		state.parentStatus.lastAttemptAt = new Date("2026-09-08T12:00:00.000Z");
		state.parentStatus.lastAttemptResult = "in_progress:00000000-0000-4000-8000-000000000001";
		const client = publication.client!;

		const result = await refreshOwnedJellyfinEpisodeCache({
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
			now: new Date("2026-09-08T12:01:00.000Z"),
		});

		expect(result).toMatchObject({
			complete: false,
			errors: 0,
			progressed: false,
			parentRefreshPending: true,
		});
		expect(durable.finishFailure).not.toHaveBeenCalled();
		expect(
			(client as unknown as { getUsers: ReturnType<typeof vi.fn> }).getUsers,
		).not.toHaveBeenCalled();
	});

	it.each([
		"malformed marker",
		"future timestamp",
		"changed generation",
		"disabled owner",
		"changed owner",
	])("does not defer for a %s parent status", async (scenario) => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state);
		state.parentStatus.lastAttemptAt = new Date(
			scenario === "future timestamp" ? "2026-09-08T12:02:00.000Z" : "2026-09-08T12:00:00.000Z",
		);
		state.parentStatus.lastAttemptResult =
			scenario === "malformed marker"
				? "in_progress:not-a-uuid"
				: "in_progress:00000000-0000-4000-8000-000000000001";
		if (scenario === "changed generation") state.parentStatus.connectionGeneration = 8;
		if (scenario === "disabled owner" || scenario === "changed owner")
			(state.prisma.serviceInstance.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

		const result = await refreshOwnedJellyfinEpisodeCache({
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
			now: new Date("2026-09-08T12:01:00.000Z"),
		});

		expect(result.parentRefreshPending).toBeUndefined();
	});

	it("retains a staged run when the parent starts refreshing during final verification", async () => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state, 0);
		state.parentStatus.lastRefreshedAt = new Date("2026-09-08T12:00:00.000Z");
		state.parentStatus.lastAttemptAt = new Date("2026-09-08T12:00:00.000Z");
		const parentPendingStatus = {
			...state.parentStatus,
			lastAttemptAt: new Date("2026-09-08T12:00:00.000Z"),
			lastAttemptResult: "in_progress:00000000-0000-4000-8000-000000000001",
		};
		let statusReads = 0;
		vi.mocked(state.prisma.cacheRefreshStatus.findUnique).mockImplementation((async () => {
			statusReads += 1;
			return (statusReads === 7 ? parentPendingStatus : state.parentStatus) as never;
		}) as never);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
			now: new Date("2026-09-08T12:01:00.000Z"),
		};

		await refreshOwnedJellyfinEpisodeCache(context);
		await refreshOwnedJellyfinEpisodeCache(context);
		const result = await refreshOwnedJellyfinEpisodeCache(context);

		expect(result).toMatchObject({
			complete: false,
			errors: 0,
			progressed: false,
			parentRefreshPending: true,
		});
		expect(durable.finalize).not.toHaveBeenCalled();
		expect(durable.invalidate).not.toHaveBeenCalled();
		expect(durable.run).toMatchObject({ state: "running", completedUnits: 2, totalUnits: 2 });
		expect(durable.finishFailure).toHaveBeenCalledWith(
			state.prisma,
			"jellyfin_episode",
			"collection-deferred",
			expect.anything(),
			expect.anything(),
			log,
			expect.anything(),
		);

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: true,
			errors: 0,
		});
		expect(durable.finalize).toHaveBeenCalledOnce();
	});

	it("runs the same durable page contract for an owned Emby instance", async () => {
		const state = ownedFixture("EMBY");
		const client = configureDurableRun(state);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await refreshOwnedJellyfinEpisodeCache(context);
		await refreshOwnedJellyfinEpisodeCache(context);
		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: true,
			errors: 0,
		});
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(2);
		expect(client.getEpisodeItemsPageWithCoverage.mock.calls[0]?.[3]).toBe(1_000);
	});

	it("fails the acquired attempt without provider reads when credential preparation fails", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		publication.snapshotError = true;
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 1,
			progressed: false,
		});
		expect(client.getUsers).not.toHaveBeenCalled();
		expect(durable.finishFailure).toHaveBeenCalledOnce();
		expect(durable.invalidate).not.toHaveBeenCalled();
		publication.snapshotError = false;
	});

	it("rejects a same-generation endpoint or credential replacement before provider reads", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		(state.prisma.serviceInstance.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
			...state.instance,
			baseUrl: "https://replacement.invalid",
			encryptedApiKey: "replacement-cipher",
		});

		const result = await refreshOwnedJellyfinEpisodeCache({
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		});

		expect(result).toMatchObject({ complete: false, errors: 1, upserted: 0 });
		expect(client.getUsers).not.toHaveBeenCalled();
		expect(client.getLibraries).not.toHaveBeenCalled();
		expect(client.getEpisodeItemsPageWithCoverage).not.toHaveBeenCalled();
		expect(durable.guard).not.toHaveBeenCalled();
		expect(durable.finishFailure).toHaveBeenCalledOnce();
	});

	it("treats an empty current user inventory as unavailable instead of publishing absence", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		client.getUsers.mockResolvedValueOnce([]);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 1,
		});
		expect(client.getEpisodeItemsPageWithCoverage).not.toHaveBeenCalled();
		expect(durable.finishFailure).toHaveBeenCalledOnce();
	});

	it("keeps a continuation retryable when the exact attempt's provider page is unavailable", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state, 1_001);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await refreshOwnedJellyfinEpisodeCache(context);
		durable.outer = {
			status: "already-running",
			attempt: {
				attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
				resultMarker: "in_progress:test",
			},
		};
		client.getEpisodeItemsPageWithCoverage.mockRejectedValueOnce(new Error("unavailable"));

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 1,
		});
		expect(durable.failUnit).toHaveBeenCalledWith(state.prisma, {
			claim: expect.objectContaining({ runId: "run-1", unitId: "unit-0" }),
			reasonCode: "provider-unavailable",
			now: expect.any(Date),
		});
		expect(durable.invalidate).not.toHaveBeenCalled();
		expect(durable.recordedFailureCount).toBe(1);
	});

	it("logs only a bounded schema category when a private provider page is rejected", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		const warn = log.warn as unknown as ReturnType<typeof vi.fn>;
		warn.mockClear();
		client.getEpisodeItemsPageWithCoverage.mockRejectedValueOnce(
			new UpstreamValidationError("PRIVATE_RESPONSE_DETAIL", "jellyfin", "provider-response", [
				"Items.0.UserData.Played: PRIVATE_FIELD_DETAIL",
			]),
		);

		const result = await refreshOwnedJellyfinEpisodeCache({
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		});

		expect(warn).toHaveBeenCalledWith(
			{ category: "episode-row-schema" },
			"Jellyfin episode page unavailable",
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
		expect(durable.failUnit).toHaveBeenCalledOnce();
		expect(result.progressed).toBe(false);
	});

	it.each([
		["P1008", "prisma-known", "P1008", "SQLITE_BUSY"],
		["P1008-snapshot", "prisma-known", "P1008", "SQLITE_BUSY_SNAPSHOT"],
		["P1008-unclassified", "prisma-known", "P1008", null],
		["P2024", "prisma-known", "P2024", null],
		["P9999", "prisma-known", "other", "other"],
		["runtime", "runtime-admission", null, null],
		["unknown", "other", null, null],
	])(
		"logs a bounded staging failure class for exhausted %s without changing settlement",
		async (code, errorCategory, databaseCode, sqliteCode) => {
			const state = ownedFixture("JELLYFIN");
			configureDurableRun(state);
			const info = log.info as unknown as ReturnType<typeof vi.fn>;
			info.mockClear();
			const failure =
				code === "runtime"
					? new RestoreRuntimeAdmissionError()
					: code === "unknown"
						? new Error("PRIVATE_ERROR_DETAIL")
						: new Prisma.PrismaClientKnownRequestError("PRIVATE_DATABASE_DETAIL", {
								code: code!.startsWith("P1008") ? "P1008" : code!,
								clientVersion: "test",
								meta: {
									target: "PRIVATE_COLUMN",
									driverAdapterError: {
										cause: {
											originalCode:
												code === "P1008"
													? "SQLITE_BUSY"
													: code === "P1008-snapshot"
														? "SQLITE_BUSY_SNAPSHOT"
														: code === "P9999"
															? "PRIVATE_DRIVER"
															: null,
										},
									},
								},
							});
			const attempts = code === "P1008" || code === "P1008-snapshot" ? 3 : 1;
			for (let attempt = 0; attempt < attempts; attempt++)
				durable.stage.mockRejectedValueOnce(failure);
			const result = await refreshOwnedJellyfinEpisodeCache({
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log,
			});
			expect(info).toHaveBeenCalledWith(
				{ category: "jellyfin-episode-stage-failure", errorCategory, databaseCode, sqliteCode },
				"Jellyfin episode staging failure category",
			);
			expect(JSON.stringify(info.mock.calls)).not.toContain("PRIVATE");
			expect(durable.stage).toHaveBeenCalledTimes(attempts);
			if (code === "P1008" || code === "P1008-snapshot") {
				expect(durable.failUnit).not.toHaveBeenCalled();
				expect(durable.units[0]).toMatchObject({ state: "pending", claimToken: null });
			} else {
				expect(durable.failUnit).toHaveBeenCalledOnce();
			}
			expect(durable.invalidate).not.toHaveBeenCalled();
			expect(result.progressed).toBe(false);
		},
	);

	it.each(["P1008", "P2028"])(
		"finishes a deferred joined release before resuming a page after %s",
		async (code) => {
			const state = ownedFixture("JELLYFIN");
			const client = configureDurableRun(state, 2_001);
			const run = createJellyfinEpisodeWorkItemRunner();
			const context = {
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log,
				cleanupRunClaimToken: "cleanup-first",
			};
			await run(context);
			const failure = new Prisma.PrismaClientKnownRequestError("private database failure", {
				code,
				clientVersion: "test",
				meta: { driverAdapterError: { cause: { originalCode: "SQLITE_BUSY" } } },
			});
			const stageAttempts = code === "P1008" ? 3 : 1;
			for (let attempt = 0; attempt < stageAttempts; attempt++)
				durable.stage.mockRejectedValueOnce(failure);
			durable.releaseUnit.mockResolvedValueOnce("deferred");

			await expect(run(context)).resolves.toMatchObject({
				progressed: false,
				retryableDependencyFailure: true,
			});
			expect(durable.units[0]).toMatchObject({
				state: "running",
				cursor: 1_000,
				observedRawCount: 1_000,
				claimToken: "claim-unit-0",
			});
			const claimCalls = durable.claimUnit.mock.calls.length;
			const providerCalls = client.getEpisodeItemsPageWithCoverage.mock.calls.length;
			const stageCalls = durable.stage.mock.calls.length;

			await expect(
				run({ ...context, cleanupRunClaimToken: "cleanup-current" }),
			).resolves.toMatchObject({
				progressed: false,
			});
			expect(durable.units[0]).toMatchObject({
				state: "pending",
				cursor: 1_000,
				observedRawCount: 1_000,
				claimToken: null,
			});
			expect(durable.releaseUnit).toHaveBeenCalledTimes(2);
			expect(durable.releaseUnit.mock.calls[1]![1]).toEqual({
				...durable.releaseUnit.mock.calls[0]![1],
				cleanupRunClaimToken: "cleanup-current",
			});
			expect(durable.claimUnit).toHaveBeenCalledTimes(claimCalls);
			expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(providerCalls);
			expect(durable.stage).toHaveBeenCalledTimes(stageCalls);
			expect(durable.failUnit).not.toHaveBeenCalled();
			expect(durable.recordedFailureCount).toBe(0);

			await expect(run(context)).resolves.toMatchObject({ progressed: true });
			expect(durable.units[0]).toMatchObject({ cursor: 2_000, observedRawCount: 2_000 });
			expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenLastCalledWith(
				"user-1",
				"library-1",
				1_000,
				2_000,
			);
			expect(durable.releaseUnit).toHaveBeenCalledTimes(2);
		},
	);

	it.each(["deferred", "transient-throw", "unexpected-throw"])(
		"retains a joined release obligation across %s without spending provider retries",
		async (outcome) => {
			const state = ownedFixture("JELLYFIN");
			const client = configureDurableRun(state);
			const run = createJellyfinEpisodeWorkItemRunner();
			const context = {
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log,
			};
			const timeout = new Prisma.PrismaClientKnownRequestError("private transaction timeout", {
				code: "P2028",
				clientVersion: "test",
			});
			durable.stage.mockRejectedValueOnce(timeout);
			const releaseError =
				outcome === "transient-throw" ? timeout : new Error("private release error");
			if (outcome === "deferred") durable.releaseUnit.mockResolvedValueOnce("deferred");
			else durable.releaseUnit.mockRejectedValueOnce(releaseError);

			if (outcome === "unexpected-throw") await expect(run(context)).rejects.toBe(releaseError);
			else
				await expect(run(context)).resolves.toMatchObject({
					retryableDependencyFailure: true,
					progressed: false,
				});
			durable.releaseUnit.mockResolvedValueOnce("deferred");
			await expect(run(context)).resolves.toMatchObject({
				retryableDependencyFailure: true,
				progressed: false,
			});
			expect(durable.units[0]).toMatchObject({
				state: "running",
				claimToken: "claim-unit-0",
				cursor: 0,
			});
			await expect(run(context)).resolves.toMatchObject({ progressed: false });
			expect(durable.units[0]).toMatchObject({ state: "pending", claimToken: null, cursor: 0 });
			expect(durable.releaseUnit).toHaveBeenCalledTimes(3);
			expect(durable.claimUnit).toHaveBeenCalledOnce();
			expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledOnce();
			expect(durable.stage).toHaveBeenCalledOnce();
			expect(durable.failUnit).not.toHaveBeenCalled();
			expect(durable.recordedFailureCount).toBe(0);
		},
	);

	it.each([
		{ userId: "different-owner" },
		{ expectedIdentity: "different-server" },
		{ connectionGeneration: 8 },
		{ identityGeneration: 3 },
	])("discards a deferred release when its authority changes (%j)", async (change) => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		const run = createJellyfinEpisodeWorkItemRunner();
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};
		durable.stage.mockRejectedValueOnce(
			new Prisma.PrismaClientKnownRequestError("timeout", { code: "P2028", clientVersion: "test" }),
		);
		durable.releaseUnit.mockResolvedValueOnce("deferred");
		await run(context);

		await expect(
			run({ ...context, instance: { ...state.instance, ...change } }),
		).resolves.toMatchObject({ superseded: true, progressed: false });
		expect(durable.releaseUnit).toHaveBeenCalledOnce();
		expect(durable.claimUnit).toHaveBeenCalledOnce();
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledOnce();
		expect(durable.units[0]).toMatchObject({
			state: "running",
			claimToken: "claim-unit-0",
			cursor: 0,
		});
	});

	it("retires a deferred release without touching a replacement claim", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		const run = createJellyfinEpisodeWorkItemRunner();
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};
		durable.stage.mockRejectedValueOnce(
			new Prisma.PrismaClientKnownRequestError("timeout", { code: "P2028", clientVersion: "test" }),
		);
		durable.releaseUnit.mockResolvedValueOnce("deferred");
		await run(context);
		durable.units[0]!.claimToken = "replacement-owner-claim";

		const recovered = await run(context);
		expect(recovered).toMatchObject({ retryableDependencyFailure: true, progressed: false });
		expect(recovered.superseded).not.toBe(true);
		expect(durable.units[0]).toMatchObject({
			state: "running",
			claimToken: "replacement-owner-claim",
			cursor: 0,
		});
		expect(durable.releaseUnit.mock.calls[1]![1].claim.claimToken).toBe("claim-unit-0");
		expect(durable.claimUnit).toHaveBeenCalledOnce();
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledOnce();
	});

	it("resumes the committed cursor after a lost stage acknowledgement and deferred release", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state, 2_001);
		const run = createJellyfinEpisodeWorkItemRunner();
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};
		const stage = durable.stage.getMockImplementation()!;
		durable.stage.mockImplementationOnce(async (...args) => {
			await stage(...args);
			durable.units[0]!.claimToken = null;
			throw new Prisma.PrismaClientKnownRequestError("lost acknowledgement", {
				code: "P2028",
				clientVersion: "test",
			});
		});
		durable.releaseUnit.mockResolvedValueOnce("deferred");
		await run(context);
		const recovered = await run(context);
		expect(recovered).toMatchObject({ retryableDependencyFailure: true, progressed: false });
		expect(recovered.superseded).not.toBe(true);
		expect(durable.units[0]).toMatchObject({
			state: "pending",
			cursor: 1_000,
			observedRawCount: 1_000,
			claimToken: null,
		});
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledOnce();

		await expect(run(context)).resolves.toMatchObject({ progressed: true });
		expect(durable.units[0]).toMatchObject({ cursor: 2_000, observedRawCount: 2_000 });
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenLastCalledWith(
			"user-1",
			"library-1",
			1_000,
			2_000,
		);
		expect(durable.releaseUnit).toHaveBeenCalledTimes(2);
	});

	it("continues the real scheduler from the committed cursor after lost acknowledgement", async () => {
		vi.useFakeTimers();
		const app: FastifyInstance = Fastify({ logger: false });
		try {
			const state = ownedFixture("JELLYFIN");
			const client = configureDurableRun(state, 2_001);
			const stage = durable.stage.getMockImplementation()!;
			durable.stage.mockImplementationOnce(async (...args) => {
				await stage(...args);
				durable.units[0]!.claimToken = null;
				throw new Prisma.PrismaClientKnownRequestError("lost acknowledgement", {
					code: "P2028",
					clientVersion: "test",
				});
			});
			durable.releaseUnit.mockResolvedValueOnce("deferred");
			const registry = new SchedulerRegistry();
			for (const definition of KNOWN_JOBS) registry.register(definition);
			for (const [name, decorate] of [
				["prisma", () => app.decorate("prisma", state.prisma)],
				["security", () => app.decorate("encryptor", { decrypt: vi.fn() } as never)],
				["scheduler-registry", () => app.decorate("schedulerRegistry", registry)],
			] as const) {
				await app.register(
					fastifyPlugin(
						async () => {
							decorate();
						},
						{ name },
					),
				);
			}
			await app.register(jellyfinEpisodeCacheSchedulerPlugin);
			await app.ready();
			const admitted = await (
				app as FastifyWithEpisodeRefreshScheduler
			).episodeRefreshScheduler.retry("jellyfin_episode", {
				userId: state.instance.userId,
				instanceId: state.instance.id,
			});
			expect(admitted.status).toBe("accepted");
			if (admitted.status === "accepted") await admitted.backgroundTask;
			expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledOnce();
			expect(durable.units[0]).toMatchObject({ state: "pending", cursor: 1_000, claimToken: null });

			await vi.advanceTimersByTimeAsync(30_000);
			expect(durable.releaseUnit).toHaveBeenCalledTimes(2);
			expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(120_000);
			expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(2);
			expect(durable.units[0]).toMatchObject({ cursor: 2_000, observedRawCount: 2_000 });
			expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenLastCalledWith(
				"user-1",
				"library-1",
				1_000,
				2_000,
			);
			expect(durable.failUnit).not.toHaveBeenCalled();
		} finally {
			await app.close();
			vi.useRealTimers();
		}
	});

	it("does not transfer deferred releases to a replacement database client", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		const run = createJellyfinEpisodeWorkItemRunner();
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};
		durable.stage.mockRejectedValueOnce(
			new Prisma.PrismaClientKnownRequestError("timeout", { code: "P2028", clientVersion: "test" }),
		);
		durable.releaseUnit.mockResolvedValueOnce("deferred");
		await run(context);

		await run({ ...context, prisma: { ...state.prisma } as PrismaClient });
		expect(durable.releaseUnit).toHaveBeenCalledOnce();
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(2);
		await run(context);
		expect(durable.releaseUnit).toHaveBeenCalledTimes(2);
		expect(durable.units[0]).toMatchObject({ state: "pending", claimToken: null, cursor: 0 });
	});

	it("keeps a deferred release when a later invocation is cancelled before settlement", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		const run = createJellyfinEpisodeWorkItemRunner();
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};
		durable.stage.mockRejectedValueOnce(
			new Prisma.PrismaClientKnownRequestError("timeout", { code: "P2028", clientVersion: "test" }),
		);
		durable.releaseUnit.mockResolvedValueOnce("deferred");
		await run(context);
		await expect(run({ ...context, signal: AbortSignal.abort() })).rejects.toMatchObject({
			code: "PUBLICATION_CANCELLED",
		});
		expect(durable.releaseUnit).toHaveBeenCalledOnce();
		await run(context);
		expect(durable.units[0]).toMatchObject({ state: "pending", claimToken: null, cursor: 0 });
		expect(durable.releaseUnit).toHaveBeenCalledTimes(2);
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledOnce();
	});

	it("does not let an older release completion erase a newer obligation", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		client.getUsers.mockResolvedValue([
			{ id: "user-1", name: "Alice" },
			{ id: "user-2", name: "Bob" },
		]);
		const run = createJellyfinEpisodeWorkItemRunner();
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};
		const readPage = client.getEpisodeItemsPageWithCoverage.getMockImplementation()!;
		const deferred = () => {
			let resolve!: () => void;
			const promise = new Promise<void>((done) => {
				resolve = done;
			});
			return { promise, resolve };
		};
		const readEntered = deferred();
		const finishRead = deferred();
		client.getEpisodeItemsPageWithCoverage.mockImplementationOnce(async (...args) => {
			readEntered.resolve();
			await finishRead.promise;
			return await readPage(...args);
		});
		const timeout = new Prisma.PrismaClientKnownRequestError("timeout", {
			code: "P2028",
			clientVersion: "test",
		});
		durable.stage.mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout);
		const release = durable.releaseUnit.getMockImplementation()!;
		const releaseEntered = deferred();
		const finishRelease = deferred();
		durable.releaseUnit
			.mockImplementationOnce(async (...args) => {
				releaseEntered.resolve();
				await finishRelease.promise;
				return await release(...args);
			})
			.mockResolvedValueOnce("deferred");

		const first = run(context);
		await readEntered.promise;
		const second = run(context);
		await releaseEntered.promise;
		finishRead.resolve();
		await first;
		expect(durable.units[0]).toMatchObject({ state: "running", claimToken: "claim-unit-0" });
		finishRelease.resolve();
		await second;
		expect(durable.units[1]).toMatchObject({ state: "pending", claimToken: null });

		await run(context);
		expect(durable.units[0]).toMatchObject({ state: "pending", claimToken: null, cursor: 0 });
		expect(durable.releaseUnit.mock.calls.map((call) => call[1].claim.unitId)).toEqual([
			"unit-1",
			"unit-0",
			"unit-0",
		]);
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(2);
		expect(durable.stage).toHaveBeenCalledTimes(2);
		expect(durable.failUnit).not.toHaveBeenCalled();
	});

	it.each([
		["P2002", "episode-stage-conflict"],
		["P2028", "episode-stage-timeout"],
		["P2034", "episode-stage-contention"],
		["P9999", "episode-stage-unavailable"],
	])("separates %s staging failures without exposing database details", async (code, category) => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state);
		const warn = log.warn as unknown as ReturnType<typeof vi.fn>;
		warn.mockClear();
		durable.stage.mockRejectedValueOnce(
			new Prisma.PrismaClientKnownRequestError("PRIVATE_DATABASE_DETAIL", {
				code,
				clientVersion: "test",
				meta: { target: "PRIVATE_COLUMN" },
			}),
		);
		const result = await refreshOwnedJellyfinEpisodeCache({
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		});
		expect(warn).toHaveBeenCalledWith({ category }, "Jellyfin episode page unavailable");
		expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
		if (code === "P2028") {
			expect(durable.failUnit).not.toHaveBeenCalled();
			expect(durable.units[0]).toMatchObject({ state: "pending", claimToken: null });
			expect(durable.recordedFailureCount).toBe(0);
		} else {
			expect(durable.failUnit).toHaveBeenCalledWith(state.prisma, {
				claim: expect.any(Object),
				reasonCode: "provider-unavailable",
				now: expect.any(Date),
			});
		}
		expect(durable.invalidate).not.toHaveBeenCalled();
		expect(result.progressed).toBe(false);
	});

	it.each(["recorded", "superseded"] as const)(
		"settles an inherited catalog-drift attempt atomically before requesting replan (%s)",
		async (settlement) => {
			const state = ownedFixture("JELLYFIN");
			const client = configureDurableRun(state, 1_001);
			const context = {
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log,
			};
			await refreshOwnedJellyfinEpisodeCache(context);
			const originalParent = durable.run!.parentGenerationId;
			durable.outer = {
				status: "already-running",
				attempt: {
					attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
					resultMarker: "in_progress:test",
				},
			};
			const addedRow = {
				...state.parentRow,
				id: "row-added",
				jellyfinId: "series-added",
				tmdbId: 43,
			};
			const rows = [state.parentRow, addedRow];
			const metadata = JSON.parse(state.parentStatus.generationMetadata);
			metadata.itemCount = 2;
			metadata.contentFingerprint = fingerprintJellyfinLibraryRows(rows);
			metadata.coverageReceipt.publishedCanonicalEntities = 2;
			Object.assign(metadata.coverageReceipt.units[0], {
				expectedRawCount: 2,
				rawObserved: 2,
				sourceBindings: 2,
				canonicalEntities: 2,
			});
			state.parentStatus.itemCount = 2;
			state.parentStatus.generationId = "library-generation-added";
			state.parentStatus.generationMetadata = encodeJellyfinLibraryGenerationMetadata(metadata);
			vi.mocked(state.prisma.jellyfinCache.findMany).mockResolvedValue(rows as never);
			durable.invalidateAttempt.mockResolvedValueOnce(settlement);
			client.getEpisodeItemsPageWithCoverage.mockClear();

			const result = await refreshOwnedJellyfinEpisodeCache(context);

			expect(durable.invalidateAttempt).toHaveBeenCalledOnce();
			expect(durable.invalidateAttempt).toHaveBeenCalledWith(
				expect.objectContaining({
					prisma: state.prisma,
					runId: "run-1",
					attempt: expect.objectContaining({ resultMarker: "in_progress:test" }),
					authority: expect.objectContaining({
						id: state.instance.id,
						userId: state.instance.userId,
					}),
				}),
			);
			expect(result).toMatchObject({ complete: false, errors: 1, progressed: false });
			expect(result.replanRequired).toBe(settlement === "recorded" ? true : undefined);
			expect(result.superseded).toBe(settlement === "superseded" ? true : undefined);
			expect(durable.run!.parentGenerationId).toBe(originalParent);
			expect(durable.invalidate).not.toHaveBeenCalled();
			expect(durable.finishFailure).not.toHaveBeenCalled();
			expect(client.getEpisodeItemsPageWithCoverage).not.toHaveBeenCalled();
		},
	);

	it("rediscovers failed-run scopes without terminalizing an attempt it cannot bind after drift", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state, 1_001);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await refreshOwnedJellyfinEpisodeCache(context);
		durable.outer = {
			status: "already-running",
			attempt: {
				attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
				resultMarker: "in_progress:test",
			},
		};
		client.getLibraries.mockResolvedValueOnce([{ id: "library-replacement" }]);
		durable.run!.state = "failed";

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 1,
		});
		expect(durable.invalidate).toHaveBeenCalledWith(state.prisma, "run-1", expect.any(Date));
		expect(durable.finishFailure).not.toHaveBeenCalled();
	});

	it("treats a superseded page-stage claim as a no-op", async () => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state);
		durable.stage.mockImplementationOnce(async (...args: unknown[]) => {
			(args[5] as ((reason: string) => void) | undefined)?.("claim-mismatch");
			return false;
		});
		durable.failUnit.mockResolvedValueOnce(false);
		(log.warn as unknown as ReturnType<typeof vi.fn>).mockClear();
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 0,
			progressed: false,
		});
		expect(durable.invalidate).not.toHaveBeenCalled();
		expect(durable.failUnit).toHaveBeenCalledWith(state.prisma, {
			claim: expect.objectContaining({ runId: "run-1", unitId: "unit-0" }),
			reasonCode: "coverage-incomplete",
			now: expect.any(Date),
			resetProgress: true,
		});
		expect(log.warn).toHaveBeenCalledWith(
			{ category: "episode-page-rejected", reason: "claim-mismatch" },
			"Jellyfin episode page unavailable",
		);
		expect(durable.finishFailure).not.toHaveBeenCalled();
	});

	it("terminalizes only an acquired attempt when scope discovery fails", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		client.getUsers.mockRejectedValueOnce(new Error("unavailable"));
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		const result = await refreshOwnedJellyfinEpisodeCache(context);
		expect(result).toMatchObject({ complete: false, errors: 1, progressed: false });
		expect(durable.finishFailure).toHaveBeenCalledOnce();
		expect(durable.invalidate).not.toHaveBeenCalled();

		durable.outer = {
			status: "already-running",
			attempt: {
				attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
				resultMarker: "in_progress:other",
			},
		};
		client.getUsers.mockRejectedValueOnce(new Error("unavailable"));
		await refreshOwnedJellyfinEpisodeCache(context);
		expect(durable.finishFailure).toHaveBeenCalledOnce();
	});

	it("resumes 4,163 items at provider cursors without any per-series call", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state, 4_163);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		for (let invocation = 0; invocation < 10; invocation += 1) {
			const result = await refreshOwnedJellyfinEpisodeCache(context);
			expect(result).toMatchObject({ complete: false, errors: 0 });
		}
		const completed = await refreshOwnedJellyfinEpisodeCache(context);
		expect(completed).toMatchObject({ complete: true, errors: 0 });
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(10);
		expect(client.getEpisodeItemsPageWithCoverage.mock.calls.map((call) => call[2])).toEqual([
			0, 1_000, 2_000, 3_000, 4_000, 0, 1_000, 2_000, 3_000, 4_000,
		]);
		expect((client as { getEpisodes?: unknown }).getEpisodes).toBeUndefined();
	});

	it("retains staged work and settles the outer attempt while a failed page backs off", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		client.getEpisodeItemsPageWithCoverage.mockRejectedValueOnce(new Error("unavailable"));
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		const result = await refreshOwnedJellyfinEpisodeCache(context);
		expect(result).toMatchObject({ complete: false, errors: 1 });
		expect(durable.failUnit).toHaveBeenCalledOnce();
		expect(durable.invalidate).not.toHaveBeenCalled();
		expect(durable.recordedFailureCount).toBe(1);
	});

	it.each([false, true])(
		"terminalizes the fourth consecutive page failure and admits only a V3 deadline: %s",
		async (v3) => {
			const state = ownedFixture("JELLYFIN", { v3 });
			const client = configureDurableRun(state);
			client.getEpisodeItemsPageWithCoverage.mockRejectedValue(new Error("unavailable"));
			const deadline = new Date(Date.now() + 30 * 60_000);
			durable.deadline.mockResolvedValue(v3 ? deadline : null);
			const context = {
				prisma: state.prisma,
				encryptor: { decrypt: vi.fn() },
				instance: state.instance,
				log,
			};
			durable.failUnit.mockImplementation(async (_prisma, input) => {
				const unit = durable.units.find((candidate) => candidate.id === input.claim.unitId);
				if (!unit || !durable.run) return false;
				unit.state = "failed";
				unit.claimToken = null;
				const attemptCount = Number(unit.attemptCount ?? 0) + 1;
				unit.attemptCount = attemptCount;
				unit.nextAttemptAt = attemptCount > 3 ? null : new Date("2026-09-08T00:00:00.000Z");
				durable.run.state = "failed";
				durable.run.nextAttemptAt = unit.nextAttemptAt;
				durable.run.lastReasonCode = input.reasonCode;
				return true;
			});
			durable.claimUnit.mockImplementation(async () => {
				const unit = durable.units.find((candidate) =>
					["pending", "failed"].includes(String(candidate.state)),
				);
				if (!unit || !durable.run) return null;
				unit.state = "running";
				unit.claimToken = `claim-${unit.id}`;
				return {
					runId: "run-1",
					unitId: unit.id,
					claimToken: unit.claimToken,
					authorityKey: "authority",
					phase: unit.phase,
					scopeKey: unit.scopeKey,
					scopePayload: unit.scopePayload,
					cursor: unit.cursor,
					expectedRawCount: unit.expectedRawCount,
					observedRawCount: unit.observedRawCount,
				};
			});
			durable.exhausted.mockImplementation(async () => {
				const failedUnit = durable.units.find((unit) => unit.state === "failed");
				return Number(failedUnit?.attemptCount ?? 0) > 3 && failedUnit?.nextAttemptAt === null;
			});

			for (let failure = 0; failure < 4; failure += 1) {
				const result = await refreshOwnedJellyfinEpisodeCache(context);
				expect(result).toMatchObject({ complete: false, errors: 1 });
				expect(result.renewalDeadline).toEqual(failure === 3 && v3 ? deadline : undefined);
				durable.outer = {
					status: "already-running",
					attempt: {
						attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
						resultMarker: "in_progress:test",
					},
				};
			}

			expect(durable.failUnit).toHaveBeenCalledTimes(4);
			expect(durable.recordedFailureCount).toBe(1);
			expect(durable.invalidate).not.toHaveBeenCalled();
			expect(durable.run).toMatchObject({ state: "failed", nextAttemptAt: null });
		},
	);

	it("guards resumed page collection before any new provider data read", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};
		await refreshOwnedJellyfinEpisodeCache(context);
		durable.outer = {
			status: "already-running",
			attempt: {
				attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
				resultMarker: "in_progress:test",
			},
		};
		client.getUsers.mockClear();
		client.getLibraries.mockClear();
		client.getEpisodeItemsPageWithCoverage.mockClear();
		durable.stage.mockClear();
		durable.finalize.mockClear();
		durable.invalidate.mockClear();
		durable.collectionGuard.mockRejectedValueOnce(
			new ProviderIdentityGuardError(
				"IDENTITY_MISMATCH",
				"Provider identity changed; cache publication was not attempted.",
			),
		);

		const result = await refreshOwnedJellyfinEpisodeCache(context);

		expect(result).toMatchObject({ complete: false, errors: 1, upserted: 0 });
		expect(client.getUsers).not.toHaveBeenCalled();
		expect(client.getLibraries).not.toHaveBeenCalled();
		expect(client.getEpisodeItemsPageWithCoverage).not.toHaveBeenCalled();
		expect(durable.stage).not.toHaveBeenCalled();
		expect(durable.finalize).not.toHaveBeenCalled();
		expect(durable.invalidate).toHaveBeenCalledWith(state.prisma, "run-1", expect.any(Date));
	});

	it("retains failed-run staged evidence when resumed scope identity is temporarily unavailable", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};
		await refreshOwnedJellyfinEpisodeCache(context);
		durable.run!.state = "failed";
		durable.outer = {
			status: "already-running",
			attempt: {
				attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
				resultMarker: "in_progress:test",
			},
		};
		durable.collectionGuard.mockRejectedValueOnce(
			new ProviderIdentityGuardError(
				"IDENTITY_UNAVAILABLE",
				"Provider identity could not be read; cache publication was not attempted.",
			),
		);

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 1,
			upserted: 0,
		});
		expect(durable.run).toMatchObject({ id: "run-1", state: "failed", completedUnits: 1 });
		expect(durable.invalidate).not.toHaveBeenCalled();
		expect(durable.finishFailure).not.toHaveBeenCalled();

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 0,
		});
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(2);
	});

	it("invalidates staged evidence when identity changes between scope discovery and a page read", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		durable.collectionGuard
			.mockImplementationOnce(async (_prisma, _snapshot, _log, collect) => await collect())
			.mockRejectedValueOnce(
				new ProviderIdentityGuardError(
					"IDENTITY_MISMATCH",
					"Provider identity changed; cache publication was not attempted.",
				),
			);

		const result = await refreshOwnedJellyfinEpisodeCache({
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		});

		expect(result).toMatchObject({ complete: false, errors: 1, upserted: 0 });
		expect(client.getUsers).toHaveBeenCalledOnce();
		expect(client.getLibraries).toHaveBeenCalledOnce();
		expect(client.getEpisodeItemsPageWithCoverage).not.toHaveBeenCalled();
		expect(durable.stage).not.toHaveBeenCalled();
		expect(durable.failUnit).not.toHaveBeenCalled();
		expect(durable.invalidate).toHaveBeenCalledWith(state.prisma, "run-1", expect.any(Date));
	});

	it("invalidates staged evidence when live identity changes immediately before final publication", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state, 0);
		durable.guard.mockRejectedValueOnce(
			new ProviderIdentityGuardError(
				"IDENTITY_MISMATCH",
				"Provider identity changed; cache publication was not attempted.",
			),
		);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await refreshOwnedJellyfinEpisodeCache(context);
		await refreshOwnedJellyfinEpisodeCache(context);
		const result = await refreshOwnedJellyfinEpisodeCache(context);

		expect(result).toMatchObject({ complete: false, errors: 1, upserted: 0 });
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(2);
		expect(durable.finalize).not.toHaveBeenCalled();
		expect(durable.invalidate).toHaveBeenCalledWith(state.prisma, "run-1", expect.any(Date));
	});

	it("retains a fully staged run when final identity proof is temporarily unavailable", async () => {
		const state = ownedFixture("JELLYFIN");
		configureDurableRun(state, 0);
		durable.guard.mockRejectedValueOnce(
			new ProviderIdentityGuardError(
				"IDENTITY_UNAVAILABLE",
				"Provider identity could not be read; cache publication was not attempted.",
			),
		);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};

		await refreshOwnedJellyfinEpisodeCache(context);
		await refreshOwnedJellyfinEpisodeCache(context);
		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 1,
			upserted: 0,
		});
		expect(durable.run).toMatchObject({ state: "running", completedUnits: 2, totalUnits: 2 });
		expect(durable.finalize).not.toHaveBeenCalled();
		expect(durable.invalidate).not.toHaveBeenCalled();
		expect(durable.finishFailure).not.toHaveBeenCalled();

		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: true,
			errors: 0,
			upserted: 0,
		});
		expect(durable.finalize).toHaveBeenCalledOnce();
	});

	it("reports the finalizer's committed item count and preserves a genuine zero", async () => {
		const populated = ownedFixture("JELLYFIN");
		configureDurableRun(populated);
		durable.finalize.mockImplementation(async () => {
			if (durable.run) durable.run.state = "complete";
			return { published: true, itemCount: 37 };
		});
		const populatedContext = {
			prisma: populated.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: populated.instance,
			log,
		};
		await refreshOwnedJellyfinEpisodeCache(populatedContext);
		await refreshOwnedJellyfinEpisodeCache(populatedContext);
		await expect(refreshOwnedJellyfinEpisodeCache(populatedContext)).resolves.toMatchObject({
			complete: true,
			upserted: 37,
		});

		const empty = ownedFixture("JELLYFIN");
		configureDurableRun(empty, 0);
		const emptyContext = {
			prisma: empty.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: empty.instance,
			log,
		};
		await refreshOwnedJellyfinEpisodeCache(emptyContext);
		await refreshOwnedJellyfinEpisodeCache(emptyContext);
		await expect(refreshOwnedJellyfinEpisodeCache(emptyContext)).resolves.toMatchObject({
			complete: true,
			upserted: 0,
		});
	});

	it("invalidates and releases the durable run when final publication loses its exact CAS", async () => {
		const state = ownedFixture("JELLYFIN");
		const client = configureDurableRun(state);
		const context = {
			prisma: state.prisma,
			encryptor: { decrypt: vi.fn() },
			instance: state.instance,
			log,
		};
		durable.finalize.mockRejectedValueOnce(new Error("publication superseded"));

		await refreshOwnedJellyfinEpisodeCache(context);
		await refreshOwnedJellyfinEpisodeCache(context);
		await expect(refreshOwnedJellyfinEpisodeCache(context)).resolves.toMatchObject({
			complete: false,
			errors: 1,
		});

		expect(durable.invalidate).toHaveBeenCalledWith(state.prisma, "run-1", expect.any(Date));
		expect(durable.finishFailure).toHaveBeenCalledOnce();
		expect(client.getEpisodeItemsPageWithCoverage).toHaveBeenCalledTimes(2);
	});
});

describe("scope discovery diagnostic privacy", () => {
	it.each([
		[
			Object.assign(new Error("private provider response"), { name: "TimeoutError" }),
			"scope-discovery-timeout",
		],
		[
			new Error("Jellyfin library inventory was not returned completely"),
			"scope-inventory-incomplete",
		],
		[new Error("Jellyfin API returned invalid JSON"), "scope-response-schema"],
		[new Error("Jellyfin API returned an unexpected response type"), "scope-response-schema"],
		[new Error("private provider address and account data"), "scope-discovery-failed"],
		[{ name: "TimeoutError", message: "private untrusted value" }, "scope-discovery-failed"],
	])("logs only a closed discovery category", (error, expected) => {
		const warn = vi.fn();
		logJellyfinEpisodePrePageFailure({ warn } as never, classifyJellyfinEpisodeScopeFailure(error));
		expect(warn).toHaveBeenCalledWith(
			{ category: expected },
			"Jellyfin episode refresh pre-page dependency unavailable",
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
	});
});
