import { afterEach, describe, expect, it } from "vitest";
import type { SendResult } from "../../lib/notifications/types.js";
import { bootNotificationNativeApp } from "./fixtures/notification-native-app.js";

const fixtures: Awaited<ReturnType<typeof bootNotificationNativeApp>>[] = [];
const releases: Array<() => void> = [];
const pending: Promise<unknown>[] = [];

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(pending.splice(0));
	for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe("actual notification plugin shutdown and physical native-client closure", () => {
	for (const outcome of ["success", "retryable", "uncertain"] as const) {
		it(`joins an issued ${outcome} transport before actual database close`, async () => {
			let release!: () => void;
			let entered!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			releases.push(release);
			const fixture = await bootNotificationNativeApp({
				transport: async (): Promise<SendResult> => {
					entered();
					await held;
					if (outcome === "uncertain") throw new Error("Synthetic unconfirmed transport");
					return outcome === "success"
						? { success: true, retryable: false }
						: {
								success: false,
								retryable: true,
								failureCategory: "provider-unavailable",
								retryAfterMs: 60_000,
							};
				},
			});
			fixtures.push(fixture);
			const notification = fixture.notify();
			pending.push(notification.catch(() => undefined));
			await started;
			let closed = false;
			const closing = fixture.app.close().then(() => {
				closed = true;
			});
			pending.push(closing.catch(() => undefined));
			await fixture.preClosed;
			let completionLower = 0;
			let completionUpper = 0;
			try {
				expect(fixture.state.pendingTransports).toBe(1);
				expect(fixture.state.physicalClientClosed).toBe(false);
				expect(closed).toBe(false);
			} finally {
				completionLower = Date.now();
				release();
				await Promise.all([notification, closing]);
				completionUpper = Date.now();
			}
			expect(fixture.state.order).toEqual([
				"transport-start",
				"transport-settled",
				"database-close-start",
				"database-close-complete",
			]);
			expect(fixture.state.pendingAtDatabaseClose).toBe(0);
			expect(fixture.state.databaseCloseCount).toBe(1);
			expect(fixture.state.physicalClientClosed).toBe(true);
			expect(fixture.payloads).toEqual([fixture.native.payload]);
			const rows = await fixture.deliveries();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				state:
					outcome === "success" ? "sent" : outcome === "retryable" ? "retry-waiting" : "uncertain",
				attemptOrdinal: outcome === "retryable" ? 1 : 0,
			});
			const history = await fixture.history();
			expect(history.map((row) => ({ status: row.status, ordinal: row.retryCount }))).toEqual(
				outcome === "success"
					? [{ status: "sent", ordinal: 0 }]
					: outcome === "retryable"
						? [{ status: "failed", ordinal: 0 }]
						: [],
			);
			if (outcome === "retryable") {
				expect(rows[0]!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(completionLower + 60_000);
				expect(rows[0]!.nextAttemptAt.getTime()).toBeLessThanOrEqual(completionUpper + 60_000);
				expect(rows[0]!.attemptToken).toBeNull();
			}
			await fixture.app.close();
			expect(fixture.state.databaseCloseCount).toBe(1);
			expect(fixture.payloads).toHaveLength(1);
		});
	}

	it("closes the actual client without forcing future deferred delivery", async () => {
		const fixture = await bootNotificationNativeApp({
			prepare: async (native) => {
				await native.repository().admit({
					...native.input(),
					policy: { stage: "deferred", dueAt: new Date("2099-01-01T00:00:00.000Z") },
				});
			},
		});
		fixtures.push(fixture);
		await fixture.app.close();
		expect(fixture.state.physicalClientClosed).toBe(true);
		expect(fixture.state.order).toEqual(["database-close-start", "database-close-complete"]);
		expect(fixture.payloads).toEqual([]);
		expect(await fixture.history()).toEqual([]);
		expect(await fixture.deliveries()).toEqual([
			expect.objectContaining({
				state: "waiting",
				attemptOrdinal: 0,
				nextAttemptAt: new Date("2099-01-01T00:00:00.000Z"),
			}),
		]);
	});
});
