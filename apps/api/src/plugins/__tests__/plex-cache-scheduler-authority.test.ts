import Fastify, { type FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createSnapshot: vi.fn((_encryptor: unknown, instance: unknown) => ({ sealed: instance })),
	refreshLibrary: vi.fn(),
	refreshEpisodes: vi.fn(),
	recordFailure: vi.fn(),
}));

vi.mock("../../lib/plex/plex-cache-refresher.js", () => ({
	createOwnedPlexPublicationSnapshot: mocks.createSnapshot,
	refreshPlexCache: mocks.refreshLibrary,
}));
vi.mock("../../lib/plex/plex-episode-cache-refresher.js", () => ({
	refreshPlexEpisodeCache: mocks.refreshEpisodes,
}));
vi.mock("../../lib/services/provider-cache-status.js", () => ({
	recordPlexCacheRefreshFailure: mocks.recordFailure,
}));

import plexCacheSchedulerPlugin from "../plex-cache-scheduler.js";
import plexEpisodeCacheSchedulerPlugin from "../plex-episode-cache-scheduler.js";

describe("Plex scheduler publication authority", () => {
	let app: FastifyInstance;
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
		mocks.createSnapshot.mockClear();
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
		mocks.recordFailure.mockReset();

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
	});

	afterEach(async () => {
		await app.close();
		vi.useRealTimers();
	});

	it("uses sealed owned snapshots for startup and recurring publication paths", async () => {
		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(mocks.createSnapshot).toHaveBeenCalledTimes(2);
		expect(mocks.refreshLibrary).toHaveBeenCalledWith({
			prisma: app.prisma,
			instance: { sealed: instance },
			log: app.log,
		});
		expect(mocks.refreshEpisodes).toHaveBeenCalledWith({
			prisma: app.prisma,
			instance: { sealed: instance },
			log: app.log,
		});

		await vi.advanceTimersByTimeAsync(385 * 60_000);

		expect(mocks.createSnapshot).toHaveBeenCalledTimes(4);
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
		expect(mocks.recordFailure).not.toHaveBeenCalled();
	});
});
