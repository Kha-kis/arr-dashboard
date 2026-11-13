import { SonarrClient } from "arr-sdk";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../../routes/__tests__/test-helpers.js";
import {
	collectDashboardStatistics,
	statisticsRoutes,
} from "../../../routes/dashboard/statistics-routes.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	type ScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { emptySonarrStatistics } from "../../statistics/dashboard-statistics.js";
import * as refresh from "../../statistics/dashboard-statistics-refresh.js";
import { fingerprintDashboardSources } from "../../statistics/dashboard-statistics-snapshot.js";

const provider = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../statistics/dashboard-statistics.js", async (original) => ({
	...(await original<typeof import("../../statistics/dashboard-statistics.js")>()),
	fetchSonarrStatisticsWithSdk: provider.fetch,
}));

afterEach(async () => {
	await closeScopedWriteFixtures();
	vi.restoreAllMocks();
	provider.fetch.mockReset();
});

async function setup(published: boolean) {
	// Match the production plugin's ordinary client, without forcing write intent.
	const f = await createScopedWriteFixture();
	await f.plain.serviceInstance.updateMany({ data: { enabled: false } });
	await f.plain.user.create({ data: { id: "foreign-user", username: "synthetic-foreign" } });
	await f.plain.serviceInstance.createMany({
		data: [
			{ id: "owned-arr", userId: "synthetic-user", enabled: true, label: "Committed" },
			{ id: "disabled-arr", userId: "synthetic-user", enabled: false, label: "Disabled" },
			{ id: "foreign-arr", userId: "foreign-user", enabled: true, label: "Foreign" },
		].map((row) => ({
			...row,
			service: "SONARR" as const,
			baseUrl: "http://synthetic.invalid",
			encryptedApiKey: "synthetic-cipher",
			encryptionIv: "synthetic-iv",
		})),
	});
	const fingerprint = fingerprintDashboardSources(
		await f.plain.serviceInstance.findMany({ where: { userId: "synthetic-user", enabled: true } }),
	);
	const observedAt = new Date(Date.now() - 16 * 60_000);
	const payload = {
		sonarr: {
			instances: [
				{
					instanceId: "owned-arr",
					instanceName: "Committed",
					data: { ...emptySonarrStatistics, totalSeries: 17 },
					error: false,
				},
			],
		},
		radarr: { instances: [] },
		prowlarr: { instances: [] },
		lidarr: { instances: [] },
		readarr: { instances: [] },
	};
	if (published)
		await f.plain.dashboardStatisticsSnapshot.create({
			data: {
				userId: "synthetic-user",
				sourceFingerprint: fingerprint,
				observedAt,
				result: "complete",
				payload: JSON.stringify(payload),
			},
		});
	const app = Fastify({ logger: false });
	app.decorate("prisma", f.client.prisma);
	app.decorate("arrClientFactory", {
		create: () => Object.create(SonarrClient.prototype),
	} as never);
	setupAuthInjection(app, { id: "synthetic-user", username: "synthetic-owner" });
	registerTestErrorHandler(app);
	await app.register(statisticsRoutes);
	await app.ready();
	const inject = createInjectAuthenticated(app);
	const get = () => f.runtime.runOperation(() => inject("GET", "/dashboard/statistics/snapshot"));
	const queued = vi.spyOn(refresh, "queueDashboardStatisticsRefresh");
	return { f, app, get, observedAt, payload, queued };
}

async function holdOrdinaryTransaction(f: ScopedWriteFixture) {
	let release!: () => void;
	let entered!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const rollback = new Error("synthetic-statistics-rollback");
	const work = f.runtime
		.runOperation(() =>
			f.client.prisma.$transaction(
				async (tx) => {
					await tx.serviceInstance.update({
						where: { id: "owned-arr" },
						data: { userId: "foreign-user", enabled: false, label: "Uncommitted" },
					});
					await tx.serviceInstance.update({
						where: { id: "foreign-arr" },
						data: { userId: "synthetic-user" },
					});
					entered();
					await held;
					throw rollback;
				},
				{ timeout: 15_000 },
			),
		)
		.then(
			() => null,
			(error: unknown) => error,
		);
	await started;
	return { release, work, rollback };
}

describe("Statistics read and refresh-claim acquisition", { timeout: 30_000 }, () => {
	// Break caught: an optional claim must not make a cached GET wait for the
	// ordinary connection or fabricate a successful claim while a writer holds it.
	it.each([true, false])(
		"serves honest cached state during an ordinary transaction, then retries (published: %s)",
		async (published) => {
			const { f, app, get, observedAt, payload, queued } = await setup(published);
			const held = await holdOrdinaryTransaction(f);
			let releaseProvider = () => {};
			try {
				provider.fetch.mockImplementation(() => {
					throw new Error("Provider must not start while the claim is refused");
				});
				const startedAt = performance.now();
				const first = await get();
				expect(first.statusCode).toBe(200);
				expect(performance.now() - startedAt).toBeLessThan(2_000);
				expect(first.json()).toEqual(
					published
						? { availability: "last-known", observedAt: observedAt.toISOString(), data: payload }
						: { availability: "unavailable", observedAt: null, data: null },
				);
				expect(provider.fetch).not.toHaveBeenCalled();
				const repeated = await Promise.all([get(), get()]);
				expect(repeated.map((response) => response.statusCode)).toEqual([200, 200]);
				const pending = queued.mock.results.map((result) => result.value);
				expect(new Set(pending).size).toBe(1);
				await expect(pending[0]).resolves.toBe(false);
				expect(provider.fetch).not.toHaveBeenCalled();
				expect(
					(
						await f.plain.dashboardStatisticsSnapshot.findUnique({
							where: { userId: "synthetic-user" },
						})
					)?.claimToken ?? null,
				).toBeNull();
				held.release();
				expect(await held.work).toBe(held.rollback);
				provider.fetch.mockImplementation(
					() =>
						new Promise((resolve) => {
							releaseProvider = () => resolve({ ...emptySonarrStatistics, totalSeries: 18 });
						}),
				);
				const retry = await get();
				expect(retry.statusCode).toBe(200);
				expect(retry.json().availability).toBe(published ? "last-known" : "unavailable");
				await expect(queued.mock.results.at(-1)!.value).resolves.toBe(true);
				await vi.waitFor(() => expect(provider.fetch).toHaveBeenCalledTimes(1));
				expect(provider.fetch.mock.calls[0]![1]).toBe("owned-arr");
				expect(provider.fetch.mock.calls[0]![2]).toBe("Committed");
				releaseProvider();
				await vi.waitFor(async () => {
					const row = await f.plain.dashboardStatisticsSnapshot.findUniqueOrThrow({
						where: { userId: "synthetic-user" },
					});
					expect(row.claimToken).toBeNull();
					expect(row.observedAt!.getTime()).toBeGreaterThan(observedAt.getTime());
				});
				const current = await get();
				expect(current.statusCode).toBe(200);
				expect(current.json()).toMatchObject({
					availability: "current",
					data: { sonarr: { instances: [{ instanceId: "owned-arr", data: { totalSeries: 18 } }] } },
				});
				expect(f.losses).toEqual([]);
			} finally {
				releaseProvider();
				held.release();
				await held.work;
				await f.runtime.drain();
				await app.close();
			}
		},
	);

	// Break caught: after admission, the collector still needs a committed source
	// selection, separate from the ordinary connection and provider callbacks.
	it("collects only committed owned enabled sources while an ordinary transaction is open", async () => {
		const { f, app } = await setup(false);
		const held = await holdOrdinaryTransaction(f);
		try {
			provider.fetch.mockResolvedValue({ ...emptySonarrStatistics, totalSeries: 18 });
			const collected = await f.runtime.runOperation(() =>
				collectDashboardStatistics(app, "synthetic-user", app.log),
			);
			expect(collected.partial).toBe(false);
			expect(collected.data.sonarr.instances).toEqual([
				expect.objectContaining({
					instanceId: "owned-arr",
					instanceName: "Committed",
					error: false,
				}),
			]);
			expect(provider.fetch).toHaveBeenCalledTimes(1);
			expect(provider.fetch.mock.calls[0]![1]).toBe("owned-arr");
			expect(provider.fetch.mock.calls[0]![2]).toBe("Committed");
			expect(f.losses).toEqual([]);
		} finally {
			held.release();
			await held.work;
			await f.runtime.drain();
			await app.close();
		}
	});

	// Break caught: GET can end before admission, but accepted deferred work must
	// still finish under a live runtime ticket before native clients are closed.
	it("keeps queued admission and publication joined when shutdown begins after GET", async () => {
		const { f, app, get, queued } = await setup(false);
		const immediate = globalThis.setImmediate;
		let callback: (() => void) | undefined;
		const scheduling = vi.spyOn(globalThis, "setImmediate").mockImplementation((next, ...args) => {
			if (new Error().stack?.includes("dashboard-statistics-refresh.ts")) {
				callback = () => next(...args);
				return { ref() {}, unref() {}, hasRef: () => false } as NodeJS.Immediate;
			}
			return immediate(next, ...args);
		});
		let releaseProvider = () => {};
		let closing: Promise<void> | undefined;
		try {
			provider.fetch.mockImplementation(
				() =>
					new Promise((resolve) => {
						releaseProvider = () => resolve({ ...emptySonarrStatistics, totalSeries: 18 });
					}),
			);
			const response = await get();
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({ availability: "unavailable", data: null });
			expect(callback).toBeTypeOf("function");
			expect(provider.fetch).not.toHaveBeenCalled();
			scheduling.mockRestore();
			f.runtime.closeAdmission();
			let closed = false;
			closing = f.runtime.close().then(() => {
				closed = true;
			});
			await new Promise<void>((resolve) => immediate(resolve));
			expect(closed).toBe(false);
			callback!();
			callback = undefined;
			await expect(queued.mock.results[0]!.value).resolves.toBe(true);
			await vi.waitFor(() => expect(provider.fetch).toHaveBeenCalledTimes(1));
			expect(closed).toBe(false);
			releaseProvider();
			await closing;
			expect(closed).toBe(true);
			expect(
				await f.plain.dashboardStatisticsSnapshot.findUniqueOrThrow({
					where: { userId: "synthetic-user" },
				}),
			).toMatchObject({ result: "complete", claimToken: null, lastFailureCategory: null });
			expect(f.losses).toEqual([]);
		} finally {
			scheduling.mockRestore();
			callback?.();
			releaseProvider();
			await closing;
			await app.close();
		}
	});
});
