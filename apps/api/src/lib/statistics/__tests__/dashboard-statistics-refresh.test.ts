import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotificationOutboxNativeFixture } from "../../notifications/__tests__/notification-outbox-native-fixture.js";
import { requestDashboardStatisticsRefresh } from "../dashboard-statistics-refresh.js";
import * as snapshot from "../dashboard-statistics-snapshot.js";

vi.mock("../dashboard-statistics-snapshot.js", () => ({
	claimDashboardRefresh: vi.fn(),
	renewDashboardRefreshClaim: vi.fn(),
	publishDashboardSnapshot: vi.fn(),
	failDashboardRefresh: vi.fn(),
}));

const payload = {
	sonarr: { instances: [] },
	radarr: { instances: [] },
	prowlarr: { instances: [] },
	lidarr: { instances: [] },
	readarr: { instances: [] },
};

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("Dashboard statistics background refresh", () => {
	it.each([false, true])(
		"joins an in-flight renewal after provider failure (settlement failure: %s)",
		async (settlementFails) => {
			const fixture = await createNotificationOutboxNativeFixture();
			vi.useFakeTimers({
				toFake: ["Date", "setImmediate", "clearImmediate", "setInterval", "clearInterval"],
			});
			vi.mocked(snapshot.claimDashboardRefresh).mockResolvedValue(true);
			let releaseRenewal!: (value: boolean) => void;
			vi.mocked(snapshot.renewDashboardRefreshClaim).mockImplementation(
				() =>
					new Promise<boolean>((resolve) => {
						releaseRenewal = resolve;
					}),
			);
			if (settlementFails)
				vi.mocked(snapshot.failDashboardRefresh).mockRejectedValue(
					new Error("synthetic storage failure"),
				);
			else vi.mocked(snapshot.failDashboardRefresh).mockResolvedValue(true);
			let rejectCollection!: (error: Error) => void;
			const collect = () =>
				new Promise<{ data: typeof payload; partial: boolean }>((_resolve, reject) => {
					rejectCollection = reject;
				});
			const app = { prisma: fixture.prisma } as never;
			const log = { warn: vi.fn() } as never;
			let drain: Promise<void> | undefined;
			try {
				expect(
					await fixture.run(() =>
						requestDashboardStatisticsRefresh(app, fixture.userId, "fingerprint", log, collect),
					),
				).toBe(true);
				await vi.advanceTimersByTimeAsync(0);
				await vi.advanceTimersByTimeAsync(30_000);
				expect(releaseRenewal).toBeTypeOf("function");
				rejectCollection(new Error("synthetic provider failure"));
				await vi.advanceTimersByTimeAsync(0);
				let drained = false;
				drain = fixture.runtime.drain().then(() => {
					drained = true;
				});
				await Promise.resolve();
				expect(drained).toBe(false);
				releaseRenewal(true);
				await vi.advanceTimersByTimeAsync(0);
				await drain;
				expect(vi.getTimerCount()).toBe(0);
				expect(snapshot.publishDashboardSnapshot).not.toHaveBeenCalled();
			} finally {
				releaseRenewal?.(true);
				await vi.advanceTimersByTimeAsync(0);
				await drain;
				vi.useRealTimers();
				await fixture.close();
			}
		},
	);

	it.each(["rejected", "exception"] as const)(
		"releases retained admission for a claim %s",
		async (outcome) => {
			const fixture = await createNotificationOutboxNativeFixture();
			if (outcome === "rejected")
				vi.mocked(snapshot.claimDashboardRefresh).mockResolvedValue(false);
			else
				vi.mocked(snapshot.claimDashboardRefresh).mockRejectedValue(
					new Error("synthetic claim failure"),
				);
			let collected = false;
			try {
				const requested = fixture.run(() =>
					requestDashboardStatisticsRefresh(
						{ prisma: fixture.prisma } as never,
						fixture.userId,
						"fingerprint",
						{ warn() {} } as never,
						async () => {
							collected = true;
							return { data: payload, partial: false };
						},
					),
				);
				if (outcome === "rejected") expect(await requested).toBe(false);
				else await expect(requested).rejects.toThrow("synthetic claim failure");
				await fixture.runtime.drain();
				expect(collected).toBe(false);
			} finally {
				await fixture.close();
			}
		},
	);

	it("renews the same claim while a provider collection lasts beyond the initial lease", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-29T12:00:00.000Z"));
		vi.mocked(snapshot.claimDashboardRefresh).mockResolvedValue(true);
		vi.mocked(snapshot.renewDashboardRefreshClaim).mockResolvedValue(true);
		vi.mocked(snapshot.publishDashboardSnapshot).mockResolvedValue(true);
		let resolveCollection!: (value: { data: typeof payload; partial: boolean }) => void;
		const collect = vi.fn(
			() =>
				new Promise<{ data: typeof payload; partial: boolean }>((resolve) => {
					resolveCollection = resolve;
				}),
		);
		const app = { prisma: {} } as never;
		const log = { warn: vi.fn() } as never;
		expect(await requestDashboardStatisticsRefresh(app, "owner", "fingerprint", log, collect)).toBe(
			true,
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(collect).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(150_000);
		expect(snapshot.renewDashboardRefreshClaim).toHaveBeenCalledTimes(5);
		const tokens = new Set(
			vi.mocked(snapshot.renewDashboardRefreshClaim).mock.calls.map(([, , , token]) => token),
		);
		expect(tokens.size).toBe(1);
		resolveCollection({ data: payload, partial: false });
		await vi.advanceTimersByTimeAsync(0);
		expect(snapshot.publishDashboardSnapshot).toHaveBeenCalledOnce();
		expect(vi.mocked(snapshot.publishDashboardSnapshot).mock.calls[0]?.[3]).toBe([...tokens][0]);
		expect(snapshot.failDashboardRefresh).not.toHaveBeenCalled();
	});
});
