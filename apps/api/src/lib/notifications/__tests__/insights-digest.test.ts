import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InsightsDigestScheduler } from "../insights-digest.js";
import { NotificationService } from "../notification-service.js";
import type { NotificationPayload } from "../types.js";

describe("insights digest notification ownership", () => {
	it("keeps each synthetic owner's digest payload attached to that owner", async () => {
		const notify = vi.fn().mockResolvedValue(undefined);
		for (const userId of ["owner-a", "owner-b"]) {
			const scheduler = new InsightsDigestScheduler(
				{} as never,
				{ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
				{} as never,
				{} as never,
				notify,
			);
			const internal = scheduler as unknown as {
				findRequestedUnwatched: (
					id: string,
				) => Promise<Array<{ title: string; requestedBy: string }>>;
				findWatchedMonitored: (id: string) => Promise<Array<{ title: string; watchCount: number }>>;
				checkRequestedUnwatched: (id: string) => Promise<void>;
				checkWatchedMonitored: (id: string) => Promise<void>;
			};
			vi.spyOn(internal, "findRequestedUnwatched").mockResolvedValue([
				{ title: `${userId} private title`, requestedBy: userId },
			]);
			vi.spyOn(internal, "findWatchedMonitored").mockResolvedValue([
				{ title: `${userId} watched title`, watchCount: 2 },
			]);

			await internal.checkRequestedUnwatched(userId);
			await internal.checkWatchedMonitored(userId);
		}

		expect(notify).toHaveBeenCalledTimes(4);
		expect(notify).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ body: expect.stringContaining("owner-a private title") }),
			"owner-a",
		);
		expect(notify).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ body: expect.stringContaining("owner-a watched title") }),
			"owner-a",
		);
		expect(notify).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({ body: expect.stringContaining("owner-b private title") }),
			"owner-b",
		);
		expect(notify).toHaveBeenNthCalledWith(
			4,
			expect.objectContaining({ body: expect.stringContaining("owner-b watched title") }),
			"owner-b",
		);
	});
});

type DigestInternals = {
	findRequestedUnwatched: (id: string) => Promise<Array<{ title: string; requestedBy: string }>>;
	findWatchedMonitored: (id: string) => Promise<Array<{ title: string; watchCount: number }>>;
	checkRequestedUnwatched: (id: string) => Promise<void>;
	checkWatchedMonitored: (id: string) => Promise<void>;
	check: () => Promise<void>;
	lastNotifiedRequestedUnwatched: number;
	lastNotifiedWatchedMonitored: number;
};

function outcomeFixture(notify: (payload: NotificationPayload, userId: string) => Promise<void>) {
	const info: Array<{ count: unknown; message: string }> = [];
	const failures: string[] = [];
	const attempts: string[] = [];
	const logger = {
		info(data: { count?: number }, message: string) {
			info.push({ count: data.count, message });
		},
		debug(_data: unknown, message: string) {
			failures.push(message);
		},
		warn() {},
		error() {},
	};
	const scheduler = new InsightsDigestScheduler(
		{
			user: {
				async findFirst(args: unknown) {
					if (JSON.stringify(args) !== '{"select":{"id":true}}') {
						throw new Error("Unexpected synthetic user lookup");
					}
					return { id: "synthetic-owner" };
				},
			},
		} as never,
		logger as never,
		{} as never,
		{} as never,
		async (payload, userId) => {
			if (userId !== "synthetic-owner") throw new Error("Unexpected synthetic owner");
			attempts.push(payload.eventType);
			await notify(payload, userId);
		},
	);
	const internal = scheduler as unknown as DigestInternals;
	// Isolate submission outcomes from private provider inventory; these are synthetic findings,
	// not evidence of real Plex/Seerr authority. The actual digest branches/cooldowns run.
	const requested = vi
		.spyOn(internal, "findRequestedUnwatched")
		.mockResolvedValue([{ title: "Synthetic requested item", requestedBy: "Synthetic requester" }]);
	const watched = vi
		.spyOn(internal, "findWatchedMonitored")
		.mockResolvedValue([{ title: "Synthetic watched item", watchCount: 2 }]);
	return { internal, logger, attempts, info, failures, requested, watched };
}

describe("insights digest submission outcomes", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	for (const signal of [
		{
			label: "requested-unwatched",
			check: "checkRequestedUnwatched",
			cooldown: "lastNotifiedRequestedUnwatched",
			finder: "requested",
		},
		{
			label: "watched-monitored",
			check: "checkWatchedMonitored",
			cooldown: "lastNotifiedWatchedMonitored",
			finder: "watched",
		},
	] as const) {
		it(`${signal.label} rejection remains retryable and never reports a successful submission`, async () => {
			let rejected = true;
			const fixture = outcomeFixture(async () => {
				if (rejected) throw new Error("Synthetic submission rejection");
			});
			await fixture.internal[signal.check]("synthetic-owner");
			expect(fixture.internal[signal.cooldown]).toBe(0);
			expect(fixture.info).toEqual([]);
			expect(fixture.failures).toHaveLength(1);
			rejected = false;
			await fixture.internal[signal.check]("synthetic-owner");
			expect(fixture.attempts).toHaveLength(2);
			expect(fixture.internal[signal.cooldown]).toBe(Date.now());
		});

		it(`${signal.label} resolved callback reports processing, not confirmed external delivery`, async () => {
			const fixture = outcomeFixture(async () => undefined);
			await fixture.internal[signal.check]("synthetic-owner");
			expect(fixture.info).toHaveLength(1);
			expect(fixture.info[0]?.count).toBe(1);
			expect(fixture.info[0]?.message).toMatch(/processing/i);
			expect(fixture.info.some((entry) => /^Sent\b/i.test(entry.message))).toBe(false);
			expect(fixture.internal[signal.cooldown]).toBe(Date.now());
		});

		it(`${signal.label} successful submission retains the twenty-four-hour cooldown boundary`, async () => {
			const fixture = outcomeFixture(async () => undefined);
			const started = Date.now();
			await fixture.internal[signal.check]("synthetic-owner");
			vi.setSystemTime(started + 24 * 60 * 60_000 - 1);
			await fixture.internal[signal.check]("synthetic-owner");
			expect(fixture.attempts).toHaveLength(1);
			vi.setSystemTime(started + 24 * 60 * 60_000);
			await fixture.internal[signal.check]("synthetic-owner");
			expect(fixture.attempts).toHaveLength(2);
			expect(fixture.internal[signal.cooldown]).toBe(Date.now());
		});

		it(`${signal.label} empty findings neither submit nor consume future eligibility`, async () => {
			const fixture = outcomeFixture(async () => undefined);
			fixture[signal.finder].mockResolvedValueOnce([]);
			await fixture.internal[signal.check]("synthetic-owner");
			expect(fixture.attempts).toEqual([]);
			expect(fixture.info).toEqual([]);
			expect(fixture.internal[signal.cooldown]).toBe(0);
			await fixture.internal[signal.check]("synthetic-owner");
			expect(fixture.attempts).toHaveLength(1);
		});

		for (const reject of [false, true]) {
			it(`${signal.label} held ${reject ? "rejected" : "completed"} submission records no premature outcome`, async () => {
				let release!: () => void;
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				let entered!: () => void;
				const entry = new Promise<void>((resolve) => {
					entered = resolve;
				});
				const fixture = outcomeFixture(async () => {
					entered();
					await gate;
					if (reject) throw new Error("Synthetic held submission rejection");
				});
				const check = fixture.internal[signal.check]("synthetic-owner");
				try {
					await entry;
					expect(fixture.internal[signal.cooldown]).toBe(0);
					expect(fixture.info).toEqual([]);
				} finally {
					release();
					await check;
				}
				expect(fixture.internal[signal.cooldown]).toBe(reject ? 0 : Date.now());
				expect(fixture.info).toHaveLength(reject ? 0 : 1);
			});
		}

		it(`${signal.label} finding-read failure stays visible without claiming submission`, async () => {
			const fixture = outcomeFixture(async () => undefined);
			fixture[signal.finder].mockRejectedValueOnce(new Error("Synthetic finding failure"));
			await expect(fixture.internal[signal.check]("synthetic-owner")).rejects.toThrow(
				"Synthetic finding failure",
			);
			expect(fixture.attempts).toEqual([]);
			expect(fixture.info).toEqual([]);
			expect(fixture.internal[signal.cooldown]).toBe(0);
			await fixture.internal[signal.check]("synthetic-owner");
			expect(fixture.attempts).toHaveLength(1);
		});

		it(`${signal.label} actual service shutdown rejection preserves eligibility without downstream reads`, async () => {
			let reads = 0;
			const fixture = outcomeFixture(async (payload, userId) => {
				await service.notify(payload, { userId });
			});
			const service = new NotificationService(
				{
					notificationSubscription: {
						async findMany() {
							reads++;
							throw new Error("Fixture forbids downstream reads");
						},
					},
				} as never,
				{} as never,
				{} as never,
				fixture.logger as never,
				{} as never,
				{} as never,
				"https://synthetic.invalid",
			);
			try {
				service.closeAdmission();
				await fixture.internal[signal.check]("synthetic-owner");
				await fixture.internal[signal.check]("synthetic-owner");
				expect(fixture.attempts).toHaveLength(2);
				expect(fixture.failures).toHaveLength(2);
				expect(fixture.info).toEqual([]);
				expect(fixture.internal[signal.cooldown]).toBe(0);
				expect(reads).toBe(0);
			} finally {
				await service.shutdown();
			}
		});
	}

	it("one rejected signal does not suppress the other and retries only the failed signal", async () => {
		const fixture = outcomeFixture(async (payload) => {
			if (payload.eventType === "LIBRARY_INSIGHT_REQUESTED_UNWATCHED") {
				throw new Error("Synthetic first-signal rejection");
			}
		});
		await fixture.internal.check();
		await fixture.internal.check();
		expect(fixture.attempts).toEqual([
			"LIBRARY_INSIGHT_REQUESTED_UNWATCHED",
			"LIBRARY_INSIGHT_WATCHED_MONITORED",
			"LIBRARY_INSIGHT_REQUESTED_UNWATCHED",
		]);
		expect(fixture.internal.lastNotifiedRequestedUnwatched).toBe(0);
		expect(fixture.internal.lastNotifiedWatchedMonitored).toBe(Date.now());
		expect(fixture.info).toHaveLength(1);
		expect(fixture.failures).toHaveLength(2);
	});
});
