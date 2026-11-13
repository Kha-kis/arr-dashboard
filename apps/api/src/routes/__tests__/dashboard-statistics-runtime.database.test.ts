import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRestoreRuntimeClientContext } from "../../lib/backup/restore-runtime-admission.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { requestDashboardStatisticsRefresh } from "../../lib/statistics/dashboard-statistics-refresh.js";
import {
	fingerprintDashboardSources,
	readDashboardSnapshot,
} from "../../lib/statistics/dashboard-statistics-snapshot.js";
import lifecyclePlugin from "../../plugins/lifecycle.js";

const payload = {
	sonarr: { instances: [] },
	radarr: { instances: [] },
	prowlarr: { instances: [] },
	lidarr: { instances: [] },
	readarr: { instances: [] },
};
type Collection = { data: typeof payload; partial: boolean };

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function holdRefreshCallback() {
	const immediate = globalThis.setImmediate;
	let queued: (() => void) | undefined;
	const intercept = vi.spyOn(globalThis, "setImmediate").mockImplementation((callback, ...args) => {
		if (new Error().stack?.includes("dashboard-statistics-refresh.ts")) {
			queued = () => callback(...args);
			return { ref() {}, unref() {}, hasRef: () => false } as NodeJS.Immediate;
		}
		return immediate(callback, ...args);
	});
	return {
		isQueued: () => queued !== undefined,
		run() {
			const callback = queued;
			queued = undefined;
			callback?.();
		},
		restore: () => intercept.mockRestore(),
		turn: () => new Promise<void>((resolve) => immediate(resolve)),
	};
}

describe("Statistics refresh with native HTTP runtime admission", () => {
	const cleanup: Array<() => Promise<void>> = [];
	afterEach(async () => {
		for (const close of cleanup.splice(0).reverse()) await close();
	});

	async function setup() {
		const fixture = await createNotificationOutboxNativeFixture();
		const app = Fastify({ logger: false });
		app.decorate("prisma", fixture.prisma);
		app.decorate("restoreRuntime", fixture.runtime);
		await app.register(lifecyclePlugin);
		const collections: Array<ReturnType<typeof deferred<Collection>>> = [];
		const nativeChecks: string[] = [];
		const users = new Set<string>([fixture.userId]);
		const fingerprint = fingerprintDashboardSources([]);
		// The actual lifecycle wrapper and refresh/persistence are exercised. Only
		// the external collector is synthetic; this is not the full statistics route.
		app.get("/statistics/:userId", async (request, reply) => {
			const { userId } = request.params as { userId: string };
			if (!users.has(userId)) return reply.code(404).send();
			const snapshot = await readDashboardSnapshot(app.prisma, userId, fingerprint, new Date());
			if (snapshot.refreshDue) {
				await requestDashboardStatisticsRefresh(app, userId, fingerprint, request.log, async () => {
					const collection = deferred<Collection>();
					collections.push(collection);
					const result = await collection.promise;
					// Native SQL after provider completion must have its own live ticket.
					try {
						await app.prisma.user.findUniqueOrThrow({ where: { id: userId } });
						nativeChecks.push("admitted");
					} catch (error) {
						nativeChecks.push("denied");
						throw error;
					}
					return result;
				});
			}
			return readDashboardSnapshot(app.prisma, userId, fingerprint, new Date());
		});
		await app.ready();
		cleanup.push(async () => {
			for (const collection of collections) collection.resolve({ data: payload, partial: false });
			await fixture.runtime.drain();
			await app.close();
			await fixture.close();
		});
		const get = (userId = fixture.userId) => app.inject(`/statistics/${userId}`);
		const row = (userId = fixture.userId) =>
			fixture.run(() =>
				fixture.prisma.dashboardStatisticsSnapshot.findUnique({ where: { userId } }),
			);
		const path = getRestoreRuntimeClientContext(fixture.runtime).databaseUrl.slice(5);
		return { fixture, app, collections, nativeChecks, users, fingerprint, get, row, path };
	}

	it("publishes after the lifecycle-tracked GET has ended its native ticket", async () => {
		const { fixture, get, row, collections, nativeChecks } = await setup();
		const response = await get();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ availability: "collecting", data: null });
		await expect(fixture.prisma.user.count()).rejects.toThrow();
		// GET has settled before the held external result is made available.
		await expect.poll(() => collections.length).toBe(1);
		collections[0]!.resolve({ data: payload, partial: false });
		await expect.poll(() => nativeChecks).toEqual(["admitted"]);
		await expect.poll(async () => (await row())?.result).toBe("complete");
		expect(await row()).toMatchObject({ claimToken: null, lastFailureCategory: null });
		expect((await get()).json()).toMatchObject({ availability: "current", data: payload });
	});

	it("settles a failed provider after GET and publishes only when its retry is due", async () => {
		const { fixture, get, row, collections } = await setup();
		expect((await get()).statusCode).toBe(200);
		await expect.poll(() => collections.length).toBe(1);
		const failedAt = Date.now();
		collections[0]!.reject(new Error("synthetic provider unavailable"));
		await expect.poll(async () => (await row())?.claimToken).toBeNull();
		const failed = await row();
		expect(failed).toMatchObject({
			payload: null,
			result: null,
			lastFailureCategory: "provider-unavailable",
		});
		expect(failed?.retryAt?.getTime()).toBeGreaterThanOrEqual(failedAt + 60_000);
		expect((await get()).json()).toMatchObject({ availability: "unavailable", data: null });
		expect(collections).toHaveLength(1);
		await fixture.run(() =>
			fixture.prisma.dashboardStatisticsSnapshot.update({
				where: { userId: fixture.userId },
				data: { retryAt: new Date(Date.now() - 1) },
			}),
		);
		expect((await get()).json().availability).toBe("collecting");
		await expect.poll(() => collections.length).toBe(2);
		collections[1]!.resolve({ data: payload, partial: false });
		await expect.poll(async () => (await row())?.result).toBe("complete");
		expect(await row()).toMatchObject({
			claimToken: null,
			retryAt: null,
			lastFailureCategory: null,
		});
	});

	it("coalesces concurrent GETs and isolates a second owner's claim and publication", async () => {
		const { fixture, get, row, collections, users } = await setup();
		const responses = await Promise.all([get(), get(), get()]);
		expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
		await expect.poll(() => collections.length).toBe(1);
		const firstClaim = await row();
		const other = await fixture.createOwner();
		users.add(other.userId);
		expect((await get(other.userId)).statusCode).toBe(200);
		await expect.poll(() => collections.length).toBe(2);
		const secondClaim = await row(other.userId);
		expect(secondClaim?.claimToken).not.toBe(firstClaim?.claimToken);
		collections[0]!.resolve({ data: payload, partial: false });
		await expect.poll(async () => (await row())?.result).toBe("complete");
		expect(await row(other.userId)).toMatchObject({
			claimToken: secondClaim?.claimToken,
			payload: null,
		});
		collections[1]!.resolve({ data: payload, partial: true });
		await expect.poll(async () => (await row(other.userId))?.result).toBe("partial");
		expect((await get()).json().availability).toBe("current");
		expect((await get(other.userId)).json().availability).toBe("partial");
		expect(collections).toHaveLength(2);
	});

	it("joins a queued accepted callback through admission closure and native client teardown", async () => {
		const { fixture, app, get, collections, path } = await setup();
		// Hold only this module's deferred callback; leave Fastify/runtime scheduling real.
		const queued = holdRefreshCallback();
		let closing: Promise<void> | undefined;
		try {
			expect((await get()).statusCode).toBe(200);
			expect(queued.isQueued()).toBe(true);
			queued.restore();
			fixture.runtime.closeAdmission();
			let closed = false;
			closing = fixture.runtime.close().then(() => {
				closed = true;
			});
			await expect(fixture.run(() => fixture.prisma.user.count())).rejects.toThrow();
			const denied = await get();
			expect(denied.statusCode).toBe(503);
			await queued.turn();
			expect(closed).toBe(false);
			queued.run();
			await expect.poll(() => collections.length).toBe(1);
			expect(closed).toBe(false);
			collections[0]!.resolve({ data: payload, partial: false });
			await closing;
			expect(closed).toBe(true);
			await expect(fixture.prisma.user.count()).rejects.toThrow();
			const observer = new Database(path, { readonly: true });
			try {
				expect(
					observer
						.prepare(
							"SELECT result, claimToken FROM dashboard_statistics_snapshots WHERE userId = ?",
						)
						.get(fixture.userId),
				).toEqual({ result: "complete", claimToken: null });
			} finally {
				observer.close();
			}
		} finally {
			queued.restore();
			queued.run();
			await queued.turn();
			for (const collection of collections) collection.resolve({ data: payload, partial: false });
			await closing;
			await app.lifecycle.drainHttpHandlers();
		}
	});

	it("settles detached admission rejection without invoking a collector or leaking retention", async () => {
		const { fixture, app, get, collections, path } = await setup();
		const queued = holdRefreshCallback();
		const warned = vi.spyOn(app.log, "warn").mockImplementation(() => {
			throw new Error("synthetic diagnostic failure");
		});
		const observer = new Database(path);
		try {
			expect((await get()).statusCode).toBe(200);
			expect(queued.isQueued()).toBe(true);
			queued.restore();
			observer
				.prepare("UPDATE RestoreRuntimeControl SET runtimeEpoch = ?")
				.run("00000000-0000-4000-8000-000000000001");
			queued.run();
			await fixture.runtime.drain();
			expect(collections).toHaveLength(0);
			expect(warned).toHaveBeenCalledOnce();
			expect(
				observer
					.prepare(
						"SELECT payload, result, retryAt FROM dashboard_statistics_snapshots WHERE userId = ?",
					)
					.get(fixture.userId),
			).toEqual({ payload: null, result: null, retryAt: null });
			expect(
				observer
					.prepare("SELECT claimToken FROM dashboard_statistics_snapshots WHERE userId = ?")
					.get(fixture.userId),
			).toMatchObject({ claimToken: expect.any(String) });
		} finally {
			queued.restore();
			queued.run();
			observer.close();
			warned.mockRestore();
		}
	});

	it("does not fabricate settlement when the real database refuses the failure write", async () => {
		const { fixture, app, get, row, collections } = await setup();
		const warned = vi.spyOn(app.log, "warn");
		expect((await get()).statusCode).toBe(200);
		await expect.poll(() => collections.length).toBe(1);
		const claim = await row();
		await fixture.run(() =>
			fixture.prisma.$executeRawUnsafe(
				"CREATE TRIGGER refuse_statistics_settlement BEFORE UPDATE ON dashboard_statistics_snapshots WHEN NEW.claimToken IS NULL BEGIN SELECT RAISE(ABORT, 'synthetic settlement unavailable'); END",
			),
		);
		collections[0]!.reject(new Error("synthetic provider unavailable"));
		await expect.poll(() => warned.mock.calls.length).toBe(1);
		await fixture.runtime.drain();
		expect(await row()).toMatchObject({
			claimToken: claim?.claimToken,
			payload: null,
			result: null,
			retryAt: null,
			lastFailureCategory: null,
		});
		warned.mockRestore();
	});

	it("refuses stale publication after the native runtime identity is lost", async () => {
		const { fixture, app, get, collections, path } = await setup();
		const warned = vi.spyOn(app.log, "warn");
		expect((await get()).statusCode).toBe(200);
		await expect.poll(() => collections.length).toBe(1);
		const observer = new Database(path);
		try {
			observer
				.prepare("UPDATE RestoreRuntimeControl SET runtimeEpoch = ?")
				.run("00000000-0000-4000-8000-000000000001");
			collections[0]!.resolve({ data: payload, partial: false });
			await expect.poll(() => warned.mock.calls.length).toBe(1);
			await fixture.runtime.drain();
			expect(
				observer
					.prepare("SELECT payload, result FROM dashboard_statistics_snapshots WHERE userId = ?")
					.get(fixture.userId),
			).toEqual({ payload: null, result: null });
			await expect(fixture.run(() => fixture.prisma.user.count())).rejects.toThrow();
		} finally {
			observer.close();
			warned.mockRestore();
		}
	});

	it("context-free callers cannot grant native authority", async () => {
		const { fixture, app, collections, fingerprint, row } = await setup();
		await expect(
			requestDashboardStatisticsRefresh(app, fixture.userId, fingerprint, app.log, async () => ({
				data: payload,
				partial: false,
			})),
		).rejects.toThrow();
		expect(await row()).toBeNull();
		expect(collections).toHaveLength(0);
		await fixture.runtime.drain();
	});
});
