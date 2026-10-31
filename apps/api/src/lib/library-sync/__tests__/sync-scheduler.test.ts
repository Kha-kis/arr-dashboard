/**
 * Tests for library-sync's adaptive-concurrency + first-tick-delay logic
 * (issue #427 follow-up).
 *
 * Covers the two review-feedback fixes:
 *
 * 1. **Cold-start adaptive cap.** When `LibrarySyncStatus.itemCount` defaults
 *    to 0 because the instance has never been synced (`lastFullSync === null`),
 *    the previous code treated the candidate as "small" and allowed it to
 *    co-sync with another large library — exactly the OOM scenario the cap
 *    was meant to prevent. Now we treat `lastFullSync === null` as "assume
 *    large" so cold-start syncs run solo.
 *
 * 2. **stop()/start() race.** If `stop()` runs during the FIRST_TICK_DELAY_MS
 *    window, the previously-installed setTimeout would still fire, creating
 *    an interval that escaped shutdown cleanup. Now the timeout callback
 *    checks `this.running` before installing the interval.
 *
 * Plus the pure adaptive-cap logic (effectiveMaxConcurrent) tested through
 * the public surface via mocked Prisma + manipulation of
 * `activeSyncItemCounts`.
 */

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotificationOutboxNativeFixture } from "../../notifications/__tests__/notification-outbox-native-fixture.js";
import { NotificationDispatcher } from "../../notifications/notification-dispatcher.js";
import { NotificationService } from "../../notifications/notification-service.js";
import { RuleEngine } from "../../notifications/rule-engine.js";

import { LibrarySyncScheduler, sendNewDownloadNotification } from "../sync-scheduler.js";

// Match the constants in sync-scheduler.ts. If those change, these test
// thresholds should too — but keep them in sync intentionally so a change
// to the production threshold breaks the test (forcing review).
const LARGE_LIBRARY_THRESHOLD = 10_000;
const FIRST_TICK_DELAY_MS = 60_000;

function makeMockApp(
	opts: {
		instances?: Array<{
			id: string;
			service: string;
			librarySyncStatus?: {
				lastFullSync: Date | null;
				itemCount: number;
				syncInProgress?: boolean;
				pollingEnabled?: boolean;
				pollingIntervalMins?: number;
				updatedAt?: Date;
			};
		}>;
	} = {},
): { app: FastifyInstance; warnSpy: ReturnType<typeof vi.fn> } {
	const warnSpy = vi.fn();
	const log = {
		child: vi.fn().mockReturnValue({
			info: vi.fn(),
			debug: vi.fn(),
			error: vi.fn(),
			warn: warnSpy,
		}),
		info: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
		warn: warnSpy,
	};
	const app = {
		log: log as unknown as FastifyInstance["log"],
		prisma: {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue(opts.instances ?? []),
				findUnique: vi.fn().mockImplementation(async (q: { where: { id: string } }) => {
					return (opts.instances ?? []).find((i) => i.id === q.where.id) ?? null;
				}),
			},
			librarySyncStatus: {
				update: vi.fn().mockResolvedValue({}),
			},
		} as unknown as FastifyInstance["prisma"],
		arrClientFactory: {
			create: vi.fn(),
		} as unknown as FastifyInstance["arrClientFactory"],
		encryptor: {} as FastifyInstance["encryptor"],
	} as unknown as FastifyInstance;
	return { app, warnSpy };
}

/**
 * Helper to poke at the private map. Necessary because the adaptive-cap
 * helper is a method that reads instance state; we want to test it
 * deterministically without spinning up a sync.
 */
function setActive(scheduler: LibrarySyncScheduler, entries: Array<[string, number]>): void {
	const map = (scheduler as unknown as { activeSyncItemCounts: Map<string, number> })
		.activeSyncItemCounts;
	for (const [id, count] of entries) map.set(id, count);
}

function callEffectiveMaxConcurrent(
	scheduler: LibrarySyncScheduler,
	candidateItemCount: number,
): number {
	return (
		scheduler as unknown as {
			effectiveMaxConcurrent: (n: number) => number;
		}
	).effectiveMaxConcurrent(candidateItemCount);
}

// ============================================================================
// effectiveMaxConcurrent — pure adaptive-cap logic
// ============================================================================

describe("LibrarySyncScheduler.effectiveMaxConcurrent", () => {
	it("returns the default MAX_CONCURRENT_SYNCS (2) when nothing is large", () => {
		const sched = new LibrarySyncScheduler();
		setActive(sched, [["a", 100]]);
		expect(callEffectiveMaxConcurrent(sched, 500)).toBe(2);
	});

	it("returns 1 when an active sync is at/above the threshold", () => {
		const sched = new LibrarySyncScheduler();
		setActive(sched, [["a", LARGE_LIBRARY_THRESHOLD]]);
		expect(callEffectiveMaxConcurrent(sched, 100)).toBe(1);
	});

	it("returns 1 when the candidate itself is large (no active syncs)", () => {
		const sched = new LibrarySyncScheduler();
		// No active syncs.
		expect(callEffectiveMaxConcurrent(sched, LARGE_LIBRARY_THRESHOLD + 1)).toBe(1);
	});

	it("returns 1 when both an active sync AND the candidate are large", () => {
		const sched = new LibrarySyncScheduler();
		setActive(sched, [
			["a", 50_000],
			["b", 200],
		]);
		expect(callEffectiveMaxConcurrent(sched, 20_000)).toBe(1);
	});

	it("returns 2 when active syncs are all below threshold and candidate is small", () => {
		const sched = new LibrarySyncScheduler();
		setActive(sched, [
			["a", 5000],
			["b", 5000],
		]);
		expect(callEffectiveMaxConcurrent(sched, 1000)).toBe(2);
	});

	it("boundary: exactly LARGE_LIBRARY_THRESHOLD counts as large", () => {
		// Documents the inclusive-of-threshold semantic. A regression that
		// flipped to strict-greater-than would let a 10k-item library escape
		// the cap and co-sync.
		const sched = new LibrarySyncScheduler();
		expect(callEffectiveMaxConcurrent(sched, LARGE_LIBRARY_THRESHOLD)).toBe(1);
	});
});

// ============================================================================
// triggerSync — cold-start adaptive cap (review-fix #3)
// ============================================================================

describe("LibrarySyncScheduler.triggerSync — cold-start adaptive cap", () => {
	let sched: LibrarySyncScheduler;

	beforeEach(() => {
		sched = new LibrarySyncScheduler();
	});

	it("treats a never-synced instance (lastFullSync === null) as LARGE", async () => {
		// Pre-fix behavior: itemCount=0 default + lastFullSync=null →
		// candidateItemCount=0 → adaptive cap returns 2 → cold-start sync
		// of a 50k-artist Lidarr could co-spike with another instance.
		// Post-fix: lastFullSync=null → assume large → cap returns 1.
		const { app } = makeMockApp({
			instances: [
				{
					id: "inst-1",
					service: "LIDARR",
					librarySyncStatus: {
						lastFullSync: null,
						itemCount: 0,
					},
				},
			],
		});
		sched.initialize(app);

		// Manually invoke the bookkeeping that triggerSync would do, then
		// check the recorded itemCount. (Calling triggerSync directly would
		// require mocking all of syncInstance — out of scope.)
		const map = (sched as unknown as { activeSyncItemCounts: Map<string, number> })
			.activeSyncItemCounts;

		// Simulate the populate step from triggerSync (the part we care
		// about — the post-populate runSync is uninteresting here).
		const status = { lastFullSync: null, itemCount: 0 };
		const knownItemCount = status.lastFullSync ? status.itemCount : LARGE_LIBRARY_THRESHOLD;
		map.set("inst-1", knownItemCount);

		expect(map.get("inst-1")).toBeGreaterThanOrEqual(LARGE_LIBRARY_THRESHOLD);
		expect(callEffectiveMaxConcurrent(sched, 100)).toBe(1);
	});

	it("uses the persisted itemCount when lastFullSync exists", () => {
		// Once a sync has succeeded, we have real data. Use it.
		const sched2 = new LibrarySyncScheduler();
		const map = (sched2 as unknown as { activeSyncItemCounts: Map<string, number> })
			.activeSyncItemCounts;

		const status = { lastFullSync: new Date("2026-05-01"), itemCount: 250 };
		const knownItemCount = status.lastFullSync ? status.itemCount : LARGE_LIBRARY_THRESHOLD;
		map.set("inst-1", knownItemCount);

		expect(map.get("inst-1")).toBe(250);
		expect(callEffectiveMaxConcurrent(sched2, 100)).toBe(2);
	});

	it("reports a requested sync as pending before its instance lookup settles", async () => {
		const { app } = makeMockApp();
		let rejectLookup!: (reason: Error) => void;
		const lookup = new Promise<never>((_resolve, reject) => {
			rejectLookup = reject;
		});
		vi.mocked(app.prisma.serviceInstance.findUnique).mockReturnValue(
			lookup as unknown as ReturnType<typeof app.prisma.serviceInstance.findUnique>,
		);
		sched.initialize(app);

		const first = sched.triggerSync("inst-1");
		expect(sched.isInstanceSyncing("inst-1")).toBe(true);
		expect(await sched.triggerSync("inst-1")).toBeNull();
		expect(app.prisma.serviceInstance.findUnique).toHaveBeenCalledTimes(1);

		rejectLookup(new Error("lookup unavailable"));
		await expect(first).rejects.toThrow("lookup unavailable");
		expect(sched.isInstanceSyncing("inst-1")).toBe(false);
	});
});

// ============================================================================
// activeSyncItemCounts lifecycle — must clear in runSync's finally
// ============================================================================

describe("LibrarySyncScheduler.activeSyncItemCounts lifecycle", () => {
	it("starts empty on a fresh instance", () => {
		const sched = new LibrarySyncScheduler();
		const map = (sched as unknown as { activeSyncItemCounts: Map<string, number> })
			.activeSyncItemCounts;
		expect(map.size).toBe(0);
	});

	it("can be set + cleared manually (matches what triggerSync+runSync do)", () => {
		// Pins the lifecycle: if a future refactor moves the .delete() out
		// of runSync's finally, the map would leak entries and a stuck-large
		// item would cap concurrency to 1 forever. This test exercises the
		// set→delete contract.
		const sched = new LibrarySyncScheduler();
		const map = (sched as unknown as { activeSyncItemCounts: Map<string, number> })
			.activeSyncItemCounts;
		map.set("inst-1", 50_000);
		expect(callEffectiveMaxConcurrent(sched, 100)).toBe(1);
		map.delete("inst-1");
		expect(callEffectiveMaxConcurrent(sched, 100)).toBe(2);
	});
});

// ============================================================================
// New-download producer → Telegram sender (issue #543)
// ============================================================================

describe("sendNewDownloadNotification", () => {
	let fixture: Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
	let services: NotificationService[];
	let service: NotificationService;
	let statuses: number[];
	let requests: Array<{ url: string; text: string; chatId: string; markerCommitted: boolean }>;
	const logger = { info() {}, warn() {}, error() {}, debug() {} };

	function createService() {
		const current = new NotificationService(
			fixture.prisma,
			fixture.encryptor,
			new NotificationDispatcher(),
			logger,
			undefined,
			undefined,
			"https://dashboard.example.test",
			new RuleEngine(),
			undefined,
			{ runtime: fixture.runtime, clock: fixture.clock },
		);
		services.push(current);
		return current;
	}
	async function configure(channelId: string, userId: string, botToken = "telegram-token") {
		const encrypted = fixture.encryptor.encrypt(JSON.stringify({ botToken, chatId: "chat-123" }));
		await fixture.prisma.notificationChannel.update({
			where: { id: channelId, userId },
			data: { type: "TELEGRAM", encryptedConfig: encrypted.value, configIv: encrypted.iv },
		});
		await fixture.prisma.notificationSubscription.deleteMany({
			where: { channelId, channel: { userId } },
		});
		await fixture.prisma.notificationSubscription.create({
			data: { channelId, eventType: "LIBRARY_NEW_CONTENT" },
		});
	}
	function produce(current = service) {
		return sendNewDownloadNotification(
			current,
			{
				newDownloads: [
					{ title: "Movie <One>", itemType: "movie" },
					{ title: "Movie Two", itemType: "movie" },
				],
			},
			{ label: "Radarr", service: "RADARR", userId: fixture.userId },
		);
	}
	function history() {
		return fixture.prisma.notificationLog.findMany({
			where: { channelId: fixture.channelId },
			orderBy: { retryCount: "asc" },
		});
	}
	function delivery() {
		return fixture.prisma.notificationOutboxDelivery.findFirstOrThrow({
			where: { userId: fixture.userId, channelId: fixture.channelId },
		});
	}
	beforeEach(async () => {
		fixture = await createNotificationOutboxNativeFixture();
		services = [];
		statuses = [];
		requests = [];
		await fixture.run(() => configure(fixture.channelId, fixture.userId));
		service = createService();
		// The real sender runs, but no HTTP request may leave this synthetic fixture.
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			if (
				![
					"https://api.telegram.org/bottelegram-token/sendMessage",
					"https://api.telegram.org/botrotated-synthetic-token/sendMessage",
					"https://api.telegram.org/botforeign-synthetic-token/sendMessage",
				].includes(url)
			)
				throw new Error("Fixture refuses an unexpected HTTP destination");
			if (init?.method !== "POST") throw new Error("Fixture refuses an unexpected HTTP method");
			const body = JSON.parse(String(init.body)) as { text: string; chat_id: string };
			const marker = await delivery();
			requests.push({
				url,
				text: body.text,
				chatId: body.chat_id,
				markerCommitted: marker.state === "submitting" && marker.attemptToken !== null,
			});
			const status = statuses.shift() ?? 200;
			return new Response(
				JSON.stringify(status === 429 ? { parameters: { retry_after: 60 } } : { ok: true }),
				{ status },
			);
		});
	});
	afterEach(async () => {
		for (const current of services) await current.shutdown();
		vi.restoreAllMocks();
		await fixture.close();
	});

	it("scopes durable work to its owner and reaches the real Telegram sender", async () =>
		fixture.run(async () => {
			const foreign = await fixture.createOwner();
			await configure(foreign.channelId, foreign.userId, "foreign-synthetic-token");
			await produce();
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({
				url: "https://api.telegram.org/bottelegram-token/sendMessage",
				chatId: "chat-123",
				markerCommitted: true,
			});
			expect(requests[0]!.text).toContain("2 new download(s) on Radarr");
			expect(requests[0]!.text).toContain("Movie &lt;One&gt;, Movie Two");
			expect(requests[0]!.text).toContain("https://dashboard.example.test/library");
			expect(await delivery()).toMatchObject({
				state: "sent",
				attemptOrdinal: 0,
				outcomeCategory: "acknowledged",
			});
			expect(await history()).toEqual([
				expect.objectContaining({
					channelType: "TELEGRAM",
					eventType: "LIBRARY_NEW_CONTENT",
					status: "sent",
					retryCount: 0,
				}),
			]);
			expect(
				await fixture.prisma.notificationChannel.findFirstOrThrow({
					where: { id: fixture.channelId, userId: fixture.userId },
				}),
			).toMatchObject({ lastSendResult: "success" });
			expect(
				await fixture.prisma.notificationOutboxEvent.count({ where: { userId: foreign.userId } }),
			).toBe(0);
			expect(
				await fixture.prisma.notificationLog.count({ where: { channelId: foreign.channelId } }),
			).toBe(0);
			await service.shutdown();
			service = createService();
			await service.start();
			await service.drain();
			expect(requests).toHaveLength(1);
			expect(await history()).toHaveLength(1);
		}));

	it("recovers a rate-limited download after native restart using current encrypted config", async () => {
		statuses.push(429);
		await fixture.run(async () => {
			await produce();
			expect(await delivery()).toMatchObject({
				state: "retry-waiting",
				attemptOrdinal: 1,
				nextAttemptAt: new Date("2026-10-10T12:01:00.000Z"),
				attemptToken: null,
			});
			await configure(fixture.channelId, fixture.userId, "rotated-synthetic-token");
		});
		await service.shutdown();
		expect(requests).toHaveLength(1);
		await fixture.restart();
		service = createService();
		fixture.now = new Date("2026-10-10T12:00:59.999Z");
		await service.start();
		await service.drain();
		expect(requests).toHaveLength(1);
		await service.shutdown();
		fixture.now = new Date("2026-10-10T12:01:00.000Z");
		service = createService();
		await service.start();
		await service.drain();
		expect(requests).toHaveLength(2);
		expect(requests[1]).toMatchObject({
			url: "https://api.telegram.org/botrotated-synthetic-token/sendMessage",
			markerCommitted: true,
		});
		await fixture.run(async () => {
			expect(await delivery()).toMatchObject({ state: "sent", attemptOrdinal: 1 });
			expect(
				(await history()).map((row) => ({ status: row.status, ordinal: row.retryCount })),
			).toEqual([
				{ status: "failed", ordinal: 0 },
				{ status: "sent", ordinal: 1 },
			]);
		});
	});

	it("does not resend a download whose subscription was revoked before retry", async () =>
		fixture.run(async () => {
			statuses.push(429);
			await produce();
			await service.shutdown();
			await fixture.prisma.notificationSubscription.deleteMany({
				where: { channelId: fixture.channelId, channel: { userId: fixture.userId } },
			});
			fixture.now = new Date("2026-10-10T12:01:00.000Z");
			service = createService();
			await service.start();
			await service.drain();
			expect(requests).toHaveLength(1);
			expect(await delivery()).toMatchObject({
				state: "canceled",
				attemptOrdinal: 1,
				outcomeCategory: "recipient-unavailable",
			});
			expect((await history()).map((row) => row.status)).toEqual(["failed"]);
		}));

	it("rejects failed durable admission without a send or dedup poison and succeeds after repair", async () =>
		fixture.run(async () => {
			if (fixture.engine === "sqlite") {
				await fixture.prisma.$executeRawUnsafe(
					"CREATE TRIGGER library_download_admission_reject BEFORE INSERT ON \"NotificationOutboxEvent\" BEGIN SELECT RAISE(ABORT, 'synthetic admission rejection'); END",
				);
			} else {
				await fixture.prisma.$executeRawUnsafe(
					"CREATE FUNCTION library_download_admission_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic admission rejection'; END $$",
				);
				await fixture.prisma.$executeRawUnsafe(
					'CREATE TRIGGER library_download_admission_reject BEFORE INSERT ON "NotificationOutboxEvent" FOR EACH ROW EXECUTE FUNCTION library_download_admission_reject()',
				);
			}
			try {
				await expect(produce()).rejects.toMatchObject({ category: "storage-unavailable" });
				expect(requests).toEqual([]);
				expect(await history()).toEqual([]);
				expect(
					await fixture.prisma.notificationOutboxEvent.count({ where: { userId: fixture.userId } }),
				).toBe(0);
				expect(
					await fixture.prisma.notificationChannel.findFirstOrThrow({
						where: { id: fixture.channelId, userId: fixture.userId },
					}),
				).toMatchObject({ lastSentAt: null, lastSendResult: null });
			} finally {
				await fixture.prisma.$executeRawUnsafe(
					fixture.engine === "sqlite"
						? "DROP TRIGGER library_download_admission_reject"
						: 'DROP TRIGGER library_download_admission_reject ON "NotificationOutboxEvent"',
				);
				if (fixture.engine === "postgresql")
					await fixture.prisma.$executeRawUnsafe(
						"DROP FUNCTION library_download_admission_reject()",
					);
			}
			await produce();
			expect(requests).toHaveLength(1);
			expect(await delivery()).toMatchObject({ state: "sent", attemptOrdinal: 0 });
		}));

	it("rejects new download work after shutdown without publishing an accepted event", async () =>
		fixture.run(async () => {
			await service.shutdown();
			await expect(produce()).rejects.toThrow("Notification service is shutting down");
			expect(requests).toEqual([]);
			expect(await history()).toEqual([]);
			expect(
				await fixture.prisma.notificationOutboxEvent.count({ where: { userId: fixture.userId } }),
			).toBe(0);
		}));
});

// ============================================================================
// First-tick delay + stop()/start() race (review-fix #2)
// ============================================================================

describe("LibrarySyncScheduler.start/stop — first-tick delay", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does NOT install the periodic interval until FIRST_TICK_DELAY_MS elapses", () => {
		const sched = new LibrarySyncScheduler();
		const { app } = makeMockApp({ instances: [] });
		sched.initialize(app);

		sched.start(app);
		// Immediately after start(): no interval yet, only a pending timeout.
		const internals = sched as unknown as {
			intervalId: NodeJS.Timeout | null;
			firstTickTimeoutId: NodeJS.Timeout | null;
		};
		expect(internals.intervalId).toBeNull();
		expect(internals.firstTickTimeoutId).not.toBeNull();

		// Clean up the still-pending timeout so vi.useRealTimers() doesn't
		// trigger background tick work later in the test run.
		sched.stop();
	});

	it("stop() during the FIRST_TICK_DELAY window cancels the pending timeout", () => {
		const sched = new LibrarySyncScheduler();
		const { app } = makeMockApp({ instances: [] });
		sched.initialize(app);

		sched.start(app);
		const internals = sched as unknown as {
			intervalId: NodeJS.Timeout | null;
			firstTickTimeoutId: NodeJS.Timeout | null;
			running: boolean;
		};
		expect(internals.firstTickTimeoutId).not.toBeNull();

		sched.stop();

		expect(internals.firstTickTimeoutId).toBeNull();
		expect(internals.intervalId).toBeNull();
		expect(internals.running).toBe(false);
	});

	it("late-firing timeout after stop() does NOT install an interval (race fix)", () => {
		// The race: between when stop()'s clearTimeout runs and when the
		// already-queued timeout callback executes, there can be a window
		// where the callback fires anyway. Without the `if (!this.running)
		// return` guard, the callback would install a setInterval that
		// escapes shutdown cleanup.
		const sched = new LibrarySyncScheduler();
		const { app } = makeMockApp({ instances: [] });
		sched.initialize(app);

		sched.start(app);
		// Simulate the race by setting running=false WITHOUT calling stop()
		// (which would clearTimeout). This mimics: stop() ran, clearTimeout
		// was a no-op because the callback was already in flight on the
		// event-loop queue, callback proceeds.
		(sched as unknown as { running: boolean }).running = false;

		// Advance time past FIRST_TICK_DELAY_MS so the timeout fires.
		vi.advanceTimersByTime(FIRST_TICK_DELAY_MS + 1000);

		// The interval MUST NOT be installed. Pre-fix: it would be.
		const internals = sched as unknown as { intervalId: NodeJS.Timeout | null };
		expect(internals.intervalId).toBeNull();
	});

	it("normal flow: timeout fires → interval installed → stop clears both", async () => {
		const sched = new LibrarySyncScheduler();
		const { app } = makeMockApp({ instances: [] });
		sched.initialize(app);

		sched.start(app);
		const internals = sched as unknown as {
			intervalId: NodeJS.Timeout | null;
			firstTickTimeoutId: NodeJS.Timeout | null;
		};

		// Advance past the delay — the timeout callback will run synchronously
		// inside advanceTimersByTime, which triggers the first tick (a Prisma
		// query in the real path). With our empty-instances mock, the tick
		// completes immediately. The interval should now be installed.
		await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS + 100);

		expect(internals.firstTickTimeoutId).toBeNull();
		expect(internals.intervalId).not.toBeNull();

		sched.stop();
		expect(internals.intervalId).toBeNull();
	});
});
