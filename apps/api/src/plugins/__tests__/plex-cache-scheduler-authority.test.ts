import Fastify, { type FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	refreshLibrary: vi.fn(),
	refreshEpisodes: vi.fn(),
	loadGenerationObservationsForOwnedInstances: vi.fn(),
	getPublishedEpisodeGenerationObservation: vi.fn(),
	claim: vi.fn(),
	order: vi.fn(),
	reconcile: vi.fn(),
}));

vi.mock("../../lib/plex/plex-refresh-orchestration.js", () => ({
	refreshOwnedPlexCacheWithAttempt: mocks.refreshLibrary,
	refreshOwnedPlexEpisodeCache: mocks.refreshEpisodes,
}));
vi.mock("../../lib/services/provider-cache-status.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/services/provider-cache-status.js")>()),
	claimProviderCacheRefreshAttempt: mocks.claim,
	getProviderCacheRefreshClaimOrder: mocks.order,
	reconcileSettledProviderCacheRefreshAttempt: mocks.reconcile,
}));
vi.mock("../../lib/plex/plex-evidence-repository.js", () => ({
	loadGenerationObservationsForOwnedInstances: mocks.loadGenerationObservationsForOwnedInstances,
	getPublishedEpisodeGenerationObservation: mocks.getPublishedEpisodeGenerationObservation,
}));

import type {
	LibraryRefreshRecoveryRequest,
	FastifyWithLibraryRefreshRecovery,
} from "../../lib/services/library-refresh-recovery.js";
import { createProviderPublicationAuthority } from "../../lib/services/provider-identity-guard.js";
import plexCacheSchedulerPlugin from "../plex-cache-scheduler.js";
import plexEpisodeCacheSchedulerPlugin from "../plex-episode-cache-scheduler.js";

let fixtureOrder = 0n;
let fixtureOrders = new WeakMap<object, { order: bigint; cacheType: string; authority: string }>();
// Explicit claim-boundary double; unknown objects remain unregistered.
function trackRequest<T extends LibraryRefreshRecoveryRequest>(request: T): T {
	if (!fixtureOrders.has(request.attempt))
		fixtureOrders.set(request.attempt, {
			order: ++fixtureOrder,
			cacheType: request.provider,
			authority: JSON.stringify(request.authority),
		});
	return request;
}
function resetClaimOrder() {
	fixtureOrder = 0n;
	fixtureOrders = new WeakMap();
	mocks.order.mockReset().mockImplementation((attempt, cacheType, authority) => {
		const record = fixtureOrders.get(attempt);
		return record &&
			record.cacheType === cacheType &&
			record.authority === JSON.stringify(authority)
			? record.order
			: undefined;
	});
	mocks.claim.mockReset().mockImplementation(async (_prisma, cacheType, authority) => {
		const attempt = { attemptedAt: new Date(), resultMarker: `in_progress:${crypto.randomUUID()}` };
		fixtureOrders.set(attempt, {
			order: ++fixtureOrder,
			cacheType,
			authority: JSON.stringify(authority),
		});
		return { status: "acquired", attempt };
	});
}

describe("Plex scheduler publication authority", () => {
	let app: FastifyInstance;
	let logSpies: Array<ReturnType<typeof vi.spyOn>>;
	const instance = {
		id: "plex-1",
		userId: "user-1",
		service: "PLEX",
		label: "Plex",
		connectionGeneration: 4,
		identityGeneration: 9,
		baseUrl: "https://plex.invalid",
		enabled: true,
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		expectedIdentity: "plex-machine",
		identityStatus: "VERIFIED",
	};

	beforeEach(async () => {
		vi.useFakeTimers();
		resetClaimOrder();
		mocks.reconcile.mockReset().mockResolvedValue("ready");
		mocks.refreshLibrary.mockReset().mockResolvedValue({
			complete: true,
			completedAt: new Date(),
			upserted: 1,
			errors: 0,
			errorMessages: [],
		});
		mocks.refreshEpisodes.mockReset().mockResolvedValue({
			complete: true,
			completedAt: new Date(),
			upserted: 1,
			errors: 0,
			errorMessages: [],
			eligibleShows: 1,
			refreshedShows: 1,
			coverageIncomplete: false,
			capacityDegraded: false,
		});
		mocks.loadGenerationObservationsForOwnedInstances.mockReset().mockResolvedValue([
			{
				available: true,
				evidence: {
					publicationLevel: "authoritative",
					completeness: "complete",
					reasonCodes: [],
				},
				providerStatus: {
					availability: "current",
					evidence: "complete",
					observedAt: new Date().toISOString(),
					ageSeconds: 0,
					latestAttempt: "successful",
					reasonCodes: [],
				},
			},
		]);
		mocks.getPublishedEpisodeGenerationObservation.mockReset().mockResolvedValue({
			available: true,
			evidence: {
				publicationLevel: "authoritative",
				completeness: "complete",
				reasonCodes: [],
			},
		});

		app = Fastify({ logger: false });
		await app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("prisma", {
						serviceInstance: {
							findMany: vi.fn().mockResolvedValue([instance]),
							findFirst: vi.fn().mockResolvedValue(instance),
						},
						cacheRefreshStatus: { findMany: vi.fn().mockResolvedValue([]) },
					} as never);
				},
				{ name: "prisma" },
			),
		);
		await app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("encryptor", { decrypt: vi.fn() } as never);
				},
				{ name: "security" },
			),
		);
		await app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("notificationService", {
						runProducer: <T>(operation: () => Promise<T>) => operation(),
						notify: vi.fn().mockResolvedValue({}),
					} as never);
				},
				{ name: "notification-service" },
			),
		);
		await app.register(
			fastifyPlugin(
				async (server) => {
					server.decorate("schedulerRegistry", {
						track: vi.fn(async (_jobId, callback: () => Promise<unknown>) => await callback()),
					} as never);
				},
				{ name: "scheduler-registry" },
			),
		);
		await app.register(plexCacheSchedulerPlugin);
		await app.register(plexEpisodeCacheSchedulerPlugin);
		await app.ready();
		logSpies = ["debug", "info", "warn", "error"].map((level) =>
			vi.spyOn(app.log, level as "debug").mockImplementation(() => undefined),
		);
	});

	afterEach(async () => {
		await app.close();
		vi.useRealTimers();
	});

	function receipt(overrides: Record<string, unknown> = {}) {
		return {
			version: 1,
			provider: "plex",
			attemptStartedAt: "2026-09-02T00:00:00.000Z",
			observedAt: "2026-09-02T00:00:01.000Z",
			evidence: "complete",
			units: [
				{
					scopeKey: "section:private-section",
					expectedRawCount: 2,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: 2,
					sourceBindings: 2,
					canonicalEntities: 1,
					acceptedSkips: [],
					fatalCount: 0,
				},
			],
			...overrides,
		};
	}

	function telemetryEntries() {
		return logSpies
			.flatMap((spy) => spy.mock.calls)
			.filter((args) => args.some((arg: unknown) => arg === "Provider observation completed"))
			.map((args) => args[0] as Record<string, unknown>);
	}

	function expectSanitizedTelemetry(entry: Record<string, unknown>) {
		const allowedKeys = new Set([
			"provider",
			"outcome",
			"availability",
			"reason",
			"durationMs",
			"rawObserved",
			"sourceBindings",
			"canonicalEntities",
			"acceptedSkips",
			"fatalCount",
			"pagesAttempted",
			"pagesCompleted",
		]);
		const forbiddenKeys = new Set([
			"instanceId",
			"instanceLabel",
			"label",
			"name",
			"url",
			"errorMessages",
			"snapshot",
			"targets",
			"settlement",
			"receipt",
		]);
		expect(Object.keys(entry).every((key) => allowedKeys.has(key))).toBe(true);
		expect(Object.keys(entry).some((key) => forbiddenKeys.has(key))).toBe(false);
		expect(JSON.stringify(entry)).not.toContain("PRIVATE_PLEX_MARKER");
	}

	it("uses the pre-decryption boundary for startup and recurring publication paths", async () => {
		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(mocks.refreshLibrary).toHaveBeenCalledWith(
			{
				prisma: app.prisma,
				encryptor: app.encryptor,
				instance,
				log: app.log,
				signal: expect.any(AbortSignal),
			},
			expect.objectContaining({ resultMarker: expect.stringMatching(/^in_progress:/) }),
		);
		expect(mocks.refreshEpisodes).toHaveBeenCalledWith(
			{
				prisma: app.prisma,
				signal: expect.any(AbortSignal),
				encryptor: app.encryptor,
				instance,
				log: app.log,
				resumeFailed: true,
				diagnostics: { stage: "not-started" },
			},
			undefined,
		);

		await vi.advanceTimersByTimeAsync(385 * 60_000);

		expect(mocks.refreshLibrary).toHaveBeenCalledTimes(2);
		expect(mocks.refreshEpisodes).toHaveBeenCalledTimes(2);
	});

	it("does not record superseded library or episode refreshes as failures", async () => {
		mocks.refreshLibrary.mockResolvedValue({
			complete: false,
			upserted: 0,
			errors: 0,
			errorMessages: [],
			superseded: true,
		});
		mocks.refreshEpisodes.mockResolvedValue({
			complete: false,
			upserted: 0,
			errors: 0,
			errorMessages: [],
			eligibleShows: 0,
			refreshedShows: 0,
			coverageIncomplete: true,
			capacityDegraded: false,
			superseded: true,
		});

		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(mocks.refreshLibrary).toHaveBeenCalledTimes(1);
		expect(mocks.refreshEpisodes).toHaveBeenCalledTimes(1);
	});

	it("excludes disabled instances from both stale-status scans", async () => {
		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(app.prisma.cacheRefreshStatus.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { cacheType: "plex", instance: { enabled: true } },
			}),
		);
		expect(app.prisma.cacheRefreshStatus.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { cacheType: "plex_episode", instance: { enabled: true } },
			}),
		);
	});

	it("retries a failed parent refresh before the six-hour regular interval", async () => {
		mocks.refreshLibrary.mockResolvedValueOnce({
			complete: false,
			upserted: 0,
			errors: 1,
			errorMessages: ["Plex refresh preparation failed before publication"],
		});
		mocks.refreshEpisodes.mockResolvedValueOnce({
			complete: false,
			upserted: 0,
			errors: 1,
			errorMessages: ["Plex refresh preparation failed before publication"],
			eligibleShows: 0,
			refreshedShows: 0,
			coverageIncomplete: true,
			capacityDegraded: false,
		});

		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(mocks.refreshLibrary).toHaveBeenCalledTimes(2);
		expect(mocks.refreshEpisodes).toHaveBeenCalledOnce();
	});

	it("retries native inventory failure even when canonical evidence published", async () => {
		mocks.refreshLibrary.mockResolvedValueOnce({
			complete: true,
			upserted: 1,
			errors: 0,
			nativeInventoryStatus: "failed",
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(mocks.refreshLibrary).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(20 * 60_000);
		expect(mocks.refreshLibrary).toHaveBeenCalledTimes(2);
	});

	it("arms the existing 30-second queue for a manual native-only failure", async () => {
		await vi.advanceTimersByTimeAsync(30_000);
		mocks.refreshLibrary.mockClear();
		const recovery = (app as FastifyWithLibraryRefreshRecovery).libraryRefreshRecovery;
		const request = {
			provider: "plex" as const,
			userId: "user-1",
			instanceId: instance.id,
			authority: createProviderPublicationAuthority(instance as never),
			attempt: {
				attemptedAt: new Date("2026-09-14T12:00:00.000Z"),
				resultMarker: "in_progress:00000000-0000-4000-8000-000000000001",
			},
		};
		recovery.admit(trackRequest(request));
		expect(await recovery.arm(request)).toEqual({ status: "accepted" });
		await vi.advanceTimersByTimeAsync(29_999);
		expect(mocks.refreshLibrary).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(mocks.refreshLibrary).toHaveBeenCalledOnce();
	});

	it("drops a manually armed retry when the owner is replaced before execution", async () => {
		await vi.advanceTimersByTimeAsync(30_000);
		mocks.refreshLibrary.mockClear();
		const findFirst = app.prisma.serviceInstance.findFirst as ReturnType<typeof vi.fn>;
		const recovery = (app as FastifyWithLibraryRefreshRecovery).libraryRefreshRecovery;
		const request = {
			provider: "plex" as const,
			userId: "user-1",
			instanceId: instance.id,
			authority: createProviderPublicationAuthority(instance as never),
			attempt: {
				attemptedAt: new Date("2026-09-14T12:00:00.000Z"),
				resultMarker: "in_progress:00000000-0000-4000-8000-000000000002",
			},
		};
		recovery.admit(trackRequest(request));
		findFirst.mockResolvedValue(instance);
		expect(await recovery.arm(request)).toEqual({ status: "accepted" });
		findFirst.mockResolvedValueOnce(null);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refreshLibrary).not.toHaveBeenCalled();
	});

	it("queues without admission reads, preserves the origin through database failure and retries each new failed claim once per rung", async () => {
		await vi.advanceTimersByTimeAsync(30_000);
		mocks.refreshLibrary.mockClear();
		const bridge = (app as FastifyWithLibraryRefreshRecovery).libraryRefreshRecovery;
		const request = {
			provider: "plex" as const,
			userId: instance.userId,
			instanceId: instance.id,
			authority: createProviderPublicationAuthority(instance as never),
			attempt: {
				attemptedAt: new Date(),
				resultMarker: "in_progress:00000000-0000-4000-8000-000000000001",
			},
		};
		const lookup = app.prisma.serviceInstance.findFirst as ReturnType<typeof vi.fn>;
		lookup
			.mockClear()
			.mockRejectedValueOnce(new Error("database unavailable"))
			.mockResolvedValue(instance);
		bridge.admit(trackRequest(request));
		expect(await Promise.all([bridge.arm(request), bridge.arm(request)])).toEqual([
			{ status: "accepted" },
			{ status: "accepted" },
		]);
		expect(lookup).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refreshLibrary).not.toHaveBeenCalled();
		mocks.refreshLibrary
			.mockResolvedValueOnce({ complete: false, errors: 1 })
			.mockResolvedValueOnce({ complete: true, errors: 0 });
		await vi.advanceTimersByTimeAsync(120_000);
		expect(mocks.refreshLibrary).toHaveBeenCalledOnce();
		expect(mocks.reconcile.mock.calls[0]?.[3]).toEqual(request.attempt);
		const fresh = mocks.refreshLibrary.mock.calls[0]?.[1];
		expect(fresh.resultMarker).not.toBe(request.attempt.resultMarker);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.refreshLibrary).toHaveBeenCalledTimes(2);
		expect(mocks.reconcile.mock.calls[1]?.[3]).toEqual(fresh);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.refreshLibrary).toHaveBeenCalledTimes(2);
	});

	it("retains an exhausted settled owner for the ordinary cadence without adding retry timers", async () => {
		await vi.advanceTimersByTimeAsync(30_000);
		mocks.refreshLibrary.mockClear();
		mocks.reconcile.mockResolvedValue("unavailable");
		const bridge = (app as FastifyWithLibraryRefreshRecovery).libraryRefreshRecovery;
		const request = {
			provider: "plex" as const,
			userId: instance.userId,
			instanceId: instance.id,
			authority: createProviderPublicationAuthority(instance as never),
			attempt: {
				attemptedAt: new Date(),
				resultMarker: "in_progress:00000000-0000-4000-8000-000000000001",
			},
		};
		bridge.admit(trackRequest(request));
		await bridge.arm(request);
		await vi.advanceTimersByTimeAsync(30_000 + 120_000 + 600_000 + 600_000);
		expect(mocks.reconcile).toHaveBeenCalledTimes(3);
		expect(mocks.refreshLibrary).not.toHaveBeenCalled();
		mocks.reconcile.mockResolvedValue("ready");
		await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
		expect(mocks.reconcile).toHaveBeenCalledTimes(4);
		expect(mocks.reconcile.mock.calls[3]?.[3]).toBe(request.attempt);
		expect(mocks.refreshLibrary).toHaveBeenCalledOnce();
	});

	it("bounds parent refresh retries and cancels them after close", async () => {
		mocks.refreshLibrary.mockResolvedValue({ complete: false, upserted: 0, errors: 1 });
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.refreshLibrary).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(29_999);
		expect(mocks.refreshLibrary).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(mocks.refreshLibrary).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(mocks.refreshLibrary).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.refreshLibrary).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(mocks.refreshLibrary).toHaveBeenCalledTimes(4);
		await app.close();
		await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
		expect(mocks.refreshLibrary).toHaveBeenCalledTimes(4);
	});

	it.each(["superseded", "non-acquired", "complete", "failed"] as const)(
		"FAR-SAF-001 preserves settled B when older A finishes %s",
		async (exit) => {
			await vi.advanceTimersByTimeAsync(30_000);
			mocks.refreshLibrary.mockClear();
			const bridge = (app as FastifyWithLibraryRefreshRecovery).libraryRefreshRecovery;
			const request = (nonce: string) => ({
				provider: "plex" as const,
				userId: instance.userId,
				instanceId: instance.id,
				authority: createProviderPublicationAuthority(instance as never),
				attempt: {
					attemptedAt: new Date(),
					resultMarker: `in_progress:00000000-0000-4000-8000-${nonce}`,
				},
			});
			const a = request("000000000001"),
				b = request("000000000002");
			let finish!: (result: unknown) => void;
			const blocked = new Promise((resolve) => {
				finish = resolve;
			});
			if (exit === "superseded") mocks.reconcile.mockImplementationOnce(() => blocked);
			else if (exit === "non-acquired") mocks.claim.mockImplementationOnce(() => blocked);
			else mocks.refreshLibrary.mockImplementationOnce(() => blocked);
			bridge.admit(trackRequest(a));
			await bridge.arm(a);
			await vi.advanceTimersByTimeAsync(30_000);
			bridge.admit(trackRequest(b));
			expect(await bridge.arm(b)).toEqual({ status: "accepted" });
			finish(
				exit === "superseded"
					? "superseded"
					: exit === "non-acquired"
						? { status: "superseded" }
						: { complete: exit === "complete", errors: exit === "failed" ? 1 : 0 },
			);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(
				mocks.reconcile.mock.calls.some((call) => call[3].resultMarker === b.attempt.resultMarker),
			).toBe(true);
			expect(mocks.refreshLibrary).toHaveBeenCalledTimes(
				exit === "complete" || exit === "failed" ? 2 : 1,
			);
		},
	);

	it("FAR-REG-001 gives new external B a finite ladder after exhausted A without resetting duplicate budgets", async () => {
		await vi.advanceTimersByTimeAsync(30_000);
		mocks.refreshLibrary.mockClear();
		const bridge = (app as FastifyWithLibraryRefreshRecovery).libraryRefreshRecovery;
		const request = (nonce: string) => ({
			provider: "plex" as const,
			userId: instance.userId,
			instanceId: instance.id,
			authority: createProviderPublicationAuthority(instance as never),
			attempt: {
				attemptedAt: new Date(),
				resultMarker: `in_progress:00000000-0000-4000-8000-${nonce}`,
			},
		});
		const a = request("000000000001"),
			b = request("000000000002");
		mocks.reconcile.mockResolvedValue("unavailable");
		bridge.admit(trackRequest(a));
		await bridge.arm(a);
		await vi.advanceTimersByTimeAsync(30_000 + 120_000 + 600_000);
		await bridge.arm(a);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.reconcile).toHaveBeenCalledTimes(3);
		bridge.admit(trackRequest(b));
		await Promise.all([bridge.arm(b), bridge.arm(b)]);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.reconcile).toHaveBeenCalledTimes(4);
		expect(mocks.reconcile.mock.calls[3]?.[3]).toBe(b.attempt);
		await bridge.arm(b);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.reconcile).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(90_000 + 600_000 + 600_000);
		expect(mocks.reconcile).toHaveBeenCalledTimes(6);
	});

	it("does not retry a successfully published positive-only parent", async () => {
		mocks.refreshLibrary.mockResolvedValue({
			complete: false,
			upserted: 1,
			errors: 0,
			receipt: receipt({ evidence: "positive-only" }),
		});
		await vi.advanceTimersByTimeAsync(20 * 60_000);
		expect(mocks.refreshLibrary).toHaveBeenCalledOnce();
	});

	it("rechecks enabled instances before retrying a failed parent", async () => {
		mocks.refreshLibrary.mockResolvedValue({ complete: false, upserted: 0, errors: 1 });
		await vi.advanceTimersByTimeAsync(30_000);
		(app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
		await vi.advanceTimersByTimeAsync(20 * 60_000);
		expect(mocks.refreshLibrary).toHaveBeenCalledOnce();
		expect(app.prisma.serviceInstance.findMany).toHaveBeenCalledWith({
			where: { service: "PLEX", enabled: true, id: { in: ["plex-1"] } },
		});
	});

	it("does not rearm retries when an in-flight refresh fails after shutdown", async () => {
		let finish!: (result: unknown) => void;
		mocks.refreshLibrary.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		await vi.advanceTimersByTimeAsync(30_000);
		let closeSettled = false;
		const closing = app.close().then(() => {
			closeSettled = true;
		});
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(closeSettled).toBe(false);
		} finally {
			finish({ complete: false, upserted: 0, errors: 1 });
			await closing;
		}
		await vi.advanceTimersByTimeAsync(20 * 60_000);
		expect(mocks.refreshLibrary).toHaveBeenCalledOnce();
	});

	it("emits only validated receipt aggregates and persisted provider availability", async () => {
		mocks.refreshLibrary.mockResolvedValueOnce({
			complete: true,
			upserted: 1,
			errors: 0,
			errorMessages: ["PRIVATE_PLEX_MARKER"],
			receipt: receipt(),
			snapshot: { title: "PRIVATE_PLEX_MARKER" },
			instanceId: "PRIVATE_PLEX_MARKER",
			label: "PRIVATE_PLEX_MARKER",
		});

		await vi.advanceTimersByTimeAsync(5 * 60_000);

		const entries = telemetryEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			provider: "plex",
			outcome: "complete",
			availability: "current",
			reason: "none",
			rawObserved: 2,
			sourceBindings: 2,
			canonicalEntities: 1,
			acceptedSkips: 0,
			fatalCount: 0,
			pagesAttempted: 1,
			pagesCompleted: 1,
		});
		expectSanitizedTelemetry(entries[0]!);
	});

	it("preserves partial availability for a valid positive-only receipt", async () => {
		mocks.refreshLibrary.mockResolvedValueOnce({
			complete: false,
			upserted: 1,
			errors: 0,
			receipt: receipt({ evidence: "positive-only" }),
		});
		mocks.loadGenerationObservationsForOwnedInstances.mockResolvedValueOnce([
			{
				available: true,
				evidence: { publicationLevel: "positive-only", completeness: "partial", reasonCodes: [] },
				providerStatus: {
					availability: "partial",
					evidence: "positive-only",
					observedAt: "2026-09-02T00:00:00.000Z",
					ageSeconds: 1,
					latestAttempt: "successful",
					reasonCodes: ["positive-only"],
				},
			},
		]);

		await vi.advanceTimersByTimeAsync(5 * 60_000);

		const entries = telemetryEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			provider: "plex",
			outcome: "partial",
			availability: "partial",
			reason: "positive-only",
			rawObserved: 2,
			sourceBindings: 2,
			canonicalEntities: 1,
			acceptedSkips: 0,
			fatalCount: 0,
			pagesAttempted: 1,
			pagesCompleted: 1,
		});
		expectSanitizedTelemetry(entries[0]!);
	});

	it.each([
		["missing receipt", undefined],
		["invalid receipt", { provider: "plex", units: [{ scopeKey: "PRIVATE_PLEX_MARKER" }] }],
	])("omits receipt counters when the %s cannot be validated", async (_name, invalidReceipt) => {
		mocks.refreshLibrary.mockResolvedValueOnce({
			complete: true,
			upserted: 1,
			errors: 0,
			errorMessages: ["PRIVATE_PLEX_MARKER"],
			receipt: invalidReceipt,
		});
		mocks.loadGenerationObservationsForOwnedInstances.mockResolvedValueOnce([
			{
				available: true,
				evidence: { publicationLevel: "authoritative", completeness: "complete", reasonCodes: [] },
				providerStatus: {
					availability: "last-known",
					evidence: "complete",
					observedAt: "2026-09-02T00:00:00.000Z",
					ageSeconds: 1,
					latestAttempt: "successful",
					reasonCodes: [],
				},
			},
		]);

		await vi.advanceTimersByTimeAsync(5 * 60_000);

		const [entry] = telemetryEntries();
		expect(entry).toMatchObject({
			provider: "plex",
			outcome: "failed",
			availability: "last-known",
			reason: "receipt-invalid",
		});
		expect(entry).not.toHaveProperty("rawObserved");
		expect(entry).not.toHaveProperty("sourceBindings");
		expect(entry).not.toHaveProperty("canonicalEntities");
		expectSanitizedTelemetry(entry!);
	});

	it("logs generic stale state and notifications without instance names", async () => {
		const staleInstance = { ...instance, label: "PRIVATE_PLEX_MARKER" };
		(app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			staleInstance,
		]);
		(app.prisma.cacheRefreshStatus.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			{
				lastRefreshedAt: new Date("2026-09-01T00:00:00.000Z"),
				instance: staleInstance,
			},
		]);
		mocks.loadGenerationObservationsForOwnedInstances.mockResolvedValue([
			{
				available: false,
				providerStatus: {
					availability: "unavailable",
					evidence: "unknown",
					observedAt: null,
					ageSeconds: null,
					latestAttempt: "idle",
					reasonCodes: ["no-publication"],
				},
				evidence: {
					publicationLevel: "unavailable",
					completeness: "unknown",
					reasonCodes: [],
				},
			},
		]);

		await vi.advanceTimersByTimeAsync(5 * 60_000);

		const serializedLogs = JSON.stringify(logSpies.flatMap((spy) => spy.mock.calls));
		expect(serializedLogs).not.toContain("PRIVATE_PLEX_MARKER");
		const notify = app.notificationService.notify as unknown as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Plex provider observation is stale",
				body: expect.stringContaining("1"),
			}),
		);
		expect(JSON.stringify(notify.mock.calls)).not.toContain("PRIVATE_PLEX_MARKER");
	});

	it("continues refreshing later instances after a failed attempt", async () => {
		const instances = [instance, { ...instance, id: "plex-2", label: "PRIVATE_PLEX_MARKER" }];
		(app.prisma.serviceInstance.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			instances,
		);
		mocks.refreshLibrary
			.mockRejectedValueOnce(new Error("PRIVATE_PLEX_MARKER"))
			.mockResolvedValueOnce({ complete: true, receipt: receipt(), upserted: 1, errors: 0 });

		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(mocks.refreshLibrary).toHaveBeenCalledTimes(3);
		expect(mocks.refreshLibrary.mock.calls.map(([input]) => input.instance.id)).toEqual([
			"plex-1",
			"plex-2",
			"plex-1",
		]);
		const serializedLogs = JSON.stringify(logSpies.flatMap((spy) => spy.mock.calls));
		expect(serializedLogs).not.toContain("PRIVATE_PLEX_MARKER");
	});
});
