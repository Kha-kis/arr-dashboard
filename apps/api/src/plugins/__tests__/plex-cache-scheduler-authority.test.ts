import Fastify, { type FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	refreshLibrary: vi.fn(),
	refreshEpisodes: vi.fn(),
	loadGenerationObservationsForOwnedInstances: vi.fn(),
	getPublishedEpisodeGenerationObservation: vi.fn(),
}));

vi.mock("../../lib/plex/plex-refresh-orchestration.js", () => ({
	refreshOwnedPlexCache: mocks.refreshLibrary,
	refreshOwnedPlexEpisodeCache: mocks.refreshEpisodes,
}));
vi.mock("../../lib/plex/plex-evidence-repository.js", () => ({
	loadGenerationObservationsForOwnedInstances: mocks.loadGenerationObservationsForOwnedInstances,
	getPublishedEpisodeGenerationObservation: mocks.getPublishedEpisodeGenerationObservation,
}));

import plexCacheSchedulerPlugin from "../plex-cache-scheduler.js";
import plexEpisodeCacheSchedulerPlugin from "../plex-episode-cache-scheduler.js";

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
	};

	beforeEach(async () => {
		vi.useFakeTimers();
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
						serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
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

		expect(mocks.refreshLibrary).toHaveBeenCalledWith({
			prisma: app.prisma,
			encryptor: app.encryptor,
			instance,
			log: app.log,
		});
		expect(mocks.refreshEpisodes).toHaveBeenCalledWith({
			prisma: app.prisma,
			encryptor: app.encryptor,
			instance,
			log: app.log,
			resumeFailed: true,
		});

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
		await app.close();
		finish({ complete: false, upserted: 0, errors: 1 });
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
