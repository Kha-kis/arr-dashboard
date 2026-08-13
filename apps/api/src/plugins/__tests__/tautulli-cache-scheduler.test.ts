import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createTautulliClient, refreshTautulliCache, recordProviderCacheRefreshFailure } =
	vi.hoisted(() => ({
		createTautulliClient: vi.fn(),
		refreshTautulliCache: vi.fn(),
		recordProviderCacheRefreshFailure: vi.fn(),
	}));

vi.mock("../../lib/tautulli/tautulli-client.js", () => ({ createTautulliClient }));
vi.mock("../../lib/tautulli/tautulli-cache-refresher.js", () => ({ refreshTautulliCache }));
vi.mock("../../lib/services/provider-cache-status.js", () => ({
	recordProviderCacheRefreshFailure,
}));

import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import { providerConnectionIdentity } from "../../lib/services/provider-connection-guard.js";
import schedulerRegistryPlugin from "../scheduler-registry.js";
import tautulliCacheSchedulerPlugin, {
	refreshScheduledTautulliCacheInstance,
} from "../tautulli-cache-scheduler.js";

const STARTUP_DELAY_MS = 2 * 60_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

function instance(id: string, enabled = true) {
	return {
		id,
		userId: "user-1",
		label: `Tautulli ${id}`,
		service: "TAUTULLI",
		enabled,
		connectionGeneration: 4,
		encryptedApiKey: "encrypted-key",
		encryptionIv: "key-iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		baseUrl: "https://tautulli.example.test",
	};
}

describe("tautulli cache scheduler", () => {
	let app: ReturnType<typeof Fastify>;
	let findMany: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		findMany = vi.fn();
		app = Fastify({ logger: false });
		app.decorate("encryptor", {} as never);
		app.decorate("prisma", {
			serviceInstance: { findMany },
		} as never);
		await app.register(schedulerRegistryPlugin);
		createTautulliClient.mockReturnValue({});
		refreshTautulliCache.mockResolvedValue({
			upserted: 1,
			errors: 0,
			errorMessages: [],
			complete: true,
		});
		await app.register(tautulliCacheSchedulerPlugin);
		await app.ready();
	});

	afterEach(async () => {
		await app?.close();
		vi.useRealTimers();
	});

	it("refreshes each enabled Tautulli instance while skipping a disabled row", async () => {
		findMany.mockResolvedValue([instance("one"), instance("two"), instance("disabled", false)]);

		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);

		expect(findMany).toHaveBeenCalledWith({
			where: { service: "TAUTULLI", enabled: true },
		});
		expect(createTautulliClient).toHaveBeenCalledTimes(2);
		expect(refreshTautulliCache).toHaveBeenCalledTimes(2);
		expect(refreshTautulliCache).toHaveBeenNthCalledWith(
			1,
			expect.anything(),
			app.prisma,
			"one",
			app.log,
			providerConnectionIdentity(instance("one") as never),
		);
		expect(refreshTautulliCache).toHaveBeenNthCalledWith(
			2,
			expect.anything(),
			app.prisma,
			"two",
			app.log,
			providerConnectionIdentity(instance("two") as never),
		);
		expect(app.schedulerRegistry.getStatus(JOB_ID.tautulliCache)).toMatchObject({
			totalRuns: 1,
			totalFailures: 0,
			state: "idle",
		});
	});

	it("does not start an overlapping tick while an earlier refresh is in flight", async () => {
		findMany.mockResolvedValue([instance("one")]);
		let releaseRefresh: (() => void) | undefined;
		refreshTautulliCache.mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseRefresh = () =>
						resolve({ upserted: 1, errors: 0, errorMessages: [], complete: true });
				}),
		);

		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
		expect(refreshTautulliCache).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(refreshTautulliCache).toHaveBeenCalledTimes(1);
		expect(findMany).toHaveBeenCalledTimes(1);

		releaseRefresh?.();
		await vi.runAllTicks();
	});

	it("records a failed attempt through the guarded status boundary without replacing a generation", async () => {
		const failure = new Error("credential could not be decrypted");
		createTautulliClient.mockImplementation(() => {
			throw failure;
		});
		recordProviderCacheRefreshFailure.mockResolvedValue("recorded");
		const schedulerApp = {
			encryptor: {},
			prisma: {},
			log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
		};

		await refreshScheduledTautulliCacheInstance(schedulerApp as never, instance("one") as never);

		expect(recordProviderCacheRefreshFailure).toHaveBeenCalledWith(
			schedulerApp.prisma,
			"one",
			"tautulli",
			"credential could not be decrypted",
			providerConnectionIdentity(instance("one") as never),
			schedulerApp.log,
		);
	});
});
